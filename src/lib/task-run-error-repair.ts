import { queryAll, run } from '@/lib/db';

const UNRECONCILED_RUN_ERROR_PREFIX = 'Run ended without completion callback or workflow handoff';

export interface SuccessfulTaskRunErrorRepairRow {
  id: string;
  title: string;
  status: string;
  planning_dispatch_error: string | null;
  status_reason: string | null;
}

export interface SuccessfulTaskRunErrorRepairSummary {
  dryRun: boolean;
  workspaceId: string | null;
  scannedSuccessfulTasks: number;
  staleSuccessfulTasks: number;
  clearedPlanningDispatchError: number;
  clearedStatusReason: number;
  repairedTaskIds: string[];
}

export function repairSuccessfulTaskRunErrors(
  now: string,
  options?: { dryRun?: boolean; workspaceId?: string | null },
): SuccessfulTaskRunErrorRepairSummary {
  const dryRun = options?.dryRun !== false;
  const workspaceId = options?.workspaceId?.trim() || null;
  const params: unknown[] = [];

  let successfulTaskCountSql = `SELECT COUNT(*) AS count FROM tasks WHERE status = 'done'`;
  if (workspaceId) {
    successfulTaskCountSql += ' AND workspace_id = ?';
    params.push(workspaceId);
  }
  const successfulTaskCount = queryAll<{ count: number }>(successfulTaskCountSql, params)[0]?.count || 0;

  const staleParams: unknown[] = [];
  let staleSql = `SELECT id, title, status, planning_dispatch_error, status_reason
                  FROM tasks
                  WHERE status = 'done'
                    AND (
                      planning_dispatch_error LIKE ?
                      OR status_reason LIKE ?
                    )`;
  staleParams.push(`${UNRECONCILED_RUN_ERROR_PREFIX}%`, `${UNRECONCILED_RUN_ERROR_PREFIX}%`);
  if (workspaceId) {
    staleSql += ' AND workspace_id = ?';
    staleParams.push(workspaceId);
  }
  staleSql += ' ORDER BY updated_at DESC, created_at DESC, id DESC';

  const staleTasks = queryAll<SuccessfulTaskRunErrorRepairRow>(staleSql, staleParams);
  const repairedTaskIds = staleTasks.map((task) => task.id);
  const clearedPlanningDispatchError = staleTasks.filter((task) =>
    (task.planning_dispatch_error || '').startsWith(UNRECONCILED_RUN_ERROR_PREFIX),
  ).length;
  const clearedStatusReason = staleTasks.filter((task) =>
    (task.status_reason || '').startsWith(UNRECONCILED_RUN_ERROR_PREFIX),
  ).length;

  if (!dryRun && staleTasks.length > 0) {
    for (const task of staleTasks) {
      run(
        `UPDATE tasks
         SET planning_dispatch_error = CASE
               WHEN planning_dispatch_error LIKE ? THEN NULL
               ELSE planning_dispatch_error
             END,
             status_reason = CASE
               WHEN status_reason LIKE ? THEN NULL
               ELSE status_reason
             END,
             updated_at = ?
         WHERE id = ?`,
        [`${UNRECONCILED_RUN_ERROR_PREFIX}%`, `${UNRECONCILED_RUN_ERROR_PREFIX}%`, now, task.id],
      );
    }
  }

  return {
    dryRun,
    workspaceId,
    scannedSuccessfulTasks: successfulTaskCount,
    staleSuccessfulTasks: staleTasks.length,
    clearedPlanningDispatchError,
    clearedStatusReason,
    repairedTaskIds,
  };
}
