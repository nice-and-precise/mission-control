import { NextRequest, NextResponse } from 'next/server';
import { queryOne, run } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { finalizePlanningCompletion, reconcilePlanningTranscript } from '@/lib/planning-utils';
import type { Task } from '@/lib/types';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/tasks/[id]/planning/force-complete
 * 
 * Force-completes a stuck planning session by reconciling the stored
 * transcript with OpenClaw history and persisting any recoverable plan.
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

    const resolution = await reconcilePlanningTranscript(task, { refreshFromOpenClaw: true });

    if (!resolution.completion) {
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
        transcriptIssue: resolution.transcriptIssue || null,
      });
    }

    // Found completion JSON — create agents, save spec, dispatch
    console.log(`[Force Complete] Found completion JSON for task ${taskId} — processing`);

    const finalized = await finalizePlanningCompletion(taskId, resolution.messages, resolution.completion, {
      statusReason: 'Planning force-completed by user — awaiting approval',
      activityMessage: 'Planning force-completed by user — awaiting approval',
    });

    return NextResponse.json({
      success: true,
      message: 'Planning force-completed and saved. Approve the plan before execution begins.',
      dispatched: false,
      dispatchError: null,
      spec: finalized.spec,
      agents: finalized.agents,
      transcriptIssue: resolution.transcriptIssue || null,
    });
  } catch (error) {
    console.error('[Force Complete] Error:', error);
    return NextResponse.json({ error: 'Failed to force-complete planning' }, { status: 500 });
  }
}
