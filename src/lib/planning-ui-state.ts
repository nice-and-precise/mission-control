import type { Task } from './types';

export interface PlanningSubmissionReleaseState {
  effectiveQuestion?: { question: string } | null;
  effectiveComplete?: boolean | null;
  taskStatus?: string | null;
  isApproved?: boolean | null;
  dispatchError?: string | null;
  transcriptIssue?: { code: string; message: string } | null;
}

export function shouldReleasePlanningSubmission(
  state: PlanningSubmissionReleaseState,
): boolean {
  return Boolean(
    state.effectiveQuestion ||
      state.effectiveComplete ||
      state.taskStatus === 'pending_dispatch' ||
      (state.taskStatus && state.taskStatus !== 'planning') ||
      state.isApproved ||
      state.dispatchError ||
      state.transcriptIssue,
  );
}

export function resolveEditingTaskById(
  tasks: Task[],
  editingTaskId: string | null,
): Task | null {
  if (!editingTaskId) return null;
  return tasks.find((task) => task.id === editingTaskId) || null;
}
