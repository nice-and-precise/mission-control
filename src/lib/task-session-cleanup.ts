import { run } from '@/lib/db';

export function endActiveTaskSessions(taskId: string, now: string): void {
  run(
    `UPDATE openclaw_sessions
     SET status = 'ended',
         ended_at = COALESCE(ended_at, ?),
         updated_at = ?
     WHERE task_id = ?
       AND status = 'active'`,
    [now, now, taskId],
  );
}
