import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, queryAll, run } from './db';
import { endActiveTaskSessions } from './task-session-cleanup';

afterEach(() => {
  closeDb();
});

test('endActiveTaskSessions ends every active session row for the task and preserves existing ended_at values', () => {
  const taskId = crypto.randomUUID();
  const otherTaskId = crypto.randomUUID();
  const workspaceId = 'default';
  const now = '2026-03-28T00:40:00.000Z';

  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, created_at, updated_at)
     VALUES
     (?, 'Task A', 'verification', 'normal', ?, 'default', datetime('now'), datetime('now')),
     (?, 'Task B', 'verification', 'normal', ?, 'default', datetime('now'), datetime('now'))`,
    [taskId, workspaceId, otherTaskId, workspaceId],
  );

  run(
    `INSERT INTO openclaw_sessions (id, openclaw_session_id, channel, status, task_id, ended_at, created_at, updated_at)
     VALUES
     (?, ?, 'mission-control', 'active', ?, NULL, datetime('now'), datetime('now')),
     (?, ?, 'mission-control', 'active', ?, NULL, datetime('now'), datetime('now')),
     (?, ?, 'mission-control', 'ended', ?, '2026-03-28T00:30:00.000Z', datetime('now'), datetime('now')),
     (?, ?, 'mission-control', 'active', ?, NULL, datetime('now'), datetime('now'))`,
    [
      crypto.randomUUID(), `session-${crypto.randomUUID()}`, taskId,
      crypto.randomUUID(), `session-${crypto.randomUUID()}`, taskId,
      crypto.randomUUID(), `session-${crypto.randomUUID()}`, taskId,
      crypto.randomUUID(), `session-${crypto.randomUUID()}`, otherTaskId,
    ],
  );

  endActiveTaskSessions(taskId, now);

  const sessions = queryAll<{ task_id: string | null; status: string; ended_at: string | null }>(
    `SELECT task_id, status, ended_at
     FROM openclaw_sessions
     ORDER BY task_id, status, ended_at`,
  );

  const taskSessions = sessions.filter((session) => session.task_id === taskId);
  assert.equal(taskSessions.length, 3);
  assert.equal(taskSessions.every((session) => session.status === 'ended'), true);
  assert.deepEqual(
    taskSessions.map((session) => session.ended_at),
    [
      '2026-03-28T00:30:00.000Z',
      now,
      now,
    ],
  );

  const unrelatedSession = sessions.find((session) => session.task_id === otherTaskId);
  assert.equal(unrelatedSession?.status, 'active');
  assert.equal(unrelatedSession?.ended_at, null);
});
