import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureHealthCheckScheduled,
  resetHealthCheckSchedulerForTests,
  setHealthCheckRunnerForTests,
} from './agent-health-scheduler';

afterEach(() => {
  resetHealthCheckSchedulerForTests();
  delete process.env.AGENT_HEALTH_CHECK_INTERVAL_MS;
});

test('ensureHealthCheckScheduled is idempotent and runs one startup cycle', async () => {
  let calls = 0;
  setHealthCheckRunnerForTests(async () => {
    calls += 1;
  });

  ensureHealthCheckScheduled();
  const firstTimer = (globalThis as typeof globalThis & {
    __mcAgentHealthTimer__?: NodeJS.Timeout;
  }).__mcAgentHealthTimer__;

  ensureHealthCheckScheduled();
  const secondTimer = (globalThis as typeof globalThis & {
    __mcAgentHealthTimer__?: NodeJS.Timeout;
  }).__mcAgentHealthTimer__;

  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.ok(firstTimer);
  assert.equal(firstTimer, secondTimer);
  assert.equal(calls, 1);
});

test('ensureHealthCheckScheduled continues running on an interval', async () => {
  process.env.AGENT_HEALTH_CHECK_INTERVAL_MS = '10';

  let calls = 0;
  setHealthCheckRunnerForTests(async () => {
    calls += 1;
  });

  ensureHealthCheckScheduled();

  await new Promise((resolve) => setTimeout(resolve, 35));

  assert.ok(calls >= 2);
});
