"""A concurrency cap for A2A-driven runs -- not a requests-per-minute limiter. The
documented risk for this kind of bridge isn't request volume, it's a single run (especially
team-mode) hanging for a long time and tying up a server slot; capping how many runs can be
in flight at once bounds that blast radius without needing to guess at a request rate.
"""
from __future__ import annotations

import os


class ConcurrencyGuard:
    """`try_acquire()` / `release()` around a run. `max_concurrent <= 0` disables the cap."""

    def __init__(self, max_concurrent: int):
        self.max_concurrent = max_concurrent
        self._in_flight = 0

    def try_acquire(self) -> bool:
        if self.max_concurrent <= 0:
            return True
        if self._in_flight >= self.max_concurrent:
            return False
        self._in_flight += 1
        return True

    def release(self) -> None:
        if self._in_flight > 0:
            self._in_flight -= 1

    @classmethod
    def from_env(cls, env_var: str, default: int) -> "ConcurrencyGuard":
        return cls(int(os.environ.get(env_var, default) or default))
