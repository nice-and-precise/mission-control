/**
 * Workflow Engine
 *
 * Handles automatic stage transitions, role-based agent handoffs,
 * and fail-loopback logic for multi-agent task workflows.
 */

import { queryOne, queryAll, run } from '@/lib/db';
import { pickDynamicAgent, pickWorkspaceAgentForRole, escalateFailureIfNeeded, recordLearnerOnTransition } from '@/lib/task-governance';
import { getMissionControlUrl } from '@/lib/config';
import { broadcast } from '@/lib/events';
import type { Task, WorkflowTemplate, WorkflowStage, TaskRole } from '@/lib/types';

const EXECUTING_STATUSES = ['in_progress', 'testing', 'review', 'verification', 'convoy_active'] as const;
const WAITING_FOR_AGENT_PREFIX = 'Waiting for ';

interface StageTransitionResult {
  success: boolean;
  handedOff: boolean;
  queued?: boolean;
  newAgentId?: string;
  newAgentName?: string;
  error?: string;
}

interface QueueAdvanceResult extends StageTransitionResult {
  advancedTaskId?: string;
  queued?: boolean;
}

/**
 * Get the workflow template for a task (via task.workflow_template_id or workspace default)
 */
export function getTaskWorkflow(taskId: string): WorkflowTemplate | null {
  const task = queryOne<{ workflow_template_id?: string; workspace_id: string }>(
    'SELECT workflow_template_id, workspace_id FROM tasks WHERE id = ?',
    [taskId]
  );
  if (!task) return null;

  // Try task-specific template first
  if (task.workflow_template_id) {
    const tpl = queryOne<{ id: string; workspace_id: string; name: string; description: string; stages: string; fail_targets: string; is_default: number; created_at: string; updated_at: string }>(
      'SELECT * FROM workflow_templates WHERE id = ?',
      [task.workflow_template_id]
    );
    if (tpl) return parseTemplate(tpl);
  }

  // Fall back to workspace default
  const tpl = queryOne<{ id: string; workspace_id: string; name: string; description: string; stages: string; fail_targets: string; is_default: number; created_at: string; updated_at: string }>(
    'SELECT * FROM workflow_templates WHERE workspace_id = ? AND is_default = 1 LIMIT 1',
    [task.workspace_id]
  );
  if (tpl) return parseTemplate(tpl);

  // Fall back to global default
  const globalTpl = queryOne<{ id: string; workspace_id: string; name: string; description: string; stages: string; fail_targets: string; is_default: number; created_at: string; updated_at: string }>(
    "SELECT * FROM workflow_templates WHERE is_default = 1 ORDER BY created_at ASC LIMIT 1"
  );
  return globalTpl ? parseTemplate(globalTpl) : null;
}

export function getWorkflowStageForStatus(
  workflow: WorkflowTemplate | null | undefined,
  status: string | null | undefined,
): WorkflowStage | null {
  if (!workflow || !status) return null;
  const directMatch = workflow.stages.find((stage) => stage.status === status);
  if (directMatch) return directMatch;

  if (status === 'assigned') {
    return workflow.stages.find((stage) => stage.role?.toLowerCase() === 'builder') || null;
  }

  return null;
}

export function getWorkflowOwnerRoleForStatus(
  workflow: WorkflowTemplate | null | undefined,
  status: string | null | undefined,
): string | null {
  return getWorkflowStageForStatus(workflow, status)?.role || null;
}

function safeParseJson<T>(raw: string | null | undefined, fallback: T, context: string): T {
  try {
    return JSON.parse(raw || '') as T;
  } catch (error) {
    console.error(`[Workflow] Failed to parse ${context}:`, error);
    return fallback;
  }
}

function parseTemplate(row: { id: string; workspace_id: string; name: string; description: string; stages: string; fail_targets: string; is_default: number; created_at: string; updated_at: string }): WorkflowTemplate {
  return {
    ...row,
    stages: safeParseJson<WorkflowStage[]>(row.stages, [], `workflow stages for template ${row.id}`),
    fail_targets: safeParseJson<Record<string, string>>(row.fail_targets, {}, `workflow fail_targets for template ${row.id}`),
    is_default: Boolean(row.is_default),
  };
}

/**
 * Get all role assignments for a task
 */
export function getTaskRoles(taskId: string): TaskRole[] {
  return queryAll<TaskRole>(
    `SELECT tr.*, a.name as agent_name, a.avatar_emoji
     FROM task_roles tr
     LEFT JOIN agents a ON tr.agent_id = a.id
     WHERE tr.task_id = ?`,
    [taskId]
  );
}

/**
 * Find the agent assigned to a specific role on a task
 */
function getAgentForRole(taskId: string, role: string): { id: string; name: string } | null {
  const result = queryOne<{ agent_id: string; agent_name: string }>(
    `SELECT tr.agent_id, a.name as agent_name
     FROM task_roles tr
     JOIN agents a ON tr.agent_id = a.id
     WHERE tr.task_id = ? AND tr.role = ?`,
    [taskId, role]
  );
  return result ? { id: result.agent_id, name: result.agent_name } : null;
}

async function dispatchNextQueuedBuilderTask(agentId: string, previousTaskId: string, workspaceId: string): Promise<boolean> {
  const releasedAgent = queryOne<{ role: string; name: string }>(
    'SELECT role, name FROM agents WHERE id = ? LIMIT 1',
    [agentId]
  );
  if (!releasedAgent || releasedAgent.role.toLowerCase() !== 'builder') {
    return false;
  }

  const executingPlaceholders = EXECUTING_STATUSES.map(() => '?').join(', ');
  const otherExecutingTasks = queryOne<{ cnt: number }>(
    `SELECT COUNT(*) as cnt
     FROM tasks
     WHERE assigned_agent_id = ?
       AND id != ?
       AND workspace_id = ?
       AND status IN (${executingPlaceholders})`,
    [agentId, previousTaskId, workspaceId, ...EXECUTING_STATUSES]
  );

  if (Number(otherExecutingTasks?.cnt || 0) > 0) {
    return false;
  }

  let queuedTask = queryOne<{ id: string; title: string; assigned_agent_id: string | null }>(
    `SELECT t.id, t.title, t.assigned_agent_id
     FROM tasks t
     WHERE t.assigned_agent_id = ?
       AND t.id != ?
       AND t.workspace_id = ?
       AND t.status = 'assigned'
       AND t.status_reason LIKE ?
       AND NOT EXISTS (
         SELECT 1
         FROM openclaw_sessions os
         WHERE os.active_task_id = t.id
           AND os.status = 'active'
           AND os.session_type != 'subagent'
       )
     ORDER BY t.updated_at ASC
     LIMIT 1`,
    [agentId, previousTaskId, workspaceId, `${WAITING_FOR_AGENT_PREFIX}%before starting this task.`]
  );

  if (!queuedTask) {
    queuedTask = queryOne<{ id: string; title: string; assigned_agent_id: string | null }>(
      `SELECT t.id, t.title, t.assigned_agent_id
       FROM tasks t
       WHERE t.id != ?
         AND t.workspace_id = ?
         AND t.status = 'assigned'
         AND t.status_reason LIKE ?
         AND NOT EXISTS (
           SELECT 1
           FROM openclaw_sessions os
           WHERE os.active_task_id = t.id
             AND os.status = 'active'
             AND os.session_type != 'subagent'
         )
       ORDER BY t.updated_at ASC
       LIMIT 1`,
      [previousTaskId, workspaceId, `${WAITING_FOR_AGENT_PREFIX}%before starting this task.`]
    );
  }

  if (!queuedTask) {
    return false;
  }

  if (queuedTask.assigned_agent_id !== agentId) {
    const now = new Date().toISOString();
    run(
      `UPDATE tasks
       SET assigned_agent_id = ?,
           planning_dispatch_error = NULL,
           status_reason = ?,
           updated_at = ?
       WHERE id = ?`,
      [agentId, 'Builder reassigned from queue to the next available execution slot.', now, queuedTask.id]
    );

    const existingBuilderRole = queryOne<{ id: string }>(
      `SELECT id
       FROM task_roles
       WHERE task_id = ?
         AND lower(role) = 'builder'
       ORDER BY created_at ASC
       LIMIT 1`,
      [queuedTask.id]
    );

    if (existingBuilderRole) {
      run('UPDATE task_roles SET agent_id = ?, created_at = ? WHERE id = ?', [agentId, now, existingBuilderRole.id]);
    } else {
      run(
        `INSERT INTO task_roles (id, task_id, role, agent_id, created_at)
         VALUES (?, ?, 'builder', ?, ?)`,
        [crypto.randomUUID(), queuedTask.id, agentId, now]
      );
    }

    run(
      `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, created_at)
       VALUES (?, ?, ?, 'status_changed', ?, ?)`,
      [
        crypto.randomUUID(),
        queuedTask.id,
        agentId,
        `Builder queue rebalanced: ${releasedAgent.name} picked up this task from the shared builder pool`,
        now,
      ]
    );
  }

  const missionControlUrl = getMissionControlUrl();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (process.env.MC_API_TOKEN) {
    headers['Authorization'] = `Bearer ${process.env.MC_API_TOKEN}`;
  }

  try {
    const dispatchRes = await fetch(`${missionControlUrl}/api/tasks/${queuedTask.id}/dispatch`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(30_000),
    });

    if (!dispatchRes.ok) {
      const errorText = await dispatchRes.text();
      const dispatchError = `Queued builder dispatch failed (${dispatchRes.status}): ${errorText}`;
      run(
        'UPDATE tasks SET planning_dispatch_error = ?, updated_at = datetime(\'now\') WHERE id = ?',
        [dispatchError, queuedTask.id]
      );
      console.error(`[Workflow] ${dispatchError}`);
      return false;
    }

    const payload = await dispatchRes.json().catch(() => null) as { queued?: boolean } | null;
    if (payload?.queued) {
      console.log(`[Workflow] Builder queue still blocked for task ${queuedTask.id}`);
      return false;
    }

    console.log(`[Workflow] Auto-started queued builder task ${queuedTask.id} after releasing agent ${agentId}`);
    return true;
  } catch (err) {
    const dispatchError = `Queued builder dispatch error: ${(err as Error).message}`;
    run(
      'UPDATE tasks SET planning_dispatch_error = ?, updated_at = datetime(\'now\') WHERE id = ?',
      [dispatchError, queuedTask.id]
    );
    console.error(`[Workflow] ${dispatchError}`);
    return false;
  }
}

/**
 * Handle a task stage transition. Called when status changes.
 *
 * This is the core workflow orchestration function:
 * 1. Looks up the workflow template for the task
 * 2. Finds which role owns the new status
 * 3. Assigns the correct agent and dispatches
 * 4. Handles fail-loopback (e.g., testing failure → back to builder)
 */
export async function handleStageTransition(
  taskId: string,
  newStatus: string,
  options?: {
    failReason?: string;
    previousStatus?: string;
    skipDispatch?: boolean;
  }
): Promise<StageTransitionResult> {
  const workflow = getTaskWorkflow(taskId);
  if (!workflow) {
    // No workflow template — fall back to legacy single-agent behavior
    return { success: true, handedOff: false };
  }

  // Find the stage that maps to this status
  const targetStage = getWorkflowStageForStatus(workflow, newStatus);
  if (!targetStage) {
    // Status not in workflow
    return { success: true, handedOff: false };
  }

  if (!targetStage.role) {
    if (targetStage.status !== 'done') {
      // Queue stage (no role, not done) — park the task here, then try to drain
      console.log(`[Workflow] Task ${taskId} entered queue stage "${targetStage.label}"`);
      const task = queryOne<{ workspace_id: string }>('SELECT workspace_id FROM tasks WHERE id = ?', [taskId]);
      if (task) {
        const drainResult = await advanceQueueStage(taskId, task.workspace_id, workflow, targetStage.status);
        if (!drainResult.success && drainResult.error) {
          return {
            success: false,
            handedOff: drainResult.handedOff,
            newAgentId: drainResult.newAgentId,
            newAgentName: drainResult.newAgentName,
            error: drainResult.error,
          };
        }
        if (drainResult.advancedTaskId === taskId) {
          return {
            success: true,
            handedOff: drainResult.handedOff,
            newAgentId: drainResult.newAgentId,
            newAgentName: drainResult.newAgentName,
          };
        }
      }
    }
    return { success: true, handedOff: false };
  }

  // Find the agent assigned to this role (task_roles first, then fall back to assigned_agent_id)
  let roleAgent = getAgentForRole(taskId, targetStage.role);
  if (!roleAgent) {
    // Fall back to the task's directly assigned agent
    const task = queryOne<{ assigned_agent_id: string | null }>(
      'SELECT assigned_agent_id FROM tasks WHERE id = ?',
      [taskId]
    );
    if (task?.assigned_agent_id) {
      const agent = queryOne<{ id: string; name: string }>(
        'SELECT id, name FROM agents WHERE id = ?',
        [task.assigned_agent_id]
      );
      if (agent) {
        console.log(`[Workflow] No task_role for "${targetStage.role}", using assigned agent "${agent.name}"`);
        roleAgent = agent;
      }
    }
  }
  if (!roleAgent) {
    // Dynamic routing fallback (planner+rules) when explicit role assignment is missing
    roleAgent = pickDynamicAgent(taskId, targetStage.role);
  }

  if (!roleAgent) {
    const errorMsg = `No eligible agent found for stage role: ${targetStage.role}.`;
    run(
      'UPDATE tasks SET planning_dispatch_error = ?, updated_at = datetime(\'now\') WHERE id = ?',
      [errorMsg, taskId]
    );
    console.warn(`[Workflow] ${errorMsg} (task ${taskId})`);
    return { success: false, handedOff: false, error: errorMsg };
  }

  // Preserve previous agent before updating the task. If the workflow moves the
  // task off the builder, we may immediately start the next queued builder task.
  const previousTask = queryOne<{ assigned_agent_id: string | null; workspace_id: string | null }>(
    'SELECT assigned_agent_id, workspace_id FROM tasks WHERE id = ?',
    [taskId]
  );
  const releasedAgentId =
    previousTask?.assigned_agent_id && previousTask.assigned_agent_id !== roleAgent.id
      ? previousTask.assigned_agent_id
      : null;
  const releasedWorkspaceId = previousTask?.workspace_id || null;

  // Assign agent to task. Preserve the explicit failure reason when a stage is
  // being routed back through the workflow fail target so the UI still shows
  // why the task re-entered the builder stage.
  const now = new Date().toISOString();
  const shouldPreserveStatusReason = Boolean(options?.failReason);
  run(
    shouldPreserveStatusReason
      ? 'UPDATE tasks SET assigned_agent_id = ?, planning_dispatch_error = NULL, updated_at = ? WHERE id = ?'
      : 'UPDATE tasks SET assigned_agent_id = ?, planning_dispatch_error = NULL, status_reason = NULL, updated_at = ? WHERE id = ?',
    shouldPreserveStatusReason
      ? [roleAgent.id, now, taskId]
      : [roleAgent.id, now, taskId]
  );

  if (releasedAgentId && releasedWorkspaceId) {
    const startedQueuedTask = await dispatchNextQueuedBuilderTask(releasedAgentId, taskId, releasedWorkspaceId).catch(err => {
      console.error(`[Workflow] Failed to advance queued builder task for agent ${releasedAgentId}:`, err);
      return false;
    });

    if (!startedQueuedTask) {
      const executingPlaceholders = EXECUTING_STATUSES.map(() => '?').join(', ');
      const otherExecutingTasks = queryOne<{ cnt: number }>(
        `SELECT COUNT(*) as cnt
         FROM tasks
         WHERE assigned_agent_id = ?
           AND id != ?
           AND workspace_id = ?
           AND status IN (${executingPlaceholders})`,
        [releasedAgentId, taskId, releasedWorkspaceId, ...EXECUTING_STATUSES]
      );
      if (!otherExecutingTasks || otherExecutingTasks.cnt === 0) {
        run(
          `UPDATE agents SET status = 'standby', updated_at = datetime('now') WHERE id = ? AND status = 'working'`,
          [releasedAgentId]
        );
      }
    }
  }

  // Log the handoff
  run(
    `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, created_at)
     VALUES (?, ?, ?, 'status_changed', ?, ?)`,
    [
      crypto.randomUUID(), taskId, roleAgent.id,
      `Stage handoff: ${targetStage.label} → ${roleAgent.name}${options?.failReason ? ` (reason: ${options.failReason})` : ''}`,
      now
    ]
  );

  recordLearnerOnTransition(taskId, options?.previousStatus || newStatus, newStatus, true).catch(err =>
    console.error('[Learner] transition record failed:', err)
  );

  if (options?.skipDispatch) {
    return { success: true, handedOff: true, newAgentId: roleAgent.id, newAgentName: roleAgent.name };
  }

  // Dispatch to the agent
  const missionControlUrl = getMissionControlUrl();
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (process.env.MC_API_TOKEN) {
      headers['Authorization'] = `Bearer ${process.env.MC_API_TOKEN}`;
    }

    const dispatchRes = await fetch(`${missionControlUrl}/api/tasks/${taskId}/dispatch`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(30_000),
    });

    if (!dispatchRes.ok) {
      const errorText = await dispatchRes.text();
      const error = `Auto-dispatch to ${roleAgent.name} failed (${dispatchRes.status}): ${errorText}`;
      console.error(`[Workflow] ${error}`);
      run('UPDATE tasks SET planning_dispatch_error = ?, updated_at = ? WHERE id = ?', [error, now, taskId]);
      return { success: false, handedOff: true, newAgentId: roleAgent.id, newAgentName: roleAgent.name, error };
    }

    const dispatchPayload = await dispatchRes.clone().json().catch(() => null) as
      | { queued?: boolean }
      | null;

    if (dispatchPayload?.queued) {
      console.log(`[Workflow] Queued task ${taskId} for ${roleAgent.name} until the agent is free`);
      return { success: true, handedOff: false, queued: true, newAgentId: roleAgent.id, newAgentName: roleAgent.name };
    }

    console.log(`[Workflow] Dispatched task ${taskId} to ${roleAgent.name} (role: ${targetStage.role})`);
    return { success: true, handedOff: true, newAgentId: roleAgent.id, newAgentName: roleAgent.name };
  } catch (err) {
    const error = `Dispatch error: ${(err as Error).message}`;
    console.error(`[Workflow] ${error}`);
    run('UPDATE tasks SET planning_dispatch_error = ?, updated_at = ? WHERE id = ?', [error, now, taskId]);
    return { success: false, handedOff: true, newAgentId: roleAgent.id, newAgentName: roleAgent.name, error };
  }
}

/**
 * Handle a stage failure — move task back to the fail target stage.
 * Called when testing/review/verification fails.
 */
export async function handleStageFailure(
  taskId: string,
  currentStatus: string,
  failReason: string
): Promise<StageTransitionResult> {
  const workflow = getTaskWorkflow(taskId);
  if (!workflow) {
    return { success: false, handedOff: false, error: 'No workflow template' };
  }

  const targetStatus = workflow.fail_targets[currentStatus];
  if (!targetStatus) {
    return { success: false, handedOff: false, error: `No fail target defined for status: ${currentStatus}` };
  }

  const now = new Date().toISOString();

  // Log the failure
  run(
    `INSERT INTO task_activities (id, task_id, activity_type, message, created_at)
     VALUES (?, ?, 'status_changed', ?, ?)`,
    [crypto.randomUUID(), taskId, `Stage failed: ${currentStatus} → ${targetStatus} (reason: ${failReason})`, now]
  );

  // Update task status to the fail target
  run(
    'UPDATE tasks SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?',
    [targetStatus, `Failed: ${failReason}`, now, taskId]
  );

  // Broadcast update
  const updatedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (updatedTask) {
    broadcast({ type: 'task_updated', payload: updatedTask });
  }

  await recordLearnerOnTransition(taskId, currentStatus, targetStatus, false, failReason);
  await escalateFailureIfNeeded(taskId, currentStatus);

  // Trigger handoff to the agent that owns the fail target stage
  return handleStageTransition(taskId, targetStatus, {
    failReason,
    previousStatus: currentStatus,
  });
}

/**
 * Auto-populate task_roles from planning agents when a workflow template is assigned.
 * Maps agent roles to workflow stage roles using fuzzy matching.
 */
export function populateTaskRolesFromAgents(taskId: string, workspaceId: string): void {
  const workflow = getTaskWorkflow(taskId);
  if (!workflow) return;

  const existingRoles = getTaskRoles(taskId);
  if (existingRoles.length > 0) return; // Already populated

  // For each stage that requires a role, try to find a matching agent
  const roleMap: Record<string, string> = {};
  for (const stage of workflow.stages) {
    if (!stage.role || roleMap[stage.role]) continue;

    const match = pickWorkspaceAgentForRole(workspaceId, stage.role, { excludeTaskId: taskId });

    if (match) {
      roleMap[stage.role] = match.id;
    }
  }

  // Learner fallback: the 'learner' role isn't in any workflow stage,
  // so it won't be matched above. Find a learner agent and assign it.
  if (!roleMap['learner']) {
    const learner = pickWorkspaceAgentForRole(workspaceId, 'learner', { excludeTaskId: taskId });
    if (learner) {
      roleMap['learner'] = learner.id;
    }
  }

  // Insert role assignments
  for (const [role, agentId] of Object.entries(roleMap)) {
    run(
      `INSERT OR IGNORE INTO task_roles (id, task_id, role, agent_id, created_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
      [crypto.randomUUID(), taskId, role, agentId]
    );
  }

  if (Object.keys(roleMap).length > 0) {
    console.log(`[Workflow] Auto-populated ${Object.keys(roleMap).length} role(s) for task ${taskId}`);
  }
}

/**
 * Drain the review queue: advance the oldest queued task to the next stage
 * if that stage is free (no other task currently occupying it).
 *
 * Call this when:
 * - A task enters a queue stage (immediate pickup if next stage is free)
 * - A task moves to 'done' (frees the verification slot)
 * - A task fails from verification/testing (frees the slot)
 */
export async function drainQueue(
  triggeringTaskId: string,
  workspaceId: string,
  workflow?: WorkflowTemplate | null,
): Promise<void> {
  if (!workflow) {
    // Try to resolve from the triggering task
    workflow = getTaskWorkflow(triggeringTaskId);
  }
  if (!workflow) return;

  // Find queue stages (role === null and status !== 'done')
  for (const stage of workflow.stages) {
    if (stage.role !== null || stage.status === 'done') continue;
    await advanceQueueStage(triggeringTaskId, workspaceId, workflow, stage.status);
  }
}

async function advanceQueueStage(
  triggeringTaskId: string,
  workspaceId: string,
  workflow: WorkflowTemplate,
  queueStatus: string,
): Promise<QueueAdvanceResult> {
  const stage = workflow.stages.find(current => current.status === queueStatus && current.role === null);
  if (!stage || stage.status === 'done') {
    return { success: true, handedOff: false };
  }

  const stageIndex = workflow.stages.indexOf(stage);
  const nextStage = workflow.stages[stageIndex + 1];
  if (!nextStage || nextStage.status === 'done') {
    return { success: true, handedOff: false };
  }

  const occupant = queryOne<{ id: string }>(
    'SELECT id FROM tasks WHERE workspace_id = ? AND status = ? LIMIT 1',
    [workspaceId, nextStage.status]
  );
  if (occupant) {
    console.log(`[Workflow] Next stage "${nextStage.label}" is occupied by task ${occupant.id} — queue holds`);
    return { success: true, handedOff: false, queued: true };
  }

  const oldest = queryOne<{ id: string }>(
    'SELECT id FROM tasks WHERE workspace_id = ? AND status = ? ORDER BY updated_at ASC LIMIT 1',
    [workspaceId, stage.status]
  );
  if (!oldest) {
    return { success: true, handedOff: false };
  }

  console.log(`[Workflow] Draining queue: advancing task ${oldest.id} from "${stage.label}" → "${nextStage.label}"`);

  const now = new Date().toISOString();
  run('UPDATE tasks SET status = ?, planning_dispatch_error = NULL, updated_at = ? WHERE id = ?', [nextStage.status, now, oldest.id]);

  const updated = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [oldest.id]);
  if (updated) broadcast({ type: 'task_updated', payload: updated });

  const result = await handleStageTransition(oldest.id, nextStage.status);
  if (!result.success && result.error) {
    run('UPDATE tasks SET planning_dispatch_error = ?, updated_at = ? WHERE id = ?', [result.error, now, oldest.id]);
  }

  return {
    ...result,
    advancedTaskId: oldest.id,
  };
}
