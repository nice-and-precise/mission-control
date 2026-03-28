import { NextRequest, NextResponse } from 'next/server';
import { queryOne, run } from '@/lib/db';
import { extractJSON } from '@/lib/planning-utils';
import { broadcast } from '@/lib/events';
import { createTaskScopedPlanningAgents } from '@/lib/planning-agents';
import type { Task } from '@/lib/types';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/tasks/[id]/planning/force-complete
 * 
 * Force-completes a stuck planning session by scanning stored messages
 * for the completion JSON and triggering dispatch. Used when the normal
 * poll loop fails to detect completion (race condition).
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id: taskId } = await params;

    const task = queryOne<{
      id: string;
      title: string;
      planning_messages?: string;
      planning_complete?: number;
      planning_session_key?: string;
      workspace_id: string;
    }>('SELECT * FROM tasks WHERE id = ?', [taskId]);

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    if (task.planning_complete) {
      return NextResponse.json({ error: 'Planning is already complete' }, { status: 400 });
    }

    const messages = task.planning_messages ? JSON.parse(task.planning_messages) : [];
    
    // Scan messages from the end looking for the completion JSON
    let completionParsed: any = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') {
        const parsed = extractJSON(messages[i].content);
        if (parsed && (parsed as any).status === 'complete') {
          completionParsed = parsed;
          break;
        }
      }
    }

    if (!completionParsed) {
      // No completion found in stored messages — keep the task in planning
      // so the user can restart/approve cleanly later.
      console.log(`[Force Complete] No completion JSON found for task ${taskId} — marking complete without spec`);
      run(
        `UPDATE tasks SET planning_complete = 1, status = 'planning',
         status_reason = 'Planning force-completed by user (no completion spec found)',
         updated_at = datetime('now') WHERE id = ?`,
        [taskId]
      );

      const updatedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
      if (updatedTask) broadcast({ type: 'task_updated', payload: updatedTask });

      return NextResponse.json({ 
        success: true, 
        message: 'Planning force-completed. No spec was found — task remains in planning for manual review.',
      });
    }

    // Found completion JSON — create agents, save spec, dispatch
    console.log(`[Force Complete] Found completion JSON for task ${taskId} — processing`);

    const allowDynamicAgents = process.env.ALLOW_DYNAMIC_AGENTS !== 'false';
    const savedAgents = allowDynamicAgents
      ? createTaskScopedPlanningAgents(taskId, completionParsed.agents || [])
      : (completionParsed.agents || []).map((agent: any) => ({ ...agent, scope: 'task' }));

    // Update task
    run(
      `UPDATE tasks SET 
         planning_complete = 1,
         planning_spec = ?,
         planning_agents = ?,
         assigned_agent_id = NULL,
         status = 'planning',
         planning_dispatch_error = NULL,
         status_reason = 'Planning force-completed by user — awaiting approval',
         updated_at = datetime('now')
       WHERE id = ?`,
      [
        JSON.stringify(completionParsed.spec || {}),
        JSON.stringify(savedAgents),
        taskId,
      ]
    );

    // Log the force-complete
    run(
      `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, created_at)
       VALUES (lower(hex(randomblob(16))), ?, NULL, 'status_changed', 'Planning force-completed by user — awaiting approval', datetime('now'))`,
      [taskId]
    );

    const updatedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
    if (updatedTask) broadcast({ type: 'task_updated', payload: updatedTask });

    return NextResponse.json({
      success: true,
      message: 'Planning force-completed and saved. Approve the plan before execution begins.',
      dispatched: false,
      dispatchError: null,
    });
  } catch (error) {
    console.error('[Force Complete] Error:', error);
    return NextResponse.json({ error: 'Failed to force-complete planning' }, { status: 500 });
  }
}
