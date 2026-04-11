import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { closeDb, queryOne, run } from './db';
import { POST as createAgentRoute } from '../app/api/agents/route';
import { PATCH as patchAgentRoute } from '../app/api/agents/[id]/route';

const TEST_DB_PATH = process.env.DATABASE_PATH || join(tmpdir(), `mission-control-tests-${process.pid}.sqlite`);
process.env.DATABASE_PATH = TEST_DB_PATH;

afterEach(() => {
  closeDb();
});

function ensureWorkspace(id: string) {
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at, updated_at)
     VALUES (?, ?, ?, datetime('now'), datetime('now'))`,
    [id, `Workspace ${id}`, id]
  );
}

test('agent routes persist and normalize session_key_prefix values', async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  ensureWorkspace(workspaceId);

  const createResponse = await createAgentRoute(
    new NextRequest('http://localhost/api/agents', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Builder Agent 2',
        role: 'builder',
        workspace_id: workspaceId,
        session_key_prefix: 'agent:worker',
      }),
    })
  );

  assert.equal(createResponse.status, 201);
  const createdAgent = await createResponse.json() as { id: string; session_key_prefix: string | null };
  assert.equal(createdAgent.session_key_prefix, 'agent:worker:');

  const storedAfterCreate = queryOne<{ session_key_prefix: string | null }>(
    'SELECT session_key_prefix FROM agents WHERE id = ?',
    [createdAgent.id]
  );
  assert.equal(storedAfterCreate?.session_key_prefix, 'agent:worker:');

  const patchResponse = await patchAgentRoute(
    new NextRequest(`http://localhost/api/agents/${createdAgent.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ session_key_prefix: 'agent:review' }),
    }),
    { params: Promise.resolve({ id: createdAgent.id }) }
  );

  assert.equal(patchResponse.status, 200);
  const updatedAgent = await patchResponse.json() as { session_key_prefix: string | null };
  assert.equal(updatedAgent.session_key_prefix, 'agent:review:');

  const clearResponse = await patchAgentRoute(
    new NextRequest(`http://localhost/api/agents/${createdAgent.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ session_key_prefix: null }),
    }),
    { params: Promise.resolve({ id: createdAgent.id }) }
  );

  assert.equal(clearResponse.status, 200);
  const storedAfterClear = queryOne<{ session_key_prefix: string | null }>(
    'SELECT session_key_prefix FROM agents WHERE id = ?',
    [createdAgent.id]
  );
  assert.equal(storedAfterClear?.session_key_prefix, null);
});