import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, queryOne, run } from '@/lib/db';

const TEST_DB_PATH = process.env.DATABASE_PATH || join(tmpdir(), `mission-control-ideation-tests-${process.pid}.sqlite`);
process.env.DATABASE_PATH = TEST_DB_PATH;

const originalFetch = globalThis.fetch;
const originalGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
const originalAutopilotModel = process.env.AUTOPILOT_MODEL;
const originalCompletionMode = process.env.OPENCLAW_AUTOPILOT_COMPLETION_MODE;

afterEach(() => {
  globalThis.fetch = originalFetch;

  if (originalGatewayToken === undefined) {
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
  } else {
    process.env.OPENCLAW_GATEWAY_TOKEN = originalGatewayToken;
  }

  if (originalAutopilotModel === undefined) {
    delete process.env.AUTOPILOT_MODEL;
  } else {
    process.env.AUTOPILOT_MODEL = originalAutopilotModel;
  }

  if (originalCompletionMode === undefined) {
    delete process.env.OPENCLAW_AUTOPILOT_COMPLETION_MODE;
  } else {
    process.env.OPENCLAW_AUTOPILOT_COMPLETION_MODE = originalCompletionMode;
  }

  closeDb();
});

function ensureWorkspace(workspaceId: string) {
  run(
    `INSERT INTO workspaces (
       id, name, slug, cost_cap_daily, cost_cap_monthly, reserved_cost_usd, budget_status,
       autopilot_model_override, planning_model_override, created_at, updated_at
     ) VALUES (?, ?, ?, 20, 100, 0, 'clear', 'qwen/qwen3.6-plus', 'qwen/qwen3.6-plus', datetime('now'), datetime('now'))`,
    [workspaceId, `Workspace ${workspaceId}`, workspaceId],
  );
}

function seedProduct(productId: string, workspaceId: string) {
  ensureWorkspace(workspaceId);
  run(
    `INSERT INTO products (
       id, workspace_id, name, repo_url, product_program, icon,
       cost_cap_per_task, cost_cap_monthly, reserved_cost_usd, budget_status, created_at, updated_at
     ) VALUES (?, ?, 'BoreReady', 'https://github.com/nice-and-precise/squti.git', ?, '🚀', 15, 40, 0, 'clear', datetime('now'), datetime('now'))`,
    [
      productId,
      workspaceId,
      'Train workers for confined-space safety with a Frappe LMS-backed program and identify implementation gaps.',
    ],
  );
}

async function waitForIdeationCycle(ideationId: string, timeoutMs = 2_500): Promise<{ status: string; error_message: string | null }> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const cycle = queryOne<{ status: string; error_message: string | null }>(
      'SELECT status, error_message FROM ideation_cycles WHERE id = ?',
      [ideationId],
    );
    if (cycle && cycle.status !== 'running') {
      return cycle;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Timed out waiting for ideation cycle ${ideationId}`);
}

test('runIdeationCycle accepts wrapped idea arrays from provider models', async () => {
  process.env.OPENCLAW_GATEWAY_TOKEN = 'test-token';
  process.env.AUTOPILOT_MODEL = 'openclaw';
  process.env.OPENCLAW_AUTOPILOT_COMPLETION_MODE = 'http';

  const workspaceId = `ws-${crypto.randomUUID()}`;
  const productId = crypto.randomUUID();
  seedProduct(productId, workspaceId);

  globalThis.fetch = async () => new Response(JSON.stringify({
    model: 'openclaw',
    choices: [{
      message: {
        content: JSON.stringify({
          data: {
            ideas: [{
              title: 'Wrapped Idea',
              description: 'Comes back inside a nested object wrapper',
              category: 'operations',
              impact_score: 8,
              feasibility_score: 7,
              complexity: 'S',
              estimated_effort_hours: 2,
              technical_approach: 'Normalize common provider wrappers before validation',
              risks: ['Providers may wrap arrays in metadata objects'],
              tags: ['autopilot', 'qwen'],
            }],
          },
        }),
      },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 },
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

  const mod = await import(`./ideation?test=${Date.now()}`);
  const ideationId = await mod.runIdeationCycle(productId);
  const cycle = await waitForIdeationCycle(ideationId);

  assert.equal(cycle.status, 'completed');
  assert.equal(cycle.error_message, null);

  const idea = queryOne<{ title: string; status: string }>(
    'SELECT title, status FROM ideas WHERE product_id = ? ORDER BY created_at DESC LIMIT 1',
    [productId],
  );
  assert.equal(idea?.title, 'Wrapped Idea');
  assert.equal(idea?.status, 'pending');
});

test('runIdeationCycle accepts a single idea object from provider models', async () => {
  process.env.OPENCLAW_GATEWAY_TOKEN = 'test-token';
  process.env.AUTOPILOT_MODEL = 'openclaw';
  process.env.OPENCLAW_AUTOPILOT_COMPLETION_MODE = 'http';

  const workspaceId = `ws-${crypto.randomUUID()}`;
  const productId = crypto.randomUUID();
  seedProduct(productId, workspaceId);

  globalThis.fetch = async () => new Response(JSON.stringify({
    model: 'openclaw',
    choices: [{
      message: {
        content: JSON.stringify({
          title: 'Single Idea',
          description: 'Provider returned one idea object instead of an array',
          category: 'operations',
          impact_score: 8,
          feasibility_score: 8,
          complexity: 'S',
          estimated_effort_hours: 2,
          technical_approach: 'Wrap single idea-like objects before storage',
          risks: ['Providers may collapse singleton arrays'],
          tags: ['autopilot', 'qwen'],
          target_user_segment: 'operators',
        }),
      },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 35, completion_tokens: 18, total_tokens: 53 },
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

  const mod = await import(`./ideation?test-single=${Date.now()}`);
  const ideationId = await mod.runIdeationCycle(productId);
  const cycle = await waitForIdeationCycle(ideationId);

  assert.equal(cycle.status, 'completed');
  assert.equal(cycle.error_message, null);

  const idea = queryOne<{ title: string; status: string }>(
    'SELECT title, status FROM ideas WHERE product_id = ? ORDER BY created_at DESC LIMIT 1',
    [productId],
  );
  assert.equal(idea?.title, 'Single Idea');
  assert.equal(idea?.status, 'pending');
});
