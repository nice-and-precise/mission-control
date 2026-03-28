import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildChatSendMessage,
  buildTaskDispatchEnvelope,
  shouldStartFreshRun,
} from './session-commands';

test('task dispatch messages start a fresh run', () => {
  assert.equal(shouldStartFreshRun('task_dispatch'), true);
  assert.equal(
    buildChatSendMessage('Build the validator.', 'task_dispatch'),
    '/new\n\nBuild the validator.',
  );
});

test('non-dispatch chat flows do not prepend the fresh-run command', () => {
  assert.equal(shouldStartFreshRun('task_note'), false);
  assert.equal(shouldStartFreshRun('direct_chat'), false);
  assert.equal(shouldStartFreshRun('checkpoint_restore'), false);

  assert.equal(
    buildChatSendMessage('Queued operator note', 'task_note'),
    'Queued operator note',
  );
  assert.equal(
    buildChatSendMessage('Need an update?', 'direct_chat'),
    'Need an update?',
  );
  assert.equal(
    buildChatSendMessage('Restore from checkpoint 2', 'checkpoint_restore'),
    'Restore from checkpoint 2',
  );
});

test('fresh task dispatch keeps the stable session id while resetting the transcript', () => {
  const envelope = buildTaskDispatchEnvelope('mission-control-builder-agent', 'Run the validator task.');

  assert.equal(envelope.openclawSessionId, 'mission-control-builder-agent');
  assert.equal(envelope.message, '/new\n\nRun the validator task.');
});
