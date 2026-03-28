import type { Agent, Task } from '@/lib/types';

interface AgentApprovalPolicyInput {
  existingStatus: Task['status'];
  nextStatus?: Task['status'];
  updatedByAgentId?: string;
  assignedAgentId?: string | null;
  updatingAgent?: Pick<Agent, 'id' | 'role' | 'is_master'> | null;
}

interface AgentApprovalPolicyResult {
  allowed: boolean;
  error?: string;
}

export function evaluateAgentApprovalPolicy(
  input: AgentApprovalPolicyInput,
): AgentApprovalPolicyResult {
  if (input.nextStatus !== 'done' || !input.updatedByAgentId) {
    return { allowed: true };
  }

  if (!input.updatingAgent) {
    return {
      allowed: false,
      error: 'Forbidden: approving agent was not found',
    };
  }

  if (input.existingStatus === 'review') {
    return input.updatingAgent.is_master
      ? { allowed: true }
      : { allowed: false, error: 'Forbidden: only the master agent can approve review-stage tasks' };
  }

  if (input.existingStatus === 'verification') {
    if (input.updatingAgent.is_master) {
      return { allowed: true };
    }

    const isAssignedReviewer =
      input.updatingAgent.id === input.assignedAgentId &&
      input.updatingAgent.role === 'reviewer';

    return isAssignedReviewer
      ? { allowed: true }
      : { allowed: false, error: 'Forbidden: only the assigned reviewer or a master agent can approve verification-stage tasks' };
  }

  return { allowed: true };
}
