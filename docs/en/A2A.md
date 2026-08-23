# A2A Integration Guide

This page explains the Gateway-side **A2A Server** (`A2AChannel`): implementation location, configuration, mapping to internal `Message`/E2A, and local verification commands. For outbound A2A (agent calling external services), see section 7.

> **Implementation**: `jiuwenswarm/gateway/channel_manager/protocol/a2a/a2a_connect.py` (`A2AChannel` + `a2a-sdk`). **Entrypoint process**: `python -m jiuwenswarm.gateway.app_gateway` (registered and started in `jiuwenswarm/gateway/app_gateway.py`). In case of mismatch, source code is the source of truth.

---

## 0. Document Location and Source of Truth

| Location | Role |
|------|------|
| **docs/en/A2A.md** (this page) | Integration and dev debugging: modules, config, mapping, verification |
| `jiuwenswarm/gateway/channel_manager/protocol/a2a/a2a_connect.py` | A2A HTTP service, `AgentCard`, request/response to `Message` conversion |
| `jiuwenswarm/gateway/app_gateway.py` | Env loading, `A2AChannel` construction, `channel_manager.register_channel` |
| `jiuwenswarm/gateway/message_handler/message_handler.py` | Gateway↔AgentServer E2A exchange and internal `Message` orchestration |
| `jiuwenswarm/gateway/channel_manager/channel_manager.py` | Channel registration and `robot_messages` → `Channel.send` dispatch |
| [E2A-protocol.md](E2A-protocol.md) | Inner protocol between Gateway and AgentServer |

---

## 1. Responsibility Boundary

- **Inbound (this page)**: external A2A client → `A2AChannel` → `ChannelManager` → `MessageHandler` → E2A → AgentServer; responses return through the same path, emitted as `TaskStatusUpdateEvent` / `TaskArtifactUpdateEvent` (streaming) or aggregated result (non-streaming).
- **Outbound**: Agent-side access to external A2A services (for example via A2A MCP Hub style tooling) belongs to the AgentServer adapter layer (see section 7), not `A2AChannel`.

---

## 2. Comparison with Web / ACP Channels

| Item | Web | ACP | A2A (current) |
|------|-----|-----|-------------|
| Bindings | `WEB_HOST` / `WEB_PORT` / `WEB_PATH` | `ACP_GATEWAY_*` | `A2A_SERVER_*` |
| Config source | Env + CLI (`--host`, etc.) | Env only | Env only |
| `.env` loading | `app_gateway` calls `load_dotenv(get_env_file())`, i.e. `~/.jiuwenswarm/config/.env` | same | same |

---

## 3. Environment Variables (Gateway)

Set these in `~/.jiuwenswarm/config/.env` or process environment (read by `app_gateway.py`):

Before enabling A2A, make sure the optional dependency is installed:

```bash
pip install "jiuwenswarm[a2a]"
# or (repo/dev environment)
uv sync --extra a2a
```

| Variable | Default | Notes |
|------|------|------|
| `A2A_SERVER_ENABLED` | disabled when unset | `1` / `true` / `yes` / `on` enable it |
| `A2A_SERVER_HOST` | `127.0.0.1` | HTTP bind address; `0.0.0.0` is common for external access |
| `A2A_SERVER_PORT` | `19100` | avoid conflicts with Web/ACP ports |
| `A2A_SERVER_PATH` | `/a2a` | JSON-RPC entry path |
| `A2A_SERVER_PROTOCOL_VERSION` | `1.0.0` | written into `AgentCard.AgentInterface.protocol_version` |
| `A2A_SERVER_CARD_PATH` | `/.well-known/agent-card.json` | Agent Card path |
| `A2A_SERVER_EXTENDED_CARD_PATH` | `/agent/authenticatedExtendedCard` | Extended Card path |
| `A2A_SERVER_APP_NAME` | `JiuwenSwarm Gateway A2A Server` | Agent Card `name` |
| `A2A_SERVER_APP_DESCRIPTION` | `A2A ingress for JiuwenSwarm Gateway` | Agent Card `description` |
| `A2A_SERVER_APP_VERSION` | `0.1.0` | Agent Card `version` |
| `A2A_SERVER_EXPOSE_REASONING` | `true` (enabled by default) | when enabled, reasoning (thinking) content is emitted as working-state `TaskStatusUpdateEvent` (see §6.2); set to `false`/`0`/`no`/`off` to drop it |

AgentServer connectivity still follows existing gateway config (for example `AGENT_SERVER_URL`) and is independent from the A2A listening endpoint.

When `A2A_SERVER_ENABLED=true` but `jiuwenswarm[a2a]` (or `uv sync --extra a2a`) is not installed, Gateway startup remains non-blocking; A2A channel startup failure is reported in logs with actionable install hints.

---

## 4. External Endpoints

- **JSON-RPC**: `http://{A2A_SERVER_HOST}:{A2A_SERVER_PORT}{A2A_SERVER_PATH}`
- **Agent Card**: `http://{host}:{port}/.well-known/agent-card.json` (path defined by `A2AChannelConfig.card_path`, default `/.well-known/agent-card.json`)

`AgentCard` is built in `A2AChannel.start()`: `supported_interfaces[0].url` points to the JSON-RPC endpoint above; `capabilities.streaming` and skills are defined in code.

---

## 5. Data Flow (Overview)

```mermaid
flowchart LR
    Caller["A2A Caller"]
    Ch["A2AChannel"]
    CM["ChannelManager"]
    MH["MessageHandler"]
    AS["AgentServer E2A"]

    Caller --> Ch
    Ch --> CM
    CM --> MH
    MH --> AS
    AS --> MH
    MH --> CM
    CM --> Ch
    Ch --> Caller
```

Inbound A2A `message.parts` are mapped into internal `Message.params.query` and optional `files`; no dedicated `params["a2a"]` extension object is written. Outbound internal `Message.payload` is mapped to A2A `Part` list (including multimodal parts and textified tool events).

---

## 6. Field Mapping Summary

### 6.1 Request (A2A → `Message`)

| A2A / context | Internal |
|--------------|------|
| `task_id` or generated value | `Message.id` (used to correlate replies) |
| `context_id` | `Message.session_id` |
| `parts[].text` | merged into `params.query` |
| non-text parts (`url` / `data` / `raw`) | `params.files[]` (includes web-compatible redundant keys) |
| metadata | `Message.metadata` |

### 6.2 Response (`Message` → A2A)

| Internal | A2A |
|------|-----|
| `payload.content`, tool-related events, etc. | `Part(text=...)`, etc., written into the `response` artifact |
| `payload.files[]` | `Part` url / data / raw fields |
| reasoning content (`chat.reasoning`, or `chat.delta` with `source_chunk_type == "llm_reasoning"`) | see below |

**Separating reasoning from the answer**: reasoning content never enters the `response` artifact. By default (`A2A_SERVER_EXPOSE_REASONING` enabled) it is emitted as working-state `TaskStatusUpdateEvent`s whose `status.message.parts[].metadata` carries `{"jiuwen_thought": true}` (mirroring Google ADK's `adk_thought` convention), so callers can structurally render or ignore it. Set to `false`/`0`/`no`/`off` to drop it.

### 6.3 Metadata: empty is safe, `mode` routes to team

- Request-level `Message.metadata` is always normalized to `{}` (never `None`) before it
  reaches internal routing, whether the caller sends no metadata at all or an explicit empty
  object — see `A2AChannel.dispatch_a2a_request` and `_A2AAgentExecutor.execute` in
  `a2a_connect.py`. Sending non-empty metadata (e.g. `{"source": "my-app"}`) is still good
  practice for observability on the gateway side, but it's no longer required to avoid a
  crash.
- A `mode` key in that metadata (e.g. `{"mode": "team"}`) is copied into the internal
  request's `params.mode`, routing to JiuwenSwarm's native team mode (a real leader that
  spawns teammates) instead of a single default agent — see `dispatch_a2a_request`. Omit it
  (or send anything else) to get the single-agent default.
- Team-mode runs have a generic per-agent ceiling (`max_iterations=200`,
  `completion_timeout=600s` by default — `jiuwenswarm/agents/harness/team/config_loader.py`),
  channel-agnostic and not currently overridable per A2A request. An unconstrained team brief
  can still take a long time even within that bound; keep briefs lean if your caller needs
  fast turnaround (see `demos/inkwell-studio/server/prompt.py`'s `build_team_brief` for a
  worked example of deliberately capping scope to avoid this).

---

## 7. Outbound A2A (Agent Side)

- This repository currently does not include a dedicated A2A MCP Hub registration module. If/when that capability is restored, follow the actual wiring code and environment variable definitions.

---

## 8. Local Verification (Examples)

**The `A2A-Version` header is required.** The installed a2a-sdk (1.0) validates a
`A2A-Version` request header (`a2a.utils.constants.VERSION_HEADER`) against
`PROTOCOL_VERSION_1_0` (`"1.0"`); if the header is missing, the request is treated as
protocol `"0.3"` and rejected with `VersionNotSupportedError` (see
`a2a.utils.version_validator.validate_version`, applied to the streaming handler). This is
easy to miss — the method names and body shape below are otherwise correct as written, and
a request built without this header fails with a version error that doesn't obviously point
at "add a header."

Non-streaming:

```bash
curl -sS -X POST "http://127.0.0.1:${A2A_SERVER_PORT:-19100}${A2A_SERVER_PATH:-/a2a}" \
  -H 'Content-Type: application/json' \
  -H 'A2A-Version: 1.0' \
  -d '{"jsonrpc":"2.0","id":"t1","method":"SendMessage","params":{"message":{"messageId":"m1","contextId":"c1","role":"ROLE_USER","parts":[{"text":"ping"}]}}}'
```

Streaming:

```bash
curl -sS -N -X POST "http://127.0.0.1:${A2A_SERVER_PORT:-19100}${A2A_SERVER_PATH:-/a2a}" \
  -H 'Content-Type: application/json' \
  -H 'A2A-Version: 1.0' \
  -d '{"jsonrpc":"2.0","id":"t2","method":"SendStreamingMessage","params":{"message":{"messageId":"m2","contextId":"c2","role":"ROLE_USER","parts":[{"text":"ping"}]}}}'
```

Start both AgentServer and Gateway, and ensure `A2A_SERVER_ENABLED=true`.

**Python client (what a real integration should use):** the `a2a-sdk` Python client sets
this header itself, so it's the tested, verified path rather than hand-built JSON-RPC — see
`packages/a2a-embed/a2a_embed/client.py`'s `run_agent` (used by
`demos/inkwell-studio/server/bridge.py`) for a complete, working example:

```python
from a2a.client import ClientConfig, create_client
from a2a.helpers import new_text_message
from a2a.types import SendMessageRequest

client = await create_client(a2a_url, ClientConfig(streaming=True, httpx_client=hx))
msg = new_text_message("ping", context_id="c1", role=1)   # 1 = ROLE_USER
req = SendMessageRequest(message=msg)
req.metadata.update({"source": "my-app"})                 # see 6.3 -- empty is safe, but be a good citizen
async for resp in client.send_message(req):
    ...
```

---

## 9. Known Extension Points

- Authentication, rate limit, timeout, and observability metrics are better enforced by gateway or upstream proxy, while keeping `A2AChannel` focused on protocol/message mapping. `packages/a2a-embed/` is a ready-made bridge-layer implementation of this (Bearer-token auth, CORS, a concurrency guard) for a browser-facing bridge sitting in front of `A2AChannel` — see its README and `demos/inkwell-studio/server/bridge.py` for a working example, rather than building this from scratch per integration.
- If `jiuwenswarm/resources/.env.template` does not include A2A/ACP keys, append them manually in local `.env` (consistent with section 2).
