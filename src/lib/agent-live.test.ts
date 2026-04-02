import test from 'node:test';
import assert from 'node:assert/strict';
import { getAgentLiveEmptyState, shouldShowAgentLiveTab } from './agent-live';

test('shouldShowAgentLiveTab keeps the tab visible for blocked assigned tasks', () => {
  assert.equal(
    shouldShowAgentLiveTab({
      status: 'assigned',
      assigned_agent_id: 'builder-agent',
      planning_dispatch_error: 'Run ended without completion callback or workflow handoff (ended session).',
    }),
    true,
  );
});

test('shouldShowAgentLiveTab hides the tab when a task has no agent or runtime evidence', () => {
  assert.equal(
    shouldShowAgentLiveTab({
      status: 'inbox',
      assigned_agent_id: null,
      planning_dispatch_error: null,
    }),
    false,
  );
});

test('getAgentLiveEmptyState distinguishes no-session, ended, and waiting states', () => {
  assert.equal(getAgentLiveEmptyState('no_session', 0, 0), 'no_session');
  assert.equal(getAgentLiveEmptyState('session_ended', 0, 0), 'session_ended');
  assert.equal(getAgentLiveEmptyState('connecting', 0, 0), 'waiting');
  assert.equal(getAgentLiveEmptyState('session_ended', 1, 0), null);
});
