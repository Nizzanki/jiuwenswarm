# a2a-embed

Reusable transport/relay layer for a browser-facing bridge that drives a JiuwenSwarm agent
or team over A2A and streams its output to a front-end as SSE. Extracted from
`demos/inkwell-studio/server/bridge.py` — see
`demos/inkwell-studio/docs/productization-architecture.md` for the before/after picture and
why this split exists.

## What's in here (generic) vs. what stays per-app (domain-specific)

This package handles the infrastructure every A2A-embedding bridge needs: talking to the
gateway, framing its line-delimited JSON protocol, forwarding live progress, retrying flaky
sub-calls, and the FastAPI plumbing (auth, CORS, rate-limiting, the SSE route itself).

It does **not** define your app's event vocabulary, prompt/guided-protocol, or how you
render the result — that's the actual creative and domain work, and it's different for
every app. See `demos/inkwell-studio/server/prompt.py` for what that looks like for a
storybook app.

## Modules

- **`client.run_agent`** — send one prompt to an agent/team over A2A, stream the response,
  return every parsed protocol event. Pass `known_events` (your app's vocabulary) and
  optionally `metadata={"mode": "team"}` to route to JiuwenSwarm's native team mode.
- **`json_events`** — line-delimited JSON extraction, robust to a real team run's tool-event
  noise (`parse_events`, `parse_line`, `extract_json_objects`, `new_complete_lines`).
- **`dedup`** — whitespace-insensitive dedup keeping the best-spaced variant of each event
  (`identity`, `best_variants`).
- **`live.LiveRelay`** — fan early (pre-dedup) events out to a consumer via a caller-supplied
  `live_view(event) -> event | None` predicate, so a UI isn't frozen for the whole call.
- **`resilient.call_resilient`** — retry-then-fallback wrapper for a flaky async call (e.g.
  an image backend): N retries with backoff, then one fallback attempt.
- **`server`** — FastAPI app-factory helpers: `add_cors`, `add_auth`, `add_health`,
  `add_static`, and `sse_route` (a concurrency-guarded, optionally token-checked SSE route).
- **`auth`** — opt-in Bearer-token middleware, ported from
  `jiuwenbox/src/jiuwenbox/server/auth.py` (the only existing inbound-auth convention in
  this repo). No-ops when its env var is unset.
- **`ratelimit.ConcurrencyGuard`** — caps simultaneous in-flight runs (not a
  requests-per-minute limiter — see the module docstring for why).

## Wiring a new app

1. Define your event vocabulary and guided-protocol prompt (your own `prompt.py`-equivalent —
   see Inkwell's for the shape: a `PROTOCOL_SPEC` describing exact JSON events, plus
   `build_brief`/`build_*` functions that embed it into the prompt sent to the agent/team).
2. Call `run_agent(a2a_url, prompt, known_events=YOUR_EVENTS, on_event=...)` to run it.
3. If you want live progress, create a `LiveRelay(your_live_view)`, pass its `on_event` as
   `run_agent`'s `on_event`, and drain it concurrently with the run (see
   `demos/inkwell-studio/server/bridge.py`'s `_collect_swarm_live`/`stream_story` for the
   pattern — the concurrent-task-plus-queue shape didn't move into this package because it's
   only a few lines of `asyncio` glue once you have `LiveRelay`, and forcing it into a fixed
   shape would constrain how a different app's live/final merge actually needs to work).
4. Wire a FastAPI app with `server.add_cors`, `server.add_auth`, `server.add_health`, and
   `server.sse_route(app, "/events", your_stream_generator, guard=ConcurrencyGuard.from_env(...), token_env_var="YOUR_APP_API_TOKEN")`.
5. Write your own front-end adapter. If you're driving it from a browser, `demos/inkwell-studio/embed/agent-embed.js`'s
   `AgentEmbedSource` is the reusable SSE client half of that (see its own file header).

## Env vars (bridge author picks the var names; these are just the defaults)

- `auth.DEFAULT_ENV_VAR` (`A2A_EMBED_API_TOKEN`) — set to require `Authorization: Bearer
  <token>` (and, for SSE, `?token=<token>`) on every request. Unset = no auth (default).
  Pass your own `env_var=` to `add_auth`/`sse_route` to use an app-specific name instead
  (Inkwell uses `INKWELL_API_TOKEN`).
- Rate limiting has no fixed env var name — call `ConcurrencyGuard.from_env("YOUR_VAR", default)`
  with whatever name fits your app.
