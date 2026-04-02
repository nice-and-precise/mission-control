import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, queryOne, run } from './db';
import { getOpenClawClient } from './openclaw/client';
import { handleStageTransition } from './workflow-engine';
import { POST as dispatchTaskRoute } from '../app/api/tasks/[id]/dispatch/route';
import { NextRequest } from 'next/server';
import { buildPersistentAgentSessionId } from './openclaw/routing';

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

function seedSession(args: {
  agentId: string;
  taskId: string;
  openclawSessionId?: string;
  status?: string;
}) {
  run(
    `INSERT INTO openclaw_sessions (id, agent_id, task_id, openclaw_session_id, channel, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'mission-control', ?, datetime('now'), datetime('now'))`,
    [
      crypto.randomUUID(),
      args.agentId,
      args.taskId,
      args.openclawSessionId || `mission-control-builder-agent-${args.agentId.slice(0, 8)}`,
      args.status || 'active',
    ]
  );
}

function stubGatewayClient(options?: { allowDispatch?: boolean }) {
  const client = getOpenClawClient() as unknown as {
    isConnected: () => boolean;
    connect: () => Promise<void>;
    listAgents: () => Promise<unknown[]>;
    call: (...args: unknown[]) => Promise<unknown>;
  };
  client.isConnected = () => true;
  client.connect = async () => undefined;
  client.listAgents = async () => [];
  client.call = async (...args: unknown[]) => {
    if (options?.allowDispatch && args[0] === 'chat.send') {
      return {};
    }
    throw new Error(`chat.send should not run in this test: ${JSON.stringify(args)}`);
  };
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

test('handleStageTransition immediately starts the next queued builder task after releasing the builder', { concurrency: false }, async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const builderId = crypto.randomUUID();
  const testerId = crypto.randomUUID();
  const completedBuildTaskId = crypto.randomUUID();
  const queuedTaskId = crypto.randomUUID();
  const builderSessionId = buildPersistentAgentSessionId({ id: builderId, name: 'Builder Agent' });

  ensureWorkspace(workspaceId);
  const templateId = seedStrictWorkflowTemplate(workspaceId);
  seedAgent({ id: builderId, workspaceId, name: 'Builder Agent', role: 'builder', status: 'working' });
  seedAgent({ id: testerId, workspaceId, name: 'Tester Agent', role: 'tester', status: 'standby' });
  seedTask({ id: completedBuildTaskId, workspaceId, templateId, status: 'testing', assignedAgentId: builderId });
  seedTask({ id: queuedTaskId, workspaceId, templateId, status: 'assigned', assignedAgentId: builderId });
  run(
    `UPDATE tasks
     SET title = 'Queued builder task',
         status_reason = 'Waiting for Builder Agent to finish \"Current builder task\" before starting this task.'
     WHERE id = ?`,
    [queuedTaskId]
  );
  seedTaskRole(completedBuildTaskId, 'builder', builderId);
  seedTaskRole(completedBuildTaskId, 'tester', testerId);
  seedTaskRole(queuedTaskId, 'builder', builderId);
  seedSession({
    agentId: builderId,
    taskId: completedBuildTaskId,
    openclawSessionId: builderSessionId,
    status: 'active',
  });
  stubGatewayClient({ allowDispatch: true });

  const originalFetch = global.fetch;
  global.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith(`/api/tasks/${completedBuildTaskId}/dispatch`)) {
      return dispatchTaskRoute(
        new NextRequest(url, { method: 'POST', headers: init?.headers }),
        { params: Promise.resolve({ id: completedBuildTaskId }) }
      );
    }
    if (url.endsWith(`/api/tasks/${queuedTaskId}/dispatch`)) {
      return dispatchTaskRoute(
        new NextRequest(url, { method: 'POST', headers: init?.headers }),
        { params: Promise.resolve({ id: queuedTaskId }) }
      );
    }
    throw new Error(`Unexpected fetch in workflow-engine test: ${url}`);
  };

  try {
    const result = await handleStageTransition(completedBuildTaskId, 'testing', {
      previousStatus: 'in_progress',
    });

    assert.equal(result.success, true);
    assert.equal(result.handedOff, true);
    assert.equal(result.newAgentId, testerId);

    const completedTask = queryOne<{ assigned_agent_id: string | null; status: string }>(
      'SELECT assigned_agent_id, status FROM tasks WHERE id = ?',
      [completedBuildTaskId]
    );
    assert.equal(completedTask?.assigned_agent_id, testerId);
    assert.equal(completedTask?.status, 'testing');

    const queuedTask = queryOne<{ status: string; status_reason: string | null }>(
      'SELECT status, status_reason FROM tasks WHERE id = ?',
      [queuedTaskId]
    );
    assert.equal(queuedTask?.status, 'in_progress');
    assert.equal(queuedTask?.status_reason, null);

    const builderSession = queryOne<{ task_id: string | null; status: string }>(
      `SELECT task_id, status
       FROM openclaw_sessions
       WHERE agent_id = ?
         AND task_id = ?
         AND status = 'active'`,
      [builderId, queuedTaskId]
    );
    assert.equal(builderSession?.task_id, queuedTaskId);
    assert.equal(builderSession?.status, 'active');
  } finally {
    global.fetch = originalFetch;
  }
});
