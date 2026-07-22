# Inkwell Studio

A **Story Studio** demo: type one story idea + a style, press **Go**, and watch a *crew of
agents* turn it into an illustrated short story — **panel by panel, live**. The hook is the
**Critic rejecting a weak panel and the Writer revising it** in full view.

This is a **Path 2** demo: Inkwell Studio is a standalone app with its own front-end. In
**Live** mode it talks to [JiuwenSwarm](../../) as a *service* over **A2A**. JiuwenSwarm is the
engine, not the shell — so A2UI is not used; this front-end renders every panel and crew card
itself from the swarm's JSON.

> **Framework untouched.** Everything here lives under `demos/` and does not modify any
> JiuwenSwarm source. The one framework bug we hit is worked around from our side (see below).

## One engine

The front-end renders entirely from a `state` model mutated by a single `apply(event)`
reducer. Events come from `A2AEventSource`, which subscribes to the bridge's SSE stream — the
bridge runs a **real JiuwenSwarm story over A2A** and forwards normalized events that the
reducer/renderers turn into panels, crew status, and the revision log.

(An earlier phase had a `SimEventSource` — a scripted, client-side-only run used to lock the
UX before the real A2A integration existed. It's since been removed; the live engine is the
only path now.)

## Run it

Needs the repo venv (`uv sync --extra a2a`) and three processes. From the repo root:

```bash
# 1. AgentServer
.venv/Scripts/python.exe -m jiuwenswarm.server.app_agentserver

# 2. Gateway with the A2A channel enabled
A2A_SERVER_ENABLED=true .venv/Scripts/python.exe -m jiuwenswarm.gateway.app_gateway

# 3. The Inkwell bridge (serves the front-end + SSE)
.venv/Scripts/python.exe demos/inkwell-studio/server/bridge.py
```
Then open **http://127.0.0.1:8800/** and press **Go**. Model credentials must be set in
`~/.jiuwenswarm/config/.env` (`API_BASE`/`API_KEY`/`MODEL_NAME`/`MODEL_PROVIDER`).

> If the bridge/servers aren't reachable, the run aborts with a visible error instead of
> silently continuing — there's no other engine to fall back to.

## How Live mode works

Live mode runs a **genuine JiuwenSwarm multi-agent team** (the `jiuwen_team`) by default: a leader
agent spawns real **Writer** and **Critic** teammate agents, delegates tasks, and the Critic really
reviews and rejects a panel that the Writer then revises — all coordinated by JiuwenSwarm's own
`TeamAgent`, not one agent pretending.

```
browser (unchanged reducer)
  │  EventSource (SSE)                          ▲ normalized events from the bridge
  ▼                                             │
server/bridge.py  ── buffer → line-parse → paced replay + concurrent images ──┐
  │  A2A SendStreamingMessage (metadata mode=team)                             │
  ▼                                                                            │
Gateway (:19100/a2a) → AgentServer → jiuwen_team: leader ⇄ Writer/Critic teammates ┘
```

- **`server/prompt.py`** — `build_team_brief`: a **lean** leader brief (small crew, few panels, one
  real rejection) so the team completes in bounded time, and emits our JSON event protocol as its
  final answer. (`build_brief` is the single-agent fallback.)
- **`server/bridge.py`** — an a2a-sdk client that routes to the team (`metadata={"mode":"team"}`), a
  **line-scoped** protocol parser (robust to the heavy tool-event noise of a real team run), image
  rendering, SSE, and the static front-end. If a team run doesn't yield usable protocol, it **falls
  back to the single agent** so Live still delivers a story.

The protocol events are the original event shapes (`panel.status|caption|art|note`, `agent`, `log`,
`progress`, `focus`, `brief`, `run.done`). `panel.art` carries the Art Director's **image prompt**;
the bridge renders a picture and emits `panel.image` (a data URI) that the front-end swaps in. If the
render fails the bridge emits `panel.image.failed` (with a `reason`) instead, so the panel shows
**no image · why** rather than a `rendering…` badge that never resolves. Both are bridge-generated —
they're not part of the agent-emitted protocol, so they're absent from `KNOWN_EVENTS`.

### What the framework edit / config does (real-team enablement)

Routing an inbound A2A request into the native team needs `params.mode="team"`, which the A2A channel
didn't set (and `default_mode` config / the `/mode` command are gated to non-A2A "control channels").
So there is **one small framework edit** — in `jiuwenswarm/gateway/channel_manager/protocol/a2a/
a2a_connect.py`, the A2A request's metadata `mode` is copied into `params.mode` (~3 lines). Plus a
config change in `~/.jiuwenswarm/config/config.yaml`: the team leader/teammate `max_iterations` and
`completion_timeout` are lowered so the team can't poll/coordinate forever (an unbounded team run
deadlocks over A2A). Set `INKWELL_TEAM=0` to force the single-agent engine instead.

## Images (Phase 3)

Per Path 2, the **bridge renders the pictures** (like the front-end renders panels) — JiuwenSwarm
`config.yaml` is untouched. `server/imagegen.py` is pluggable via env, renders panels **concurrently**
and **pops them in progressively** (panels show caption/prompt immediately; images arrive when ready).

| `IMAGE_BACKEND` | What it does | Extra env |
|-----------------|--------------|-----------|
| `stub` (default) | A real image generated locally from the prompt — a mood-board gradient with the prompt text. Zero setup; **not model art**. | — |
| `a1111` | Automatic1111 / SD.Next `POST {IMAGE_URL}/sdapi/v1/txt2img` | `IMAGE_URL`, `IMAGE_STEPS` |
| `openai` | OpenAI-compatible `POST {IMAGE_URL}/v1/images/generations` (DashScope Qwen-Image, local, hosted…) | `IMAGE_URL`, `IMAGE_KEY`, `IMAGE_MODEL` |

Also: `IMAGE_SIZE` (default `768x480`), `IMAGE_TIMEOUT`, `IMAGE_RETRIES` (attempts on 429/5xx,
default `3`), `IMAGE_CONCURRENCY` (default `2`).

**On failures:** requests that come back `429` or `5xx` are retried with backoff, honoring
`Retry-After` — free image tiers rate-limit on bursts, and a story is a burst (one render per panel,
plus another per revision). If a panel still can't be rendered, the panel keeps its prompt placeholder
**and says why**, and the bridge logs a warning. Raise `IMAGE_CONCURRENCY` only if your endpoint has
the headroom. Point `IMAGE_BACKEND` at a real **SDXL/Flux** endpoint for genuine art:

```bash
IMAGE_BACKEND=a1111 IMAGE_URL=http://127.0.0.1:7860 \
  .venv/Scripts/python.exe demos/inkwell-studio/server/bridge.py
```

## Child-safety moderation

Every caption and image prompt is required to be child-appropriate (roughly ages 4-8) —
enforced at three layers, from softest to hardest:

1. `server/prompt.py`'s brief instructs the crew directly: no violence, weapons, gore, death,
   scary imagery, horror, or adult themes — including the intentionally-rejected panel-3
   draft, which must be flawed for being flat/rushed, never for being scary.
2. `server/imagegen.py` appends a child-safe tag to every real (`a1111`/`openai`) image
   render, independent of what the crew's Art Director wrote — this also covers `/restyle`,
   which reuses the same render call.
3. `server/moderate.py` runs an independent classifier call (over A2A — the same path the
   story itself uses, so it always hits the real configured model) on every caption and image
   prompt **before** anything is shown or rendered. A flagged panel's text/prompt is replaced
   with a neutral filler (visible directly in the caption, honestly, rather than hidden) —
   only that panel is touched, the rest of the story is unaffected. All of a story's texts
   (~10-12 for a typical run: every caption + every image prompt, including revisions) go in
   **one** batched classification call, not one call per text — that was tried first and made
   the initial run noticeably slower, since each call is a full A2A agent turn with real
   framework overhead on top of the model's own inference time.

**Honesty caveat:** layer 3 fails **open** by default — if the moderation call itself errors
(timeout, unreachable Gateway, malformed response), the content passes rather than the run
aborting on a moderation hiccup. Set `MODERATION_FAIL_OPEN=0` to fail closed instead. Other
knob: `MODERATION_TIMEOUT` (default `45`s for the whole batch call).

## Download story

At the end of a run the **⤓ Download story** button (in "Story so far") exports a **self-contained
HTML flip-book** — a cover page, one page per panel (picture + serif caption), and a closing page,
turned with Prev/Next buttons, left/right click zones, or arrow keys. The turn is a real CSS 3D
page-rotation, not a page reload — no external library, so the file still opens and works
completely offline. Opens and shares anywhere.

## Coloring book

Pick the **Coloring book · Black & white line art** style preset (prompt bar or Restyle) — the
crew/image backend is simply asked to draw in that style, same as any other preset.

## Demo clip

`server/capture.py` grabs frames of a run over the DevTools Protocol; stitch them with `ffmpeg`
(commands in the file's docstring). Actual recording/stitching is a manual step.

## What's real vs. approximate (honesty)

- **Real multi-agent team (default):** Live runs the genuine `jiuwen_team` — a leader agent spawns
  real Writer and Critic **teammate agents** (separate LLM contexts) and coordinates them; the
  Critic's rejection and the Writer's revision are real handoffs, not one agent role-playing.
  Verified in the AgentServer logs (`team ... completed: 3 members, 2 tasks`).
- **The cost of "real":** a real team run takes **~1–3 minutes** (each teammate makes its own LLM
  calls; the leader coordinates), versus ~30s for the single agent. It's also **non-deterministic** —
  the crew/panel counts vary, and occasionally the leader answers in prose instead of the protocol,
  in which case the bridge **falls back to the single agent**. The brief is kept deliberately lean
  (small crew, few panels, one rejection) because an unconstrained team run **deadlocks** over A2A
  (the leader polls teammates that never finish). `INKWELL_TEAM=0` uses the fast single agent.
- **Images (Phase 3):** the default `stub` backend generates a real image locally from the prompt,
  but it's a labeled mood-board placeholder, **not model art**. Real SDXL/Flux art needs you to run
  an endpoint (A1111/ComfyUI/OpenAI-compatible) and set `IMAGE_BACKEND` — see the Images section.
- **Images (Phase 3):** the default `stub` backend generates a real image locally from the prompt,
  but it's a labeled mood-board placeholder, **not model art**. Real SDXL/Flux art needs you to run
  an endpoint (A1111/ComfyUI/OpenAI-compatible) and set `IMAGE_BACKEND` — see the Images section.
- **Buffer-then-replay, not token-streaming:** the A2A channel strips whitespace from each
  streamed chunk (`message_to_a2a_parts` does `content.strip()`), so live token deltas lose their
  spaces. The bridge collects the run, keeps the best-spaced variant of each event, and replays it
  with gentle pacing. Panels appear after the story is written, shown as a "crew is drafting" state.
- **Team captions can lose their spaces:** for single-agent runs the swarm sends a final
  correctly-spaced block that the bridge prefers; **team** runs don't always send that block, so some
  team runs render space-stripped captions ("Avastsea..."). It's the same A2A framework strip, hit
  non-deterministically. Structure (panels, crew, the real rejection) is unaffected;
  `INKWELL_TEAM=0` (single agent) reliably has correct spacing.
- **Framework bug worked around:** an A2A request with empty metadata crashes the Gateway
  (`message_handler.py:317` calls `.get` on `None`). The bridge always sends non-empty
  request-level metadata to avoid it.
- **Non-determinism:** even guided, a rare run may emit a malformed line or skip the rejection.
  The bridge is tolerant (drops noise, always sends a terminal `run.done`) and the prompt insists
  on one real revision, but the money-moment isn't 100% guaranteed every run.

## Accessibility
Respects `prefers-reduced-motion`: shimmer, pulsing crew dots, the caption typewriter, and card
entrance animations are all disabled; runs still complete.

## Roadmap
- **Phase 1 (done, later removed):** interactive simulated prototype — locked the UX before the
  real A2A integration existed.
- **Phase 2 (done):** real 5-role JiuwenSwarm run over A2A, streamed to the same UI via the bridge.
  The simulated engine was removed once this became the sole, reliable path.
- **Phase 3 (this):** pluggable image backend (stub default; A1111 / OpenAI-compatible for real
  SDXL/Flux) with concurrent progressive reveal, a self-contained **Download story** export, and a
  demo-clip frame grabber.
