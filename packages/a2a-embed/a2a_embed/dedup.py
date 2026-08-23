"""Whitespace-insensitive dedup, keeping the longest (best-spaced) variant of each distinct
event. Ported from demos/inkwell-studio/server/bridge.py, where it exists because some A2A
streaming paths strip whitespace from live per-chunk deltas -- only a later, corrected
variant of the same event carries correct inter-token spacing (see docs/en/A2A.md).
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
