import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb } from '@/lib/db';
import { getDb } from '@/lib/db';
import {
  listOpenClawBackgroundTasks,
  normalizeOpenClawBackgroundTask,
  setOpenClawBackgroundTaskExecRunnerForTests,
} from './background-tasks';

afterEach(() => {
  setOpenClawBackgroundTaskExecRunnerForTests(null);
  closeDb();
});

function stubTaskLedger(output: { stdout?: string; stderr?: string; error?: unknown }): void {
  setOpenClawBackgroundTaskExecRunnerForTests(async () => {
    if (output.error) {
      throw output.error;
    }
    return {
      stdout: output.stdout || '',
      stderr: output.stderr || '',
    };
  });
}

test('listOpenClawBackgroundTasks reads JSON from stdout as ok', async () => {
  stubTaskLedger({
    stdout: JSON.stringify({
      tasks: [
        { id: 'bg-stdout', runtimeKind: 'cli', status: 'running' },
      ],
    }),
  });

  const result = await listOpenClawBackgroundTasks();

  assert.equal(result.status, 'ok');
  assert.equal(result.sourceChannel, 'stdout');
  assert.equal(result.warning, null);
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0]?.id, 'bg-stdout');
});

test('listOpenClawBackgroundTasks accepts stderr JSON as a successful ledger read', async () => {
  stubTaskLedger({
    stderr: JSON.stringify({
      tasks: [
        { id: 'bg-stderr', runtimeKind: 'cli', status: 'running' },
      ],
    }),
  });

  const result = await listOpenClawBackgroundTasks();

  assert.equal(result.status, 'ok');
  assert.equal(result.sourceChannel, 'stderr');
  assert.equal(result.warning, null);
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0]?.id, 'bg-stderr');
});

test('listOpenClawBackgroundTasks returns degraded timeout metadata when the CLI times out empty', async () => {
  stubTaskLedger({
    error: Object.assign(new Error('Command timed out'), {
      killed: true,
      stdout: '',
      stderr: '',
      code: 1,
    }),
  });

  const result = await listOpenClawBackgroundTasks();

  assert.equal(result.status, 'degraded');
  assert.equal(result.sourceChannel, 'none');
  assert.match(result.warning || '', /timed out/i);
  assert.deepEqual(result.tasks, []);
});

test('listOpenClawBackgroundTasks recovers noisy stdout via fallback parsing', async () => {
  stubTaskLedger({
    stdout: [
      '{"ignored":true}',
      JSON.stringify({
        tasks: [
          { id: 'bg-fallback-stdout', runtimeKind: 'cli', status: 'running' },
        ],
      }),
    ].join('\n'),
  });

  const result = await listOpenClawBackgroundTasks();

  assert.equal(result.status, 'ok');
  assert.equal(result.sourceChannel, 'fallback');
  assert.equal(result.warning, null);
  assert.equal(result.tasks[0]?.id, 'bg-fallback-stdout');
});

test('listOpenClawBackgroundTasks recovers noisy stderr payloads without degrading a valid ledger', async () => {
  stubTaskLedger({
    stderr: [
      '[agents/auth-profiles] synced openai-codex credentials from external cli',
      JSON.stringify({
        tasks: [
          { id: 'bg-fallback-stderr', runtimeKind: 'cli', status: 'running' },
        ],
      }),
      'trailing log line',
    ].join('\n'),
  });

  const result = await listOpenClawBackgroundTasks();

  assert.equal(result.status, 'ok');
  assert.equal(result.sourceChannel, 'fallback');
  assert.equal(result.warning, null);
  assert.equal(result.tasks[0]?.id, 'bg-fallback-stderr');
});

test('normalizeOpenClawBackgroundTask preserves 2026.4.x ledger fields and resolves child session keys', () => {
  const task = normalizeOpenClawBackgroundTask(
    {
      taskId: 'bg-ledger-task',
      runtime: 'cli',
      sourceId: 'run-source-1',
      requesterSessionKey: 'agent:worker:main',
      ownerKey: 'agent:worker:main',
      childSessionKey: 'agent:worker:main',
      scopeKind: 'session',
      runId: 'run-1',
      deliveryStatus: 'delivered',
      notifyPolicy: 'done_only',
      progressSummary: 'Completed successfully',
      status: 'succeeded',
    },
    null,
  );

  assert.deepEqual(task, {
    id: 'bg-ledger-task',
    taskId: 'bg-ledger-task',
    runId: 'run-1',
    sourceId: 'run-source-1',
    sessionKey: 'agent:worker:main',
    requesterSessionKey: 'agent:worker:main',
    ownerKey: 'agent:worker:main',
    childSessionKey: 'agent:worker:main',
    scopeKind: 'session',
    runtimeKind: 'cli',
    status: 'succeeded',
    deliveryStatus: 'delivered',
    notifyPolicy: 'done_only',
    progressSummary: 'Completed successfully',
    createdAt: null,
    startedAt: null,
    updatedAt: null,
    endedAt: null,
    correlatedSession: null,
  });
});

test('listOpenClawBackgroundTasks correlates sessions using 2026.4.x child/requester session keys', async () => {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT
    );
    CREATE TABLE IF NOT EXISTS openclaw_sessions (
      id TEXT PRIMARY KEY,
      openclaw_session_id TEXT NOT NULL,
      status TEXT NOT NULL,
      task_id TEXT,
      agent_id TEXT
    );
    DELETE FROM agents;
    DELETE FROM openclaw_sessions;
  `);
  db.prepare('INSERT INTO agents (id, name) VALUES (?, ?)').run('agent-1', 'Scout');
  db.prepare(
    'INSERT INTO openclaw_sessions (id, openclaw_session_id, status, task_id, agent_id) VALUES (?, ?, ?, ?, ?)',
  ).run('session-row-1', 'agent:worker:main', 'running', 'mc-task-1', 'agent-1');

  stubTaskLedger({
    stdout: JSON.stringify({
      tasks: [
        {
          taskId: 'bg-child-session',
          runtime: 'cli',
          childSessionKey: 'agent:worker:main',
          requesterSessionKey: 'agent:worker:main',
          ownerKey: 'agent:worker:main',
          status: 'running',
        },
      ],
    }),
  });

  const result = await listOpenClawBackgroundTasks();

  assert.equal(result.status, 'ok');
  assert.equal(result.tasks.length, 1);
  assert.deepEqual(result.tasks[0]?.correlatedSession, {
    id: 'session-row-1',
    taskId: 'mc-task-1',
    openclawSessionId: 'agent:worker:main',
    status: 'running',
    agentId: 'agent-1',
    agentName: 'Scout',
  });
});
