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

test('ensureFixerExists creates fixer when missing', () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  ensureWorkspace(workspaceId);
  const fixer = ensureFixerExists(workspaceId);
  assert.equal(fixer.created, true);

  const stored = queryOne<{ id: string; role: string }>('SELECT id, role FROM agents WHERE id = ?', [fixer.id]);
  assert.ok(stored);
  assert.equal(stored?.role, 'fixer');
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

test('pickDynamicAgent falls back to a workspace agent when no exact stage role exists', () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const taskId = crypto.randomUUID();
  const fallbackId = crypto.randomUUID();

  seedTask(taskId, workspaceId);
  seedAgent({ id: fallbackId, workspace: workspaceId, name: 'Fallback Agent', role: 'reviewer' });

  const picked = pickDynamicAgent(taskId, 'builder');
  assert.deepEqual(picked, { id: fallbackId, name: 'Fallback Agent' });
});
