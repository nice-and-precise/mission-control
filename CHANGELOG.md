# Changelog

All notable changes to Mission Control will be documented in this file.

## [Unreleased]

### Added - Real-Time Integration (2026-01-31)
- **Server-Sent Events (SSE)**: Real-time updates without page refresh
  - `/api/events/stream` endpoint for SSE connection
  - Auto-reconnection with 5-second retry
  - Broadcasts task updates, activities, deliverables, and agent events
- **Task Activities Tracking**: Complete activity log for each task
  - `task_activities` table with activity types: spawned, updated, completed, file_created, status_changed
  - `/api/tasks/[id]/activities` endpoints (GET/POST)
  - ActivityLog component with chronological timeline
- **Task Deliverables**: Track outputs and artifacts
  - `task_deliverables` table for files, URLs, and artifacts
  - `/api/tasks/[id]/deliverables` endpoints (GET/POST)
  - DeliverablesList component with file paths and descriptions
- **Sub-Agent Sessions**: Track spawned sub-agents per task
  - Enhanced `openclaw_sessions` table with `session_type` and `task_id`
  - `/api/tasks/[id]/subagent` endpoints (GET/POST)
  - SessionsList component showing active sub-agents
  - Active sub-agent counter in sidebar
- **Enhanced Task Modal**: Tabbed interface with Overview, Activity, Deliverables, and Sessions tabs
- **SSE Event Broadcasting**: All task/activity/deliverable changes broadcast to connected clients
- **useSSE Hook**: React hook for managing SSE connection lifecycle

### Changed
- Task updates now broadcast via SSE to all connected clients
- Task creation triggers real-time notification
- OpenClaw sessions API supports filtering by `session_type` and `status`
- TaskModal redesigned with wider layout and tabbed interface

### Technical Details
- SSE connection with keep-alive pings every 30 seconds
- All database operations broadcast events to SSE clients
- Activity metadata stored as JSON for extensibility
- Sub-agent sessions automatically linked to tasks
- Real-time agent counter polls every 10 seconds

### Previous Features
- **Task Auto-Dispatch**: Tasks automatically dispatch to agent's OpenClaw session when moved to ASSIGNED status
- **Agent Completion Detection**: Agents can report completion via TASK_COMPLETE message, auto-moves to REVIEW
- **Review Workflow Enforcement**: Only master agent (Charlie) can move tasks from REVIEW to DONE
- **Task Dispatch API** (`POST /api/tasks/[id]/dispatch`): Manually trigger task dispatch to agent
- **Agent Completion Webhook** (`POST /api/webhooks/agent-completion`): Receive completion notifications from agents

---

## [1.0.0] - 2026-01-31

### Initial Release
- Agent management with personality files (SOUL.md, USER.md, AGENTS.md)
- Mission Queue Kanban board (INBOX → ASSIGNED → IN PROGRESS → REVIEW → DONE)
- Agent-to-agent chat and conversations
- Live event feed
- OpenClaw Gateway WebSocket integration
- SQLite database with full schema
- Next.js 14 web interface
