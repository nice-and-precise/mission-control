# Mission Control Orchestration Guide

This document explains how to orchestrate tasks in Mission Control, including how to:
- Register sub-agents
- Log activities
- Track deliverables
- Report explicit workflow completion signals
- Understand the runtime evidence fallback path

> [!NOTE]
> For the verified behavior of this detached local fork, including machine-specific runtime overrides and known gaps, see [docs/CURRENT_LOCAL_STATUS.md](docs/CURRENT_LOCAL_STATUS.md).

## API Base URL

```
http://localhost:4000
```

Or use the `MISSION_CONTROL_URL` environment variable.

If `MC_API_TOKEN` is configured, direct API calls must also include:

```bash
TOKEN="${MC_API_TOKEN:-your-token}"
```

## Task Lifecycle

```
INBOX → ASSIGNED → IN_PROGRESS → TESTING → REVIEW → VERIFICATION → DONE
```

**Status Descriptions:**
- **INBOX**: New tasks awaiting processing
- **ASSIGNED**: Task assigned to an agent, ready to be worked on
- **IN_PROGRESS**: Agent actively working on the task
- **TESTING**: Automated quality gate - runs browser tests, CSS validation, resource checks
- **REVIEW**: Queue stage between testing and verification in the strict workflow
- **VERIFICATION**: Reviewer/verifier is actively confirming the work is ready to ship
- **DONE**: Task completed and approved

## Workflow Authority

Mission Control can recover **visibility evidence** from the OpenClaw session tree and the isolated workspace when an agent run fails to POST the usual artifacts.

That fallback can populate:
- Sessions
- Deliverables
- Agent Live state (`no_session`, `streaming`, or `session_ended`)

It does **not** advance the workflow automatically.

Stage transitions still require an explicit completion signal in the agent conversation:
- `TASK_COMPLETE: ...`
- `BLOCKED: ... | need: ... | meanwhile: ...` for builder-stage blockers that should keep the task assigned but explicit
- `TEST_PASS: ...`
- `TEST_FAIL: ...`
- `VERIFY_PASS: ...`
- `VERIFY_FAIL: ...`

For repo-backed tasks, the primary handoff surface is:
- the task `workspace_path`
- registered file deliverables
- the task `pr_url` / `Pull Request` URL deliverable when present

Do not treat an empty root output folder as sufficient reason to fail a repo-backed tester/reviewer handoff when those repo artifacts exist.

In the strict workflow template:
- `review` is queue-only
- `verification` is owned by the `reviewer` role
- `VERIFY_PASS` can complete the task from `verification`
- legacy direct `review -> done` approval remains master-only

## When You Receive a Task

When a task is dispatched to you, the message includes:
- Task ID
- Output directory path
- API endpoints to call

For task dispatches, Mission Control now starts a fresh OpenClaw run on the existing routing key by prepending `/new` to the dispatch message. That clears stale task context between reruns without changing the stable session key.

On this machine, use a normal local projects root such as `/Users/jordan/Projects`. Do not run Mission Control builder workspaces from file-provider-managed roots like `~/Documents` if macOS has attached file-provider attributes there.

## Preferred API Calls

Agents and orchestrators should still call these APIs when possible. The runtime reconciliation path is only a fallback for visibility after a broken run.

### 1. Register Sub-Agent (when spawning a worker)

```bash
curl -X POST http://localhost:4000/api/tasks/{TASK_ID}/subagent \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "openclaw_session_id": "unique-session-id",
    "agent_name": "Designer"
  }'
```

This registers the sub-agent and increments the "Active Sub-Agents" counter.

### 2. Log Activity (for each significant action)

```bash
curl -X POST http://localhost:4000/api/tasks/{TASK_ID}/activities \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "activity_type": "updated",
    "message": "Started working on design mockups",
    "agent_id": "optional-agent-uuid"
  }'
```

Activity types:
- `spawned` - When sub-agent starts
- `updated` - Progress update
- `completed` - Work finished
- `file_created` - Created a deliverable
- `status_changed` - Task moved to new status

### 3. Register Deliverable (for each output file)

**IMPORTANT: You must CREATE THE FILE FIRST before registering it as a deliverable!**

```bash
# Step 1: Actually create the file
mkdir -p $PROJECTS_PATH/homepage
cat > $PROJECTS_PATH/homepage/index.html << 'EOF'
<!DOCTYPE html>
<html>
<head><title>Homepage</title></head>
<body><h1>Welcome</h1></body>
</html>
EOF

# Step 2: Register the deliverable (will warn if file doesn't exist)
curl -X POST http://localhost:4000/api/tasks/{TASK_ID}/deliverables \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "deliverable_type": "file",
    "title": "Homepage Design",
    "path": "$PROJECTS_PATH/homepage/index.html",
    "description": "Main homepage with responsive layout"
  }'
```

The API will return a `warning` field if the file doesn't exist:
```json
{
  "id": "...",
  "title": "Homepage Design",
  "warning": "File does not exist at path: $PROJECTS_PATH/homepage/index.html. Please create the file."
}
```

Deliverable types:
- `file` - Local file (must exist!)
- `url` - Web URL
- `artifact` - Other output

### 4. Update Task Status

```bash
curl -X PATCH http://localhost:4000/api/tasks/{TASK_ID} \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "status": "review",
    "updated_by_agent_id": "agent-uuid"
  }'
```

### 5. Send Explicit Completion Signal

When the task stage is actually complete, send the matching signal in the OpenClaw chat/session:

```text
TASK_COMPLETE: Implemented the validator and verified the new endpoints locally.
```

Other accepted signals:

```text
BLOCKED: Workspace deadlock | need: refreshed isolated workspace | meanwhile: confirmed repo access
TEST_PASS: Browser and API checks passed.
TEST_FAIL: Validator failed on malformed board configuration.
VERIFY_PASS: Review complete and ready to merge.
VERIFY_FAIL: Found regression in the Monday.com mapping flow.
```

## Complete Example Workflow

```bash
TASK_ID="abc-123"
BASE_URL="http://localhost:4000"
TOKEN="${MC_API_TOKEN:-your-token}"

# 1. Log that you're starting
curl -X POST $BASE_URL/api/tasks/$TASK_ID/activities \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"activity_type": "updated", "message": "Starting work on task"}'

# 2. Spawn a sub-agent
curl -X POST $BASE_URL/api/tasks/$TASK_ID/subagent \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"openclaw_session_id": "subagent-'$(date +%s)'", "agent_name": "Designer"}'

# 3. Sub-agent does work and creates file...
mkdir -p $PROJECTS_PATH/my-project
echo "<html><body>Hello World</body></html>" > $PROJECTS_PATH/my-project/output.html

# 4. Register the deliverable
curl -X POST $BASE_URL/api/tasks/$TASK_ID/deliverables \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "deliverable_type": "file",
    "title": "Completed Design",
    "path": "$PROJECTS_PATH/my-project/output.html",
    "description": "Final design with all requested features"
  }'

# 5. Log completion
curl -X POST $BASE_URL/api/tasks/$TASK_ID/activities \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"activity_type": "completed", "message": "Design completed successfully"}'

# 6. Report stage completion in the agent chat/session
# TASK_COMPLETE: Completed Design and verified responsive layout locally
```

## Runtime Evidence Fallback

If the agent run crashes or ends early, Mission Control now reconciles runtime evidence before serving:
- `GET /api/tasks/{id}/subagent`
- `GET /api/tasks/{id}/deliverables`
- `GET /api/tasks/{id}/agent-stream`

Fallback behavior:
- Child sessions can be recovered from the live OpenClaw session tree
- File deliverables can be recovered from the task's isolated workspace diff
- Agent Live returns `session_ended` when only terminal task sessions exist
- The task modal keeps Agent Live visible for assigned, active, and unreconciled-ended runs so that terminal state is not hidden
- Health checks suppress repeated zombie/stalled task activity once a run is already marked as an unreconciled ended run
- Released workspace ports can be reused safely; Mission Control now enforces uniqueness only for active allocations
- If isolated workspace creation fails during builder dispatch, Mission Control now records that as an explicit dispatch blocker instead of silently falling back to a non-isolated project path
- If a run ends before the live chat listener catches a terminal marker, Mission Control now uses the official gateway session history endpoint internally to recover a missed explicit marker or synthesize an explicit runtime blocker before falling back to the generic unreconciled-ended-run error

Current limitation:
- Historical transcript replay is still unsupported
- `GET /api/openclaw/sessions/{id}/history` returns `501`
- If the local machine points `PROJECTS_PATH` at a file-provider-managed root on macOS, builder dispatch will now fail fast with an explicit workspace-root error instead of trying to run from that path

## Debugging

Enable debug mode in browser console:
```javascript
mcDebug.enable()
```

Then refresh and watch for:
- `[SSE]` - Server-sent events
- `[STORE]` - Zustand state changes
- `[API]` - API calls
- `[FILE]` - File operations

## Endpoints Reference

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/tasks` | GET | List all tasks |
| `/api/tasks` | POST | Create task |
| `/api/tasks/{id}` | GET | Get task details |
| `/api/tasks/{id}` | PATCH | Update task |
| `/api/tasks/{id}/activities` | GET | List activities |
| `/api/tasks/{id}/activities` | POST | Log activity |
| `/api/tasks/{id}/deliverables` | GET | List deliverables |
| `/api/tasks/{id}/deliverables` | POST | Add deliverable |
| `/api/tasks/{id}/subagent` | GET | List sub-agents |
| `/api/tasks/{id}/subagent` | POST | Register sub-agent |
| `/api/openclaw/sessions` | GET | List all sessions |
| `/api/openclaw/sessions/{id}` | PATCH | Update session (mark complete) |
| `/api/openclaw/sessions/{id}` | DELETE | Delete a session |
| `/api/files/reveal` | POST | Open file in Finder |
| `/api/files/preview` | GET | Preview HTML file |
| `/api/files/upload` | POST | Upload file from remote agent |
| `/api/files/upload` | GET | Get upload endpoint info |
| `/api/files/download` | GET | Download file from server |

## Activity Body Schema

```json
{
  "activity_type": "spawned|updated|completed|file_created|status_changed",
  "message": "Human-readable description of what happened",
  "agent_id": "optional-uuid-of-agent",
  "metadata": { "optional": "additional data" }
}
```

## Deliverable Body Schema

```json
{
  "deliverable_type": "file|url|artifact",
  "title": "Display name for the deliverable",
  "path": "/full/path/to/file.html",
  "description": "Optional description"
}
```

## Sub-Agent Body Schema

```json
{
  "openclaw_session_id": "unique-identifier-for-session",
  "agent_name": "Designer|Developer|Researcher|Writer"
}
```

## File Upload Body Schema (for remote agents)

```json
{
  "relativePath": "project-name/filename.html",
  "content": "<!DOCTYPE html>...",
  "encoding": "utf-8"
}
```

The file will be saved at `$PROJECTS_PATH/{relativePath}`

## File Download Query Parameters (for remote agents)

```
GET /api/files/download?relativePath=project-name/filename.html
GET /api/files/download?path=$PROJECTS_PATH/project-name/filename.html
GET /api/files/download?relativePath=project-name/filename.html&raw=true
```

Query parameters:
- `relativePath` - Path relative to projects base (preferred)
- `path` - Full absolute path (must be under projects base)
- `raw` - If `true`, returns raw file content; otherwise returns JSON with metadata

JSON response includes: `success`, `path`, `relativePath`, `size`, `contentType`, `content`, `encoding`, `modifiedAt`

## Completing a Sub-Agent Session

When a sub-agent finishes its work, mark it as complete:

```bash
curl -X PATCH http://localhost:4000/api/openclaw/sessions/{SESSION_ID} \
  -H "Content-Type: application/json" \
  -d '{
    "status": "completed",
    "ended_at": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"
  }'
```

This updates the agent status to "idle" and broadcasts an `agent_completed` event.

## Deleting a Sub-Agent Session

To delete a stuck or unwanted session:

```bash
curl -X DELETE http://localhost:4000/api/openclaw/sessions/{SESSION_ID}
```

## SSE Events

The following events are broadcast to all connected clients:

- `task_created` - New task added
- `task_updated` - Task modified (including status changes)
- `activity_logged` - New activity logged
- `deliverable_added` - New deliverable registered
- `agent_spawned` - Sub-agent started
- `agent_completed` - Sub-agent finished
