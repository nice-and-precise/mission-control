import { NextRequest, NextResponse } from 'next/server';
import { queryOne, run } from '@/lib/db';
import {
  attemptAutomaticPlanningRecovery,
  finalizePlanningCompletion,
  reconcilePlanningTranscript,
} from '@/lib/planning-utils';
import { broadcast } from '@/lib/events';
import type { TaskActivity } from '@/lib/types';

export const dynamic = 'force-dynamic';
// Planning timeout and poll interval configuration with validation
const PLANNING_TIMEOUT_MS = parseInt(process.env.PLANNING_TIMEOUT_MS || '30000', 10);
const PLANNING_POLL_INTERVAL_MS = parseInt(process.env.PLANNING_POLL_INTERVAL_MS || '2000', 10);

// Validate environment variables
if (isNaN(PLANNING_TIMEOUT_MS) || PLANNING_TIMEOUT_MS < 1000) {
  throw new Error('PLANNING_TIMEOUT_MS must be a valid number >= 1000ms');
}
if (isNaN(PLANNING_POLL_INTERVAL_MS) || PLANNING_POLL_INTERVAL_MS < 100) {
  throw new Error('PLANNING_POLL_INTERVAL_MS must be a valid number >= 100ms');
}

// GET /api/tasks/[id]/planning/poll - Check for new messages from OpenClaw
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;
  const pollStartedAt = Date.now();

  try {
    const task = queryOne<{
      id: string;
      planning_session_key?: string;
      planning_messages?: string;
      planning_complete?: number;
      planning_dispatch_error?: string;
    }>('SELECT * FROM tasks WHERE id = ?', [taskId]);

    if (!task || !task.planning_session_key) {
      return NextResponse.json({ error: 'Planning session not found' }, { status: 404 });
    }

    if (task.planning_complete) {
      return NextResponse.json({ hasUpdates: false, isComplete: true });
    }

    // Return dispatch error if present (allows user to see/ retry failed dispatch)
    if (task.planning_dispatch_error) {
      return NextResponse.json({
        hasUpdates: true,
        dispatchError: task.planning_dispatch_error,
      });
    }

    const storedMessages = task.planning_messages ? JSON.parse(task.planning_messages) : [];
    const transcriptRefreshStartedAt = Date.now();
    const resolution = await reconcilePlanningTranscript(task, {
      refreshFromOpenClaw: true,
      timeoutMs: PLANNING_TIMEOUT_MS,
    });
    console.log(
      `[Planning Poll] Transcript refresh for ${taskId} (${task.planning_session_key}) completed in ${Date.now() - transcriptRefreshStartedAt}ms`,
    );

    if (resolution.completion) {
      const finalized = await finalizePlanningCompletion(taskId, resolution.messages, resolution.completion);

      return NextResponse.json({
        hasUpdates: true,
        complete: true,
        spec: finalized.spec,
        agents: finalized.agents,
        executionPlan: finalized.execution_plan,
        messages: resolution.messages,
        transcriptIssue: resolution.transcriptIssue || null,
        autoDispatched: false,
        dispatchError: null,
      });
    }

    if (resolution.transcriptIssue?.code === 'unstructured_response') {
      try {
        const repairedMessages = await attemptAutomaticPlanningRecovery(
          taskId,
          task.planning_session_key,
          resolution.messages,
        );
        if (repairedMessages) {
          return NextResponse.json({
            hasUpdates: true,
            complete: false,
            messages: repairedMessages,
            currentQuestion: null,
            transcriptIssue: null,
          });
        }
      } catch (repairError) {
        console.error('Failed to auto-repair planning transcript during poll:', repairError);
      }
    }

    if (resolution.changed) {
      run('UPDATE tasks SET planning_messages = ? WHERE id = ?', [JSON.stringify(resolution.messages), taskId]);

      return NextResponse.json({
        hasUpdates: true,
        complete: false,
        messages: resolution.messages,
        currentQuestion: resolution.currentQuestion,
        transcriptIssue: resolution.transcriptIssue || null,
      });
    }

    if (resolution.transcriptIssue) {
      if (resolution.transcriptIssue.code === 'gateway_timeout') {
        logPlanningPollTimeout(taskId, task.planning_session_key || null, resolution.transcriptIssue.message);
      }
      return NextResponse.json({
        hasUpdates: true,
        complete: false,
        messages: resolution.messages,
        currentQuestion: resolution.currentQuestion,
        transcriptIssue: resolution.transcriptIssue,
      });
    }

    // Check for stale planning — if no new messages for >10 minutes, flag it
    const lastMsgTimestamp = resolution.messages.length > 0
      ? resolution.messages[resolution.messages.length - 1].timestamp
      : (storedMessages.length > 0 ? storedMessages[storedMessages.length - 1].timestamp : null);
    const stalePlanningMs = 10 * 60 * 1000; // 10 minutes
    const isStalePlanning = lastMsgTimestamp && (Date.now() - lastMsgTimestamp) > stalePlanningMs;

    console.log('[Planning Poll] No new messages found', isStalePlanning ? '(STALE — over 10min since last message)' : '');
    return NextResponse.json({ 
      hasUpdates: false,
      stalePlanning: isStalePlanning || undefined,
      staleSinceMs: isStalePlanning ? (Date.now() - lastMsgTimestamp) : undefined,
      transcriptIssue: null,
    });
  } catch (error) {
    console.error('Failed to poll for updates:', error);
    return NextResponse.json({ error: 'Failed to poll for updates' }, { status: 500 });
  } finally {
    console.log(`[Planning Poll] Request completed for ${taskId} in ${Date.now() - pollStartedAt}ms`);
  }
}

function logPlanningPollTimeout(
  taskId: string,
  sessionKey: string | null,
  message: string,
): void {
  const duplicate = queryOne<{ id: string }>(
    `SELECT id
       FROM task_activities
      WHERE task_id = ?
        AND activity_type = 'planning_poll_timeout'
        AND message = ?
        AND created_at >= datetime('now', '-5 minutes')
      LIMIT 1`,
    [taskId, message],
  );

  if (duplicate) return;

  const activity: TaskActivity = {
    id: crypto.randomUUID(),
    task_id: taskId,
    activity_type: 'planning_poll_timeout',
    message,
    metadata: sessionKey ? JSON.stringify({ sessionKey }) : undefined,
    created_at: new Date().toISOString(),
  };

  run(
    `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, metadata, created_at)
     VALUES (?, ?, NULL, 'planning_poll_timeout', ?, ?, ?)`,
    [activity.id, taskId, message, activity.metadata || null, activity.created_at],
  );

  run(
    `INSERT INTO events (id, type, task_id, message, metadata, created_at)
     VALUES (?, 'system', ?, ?, ?, ?)`,
    [
      crypto.randomUUID(),
      taskId,
      `Planning poll timed out for task ${taskId}`,
      JSON.stringify({
        kind: 'planning_poll_timeout',
        sessionKey,
        message,
      }),
      activity.created_at,
    ],
  );

  broadcast({
    type: 'activity_logged',
    payload: activity,
  });
}
