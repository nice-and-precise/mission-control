import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveTaskRunOutcomeFromGatewayHistory,
  setGatewaySessionHistoryResolverForTests,
} from './session-history';

afterEach(() => {
  setGatewaySessionHistoryResolverForTests(null);
});

test('resolveTaskRunOutcomeFromGatewayHistory prefers explicit workflow markers from transcript history', async () => {
  setGatewaySessionHistoryResolverForTests(async () => ({
    items: [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Implementation details' }],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'TASK_COMPLETE: Finished the controlled fixture task' }],
      },
      {
        role: 'assistant',
        errorMessage: 'This older error should be ignored in favor of the marker.',
      },
    ],
  }));

  const outcome = await resolveTaskRunOutcomeFromGatewayHistory({
    sessionKey: 'agent:coder:mission-control-builder-agent',
  });

  assert.deepEqual(outcome, {
    kind: 'signal',
    message: 'TASK_COMPLETE: Finished the controlled fixture task',
  });
});

test('resolveTaskRunOutcomeFromGatewayHistory converts terminal runtime errors into blocker messages', async () => {
  setGatewaySessionHistoryResolverForTests(async () => ({
    items: [
      {
        role: 'assistant',
        errorMessage: 'You have hit your ChatGPT usage limit (team plan). Try again in ~92 min.',
        stopReason: 'error',
      },
    ],
  }));

  const outcome = await resolveTaskRunOutcomeFromGatewayHistory({
    sessionKey: 'agent:coder:mission-control-builder-agent',
  });

  assert.deepEqual(outcome, {
    kind: 'runtime_blocked',
    error: 'You have hit your ChatGPT usage limit (team plan). Try again in ~92 min.',
    message:
      'BLOCKED: OpenClaw runtime failure: You have hit your ChatGPT usage limit (team plan). Try again in ~92 min.',
  });
});

test('resolveTaskRunOutcomeFromGatewayHistory returns none when transcript has no marker or runtime error', async () => {
  setGatewaySessionHistoryResolverForTests(async () => ({
    items: [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'I am still thinking through the task.' }],
      },
    ],
  }));

  const outcome = await resolveTaskRunOutcomeFromGatewayHistory({
    sessionKey: 'agent:coder:mission-control-builder-agent',
  });

  assert.deepEqual(outcome, { kind: 'none' });
});

test('resolveTaskRunOutcomeFromGatewayHistory prefers sessionId before falling back to sessionKey', async () => {
  const attemptedRefs: string[] = [];

  setGatewaySessionHistoryResolverForTests(async (sessionRef) => {
    attemptedRefs.push(sessionRef);

    if (sessionRef === 'ephemeral-session-id') {
      return {
        items: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'VERIFY_PASS: Ready to ship' }],
          },
        ],
      };
    }

    throw new Error(`unexpected fallback to ${sessionRef}`);
  });

  const outcome = await resolveTaskRunOutcomeFromGatewayHistory({
    sessionKey: 'agent:main:mission-control-reviewer-agent-1234',
    sessionId: 'ephemeral-session-id',
  });

  assert.deepEqual(attemptedRefs, ['ephemeral-session-id']);
  assert.deepEqual(outcome, {
    kind: 'signal',
    message: 'VERIFY_PASS: Ready to ship',
  });
});

test('resolveTaskRunOutcomeFromGatewayHistory falls back to sessionKey when the sessionId lookup fails', async () => {
  const attemptedRefs: string[] = [];

  setGatewaySessionHistoryResolverForTests(async (sessionRef) => {
    attemptedRefs.push(sessionRef);

    if (sessionRef === 'agent:main:missing-reviewer-session') {
      return {
        items: [
          {
            role: 'assistant',
            errorMessage: 'provider timeout before emitting a workflow marker',
          },
        ],
      };
    }

    throw new Error(`not found: ${sessionRef}`);
  });

  const outcome = await resolveTaskRunOutcomeFromGatewayHistory({
    sessionKey: 'agent:main:missing-reviewer-session',
    sessionId: 'ephemeral-session-id',
  });

  assert.deepEqual(attemptedRefs, [
    'ephemeral-session-id',
    'agent:main:missing-reviewer-session',
  ]);
  assert.deepEqual(outcome, {
    kind: 'runtime_blocked',
    error: 'provider timeout before emitting a workflow marker',
    message: 'BLOCKED: OpenClaw runtime failure: provider timeout before emitting a workflow marker',
  });
});

test('resolveTaskRunOutcomeFromGatewayHistory filters stable-key history to the current run window', async () => {
  setGatewaySessionHistoryResolverForTests(async () => ({
    items: [
      {
        role: 'assistant',
        errorMessage: 'older provider limit from a previous run',
        timestamp: 1_700_000_000_000,
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'Current verification prompt' }],
        timestamp: 1_700_000_100_000,
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'VERIFY_PASS: Current run succeeded' }],
        timestamp: 1_700_000_120_000,
      },
    ],
  }));

  const outcome = await resolveTaskRunOutcomeFromGatewayHistory({
    sessionKey: 'agent:main:mission-control-reviewer-agent-1234',
    startedAt: new Date(1_700_000_100_000).toISOString(),
    endedAt: new Date(1_700_000_130_000).toISOString(),
  });

  assert.deepEqual(outcome, {
    kind: 'signal',
    message: 'VERIFY_PASS: Current run succeeded',
  });
});
