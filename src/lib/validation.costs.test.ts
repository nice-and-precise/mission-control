import test from 'node:test';
import assert from 'node:assert/strict';
import { CreateProviderBillingSnapshotSchema } from './validation';

test('provider billing snapshot validation rejects impossible months', () => {
  const invalidLow = CreateProviderBillingSnapshotSchema.safeParse({
    workspace_id: 'ws-test',
    provider: 'qwen',
    billing_period: '2026-00',
    imported_total_usd: 1,
  });
  const invalidHigh = CreateProviderBillingSnapshotSchema.safeParse({
    workspace_id: 'ws-test',
    provider: 'qwen',
    billing_period: '2026-13',
    imported_total_usd: 1,
  });
  const valid = CreateProviderBillingSnapshotSchema.safeParse({
    workspace_id: 'ws-test',
    provider: 'qwen',
    billing_period: '2026-12',
    imported_total_usd: 1,
  });

  assert.equal(invalidLow.success, false);
  assert.equal(invalidHigh.success, false);
  assert.equal(valid.success, true);
});
