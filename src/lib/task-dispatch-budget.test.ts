import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { closeDb, queryOne, run } from './db';
import { getOpenClawClient } from './openclaw/client';
import { POST as dispatchTaskRoute } from '../app/api/tasks/[id]/dispatch/route';

const TEST_DB_PATH = process.env.DATABASE_PATH || join(tmpdir(), `mission-control-tests-${process.pid}.sqlite`);
process.env.DATABASE_PATH = TEST_DB_PATH;

afterEach(() => {
  const client = getOpenClawClient() as unknown as {
    isConnected?: () => boolean;
    connect?: () => Promise<void>;
    listAgents?: () => Promise<unknown[]>;
    getSessionByKey?: (sessionKey: string) => Promise<unknown>;
    patchSessionModel?: (sessionKey: string, model: string) => Promise<unknown>;
    call?: (...args: unknown[]) => Promise<unknown>;
  };
  delete client.isConnected;
  delete client.connect;
  delete client.listAgents;
  delete client.getSessionByKey;
  delete client.patchSessionModel;
  delete client.call;
  getOpenClawClient().disconnect();
  closeDb();
});

function ensureWorkspace(workspaceId: string) {
  run(
    `INSERT INTO workspaces (
       id, name, slug, cost_cap_daily, cost_cap_monthly, reserved_cost_usd, budget_status, created_at, updated_at
     ) VALUES (?, ?, ?, 20, 100, 0, 'clear', datetime('now'), datetime('now'))`,
    [workspaceId, `Workspace ${workspaceId}`, workspaceId],
  );
}

function seedAgent(agentId: string, workspaceId: string, model: string) {
  run(
    `INSERT INTO agents (
       id, workspace_id, name, role, model, status, source, created_at, updated_at
     ) VALUES (?, ?, 'Builder Agent', 'builder', ?, 'standby', 'local', datetime('now'), datetime('now'))`,
    [agentId, workspaceId, model],
  );
}

function seedProduct(productId: string, workspaceId: string) {
  run(
    `INSERT INTO products (
       id, workspace_id, name, icon, cost_cap_per_task, cost_cap_monthly, reserved_cost_usd, budget_status, created_at, updated_at
     ) VALUES (?, ?, 'Budget Product', '🚀', 15, 40, 0, 'clear', datetime('now'), datetime('now'))`,
    [productId, workspaceId],
  );
}

function seedTask(taskId: string, workspaceId: string, productId: string, agentId: string) {
  run(
    `INSERT INTO tasks (
       id, title, status, priority, workspace_id, business_id, product_id, assigned_agent_id, estimated_cost_usd, created_at, updated_at
     ) VALUES (?, 'Budget guarded dispatch', 'assigned', 'normal', ?, 'default', ?, ?, 5, datetime('now'), datetime('now'))`,
    [taskId, workspaceId, productId, agentId],
  );
}

test('dispatch blocks disallowed provider overrides before chat.send', async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const productId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  let chatSendCalled = false;

  ensureWorkspace(workspaceId);
  seedProduct(productId, workspaceId);
  seedAgent(agentId, workspaceId, 'google/gemini-2.5-flash');
  seedTask(taskId, workspaceId, productId, agentId);

  const client = getOpenClawClient() as unknown as {
    isConnected: () => boolean;
    connect: () => Promise<void>;
    listAgents: () => Promise<unknown[]>;
    call: (method: string, params?: unknown) => Promise<unknown>;
  };
  client.isConnected = () => true;
  client.connect = async () => undefined;
  client.listAgents = async () => [];
  client.call = async (method: string) => {
    if (method === 'chat.send') {
      chatSendCalled = true;
    }
    return {};
  };

  const response = await dispatchTaskRoute(
    new NextRequest(`http://localhost/api/tasks/${taskId}/dispatch`, { method: 'POST' }),
    { params: Promise.resolve({ id: taskId }) },
  );

  assert.equal(response.status, 409);
  const body = await response.json();
  assert.match(body.error || '', /docs-backed model policy allowlist|not allowed by Mission Control policy/i);
  assert.equal(chatSendCalled, false);

  const task = queryOne<{ planning_dispatch_error: string | null; budget_status: string | null }>(
    'SELECT planning_dispatch_error, budget_status FROM tasks WHERE id = ?',
    [taskId],
  );
  assert.match(task?.planning_dispatch_error || '', /docs-backed model policy allowlist|not allowed by Mission Control policy/i);
  assert.equal(task?.budget_status, 'blocked');
});

test('dispatch fails closed when runtime model readback does not match requested model', async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const productId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  let chatSendCalled = false;

  ensureWorkspace(workspaceId);
  seedProduct(productId, workspaceId);
  seedAgent(agentId, workspaceId, 'openai-codex/gpt-5.4');
  seedTask(taskId, workspaceId, productId, agentId);

  const client = getOpenClawClient() as unknown as {
    isConnected: () => boolean;
    connect: () => Promise<void>;
    listAgents: () => Promise<unknown[]>;
    patchSessionModel: (sessionKey: string, model: string) => Promise<unknown>;
    getSessionByKey: (sessionKey: string) => Promise<unknown>;
    call: (method: string, params?: unknown) => Promise<unknown>;
  };
  client.isConnected = () => true;
  client.connect = async () => undefined;
  client.listAgents = async () => [];
  client.patchSessionModel = async (sessionKey: string, model: string) => ({
    key: sessionKey,
    resolved: { modelProvider: 'openai-codex', model: 'gpt-5.4' },
  });
  client.getSessionByKey = async (sessionKey: string) => ({
    key: sessionKey,
    sessionId: 'runtime-session-1',
    modelProvider: 'openai-codex',
    model: 'gpt-5.3-codex-spark',
  });
  client.call = async (method: string) => {
    if (method === 'chat.send') {
      chatSendCalled = true;
    }
    return {};
  };

  const response = await dispatchTaskRoute(
    new NextRequest(`http://localhost/api/tasks/${taskId}/dispatch`, { method: 'POST' }),
    { params: Promise.resolve({ id: taskId }) },
  );

  assert.equal(response.status, 409);
  const body = await response.json();
  assert.match(body.error || '', /could not confirm|expected/i);
  assert.equal(body.binding_status, 'failed');
  assert.equal(chatSendCalled, false);

  const session = queryOne<{
    binding_status: string | null;
    requested_model: string | null;
    bound_model: string | null;
  }>(
    'SELECT binding_status, requested_model, bound_model FROM openclaw_sessions WHERE agent_id = ? LIMIT 1',
    [agentId],
  );
  assert.equal(session?.binding_status, 'failed');
  assert.equal(session?.requested_model, 'openai-codex/gpt-5.4');
  assert.equal(session?.bound_model, 'openai-codex/gpt-5.3-codex-spark');
});

test('dispatch records confirmed runtime model binding before chat.send', async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const productId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  const sentMethods: string[] = [];

  ensureWorkspace(workspaceId);
  seedProduct(productId, workspaceId);
  seedAgent(agentId, workspaceId, 'qwen/qwen3.6-plus');
  seedTask(taskId, workspaceId, productId, agentId);

  const client = getOpenClawClient() as unknown as {
    isConnected: () => boolean;
    connect: () => Promise<void>;
    listAgents: () => Promise<unknown[]>;
    patchSessionModel: (sessionKey: string, model: string) => Promise<unknown>;
    getSessionByKey: (sessionKey: string) => Promise<unknown>;
    call: (method: string, params?: unknown) => Promise<unknown>;
  };
  client.isConnected = () => true;
  client.connect = async () => undefined;
  client.listAgents = async () => [];
  client.patchSessionModel = async (sessionKey: string, model: string) => ({
    key: sessionKey,
    resolved: { model: 'qwen/qwen3.6-plus' },
  });
  client.getSessionByKey = async (sessionKey: string) => ({
    key: sessionKey,
    sessionId: 'runtime-session-2',
    model: 'qwen/qwen3.6-plus',
    inputTokens: 120,
    outputTokens: 24,
    cacheRead: 6,
    cacheWrite: 0,
  });
  client.call = async (method: string) => {
    sentMethods.push(method);
    return {};
  };

  const response = await dispatchTaskRoute(
    new NextRequest(`http://localhost/api/tasks/${taskId}/dispatch`, { method: 'POST' }),
    { params: Promise.resolve({ id: taskId }) },
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.binding_status, 'bound');
  assert.equal(body.bound_model, 'qwen/qwen3.6-plus');
  assert.equal(body.requested_model, 'qwen/qwen3.6-plus');
  assert.deepEqual(sentMethods.filter((method) => method === 'chat.send'), ['chat.send']);

  const session = queryOne<{
    binding_status: string | null;
    session_key: string | null;
    bound_model: string | null;
    usage_start_input_tokens: number | null;
    usage_start_output_tokens: number | null;
  }>(
    `SELECT binding_status, session_key, bound_model, usage_start_input_tokens, usage_start_output_tokens
     FROM openclaw_sessions
     WHERE agent_id = ?
     LIMIT 1`,
    [agentId],
  );
  assert.equal(session?.binding_status, 'bound');
  assert.equal(session?.bound_model, 'qwen/qwen3.6-plus');
  assert.match(session?.session_key || '', /^agent:coder:/);
  assert.equal(session?.usage_start_input_tokens, 120);
  assert.equal(session?.usage_start_output_tokens, 24);
});
