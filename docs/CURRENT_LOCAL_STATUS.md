# Mission Control Local Status

This is the canonical current-state document for the local checkout at [the repo root](../).

Use this page when you need the truth about this machine and this worktree. Treat the top-level [README.md](../README.md) and [CHANGELOG.md](../CHANGELOG.md) as product-facing docs, then use this page for local deviations, verified runtime evidence, and known gaps.

For day-to-day local commands, use [LOCAL_OPERATIONS_RUNBOOK.md](LOCAL_OPERATIONS_RUNBOOK.md). For the docs map, use [docs/README.md](README.md).

## Snapshot

- Date verified: `2026-04-02`
- Upstream base: `v2.4.0`
- Local checkout state: `merged stabilization baseline on canonical origin/main`
- Git ref: `main`
- Baseline commit: `be9e32f`
- GitHub PR state:
  - PR `#1` merged into `origin/main` on `2026-04-02`
  - local `HEAD` matches `origin/main`
- Git remote model on this machine:
  - `origin` -> `nice-and-precise/mission-control`
  - `source` -> `crshdn/mission-control` (optional read-only comparison remote, with push disabled locally)
- Canonical product trunk:
  - `origin/main`
- Repository policy:
  - day-to-day work branches must be based on `origin/main`
  - `source/main` is for comparison and selective import work only when the `source` remote is present
- Local app URL: `http://localhost:4000`
- Local runtime project root override:
  - `PROJECTS_PATH=/Users/jordan/Projects`
  - `WORKSPACE_BASE_PATH=/Users/jordan/Projects`
- Local auth behavior:
  - `MC_API_TOKEN` is set in `.env.local`
  - direct API calls to protected `/api/*` routes require `Authorization: Bearer <token>`

## Verified Runtime Behavior

The following facts were re-verified against the live local runtime on `2026-04-02`:

- `npm run dev` is the default local operating mode on `localhost:4000`
  - authenticated `GET /api/health` now returns HTTP `200` with JSON like `{"status":"ok","uptime_seconds":...,"version":"2.4.0"}` during this stabilization pass
  - `next dev` uses `.next-dev` while `next build` and `next start` keep using `.next`, which prevents a build from clobbering the active dev runtime
- The repo-backed strict workflow is behaving truthfully on this checkout
  - the clean-room smoke task completed end-to-end through build -> test -> verification without manual task-state repair
  - both disposable smoke tasks were deleted successfully afterward, and their isolated workspaces were removed from the active projects tree
- The local control-plane database was returned to a pre-real-work baseline
  - all clearly synthetic null-product fixture tasks were purged
  - the reusable smoke product remains present and empty
  - real `LLI SaaS` planning tasks were preserved
  - orphan learner-session rows were removed
  - after cleanup, there are `0` live tasks in `assigned|in_progress|testing|review|verification`
- Runtime evidence and transcript fallback now have separate roles
  - Sessions, Deliverables, and Agent Live can recover visibility after a broken run
  - workflow advancement still depends on explicit markers such as `TASK_COMPLETE`, `BLOCKED`, `TEST_PASS`, `TEST_FAIL`, `VERIFY_PASS`, or `VERIFY_FAIL`
  - when a run ends before the live listener sees a marker, Mission Control uses official gateway history internally to recover a missed marker or synthesize an explicit runtime/provider blocker
- Strict workflow ownership is enforced at both PATCH and dispatch time
  - `inbox` is unassigned, `assigned` / `in_progress` are builder-owned, `testing` is tester-owned, `review` is queue-only, and `verification` is reviewer-owned
  - invalid manual workflow moves now fail closed with `409` instead of dispatching the wrong prompt to the wrong persistent agent session
- Protected callback instructions are aligned with runtime auth
  - when `MC_API_TOKEN` is configured, builder/tester/verifier dispatch prompts include the required `Authorization: Bearer <token>` header for localhost callback requests
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
  - `GET /api/openclaw/background-tasks` exposes the OpenClaw task ledger as read-only observability and correlates known session keys back to Mission Control task sessions when possible
  - the detached-work route now also surfaces `status`, `sourceChannel`, and `warning` so operators can see degraded ledger reads instead of treating them as a silent empty state
  - a timed-out empty ledger is currently surfaced truthfully as `status: "degraded"` with a warning, which is acceptable operator behavior for this baseline
- The session detail route no longer crashes on `sessions.list` payload shape differences
  - authenticated `GET /api/openclaw/sessions/{id}` now returns a normal `404` for a missing session instead of a `500`
- Static error-page build regression is not reproducible on the current checkout
  - `npm run build` completed successfully on this `v2.4.0-local-baseline` worktree after compile, typecheck, static generation, and route optimization

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

## Historical Snapshots

These files are preserved for context, but they are not the current-state source of truth:

- [docs/archive/status/VERIFICATION_CHECKLIST.md](archive/status/VERIFICATION_CHECKLIST.md)
- [docs/archive/status/HANDOVER-2026-03-03.md](archive/status/HANDOVER-2026-03-03.md)
- [HANDOFF-2026-03-26-AUTOPILOT.md](../HANDOFF-2026-03-26-AUTOPILOT.md)
- [OPENCLAW_RELEASE_IMPACT_AUDIT_2026-04-02.md](OPENCLAW_RELEASE_IMPACT_AUDIT_2026-04-02.md)

## Active Docs To Trust

- [../VERIFICATION_CHECKLIST.md](../VERIFICATION_CHECKLIST.md) for the current shareable verification contract
- [docs/README.md](README.md) for the current docs map and documentation conventions
- [docs/LOCAL_OPERATIONS_RUNBOOK.md](LOCAL_OPERATIONS_RUNBOOK.md) for local start/restart, health, backup, and checkpoint commands
- [USER_GUIDE.md](USER_GUIDE.md) for the shareable doc entrypoint
- [README.md](../README.md) for upstream/public product framing
- [PRODUCTION_SETUP.md](../PRODUCTION_SETUP.md) for generic setup patterns
- [ORCHESTRATION.md](../ORCHESTRATION.md) for explicit workflow and runtime evidence behavior
- [docs/AGENT_PROTOCOL.md](AGENT_PROTOCOL.md) for agent-side contract
- [docs/ORCHESTRATION_WORKFLOW.md](ORCHESTRATION_WORKFLOW.md) for orchestration expectations

If any of those disagree with this page, this page wins for this machine and this worktree.
