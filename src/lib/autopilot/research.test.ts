import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fs from 'node:fs';
import { closeDb, queryOne, run } from '@/lib/db';

const TEST_DB_PATH = process.env.DATABASE_PATH || join(tmpdir(), `mission-control-research-tests-${process.pid}.sqlite`);
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

function seedProduct(productId: string, workspaceId: string, overrides?: { productProgram?: string; settings?: string }) {
  ensureWorkspace(workspaceId);
  run(
    `INSERT INTO products (
       id, workspace_id, name, repo_url, product_program, icon,
       settings, cost_cap_per_task, cost_cap_monthly, reserved_cost_usd, budget_status, created_at, updated_at
     ) VALUES (?, ?, 'BoreReady', 'https://github.com/nice-and-precise/squti.git', ?, '🚀', ?, 15, 40, 0, 'clear', datetime('now'), datetime('now'))`,
    [
      productId,
      workspaceId,
      overrides?.productProgram || 'Train workers for confined-space safety with a Frappe LMS-backed program and identify implementation gaps.',
      overrides?.settings || JSON.stringify({ repo_checkout_path: '/__tests__/disabled-product-program-sync' }),
    ],
  );
}

async function waitForResearchCycle(cycleId: string, timeoutMs = 2_500): Promise<{ status: string; report: string | null; error_message: string | null }> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const cycle = queryOne<{ status: string; report: string | null; error_message: string | null }>(
      'SELECT status, report, error_message FROM research_cycles WHERE id = ?',
      [cycleId],
    );
    if (cycle && cycle.status !== 'running') {
      return cycle;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Timed out waiting for research cycle ${cycleId}`);
}

test('runResearchCycle retries invalid JSON and completes for a qwen workspace override', async () => {
  process.env.OPENCLAW_GATEWAY_TOKEN = 'test-token';
  process.env.AUTOPILOT_MODEL = 'openclaw';
  process.env.OPENCLAW_AUTOPILOT_COMPLETION_MODE = 'http';

  const workspaceId = `ws-${crypto.randomUUID()}`;
  const productId = crypto.randomUUID();
  seedProduct(productId, workspaceId);

  let callCount = 0;
  globalThis.fetch = async (_input, init) => {
    callCount += 1;

    const body = JSON.parse(String(init?.body)) as {
      messages?: Array<{ role?: string; content?: string }>;
    };

    const responseContent = callCount === 1
      ? '{"sections":{"codebase":{"findings":["Repository github.com/nice-and-precise/squti returns 404"'
      : '{"sections":{"codebase":{"findings":["Recovered"],"gaps":[],"opportunities":[]},"competitors":{"products_analyzed":[],"feature_gaps":[],"market_position":"Niche"},"trends":{"relevant_trends":[],"emerging_tech":[],"community_signals":[]},"technology":{"new_tools":[],"integration_opportunities":[],"infrastructure_improvements":[]}}}';

    if (callCount === 2) {
      assert.match(body.messages?.[0]?.content || '', /Return exactly one valid JSON object or array/i);
    }

    return new Response(JSON.stringify({
      model: 'openclaw',
      choices: [{ message: { content: responseContent }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 50, completion_tokens: 25, total_tokens: 75 },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const mod = await import(`./research?test=${Date.now()}`);
  const cycleId = await mod.runResearchCycle(productId);
  const cycle = await waitForResearchCycle(cycleId);

  assert.equal(callCount, 2);
  assert.equal(cycle.status, 'completed');
  assert.equal(cycle.error_message, null);
  assert.match(cycle.report || '', /"Recovered"/);

  const storedCycle = queryOne<{ current_phase: string | null; report: string | null }>(
    'SELECT current_phase, report FROM research_cycles WHERE id = ?',
    [cycleId],
  );
  assert.equal(storedCycle?.current_phase, 'completed');
  assert.match(storedCycle?.report || '', /"technology"/);
});

test('runResearchCycle stores product program provenance for completed cycles', async () => {
  process.env.OPENCLAW_GATEWAY_TOKEN = 'test-token';
  process.env.AUTOPILOT_MODEL = 'openclaw';
  process.env.OPENCLAW_AUTOPILOT_COMPLETION_MODE = 'http';

  const workspaceId = `ws-${crypto.randomUUID()}`;
  const productId = crypto.randomUUID();
  const programText = '# Product Program\n\nCanonical BoreReady test program.';
  const programPath = join(tmpdir(), `mc-program-${crypto.randomUUID()}.md`);
  fs.writeFileSync(programPath, programText);
  seedProduct(productId, workspaceId, {
    productProgram: programText,
    settings: JSON.stringify({ canonical_program_path: programPath }),
  });

  globalThis.fetch = async () => new Response(JSON.stringify({
    model: 'openclaw',
    choices: [{
      message: {
        content: '{"sections":{"missing_artifacts":{"artifacts":[],"blockers":[],"priority_order":[]},"factual_gaps":{"statute_mismatches":[],"dli_doc_mismatches":[],"source_citation_issues":[]},"contradictions":{"repo_vs_board":[],"repo_vs_prs":[],"internal_doc_conflicts":[]},"domain_lock_violations":{"prohibited_terms_found":[],"wrong_domain_references":[]}}}',
      },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

  const mod = await import(`./research?test-provenance=${Date.now()}`);
  const cycleId = await mod.runResearchCycle(productId);
  const cycle = await waitForResearchCycle(cycleId);

  assert.equal(cycle.status, 'completed');
  const storedCycle = queryOne<{ product_program_sha: string | null; product_program_snapshot: string | null }>(
    'SELECT product_program_sha, product_program_snapshot FROM research_cycles WHERE id = ?',
    [cycleId],
  );
  assert.equal(storedCycle?.product_program_sha?.length, 64);
  assert.equal(storedCycle?.product_program_snapshot, programText);
});

test('runResearchCycle blocks when canonical Product Program differs from Mission Control DB copy', async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const productId = crypto.randomUUID();
  const programPath = join(tmpdir(), `mc-program-drift-${crypto.randomUUID()}.md`);
  fs.writeFileSync(programPath, '# Product Program\n\nCanonical repo truth.');

  seedProduct(productId, workspaceId, {
    productProgram: '# Product Program\n\nStale DB truth.',
    settings: JSON.stringify({ canonical_program_path: programPath }),
  });

  const mod = await import(`./research?test-drift=${Date.now()}`);
  await assert.rejects(
    () => mod.runResearchCycle(productId),
    /Product Program is out of sync/i,
  );
});

test('getResearchCycles interrupts stale running cycles with no recent heartbeat', async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const productId = crypto.randomUUID();
  seedProduct(productId, workspaceId);

  const staleCycleId = crypto.randomUUID();
  run(
    `INSERT INTO research_cycles (
       id, product_id, status, current_phase, started_at, last_heartbeat
     ) VALUES (?, ?, 'running', 'llm_polling', ?, ?)`,
    [
      staleCycleId,
      productId,
      '2026-04-09T23:00:00.000Z',
      '2026-04-09T23:00:00.000Z',
    ],
  );

  const mod = await import(`./research?test-stale=${Date.now()}`);
  const cycles = mod.getResearchCycles(productId);
  const recovered = cycles.find((cycle: { id: string }) => cycle.id === staleCycleId);

  assert.equal(recovered?.status, 'interrupted');
  assert.match(recovered?.error_message || '', /Mission Control lost its worker/i);
});
