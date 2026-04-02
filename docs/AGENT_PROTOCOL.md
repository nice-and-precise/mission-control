# Agent Protocol

This document describes how OpenClaw agents interact with Mission Control.

> [!NOTE]
> This is an active protocol guide, not the canonical local-status page. For the verified behavior of this local checkout, see [CURRENT_LOCAL_STATUS.md](CURRENT_LOCAL_STATUS.md).

## Task Assignment Flow

1. **Human assigns task** in Mission Control UI
   - Drag task card to agent in "ASSIGNED" column
   - System auto-dispatches to agent's OpenClaw session

2. **Agent receives task notification**
   ```
   🔵 **NEW TASK ASSIGNED**
   
   **Title:** Build authentication system
   **Description:** Implement JWT-based auth with refresh tokens
   **Priority:** HIGH
   **Due:** 2026-02-05
   **Task ID:** abc-123-def
   
   Please work on this task. When complete, reply with:
   `TASK_COMPLETE: [brief summary of what you did]`
   
   If you need help or clarification, ask me (the orchestrator).
   ```

3. **Agent works on task**
   - Builder-owned work automatically moves through `ASSIGNED -> IN PROGRESS`
   - Agent status updates to "working"
   - Agent can ask the orchestrator for help via normal conversation

4. **Agent completes task**
   - Agent replies with completion message:
     ```
     TASK_COMPLETE: Built JWT authentication system with access/refresh tokens,
     middleware for protected routes, and secure token storage.
     ```
   - Task automatically advances to the next workflow stage
   - Agent status returns to "standby"

5. **Verification / approval happens**
   - In the strict workflow, `assigned` and `in_progress` are builder-owned, `testing` is tester-owned, `review` is a queue stage, and `verification` is owned by the `reviewer` role
   - Builder work is sequential per agent: `assigned` means the builder owns the next task in queue, while `in_progress` means that builder is the one actively running right now
   - The verifier checks task evidence in Mission Control (Activities, Deliverables, Sessions, Agent Live) plus the actual workspace/code
   - If approved in `verification`: the assigned reviewer emits `VERIFY_PASS` and may PATCH the task to `done`
   - If the work needs changes: the verifier emits `VERIFY_FAIL` and routes it back through the workflow fail target
   - Legacy direct `review -> done` approval remains a master-agent decision

## Completion Message Format

```
TASK_COMPLETE: [concise summary of what you accomplished]
```

Include receipts when possible:

```
TASK_COMPLETE: <summary> | deliverables: <paths/links> | verification: <how you verified>
```

Additional accepted workflow markers:

```text
BLOCKED: <what is blocked> | need: <specific input> | meanwhile: <fallback work>
TEST_PASS: <concise testing summary>
TEST_FAIL: <what failed>
VERIFY_PASS: <review/verification summary>
VERIFY_FAIL: <what still blocks approval>
```

## Progress Updates (to prevent work from stalling)

Agents should post periodic progress so the orchestrator can unblock quickly.

Format:

```
PROGRESS_UPDATE: <what changed> | next: <next step> | eta: <time>
```

## Blockers (explicit + parallel fallback)

If you are blocked, don’t wait silently.

Format:

```
BLOCKED: <what is blocked> | need: <specific input> | meanwhile: <fallback work>
```

Rule: ask the question **and** start the best available next step.

**Examples:**

✅ Good:
```
TASK_COMPLETE: Refactored authentication module to use async/await,
added unit tests, and updated documentation.
```

✅ Good:
```
TASK_COMPLETE: Researched 5 competitor pricing models, compiled findings
in pricing-analysis.md with recommendations.
```

❌ Bad (too vague):
```
TASK_COMPLETE: Done
```

❌ Bad (missing prefix):
```
I finished the task successfully!
```

## Getting Help

If you're stuck or need clarification:

1. **Ask the orchestrator directly** in your session
   ```
   @the orchestrator - Question about the authentication task: Should we support
   OAuth providers or just email/password for now?
   ```

2. **Request collaboration** with another agent
   ```
   @the orchestrator - I need help from Design agent to create the login UI.
   Can you coordinate?
   ```

3. **Report blockers**
   ```
   @the orchestrator - Blocked on this task: Missing API credentials for the
   third-party service. Can you provide?
   ```

## Session Management

### Agent Sessions
- Each agent has a persistent OpenClaw session
- Session ID format: `mission-control-{agent-name}`
  - Example: `mission-control-engineering`
  - Example: `mission-control-writing`
- Mission Control starts fresh reruns by prepending `/new` on the same stable routing key
- A healthy rerun normally keeps the same `sessionKey` and creates a new `sessionId`

### Session Linking
- Agents are automatically linked to OpenClaw when first task is assigned
- Session remains active for future tasks
- the orchestrator can manually link/unlink agents via Mission Control UI

## Status Transitions

### Task Statuses
- **INBOX**: Unassigned, awaiting triage
- **ASSIGNED**: Builder-owned staging state before active work begins; queued work waits here until that builder is free
- **IN PROGRESS**: Builder actively working; one builder should only have one active `in_progress` task at a time
- **TESTING**: Tester-owned quality gate
- **REVIEW**: Queue stage between testing and verification in the strict workflow
- **VERIFICATION**: Reviewer/verifier is actively evaluating whether the task is ready to ship
- **DONE**: Approved and closed

Mission Control rejects invalid manual workflow combinations with `409` instead of silently dispatching them:

- `inbox -> in_progress`
- `in_progress` explicitly assigned to a tester/reviewer
- `testing` explicitly assigned to a builder/reviewer
- `verification` explicitly assigned to a builder/tester

### Agent Statuses
- **standby**: Available for work
- **working**: Currently running a task
- **offline**: Not connected to OpenClaw

## API Integration

Mission Control treats explicit workflow markers as the source of truth for stage transitions.

Preferred behavior during a healthy run:
1. **Receive tasks** via OpenClaw session message
2. **Register activities/deliverables/sub-agent sessions** through Mission Control APIs when your runtime supports it
3. **Report the terminal stage outcome** via `TASK_COMPLETE`, `BLOCKED`, `TEST_PASS`, `TEST_FAIL`, `VERIFY_PASS`, or `VERIFY_FAIL`
4. **Ask questions** via normal conversation with the orchestrator

If `MC_API_TOKEN` is configured, direct API requests to Mission Control must include `Authorization: Bearer <token>`.

Mission Control now has a fallback runtime-evidence reconciler for visibility:
- Sessions can be recovered from the live OpenClaw session tree
- Deliverables can be recovered from the isolated workspace diff
- Agent Live can report `session_ended` even when no active session remains
- Repeated zombie/stalled activity spam is suppressed once the task is already marked as an unreconciled ended run

Mission Control also has an ended-run transcript fallback for closeout:
- it uses the official gateway session history endpoint internally
- it can recover a missed explicit workflow marker after the live listener missed it
- it can synthesize `BLOCKED: OpenClaw runtime failure: ...` when a run ended on a terminal runtime/provider error before any explicit marker was emitted

Recovered Sessions / Deliverables / Agent Live evidence alone still does not move the task through the workflow.
Explicit or transcript-recovered `TASK_COMPLETE`, `BLOCKED`, `TEST_PASS`, `TEST_FAIL`, `VERIFY_PASS`, and `VERIFY_FAIL` outcomes do.

For repo-backed tasks, treat the task workspace, registered file deliverables, and the PR URL as the testing/review contract.
Do not fail a repo-backed handoff solely because the root output directory is empty when those repo artifacts exist.

For repo-backed file inspection:

- shell commands should use `cd <workspace> && ...`
- non-shell file tools such as `read`, `edit`, `find`, `glob`, and file-path `ls` should use absolute paths under the task workspace
- if a deliverable is listed with an absolute path, copy that exact path instead of switching to a bare repo-relative path

Current limitation:
- `GET /api/openclaw/sessions/{id}/history` is now available as a read-only transcript surface, but bounded OpenClaw history can omit oversized entries
- Treat Activities, Deliverables, Sessions, Agent Live, and explicit workflow markers as the primary operational truth; use transcript history as supporting evidence

## The orchestrator's Responsibilities

As master orchestrator, the orchestrator:

- **Triages incoming tasks** from humans
- **Assigns work** to appropriate specialist agents
- **Monitors progress** via session activity
- **Reviews completed work** before marking done
- **Coordinates collaboration** when multiple agents needed
- **Provides guidance** when agents are stuck
- **Enforces quality standards**

Only the orchestrator (master agent with `is_master = 1`) can approve legacy direct `review -> done` transitions.
For the strict workflow, the assigned `reviewer` role may complete `verification -> done`, and a master agent may also approve that transition.

## Error Handling

### If task dispatch fails:
- Check agent's OpenClaw session is active
- Verify Gateway connection
- Try manual dispatch via API
- On macOS, verify `PROJECTS_PATH` is not inside a file-provider-managed root such as a managed `~/Documents` tree

### If completion not detected:
- Ensure message format exactly matches one of the accepted workflow markers
- Check agent session is linked correctly
- Check whether the task fell back to `planning_dispatch_error = "Run ended without completion callback or workflow handoff ..."` or was reconciled into an explicit blocker from gateway history
- Review the recovered Activities / Deliverables / Sessions / Agent Live evidence
- Manually move task via UI only after reviewing the recovered evidence

### If a rerun replays stale blocker context:
- Mission Control dispatch now starts a fresh OpenClaw run with `/new` on the existing routing key
- Confirm the latest dispatch created a fresh gateway `sessionId` on the same `sessionKey`
- If stale blocker text still appears immediately, treat it as a new bug in the dispatch/session path rather than an expected behavior

### If stuck in verification:
- verify the reviewer task actually launched and linked to the task
- confirm the verifier dispatch includes `updated_by_agent_id` in the PATCH example
- if the reviewer emitted `VERIFY_PASS` but the task still shows the generic unreconciled error, refresh the workspace or hit `GET /api/openclaw/status` first; that route now retries transcript-based closeout immediately
- if the status poll does not recover it, then run the health sweep as the fallback retry path
- only fall back to manual approval for legacy direct `review -> done` flows

## Example Workflow

```
[Human] Creates task: "Write blog post about AI agents"
         ↓
[System] Auto-assigns to Writing agent
         ↓
[Writing] Receives notification in OpenClaw session
         ↓
[Writing] Works on blog post, saves to docs/blog/ai-agents.md
         ↓
[Writing] Replies: "TASK_COMPLETE: Wrote 1500-word blog post about
          AI agents with examples and best practices."
         ↓
[System] Auto-moves to REVIEW
         ↓
[the orchestrator] Reviews docs/blog/ai-agents.md
         ↓
[the orchestrator] Approves → moves to DONE
         ↓
[Human] Publishes blog post
```

## Best Practices

1. **Be specific in completion summaries** - help the orchestrator review faster
2. **Ask for help early** - don't spin wheels, ping the orchestrator
3. **Document your work** - leave breadcrumbs for review
4. **One task at a time** - focus before moving to next
   Builder agents are serialized. If a second builder card is approved while the builder is already executing, it stays `assigned` and automatically starts only after the current build leaves the builder stage.
5. **Update progress** - if task will take a while, check in with the orchestrator

## Future Enhancements

Planned features:
- Progress updates (25%, 50%, 75% complete)
- Task dependencies (Task B requires Task A)
- Subtask breakdown
- Time tracking
- Quality metrics
