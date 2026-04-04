import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, queryAll, run } from './db';
import { endActiveTaskSessions, repairActiveRootSessionAttachments } from './task-session-cleanup';

let testDbPath = '';

beforeEach(() => {
  closeDb();
  testDbPath = join(tmpdir(), `mission-control-task-session-cleanup-tests-${process.pid}-${crypto.randomUUID()}.sqlite`);
  process.env.DATABASE_PATH = testDbPath;
});

afterEach(() => {
  closeDb();
  if (!testDbPath) return;
  rmSync(testDbPath, { force: true });
  rmSync(`${testDbPath}-wal`, { force: true });
  rmSync(`${testDbPath}-shm`, { force: true });
});

test('endActiveTaskSessions ends and detaches active root sessions for the task and preserves existing ended_at values', () => {
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
    `INSERT INTO openclaw_sessions (id, openclaw_session_id, channel, status, session_type, task_id, active_task_id, ended_at, created_at, updated_at)
     VALUES
     (?, ?, 'mission-control', 'active', 'persistent', ?, ?, NULL, datetime('now'), datetime('now')),
     (?, ?, 'mission-control', 'active', 'persistent', ?, ?, NULL, datetime('now'), datetime('now')),
     (?, ?, 'mission-control', 'ended', 'persistent', ?, NULL, '2026-03-28T00:30:00.000Z', datetime('now'), datetime('now')),
     (?, ?, 'mission-control', 'active', 'persistent', ?, ?, NULL, datetime('now'), datetime('now')),
     (?, ?, 'mission-control', 'active', 'subagent', ?, NULL, NULL, datetime('now'), datetime('now'))`,
    [
      crypto.randomUUID(), `session-${crypto.randomUUID()}`, taskId, taskId,
      crypto.randomUUID(), `session-${crypto.randomUUID()}`, taskId, taskId,
      crypto.randomUUID(), `session-${crypto.randomUUID()}`, taskId,
      crypto.randomUUID(), `session-${crypto.randomUUID()}`, otherTaskId, otherTaskId,
      crypto.randomUUID(), `session-${crypto.randomUUID()}`, taskId,
    ],
  );

  endActiveTaskSessions(taskId, now);

  const sessions = queryAll<{ task_id: string | null; active_task_id: string | null; session_type: string; status: string; ended_at: string | null }>(
    `SELECT task_id, active_task_id, session_type, status, ended_at
     FROM openclaw_sessions
     ORDER BY task_id, session_type, status, ended_at`,
  );

  const taskRootSessions = sessions.filter((session) => session.task_id === taskId && session.session_type === 'persistent');
  assert.equal(taskRootSessions.length, 3);
  assert.equal(taskRootSessions.every((session) => session.status === 'ended'), true);
  assert.deepEqual(
    taskRootSessions.map((session) => session.ended_at),
    [
      '2026-03-28T00:30:00.000Z',
      now,
      now,
    ],
  );
  assert.equal(taskRootSessions.every((session) => session.active_task_id === null), true);

  const subagentSession = sessions.find((session) => session.task_id === taskId && session.session_type === 'subagent');
  assert.equal(subagentSession?.status, 'active');
  assert.equal(subagentSession?.active_task_id, null);

  const unrelatedSession = sessions.find((session) => session.task_id === otherTaskId);
  assert.equal(unrelatedSession?.status, 'active');
  assert.equal(unrelatedSession?.active_task_id, otherTaskId);
  assert.equal(unrelatedSession?.ended_at, null);
});

test('repairActiveRootSessionAttachments dry run reports stale attachment candidates without mutating rows', () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const builderId = crypto.randomUUID();
  const testerId = crypto.randomUUID();
  const taskId = crypto.randomUUID();

  run(
    `INSERT INTO workspaces (id, name, slug, created_at, updated_at)
     VALUES (?, 'Repair Workspace', ?, datetime('now'), datetime('now'))`,
    [workspaceId, workspaceId],
  );
  run(
    `INSERT INTO agents (id, workspace_id, name, role, status, source, created_at, updated_at)
     VALUES
     (?, ?, 'Builder Agent', 'builder', 'working', 'local', datetime('now'), datetime('now')),
     (?, ?, 'Tester Agent', 'tester', 'working', 'local', datetime('now'), datetime('now'))`,
    [builderId, workspaceId, testerId, workspaceId],
  );
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, assigned_agent_id, created_at, updated_at)
     VALUES (?, 'Repair task', 'testing', 'normal', ?, 'default', ?, datetime('now'), datetime('now'))`,
    [taskId, workspaceId, testerId],
  );
  run(
    `INSERT INTO openclaw_sessions (id, agent_id, openclaw_session_id, channel, status, session_type, task_id, active_task_id, created_at, updated_at)
     VALUES
     (?, ?, 'builder-live', 'mission-control', 'active', 'persistent', ?, NULL, datetime('now'), datetime('now')),
     (?, ?, 'subagent-ignored', 'mission-control', 'active', 'subagent', ?, NULL, datetime('now'), datetime('now'))`,
    [
      crypto.randomUUID(), builderId, taskId,
      crypto.randomUUID(), builderId, taskId,
    ],
  );

  const summary = repairActiveRootSessionAttachments('2026-04-04T07:10:00.000Z', { dryRun: true });

  assert.equal(summary.dryRun, true);
  assert.equal(summary.scannedActiveRootSessions, 1);
  assert.equal(summary.missingActiveTaskPointer, 1);
  assert.equal(summary.missingAttachedTask, 0);
  assert.equal(summary.ownerMismatchAttachment, 0);
  assert.equal(summary.backfilledActiveTaskPointer, 0);
  assert.equal(summary.detachedStaleAttachments, 0);

  const untouched = queryAll<{ status: string; active_task_id: string | null; session_type: string }>(
    `SELECT status, active_task_id, session_type
     FROM openclaw_sessions
     ORDER BY openclaw_session_id`,
  );
  assert.equal(untouched.filter((session) => session.session_type === 'persistent' && session.status === 'active').length, 1);
});

test('repairActiveRootSessionAttachments backfills missing pointer and detaches stale root attachments', () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const builderId = crypto.randomUUID();
  const testerId = crypto.randomUUID();
  const healthyTaskId = crypto.randomUUID();
  const mismatchTaskId = crypto.randomUUID();
  const doneTaskId = crypto.randomUUID();
  const now = '2026-04-04T07:12:00.000Z';

  run(
    `INSERT INTO workspaces (id, name, slug, created_at, updated_at)
     VALUES (?, 'Repair Apply Workspace', ?, datetime('now'), datetime('now'))`,
    [workspaceId, workspaceId],
  );
  run(
    `INSERT INTO agents (id, workspace_id, name, role, status, source, created_at, updated_at)
     VALUES
     (?, ?, 'Builder Agent', 'builder', 'working', 'local', datetime('now'), datetime('now')),
     (?, ?, 'Tester Agent', 'tester', 'working', 'local', datetime('now'), datetime('now'))`,
    [builderId, workspaceId, testerId, workspaceId],
  );
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, assigned_agent_id, created_at, updated_at)
     VALUES
     (?, 'Healthy task', 'in_progress', 'normal', ?, 'default', ?, datetime('now'), datetime('now')),
     (?, 'Mismatch task', 'testing', 'normal', ?, 'default', ?, datetime('now'), datetime('now')),
     (?, 'Done task', 'done', 'normal', ?, 'default', ?, datetime('now'), datetime('now'))`,
    [healthyTaskId, workspaceId, builderId, mismatchTaskId, workspaceId, testerId, doneTaskId, workspaceId, builderId],
  );
  run(
    `INSERT INTO openclaw_sessions (id, agent_id, openclaw_session_id, channel, status, session_type, task_id, active_task_id, created_at, updated_at)
     VALUES
     (?, ?, 'healthy-root', 'mission-control', 'active', 'persistent', ?, NULL, datetime('now'), datetime('now')),
     (?, ?, 'mismatch-root', 'mission-control', 'active', 'persistent', ?, ?, datetime('now'), datetime('now')),
     (?, ?, 'done-root', 'mission-control', 'active', 'persistent', ?, ?, datetime('now'), datetime('now')),
     (?, ?, 'subagent-kept', 'mission-control', 'active', 'subagent', ?, NULL, datetime('now'), datetime('now'))`,
    [
      crypto.randomUUID(), builderId, healthyTaskId,
      crypto.randomUUID(), builderId, mismatchTaskId, mismatchTaskId,
      crypto.randomUUID(), builderId, doneTaskId, doneTaskId,
      crypto.randomUUID(), builderId, mismatchTaskId,
    ],
  );

  const summary = repairActiveRootSessionAttachments(now, { dryRun: false });
  assert.equal(summary.dryRun, false);
  assert.equal(summary.backfilledActiveTaskPointer, 1);
  assert.equal(summary.detachedStaleAttachments, 2);

  const sessions = queryAll<{ openclaw_session_id: string; status: string; active_task_id: string | null; ended_at: string | null; session_type: string }>(
    `SELECT openclaw_session_id, status, active_task_id, ended_at, session_type
     FROM openclaw_sessions
     ORDER BY openclaw_session_id`,
  );

  const healthy = sessions.find((session) => session.openclaw_session_id === 'healthy-root');
  const mismatch = sessions.find((session) => session.openclaw_session_id === 'mismatch-root');
  const done = sessions.find((session) => session.openclaw_session_id === 'done-root');
  const subagent = sessions.find((session) => session.openclaw_session_id === 'subagent-kept');

  assert.equal(healthy?.status, 'active');
  assert.equal(healthy?.active_task_id, healthyTaskId);
  assert.equal(healthy?.ended_at, null);

  assert.equal(mismatch?.status, 'ended');
  assert.equal(mismatch?.active_task_id, null);
  assert.equal(mismatch?.ended_at, now);

  assert.equal(done?.status, 'ended');
  assert.equal(done?.active_task_id, null);
  assert.equal(done?.ended_at, now);

  assert.equal(subagent?.session_type, 'subagent');
  assert.equal(subagent?.status, 'active');
  assert.equal(subagent?.active_task_id, null);
});
