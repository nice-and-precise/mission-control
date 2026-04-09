import type { Agent, Task, TaskStatus } from '@/lib/types';

const ACTIVE_TASK_STATUSES = new Set<TaskStatus>(['in_progress', 'convoy_active', 'testing', 'verification']);
const WAITING_REASON_PREFIX = 'Waiting for ';
const HOT_WAIT_THRESHOLD_MS = 15 * 60 * 1000;

export type AgentLoadLevel = 'clear' | 'warm' | 'hot';

export interface AgentLoadMetrics {
  agentId: string;
  activeTaskCount: number;
  waitingTaskCount: number;
  activeTaskId: string | null;
  activeTaskTitle: string | null;
  waitingTaskIds: string[];
  oldestWaitMs: number;
  totalQueuedWaitMs: number;
  inFlightCostUsd: number;
  level: AgentLoadLevel;
}

interface BuildAgentLoadMapOptions {
  nowMs?: number;
}

export function isTaskWaitingForAgent(task: Pick<Task, 'status' | 'status_reason'>): boolean {
  return task.status === 'assigned' && (task.status_reason || '').startsWith(WAITING_REASON_PREFIX);
}

export function getTaskQueueWaitMs(
  task: Pick<Task, 'status' | 'status_reason' | 'created_at' | 'updated_at'>,
  nowMs = Date.now(),
): number {
  if (!isTaskWaitingForAgent(task)) {
    return 0;
  }

  const updatedAtMs = Date.parse(task.updated_at || '');
  const createdAtMs = Date.parse(task.created_at || '');
  const baselineMs = Number.isFinite(updatedAtMs)
    ? updatedAtMs
    : Number.isFinite(createdAtMs)
      ? createdAtMs
      : nowMs;

  return Math.max(0, nowMs - baselineMs);
}

export function buildAgentLoadMap(
  agents: Agent[],
  tasks: Task[],
  options: BuildAgentLoadMapOptions = {},
): Record<string, AgentLoadMetrics> {
  const nowMs = options.nowMs ?? Date.now();
  const metrics: Record<string, AgentLoadMetrics> = {};

  for (const agent of agents) {
    metrics[agent.id] = {
      agentId: agent.id,
      activeTaskCount: 0,
      waitingTaskCount: 0,
      activeTaskId: null,
      activeTaskTitle: null,
      waitingTaskIds: [],
      oldestWaitMs: 0,
      totalQueuedWaitMs: 0,
      inFlightCostUsd: 0,
      level: 'clear',
    };
  }

  for (const task of tasks) {
    if (!task.assigned_agent_id) {
      continue;
    }

    const taskCost = (task.actual_cost_usd || 0) + (task.reserved_cost_usd || 0);
    const metric = metrics[task.assigned_agent_id] || {
      agentId: task.assigned_agent_id,
      activeTaskCount: 0,
      waitingTaskCount: 0,
      activeTaskId: null,
      activeTaskTitle: null,
      waitingTaskIds: [],
      oldestWaitMs: 0,
      totalQueuedWaitMs: 0,
      inFlightCostUsd: 0,
      level: 'clear' as AgentLoadLevel,
    };

    if (task.status !== 'done') {
      metric.inFlightCostUsd += taskCost;
    }

    if (ACTIVE_TASK_STATUSES.has(task.status)) {
      metric.activeTaskCount += 1;
      if (!metric.activeTaskId) {
        metric.activeTaskId = task.id;
        metric.activeTaskTitle = task.title;
      }
    }

    if (isTaskWaitingForAgent(task)) {
      const waitMs = getTaskQueueWaitMs(task, nowMs);
      metric.waitingTaskCount += 1;
      metric.waitingTaskIds.push(task.id);
      metric.totalQueuedWaitMs += waitMs;
      metric.oldestWaitMs = Math.max(metric.oldestWaitMs, waitMs);
    }

    metrics[task.assigned_agent_id] = metric;
  }

  for (const agent of agents) {
    const metric = metrics[agent.id];
    if (!metric) {
      continue;
    }

    metric.level = resolveAgentLoadLevel(metric, agent.status);
  }

  return metrics;
}

export function resolveAgentLoadLevel(
  metric: Pick<AgentLoadMetrics, 'waitingTaskCount' | 'oldestWaitMs' | 'activeTaskCount'>,
  agentStatus?: Agent['status'],
): AgentLoadLevel {
  if (agentStatus === 'offline' && (metric.waitingTaskCount > 0 || metric.activeTaskCount > 0)) {
    return 'hot';
  }

  if (metric.waitingTaskCount >= 2 || metric.oldestWaitMs >= HOT_WAIT_THRESHOLD_MS) {
    return 'hot';
  }

  if (metric.waitingTaskCount >= 1 || metric.activeTaskCount >= 1) {
    return 'warm';
  }

  return 'clear';
}

export function formatDurationCompact(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return '0m';
  }

  const totalMinutes = Math.floor(durationMs / 60000);
  if (totalMinutes < 1) {
    return '<1m';
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours === 0) {
    return `${totalMinutes}m`;
  }

  if (minutes === 0) {
    return `${hours}h`;
  }

  return `${hours}h ${minutes}m`;
}

export function formatUsdCompact(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: value >= 100 ? 0 : 2,
    maximumFractionDigits: value >= 100 ? 0 : 2,
  }).format(value || 0);
}

export function formatTokenCount(value: number): string {
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value || 0);
}