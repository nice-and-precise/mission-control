import { NextRequest, NextResponse } from 'next/server';
import { getDb, queryAll, queryOne, run } from '@/lib/db';
import { broadcast } from '@/lib/events';
import {
  attemptAutomaticPlanningRecovery,
  completePlanningTurnHttp,
  finalizePlanningCompletion,
  reconcilePlanningTranscript,
} from '@/lib/planning-utils';
import { parsePlanningSpecValue } from '@/lib/planning-agents';
import { cleanupTaskScopedAgents } from '@/lib/planning-agents';
import { resolvePlanningModelForWorkspace } from '@/lib/openclaw/workspace-model-overrides';

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
    let spec = parsePlanningSpecValue(task.planning_spec ? JSON.parse(task.planning_spec) : null);
    let agents = task.planning_agents ? JSON.parse(task.planning_agents) : null;
    let isComplete = !!task.planning_complete;

    let resolution = isComplete
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
      spec = finalized.spec;
      agents = finalized.agents;
      isComplete = true;
      statusReason = 'Planning complete — awaiting approval before execution';
    } else if (
      !isComplete &&
      task.planning_session_key &&
      resolution.transcriptIssue?.code === 'unstructured_response'
    ) {
      try {
        const repairedMessages = await attemptAutomaticPlanningRecovery(
          taskId,
          task.planning_session_key,
          resolution.messages,
        );
        if (repairedMessages) {
          resolution = {
            ...resolution,
            messages: repairedMessages,
            currentQuestion: null,
            completion: null,
            transcriptIssue: null,
            changed: false,
          };
          statusReason = 'Planning auto-recovery in progress — waiting for a valid planner reply';
        }
      } catch (repairError) {
        console.error('Failed to auto-repair planning transcript:', repairError);
      }
    }

    if (!isComplete && resolution.changed) {
      run('UPDATE tasks SET planning_messages = ? WHERE id = ?', [JSON.stringify(resolution.messages), taskId]);
    }

    if (isComplete && task.planning_spec && spec) {
      const normalizedSpecText = JSON.stringify(spec);
      if (normalizedSpecText !== task.planning_spec) {
        run('UPDATE tasks SET planning_spec = ? WHERE id = ?', [normalizedSpecText, taskId]);
      }
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
      repo_url?: string | null;
      repo_branch?: string | null;
      workspace_path?: string | null;
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
    const canonicalRepoContext = [
      task.repo_url ? `Canonical repository URL: ${task.repo_url}` : null,
      task.repo_branch ? `Canonical repository branch: ${task.repo_branch}` : null,
      task.workspace_path ? `Task workspace path: ${task.workspace_path}` : null,
    ].filter(Boolean).join('\n');

    // Build the initial planning prompt
    const planningPrompt = `PLANNING REQUEST

Task Title: ${task.title}
Task Description: ${task.description || 'No description provided'}

${canonicalRepoContext ? `${canonicalRepoContext}

` : ''}Planning protocol:
- Use the task description, technical approach, research backing, and canonical repository context above as ground truth.
- If a canonical repository URL/branch is provided above, treat it as the target. Do not ask the user to choose between duplicate local copies unless the task explicitly says multiple repos must be changed.
- Do not execute the task itself during planning. Do not scan files, produce findings, or return a work product during this phase.
- Do not return execution-style payloads such as scan reports, audit findings, file lists, missing-artifact lists, or remediation summaries during planning. Those outputs are invalid in this phase.
- If the task is straightforward and you do not need clarification, return a planning completion payload immediately instead of doing the work.
- Do not inspect the wider workspace or run discovery/tool calls during planning unless the task description is missing information required to form the next question.
- Your output must be structured JSON only. Do not add prose before or after the JSON.
- Only these top-level response shapes are valid in planning:
  - Question shape: { "question": "...", "options": [...] }
  - Completion shape: { "status": "complete", "spec": {...}, "agents": [...], "execution_plan": {...} }

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

    // Persist session state before starting HTTP completion so the task can be
    // recovered from the UI even if the completion is slow or times out.
    const messages: Array<{ role: string; content: string; timestamp: number }> = [{ role: 'user', content: planningPrompt, timestamp: Date.now() }];

    getDb().prepare(`
      UPDATE tasks
      SET planning_session_key = ?, planning_messages = ?, status = 'planning', updated_at = datetime('now')
      WHERE id = ?
    `).run(sessionKey, JSON.stringify(messages), taskId);

    // Use stateless HTTP completion instead of OpenClaw agent sessions.
    // This bypasses SOUL.md injection that conflicts with JSON-only planning.
    const completionStartedAt = Date.now();
    console.log(`[Planning] Starting HTTP completion for ${taskId}, model=${planningModel}`);
    try {
      const result = await completePlanningTurnHttp(
        [{ role: 'user', content: planningPrompt }],
        planningModel,
      );
      console.log(`[Planning] HTTP completion for ${taskId} finished in ${Date.now() - completionStartedAt}ms`);

      // Store the assistant response inline
      messages.push({ role: 'assistant', content: result.content, timestamp: Date.now() });
      getDb().prepare(`
        UPDATE tasks SET planning_messages = ?, updated_at = datetime('now') WHERE id = ?
      `).run(JSON.stringify(messages), taskId);
    } catch (completionError) {
      console.error(`[Planning] HTTP completion failed for ${taskId} after ${Date.now() - completionStartedAt}ms:`, completionError);
      // Task stays in planning state; poll endpoint will attempt recovery.
    }

    return NextResponse.json({
      success: true,
      sessionKey,
      model: planningModel,
      messages,
      note: 'Planning started. Assistant response is included when the HTTP completion succeeded; poll GET endpoint if the messages array contains no assistant reply (timeout/error recovery path).',
    });
  } catch (error) {
    console.error('Failed to start planning:', error);

    // If we pre-persisted the session state but the gateway call failed,
    // clear it so the user can retry without getting "Planning already started".
    getDb().prepare(`
      UPDATE tasks
      SET planning_session_key = NULL, planning_messages = NULL, status = 'inbox', updated_at = datetime('now')
      WHERE id = ? AND status = 'planning'
    `).run(taskId);

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
