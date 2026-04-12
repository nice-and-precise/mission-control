import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { completePlanningTurnHttp } from '@/lib/planning-utils';
import { resolvePlanningModelForWorkspace } from '@/lib/openclaw/workspace-model-overrides';

// POST /api/tasks/[id]/planning/answer - Submit an answer and get next question
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;
  const startedAt = Date.now();

  try {
    const body = await request.json();
    const { answer, otherText } = body;

    if (!answer) {
      return NextResponse.json({ error: 'Answer is required' }, { status: 400 });
    }

    // Get task
    const task = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as {
      id: string;
      title: string;
      description: string;
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

    if (!task.planning_session_key) {
      return NextResponse.json({ error: 'Planning not started' }, { status: 400 });
    }

    const canonicalRepoContext = [
      task.repo_url ? `Canonical repository URL: ${task.repo_url}` : null,
      task.repo_branch ? `Canonical repository branch: ${task.repo_branch}` : null,
      task.workspace_path ? `Task workspace path: ${task.workspace_path}` : null,
    ].filter(Boolean).join('\n');

    // Build the answer message
    const answerText = answer === 'other' && otherText 
      ? `Other: ${otherText}`
      : answer;

    const answerPrompt = `${canonicalRepoContext ? `${canonicalRepoContext}

` : ''}User's answer: ${answerText}

Based on this answer and the conversation so far, either:
1. Ask your next question (if you need more information)
2. Complete the planning (if you have enough information)

Rules:
- If canonical repository context is provided above, use it as ground truth. Do not ask which local copy is canonical.
- Do not execute the task itself during planning. Do not scan files, produce findings, or return a work product during this phase.
- Do not return execution-style payloads such as scan reports, audit findings, file lists, missing-artifact lists, or remediation summaries during planning. Those outputs are invalid in this phase.
- If no more clarification is needed, return the planning completion payload immediately.
- Do not inspect the wider workspace or run discovery/tool calls during planning unless the task text is missing critical information required for the next question.
- Return structured JSON only.
- Only these top-level response shapes are valid in planning:
  - Question shape: { "question": "...", "options": [...] }
  - Completion shape: { "status": "complete", "spec": {...}, "agents": [...], "execution_plan": {...} }

Respond with ONLY valid JSON. Do not add commentary, explanations, status updates, markdown fences, or any prose before or after the JSON.`;

    // Parse existing messages and add user answer
    const messages = task.planning_messages ? JSON.parse(task.planning_messages) : [];
    messages.push({ role: 'user', content: answerText, timestamp: Date.now() });

    // Build full conversation for HTTP completion (system prompt handled by completePlanningTurnHttp)
    const conversationForHttp: Array<{ role: string; content: string }> = messages
      .map((msg: { role: string; content: string }) => ({ role: msg.role, content: msg.content }));
    // Replace the last user message with the full answer prompt (includes rules)
    conversationForHttp[conversationForHttp.length - 1] = { role: 'user', content: answerPrompt };

    // Resolve the planning model for this workspace
    const planningModel = await resolvePlanningModelForWorkspace(task.workspace_id);

    console.log('[Planning Answer] Starting HTTP completion, model:', planningModel);
    const completionStartedAt = Date.now();

    try {
      const result = await completePlanningTurnHttp(conversationForHttp, planningModel);
      console.log(
        `[Planning Answer] HTTP completion for ${taskId} finished in ${Date.now() - completionStartedAt}ms`,
      );

      // Store the assistant response inline
      messages.push({ role: 'assistant', content: result.content, timestamp: Date.now() });
    } catch (completionError) {
      console.error(`[Planning Answer] HTTP completion failed for ${taskId} after ${Date.now() - completionStartedAt}ms:`, completionError);
      // Store just the user message; poll endpoint will handle recovery.
    }

    // Update messages in DB
    getDb().prepare(`
      UPDATE tasks SET planning_messages = ?, updated_at = datetime('now') WHERE id = ?
    `).run(JSON.stringify(messages), taskId);

    return NextResponse.json({
      success: true,
      messages,
      note: 'Answer submitted. Assistant response is included when the HTTP completion succeeded; poll GET endpoint if the messages array contains no assistant reply (timeout/error recovery path).',
    });
  } catch (error) {
    console.error('Failed to submit answer:', error);
    return NextResponse.json({ error: 'Failed to submit answer: ' + (error as Error).message }, { status: 500 });
  } finally {
    console.log(`[Planning Answer] Request completed for ${taskId} in ${Date.now() - startedAt}ms`);
  }
}
