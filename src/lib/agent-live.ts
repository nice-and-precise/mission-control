import type { Task, TaskStatus } from './types';

const ACTIVE_AGENT_LIVE_STATUSES = new Set<TaskStatus>([
  'in_progress',
  'convoy_active',
  'testing',
  'verification',
]);

export type AgentLiveStatus =
  | 'connecting'
  | 'streaming'
  | 'no_session'
  | 'session_ended'
  | 'error'
  | 'disconnected';

export type AgentLiveEmptyState = 'waiting' | 'no_session' | 'session_ended' | null;

export function shouldShowAgentLiveTab(
  task?: Pick<Task, 'status' | 'assigned_agent_id' | 'planning_dispatch_error'> | null,
): boolean {
  if (!task) return false;

  return Boolean(
    ACTIVE_AGENT_LIVE_STATUSES.has(task.status) ||
      task.assigned_agent_id ||
      task.planning_dispatch_error,
  );
}

export function getAgentLiveEmptyState(
  status: AgentLiveStatus,
  messageCount: number,
  activeStreamCount: number,
): AgentLiveEmptyState {
  if (messageCount > 0 || activeStreamCount > 0) return null;
  if (status === 'no_session') return 'no_session';
  if (status === 'session_ended') return 'session_ended';
  return 'waiting';
}
