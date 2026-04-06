import { queryOne } from '@/lib/db';

export const AGENT_EXECUTING_STATUSES = ['in_progress', 'testing', 'review', 'verification', 'convoy_active'] as const;

export interface BlockingTaskSummary {
  id: string;
  title: string;
  status: string;
}

export function findBlockingActiveTask(
  agentId: string,
  taskId: string,
  workspaceId: string,
): BlockingTaskSummary | null {
  const placeholders = AGENT_EXECUTING_STATUSES.map(() => '?').join(', ');

  return queryOne<BlockingTaskSummary>(
    `SELECT id, title, status
     FROM tasks
     WHERE assigned_agent_id = ?
       AND id != ?
       AND workspace_id = ?
       AND status IN (${placeholders})
     ORDER BY updated_at DESC
     LIMIT 1`,
    [agentId, taskId, workspaceId, ...AGENT_EXECUTING_STATUSES],
  ) || null;
}

export function buildQueuedTaskWaitingMessage(
  agentName: string,
  blockingTaskTitle: string,
): string {
  return `Waiting for ${agentName} to finish "${blockingTaskTitle}" before starting this task.`;
}
