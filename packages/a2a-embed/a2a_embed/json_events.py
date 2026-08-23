"""Line-delimited JSON protocol extraction, robust to a real agent/team run's tool-event
noise (Python-dict reprs, unbalanced braces mixed in around clean protocol lines). Ported
from demos/inkwell-studio/server/bridge.py, generalized: callers supply their own
`known_events` vocabulary (a set of `t` values) instead of importing one hardcoded set.
"""
from __future__ import annotations

import json


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


def parse_line(line: str, known_events: set[str]) -> list[dict]:
    """Extract known protocol events from a single line (see parse_events). Split out so a
    live incremental scanner can reuse the exact same per-line extraction without waiting
    for the whole buffer."""
    out: list[dict] = []

    def _keep(raw: str) -> None:
        try:
            ev = json.loads(raw)
        except (ValueError, TypeError):
            return
        if isinstance(ev, dict) and ev.get("t") in known_events:
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


def parse_events(buf: str, known_events: set[str]) -> list[dict]:
    """Extract known protocol events from `buf`, line-scoped so it's robust to the heavy
    tool-event noise of a real team run (Python-dict reprs, unbalanced braces). A well-
    behaved agent that emits one JSON object per line satisfies this trivially too."""
    out: list[dict] = []
    for line in buf.splitlines():
        out.extend(parse_line(line, known_events))
    return out


def new_complete_lines(buf: str, scanned: int) -> tuple[list[str], int]:
    """Complete (newline-terminated) lines in buf[scanned:] not yet handed to a caller, and
    the new scan offset. The trailing partial line (no newline yet) is left for next time."""
    idx = buf.rfind("\n", scanned)
    if idx == -1:
        return [], scanned
    return buf[scanned:idx].splitlines(), idx + 1
