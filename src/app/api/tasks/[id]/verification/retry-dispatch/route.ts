import { NextRequest, NextResponse } from 'next/server';
import { queryOne, run } from '@/lib/db';
import { triggerAutoDispatch } from '@/lib/auto-dispatch';
import type { Task } from '@/lib/types';

/**
 * POST /api/tasks/[id]/verification/retry-dispatch
 *
 * Retries the dispatch for a task currently stuck in the verification stage.
 * Use when the reviewer agent session ended without emitting VERIFY_PASS/VERIFY_FAIL.
 * The re-dispatch sends the updated prompt (including the contract banner) so the
 * model receives the required output format at the very start of the message.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;

  try {
    const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    if (task.status !== 'verification') {
      return NextResponse.json(
        {
          error: `Cannot retry verification dispatch: task status is '${task.status}', expected 'verification'`,
        },
        { status: 400 },
      );
    }

    if (!task.assigned_agent_id) {
      return NextResponse.json(
        { error: 'Cannot retry verification dispatch: no agent assigned' },
        { status: 400 },
      );
    }

    const agent = queryOne<{ name: string }>(
      'SELECT name FROM agents WHERE id = ?',
      [task.assigned_agent_id],
    );

    const result = await triggerAutoDispatch({
      taskId: task.id,
      taskTitle: task.title,
      agentId: task.assigned_agent_id,
      agentName: agent?.name || 'Unknown Agent',
      workspaceId: task.workspace_id,
    });

    if (result.success) {
      const updatedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
      return NextResponse.json({
        success: true,
        message: 'Verification dispatch retry successful',
        task: updatedTask,
      });
    } else if (result.queued) {
      run(
        `UPDATE tasks
         SET planning_dispatch_error = NULL,
             updated_at = datetime('now')
         WHERE id = ?`,
        [taskId],
      );
      const updatedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
      return NextResponse.json({
        success: false,
        queued: true,
        message: result.error || 'Dispatch queued until the assigned agent is free',
        waiting_for_task_id: result.waitingForTaskId,
        waiting_for_task_title: result.waitingForTaskTitle,
        task: updatedTask,
      });
    } else {
      run(
        `UPDATE tasks
         SET planning_dispatch_error = ?,
             updated_at = datetime('now')
         WHERE id = ?`,
        [result.error || 'Verification dispatch retry failed', taskId],
      );
      return NextResponse.json(
        { error: 'Verification dispatch retry failed', details: result.error },
        { status: 500 },
      );
    }
  } catch (error) {
    console.error('[Verification retry-dispatch] Failed:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    run(
      `UPDATE tasks
       SET planning_dispatch_error = ?,
           updated_at = datetime('now')
       WHERE id = ?`,
      [`Retry error: ${errorMessage}`, taskId],
    );
    return NextResponse.json(
      { error: 'Failed to retry verification dispatch', details: errorMessage },
      { status: 500 },
    );
  }
}
