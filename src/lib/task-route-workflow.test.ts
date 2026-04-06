import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { closeDb, queryOne, run } from './db';
import { getOpenClawClient } from './openclaw/client';
import { POST as createTaskRoute } from '../app/api/tasks/route';
import { PATCH as patchTaskRoute } from '../app/api/tasks/[id]/route';
import { POST as dispatchTaskRoute } from '../app/api/tasks/[id]/dispatch/route';
import { POST as approvePlanningRoute } from '../app/api/tasks/[id]/planning/approve/route';
import { buildPersistentAgentSessionId } from './openclaw/routing';

const originalFetch = global.fetch;
const TEST_DB_PATH = process.env.DATABASE_PATH || join(tmpdir(), `mission-control-tests-${process.pid}.sqlite`);
process.env.DATABASE_PATH = TEST_DB_PATH;

afterEach(() => {
  global.fetch = originalFetch;
  const client = getOpenClawClient() as unknown as {
    isConnected?: () => boolean;
    connect?: () => Promise<void>;
    listAgents?: () => Promise<unknown[]>;
    patchSessionModel?: (sessionKey: string, model: string) => Promise<unknown>;
    getSessionByKey?: (sessionKey: string) => Promise<unknown>;
    call?: (...args: unknown[]) => Promise<unknown>;
  };
  delete client.isConnected;
  delete client.connect;
  delete client.listAgents;
  delete client.patchSessionModel;
  delete client.getSessionByKey;
  delete client.call;
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
    [id, `Workspace ${id}`, id],
  );
}

function seedAgent(args: { id: string; workspaceId: string; name: string; role: string; status?: string }) {
  ensureWorkspace(args.workspaceId);
  run(
    `INSERT INTO agents (id, workspace_id, name, role, status, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'local', datetime('now'), datetime('now'))`,
    [args.id, args.workspaceId, args.name, args.role, args.status || 'standby'],
  );
}

function seedStrictWorkflowTemplate(workspaceId: string): string {
  const templateId = `tpl-${crypto.randomUUID()}`;
  ensureWorkspace(workspaceId);
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
    [templateId, workspaceId, stages, failTargets],
  );

  return templateId;
}

function seedTask(args: {
  id: string;
  workspaceId: string;
  templateId: string;
  status: string;
  assignedAgentId?: string | null;
  title?: string;
}) {
  ensureWorkspace(args.workspaceId);
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, workflow_template_id, assigned_agent_id, created_at, updated_at)
     VALUES (?, ?, ?, 'normal', ?, 'default', ?, ?, datetime('now'), datetime('now'))`,
    [args.id, args.title || 'Workflow guard task', args.status, args.workspaceId, args.templateId, args.assignedAgentId || null],
  );
}

function seedTaskRole(taskId: string, role: string, agentId: string) {
  run(
    `INSERT INTO task_roles (id, task_id, role, agent_id, created_at)
     VALUES (?, ?, ?, ?, datetime('now'))`,
    [crypto.randomUUID(), taskId, role, agentId],
  );
}

function seedStageEvidence(taskId: string, agentId: string) {
  run(
    `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, created_at)
     VALUES (?, ?, ?, 'completed', 'Completed implementation work', datetime('now'))`,
    [crypto.randomUUID(), taskId, agentId],
  );
  run(
    `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, path, created_at)
     VALUES (?, ?, 'file', 'src/index.ts', '/tmp/worktree/src/index.ts', datetime('now'))`,
    [crypto.randomUUID(), taskId],
  );
}

function seedSession(args: {
  agentId: string;
  taskId: string;
  openclawSessionId?: string;
  sessionKey?: string | null;
  status?: string;
  sessionType?: string;
  activeTaskId?: string | null;
}) {
  const status = args.status || 'active';
  const sessionType = args.sessionType || 'persistent';
  const activeTaskId = args.activeTaskId === undefined
    ? (status === 'active' && sessionType !== 'subagent' ? args.taskId : null)
    : args.activeTaskId;
  run(
    `INSERT INTO openclaw_sessions (id, agent_id, task_id, active_task_id, openclaw_session_id, session_key, channel, status, session_type, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'mission-control', ?, ?, datetime('now'), datetime('now'))`,
    [
      crypto.randomUUID(),
      args.agentId,
      args.taskId,
      activeTaskId,
      args.openclawSessionId || `mission-control-builder-agent-${args.agentId.slice(0, 8)}`,
      args.sessionKey || null,
      status,
      sessionType,
    ],
  );
}

function stubGatewayClient(options?: { allowDispatch?: boolean }) {
  const client = getOpenClawClient() as unknown as {
    isConnected: () => boolean;
    connect: () => Promise<void>;
    listAgents: () => Promise<unknown[]>;
    patchSessionModel: (sessionKey: string, model: string) => Promise<unknown>;
    getSessionByKey: (sessionKey: string) => Promise<unknown>;
    call: (...args: unknown[]) => Promise<unknown>;
  };
  let boundModel = 'openai-codex/gpt-5.4';
  client.isConnected = () => true;
  client.connect = async () => undefined;
  client.listAgents = async () => [];
  client.patchSessionModel = async (sessionKey: string, model: string) => {
    boundModel = model;
    const [provider, ...rest] = model.split('/');
    return {
      key: sessionKey,
      resolved: { modelProvider: provider, model: rest.join('/') },
    };
  };
  client.getSessionByKey = async (sessionKey: string) => {
    const [provider, ...rest] = boundModel.split('/');
    return {
      key: sessionKey,
      sessionId: `runtime-${sessionKey}`,
      modelProvider: provider,
      model: rest.join('/'),
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
    };
  };
  client.call = async (...args: unknown[]) => {
    if (options?.allowDispatch && args[0] === 'chat.send') {
      return {};
    }
    throw new Error(`chat.send should not run in this test: ${JSON.stringify(args)}`);
  };
}

test('PATCH blocks inbox to in_progress on strict workflow tasks', async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const builderId = crypto.randomUUID();
  const taskId = crypto.randomUUID();

  ensureWorkspace(workspaceId);
  const templateId = seedStrictWorkflowTemplate(workspaceId);
  seedAgent({ id: builderId, workspaceId, name: 'Builder Agent', role: 'builder' });
  seedTask({ id: taskId, workspaceId, templateId, status: 'inbox', assignedAgentId: builderId });
  stubGatewayClient();

  const response = await patchTaskRoute(
    new NextRequest(`http://localhost/api/tasks/${taskId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'in_progress' }),
      headers: { 'Content-Type': 'application/json' },
    }),
    { params: Promise.resolve({ id: taskId }) },
  );

  assert.equal(response.status, 409);
  const body = await response.json();
  assert.match(body.error || '', /inbox tasks must be assigned/i);

  const task = queryOne<{ status: string; assigned_agent_id: string | null }>(
    'SELECT status, assigned_agent_id FROM tasks WHERE id = ?',
    [taskId],
  );
  assert.equal(task?.status, 'inbox');
  assert.equal(task?.assigned_agent_id, builderId);
});

test('PATCH routes quality-stage failure back through workflow ownership', async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const builderId = crypto.randomUUID();
  const testerId = crypto.randomUUID();
  const taskId = crypto.randomUUID();

  ensureWorkspace(workspaceId);
  const templateId = seedStrictWorkflowTemplate(workspaceId);
  seedAgent({ id: builderId, workspaceId, name: 'Builder Agent', role: 'builder' });
  seedAgent({ id: testerId, workspaceId, name: 'Tester Agent', role: 'tester' });
  seedTask({ id: taskId, workspaceId, templateId, status: 'testing', assignedAgentId: testerId });
  seedTaskRole(taskId, 'builder', builderId);
  seedTaskRole(taskId, 'tester', testerId);
  stubGatewayClient();

  global.fetch = async () => new Response('{}', { status: 200 });

  const response = await patchTaskRoute(
    new NextRequest(`http://localhost/api/tasks/${taskId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'in_progress', status_reason: 'Validation failed in tester stage' }),
      headers: { 'Content-Type': 'application/json' },
    }),
    { params: Promise.resolve({ id: taskId }) },
  );

  assert.equal(response.status, 200);
  const task = queryOne<{ status: string; assigned_agent_id: string | null; status_reason: string | null }>(
    'SELECT status, assigned_agent_id, status_reason FROM tasks WHERE id = ?',
    [taskId],
  );
  assert.equal(task?.status, 'in_progress');
  assert.equal(task?.assigned_agent_id, builderId);
  assert.match(task?.status_reason || '', /Failed: Validation failed in tester stage/);
});

test('dispatch rejects workflow mismatch instead of sending the wrong prompt', async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const builderId = crypto.randomUUID();
  const testerId = crypto.randomUUID();
  const taskId = crypto.randomUUID();

  ensureWorkspace(workspaceId);
  const templateId = seedStrictWorkflowTemplate(workspaceId);
  seedAgent({ id: builderId, workspaceId, name: 'Builder Agent', role: 'builder' });
  seedAgent({ id: testerId, workspaceId, name: 'Tester Agent', role: 'tester' });
  seedTask({ id: taskId, workspaceId, templateId, status: 'in_progress', assignedAgentId: testerId });
  seedTaskRole(taskId, 'builder', builderId);
  seedTaskRole(taskId, 'tester', testerId);
  stubGatewayClient();

  const response = await dispatchTaskRoute(
    new NextRequest(`http://localhost/api/tasks/${taskId}/dispatch`, { method: 'POST' }),
    { params: Promise.resolve({ id: taskId }) },
  );

  assert.equal(response.status, 409);
  const body = await response.json();
  assert.match(body.error || '', /workflow mismatch/i);

  const task = queryOne<{ planning_dispatch_error: string | null; status_reason: string | null }>(
    'SELECT planning_dispatch_error, status_reason FROM tasks WHERE id = ?',
    [taskId],
  );
  assert.match(task?.planning_dispatch_error || '', /in_progress is builder-owned/i);
  assert.match(task?.status_reason || '', /in_progress is builder-owned/i);
});

test('dispatch prompt uses MC_API_TOKEN instructions without leaking the raw bearer token', async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const builderId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  const previousToken = process.env.MC_API_TOKEN;
  let dispatchedMessage = '';

  process.env.MC_API_TOKEN = 'super-secret-token-for-test';
  try {
    ensureWorkspace(workspaceId);
    const templateId = seedStrictWorkflowTemplate(workspaceId);
    seedAgent({ id: builderId, workspaceId, name: 'Builder Agent', role: 'builder' });
    seedTask({ id: taskId, workspaceId, templateId, status: 'assigned', assignedAgentId: builderId, title: 'Auth prompt task' });
    seedTaskRole(taskId, 'builder', builderId);

    const client = getOpenClawClient() as unknown as {
      isConnected: () => boolean;
      connect: () => Promise<void>;
      listAgents: () => Promise<unknown[]>;
      patchSessionModel: (sessionKey: string, model: string) => Promise<unknown>;
      getSessionByKey: (sessionKey: string) => Promise<unknown>;
      call: (...args: unknown[]) => Promise<unknown>;
    };
    let boundModel = 'openai-codex/gpt-5.4';
    client.isConnected = () => true;
    client.connect = async () => undefined;
    client.listAgents = async () => [];
    client.patchSessionModel = async (sessionKey: string, model: string) => {
      boundModel = model;
      const [provider, ...rest] = model.split('/');
      return {
        key: sessionKey,
        resolved: { modelProvider: provider, model: rest.join('/') },
      };
    };
    client.getSessionByKey = async (sessionKey: string) => {
      const [provider, ...rest] = boundModel.split('/');
      return {
        key: sessionKey,
        sessionId: `runtime-${sessionKey}`,
        modelProvider: provider,
        model: rest.join('/'),
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
      };
    };
    client.call = async (...args: unknown[]) => {
      if (args[0] === 'chat.send') {
        dispatchedMessage = String((args[1] as { message?: string } | undefined)?.message || '');
        return {};
      }
      throw new Error(`Unexpected gateway call: ${JSON.stringify(args)}`);
    };

    const response = await dispatchTaskRoute(
      new NextRequest(`http://localhost/api/tasks/${taskId}/dispatch`, { method: 'POST' }),
      { params: Promise.resolve({ id: taskId }) },
    );

    assert.equal(response.status, 200);
    assert.match(dispatchedMessage, /MC_API_TOKEN/);
    assert.match(dispatchedMessage, /Authorization: Bearer \$MC_API_TOKEN/);
    assert.doesNotMatch(dispatchedMessage, /super-secret-token-for-test/);
  } finally {
    if (previousToken === undefined) {
      delete process.env.MC_API_TOKEN;
    } else {
      process.env.MC_API_TOKEN = previousToken;
    }
  }
});

test('POST /api/tasks dispatches assigned tasks server-side', async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const builderId = crypto.randomUUID();
  ensureWorkspace(workspaceId);
  const templateId = seedStrictWorkflowTemplate(workspaceId);
  seedAgent({ id: builderId, workspaceId, name: 'Builder Agent', role: 'builder' });

  let dispatchCalls = 0;
  global.fetch = async (input: string | URL | Request) => {
    dispatchCalls += 1;
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    assert.match(url, /\/api\/tasks\/.+\/dispatch$/);
    return new Response('{}', { status: 200 });
  };

  const response = await createTaskRoute(
    new NextRequest('http://localhost/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Create and dispatch',
        status: 'assigned',
        assigned_agent_id: builderId,
        workspace_id: workspaceId,
      }),
      headers: { 'Content-Type': 'application/json' },
    }),
  );

  assert.equal(response.status, 201);
  assert.equal(dispatchCalls, 1);

  const createdTask = await response.json();
  const task = queryOne<{ workflow_template_id: string | null }>(
    'SELECT workflow_template_id FROM tasks WHERE id = ?',
    [createdTask.id],
  );
  assert.equal(task?.workflow_template_id, templateId);
});

test('planning approval immediately dispatches strict-workflow tasks to the builder', async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const builderId = crypto.randomUUID();
  const taskId = crypto.randomUUID();

  ensureWorkspace(workspaceId);
  const templateId = seedStrictWorkflowTemplate(workspaceId);
  seedAgent({ id: builderId, workspaceId, name: 'Builder Agent', role: 'builder' });
  seedTask({ id: taskId, workspaceId, templateId, status: 'planning', title: 'Planning approval dispatch' });
  run(
    `UPDATE tasks
     SET planning_complete = 1,
         planning_spec = ?,
         planning_agents = '[]',
         assigned_agent_id = ?
     WHERE id = ?`,
    [
      JSON.stringify({
        title: 'Planning approval dispatch',
        summary: 'Dispatch the builder immediately after approval.',
        deliverables: ['working builder session'],
        success_criteria: ['builder session exists'],
        constraints: {},
      }),
      builderId,
      taskId,
    ],
  );
  seedTaskRole(taskId, 'builder', builderId);
  stubGatewayClient({ allowDispatch: true });

  global.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    assert.match(url, new RegExp(`/api/tasks/${taskId}/dispatch$`));
    return dispatchTaskRoute(
      new NextRequest(url, {
        method: 'POST',
        headers: init?.headers,
      }),
      { params: Promise.resolve({ id: taskId }) },
    );
  };

  const response = await approvePlanningRoute(
    new NextRequest(`http://localhost/api/tasks/${taskId}/planning/approve`, { method: 'POST' }),
    { params: Promise.resolve({ id: taskId }) },
  );

  assert.equal(response.status, 200);

  const task = queryOne<{ status: string; assigned_agent_id: string | null; planning_dispatch_error: string | null }>(
    'SELECT status, assigned_agent_id, planning_dispatch_error FROM tasks WHERE id = ?',
    [taskId],
  );
  assert.equal(task?.status, 'in_progress');
  assert.equal(task?.assigned_agent_id, builderId);
  assert.equal(task?.planning_dispatch_error, null);

  const session = queryOne<{ status: string; task_id: string | null }>(
    `SELECT status, task_id
     FROM openclaw_sessions
     WHERE agent_id = ?
       AND task_id = ?
       AND status = 'active'`,
    [builderId, taskId],
  );
  assert.equal(session?.status, 'active');
  assert.equal(session?.task_id, taskId);
});

test('dispatch keeps a second builder task queued instead of stealing the active builder session', async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const builderId = crypto.randomUUID();
  const activeTaskId = crypto.randomUUID();
  const queuedTaskId = crypto.randomUUID();
  const builderSessionId = buildPersistentAgentSessionId({ id: builderId, name: 'Builder Agent' });
  const builderSessionKey = `agent:coder:${builderSessionId}`;

  ensureWorkspace(workspaceId);
  const templateId = seedStrictWorkflowTemplate(workspaceId);
  seedAgent({ id: builderId, workspaceId, name: 'Builder Agent', role: 'builder', status: 'working' });
  seedTask({ id: activeTaskId, workspaceId, templateId, status: 'in_progress', assignedAgentId: builderId, title: 'Current builder task' });
  seedTask({ id: queuedTaskId, workspaceId, templateId, status: 'assigned', assignedAgentId: builderId, title: 'Queued builder task' });
  seedTaskRole(activeTaskId, 'builder', builderId);
  seedTaskRole(queuedTaskId, 'builder', builderId);
  seedSession({
    agentId: builderId,
    taskId: activeTaskId,
    openclawSessionId: builderSessionId,
    sessionKey: builderSessionKey,
    status: 'active',
  });
  stubGatewayClient({ allowDispatch: true });

  const response = await dispatchTaskRoute(
    new NextRequest(`http://localhost/api/tasks/${queuedTaskId}/dispatch`, { method: 'POST' }),
    { params: Promise.resolve({ id: queuedTaskId }) },
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.queued, true);
  assert.equal(body.waiting_for_task_id, activeTaskId);

  const queuedTask = queryOne<{ status: string; status_reason: string | null }>(
    'SELECT status, status_reason FROM tasks WHERE id = ?',
    [queuedTaskId],
  );
  assert.equal(queuedTask?.status, 'assigned');
  assert.match(queuedTask?.status_reason || '', /Waiting for Builder Agent to finish "Current builder task"/);
  assert.equal(queuedTask?.status, 'assigned');

  const builderSession = queryOne<{ task_id: string | null; active_task_id: string | null; session_key: string | null }>(
    `SELECT task_id, active_task_id, session_key
     FROM openclaw_sessions
     WHERE agent_id = ?
       AND openclaw_session_id = ?
     LIMIT 1`,
    [builderId, builderSessionId],
  );
  const queuedTaskSessions = queryOne<{ count: number }>(
    'SELECT COUNT(*) AS count FROM openclaw_sessions WHERE task_id = ?',
    [queuedTaskId],
  );

  assert.equal(builderSession?.task_id, activeTaskId);
  assert.equal(builderSession?.active_task_id, activeTaskId);
  assert.equal(builderSession?.session_key, builderSessionKey);
  assert.equal(queuedTaskSessions?.count || 0, 0);
});

test('dispatch restores a corrupted queued builder task to waiting state without creating a root session', async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const builderId = crypto.randomUUID();
  const activeTaskId = crypto.randomUUID();
  const queuedTaskId = crypto.randomUUID();
  const builderSessionId = buildPersistentAgentSessionId({ id: builderId, name: 'Builder Agent' });
  const builderSessionKey = `agent:coder:${builderSessionId}`;

  ensureWorkspace(workspaceId);
  const templateId = seedStrictWorkflowTemplate(workspaceId);
  seedAgent({ id: builderId, workspaceId, name: 'Builder Agent', role: 'builder', status: 'working' });
  seedTask({ id: activeTaskId, workspaceId, templateId, status: 'in_progress', assignedAgentId: builderId, title: 'Current builder task' });
  seedTask({ id: queuedTaskId, workspaceId, templateId, status: 'assigned', assignedAgentId: builderId, title: 'Corrupted queued task' });
  seedTaskRole(activeTaskId, 'builder', builderId);
  seedTaskRole(queuedTaskId, 'builder', builderId);
  seedSession({
    agentId: builderId,
    taskId: activeTaskId,
    openclawSessionId: builderSessionId,
    sessionKey: builderSessionKey,
    status: 'active',
  });
  run(
    `UPDATE tasks
     SET planning_dispatch_error = 'Run ended without completion callback or workflow handoff (ended session).',
         status_reason = 'Run ended without completion callback or workflow handoff (ended session).'
     WHERE id = ?`,
    [queuedTaskId],
  );
  run(
    `INSERT INTO openclaw_sessions
      (id, agent_id, task_id, active_task_id, openclaw_session_id, channel, status, session_type, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, 'mission-control', 'ended', 'persistent', datetime('now'), datetime('now'))`,
    [crypto.randomUUID(), builderId, queuedTaskId, builderSessionId],
  );
  stubGatewayClient({ allowDispatch: true });

  const response = await dispatchTaskRoute(
    new NextRequest(`http://localhost/api/tasks/${queuedTaskId}/dispatch`, { method: 'POST' }),
    { params: Promise.resolve({ id: queuedTaskId }) },
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.queued, true);
  assert.equal(body.waiting_for_task_id, activeTaskId);

  const queuedTask = queryOne<{ planning_dispatch_error: string | null; status_reason: string | null }>(
    'SELECT planning_dispatch_error, status_reason FROM tasks WHERE id = ?',
    [queuedTaskId],
  );
  const builderSession = queryOne<{ task_id: string | null; active_task_id: string | null; session_key: string | null }>(
    `SELECT task_id, active_task_id, session_key
     FROM openclaw_sessions
     WHERE agent_id = ?
       AND openclaw_session_id = ?
       AND status = 'active'
     LIMIT 1`,
    [builderId, builderSessionId],
  );
  const queuedActiveSessionCount = queryOne<{ count: number }>(
    `SELECT COUNT(*) AS count
     FROM openclaw_sessions
     WHERE task_id = ?
       AND status = 'active'`,
    [queuedTaskId],
  );

  assert.equal(queuedTask?.planning_dispatch_error, null);
  assert.match(queuedTask?.status_reason || '', /Waiting for Builder Agent to finish "Current builder task"/);
  assert.equal(builderSession?.task_id, activeTaskId);
  assert.equal(builderSession?.active_task_id, activeTaskId);
  assert.equal(builderSession?.session_key, builderSessionKey);
  assert.equal(queuedActiveSessionCount?.count || 0, 0);
});

test('planning approval queues a busy builder task instead of starting a second in-progress build', async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const builderId = crypto.randomUUID();
  const activeTaskId = crypto.randomUUID();
  const queuedTaskId = crypto.randomUUID();
  const builderSessionId = buildPersistentAgentSessionId({ id: builderId, name: 'Builder Agent' });

  ensureWorkspace(workspaceId);
  const templateId = seedStrictWorkflowTemplate(workspaceId);
  seedAgent({ id: builderId, workspaceId, name: 'Builder Agent', role: 'builder', status: 'working' });
  seedTask({ id: activeTaskId, workspaceId, templateId, status: 'in_progress', assignedAgentId: builderId, title: 'Current builder task' });
  seedTask({ id: queuedTaskId, workspaceId, templateId, status: 'planning', title: 'Planning approval dispatch' });
  run(
    `UPDATE tasks
     SET planning_complete = 1,
         planning_spec = ?,
         planning_agents = '[]'
     WHERE id = ?`,
    [
      JSON.stringify({
        title: 'Planning approval dispatch',
        summary: 'Queue behind a busy builder.',
        deliverables: ['queued builder task'],
        success_criteria: ['task remains assigned until builder is free'],
        constraints: {},
      }),
      queuedTaskId,
    ],
  );
  seedTaskRole(activeTaskId, 'builder', builderId);
  seedTaskRole(queuedTaskId, 'builder', builderId);
  seedSession({
    agentId: builderId,
    taskId: activeTaskId,
    openclawSessionId: builderSessionId,
    status: 'active',
  });
  stubGatewayClient({ allowDispatch: true });

  global.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    assert.match(url, new RegExp(`/api/tasks/${queuedTaskId}/dispatch$`));
    return dispatchTaskRoute(
      new NextRequest(url, {
        method: 'POST',
        headers: init?.headers,
      }),
      { params: Promise.resolve({ id: queuedTaskId }) },
    );
  };

  const response = await approvePlanningRoute(
    new NextRequest(`http://localhost/api/tasks/${queuedTaskId}/planning/approve`, { method: 'POST' }),
    { params: Promise.resolve({ id: queuedTaskId }) },
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.dispatched, false);
  assert.equal(body.queued, true);
  assert.equal(body.builderAgentId, builderId);

  const queuedTask = queryOne<{ status: string; assigned_agent_id: string | null; status_reason: string | null }>(
    'SELECT status, assigned_agent_id, status_reason FROM tasks WHERE id = ?',
    [queuedTaskId],
  );
  assert.equal(queuedTask?.status, 'assigned');
  assert.equal(queuedTask?.assigned_agent_id, builderId);
  assert.match(queuedTask?.status_reason || '', /Waiting for Builder Agent to finish "Current builder task"/);
});

test('PATCH to testing detaches the builder root session even when updated_by_agent_id is missing', async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const builderId = crypto.randomUUID();
  const testerId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  const builderSessionId = buildPersistentAgentSessionId({ id: builderId, name: 'Builder Agent' });

  ensureWorkspace(workspaceId);
  const templateId = seedStrictWorkflowTemplate(workspaceId);
  seedAgent({ id: builderId, workspaceId, name: 'Builder Agent', role: 'builder', status: 'working' });
  seedAgent({ id: testerId, workspaceId, name: 'Tester Agent', role: 'tester' });
  seedTask({ id: taskId, workspaceId, templateId, status: 'in_progress', assignedAgentId: builderId, title: 'Builder handoff compatibility' });
  seedTaskRole(taskId, 'builder', builderId);
  seedTaskRole(taskId, 'tester', testerId);
  seedStageEvidence(taskId, builderId);
  seedSession({
    agentId: builderId,
    taskId,
    openclawSessionId: builderSessionId,
    status: 'active',
  });
  stubGatewayClient({ allowDispatch: true });

  global.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    assert.match(url, new RegExp(`/api/tasks/${taskId}/dispatch$`));
    return dispatchTaskRoute(
      new NextRequest(url, {
        method: 'POST',
        headers: init?.headers,
      }),
      { params: Promise.resolve({ id: taskId }) },
    );
  };

  const response = await patchTaskRoute(
    new NextRequest(`http://localhost/api/tasks/${taskId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'testing' }),
      headers: { 'Content-Type': 'application/json' },
    }),
    { params: Promise.resolve({ id: taskId }) },
  );

  assert.equal(response.status, 200);

  const builderSession = queryOne<{ status: string; active_task_id: string | null }>(
    `SELECT status, active_task_id
     FROM openclaw_sessions
     WHERE agent_id = ? AND openclaw_session_id = ?`,
    [builderId, builderSessionId],
  );
  const testerSession = queryOne<{ status: string; task_id: string | null; active_task_id: string | null }>(
    `SELECT status, task_id, active_task_id
     FROM openclaw_sessions
     WHERE agent_id = ?
       AND status = 'active'
       AND COALESCE(session_type, 'persistent') != 'subagent'
     ORDER BY created_at DESC
     LIMIT 1`,
    [testerId],
  );

  assert.equal(builderSession?.status, 'ended');
  assert.equal(builderSession?.active_task_id, null);
  assert.equal(testerSession?.status, 'active');
  assert.equal(testerSession?.task_id, taskId);
  assert.equal(testerSession?.active_task_id, taskId);
});

test('PATCH to testing detaches the builder root session when updated_by_agent_id is present', async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const builderId = crypto.randomUUID();
  const testerId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  const builderSessionId = buildPersistentAgentSessionId({ id: builderId, name: 'Builder Agent' });

  ensureWorkspace(workspaceId);
  const templateId = seedStrictWorkflowTemplate(workspaceId);
  seedAgent({ id: builderId, workspaceId, name: 'Builder Agent', role: 'builder', status: 'working' });
  seedAgent({ id: testerId, workspaceId, name: 'Tester Agent', role: 'tester' });
  seedTask({ id: taskId, workspaceId, templateId, status: 'in_progress', assignedAgentId: builderId, title: 'Builder handoff explicit owner' });
  seedTaskRole(taskId, 'builder', builderId);
  seedTaskRole(taskId, 'tester', testerId);
  seedStageEvidence(taskId, builderId);
  seedSession({
    agentId: builderId,
    taskId,
    openclawSessionId: builderSessionId,
    status: 'active',
  });
  stubGatewayClient({ allowDispatch: true });

  global.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    assert.match(url, new RegExp(`/api/tasks/${taskId}/dispatch$`));
    return dispatchTaskRoute(
      new NextRequest(url, {
        method: 'POST',
        headers: init?.headers,
      }),
      { params: Promise.resolve({ id: taskId }) },
    );
  };

  const response = await patchTaskRoute(
    new NextRequest(`http://localhost/api/tasks/${taskId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'testing', updated_by_agent_id: builderId }),
      headers: { 'Content-Type': 'application/json' },
    }),
    { params: Promise.resolve({ id: taskId }) },
  );

  assert.equal(response.status, 200);

  const builderSession = queryOne<{ status: string; active_task_id: string | null }>(
    `SELECT status, active_task_id
     FROM openclaw_sessions
     WHERE agent_id = ? AND openclaw_session_id = ?`,
    [builderId, builderSessionId],
  );
  const testerSession = queryOne<{ status: string; active_task_id: string | null }>(
    `SELECT status, active_task_id
     FROM openclaw_sessions
     WHERE agent_id = ?
       AND status = 'active'
       AND COALESCE(session_type, 'persistent') != 'subagent'
     ORDER BY created_at DESC
     LIMIT 1`,
    [testerId],
  );

  assert.equal(builderSession?.status, 'ended');
  assert.equal(builderSession?.active_task_id, null);
  assert.equal(testerSession?.status, 'active');
  assert.equal(testerSession?.active_task_id, taskId);
});
