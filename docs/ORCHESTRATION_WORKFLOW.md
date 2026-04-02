# Task Orchestration Workflow

This guide explains how the master agent should orchestrate sub-agents to properly integrate with Mission Control.

> [!NOTE]
> Use [CURRENT_LOCAL_STATUS.md](CURRENT_LOCAL_STATUS.md) for the live verified state of this local checkout. This guide describes the intended orchestration contract.

## Overview

When the orchestrator spawns a sub-agent to work on a task, **all activities, deliverables, and session info should be logged** to Mission Control so the UI shows real-time progress.

Mission Control now has a fallback reconciliation path for visibility, but that fallback is not a substitute for the normal orchestration contract:
- Sessions can be recovered from the live OpenClaw session tree
- Deliverables can be recovered from the isolated workspace diff
- Agent Live can remain visible and report `session_ended` for unreconciled ended runs
- Workflow advancement still requires explicit completion markers

For repo-backed tasks, the normal orchestration contract is workspace-first:
- test/review against the task `workspace_path`
- use registered file deliverables as the primary artifact list
- include the PR URL as supporting context and as a `url` deliverable when available

For repo-backed testing and review work:
- shell commands should use `cd <workspace> && ...`
- non-shell file tools such as `read`, `edit`, `find`, `glob`, and file-path-based `ls` must use absolute paths under the task workspace
- when a deliverable is listed with an absolute path, copy that exact path instead of switching to a bare repo-relative path

## Import the Helper

```typescript
// From Node.js context (the orchestrator's environment)
import * as orchestrator from '@/lib/orchestration';

// Or use direct fetch calls if TypeScript module isn't available
```

## Workflow Steps

## Strict Stage Ownership

On this local checkout's strict workflow:

- `inbox` is unassigned triage
- `assigned` and `in_progress` are builder-owned
- `testing` is tester-owned
- `review` is queue-only
- `verification` is reviewer-owned

Mission Control enforces that ownership in both `PATCH /api/tasks/:id` and `POST /api/tasks/:id/dispatch`.
Illegal manual moves or role/status mismatches now fail closed with `409` instead of dispatching the wrong prompt to the wrong agent.

### 1. When Spawning a Sub-Agent

**Immediately after spawning**, register the session:

```typescript
await orchestrator.onSubAgentSpawned({
  taskId: 'task-abc123',                           // From Mission Control task
  sessionId: 'agent:main:subagent:xyz789',         // Sub-agent's OpenClaw session ID
  agentName: 'fix-mission-control-integration',    // Descriptive name
  description: 'Fix real-time updates and logging', // Optional details
});
```

**What this does:**
- Creates activity log entry: "Sub-agent spawned: fix-mission-control-integration"
- Registers session in `openclaw_sessions` table with `session_type='subagent'`
- Broadcasts SSE event so UI updates immediately
- Agent counter in sidebar updates from 0 → 1

### 2. During Sub-Agent Work

Log significant activities as work progresses:

```typescript
await orchestrator.logActivity({
  taskId: 'task-abc123',
  activityType: 'updated',
  message: 'Fixed SSE broadcast in dispatch endpoint',
  metadata: { file: 'src/app/api/tasks/[id]/dispatch/route.ts' }
});

await orchestrator.logActivity({
  taskId: 'task-abc123',
  activityType: 'file_created',
  message: 'Created orchestration helper',
  metadata: { file: 'src/lib/orchestration.ts' }
});
```

**Activity Types:**
- `spawned` - Sub-agent started
- `updated` - General progress update
- `completed` - Sub-agent finished
- `file_created` - File created/modified
- `status_changed` - Status change occurred

### 3. When Sub-Agent Completes

**Before marking task as review**, log completion with deliverables:

```typescript
await orchestrator.onSubAgentCompleted({
  taskId: 'task-abc123',
  sessionId: 'agent:main:subagent:xyz789',
  agentName: 'fix-mission-control-integration',
  summary: 'All integration issues fixed and tested',
  deliverables: [
    {
      type: 'file',
      title: 'Updated dispatch route',
      path: 'src/app/api/tasks/[id]/dispatch/route.ts'
    },
    {
      type: 'file',
      title: 'Orchestration helper',
      path: 'src/lib/orchestration.ts'
    },
    {
      type: 'file',
      title: 'Fixed Header component',
      path: 'src/components/Header.tsx'
    }
  ]
});
```

**What this does:**
- Logs completion activity
- Marks session as `status='completed'`, sets `ended_at` timestamp
- Logs all deliverables to `task_deliverables` table
- Broadcasts events so UI updates
- Agent counter decrements back to 0

### 4. Review & Approval

In the strict workflow, `review` is a queue stage and `verification` is the active reviewer-owned approval stage.

**Before approving**:
- if the task is still in `review`, it is waiting for the verification slot and should not be marked `done` yet
- once the task reaches `verification`, verify deliverables exist and the assigned reviewer may complete `verification -> done`
- legacy direct `review -> done` approval remains master-only

```typescript
const hasDeliverables = await orchestrator.verifyTaskHasDeliverables('task-abc123');

if (!hasDeliverables) {
  console.log('⚠️ Task has no deliverables - cannot approve');
  console.log('📋 Ask sub-agent to provide deliverables or log them manually');
  return;
}

// Now safe to approve
await fetch('http://localhost:4000/api/tasks/task-abc123', {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    status: 'done',
    updated_by_agent_id: 'reviewer-agent-id'  // the assigned reviewer or a master agent
  })
});
```

**Backend validation:**
- Endpoint will reject `review` → `done` transitions from non-master agents
- Endpoint allows `verification` → `done` for the assigned reviewer role or a master agent
- This ensures quality control

### 5. Report Explicit Workflow Completion

Recovered evidence is not enough to move the task forward.

The active agent still needs to emit the correct workflow marker in chat:

```text
TASK_COMPLETE: <build stage summary>
BLOCKED: <builder blocker> | need: <specific fix/input> | meanwhile: <fallback progress>
TEST_PASS: <testing summary>
TEST_FAIL: <failure summary>
VERIFY_PASS: <verification summary>
VERIFY_FAIL: <verification failure summary>
```

## Fresh Reruns

Mission Control starts fresh reruns by prepending `/new` on the existing OpenClaw routing key.

Expected behavior for a healthy rerun:

- the `sessionKey` stays stable
- the `sessionId` changes for the new run
- the latest run receives fresh task instructions

Do not treat a reused `sessionKey` by itself as evidence of stale task context.

## Direct API Usage (Without Helper)

If you can't import the TypeScript module, use direct fetch:

If `MC_API_TOKEN` is configured, add `Authorization: Bearer <token>` to these requests.

```typescript
// Register sub-agent
await fetch('http://localhost:4000/api/tasks/TASK_ID/subagent', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: 'Bearer <MC_API_TOKEN>',
  },
  body: JSON.stringify({
    openclaw_session_id: 'agent:main:subagent:xyz',
    agent_name: 'my-subagent-name'
  })
});

// Log activity
await fetch('http://localhost:4000/api/tasks/TASK_ID/activities', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: 'Bearer <MC_API_TOKEN>',
  },
  body: JSON.stringify({
    activity_type: 'updated',
    message: 'Did something important'
  })
});

// Log deliverable
await fetch('http://localhost:4000/api/tasks/TASK_ID/deliverables', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: 'Bearer <MC_API_TOKEN>',
  },
  body: JSON.stringify({
    deliverable_type: 'file',
    title: 'My deliverable',
    path: 'path/to/file.ts'
  })
});

// Complete session
await fetch('http://localhost:4000/api/openclaw/sessions/SESSION_ID', {
  method: 'PATCH',
  headers: {
    'Content-Type': 'application/json',
    Authorization: 'Bearer <MC_API_TOKEN>',
  },
  body: JSON.stringify({
    status: 'completed',
    ended_at: new Date().toISOString()
  })
});
```

## Testing Checklist

After implementing this workflow, verify:

- ✅ Task status changes appear without page refresh
- ✅ Agent counter shows "1" when sub-agent is working
- ✅ Activities tab shows timestamped log of all work
- ✅ Deliverables tab shows all files/artifacts created
- ✅ Sessions tab shows sub-agent info with start/end times
- ✅ Agent Live shows `streaming`, `no_session`, or `session_ended` instead of a blank panel
- ✅ Header shows accurate "X agents active, Y tasks in queue"
- ✅ Cannot approve task without deliverables

## Common Pitfalls

1. **Forgetting to register session** → Agent counter stays at 0
2. **Not logging deliverables** → Cannot approve task
3. **Wrong session ID format** → Session not found
4. **Not completing session** → Agent counter never decrements
5. **Ending the run without a workflow marker** → Mission Control may recover a missed explicit marker or synthesize an explicit blocker from gateway history, but successful runs should still emit the required marker directly
6. **Builder hits a blocker but only writes free-form prose** → Mission Control cannot distinguish an intentional blocker from a missing callback; use `BLOCKED: ...`
7. **Approving without verification** → Backend rejects with 400 error
8. **Treating session-history replay as the only review surface** → `GET /api/openclaw/sessions/{id}/history` is read-only and bounded; use Activities / Deliverables / Sessions / Agent Live first, then use transcript history or Detached Work as supporting evidence

## Example: Complete Workflow

```typescript
// 1. Spawn sub-agent
const sessionId = await spawnSubAgent({
  label: 'fix-integration',
  task: taskDescription
});

// 2. Register immediately
await orchestrator.onSubAgentSpawned({
  taskId: task.id,
  sessionId: sessionId,
  agentName: 'fix-integration',
  description: 'Fix Mission Control integration'
});

// 3. Monitor and log progress
// (Sub-agent does work)

// 4. When complete, log everything
await orchestrator.onSubAgentCompleted({
  taskId: task.id,
  sessionId: sessionId,
  agentName: 'fix-integration',
  summary: 'Fixed all integration issues',
  deliverables: [
    { type: 'file', title: 'Fixed route', path: 'src/api/...' }
  ]
});

// 5. Move to review
await updateTaskStatus(task.id, 'review');

// 6. Verify and approve
const hasDeliverables = await orchestrator.verifyTaskHasDeliverables(task.id);
if (hasDeliverables) {
  await updateTaskStatus(task.id, 'done', { updated_by_agent_id: orchestratorId });
} else {
  console.log('⚠️ Cannot approve - no deliverables');
}
```

---

**Remember:** Every sub-agent action should be visible in Mission Control. If it's not logged, it didn't happen!
