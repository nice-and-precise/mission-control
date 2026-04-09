import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb } from '@/lib/db';
import {
  listOpenClawBackgroundTasks,
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

test('listOpenClawBackgroundTasks treats stderr JSON as successful with a warning', async () => {
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
  assert.match(result.warning || '', /stderr/i);
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

test('listOpenClawBackgroundTasks recovers noisy stderr payloads via fallback parsing', async () => {
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
  assert.match(result.warning || '', /stderr/i);
  assert.equal(result.tasks[0]?.id, 'bg-fallback-stderr');
});
