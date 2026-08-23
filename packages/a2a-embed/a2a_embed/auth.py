"""Opt-in Bearer token authentication for an A2A embed bridge, ported from jiuwenbox's
identical pattern (jiuwenbox/src/jiuwenbox/server/auth.py) -- the only inbound-auth
convention that already existed in this repo. No-ops entirely when the configured token env
var is unset, so a bridge keeps working with zero config until an operator opts in.

Single shared-secret token, not per-customer key management: no such infra exists anywhere
in this repo, and inventing one here would be speculative. A caller that needs scoped,
per-customer tokens should front this with its own token-issuing layer; this middleware only
answers "is the caller allowed at all."

Browsers' native EventSource can't set custom headers, so an SSE endpoint can't rely on this
middleware alone -- see `server.sse_route`'s `token_env_var`, which validates the same token
from a `?token=` query param instead. That's a real, documented tradeoff (the token rides in
the URL: server access logs, browser history, Referer headers), acceptable for a
low-privilege scoped token but worth knowing about before reusing this for anything higher-
stakes.

A bridge that also serves its own static front-end same-origin should pass `protect_paths`
naming only its actual compute/API routes -- see `BearerTokenAuthMiddleware`'s docstring for
why leaving it at the default (protect everything) breaks the page's own initial load.
"""
from __future__ import annotations

import hmac
import os

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

DEFAULT_ENV_VAR = "A2A_EMBED_API_TOKEN"


def get_configured_token(env_var: str = DEFAULT_ENV_VAR) -> str | None:
    """Return the configured API token, or `None` when auth is disabled."""
    raw = os.environ.get(env_var)
    if raw is None:
        return None
    token = raw.strip()
    return token or None


def extract_bearer_token(authorization: str | None) -> str | None:
    if not authorization:
        return None
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        return None
    stripped = token.strip()
    return stripped or None


def token_is_valid(provided: str | None, expected: str | None) -> bool:
    if provided is None or expected is None:
        return False
    return hmac.compare_digest(provided.encode("utf-8"), expected.encode("utf-8"))


class BearerTokenAuthMiddleware(BaseHTTPMiddleware):
    """Require `Authorization: Bearer <token>` when `env_var` is set.

    `protect_paths`, if given, is an ALLOWLIST: only those exact paths are checked, and
    everything else (e.g. a static-file mount serving the app's own HTML/JS/CSS, or /health)
    passes through unauthenticated. `None` (the default) protects every route, which is
    right for an API-only bridge but WRONG for one that also serves its own static front-end
    same-origin -- a plain browser navigation can't attach an Authorization header to a
    top-level page load, so blanket protection would make the page itself unloadable. Pass
    `protect_paths` naming your actual compute/API routes (see server.sse_route's own
    `token_env_var` for the SSE route specifically, which needs a query-param check instead
    since EventSource can't set headers at all -- don't put it in `protect_paths` too).
    """

    def __init__(self, app, env_var: str = DEFAULT_ENV_VAR, protect_paths: set[str] | None = None):
        super().__init__(app)
        self._env_var = env_var
        self._protect_paths = protect_paths

    async def dispatch(self, request: Request, call_next) -> Response:
        expected = get_configured_token(self._env_var)
        if expected is None:
            return await call_next(request)
        if self._protect_paths is not None and request.url.path not in self._protect_paths:
            return await call_next(request)

        provided = extract_bearer_token(request.headers.get("Authorization"))
        if not token_is_valid(provided, expected):
            return JSONResponse(
                status_code=401,
                content={"error": "unauthorized"},
                headers={"WWW-Authenticate": "Bearer"},
            )
        return await call_next(request)
