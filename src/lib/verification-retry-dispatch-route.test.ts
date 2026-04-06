import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { closeDb, queryOne, run } from '@/lib/db';
import { POST as verificationRetryDispatch } from '@/app/api/tasks/[id]/verification/retry-dispatch/route';

const TEST_DB_PATH = join(tmpdir(), `mission-control-verification-retry-${process.pid}.sqlite`);
process.env.DATABASE_PATH = TEST_DB_PATH;

// Capture fetch calls so tests do not make real HTTP requests
let lastFetchUrl: string | null = null;
let mockFetchResponse: { ok: boolean; json: () => Promise<unknown> } = {
  ok: true,
  json: async () => ({ success: true }),
};
const originalFetch = global.fetch;

beforeEach(() => {
  lastFetchUrl = null;
  mockFetchResponse = { ok: true, json: async () => ({ success: true }) };
  global.fetch = (async (url: string) => {
    lastFetchUrl = url;
    return mockFetchResponse;
  }) as typeof global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  closeDb();
});

function ensureWorkspace(id: string) {
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at, updated_at)
     VALUES (?, ?, ?, datetime('now'), datetime('now'))`,
    [id, `Workspace ${id}`, id],
  );
}

function seedAgent(id: string, workspaceId: string, role = 'reviewer') {
  ensureWorkspace(workspaceId);
  run(
    `INSERT INTO agents (id, workspace_id, name, role, status, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'standby', 'local', datetime('now'), datetime('now'))`,
    [id, workspaceId, `${role} agent`, role],
  );
}

function seedTask(id: string, workspaceId: string, status = 'verification', agentId: string | null = null) {
  ensureWorkspace(workspaceId);
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, assigned_agent_id, created_at, updated_at)
     VALUES (?, 'Test task', ?, 'normal', ?, 'default', ?, datetime('now'), datetime('now'))`,
    [id, status, workspaceId, agentId],
  );
}

function makeRequest(taskId: string) {
  const url = `http://localhost:4000/api/tasks/${taskId}/verification/retry-dispatch`;
  return new NextRequest(url, { method: 'POST' });
}

test('returns 404 when task does not exist', async () => {
  const res = await verificationRetryDispatch(
    makeRequest('nonexistent-task-id'),
    { params: Promise.resolve({ id: 'nonexistent-task-id' }) },
  );
  assert.equal(res.status, 404);
  const body = await res.json() as { error: string };
  assert.match(body.error, /not found/i);
});

test('returns 400 when task is not in verification status', async () => {
  const wsId = `ws-${crypto.randomUUID()}`;
  const taskId = crypto.randomUUID();
  seedTask(taskId, wsId, 'done');

  const res = await verificationRetryDispatch(
    makeRequest(taskId),
    { params: Promise.resolve({ id: taskId }) },
  );
  assert.equal(res.status, 400);
  const body = await res.json() as { error: string };
  assert.match(body.error, /expected 'verification'/i);
});

test('returns 400 when no agent is assigned', async () => {
  const wsId = `ws-${crypto.randomUUID()}`;
  const taskId = crypto.randomUUID();
  seedTask(taskId, wsId, 'verification', null);

  const res = await verificationRetryDispatch(
    makeRequest(taskId),
    { params: Promise.resolve({ id: taskId }) },
  );
  assert.equal(res.status, 400);
  const body = await res.json() as { error: string };
  assert.match(body.error, /no agent assigned/i);
});

test('returns 200 success when dispatch succeeds', async () => {
  const wsId = `ws-${crypto.randomUUID()}`;
  const agentId = `agent-${crypto.randomUUID()}`;
  const taskId = crypto.randomUUID();
  seedAgent(agentId, wsId);
  seedTask(taskId, wsId, 'verification', agentId);

  // Mock dispatch returning success
  mockFetchResponse = { ok: true, json: async () => ({ success: true }) };

  const res = await verificationRetryDispatch(
    makeRequest(taskId),
    { params: Promise.resolve({ id: taskId }) },
  );
  assert.equal(res.status, 200);
  const body = await res.json() as { success: boolean; message: string };
  assert.equal(body.success, true);
  assert.match(body.message, /retry successful/i);
  assert.ok(lastFetchUrl?.includes(`/api/tasks/${taskId}/dispatch`));
});

test('returns 200 queued and clears planning_dispatch_error when dispatch is queued', async () => {
  const wsId = `ws-${crypto.randomUUID()}`;
  const agentId = `agent-${crypto.randomUUID()}`;
  const taskId = crypto.randomUUID();
  seedAgent(agentId, wsId);
  seedTask(taskId, wsId, 'verification', agentId);

  // Seed a planning_dispatch_error to verify it gets cleared on queue
  run(
    `UPDATE tasks SET planning_dispatch_error = 'Run ended without completion callback or workflow handoff (ended session).' WHERE id = ?`,
    [taskId],
  );

  // Mock dispatch returning queued
  mockFetchResponse = {
    ok: true,
    json: async () => ({ queued: true, message: 'Waiting for agent to finish another task' }),
  };

  const res = await verificationRetryDispatch(
    makeRequest(taskId),
    { params: Promise.resolve({ id: taskId }) },
  );
  assert.equal(res.status, 200);
  const body = await res.json() as { queued: boolean };
  assert.equal(body.queued, true);

  // planning_dispatch_error should be cleared
  const task = queryOne<{ planning_dispatch_error: string | null }>(
    'SELECT planning_dispatch_error FROM tasks WHERE id = ?',
    [taskId],
  );
  assert.equal(task?.planning_dispatch_error, null);
});
