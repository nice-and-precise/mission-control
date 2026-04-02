import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILDER_SESSION_KEY_PREFIX,
  DEFAULT_SESSION_KEY_PREFIX,
  buildAgentSessionKey,
  buildPersistentAgentSessionId,
  getAgentSessionKeyPrefix,
} from './routing';

test('builder defaults to coder lane when no explicit session_key_prefix is set', () => {
  assert.equal(
    getAgentSessionKeyPrefix({ role: 'builder' }),
    BUILDER_SESSION_KEY_PREFIX,
  );
  assert.equal(
    buildAgentSessionKey('mission-control-builder-agent', { role: 'builder' }),
    'agent:coder:mission-control-builder-agent',
  );
});

test('explicit session_key_prefix wins over inferred routing', () => {
  assert.equal(
    getAgentSessionKeyPrefix({ role: 'builder', session_key_prefix: 'agent:worker:' }),
    'agent:worker:',
  );
});

test('non-builder roles keep the main lane fallback', () => {
  assert.equal(
    getAgentSessionKeyPrefix({ role: 'tester' }),
    DEFAULT_SESSION_KEY_PREFIX,
  );
});

test('persistent session ids are agent-specific even when display names collide', () => {
  const first = buildPersistentAgentSessionId({
    id: '45f65650-8df9-4280-93af-42b599e7f4ae',
    name: 'Reviewer Agent',
  });
  const second = buildPersistentAgentSessionId({
    id: '58ace9f0-871e-48ea-8dce-fdce76ba2f20',
    name: 'Reviewer Agent',
  });

  assert.equal(first, 'mission-control-reviewer-agent-45f65650');
  assert.equal(second, 'mission-control-reviewer-agent-58ace9f0');
  assert.notEqual(first, second);
});
