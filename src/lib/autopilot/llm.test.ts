import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { setGatewaySessionHistoryResolverForTests } from '@/lib/openclaw/session-history';

const originalFetch = globalThis.fetch;
const originalGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
const originalAutopilotModel = process.env.AUTOPILOT_MODEL;
const originalCompletionMode = process.env.OPENCLAW_AUTOPILOT_COMPLETION_MODE;

afterEach(() => {
  globalThis.fetch = originalFetch;

  if (originalGatewayToken === undefined) {
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
  } else {
    process.env.OPENCLAW_GATEWAY_TOKEN = originalGatewayToken;
  }

  if (originalAutopilotModel === undefined) {
    delete process.env.AUTOPILOT_MODEL;
  } else {
    process.env.AUTOPILOT_MODEL = originalAutopilotModel;
  }

  if (originalCompletionMode === undefined) {
    delete process.env.OPENCLAW_AUTOPILOT_COMPLETION_MODE;
  } else {
    process.env.OPENCLAW_AUTOPILOT_COMPLETION_MODE = originalCompletionMode;
  }

  setGatewaySessionHistoryResolverForTests(null);

  const client = getOpenClawClient() as unknown as {
    isConnected?: () => boolean;
    connect?: () => Promise<void>;
    patchSessionModel?: (sessionKey: string, model: string) => Promise<unknown>;
    getSessionByKey?: (sessionKey: string) => Promise<unknown>;
    call?: (method: string, params?: unknown) => Promise<unknown>;
  };
  delete client.isConnected;
  delete client.connect;
  delete client.patchSessionModel;
  delete client.getSessionByKey;
  delete client.call;
  getOpenClawClient().disconnect();
});

test('gateway HTTP completions send the required OpenClaw scopes header', async () => {
  process.env.OPENCLAW_GATEWAY_TOKEN = 'test-token';
  process.env.AUTOPILOT_MODEL = 'openclaw';
  process.env.OPENCLAW_AUTOPILOT_COMPLETION_MODE = 'http';

  let capturedInit: RequestInit | undefined;

  globalThis.fetch = async (_input, init) => {
    capturedInit = init;
    return new Response(JSON.stringify({
      model: 'openclaw',
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const mod = await import(`./llm?test-http-headers=${Date.now()}`);
  const result = await mod.complete('hello');

  assert.equal(result.content, 'ok');
  assert.equal(result.transport, 'http');
  assert.equal(result.requestedModel, 'openclaw');
  assert.equal(result.resolvedModel, 'openclaw');
  assert.equal(result.finishReason, 'stop');
  assert.deepEqual(capturedInit?.headers, {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer test-token',
    'x-openclaw-scopes': 'operator.read,operator.write',
  });

  const body = JSON.parse(String(capturedInit?.body));
  assert.equal(body.model, 'openclaw');
});

test('gateway HTTP completions route provider model overrides through x-openclaw-model', async () => {
  process.env.OPENCLAW_GATEWAY_TOKEN = 'test-token';
  process.env.OPENCLAW_AUTOPILOT_COMPLETION_MODE = 'http';

  let capturedInit: RequestInit | undefined;

  globalThis.fetch = async (_input, init) => {
    capturedInit = init;
    return new Response(JSON.stringify({
      model: 'openclaw',
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const mod = await import(`./llm?test-http-provider=${Date.now()}`);
  const result = await mod.complete('hello', { model: 'openai-codex/gpt-5.4' });

  assert.equal(result.transport, 'http');
  assert.equal(result.requestedModel, 'openai-codex/gpt-5.4');
  assert.equal(result.resolvedModel, 'openai-codex/gpt-5.4');
  assert.deepEqual(capturedInit?.headers, {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer test-token',
    'x-openclaw-scopes': 'operator.read,operator.write',
    'x-openclaw-model': 'openai-codex/gpt-5.4',
  });

  const body = JSON.parse(String(capturedInit?.body));
  assert.equal(body.model, 'openclaw');
});

test('provider model requests bypass agent-cli and select session transport', async () => {
  process.env.OPENCLAW_AUTOPILOT_COMPLETION_MODE = 'agent-cli';
  process.env.AUTOPILOT_MODEL = 'openclaw';

  const client = getOpenClawClient() as unknown as {
    isConnected: () => boolean;
    connect: () => Promise<void>;
    patchSessionModel: (sessionKey: string, model: string) => Promise<unknown>;
    getSessionByKey: (sessionKey: string) => Promise<unknown>;
    call: (method: string, params?: unknown) => Promise<unknown>;
  };

  let patchedSession: { sessionKey: string; model: string } | null = null;
  let sentSessionKey: string | null = null;

  client.isConnected = () => true;
  client.connect = async () => undefined;
  client.patchSessionModel = async (sessionKey: string, model: string) => {
    patchedSession = { sessionKey, model };
    return { key: sessionKey, resolved: { modelProvider: 'qwen', model: 'qwen3.6-plus' } };
  };
  client.getSessionByKey = async (sessionKey: string) => ({
    key: sessionKey,
    status: 'completed',
    modelProvider: 'qwen',
    model: 'qwen3.6-plus',
    inputTokens: 10,
    outputTokens: 20,
    totalTokens: 30,
  });
  client.call = async (method: string, params?: unknown) => {
    if (method === 'chat.send') {
      sentSessionKey = (params as { sessionKey?: string }).sessionKey || null;
    }
    return {};
  };

  setGatewaySessionHistoryResolverForTests(async (sessionKey) => ({
    sessionKey,
    items: [{
      role: 'assistant',
      content: 'session result',
      stopReason: 'stop',
      timestamp: Date.now() + 1_000,
    }],
  }));

  const mod = await import(`./llm?test-session-transport=${Date.now()}`);
  const result = await mod.complete('hello', { model: 'qwen/qwen3.6-plus' });

  assert.equal(result.transport, 'session');
  assert.equal(result.requestedModel, 'qwen/qwen3.6-plus');
  assert.equal(result.resolvedModel, 'qwen/qwen3.6-plus');
  assert.equal(result.finishReason, 'stop');
  assert.equal(patchedSession?.model, 'qwen/qwen3.6-plus');
  assert.equal(sentSessionKey, patchedSession?.sessionKey || null);
});

test('extractStructuredJSON handles direct, fenced, and embedded JSON', async () => {
  const mod = await import(`./llm?test-extract-json=${Date.now()}`);

  assert.deepEqual(mod.extractStructuredJSON('{"ok":true}'), { ok: true });
  assert.deepEqual(mod.extractStructuredJSON('```json\n{"ok":true}\n```'), { ok: true });
  assert.deepEqual(mod.extractStructuredJSON('Prefix\n{"ok":true}\nSuffix'), { ok: true });
});

test('extractStructuredJSON recovers array from code-fenced truncated JSON', async () => {
  const mod = await import(`./llm?test-truncated-array=${Date.now()}`);

  // Simulates Qwen: code fence wrapper + truncated array (last element incomplete)
  const fencedTruncated = '```json\n[{"title":"Idea 1","score":9},{"title":"Idea 2","score":8},{"title":"Idea 3","sc';
  const result = mod.extractStructuredJSON(fencedTruncated) as unknown[];
  assert.ok(Array.isArray(result), 'should recover an array');
  assert.equal(result.length, 2, 'should recover 2 complete elements, dropping the truncated 3rd');
  assert.deepEqual(result[0], { title: 'Idea 1', score: 9 });
  assert.deepEqual(result[1], { title: 'Idea 2', score: 8 });
});

test('extractStructuredJSON prefers full array over first object in code-fenced JSON', async () => {
  const mod = await import(`./llm?test-fenced-array=${Date.now()}`);

  // Complete array inside code fences — should return the array, not just the first object
  const fencedArray = '```json\n[{"a":1},{"a":2},{"a":3}]\n```';
  const result = mod.extractStructuredJSON(fencedArray) as unknown[];
  assert.ok(Array.isArray(result), 'should return array');
  assert.equal(result.length, 3);
});

test('completeJSON retries once with stricter JSON settings when the first response is invalid', async () => {
  process.env.OPENCLAW_GATEWAY_TOKEN = 'test-token';
  process.env.OPENCLAW_AUTOPILOT_COMPLETION_MODE = 'http';
  process.env.AUTOPILOT_MODEL = 'openclaw';

  const requestBodies: Array<Record<string, unknown>> = [];
  let callCount = 0;

  globalThis.fetch = async (_input, init) => {
    callCount += 1;
    requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);

    const content = callCount === 1
      ? '{"sections":{"codebase":{"findings":["unterminated"'
      : '{"sections":{"codebase":{"findings":["recovered"]}}}';

    return new Response(JSON.stringify({
      model: 'openclaw',
      choices: [{ message: { content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const mod = await import(`./llm?test-json-retry=${Date.now()}`);
  const result = await mod.completeJSON<{ sections: { codebase: { findings: string[] } } }>('hello', {
    model: 'openclaw',
    systemPrompt: 'Return JSON only.',
  });

  assert.equal(callCount, 2);
  assert.deepEqual(result.data.sections.codebase.findings, ['recovered']);
  assert.equal(result.transport, 'http');
  assert.equal((requestBodies[1].temperature as number) || 0, 0);
  assert.match(String((requestBodies[1].messages as Array<{ role: string; content: string }>)[0]?.content || ''), /Return exactly one valid JSON object or array/i);
});

test('completeJSON failure text includes transport and model diagnostics', async () => {
  process.env.OPENCLAW_GATEWAY_TOKEN = 'test-token';
  process.env.OPENCLAW_AUTOPILOT_COMPLETION_MODE = 'http';
  process.env.AUTOPILOT_MODEL = 'openclaw';

  globalThis.fetch = async () => new Response(JSON.stringify({
    model: 'openclaw',
    choices: [{ message: { content: '{"sections":{"codebase":{"findings":["broken"' }, finish_reason: 'length' }],
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

  const mod = await import(`./llm?test-json-failure=${Date.now()}`);

  await assert.rejects(
    () => mod.completeJSON('hello', { model: 'openclaw' }),
    /after retry .*transport=http.*requested=openclaw.*resolved=openclaw.*finish_reason=length/i,
  );
});
