import { getDb, queryAll, queryOne, run } from '@/lib/db';

export interface ActiveRootSessionRepairSummary {
  dryRun: boolean;
  scannedActiveRootSessions: number;
  missingActiveTaskPointer: number;
  missingAttachedTask: number;
  terminalTaskAttachment: number;
  ownerMismatchAttachment: number;
  backfilledActiveTaskPointer: number;
  detachedStaleAttachments: number;
}

function assertActiveTaskPointerAvailable(): void {
  const columns = getDb().prepare('PRAGMA table_info(openclaw_sessions)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'active_task_id')) {
    throw new Error(
      'openclaw_sessions.active_task_id is missing in this database. Run migrations before repairing session attachments.',
    );
  }
}

export function endActiveTaskSessions(taskId: string, now: string): void {
  run(
    `UPDATE openclaw_sessions
     SET status = 'ended',
         active_task_id = NULL,
         ended_at = COALESCE(ended_at, ?),
         updated_at = ?
     WHERE active_task_id = ?
       AND status = 'active'
       AND COALESCE(session_type, 'persistent') != 'subagent'`,
    [now, now, taskId],
  );
}

export function repairActiveRootSessionAttachments(
  now = new Date().toISOString(),
  options: { dryRun?: boolean } = {},
): ActiveRootSessionRepairSummary {
  assertActiveTaskPointerAvailable();

  const dryRun = options.dryRun !== false;
  const scannedActiveRootSessions =
    queryOne<{ count: number }>(
      `SELECT COUNT(*) AS count
       FROM openclaw_sessions
       WHERE status = 'active'
         AND COALESCE(session_type, 'persistent') != 'subagent'`,
    )?.count || 0;
  const missingActiveTaskPointer =
    queryOne<{ count: number }>(
      `SELECT COUNT(*) AS count
       FROM openclaw_sessions
       WHERE status = 'active'
         AND COALESCE(session_type, 'persistent') != 'subagent'
         AND task_id IS NOT NULL
         AND active_task_id IS NULL`,
    )?.count || 0;
  const missingAttachedTask =
    queryOne<{ count: number }>(
      `SELECT COUNT(*) AS count
       FROM openclaw_sessions os
       LEFT JOIN tasks t ON t.id = os.active_task_id
       WHERE os.status = 'active'
         AND COALESCE(os.session_type, 'persistent') != 'subagent'
         AND os.active_task_id IS NOT NULL
         AND t.id IS NULL`,
    )?.count || 0;
  const terminalTaskAttachment =
    queryOne<{ count: number }>(
      `SELECT COUNT(*) AS count
       FROM openclaw_sessions os
       JOIN tasks t ON t.id = os.active_task_id
       WHERE os.status = 'active'
         AND COALESCE(os.session_type, 'persistent') != 'subagent'
         AND t.status IN ('pending_dispatch', 'planning', 'inbox', 'done')`,
    )?.count || 0;
  const ownerMismatchAttachment =
    queryOne<{ count: number }>(
      `SELECT COUNT(*) AS count
       FROM openclaw_sessions os
       JOIN tasks t ON t.id = os.active_task_id
       WHERE os.status = 'active'
         AND COALESCE(os.session_type, 'persistent') != 'subagent'
         AND t.assigned_agent_id IS NOT NULL
         AND os.agent_id IS NOT NULL
         AND t.assigned_agent_id != os.agent_id`,
    )?.count || 0;

  if (dryRun) {
    return {
      dryRun,
      scannedActiveRootSessions,
      missingActiveTaskPointer,
      missingAttachedTask,
      terminalTaskAttachment,
      ownerMismatchAttachment,
      backfilledActiveTaskPointer: 0,
      detachedStaleAttachments: 0,
    };
  }

  const backfilledActiveTaskPointer = run(
    `UPDATE openclaw_sessions
     SET active_task_id = task_id,
         updated_at = ?
     WHERE status = 'active'
       AND COALESCE(session_type, 'persistent') != 'subagent'
       AND task_id IS NOT NULL
       AND active_task_id IS NULL`,
    [now],
  ).changes;

  const staleSessionIds = queryAll<{ id: string }>(
    `SELECT os.id
     FROM openclaw_sessions os
     LEFT JOIN tasks t ON t.id = os.active_task_id
     WHERE os.status = 'active'
       AND COALESCE(os.session_type, 'persistent') != 'subagent'
       AND (
         (os.active_task_id IS NOT NULL AND t.id IS NULL)
         OR t.status IN ('pending_dispatch', 'planning', 'inbox', 'done')
         OR (
           t.assigned_agent_id IS NOT NULL
           AND os.agent_id IS NOT NULL
           AND t.assigned_agent_id != os.agent_id
         )
       )`,
  ).map((row) => row.id);

  let detachedStaleAttachments = 0;
  if (staleSessionIds.length > 0) {
    const placeholders = staleSessionIds.map(() => '?').join(', ');
    detachedStaleAttachments = run(
      `UPDATE openclaw_sessions
       SET status = 'ended',
           active_task_id = NULL,
           ended_at = COALESCE(ended_at, ?),
           updated_at = ?
       WHERE id IN (${placeholders})`,
      [now, now, ...staleSessionIds],
    ).changes;
  }

  return {
    dryRun,
    scannedActiveRootSessions,
    missingActiveTaskPointer,
    missingAttachedTask,
    terminalTaskAttachment,
    ownerMismatchAttachment,
    backfilledActiveTaskPointer,
    detachedStaleAttachments,
  };
}
