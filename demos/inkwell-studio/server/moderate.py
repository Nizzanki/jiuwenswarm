"""Child-safety moderation for the Inkwell bridge: an independent check on each panel's
caption and image prompt BEFORE it's ever shown to a viewer or used to render a picture — a
backstop for when the story-writing model doesn't perfectly follow server/prompt.py's
CHILD-SAFE instruction.

Goes over A2A (the same Gateway → AgentServer path the story itself uses), NOT a direct HTTP
call to the model: `~/.jiuwenswarm/config/.env`'s API_BASE/MODEL_NAME are template values in
this repo checkout (`example.com`, `your-model-name`) — the real credentials the story path
actually resolves to aren't reliably readable from a fresh process. Routing through A2A means
moderation always hits whatever model JiuwenSwarm is actually configured with, with no
separate credential-reading logic to keep in sync.

check_child_safe_batch() classifies MULTIPLE texts in ONE A2A call rather than one call per
text — a full agent turn has real framework/round-trip overhead on top of the model's own
inference time, and a typical story needs ~10-12 checks (every caption + every image prompt,
including revisions), so one call per text was a real, measured cause of the initial run
becoming noticeably slower once moderation was added. check_child_safe_grouped() dispatches
several such batch calls CONCURRENTLY (bridge.py uses one group per panel) — panels are
independent, so there's no reason to also serialize the batch calls against each other; that
was the next-biggest cost once per-text calls were fixed. check_child_safe() (single-text) is
kept for callers that only ever have one piece of text to check.

Fails OPEN on any moderation-call error (timeout, bad response, malformed JSON): content
passes rather than the whole story failing on a moderation hiccup. Set
MODERATION_FAIL_OPEN=0 to fail closed (treat errors as unsafe) instead.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import uuid

import httpx

from a2a.client import ClientConfig, create_client
from a2a.helpers import get_stream_response_text, new_text_message
from a2a.types import SendMessageRequest

log = logging.getLogger("inkwell.moderate")

A2A_URL = os.getenv("A2A_URL", "http://127.0.0.1:19100")
TIMEOUT = float(os.getenv("MODERATION_TIMEOUT", "45") or 45)
FAIL_OPEN = os.getenv("MODERATION_FAIL_OPEN", "1").strip().lower() in {"1", "true", "yes", "on"}

SYSTEM = (
    "You are a strict content-safety classifier for a children's story app (readers as young "
    "as 4-8). You will be given ONE piece of text: either a story caption or an "
    "image-generation prompt. Decide whether it is appropriate for young children. Flag ANY "
    "violence, weapons, blood/gore, death, scary or frightening imagery, horror, adult "
    "themes, or innuendo. Respond with ONLY one compact JSON object and NOTHING else — no "
    "prose, no markdown fences:\n"
    '{"safe": true|false, "reason": "<short reason if unsafe, else empty string>"}'
)

SYSTEM_BATCH = (
    "You are a strict content-safety classifier for a children's story app (readers as young "
    "as 4-8). You will be given a NUMBERED LIST of texts — each is either a story caption or "
    "an image-generation prompt. For EACH one, decide whether it is appropriate for young "
    "children. Flag ANY violence, weapons, blood/gore, death, scary or frightening imagery, "
    "horror, adult themes, or innuendo. Respond with ONLY one compact JSON array, one object "
    "per input IN THE SAME ORDER as the numbered list, and NOTHING else — no prose, no "
    "markdown fences:\n"
    '[{"safe": true|false, "reason": "<short reason if unsafe, else empty string>"}, ...]'
)


async def _call(prompt: str) -> str:
    """Send one message over A2A and return the buffered response text."""
    context_id = f"inkwell_mod_{uuid.uuid4().hex[:12]}"
    hx = httpx.AsyncClient(timeout=httpx.Timeout(TIMEOUT, connect=10.0))
    client = None
    try:
        client = await create_client(A2A_URL, ClientConfig(streaming=True, httpx_client=hx))
        msg = new_text_message(prompt, context_id=context_id, role=1)  # 1 = ROLE_USER
        req = SendMessageRequest(message=msg)
        req.metadata.update({"source": "inkwell-studio-moderation"})  # MUST be non-empty
        buf = ""
        async for resp in client.send_message(req):
            if resp.WhichOneof("payload") != "artifact_update":
                continue
            chunk = get_stream_response_text(resp) or ""
            if chunk:
                buf += chunk
        return buf
    finally:
        if client is not None:
            try:
                await client.close()
            except Exception:  # noqa: BLE001
                pass
        await hx.aclose()


async def check_child_safe(text: str) -> tuple[bool, str | None]:
    """Returns (is_safe, reason). `reason` is None when safe or when a moderation-call error
    fails open. For more than one text, use check_child_safe_batch instead — one A2A call
    per text is the slow path this module used to take."""
    text = (text or "").strip()
    if not text:
        return True, None
    try:
        buf = await _call(f"{SYSTEM}\n\nTEXT TO CLASSIFY:\n{text}")
        parsed = json.loads(_extract_json(buf))
        safe = bool(parsed.get("safe", True))
        reason = (str(parsed.get("reason") or "") or None) if not safe else None
        return safe, reason
    except Exception as exc:  # noqa: BLE001
        log.warning("moderation call failed (%s) — %s", exc,
                    "failing open, content passes" if FAIL_OPEN else "failing closed")
        return FAIL_OPEN, (None if FAIL_OPEN else "moderation check failed")


async def check_child_safe_batch(texts: list[str]) -> list[tuple[bool, str | None]]:
    """Classify MULTIPLE texts in ONE A2A call. Returns one (is_safe, reason) per input,
    same order, same length as `texts`. Empty strings are treated as trivially safe without
    spending a slot in the batch.

    Fails OPEN for every item if the batch call itself errors or the response can't be
    parsed — same trade-off as check_child_safe, just correlated across the whole batch
    instead of independent per item (acceptable: this demo prioritizes not blocking a run
    over catching every possible edge case in the moderation layer itself)."""
    cleaned = [(t or "").strip() for t in texts]
    indices = [i for i, t in enumerate(cleaned) if t]
    if not indices:
        return [(True, None)] * len(cleaned)

    numbered = "\n".join(f"{n}. {cleaned[i]}" for n, i in enumerate(indices, start=1))
    try:
        buf = await _call(f"{SYSTEM_BATCH}\n\nTEXTS TO CLASSIFY:\n{numbered}")
        parsed = json.loads(_extract_json_array(buf))
        results: list[tuple[bool, str | None]] = [(True, None)] * len(cleaned)
        for n, i in enumerate(indices):
            item = parsed[n] if n < len(parsed) else {}
            safe = bool(item.get("safe", True)) if isinstance(item, dict) else True
            reason = (str(item.get("reason") or "") or None) if isinstance(item, dict) and not safe else None
            results[i] = (safe, reason)
        return results
    except Exception as exc:  # noqa: BLE001
        log.warning("batch moderation call failed (%s) — %s", exc,
                    "failing open, content passes" if FAIL_OPEN else "failing closed")
        return [(FAIL_OPEN, None if FAIL_OPEN else "moderation check failed")] * len(cleaned)


async def check_child_safe_grouped(groups: list[list[str]]) -> list[list[tuple[bool, str | None]]]:
    """Classify multiple GROUPS of texts concurrently — one check_child_safe_batch call per
    group, all groups in flight at once via asyncio.gather. Bridge.py uses one group per
    panel (its caption + its art prompt): panels are independent, so there's no reason their
    moderation checks should wait on each other.

    This replaced a single whole-story batch call, which was the single largest serial link
    in the pipeline (nothing downstream — not even the first image — could start until that
    one call returned). N concurrent small calls cuts moderation wall-clock down to roughly
    the slowest individual call instead of one call carrying the whole story's texts, the
    same trade the demo already makes for image rendering (IMAGE_CONCURRENCY): more
    concurrent requests to the Gateway in exchange for wall-clock time. Fail-open is now
    scoped per group instead of per story, which is also a strict improvement — one panel's
    moderation hiccup no longer risks failing open every other panel's check too."""
    if not groups:
        return []
    return await asyncio.gather(*(check_child_safe_batch(g) for g in groups))


def _extract_balanced(s: str, open_ch: str, close_ch: str) -> list[str]:
    """Top-level open_ch...close_ch balanced substrings, string/escape-aware (mirrors
    bridge.py's extract_json_objects). Needed because _call() concatenates every streamed
    chunk into one buffer, and the A2A channel streams unspaced token deltas followed by a
    full correctly-spaced duplicate (see bridge.py's module docstring) — so the buffer
    typically contains the JSON value TWICE. A naive first-open-to-last-close slice spans
    both copies and hands json.loads two back-to-back values, which raises "Extra data"."""
    out: list[str] = []
    start: int | None = None
    depth = 0
    in_str = False
    esc = False
    for i, c in enumerate(s):
        if start is None:
            if c == open_ch:
                start, depth, in_str, esc = i, 1, False, False
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
            elif c == open_ch:
                depth += 1
            elif c == close_ch:
                depth -= 1
                if depth == 0:
                    out.append(s[start:i + 1])
                    start = None
    return out


def _extract_json(s: str) -> str:
    """The classifier may wrap the JSON in stray text or fences; pull out the LAST complete
    {...} (the final, correctly-spaced consolidated copy — see _extract_balanced)."""
    objs = _extract_balanced(s.strip(), "{", "}")
    if not objs:
        raise ValueError("no JSON object in moderation response")
    return objs[-1]


def _extract_json_array(s: str) -> str:
    """Same idea as _extract_json but for a [...] array response."""
    arrays = _extract_balanced(s.strip(), "[", "]")
    if not arrays:
        raise ValueError("no JSON array in moderation response")
    return arrays[-1]
