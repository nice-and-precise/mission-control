import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGatewayEventDedupPayload, OpenClawClient, OPENCLAW_OPERATOR_SCOPES } from './client';

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

  client.call = (async () => ({
    sessions: [
      {
        id: 'session-1',
        key: 'agent:main:session-1',
      },
    ],
  })) as typeof client.call;

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

test('connect requests read, write, and admin operator scopes', async () => {
  const OriginalWebSocket = globalThis.WebSocket;

  class MockWebSocket {
    static instance: MockWebSocket | null = null;
    static OPEN = 1;
    static CONNECTING = 0;
    static CLOSING = 2;
    static CLOSED = 3;

    readyState = MockWebSocket.OPEN;
    onopen: ((event: Event) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    sent: string[] = [];

    constructor(_url: string) {
      MockWebSocket.instance = this;
      queueMicrotask(() => this.onopen?.({} as Event));
    }

    send(payload: string): void {
      this.sent.push(payload);
    }

    close(): void {
      this.readyState = MockWebSocket.CLOSED;
    }
  }

  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

  const client = new OpenClawClient('ws://127.0.0.1:18789', 'test-token');

  try {
    const connectPromise = client.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const ws = MockWebSocket.instance;
    assert.ok(ws);

    ws.onmessage?.({
      data: JSON.stringify({
        type: 'event',
        event: 'connect.challenge',
        payload: { nonce: 'nonce', ts: Date.now() },
      }),
    } as MessageEvent);

    await new Promise((resolve) => setTimeout(resolve, 0));

    const connectRequest = ws.sent
      .map((payload) => JSON.parse(payload))
      .find((frame) => frame.method === 'connect');

    assert.ok(connectRequest);
    assert.deepEqual(connectRequest.params.scopes, OPENCLAW_OPERATOR_SCOPES);

    ws.onmessage?.({
      data: JSON.stringify({
        type: 'res',
        id: connectRequest.id,
        ok: true,
        payload: { type: 'hello-ok', protocol: 3 },
      }),
    } as MessageEvent);

    await connectPromise;
  } finally {
    client.disconnect();
    globalThis.WebSocket = OriginalWebSocket;
  }
});
