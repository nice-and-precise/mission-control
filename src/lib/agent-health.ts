import { v4 as uuidv4 } from 'uuid';
import { queryOne, queryAll, run } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { getMissionControlUrl } from '@/lib/config';
import { buildCheckpointContext } from '@/lib/checkpoint';
import { processAgentSignal } from '@/lib/agent-signals';
import { resolveTaskRunOutcomeFromGatewayHistory } from '@/lib/openclaw/session-history';
import { buildAgentSessionKey } from '@/lib/openclaw/routing';
import { reconcileTaskRuntimeEvidence, shouldSuppressHealthEvidenceActivity } from '@/lib/task-evidence';
import type { Agent, AgentHealth, AgentHealthState, Task } from '@/lib/types';

const STALL_THRESHOLD_MINUTES = 5;
const STUCK_THRESHOLD_MINUTES = 15;
const AUTO_NUDGE_AFTER_STALLS = 3;
const ASSIGNED_STALE_MINUTES = 2;
const UNRECONCILED_RUN_ERROR_PREFIX = 'Run ended without completion callback or workflow handoff';
let healthCheckCycleInFlight: Promise<AgentHealth[]> | null = null;
let healthCheckImplementationForTests: (() => Promise<AgentHealth[]>) | null = null;
let unreconciledTaskRunRecoveryInFlight: Promise<number> | null = null;

/**
 * Check health state for a single agent.
 */
export function checkAgentHealth(agentId: string): AgentHealthState {
  const agent = queryOne<Agent>('SELECT * FROM agents WHERE id = ?', [agentId]);
  if (!agent) return 'offline';
  if (agent.status === 'offline') return 'offline';

  // Find active task
  const activeTask = queryOne<Task>(
    `SELECT * FROM tasks WHERE assigned_agent_id = ? AND status IN ('assigned', 'in_progress', 'testing', 'verification') LIMIT 1`,
    [agentId]
  );

  if (!activeTask) return 'idle';

  // Check if OpenClaw session is still alive
  const session = queryOne<{ status: string }>(
    `SELECT status
     FROM openclaw_sessions
     WHERE agent_id = ?
       AND task_id = ?
       AND status = 'active'
       AND session_type != 'subagent'
     LIMIT 1`,
    [agentId, activeTask.id]
  );

  if (!session) {
    // Check for any active session (task might not be linked yet)
    const anySession = queryOne<{ status: string }>(
      `SELECT status
       FROM openclaw_sessions
       WHERE agent_id = ?
         AND status = 'active'
         AND session_type != 'subagent'
       LIMIT 1`,
      [agentId]
    );
    if (!anySession) return 'zombie';
  }

  // Check last REAL activity (exclude health check logs — they reset the clock and prevent stuck detection)
  const lastActivity = queryOne<{ created_at: string }>(
    `SELECT created_at FROM task_activities WHERE task_id = ? AND message NOT LIKE 'Agent health:%' ORDER BY created_at DESC LIMIT 1`,
    [activeTask.id]
  );

  if (lastActivity) {
    const minutesSince = (Date.now() - new Date(lastActivity.created_at).getTime()) / 60000;
    if (minutesSince > STUCK_THRESHOLD_MINUTES) return 'stuck';
    if (minutesSince > STALL_THRESHOLD_MINUTES) return 'stalled';
  } else {
    // No real activity at all — check how long the task has been in progress
    const taskAge = (Date.now() - new Date(activeTask.updated_at).getTime()) / 60000;
    if (taskAge > STUCK_THRESHOLD_MINUTES) return 'stuck';
    if (taskAge > STALL_THRESHOLD_MINUTES) return 'stalled';
  }

  return 'working';
}

/**
 * Run a full health check cycle across all agents with active tasks.
 */
async function runHealthCheckCycleInternal(): Promise<AgentHealth[]> {
  const now = new Date().toISOString();

  await sweepOrphanedAssignedTasks(now);

  const activeAgents = queryAll<{ id: string }>(
    `SELECT DISTINCT assigned_agent_id as id FROM tasks WHERE status IN ('assigned', 'in_progress', 'testing', 'verification') AND assigned_agent_id IS NOT NULL`
  );

  // Also check agents that are in 'working' status but may have no tasks
  const workingAgents = queryAll<{ id: string }>(
    `SELECT id FROM agents WHERE status = 'working'`
  );

  const allAgentIds = Array.from(new Set([...activeAgents.map(a => a.id), ...workingAgents.map(a => a.id)]));
  const results: AgentHealth[] = [];

  for (const agentId of allAgentIds) {
    const healthState = checkAgentHealth(agentId);
    let reconciliationState:
      | Awaited<ReturnType<typeof reconcileTaskRuntimeEvidence>>
      | null = null;

    // Find current task for this agent
    const activeTask = queryOne<Task>(
      `SELECT * FROM tasks WHERE assigned_agent_id = ? AND status IN ('assigned', 'in_progress', 'testing', 'verification') LIMIT 1`,
      [agentId]
    );

    // Upsert health record
    const existing = queryOne<AgentHealth>(
      'SELECT * FROM agent_health WHERE agent_id = ?',
      [agentId]
    );

    const previousState = existing?.health_state;

    if (existing) {
      const consecutiveStalls = healthState === 'stalled' || healthState === 'stuck'
        ? (existing.consecutive_stall_checks || 0) + 1
        : 0;

      run(
        `UPDATE agent_health SET health_state = ?, task_id = ?, last_activity_at = ?, consecutive_stall_checks = ?, updated_at = ?
         WHERE agent_id = ?`,
        [healthState, activeTask?.id || null, now, consecutiveStalls, now, agentId]
      );
    } else {
      const healthId = uuidv4();
      run(
        `INSERT INTO agent_health (id, agent_id, task_id, health_state, last_activity_at, consecutive_stall_checks, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, ?)`,
        [healthId, agentId, activeTask?.id || null, healthState, now, now]
      );
    }

    // Broadcast if health state changed
    if (previousState && previousState !== healthState) {
      const healthRecord = queryOne<AgentHealth>('SELECT * FROM agent_health WHERE agent_id = ?', [agentId]);
      if (healthRecord) {
        broadcast({ type: 'agent_health_changed', payload: healthRecord });
      }
    }

    // Reconcile task evidence before deciding whether a degraded state still
    // represents active work. This prevents stale task-linked subagent rows
    // from blocking suppression after the gateway has already ended them.
    if (activeTask && (healthState === 'stalled' || healthState === 'stuck' || healthState === 'zombie')) {
      reconciliationState = await reconcileTaskRuntimeEvidence(activeTask.id);
    }

    // Log warnings for degraded states
    if (
      activeTask &&
      (healthState === 'stalled' || healthState === 'stuck' || healthState === 'zombie') &&
      !shouldSuppressPendingDispatchHealthNoise(activeTask, healthState) &&
      !shouldSuppressTerminalRunHealthNoise(activeTask, healthState) &&
      !shouldSuppressHealthEvidenceActivity(
        queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [activeTask.id]),
        reconciliationState,
      )
    ) {
      run(
        `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, created_at)
         VALUES (?, ?, ?, 'status_changed', ?, ?)`,
        [uuidv4(), activeTask.id, agentId, `Agent health: ${healthState}`, now]
      );
    }

    // Auto-nudge after consecutive stall checks
    const updatedHealth = queryOne<AgentHealth>('SELECT * FROM agent_health WHERE agent_id = ?', [agentId]);
    if (updatedHealth) {
      results.push(updatedHealth);
      if (updatedHealth.consecutive_stall_checks >= AUTO_NUDGE_AFTER_STALLS && healthState === 'stuck') {
        // Auto-nudge is fire-and-forget
        nudgeAgent(agentId).catch(err =>
          console.error(`[Health] Auto-nudge failed for agent ${agentId}:`, err)
        );
      }
    }
  }

  // Reconcile runtime evidence for active tasks before deciding whether an
  // apparently active DB session has already ended upstream. This keeps the
  // unreconciled-run pass below truthful even when a builder run fails fast.
  const activeTaskIds = queryAll<{ id: string }>(
    `SELECT DISTINCT t.id
     FROM tasks t
     JOIN openclaw_sessions os ON os.task_id = t.id AND os.status = 'active'
     WHERE t.status IN ('assigned', 'in_progress', 'testing', 'review', 'verification')`
  );

  for (const { id } of activeTaskIds) {
    await reconcileTaskRuntimeEvidence(id);
  }

  await recoverUnreconciledTaskRuns(now);

  // Also set idle agents
  const idleAgents = queryAll<{ id: string }>(
    `SELECT id FROM agents WHERE status = 'standby' AND id NOT IN (SELECT assigned_agent_id FROM tasks WHERE status IN ('assigned', 'in_progress', 'testing', 'verification') AND assigned_agent_id IS NOT NULL)`
  );
  for (const { id: agentId } of idleAgents) {
    const existing = queryOne<{ id: string }>('SELECT id FROM agent_health WHERE agent_id = ?', [agentId]);
    if (existing) {
      run(`UPDATE agent_health SET health_state = 'idle', task_id = NULL, consecutive_stall_checks = 0, updated_at = ? WHERE agent_id = ?`, [now, agentId]);
    } else {
      run(
        `INSERT INTO agent_health (id, agent_id, health_state, updated_at) VALUES (?, ?, 'idle', ?)`,
        [uuidv4(), agentId, now]
      );
    }
  }

  return results;
}

async function sweepOrphanedAssignedTasks(now: string): Promise<void> {
  const orphanedTasks = queryAll<Task>(
    `SELECT * FROM tasks 
     WHERE status = 'assigned' 
       AND planning_complete = 1 
       AND NOT EXISTS (
         SELECT 1 FROM openclaw_sessions os WHERE os.task_id = tasks.id
       )
       AND (julianday('now') - julianday(updated_at)) * 1440 > ?`,
    [ASSIGNED_STALE_MINUTES]
  );

  for (const task of orphanedTasks) {
    console.log(`[Health] Orphaned assigned task detected: "${task.title}" (${task.id}) — stale for >${ASSIGNED_STALE_MINUTES}min, auto-dispatching`);
    
    const missionControlUrl = getMissionControlUrl();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (process.env.MC_API_TOKEN) {
      headers['Authorization'] = `Bearer ${process.env.MC_API_TOKEN}`;
    }

    try {
      const res = await fetch(`${missionControlUrl}/api/tasks/${task.id}/dispatch`, {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(30_000),
      });

      if (res.ok) {
        console.log(`[Health] Auto-dispatched orphaned task "${task.title}"`);
        run(
          `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, created_at)
           VALUES (?, ?, ?, 'status_changed', 'Auto-dispatched by health sweeper (was stuck in assigned)', ?)`,
          [uuidv4(), task.id, task.assigned_agent_id, now]
        );
      } else {
        const errorText = await res.text();
        console.error(`[Health] Failed to auto-dispatch orphaned task "${task.title}": ${errorText}`);
        // Record the failure so it shows in the UI
        run(
          `UPDATE tasks SET planning_dispatch_error = ?, updated_at = ? WHERE id = ?`,
          [`Health sweeper dispatch failed: ${errorText.substring(0, 200)}`, now, task.id]
        );
      }
    } catch (err) {
      console.error(`[Health] Auto-dispatch error for orphaned task "${task.title}":`, (err as Error).message);
    }
  }
}

function shouldSuppressPendingDispatchHealthNoise(
  task: Task,
  healthState: AgentHealthState,
): boolean {
  if (healthState !== 'zombie') return false;
  if (task.status !== 'assigned') return false;

  const activeRootSessionCount = queryOne<{ count: number }>(
    `SELECT COUNT(*) AS count
     FROM openclaw_sessions
     WHERE task_id = ?
       AND session_type != 'subagent'
       AND status = 'active'`,
    [task.id],
  )?.count || 0;

  return activeRootSessionCount === 0;
}

function shouldSuppressTerminalRunHealthNoise(
  task: Task,
  healthState: AgentHealthState,
): boolean {
  if (healthState !== 'zombie') return false;
  if (task.planning_dispatch_error?.trim() || task.status_reason?.trim()) return false;

  const latestTerminalTaskSession = queryOne<{ status: string; ended_at: string | null; updated_at: string | null }>(
    `SELECT status, ended_at, updated_at
     FROM openclaw_sessions
     WHERE task_id = ?
       AND session_type != 'subagent'
       AND status != 'active'
     ORDER BY COALESCE(ended_at, updated_at, created_at) DESC
     LIMIT 1`,
    [task.id],
  );

  return Boolean(latestTerminalTaskSession);
}

export async function runHealthCheckCycle(): Promise<AgentHealth[]> {
  if (healthCheckCycleInFlight) {
    return healthCheckCycleInFlight;
  }

  healthCheckCycleInFlight = (healthCheckImplementationForTests || runHealthCheckCycleInternal)();

  try {
    return await healthCheckCycleInFlight;
  } finally {
    healthCheckCycleInFlight = null;
  }
}

type UnreconciledRunTask = Task & {
  latest_session_status?: string;
  latest_session_created_at?: string;
  latest_session_updated_at?: string;
  latest_openclaw_session_id?: string;
  latest_agent_role?: string | null;
  latest_agent_session_key_prefix?: string | null;
};

async function recoverUnreconciledTaskRunsInternal(now: string): Promise<number> {
  const unreconciledRuns = queryAll<UnreconciledRunTask>(
    `WITH ranked_task_sessions AS (
       SELECT
         os.*,
         ROW_NUMBER() OVER (
           PARTITION BY os.task_id
           ORDER BY
             CASE WHEN os.session_type = 'subagent' THEN 1 ELSE 0 END,
             CASE WHEN os.agent_id = t.assigned_agent_id THEN 0 ELSE 1 END,
             os.updated_at DESC
         ) as session_rank
       FROM openclaw_sessions os
       JOIN tasks t ON t.id = os.task_id
     )
     SELECT
       t.*,
       os.status as latest_session_status,
       os.created_at as latest_session_created_at,
       os.updated_at as latest_session_updated_at,
       os.openclaw_session_id as latest_openclaw_session_id,
       a.role as latest_agent_role,
       a.session_key_prefix as latest_agent_session_key_prefix
     FROM tasks t
     JOIN ranked_task_sessions os
       ON os.task_id = t.id
      AND os.session_rank = 1
     LEFT JOIN agents a ON a.id = os.agent_id
     WHERE t.status IN ('assigned', 'in_progress', 'testing', 'review', 'verification')
       AND os.status != 'active'
       AND (
         t.planning_dispatch_error IS NULL
         OR trim(t.planning_dispatch_error) = ''
         OR t.planning_dispatch_error LIKE ?
       )`,
    [`${UNRECONCILED_RUN_ERROR_PREFIX}%`]
  );

  let recoveredCount = 0;

  for (const task of unreconciledRuns) {
    const reconciliationState = await reconcileTaskRuntimeEvidence(task.id);
    const sessionKey = buildTaskSessionKey(task);

    if (sessionKey) {
      const matchingGatewaySession = reconciliationState.relevantSessions.find(
        (session) => session.key === sessionKey,
      );

      try {
        console.info(
          `[Health] Reconciling ended task run ${task.id}: session=${sessionKey} status=${task.latest_session_status || 'unknown'} history=lookup`,
        );
        const resolvedOutcome = await resolveTaskRunOutcomeFromGatewayHistory({
          sessionKey,
          sessionId: matchingGatewaySession?.sessionId || null,
          startedAt: matchingGatewaySession?.createdAt || null,
          endedAt: matchingGatewaySession?.endedAt || null,
        });

        console.info(
          `[Health] Reconciliation outcome for task ${task.id}: ${
            resolvedOutcome.kind === 'signal'
              ? 'signal'
              : resolvedOutcome.kind === 'runtime_blocked'
                ? 'runtime_blocked'
                : 'none'
          }`,
        );

        if (resolvedOutcome.kind === 'signal' || resolvedOutcome.kind === 'runtime_blocked') {
          const result = await processAgentSignal({
            taskId: task.id,
            sessionKey,
            message: resolvedOutcome.message,
          });

          if (result.handled) {
            recoveredCount += 1;
            continue;
          }
        }
      } catch (error) {
        console.warn(`[Health] Failed to resolve transcript outcome for task ${task.id}:`, error);
      }
    } else {
      console.info(
        `[Health] Reconciling ended task run ${task.id}: no stable session key available for history lookup`,
      );
    }

    const error = `Run ended without completion callback or workflow handoff (${task.latest_session_status || 'ended'} session).`;
    const existingRunError = queryOne<{ id: string }>(
      `SELECT id
       FROM task_activities
       WHERE task_id = ?
         AND message = ?
         AND created_at >= COALESCE(?, ?, created_at)
       ORDER BY created_at DESC
       LIMIT 1`,
      [task.id, error, task.latest_session_created_at || null, task.latest_session_updated_at || null]
    );

    if (existingRunError && task.planning_dispatch_error === error) {
      if (task.assigned_agent_id) {
        run(
          `UPDATE agents SET status = 'standby', updated_at = ? WHERE id = ? AND status = 'working'`,
          [now, task.assigned_agent_id]
        );
      }
      continue;
    }

    run(
      `UPDATE tasks
       SET planning_dispatch_error = ?, status_reason = ?, updated_at = ?
       WHERE id = ?`,
      [error, error, now, task.id]
    );
    run(
      `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, created_at)
       VALUES (?, ?, ?, 'status_changed', ?, ?)`,
      [uuidv4(), task.id, task.assigned_agent_id, error, now]
    );
    if (task.assigned_agent_id) {
      run(
        `UPDATE agents SET status = 'standby', updated_at = ? WHERE id = ? AND status = 'working'`,
        [now, task.assigned_agent_id]
      );
    }
  }

  return recoveredCount;
}

export async function recoverUnreconciledTaskRuns(now = new Date().toISOString()): Promise<number> {
  if (unreconciledTaskRunRecoveryInFlight) {
    return unreconciledTaskRunRecoveryInFlight;
  }

  unreconciledTaskRunRecoveryInFlight = recoverUnreconciledTaskRunsInternal(now);

  try {
    return await unreconciledTaskRunRecoveryInFlight;
  } finally {
    unreconciledTaskRunRecoveryInFlight = null;
  }
}

export function setHealthCheckImplementationForTests(
  implementation: (() => Promise<AgentHealth[]>) | null,
): void {
  healthCheckImplementationForTests = implementation;
  healthCheckCycleInFlight = null;
}

function buildTaskSessionKey(task: {
  latest_openclaw_session_id?: string;
  latest_agent_role?: string | null;
  latest_agent_session_key_prefix?: string | null;
}): string | null {
  const openclawSessionId = task.latest_openclaw_session_id;
  if (!openclawSessionId) return null;
  if (openclawSessionId.startsWith('agent:')) return openclawSessionId;

  return buildAgentSessionKey(openclawSessionId, {
    role: task.latest_agent_role || undefined,
    session_key_prefix: task.latest_agent_session_key_prefix || undefined,
  });
}

/**
 * Nudge a stuck agent: re-dispatch its task with the latest checkpoint context.
 */
export async function nudgeAgent(agentId: string): Promise<{ success: boolean; error?: string }> {
  const activeTask = queryOne<Task>(
    `SELECT * FROM tasks WHERE assigned_agent_id = ? AND status IN ('assigned', 'in_progress', 'testing', 'verification') LIMIT 1`,
    [agentId]
  );

  if (!activeTask) {
    return { success: false, error: 'No active task for this agent' };
  }

  const now = new Date().toISOString();

  // Kill current session
  run(
    `UPDATE openclaw_sessions SET status = 'ended', ended_at = ?, updated_at = ? WHERE agent_id = ? AND status = 'active'`,
    [now, now, agentId]
  );

  // Build checkpoint context
  const checkpointCtx = buildCheckpointContext(activeTask.id);

  // Append checkpoint to task description if available
  if (checkpointCtx) {
    const newDesc = (activeTask.description || '') + checkpointCtx;
    run(
      `UPDATE tasks SET description = ?, status = 'assigned', planning_dispatch_error = NULL, updated_at = ? WHERE id = ?`,
      [newDesc, now, activeTask.id]
    );
  } else {
    run(
      `UPDATE tasks SET status = 'assigned', planning_dispatch_error = NULL, updated_at = ? WHERE id = ?`,
      [now, activeTask.id]
    );
  }

  // Re-dispatch via API
  const missionControlUrl = getMissionControlUrl();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (process.env.MC_API_TOKEN) {
    headers['Authorization'] = `Bearer ${process.env.MC_API_TOKEN}`;
  }

  try {
    const res = await fetch(`${missionControlUrl}/api/tasks/${activeTask.id}/dispatch`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const errorText = await res.text();
      return { success: false, error: `Dispatch failed: ${errorText}` };
    }

    // Log nudge
    run(
      `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, created_at)
       VALUES (?, ?, ?, 'status_changed', 'Agent nudged — re-dispatching with checkpoint context', ?)`,
      [uuidv4(), activeTask.id, agentId, now]
    );

    // Reset stall counter
    run(
      `UPDATE agent_health SET consecutive_stall_checks = 0, health_state = 'working', updated_at = ? WHERE agent_id = ?`,
      [now, agentId]
    );

    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Get health state for all agents.
 */
export function getAllAgentHealth(): AgentHealth[] {
  return queryAll<AgentHealth>('SELECT * FROM agent_health ORDER BY updated_at DESC');
}

/**
 * Get health state for a single agent.
 */
export function getAgentHealth(agentId: string): AgentHealth | null {
  return queryOne<AgentHealth>('SELECT * FROM agent_health WHERE agent_id = ?', [agentId]) || null;
}
