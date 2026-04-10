import test from 'node:test';
import assert from 'node:assert/strict';
import { run, queryOne } from './db';
import {
  hasStageEvidence,
  taskCanBeDone,
  ensureFixerExists,
  getFailureCountInStage,
  pickDynamicAgent,
} from './task-governance';

function ensureWorkspace(id: string) {
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at, updated_at)
     VALUES (?, ?, ?, datetime('now'), datetime('now'))`,
    [id, `Workspace ${id}`, id]
  );
}

function seedTask(id: string, workspace = 'default') {
  ensureWorkspace(workspace);
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, created_at, updated_at)
     VALUES (?, 'T', 'review', 'normal', ?, 'default', datetime('now'), datetime('now'))`,
    [id, workspace]
  );
}

function seedAgent({
  id,
  workspace = 'default',
  name,
  role,
  status = 'standby',
  scope = 'workspace',
}: {
  id: string;
  workspace?: string;
  name: string;
  role: string;
  status?: string;
  scope?: 'workspace' | 'task';
}) {
  ensureWorkspace(workspace);
  run(
    `INSERT INTO agents (id, workspace_id, name, role, status, source, scope, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'local', ?, datetime('now'), datetime('now'))`,
    [id, workspace, name, role, status, scope]
  );
}

test('evidence gate requires deliverable + activity', () => {
  const taskId = crypto.randomUUID();
  seedTask(taskId);

  assert.equal(hasStageEvidence(taskId), false);

  run(
    `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, created_at)
     VALUES (lower(hex(randomblob(16))), ?, 'file', 'index.html', datetime('now'))`,
    [taskId]
  );
  assert.equal(hasStageEvidence(taskId), false);

  run(
    `INSERT INTO task_activities (id, task_id, activity_type, message, created_at)
     VALUES (lower(hex(randomblob(16))), ?, 'completed', 'did thing', datetime('now'))`,
    [taskId]
  );

  assert.equal(hasStageEvidence(taskId), true);
});

test('task cannot be done when status_reason indicates failure', () => {
  const taskId = crypto.randomUUID();
  seedTask(taskId);

  run(`UPDATE tasks SET status_reason = 'Validation failed: CSS broken' WHERE id = ?`, [taskId]);
  run(
    `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, created_at)
     VALUES (lower(hex(randomblob(16))), ?, 'file', 'index.html', datetime('now'))`,
    [taskId]
  );
  run(
    `INSERT INTO task_activities (id, task_id, activity_type, message, created_at)
     VALUES (lower(hex(randomblob(16))), ?, 'completed', 'did thing', datetime('now'))`,
    [taskId]
  );

  assert.equal(taskCanBeDone(taskId), false);
});

test('ensureFixerExists returns null when no fixer agent exists', () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  ensureWorkspace(workspaceId);
  const result = ensureFixerExists(workspaceId);
  assert.equal(result, null);
});

test('ensureFixerExists returns a pre-seeded fixer agent when one exists', () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const fixerId = crypto.randomUUID();
  seedAgent({ id: fixerId, workspace: workspaceId, name: 'Senior Fixer', role: 'fixer' });
  const result = ensureFixerExists(workspaceId);
  assert.ok(result);
  assert.equal(result?.id, fixerId);
  assert.equal(result?.name, 'Senior Fixer');
});

test('escalateFailureIfNeeded logs governance_warning when no fixer is configured', async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const taskId = crypto.randomUUID();
  const assignedId = crypto.randomUUID();
  seedTask(taskId, workspaceId);
  seedAgent({ id: assignedId, workspace: workspaceId, name: 'Builder', role: 'builder' });
  run(`UPDATE tasks SET assigned_agent_id = ? WHERE id = ?`, [assignedId, taskId]);

  // Seed 2 stage failure activities to cross the threshold
  run(
    `INSERT INTO task_activities (id, task_id, activity_type, message, created_at)
     VALUES (lower(hex(randomblob(16))), ?, 'status_changed', 'Stage failed: testing', datetime('now'))`,
    [taskId]
  );
  run(
    `INSERT INTO task_activities (id, task_id, activity_type, message, created_at)
     VALUES (lower(hex(randomblob(16))), ?, 'status_changed', 'Stage failed: testing', datetime('now'))`,
    [taskId]
  );

  const { escalateFailureIfNeeded: escalate } = await import('./task-governance');
  await escalate(taskId, 'testing');

  // Task should NOT have been reassigned
  const task = queryOne<{ assigned_agent_id: string }>('SELECT assigned_agent_id FROM tasks WHERE id = ?', [taskId]);
  assert.equal(task?.assigned_agent_id, assignedId);

  // A governance_warning activity should have been inserted
  const warning = queryOne<{ activity_type: string; message: string }>(
    `SELECT activity_type, message FROM task_activities WHERE task_id = ? AND activity_type = 'governance_warning'`,
    [taskId]
  );
  assert.ok(warning, 'governance_warning activity should have been inserted');
  assert.ok(warning?.message.includes('testing'), 'warning message should mention the stage');
});

test('failure counter reads status_changed failure events', () => {
  const taskId = crypto.randomUUID();
  seedTask(taskId);

  run(
    `INSERT INTO task_activities (id, task_id, activity_type, message, created_at)
     VALUES (lower(hex(randomblob(16))), ?, 'status_changed', 'Stage failed: verification → in_progress (reason: x)', datetime('now'))`,
    [taskId]
  );
  run(
    `INSERT INTO task_activities (id, task_id, activity_type, message, created_at)
     VALUES (lower(hex(randomblob(16))), ?, 'status_changed', 'Stage failed: verification → in_progress (reason: y)', datetime('now'))`,
    [taskId]
  );

  assert.equal(getFailureCountInStage(taskId, 'verification'), 2);
});

test('pickDynamicAgent prefers the task assigned agent before role lookup', () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const taskId = crypto.randomUUID();
  const assignedAgentId = crypto.randomUUID();
  const builderAgentId = crypto.randomUUID();

  seedTask(taskId, workspaceId);
  seedAgent({ id: assignedAgentId, workspace: workspaceId, name: 'Assigned', role: 'reviewer' });
  seedAgent({ id: builderAgentId, workspace: workspaceId, name: 'Builder', role: 'builder' });
  run(`UPDATE tasks SET assigned_agent_id = ? WHERE id = ?`, [assignedAgentId, taskId]);

  const picked = pickDynamicAgent(taskId, 'builder');
  assert.deepEqual(picked, { id: assignedAgentId, name: 'Assigned' });
});

test('pickDynamicAgent uses exact workspace role matches and ignores task-scoped planner agents', () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const taskId = crypto.randomUUID();
  const taskScopedBuilderId = crypto.randomUUID();
  const workspaceBuilderId = crypto.randomUUID();

  seedTask(taskId, workspaceId);
  seedAgent({ id: taskScopedBuilderId, workspace: workspaceId, name: 'Planner Builder', role: 'builder', scope: 'task' });
  seedAgent({ id: workspaceBuilderId, workspace: workspaceId, name: 'Workspace Builder', role: 'builder' });

  const picked = pickDynamicAgent(taskId, 'builder');
  assert.deepEqual(picked, { id: workspaceBuilderId, name: 'Workspace Builder' });
});

test('pickDynamicAgent prefers the least-loaded workspace agent for a shared role', () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const taskId = crypto.randomUUID();
  const busyBuilderId = crypto.randomUUID();
  const idleBuilderId = crypto.randomUUID();
  const busyTaskId = crypto.randomUUID();

  seedTask(taskId, workspaceId);
  seedTask(busyTaskId, workspaceId);
  seedAgent({ id: busyBuilderId, workspace: workspaceId, name: 'Builder Agent', role: 'builder', status: 'working' });
  seedAgent({ id: idleBuilderId, workspace: workspaceId, name: 'Builder Agent 2', role: 'builder', status: 'standby' });
  run(`UPDATE tasks SET status = 'in_progress', assigned_agent_id = ? WHERE id = ?`, [busyBuilderId, busyTaskId]);

  const picked = pickDynamicAgent(taskId, 'builder');
  assert.deepEqual(picked, { id: idleBuilderId, name: 'Builder Agent 2' });
});

test('pickDynamicAgent falls back to a workspace agent when no exact stage role exists', () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const taskId = crypto.randomUUID();
  const fallbackId = crypto.randomUUID();

  seedTask(taskId, workspaceId);
  seedAgent({ id: fallbackId, workspace: workspaceId, name: 'Fallback Agent', role: 'reviewer' });

  const picked = pickDynamicAgent(taskId, 'builder');
  assert.deepEqual(picked, { id: fallbackId, name: 'Fallback Agent' });
});
