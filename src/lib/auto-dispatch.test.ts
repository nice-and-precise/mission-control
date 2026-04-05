import assert from 'node:assert/strict';
import test from 'node:test';
import { triggerAutoDispatch } from './auto-dispatch';

test('triggerAutoDispatch reports queued dispatches without treating them as success', async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () => new Response(JSON.stringify({
    success: true,
    queued: true,
    message: 'Task queued for Builder Agent; agent is still busy with another active task.',
    waiting_for_task_id: 'blocking-task',
    waiting_for_task_title: 'Current builder task',
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })) as typeof fetch;

  try {
    const result = await triggerAutoDispatch({
      taskId: 'task-1',
      taskTitle: 'Queued task',
      agentId: 'agent-1',
      agentName: 'Builder Agent',
    });

    assert.equal(result.success, false);
    assert.equal(result.queued, true);
    assert.equal(result.waitingForTaskId, 'blocking-task');
    assert.equal(result.waitingForTaskTitle, 'Current builder task');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('triggerAutoDispatch reports successful dispatches when work actually starts', async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () => new Response(JSON.stringify({
    success: true,
    message: 'Task dispatched to agent',
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })) as typeof fetch;

  try {
    const result = await triggerAutoDispatch({
      taskId: 'task-2',
      taskTitle: 'Started task',
      agentId: 'agent-1',
      agentName: 'Builder Agent',
    });

    assert.equal(result.success, true);
    assert.equal(result.queued, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
