# Mission Control Local Status

This is the canonical current-state document for the local checkout at [the repo root](../).

Use this page when you need the truth about this machine and this worktree. Treat the top-level [README.md](../README.md) and [CHANGELOG.md](../CHANGELOG.md) as upstream/public-facing docs first, then use this page for local deviations, verified runtime evidence, and known gaps.

## Snapshot

- Date verified: `2026-03-28`
- Upstream base: `v2.4.0`
- Local checkout state: `v2.4.0-dirty`
- Git ref: `chore/pre-real-work-baseline-20260327`
- Local app URL: `http://localhost:4000`
- Local runtime project root override:
  - `PROJECTS_PATH=/Users/jordan/Projects`
  - `WORKSPACE_BASE_PATH=/Users/jordan/Projects`
- Local auth behavior:
  - `MC_API_TOKEN` is set in `.env.local`
  - direct API calls to protected task endpoints require `Authorization: Bearer <token>`

## Verified Runtime Behavior

The following facts were re-verified against the live local runtime on `2026-03-28`:

- `npm run dev` is the default local operating mode on `localhost:4000`
  - `GET /api/health` returned HTTP `200` with `{"status":"ok","uptime_seconds":433,"version":"2.4.0"}` during this cleanup pass
  - `next dev` uses `.next-dev` while `next build` and `next start` keep using `.next`, which prevents a build from clobbering the active dev runtime
- The repo-backed strict workflow is behaving truthfully on this fork
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
- Protected callback instructions are aligned with runtime auth
  - when `MC_API_TOKEN` is configured, builder/tester/verifier dispatch prompts include the required `Authorization: Bearer <token>` header for localhost callback requests
- The session detail route no longer crashes on `sessions.list` payload shape differences
  - authenticated `GET /api/openclaw/sessions/{id}` now returns a normal `404` for a missing session instead of a `500`
- Static error-page build regression is not reproducible on the current checkout
  - `npm run build` completed successfully on this `v2.4.0-dirty` worktree after compile, typecheck, static generation, and route optimization

## Known Gaps

These are still real local limitations as of this verification pass:

1. Historical transcript replay is still intentionally unavailable through Mission Control's public route.
   `GET /api/openclaw/sessions/{id}/history` remains `501` even though Mission Control now uses the official gateway history endpoint internally for transcript-based closeout reconciliation.

2. The local checkout is still intentionally dirty relative to upstream.
   This branch is a local stabilization baseline, not a pristine mirror of upstream `v2.4.0`.

## Verification Commands

These were the commands used for the claims above:

```bash
cd /Users/jordan/.openclaw/workspace/mission-control

git rev-parse HEAD
git describe --tags --always --dirty
git branch --show-current
git symbolic-ref --short HEAD

curl -s http://localhost:4000/api/health

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
| Local runtime should use `npm run dev` on `localhost:4000` for day-to-day work | local operating convention | `verified` | fresh `2026-03-28` relaunch returned `GET /api/health = 200` with JSON on port `4000` | Keep `.next-dev` split in place and treat `dev` as the default local mode |
| Upstream defaults use `~/Documents/Shared` paths while this machine should run from `/Users/jordan/Projects` | [README.md](../README.md) | `verified with local deviation` | README config table plus local `.env.local` override | Keep README public-facing and point here for machine-specific runtime |
| Synthetic null-product fixture noise was removed before real work | local runtime/DB | `verified` | fixture task count `0`, orphan learner session count `0`, smoke product task count `0`, real `LLI SaaS` planning tasks preserved | Keep this page as the canonical pre-real-work baseline |
| Protected localhost callbacks need bearer auth when `MC_API_TOKEN` is set | [ORCHESTRATION.md](../ORCHESTRATION.md), [docs/AGENT_PROTOCOL.md](AGENT_PROTOCOL.md) | `verified` | dispatch prompts and local protected routes require bearer auth on this machine | Keep callback examples aligned with the real auth requirement |
| `GET /api/openclaw/sessions/{id}` no longer crashes on a non-array `sessions.list` payload | local runtime | `verified` | authenticated request now returns `404` for a missing session instead of `500` | Keep the client-side session-list normalization in place |
| Workflow advancement still depends on explicit completion markers, with gateway-history fallback for missed callbacks | [ORCHESTRATION.md](../ORCHESTRATION.md), [docs/AGENT_PROTOCOL.md](AGENT_PROTOCOL.md) | `verified with local deviation` | clean-room smoke completed end-to-end, and earlier missed callbacks were recoverable from gateway history | Keep active docs precise about evidence visibility versus transcript-based closeout recovery |
| Session-history replay is available through Mission Control's public route | stale internal assumption | `known gap` | `GET /api/openclaw/sessions/{id}/history` returns `501` | Keep limitation explicit in active docs |
| Static error-page build regression is currently reproducible from source | local status note from earlier session | `not reproducible` | current `npm run build` exits `0` on this worktree | Only reopen if a fresh failing revision or exact repro is captured |

## Historical Snapshots

These files are preserved for context, but they are not the current-state source of truth:

- [docs/archive/status/VERIFICATION_CHECKLIST.md](archive/status/VERIFICATION_CHECKLIST.md)
- [docs/archive/status/HANDOVER-2026-03-03.md](archive/status/HANDOVER-2026-03-03.md)
- [HANDOFF-2026-03-26-AUTOPILOT.md](../HANDOFF-2026-03-26-AUTOPILOT.md)

## Active Docs To Trust

- [README.md](../README.md) for upstream/public product framing
- [PRODUCTION_SETUP.md](../PRODUCTION_SETUP.md) for generic setup patterns
- [ORCHESTRATION.md](../ORCHESTRATION.md) for explicit workflow and runtime evidence behavior
- [docs/AGENT_PROTOCOL.md](AGENT_PROTOCOL.md) for agent-side contract
- [docs/ORCHESTRATION_WORKFLOW.md](ORCHESTRATION_WORKFLOW.md) for orchestration expectations

If any of those disagree with this page, this page wins for this machine and this worktree.
