import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, queryOne, run } from './db';
import { getOpenClawClient } from './openclaw/client';
import { handleStageTransition } from './workflow-engine';

afterEach(() => {
  getOpenClawClient().disconnect();
  const cleanupTimer = (globalThis as Record<string, unknown>).__openclaw_cache_cleanup_timer__;
  if (cleanupTimer) {
    clearInterval(cleanupTimer as NodeJS.Timeout);
    delete (globalThis as Record<string, unknown>).__openclaw_cache_cleanup_timer__;
  }
  closeDb();
});

function ensureWorkspace(id: string) {
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at, updated_at)
     VALUES (?, ?, ?, datetime('now'), datetime('now'))`,
    [id, `Workspace ${id}`, id]
  );
}

function seedAgent(args: { id: string; workspaceId: string; name: string; role: string; status?: string }) {
  run(
    `INSERT INTO agents (id, workspace_id, name, role, status, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'local', datetime('now'), datetime('now'))`,
    [args.id, args.workspaceId, args.name, args.role, args.status || 'standby']
  );
}

function seedStrictWorkflowTemplate(workspaceId: string): string {
  const templateId = `tpl-${crypto.randomUUID()}`;
  const stages = JSON.stringify([
    { id: 'build', label: 'Build', role: 'builder', status: 'in_progress' },
    { id: 'test', label: 'Test', role: 'tester', status: 'testing' },
    { id: 'review', label: 'Review', role: null, status: 'review' },
    { id: 'verify', label: 'Verify', role: 'reviewer', status: 'verification' },
    { id: 'done', label: 'Done', role: null, status: 'done' },
  ]);
  const failTargets = JSON.stringify({
    testing: 'in_progress',
    review: 'in_progress',
    verification: 'in_progress',
  });

  run(
    `INSERT INTO workflow_templates (id, workspace_id, name, description, stages, fail_targets, is_default, created_at, updated_at)
     VALUES (?, ?, 'Strict', 'Strict workflow', ?, ?, 1, datetime('now'), datetime('now'))`,
    [templateId, workspaceId, stages, failTargets]
  );

  return templateId;
}

function seedTask(args: {
  id: string;
  workspaceId: string;
  templateId: string;
  status: string;
  assignedAgentId?: string | null;
  updatedAt?: string;
}) {
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, workflow_template_id, assigned_agent_id, created_at, updated_at)
     VALUES (?, 'Queue task', ?, 'normal', ?, 'default', ?, ?, datetime('now'), ?)`,
    [args.id, args.status, args.workspaceId, args.templateId, args.assignedAgentId || null, args.updatedAt || new Date().toISOString()]
  );
}

function seedTaskRole(taskId: string, role: string, agentId: string) {
  run(
    `INSERT INTO task_roles (id, task_id, role, agent_id, created_at)
     VALUES (?, ?, ?, ?, datetime('now'))`,
    [crypto.randomUUID(), taskId, role, agentId]
  );
}

test('handleStageTransition drains review queue into verification and assigns the reviewer when the slot is free', { concurrency: false }, async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const reviewerId = crypto.randomUUID();
  const taskId = crypto.randomUUID();

  ensureWorkspace(workspaceId);
  const templateId = seedStrictWorkflowTemplate(workspaceId);
  seedAgent({ id: reviewerId, workspaceId, name: 'Reviewer Agent', role: 'reviewer' });
  seedTask({ id: taskId, workspaceId, templateId, status: 'review' });
  seedTaskRole(taskId, 'reviewer', reviewerId);

  const originalFetch = global.fetch;
  global.fetch = async () => new Response('{}', { status: 200 });

  try {
    const result = await handleStageTransition(taskId, 'review', {
      previousStatus: 'testing',
    });

    assert.equal(result.success, true);
    assert.equal(result.handedOff, true);
    assert.equal(result.newAgentId, reviewerId);

    const task = queryOne<{ status: string; assigned_agent_id: string; planning_dispatch_error: string | null; status_reason: string | null }>(
      'SELECT status, assigned_agent_id, planning_dispatch_error, status_reason FROM tasks WHERE id = ?',
      [taskId]
    );
    assert.equal(task?.status, 'verification');
    assert.equal(task?.assigned_agent_id, reviewerId);
    assert.equal(task?.planning_dispatch_error, null);
    assert.equal(task?.status_reason, null);
  } finally {
    global.fetch = originalFetch;
  }
});

test('handleStageTransition keeps a task parked in review when verification is already occupied in the workspace', { concurrency: false }, async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const reviewerId = crypto.randomUUID();
  const queuedTaskId = crypto.randomUUID();
  const occupyingTaskId = crypto.randomUUID();

  ensureWorkspace(workspaceId);
  const templateId = seedStrictWorkflowTemplate(workspaceId);
  seedAgent({ id: reviewerId, workspaceId, name: 'Reviewer Agent', role: 'reviewer' });
  seedTask({ id: queuedTaskId, workspaceId, templateId, status: 'review' });
  seedTask({ id: occupyingTaskId, workspaceId, templateId, status: 'verification', assignedAgentId: reviewerId });
  seedTaskRole(queuedTaskId, 'reviewer', reviewerId);

  const originalFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    return new Response('{}', { status: 200 });
  };

  try {
    const result = await handleStageTransition(queuedTaskId, 'review', {
      previousStatus: 'testing',
    });

    assert.equal(result.success, true);
    assert.equal(result.handedOff, false);
    assert.equal(fetchCalls, 0);

    const task = queryOne<{ status: string; assigned_agent_id: string | null }>(
      'SELECT status, assigned_agent_id FROM tasks WHERE id = ?',
      [queuedTaskId]
    );
    assert.equal(task?.status, 'review');
    assert.equal(task?.assigned_agent_id, null);
  } finally {
    global.fetch = originalFetch;
  }
});

test('handleStageTransition persists planning_dispatch_error when queue drain advances but reviewer dispatch fails', { concurrency: false }, async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const reviewerId = crypto.randomUUID();
  const taskId = crypto.randomUUID();

  ensureWorkspace(workspaceId);
  const templateId = seedStrictWorkflowTemplate(workspaceId);
  seedAgent({ id: reviewerId, workspaceId, name: 'Reviewer Agent', role: 'reviewer' });
  seedTask({ id: taskId, workspaceId, templateId, status: 'review' });
  seedTaskRole(taskId, 'reviewer', reviewerId);

  const originalFetch = global.fetch;
  global.fetch = async () => new Response('dispatch exploded', { status: 503 });

  try {
    const result = await handleStageTransition(taskId, 'review', {
      previousStatus: 'testing',
    });

    assert.equal(result.success, false);
    assert.equal(result.handedOff, true);
    assert.match(result.error || '', /dispatch exploded/i);

    const task = queryOne<{ status: string; assigned_agent_id: string; planning_dispatch_error: string | null }>(
      'SELECT status, assigned_agent_id, planning_dispatch_error FROM tasks WHERE id = ?',
      [taskId]
    );
    assert.equal(task?.status, 'verification');
    assert.equal(task?.assigned_agent_id, reviewerId);
    assert.match(task?.planning_dispatch_error || '', /dispatch exploded/i);
  } finally {
    global.fetch = originalFetch;
  }
});
