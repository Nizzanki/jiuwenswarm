"""A2A client dispatch: send one prompt to a JiuwenSwarm agent/team over A2A, stream the
response, and return every line-delimited protocol event parsed from the accumulated text.

Ported from demos/inkwell-studio/server/bridge.py's `_collect_swarm`/`_collect_fill`,
generalized past Inkwell's own prompt-building and event vocabulary.
"""
from __future__ import annotations

import logging
import uuid
from collections.abc import Callable

import httpx
from a2a.client import ClientConfig, create_client
from a2a.helpers import get_stream_response_text, new_text_message
from a2a.types import SendMessageRequest

from .json_events import new_complete_lines, parse_events, parse_line

log = logging.getLogger("a2a_embed.client")

OnEvent = Callable[[dict], None]


async def run_agent(
    a2a_url: str,
    prompt: str,
    *,
    known_events: set[str],
    metadata: dict[str, str] | None = None,
    context_prefix: str = "a2a-embed",
    timeout: float = 600.0,
    connect_timeout: float = 10.0,
    on_event: OnEvent | None = None,
) -> list[dict]:
    """Send `prompt` to the agent/team at `a2a_url` and return every parsed protocol event
    (raw, undeduped -- see dedup.best_variants).

    `metadata` is sent as A2A request-level metadata; a `mode` key (e.g. `"team"`) routes to
    JiuwenSwarm's native team mode instead of a single default agent. It's always sent
    non-empty (falling back to `{"source": context_prefix}`) even though the gateway now
    tolerates empty metadata -- keeping it populated is still good practice for
    observability on the gateway side.

    `on_event`, if given, is called synchronously with EVERY event as soon as its line
    completes in the growing buffer -- before the run finishes, before dedup, and before any
    whitespace-corruption in raw deltas is corrected by the final consolidated artifact. It's
    the caller's job to decide which event types are safe to act on early (see `live.py`) --
    this function just reports what it sees, as soon as it sees it.
    """
    context_id = f"{context_prefix}_{uuid.uuid4().hex[:12]}"
    hx = httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=connect_timeout))
    client = None
    buf = ""
    scanned = 0
    try:
        client = await create_client(a2a_url, ClientConfig(streaming=True, httpx_client=hx))
        msg = new_text_message(prompt, context_id=context_id, role=1)  # 1 = ROLE_USER
        req = SendMessageRequest(message=msg)
        req.metadata.update(dict(metadata) if metadata else {"source": context_prefix})
        async for resp in client.send_message(req):
            if resp.WhichOneof("payload") != "artifact_update":
                continue
            text = get_stream_response_text(resp) or ""
            if text:
                buf += text
                if on_event is not None:
                    lines, scanned = new_complete_lines(buf, scanned)
                    for line in lines:
                        for ev in parse_line(line, known_events):
                            try:
                                on_event(ev)
                            except Exception:  # noqa: BLE001 -- a live-forwarding hiccup must never break the run
                                log.exception("on_event callback failed")
        # Parse once over the full buffer, line-scoped (robust to team tool-noise). This is
        # the authoritative pass -- it re-sees everything on_event already reported (plus the
        # final consolidated/correctly-spaced copy), which is why on_event alone is never the
        # source of truth downstream.
        return parse_events(buf, known_events)
    finally:
        if client is not None:
            try:
                await client.close()
            except Exception:  # noqa: BLE001
                pass
        await hx.aclose()
