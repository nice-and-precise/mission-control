import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  getOversizedHistoryOmissionMessage,
  hasOversizedHistoryOmission,
  loadGatewaySessionHistory,
  normalizeGatewaySessionHistoryPayload,
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

test('normalizeGatewaySessionHistoryPayload resolves key and id fields into Mission Control contract', () => {
  const payload = normalizeGatewaySessionHistoryPayload('agent:main:session-123', {
    sessionId: 'runtime-session-id',
    sessionKey: 'agent:main:session-123',
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'hello' }],
      },
    ],
    hasMore: true,
    nextCursor: 'cursor-2',
  });

  assert.deepEqual(payload, {
    sessionRef: 'agent:main:session-123',
    resolvedSessionKey: 'agent:main:session-123',
    resolvedSessionId: 'runtime-session-id',
    items: [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'hello' }],
      },
    ],
    hasMore: true,
    nextCursor: 'cursor-2',
    source: 'chat.history',
  });
});

test('loadGatewaySessionHistory strips tool events unless includeTools is explicitly enabled', async () => {
  setGatewaySessionHistoryResolverForTests(async () => ({
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'working' },
          { type: 'toolCall', id: 'read:1', name: 'read', arguments: { path: '/tmp/example' } },
          { type: 'text', text: 'done' },
        ],
      },
      {
        role: 'toolResult',
        content: [{ type: 'text', text: 'tool output' }],
      },
    ],
  }));

  const withoutTools = await loadGatewaySessionHistory('agent:main:session-123');
  assert.deepEqual(withoutTools.items, [
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'working' },
        { type: 'text', text: 'done' },
      ],
    },
  ]);

  const withTools = await loadGatewaySessionHistory('agent:main:session-123', 100, {
    includeTools: true,
  });
  assert.equal(withTools.items.length, 2);
});

test('oversized history omission helpers detect the documented placeholder', () => {
  const items = [
    {
      role: 'assistant',
      content: [{ type: 'text', text: '[chat.history omitted: message too large]' }],
    },
  ];

  assert.equal(hasOversizedHistoryOmission(items), true);
  assert.match(getOversizedHistoryOmissionMessage(), /oversized/i);
});

test('loadGatewaySessionHistory honors timeoutMs for resolver-backed history loads', async () => {
  setGatewaySessionHistoryResolverForTests(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { items: [] };
  });

  await assert.rejects(
    () => loadGatewaySessionHistory('agent:main:session-123', 100, { timeoutMs: 10 }),
    /Request timeout: chat\.history:agent:main:session-123/,
  );
});
