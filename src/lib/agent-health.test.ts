import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkAgentHealth, runHealthCheckCycle, setHealthCheckImplementationForTests } from './agent-health';
import { closeDb, queryOne, run } from './db';

const TEST_DB_PATH = process.env.DATABASE_PATH || join(tmpdir(), `mission-control-agent-health-tests-${process.pid}.sqlite`);
process.env.DATABASE_PATH = TEST_DB_PATH;

afterEach(() => {
  setHealthCheckImplementationForTests(null);
  closeDb();
  rmSync(TEST_DB_PATH, { force: true });
  rmSync(`${TEST_DB_PATH}-wal`, { force: true });
  rmSync(`${TEST_DB_PATH}-shm`, { force: true });
});

test('runHealthCheckCycle shares one in-flight execution across concurrent callers', async () => {
  let calls = 0;

  setHealthCheckImplementationForTests(async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 25));
    return [];
  });

  const [first, second] = await Promise.all([runHealthCheckCycle(), runHealthCheckCycle()]);

  assert.equal(calls, 1);
  assert.deepEqual(first, []);
  assert.deepEqual(second, []);
});

test('checkAgentHealth treats recent OpenClaw session activity as real work', async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const agentId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const now = Date.now();
  const staleTaskUpdatedAt = new Date(now - (10 * 60 * 1000)).toISOString();
  const recentSessionUpdatedAt = new Date(now - (60 * 1000)).toISOString();

  run(
    `INSERT INTO workspaces (id, name, slug, created_at, updated_at)
     VALUES (?, 'Health Workspace', ?, datetime('now'), datetime('now'))`,
    [workspaceId, workspaceId],
  );
  run(
    `INSERT INTO agents (id, workspace_id, name, role, status, source, created_at, updated_at)
     VALUES (?, ?, 'Builder Agent', 'builder', 'working', 'local', datetime('now'), datetime('now'))`,
    [agentId, workspaceId],
  );
  run(
    `INSERT INTO tasks
      (id, title, status, priority, workspace_id, business_id, assigned_agent_id, created_at, updated_at)
     VALUES (?, 'Long-running build', 'in_progress', 'normal', ?, 'default', ?, ?, ?)`,
    [taskId, workspaceId, agentId, staleTaskUpdatedAt, staleTaskUpdatedAt],
  );
  run(
    `INSERT INTO openclaw_sessions
      (id, agent_id, openclaw_session_id, session_key, channel, status, session_type, task_id, active_task_id, created_at, updated_at)
     VALUES (?, ?, 'mission-control-builder-agent', 'agent:coder:mission-control-builder-agent', 'mission-control', 'active', 'persistent', ?, ?, ?, ?)`,
    [sessionId, agentId, taskId, taskId, staleTaskUpdatedAt, recentSessionUpdatedAt],
  );

  assert.equal(checkAgentHealth(agentId), 'working');

  await runHealthCheckCycle();

  const health = queryOne<{ health_state: string }>(
    'SELECT health_state FROM agent_health WHERE agent_id = ?',
    [agentId],
  );
  const healthNoise = queryOne<{ count: number }>(
    `SELECT COUNT(*) AS count
     FROM task_activities
     WHERE task_id = ?
       AND message LIKE 'Agent health:%'`,
    [taskId],
  );

  assert.equal(health?.health_state, 'working');
  assert.equal(healthNoise?.count || 0, 0);
});
