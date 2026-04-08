import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveEditingTaskById, shouldReleasePlanningSubmission } from './planning-ui-state';
import type { Task } from './types';

function buildTask(overrides: Partial<Task> = {}): Task {
  return {
    id: overrides.id || crypto.randomUUID(),
    title: overrides.title || 'Task',
    status: overrides.status || 'planning',
    priority: overrides.priority || 'normal',
    assigned_agent_id: overrides.assigned_agent_id ?? null,
    created_by_agent_id: overrides.created_by_agent_id ?? null,
    workspace_id: overrides.workspace_id || 'ws-1',
    business_id: overrides.business_id || 'default',
    created_at: overrides.created_at || new Date().toISOString(),
    updated_at: overrides.updated_at || new Date().toISOString(),
    ...overrides,
  };
}

test('resolveEditingTaskById follows the latest task object for an open modal', () => {
  const taskId = crypto.randomUUID();
  const staleTask = buildTask({ id: taskId, status: 'planning' });
  const updatedTask = buildTask({ id: taskId, status: 'verification' });

  const resolved = resolveEditingTaskById([updatedTask], staleTask.id);

  assert.equal(resolved?.id, taskId);
  assert.equal(resolved?.status, 'verification');
});

test('shouldReleasePlanningSubmission clears sticky sending state on non-question progress', () => {
  assert.equal(
    shouldReleasePlanningSubmission({
      taskStatus: 'verification',
    }),
    true,
  );

  assert.equal(
    shouldReleasePlanningSubmission({
      transcriptIssue: {
        code: 'gateway_timeout',
        message: 'Timed out waiting for transcript history.',
      },
    }),
    true,
  );

  assert.equal(
    shouldReleasePlanningSubmission({
      taskStatus: 'planning',
      effectiveQuestion: null,
      effectiveComplete: false,
    }),
    false,
  );
});
