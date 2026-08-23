"""Retry-then-fallback wrapper for a pluggable, possibly-flaky async call (e.g. an image
backend): try `call` up to `retries` times with a backoff delay between attempts, then fall
back to `fallback` once so the caller always gets *something* rather than nothing.

Ported from demos/inkwell-studio/server/bridge.py's `_render_panel_resilient`, generalized
past image rendering to any `() -> (result, error)` async callable.
"""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from typing import TypeVar

log = logging.getLogger("a2a_embed.resilient")

T = TypeVar("T")


async def call_resilient(
    call: Callable[[], Awaitable[tuple[T | None, str | None]]],
    fallback: Callable[[], Awaitable[T]],
    *,
    retries: int = 3,
    backoff: Callable[[int], float] = lambda attempt: min(6 * attempt, 20),
    on_retry: Callable[[int, str | None], None] | None = None,
) -> tuple[T | None, str | None]:
    """`call` returns `(result, error)`; a falsy `result` triggers a retry. After `retries`
    attempts, `fallback` is tried once. `on_retry(attempt, error)`, if given, fires between
    attempts (for logging/telemetry) before the backoff sleep.
    """
    err: str | None = None
    for attempt in range(1, retries + 1):
        try:
            result, err = await call()
        except Exception as exc:  # noqa: BLE001 -- `call` shouldn't raise, but don't trust that
            log.exception("call_resilient: attempt %d raised", attempt)
            result, err = None, f"{type(exc).__name__}: {exc}"
        if result:
            return result, None
        if attempt < retries:
            if on_retry:
                on_retry(attempt, err)
            await asyncio.sleep(backoff(attempt))
    try:
        return await fallback(), None
    except Exception:  # noqa: BLE001
        log.exception("call_resilient: fallback failed too")
        return None, err
