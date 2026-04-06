# Mission Control Card Operations Runbook

This document records the failure patterns seen during the BoreReady curriculum card rollout on 2026-04-05 and defines the correct operating method for creating, dispatching, and recovering cards.

Use this when:

- creating new execution or review cards
- moving cards between builder, tester, and reviewer lanes
- deciding whether a task is truly stalled or only queued
- debugging ended-session and wrong-lane problems

## What Went Wrong

The failures were not one bug. They were a chain:

1. Cards were created directly into active stages without all stage metadata being initialized.
2. Some tasks launched without hydrated repo context, which allowed invalid repo and PR artifacts.
3. Runtime inspection initially leaned too hard on UI state and subagent-only views instead of authoritative task session state.
4. A dispatch can return HTTP 200 while still meaning queued, not started.
5. Queue stages such as review were manually redispatched instead of being advanced through workflow rules.
6. The automated test route changed task status directly without routing the change through the workflow engine.
7. That direct status mutation left `assigned_agent_id` and session ownership on the wrong lane after testing.
8. Reused persistent sessions plus stale task pointers made some cards look active when the wrong agent lane actually owned the runtime.
9. Several review outputs contained fabricated or cross-project claims, which triggered fail-loopbacks and made the queue look more broken than it was.

## Root Causes

### Card creation mistakes

- Direct-to-execution tasks need `planning_complete = 1`.
- Repo-backed tasks need `product_id`, `repo_url`, and `repo_branch` at creation time.
- Review/verification cards need evidence attached before quality-stage advancement.

### Monitoring mistakes

- `/api/tasks/[id]/subagent` is not the full runtime picture.
- Agent rows can be stale.
- The board can show a card in a lane even when there is no active root session.

### Workflow mistakes

- Queue stages are not executable stages.
- Test pass/fail must go through `handleStageTransition(...)`, not direct status updates.
- A queued dispatch result must not be treated as started work.

### Content-quality mistakes

- Review cards must validate only against the actual source packet in the repo.
- Any claim not anchored to the real workspace files must be treated as failure.
- Do not accept deliverables that describe a different module, different statute set, or different project state.

## Correct Way To Create Cards

### 1. Create cards with the right initial state

For execution-stage cards:

- use the intended active stage only when the card is truly ready to run
- ensure planning is already complete
- ensure repo-backed metadata is present

Required invariants:

- execution-stage task does not reopen planning UI
- repo-backed task has workspace product context
- workflow template is attached

### 2. Register exact deliverables up front

Before entering testing, review, or verification:

- attach the file deliverables that actually exist
- attach the PR URL only if it is real
- add at least one activity note describing what the card is meant to validate

Do not let cards carry placeholder PR URLs, off-repo paths, or artifact lists that were never produced.

### 3. Respect strict stage ownership

On this workflow:

- `assigned` and `in_progress` are builder-owned
- `testing` is tester-owned
- `review` is queue-only
- `verification` is reviewer-owned

Implication:

- do not dispatch queue stages directly unless the dispatch route explicitly auto-promotes them to the next actionable stage
- do not hand-force a tester or reviewer onto the wrong stage just to make the board move

## Correct Way To Monitor Cards

### Use task sessions, not subagent-only views

Authoritative runtime check:

```bash
curl -s -H "Authorization: Bearer $MC_API_TOKEN" \
  "http://localhost:4000/api/openclaw/sessions?task_id=<task-id>"
```

Use this to answer:

- is there an active root session
- which model is actually bound
- which task the active lane is actually attached to

Do not infer runtime ownership from:

- board column alone
- agent sidebar alone
- `/api/tasks/[id]/subagent` alone

### Distinguish queued from broken

Queued is healthy when:

- task status is `assigned`
- `status_reason` says it is waiting for another task
- no active session exists for the queued task
- the blocking task does have the active session

Broken is real when:

- task is in an executing stage and has no active session
- task shows `Run ended without completion callback or workflow handoff ...`
- task has a session attached to the wrong lane or wrong task

### Treat HTTP 200 carefully

Dispatch success is only a true start if the payload is not queued.

Healthy queued response:

- `success: true`
- `queued: true`
- a `waiting_for_task_id`

That means wait, not run.

## Correct Way To Recover Cards

### If an executing card has no active session

1. Check `/api/openclaw/sessions?task_id=<task-id>`.
2. If there is no active root session, redispatch the specific card.
3. Re-read the task and sessions immediately.

### If a queued card still shows an ended-session error

Re-dispatch it so the queue logic can rewrite the waiting state cleanly.

Expected good result:

- `success: true`
- `queued: true`
- waiting message names the actually active blocking task

### If a tester pass moves a task to review with the tester still attached

That is a workflow bug, not an operator-only problem.

Correct fix:

- patch the route that changed status directly
- make it call `handleStageTransition(...)`
- only then normalize the live cards that were damaged by the old behavior

## Session Lessons From This Incident

### Session truth beats UI truth

The board can lag or show stale lane placement. Root sessions are the real ownership signal.

### False unreconciled-run errors exist

Some generic ended-session errors can be stale while a streaming root session still exists. Health reconciliation must clear those instead of preserving them forever.

### Persistent session reuse needs authoritative selection

When multiple stored sessions exist for one task, use the authoritative root session, not just the newest row.

## Content Validation Lessons

The review cards failed repeatedly because some agent outputs were validating against invented or wrong-source content.

Required review standard:

- validate only against real files present in the checked-out workspace
- prefer absolute task workspace paths for repo-backed work
- reject any report that references files, statutes, or module content absent from the workspace
- treat cross-project bleed as a hard fail, not a warning

## Operator Checklist

Before creating cards:

- confirm workspace product is active and repo-backed metadata is present
- confirm the workflow template is attached
- define exact deliverables
- define the intended first actionable stage

After creating cards:

- verify execution-stage cards have `planning_complete = 1`
- verify repo-backed cards have `repo_url` and `repo_branch`
- verify quality-stage cards have evidence attached

While monitoring cards:

- check `/api/health`
- inspect `/api/openclaw/sessions?task_id=...`
- treat queued 200 responses as waiting, not started
- do not rely on stale agent `task_id` pointers

When something looks wrong:

- recover the specific card first
- do not restart the full gateway unless the gateway itself is unhealthy or multiple unrelated dispatches fail
- if lane ownership is wrong after a stage transition, audit the route for direct status mutation bypassing workflow handoff

## Code Paths That Matter

- [src/app/api/tasks/route.ts](../src/app/api/tasks/route.ts): task creation invariants
- [src/app/api/tasks/[id]/dispatch/route.ts](../src/app/api/tasks/%5Bid%5D/dispatch/route.ts): dispatch, queue handling, model binding
- [src/app/api/tasks/[id]/test/route.ts](../src/app/api/tasks/%5Bid%5D/test/route.ts): automated test pass/fail stage transitions
- [src/lib/workflow-engine.ts](../src/lib/workflow-engine.ts): authoritative stage ownership and queue draining
- [src/app/api/openclaw/sessions/route.ts](../src/app/api/openclaw/sessions/route.ts): full task session inspection

## Bottom Line

The correct pattern is:

1. Create cards with complete metadata.
2. Attach evidence before quality gates.
3. Use task-scoped root sessions as the runtime source of truth.
4. Treat queued cards as waiting, not stalled.
5. Route every stage change through the workflow engine.
6. Recover individual broken cards before considering full control-plane restarts.
