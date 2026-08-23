"""FastAPI app-factory helpers for an A2A embed bridge: CORS, Bearer-token auth, a
concurrency-guarded SSE endpoint, /health, and static-file mounting -- the boilerplate every
bridge.py-equivalent needs, independent of any particular agent's event vocabulary or UI.

Ported from demos/inkwell-studio/server/bridge.py.
"""
from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator, Callable
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.responses import StreamingResponse

from .auth import DEFAULT_ENV_VAR, BearerTokenAuthMiddleware, get_configured_token, token_is_valid
from .ratelimit import ConcurrencyGuard

log = logging.getLogger("a2a_embed.server")


def add_cors(app: FastAPI, *, allow_origins: list[str] | None = None) -> None:
    """Mirrors jiuwenbox/src/jiuwenbox/server/app.py's CORS wiring -- the only existing
    CORSMiddleware usage in this repo."""
    app.add_middleware(
        CORSMiddleware,
        allow_origins=allow_origins or ["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )


def add_auth(app: FastAPI, *, env_var: str = DEFAULT_ENV_VAR, protect_paths: set[str] | None = None) -> None:
    """Header-based Bearer auth. `protect_paths`, if given, is an ALLOWLIST of the only
    routes checked -- name your compute/API routes here (NOT an SSE route using
    `sse_route(..., token_env_var=...)`, which needs its own query-param check instead).
    Leaving `protect_paths` unset protects every route, which breaks a bridge's own static
    front-end (see auth.py's docstring). No-ops entirely when `env_var` is unset."""
    app.add_middleware(BearerTokenAuthMiddleware, env_var=env_var, protect_paths=protect_paths)


def add_health(app: FastAPI, *, extra: Callable[[], dict] | None = None) -> None:
    @app.get("/health")
    async def health():
        payload = {"ok": True}
        if extra:
            payload.update(extra())
        return JSONResponse(payload)


def add_static(app: FastAPI, directory: Path) -> None:
    """Mount AFTER other routes are registered, so they win over this catch-all."""
    app.mount("/", StaticFiles(directory=str(directory), html=True), name="static")


def sse_route(
    app: FastAPI,
    path: str,
    stream_factory: Callable[..., AsyncIterator[dict]],
    *,
    guard: ConcurrencyGuard | None = None,
    token_env_var: str | None = None,
) -> None:
    """Register a GET SSE endpoint at `path` that calls `stream_factory(**query_params)` and
    forwards each yielded dict as a `data: <json>` SSE event. `stream_factory`'s own default
    values are used for any query param the caller omits -- FastAPI's route-level defaults
    don't apply here since query params are forwarded generically as strings.

    `token_env_var`, if given, validates the same Bearer token `add_auth` checks via header,
    but read from a `?token=` query param instead (browsers' native EventSource can't set
    custom headers -- see auth.py's docstring for the tradeoff).

    `guard`, if given, rejects the request with 429 when the concurrency cap is already in
    use, so one long-running (or hung) team-mode run can't silently starve every other caller.
    """
    async def endpoint(request: Request):
        params = dict(request.query_params)
        token = params.pop("token", None)   # the SSE auth channel, not a stream_factory arg
        if token_env_var is not None:
            expected = get_configured_token(token_env_var)
            if expected is not None and not token_is_valid(token, expected):
                return JSONResponse({"error": "unauthorized"}, status_code=401)
        if guard is not None and not guard.try_acquire():
            return JSONResponse({"error": "too many concurrent runs, try again shortly"}, status_code=429)

        async def sse() -> AsyncIterator[str]:
            try:
                async for ev in stream_factory(**params):
                    if await request.is_disconnected():
                        break
                    yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
            finally:
                if guard is not None:
                    guard.release()

        return StreamingResponse(
            sse(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    app.add_api_route(path, endpoint, methods=["GET"])
