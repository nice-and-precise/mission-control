import { queryAll, queryOne, run, transaction } from '@/lib/db';
import { notifyLearner } from '@/lib/learner';
import type { Task } from '@/lib/types';

const ACTIVE_STATUSES = ['assigned', 'in_progress', 'convoy_active', 'testing', 'review', 'verification'];
const EXECUTION_STATUSES = ['in_progress', 'convoy_active', 'testing', 'review', 'verification'] as const;

interface WorkspaceRoleCandidate {
  id: string;
  name: string;
  status: string;
  updated_at: string;
}

interface AgentTaskLoad {
  activeTaskCount: number;
  queuedTaskCount: number;
}

export function hasStageEvidence(taskId: string): boolean {
  const deliverable = queryOne<{ count: number }>('SELECT COUNT(*) as count FROM task_deliverables WHERE task_id = ?', [taskId]);
  const activity = queryOne<{ count: number }>(
    `SELECT COUNT(*) as count FROM task_activities WHERE task_id = ? AND activity_type IN ('completed','file_created','updated')`,
    [taskId]
  );
  return Number(deliverable?.count || 0) > 0 && Number(activity?.count || 0) > 0;
}

export function canUseBoardOverride(request: Request): boolean {
  if (process.env.BOARD_OVERRIDE_ENABLED !== 'true') return false;
  return request.headers.get('x-mc-board-override') === 'true';
}

export function auditBoardOverride(taskId: string, fromStatus: string, toStatus: string, reason?: string): void {
  const now = new Date().toISOString();
  run(
    `INSERT INTO events (id, type, task_id, message, metadata, created_at)
     VALUES (lower(hex(randomblob(16))), 'system', ?, ?, ?, ?)`,
    [taskId, `Board override: ${fromStatus} → ${toStatus}`, JSON.stringify({ boardOverride: true, reason: reason || null }), now]
  );
}

export function getFailureCountInStage(taskId: string, stage: string): number {
  const row = queryOne<{ count: number }>(
    `SELECT COUNT(*) as count
     FROM task_activities
     WHERE task_id = ? AND activity_type = 'status_changed' AND message LIKE ?`,
    [taskId, `%Stage failed: ${stage}%`]
  );
  return Number(row?.count || 0);
}

// Lookup-only: returns a pre-seeded fixer/senior agent for this workspace, or null if none
// exists. Does NOT auto-create agents — callers must seed a fixer agent manually before
// the escalation path can activate. This prevents ghost agents with no model or docs from
// appearing on the board after stage failures.
export function ensureFixerExists(workspaceId: string): { id: string; name: string } | null {
  return queryOne<{ id: string; name: string }>(
    `SELECT id, name FROM agents WHERE workspace_id = ? AND role IN ('fixer','senior') AND status != 'offline' ORDER BY role = 'fixer' DESC, updated_at DESC LIMIT 1`,
    [workspaceId]
  ) ?? null;
}

export async function escalateFailureIfNeeded(taskId: string, stage: string): Promise<void> {
  const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (!task) return;

  if (getFailureCountInStage(taskId, stage) < 2) return;

  const fixer = ensureFixerExists(task.workspace_id);
  const now = new Date().toISOString();

  if (!fixer) {
    // No fixer agent is configured for this workspace — log a board-visible warning and stop.
    // To activate escalation, manually create an agent with role='fixer' in this workspace.
    run(
      `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, created_at)
       VALUES (lower(hex(randomblob(16))), ?, NULL, 'governance_warning', ?, ?)`,
      [taskId, `Escalation threshold reached in stage "${stage}" but no fixer agent is configured for this workspace. Manually create a fixer agent to enable auto-escalation.`, now]
    );
    return;
  }

  transaction(() => {
    run('UPDATE tasks SET assigned_agent_id = ?, status_reason = ?, updated_at = ? WHERE id = ?', [
      fixer.id,
      `Escalated after repeated failures in ${stage}`,
      now,
      taskId,
    ]);

    run(
      `INSERT OR REPLACE INTO task_roles (id, task_id, role, agent_id, created_at)
       VALUES (COALESCE((SELECT id FROM task_roles WHERE task_id = ? AND role = 'fixer'), lower(hex(randomblob(16)))), ?, 'fixer', ?, ?)`,
      [taskId, taskId, fixer.id, now]
    );

    run(
      `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, created_at)
       VALUES (lower(hex(randomblob(16))), ?, ?, 'status_changed', ?, ?)`,
      [taskId, fixer.id, `Escalated to ${fixer.name} after repeated failures in ${stage}`, now]
    );
  });

  await notifyLearner(taskId, {
    previousStatus: stage,
    newStatus: stage,
    passed: true,
    context: `Fixer agent (${fixer.name}) assigned due to repeated stage failures.`,
  });
}

export async function recordLearnerOnTransition(taskId: string, previousStatus: string, newStatus: string, passed = true, failReason?: string): Promise<void> {
  await notifyLearner(taskId, { previousStatus, newStatus, passed, failReason });
}

export function taskCanBeDone(taskId: string): boolean {
  const task = queryOne<{ status: string; status_reason?: string }>('SELECT status, status_reason FROM tasks WHERE id = ?', [taskId]);
  if (!task) return false;
  const hasValidationFailure = (task.status_reason || '').toLowerCase().includes('fail');
  return !hasValidationFailure && hasStageEvidence(taskId);
}

export function isActiveStatus(status: string): boolean {
  return ACTIVE_STATUSES.includes(status);
}

function parseSortTimestamp(value: string): number {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? timestamp : Number.MAX_SAFE_INTEGER;
}

function sortCandidatesByLoad(
  left: WorkspaceRoleCandidate,
  right: WorkspaceRoleCandidate,
  loadByAgentId: Map<string, AgentTaskLoad>,
): number {
  const leftLoad = loadByAgentId.get(left.id) || { activeTaskCount: 0, queuedTaskCount: 0 };
  const rightLoad = loadByAgentId.get(right.id) || { activeTaskCount: 0, queuedTaskCount: 0 };

  if (leftLoad.activeTaskCount !== rightLoad.activeTaskCount) {
    return leftLoad.activeTaskCount - rightLoad.activeTaskCount;
  }

  if (leftLoad.queuedTaskCount !== rightLoad.queuedTaskCount) {
    return leftLoad.queuedTaskCount - rightLoad.queuedTaskCount;
  }

  if (left.status !== right.status) {
    return Number(right.status === 'standby') - Number(left.status === 'standby');
  }

  const timestampDiff = parseSortTimestamp(left.updated_at) - parseSortTimestamp(right.updated_at);
  if (timestampDiff !== 0) {
    return timestampDiff;
  }

  const nameDiff = left.name.localeCompare(right.name);
  if (nameDiff !== 0) {
    return nameDiff;
  }

  return left.id.localeCompare(right.id);
}

function buildRoleCandidateLoadMap(
  workspaceId: string,
  candidateIds: string[],
  excludeTaskId?: string | null,
): Map<string, AgentTaskLoad> {
  const loadByAgentId = new Map<string, AgentTaskLoad>();
  if (candidateIds.length === 0) {
    return loadByAgentId;
  }

  const agentPlaceholders = candidateIds.map(() => '?').join(', ');
  const statusPlaceholders = ACTIVE_STATUSES.map(() => '?').join(', ');
  const excludeClause = excludeTaskId ? 'AND id != ?' : '';
  const taskRows = queryAll<{ assigned_agent_id: string; status: string }>(
    `SELECT assigned_agent_id, status
     FROM tasks
     WHERE workspace_id = ?
       AND assigned_agent_id IN (${agentPlaceholders})
       AND status IN (${statusPlaceholders})
       ${excludeClause}`,
    excludeTaskId
      ? [workspaceId, ...candidateIds, ...ACTIVE_STATUSES, excludeTaskId]
      : [workspaceId, ...candidateIds, ...ACTIVE_STATUSES],
  );

  for (const row of taskRows) {
    const current = loadByAgentId.get(row.assigned_agent_id) || { activeTaskCount: 0, queuedTaskCount: 0 };
    if (row.status === 'assigned') {
      current.queuedTaskCount += 1;
    } else if ((EXECUTION_STATUSES as readonly string[]).includes(row.status)) {
      current.activeTaskCount += 1;
    }
    loadByAgentId.set(row.assigned_agent_id, current);
  }

  return loadByAgentId;
}

export function pickWorkspaceAgentForRole(
  workspaceId: string,
  role: string,
  options?: { excludeTaskId?: string | null },
): { id: string; name: string } | null {
  const candidates = queryAll<WorkspaceRoleCandidate>(
    `SELECT id, name, status, updated_at
     FROM agents
     WHERE workspace_id = ?
       AND COALESCE(scope, 'workspace') = 'workspace'
       AND lower(role) = lower(?)
       AND status != 'offline'`,
    [workspaceId, role],
  );

  if (candidates.length === 0) {
    return null;
  }

  if (candidates.length === 1) {
    return { id: candidates[0].id, name: candidates[0].name };
  }

  const loadByAgentId = buildRoleCandidateLoadMap(
    workspaceId,
    candidates.map((candidate) => candidate.id),
    options?.excludeTaskId,
  );

  const selected = [...candidates].sort((left, right) => sortCandidatesByLoad(left, right, loadByAgentId))[0];
  return selected ? { id: selected.id, name: selected.name } : null;
}

export function pickDynamicAgent(taskId: string, stageRole?: string | null): { id: string; name: string } | null {
  const task = queryOne<{ workspace_id: string; assigned_agent_id: string | null }>(
    'SELECT workspace_id, assigned_agent_id FROM tasks WHERE id = ?',
    [taskId]
  );
  if (!task) return null;

  if (task.assigned_agent_id) {
    const assigned = queryOne<{ id: string; name: string; status: string }>(
      'SELECT id, name, status FROM agents WHERE id = ? LIMIT 1',
      [task.assigned_agent_id]
    );
    if (assigned && assigned.status !== 'offline') {
      return { id: assigned.id, name: assigned.name };
    }
  }

  if (stageRole) {
    const byRole = pickWorkspaceAgentForRole(task.workspace_id, stageRole, { excludeTaskId: taskId });
    if (byRole) return byRole;
  }

  const fallback = queryOne<{ id: string; name: string }>(
    `SELECT id, name
     FROM agents
     WHERE workspace_id = ?
       AND COALESCE(scope, 'workspace') = 'workspace'
       AND status != 'offline'
     ORDER BY is_master ASC, updated_at DESC
     LIMIT 1`,
    [task.workspace_id]
  );
  if (fallback) return fallback;

  return null;
}
