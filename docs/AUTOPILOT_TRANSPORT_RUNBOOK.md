# Autopilot Transport Runbook

Last verified: `2026-04-11`

Use this document when Product Autopilot research, ideation, or planning looks slow, opaque, or contradictory. This is the dated source of truth for how the local Mission Control runtime resolves autopilot models and transports on this machine.

If this document conflicts with older notes, old session memories, or stale troubleshooting snippets, this document wins until it is superseded by a newer dated update.

## Current Local Runtime

- Repo checkout serving `http://localhost:4000`: `mission-control` on `main`
- Live local process working directory: `/Users/jordan/.openclaw/workspace/mission-control`
- Current local `.env.local`:
  - `AUTOPILOT_MODEL=openclaw`
  - `OPENCLAW_AUTOPILOT_COMPLETION_MODE=http`
- BoreReady workspace overrides:
  - `autopilot_model_override=qwen/qwen3.6-plus`
  - `planning_model_override=qwen/qwen3.6-plus`

## Resolution Order

For research and ideation, Mission Control resolves execution in this order:

1. Product lookup resolves the workspace.
2. Workspace override decides the requested provider model when present.
3. Local completion mode decides the transport family.
4. The completion pipeline runs inside one shared timeout budget.

In the current local setup, that means BoreReady research requests the provider model `qwen/qwen3.6-plus`, but still runs through the HTTP completion path because `OPENCLAW_AUTOPILOT_COMPLETION_MODE=http`.

## What Changed On 2026-04-11

The old giant-prompt bug from session-backed autopilot prompting was already fixed by switching the local autopilot default to HTTP mode.

The newer confusion was different:

- old notes still claimed provider-model workspace overrides force session transport
- the live code and `.env.local` no longer worked that way
- `completeJSON()` could spend too much time across HTTP retries, fallback transport, and the strict JSON retry path without telling the UI what it was doing

The current code now does two important things:

1. Provider-model autopilot runs in HTTP mode no longer fall back to a session-backed transport.
2. The full completion pipeline now shares one total timeout budget across the first completion plus the strict JSON retry.
3. Native Node `fetch` calls use a custom `undici` Agent to inject strict 10-minute timeout budgets into `headersTimeout` and `bodyTimeout`, preventing premature "fetch failed" socket disconnections at the strict 5-minute native default.

This keeps the session-context blowup fix intact and prevents 30-minute black-box waits caused by stacked timeout budgets, while correctly allowing long-running Qwen evaluations up to 10 minutes without TCP timeouts.

## Transport Visibility

During `llm_polling`, Mission Control now records explicit transport status into cycle `phase_data` and the autopilot activity log.

Expected activity events include:

- `transport_started`
- `transport_retry`
- `transport_fallback`
- `transport_fallback_skipped`
- `json_retry`

The Research tab should show the current transport state for the active cycle, and the Activity panel should show transport/fallback/retry events instead of only a generic waiting message.

## How To Diagnose A Slow Run

Use this order. Do not jump straight to branch or repo suspicion.

1. Confirm the live runtime checkout.

```bash
cd /Users/jordan/.openclaw/workspace/mission-control
git status --short --branch
lsof -a -p <next-server-pid> -d cwd -Fn
```

2. Confirm the local transport defaults.

```bash
cd /Users/jordan/.openclaw/workspace/mission-control
grep -n 'AUTOPILOT_MODEL\|OPENCLAW_AUTOPILOT_COMPLETION_MODE' .env.local
```

3. Confirm the product workspace override.

```bash
cd /Users/jordan/.openclaw/workspace/mission-control
sqlite3 -header -column mission-control.db \
  "SELECT p.id AS product_id, p.name, p.workspace_id, w.autopilot_model_override, w.planning_model_override
   FROM products p
   LEFT JOIN workspaces w ON w.id = p.workspace_id
   WHERE p.id = '<PRODUCT_ID>';"
```

4. Confirm whether the cycle is live or stale.

```bash
cd /Users/jordan/.openclaw/workspace/mission-control
sqlite3 -header -column mission-control.db \
  "SELECT status, current_phase, started_at, last_heartbeat, completed_at, error_message
   FROM research_cycles
   WHERE product_id = '<PRODUCT_ID>'
   ORDER BY started_at DESC LIMIT 1;"
```

5. Read recent activity for transport state.

```bash
cd /Users/jordan/.openclaw/workspace/mission-control
sqlite3 -header -column mission-control.db \
  "SELECT event_type, message, detail, created_at
   FROM autopilot_activity_log
   WHERE product_id = '<PRODUCT_ID>'
   ORDER BY created_at DESC LIMIT 20;"
```

## What Not To Assume

- A BoreReady workspace override of `qwen/qwen3.6-plus` does not automatically imply session transport.
- A one-patch OpenClaw version gap is not enough by itself to explain a 30-minute research wait.
- A clean `squti` or `mission-control` branch state does not guarantee the local runtime config is using the transport you expect.

## When This Doc Is Stale

Re-check this runbook any time one of these changes:

- `.env.local`
- `src/lib/autopilot/llm.ts`
- `src/lib/openclaw/workspace-model-overrides.ts`
- `src/lib/autopilot/research.ts`
- `src/lib/autopilot/ideation.ts`

If any of those change materially, update this document and add a fresh verification date.