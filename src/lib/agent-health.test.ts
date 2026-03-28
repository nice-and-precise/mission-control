import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { runHealthCheckCycle, setHealthCheckImplementationForTests } from './agent-health';

afterEach(() => {
  setHealthCheckImplementationForTests(null);
});

test('runHealthCheckCycle shares one in-flight execution across concurrent callers', async () => {
  let calls = 0;

  setHealthCheckImplementationForTests(async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 25));
    return [];
  });

  const [first, second] = await Promise.all([runHealthCheckCycle(), runHealthCheckCycle()]);

  assert.equal(calls, 1);
  assert.deepEqual(first, []);
  assert.deepEqual(second, []);
});
