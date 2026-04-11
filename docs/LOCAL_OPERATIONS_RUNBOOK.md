# Local Operations Runbook

Short local commands for this checkout.

For the machine-local OpenClaw runtime owner contract, use [../../docs/ops/OPENCLAW_LOCAL_RUNTIME.md](../../docs/ops/OPENCLAW_LOCAL_RUNTIME.md).
For Product Autopilot workspace setup and reset behavior, use [AUTOPILOT_SETUP.md](AUTOPILOT_SETUP.md).

For updates on this Mac's local-prefix install, use `../scripts/update_openclaw_local_runtime.sh` from the workspace root instead of `openclaw update`. The helper reruns the official `install-cli.sh` flow against `~/.openclaw`.

After `openclaw gateway restart`, allow a short warm-up window before treating a failed RPC probe as a real outage. The LaunchAgent can report running a few seconds before the gateway has rebound `127.0.0.1:18789`.

Recommended local check:

```bash
cd /Users/jordan/.openclaw/workspace
./scripts/update_openclaw_local_runtime.sh
~/.openclaw/bin/openclaw doctor
~/.openclaw/bin/openclaw gateway restart
sleep 8
~/.openclaw/bin/openclaw gateway status --require-rpc --deep
```

## Start / Restart

```bash
cd /Users/jordan/.openclaw/workspace/mission-control
npm run dev
```

If you add or restore `src/app/**` routes while `next dev` is already running and a page or API still returns `404`, fully restart `npm run dev` before treating it as a code bug. A long-lived dev process can keep serving an older route graph.

If `localhost:4000` is already occupied, identify the listener first:

```bash
lsof -nP -iTCP:4000 -sTCP:LISTEN
```

## Git Remote Model

For this checkout on Jordan's machine:

- `origin` = `nice-and-precise/mission-control`
- `source` = `crshdn/mission-control` (optional read-only comparison remote)

Policy:

- Treat `origin/main` as the canonical product trunk.
- Treat `source` as a read-only source reference, not the default branch base for new work.
- If `source` is present, disable its push URL locally so accidental pushes fail closed.
- Open day-to-day PRs against `nice-and-precise/main`, not against `crshdn/main`.

Safe commands:

```bash
git fetch origin
git fetch source
git remote set-url --push source DISABLED
git switch -c work/<topic> origin/main
npm run git:check-policy
```

Install the tracked hooks for this clone:

```bash
npm run git:install-hooks
```

## Health Check

```bash
TOKEN="${MC_API_TOKEN:-your-token}"
curl -i -H "Authorization: Bearer $TOKEN" http://localhost:4000/api/health
```

Expected result: HTTP `200` with JSON like `{"status":"ok",...}`.

If `MC_API_TOKEN` is set in `.env.local`, direct `curl` requests to `/api/*` must include the bearer token. The browser UI still works without manual headers because same-origin browser requests are allowed by the auth middleware.

## Pinned Node Runtime

Use the repo-pinned runtime before `npm ci`, test runs, or local repair work that touches native modules:

```bash
cd /Users/jordan/.openclaw/workspace/mission-control
source ~/.nvm/nvm.sh
nvm use 24.13.0
node --version
npm ci
```

Why this matters:

- Node native addons are ABI-sensitive; see the official Node docs at <https://nodejs.org/en/learn/modules/abi-stability>
- this checkout uses `better-sqlite3`, and current Node 25 failures are tracked at <https://github.com/WiseLibs/better-sqlite3/issues/1411>

If `node --version` is not `v24.13.0`, treat native-module test failures as an environment problem first.

## Queued Builder Card Repair

Use this when a builder-owned task should be queued but instead shows a generic ended-session banner, or when you need to re-drive a recently repaired queued card through the API.

```bash
cd /Users/jordan/.openclaw/workspace/mission-control

TOKEN="$(python3 -c 'from dotenv import dotenv_values; print(dotenv_values(\".env.local\").get(\"MC_API_TOKEN\",\"\"))')"

curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  http://localhost:4000/api/tasks/<TASK_ID>/dispatch | jq

curl -s -H "Authorization: Bearer $TOKEN" \
  http://localhost:4000/api/tasks/<TASK_ID> | jq '{status,status_reason,planning_dispatch_error,assigned_agent_name}'

sqlite3 mission-control.db \
  "select task_id, active_task_id, session_key, status from openclaw_sessions where task_id = '<TASK_ID>' order by updated_at desc limit 5;"
```

Expected result:

- queued builder work stays `assigned` with a waiting `status_reason`
- active builder work moves to `in_progress`
- only the actually running task owns an active builder root session

## Autopilot Surface Check

Use this after restoring or changing Product Autopilot routes:

```bash
cd /Users/jordan/.openclaw/workspace/mission-control

TOKEN="$(python3 - <<'PY'
from dotenv import dotenv_values
vals = dotenv_values('.env.local')
print(vals.get('MC_API_TOKEN', ''))
PY
)"

curl -I http://localhost:4000/autopilot
curl -I http://localhost:4000/activity

PRODUCT_ID="$(curl -s -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Autopilot Smoke Product","description":"temporary smoke product","icon":"🧪"}' \
  http://localhost:4000/api/products | jq -r '.id')"

PRODUCT_JSON="$(curl -s -H "Authorization: Bearer $TOKEN" \
  http://localhost:4000/api/products/"$PRODUCT_ID")"

WORKSPACE_ID="$(printf '%s' "$PRODUCT_JSON" | jq -r '.workspace_id')"

printf '%s\n' "$PRODUCT_JSON" | jq '{id,name,workspace_id,workspace_mode,manages_workspace,workspace_name,workspace_slug}'
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4000/api/products/"$PRODUCT_ID"/swipe/deck | jq
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4000/api/products/"$PRODUCT_ID"/health | jq
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4000/api/products/"$PRODUCT_ID"/costs | jq
curl -s -X DELETE -H "Authorization: Bearer $TOKEN" http://localhost:4000/api/products/"$PRODUCT_ID" | jq
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4000/api/workspaces | jq --arg wid "$WORKSPACE_ID" '[.[] | select(.id == $wid)] | length'
```

Expected result:

- `/autopilot` and `/activity` return HTTP `200`
- product create/read/health/cost/delete all succeed without `404`
- new products default to `workspace_mode: "dedicated"` and a non-`default` workspace
- the delete call hard-deletes the temp product instead of archiving it
- the final workspace query returns `0` because the dedicated workspace was also removed

## Product Workspace Modes

Use these API shapes if you want to verify product creation behavior directly.

Dedicated workspace, which is now the default:

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Dedicated Smoke Product","icon":"🧪"}' \
  http://localhost:4000/api/products | jq
```

Existing shared workspace:

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Shared Smoke Product","icon":"🧪","workspace_mode":"existing","workspace_id":"default"}' \
  http://localhost:4000/api/products | jq
```

Expected result:

- dedicated mode returns a non-`default` `workspace_id` and `manages_workspace: 1`
- existing mode keeps `workspace_id: "default"` and returns `manages_workspace: 0`

## Reset a Mistaken Product

UI path:

1. Open `/autopilot`.
2. Use the product card overflow menu if you know immediately that the product is wrong.
3. Or open the product dashboard, click the gear icon, and use the `Danger Zone` delete action.
4. Recreate the product with `Dedicated workspace` if you do not want build cards landing in `default`.

Direct API reset:

```bash
curl -s -X DELETE -H "Authorization: Bearer $TOKEN" \
  http://localhost:4000/api/products/<PRODUCT_ID> | jq
```

This now performs a hard delete for mistaken products and removes any product-owned tasks. Dedicated product workspaces are deleted with the product; shared workspaces are preserved.

## Runtime Owner Check

Use this when Mission Control starts logging fresh zombie or unreconciled-run activity that does not match the visible UI state.

Run:

```bash
cd /Users/jordan/.openclaw/workspace/mission-control
python3 scripts/runtime-owner-diagnostics.py
```

What to look for:

- `owner_type: app-runtime` is healthy for the active leases.
- `owner_type: test-runtime` means a leaked `tsx --test` worker is still running schedulers against the real DB.

If a leaked test worker owns the leases:

```bash
pkill -f 'tsx --test.*mission-control'
pkill -f 'src/lib/runtime-leases.test.ts'
```

Then restart the real app runtime:

```bash
cd /Users/jordan/.openclaw/workspace/mission-control
npm run dev
```

## Gateway Dashboard Auth

Use this when `openclaw dashboard` opens `http://127.0.0.1:18789/` but prints:

- `Token auto-auth is disabled for SecretRef-managed gateway.auth.token`
- gateway log warnings like `AUTH_TOKEN_MISSING` or `token_missing`

Run:

```bash
python3 /Users/jordan/.openclaw/workspace/scripts/openclaw-dashboard-auth.py
```

What it does:

1. Reads the local OpenClaw config.
2. Resolves `gateway.auth.token` from its configured SecretRef provider.
3. Builds the one-time `#token=...` dashboard bootstrap URL.
4. Copies that URL to the clipboard and opens it in your browser without echoing the token in the terminal.

Important:

- `AUTH_TOKEN_MISSING` here usually means the Control UI connected without the bootstrap token.
- It does not automatically mean the gateway token drifted or the SecretRef is broken.
- Use `python3 /Users/jordan/.openclaw/workspace/scripts/openclaw-gateway-health.py` if you need to distinguish real gateway drift from UI bootstrap noise.

## Mission Control Gateway Token Sync

Refresh `mission-control/.env.local` from the canonical OpenClaw SecretRef target:

```bash
cd /Users/jordan/.openclaw/workspace
python3 scripts/sync_mission_control_gateway_token.py
```

Use this after rotating the gateway token or after repairing the local OpenClaw runtime. Do not scrape the token from `~/.openclaw/openclaw.json` or the LaunchAgent plist.

## Autopilot HTTP Scope Check

Use this when research, ideation, or description generation fails with:

- `LLM completion failed (403)`
- `missing scope: operator.read`
- `missing scope: operator.write`

On this machine's current OpenClaw runtime, the OpenAI-compatible `/v1/models` and `/v1/chat/completions` routes require the request header:

```bash
x-openclaw-scopes: operator.read,operator.write
```

Mission Control now sends that header from its shared autopilot LLM helper. If the 403 returns again, verify the route directly before touching the gateway token:

```bash
python3 - <<'PY'
from dotenv import dotenv_values
import urllib.request, json

vals = dotenv_values('/Users/jordan/.openclaw/workspace/mission-control/.env.local')
base = vals['OPENCLAW_GATEWAY_URL'].replace('ws://', 'http://').replace('wss://', 'https://')
token = vals['OPENCLAW_GATEWAY_TOKEN']

req = urllib.request.Request(
    base + '/v1/chat/completions',
    headers={
        'Authorization': f'Bearer {token}',
        'Content-Type': 'application/json',
        'x-openclaw-scopes': 'operator.read,operator.write',
    },
    method='POST',
    data=json.dumps({
        'model': 'openclaw',
        'messages': [{'role': 'user', 'content': 'hi'}],
    }).encode(),
)

with urllib.request.urlopen(req, timeout=30) as resp:
    print(resp.status)
    print(resp.read().decode())
PY
```

If that direct call succeeds but Mission Control still fails, restart `npm run dev` so the updated server code is loaded. Route-level and server-only changes are not always picked up cleanly by the already-running dev process.

Keep `AUTOPILOT_MODEL=openclaw` and `OPENCLAW_AUTOPILOT_COMPLETION_MODE=session` in `mission-control/.env.local` on this machine. Provider-model Autopilot lanes such as `qwen/qwen3.6-plus` should flow through session-backed completion, not the local `agent-cli` shortcut. Do not hardcode provider model IDs like `anthropic/claude-sonnet-4-6` in local Autopilot routes unless the current OpenClaw agent policy explicitly allows that override.

Current local routing policy:

- Codex work stays on `openai-codex/*`
- Mission Control planning, research, ideation, builder, reviewer, tester, and learner lanes use `qwen/qwen3.6-plus`
- OpenCode Go stays installed as a fallback/discovery provider family, not as the intended default live lane

Autopilot JSON recovery note:

- research, planning, and ideation now retry once with a stricter JSON-only system prompt before surfacing a parse failure
- if the first model reply is truncated or wrapped in extra text, Mission Control will try to recover locally before issuing that retry
- planning also auto-corrects one wrong-schema JSON reply on the same session before surfacing manual transcript recovery

Qwen onboarding note:

- official OpenClaw docs describe the bundled Qwen Standard/global path and canonical model id `qwen/qwen3.6-plus`
- this local CLI build can still surface the legacy onboarding flag name `modelstudio-standard-api-key`; treat that as a compatibility alias, not a different provider contract

## OpenClaw Operator Surfaces

Mission Control now separates the main OpenClaw operator surfaces:

- `/api/openclaw/sessions/{id}/history` for normalized read-only transcript history by session key or runtime session ID
- `/api/openclaw/models` for `agentTargets` versus `providerModels`
- `/api/openclaw/background-tasks` for detached OpenClaw task-ledger visibility

Quick verification:

```bash
TOKEN="${MC_API_TOKEN:-your-token}"

curl -s -H "Authorization: Bearer $TOKEN" \
  http://localhost:4000/api/openclaw/models | jq

curl -s -H "Authorization: Bearer $TOKEN" \
  http://localhost:4000/api/openclaw/sessions/<SESSION_KEY_OR_ID>/history | jq

curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:4000/api/openclaw/background-tasks?taskId=<TASK_ID>" | jq
```

What to expect:

- models response includes `agentTargets`, `providerModels`, `defaultAgentTarget`, and `defaultProviderModel`
- history response includes `sessionRef`, `resolvedSessionKey`, `resolvedSessionId`, `items`, `hasMore`, and `source`
- background-task response includes top-level `status`, `sourceChannel`, and `warning` plus detached task `id`, `runId`, `sessionKey`, `runtimeKind`, `status`, and any correlated Mission Control session metadata
- use `status: "degraded"` to distinguish OpenClaw CLI contract issues from a true empty detached-work ledger

## Immediate Ended-Run Recovery

Mission Control now retries transcript-based closeout during the normal workspace status poll, not only during the background health sweep.

What changed:

- `GET /api/openclaw/status` now runs the same ended-session recovery pass the scheduler uses.
- If a reviewer or tester run already ended and the transcript contains `TEST_PASS`, `REVIEW_PASS`, `VERIFY_PASS`, or a runtime blocker marker, the next workspace refresh should reconcile the task immediately.
- The periodic health sweep remains the fallback path if the status route is not being hit.

Use this when a task briefly shows:

- `Agent health: stalled`
- `Run ended without completion callback or workflow handoff (...)`
- a task stuck in `testing` or `verification` even though the OpenClaw session is already `done`

Verification:

```bash
TOKEN="${MC_API_TOKEN:-your-token}"
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4000/api/openclaw/status | jq
```

Expected result:

- `connected: true`
- `recovered_runs` is present
- if a transcript-backed closeout was pending, the task should move forward on that poll instead of waiting for the next scheduled sweep

If the task still does not recover:

1. Inspect the OpenClaw session transcript and verify it contains a recognized workflow marker.
2. Confirm the task/session link uses the expected stable session key.
3. Then run the health sweep manually as a fallback diagnostic path, not as the first-line operator step.

If the task is already `done` but the generic unreconciled-run banner still shows on the card, repair only the stale task fields:

```bash
cd /Users/jordan/.openclaw/workspace/mission-control
npm run tasks:repair-successful-run-errors
npm run tasks:repair-successful-run-errors -- --apply
```

If callback/runtime regressions start after a Node switch, re-enter the pinned runtime and use the guarded targeted suite:

```bash
cd /Users/jordan/.openclaw/workspace/mission-control
nvm use
npm ci
npm run test:runtime-targeted
```

## Browser Crash Triage

Use this ladder when `next dev` is running but the browser shows:

- `Application error: a client-side exception has occurred`
- `Cannot update a component (HotReload) while rendering a different component (Router)`
- `async/await is not yet supported in Client Components`

Verification order:

1. Open Mission Control in a clean browser session first.
   Preferred options: Chrome incognito with extensions disabled, or a clean Playwright browser session.
2. Hard reload after the latest Fast Refresh rebuild.
3. If the clean browser works, treat the crash in your normal browser profile as a local extension conflict.
4. Disable Redux DevTools-style extensions for local Mission Control work.
5. Only escalate as an app/runtime bug if the same router crash reproduces in the clean browser too.

## Planning Recovery

Use this ladder when a task stays on `Planning` with `Waiting for response...` even though the planner likely already answered.

1. Refresh the page or reopen the task modal once.
2. Reopen the `Planning` tab.
3. If Mission Control can recover the completed plan from stored/OpenClaw transcript history, expect:
   - `Planning Complete — Awaiting Approval`
   - the generated spec
   - suggested task agents
   - a transcript warning instead of a silent spinner if OpenClaw omitted oversized history entries
4. Only use the recovery button if the completed plan still does not appear after refresh.
5. If recovery still fails, inspect the API directly:

```bash
TOKEN="${MC_API_TOKEN:-your-token}"
curl -s -H "Authorization: Bearer $TOKEN" \
  http://localhost:4000/api/tasks/<TASK_ID>/planning
```

## Reset Planning Fresh

Use this when you want to throw away the current plan and restart planning cleanly for the same task.

1. Cancel planning in Mission Control.
   Source: [planning/route.ts](/Users/jordan/.openclaw/workspace/mission-control/src/app/api/tasks/[id]/planning/route.ts)
2. Start planning again from Mission Control.
   Mission Control now prepends `/new` on the reused planning session key, which matches OpenClaw’s documented fresh-conversation pattern for the same chat key:
   <https://docs.openclaw.ai/help/faq>
3. Refresh the task modal once if the old question is still visible after restart.
4. Do not look for a repo-local `PLANNING.md` file in this workflow. OpenClaw’s official CLI docs do not define `PLANNING.md` as a built-in protocol file, so the planning protocol for this checkout is now inlined in Mission Control’s planning prompts.

## Workflow 409 Recovery

Use this when Mission Control rejects a manual task move with `409`.

Common examples:

- `inbox -> in_progress`
- moving a tester-owned task into a builder-owned stage without routing through the workflow
- trying to dispatch a task whose assigned agent role does not match the current stage owner

Recovery steps:

1. Read the error text first. It now tells you which stage ownership rule was violated.
2. Move the task to a legal stage instead of forcing dispatch.
3. Use these ownership rules in this checkout:
   - `inbox` is unassigned
   - `assigned` and `in_progress` are builder-owned
   - `testing` is tester-owned
   - `review` is queue-only
   - `verification` is reviewer-owned
4. If a quality-stage task failed and needs to go back for changes, move it through the normal fail path with a `status_reason` instead of reassigning it manually in the same request.
5. If the task already has the right stage and assignee, retry the action that created the dispatch, not a manual drag into another stage.

## Database Backup

```bash
cd /Users/jordan/.openclaw/workspace/mission-control
npm run db:backup
```

## Checkpoint Convention

- Branch: `chore/pre-real-work-baseline-YYYYMMDD`
- Commit: `chore: checkpoint <what changed>`

Current example:

- Branch: `chore/pre-real-work-baseline-20260327`
- Commit: `chore: checkpoint mission control runtime stabilization baseline`

## Disposable Fixture Data

Treat these rows as disposable only when they are clearly synthetic:

- `tasks.product_id IS NULL`
- `tasks.title` in:
  - `Runtime evidence task`
  - `Queue task`
  - `Build task`
  - `Review task`
  - `Verification task`
  - `Repo task`
- orphan learner-session rows where:
  - `openclaw_sessions.status = 'active'`
  - `openclaw_sessions.openclaw_session_id = 'mission-control-learner-agent'`
  - `openclaw_sessions.task_id IS NULL`

Do not purge real product rows, planning tasks, or the reusable smoke product.
