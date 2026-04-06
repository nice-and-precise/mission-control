import { NextRequest, NextResponse } from 'next/server';
import { queryOne, run } from '@/lib/db';
import { triggerAutoDispatch } from '@/lib/auto-dispatch';
import type { Task } from '@/lib/types';

/**
 * POST /api/tasks/[id]/planning/retry-dispatch
 * 
 * Retries the auto-dispatch for a completed planning task
 * This endpoint allows users to retry failed dispatches from the UI
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;

  try {
    // Get task details
    const task = queryOne<{
      id: string;
      title: string;
      assigned_agent_id?: string;
      workspace_id?: string;
      planning_complete?: number;
      planning_dispatch_error?: string;
      status: string;
    }>('SELECT * FROM tasks WHERE id = ?', [taskId]);

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // Check if planning is complete
    if (!task.planning_complete) {
      return NextResponse.json({ 
        error: 'Cannot retry dispatch: planning is not complete' 
      }, { status: 400 });
    }

    // Check if there's an assigned agent
    if (!task.assigned_agent_id) {
      return NextResponse.json({ 
        error: 'Cannot retry dispatch: no agent assigned' 
      }, { status: 400 });
    }

    // Get agent name for logging
    const agent = queryOne<{ name: string }>('SELECT name FROM agents WHERE id = ?', [task.assigned_agent_id]);

    // Trigger the dispatch
    const result = await triggerAutoDispatch({
      taskId: task.id,
      taskTitle: task.title,
      agentId: task.assigned_agent_id,
      agentName: agent?.name || 'Unknown Agent',
      workspaceId: task.workspace_id
    });

    if (result.success) {
      const updatedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
      return NextResponse.json({ 
        success: true, 
        message: 'Dispatch retry successful',
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
        [result.error || 'Dispatch retry failed', taskId],
      );

      return NextResponse.json({ 
        error: 'Dispatch retry failed', 
        details: result.error 
      }, { status: 500 });
    }
  } catch (error) {
    console.error('Failed to retry dispatch:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    
    // Store the error in the database for user display
    run(`
      UPDATE tasks 
      SET planning_dispatch_error = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `, [`Retry error: ${errorMessage}`, taskId]);

    return NextResponse.json({ 
      error: 'Failed to retry dispatch', 
      details: errorMessage 
    }, { status: 500 });
  }
}