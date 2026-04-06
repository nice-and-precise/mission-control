import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, queryOne, run } from './db';
import { repairSuccessfulTaskRunErrors } from './task-run-error-repair';

let testDbPath = '';

beforeEach(() => {
  closeDb();
  testDbPath = join(tmpdir(), `mission-control-task-run-error-repair-${process.pid}-${crypto.randomUUID()}.sqlite`);
  process.env.DATABASE_PATH = testDbPath;
});

afterEach(() => {
  closeDb();
  if (!testDbPath) return;
  rmSync(testDbPath, { force: true });
  rmSync(`${testDbPath}-wal`, { force: true });
  rmSync(`${testDbPath}-shm`, { force: true });
});

test('repairSuccessfulTaskRunErrors dry run reports stale generic run errors without mutating rows', () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const doneTaskId = crypto.randomUUID();
  const doneStatusReasonId = crypto.randomUUID();
  const cleanDoneTaskId = crypto.randomUUID();
  const activeTaskId = crypto.randomUUID();

  run(
    `INSERT INTO workspaces (id, name, slug, created_at, updated_at)
     VALUES (?, 'Repair Workspace', ?, datetime('now'), datetime('now'))`,
    [workspaceId, workspaceId],
  );
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, planning_dispatch_error, status_reason, created_at, updated_at)
     VALUES
     (?, 'Done with dispatch error', 'done', 'normal', ?, 'default', 'Run ended without completion callback or workflow handoff (completed session).', NULL, datetime('now'), datetime('now')),
     (?, 'Done with status reason', 'done', 'normal', ?, 'default', NULL, 'Run ended without completion callback or workflow handoff (ended session).', datetime('now'), datetime('now')),
     (?, 'Clean done task', 'done', 'normal', ?, 'default', NULL, NULL, datetime('now'), datetime('now')),
     (?, 'Active task', 'verification', 'normal', ?, 'default', 'Run ended without completion callback or workflow handoff (ended session).', 'Run ended without completion callback or workflow handoff (ended session).', datetime('now'), datetime('now'))`,
    [doneTaskId, workspaceId, doneStatusReasonId, workspaceId, cleanDoneTaskId, workspaceId, activeTaskId, workspaceId],
  );

  const summary = repairSuccessfulTaskRunErrors('2026-04-05T22:20:00.000Z', {
    dryRun: true,
    workspaceId,
  });

  assert.equal(summary.dryRun, true);
  assert.equal(summary.workspaceId, workspaceId);
  assert.equal(summary.scannedSuccessfulTasks, 3);
  assert.equal(summary.staleSuccessfulTasks, 2);
  assert.equal(summary.clearedPlanningDispatchError, 1);
  assert.equal(summary.clearedStatusReason, 1);
  assert.deepEqual([...summary.repairedTaskIds].sort(), [doneStatusReasonId, doneTaskId].sort());

  const doneTask = queryOne<{ planning_dispatch_error: string | null; status_reason: string | null }>(
    'SELECT planning_dispatch_error, status_reason FROM tasks WHERE id = ?',
    [doneTaskId],
  );
  assert.match(doneTask?.planning_dispatch_error || '', /Run ended without completion callback/);
  assert.equal(doneTask?.status_reason, null);
});

test('repairSuccessfulTaskRunErrors clears only generic unreconciled fields for done tasks', () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const doneTaskId = crypto.randomUUID();
  const mixedTaskId = crypto.randomUUID();
  const activeTaskId = crypto.randomUUID();
  const now = '2026-04-05T22:21:00.000Z';

  run(
    `INSERT INTO workspaces (id, name, slug, created_at, updated_at)
     VALUES (?, 'Repair Apply Workspace', ?, datetime('now'), datetime('now'))`,
    [workspaceId, workspaceId],
  );
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, planning_dispatch_error, status_reason, created_at, updated_at)
     VALUES
     (?, 'Done with both fields', 'done', 'normal', ?, 'default', 'Run ended without completion callback or workflow handoff (completed session).', 'Run ended without completion callback or workflow handoff (completed session).', datetime('now'), datetime('now')),
     (?, 'Done with mixed fields', 'done', 'normal', ?, 'default', 'Run ended without completion callback or workflow handoff (ended session).', 'Completed successfully after manual review', datetime('now'), datetime('now')),
     (?, 'Non-terminal task', 'review', 'normal', ?, 'default', 'Run ended without completion callback or workflow handoff (ended session).', 'Run ended without completion callback or workflow handoff (ended session).', datetime('now'), datetime('now'))`,
    [doneTaskId, workspaceId, mixedTaskId, workspaceId, activeTaskId, workspaceId],
  );

  const summary = repairSuccessfulTaskRunErrors(now, { dryRun: false, workspaceId });
  assert.equal(summary.dryRun, false);
  assert.equal(summary.workspaceId, workspaceId);
  assert.equal(summary.scannedSuccessfulTasks, 2);
  assert.equal(summary.staleSuccessfulTasks, 2);
  assert.equal(summary.clearedPlanningDispatchError, 2);
  assert.equal(summary.clearedStatusReason, 1);
  assert.deepEqual([...summary.repairedTaskIds].sort(), [mixedTaskId, doneTaskId].sort());

  const doneTask = queryOne<{ planning_dispatch_error: string | null; status_reason: string | null; updated_at: string | null }>(
    'SELECT planning_dispatch_error, status_reason, updated_at FROM tasks WHERE id = ?',
    [doneTaskId],
  );
  assert.equal(doneTask?.planning_dispatch_error, null);
  assert.equal(doneTask?.status_reason, null);
  assert.equal(doneTask?.updated_at, now);

  const mixedTask = queryOne<{ planning_dispatch_error: string | null; status_reason: string | null }>(
    'SELECT planning_dispatch_error, status_reason FROM tasks WHERE id = ?',
    [mixedTaskId],
  );
  assert.equal(mixedTask?.planning_dispatch_error, null);
  assert.equal(mixedTask?.status_reason, 'Completed successfully after manual review');

  const activeTask = queryOne<{ planning_dispatch_error: string | null; status_reason: string | null }>(
    'SELECT planning_dispatch_error, status_reason FROM tasks WHERE id = ?',
    [activeTaskId],
  );
  assert.match(activeTask?.planning_dispatch_error || '', /Run ended without completion callback/);
  assert.match(activeTask?.status_reason || '', /Run ended without completion callback/);
});
