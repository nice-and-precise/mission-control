import { queryOne, run } from '@/lib/db';
import {
  estimateMissionControlModelCost,
  getMissionControlModelPolicy,
  supportsMissionControlAccounting,
  supportsProviderActualAccounting,
} from '@/lib/openclaw/model-policy';
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
const CAP_REASONS = new Set([
  'workspace_daily_cap_exceeded',
  'workspace_monthly_cap_exceeded',
  'product_monthly_cap_exceeded',
  'task_cap_exceeded',
]);

export const UNKNOWN_COST_REASONS = ['model_unpriced', 'usage_missing_accountable_pricing'] as const;
const UNKNOWN_COST_REASON_SET = new Set<string>(UNKNOWN_COST_REASONS);

export function isCapBudgetReason(reason?: string | null): boolean {
  return !!reason && CAP_REASONS.has(reason);
}

export function isUnknownCostBudgetReason(reason?: string | null): boolean {
  return !!reason && UNKNOWN_COST_REASON_SET.has(reason);
}

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
  const providerPricedModel = supportsProviderActualAccounting(input.model);
  const effectiveRequestedReserve = providerPricedModel ? requestedReserve : 0;
  const additionalReserve = Math.max(effectiveRequestedReserve - currentTaskReserve, 0);

  if (!supportsMissionControlAccounting(input.model)) {
    return blockBudgetState(
      input,
      'model_unpriced',
      `Model ${input.model} does not have accountable pricing metadata for Mission Control.`,
    );
  }

  if (!providerPricedModel) {
    if (input.taskId) {
      run(
        `UPDATE tasks
         SET budget_status = ?,
             budget_block_reason = NULL,
             reserved_cost_usd = 0,
             updated_at = ?
         WHERE id = ?`,
        [CLEAR_STATUS, new Date().toISOString(), input.taskId],
      );
    }
    syncReservedSpendTotals(input.workspaceId, input.productId || undefined);
    return {
      ok: true,
      model: input.model,
      reserveCostUsd: 0,
    };
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

  if (input.action === 'dispatch' && product?.cost_cap_per_task != null && effectiveRequestedReserve > product.cost_cap_per_task) {
    return blockBudgetState(
      input,
      'task_cap_exceeded',
      `Mission Control provider reserve block: requested provider-priced reserve $${effectiveRequestedReserve.toFixed(2)} exceeds the product per-task cap of $${product.cost_cap_per_task.toFixed(2)}. This is a local Mission Control planning limit tied to provider-priced usage, not subscription quota usage or imported billing snapshots.`,
    );
  }

  const todayTotals = getWorkspaceSpendTotals(input.workspaceId, startOfTodayIso());
  if (todayTotals.actual + todayTotals.reserved + additionalReserve > Number(workspace.cost_cap_daily)) {
    return blockBudgetState(
      input,
      'workspace_daily_cap_exceeded',
      buildCapExceededMessage({
        label: 'workspace daily cap',
        actual: todayTotals.actual,
        reserved: todayTotals.reserved,
        requestedReserve: additionalReserve,
        total: todayTotals.actual + todayTotals.reserved + additionalReserve,
        limit: Number(workspace.cost_cap_daily),
      }),
    );
  }

  const monthTotals = getWorkspaceSpendTotals(input.workspaceId, startOfMonthIso());
  if (monthTotals.actual + monthTotals.reserved + additionalReserve > Number(workspace.cost_cap_monthly)) {
    return blockBudgetState(
      input,
      'workspace_monthly_cap_exceeded',
      buildCapExceededMessage({
        label: 'workspace monthly cap',
        actual: monthTotals.actual,
        reserved: monthTotals.reserved,
        requestedReserve: additionalReserve,
        total: monthTotals.actual + monthTotals.reserved + additionalReserve,
        limit: Number(workspace.cost_cap_monthly),
      }),
    );
  }

  if (product) {
    const productMonthTotals = getProductSpendTotals(product.id, startOfMonthIso());
    if (productMonthTotals.actual + productMonthTotals.reserved + additionalReserve > Number(product.cost_cap_monthly)) {
      return blockBudgetState(
        input,
        'product_monthly_cap_exceeded',
        buildCapExceededMessage({
          label: 'product monthly cap',
          actual: productMonthTotals.actual,
          reserved: productMonthTotals.reserved,
          requestedReserve: additionalReserve,
          total: productMonthTotals.actual + productMonthTotals.reserved + additionalReserve,
          limit: Number(product.cost_cap_monthly),
        }),
      );
    }
  }

  if (input.taskId) {
    run(
      `UPDATE tasks
       SET budget_status = ?,
           budget_block_reason = NULL,
           reserved_cost_usd = ?,
           updated_at = ?
       WHERE id = ?`,
      [CLEAR_STATUS, Math.max(currentTaskReserve, effectiveRequestedReserve), new Date().toISOString(), input.taskId],
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
    reserveCostUsd: Math.max(currentTaskReserve, effectiveRequestedReserve),
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

  reconcileBudgetStateForScope(workspaceId, productId);
}

export function reconcileBudgetStateForScope(workspaceId: string, productId?: string): void {
  const workspace = queryOne<Workspace>('SELECT * FROM workspaces WHERE id = ?', [workspaceId]);
  if (!workspace) return;

  const activeWorkspaceCapReason = queryOne<{ reason: string | null }>(
    `SELECT budget_block_reason AS reason
     FROM tasks
     WHERE workspace_id = ?
       AND budget_status = 'blocked'
       AND status NOT IN ('done', 'cancelled')
       AND budget_block_reason IN (${Array.from(CAP_REASONS).map(() => '?').join(', ')})
     ORDER BY updated_at DESC, created_at DESC
     LIMIT 1`,
    [workspaceId, ...Array.from(CAP_REASONS)],
  )?.reason;

  if (activeWorkspaceCapReason) {
    setEntityBudgetState('workspaces', workspaceId, BLOCKED_STATUS, activeWorkspaceCapReason);
  } else if (
    isCapBudgetReason(workspace.budget_block_reason)
    && !workspaceCapsExceeded(workspaceId, workspace)
  ) {
    clearEntityBudgetState('workspaces', workspaceId);
  }

  if (!productId) return;

  const product = queryOne<Product>('SELECT * FROM products WHERE id = ?', [productId]);
  if (!product) return;

  const activeProductCapReason = queryOne<{ reason: string | null }>(
    `SELECT budget_block_reason AS reason
     FROM tasks
     WHERE product_id = ?
       AND budget_status = 'blocked'
       AND status NOT IN ('done', 'cancelled')
       AND budget_block_reason IN (${Array.from(CAP_REASONS).map(() => '?').join(', ')})
     ORDER BY updated_at DESC, created_at DESC
     LIMIT 1`,
    [productId, ...Array.from(CAP_REASONS)],
  )?.reason;

  if (activeProductCapReason) {
    setEntityBudgetState('products', productId, BLOCKED_STATUS, activeProductCapReason);
  } else if (
    isCapBudgetReason(product.budget_block_reason)
    && !productCapsExceeded(productId, product)
    && !workspaceCapsExceeded(workspaceId, workspace)
  ) {
    clearEntityBudgetState('products', productId);
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
  run(
    `UPDATE ${entity}
     SET budget_status = ?, budget_block_reason = ?, updated_at = ?
     WHERE id = ?`,
    [status, reason, new Date().toISOString(), id],
  );
}

function clearEntityBudgetState(entity: BudgetEntity, id: string): void {
  run(
    `UPDATE ${entity}
     SET budget_status = ?, budget_block_reason = NULL, updated_at = ?
     WHERE id = ?`,
    [CLEAR_STATUS, new Date().toISOString(), id],
  );
}

function getWorkspaceSpendTotals(workspaceId: string, periodStart: string): SpendTotals {
  const actual = queryOne<{ total: number }>(
    `SELECT COALESCE(SUM(cost_usd), 0) AS total
     FROM cost_events
     WHERE workspace_id = ?
       AND ledger_type = 'provider_actual'
       AND created_at >= ?`,
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
    `SELECT COALESCE(SUM(cost_usd), 0) AS total
     FROM cost_events
     WHERE product_id = ?
       AND ledger_type = 'provider_actual'
       AND created_at >= ?`,
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

function workspaceCapsExceeded(workspaceId: string, workspace: Workspace): boolean {
  if (workspace.cost_cap_daily != null) {
    const todayTotals = getWorkspaceSpendTotals(workspaceId, startOfTodayIso());
    if (todayTotals.actual + todayTotals.reserved > Number(workspace.cost_cap_daily)) {
      return true;
    }
  }

  if (workspace.cost_cap_monthly != null) {
    const monthTotals = getWorkspaceSpendTotals(workspaceId, startOfMonthIso());
    if (monthTotals.actual + monthTotals.reserved > Number(workspace.cost_cap_monthly)) {
      return true;
    }
  }

  return false;
}

function productCapsExceeded(productId: string, product: Product): boolean {
  if (product.cost_cap_monthly == null) {
    return false;
  }

  const monthTotals = getProductSpendTotals(productId, startOfMonthIso());
  return monthTotals.actual + monthTotals.reserved > Number(product.cost_cap_monthly);
}

function buildCapExceededMessage(input: {
  label: string;
  actual: number;
  reserved: number;
  requestedReserve: number;
  total: number;
  limit: number;
}): string {
  return `Mission Control provider reserve block: ${input.label} would be exceeded. Provider-priced recorded spend $${input.actual.toFixed(2)} + provider-priced reserved spend $${input.reserved.toFixed(2)} + requested provider-priced reserve $${input.requestedReserve.toFixed(2)} = $${input.total.toFixed(2)} against a cap of $${input.limit.toFixed(2)}. This is a local Mission Control planning limit tied to provider-priced usage, not subscription quota usage or imported billing snapshots.`;
}
