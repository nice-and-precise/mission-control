import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, run } from '@/lib/db';
import { createProviderBillingSnapshot, getProviderBillingReconciliation } from './reconciliation';

const TEST_DB_PATH = process.env.DATABASE_PATH || join(tmpdir(), `mission-control-tests-${process.pid}.sqlite`);
process.env.DATABASE_PATH = TEST_DB_PATH;

afterEach(() => {
  closeDb();
});

test('provider reconciliation compares imported totals against provider_actual spend without mutating task allocations', () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const productId = crypto.randomUUID();

  run(
    `INSERT INTO workspaces (
       id, name, slug, cost_cap_daily, cost_cap_monthly, reserved_cost_usd, budget_status, created_at, updated_at
     ) VALUES (?, ?, ?, 20, 100, 0, 'clear', datetime('now'), datetime('now'))`,
    [workspaceId, `Workspace ${workspaceId}`, workspaceId],
  );
  run(
    `INSERT INTO products (
       id, workspace_id, name, icon, cost_cap_per_task, cost_cap_monthly, reserved_cost_usd, budget_status, created_at, updated_at
     ) VALUES (?, ?, 'Recon Product', '🚀', 10, 50, 0, 'clear', datetime('now'), datetime('now'))`,
    [productId, workspaceId],
  );
  run(
    `INSERT INTO cost_events (
       id, product_id, workspace_id, event_type, provider, model, cost_usd, ledger_type, pricing_basis, created_at
     ) VALUES
       (?, ?, ?, 'build_task', 'qwen', 'qwen/qwen3.6-plus', 12.5, 'provider_actual', 'token_priced', '2026-04-06T12:00:00.000Z'),
       (?, ?, ?, 'build_task', 'opencode-go-mm', 'opencode-go-mm/minimax-m2.5', 4.25, 'mission_estimate', 'request_estimate', '2026-04-06T12:00:00.000Z')`,
    [crypto.randomUUID(), productId, workspaceId, crypto.randomUUID(), productId, workspaceId],
  );

  createProviderBillingSnapshot({
    workspace_id: workspaceId,
    product_id: productId,
    provider: 'qwen',
    billing_period: '2026-04',
    imported_total_usd: 14,
    provider_account_label: 'Alibaba Cloud',
    source: 'manual_import',
    notes: 'April reference export',
  });

  const reconciliation = getProviderBillingReconciliation(workspaceId, productId);
  assert.equal(reconciliation.items.length, 1);
  assert.equal(reconciliation.items[0]?.provider, 'qwen');
  assert.equal(reconciliation.items[0]?.provider_actual_total_usd, 12.5);
  assert.equal(reconciliation.items[0]?.imported_total_usd, 14);
  assert.equal(reconciliation.items[0]?.delta_usd, 1.5);
});
