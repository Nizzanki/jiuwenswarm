"""Inkwell Studio bridge — Phase 2.

Our own app's tiny backend (still Path 2). It:
  1. serves the static front-end (same origin, so no CORS),
  2. exposes GET /events (SSE) which runs one JiuwenSwarm story over A2A and forwards
     the swarm's line-delimited JSON protocol to the browser as normalized events —
     the exact events the Phase 1 reducer already renders.

A2A streaming quirk (confirmed in the Step 0 spike): the swarm streams token deltas as
`artifact_update` events, then a final consolidated artifact carrying the full text (a
byte-identical duplicate of the deltas). So we brace-match complete JSON objects from an
accumulating buffer and dedup by canonical JSON string; first-seen order is correct.

Run:  .venv/Scripts/python.exe demos/inkwell-studio/server/bridge.py
Env:  A2A_URL (default http://127.0.0.1:19100), BRIDGE_HOST, BRIDGE_PORT (default 8800)
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import sys
import uuid
from collections.abc import Callable
from pathlib import Path

import httpx
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

sys.path.insert(0, str(Path(__file__).resolve().parent))
# Load this folder's .env (image backend config etc.) BEFORE importing imagegen,
# which reads IMAGE_* env vars at import time.
from dotenv import load_dotenv  # noqa: E402
load_dotenv(Path(__file__).resolve().parent / ".env")

from prompt import build_brief, build_team_brief, build_fill_brief, KNOWN_EVENTS  # noqa: E402
import imagegen  # noqa: E402
import gifexport  # noqa: E402
import pdfexport  # noqa: E402
import moderate  # noqa: E402

from a2a.client import ClientConfig, create_client  # noqa: E402
from a2a.helpers import get_stream_response_text, new_text_message  # noqa: E402
from a2a.types import SendMessageRequest  # noqa: E402

log = logging.getLogger("inkwell.bridge")

STATIC_DIR = Path(__file__).resolve().parent.parent          # demos/inkwell-studio/
A2A_URL = os.getenv("A2A_URL", "http://127.0.0.1:19100")
BRIDGE_HOST = os.getenv("BRIDGE_HOST", "127.0.0.1")
BRIDGE_PORT = int(os.getenv("BRIDGE_PORT", "8800"))
# Default 2: a story is a burst of renders (plus a re-render per revision) and free image
# tiers rate-limit on concurrency. Raise it if your endpoint has headroom.
IMAGE_CONCURRENCY = int(os.getenv("IMAGE_CONCURRENCY", "2") or 2)
# Whole-render retries per panel (on top of imagegen's own per-request retries), spaced
# out so a burst-triggered 429 gets a real cooldown instead of the same instant re-try.
IMAGE_PANEL_RETRIES = max(1, int(os.getenv("IMAGE_PANEL_RETRIES", "3") or 3))
# Native multi-agent team (real jiuwen_team via A2A) vs single-agent guided run.
TEAM = os.getenv("INKWELL_TEAM", "1").strip().lower() in {"1", "true", "yes", "on"}
# Retries for the targeted single-agent fill patch (see _incomplete_panels) before giving up
# and paying for a full single-agent redo that discards the team's already-good panels.
FILL_RETRIES = max(1, int(os.getenv("INKWELL_FILL_RETRIES", "2") or 2))

CAPTION_REDACTED = "— this part of the story was redacted (didn't meet our content guidelines) —"
ART_REDACTED_PROMPT = "a soft, warm, gentle abstract illustration, no specific subject"

app = FastAPI(title="Inkwell Studio bridge")


# --------------------------- JSON protocol extraction ---------------------------

def extract_json_objects(buf: str) -> tuple[list[str], str]:
    """Pull complete top-level {...} objects out of `buf`.

    Returns (objects, remaining) where `remaining` holds an incomplete trailing object
    (or noise before the next '{'). Brace-matching respects JSON strings/escapes.
    """
    objs: list[str] = []
    start: int | None = None
    depth = 0
    in_str = False
    esc = False
    for idx, c in enumerate(buf):
        if start is None:
            if c == "{":
                start, depth, in_str, esc = idx, 1, False, False
            continue
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
        else:
            if c == '"':
                in_str = True
            elif c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    objs.append(buf[start:idx + 1])
                    start = None
    remaining = buf[start:] if start is not None else ""
    return objs, remaining


def _parse_line(line: str) -> list[dict]:
    """Extract known protocol events from a single line (see parse_events). Split out so the
    live incremental scanner in _collect_swarm can reuse the exact same per-line extraction
    without waiting for the whole buffer."""
    out: list[dict] = []

    def _keep(raw: str) -> None:
        try:
            ev = json.loads(raw)
        except (ValueError, TypeError):
            return
        if isinstance(ev, dict) and ev.get("t") in KNOWN_EVENTS:
            out.append(ev)

    s = line.strip().rstrip(",")
    if "{" not in s:
        return out
    if s.startswith("{") and s.endswith("}"):
        before = len(out)
        _keep(s)
        if len(out) > before:
            return out
    objs, _ = extract_json_objects(s)  # concatenated objects on one line
    for raw in objs:
        _keep(raw)
    return out


def parse_events(buf: str) -> list[dict]:
    """Extract known protocol events from `buf`, line-scoped so it's robust to the heavy
    tool-event noise of a real team run (Python-dict reprs, unbalanced braces). The team
    emits one JSON object per line; single-agent output is clean too."""
    out: list[dict] = []
    for line in buf.splitlines():
        out.extend(_parse_line(line))
    return out


def _new_complete_lines(buf: str, scanned: int) -> tuple[list[str], int]:
    """Complete (newline-terminated) lines in buf[scanned:] not yet handed to a caller, and
    the new scan offset. The trailing partial line (no newline yet) is left for next time."""
    idx = buf.rfind("\n", scanned)
    if idx == -1:
        return [], scanned
    return buf[scanned:idx].splitlines(), idx + 1


# --------------------------------- swarm run ------------------------------------
#
# Why buffer + replay instead of pure passthrough: the A2A channel strips whitespace
# from every streamed chunk (message_to_a2a_parts does content.strip()), so live token
# deltas lose the spaces between tokens ("Eliasworkedthrough..."). Only the final
# consolidated artifact carries correctly-spaced text. So we collect the whole run,
# pick the best-spaced variant of each event, then replay it with gentle pacing — the
# swarm's work is real; we just render it readably. (Latency tuning is Phase 3.)

# Per-event replay delay (seconds) — mimics the Phase 1 timeline's cadence.
_PACE = {
    "panel.caption": 0.35, "panel.note": 0.30, "panel.art": 0.12, "log": 0.20,
    "agent": 0.14, "panel.status": 0.12, "progress": 0.08, "focus": 0.06,
    "brief": 0.15, "run.done": 0.0,
}


def _identity(ev: dict) -> str:
    """Whitespace-insensitive identity so spaced/unspaced variants collapse together."""
    return "".join(json.dumps(ev, sort_keys=True, ensure_ascii=False).split())


def _best_variants(events: list[dict]) -> list[dict]:
    """Dedup by identity, keeping the longest (best-spaced) variant, in first-seen order."""
    order: list[str] = []
    best: dict[str, tuple[int, dict]] = {}
    for ev in events:
        ident = _identity(ev)
        raw_len = len(json.dumps(ev, ensure_ascii=False))
        if ident not in best:
            order.append(ident)
            best[ident] = (raw_len, ev)
        elif raw_len > best[ident][0]:
            best[ident] = (raw_len, ev)
    return [best[i][1] for i in order]


# --------------------------- live status while the crew writes -------------------------
#
# The whitespace-stripping bug (see the block comment above) only corrupts FREE-TEXT fields.
# panel.status/progress/focus carry none at all (just panel numbers, an enum status, counts);
# `agent` mixes a safe enum `status`/`state` with a free-form `say` sentence. So instead of
# leaving the whole UI frozen on "Contacting the crew…" for the entire single A2A call that
# writes the full story, forward the text-safe SLICE of these live, as _collect_swarm sees
# them — the Crew panel's dots and each panel's status genuinely animate in real time while
# the crew is still working. Caption/art-prompt/note/log text still waits for the corrected,
# fully-deduped final replay, same as before.

_LIVE_SAFE_TYPES = {"panel.status", "progress", "focus"}
_LIVE_DONE = object()


def _live_view(ev: dict, total: int) -> dict | None:
    """A live-safe rendition of `ev`, or None if it either (a) carries free text that must
    wait for the corrected final replay, (b) is a TERMINAL/completion state — agent done,
    panel approved, progress at 100% — or (c) is a panel-scoped event with an invalid `panel`
    number.

    (b) matters because the crew's "settle the crew" events (see prompt.py's protocol) are
    emitted near the END of its own generation, but moderation + the paced replay still run
    AFTER that — so live-forwarding "done"/"approved" the instant they're written makes the
    Crew panel and progress bar claim the run is finished while every panel still reads
    "caption pending". That's more confusing than the frozen-UI problem this was built to
    fix. Intermediate states (active/drafting/rendering/review/reject/revising) are genuine,
    non-misleading progress and stay live; terminal ones are left for the final replay, where
    they land in sync with the content they actually describe.

    (c) matters because `_valid_panel_events` (below) only runs on the authoritative buffer
    AFTER the whole run finishes — a malformed/hallucinated `panel.status` or `focus` event
    with a missing or out-of-range `panel` reaches the browser straight from here otherwise,
    creating a permanent ghost panel card (`ensurePanel(undefined)` front-end-side) well
    before that later filter ever gets a chance to drop it."""
    t = ev.get("t")
    if t in ("panel.status", "focus"):
        n = ev.get("panel")
        if not isinstance(n, int) or not (1 <= n <= total):
            return None
    if t == "panel.status":
        return None if ev.get("status") == "approved" else ev
    if t == "progress":
        return None if ev.get("approved") == ev.get("total") else ev
    if t == "focus":
        return ev
    if t == "agent":
        if ev.get("status") == "done":
            return None
        return {**ev, "say": ""}   # keep the (canned) status/state word, drop the free line
    return None


async def _collect_swarm_live(
    idea: str, style: str, total: int, *, team: bool, live_q: asyncio.Queue, seen_live: set[str],
) -> list[dict]:
    """_collect_swarm, forwarding live-safe events onto `live_q` as they're seen and always
    signalling _LIVE_DONE when finished (success or error) so the drainer never hangs."""
    def _on_event(ev: dict) -> None:
        live = _live_view(ev, total)
        if live is None:
            return
        ident = _identity(live)
        if ident in seen_live:
            return
        seen_live.add(ident)
        live_q.put_nowait(live)

    try:
        return await _collect_swarm(idea, style, total, team=team, on_event=_on_event)
    finally:
        live_q.put_nowait(_LIVE_DONE)


async def _drain_live(live_q: asyncio.Queue):
    """Yield live-safe events as they arrive until _LIVE_DONE is seen."""
    while True:
        item = await live_q.get()
        if item is _LIVE_DONE:
            return
        yield item


async def _collect_swarm(
    idea: str, style: str, panels: int, *, team: bool = TEAM,
    on_event: Callable[[dict], None] | None = None,
) -> list[dict]:
    """Run one story over A2A and return every parsed protocol event (raw, undeduped).

    team=True routes to the native jiuwen_team (real leader + teammate agents) via request
    metadata mode=team; the leader streams our protocol while genuinely delegating.

    `on_event`, if given, is called synchronously with EVERY event as soon as its line
    completes in the growing buffer — before the run finishes, before dedup, before the
    whitespace-corruption in raw deltas is corrected. It's the caller's job to decide which
    event types are safe to act on early (see stream_story's live-forwarding, which only
    trusts text-free fields) — this function just reports what it sees, as soon as it sees it.
    """
    prompt = build_team_brief(idea, style, panels) if team else build_brief(idea, style, panels)
    context_id = f"inkwell_{uuid.uuid4().hex[:12]}"
    # Team runs are slower (multi-agent rounds) — give them room.
    timeout = 900.0 if team else 600.0
    hx = httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=10.0))
    client = None
    events: list[dict] = []
    try:
        client = await create_client(A2A_URL, ClientConfig(streaming=True, httpx_client=hx))
        msg = new_text_message(prompt, context_id=context_id, role=1)  # 1 = ROLE_USER
        req = SendMessageRequest(message=msg)
        meta = {"source": "inkwell-studio"}          # MUST be non-empty (framework guard)
        if team:
            meta["mode"] = "team"                      # route to the real jiuwen_team
        req.metadata.update(meta)
        buf = ""
        scanned = 0
        async for resp in client.send_message(req):
            if resp.WhichOneof("payload") != "artifact_update":
                continue
            text = get_stream_response_text(resp) or ""
            if text:
                buf += text
                if on_event is not None:
                    lines, scanned = _new_complete_lines(buf, scanned)
                    for line in lines:
                        for ev in _parse_line(line):
                            try:
                                on_event(ev)
                            except Exception:  # noqa: BLE001 — a live-forwarding hiccup must never break the run
                                log.exception("on_event callback failed")
        # Parse once over the full buffer, line-scoped (robust to team tool-noise). This is
        # the authoritative pass — it re-sees everything on_event already reported (plus the
        # final consolidated/correctly-spaced copy), which is why on_event alone is never
        # treated as the source of truth downstream.
        events = parse_events(buf)
    finally:
        if client is not None:
            try:
                await client.close()
            except Exception:  # noqa: BLE001
                pass
        await hx.aclose()
    return events


async def _collect_fill(
    idea: str, style: str, total: int, prior: list[tuple[int, str]], missing: list[int],
) -> list[dict]:
    """Ask a single agent for ONLY the missing panel(s) (build_fill_brief) — a small, fast
    patch instead of re-running the whole story. Short timeout: this is 1-2 panels of prose,
    not a full crew run."""
    prompt = build_fill_brief(idea, style, total, prior, missing)
    context_id = f"inkwell_fill_{uuid.uuid4().hex[:12]}"
    hx = httpx.AsyncClient(timeout=httpx.Timeout(180.0, connect=10.0))
    client = None
    events: list[dict] = []
    try:
        client = await create_client(A2A_URL, ClientConfig(streaming=True, httpx_client=hx))
        msg = new_text_message(prompt, context_id=context_id, role=1)  # 1 = ROLE_USER
        req = SendMessageRequest(message=msg)
        req.metadata.update({"source": "inkwell-studio-fill"})  # MUST be non-empty
        buf = ""
        async for resp in client.send_message(req):
            if resp.WhichOneof("payload") != "artifact_update":
                continue
            text = get_stream_response_text(resp) or ""
            if text:
                buf += text
        events = parse_events(buf)
    finally:
        if client is not None:
            try:
                await client.close()
            except Exception:  # noqa: BLE001
                pass
        await hx.aclose()
    return events


_PANEL_SCOPED_EVENTS = {"panel.status", "panel.art", "panel.caption", "panel.image", "panel.note"}


def _valid_panel_events(events: list[dict], total: int) -> list[dict]:
    """Drop the model's own duplicate `brief` (the bridge's synthetic opener already sent the
    authoritative, server-computed total — a second one from the model can only disagree with
    it) and any panel-scoped event whose `panel` is missing or outside 1..total.

    Without this, two real failure modes reach the viewer: (1) a hallucinated event missing
    its `panel` key creates a permanent ghost panel front-end-side (`ensurePanel(undefined)`
    renders as the literal text "undefined"), and (2) a model that drifts past the requested
    panel count leaves an extra panel stuck mid-render forever, since `_incomplete_panels`
    below only ever looks at 1..total.
    """
    out = []
    for ev in events:
        t = ev.get("t")
        if t == "brief":
            continue
        if t in _PANEL_SCOPED_EVENTS:
            n = ev.get("panel")
            if not isinstance(n, int) or not (1 <= n <= total):
                log.warning("dropping %s event with invalid panel %r", t, n)
                continue
        out.append(ev)
    return out


def _incomplete_panels(events: list[dict], total: int) -> list[int]:
    """Panel numbers (1..total) missing a caption or an art prompt.

    The native team leader sometimes settles a panel (`panel.status:"approved"`) without ever
    emitting its `panel.caption`/`panel.art` — the run "completes" but that panel is empty
    forever. `len(events) < 5` (the old check) only caught a leader that produced almost no
    protocol at all; it missed a mostly-good run with one silently-dropped panel."""
    have_caption = {ev["panel"] for ev in events if ev.get("t") == "panel.caption"}
    have_art = {ev["panel"] for ev in events if ev.get("t") == "panel.art"}
    return [n for n in range(1, total + 1) if n not in have_caption or n not in have_art]


async def _moderate_events(events: list[dict]) -> list[dict]:
    """Check every panel.caption/panel.art string against server/moderate.py's child-safety
    classifier before anything downstream sees it — this runs BEFORE images are rendered, so
    a flagged image prompt never reaches imagegen at all. Flagged panels get their
    text/prompt replaced with a safe filler (CAPTION_REDACTED/ART_REDACTED_PROMPT); other
    panels are untouched. This covers both the draft and the revised text for the
    intentionally-rejected panel, since both go through here as separate events.

    ONE moderation call PER PANEL (its caption + its art prompt), all panels dispatched
    CONCURRENTLY via moderate.check_child_safe_grouped — not one call per text (too many
    serial round-trips) and not one call for the whole story (that was the single biggest
    serial link in the pipeline: nothing, not even the first image, could start until that
    one call returned). Panels are independent, so their checks have no reason to wait on
    each other; wall-clock is now roughly the slowest single panel's call instead of one call
    covering all ~10-12 checks in the story."""
    by_panel: dict[int, list[int]] = {}  # panel number -> event indices, in event order
    for i, ev in enumerate(events):
        if ev.get("t") in ("panel.caption", "panel.art"):
            by_panel.setdefault(ev.get("panel"), []).append(i)
    if not by_panel:
        return events

    panels = sorted(by_panel)
    groups = [
        [events[i].get("text") if events[i]["t"] == "panel.caption" else events[i].get("svg")
         for i in by_panel[p]]
        for p in panels
    ]
    grouped_results = await moderate.check_child_safe_grouped(groups)
    for p, results in zip(panels, grouped_results):
        for i, (safe, reason) in zip(by_panel[p], results):
            if safe:
                continue
            ev = events[i]
            log.warning("panel %s: moderation flagged %s (%s)", ev.get("panel"), ev["t"], reason or "unspecified")
            if ev["t"] == "panel.caption":
                events[i] = {**ev, "text": CAPTION_REDACTED}
            else:
                events[i] = {**ev, "svg": ART_REDACTED_PROMPT}
    return events


async def _render_panel_resilient(
    panel_n: int, prompt: str, style: str, sem: asyncio.Semaphore,
) -> tuple[str | None, str | None]:
    """Render one panel's picture, retrying real-backend failures up to IMAGE_PANEL_RETRIES
    times (each attempt also gets imagegen._post_retrying's own internal 429/5xx retries),
    then falling back to the local stub placeholder so a panel always shows *something*.

    Shared by the initial run (render_one, below) and /restyle — /restyle used to skip this
    retry loop entirely and call imagegen.render() exactly once, so a single transient
    failure (a 429, or any non-retried 4xx like a 422) cost a panel with zero chance to
    recover, unlike the initial run's panels.
    """
    src: str | None = None
    err: str | None = None
    for attempt in range(1, IMAGE_PANEL_RETRIES + 1):
        try:
            async with sem:
                src, err, _seed = await imagegen.render(prompt, style)
        except Exception as exc:  # noqa: BLE001 — imagegen.render() shouldn't raise, but don't trust that blindly
            log.exception("panel %s: unexpected image render error", panel_n)
            src, err = None, f"{type(exc).__name__}: {exc}"
        if src:
            return src, None
        if attempt < IMAGE_PANEL_RETRIES:
            delay = min(6 * attempt, 20)
            log.info("panel %s: render failed (%s) — retry %d/%d in %.0fs",
                      panel_n, err, attempt, IMAGE_PANEL_RETRIES, delay)
            await asyncio.sleep(delay)
    log.warning("panel %s: no image after %d attempts (%s) — falling back to placeholder",
                panel_n, IMAGE_PANEL_RETRIES, err)
    try:
        src = await imagegen.stub(prompt, style)
        return src, None
    except Exception:  # noqa: BLE001
        log.exception("panel %s: placeholder fallback failed too", panel_n)
        return None, err


async def stream_story(idea: str, style: str, panels: int):
    """Async-generate normalized events: instant opener, paced narrative, and images that
    render concurrently and pop in as they finish (progressive reveal)."""
    total = max(3, min(int(panels or 5), 6))
    idea = (idea or "").strip() or "A sleepy bear tries to stay awake to see the first snow."
    style = (style or "").strip() or "Warm storybook · Painterly"

    # Immediate opener so the UI shows the brief + a warming crew during generation.
    yield {"t": "brief", "idea": idea, "style": style, "total": total}
    yield {"t": "progress", "approved": 0, "inReview": 0, "drafting": total, "total": total}
    yield {"t": "agent", "id": "writer", "status": "active", "state": "drafting",
           "say": "The crew is drafting your story…"}
    for aid in ("critic", "artDirector", "imageGen", "editor"):
        yield {"t": "agent", "id": aid, "status": "idle", "say": "Standing by."}

    # live_q/seen_live carry text-safe events out of the crew's single big A2A call AS IT
    # WRITES, so the Crew panel and panel statuses animate in real time instead of the UI
    # sitting frozen on "Contacting the crew…" for the whole call. See _collect_swarm_live.
    live_q: asyncio.Queue = asyncio.Queue()
    seen_live: set[str] = set()
    try:
        collect_task = asyncio.create_task(
            _collect_swarm_live(idea, style, total, team=TEAM, live_q=live_q, seen_live=seen_live)
        )
        async for live_ev in _drain_live(live_q):
            yield live_ev
        raw = await collect_task
        events = _best_variants(raw)
        if TEAM and len(events) < 5:
            # The team leader emitted ~no usable protocol at all — nothing worth patching,
            # so this is the one case that pays for a full single-agent redo. That redo is a
            # fresh, unrelated generation, so whatever was already shown live for the
            # abandoned team attempt no longer describes it — clear it so the redo's own
            # panel statuses replay properly instead of being wrongly suppressed below.
            log.warning("team run produced ~no usable protocol — falling back to single-agent")
            seen_live.clear()
            raw = await _collect_swarm(idea, style, total, team=False)
            events = _best_variants(raw)
        elif TEAM and _incomplete_panels(events, total):
            # The team otherwise wrote a good story but silently skipped panel(s) — team mode
            # is deliberately capped at a lean panel count (see build_team_brief) to avoid the
            # coordination deadlocks a heavier brief can trigger, so this is routine whenever
            # the requested total exceeds that cap, not a rare failure. Patch the gap with a
            # small targeted single-agent call instead of redoing the whole story — and if that
            # patch itself comes up short, retry it for whatever's STILL missing (cheap: 1-2
            # panels of prose) before paying for a full redo that would throw away the team's
            # already-good panels.
            missing = _incomplete_panels(events, total)
            for attempt in range(1, FILL_RETRIES + 1):
                log.warning("team run missing content for panel(s) %s — patching with a targeted fill (attempt %d/%d)",
                            missing, attempt, FILL_RETRIES)
                prior = sorted(
                    (ev["panel"], ev["text"]) for ev in events
                    if ev.get("t") == "panel.caption" and ev.get("panel") not in missing
                )
                fill_raw = await _collect_fill(idea, style, total, prior, missing)
                fill_events = [
                    ev for ev in _best_variants(fill_raw)
                    if ev.get("t") in ("panel.art", "panel.caption") and ev.get("panel") in missing
                ]
                filled = {ev["panel"] for ev in fill_events if ev.get("t") == "panel.caption"} & \
                         {ev["panel"] for ev in fill_events if ev.get("t") == "panel.art"}
                events = events + fill_events + [
                    {"t": "panel.status", "panel": n, "status": "approved"} for n in sorted(filled)
                ]
                missing = sorted(set(missing) - filled)
                if not missing:
                    events.append({"t": "progress", "approved": total, "inReview": 0, "drafting": 0, "total": total})
                    break
            else:
                # Still missing panel(s) after every retry — actual last resort, full
                # single-agent redo (same reasoning as above: a fresh generation, so clear
                # whatever was live-shown so far).
                log.warning("fill still missing panel(s) %s after %d attempts — falling back to full single-agent run",
                            missing, FILL_RETRIES)
                seen_live.clear()
                raw = await _collect_swarm(idea, style, total, team=False)
                events = _best_variants(raw)
        events = _valid_panel_events(events, total)
        events = await _moderate_events(events)
        if seen_live:
            # Don't replay-with-pacing what the viewer already watched happen live.
            events = [
                ev for ev in events
                if not (ev.get("t") in _LIVE_SAFE_TYPES and _identity(ev) in seen_live)
            ]
    except Exception as exc:  # noqa: BLE001
        yield {"t": "error", "message": f"bridge/swarm error: {exc}"}
        yield {"t": "run.done"}
        return

    # Producer/consumer merge: the paced narrative and the concurrent image renders both
    # feed one queue; the SSE consumer drains it, so images interleave with the story.
    q: asyncio.Queue = asyncio.Queue()
    DONE = object()
    img_tasks: dict[int, asyncio.Task] = {}
    sem = asyncio.Semaphore(IMAGE_CONCURRENCY)

    async def render_one(panel: int, prompt: str):
        try:
            src, err = await _render_panel_resilient(panel, prompt, style, sem)
        except asyncio.CancelledError:
            return
        if src:
            await q.put({"t": "panel.image", "panel": panel, "src": src})
        else:
            # Tell the UI the render is over and failed, so the panel stops showing
            # "rendering…" forever and the viewer sees why.
            log.warning("panel %s: no image at all", panel)
            await q.put({"t": "panel.image.failed", "panel": panel, "reason": err or "render failed"})

    async def producer():
        for ev in events:
            if ev.get("t") == "run.done":
                continue  # deferred until images are in, so the export is complete
            if ev.get("t") == "panel.art":
                panel = ev.get("panel")
                prompt = str(ev.get("svg") or "")
                if prompt:
                    # debounce: newest prompt for a panel wins — but only cancel the old
                    # render once we actually have a replacement queued, so a stray/empty
                    # duplicate panel.art can never kill an in-flight render and leave the
                    # panel stuck showing "rendering…" forever with no image and no error.
                    old = img_tasks.get(panel)
                    if old and not old.done():
                        old.cancel()
                    img_tasks[panel] = asyncio.create_task(render_one(panel, prompt))
            await q.put(ev)
            await asyncio.sleep(_PACE.get(ev.get("t"), 0.1))
        pending = [t for t in img_tasks.values() if not t.done()]
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        await q.put({"t": "run.done"})
        await q.put(DONE)

    prod = asyncio.create_task(producer())
    try:
        while True:
            item = await q.get()
            if item is DONE:
                break
            yield item
    finally:
        prod.cancel()
        for t in img_tasks.values():
            if not t.done():
                t.cancel()


# ----------------------------------- routes -------------------------------------

@app.get("/health")
async def health():
    return JSONResponse({"ok": True, "a2a_url": A2A_URL})


def _decode_panels(data: dict) -> list[dict]:
    """Shared by the /export/* routes: {n, caption, png} where png is a data-URI / base64 PNG."""
    panels = []
    for p in data.get("panels") or []:
        raw = str(p.get("png") or "")
        png = None
        if raw:
            try:
                png = base64.b64decode(raw.split(",", 1)[-1])
            except Exception:  # noqa: BLE001
                png = None
        panels.append({"n": p.get("n"), "caption": p.get("caption") or "", "png": png})
    return panels


@app.post("/export/gif")
async def export_gif(request: Request):
    """Build an animated-GIF animatic from the finished story. Body:
    {idea, style, panels:[{n, caption, png}]} where png is a data-URI / base64 PNG."""
    data = await request.json()
    panels = _decode_panels(data)
    if not panels:
        return JSONResponse({"error": "no panels"}, status_code=400)
    gif = await asyncio.to_thread(
        gifexport.build_gif, data.get("idea") or "", data.get("style") or "", panels,
    )
    return Response(
        content=gif, media_type="image/gif",
        headers={"Content-Disposition": 'attachment; filename="inkwell-story.gif"'},
    )


@app.post("/export/pdf")
async def export_pdf(request: Request):
    """Build a printable PDF of the finished story — same frames as /export/gif (title page +
    one page per panel), just paginated instead of animated. Body: {idea, style,
    panels:[{n, caption, png}]} where png is a data-URI / base64 PNG."""
    data = await request.json()
    panels = _decode_panels(data)
    if not panels:
        return JSONResponse({"error": "no panels"}, status_code=400)
    pdf = await asyncio.to_thread(
        pdfexport.build_pdf, data.get("idea") or "", data.get("style") or "", panels,
    )
    return Response(
        content=pdf, media_type="application/pdf",
        headers={"Content-Disposition": 'attachment; filename="inkwell-story.pdf"'},
    )


@app.post("/restyle")
async def restyle(request: Request):
    """Re-render a finished story's panels in a new style, WITHOUT re-running the crew — text
    (captions) and image prompts are untouched, only the pictures are redone. Body:
    {style, panels:[{n, prompt}]}.

    Does NOT reuse each panel's original seed (it used to — see git history). With a
    low-step distilled model (e.g. FLUX.1-schnell at 4 steps, this demo's default free-tier
    config), the seed dominates the output strongly enough that "same seed + same prompt +
    only the style words changed" can render a near-identical image — restyle would silently
    do nothing for some panels. A fresh random seed every restyle guarantees a visible change,
    at the cost of the composition/framing also possibly shifting, not just the style. The
    stub backend is unaffected either way: its composition is locked by the PROMPT alone
    (imagegen._layout_seed), independent of any seed argument.

    Uses the same retry-then-stub-fallback as the initial run (_render_panel_resilient) — this
    used to call imagegen.render() exactly once per panel, so a single transient failure (a
    429, or a non-retried 4xx) cost a panel with no chance to recover."""
    data = await request.json()
    style = str(data.get("style") or "").strip()
    panels_in = data.get("panels") or []
    if not style or not panels_in:
        return JSONResponse({"error": "style and panels are required"}, status_code=400)

    sem = asyncio.Semaphore(IMAGE_CONCURRENCY)

    async def one(p: dict) -> dict:
        n = p.get("n")
        prompt = str(p.get("prompt") or "")
        src, err = await _render_panel_resilient(n, prompt, style, sem)
        return {"n": n, "src": src, "error": err}

    results = await asyncio.gather(*(one(p) for p in panels_in))
    return JSONResponse({"panels": results})


@app.post("/panel/regenerate")
async def regenerate_panel(request: Request):
    """Re-render ONE panel's picture — same caption/prompt, a fresh image — without touching
    any other panel or re-running the crew. The single-panel sibling of /restyle (which redoes
    every panel at once for a style change); this is for "four panels are great, redo just this
    one." Body: {n, prompt, style}.

    Shares /restyle's two properties: the retry-then-stub-fallback of _render_panel_resilient
    (so a transient 429/4xx doesn't cost the panel with zero chance to recover), and no seed
    reuse (a fresh random seed every time), for the same reason — a low-step distilled model can
    let a reused seed dominate the output enough that nothing visibly changes, which would make
    "redo this image" silently do nothing."""
    data = await request.json()
    n = data.get("n")
    prompt = str(data.get("prompt") or "").strip()
    style = str(data.get("style") or "").strip()
    if not isinstance(n, int) or not prompt:
        return JSONResponse({"error": "n and prompt are required"}, status_code=400)
    sem = asyncio.Semaphore(IMAGE_CONCURRENCY)
    src, err = await _render_panel_resilient(n, prompt, style, sem)
    return JSONResponse({"src": src, "error": err})


@app.get("/events")
async def events(request: Request, idea: str = "", style: str = "", panels: int = 5):
    async def sse():
        try:
            async for ev in stream_story(idea, style, panels):
                if await request.is_disconnected():
                    break
                yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
        except asyncio.CancelledError:  # client went away
            raise
    return StreamingResponse(
        sse(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# Static front-end at the root (added AFTER routes so /events and /health win).
app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")


if __name__ == "__main__":
    print(f"[bridge] A2A_URL={A2A_URL}  static={STATIC_DIR}")
    print(f"[bridge] engine: {'native jiuwen_team (mode=team)' if TEAM else 'single-agent guided'}")
    print(f"[bridge] images: {imagegen.describe()}  (concurrency={IMAGE_CONCURRENCY})")
    print(f"[bridge] open http://{BRIDGE_HOST}:{BRIDGE_PORT}/")
    uvicorn.run(app, host=BRIDGE_HOST, port=BRIDGE_PORT, log_level="info")
