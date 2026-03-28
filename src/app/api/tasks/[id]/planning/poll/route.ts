import { NextRequest, NextResponse } from 'next/server';
import { queryOne, run, getDb } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { extractJSON, getMessagesFromOpenClaw } from '@/lib/planning-utils';
import { createTaskScopedPlanningAgents } from '@/lib/planning-agents';
import { Task } from '@/lib/types';

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

// Helper to handle planning completion with proper error handling
async function handlePlanningCompletion(taskId: string, parsed: any, messages: any[]) {
  const db = getDb();
  const allowDynamicAgents = process.env.ALLOW_DYNAMIC_AGENTS !== 'false';
  const savedAgents = allowDynamicAgents
    ? createTaskScopedPlanningAgents(taskId, parsed.agents || [])
    : (parsed.agents || []).map((agent: any) => ({ ...agent, scope: 'task' }));

  db.prepare('DELETE FROM task_roles WHERE task_id = ?').run(taskId);

  db.prepare(`
    UPDATE tasks
    SET planning_messages = ?,
        planning_spec = ?,
        planning_agents = ?,
        planning_complete = 1,
        assigned_agent_id = NULL,
        status = 'planning',
        planning_dispatch_error = NULL,
        status_reason = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(
    JSON.stringify(messages),
    JSON.stringify(parsed.spec),
    JSON.stringify(savedAgents),
    'Planning complete — awaiting approval before execution',
    taskId
  );

  // Broadcast task update
  const updatedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (updatedTask) {
    broadcast({ type: 'task_updated', payload: updatedTask });
  }

  return { parsed: { ...parsed, agents: savedAgents } };
}

// GET /api/tasks/[id]/planning/poll - Check for new messages from OpenClaw
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;

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

    const messages = task.planning_messages ? JSON.parse(task.planning_messages) : [];
    // Count only assistant messages for comparison, since OpenClaw only returns assistant messages
    const initialAssistantCount = messages.filter((m: any) => m.role === 'assistant').length;

    console.log('[Planning Poll] Task', taskId, 'has', messages.length, 'total messages,', initialAssistantCount, 'assistant messages');

    // Check OpenClaw for new messages (lightweight check, not a loop)
    const openclawMessages = await getMessagesFromOpenClaw(task.planning_session_key);

    console.log('[Planning Poll] Comparison: stored_assistant=', initialAssistantCount, 'openclaw_assistant=', openclawMessages.length);

    if (openclawMessages.length > initialAssistantCount) {
      let currentQuestion = null;
      const newMessages = openclawMessages.slice(initialAssistantCount);
      console.log('[Planning Poll] Processing', newMessages.length, 'new messages');

      // Find new assistant messages
      for (const msg of newMessages) {
        console.log('[Planning Poll] Processing new message, role:', msg.role, 'content length:', msg.content?.length || 0);

        if (msg.role === 'assistant') {
          const lastMessage = { role: 'assistant', content: msg.content, timestamp: Date.now() };
          messages.push(lastMessage);

          // Check if this message contains completion status or a question
          const parsed = extractJSON(msg.content) as {
            status?: string;
            question?: string;
            options?: Array<{ id: string; label: string }>;
            spec?: object;
            agents?: Array<{
              name: string;
              role: string;
              avatar_emoji?: string;
              soul_md?: string;
              instructions?: string;
            }>;
            execution_plan?: object;
          } | null;

          console.log('[Planning Poll] Parsed message content:', {
            hasStatus: !!parsed?.status,
            hasQuestion: !!parsed?.question,
            hasOptions: !!parsed?.options,
            status: parsed?.status,
            question: parsed?.question?.substring(0, 50),
            rawPreview: msg.content?.substring(0, 200)
          });

          if (parsed && parsed.status === 'complete') {
            // Handle completion
            console.log('[Planning Poll] Planning complete, handling...');
            const { parsed: fullParsed } = await handlePlanningCompletion(taskId, parsed, messages);

            return NextResponse.json({
              hasUpdates: true,
              complete: true,
              spec: fullParsed.spec,
              agents: fullParsed.agents,
              executionPlan: fullParsed.execution_plan,
              messages,
              autoDispatched: false,
              dispatchError: null,
            });
          }

          // Extract current question if present (be tolerant if options are missing)
          if (parsed && parsed.question) {
            const normalizedOptions = Array.isArray(parsed.options) && parsed.options.length > 0
              ? parsed.options
              : [
                  { id: 'continue', label: 'Continue' },
                  { id: 'other', label: 'Other' },
                ];
            console.log('[Planning Poll] Found question with', normalizedOptions.length, 'options');
            currentQuestion = {
              question: parsed.question,
              options: normalizedOptions,
            };
          }
        }
      }

      console.log('[Planning Poll] Returning updates: currentQuestion =', currentQuestion ? 'YES' : 'NO');

      // Update database
      run('UPDATE tasks SET planning_messages = ? WHERE id = ?', [JSON.stringify(messages), taskId]);

      return NextResponse.json({
        hasUpdates: true,
        complete: false,
        messages,
        currentQuestion,
      });
    }

    // FALLBACK: Check if the last stored message is actually a completion that was
    // saved but never processed (race condition where message was stored but
    // extractJSON failed or the completion handler never fired).
    const lastAssistantMsg = [...messages].reverse().find((m: any) => m.role === 'assistant');
    if (lastAssistantMsg) {
      const parsed = extractJSON(lastAssistantMsg.content) as { status?: string; spec?: object; agents?: any[]; execution_plan?: object } | null;
      if (parsed && parsed.status === 'complete') {
        console.log('[Planning Poll] FALLBACK: Found unprocessed completion in stored messages — handling now');
        const { parsed: fullParsed } = await handlePlanningCompletion(taskId, parsed, messages);
        return NextResponse.json({
          hasUpdates: true,
          complete: true,
          spec: fullParsed.spec,
          agents: fullParsed.agents,
          executionPlan: fullParsed.execution_plan,
          messages,
          autoDispatched: false,
          dispatchError: null,
        });
      }
    }

    // Check for stale planning — if no new messages for >10 minutes, flag it
    const lastMsgTimestamp = messages.length > 0 ? messages[messages.length - 1].timestamp : null;
    const stalePlanningMs = 10 * 60 * 1000; // 10 minutes
    const isStalePlanning = lastMsgTimestamp && (Date.now() - lastMsgTimestamp) > stalePlanningMs;

    console.log('[Planning Poll] No new messages found', isStalePlanning ? '(STALE — over 10min since last message)' : '');
    return NextResponse.json({ 
      hasUpdates: false,
      stalePlanning: isStalePlanning || undefined,
      staleSinceMs: isStalePlanning ? (Date.now() - lastMsgTimestamp) : undefined,
    });
  } catch (error) {
    console.error('Failed to poll for updates:', error);
    return NextResponse.json({ error: 'Failed to poll for updates' }, { status: 500 });
  }
}
