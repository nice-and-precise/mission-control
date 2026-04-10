import { NextRequest, NextResponse } from 'next/server';
import { getDb, queryAll, queryOne, run } from '@/lib/db';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { broadcast } from '@/lib/events';
import { finalizePlanningCompletion, reconcilePlanningTranscript } from '@/lib/planning-utils';
import { cleanupTaskScopedAgents } from '@/lib/planning-agents';
import { resolvePlanningModelForWorkspace } from '@/lib/openclaw/workspace-model-overrides';
// File system imports removed - using OpenClaw API instead

export const dynamic = 'force-dynamic';

// Default planning session prefix for OpenClaw
// Can be overridden per-agent via the session_key_prefix column on agents table
const DEFAULT_SESSION_KEY_PREFIX = 'agent:main:';

// GET /api/tasks/[id]/planning - Get planning state
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;

  try {
    // Get task
    const task = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as {
      id: string;
      title: string;
      description: string;
      status: string;
      planning_session_key?: string;
      planning_messages?: string;
      planning_complete?: number;
      planning_spec?: string;
      planning_agents?: string;
      status_reason?: string;
      planning_dispatch_error?: string;
    } | undefined;
    
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    let statusReason = task.status_reason || null;
    let spec = task.planning_spec ? JSON.parse(task.planning_spec) : null;
    let agents = task.planning_agents ? JSON.parse(task.planning_agents) : null;
    let isComplete = !!task.planning_complete;

    const resolution = isComplete
      ? {
          messages: task.planning_messages ? JSON.parse(task.planning_messages) : [],
          currentQuestion: null,
          completion: null,
          changed: false,
          transcriptIssue: null,
        }
      : await reconcilePlanningTranscript(task, { refreshFromOpenClaw: true });

    if (!isComplete && resolution.completion) {
      const finalized = await finalizePlanningCompletion(taskId, resolution.messages, resolution.completion);
      spec = finalized.spec || {};
      agents = finalized.agents;
      isComplete = true;
      statusReason = 'Planning complete — awaiting approval before execution';
    } else if (!isComplete && resolution.changed) {
      run('UPDATE tasks SET planning_messages = ? WHERE id = ?', [JSON.stringify(resolution.messages), taskId]);
    }

    const lockedSpec = getDb().prepare('SELECT id FROM planning_specs WHERE task_id = ?').get(taskId) as { id: string } | undefined;

    return NextResponse.json({
      taskId,
      sessionKey: task.planning_session_key,
      messages: resolution.messages,
      currentQuestion: isComplete ? null : resolution.currentQuestion,
      transcriptIssue: resolution.transcriptIssue || null,
      isComplete,
      spec,
      agents,
      isStarted: resolution.messages.length > 0,
      isApproved: !!lockedSpec,
      taskStatus: task.status,
      statusReason,
      dispatchError: lockedSpec ? (task.planning_dispatch_error || null) : null,
    });
  } catch (error) {
    console.error('Failed to get planning state:', error);
    return NextResponse.json({ error: 'Failed to get planning state' }, { status: 500 });
  }
}

// POST /api/tasks/[id]/planning - Start planning session
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;

  try {
    const body = await request.json().catch(() => ({}));
    const customSessionKeyPrefix = body.session_key_prefix;

    // Get task
    const task = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as {
      id: string;
      title: string;
      description: string;
      status: string;
      workspace_id: string;
      planning_session_key?: string;
      planning_messages?: string;
    } | undefined;

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // Check if planning already started
    if (task.planning_session_key) {
      return NextResponse.json({ error: 'Planning already started', sessionKey: task.planning_session_key }, { status: 400 });
    }

    // Check if there are other orchestrators available before starting planning with the default master agent
    // Get the default master agent for this workspace
    const defaultMaster = queryOne<{ id: string; session_key_prefix?: string }>(
      `SELECT id, session_key_prefix FROM agents WHERE is_master = 1 AND workspace_id = ? ORDER BY created_at ASC LIMIT 1`,
      [task.workspace_id]
    );

    // Get assigned agent if any (for session_key_prefix)
    const taskWithAgent = getDb().prepare(`
      SELECT a.session_key_prefix 
      FROM tasks t 
      LEFT JOIN agents a ON t.assigned_agent_id = a.id 
      WHERE t.id = ?
    `).get(taskId) as { session_key_prefix?: string } | undefined;

    const otherOrchestrators = queryAll<{
      id: string;
      name: string;
      role: string;
    }>(
      `SELECT id, name, role
       FROM agents
       WHERE is_master = 1
       AND id != ?
       AND workspace_id = ?
       AND status != 'offline'`,
      [defaultMaster?.id ?? '', task.workspace_id]
    );

    if (otherOrchestrators.length > 0) {
      return NextResponse.json({
        error: 'Other orchestrators available',
        message: `There ${otherOrchestrators.length === 1 ? 'is' : 'are'} ${otherOrchestrators.length} other orchestrator${otherOrchestrators.length === 1 ? '' : 's'} available in this workspace: ${otherOrchestrators.map(o => o.name).join(', ')}. Please assign this task to them directly.`,
        otherOrchestrators,
      }, { status: 409 }); // 409 Conflict
    }

    // Create session key for this planning task
    // Priority: custom prefix > assigned agent's prefix > master agent's prefix > default prefix
    const basePrefix = customSessionKeyPrefix || taskWithAgent?.session_key_prefix || defaultMaster?.session_key_prefix || DEFAULT_SESSION_KEY_PREFIX;
    const planningPrefix = basePrefix + 'planning:';
    const sessionKey = `${planningPrefix}${taskId}`;
    const planningModel = await resolvePlanningModelForWorkspace(task.workspace_id);

    // Build the initial planning prompt
    const planningPrompt = `PLANNING REQUEST

Task Title: ${task.title}
Task Description: ${task.description || 'No description provided'}

You are starting a planning session for this task. Read PLANNING.md for your protocol.

Generate your FIRST question to understand what the user needs. Remember:
- Questions must be multiple choice
- Include an "Other" option
- Be specific to THIS task, not generic

Respond with ONLY valid JSON in this format:
{
  "question": "Your question here?",
  "options": [
    {"id": "A", "label": "First option"},
    {"id": "B", "label": "Second option"},
    {"id": "C", "label": "Third option"},
    {"id": "other", "label": "Other"}
  ]
}`;

    // Persist session state before contacting OpenClaw so the task can be
    // recovered from the UI even if the gateway call is slow or times out.
    const messages = [{ role: 'user', content: planningPrompt, timestamp: Date.now() }];

    getDb().prepare(`
      UPDATE tasks
      SET planning_session_key = ?, planning_messages = ?, status = 'planning', updated_at = datetime('now')
      WHERE id = ?
    `).run(sessionKey, JSON.stringify(messages), taskId);

    // Connect to OpenClaw and send the planning request
    const client = getOpenClawClient();
    if (!client.isConnected()) {
      await client.connect();
    }

    let modelBoundBeforeFirstMessage = false;
    try {
      await client.patchSessionModel(sessionKey, planningModel);
      modelBoundBeforeFirstMessage = true;
    } catch (bindingError) {
      console.warn('[Planning] Pre-bind model patch failed, retrying after first send:', bindingError);
    }

    // Send planning request to the planning session
    await client.call('chat.send', {
      sessionKey: sessionKey,
      message: planningPrompt,
      idempotencyKey: `planning-start-${taskId}-${Date.now()}`,
    });

    if (!modelBoundBeforeFirstMessage) {
      await client.patchSessionModel(sessionKey, planningModel);
    }

    // Return immediately - frontend will poll for updates
    // This eliminates the aggressive polling loop that was making 30+ OpenClaw API calls
    return NextResponse.json({
      success: true,
      sessionKey,
      model: planningModel,
      messages,
      note: 'Planning started. Poll GET endpoint for updates.',
    });
  } catch (error) {
    console.error('Failed to start planning:', error);
    return NextResponse.json({ error: 'Failed to start planning: ' + (error as Error).message }, { status: 500 });
  }
}

// DELETE /api/tasks/[id]/planning - Cancel planning session
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;

  try {
    // Get task to check session key
    const task = queryOne<{
      id: string;
      planning_session_key?: string;
      status: string;
    }>(
      'SELECT * FROM tasks WHERE id = ?',
      [taskId]
    );

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // Clear planning-related fields
    cleanupTaskScopedAgents(taskId);
    run(`
      UPDATE tasks
      SET planning_session_key = NULL,
          planning_messages = NULL,
          planning_complete = 0,
          planning_spec = NULL,
          planning_agents = NULL,
          planning_dispatch_error = NULL,
          assigned_agent_id = NULL,
          status_reason = NULL,
          status = 'inbox',
          updated_at = datetime('now')
      WHERE id = ?
    `, [taskId]);

    run('DELETE FROM planning_specs WHERE task_id = ?', [taskId]);

    // Broadcast task update
    const updatedTask = queryOne('SELECT * FROM tasks WHERE id = ?', [taskId]);
    if (updatedTask) {
      broadcast({
        type: 'task_updated',
        payload: updatedTask as any, // Cast to any to satisfy SSEEvent payload union type
      });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to cancel planning:', error);
    return NextResponse.json({ error: 'Failed to cancel planning: ' + (error as Error).message }, { status: 500 });
  }
}
