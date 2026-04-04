import { queryOne, queryAll } from '@/lib/db';
import { UNKNOWN_COST_REASONS } from '@/lib/costs/budget-policy';
import type { CostBreakdown, CostOverview } from '@/lib/types';

interface PerFeatureStats {
  avg_cost_per_idea: number;
  avg_cost_per_shipped_feature: number;
  total_ideas_cost: number;
  total_build_cost: number;
}

function costEventsWhere(workspaceId: string, productId?: string): { clause: string; params: unknown[] } {
  if (productId) {
    return {
      clause: 'workspace_id = ? AND product_id = ?',
      params: [workspaceId, productId],
    };
  }
  return {
    clause: 'workspace_id = ?',
    params: [workspaceId],
  };
}

function tasksWhere(workspaceId: string, productId?: string): { clause: string; params: unknown[] } {
  if (productId) {
    return {
      clause: 'workspace_id = ? AND product_id = ?',
      params: [workspaceId, productId],
    };
  }
  return {
    clause: 'workspace_id = ?',
    params: [workspaceId],
  };
}

export function getCostOverview(workspaceId: string, productId?: string): CostOverview {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();

  // Start of week (Monday)
  const dayOfWeek = now.getDay();
  const diffToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diffToMonday).toISOString();

  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const costScope = costEventsWhere(workspaceId, productId);
  const taskScope = tasksWhere(workspaceId, productId);

  const today = queryOne<{ total: number }>(
    `SELECT COALESCE(SUM(cost_usd), 0) as total FROM cost_events WHERE ${costScope.clause} AND created_at >= ?`,
    [...costScope.params, todayStart]
  );
  const week = queryOne<{ total: number }>(
    `SELECT COALESCE(SUM(cost_usd), 0) as total FROM cost_events WHERE ${costScope.clause} AND created_at >= ?`,
    [...costScope.params, weekStart]
  );
  const month = queryOne<{ total: number }>(
    `SELECT COALESCE(SUM(cost_usd), 0) as total FROM cost_events WHERE ${costScope.clause} AND created_at >= ?`,
    [...costScope.params, monthStart]
  );
  const total = queryOne<{ total: number }>(
    `SELECT COALESCE(SUM(cost_usd), 0) as total FROM cost_events WHERE ${costScope.clause}`,
    costScope.params
  );
  const reserved = queryOne<{ total: number }>(
    `SELECT COALESCE(SUM(reserved_cost_usd), 0) as total FROM tasks WHERE ${taskScope.clause}`,
    taskScope.params
  );
  const activeBlockedTaskCount = queryOne<{ count: number }>(
    `SELECT COUNT(*) as count
     FROM tasks
     WHERE ${taskScope.clause}
       AND budget_status = 'blocked'
       AND status NOT IN ('done', 'cancelled')`,
    taskScope.params
  );
  const activeBlockedEstimatedUsd = queryOne<{ total: number }>(
    `SELECT COALESCE(SUM(estimated_cost_usd), 0) as total
     FROM tasks
     WHERE ${taskScope.clause}
       AND budget_status = 'blocked'
       AND status NOT IN ('done', 'cancelled')`,
    taskScope.params
  );
  const blockedUnknownCostCount = queryOne<{ count: number }>(
    `SELECT COUNT(*) as count
     FROM tasks
     WHERE ${taskScope.clause}
       AND budget_status = 'blocked'
       AND budget_block_reason IN (${UNKNOWN_COST_REASONS.map(() => '?').join(', ')})`,
    [...taskScope.params, ...UNKNOWN_COST_REASONS]
  );
  const unpricedBuildRunsCount = queryOne<{ count: number }>(
    `SELECT COUNT(*) as count
     FROM openclaw_sessions os
     JOIN tasks t ON t.id = os.task_id
     WHERE ${productId ? 't.workspace_id = ? AND t.product_id = ?' : 't.workspace_id = ?'}
       AND os.usage_sync_status = 'unpriced'`,
    productId ? [workspaceId, productId] : [workspaceId],
  );

  return {
    today: today?.total || 0,
    this_week: week?.total || 0,
    this_month: month?.total || 0,
    total: total?.total || 0,
    reserved_total: reserved?.total || 0,
    active_blocked_task_count: activeBlockedTaskCount?.count || 0,
    active_blocked_estimated_usd: activeBlockedEstimatedUsd?.total || 0,
    blocked_unknown_cost_count: blockedUnknownCostCount?.count || 0,
    unpriced_build_runs_count: unpricedBuildRunsCount?.count || 0,
  };
}

export function getCostBreakdown(workspaceId: string, productId?: string): CostBreakdown {
  const costScope = costEventsWhere(workspaceId, productId);
  const taskScope = tasksWhere(workspaceId, productId);
  const by_event_type = queryAll<{ event_type: string; total: number; count: number }>(
    `SELECT event_type, SUM(cost_usd) as total, COUNT(*) as count
     FROM cost_events WHERE ${costScope.clause}
     GROUP BY event_type ORDER BY total DESC`,
    costScope.params
  );

  const by_product = queryAll<{ product_id: string; product_name: string; total: number; count: number }>(
    `SELECT ce.product_id, COALESCE(p.name, 'Unassigned') as product_name, SUM(ce.cost_usd) as total, COUNT(*) as count
     FROM cost_events ce LEFT JOIN products p ON ce.product_id = p.id
     WHERE ${productId ? 'ce.workspace_id = ? AND ce.product_id = ?' : 'ce.workspace_id = ?'}
     GROUP BY ce.product_id ORDER BY total DESC`,
    productId ? [workspaceId, productId] : [workspaceId]
  );

  const by_agent = queryAll<{ agent_id: string; agent_name: string; total: number; count: number }>(
    `SELECT ce.agent_id, COALESCE(a.name, 'Unknown') as agent_name, SUM(ce.cost_usd) as total, COUNT(*) as count
     FROM cost_events ce LEFT JOIN agents a ON ce.agent_id = a.id
     WHERE ${productId ? 'ce.workspace_id = ? AND ce.product_id = ?' : 'ce.workspace_id = ?'}
     GROUP BY ce.agent_id ORDER BY total DESC`,
    productId ? [workspaceId, productId] : [workspaceId]
  );

  const summary = {
    actual_recorded_usd: queryOne<{ total: number }>(
      `SELECT COALESCE(SUM(cost_usd), 0) as total FROM cost_events WHERE ${costScope.clause}`,
      costScope.params,
    )?.total || 0,
    reserved_estimated_usd: queryOne<{ total: number }>(
      `SELECT COALESCE(SUM(reserved_cost_usd), 0) as total FROM tasks WHERE ${taskScope.clause}`,
      taskScope.params,
    )?.total || 0,
    active_blocked_task_count: queryOne<{ count: number }>(
      `SELECT COUNT(*) as count
       FROM tasks
       WHERE ${taskScope.clause}
         AND budget_status = 'blocked'
         AND status NOT IN ('done', 'cancelled')`,
      taskScope.params,
    )?.count || 0,
    active_blocked_estimated_usd: queryOne<{ total: number }>(
      `SELECT COALESCE(SUM(estimated_cost_usd), 0) as total
       FROM tasks
       WHERE ${taskScope.clause}
         AND budget_status = 'blocked'
         AND status NOT IN ('done', 'cancelled')`,
      taskScope.params,
    )?.total || 0,
    blocked_unknown_cost_count: queryOne<{ count: number }>(
      `SELECT COUNT(*) as count
       FROM tasks
       WHERE ${taskScope.clause}
         AND budget_status = 'blocked'
         AND budget_block_reason IN (${UNKNOWN_COST_REASONS.map(() => '?').join(', ')})`,
      [...taskScope.params, ...UNKNOWN_COST_REASONS],
    )?.count || 0,
    unpriced_build_runs_count: queryOne<{ count: number }>(
      `SELECT COUNT(*) as count
       FROM openclaw_sessions os
       JOIN tasks t ON t.id = os.task_id
       WHERE ${productId ? 't.workspace_id = ? AND t.product_id = ?' : 't.workspace_id = ?'}
         AND os.usage_sync_status = 'unpriced'`,
      productId ? [workspaceId, productId] : [workspaceId],
    )?.count || 0,
  };

  return { by_event_type, by_product, by_agent, summary };
}

export function getPerFeatureStats(workspaceId: string, productId?: string): PerFeatureStats {
  const costScope = costEventsWhere(workspaceId, productId);
  const ideaCost = queryOne<{ total: number }>(
    `SELECT COALESCE(SUM(cost_usd), 0) as total FROM cost_events
     WHERE ${costScope.clause} AND event_type IN ('research_cycle', 'ideation_cycle')`,
    costScope.params
  );

  const buildCost = queryOne<{ total: number }>(
    `SELECT COALESCE(SUM(cost_usd), 0) as total FROM cost_events
     WHERE ${costScope.clause} AND event_type = 'build_task'`,
    costScope.params
  );

  const ideaCount = queryOne<{ count: number }>(
    productId
      ? `SELECT COUNT(*) as count FROM ideas WHERE product_id = ?`
      : `SELECT COUNT(*) as count FROM ideas WHERE product_id IN (SELECT id FROM products WHERE workspace_id = ?)`,
    [productId || workspaceId]
  );

  const shippedCount = queryOne<{ count: number }>(
    productId
      ? `SELECT COUNT(*) as count FROM ideas WHERE status = 'shipped' AND product_id = ?`
      : `SELECT COUNT(*) as count FROM ideas WHERE status = 'shipped' AND product_id IN (SELECT id FROM products WHERE workspace_id = ?)`,
    [productId || workspaceId]
  );

  const totalIdeas = ideaCount?.count || 0;
  const totalShipped = shippedCount?.count || 0;

  return {
    avg_cost_per_idea: totalIdeas > 0 ? (ideaCost?.total || 0) / totalIdeas : 0,
    avg_cost_per_shipped_feature: totalShipped > 0 ? ((ideaCost?.total || 0) + (buildCost?.total || 0)) / totalShipped : 0,
    total_ideas_cost: ideaCost?.total || 0,
    total_build_cost: buildCost?.total || 0,
  };
}
