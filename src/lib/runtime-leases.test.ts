import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, run } from './db';
import { acquireRuntimeLease, getRuntimeLease, setRuntimeLeaseOwnerForTests } from './runtime-leases';

beforeEach(() => {
  run('DELETE FROM runtime_leases');
});

afterEach(() => {
  setRuntimeLeaseOwnerForTests(null);
  closeDb();
});

test('acquireRuntimeLease only allows one live owner per lease', () => {
  const now = '2026-03-28T16:25:00.000Z';

  setRuntimeLeaseOwnerForTests('owner-a');
  assert.equal(acquireRuntimeLease('agent-health-scheduler', { ttlMs: 60_000, now }), true);

  setRuntimeLeaseOwnerForTests('owner-b');
  assert.equal(
    acquireRuntimeLease('agent-health-scheduler', {
      ttlMs: 60_000,
      now: '2026-03-28T16:25:30.000Z',
    }),
    false,
  );

  const lease = getRuntimeLease('agent-health-scheduler');
  assert.equal(lease?.owner_id, 'owner-a');
});

test('acquireRuntimeLease lets the same owner renew and a new owner take over after expiry', () => {
  setRuntimeLeaseOwnerForTests('owner-a');
  assert.equal(
    acquireRuntimeLease('agent-catalog-sync-scheduler', {
      ttlMs: 1_000,
      now: '2026-03-28T16:25:00.000Z',
    }),
    true,
  );
  assert.equal(
    acquireRuntimeLease('agent-catalog-sync-scheduler', {
      ttlMs: 1_000,
      now: '2026-03-28T16:25:00.500Z',
    }),
    true,
  );

  setRuntimeLeaseOwnerForTests('owner-b');
  assert.equal(
    acquireRuntimeLease('agent-catalog-sync-scheduler', {
      ttlMs: 1_000,
      now: '2026-03-28T16:25:02.000Z',
    }),
    true,
  );

  const lease = getRuntimeLease('agent-catalog-sync-scheduler');
  assert.equal(lease?.owner_id, 'owner-b');
});
