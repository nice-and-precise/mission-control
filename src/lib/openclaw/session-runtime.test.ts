import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, queryOne, run } from '@/lib/db';
import { getOpenClawClient } from './client';
import { syncOpenClawBuildUsage } from './session-runtime';

const TEST_DB_PATH = process.env.DATABASE_PATH || join(tmpdir(), `mission-control-tests-${process.pid}.sqlite`);
process.env.DATABASE_PATH = TEST_DB_PATH;

afterEach(() => {
  const client = getOpenClawClient() as unknown as {
    isConnected?: () => boolean;
    connect?: () => Promise<void>;
    listSessions?: () => Promise<unknown[]>;
    getConfig?: () => Promise<unknown>;
  };
  delete client.isConnected;
  delete client.connect;
  delete client.listSessions;
  delete client.getConfig;
  getOpenClawClient().disconnect();
  closeDb();
});

function seedWorkspaceProductTask(agentModel: string) {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const productId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const openclawSessionId = `mission-control-builder-agent-${agentId.slice(0, 8)}`;
  const sessionKey = `agent:coder:${openclawSessionId}`;

  run(
    `INSERT INTO workspaces (id, name, slug, cost_cap_daily, cost_cap_monthly, reserved_cost_usd, budget_status, created_at, updated_at)
     VALUES (?, ?, ?, 20, 100, 0, 'clear', datetime('now'), datetime('now'))`,
    [workspaceId, `Workspace ${workspaceId}`, workspaceId],
  );
  run(
    `INSERT INTO products (id, workspace_id, name, icon, cost_cap_per_task, cost_cap_monthly, reserved_cost_usd, budget_status, created_at, updated_at)
     VALUES (?, ?, 'Usage Product', '🚀', 15, 40, 0, 'clear', datetime('now'), datetime('now'))`,
    [productId, workspaceId],
  );
  run(
    `INSERT INTO agents (id, workspace_id, name, role, model, status, source, session_key_prefix, created_at, updated_at)
     VALUES (?, ?, 'Builder Agent', 'builder', ?, 'working', 'local', 'agent:coder:', datetime('now'), datetime('now'))`,
    [agentId, workspaceId, agentModel],
  );
  run(
    `INSERT INTO tasks (
       id, title, status, priority, workspace_id, business_id, product_id, assigned_agent_id,
       estimated_cost_usd, reserved_cost_usd, actual_cost_usd, budget_status, created_at, updated_at
     ) VALUES (?, 'Usage sync task', 'testing', 'normal', ?, 'default', ?, ?, 5, 5, 0, 'clear', datetime('now'), datetime('now'))`,
    [taskId, workspaceId, productId, agentId],
  );
  run(
    `INSERT INTO openclaw_sessions (
       id, agent_id, openclaw_session_id, session_key, channel, status, session_type, task_id,
       requested_model, bound_model, binding_status,
       usage_start_input_tokens, usage_start_output_tokens, usage_start_cache_read_tokens, usage_start_cache_write_tokens,
       usage_sync_status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'mission-control', 'ended', 'persistent', ?, ?, ?, 'bound', 1000, 200, 0, 0, 'pending', datetime('now'), datetime('now'))`,
    [sessionId, agentId, openclawSessionId, sessionKey, taskId, agentModel, agentModel],
  );

  return { workspaceId, productId, agentId, taskId, sessionId, sessionKey };
}

test('syncOpenClawBuildUsage records one priced build_task event and is idempotent', async () => {
  const seeded = seedWorkspaceProductTask('deepinfra/meta-llama/Llama-3.3-70B-Instruct-Turbo');
  const client = getOpenClawClient() as unknown as {
    isConnected: () => boolean;
    connect: () => Promise<void>;
    listSessions: () => Promise<unknown[]>;
    getConfig: () => Promise<unknown>;
  };

  client.isConnected = () => true;
  client.connect = async () => undefined;
  client.listSessions = async () => [{
    key: seeded.sessionKey,
    sessionId: 'runtime-session-usage-1',
    modelProvider: 'deepinfra',
    model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    inputTokens: 2500,
    outputTokens: 800,
    cacheRead: 100,
    cacheWrite: 0,
    updatedAt: 101,
    status: 'ended',
  }];
  client.getConfig = async () => ({
    config: {
      models: {
        providers: {
          deepinfra: {
            models: [
              {
                id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
                cost: { input: 0.1, output: 0.32, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
    },
  });

  const first = await syncOpenClawBuildUsage({ taskId: seeded.taskId });
  assert.equal(first.priced, 1);

  const event = queryOne<{ tokens_input: number; tokens_output: number; cost_usd: number }>(
    `SELECT tokens_input, tokens_output, cost_usd
     FROM cost_events
     WHERE task_id = ? AND event_type = 'build_task'`,
    [seeded.taskId],
  );
  assert.equal(event?.tokens_input, 1500);
  assert.equal(event?.tokens_output, 600);
  assert.ok((event?.cost_usd || 0) > 0.00034 && (event?.cost_usd || 0) < 0.00035);

  const task = queryOne<{ reserved_cost_usd: number; actual_cost_usd: number }>(
    'SELECT reserved_cost_usd, actual_cost_usd FROM tasks WHERE id = ?',
    [seeded.taskId],
  );
  assert.equal(task?.reserved_cost_usd, 0);
  assert.ok((task?.actual_cost_usd || 0) > 0);

  const second = await syncOpenClawBuildUsage({ taskId: seeded.taskId });
  assert.equal(second.skipped, 1);

  const eventCount = queryOne<{ count: number }>(
    `SELECT COUNT(*) AS count FROM cost_events WHERE task_id = ? AND event_type = 'build_task'`,
    [seeded.taskId],
  );
  assert.equal(eventCount?.count, 1);
});

test('syncOpenClawBuildUsage releases reserved spend and marks unpriced runs explicitly', async () => {
  const seeded = seedWorkspaceProductTask('openai-codex/gpt-5.4');
  const client = getOpenClawClient() as unknown as {
    isConnected: () => boolean;
    connect: () => Promise<void>;
    listSessions: () => Promise<unknown[]>;
    getConfig: () => Promise<unknown>;
  };

  client.isConnected = () => true;
  client.connect = async () => undefined;
  client.listSessions = async () => [{
    key: seeded.sessionKey,
    sessionId: 'runtime-session-usage-2',
    modelProvider: 'openai-codex',
    model: 'gpt-5.4',
    inputTokens: 2200,
    outputTokens: 400,
    updatedAt: 202,
    status: 'ended',
  }];
  client.getConfig = async () => ({ config: { models: { providers: {} } } });

  const result = await syncOpenClawBuildUsage({ taskId: seeded.taskId });
  assert.equal(result.unpriced, 1);

  const eventCount = queryOne<{ count: number }>(
    `SELECT COUNT(*) AS count FROM cost_events WHERE task_id = ? AND event_type = 'build_task'`,
    [seeded.taskId],
  );
  assert.equal(eventCount?.count, 0);

  const task = queryOne<{ reserved_cost_usd: number; budget_status: string | null; budget_block_reason: string | null }>(
    'SELECT reserved_cost_usd, budget_status, budget_block_reason FROM tasks WHERE id = ?',
    [seeded.taskId],
  );
  assert.equal(task?.reserved_cost_usd, 0);
  assert.equal(task?.budget_status, 'blocked');
  assert.equal(task?.budget_block_reason, 'usage_missing_accountable_pricing');

  const session = queryOne<{ usage_sync_status: string | null; usage_external_id: string | null }>(
    'SELECT usage_sync_status, usage_external_id FROM openclaw_sessions WHERE id = ?',
    [seeded.sessionId],
  );
  assert.equal(session?.usage_sync_status, 'unpriced');
  assert.ok(session?.usage_external_id);
});
