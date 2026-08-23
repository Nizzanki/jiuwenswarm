"""Inkwell Studio bridge — Phase 2.

Our own app's tiny backend (still Path 2). It:
  1. serves the static front-end (same origin, so no CORS unless a different-origin embed
     needs it — see add_cors below),
  2. exposes GET /events (SSE) which runs one JiuwenSwarm story over A2A and forwards
     the swarm's line-delimited JSON protocol to the browser as normalized events —
     the exact events the Phase 1 reducer already renders.

Transport, JSON-protocol framing, whitespace dedup, live-progress forwarding, the resilient-
retry pattern, and the FastAPI auth/CORS/rate-limit/SSE plumbing all now live in the
`a2a_embed` package (packages/a2a-embed/) — this file keeps only what's genuinely Inkwell's:
the guided-protocol prompt wiring (prompt.py), panel/brief validation, moderation, the
team/single-agent fallback and fill-retry orchestration, and image rendering + the story-
specific export/restyle/regenerate endpoints. See
demos/inkwell-studio/docs/productization-architecture.md for the before/after picture.

Run:  .venv/Scripts/python.exe demos/inkwell-studio/server/bridge.py
Env:  A2A_URL (default http://127.0.0.1:19100), BRIDGE_HOST, BRIDGE_PORT (default 8800),
      INKWELL_API_TOKEN (unset = no auth), INKWELL_MAX_CONCURRENT_RUNS (default 4, 0 = no cap)
"""

from __future__ import annotations

import asyncio
import base64
import logging
import os
import sys
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response

from a2a_embed import ConcurrencyGuard, LiveRelay, best_variants, call_resilient, identity, run_agent
from a2a_embed import server as embed_server

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
# Opt-in Bearer/query token (a2a_embed.auth); unset = no auth, matching the demo's original
# zero-config behavior. Concurrency cap targets the real documented risk (a team-mode run
# hanging for a long time and tying up a slot), not request volume — see ratelimit.py.
API_TOKEN_ENV_VAR = "INKWELL_API_TOKEN"
RUN_GUARD = ConcurrencyGuard.from_env("INKWELL_MAX_CONCURRENT_RUNS", 4)

CAPTION_REDACTED = "— this part of the story was redacted (didn't meet our content guidelines) —"
ART_REDACTED_PROMPT = "a soft, warm, gentle abstract illustration, no specific subject"

app = FastAPI(title="Inkwell Studio bridge")
embed_server.add_cors(app)
# Allowlist, not blanket protection: the static front-end (STATIC_DIR, mounted at the very
# end of this file) and /health stay open so the page can load at all — a plain browser
# navigation can't attach an Authorization header. /events isn't in this list either: it
# validates the same token via ?token= instead (wired below through sse_route's
# token_env_var), since EventSource can't set headers at all.
_PROTECTED_ROUTES = {"/export/gif", "/export/pdf", "/restyle", "/panel/regenerate"}
embed_server.add_auth(app, env_var=API_TOKEN_ENV_VAR, protect_paths=_PROTECTED_ROUTES)


# --------------------------------- swarm run ------------------------------------
#
# Why buffer + replay instead of pure passthrough: some A2A streaming paths strip
# whitespace from per-chunk deltas (see docs/en/A2A.md), so live token deltas can lose the
# spaces between tokens ("Eliasworkedthrough..."). Only the final consolidated artifact is
# guaranteed correctly-spaced. So we collect the whole run, pick the best-spaced variant of
# each event (a2a_embed.dedup), then replay it with gentle pacing — the swarm's work is
# real; we just render it readably. (Latency tuning is Phase 3.)

# Per-event replay delay (seconds) — mimics the Phase 1 timeline's cadence.
_PACE = {
    "panel.caption": 0.35, "panel.note": 0.30, "panel.art": 0.12, "log": 0.20,
    "agent": 0.14, "panel.status": 0.12, "progress": 0.08, "focus": 0.06,
    "brief": 0.15, "run.done": 0.0,
}


# --------------------------- live status while the crew writes -------------------------
#
# The whitespace-stripping bug (see the block comment above) only corrupts FREE-TEXT fields.
# panel.status/progress/focus carry none at all (just panel numbers, an enum status, counts);
# `agent` mixes a safe enum `status`/`state` with a free-form `say` sentence. So instead of
# leaving the whole UI frozen on "Contacting the crew…" for the entire single A2A call that
# writes the full story, forward the text-safe SLICE of these live, as run_agent's on_event
# sees them (via a2a_embed.LiveRelay) — the Crew panel's dots and each panel's status
# genuinely animate in real time while the crew is still working. Caption/art-prompt/note/log
# text still waits for the corrected, fully-deduped final replay, same as before.

_LIVE_SAFE_TYPES = {"panel.status", "progress", "focus"}


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


async def _run_story(idea: str, style: str, total: int, *, team: bool, relay: LiveRelay) -> list[dict]:
    """run_agent, forwarding live-safe events onto `relay` as they're seen and always
    closing it when finished (success or error) so the drainer never hangs."""
    prompt = build_team_brief(idea, style, total) if team else build_brief(idea, style, total)
    meta = {"source": "inkwell-studio"}
    if team:
        meta["mode"] = "team"          # route to the real jiuwen_team
    try:
        return await run_agent(
            A2A_URL, prompt,
            known_events=KNOWN_EVENTS, metadata=meta, context_prefix="inkwell",
            timeout=900.0 if team else 600.0,
            on_event=lambda ev: relay.on_event(ev),
        )
    finally:
        relay.close()


async def _collect_fill(
    idea: str, style: str, total: int, prior: list[tuple[int, str]], missing: list[int],
) -> list[dict]:
    """Ask a single agent for ONLY the missing panel(s) (build_fill_brief) — a small, fast
    patch instead of re-running the whole story. Short timeout: this is 1-2 panels of prose,
    not a full crew run."""
    prompt = build_fill_brief(idea, style, total, prior, missing)
    return await run_agent(
        A2A_URL, prompt,
        known_events=KNOWN_EVENTS, metadata={"source": "inkwell-studio-fill"},
        context_prefix="inkwell_fill", timeout=180.0,
    )


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
    then falling back to the local stub placeholder so a panel always shows *something*
    (a2a_embed.call_resilient).

    Shared by the initial run (render_one, below) and /restyle — /restyle used to skip this
    retry loop entirely and call imagegen.render() exactly once, so a single transient
    failure (a 429, or any non-retried 4xx like a 422) cost a panel with zero chance to
    recover, unlike the initial run's panels.
    """
    async def _call() -> tuple[str | None, str | None]:
        async with sem:
            src, err, _seed = await imagegen.render(prompt, style)
        return src, err

    def _on_retry(attempt: int, err: str | None) -> None:
        log.info("panel %s: render failed (%s) — retry %d/%d",
                  panel_n, err, attempt, IMAGE_PANEL_RETRIES)

    src, err = await call_resilient(
        _call, lambda: imagegen.stub(prompt, style),
        retries=IMAGE_PANEL_RETRIES, on_retry=_on_retry,
    )
    if not src:
        log.warning("panel %s: no image after %d attempts (%s)", panel_n, IMAGE_PANEL_RETRIES, err)
    return src, (None if src else err)


async def stream_story(idea: str = "", style: str = "", panels: int = 5):
    """Async-generate normalized events: instant opener, paced narrative, and images that
    render concurrently and pop in as they finish (progressive reveal).

    Defaults mirror the /events route's previous FastAPI-level defaults — the generic SSE
    route (a2a_embed.server.sse_route) forwards raw query-string values, so this function
    now owns its own defaults instead of relying on route parameter declarations."""
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

    # relay carries text-safe events out of the crew's single big A2A call AS IT WRITES, so
    # the Crew panel and panel statuses animate in real time instead of the UI sitting frozen
    # on "Contacting the crew…" for the whole call. See _run_story / _live_view above.
    relay = LiveRelay(lambda ev: _live_view(ev, total))
    try:
        collect_task = asyncio.create_task(_run_story(idea, style, total, team=TEAM, relay=relay))
        async for live_ev in relay.drain():
            yield live_ev
        raw = await collect_task
        events = best_variants(raw)
        if TEAM and len(events) < 5:
            # The team leader emitted ~no usable protocol at all — nothing worth patching,
            # so this is the one case that pays for a full single-agent redo. That redo is a
            # fresh, unrelated generation, so whatever was already shown live for the
            # abandoned team attempt no longer describes it — clear it so the redo's own
            # panel statuses replay properly instead of being wrongly suppressed below.
            log.warning("team run produced ~no usable protocol — falling back to single-agent")
            relay.seen.clear()
            fallback_relay = LiveRelay(lambda ev: None)
            raw = await _run_story(idea, style, total, team=False, relay=fallback_relay)
            events = best_variants(raw)
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
                    ev for ev in best_variants(fill_raw)
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
                relay.seen.clear()
                fallback_relay = LiveRelay(lambda ev: None)
                raw = await _run_story(idea, style, total, team=False, relay=fallback_relay)
                events = best_variants(raw)
        events = _valid_panel_events(events, total)
        events = await _moderate_events(events)
        if relay.seen:
            # Don't replay-with-pacing what the viewer already watched happen live.
            events = [
                ev for ev in events
                if not (ev.get("t") in _LIVE_SAFE_TYPES and identity(ev) in relay.seen)
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

embed_server.add_health(app, extra=lambda: {"a2a_url": A2A_URL})


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


embed_server.sse_route(app, "/events", stream_story, guard=RUN_GUARD, token_env_var=API_TOKEN_ENV_VAR)


# Static front-end at the root (added AFTER routes so /events and /health win).
embed_server.add_static(app, STATIC_DIR)


if __name__ == "__main__":
    import uvicorn
    print(f"[bridge] A2A_URL={A2A_URL}  static={STATIC_DIR}")
    print(f"[bridge] engine: {'native jiuwen_team (mode=team)' if TEAM else 'single-agent guided'}")
    print(f"[bridge] images: {imagegen.describe()}  (concurrency={IMAGE_CONCURRENCY})")
    print(f"[bridge] auth: {'token required' if os.getenv(API_TOKEN_ENV_VAR) else 'open (no ' + API_TOKEN_ENV_VAR + ' set)'}"
          f"  concurrency cap: {RUN_GUARD.max_concurrent or 'none'}")
    print(f"[bridge] open http://{BRIDGE_HOST}:{BRIDGE_PORT}/")
    uvicorn.run(app, host=BRIDGE_HOST, port=BRIDGE_PORT, log_level="info")
