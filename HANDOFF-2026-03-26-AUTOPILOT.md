# Mission Control Autopilot Handoff — 2026-03-26

> [!NOTE]
> Historical dated handoff snapshot. Use [docs/CURRENT_LOCAL_STATUS.md](docs/CURRENT_LOCAL_STATUS.md) for the current local source of truth.

## Source Of Truth

- Mission Control upstream repo: https://github.com/crshdn/mission-control
- OpenClaw CLI docs: https://docs.openclaw.ai/cli

This local checkout must behave according to the upstream Mission Control docs, not older internal assumptions.

## Live App State

- Repo path: [mission-control](/Users/jordan/.openclaw/workspace/mission-control)
- Local app URL: `http://localhost:4000`
- OpenClaw is already installed and upgraded locally
- Current workspace: `LLI SaaS`
- Current task under active investigation:
  - `82c5dd08-3499-4089-9fbc-db3f3b11a249`
  - `Pre-Scan Monday.com Board Configuration Validator`

## What Is Fixed

- Planning approval is enforced before execution.
- Planner-created agents are task-scoped instead of polluting the workspace roster.
- Task routing no longer fuzzy-matches planner agents.
- Builder default routing now resolves to `agent:coder:` if no explicit session prefix is set.
- Agent completion markers (`TASK_COMPLETE`, `BLOCKED`, `TEST_PASS`, `TEST_FAIL`, `VERIFY_PASS`, `VERIFY_FAIL`) now route through a shared workflow handler.
- The unsupported session-history API no longer throws a misleading `500`; it returns `501`.
- Workspace isolation now reuses and resets an existing task worktree and uses a cached repo/worktree flow instead of cloning into a non-empty task directory.
- Workspace port allocations now release and reuse ports correctly; live DB migration `031` changes `workspace_ports` uniqueness from global-per-port to active-only.
- Builder redispatches can now force a fresh workspace after a workspace-health blocker instead of blindly reusing the same broken task directory.
- Builder dispatch now fails safe if isolated workspace creation fails instead of silently falling back to a non-isolated project path.
- Builder dispatches now start a fresh OpenClaw run on the stable session key by prepending `/new` to the dispatch message, which prevents stale invalidation context from replaying into the next rerun.
- Workspace isolation now rejects file-provider-managed `PROJECTS_PATH` roots on macOS and tells the operator to move the live project root to a normal local directory such as `/Users/jordan/Projects`.
- Health checks no longer endlessly auto-dispatch a task once a run has already ended without reconciliation; they now surface a real error.
- Runtime reconciliation now also updates stale active root task-session rows from the live gateway terminal state before the unreconciled-run sweep, so fast-ended builder runs no longer stay wedged as fake active sessions.

## What Is Still Broken

The screenshots captured the next problem area that has now been addressed on the code path:

1. Mission Control now recovers Sessions from the live OpenClaw session tree.
2. Mission Control now recovers Deliverables from the isolated workspace diff.
3. Agent Live now reports a terminal `session_ended` state instead of silently returning `no_session` when only ended task sessions exist.
4. Health checks no longer keep appending new zombie/stalled entries once the task is already marked as an unreconciled ended run.

What remains broken after that fix is now outside the original callback-path bug:

1. The builder now has an explicit blocker path via `BLOCKED: ...`, and the live validator task has been verified to use it.
2. The machine still has a real host-level filesystem risk if disk headroom stays very low. The original deadlock path was traced to file-provider-managed `~/Documents`, and the local runtime has now been moved to `/Users/jordan/Projects` to avoid that root.
3. Builder-session reuse no longer replays stale invalidation context on redispatch, because Mission Control now forces a fresh OpenClaw run on dispatch while keeping the stable `agent:coder:mission-control-builder-agent` routing key.

The current debugging target is now:

`Why does this machine still hit host-level file read/write deadlocks (`Errno 11`) even in a fresh clone, and should Mission Control rotate to a fresh builder session after terminal/invalidation runs to avoid stale session context on redispatch?`

## Screenshot-Backed Next Issues

- [Screenshot 2026-03-26 at 10.43.04 AM](/Users/jordan/Desktop/Screenshot%202026-03-26%20at%2010.43.04%E2%80%AFAM.png)
  - Builder shows as `WORKING`
  - task card is in `IN PROGRESS`
  - live feed mostly shows agent catalog noise, not meaningful execution evidence
- [Screenshot 2026-03-26 at 10.43.33 AM](/Users/jordan/Desktop/Screenshot%202026-03-26%20at%2010.43.33%E2%80%AFAM.png)
  - Team tab shows the intended core execution team
- [Screenshot 2026-03-26 at 10.43.39 AM](/Users/jordan/Desktop/Screenshot%202026-03-26%20at%2010.43.39%E2%80%AFAM.png)
  - Planner-suggested agents still appear separately, which is expected after the refactor
- [Screenshot 2026-03-26 at 10.43.47 AM](/Users/jordan/Desktop/Screenshot%202026-03-26%20at%2010.43.47%E2%80%AFAM.png)
  - Activity showed old zombie/autodispatch noise before the reconciliation fix
- [Screenshot 2026-03-26 at 10.43.54 AM](/Users/jordan/Desktop/Screenshot%202026-03-26%20at%2010.43.54%E2%80%AFAM.png)
  - Deliverables was empty before runtime evidence reconciliation
- [Screenshot 2026-03-26 at 10.44.02 AM](/Users/jordan/Desktop/Screenshot%202026-03-26%20at%2010.44.02%E2%80%AFAM.png)
  - Sessions showed no sub-agent sessions before runtime evidence reconciliation
- [Screenshot 2026-03-26 at 10.44.09 AM](/Users/jordan/Desktop/Screenshot%202026-03-26%20at%2010.44.09%E2%80%AFAM.png)
  - Workspace shows real diff evidence and mergeable worktree state
- [Screenshot 2026-03-26 at 10.44.19 AM](/Users/jordan/Desktop/Screenshot%202026-03-26%20at%2010.44.19%E2%80%AFAM.png)
  - Agent Live was blank before the stream-state fix

## Files Changed In This Debugging Pass

- [src/lib/openclaw/routing.ts](/Users/jordan/.openclaw/workspace/mission-control/src/lib/openclaw/routing.ts)
- [src/lib/agent-signals.ts](/Users/jordan/.openclaw/workspace/mission-control/src/lib/agent-signals.ts)
- [src/app/api/tasks/[id]/dispatch/route.ts](/Users/jordan/.openclaw/workspace/mission-control/src/app/api/tasks/[id]/dispatch/route.ts)
- [src/app/api/webhooks/agent-completion/route.ts](/Users/jordan/.openclaw/workspace/mission-control/src/app/api/webhooks/agent-completion/route.ts)
- [src/lib/chat-listener.ts](/Users/jordan/.openclaw/workspace/mission-control/src/lib/chat-listener.ts)
- [src/lib/agent-health.ts](/Users/jordan/.openclaw/workspace/mission-control/src/lib/agent-health.ts)
- [src/lib/workspace-isolation.ts](/Users/jordan/.openclaw/workspace/mission-control/src/lib/workspace-isolation.ts)
- [src/app/api/openclaw/sessions/[id]/history/route.ts](/Users/jordan/.openclaw/workspace/mission-control/src/app/api/openclaw/sessions/[id]/history/route.ts)
- [src/lib/bootstrap-agents.ts](/Users/jordan/.openclaw/workspace/mission-control/src/lib/bootstrap-agents.ts)
- [src/lib/db/migrations.ts](/Users/jordan/.openclaw/workspace/mission-control/src/lib/db/migrations.ts)
- [src/lib/db/index.ts](/Users/jordan/.openclaw/workspace/mission-control/src/lib/db/index.ts)
- [src/lib/task-notes.ts](/Users/jordan/.openclaw/workspace/mission-control/src/lib/task-notes.ts)
- [src/lib/learner.ts](/Users/jordan/.openclaw/workspace/mission-control/src/lib/learner.ts)
- [src/lib/openclaw/routing.test.ts](/Users/jordan/.openclaw/workspace/mission-control/src/lib/openclaw/routing.test.ts)
- [src/lib/agent-signals.test.ts](/Users/jordan/.openclaw/workspace/mission-control/src/lib/agent-signals.test.ts)
- [src/lib/task-evidence.ts](/Users/jordan/.openclaw/workspace/mission-control/src/lib/task-evidence.ts)
- [src/lib/task-evidence.test.ts](/Users/jordan/.openclaw/workspace/mission-control/src/lib/task-evidence.test.ts)
- [src/lib/agent-live.ts](/Users/jordan/.openclaw/workspace/mission-control/src/lib/agent-live.ts)
- [src/lib/agent-live.test.ts](/Users/jordan/.openclaw/workspace/mission-control/src/lib/agent-live.test.ts)
- [src/components/TaskModal.tsx](/Users/jordan/.openclaw/workspace/mission-control/src/components/TaskModal.tsx)
- [src/components/AgentLiveTab.tsx](/Users/jordan/.openclaw/workspace/mission-control/src/components/AgentLiveTab.tsx)

## Current Verified Live Facts

- `/api/health` returns `{"status":"ok","version":"2.4.0"}`
- `localhost:4000` has been restarted onto the updated build
- Local runtime env now overrides the upstream default project root:
  - `PROJECTS_PATH=/Users/jordan/Projects`
  - `WORKSPACE_BASE_PATH=/Users/jordan/Projects`
- `Builder Agent` in `LLI SaaS` now has `session_key_prefix = 'agent:coder:'`
- Live DB migration `031` is applied, and `workspace_ports` now allows released ports to be reused while keeping active ports unique
- `GET /api/tasks/{id}/subagent` now recovers the validator task's `CRMAgent` and `PortalAgent` child sessions
- `GET /api/tasks/{id}/deliverables` now recovers the validator task's changed files from the isolated workspace diff
- `GET /api/tasks/{id}/agent-stream` now returns `session_ended` when the task only has ended task sessions
- The real browser UI on `localhost:4000` now shows:
  - Deliverables: the recovered task files instead of an empty state
  - Sessions: the recovered `PortalAgent` and `CRMAgent` child sessions
  - Agent Live: a visible `session_ended` state instead of a hidden/blank panel
- A fresh dispatch on `localhost:4000` now starts a fresh OpenClaw run on the stable builder key and ends with an explicit `BLOCKED:` marker instead of falling back to `Run ended without completion callback or workflow handoff (...)`
- The validator investigation proved two real blockers:
  - The original assigned worktree under `~/Documents/Shared/projects/...` was unhealthy.
  - Even a fresh clone under that same file-provider-managed root hit `Errno 11` on direct file writes, which pointed to a host filesystem problem rather than only a Mission Control routing bug.
- The Monday.com pre-scan validator feature work is now manually complete in `/Users/jordan/Projects/pre-scan-monday-com-board-configuration-validator/.workspaces/task-82c5dd08-3499-4089-9fbc-db3f3b11a249`, with official Monday OAuth semantics, required column-type enforcement, updated docs, and green touched-service verification.
- A fresh closeout dispatch on `2026-03-26T21:42Z` still ended without an explicit builder completion marker, but the patched runtime now reconciles that run correctly:
  - the root builder session row is marked terminal instead of staying fake-`active`
  - the task carries an explicit unreconciled-run `planning_dispatch_error`
  - patched health cycles do not append newer `Agent health: zombie` noise after that terminal state
- The workspace diff still exists on disk and is reflected in recovered deliverables
- A second stale `next-server` process was also running against the same DB and OpenClaw gateway; killing it stopped the duplicate zombie-activity spam on the live app

## Most Likely Next Work

1. Decide whether to fix the builder’s final completion-signal behavior next, or to advance the task manually with truthful workflow signals after an operator decision about the final merge/PR step.
2. Keep any new task reruns on `/Users/jordan/Projects`; do not regress back to `~/Documents/Shared/projects`.
3. If the builder completion-marker path is fixed later, rerun the validator task once more and verify it reaches `TASK_COMPLETE`/`TEST_PASS`/`VERIFY_PASS` instead of the unreconciled-run fallback.

## Safety Backup

- DB backup before the latest validator reset/re-dispatch:
  - [20260326-103748-pre-validator-redispatch.db](/Users/jordan/.openclaw/workspace/ARCHIVE/mission-control-resets/20260326-103748-pre-validator-redispatch.db)

## Do Not Assume

- Do not assume the upstream GitHub repo is universally broken.
- Do not assume the local install is fully healthy just because the app boots.
- Do not assume the builder has failed just because Agent Live is blank.
- Do not assume the builder has succeeded just because the Workspace tab shows diffs.

The current problem is no longer missing execution evidence, stale builder-session reuse, or fake-active root sessions. The remaining closeout gap is that the builder still does not emit the explicit completion marker on its own for this already-finished validator task.
