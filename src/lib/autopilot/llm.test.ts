import test from 'node:test';
import assert from 'node:assert/strict';

test('gateway HTTP completions send the required OpenClaw scopes header', async () => {
  process.env.OPENCLAW_GATEWAY_TOKEN = 'test-token';

  const originalFetch = globalThis.fetch;
  let capturedInit: RequestInit | undefined;

  globalThis.fetch = async (_input, init) => {
    capturedInit = init;
    return new Response(JSON.stringify({
      model: 'openclaw',
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const mod = await import(`./llm?test=${Date.now()}`);
    const result = await mod.complete('hello');

    assert.equal(result.content, 'ok');
    assert.deepEqual(capturedInit?.headers, {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer test-token',
      'x-openclaw-scopes': 'operator.read,operator.write',
    });
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
  }
});

test('gateway HTTP completions route provider model overrides through x-openclaw-model', async () => {
  process.env.OPENCLAW_GATEWAY_TOKEN = 'test-token';

  const originalFetch = globalThis.fetch;
  let capturedInit: RequestInit | undefined;

  globalThis.fetch = async (_input, init) => {
    capturedInit = init;
    return new Response(JSON.stringify({
      model: 'openclaw',
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const mod = await import(`./llm?test-override=${Date.now()}`);
    await mod.complete('hello', { model: 'anthropic/claude-sonnet-4-6' });

    assert.deepEqual(capturedInit?.headers, {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer test-token',
      'x-openclaw-scopes': 'operator.read,operator.write',
      'x-openclaw-model': 'anthropic/claude-sonnet-4-6',
    });

    const body = JSON.parse(String(capturedInit?.body));
    assert.equal(body.model, 'openclaw');
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
  }
});
