import test from 'node:test';
import assert from 'node:assert/strict';
import { getMissionControlHealth } from './health';

test('getMissionControlHealth returns the current runtime contract', () => {
  let dbChecked = false;

  const result = getMissionControlHealth({
    appVersion: '9.9.9',
    env: {
      OPENCLAW_GATEWAY_URL: 'ws://gateway.example.test',
      MISSION_CONTROL_RUNTIME_BOOT: '1',
    } as NodeJS.ProcessEnv,
    nodeVersion: '24.13.0',
    uptimeSeconds: 321,
    dbCheck: () => {
      dbChecked = true;
    },
  });

  assert.equal(dbChecked, true);
  assert.deepEqual(result, {
    status: 'ok',
    version: '9.9.9',
    uptime_seconds: 321,
    node_version: '24.13.0',
    runtime_boot_enabled: true,
    openclaw_gateway_url: 'ws://gateway.example.test',
    database: {
      connected: true,
    },
  });
});

test('getMissionControlHealth uses stable defaults when optional inputs are omitted', () => {
  const result = getMissionControlHealth({
    env: {} as NodeJS.ProcessEnv,
    nodeVersion: '20.19.0',
    uptimeSeconds: 12,
    dbCheck: () => {},
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.version, '2.4.0');
  assert.equal(result.openclaw_gateway_url, 'ws://127.0.0.1:18789');
  assert.equal(result.runtime_boot_enabled, false);
});
