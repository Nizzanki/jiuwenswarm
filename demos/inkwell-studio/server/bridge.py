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
import os
import sys
import uuid
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

from prompt import build_brief, build_team_brief, KNOWN_EVENTS  # noqa: E402
import imagegen  # noqa: E402
import gifexport  # noqa: E402

from a2a.client import ClientConfig, create_client  # noqa: E402
from a2a.helpers import get_stream_response_text, new_text_message  # noqa: E402
from a2a.types import SendMessageRequest  # noqa: E402

STATIC_DIR = Path(__file__).resolve().parent.parent          # demos/inkwell-studio/
A2A_URL = os.getenv("A2A_URL", "http://127.0.0.1:19100")
BRIDGE_HOST = os.getenv("BRIDGE_HOST", "127.0.0.1")
BRIDGE_PORT = int(os.getenv("BRIDGE_PORT", "8800"))
IMAGE_CONCURRENCY = int(os.getenv("IMAGE_CONCURRENCY", "3") or 3)
# Native multi-agent team (real jiuwen_team via A2A) vs single-agent guided run.
TEAM = os.getenv("INKWELL_TEAM", "1").strip().lower() in {"1", "true", "yes", "on"}

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


def parse_events(buf: str) -> list[dict]:
    """Extract known protocol events from `buf`, line-scoped so it's robust to the heavy
    tool-event noise of a real team run (Python-dict reprs, unbalanced braces). The team
    emits one JSON object per line; single-agent output is clean too. For each line we try
    it as one object, then fall back to brace-matching WITHIN that line (never across the
    whole buffer, which the tool-noise would derail)."""
    out: list[dict] = []

    def _keep(raw: str) -> None:
        try:
            ev = json.loads(raw)
        except (ValueError, TypeError):
            return
        if isinstance(ev, dict) and ev.get("t") in KNOWN_EVENTS:
            out.append(ev)

    for line in buf.splitlines():
        s = line.strip().rstrip(",")
        if "{" not in s:
            continue
        if s.startswith("{") and s.endswith("}"):
            before = len(out)
            _keep(s)
            if len(out) > before:
                continue
        for obj, _ in [extract_json_objects(s)]:  # concatenated objects on one line
            for raw in obj:
                _keep(raw)
    return out


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


async def _collect_swarm(idea: str, style: str, panels: int, *, team: bool = TEAM) -> list[dict]:
    """Run one story over A2A and return every parsed protocol event (raw, undeduped).

    team=True routes to the native jiuwen_team (real leader + teammate agents) via request
    metadata mode=team; the leader streams our protocol while genuinely delegating.
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
        async for resp in client.send_message(req):
            if resp.WhichOneof("payload") != "artifact_update":
                continue
            text = get_stream_response_text(resp) or ""
            if text:
                buf += text
        # Parse once over the full buffer, line-scoped (robust to team tool-noise).
        events = parse_events(buf)
    finally:
        if client is not None:
            try:
                await client.close()
            except Exception:  # noqa: BLE001
                pass
        await hx.aclose()
    return events


async def stream_story(idea: str, style: str, panels: int):
    """Async-generate normalized events: instant opener, paced narrative, and images that
    render concurrently and pop in as they finish (progressive reveal)."""
    total = max(3, min(int(panels or 5), 6))
    idea = (idea or "").strip() or "A lonely lighthouse keeper befriends a sea monster."
    style = (style or "").strip() or "Warm storybook · Painterly"

    # Immediate opener so the UI shows the brief + a warming crew during generation.
    yield {"t": "brief", "idea": idea, "style": style, "total": total}
    yield {"t": "progress", "approved": 0, "inReview": 0, "drafting": total, "total": total}
    yield {"t": "agent", "id": "writer", "status": "active", "state": "drafting",
           "say": "The crew is drafting your story…"}
    for aid in ("critic", "artDirector", "imageGen", "editor"):
        yield {"t": "agent", "id": aid, "status": "idle", "say": "Standing by."}

    try:
        raw = await _collect_swarm(idea, style, total, team=TEAM)
        events = _best_variants(raw)
        if TEAM and len(events) < 5:
            # The team leader didn't emit usable protocol — fall back to the single agent
            # so Live still delivers a story.
            raw = await _collect_swarm(idea, style, total, team=False)
            events = _best_variants(raw)
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
            async with sem:
                src = await imagegen.render(prompt, style)
        except asyncio.CancelledError:
            return
        except Exception:  # noqa: BLE001
            src = None
        if src:
            await q.put({"t": "panel.image", "panel": panel, "src": src})

    async def producer():
        for ev in events:
            if ev.get("t") == "run.done":
                continue  # deferred until images are in, so the export is complete
            if ev.get("t") == "panel.art":
                panel = ev.get("panel")
                prompt = str(ev.get("svg") or "")
                old = img_tasks.get(panel)
                if old and not old.done():
                    old.cancel()               # debounce: newest prompt for a panel wins
                if prompt:
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


@app.post("/export/gif")
async def export_gif(request: Request):
    """Build an animated-GIF animatic from the finished story. Body:
    {idea, style, panels:[{n, caption, png}]} where png is a data-URI / base64 PNG."""
    data = await request.json()
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
    if not panels:
        return JSONResponse({"error": "no panels"}, status_code=400)
    gif = await asyncio.to_thread(
        gifexport.build_gif, data.get("idea") or "", data.get("style") or "", panels,
    )
    return Response(
        content=gif, media_type="image/gif",
        headers={"Content-Disposition": 'attachment; filename="inkwell-story.gif"'},
    )


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
    print(f"[bridge] open http://{BRIDGE_HOST}:{BRIDGE_PORT}/  (live mode: append ?live=1)")
    uvicorn.run(app, host=BRIDGE_HOST, port=BRIDGE_PORT, log_level="info")
