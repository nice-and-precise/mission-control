# Real-Time Features - Quick Start Guide

> [!NOTE]
> This guide describes the real-time surfaces and API contract, but the canonical local-fork status lives in [docs/CURRENT_LOCAL_STATUS.md](docs/CURRENT_LOCAL_STATUS.md). If `MC_API_TOKEN` is configured, add `Authorization: Bearer <token>` to direct API calls.

## 🚀 Getting Started

### 1. Pull Latest Code

```bash
cd /path/to/mission-control
git pull origin main
npm install
```

### 2. Start Development Server

```bash
npm run dev
```

Open: http://localhost:4000

### 3. Verify Real-Time is Working

1. Open Mission Control in your browser
2. Open browser DevTools → Console
3. Look for: `[SSE] Connected` ← This means real-time is active!
4. Open a second browser window side-by-side
5. Create a task in one window
6. Watch it appear in the other window **instantly**

That's it! Real-time is now active. 🎉

## 🎯 What's New: Key Features

### 1. Live Updates (No Refresh Needed!)
- Create/move tasks → All browsers update instantly
- ~100ms latency
- Works across Chrome, Firefox, Safari

### 2. Task Details Enhanced
When you click on a task, Mission Control exposes several task-detail tabs. The most important evidence tabs are:

#### Overview Tab
- Same as before: edit title, description, status, etc.

#### Activity Tab
- Complete history of everything that happened to this task
- Who did what, when
- Includes reconciliation events when Mission Control recovers runtime evidence

#### Deliverables Tab
- Files, URLs, and artifacts created for this task
- Click to open files
- Prefer explicit API logging from agents
- Falls back to recovered workspace diff evidence when explicit deliverables are missing

#### Sessions Tab
- Shows sub-agents that worked on this task
- Session duration
- Active status (green pulsing dot = currently running)
- Falls back to recovered OpenClaw child-session evidence when sub-agents were not registered explicitly

#### Workspace Tab
- Shows isolated worktree path, branch, and merge status
- Useful when Deliverables were recovered from actual file changes

#### Agent Live Tab
- Streams `agent_event` and `chat_event` output from all active task sessions
- Returns `session_ended` when the task only has ended sessions
- Does not replay history yet

### 3. Agent Counter (NEW!)
- Sidebar now shows: "Active Sub-Agents: X"
- Live count of running sub-agents
- Updates every 10 seconds

## 🛠️ For the orchestrator: API Integration

### Logging Activities

When orchestrating tasks, log activities so users can see what's happening:

```typescript
// Log when you triage a task
await fetch(`http://localhost:4000/api/tasks/${taskId}/activities`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: 'Bearer <MC_API_TOKEN>', // required when MC_API_TOKEN is configured
  },
  body: JSON.stringify({
    activity_type: 'updated',
    message: 'Task triaged and assigned to Developer agent',
    agent_id: myAgentId,
  })
});
```

**Activity Types:**
- `spawned` - Sub-agent created
- `updated` - Task modified
- `completed` - Work finished
- `file_created` - New file produced
- `status_changed` - Status transition

### Tracking Deliverables

When a sub-agent creates files:

```typescript
await fetch(`http://localhost:4000/api/tasks/${taskId}/deliverables`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: 'Bearer <MC_API_TOKEN>', // required when MC_API_TOKEN is configured
  },
  body: JSON.stringify({
    deliverable_type: 'file', // or 'url', 'artifact'
    title: 'Implementation Report',
    path: '/absolute/path/to/report.md',
    description: 'Detailed implementation'
  })
});
```

### Registering Sub-Agents

When spawning a sub-agent:

```typescript
// 1. Spawn the sub-agent (your existing code)
const session = await spawnSubAgent(task);

// 2. Register it in Mission Control
await fetch(`http://localhost:4000/api/tasks/${taskId}/subagent`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: 'Bearer <MC_API_TOKEN>', // required when MC_API_TOKEN is configured
  },
  body: JSON.stringify({
    openclaw_session_id: session.id,
    agent_name: 'Developer Sub-Agent'
  })
});
```

## 🧪 Quick Test

### Test Real-Time Updates

1. **Open two browser windows:**
   - Window 1: http://localhost:4000
   - Window 2: http://localhost:4000

2. **Create a task in Window 1:**
   - Click "+ New Task"
   - Title: "Test Real-Time"
   - Save

3. **Watch Window 2:**
   - Task should appear in INBOX **without refreshing**
   - If it does → Real-time is working! ✅

4. **Move the task:**
   - Drag to ASSIGNED in Window 1
   - Should move in Window 2 instantly

### Test Activity Log

Using your terminal:

```bash
TOKEN=$(grep '^MC_API_TOKEN=' .env.local | cut -d= -f2-)

# Create a test task (copy the ID from response)
curl -X POST http://localhost:4000/api/tasks \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title": "Test Activity Log", "status": "inbox"}'

# Log an activity (replace TASK_ID)
curl -X POST http://localhost:4000/api/tasks/TASK_ID/activities \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"activity_type": "updated", "message": "This is a test activity"}'

# Now open the task in UI and click Activity tab
# You should see your test activity!
```

## 📊 What to Expect

### Visual Indicators

**SSE Connection Status:**
- Browser console shows `[SSE] Connected` = good
- If disconnected, it auto-reconnects in 5 seconds

**Agent Counter:**
- Sidebar shows "Active Sub-Agents: X" when sub-agents are running
- Updates every 10 seconds
- Green highlight when >0

**Activity Log:**
- Newest activities at top
- Icons for each activity type (🚀 spawned, ✏️ updated, ✅ completed)
- Relative timestamps ("5 mins ago")

**Deliverables:**
- File icon for files, link icon for URLs
- Monospace font for paths
- "Open" button for URLs

**Sessions:**
- Green pulsing dot = active
- Checkmark = completed
- Duration displayed (e.g., "2h 15m")

## 🔧 Troubleshooting

### "Real-time not working"

1. Check browser console:
   - Should see `[SSE] Connected`
   - If not, check Network tab for `/api/events/stream`

2. Hard refresh:
   - Cmd+Shift+R (Mac) or Ctrl+Shift+R (Windows)

3. Check server is running:
   - Terminal should show `✓ Ready in XXXXms`

### "Activity tab is empty"

Activities only appear after you start logging them via API. Old tasks won't have activities.

Mission Control may also add a reconciliation activity when it recovers sessions/deliverables from runtime evidence.

### "Agent counter stuck at 0"

Counter only shows sub-agents with:
- `session_type = 'subagent'`
- `status = 'active'`

Make sure you're registering sub-agents via the `/api/tasks/[id]/subagent` endpoint.

### "Agent Live says session ended"

This means Mission Control found task-linked sessions, but none of them are still active.

Current limitation:
- `/api/openclaw/sessions/[id]/history` still returns `501`
- Agent Live can show live streaming and terminal state, but not historical transcript replay

## 📚 More Information

- **Full Testing Guide:** `docs/TESTING_REALTIME.md`
- **Implementation Details:** `REALTIME_IMPLEMENTATION_SUMMARY.md`
- **API Specification:** `docs/REALTIME_SPEC.md`
- **Local Fork Status:** `docs/CURRENT_LOCAL_STATUS.md`
- **Changelog:** `CHANGELOG.md`

## 🎉 You're All Set!

Real-time integration is active, and the current local caveats are documented in `docs/CURRENT_LOCAL_STATUS.md`.

Enjoy the new transparency! 🦞✨

---

**Questions?** Check the docs above or ask the orchestrator.
