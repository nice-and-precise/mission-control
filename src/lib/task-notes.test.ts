import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, run } from './db';
import { getActiveSessionForTask } from './task-notes';

afterEach(() => {
  closeDb();
});

test('getActiveSessionForTask targets the tester session after builder handoff', () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const taskId = crypto.randomUUID();
  const builderId = crypto.randomUUID();
  const testerId = crypto.randomUUID();

  run(
    `INSERT INTO workspaces (id, name, slug, created_at, updated_at)
     VALUES (?, 'Notes Workspace', ?, datetime('now'), datetime('now'))`,
    [workspaceId, workspaceId],
  );
  run(
    `INSERT INTO agents (id, workspace_id, name, role, status, source, session_key_prefix, created_at, updated_at)
     VALUES
     (?, ?, 'Builder Agent', 'builder', 'working', 'local', 'agent:builder:', datetime('now'), datetime('now')),
     (?, ?, 'Tester Agent', 'tester', 'working', 'local', 'agent:tester:', datetime('now'), datetime('now'))`,
    [builderId, workspaceId, testerId, workspaceId],
  );
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, assigned_agent_id, created_at, updated_at)
     VALUES (?, 'Notes handoff task', 'testing', 'normal', ?, 'default', ?, datetime('now'), datetime('now'))`,
    [taskId, workspaceId, testerId],
  );
  run(
    `INSERT INTO openclaw_sessions
      (id, agent_id, openclaw_session_id, channel, status, task_id, active_task_id, created_at, updated_at)
     VALUES
      (?, ?, 'builder-root', 'mission-control', 'active', ?, NULL, datetime('now'), datetime('now')),
      (?, ?, 'tester-root', 'mission-control', 'active', ?, ?, datetime('now'), datetime('now'))`,
    [crypto.randomUUID(), builderId, taskId, crypto.randomUUID(), testerId, taskId, taskId],
  );

  const active = getActiveSessionForTask(taskId);

  assert.equal(active?.session.agent_id, testerId);
  assert.equal(active?.session.openclaw_session_id, 'tester-root');
});
