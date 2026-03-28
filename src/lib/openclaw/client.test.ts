import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGatewayEventDedupPayload, OpenClawClient } from './client';

test('gateway event dedupe payload includes session identity for chat events', () => {
  const first = buildGatewayEventDedupPayload({
    type: 'event',
    event: 'chat',
    payload: {
      sessionKey: 'agent:main:mission-control-reviewer-agent-45f65650',
      seq: 42,
      __openclaw: { id: 'evt-1', seq: 42 },
      content: [{ type: 'output_text', text: 'VERIFY_FAIL: Missing tests' }],
    },
  });
  const second = buildGatewayEventDedupPayload({
    type: 'event',
    event: 'chat',
    payload: {
      sessionKey: 'agent:main:mission-control-reviewer-agent',
      seq: 42,
      __openclaw: { id: 'evt-2', seq: 42 },
      content: [{ type: 'output_text', text: 'VERIFY_FAIL: Missing tests' }],
    },
  });

  assert.notDeepEqual(first, second);
  assert.equal(first.sessionKey, 'agent:main:mission-control-reviewer-agent-45f65650');
  assert.equal(second.sessionKey, 'agent:main:mission-control-reviewer-agent');
});

test('listSessions normalizes object payloads with a sessions array', async () => {
  const client = new OpenClawClient('ws://127.0.0.1:1');
  const originalCall = client.call.bind(client);

  client.call = async () => ({
    sessions: [
      {
        id: 'session-1',
        key: 'agent:main:session-1',
      },
    ],
  });

  try {
    const sessions = await client.listSessions();
    assert.equal(Array.isArray(sessions), true);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.id, 'session-1');
  } finally {
    client.call = originalCall;
    client.disconnect();
  }
});
