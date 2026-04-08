import { execFile } from 'child_process';
import { promisify } from 'util';
import { homedir } from 'os';
import { join } from 'path';
import { queryAll } from '@/lib/db';
import type {
  OpenClawBackgroundTask,
  OpenClawBackgroundTasksResponse,
  OpenClawBackgroundTasksSourceChannel,
} from '@/lib/types';

const execFileAsync = promisify(execFile);
const OPENCLAW_CLI_PATH = process.env.OPENCLAW_CLI_PATH || join(homedir(), '.openclaw', 'bin', 'openclaw');
const DEFAULT_OPENCLAW_TASKS_LIST_TIMEOUT_MS = 30000;
const OPENCLAW_TASKS_LIST_TIMEOUT_MS = resolveOpenClawTasksListTimeoutMs();
const SESSION_KEY_FIELDS = [
  'sessionKey',
  'session_key',
  'childSessionKey',
  'child_session_key',
  'requesterSessionKey',
  'requester_session_key',
  'ownerKey',
  'owner_key',
] as const;

type TaskLedgerAdapterStatus = 'ok' | 'degraded_timeout_or_empty';

interface TaskLedgerPayload {
  tasks?: unknown[];
  [key: string]: unknown;
}

interface TaskLedgerParseResult {
  payload: TaskLedgerPayload;
  status: TaskLedgerAdapterStatus;
  sourceChannel: OpenClawBackgroundTasksSourceChannel;
  warning: string | null;
}

interface TaskLedgerCommandOutput {
  stdout: string;
  stderr: string;
  error?: unknown;
}

interface SessionCorrelationRow {
  id: string;
  openclaw_session_id: string;
  status: string;
  task_id: string | null;
  agent_id: string | null;
  agent_name: string | null;
}

type OpenClawExecRunner = (
  file: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv;
    maxBuffer: number;
    timeout: number;
  },
) => Promise<{ stdout: string; stderr: string }>;

let execRunnerForTests: OpenClawExecRunner | null = null;

export function setOpenClawBackgroundTaskExecRunnerForTests(runner: OpenClawExecRunner | null): void {
  execRunnerForTests = runner;
}

function pickString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

export function normalizeOpenClawBackgroundTask(
  raw: unknown,
  correlatedSession: OpenClawBackgroundTask['correlatedSession'],
): OpenClawBackgroundTask | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;

  const sessionKey = pickString(record, [...SESSION_KEY_FIELDS]);
  const runId = pickString(record, ['runId', 'run_id']);
  const taskId = pickString(record, ['taskId', 'task_id']);
  const id = pickString(record, ['id', 'taskId', 'task_id', 'runId', 'run_id', 'sessionKey', 'session_key']);

  if (!id) {
    return null;
  }

  return {
    id,
    taskId,
    runId,
    sourceId: pickString(record, ['sourceId', 'source_id']),
    sessionKey,
    requesterSessionKey: pickString(record, ['requesterSessionKey', 'requester_session_key']),
    ownerKey: pickString(record, ['ownerKey', 'owner_key']),
    childSessionKey: pickString(record, ['childSessionKey', 'child_session_key']),
    scopeKind: pickString(record, ['scopeKind', 'scope_kind']),
    runtimeKind: pickString(record, ['runtimeKind', 'runtime', 'kind']),
    status: pickString(record, ['status']),
    deliveryStatus: pickString(record, ['deliveryStatus', 'delivery_status']),
    notifyPolicy: pickString(record, ['notifyPolicy', 'notify_policy']),
    progressSummary: pickString(record, ['progressSummary', 'progress_summary']),
    createdAt: pickString(record, ['createdAt', 'created_at']),
    startedAt: pickString(record, ['startedAt', 'started_at']),
    updatedAt: pickString(record, ['updatedAt', 'updated_at']),
    endedAt: pickString(record, ['endedAt', 'ended_at']),
    correlatedSession,
  };
}

export async function listOpenClawBackgroundTasks(taskId?: string): Promise<OpenClawBackgroundTasksResponse> {
  const commandResult = await runOpenClawTasksList();
  const parsed = parseTaskLedgerPayload(commandResult);

  if (parsed.status !== 'ok') {
    console.warn('[OpenClaw] task ledger degraded:', {
      status: parsed.status,
      sourceChannel: parsed.sourceChannel,
      warning: parsed.warning,
      error: commandResult.error instanceof Error ? commandResult.error.message : commandResult.error,
    });
  }

  const rawTasks = Array.isArray(parsed.payload.tasks) ? parsed.payload.tasks : [];
  const sessionRows = queryAll<SessionCorrelationRow>(
    `SELECT os.id, os.openclaw_session_id, os.status, os.task_id, os.agent_id, a.name as agent_name
     FROM openclaw_sessions os
     LEFT JOIN agents a ON a.id = os.agent_id`,
  );

  const sessionByOpenClawId = new Map(
    sessionRows.map((row) => [
      row.openclaw_session_id,
      {
        id: row.id,
        taskId: row.task_id,
        openclawSessionId: row.openclaw_session_id,
        status: row.status,
        agentId: row.agent_id,
        agentName: row.agent_name,
      },
    ]),
  );

  const tasks = rawTasks
    .map((raw) => {
      const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
      const sessionKey = record ? pickString(record, [...SESSION_KEY_FIELDS]) : null;
      const normalized = normalizeOpenClawBackgroundTask(raw, sessionKey ? (sessionByOpenClawId.get(sessionKey) || null) : null);
      if (!normalized) return null;
      if (taskId && normalized.correlatedSession?.taskId && normalized.correlatedSession.taskId !== taskId) {
        return null;
      }
      if (taskId && normalized.taskId && normalized.taskId !== taskId) {
        return null;
      }
      return normalized;
    })
    .filter((task): task is OpenClawBackgroundTask => task !== null);

  return {
    tasks,
    status: parsed.status === 'ok' ? 'ok' : 'degraded',
    sourceChannel: parsed.sourceChannel,
    warning: parsed.warning,
  };
}

function resolveOpenClawTasksListTimeoutMs(): number {
  const raw = process.env.OPENCLAW_TASKS_LIST_TIMEOUT_MS;
  if (!raw) {
    return DEFAULT_OPENCLAW_TASKS_LIST_TIMEOUT_MS;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1000) {
    return DEFAULT_OPENCLAW_TASKS_LIST_TIMEOUT_MS;
  }

  return parsed;
}

async function runOpenClawTasksList(): Promise<TaskLedgerCommandOutput> {
  const runner = execRunnerForTests ?? execFileAsync;

  try {
    const result = await runner(OPENCLAW_CLI_PATH, ['tasks', 'list', '--json'], {
      env: process.env,
      maxBuffer: 1024 * 1024 * 4,
      timeout: OPENCLAW_TASKS_LIST_TIMEOUT_MS,
    });
    return {
      stdout: toText(result.stdout),
      stderr: toText(result.stderr),
    };
  } catch (error) {
    return {
      stdout: readExecOutput(error, 'stdout'),
      stderr: readExecOutput(error, 'stderr'),
      error,
    };
  }
}

export function parseTaskLedgerPayload(result: TaskLedgerCommandOutput): TaskLedgerParseResult {
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();

  const exactStdout = tryParseTaskLedgerPayload(stdout);
  if (exactStdout) {
    return {
      payload: exactStdout,
      status: 'ok',
      sourceChannel: 'stdout',
      warning: null,
    };
  }

  const exactStderr = tryParseTaskLedgerPayload(stderr);
  if (exactStderr) {
    return {
      payload: exactStderr,
      status: 'ok',
      sourceChannel: 'stderr',
      warning: null,
    };
  }

  const fallbackCandidates: Array<{ text: string; origin: 'stdout' | 'stderr' | 'combined' }> = [
    { text: stdout, origin: 'stdout' },
    { text: stderr, origin: 'stderr' },
    { text: [stdout, stderr].filter(Boolean).join('\n'), origin: 'combined' },
  ];

  for (const candidate of fallbackCandidates) {
    const recovered = tryParseTaskLedgerPayload(extractLastJsonObject(candidate.text));
    if (!recovered) continue;

    return {
      payload: recovered,
      status: 'ok',
      sourceChannel: 'fallback',
      warning: null,
    };
  }

  return {
    payload: { tasks: [] },
    status: 'degraded_timeout_or_empty',
    sourceChannel: 'none',
    warning: buildEmptyLedgerWarning(result.error),
  };
}

function tryParseTaskLedgerPayload(input: string | null): TaskLedgerPayload | null {
  if (!input || input.trim().length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(input) as unknown;
    return isTaskLedgerPayload(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isTaskLedgerPayload(value: unknown): value is TaskLedgerPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const tasks = (value as TaskLedgerPayload).tasks;
  return tasks === undefined || Array.isArray(tasks);
}

function buildEmptyLedgerWarning(error: unknown): string {
  if (isExecTimeoutError(error)) {
    return `OpenClaw task ledger timed out after ${OPENCLAW_TASKS_LIST_TIMEOUT_MS / 1000}s with no JSON payload.`;
  }

  return 'OpenClaw task ledger returned no JSON payload.';
}

function isExecTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const record = error as Record<string, unknown>;
  if (record.killed === true) {
    return true;
  }

  return typeof record.message === 'string' && record.message.toLowerCase().includes('timed out');
}

function readExecOutput(error: unknown, key: 'stdout' | 'stderr'): string {
  if (!error || typeof error !== 'object') {
    return '';
  }

  const value = (error as Record<string, unknown>)[key];
  return toText(value);
}

function extractLastJsonObject(input: string): string | null {
  if (!input) {
    return null;
  }

  let lastObject: string | null = null;
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === '\\') {
        escaping = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }

    if (char === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        lastObject = input.slice(start, index + 1);
        start = -1;
      }
    }
  }

  return lastObject;
}

function toText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString('utf8');
  }
  return '';
}
