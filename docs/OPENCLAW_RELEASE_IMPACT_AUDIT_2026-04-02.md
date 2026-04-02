# OpenClaw Release Impact Audit — 2026-04-02

This audit records the Mission Control surfaces that were rechecked after the local OpenClaw runtime moved to `2026.4.1` on `2026-04-01`.

Release references:

- OpenClaw releases: <https://github.com/openclaw/openclaw/releases>
- Latest stable verified for this machine: `2026.4.1` (`2026-04-01`)

## Result

Mission Control is aligned with the OpenClaw changes that matter to this checkout. The remaining gaps are documentation and operator-contract truth, not a broken runtime integration.

## Impact Matrix

| Surface | Release relevance | Status | Notes |
| --- | --- | --- | --- |
| `session_key_prefix` and session routing | OpenClaw preserved plugin-owned session-key routing semantics across bootstrap, overrides, restart, and tool-policy paths in `2026.4.1` | `addressed` | Mission Control continues to route via `session_key_prefix`; builder/reviewer resolve through the coder lane, tester/learner through worker, and coordinator through main. |
| `GET /api/openclaw/models` target vs provider split | Mission Control must keep operator-facing agent targets distinct from raw provider model overrides | `addressed` | The route returns `agentTargets`, `providerModels`, `defaultAgentTarget`, and `defaultProviderModel`. Live verification on `2026-04-02` matched this contract. |
| `GET /api/openclaw/sessions/{id}/history` | OpenClaw history remains bounded and may omit oversized entries | `addressed with caveat` | Mission Control exposes normalized transcript history and now surfaces omissions truthfully instead of pretending history is complete. |
| `GET /api/openclaw/background-tasks` | Detached task observability is now important because OpenClaw ships more task-native UI and runtime-ledger behavior | `addressed with caveat` | Mission Control exposes `tasks`, `status`, `sourceChannel`, and `warning`. A timed-out empty ledger is surfaced as `status: "degraded"` with a warning, not a silent empty success. |
| Local runtime ownership under `~/.openclaw` | The local-prefix install and LaunchAgent ownership changed during the `2026.3.28` → `2026.4.1` repair | `addressed` | The canonical owner on this Mac is `~/.openclaw`; use `../scripts/update_openclaw_local_runtime.sh` from the workspace root instead of `openclaw update` for local repair/reinstall. |
| Chat-native `/tasks` board in OpenClaw `2026.4.1` | OpenClaw now exposes a chat-native task board for current sessions | `not applicable` | Mission Control keeps its own task UI and only consumes detached-task ledger data for operator observability. No Mission Control route or UI regression was found here. |

## Verification Evidence

- `openclaw config validate --json` returned `{"valid":true,...}`
- `openclaw status --json` reported `runtimeVersion: "2026.4.1"` and a healthy local gateway
- `openclaw gateway status --require-rpc --deep` reported `RPC probe: ok`
- `openclaw health` succeeded
- `GET /api/openclaw/models` returned separated `agentTargets` and `providerModels`
- `GET /api/openclaw/sessions/{id}/history` returned normalized transcript payloads
- `GET /api/openclaw/background-tasks` returned truthful degraded metadata when the ledger timed out instead of silently returning an empty success

## Operator Decision

- Keep the current OpenCode Go routing policy in place for now.
- Do not force a return to Codex-default routing before revalidating provider availability on or after `2026-04-03`.
- Treat `origin/main` as the only normal base for Mission Control work; keep `source/main` as comparison input only.
