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

test('cost reporting separates active blocked estimated demand from unpriced history', () => {
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
       id, product_id, workspace_id, event_type, provider, model, tokens_input, tokens_output, cost_usd, created_at
     ) VALUES (?, ?, ?, 'build_task', 'openai-codex', 'openai-codex/gpt-5.4', 100, 40, 4.5, datetime('now'))`,
    [crypto.randomUUID(), productId, workspaceId],
  );

  const overview = getCostOverview(workspaceId, productId);
  const breakdown = getCostBreakdown(workspaceId, productId);

  assert.equal(overview.total, 4.5);
  assert.equal(overview.reserved_total, 12);
  assert.equal(overview.active_blocked_task_count, 1);
  assert.equal(overview.active_blocked_estimated_usd, 60);
  assert.equal(overview.blocked_unknown_cost_count, 1);

  assert.equal(breakdown.summary.actual_recorded_usd, 4.5);
  assert.equal(breakdown.summary.reserved_estimated_usd, 12);
  assert.equal(breakdown.summary.active_blocked_task_count, 1);
  assert.equal(breakdown.summary.active_blocked_estimated_usd, 60);
  assert.equal(breakdown.summary.blocked_unknown_cost_count, 1);
});
