import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, run } from '@/lib/db';
import { getCostBreakdown, getCostOverview } from './reporting';

const TEST_DB_PATH = process.env.DATABASE_PATH || join(tmpdir(), `mission-control-tests-${process.pid}.sqlite`);
process.env.DATABASE_PATH = TEST_DB_PATH;

afterEach(() => {
  closeDb();
});

function seedWorkspace(workspaceId: string) {
  run(
    `INSERT INTO workspaces (
       id, name, slug, cost_cap_daily, cost_cap_monthly, reserved_cost_usd, budget_status, created_at, updated_at
     ) VALUES (?, ?, ?, 20, 100, 0, 'clear', datetime('now'), datetime('now'))`,
    [workspaceId, `Workspace ${workspaceId}`, workspaceId],
  );
}

function seedProduct(productId: string, workspaceId: string) {
  run(
    `INSERT INTO products (
       id, workspace_id, name, icon, cost_cap_per_task, cost_cap_monthly, reserved_cost_usd, budget_status, created_at, updated_at
     ) VALUES (?, ?, 'Budget Product', '🚀', 75, 180, 0, 'clear', datetime('now'), datetime('now'))`,
    [productId, workspaceId],
  );
}

test('cost reporting separates provider actual, mission estimate, and legacy mixed totals', () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const productId = crypto.randomUUID();

  seedWorkspace(workspaceId);
  seedProduct(productId, workspaceId);

  run(
    `INSERT INTO tasks (
       id, title, status, priority, workspace_id, business_id, product_id, estimated_cost_usd,
       actual_cost_usd, reserved_cost_usd, budget_status, budget_block_reason, created_at, updated_at
     ) VALUES
       (?, 'Active cap blocked', 'assigned', 'high', ?, 'default', ?, 60, 0, 0, 'blocked', 'workspace_daily_cap_exceeded', datetime('now'), datetime('now')),
       (?, 'Historical blocked', 'done', 'normal', ?, 'default', ?, 10, 0, 0, 'blocked', 'workspace_daily_cap_exceeded', datetime('now'), datetime('now')),
       (?, 'Unpriced build', 'done', 'normal', ?, 'default', ?, 3, 0, 0, 'blocked', 'usage_missing_accountable_pricing', datetime('now'), datetime('now')),
       (?, 'Reserved build', 'in_progress', 'normal', ?, 'default', ?, 25, 0, 12, 'clear', NULL, datetime('now'), datetime('now'))`,
    [
      crypto.randomUUID(), workspaceId, productId,
      crypto.randomUUID(), workspaceId, productId,
      crypto.randomUUID(), workspaceId, productId,
      crypto.randomUUID(), workspaceId, productId,
    ],
  );

  run(
    `INSERT INTO cost_events (
       id, product_id, workspace_id, event_type, provider, model, tokens_input, tokens_output, cost_usd, ledger_type, pricing_basis, created_at
     ) VALUES
       (?, ?, ?, 'build_task', 'qwen', 'qwen/qwen3.6-plus', 100, 40, 4.5, 'provider_actual', 'token_priced', datetime('now')),
       (?, ?, ?, 'build_task', 'opencode-go-mm', 'opencode-go-mm/minimax-m2.5', 0, 0, 1.2, 'mission_estimate', 'request_estimate', datetime('now')),
       (?, ?, ?, 'research_cycle', 'qwen', 'qwen/qwen3.6-plus', 0, 0, 9.9, 'legacy_mixed', 'legacy', datetime('now'))`,
    [crypto.randomUUID(), productId, workspaceId, crypto.randomUUID(), productId, workspaceId, crypto.randomUUID(), productId, workspaceId],
  );

  const overview = getCostOverview(workspaceId, productId);
  const breakdown = getCostBreakdown(workspaceId, productId);

  assert.equal(overview.provider_actual.total, 4.5);
  assert.equal(overview.mission_estimate.total, 1.2);
  assert.equal(overview.legacy_mixed.total, 9.9);
  assert.equal(overview.provider_reserved_total, 12);
  assert.equal(overview.active_blocked_task_count, 1);
  assert.equal(overview.active_blocked_provider_estimated_usd, 60);
  assert.equal(overview.blocked_unknown_cost_count, 1);

  assert.equal(breakdown.summary.provider_actual_usd, 4.5);
  assert.equal(breakdown.summary.mission_estimate_usd, 1.2);
  assert.equal(breakdown.summary.legacy_mixed_usd, 9.9);
  assert.equal(breakdown.summary.provider_reserved_usd, 12);
  assert.equal(breakdown.summary.active_blocked_task_count, 1);
  assert.equal(breakdown.summary.active_blocked_provider_estimated_usd, 60);
  assert.equal(breakdown.summary.blocked_unknown_cost_count, 1);
  assert.deepEqual(
    breakdown.by_ledger.map(item => item.ledger_type).sort(),
    ['legacy_mixed', 'mission_estimate', 'provider_actual'],
  );
});
