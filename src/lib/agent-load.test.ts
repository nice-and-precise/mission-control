import test from 'node:test';
import assert from 'node:assert/strict';
import type { Agent, Task } from '@/lib/types';
import { buildAgentLoadMap, formatDurationCompact, getTaskQueueWaitMs, isTaskWaitingForAgent } from './agent-load';

function createAgent(overrides: Partial<Agent> = {}): Agent {
  const id = overrides.id || crypto.randomUUID();
  return {
    id,
    name: overrides.name || 'Agent',
    role: overrides.role || 'builder',
    avatar_emoji: overrides.avatar_emoji || '🤖',
    status: overrides.status || 'standby',
    is_master: overrides.is_master || false,
    workspace_id: overrides.workspace_id || 'ws-1',
    source: overrides.source || 'local',
    total_cost_usd: overrides.total_cost_usd || 0,
    total_tokens_used: overrides.total_tokens_used || 0,
    created_at: overrides.created_at || new Date('2026-04-08T00:00:00.000Z').toISOString(),
    updated_at: overrides.updated_at || new Date('2026-04-08T00:00:00.000Z').toISOString(),
    ...overrides,
  };
}

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: overrides.id || crypto.randomUUID(),
    title: overrides.title || 'Task',
    status: overrides.status || 'assigned',
    priority: overrides.priority || 'normal',
    assigned_agent_id: overrides.assigned_agent_id || null,
    created_by_agent_id: overrides.created_by_agent_id || null,
    workspace_id: overrides.workspace_id || 'ws-1',
    business_id: overrides.business_id || 'default',
    created_at: overrides.created_at || new Date('2026-04-08T11:00:00.000Z').toISOString(),
    updated_at: overrides.updated_at || new Date('2026-04-08T11:00:00.000Z').toISOString(),
    ...overrides,
  };
}

test('buildAgentLoadMap marks queued agents hot and accumulates in-flight cost', () => {
  const nowMs = Date.parse('2026-04-08T12:00:00.000Z');
  const hotAgent = createAgent({ id: 'agent-hot', status: 'working', total_cost_usd: 12.5, total_tokens_used: 4200 });
  const warmAgent = createAgent({ id: 'agent-warm', status: 'working' });

  const tasks: Task[] = [
    createTask({
      id: 'wait-1',
      assigned_agent_id: hotAgent.id,
      status: 'assigned',
      status_reason: 'Waiting for Builder Hot to finish "Task A" before starting this task.',
      updated_at: '2026-04-08T11:40:00.000Z',
      actual_cost_usd: 2,
      reserved_cost_usd: 1,
    }),
    createTask({
      id: 'wait-2',
      assigned_agent_id: hotAgent.id,
      status: 'assigned',
      status_reason: 'Waiting for Builder Hot to finish "Task A" before starting this task.',
      updated_at: '2026-04-08T11:52:00.000Z',
      reserved_cost_usd: 0.5,
    }),
    createTask({
      id: 'active-1',
      title: 'Active build',
      assigned_agent_id: hotAgent.id,
      status: 'in_progress',
      updated_at: '2026-04-08T11:58:00.000Z',
      actual_cost_usd: 4,
    }),
    createTask({
      id: 'active-2',
      title: 'Testing pass',
      assigned_agent_id: warmAgent.id,
      status: 'testing',
      updated_at: '2026-04-08T11:55:00.000Z',
      actual_cost_usd: 3,
    }),
  ];

  const load = buildAgentLoadMap([hotAgent, warmAgent], tasks, { nowMs });

  assert.equal(load[hotAgent.id].waitingTaskCount, 2);
  assert.equal(load[hotAgent.id].activeTaskCount, 1);
  assert.equal(load[hotAgent.id].activeTaskTitle, 'Active build');
  assert.equal(load[hotAgent.id].oldestWaitMs, 20 * 60 * 1000);
  assert.equal(load[hotAgent.id].inFlightCostUsd, 7.5);
  assert.equal(load[hotAgent.id].level, 'hot');

  assert.equal(load[warmAgent.id].waitingTaskCount, 0);
  assert.equal(load[warmAgent.id].activeTaskCount, 1);
  assert.equal(load[warmAgent.id].level, 'warm');
});

test('waiting helpers detect queueing and format compact durations', () => {
  const task = createTask({
    status: 'assigned',
    status_reason: 'Waiting for Tester to finish "Regression sweep" before starting this task.',
    updated_at: '2026-04-08T11:45:00.000Z',
  });

  assert.equal(isTaskWaitingForAgent(task), true);
  assert.equal(getTaskQueueWaitMs(task, Date.parse('2026-04-08T12:00:00.000Z')), 15 * 60 * 1000);
  assert.equal(formatDurationCompact(15 * 60 * 1000), '15m');
  assert.equal(formatDurationCompact(61 * 60 * 1000), '1h 1m');
});