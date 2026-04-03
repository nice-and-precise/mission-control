import { queryAll, queryOne, run } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { movePathToTrash } from '@/lib/file-trash';
import { endActiveTaskSessions } from '@/lib/task-session-cleanup';
import { getTaskWorkflow, drainQueue } from '@/lib/workflow-engine';
import type { Task } from '@/lib/types';

interface DeleteTaskOptions {
  broadcastDeletion?: boolean;
  drainWorkflowQueue?: boolean;
  trashWorkspace?: boolean;
}

export function deleteTaskById(id: string, options: DeleteTaskOptions = {}): Task | undefined {
  const existing = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [id]);
  if (!existing) {
    return undefined;
  }

  const now = new Date().toISOString();
  const shouldBroadcast = options.broadcastDeletion !== false;
  const shouldDrainWorkflowQueue =
    options.drainWorkflowQueue !== false && ['review', 'verification'].includes(existing.status);
  const shouldTrashWorkspace = options.trashWorkspace !== false;
  const workflow = shouldDrainWorkflowQueue ? getTaskWorkflow(id) : null;

  if (existing.assigned_agent_id) {
    const otherActive = queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM tasks
       WHERE assigned_agent_id = ?
         AND status IN ('assigned', 'in_progress', 'testing', 'verification')
         AND id != ?`,
      [existing.assigned_agent_id, id]
    );
    if (!otherActive || otherActive.count === 0) {
      run(
        'UPDATE agents SET status = ?, updated_at = ? WHERE id = ? AND status = ?',
        ['standby', now, existing.assigned_agent_id, 'working']
      );
    }
  }

  const convoy = queryOne<{ id: string }>('SELECT id FROM convoys WHERE parent_task_id = ?', [id]);
  if (convoy) {
    const subtaskIds = queryAll<{ task_id: string }>(
      'SELECT task_id FROM convoy_subtasks WHERE convoy_id = ?',
      [convoy.id]
    );
    for (const { task_id } of subtaskIds) {
      deleteTaskById(task_id, { ...options, drainWorkflowQueue: false });
    }
    run('DELETE FROM agent_mailbox WHERE convoy_id = ?', [convoy.id]);
    run('DELETE FROM convoys WHERE id = ?', [convoy.id]);
  }

  endActiveTaskSessions(id, now);

  run('DELETE FROM work_checkpoints WHERE task_id = ?', [id]);
  run('DELETE FROM workspace_merges WHERE task_id = ?', [id]);
  run('DELETE FROM workspace_ports WHERE task_id = ?', [id]);
  run('DELETE FROM openclaw_sessions WHERE task_id = ?', [id]);
  run('DELETE FROM events WHERE task_id = ?', [id]);
  run('DELETE FROM skill_reports WHERE task_id = ?', [id]);
  run('UPDATE agent_health SET task_id = NULL WHERE task_id = ?', [id]);
  run('UPDATE cost_events SET task_id = NULL WHERE task_id = ?', [id]);
  run('UPDATE content_inventory SET task_id = NULL WHERE task_id = ?', [id]);
  run('UPDATE ideas SET task_id = NULL WHERE task_id = ?', [id]);
  run('UPDATE product_skills SET created_by_task_id = NULL WHERE created_by_task_id = ?', [id]);
  run('UPDATE rollback_history SET task_id = NULL WHERE task_id = ?', [id]);
  run('UPDATE conversations SET task_id = NULL WHERE task_id = ?', [id]);
  run('UPDATE knowledge_entries SET task_id = NULL WHERE task_id = ?', [id]);

  run('DELETE FROM tasks WHERE id = ?', [id]);

  if (shouldTrashWorkspace && existing.workspace_path) {
    try {
      movePathToTrash(existing.workspace_path);
    } catch (error) {
      console.error('[Tasks] Failed to trash workspace after delete:', error);
    }
  }

  if (shouldBroadcast) {
    broadcast({
      type: 'task_deleted',
      payload: { id },
    });
  }

  if (shouldDrainWorkflowQueue && workflow) {
    drainQueue(id, existing.workspace_id, workflow).catch(error =>
      console.error('[Workflow] drainQueue after delete failed:', error)
    );
  }

  return existing;
}
