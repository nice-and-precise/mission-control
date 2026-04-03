import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, queryOne, run } from '@/lib/db';
import { enforceBudgetPolicy } from './budget-policy';
import { recordCostEvent } from './tracker';

const TEST_DB_PATH = process.env.DATABASE_PATH || join(tmpdir(), `mission-control-tests-${process.pid}.sqlite`);
process.env.DATABASE_PATH = TEST_DB_PATH;

afterEach(() => {
  closeDb();
});

function seedWorkspace(workspaceId: string, dailyCap = 20, monthlyCap = 100) {
  run(
    `INSERT INTO workspaces (
       id, name, slug, cost_cap_daily, cost_cap_monthly, reserved_cost_usd, budget_status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 0, 'clear', datetime('now'), datetime('now'))`,
    [workspaceId, `Workspace ${workspaceId}`, workspaceId, dailyCap, monthlyCap],
  );
}

function seedProduct(productId: string, workspaceId: string, taskCap: number | null, monthlyCap: number | null) {
  run(
    `INSERT INTO products (
       id, workspace_id, name, icon, cost_cap_per_task, cost_cap_monthly, reserved_cost_usd, budget_status, created_at, updated_at
     ) VALUES (?, ?, ?, '🚀', ?, ?, 0, 'clear', datetime('now'), datetime('now'))`,
    [productId, workspaceId, `Product ${productId}`, taskCap, monthlyCap],
  );
}

function seedTask(taskId: string, workspaceId: string, productId: string, estimatedCostUsd: number) {
  run(
    `INSERT INTO tasks (
       id, title, status, priority, workspace_id, business_id, product_id, estimated_cost_usd, actual_cost_usd, reserved_cost_usd, created_at, updated_at
     ) VALUES (?, ?, 'assigned', 'normal', ?, 'default', ?, ?, 0, 0, datetime('now'), datetime('now'))`,
    [taskId, `Task ${taskId}`, workspaceId, productId, estimatedCostUsd],
  );
}

test('dispatch budget policy reserves task spend and reconciles when actual build cost arrives', () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const productId = crypto.randomUUID();
  const taskId = crypto.randomUUID();

  seedWorkspace(workspaceId);
  seedProduct(productId, workspaceId, 15, 40);
  seedTask(taskId, workspaceId, productId, 10);

  const result = enforceBudgetPolicy({
    action: 'dispatch',
    workspaceId,
    productId,
    taskId,
    model: 'openai-codex/gpt-5.4',
    reserveCostUsd: 10,
  });

  assert.equal(result.ok, true);
  assert.equal(result.reserveCostUsd, 10);

  const reservedBefore = queryOne<{
    task_reserved: number;
    product_reserved: number;
    workspace_reserved: number;
  }>(
    `SELECT
       (SELECT reserved_cost_usd FROM tasks WHERE id = ?) AS task_reserved,
       (SELECT reserved_cost_usd FROM products WHERE id = ?) AS product_reserved,
       (SELECT reserved_cost_usd FROM workspaces WHERE id = ?) AS workspace_reserved`,
    [taskId, productId, workspaceId],
  );

  assert.equal(reservedBefore?.task_reserved, 10);
  assert.equal(reservedBefore?.product_reserved, 10);
  assert.equal(reservedBefore?.workspace_reserved, 10);

  recordCostEvent({
    workspace_id: workspaceId,
    product_id: productId,
    task_id: taskId,
    event_type: 'build_task',
    model: 'openai-codex/gpt-5.4',
    cost_usd: 10,
  });

  const reconciled = queryOne<{
    task_reserved: number;
    task_actual: number;
    product_reserved: number;
    workspace_reserved: number;
  }>(
    `SELECT
       (SELECT reserved_cost_usd FROM tasks WHERE id = ?) AS task_reserved,
       (SELECT actual_cost_usd FROM tasks WHERE id = ?) AS task_actual,
       (SELECT reserved_cost_usd FROM products WHERE id = ?) AS product_reserved,
       (SELECT reserved_cost_usd FROM workspaces WHERE id = ?) AS workspace_reserved`,
    [taskId, taskId, productId, workspaceId],
  );

  assert.equal(reconciled?.task_reserved, 0);
  assert.equal(reconciled?.task_actual, 10);
  assert.equal(reconciled?.product_reserved, 0);
  assert.equal(reconciled?.workspace_reserved, 0);
});

test('dispatch budget policy hard-blocks products missing required monthly caps', () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const productId = crypto.randomUUID();
  const taskId = crypto.randomUUID();

  seedWorkspace(workspaceId);
  seedProduct(productId, workspaceId, 15, null);
  seedTask(taskId, workspaceId, productId, 8);

  const result = enforceBudgetPolicy({
    action: 'dispatch',
    workspaceId,
    productId,
    taskId,
    model: 'openai-codex/gpt-5.4',
    reserveCostUsd: 8,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, 'missing_product_monthly_cap');

  const blocked = queryOne<{
    workspace_status: string;
    product_status: string;
    task_status: string;
    product_reason: string | null;
  }>(
    `SELECT
       (SELECT budget_status FROM workspaces WHERE id = ?) AS workspace_status,
       (SELECT budget_status FROM products WHERE id = ?) AS product_status,
       (SELECT budget_status FROM tasks WHERE id = ?) AS task_status,
       (SELECT budget_block_reason FROM products WHERE id = ?) AS product_reason`,
    [workspaceId, productId, taskId, productId],
  );

  assert.equal(blocked?.workspace_status, 'blocked');
  assert.equal(blocked?.product_status, 'blocked');
  assert.equal(blocked?.task_status, 'blocked');
  assert.equal(blocked?.product_reason, 'missing_product_monthly_cap');
});
