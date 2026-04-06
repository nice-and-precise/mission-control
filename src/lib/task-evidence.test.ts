import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { closeDb, queryAll, queryOne, run } from './db';
import { getOpenClawClient } from './openclaw/client';
import {
  getTaskStreamState,
  mapGatewaySessionStatus,
  reconcileTaskRuntimeEvidence,
  setGatewaySessionsResolverForTests,
} from '@/lib/task-evidence';
import { runHealthCheckCycle } from './agent-health';
import { setGatewaySessionHistoryResolverForTests } from './openclaw/session-history';
import { GET as getSubagentRoute } from '../app/api/tasks/[id]/subagent/route';
import { GET as getDeliverablesRoute } from '../app/api/tasks/[id]/deliverables/route';
import { GET as getAgentStreamRoute } from '../app/api/tasks/[id]/agent-stream/route';
import { GET as getOpenClawStatusRoute } from '../app/api/openclaw/status/route';
import { DELETE as deleteTaskRoute } from '../app/api/tasks/[id]/route';
import { POST as dispatchTaskRoute } from '../app/api/tasks/[id]/dispatch/route';

const originalFetch = global.fetch;
const TEST_DB_PATH = process.env.DATABASE_PATH || path.join(os.tmpdir(), `mission-control-tests-${process.pid}.sqlite`);
process.env.DATABASE_PATH = TEST_DB_PATH;

afterEach(() => {
  global.fetch = originalFetch;
  setGatewaySessionsResolverForTests(null);
  setGatewaySessionHistoryResolverForTests(null);
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

function seedProduct(args: { id: string; workspaceId: string; name?: string }) {
  ensureWorkspace(args.workspaceId);
  run(
    `INSERT INTO products
      (id, workspace_id, name, created_at, updated_at)
     VALUES (?, ?, ?, datetime('now'), datetime('now'))`,
    [args.id, args.workspaceId, args.name || 'Runtime Evidence Product'],
  );
}

function seedAgent(args: {
  id: string;
  workspaceId: string;
  name: string;
  role: string;
  status?: string;
  prefix?: string | null;
  scope?: 'workspace' | 'task';
  taskId?: string | null;
}) {
  ensureWorkspace(args.workspaceId);
  run(
    `INSERT INTO agents
      (id, workspace_id, name, role, status, source, session_key_prefix, scope, task_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'local', ?, ?, ?, datetime('now'), datetime('now'))`,
    [
      args.id,
      args.workspaceId,
      args.name,
      args.role,
      args.status || 'standby',
      args.prefix || null,
      args.scope || 'workspace',
      args.taskId || null,
    ],
  );
}

function seedTask(args: {
  id: string;
  workspaceId: string;
  assignedAgentId?: string | null;
  status?: string;
  planningDispatchError?: string | null;
  workspacePath?: string | null;
}) {
  ensureWorkspace(args.workspaceId);
  run(
    `INSERT INTO tasks
      (id, title, status, priority, workspace_id, business_id, assigned_agent_id, planning_dispatch_error, workspace_path, created_at, updated_at)
     VALUES (?, 'Runtime evidence task', ?, 'normal', ?, 'default', ?, ?, ?, datetime('now'), datetime('now'))`,
    [
      args.id,
      args.status || 'assigned',
      args.workspaceId,
      args.assignedAgentId || null,
      args.planningDispatchError || null,
      args.workspacePath || null,
    ],
  );
}

function seedTaskSession(args: {
  id?: string;
  taskId: string;
  agentId: string;
  openclawSessionId: string;
  status?: string;
  sessionType?: string;
  activeTaskId?: string | null;
}) {
  const status = args.status || 'ended';
  const sessionType = args.sessionType || 'persistent';
  const activeTaskId = args.activeTaskId === undefined
    ? (status === 'active' && sessionType !== 'subagent' ? args.taskId : null)
    : args.activeTaskId;
  run(
    `INSERT INTO openclaw_sessions
      (id, agent_id, openclaw_session_id, channel, status, session_type, task_id, active_task_id, created_at, updated_at)
     VALUES (?, ?, ?, 'mission-control', ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    [
      args.id || crypto.randomUUID(),
      args.agentId,
      args.openclawSessionId,
      status,
      sessionType,
      args.taskId,
      activeTaskId,
    ],
  );
}

function setTaskSessionTimes(args: {
  taskId: string;
  openclawSessionId: string;
  createdAt?: string;
  updatedAt?: string;
  endedAt?: string | null;
}) {
  run(
    `UPDATE openclaw_sessions
     SET created_at = COALESCE(?, created_at),
         updated_at = COALESCE(?, updated_at),
         ended_at = ?
     WHERE task_id = ? AND openclaw_session_id = ?`,
    [
      args.createdAt || null,
      args.updatedAt || null,
      args.endedAt === undefined ? null : args.endedAt,
      args.taskId,
      args.openclawSessionId,
    ],
  );
}

function buildTaskId(prefix = '82c5dd08'): string {
  const [, ...segments] = crypto.randomUUID().split('-');
  return `${prefix}-${segments.join('-')}`;
}

function buildGatewayPayload(
  taskId: string,
  statuses?: {
    builder?: string;
    builderEndedAt?: string | number | null;
    crm?: string;
    portal?: string;
  },
) {
  const builderKey = 'agent:coder:mission-control-builder-agent';
  const crmKey = 'agent:coder:subagent:f8951fcf-7a9b-42b5-b2d0-719176823ef0';
  const portalKey = 'agent:coder:subagent:51b79a4f-1411-473e-9bf2-be7d3d6c5d86';
  const taskToken = taskId.split('-')[0];

  return {
    count: 3,
    sessions: [
      {
        key: builderKey,
        status: statuses?.builder || 'done',
        childSessions: [crmKey, portalKey],
        updatedAt: 1774539653661,
        endedAt: statuses?.builderEndedAt ?? 1774539653661,
      },
      {
        key: crmKey,
        label: `crm-agent-task-${taskToken}`,
        status: statuses?.crm || 'done',
        channel: 'webchat',
        parentSessionKey: builderKey,
        spawnedBy: builderKey,
        updatedAt: 1774539643580,
      },
      {
        key: portalKey,
        label: `portal-agent-task-${taskToken}`,
        status: statuses?.portal || 'done',
        channel: 'webchat',
        parentSessionKey: builderKey,
        spawnedBy: builderKey,
        updatedAt: 1774539653816,
      },
    ],
  };
}

function createWorkspaceRepo(): string {
  const workspacePath = mkdtempSync(path.join(os.tmpdir(), 'mission-control-task-evidence-'));

  execFileSync('git', ['init', '-b', 'main'], { cwd: workspacePath, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Mission Control Tests'], { cwd: workspacePath, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'mission-control-tests@example.com'], { cwd: workspacePath, stdio: 'pipe' });

  mkdirSync(path.join(workspacePath, 'services/crm-adapter/src'), { recursive: true });
  mkdirSync(path.join(workspacePath, 'services/user-portal/src/pages'), { recursive: true });

  writeFileSync(
    path.join(workspacePath, 'services/crm-adapter/src/app.js'),
    'module.exports = { status: "initial" };\n',
  );
  writeFileSync(
    path.join(workspacePath, 'services/user-portal/src/pages/DashboardPage.jsx'),
    'export const DashboardPage = () => null;\n',
  );

  execFileSync('git', ['add', '.'], { cwd: workspacePath, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: workspacePath, stdio: 'pipe' });

  writeFileSync(
    path.join(workspacePath, 'services/crm-adapter/src/app.js'),
    'module.exports = { status: "changed" };\n',
  );
  writeFileSync(
    path.join(workspacePath, 'services/user-portal/src/pages/DashboardPage.jsx'),
    'export const DashboardPage = () => "changed";\n',
  );
  writeFileSync(path.join(workspacePath, '.mc-workspace.json'), '{"task":"evidence"}\n');

  return workspacePath;
}

async function readFirstSseEvent(response: Response, abortController: AbortController): Promise<any> {
  assert.ok(response.body, 'Expected an SSE response body');
  const reader = response.body.getReader();
  const { value, done } = await reader.read();

  abortController.abort();
  await reader.cancel().catch(() => undefined);

  assert.equal(done, false);
  const payload = new TextDecoder().decode(value);
  const dataLine = payload
    .split('\n')
    .find((line) => line.startsWith('data: '));

  assert.ok(dataLine, `Expected an SSE data line, received: ${payload}`);
  return JSON.parse(dataLine.slice(6));
}

test('reconcileTaskRuntimeEvidence recovers subagent sessions idempotently and the route returns them', async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const taskId = buildTaskId();
  const builderId = crypto.randomUUID();
  const crmAgentId = crypto.randomUUID();
  const portalAgentId = crypto.randomUUID();

  seedAgent({
    id: builderId,
    workspaceId,
    name: 'Builder Agent',
    role: 'builder',
    status: 'working',
    prefix: 'agent:coder:',
  });
  seedTask({
    id: taskId,
    workspaceId,
    assignedAgentId: builderId,
    status: 'assigned',
  });
  seedAgent({
    id: crmAgentId,
    workspaceId,
    name: 'CRMAgent',
    role: 'crmagent',
    scope: 'task',
    taskId,
  });
  seedAgent({
    id: portalAgentId,
    workspaceId,
    name: 'PortalAgent',
    role: 'portalagent',
    scope: 'task',
    taskId,
  });
  seedTaskSession({
    taskId,
    agentId: builderId,
    openclawSessionId: 'mission-control-builder-agent',
    status: 'ended',
  });

  setGatewaySessionsResolverForTests(async () => buildGatewayPayload(taskId));

  const firstPass = await reconcileTaskRuntimeEvidence(taskId);
  assert.equal(firstPass.recoveredSubagentCount, 2);

  const recoveredSessions = queryAll<{ openclaw_session_id: string; status: string; agent_id: string | null }>(
    `SELECT openclaw_session_id, status, agent_id
     FROM openclaw_sessions
     WHERE task_id = ? AND session_type = 'subagent'
     ORDER BY openclaw_session_id ASC`,
    [taskId],
  );

  assert.equal(recoveredSessions.length, 2);
  assert.deepEqual(
    recoveredSessions.map((session) => session.status),
    ['completed', 'completed'],
  );
  assert.deepEqual(
    recoveredSessions.map((session) => session.agent_id).sort(),
    [crmAgentId, portalAgentId].sort(),
  );

  const secondPass = await reconcileTaskRuntimeEvidence(taskId);
  assert.equal(secondPass.recoveredSubagentCount, 0);
  assert.equal(
    queryOne<{ count: number }>(
      `SELECT COUNT(*) AS count
       FROM openclaw_sessions
       WHERE task_id = ? AND session_type = 'subagent'`,
      [taskId],
    )?.count,
    2,
  );

  const response = await getSubagentRoute(
    new NextRequest(`http://localhost/api/tasks/${taskId}/subagent`),
    { params: { id: taskId } },
  );
  const payload = await response.json() as Array<{ agent_name?: string }>;

  assert.equal(payload.length, 2);
  assert.deepEqual(
    payload.map((session) => session.agent_name).sort(),
    ['CRMAgent', 'PortalAgent'],
  );
});

test('reconcileTaskRuntimeEvidence does not attach unlabeled historical child sessions to a new task that only shares the stable builder key', async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const taskId = buildTaskId('abcddcba');
  const builderId = crypto.randomUUID();

  seedAgent({
    id: builderId,
    workspaceId,
    name: 'Builder Agent',
    role: 'builder',
    status: 'working',
    prefix: 'agent:coder:',
  });
  seedTask({
    id: taskId,
    workspaceId,
    assignedAgentId: builderId,
    status: 'assigned',
  });
  seedTaskSession({
    taskId,
    agentId: builderId,
    openclawSessionId: 'mission-control-builder-agent',
    status: 'ended',
  });
  setGatewaySessionsResolverForTests(async () => ({
    sessions: [
      {
        key: 'agent:coder:mission-control-builder-agent',
        sessionId: 'builder-session-fixture',
        status: 'done',
        childSessions: [
          'agent:coder:subagent:old-crm',
          'agent:coder:subagent:old-portal',
        ],
        endedAt: '2026-03-27T14:00:00.000Z',
      },
      {
        key: 'agent:coder:subagent:old-crm',
        sessionId: 'old-crm-session',
        label: 'crm-agent',
        status: 'done',
        parentSessionKey: 'agent:coder:mission-control-builder-agent',
        spawnedBy: 'agent:coder:mission-control-builder-agent',
        endedAt: '2026-03-26T15:40:33.187Z',
      },
      {
        key: 'agent:coder:subagent:old-portal',
        sessionId: 'old-portal-session',
        label: 'portal-agent',
        status: 'done',
        parentSessionKey: 'agent:coder:mission-control-builder-agent',
        spawnedBy: 'agent:coder:mission-control-builder-agent',
        endedAt: '2026-03-26T15:40:33.256Z',
      },
    ],
  }));

  const response = await getSubagentRoute(
    new NextRequest(`http://localhost/api/tasks/${taskId}/subagent`),
    { params: { id: taskId } },
  );
  const payload = await response.json() as Array<{ openclaw_session_id: string }>;

  assert.deepEqual(payload, []);
});

test('reconcileTaskRuntimeEvidence marks an active root task session terminal when the gateway run has already failed', async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const taskId = buildTaskId('facecafe');
  const builderId = crypto.randomUUID();

  seedAgent({
    id: builderId,
    workspaceId,
    name: 'Builder Agent',
    role: 'builder',
    status: 'working',
    prefix: 'agent:coder:',
  });
  seedTask({
    id: taskId,
    workspaceId,
    assignedAgentId: builderId,
    status: 'in_progress',
  });
  seedTaskSession({
    taskId,
    agentId: builderId,
    openclawSessionId: 'mission-control-builder-agent',
    status: 'active',
  });
  setTaskSessionTimes({
    taskId,
    openclawSessionId: 'mission-control-builder-agent',
    createdAt: '2026-03-26T21:40:00.000Z',
    updatedAt: '2026-03-26T21:40:00.000Z',
    endedAt: null,
  });
  setGatewaySessionsResolverForTests(async () =>
    buildGatewayPayload(taskId, {
      builder: 'failed',
      builderEndedAt: '2026-03-26T21:43:03.511Z',
    }),
  );

  const state = await reconcileTaskRuntimeEvidence(taskId);
  const rootSession = queryOne<{ status: string; ended_at: string | null }>(
    `SELECT status, ended_at
     FROM openclaw_sessions
     WHERE task_id = ? AND session_type = 'persistent'
     ORDER BY created_at DESC
     LIMIT 1`,
    [taskId],
  );

  assert.equal(state.status, 'session_ended');
  assert.notEqual(rootSession?.status, 'active');
  assert.equal(rootSession?.ended_at, '2026-03-26T21:43:03.511Z');
});

test('reconcileTaskRuntimeEvidence keeps a freshly dispatched persistent session active when gateway metadata still reflects the previous run', async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const taskId = buildTaskId('823f865a');
  const builderId = crypto.randomUUID();

  seedAgent({
    id: builderId,
    workspaceId,
    name: 'Carter',
    role: 'builder',
    status: 'working',
    prefix: 'agent:coder:',
  });
  seedTask({
    id: taskId,
    workspaceId,
    assignedAgentId: builderId,
    status: 'in_progress',
  });
  seedTaskSession({
    taskId,
    agentId: builderId,
    openclawSessionId: 'mission-control-carter-55cf1630',
    status: 'active',
  });

  setGatewaySessionsResolverForTests(async () => ({
    sessions: [
      {
        key: 'agent:coder:mission-control-carter-55cf1630',
        sessionId: 'stale-session-id',
        status: 'done',
        channel: 'mission-control',
        updatedAt: '2026-03-27T22:58:47.602Z',
        endedAt: '2026-03-27T22:58:47.602Z',
      },
    ],
  }));

  const state = await reconcileTaskRuntimeEvidence(taskId);
  const rootSession = queryOne<{ status: string; ended_at: string | null }>(
    `SELECT status, ended_at
     FROM openclaw_sessions
     WHERE task_id = ? AND session_type = 'persistent'
     ORDER BY created_at DESC
     LIMIT 1`,
    [taskId],
  );

  assert.deepEqual(
    {
      stateStatus: state.status,
      rootStatus: rootSession?.status,
      rootEndedAt: rootSession?.ended_at,
    },
    {
      stateStatus: 'streaming',
      rootStatus: 'active',
      rootEndedAt: null,
    },
  );
});

test('reconcileTaskRuntimeEvidence keeps a reused persistent session active when sessions.list looks terminal but gateway history shows fresh work', async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const taskId = buildTaskId('70bfb07b');
  const builderId = crypto.randomUUID();

  seedAgent({
    id: builderId,
    workspaceId,
    name: 'Carter',
    role: 'builder',
    status: 'working',
    prefix: 'agent:coder:',
  });
  seedTask({
    id: taskId,
    workspaceId,
    assignedAgentId: builderId,
    status: 'in_progress',
  });
  seedTaskSession({
    taskId,
    agentId: builderId,
    openclawSessionId: 'mission-control-carter-55cf1630',
    status: 'active',
  });
  setTaskSessionTimes({
    taskId,
    openclawSessionId: 'mission-control-carter-55cf1630',
    createdAt: '2026-03-27T23:52:07.550Z',
    updatedAt: '2026-03-27T23:52:07.550Z',
    endedAt: null,
  });

  setGatewaySessionsResolverForTests(async () => ({
    sessions: [
      {
        key: 'agent:coder:mission-control-carter-55cf1630',
        sessionId: 'stale-session-id',
        status: 'done',
        channel: 'mission-control',
        createdAt: '2026-03-27T22:56:44.520Z',
        updatedAt: '2026-03-27T23:55:08.650Z',
      },
    ],
  }));
  setGatewaySessionHistoryResolverForTests(async (sessionRef) => {
    if (sessionRef !== 'agent:coder:mission-control-carter-55cf1630') {
      throw new Error(`unexpected session history lookup for ${sessionRef}`);
    }

    return {
      items: [
        {
          role: 'assistant',
          content: [{ type: 'toolCall', text: '' }],
          timestamp: '2026-03-27T23:55:36.000Z',
        },
        {
          role: 'toolResult',
          content: [{ type: 'text', text: 'Edited repo-task-handoff.ts' }],
          timestamp: '2026-03-27T23:55:37.000Z',
        },
      ],
    };
  });

  const state = await reconcileTaskRuntimeEvidence(taskId);
  const rootSession = queryOne<{ status: string; ended_at: string | null }>(
    `SELECT status, ended_at
     FROM openclaw_sessions
     WHERE task_id = ? AND session_type = 'persistent'
     ORDER BY created_at DESC
     LIMIT 1`,
    [taskId],
  );

  assert.equal(state.status, 'streaming');
  assert.equal(rootSession?.status, 'active');
  assert.equal(rootSession?.ended_at, null);
});

test('deliverables route recovers workspace changes, skips housekeeping files, and stays idempotent', async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const taskId = buildTaskId('f1e2d3c4');
  const workspacePath = createWorkspaceRepo();

  try {
    seedTask({
      id: taskId,
      workspaceId,
      status: 'in_progress',
      workspacePath,
    });
    setGatewaySessionsResolverForTests(async () => ({ sessions: [] }));

    const firstResponse = await getDeliverablesRoute(
      new NextRequest(`http://localhost/api/tasks/${taskId}/deliverables`),
      { params: { id: taskId } },
    );
    const firstPayload = await firstResponse.json() as Array<{ title: string; path?: string }>;

    assert.equal(firstPayload.length, 2);
    assert.deepEqual(
      firstPayload.map((deliverable) => deliverable.title).sort(),
      [
        'services/crm-adapter/src/app.js',
        'services/user-portal/src/pages/DashboardPage.jsx',
      ],
    );
    assert.ok(firstPayload.every((deliverable) => !deliverable.path?.endsWith('.mc-workspace.json')));

    const secondResponse = await getDeliverablesRoute(
      new NextRequest(`http://localhost/api/tasks/${taskId}/deliverables`),
      { params: { id: taskId } },
    );
    const secondPayload = await secondResponse.json() as Array<{ title: string }>;

    assert.equal(secondPayload.length, 2);
    assert.equal(
      queryOne<{ count: number }>(
        'SELECT COUNT(*) AS count FROM task_deliverables WHERE task_id = ?',
        [taskId],
      )?.count,
      2,
    );
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test('agent-stream returns no_session only when the task has no linked session evidence', async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const taskId = buildTaskId('0badc0de');

  seedTask({
    id: taskId,
    workspaceId,
    status: 'assigned',
  });
  setGatewaySessionsResolverForTests(async () => ({ sessions: [] }));

  const abortController = new AbortController();
  const response = await getAgentStreamRoute(
    new NextRequest(`http://localhost/api/tasks/${taskId}/agent-stream`, { signal: abortController.signal }),
    { params: Promise.resolve({ id: taskId }) },
  );
  const event = await readFirstSseEvent(response, abortController);

  assert.equal(event.type, 'no_session');
});

test('agent-stream returns session_ended when only terminal session evidence exists', async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const taskId = buildTaskId('feedbeef');
  const builderId = crypto.randomUUID();

  seedAgent({
    id: builderId,
    workspaceId,
    name: 'Builder Agent',
    role: 'builder',
    status: 'working',
    prefix: 'agent:coder:',
  });
  seedTask({
    id: taskId,
    workspaceId,
    assignedAgentId: builderId,
    status: 'assigned',
  });
  seedTaskSession({
    taskId,
    agentId: builderId,
    openclawSessionId: 'mission-control-builder-agent',
    status: 'ended',
  });
  setGatewaySessionsResolverForTests(async () => buildGatewayPayload(taskId));

  const abortController = new AbortController();
  const response = await getAgentStreamRoute(
    new NextRequest(`http://localhost/api/tasks/${taskId}/agent-stream`, { signal: abortController.signal }),
    { params: Promise.resolve({ id: taskId }) },
  );
  const event = await readFirstSseEvent(response, abortController);

  assert.equal(event.type, 'session_ended');
});

test('getTaskStreamState follows active child sessions even after the builder has ended', async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const taskId = buildTaskId('abcddcba');
  const builderId = crypto.randomUUID();

  seedAgent({
    id: builderId,
    workspaceId,
    name: 'Builder Agent',
    role: 'builder',
    status: 'working',
    prefix: 'agent:coder:',
  });
  seedTask({
    id: taskId,
    workspaceId,
    assignedAgentId: builderId,
    status: 'assigned',
  });
  seedTaskSession({
    taskId,
    agentId: builderId,
    openclawSessionId: 'mission-control-builder-agent',
    status: 'ended',
  });
  setGatewaySessionsResolverForTests(async () => buildGatewayPayload(taskId, { crm: 'running', portal: 'done' }));

  const state = await getTaskStreamState(taskId);

  assert.equal(state.status, 'streaming');
  assert.deepEqual(state.activeSessionKeys, ['agent:coder:subagent:f8951fcf-7a9b-42b5-b2d0-719176823ef0']);
  assert.ok(state.terminalSessionKeys.includes('agent:coder:mission-control-builder-agent'));
});

test('mapGatewaySessionStatus treats endedAt as terminal even when the gateway status string is stale', () => {
  assert.equal(
    mapGatewaySessionStatus('running', '2026-03-26T20:35:49.624Z'),
    'ended',
  );
  assert.equal(mapGatewaySessionStatus('running', null), 'active');
});

test('runHealthCheckCycle suppresses repeated zombie activities once a task is already marked unreconciled', async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const taskId = buildTaskId('deadc0de');
  const builderId = crypto.randomUUID();

  seedAgent({
    id: builderId,
    workspaceId,
    name: 'Builder Agent',
    role: 'builder',
    status: 'working',
    prefix: 'agent:coder:',
  });
  seedTask({
    id: taskId,
    workspaceId,
    assignedAgentId: builderId,
    status: 'assigned',
    planningDispatchError: 'Run ended without completion callback or workflow handoff (ended session).',
  });
  seedTaskSession({
    taskId,
    agentId: builderId,
    openclawSessionId: 'mission-control-builder-agent',
    status: 'ended',
  });

  const before = queryOne<{ count: number }>(
    `SELECT COUNT(*) AS count
     FROM task_activities
     WHERE task_id = ? AND message LIKE 'Agent health:%'`,
    [taskId],
  )?.count || 0;

  await runHealthCheckCycle();

  const after = queryOne<{ count: number }>(
    `SELECT COUNT(*) AS count
     FROM task_activities
     WHERE task_id = ? AND message LIKE 'Agent health:%'`,
    [taskId],
  )?.count || 0;

  assert.equal(after, before);
});

test('runHealthCheckCycle suppresses transient zombie noise right after a terminal task run ends', async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const taskId = buildTaskId('c10se0ut');
  const reviewerId = crypto.randomUUID();
  const now = new Date();
  const endedAt = new Date(now.getTime() - 5_000).toISOString();

  seedAgent({
    id: reviewerId,
    workspaceId,
    name: 'Reviewer Agent',
    role: 'reviewer',
    status: 'working',
    prefix: 'agent:main:',
  });
  seedTask({
    id: taskId,
    workspaceId,
    assignedAgentId: reviewerId,
    status: 'verification',
  });
  seedTaskSession({
    taskId,
    agentId: reviewerId,
    openclawSessionId: 'mission-control-reviewer-agent',
    status: 'completed',
  });
  setTaskSessionTimes({
    taskId,
    openclawSessionId: 'mission-control-reviewer-agent',
    createdAt: endedAt,
    updatedAt: endedAt,
    endedAt,
  });
  setGatewaySessionHistoryResolverForTests(async () => ({ items: [] }));

  const before = queryOne<{ count: number }>(
    `SELECT COUNT(*) AS count
     FROM task_activities
     WHERE task_id = ? AND message LIKE 'Agent health:%'`,
    [taskId],
  )?.count || 0;

  await runHealthCheckCycle();

  const after = queryOne<{ count: number }>(
    `SELECT COUNT(*) AS count
     FROM task_activities
     WHERE task_id = ? AND message LIKE 'Agent health:%'`,
    [taskId],
  )?.count || 0;

  assert.equal(after, before);
});

test('task delete clears non-cascading task references before removing the task', async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const taskId = buildTaskId('d371e777');
  const builderId = crypto.randomUUID();
  const taskScopedAgentId = crypto.randomUUID();
  const productId = crypto.randomUUID();
  const productSkillId = crypto.randomUUID();
  const trashRoot = mkdtempSync(path.join(os.tmpdir(), 'mission-control-trash-'));
  const workspacePath = mkdtempSync(path.join(os.tmpdir(), 'mission-control-delete-workspace-'));
  const previousTrashRoot = process.env.MISSION_CONTROL_TRASH_DIR;

  seedAgent({
    id: builderId,
    workspaceId,
    name: 'Builder Agent',
    role: 'builder',
    status: 'working',
    prefix: 'agent:coder:',
  });
  seedTask({
    id: taskId,
    workspaceId,
    assignedAgentId: builderId,
    status: 'verification',
    workspacePath,
  });
  seedAgent({
    id: taskScopedAgentId,
    workspaceId,
    name: 'CRMAgent',
    role: 'crmagent',
    scope: 'task',
    taskId,
  });
  seedProduct({ id: productId, workspaceId });
  seedTaskSession({
    taskId,
    agentId: builderId,
    openclawSessionId: 'mission-control-reviewer-agent',
    status: 'active',
  });

  run(
    `INSERT INTO planning_specs (id, task_id, spec_markdown, locked_at, created_at)
     VALUES (?, ?, 'spec', datetime('now'), datetime('now'))`,
    [crypto.randomUUID(), taskId],
  );
  run(
    `INSERT INTO agent_health
      (id, agent_id, task_id, health_state, updated_at)
     VALUES (?, ?, ?, 'working', datetime('now'))`,
    [crypto.randomUUID(), builderId, taskId],
  );
  run(
    `INSERT INTO workspace_ports (id, task_id, port, status, created_at)
     VALUES (?, ?, 4500, 'active', datetime('now'))`,
    [crypto.randomUUID(), taskId],
  );
  run(
    `INSERT INTO product_skills
      (id, product_id, skill_type, title, steps, created_by_task_id, created_at, updated_at)
     VALUES (?, ?, 'test', 'Task-born skill', 'step 1', ?, datetime('now'), datetime('now'))`,
    [productSkillId, productId, taskId],
  );

  process.env.MISSION_CONTROL_TRASH_DIR = trashRoot;

  const response = await deleteTaskRoute(
    new NextRequest(`http://localhost/api/tasks/${taskId}`, { method: 'DELETE' }),
    { params: Promise.resolve({ id: taskId }) },
  );
  const payload = await response.json() as { success?: boolean; error?: string };

  if (previousTrashRoot === undefined) {
    delete process.env.MISSION_CONTROL_TRASH_DIR;
  } else {
    process.env.MISSION_CONTROL_TRASH_DIR = previousTrashRoot;
  }

  assert.equal(response.status, 200);
  assert.equal(payload.success, true);
  assert.equal(
    queryOne<{ count: number }>('SELECT COUNT(*) AS count FROM tasks WHERE id = ?', [taskId])?.count,
    0,
  );
  assert.equal(
    queryOne<{ count: number }>('SELECT COUNT(*) AS count FROM openclaw_sessions WHERE task_id = ?', [taskId])?.count,
    0,
  );
  assert.equal(
    queryOne<{ count: number }>('SELECT COUNT(*) AS count FROM workspace_ports WHERE task_id = ?', [taskId])?.count,
    0,
  );
  assert.equal(
    queryOne<{ count: number }>('SELECT COUNT(*) AS count FROM planning_specs WHERE task_id = ?', [taskId])?.count,
    0,
  );
  assert.equal(
    queryOne<{ count: number }>('SELECT COUNT(*) AS count FROM agents WHERE id = ?', [taskScopedAgentId])?.count,
    0,
  );
  assert.equal(
    queryOne<{ count: number }>('SELECT COUNT(*) AS count FROM agent_health WHERE task_id = ?', [taskId])?.count,
    0,
  );
  assert.equal(
    queryOne<{ created_by_task_id: string | null }>(
      'SELECT created_by_task_id FROM product_skills WHERE id = ?',
      [productSkillId],
    )?.created_by_task_id,
    null,
  );
  assert.equal(existsSync(workspacePath), false);
  assert.deepEqual(readdirSync(trashRoot), [path.basename(workspacePath)]);

  rmSync(trashRoot, { recursive: true, force: true });
});

test('runHealthCheckCycle reconciles stale active subagent rows before deciding whether to log zombie noise', async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const taskId = buildTaskId('feedface');
  const builderId = crypto.randomUUID();

  seedAgent({
    id: builderId,
    workspaceId,
    name: 'Builder Agent',
    role: 'builder',
    status: 'working',
    prefix: 'agent:coder:',
  });
  seedTask({
    id: taskId,
    workspaceId,
    assignedAgentId: builderId,
    status: 'assigned',
    planningDispatchError: 'Run ended without completion callback or workflow handoff (ended session).',
  });
  seedTaskSession({
    taskId,
    agentId: builderId,
    openclawSessionId: 'mission-control-builder-agent',
    status: 'ended',
  });
  seedTaskSession({
    taskId,
    agentId: builderId,
    openclawSessionId: 'agent:coder:subagent:f8951fcf-7a9b-42b5-b2d0-719176823ef0',
    status: 'active',
    sessionType: 'subagent',
  });
  setGatewaySessionsResolverForTests(async () => buildGatewayPayload(taskId, { crm: 'done', portal: 'done' }));

  const before = queryOne<{ count: number }>(
    `SELECT COUNT(*) AS count
     FROM task_activities
     WHERE task_id = ? AND message LIKE 'Agent health:%'`,
    [taskId],
  )?.count || 0;

  await runHealthCheckCycle();

  const after = queryOne<{ count: number }>(
    `SELECT COUNT(*) AS count
     FROM task_activities
     WHERE task_id = ? AND message LIKE 'Agent health:%'`,
    [taskId],
  )?.count || 0;
  const reconciledSession = queryOne<{ status: string; ended_at: string | null }>(
    `SELECT status, ended_at
     FROM openclaw_sessions
     WHERE task_id = ? AND openclaw_session_id = ?`,
    [taskId, 'agent:coder:subagent:f8951fcf-7a9b-42b5-b2d0-719176823ef0'],
  );

  assert.equal(after, before);
  assert.equal(reconciledSession?.status, 'completed');
  assert.ok(reconciledSession?.ended_at);
});

test('runHealthCheckCycle also suppresses zombie noise after an explicit blocked builder outcome', async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const taskId = buildTaskId('deadb10c');
  const builderId = crypto.randomUUID();

  seedAgent({
    id: builderId,
    workspaceId,
    name: 'Builder Agent',
    role: 'builder',
    status: 'standby',
    prefix: 'agent:coder:',
  });
  seedTask({
    id: taskId,
    workspaceId,
    assignedAgentId: builderId,
    status: 'assigned',
    planningDispatchError: 'Blocked: workspace deadlock | need: refreshed isolated workspace',
  });
  seedTaskSession({
    taskId,
    agentId: builderId,
    openclawSessionId: 'mission-control-builder-agent',
    status: 'ended',
  });

  const before = queryOne<{ count: number }>(
    `SELECT COUNT(*) AS count
     FROM task_activities
     WHERE task_id = ? AND message LIKE 'Agent health:%'`,
    [taskId],
  )?.count || 0;

  await runHealthCheckCycle();

  const after = queryOne<{ count: number }>(
    `SELECT COUNT(*) AS count
     FROM task_activities
     WHERE task_id = ? AND message LIKE 'Agent health:%'`,
    [taskId],
  )?.count || 0;

  assert.equal(after, before);
});

test('runHealthCheckCycle advances a task when gateway transcript history contains a missed TASK_COMPLETE marker', async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const taskId = buildTaskId('c001c0de');
  const builderId = crypto.randomUUID();
  const testerId = crypto.randomUUID();

  seedAgent({
    id: builderId,
    workspaceId,
    name: 'Builder Agent',
    role: 'builder',
    status: 'working',
    prefix: 'agent:coder:',
  });
  seedAgent({
    id: testerId,
    workspaceId,
    name: 'Tester Agent',
    role: 'tester',
    status: 'standby',
  });
  seedTask({
    id: taskId,
    workspaceId,
    assignedAgentId: builderId,
    status: 'in_progress',
  });
  run(
    `INSERT INTO task_roles (id, task_id, role, agent_id, created_at)
     VALUES (?, ?, 'builder', ?, datetime('now'))`,
    [crypto.randomUUID(), taskId, builderId],
  );
  run(
    `INSERT INTO task_roles (id, task_id, role, agent_id, created_at)
     VALUES (?, ?, 'tester', ?, datetime('now'))`,
    [crypto.randomUUID(), taskId, testerId],
  );
  seedTaskSession({
    taskId,
    agentId: builderId,
    openclawSessionId: 'mission-control-builder-agent',
    status: 'active',
  });
  setTaskSessionTimes({
    taskId,
    openclawSessionId: 'mission-control-builder-agent',
    createdAt: '2026-03-26T21:40:00.000Z',
    updatedAt: '2026-03-26T21:40:00.000Z',
    endedAt: null,
  });
  setGatewaySessionsResolverForTests(async () =>
    buildGatewayPayload(taskId, {
      builder: 'done',
      builderEndedAt: '2026-03-26T21:43:03.511Z',
    }),
  );
  setGatewaySessionHistoryResolverForTests(async () => ({
    items: [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'TASK_COMPLETE: Implemented the validator workflow' }],
      },
    ],
  }));

  const originalFetch = global.fetch;
  global.fetch = async () => new Response('{}', { status: 200 });

  try {
    await runHealthCheckCycle();
  } finally {
    global.fetch = originalFetch;
  }

  const task = queryOne<{ status: string; assigned_agent_id: string; planning_dispatch_error: string | null }>(
    'SELECT status, assigned_agent_id, planning_dispatch_error FROM tasks WHERE id = ?',
    [taskId],
  );

  assert.equal(task?.status, 'testing');
  assert.equal(task?.assigned_agent_id, testerId);
  assert.equal(task?.planning_dispatch_error, null);
});

test('runHealthCheckCycle turns a terminal runtime error into an explicit blocker instead of the generic unreconciled error', async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const taskId = buildTaskId('c001d00d');
  const builderId = crypto.randomUUID();

  seedAgent({
    id: builderId,
    workspaceId,
    name: 'Builder Agent',
    role: 'builder',
    status: 'working',
    prefix: 'agent:coder:',
  });
  seedTask({
    id: taskId,
    workspaceId,
    assignedAgentId: builderId,
    status: 'in_progress',
  });
  seedTaskSession({
    taskId,
    agentId: builderId,
    openclawSessionId: 'mission-control-builder-agent',
    status: 'active',
  });
  setTaskSessionTimes({
    taskId,
    openclawSessionId: 'mission-control-builder-agent',
    createdAt: '2026-03-26T21:40:00.000Z',
    updatedAt: '2026-03-26T21:40:00.000Z',
    endedAt: null,
  });
  setGatewaySessionsResolverForTests(async () =>
    buildGatewayPayload(taskId, {
      builder: 'failed',
      builderEndedAt: '2026-03-26T21:43:03.511Z',
    }),
  );
  setGatewaySessionHistoryResolverForTests(async () => ({
    items: [
      {
        role: 'assistant',
        errorMessage: 'You have hit your ChatGPT usage limit (team plan). Try again in ~92 min.',
        stopReason: 'error',
      },
    ],
  }));

  const before = queryOne<{ count: number }>(
    `SELECT COUNT(*) AS count
     FROM task_activities
     WHERE task_id = ? AND message LIKE 'Agent health:%'`,
    [taskId],
  )?.count || 0;

  await runHealthCheckCycle();

  const after = queryOne<{ count: number }>(
    `SELECT COUNT(*) AS count
     FROM task_activities
     WHERE task_id = ? AND message LIKE 'Agent health:%'`,
    [taskId],
  )?.count || 0;
  const task = queryOne<{ planning_dispatch_error: string | null; status_reason: string | null }>(
    'SELECT planning_dispatch_error, status_reason FROM tasks WHERE id = ?',
    [taskId],
  );
  const rootSession = queryOne<{ status: string; ended_at: string | null }>(
    `SELECT status, ended_at
     FROM openclaw_sessions
     WHERE task_id = ? AND session_type = 'persistent'
     ORDER BY created_at DESC
     LIMIT 1`,
    [taskId],
  );
  const agent = queryOne<{ status: string }>('SELECT status FROM agents WHERE id = ?', [builderId]);

  assert.equal(after, before);
  assert.equal(rootSession?.status, 'failed');
  assert.equal(rootSession?.ended_at, '2026-03-26T21:43:03.511Z');
  assert.equal(
    task?.planning_dispatch_error,
    'Blocked: OpenClaw runtime failure: You have hit your ChatGPT usage limit (team plan). Try again in ~92 min.',
  );
  assert.equal(
    task?.status_reason,
    'Blocked: OpenClaw runtime failure: You have hit your ChatGPT usage limit (team plan). Try again in ~92 min.',
  );
  assert.equal(agent?.status, 'standby');
});

test('runHealthCheckCycle auto-dispatches stale assigned tasks without logging zombie noise', async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const taskId = buildTaskId('b0b0b0b0');
  const builderId = crypto.randomUUID();
  const staleUpdatedAt = new Date(Date.now() - 3 * 60 * 1000).toISOString();

  seedAgent({
    id: builderId,
    workspaceId,
    name: 'Builder Agent',
    role: 'builder',
    status: 'standby',
    prefix: 'agent:coder:',
  });
  seedTask({
    id: taskId,
    workspaceId,
    assignedAgentId: builderId,
    status: 'assigned',
  });
  run(
    `UPDATE tasks
     SET planning_complete = 1,
         updated_at = ?,
         planning_spec = ?
     WHERE id = ?`,
    [
      staleUpdatedAt,
      JSON.stringify({
        title: 'Runtime evidence task',
        summary: 'Recover orphaned assigned dispatches.',
        deliverables: ['builder session'],
        success_criteria: ['task dispatches'],
        constraints: {},
      }),
      taskId,
    ],
  );
  run(
    `INSERT INTO task_roles (id, task_id, role, agent_id, created_at)
     VALUES (?, ?, 'builder', ?, datetime('now'))`,
    [crypto.randomUUID(), taskId, builderId],
  );

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
    if (args[0] === 'chat.send') return {};
    throw new Error(`Unexpected gateway call: ${JSON.stringify(args)}`);
  };

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

  await runHealthCheckCycle();

  const task = queryOne<{ status: string; planning_dispatch_error: string | null }>(
    'SELECT status, planning_dispatch_error FROM tasks WHERE id = ?',
    [taskId],
  );
  assert.equal(task?.status, 'in_progress');
  assert.equal(task?.planning_dispatch_error, null);

  const autoDispatchActivities = queryAll<{ message: string }>(
    `SELECT message
     FROM task_activities
     WHERE task_id = ? AND message = 'Auto-dispatched by health sweeper (was stuck in assigned)'`,
    [taskId],
  );
  const zombieActivities = queryAll<{ message: string }>(
    `SELECT message
     FROM task_activities
     WHERE task_id = ? AND message LIKE 'Agent health:%'`,
    [taskId],
  );
  assert.equal(autoDispatchActivities.length, 1);
  assert.equal(zombieActivities.length, 0);
});

test('runHealthCheckCycle keeps the generic unreconciled error when history has no marker or terminal error', async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const taskId = buildTaskId('c001fade');
  const builderId = crypto.randomUUID();

  seedAgent({
    id: builderId,
    workspaceId,
    name: 'Builder Agent',
    role: 'builder',
    status: 'working',
    prefix: 'agent:coder:',
  });
  seedTask({
    id: taskId,
    workspaceId,
    assignedAgentId: builderId,
    status: 'in_progress',
  });
  seedTaskSession({
    taskId,
    agentId: builderId,
    openclawSessionId: 'mission-control-builder-agent',
    status: 'active',
  });
  setTaskSessionTimes({
    taskId,
    openclawSessionId: 'mission-control-builder-agent',
    createdAt: '2026-03-26T21:40:00.000Z',
    updatedAt: '2026-03-26T21:40:00.000Z',
    endedAt: null,
  });
  setGatewaySessionsResolverForTests(async () =>
    buildGatewayPayload(taskId, {
      builder: 'failed',
      builderEndedAt: '2026-03-26T21:43:03.511Z',
    }),
  );
  setGatewaySessionHistoryResolverForTests(async () => ({
    items: [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'I was working, but the transcript has no final marker yet.' }],
      },
    ],
  }));

  await runHealthCheckCycle();

  const task = queryOne<{ planning_dispatch_error: string | null; status_reason: string | null }>(
    'SELECT planning_dispatch_error, status_reason FROM tasks WHERE id = ?',
    [taskId],
  );
  const zombieActivities = queryAll<{ message: string }>(
    `SELECT message
     FROM task_activities
     WHERE task_id = ? AND message LIKE 'Agent health:%'`,
    [taskId],
  );

  assert.equal(
    task?.planning_dispatch_error,
    'Run ended without completion callback or workflow handoff (failed session).',
  );
  assert.equal(
    task?.status_reason,
    'Run ended without completion callback or workflow handoff (failed session).',
  );
  assert.equal(zombieActivities.length, 0);
});

test('runHealthCheckCycle preserves queued builder waiting state instead of rewriting a queued task to the generic ended-session banner', async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const builderId = crypto.randomUUID();
  const activeTaskId = buildTaskId('feedbead');
  const queuedTaskId = buildTaskId('beadfeed');

  seedAgent({
    id: builderId,
    workspaceId,
    name: 'Builder Agent',
    role: 'builder',
    status: 'working',
    prefix: 'agent:coder:',
  });
  seedTask({
    id: activeTaskId,
    workspaceId,
    assignedAgentId: builderId,
    status: 'in_progress',
  });
  seedTask({
    id: queuedTaskId,
    workspaceId,
    assignedAgentId: builderId,
    status: 'assigned',
    planningDispatchError: 'Run ended without completion callback or workflow handoff (ended session).',
  });
  run(
    `UPDATE tasks
     SET status_reason = 'Run ended without completion callback or workflow handoff (ended session).'
     WHERE id = ?`,
    [queuedTaskId],
  );
  seedTaskSession({
    taskId: activeTaskId,
    agentId: builderId,
    openclawSessionId: 'mission-control-builder-agent',
    status: 'active',
  });
  seedTaskSession({
    taskId: queuedTaskId,
    agentId: builderId,
    openclawSessionId: 'mission-control-builder-agent',
    status: 'ended',
    activeTaskId: null,
  });
  setGatewaySessionsResolverForTests(async () => ({
    sessions: [
      {
        key: 'agent:coder:mission-control-builder-agent',
        sessionId: 'runtime-builder-session',
        status: 'running',
        channel: 'mission-control',
        updatedAt: Date.now(),
      },
    ],
  }));

  await runHealthCheckCycle();

  const queuedTask = queryOne<{ planning_dispatch_error: string | null; status_reason: string | null }>(
    'SELECT planning_dispatch_error, status_reason FROM tasks WHERE id = ?',
    [queuedTaskId],
  );
  const genericErrorActivities = queryAll<{ message: string }>(
    `SELECT message
     FROM task_activities
     WHERE task_id = ?
       AND message = 'Run ended without completion callback or workflow handoff (ended session).'`,
    [queuedTaskId],
  );

  assert.equal(queuedTask?.planning_dispatch_error, null);
  assert.equal(
    queuedTask?.status_reason,
    'Waiting for Builder Agent to finish "Runtime evidence task" before starting this task.',
  );
  assert.equal(genericErrorActivities.length, 0);
});

test('runHealthCheckCycle retries generic unreconciled errors when gateway history now contains a verifier signal', async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const taskId = buildTaskId('feedfade');
  const reviewerId = crypto.randomUUID();

  seedAgent({
    id: reviewerId,
    workspaceId,
    name: 'Reviewer Agent',
    role: 'reviewer',
    status: 'working',
  });
  seedTask({
    id: taskId,
    workspaceId,
    assignedAgentId: reviewerId,
    status: 'verification',
    planningDispatchError: 'Run ended without completion callback or workflow handoff (completed session).',
  });
  seedTaskSession({
    taskId,
    agentId: reviewerId,
    openclawSessionId: 'mission-control-reviewer-agent-1234',
    status: 'completed',
  });
  setGatewaySessionsResolverForTests(async () => ({
    sessions: [
      {
        key: 'agent:main:mission-control-reviewer-agent-1234',
        sessionId: 'ephemeral-review-session',
        status: 'done',
        channel: 'mission-control',
        updatedAt: 1774541400000,
        endedAt: '2026-03-27T16:07:32.000Z',
      },
    ],
  }));
  setGatewaySessionHistoryResolverForTests(async (sessionRef) => {
    if (sessionRef === 'agent:main:mission-control-reviewer-agent-1234') {
      return {
        items: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'VERIFY_PASS: Ready to merge' }],
          },
        ],
      };
    }

    throw new Error(`unexpected session history lookup for ${sessionRef}`);
  });

  await runHealthCheckCycle();

  const task = queryOne<{ status: string; planning_dispatch_error: string | null; status_reason: string | null }>(
    'SELECT status, planning_dispatch_error, status_reason FROM tasks WHERE id = ?',
    [taskId],
  );
  assert.equal(task?.status, 'done');
  assert.equal(task?.planning_dispatch_error, null);
  assert.equal(task?.status_reason, null);
});

test('runHealthCheckCycle recovers a first-pass verifier success from gateway history without a prior generic error', async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const taskId = buildTaskId('5f97e299');
  const reviewerId = crypto.randomUUID();

  seedAgent({
    id: reviewerId,
    workspaceId,
    name: 'Reviewer Agent',
    role: 'reviewer',
    status: 'working',
  });
  seedTask({
    id: taskId,
    workspaceId,
    assignedAgentId: reviewerId,
    status: 'verification',
  });
  seedTaskSession({
    taskId,
    agentId: reviewerId,
    openclawSessionId: 'mission-control-reviewer-agent-58ace9f0',
    status: 'completed',
  });
  setGatewaySessionsResolverForTests(async () => ({
    sessions: [
      {
        key: 'agent:main:mission-control-reviewer-agent-58ace9f0',
        sessionId: 'ephemeral-review-session',
        status: 'done',
        channel: 'mission-control',
        updatedAt: 1774652392800,
        endedAt: '2026-03-27T22:59:52.821Z',
      },
    ],
  }));
  setGatewaySessionHistoryResolverForTests(async (sessionRef) => {
    if (sessionRef === 'agent:main:mission-control-reviewer-agent-58ace9f0') {
      return {
        items: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'VERIFY_PASS: The repo-backed verification passed cleanly.' }],
          },
        ],
      };
    }

    throw new Error(`unexpected session history lookup for ${sessionRef}`);
  });

  await runHealthCheckCycle();

  const task = queryOne<{ status: string; planning_dispatch_error: string | null; status_reason: string | null }>(
    'SELECT status, planning_dispatch_error, status_reason FROM tasks WHERE id = ?',
    [taskId],
  );
  const completionActivity = queryOne<{ message: string | null }>(
    `SELECT message
     FROM task_activities
     WHERE task_id = ? AND activity_type = 'completed'
     ORDER BY created_at DESC
     LIMIT 1`,
    [taskId],
  );

  assert.equal(task?.status, 'done');
  assert.equal(task?.planning_dispatch_error, null);
  assert.equal(task?.status_reason, null);
  assert.equal(completionActivity?.message, 'The repo-backed verification passed cleanly.');
});

test('openclaw status route triggers immediate unreconciled run recovery for ended verifier sessions', async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const taskId = buildTaskId('statusrecover');
  const reviewerId = crypto.randomUUID();

  seedAgent({
    id: reviewerId,
    workspaceId,
    name: 'Reviewer Agent',
    role: 'reviewer',
    status: 'working',
  });
  seedTask({
    id: taskId,
    workspaceId,
    assignedAgentId: reviewerId,
    status: 'verification',
    planningDispatchError: 'Run ended without completion callback or workflow handoff (completed session).',
  });
  seedTaskSession({
    taskId,
    agentId: reviewerId,
    openclawSessionId: 'mission-control-reviewer-agent-statusrecover',
    status: 'completed',
  });

  setGatewaySessionsResolverForTests(async () => ({
    sessions: [
      {
        key: 'agent:main:mission-control-reviewer-agent-statusrecover',
        sessionId: 'ephemeral-review-session',
        status: 'done',
        channel: 'mission-control',
        updatedAt: 1774541400000,
        endedAt: '2026-03-27T16:07:32.000Z',
      },
    ],
  }));
  setGatewaySessionHistoryResolverForTests(async (sessionRef) => {
    if (sessionRef === 'agent:main:mission-control-reviewer-agent-statusrecover') {
      return {
        items: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'VERIFY_PASS: Status route closed the loop.' }],
          },
        ],
      };
    }

    throw new Error(`unexpected session history lookup for ${sessionRef}`);
  });

  const client = getOpenClawClient() as unknown as {
    isConnected: () => boolean;
    connect: () => Promise<void>;
    listSessions: () => Promise<unknown[]>;
  };
  client.isConnected = () => true;
  client.connect = async () => undefined;
  client.listSessions = async () => [
    {
      key: 'agent:main:mission-control-reviewer-agent-statusrecover',
      sessionId: 'ephemeral-review-session',
      status: 'done',
      channel: 'mission-control',
      endedAt: '2026-03-27T16:07:32.000Z',
    },
  ];

  const response = await getOpenClawStatusRoute();
  const payload = await response.json();
  const task = queryOne<{ status: string; planning_dispatch_error: string | null; status_reason: string | null }>(
    'SELECT status, planning_dispatch_error, status_reason FROM tasks WHERE id = ?',
    [taskId],
  );

  assert.equal(response.status, 200);
  assert.equal(payload.recovered_runs, 1);
  assert.equal(task?.status, 'done');
  assert.equal(task?.planning_dispatch_error, null);
  assert.equal(task?.status_reason, null);
});

test('openclaw status route clears a false unreconciled error when a reused builder lane is still streaming', async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const taskId = buildTaskId('streamlive');
  const builderId = crypto.randomUUID();
  const activeSessionId = crypto.randomUUID();
  const endedSessionId = crypto.randomUUID();
  const sessionKey = 'agent:coder:mission-control-builder-agent-streamlive';
  const sessionId = 'mission-control-builder-agent-streamlive';

  seedAgent({
    id: builderId,
    workspaceId,
    name: 'Builder Agent',
    role: 'builder',
    status: 'working',
  });
  seedTask({
    id: taskId,
    workspaceId,
    assignedAgentId: builderId,
    status: 'in_progress',
    planningDispatchError: 'Run ended without completion callback or workflow handoff (ended session).',
  });
  seedTaskSession({
    id: endedSessionId,
    taskId,
    agentId: builderId,
    openclawSessionId: sessionId,
    status: 'ended',
  });
  seedTaskSession({
    id: activeSessionId,
    taskId,
    agentId: builderId,
    openclawSessionId: sessionId,
    status: 'active',
  });
  run(
    `UPDATE openclaw_sessions
     SET session_key = ?, updated_at = '2026-04-05T15:40:05.446Z'
     WHERE id IN (?, ?)`,
    [sessionKey, activeSessionId, endedSessionId],
  );
  run(
    `UPDATE openclaw_sessions
     SET ended_at = '2026-04-05T15:40:05.165Z', active_task_id = NULL
     WHERE id = ?`,
    [endedSessionId],
  );

  setGatewaySessionsResolverForTests(async () => ({
    sessions: [
      {
        key: sessionKey,
        sessionId: 'runtime-streamlive',
        status: 'running',
        channel: 'mission-control',
        updatedAt: 1775404381000,
      },
    ],
  }));

  const client = getOpenClawClient() as unknown as {
    isConnected: () => boolean;
    connect: () => Promise<void>;
    listSessions: () => Promise<unknown[]>;
  };
  client.isConnected = () => true;
  client.connect = async () => undefined;
  client.listSessions = async () => [
    {
      key: sessionKey,
      sessionId: 'runtime-streamlive',
      status: 'running',
      channel: 'mission-control',
    },
  ];

  const response = await getOpenClawStatusRoute();
  const payload = await response.json();
  const task = queryOne<{ status: string; planning_dispatch_error: string | null; status_reason: string | null }>(
    'SELECT status, planning_dispatch_error, status_reason FROM tasks WHERE id = ?',
    [taskId],
  );

  assert.equal(response.status, 200);
  assert.equal(payload.recovered_runs, 0);
  assert.equal(task?.status, 'in_progress');
  assert.equal(task?.planning_dispatch_error, null);
  assert.equal(task?.status_reason, null);
});

test('runHealthCheckCycle records at most one generic unreconciled-run activity per ended session', async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const taskId = buildTaskId('dedupe123');
  const testerId = crypto.randomUUID();

  seedAgent({
    id: testerId,
    workspaceId,
    name: 'Tester Agent',
    role: 'tester',
    status: 'working',
  });
  seedTask({
    id: taskId,
    workspaceId,
    assignedAgentId: testerId,
    status: 'testing',
    planningDispatchError: 'Run ended without completion callback or workflow handoff (completed session).',
  });
  seedTaskSession({
    taskId,
    agentId: testerId,
    openclawSessionId: 'mission-control-tester-agent-dedupe',
    status: 'completed',
  });
  setTaskSessionTimes({
    taskId,
    openclawSessionId: 'mission-control-tester-agent-dedupe',
    createdAt: '2026-03-27T16:07:00.000Z',
    updatedAt: '2026-03-27T16:07:30.000Z',
    endedAt: '2026-03-27T16:07:30.000Z',
  });

  setGatewaySessionsResolverForTests(async () => ({
    sessions: [
      {
        key: 'agent:main:mission-control-tester-agent-dedupe',
        sessionId: 'ephemeral-dedupe-session',
        status: 'done',
        channel: 'mission-control',
        createdAt: '2026-03-27T16:07:00.000Z',
        updatedAt: '2026-03-27T16:07:30.000Z',
        endedAt: '2026-03-27T16:07:30.000Z',
      },
    ],
  }));
  setGatewaySessionHistoryResolverForTests(async (sessionRef) => {
    if (sessionRef === 'agent:main:mission-control-tester-agent-dedupe') {
      return {
        items: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'I asked a question and ended without a workflow marker.' }],
          },
        ],
      };
    }

    throw new Error(`unexpected session history lookup for ${sessionRef}`);
  });

  await runHealthCheckCycle();
  await runHealthCheckCycle();

  const activities = queryAll<{ message: string }>(
    `SELECT message
     FROM task_activities
     WHERE task_id = ?
       AND message = 'Run ended without completion callback or workflow handoff (completed session).'
     ORDER BY created_at ASC`,
    [taskId],
  );

  assert.equal(activities.length, 1);
});

test('runHealthCheckCycle prefers the currently assigned reviewer session over older persistent tester sessions', async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const taskId = buildTaskId('5f97e299');
  const reviewerId = crypto.randomUUID();
  const testerId = crypto.randomUUID();
  const testerSessionId = crypto.randomUUID();
  const reviewerSessionId = crypto.randomUUID();

  seedAgent({
    id: reviewerId,
    workspaceId,
    name: 'Reviewer Agent',
    role: 'reviewer',
    status: 'working',
  });
  seedAgent({
    id: testerId,
    workspaceId,
    name: 'Tester Agent',
    role: 'tester',
    status: 'standby',
  });
  seedTask({
    id: taskId,
    workspaceId,
    assignedAgentId: reviewerId,
    status: 'verification',
  });
  seedTaskSession({
    id: testerSessionId,
    taskId,
    agentId: testerId,
    openclawSessionId: 'mission-control-tester-agent-0ad3e265',
    status: 'ended',
  });
  seedTaskSession({
    id: reviewerSessionId,
    taskId,
    agentId: reviewerId,
    openclawSessionId: 'mission-control-reviewer-agent-58ace9f0',
    status: 'ended',
  });
  run(`UPDATE openclaw_sessions SET updated_at = '2026-03-27T22:59:52.821Z', ended_at = '2026-03-27T22:59:52.821Z' WHERE id IN (?, ?)`, [
    testerSessionId,
    reviewerSessionId,
  ]);

  setGatewaySessionsResolverForTests(async () => ({
    sessions: [
      {
        key: 'agent:main:mission-control-tester-agent-0ad3e265',
        sessionId: 'ephemeral-test-session',
        status: 'done',
        channel: 'mission-control',
        updatedAt: 1774652392800,
        endedAt: '2026-03-27T22:59:52.821Z',
      },
      {
        key: 'agent:main:mission-control-reviewer-agent-58ace9f0',
        sessionId: 'ephemeral-review-session',
        status: 'done',
        channel: 'mission-control',
        updatedAt: 1774652392800,
        endedAt: '2026-03-27T22:59:52.821Z',
      },
    ],
  }));
  setGatewaySessionHistoryResolverForTests(async (sessionRef) => {
    if (sessionRef === 'agent:main:mission-control-reviewer-agent-58ace9f0') {
      return {
        items: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'VERIFY_PASS: Recovered the correct reviewer outcome.' }],
          },
        ],
      };
    }

    if (sessionRef === 'agent:main:mission-control-tester-agent-0ad3e265') {
      return {
        items: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'TEST_PASS: Older tester outcome that should be ignored.' }],
          },
        ],
      };
    }

    throw new Error(`unexpected session history lookup for ${sessionRef}`);
  });

  await runHealthCheckCycle();

  const task = queryOne<{ status: string; planning_dispatch_error: string | null; status_reason: string | null }>(
    'SELECT status, planning_dispatch_error, status_reason FROM tasks WHERE id = ?',
    [taskId],
  );
  const completionActivity = queryOne<{ message: string | null }>(
    `SELECT message
     FROM task_activities
     WHERE task_id = ? AND activity_type = 'completed'
     ORDER BY created_at DESC
     LIMIT 1`,
    [taskId],
  );

  assert.equal(task?.status, 'done');
  assert.equal(task?.planning_dispatch_error, null);
  assert.equal(task?.status_reason, null);
  assert.equal(completionActivity?.message, 'Recovered the correct reviewer outcome.');
});

test('runHealthCheckCycle prefers the latest persistent task session over newer subagent rows when recovering verifier success', async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const taskId = buildTaskId('feedbeef');
  const reviewerId = crypto.randomUUID();
  const subagentId = crypto.randomUUID();
  const reviewerSessionId = crypto.randomUUID();
  const subagentSessionId = crypto.randomUUID();

  seedAgent({
    id: reviewerId,
    workspaceId,
    name: 'Reviewer Agent',
    role: 'reviewer',
    status: 'working',
  });
  seedTask({
    id: taskId,
    workspaceId,
    assignedAgentId: reviewerId,
    status: 'verification',
  });
  seedAgent({
    id: subagentId,
    workspaceId,
    name: 'PortalAgent',
    role: 'builder',
    status: 'standby',
    prefix: 'agent:coder:',
    scope: 'task',
    taskId,
  });
  seedTaskSession({
    id: reviewerSessionId,
    taskId,
    agentId: reviewerId,
    openclawSessionId: 'mission-control-reviewer-agent-1234',
    status: 'completed',
  });
  seedTaskSession({
    id: subagentSessionId,
    taskId,
    agentId: subagentId,
    openclawSessionId: 'agent:coder:subagent:portal-1234',
    status: 'completed',
    sessionType: 'subagent',
  });
  run(`UPDATE openclaw_sessions SET updated_at = '2026-03-27T16:08:10.000Z' WHERE id = ?`, [
    reviewerSessionId,
  ]);
  run(`UPDATE openclaw_sessions SET updated_at = '2026-03-27T16:09:10.000Z' WHERE id = ?`, [
    subagentSessionId,
  ]);

  setGatewaySessionsResolverForTests(async () => ({
    sessions: [
      {
        key: 'agent:main:mission-control-reviewer-agent-1234',
        sessionId: 'ephemeral-review-session',
        status: 'done',
        channel: 'mission-control',
        updatedAt: 1774541350000,
        endedAt: '2026-03-27T16:08:03.000Z',
      },
      {
        key: 'agent:coder:subagent:portal-1234',
        sessionId: 'ephemeral-portal-session',
        status: 'done',
        channel: 'webchat',
        updatedAt: 1774541410000,
        endedAt: '2026-03-27T16:09:03.000Z',
        parentSessionKey: 'agent:main:mission-control-reviewer-agent-1234',
        spawnedBy: 'agent:main:mission-control-reviewer-agent-1234',
        label: `portal-agent-task-${taskId.split('-')[0]}`,
      },
    ],
  }));
  setGatewaySessionHistoryResolverForTests(async (sessionRef) => {
    if (sessionRef === 'agent:main:mission-control-reviewer-agent-1234') {
      return {
        items: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'VERIFY_PASS: Ready to merge' }],
          },
        ],
      };
    }

    throw new Error(`unexpected session history lookup for ${sessionRef}`);
  });

  await runHealthCheckCycle();

  const task = queryOne<{ status: string; planning_dispatch_error: string | null; status_reason: string | null }>(
    'SELECT status, planning_dispatch_error, status_reason FROM tasks WHERE id = ?',
    [taskId],
  );

  assert.equal(task?.status, 'done');
  assert.equal(task?.planning_dispatch_error, null);
  assert.equal(task?.status_reason, null);
});
