# Mission Control Local Status

This is the canonical current-state document for the local checkout at [the repo root](../).

Use this page when you need the truth about this machine and this worktree. Treat the top-level [README.md](../README.md) and [CHANGELOG.md](../CHANGELOG.md) as product-facing docs, then use this page for local deviations, verified runtime evidence, and known gaps.

For day-to-day local commands, use [LOCAL_OPERATIONS_RUNBOOK.md](LOCAL_OPERATIONS_RUNBOOK.md). For the docs map, use [docs/README.md](README.md).

## Snapshot

- Date verified: `2026-04-09`
- Upstream base: `v2.4.0`
- Local checkout state: `OpenClaw 2026.4.9 restored; Mission Control reconnected; BoreReady verification lane unstuck`
- Git ref: `main`
- Baseline commit: `ca1d88d` (queue/session hijack fix on top of origin/main)
- GitHub PR state:
  - PR `#1` remains the earlier repo-reconciliation merge into `origin/main`
  - this restore work is local branch state on top of `origin/main`; local `HEAD` does not currently equal `origin/main`
- Git remote model on this machine:
  - `origin` -> `nice-and-precise/mission-control`
  - `source` -> `crshdn/mission-control` (optional read-only comparison remote, with push disabled locally)
- Canonical product trunk:
  - `origin/main`
- Repository policy:
  - day-to-day work branches must be based on `origin/main`
  - `source/main` is for comparison and selective import work only when the `source` remote is present
  - `main` is protected on GitHub and now requires `Branch Policy`, `Docs`, `Test`, and `Build`
- Local app URL: `http://localhost:4000`
- Local runtime project root override:
  - `PROJECTS_PATH=/Users/jordan/Projects`
  - `WORKSPACE_BASE_PATH=/Users/jordan/Projects`
- Local auth behavior:
  - `MC_API_TOKEN` is set in `.env.local`
  - direct API calls to protected `/api/*` routes require `Authorization: Bearer <token>`

## Verified Runtime Behavior

The following facts were re-verified against the live local runtime on `2026-04-09`:

- OpenClaw is now running locally on `2026.4.9`
  - `~/.openclaw/bin/openclaw --version` returns `OpenClaw 2026.4.9 (0512059)`
  - the LaunchAgent is installed at `~/Library/LaunchAgents/ai.openclaw.gateway.plist`
  - the live service command runs from `~/.openclaw/tools/node-v22.22.0/bin/node`
- Mission Control is reconnected to the restored loopback gateway
  - authenticated `GET /api/openclaw/status` returns `{"connected":true,...}` against `ws://127.0.0.1:18789`
  - BoreReady no longer shows the stale gateway transport failure once the verification dispatch is retried on the restored runtime
- BoreReady's earlier product-cap blocker was stale local task state, not an active cap decision
  - BoreReady's historical blended spend remains in `legacy_mixed`
  - provider-enforced spend remains separate and the BoreReady verification task cleared after gateway recovery without any cap override
- The detached-task surface still requires the current local timeout budget
  - `openclaw tasks list --json` still emits valid JSON on `stderr`
  - on the current runtime it can take longer than `8s`, so Mission Control now uses a `20s` timeout before reporting the background-task ledger as degraded
- `openclaw doctor --fix --yes --non-interactive` is not a steady-state health check on this machine today
  - it can clean up state successfully and still flap the LaunchAgent during the same run
  - after any `doctor --fix`, the authoritative truth should come from warm `openclaw gateway status --require-rpc --deep`, `openclaw status --json`, `openclaw health`, and Mission Control's `/api/openclaw/status`

The following facts were re-verified against the live local runtime on `2026-04-05`:

- `npm run dev` is the default local operating mode on `localhost:4000`
  - authenticated `GET /api/health` now returns HTTP `200` with JSON like `{"status":"ok","uptime_seconds":...,"version":"2.4.0"}` during this stabilization pass
  - `next dev` uses `.next-dev` while `next build` and `next start` keep using `.next`, which prevents a build from clobbering the active dev runtime
- The Product Autopilot surface is present again on this worktree
  - a fresh `next dev` relaunch served `/autopilot` and `/activity` with HTTP `200`
  - authenticated `POST /api/products` plus `GET /api/products/{id}`, `/swipe/deck`, `/health`, `/costs`, and `DELETE /api/products/{id}` all returned HTTP `200` during the restore smoke test
  - an older already-running `next dev` process continued serving the pre-restore route graph until it was restarted, so route-level `404`s after adding new `src/app/**` entries should be treated as a dev-server refresh issue first
- Git and GitHub guardrails are now aligned with the standalone repository model
  - the temporary reconciliation branch was merged and deleted
  - `source` remains available for fetch/compare work, but its local push URL is disabled
  - GitHub now auto-deletes merged branches, blocks force-pushes to `main`, enforces linear history, and requires the live CI checks on trunk
- The repo-backed strict workflow is behaving truthfully on this checkout
  - the clean-room smoke task completed end-to-end through build -> test -> verification without manual task-state repair
  - both disposable smoke tasks were deleted successfully afterward, and their isolated workspaces were removed from the active projects tree
- The local control-plane database was returned to a pre-real-work baseline
  - all clearly synthetic null-product fixture tasks were purged
  - the reusable smoke product remains present and empty
  - real `LLI SaaS` planning tasks were preserved
  - orphan learner-session rows were removed
  - after the earlier cleanup there were `0` live tasks in `assigned|in_progress|testing|review|verification`, but the current active local set now includes the repaired `squti` tasks `c06d980e-3845-4d2f-b051-a3c3c5ad1560` (`in_progress`) and `ddea3a70-ad4c-4380-99ae-3327388a0110` (`assigned`, queued behind the active builder task)
- Runtime evidence and transcript fallback now have separate roles
  - Sessions, Deliverables, and Agent Live can recover visibility after a broken run
  - workflow advancement still depends on explicit markers such as `TASK_COMPLETE`, `BLOCKED`, `TEST_PASS`, `TEST_FAIL`, `VERIFY_PASS`, or `VERIFY_FAIL`
  - when a run ends before the live listener sees a marker, Mission Control uses official gateway history internally to recover a missed marker or synthesize an explicit runtime/provider blocker
- Strict workflow ownership is enforced at both PATCH and dispatch time
  - `inbox` is unassigned, `assigned` / `in_progress` are builder-owned, `testing` is tester-owned, `review` is queue-only, and `verification` is reviewer-owned
  - invalid manual workflow moves now fail closed with `409` instead of dispatching the wrong prompt to the wrong persistent agent session
- Protected callback instructions are aligned with runtime auth
  - when `MC_API_TOKEN` is configured, builder/tester/verifier dispatch prompts include the required `Authorization: Bearer <token>` header for localhost callback requests
- Dispatch failures can be policy failures even when the gateway path is healthy
  - authenticated dispatch replay on `2026-04-07` reached OpenClaw successfully and then failed closed in Mission Control with `Product monthly cap is required`
  - an earlier higher-cost dispatch hit `Mission Control estimated reserve block ... exceeds the product per-task cap`
  - treat `409` as Mission Control validation first; reserve gateway triage for transport errors like `fetch failed`, `502`, or `503`
- Local cost accounting repair is staged on top of this checkout
  - cost events are now split into `provider_actual`, `mission_estimate`, and `legacy_mixed`
  - BoreReady historical blended spend was preserved as legacy history instead of continuing to drive caps
  - new cap enforcement is intended to use provider-priced spend only, while provider reconciliation imports remain read-only comparison data
- Fresh reruns intentionally reuse the stable OpenClaw routing key
  - Mission Control prepends `/new` to dispatches on the existing session key
  - seeing the same `sessionKey` with a new `sessionId` is expected OpenClaw behavior, not evidence of stale task context by itself
- Repo-backed tester/reviewer prompts now separate shell access from file-tool access
  - shell commands use `cd <workspace> && ...`
  - non-shell file tools such as `read`, `edit`, `find`, and `glob` must use absolute paths under the task workspace
- Planning completion now reconciles from transcript truth instead of relying only on live poll timing
  - if a planner run already finished, Mission Control can recover the completed spec from stored/OpenClaw transcript history on a later read
  - if OpenClaw omits oversized transcript entries, Mission Control now surfaces a structured `transcriptIssue` instead of silently waiting forever
  - this local checkout also tolerates the malformed planner `constraints` JSON shape observed on `2026-03-28`, so an almost-valid completion payload does not leave the task stuck in `Waiting for response...`
- Session history, model discovery, and detached work are now separated into explicit operator surfaces
  - authenticated `GET /api/openclaw/sessions/{id}/history` resolves either a session key or runtime session ID into a normalized Mission Control transcript payload
  - `GET /api/openclaw/models` now separates `agentTargets` from `providerModels`, and local Autopilot defaults to `openclaw`
  - provider-model Autopilot requests now force session-backed completion when a workspace override asks for `qwen/qwen3.6-plus`, rather than relying on `agent-cli` to honor provider overrides implicitly
  - `GET /api/openclaw/background-tasks` exposes the OpenClaw task ledger as read-only observability and correlates known session keys back to Mission Control task sessions when possible
  - the detached-work route now also surfaces `status`, `sourceChannel`, and `warning` so operators can see degraded ledger reads instead of treating them as a silent empty state
  - a timed-out empty ledger is currently surfaced truthfully as `status: "degraded"` with a warning, which is acceptable operator behavior for this baseline
- Local provider-family routing is now normalized around three active families
  - Codex work stays on `openai-codex/*`
  - planning, research, ideation, and any explicit Qwen lane use `qwen/qwen3.6-plus`
  - non-Qwen live lanes stay on OpenCode Go (`opencode-go/*`, `opencode-go-mm/*`)
- Autopilot JSON parsing now includes one strict retry before surfacing a failure
  - if a research/planning/ideation reply is wrapped in prose, fenced JSON, or otherwise recoverable text, Mission Control attempts local extraction first
  - if the first reply is still not valid JSON, Mission Control retries once with `temperature: 0` and a stricter JSON-only instruction before marking the cycle failed
- The session detail route no longer crashes on `sessions.list` payload shape differences
  - authenticated `GET /api/openclaw/sessions/{id}` now returns a normal `404` for a missing session instead of a `500`
- Static error-page build regression is not reproducible on the current checkout
  - `npm run build` completed successfully on this `v2.4.0-local-baseline` worktree after compile, typecheck, static generation, and route optimization
- Node.js runtime is now pinned to an exact version to prevent native addon mismatch on upgrade
  - `.nvmrc` pinned from `24` (major-only) to `24.13.0` (exact patch), enforced by `check-runtime.js` preflight
  - `npm run test:runtime-targeted` runs the focused callback / evidence / repair test suite (49 tests, 0 fail)
- Queued builder dispatch now preserves root-session ownership correctly
  - `POST /api/tasks/[id]/dispatch` now performs the builder-busy / queue decision before any root-session create-or-rebind work
  - legitimately queued builder tasks stay in `assigned`, keep `planning_dispatch_error = NULL`, receive a waiting `status_reason`, and do not own an active root session
  - `recoverUnreconciledTaskRunsInternal()` now restores that waiting state instead of overwriting queued builder tasks with the generic ended-session banner
- Live `squti` task repair was completed through the authenticated local API on `2026-04-05`
  - `ddea3a70-ad4c-4380-99ae-3327388a0110` was re-dispatched on its current `testing` stage, returned a real `TEST_FAIL` callback, and then cleanly re-entered the builder queue with `status = assigned`, `planning_dispatch_error = NULL`, and `status_reason = Waiting for Builder Agent to finish "Exam Blueprint to Question Bank Traceability Matrix" before starting this task.`
  - `c06d980e-3845-4d2f-b051-a3c3c5ad1560` was re-dispatched on its builder stage and now owns the active builder session `agent:coder:mission-control-builder-agent-105ceb56`
  - the final live state matches the intended invariant: one active builder task, one queued builder task, and no generic unreconciled-run banner on either card
- Stale "run ended without completion callback" error strings on done tasks have been repaired
  - `npm run tasks:repair-successful-run-errors` (dry-run) and `-- --apply` let operators inspect and clear stale error prefixes on completed tasks
  - applied against the live DB on `2026-04-05`; cleared 2 stale rows
- The ONLINE badge now stays green during normal operation
  - `isSameOriginEventStreamRequest()` in `src/middleware.ts` whitelists same-origin `Accept: text/event-stream` connections without an `Authorization` header
  - verified: `curl -s -i -m 5 -H 'Sec-Fetch-Site: same-origin' -H 'Accept: text/event-stream' http://localhost:4000/api/events/stream` returns `HTTP 200` + `: connected`
- `/api/tasks/unread` no longer triggers 404 noise in the UI or server logs
  - stub route at `src/app/api/tasks/unread/route.ts` returns `[]`; verified via authenticated GET
- Governance code no longer auto-creates ghost fixer agents
  - `ensureFixerExists()` in `task-governance.ts` is now lookup-only; it returns `null` when no fixer role agent is pre-seeded rather than inserting one
  - `escalateFailureIfNeeded()` handles the null case by inserting a `governance_warning` activity row instead
  - the Auto Fixer ghost agent (id `12a1b1e8`) created during earlier BoreReady stage failures was deleted from the DB
  - future fixer capability requires deliberately seeding a real fixer-role agent with docs and model
- Reviewer callback gap (missed VERIFY_PASS/VERIFY_FAIL) is now mitigated by three layers
  - `buildContractBanner(role)` in `repo-task-handoff.ts` prepends a compact ⚠️ output-format reminder as the very first content of every tester/verifier dispatch message, before any task context
  - `POST /api/tasks/[id]/verification/retry-dispatch` lets operators manually re-dispatch a reviewer stuck in the `verification` stage
  - `recoverUnreconciledTaskRunsInternal()` in `agent-health.ts` fires one automatic retry via that endpoint when it detects a missed verdict; idempotence-gated by a `verification_auto_retry` activity row so it fires at most once per task
- LLI SaaS product monthly cost cap set to `$5.00`
  - the new budget policy (commits `3dcf254`/`6046e24`) made `cost_cap_monthly` required before dispatch; the product had been left with `NULL` and `budget_status = 'blocked'`
  - updated directly in DB: `cost_cap_monthly=5.00`, `budget_status='clear'`
  - tasks under the LLI SaaS product can now be dispatched normally

## Known Gaps

These are still real local limitations as of this verification pass:

1. Public session history is available, but it is still bounded by OpenClaw's transcript limits.
   Oversized transcript entries can be omitted upstream, and Mission Control now surfaces that as a `transcriptIssue` rather than pretending the transcript is complete.

2. The detached OpenClaw task ledger can still time out and report a degraded empty response.
   Mission Control now surfaces this truthfully through `status`, `sourceChannel`, and `warning`, so operators can distinguish a CLI/ledger problem from a real empty-success state.

3. A local browser-extension conflict can still crash `next dev` in a normal Chrome profile even when Mission Control itself is healthy.
   Current evidence points to Next App Router's internal `use-reducer-with-devtools` path being activated by Redux DevTools-style extensions. A clean browser session loads Mission Control normally, so this should be triaged as a local dev-environment conflict unless it also reproduces in a clean browser.

## Verification Commands

These were the commands used for the claims above:

```bash
cd /Users/jordan/.openclaw/workspace/mission-control

git rev-parse HEAD
git describe --tags --always --dirty
git branch --show-current
git symbolic-ref --short HEAD

TOKEN="$(python3 - <<'PY'
from dotenv import dotenv_values
vals = dotenv_values('.env.local')
print(vals.get('MC_API_TOKEN', ''))
PY
)"

curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4000/api/health

node -e 'const fs=require("fs"); const tokenLine=fs.readFileSync(".env.local","utf8").split("\\n").find(l=>l.startsWith("MC_API_TOKEN=")); const token=tokenLine ? tokenLine.slice("MC_API_TOKEN=".length) : ""; fetch("http://localhost:4000/api/openclaw/sessions/mission-control-reviewer-agent-58ace9f0",{headers:{Authorization:"Bearer "+token}}).then(async r=>{console.log(r.status); console.log(await r.text());});'

sqlite3 -cmd '.timeout 5000' mission-control.db \
  "select count(*) from tasks where product_id is null and title in ('Runtime evidence task','Queue task','Build task','Review task','Verification task','Repo task');"
sqlite3 -cmd '.timeout 5000' mission-control.db \
  "select count(*) from openclaw_sessions where status='active' and openclaw_session_id='mission-control-learner-agent' and task_id is null;"
sqlite3 -cmd '.timeout 5000' mission-control.db \
  "select count(*) from tasks where product_id='512ad7b8-0cc7-43e9-a029-7aec7e094631' and status='planning';"
sqlite3 -cmd '.timeout 5000' mission-control.db \
  "select count(*) from tasks where status in ('assigned','in_progress','testing','review','verification');"

npm run build
ls -ld .next .next-dev
```

## Claim Audit

| Claim | Source doc | Verified status | Evidence source | Remediation |
| --- | --- | --- | --- | --- |
| Local runtime should use `npm run dev` on `localhost:4000` for day-to-day work | local operating convention | `verified` | fresh `2026-04-02` relaunch returned authenticated `GET /api/health = 200` with JSON on port `4000` | Keep `.next-dev` split in place and treat `dev` as the default local mode |
| Upstream defaults use `~/Documents/Shared` paths while this machine should run from `/Users/jordan/Projects` | [README.md](../README.md) | `verified with local deviation` | README config table plus local `.env.local` override | Keep README public-facing and point here for machine-specific runtime |
| Synthetic null-product fixture noise was removed before real work | local runtime/DB | `verified` | fixture task count `0`, orphan learner session count `0`, smoke product task count `0`, real `LLI SaaS` planning tasks preserved | Keep this page as the canonical pre-real-work baseline |
| Protected localhost callbacks need bearer auth when `MC_API_TOKEN` is set | [ORCHESTRATION.md](../ORCHESTRATION.md), [docs/AGENT_PROTOCOL.md](AGENT_PROTOCOL.md) | `verified` | dispatch prompts and local protected routes require bearer auth on this machine | Keep callback examples aligned with the real auth requirement |
| `GET /api/openclaw/sessions/{id}` no longer crashes on a non-array `sessions.list` payload | local runtime | `verified` | authenticated request now returns `404` for a missing session instead of `500` | Keep the client-side session-list normalization in place |
| Workflow advancement still depends on explicit completion markers, with gateway-history fallback for missed callbacks | [ORCHESTRATION.md](../ORCHESTRATION.md), [docs/AGENT_PROTOCOL.md](AGENT_PROTOCOL.md) | `verified with local deviation` | clean-room smoke completed end-to-end, and earlier missed callbacks were recoverable from gateway history | Keep active docs precise about evidence visibility versus transcript-based closeout recovery |
| Session-history replay is available through Mission Control's public route | local runtime | `verified with caveat` | authenticated `GET /api/openclaw/sessions/{id}/history` returns normalized transcript payloads for valid session refs | Keep docs explicit that OpenClaw history is bounded and may omit oversized entries |
| Static error-page build regression is currently reproducible from source | local status note from earlier session | `not reproducible` | current `npm run build` exits `0` on this worktree | Only reopen if a fresh failing revision or exact repro is captured |
| Current test and build gate succeeds on the pinned Node runtime | [../VERIFICATION_CHECKLIST.md](../VERIFICATION_CHECKLIST.md), [../README.md](../README.md) | `verified` | `nvm use 24.13.0`, `npm test`, and `npm run build` all exited `0` on `2026-03-29` | Keep `.nvmrc`, runtime preflight, and verification checklist aligned |
| `.nvmrc` pins the exact Node patch version so native addons never silently break | `.nvmrc`, `scripts/check-runtime.js` | `verified` | `node --version` returns `v24.13.0` after `nvm use` on `2026-04-05` | Keep both `.nvmrc` and preflight script in sync on every Node upgrade |
| Queued builder dispatch does not steal the active builder root session before returning a queued response | `src/app/api/tasks/[id]/dispatch/route.ts`, `src/lib/task-queue.ts`, `src/lib/task-route-workflow.test.ts` | `verified` | focused Node `24.13.0` test run plus live `squti` re-dispatch left only `c06d980e-3845-4d2f-b051-a3c3c5ad1560` owning the active builder session on `2026-04-05` | Keep queue decision ahead of root-session mutation and re-check this invariant after any dispatch-route refactor |
| Health recovery restores queued builder waiting state instead of rewriting it to the generic ended-session banner | `src/lib/agent-health.ts`, `src/lib/task-evidence.test.ts` | `verified` | focused Node `24.13.0` test run passed after adding queued-builder recovery coverage on `2026-04-05` | Keep queue-state repair ahead of the generic unreconciled-run fallback |
| Stale unreconciled-run error strings on done tasks can be repaired non-destructively | `scripts/repair-successful-run-errors.ts`, `src/lib/task-run-error-repair.ts` | `verified` | dry-run showed 2 rows; apply cleared them with `changes() = 2` on `2026-04-05` | Use `npm run tasks:repair-successful-run-errors -- --apply` after any batch of stuck-then-recovered tasks |
| SSE connection is whitelisted for same-origin browser clients without a bearer token | `src/middleware.ts` | `verified` | curl with `Sec-Fetch-Site: same-origin` + `Accept: text/event-stream` returns `HTTP 200` + `: connected` on `2026-04-05` | Keep `isSameOriginEventStreamRequest()` guard and confirm ONLINE badge after any middleware change |
| `/api/tasks/unread` returns `[]` and does not generate 404 server log noise | `src/app/api/tasks/unread/route.ts` | `verified` | authenticated GET returns `[]` on `2026-04-05` | Keep stub aligned with any future unread-count feature work |
| `ensureFixerExists()` no longer auto-inserts ghost agents during stage escalation | `src/lib/task-governance.ts` | `verified` | looked up test DB — zero rows inserted after 2 failure activities; governance_warning activity inserted instead on `2026-04-05` | Any fixer capability must be deliberately seeded via a real agent row with docs and model |

## Historical Snapshots

These files are preserved for context, but they are not the current-state source of truth:

- [docs/archive/status/VERIFICATION_CHECKLIST.md](archive/status/VERIFICATION_CHECKLIST.md)
- [docs/archive/status/HANDOVER-2026-03-03.md](archive/status/HANDOVER-2026-03-03.md)
- [HANDOFF-2026-03-26-AUTOPILOT.md](../HANDOFF-2026-03-26-AUTOPILOT.md)
- [OPENCLAW_RELEASE_IMPACT_AUDIT_2026-04-02.md](OPENCLAW_RELEASE_IMPACT_AUDIT_2026-04-02.md)

## Active Docs To Trust

- [../VERIFICATION_CHECKLIST.md](../VERIFICATION_CHECKLIST.md) for the current shareable verification contract
- [../../docs/ops/OPENCLAW_LOCAL_RUNTIME.md](../../docs/ops/OPENCLAW_LOCAL_RUNTIME.md) for the machine-local OpenClaw runtime contract, ownership model, and verification commands
- [../../docs/ops/OPENCLAW_UPDATE_LESSONS.md](../../docs/ops/OPENCLAW_UPDATE_LESSONS.md) for the machine-specific update traps and wiki-health-versus-lint-clean distinction
- [../../docs/ops/OPENCLAW_2026_4_X_UPGRADE_SUMMARY.md](../../docs/ops/OPENCLAW_2026_4_X_UPGRADE_SUMMARY.md) for the verified local `2026.4.8` repair summary
- [../../docs/ops/MEMORY_AND_DREAMS_OPERATING_POLICY.md](../../docs/ops/MEMORY_AND_DREAMS_OPERATING_POLICY.md) for the durable-memory, dreaming, and `memory-wiki` role split
- [docs/README.md](README.md) for the current docs map and documentation conventions
- [docs/LOCAL_OPERATIONS_RUNBOOK.md](LOCAL_OPERATIONS_RUNBOOK.md) for local start/restart, health, backup, and checkpoint commands
- [USER_GUIDE.md](USER_GUIDE.md) for the shareable doc entrypoint
- [README.md](../README.md) for upstream/public product framing
- [PRODUCTION_SETUP.md](../PRODUCTION_SETUP.md) for generic setup patterns
- [ORCHESTRATION.md](../ORCHESTRATION.md) for explicit workflow and runtime evidence behavior
- [docs/AGENT_PROTOCOL.md](AGENT_PROTOCOL.md) for agent-side contract
- [docs/ORCHESTRATION_WORKFLOW.md](ORCHESTRATION_WORKFLOW.md) for orchestration expectations

If any of those disagree with this page, this page wins for this machine and this worktree.
