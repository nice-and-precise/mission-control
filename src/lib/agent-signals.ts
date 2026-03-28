import { queryAll, queryOne, run } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { triggerWorkspaceMerge } from '@/lib/workspace-isolation';
import { drainQueue, handleStageFailure, handleStageTransition } from '@/lib/workflow-engine';
import { buildAgentSessionKey } from '@/lib/openclaw/routing';
import { sanitizeAgentSignalSummary, stripAgentResponseWrappers } from '@/lib/agent-signal-text';
import type { Agent, OpenClawSession, Task } from '@/lib/types';

export type AgentSignalKind =
  | 'task_complete'
  | 'blocked'
  | 'test_pass'
  | 'test_fail'
  | 'verify_pass'
  | 'verify_fail';

export interface ParsedAgentSignal {
  kind: AgentSignalKind;
  summary: string;
}

const SIGNAL_PATTERNS: Array<[AgentSignalKind, RegExp]> = [
  ['task_complete', /TASK_COMPLETE:\s*(.+)$/i],
  ['blocked', /BLOCKED:\s*(.+)$/i],
  ['test_pass', /TEST_PASS:\s*(.+)$/i],
  ['test_fail', /TEST_FAIL:\s*(.+)$/i],
  ['verify_pass', /VERIFY_PASS:\s*(.+)$/i],
  ['verify_fail', /VERIFY_FAIL:\s*(.+)$/i],
];

interface SessionWithAgent extends OpenClawSession {
  role?: string | null;
  session_key_prefix?: string | null;
}

interface ProcessAgentSignalInput {
  message: string;
  sessionId?: string;
  sessionKey?: string;
  taskId?: string;
}

interface ProcessAgentSignalResult {
  handled: boolean;
  taskId?: string;
  signal?: AgentSignalKind;
  error?: string;
}

export function parseAgentSignal(message: string): ParsedAgentSignal | null {
  const normalizedMessage = stripAgentResponseWrappers(message);

  for (const [kind, pattern] of SIGNAL_PATTERNS) {
    const match = normalizedMessage.match(pattern);
    if (match) {
      return {
        kind,
        summary: sanitizeAgentSignalSummary(match[1]),
      };
    }
  }

  return null;
}

function findSessionByContext(input: ProcessAgentSignalInput): SessionWithAgent | undefined {
  const sessions = queryAll<SessionWithAgent>(
    `SELECT os.*, a.role, a.session_key_prefix
     FROM openclaw_sessions os
     LEFT JOIN agents a ON a.id = os.agent_id
     ORDER BY os.updated_at DESC`
  );

  if (input.sessionId) {
    const byId = sessions.find((session) => session.openclaw_session_id === input.sessionId);
    if (byId) return byId;
  }

  if (input.sessionKey) {
    const bySessionKey = sessions.find((session) =>
      buildAgentSessionKey(session.openclaw_session_id, {
        role: session.role || undefined,
        session_key_prefix: session.session_key_prefix || undefined,
      }) === input.sessionKey
    );
    if (bySessionKey) return bySessionKey;
  }

  return undefined;
}

function resolveTaskForSignal(
  parsed: ParsedAgentSignal,
  input: ProcessAgentSignalInput,
  session?: SessionWithAgent,
): Task | undefined {
  if (input.taskId) {
    return queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [input.taskId]);
  }

  if (session?.task_id) {
    const byLinkedSession = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [session.task_id]);
    if (byLinkedSession) return byLinkedSession;
  }

  if (session?.agent_id) {
    const activeStatuses =
      parsed.kind === 'task_complete'
        ? ['assigned', 'in_progress']
        : parsed.kind === 'blocked'
          ? ['assigned', 'in_progress', 'testing', 'review', 'verification']
        : parsed.kind.startsWith('test_')
          ? ['testing']
          : ['review', 'verification'];

    const placeholders = activeStatuses.map(() => '?').join(', ');
    return queryOne<Task>(
      `SELECT *
       FROM tasks
       WHERE assigned_agent_id = ?
         AND status IN (${placeholders})
       ORDER BY updated_at DESC
       LIMIT 1`,
      [session.agent_id, ...activeStatuses]
    );
  }

  return undefined;
}

function markTaskSessionsEnded(taskId: string, now: string, sessionId?: string): void {
  if (sessionId) {
    run(
      `UPDATE openclaw_sessions
       SET status = CASE WHEN status = 'active' THEN 'ended' ELSE status END,
           ended_at = COALESCE(ended_at, ?),
           updated_at = ?
       WHERE openclaw_session_id = ?`,
      [now, now, sessionId]
    );
  }

  run(
    `UPDATE openclaw_sessions
     SET status = 'ended', ended_at = COALESCE(ended_at, ?), updated_at = ?
     WHERE task_id = ? AND status = 'active'`,
    [now, now, taskId]
  );
}

function setAgentStandbyIfIdle(agentId: string | null | undefined, taskId: string, now: string): void {
  if (!agentId) return;

  const otherActive = queryOne<{ count: number }>(
    `SELECT COUNT(*) as count
     FROM tasks
     WHERE assigned_agent_id = ?
       AND id != ?
       AND status IN ('assigned', 'in_progress', 'testing', 'verification')`,
    [agentId, taskId]
  );

  if (!otherActive || Number(otherActive.count || 0) === 0) {
    run(
      `UPDATE agents SET status = 'standby', updated_at = ? WHERE id = ? AND status = 'working'`,
      [now, agentId]
    );
  }
}

function getTargetStatus(kind: AgentSignalKind): Task['status'] | null {
  switch (kind) {
    case 'task_complete':
      return 'testing';
    case 'test_pass':
      return 'review';
    case 'verify_pass':
      return 'done';
    default:
      return null;
  }
}

function shouldIgnoreSignal(task: Task, targetStatus: Task['status'] | null): boolean {
  if (!targetStatus) return false;
  if (task.status === targetStatus) return true;

  if (targetStatus === 'testing' && ['testing', 'review', 'verification', 'done'].includes(task.status)) {
    return true;
  }
  if (targetStatus === 'review' && ['review', 'verification', 'done'].includes(task.status)) {
    return true;
  }
  if (targetStatus === 'done' && task.status === 'done') {
    return true;
  }

  return false;
}

export async function processAgentSignal(
  input: ProcessAgentSignalInput,
): Promise<ProcessAgentSignalResult> {
  const parsed = parseAgentSignal(input.message);
  if (!parsed) {
    return { handled: false };
  }

  const session = findSessionByContext(input);
  const task = resolveTaskForSignal(parsed, input, session);
  if (!task) {
    return {
      handled: true,
      signal: parsed.kind,
      error: 'No task matched the agent signal',
    };
  }

  const now = new Date().toISOString();
  const targetStatus = getTargetStatus(parsed.kind);

  markTaskSessionsEnded(task.id, now, session?.openclaw_session_id || input.sessionId);

  if (parsed.kind === 'blocked') {
    const blockerMessage = `Blocked: ${parsed.summary}`;

    run(
      `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, created_at)
       VALUES (?, ?, ?, 'status_changed', ?, ?)`,
      [
        crypto.randomUUID(),
        task.id,
        session?.agent_id || task.assigned_agent_id || null,
        blockerMessage,
        now,
      ]
    );

    run(
      `UPDATE tasks
       SET status = CASE
             WHEN status IN ('in_progress', 'assigned') THEN 'assigned'
             ELSE status
           END,
           planning_dispatch_error = ?,
           status_reason = ?,
           updated_at = ?
       WHERE id = ?`,
      [blockerMessage, blockerMessage, now, task.id]
    );

    const refreshedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [task.id]);
    if (refreshedTask) {
      broadcast({ type: 'task_updated', payload: refreshedTask });
    }

    setAgentStandbyIfIdle(session?.agent_id || task.assigned_agent_id, task.id, now);
    return { handled: true, taskId: task.id, signal: parsed.kind };
  }

  if (parsed.kind === 'test_fail' || parsed.kind === 'verify_fail') {
    await handleStageFailure(task.id, task.status, parsed.summary);
    return { handled: true, taskId: task.id, signal: parsed.kind };
  }

  if (shouldIgnoreSignal(task, targetStatus)) {
    setAgentStandbyIfIdle(session?.agent_id || task.assigned_agent_id, task.id, now);
    return { handled: true, taskId: task.id, signal: parsed.kind };
  }

  run(
    `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, created_at)
     VALUES (?, ?, ?, 'completed', ?, ?)`,
    [
      crypto.randomUUID(),
      task.id,
      session?.agent_id || task.assigned_agent_id || null,
      parsed.summary,
      now,
    ]
  );

  run(
    `UPDATE tasks
     SET status = ?, planning_dispatch_error = NULL, status_reason = NULL, updated_at = ?
     WHERE id = ?`,
    [targetStatus, now, task.id]
  );

  const refreshedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [task.id]);
  if (refreshedTask) {
    broadcast({ type: 'task_updated', payload: refreshedTask });
  }

  if (targetStatus === 'done') {
    setAgentStandbyIfIdle(session?.agent_id || task.assigned_agent_id, task.id, now);
    drainQueue(task.id, task.workspace_id).catch((err) => {
      console.error('[AgentSignals] drainQueue after done failed:', err);
    });
    if (task.workspace_path) {
      triggerWorkspaceMerge(task.id).catch((err) => {
        console.error('[AgentSignals] workspace merge after done failed:', err);
      });
    }
    return { handled: true, taskId: task.id, signal: parsed.kind };
  }

  if (!targetStatus) {
    return {
      handled: true,
      taskId: task.id,
      signal: parsed.kind,
      error: 'No workflow target status resolved for the agent signal.',
    };
  }

  const handoff = await handleStageTransition(task.id, targetStatus, {
    previousStatus: task.status,
  });

  if (!handoff.success && handoff.error) {
    return {
      handled: true,
      taskId: task.id,
      signal: parsed.kind,
      error: handoff.error,
    };
  }

  return { handled: true, taskId: task.id, signal: parsed.kind };
}
