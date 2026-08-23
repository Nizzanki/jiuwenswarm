"""Live-progress forwarding: `run_agent`'s `on_event` callback fires per-line, as text
streams in, well before the run finishes or its output is deduped/corrected. A caller that
wants to show partial progress before then (rather than leaving the UI frozen for the whole
call) fans early events through `LiveRelay`, which:

  - lets the caller decide, via `live_view`, which events are safe to show early (e.g. an
    enum status field is safe; free text may still be whitespace-corrupted -- see dedup.py)
    and reshapes/drops them accordingly,
  - dedups by identity so a repeated event is only forwarded once,
  - signals completion (success or error) unconditionally, so a drainer never hangs.

Ported from demos/inkwell-studio/server/bridge.py's `_collect_swarm_live`/`_drain_live`.
"""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable

from .dedup import identity

_DONE = object()

LiveView = Callable[[dict], "dict | None"]


class LiveRelay:
    """`live_view(event)` returns a live-safe rendition of `event`, or None to skip it."""

    def __init__(self, live_view: LiveView):
        self._live_view = live_view
        self.queue: asyncio.Queue = asyncio.Queue()
        self.seen: set[str] = set()

    def on_event(self, ev: dict) -> None:
        live = self._live_view(ev)
        if live is None:
            return
        ident = identity(live)
        if ident in self.seen:
            return
        self.seen.add(ident)
        self.queue.put_nowait(live)

    def close(self) -> None:
        self.queue.put_nowait(_DONE)

    async def drain(self) -> AsyncIterator[dict]:
        """Yield live-safe events as they arrive until `close()` is called."""
        while True:
            item = await self.queue.get()
            if item is _DONE:
                return
            yield item
