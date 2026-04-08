import test from 'node:test';
import assert from 'node:assert/strict';
import { getTierBadgeInfo, normalizeIdeaTags } from './task-ideas';

test('normalizeIdeaTags returns string arrays and drops invalid shapes', () => {
  assert.deepEqual(normalizeIdeaTags('["tier-2","ops"]'), ['tier-2', 'ops']);
  assert.equal(normalizeIdeaTags('{"tier":"tier-2"}'), undefined);
  assert.equal(normalizeIdeaTags('"tier-2"'), undefined);
  assert.equal(normalizeIdeaTags('null'), undefined);
  assert.equal(normalizeIdeaTags('not-json'), undefined);
});

test('getTierBadgeInfo only accepts supported tier tags', () => {
  assert.deepEqual(getTierBadgeInfo(['ops', 'Tier-3']), {
    tier: 3,
    label: 'T3',
    textClass: 'text-orange-400',
    bgClass: 'bg-orange-500/15',
    borderClass: 'border-orange-500/30',
  });
  assert.equal(getTierBadgeInfo(['phase-3']), null);
  assert.equal(getTierBadgeInfo(['tier-9']), null);
  assert.equal(getTierBadgeInfo(undefined), null);
});
