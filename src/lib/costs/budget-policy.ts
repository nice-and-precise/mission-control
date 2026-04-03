import { queryOne, run } from '@/lib/db';
import { estimateMissionControlModelCost, getMissionControlModelPolicy, supportsMissionControlAccounting } from '@/lib/openclaw/model-policy';
import type { BudgetStatus, Product, Task, Workspace } from '@/lib/types';

type BudgetEntity = 'workspaces' | 'products' | 'tasks';
type BudgetAction = 'research' | 'ideation' | 'dispatch';

interface BudgetGuardInput {
  action: BudgetAction;
  workspaceId: string;
  productId?: string | null;
  taskId?: string | null;
  model: string;
  reserveCostUsd?: number;
}

export interface BudgetGuardResult {
  ok: boolean;
  model: string;
  reserveCostUsd: number;
  reasonCode?: string;
  message?: string;
}

interface SpendTotals {
  actual: number;
  reserved: number;
}

const CLEAR_STATUS: BudgetStatus = 'clear';
const BLOCKED_STATUS: BudgetStatus = 'blocked';

export function enforceBudgetPolicy(input: BudgetGuardInput): BudgetGuardResult {
  const workspace = queryOne<Workspace>('SELECT * FROM workspaces WHERE id = ?', [input.workspaceId]);
  if (!workspace) {
    return blockBudgetState(input, 'workspace_not_found', `Workspace ${input.workspaceId} not found`);
  }

  const product = input.productId
    ? queryOne<Product>('SELECT * FROM products WHERE id = ?', [input.productId])
    : undefined;
  if (input.productId && !product) {
    return blockBudgetState(input, 'product_not_found', `Product ${input.productId} not found`);
  }

  const task = input.taskId
    ? queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [input.taskId])
    : undefined;
  if (input.taskId && !task) {
    return blockBudgetState(input, 'task_not_found', `Task ${input.taskId} not found`);
  }

  const policy = getMissionControlModelPolicy(input.model);
  if (!policy.policy_allowed) {
    return blockBudgetState(
      input,
      'model_not_allowed',
      policy.policy_reason || `Model ${input.model} is not allowed by Mission Control policy.`,
    );
  }

  const requestedReserve = Math.max(input.reserveCostUsd || 0, 0);
  const currentTaskReserve = task?.reserved_cost_usd || 0;
  const additionalReserve = Math.max(requestedReserve - currentTaskReserve, 0);

  if (!supportsMissionControlAccounting(input.model)) {
    return blockBudgetState(
      input,
      'model_unpriced',
      `Model ${input.model} does not have accountable pricing metadata for Mission Control.`,
    );
  }

  if (workspace.cost_cap_daily == null) {
    return blockBudgetState(input, 'missing_workspace_daily_cap', 'Workspace daily cap is required.');
  }
  if (workspace.cost_cap_monthly == null) {
    return blockBudgetState(input, 'missing_workspace_monthly_cap', 'Workspace monthly cap is required.');
  }
  if (product && product.cost_cap_monthly == null) {
    return blockBudgetState(input, 'missing_product_monthly_cap', 'Product monthly cap is required.');
  }
  if (input.action === 'dispatch' && product && product.cost_cap_per_task == null) {
    return blockBudgetState(input, 'missing_task_cap', 'Product per-task cap is required for dispatch.');
  }

  if (input.action === 'dispatch' && product?.cost_cap_per_task != null && requestedReserve > product.cost_cap_per_task) {
    return blockBudgetState(
      input,
      'task_cap_exceeded',
      `Estimated task cost $${requestedReserve.toFixed(2)} exceeds the per-task cap of $${product.cost_cap_per_task.toFixed(2)}.`,
    );
  }

  const todayTotals = getWorkspaceSpendTotals(input.workspaceId, startOfTodayIso());
  if (todayTotals.actual + todayTotals.reserved + additionalReserve > Number(workspace.cost_cap_daily)) {
    return blockBudgetState(
      input,
      'workspace_daily_cap_exceeded',
      `Workspace daily cap exceeded: $${(todayTotals.actual + todayTotals.reserved + additionalReserve).toFixed(2)} / $${Number(workspace.cost_cap_daily).toFixed(2)}.`,
    );
  }

  const monthTotals = getWorkspaceSpendTotals(input.workspaceId, startOfMonthIso());
  if (monthTotals.actual + monthTotals.reserved + additionalReserve > Number(workspace.cost_cap_monthly)) {
    return blockBudgetState(
      input,
      'workspace_monthly_cap_exceeded',
      `Workspace monthly cap exceeded: $${(monthTotals.actual + monthTotals.reserved + additionalReserve).toFixed(2)} / $${Number(workspace.cost_cap_monthly).toFixed(2)}.`,
    );
  }

  if (product) {
    const productMonthTotals = getProductSpendTotals(product.id, startOfMonthIso());
    if (productMonthTotals.actual + productMonthTotals.reserved + additionalReserve > Number(product.cost_cap_monthly)) {
      return blockBudgetState(
        input,
        'product_monthly_cap_exceeded',
        `Product monthly cap exceeded: $${(productMonthTotals.actual + productMonthTotals.reserved + additionalReserve).toFixed(2)} / $${Number(product.cost_cap_monthly).toFixed(2)}.`,
      );
    }
  }

  if (input.taskId) {
    run(
      `UPDATE tasks SET budget_status = ?, budget_block_reason = NULL, reserved_cost_usd = ? WHERE id = ?`,
      [CLEAR_STATUS, Math.max(currentTaskReserve, requestedReserve), input.taskId],
    );
  }

  clearEntityBudgetState('workspaces', input.workspaceId);
  if (input.productId) {
    clearEntityBudgetState('products', input.productId);
  }

  syncReservedSpendTotals(input.workspaceId, input.productId || undefined);

  return {
    ok: true,
    model: input.model,
    reserveCostUsd: Math.max(currentTaskReserve, requestedReserve),
  };
}

export function recordAutopilotEstimatedCost(args: {
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  requestCount?: number;
}): number | null {
  return estimateMissionControlModelCost(args.model, {
    promptTokens: args.promptTokens,
    completionTokens: args.completionTokens,
    requestCount: args.requestCount,
  });
}

export function syncReservedSpendTotals(workspaceId: string, productId?: string): void {
  const workspaceReserved = queryOne<{ total: number }>(
    `SELECT COALESCE(SUM(reserved_cost_usd), 0) AS total FROM tasks WHERE workspace_id = ?`,
    [workspaceId],
  )?.total || 0;

  run('UPDATE workspaces SET reserved_cost_usd = ? WHERE id = ?', [workspaceReserved, workspaceId]);

  if (productId) {
    const productReserved = queryOne<{ total: number }>(
      `SELECT COALESCE(SUM(reserved_cost_usd), 0) AS total FROM tasks WHERE product_id = ?`,
      [productId],
    )?.total || 0;
    run('UPDATE products SET reserved_cost_usd = ? WHERE id = ?', [productReserved, productId]);
  }
}

function blockBudgetState(input: BudgetGuardInput, reasonCode: string, message: string): BudgetGuardResult {
  setEntityBudgetState('workspaces', input.workspaceId, BLOCKED_STATUS, reasonCode);
  if (input.productId) {
    setEntityBudgetState('products', input.productId, BLOCKED_STATUS, reasonCode);
  }
  if (input.taskId) {
    setEntityBudgetState('tasks', input.taskId, BLOCKED_STATUS, reasonCode);
  }
  syncReservedSpendTotals(input.workspaceId, input.productId || undefined);
  return {
    ok: false,
    model: input.model,
    reserveCostUsd: input.reserveCostUsd || 0,
    reasonCode,
    message,
  };
}

function setEntityBudgetState(entity: BudgetEntity, id: string, status: BudgetStatus, reason: string | null): void {
  run(`UPDATE ${entity} SET budget_status = ?, budget_block_reason = ? WHERE id = ?`, [status, reason, id]);
}

function clearEntityBudgetState(entity: BudgetEntity, id: string): void {
  run(`UPDATE ${entity} SET budget_status = ?, budget_block_reason = NULL WHERE id = ?`, [CLEAR_STATUS, id]);
}

function getWorkspaceSpendTotals(workspaceId: string, periodStart: string): SpendTotals {
  const actual = queryOne<{ total: number }>(
    `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM cost_events WHERE workspace_id = ? AND created_at >= ?`,
    [workspaceId, periodStart],
  )?.total || 0;
  const reserved = queryOne<{ total: number }>(
    `SELECT COALESCE(SUM(reserved_cost_usd), 0) AS total FROM tasks WHERE workspace_id = ? AND created_at >= ?`,
    [workspaceId, periodStart],
  )?.total || 0;
  return { actual, reserved };
}

function getProductSpendTotals(productId: string, periodStart: string): SpendTotals {
  const actual = queryOne<{ total: number }>(
    `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM cost_events WHERE product_id = ? AND created_at >= ?`,
    [productId, periodStart],
  )?.total || 0;
  const reserved = queryOne<{ total: number }>(
    `SELECT COALESCE(SUM(reserved_cost_usd), 0) AS total FROM tasks WHERE product_id = ? AND created_at >= ?`,
    [productId, periodStart],
  )?.total || 0;
  return { actual, reserved };
}

function startOfTodayIso(): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}

function startOfMonthIso(): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
}
