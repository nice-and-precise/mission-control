import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAgentApprovalPolicy } from './task-approval';

test('review to done still requires a master agent', () => {
  const denied = evaluateAgentApprovalPolicy({
    existingStatus: 'review',
    nextStatus: 'done',
    updatedByAgentId: 'agent-1',
    assignedAgentId: 'agent-1',
    updatingAgent: {
      id: 'agent-1',
      role: 'reviewer',
      is_master: false,
    },
  });

  assert.equal(denied.allowed, false);
  assert.match(denied.error || '', /master agent/i);

  const allowed = evaluateAgentApprovalPolicy({
    existingStatus: 'review',
    nextStatus: 'done',
    updatedByAgentId: 'agent-2',
    assignedAgentId: 'agent-1',
    updatingAgent: {
      id: 'agent-2',
      role: 'orchestrator',
      is_master: true,
    },
  });

  assert.equal(allowed.allowed, true);
});

test('verification to done allows the assigned reviewer or a master agent', () => {
  const reviewer = evaluateAgentApprovalPolicy({
    existingStatus: 'verification',
    nextStatus: 'done',
    updatedByAgentId: 'reviewer-1',
    assignedAgentId: 'reviewer-1',
    updatingAgent: {
      id: 'reviewer-1',
      role: 'reviewer',
      is_master: false,
    },
  });

  assert.equal(reviewer.allowed, true);

  const master = evaluateAgentApprovalPolicy({
    existingStatus: 'verification',
    nextStatus: 'done',
    updatedByAgentId: 'master-1',
    assignedAgentId: 'reviewer-1',
    updatingAgent: {
      id: 'master-1',
      role: 'orchestrator',
      is_master: true,
    },
  });

  assert.equal(master.allowed, true);
});

test('verification to done rejects unrelated non-master agents', () => {
  const denied = evaluateAgentApprovalPolicy({
    existingStatus: 'verification',
    nextStatus: 'done',
    updatedByAgentId: 'tester-1',
    assignedAgentId: 'reviewer-1',
    updatingAgent: {
      id: 'tester-1',
      role: 'tester',
      is_master: false,
    },
  });

  assert.equal(denied.allowed, false);
  assert.match(denied.error || '', /assigned reviewer or a master agent/i);
});
