"""Whitespace-insensitive dedup, keeping the longest variant of each distinct event. Ported
from demos/inkwell-studio/server/bridge.py, where it exists because jiuwenswarm's chat.final
event replays a turn's full consolidated text as one more A2A artifact part on top of the
chat.delta chunks already streamed for that same content (other channels, e.g. the CLI
renderer, explicitly skip re-printing chat.final once a delta has been written; A2AChannel
doesn't), so a raw A2A event stream genuinely contains each logical line twice -- see
docs/en/A2A.md section 6. (A separate, now-fixed bug used to also strip whitespace from the
delta copy specifically, which is why "longest" was originally framed as "best-spaced" --
that corruption is fixed at the source now, but the two copies -- and the need to dedup them
-- predate and outlive it.)
"""
from __future__ import annotations

import json


def identity(ev: dict) -> str:
    """Whitespace-insensitive identity so spaced/unspaced variants collapse together."""
    return "".join(json.dumps(ev, sort_keys=True, ensure_ascii=False).split())


def best_variants(events: list[dict]) -> list[dict]:
    """Dedup by identity, keeping the longest (best-spaced) variant, in first-seen order."""
    order: list[str] = []
    best: dict[str, tuple[int, dict]] = {}
    for ev in events:
        ident = identity(ev)
        raw_len = len(json.dumps(ev, ensure_ascii=False))
        if ident not in best:
            order.append(ident)
            best[ident] = (raw_len, ev)
        elif raw_len > best[ident][0]:
            best[ident] = (raw_len, ev)
    return [best[i][1] for i in order]
