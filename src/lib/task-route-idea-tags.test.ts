import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { closeDb, run } from './db';
import { GET as listTasksRoute } from '../app/api/tasks/route';
import { GET as getTaskRoute } from '../app/api/tasks/[id]/route';

const TEST_DB_PATH = process.env.DATABASE_PATH || join(tmpdir(), `mission-control-task-idea-tests-${process.pid}.sqlite`);
process.env.DATABASE_PATH = TEST_DB_PATH;

afterEach(() => {
  closeDb();
});

function ensureWorkspace(id: string) {
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at, updated_at)
     VALUES (?, ?, ?, datetime('now'), datetime('now'))`,
    [id, `Workspace ${id}`, id],
  );
}

function ensureProduct(id: string, workspaceId: string) {
  ensureWorkspace(workspaceId);
  run(
    `INSERT OR IGNORE INTO products (id, workspace_id, name, status, created_at, updated_at)
     VALUES (?, ?, ?, 'active', datetime('now'), datetime('now'))`,
    [id, workspaceId, `Product ${id}`],
  );
}

function seedIdea(args: { id: string; workspaceId: string; productId: string; tags?: string | null }) {
  ensureProduct(args.productId, args.workspaceId);
  run(
    `INSERT INTO ideas (
      id, product_id, title, description, category, impact_score, feasibility_score, tags, source, status, created_at, updated_at
    ) VALUES (?, ?, 'Idea title', 'Idea description', 'feature', 8, 7, ?, 'manual', 'approved', datetime('now'), datetime('now'))`,
    [args.id, args.productId, args.tags ?? null],
  );
}

function seedTask(args: { id: string; workspaceId: string; ideaId?: string | null }) {
  ensureWorkspace(args.workspaceId);
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, idea_id, created_at, updated_at)
     VALUES (?, 'Tier badge task', 'inbox', 'normal', ?, 'default', ?, datetime('now'), datetime('now'))`,
    [args.id, args.workspaceId, args.ideaId ?? null],
  );
}

test('GET /api/tasks returns normalized idea tags and scores for linked ideas', async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const productId = `prod-${crypto.randomUUID()}`;
  const ideaId = crypto.randomUUID();
  const taskId = crypto.randomUUID();

  seedIdea({ id: ideaId, workspaceId, productId, tags: '["tier-2","ops"]' });
  seedTask({ id: taskId, workspaceId, ideaId });

  const response = await listTasksRoute(
    new NextRequest(`http://localhost/api/tasks?workspace_id=${workspaceId}`),
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.length, 1);
  assert.deepEqual(body[0].idea_tags, ['tier-2', 'ops']);
  assert.equal(body[0].idea_impact_score, 8);
  assert.equal(body[0].idea_feasibility_score, 7);
});

test('GET /api/tasks and GET /api/tasks/[id] drop invalid or missing idea tags', async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const productId = `prod-${crypto.randomUUID()}`;
  const invalidIdeaId = crypto.randomUUID();
  const invalidTaskId = crypto.randomUUID();
  const noIdeaTaskId = crypto.randomUUID();

  seedIdea({ id: invalidIdeaId, workspaceId, productId, tags: '{"tier":"tier-4"}' });
  seedTask({ id: invalidTaskId, workspaceId, ideaId: invalidIdeaId });
  seedTask({ id: noIdeaTaskId, workspaceId, ideaId: null });

  const listResponse = await listTasksRoute(
    new NextRequest(`http://localhost/api/tasks?workspace_id=${workspaceId}`),
  );

  assert.equal(listResponse.status, 200);
  const listBody = await listResponse.json();
  const invalidTask = listBody.find((task: { id: string }) => task.id === invalidTaskId);
  const noIdeaTask = listBody.find((task: { id: string }) => task.id === noIdeaTaskId);
  assert.equal(invalidTask.idea_tags, undefined);
  assert.equal(noIdeaTask.idea_tags, undefined);

  const singleResponse = await getTaskRoute(
    new NextRequest(`http://localhost/api/tasks/${invalidTaskId}`),
    { params: Promise.resolve({ id: invalidTaskId }) },
  );

  assert.equal(singleResponse.status, 200);
  const singleBody = await singleResponse.json();
  assert.equal(singleBody.idea_tags, undefined);
});
