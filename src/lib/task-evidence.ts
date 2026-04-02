import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { broadcast } from '@/lib/events';
import { queryAll, queryOne, run } from '@/lib/db';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { buildAgentSessionKey } from '@/lib/openclaw/routing';
import { inspectGatewayRunWindowFromGatewayHistory } from '@/lib/openclaw/session-history';
import { syncTaskPrDeliverable } from '@/lib/repo-task-handoff';
import type { Agent, OpenClawSession, Task, TaskActivity, TaskDeliverable } from '@/lib/types';

const ACTIVE_GATEWAY_SESSION_STATES = new Set(['active', 'running', 'streaming', 'queued', 'pending', 'working']);
const FAILED_GATEWAY_SESSION_STATES = new Set(['failed', 'error', 'aborted', 'cancelled', 'canceled', 'crashed']);
const COMPLETED_GATEWAY_SESSION_STATES = new Set(['done', 'completed', 'ended', 'closed', 'finished', 'success']);
const HOUSEKEEPING_DELIVERABLES = new Set(['.mc-workspace.json']);
const UNRECONCILED_RUN_ERROR_PREFIX = 'Run ended without completion callback or workflow handoff';
const EXPLICIT_BLOCKER_PREFIX = 'Blocked:';
export const FRESH_PERSISTENT_SESSION_GRACE_MS = 30_000;

interface StoredTaskSession extends OpenClawSession {
  agent_name?: string | null;
  agent_role?: string | null;
  agent_session_key_prefix?: string | null;
}

interface StoredSubagentSessionRow {
  id: string;
  agent_id: string | null;
  openclaw_session_id: string;
  channel?: string | null;
  status: string;
  ended_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface GatewaySessionRecord {
  key: string;
  sessionId: string | null;
  label: string | null;
  status: string;
  channel: string | null;
  parentSessionKey: string | null;
  spawnedBy: string | null;
  childSessions: string[];
  agentKey: string | null;
  createdAt: string | null;
  endedAt: string | null;
  updatedAt: string | null;
  lastActivityAt: string | null;
}

export interface TaskStreamState {
  status: 'no_session' | 'streaming' | 'session_ended';
  activeSessionKeys: string[];
  terminalSessionKeys: string[];
  relevantSessions: GatewaySessionRecord[];
}

export interface TaskEvidenceReconciliation extends TaskStreamState {
  recoveredSubagentCount: number;
  recoveredDeliverableCount: number;
}

let gatewaySessionsResolverForTests: (() => Promise<unknown>) | null = null;

export function setGatewaySessionsResolverForTests(
  resolver: (() => Promise<unknown>) | null,
): void {
  gatewaySessionsResolverForTests = resolver;
}

export function normalizeGatewaySessions(payload: unknown): GatewaySessionRecord[] {
  let rawSessions: unknown[] = [];

  if (Array.isArray(payload)) {
    rawSessions = payload;
  } else if (
    payload &&
    typeof payload === 'object' &&
    Array.isArray((payload as { sessions?: unknown[] }).sessions)
  ) {
    rawSessions = (payload as { sessions: unknown[] }).sessions;
  }

  return rawSessions
    .map((raw) => normalizeGatewaySession(raw))
    .filter((session): session is GatewaySessionRecord => Boolean(session));
}

export function mapGatewaySessionStatus(
  status?: string | null,
  endedAt?: string | null,
): 'active' | 'completed' | 'failed' | 'ended' {
  const normalized = (status || '').trim().toLowerCase();

  if (FAILED_GATEWAY_SESSION_STATES.has(normalized)) return 'failed';
  if (COMPLETED_GATEWAY_SESSION_STATES.has(normalized)) return 'completed';
  if (endedAt) return 'ended';
  if (ACTIVE_GATEWAY_SESSION_STATES.has(normalized)) return 'active';
  return 'ended';
}

export function buildTaskStreamState(
  storedSessions: StoredTaskSession[],
  relevantSessions: GatewaySessionRecord[],
): TaskStreamState {
  if (relevantSessions.length > 0) {
    const activeSessionKeys = relevantSessions
      .filter((session) => mapGatewaySessionStatus(session.status, session.endedAt) === 'active')
      .map((session) => session.key);
    const terminalSessionKeys = relevantSessions
      .filter((session) => mapGatewaySessionStatus(session.status, session.endedAt) !== 'active')
      .map((session) => session.key);

    return {
      status: activeSessionKeys.length > 0 ? 'streaming' : 'session_ended',
      activeSessionKeys,
      terminalSessionKeys,
      relevantSessions,
    };
  }

  const activeSessionKeys = storedSessions
    .filter((session) => session.status === 'active')
    .map((session) => buildStoredSessionKey(session));
  const terminalSessionKeys = storedSessions
    .filter((session) => session.status !== 'active')
    .map((session) => buildStoredSessionKey(session));

  if (activeSessionKeys.length > 0) {
    return {
      status: 'streaming',
      activeSessionKeys,
      terminalSessionKeys,
      relevantSessions: [],
    };
  }

  return {
    status: storedSessions.length > 0 ? 'session_ended' : 'no_session',
    activeSessionKeys: [],
    terminalSessionKeys,
    relevantSessions: [],
  };
}

export async function getTaskStreamState(taskId: string): Promise<TaskStreamState> {
  const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (!task) {
    return {
      status: 'no_session',
      activeSessionKeys: [],
      terminalSessionKeys: [],
      relevantSessions: [],
    };
  }

  const gatewaySessions = await loadGatewaySessions();
  const storedSessions = getStoredTaskSessions(task.id);
  const relevantSessions = collectRelevantGatewaySessions(task.id, storedSessions, gatewaySessions);

  return buildTaskStreamState(storedSessions, relevantSessions);
}

export async function reconcileTaskRuntimeEvidence(taskId: string): Promise<TaskEvidenceReconciliation> {
  const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (!task) {
    return {
      status: 'no_session',
      activeSessionKeys: [],
      terminalSessionKeys: [],
      relevantSessions: [],
      recoveredSubagentCount: 0,
      recoveredDeliverableCount: 0,
    };
  }

  syncTaskPrDeliverable(task.id, task.pr_url ?? null);

  const gatewaySessions = await loadGatewaySessions();
  const storedSessionsBefore = getStoredTaskSessions(task.id);
  const relevantSessions = collectRelevantGatewaySessions(task.id, storedSessionsBefore, gatewaySessions);
  const now = new Date().toISOString();

  await syncActiveStoredTaskSessions(storedSessionsBefore, relevantSessions, now);
  const recoveredSubagents = upsertRecoveredSubagentSessions(task, storedSessionsBefore, relevantSessions, now);
  const recoveredDeliverables = recoverWorkspaceDeliverables(task, now);

  if (recoveredSubagents.inserted > 0 || recoveredDeliverables.inserted > 0) {
    logReconciliationActivity(
      task,
      now,
      recoveredSubagents.inserted,
      recoveredDeliverables.inserted,
    );
  }

  const storedSessionsAfter = getStoredTaskSessions(task.id);
  const streamState = buildTaskStreamState(storedSessionsAfter, relevantSessions);

  return {
    ...streamState,
    recoveredSubagentCount: recoveredSubagents.inserted,
    recoveredDeliverableCount: recoveredDeliverables.inserted,
  };
}

function normalizeGatewaySession(raw: unknown): GatewaySessionRecord | null {
  if (!raw || typeof raw !== 'object') return null;

  const record = raw as Record<string, unknown>;
  const key = firstNonEmptyString(
    record.key,
    record.sessionKey,
    record.id,
    record.openclaw_session_id,
  );

  if (!key) return null;

  return {
    key,
    sessionId: firstNonEmptyString(record.sessionId, record.id),
    label: optionalString(record.label),
    status: optionalString(record.status) || 'unknown',
    channel: optionalString(record.channel),
    parentSessionKey: optionalString(record.parentSessionKey),
    spawnedBy: optionalString(record.spawnedBy),
    childSessions: Array.isArray(record.childSessions)
      ? record.childSessions
          .map((child) => optionalString(child))
          .filter((child): child is string => Boolean(child))
      : [],
    agentKey: optionalString(record.agentKey),
    createdAt: normalizeTimestamp(record.createdAt),
    endedAt: normalizeTimestamp(record.endedAt),
    updatedAt: normalizeTimestamp(record.updatedAt),
    lastActivityAt: normalizeTimestamp(record.lastActivityAt),
  };
}

async function loadGatewaySessions(): Promise<GatewaySessionRecord[]> {
  try {
    if (gatewaySessionsResolverForTests) {
      return normalizeGatewaySessions(await gatewaySessionsResolverForTests());
    }

    const client = getOpenClawClient();
    if (!client.isConnected()) {
      await client.connect();
    }

    const payload = await client.call<unknown>('sessions.list');
    return normalizeGatewaySessions(payload);
  } catch (error) {
    console.warn('[TaskEvidence] Failed to load gateway sessions:', error);
    return [];
  }
}

function getStoredTaskSessions(taskId: string): StoredTaskSession[] {
  return queryAll<StoredTaskSession>(
    `SELECT
       os.*,
       a.name AS agent_name,
       a.role AS agent_role,
       a.session_key_prefix AS agent_session_key_prefix
     FROM openclaw_sessions os
     LEFT JOIN agents a ON a.id = os.agent_id
     WHERE os.task_id = ?
     ORDER BY os.updated_at DESC, os.created_at DESC`,
    [taskId],
  );
}

function collectRelevantGatewaySessions(
  taskId: string,
  storedSessions: StoredTaskSession[],
  gatewaySessions: GatewaySessionRecord[],
): GatewaySessionRecord[] {
  if (gatewaySessions.length === 0) return [];

  const taskToken = taskId.split('-')[0]?.toLowerCase();
  const storedSessionKeys = new Set(
    storedSessions.map((session) => buildStoredSessionKey(session)),
  );
  const relevantKeys = new Set<string>();

  for (const session of gatewaySessions) {
    if (
      storedSessionKeys.has(session.key) ||
      (taskToken && session.label?.toLowerCase().includes(taskToken))
    ) {
      relevantKeys.add(session.key);
    }
  }

  if (relevantKeys.size === 0) {
    return [];
  }

  let changed = true;
  while (changed) {
    changed = false;

    for (const session of gatewaySessions) {
      if (relevantKeys.has(session.key)) continue;

      const isChildOfRelevant =
        (session.parentSessionKey && relevantKeys.has(session.parentSessionKey)) ||
        (session.spawnedBy && relevantKeys.has(session.spawnedBy));
      const isListedByRelevant = gatewaySessions.some(
        (candidate) =>
          relevantKeys.has(candidate.key) &&
          candidate.childSessions.includes(session.key),
      );
      const listsRelevantChild = session.childSessions.some((child) => relevantKeys.has(child));
      const matchesTaskIdentity =
        storedSessionKeys.has(session.key) ||
        (taskToken && session.label?.toLowerCase().includes(taskToken));

      if ((isChildOfRelevant || isListedByRelevant || listsRelevantChild) && matchesTaskIdentity) {
        relevantKeys.add(session.key);
        changed = true;
      }
    }
  }

  return gatewaySessions.filter((session) => relevantKeys.has(session.key));
}

async function syncActiveStoredTaskSessions(
  storedSessions: StoredTaskSession[],
  relevantSessions: GatewaySessionRecord[],
  now: string,
): Promise<{ updated: number }> {
  if (relevantSessions.length === 0) {
    return { updated: 0 };
  }

  const gatewaySessionsByKey = new Map(
    relevantSessions.map((session) => [session.key, session] as const),
  );
  let updated = 0;

  for (const session of storedSessions) {
    if (session.session_type === 'subagent' || session.status !== 'active') {
      continue;
    }

    const gatewaySession = gatewaySessionsByKey.get(buildStoredSessionKey(session));
    if (!gatewaySession) {
      continue;
    }

    const mappedStatus = mapGatewaySessionStatus(gatewaySession.status, gatewaySession.endedAt);
    const endedAt = mappedStatus === 'active'
      ? null
      : gatewaySession.endedAt || gatewaySession.updatedAt || gatewaySession.lastActivityAt || now;
    const nextChannel = gatewaySession.channel || session.channel || null;

    // Persistent agents reuse the same session key across `/new` runs. During a fresh dispatch,
    // the gateway can briefly report the previous run's terminal metadata for that reused key.
    // Keep the new DB session active for a short grace window so health checks do not strand the
    // task before the new run's live state arrives.
    if (
      mappedStatus !== 'active' &&
      await shouldKeepFreshPersistentSessionActive(session, gatewaySession, now)
    ) {
      gatewaySession.status = 'running';
      gatewaySession.endedAt = null;
      continue;
    }

    if (
      mappedStatus === session.status &&
      nextChannel === (session.channel || null) &&
      (endedAt || null) === (session.ended_at || null)
    ) {
      continue;
    }

    run(
      `UPDATE openclaw_sessions
       SET channel = ?, status = ?, ended_at = ?, updated_at = ?
       WHERE id = ?`,
      [nextChannel, mappedStatus, endedAt || null, now, session.id],
    );

    session.channel = nextChannel || undefined;
    session.status = mappedStatus;
    session.ended_at = endedAt || undefined;
    session.updated_at = now;
    updated++;
  }

  return { updated };
}

function upsertRecoveredSubagentSessions(
  task: Task,
  storedSessions: StoredTaskSession[],
  relevantSessions: GatewaySessionRecord[],
  now: string,
): { inserted: number } {
  if (relevantSessions.length === 0) {
    return { inserted: 0 };
  }

  const rootSessionKeys = new Set(
    storedSessions
      .filter((session) => session.session_type !== 'subagent')
      .map((session) => buildStoredSessionKey(session)),
  );
  const existingSubagentSessions = new Map<string, StoredSubagentSessionRow>(
    queryAll<StoredSubagentSessionRow>(
      `SELECT * FROM openclaw_sessions WHERE task_id = ? AND session_type = 'subagent'`,
      [task.id],
    ).map((session) => [session.openclaw_session_id, session]),
  );
  const taskScopedAgents = queryAll<Agent>(
    `SELECT * FROM agents WHERE task_id = ? AND scope = 'task' ORDER BY created_at ASC`,
    [task.id],
  );

  let inserted = 0;

  for (const session of relevantSessions) {
    const isRootSession = rootSessionKeys.has(session.key);
    if (isRootSession) continue;

    const mappedStatus = mapGatewaySessionStatus(session.status, session.endedAt);
    const existingSession = existingSubagentSessions.get(session.key);
    const agentId =
      resolveRecoveredSessionAgent(task, taskScopedAgents, session, mappedStatus, now) ||
      existingSession?.agent_id ||
      null;
    const createdAt = existingSession?.created_at || session.createdAt || session.updatedAt || now;
    const endedAt = mappedStatus === 'active'
      ? null
      : existingSession?.ended_at || session.endedAt || session.updatedAt || session.lastActivityAt || now;

    if (!existingSession) {
      const newSession = {
        id: uuidv4(),
        agent_id: agentId,
        openclaw_session_id: session.key,
        channel: session.channel || undefined,
        status: mappedStatus,
        session_type: 'subagent',
        task_id: task.id,
        ended_at: endedAt || undefined,
        created_at: createdAt,
        updated_at: now,
      };

      run(
        `INSERT INTO openclaw_sessions
          (id, agent_id, openclaw_session_id, channel, status, session_type, task_id, ended_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'subagent', ?, ?, ?, ?)`,
        [
          newSession.id,
          newSession.agent_id,
          newSession.openclaw_session_id,
          newSession.channel || null,
          newSession.status,
          task.id,
          newSession.ended_at || null,
          newSession.created_at,
          newSession.updated_at,
        ],
      );

      existingSubagentSessions.set(session.key, newSession);
      inserted++;
      broadcast({
        type: 'agent_spawned',
        payload: {
          taskId: task.id,
          sessionId: session.key,
          agentName: queryOne<{ name: string }>('SELECT name FROM agents WHERE id = ?', [agentId])?.name,
        },
      });
      continue;
    }

    run(
      `UPDATE openclaw_sessions
       SET agent_id = ?, channel = ?, status = ?, ended_at = ?, updated_at = ?
       WHERE id = ?`,
      [
        agentId,
        session.channel || existingSession.channel || null,
        mappedStatus,
        endedAt || null,
        now,
        existingSession.id,
      ],
    );
  }

  return { inserted };
}

function recoverWorkspaceDeliverables(task: Task, now: string): { inserted: number } {
  const deliverableCount = queryOne<{ count: number }>(
    'SELECT COUNT(*) AS count FROM task_deliverables WHERE task_id = ?',
    [task.id],
  )?.count || 0;

  if (deliverableCount > 0 || !task.workspace_path || !existsSync(task.workspace_path)) {
    return { inserted: 0 };
  }

  const changedFiles = getWorkspaceChangedFiles(task.workspace_path);
  if (changedFiles.length === 0) {
    return { inserted: 0 };
  }

  const existingPaths = new Set(
    queryAll<{ path: string | null }>(
      'SELECT path FROM task_deliverables WHERE task_id = ? AND path IS NOT NULL',
      [task.id],
    )
      .map((row) => row.path)
      .filter((value): value is string => Boolean(value)),
  );

  let inserted = 0;

  for (const relativePath of changedFiles) {
    const absolutePath = path.resolve(task.workspace_path, relativePath);
    if (existingPaths.has(absolutePath)) continue;

    const deliverable: TaskDeliverable = {
      id: uuidv4(),
      task_id: task.id,
      deliverable_type: 'file',
      title: relativePath,
      path: absolutePath,
      description: 'Recovered from isolated workspace changes because the agent run did not POST explicit deliverables.',
      created_at: now,
    };

    run(
      `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, path, description, created_at)
       VALUES (?, ?, 'file', ?, ?, ?, ?)`,
      [
        deliverable.id,
        deliverable.task_id,
        deliverable.title,
        deliverable.path || null,
        deliverable.description || null,
        deliverable.created_at,
      ],
    );

    existingPaths.add(absolutePath);
    inserted++;
    broadcast({
      type: 'deliverable_added',
      payload: deliverable,
    });
  }

  return { inserted };
}

function getWorkspaceChangedFiles(workspacePath: string): string[] {
  try {
    execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: workspacePath,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
  } catch {
    return [];
  }

  const trackedChanges = [
    readGitPathList(workspacePath, ['diff', '--name-only', '--relative', 'HEAD']),
    readGitPathList(workspacePath, ['diff', '--cached', '--name-only', '--relative']),
    readGitPathList(workspacePath, ['ls-files', '--others', '--exclude-standard']),
  ].flat();

  return Array.from(
    new Set(
      trackedChanges.filter((relativePath) => isRecoverableWorkspacePath(relativePath)),
    ),
  ).sort((left, right) => left.localeCompare(right));
}

function readGitPathList(workspacePath: string, args: string[]): string[] {
  try {
    const output = execFileSync('git', args, {
      cwd: workspacePath,
      encoding: 'utf-8',
      stdio: 'pipe',
    });

    return output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function isRecoverableWorkspacePath(relativePath: string): boolean {
  if (!relativePath) return false;
  if (relativePath.startsWith('.git/')) return false;
  if (HOUSEKEEPING_DELIVERABLES.has(relativePath)) return false;
  return !relativePath.endsWith('/.mc-workspace.json');
}

function resolveRecoveredSessionAgent(
  task: Task,
  taskScopedAgents: Agent[],
  session: GatewaySessionRecord,
  mappedStatus: 'active' | 'completed' | 'failed' | 'ended',
  now: string,
): string | null {
  const displayName = deriveRecoveredAgentName(session);
  if (!displayName) return null;

  const normalizedDisplayName = normalizeComparableName(displayName);
  const existingAgent = taskScopedAgents.find(
    (agent) => normalizeComparableName(agent.name) === normalizedDisplayName,
  );

  if (existingAgent) {
    run(
      'UPDATE agents SET status = ?, updated_at = ? WHERE id = ?',
      [mappedStatus === 'active' ? 'working' : 'standby', now, existingAgent.id],
    );
    return existingAgent.id;
  }

  const createdAgentId = uuidv4();
  const description = session.label
    ? `Recovered from OpenClaw runtime evidence (${session.label}).`
    : 'Recovered from OpenClaw runtime evidence.';
  const agentStatus = mappedStatus === 'active' ? 'working' : 'standby';

  run(
    `INSERT INTO agents
      (id, name, role, description, avatar_emoji, status, is_master, workspace_id, source, scope, task_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'local', 'task', ?, ?, ?)`,
    [
      createdAgentId,
      displayName,
      'Sub-Agent',
      description,
      '🤖',
      agentStatus,
      task.workspace_id,
      task.id,
      now,
      now,
    ],
  );

  const storedAgent = queryOne<Agent>('SELECT * FROM agents WHERE id = ?', [createdAgentId]);
  if (storedAgent) {
    taskScopedAgents.push(storedAgent);
  }

  return createdAgentId;
}

function deriveRecoveredAgentName(session: GatewaySessionRecord): string | null {
  const seed = (session.label || session.agentKey || session.key.split(':').pop() || '').trim();
  if (!seed) return null;

  const baseName = seed.replace(/-task-[a-f0-9]+$/i, '');
  const tokens = baseName.split(/[^a-z0-9]+/i).filter(Boolean);
  if (tokens.length === 0) return null;

  const displayName = tokens
    .map((token) => {
      if (token.length <= 3) return token.toUpperCase();
      return `${token[0]!.toUpperCase()}${token.slice(1)}`;
    })
    .join('');

  return displayName.endsWith('Agent') ? displayName : `${displayName}Agent`;
}

function logReconciliationActivity(
  task: Task,
  now: string,
  recoveredSubagentCount: number,
  recoveredDeliverableCount: number,
): void {
  const details: string[] = [];

  if (recoveredSubagentCount > 0) {
    details.push(`${recoveredSubagentCount} recovered session${recoveredSubagentCount === 1 ? '' : 's'}`);
  }
  if (recoveredDeliverableCount > 0) {
    details.push(`${recoveredDeliverableCount} recovered deliverable${recoveredDeliverableCount === 1 ? '' : 's'}`);
  }
  if (details.length === 0) return;

  const message = `Recovered runtime evidence from OpenClaw/workspace: ${details.join(', ')}.`;
  const existing = queryOne<{ id: string }>(
    'SELECT id FROM task_activities WHERE task_id = ? AND message = ? LIMIT 1',
    [task.id, message],
  );

  if (existing) return;

  const activity: TaskActivity = {
    id: uuidv4(),
    task_id: task.id,
    agent_id: task.assigned_agent_id || undefined,
    activity_type: 'updated',
    message,
    created_at: now,
  };

  run(
    `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, created_at)
     VALUES (?, ?, ?, 'updated', ?, ?)`,
    [activity.id, activity.task_id, activity.agent_id || null, activity.message, activity.created_at],
  );

  broadcast({
    type: 'activity_logged',
    payload: activity,
  });
}

function buildStoredSessionKey(session: StoredTaskSession): string {
  const storedSessionId = session.openclaw_session_id;
  if (storedSessionId.startsWith('agent:')) {
    return storedSessionId;
  }

  return buildAgentSessionKey(storedSessionId, {
    role: session.agent_role || undefined,
    session_key_prefix: session.agent_session_key_prefix || undefined,
  });
}

async function shouldKeepFreshPersistentSessionActive(
  session: StoredTaskSession,
  gatewaySession: GatewaySessionRecord,
  now: string,
): Promise<boolean> {
  if (session.session_type === 'subagent' || session.status !== 'active') {
    return false;
  }

  const localTouchedAtMs = timestampToMs(session.updated_at || session.created_at);
  if (localTouchedAtMs === null) {
    return false;
  }

  const nowMs = timestampToMs(now);
  if (nowMs === null) {
    return false;
  }
  const withinFreshGrace = nowMs - localTouchedAtMs <= FRESH_PERSISTENT_SESSION_GRACE_MS;

  const gatewayEndedAtMs = timestampToMs(gatewaySession.endedAt);
  if (gatewayEndedAtMs !== null && gatewayEndedAtMs <= localTouchedAtMs) {
    return true;
  }
  if (gatewayEndedAtMs !== null && gatewayEndedAtMs > localTouchedAtMs) {
    return false;
  }

  const gatewayCreatedAtMs = timestampToMs(gatewaySession.createdAt);
  if (
    withinFreshGrace &&
    gatewayEndedAtMs === null &&
    (gatewayCreatedAtMs === null || gatewayCreatedAtMs <= localTouchedAtMs)
  ) {
    return true;
  }

  try {
    const inspection = await inspectGatewayRunWindowFromGatewayHistory({
      sessionKey: buildStoredSessionKey(session),
      sessionId: gatewaySession.sessionId || null,
      startedAt: session.updated_at || session.created_at,
      limit: 40,
    });
    return inspection.hasActivity && inspection.outcome.kind === 'none';
  } catch {
    return false;
  }
}

function normalizeComparableName(value: string): string {
  return value.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function timestampToMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const numericValue = Number(value);
    if (Number.isFinite(numericValue) && /^\d+$/.test(value.trim())) {
      return new Date(numericValue).toISOString();
    }

    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  return null;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }

  return null;
}

export function shouldSuppressHealthEvidenceActivity(
  task: Task | null | undefined,
  streamState?: Pick<TaskStreamState, 'status'> | null,
): boolean {
  if (!task?.id) return false;
  const planningError = task.planning_dispatch_error?.trim();
  if (!planningError) {
    return false;
  }

  if (
    !planningError.startsWith(UNRECONCILED_RUN_ERROR_PREFIX) &&
    !planningError.startsWith(EXPLICIT_BLOCKER_PREFIX)
  ) {
    return false;
  }

  if (streamState) {
    return streamState.status !== 'streaming';
  }

  const activeTaskSession = queryOne<{ count: number }>(
    `SELECT COUNT(*) AS count
     FROM openclaw_sessions
     WHERE task_id = ? AND status = 'active'`,
    [task.id],
  )?.count || 0;

  return activeTaskSession === 0;
}
