import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, queryOne, run } from './db';
import { parseAgentSignal, processAgentSignal } from './agent-signals';
import { getOpenClawClient } from './openclaw/client';

afterEach(() => {
  getOpenClawClient().disconnect();
  const cleanupTimer = (globalThis as Record<string, unknown>).__openclaw_cache_cleanup_timer__;
  if (cleanupTimer) {
    clearInterval(cleanupTimer as NodeJS.Timeout);
    delete (globalThis as Record<string, unknown>).__openclaw_cache_cleanup_timer__;
  }
  closeDb();
});

function ensureWorkspace(id: string) {
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at, updated_at)
     VALUES (?, ?, ?, datetime('now'), datetime('now'))`,
    [id, `Workspace ${id}`, id]
  );
}

function seedAgent(args: { id: string; workspaceId: string; name: string; role: string; prefix?: string | null }) {
  run(
    `INSERT INTO agents (id, workspace_id, name, role, status, source, session_key_prefix, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'working', 'local', ?, datetime('now'), datetime('now'))`,
    [args.id, args.workspaceId, args.name, args.role, args.prefix || null]
  );
}

function seedStrictWorkflowTemplate(workspaceId: string): string {
  const templateId = `tpl-${crypto.randomUUID()}`;
  const stages = JSON.stringify([
    { id: 'build', label: 'Build', role: 'builder', status: 'in_progress' },
    { id: 'test', label: 'Test', role: 'tester', status: 'testing' },
    { id: 'review', label: 'Review', role: null, status: 'review' },
    { id: 'verify', label: 'Verify', role: 'reviewer', status: 'verification' },
    { id: 'done', label: 'Done', role: null, status: 'done' },
  ]);
  const failTargets = JSON.stringify({
    testing: 'in_progress',
    review: 'in_progress',
    verification: 'in_progress',
  });

  run(
    `INSERT INTO workflow_templates (id, workspace_id, name, description, stages, fail_targets, is_default, created_at, updated_at)
     VALUES (?, ?, 'Strict', 'Strict workflow', ?, ?, 1, datetime('now'), datetime('now'))`,
    [templateId, workspaceId, stages, failTargets]
  );

  return templateId;
}

function seedTaskRole(taskId: string, role: string, agentId: string) {
  run(
    `INSERT INTO task_roles (id, task_id, role, agent_id, created_at)
     VALUES (?, ?, ?, ?, datetime('now'))`,
    [crypto.randomUUID(), taskId, role, agentId]
  );
}

test('parseAgentSignal recognizes workflow markers', () => {
  assert.deepEqual(parseAgentSignal('TASK_COMPLETE: Built validator endpoint'), {
    kind: 'task_complete',
    summary: 'Built validator endpoint',
  });
  assert.deepEqual(parseAgentSignal('BLOCKED: workspace deadlock | need: clean worktree'), {
    kind: 'blocked',
    summary: 'workspace deadlock | need: clean worktree',
  });
  assert.deepEqual(parseAgentSignal('VERIFY_PASS: Ready to ship'), {
    kind: 'verify_pass',
    summary: 'Ready to ship',
  });
  assert.equal(parseAgentSignal('hello there'), null);
});

test('parseAgentSignal strips final wrappers from failure summaries', () => {
  assert.deepEqual(
    parseAgentSignal('<final>VERIFY_FAIL: Missing repo workspace evidence</final>'),
    {
      kind: 'verify_fail',
      summary: 'Missing repo workspace evidence',
    },
  );
  assert.deepEqual(
    parseAgentSignal('```text\nTEST_FAIL: Missing Monday client coverage\n```'),
    {
      kind: 'test_fail',
      summary: 'Missing Monday client coverage',
    },
  );
});

test('processAgentSignal marks verification-stage verify_pass tasks done and ends the linked session', async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const taskId = crypto.randomUUID();
  const reviewerId = crypto.randomUUID();
  const sessionDbId = crypto.randomUUID();
  const sessionId = `mission-control-reviewer-${crypto.randomUUID()}`;

  ensureWorkspace(workspaceId);
  seedAgent({ id: reviewerId, workspaceId, name: 'Reviewer Agent', role: 'reviewer' });

  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, assigned_agent_id, created_at, updated_at)
     VALUES (?, 'Review task', 'verification', 'normal', ?, 'default', ?, datetime('now'), datetime('now'))`,
    [taskId, workspaceId, reviewerId]
  );
  run(
    `INSERT INTO openclaw_sessions (id, agent_id, openclaw_session_id, channel, status, task_id, created_at, updated_at)
     VALUES (?, ?, ?, 'mission-control', 'active', ?, datetime('now'), datetime('now'))`,
    [sessionDbId, reviewerId, sessionId, taskId]
  );

  const result = await processAgentSignal({
    sessionId,
    message: 'VERIFY_PASS: Review looks good',
  });

  assert.equal(result.handled, true);
  assert.equal(result.signal, 'verify_pass');

  const task = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [taskId]);
  const session = queryOne<{ status: string }>('SELECT status FROM openclaw_sessions WHERE id = ?', [sessionDbId]);
  assert.equal(task?.status, 'done');
  assert.equal(session?.status, 'ended');
});

test('processAgentSignal advances builder completions into testing and reassigns to the tester role', async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const taskId = crypto.randomUUID();
  const builderId = crypto.randomUUID();
  const testerId = crypto.randomUUID();
  const sessionDbId = crypto.randomUUID();
  const sessionId = `mission-control-builder-${crypto.randomUUID()}`;

  ensureWorkspace(workspaceId);
  seedAgent({ id: builderId, workspaceId, name: 'Builder Agent', role: 'builder', prefix: 'agent:coder:' });
  seedAgent({ id: testerId, workspaceId, name: 'Tester Agent', role: 'tester' });

  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, assigned_agent_id, created_at, updated_at)
     VALUES (?, 'Build task', 'in_progress', 'normal', ?, 'default', ?, datetime('now'), datetime('now'))`,
    [taskId, workspaceId, builderId]
  );
  run(
    `INSERT INTO task_roles (id, task_id, role, agent_id, created_at)
     VALUES (?, ?, 'builder', ?, datetime('now'))`,
    [crypto.randomUUID(), taskId, builderId]
  );
  run(
    `INSERT INTO task_roles (id, task_id, role, agent_id, created_at)
     VALUES (?, ?, 'tester', ?, datetime('now'))`,
    [crypto.randomUUID(), taskId, testerId]
  );
  run(
    `INSERT INTO openclaw_sessions (id, agent_id, openclaw_session_id, channel, status, task_id, created_at, updated_at)
     VALUES (?, ?, ?, 'mission-control', 'active', ?, datetime('now'), datetime('now'))`,
    [sessionDbId, builderId, sessionId, taskId]
  );

  const originalFetch = global.fetch;
  global.fetch = async () => new Response('{}', { status: 200 });

  try {
    const result = await processAgentSignal({
      sessionId,
      message: 'TASK_COMPLETE: Implemented the validator',
    });

    assert.equal(result.handled, true);
    assert.equal(result.signal, 'task_complete');

    const task = queryOne<{ status: string; assigned_agent_id: string }>(
      'SELECT status, assigned_agent_id FROM tasks WHERE id = ?',
      [taskId]
    );
    assert.equal(task?.status, 'testing');
    assert.equal(task?.assigned_agent_id, testerId);
  } finally {
    global.fetch = originalFetch;
  }
});

test('processAgentSignal advances strict-workflow TEST_PASS tasks through review queue into verification', async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const taskId = crypto.randomUUID();
  const testerId = crypto.randomUUID();
  const reviewerId = crypto.randomUUID();
  const sessionDbId = crypto.randomUUID();
  const sessionId = `mission-control-tester-${crypto.randomUUID()}`;

  ensureWorkspace(workspaceId);
  const templateId = seedStrictWorkflowTemplate(workspaceId);
  seedAgent({ id: testerId, workspaceId, name: 'Tester Agent', role: 'tester' });
  seedAgent({ id: reviewerId, workspaceId, name: 'Reviewer Agent', role: 'reviewer' });

  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, workflow_template_id, assigned_agent_id, created_at, updated_at)
     VALUES (?, 'Verification task', 'testing', 'normal', ?, 'default', ?, ?, datetime('now'), datetime('now'))`,
    [taskId, workspaceId, templateId, testerId]
  );
  seedTaskRole(taskId, 'tester', testerId);
  seedTaskRole(taskId, 'reviewer', reviewerId);
  run(
    `INSERT INTO openclaw_sessions (id, agent_id, openclaw_session_id, channel, status, task_id, created_at, updated_at)
     VALUES (?, ?, ?, 'mission-control', 'active', ?, datetime('now'), datetime('now'))`,
    [sessionDbId, testerId, sessionId, taskId]
  );

  const originalFetch = global.fetch;
  global.fetch = async () => new Response('{}', { status: 200 });

  try {
    const result = await processAgentSignal({
      sessionId,
      message: 'TEST_PASS: Everything passed',
    });

    assert.equal(result.handled, true);
    assert.equal(result.signal, 'test_pass');

    const task = queryOne<{ status: string; assigned_agent_id: string; planning_dispatch_error: string | null }>(
      'SELECT status, assigned_agent_id, planning_dispatch_error FROM tasks WHERE id = ?',
      [taskId]
    );
    assert.equal(task?.status, 'verification');
    assert.equal(task?.assigned_agent_id, reviewerId);
    assert.equal(task?.planning_dispatch_error, null);
  } finally {
    global.fetch = originalFetch;
  }
});

test('processAgentSignal records explicit builder blockers instead of leaving an unreconciled run', async () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const taskId = crypto.randomUUID();
  const builderId = crypto.randomUUID();
  const sessionDbId = crypto.randomUUID();
  const sessionId = `mission-control-builder-${crypto.randomUUID()}`;

  ensureWorkspace(workspaceId);
  seedAgent({ id: builderId, workspaceId, name: 'Builder Agent', role: 'builder', prefix: 'agent:coder:' });

  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, assigned_agent_id, created_at, updated_at)
     VALUES (?, 'Build task', 'in_progress', 'normal', ?, 'default', ?, datetime('now'), datetime('now'))`,
    [taskId, workspaceId, builderId]
  );
  run(
    `INSERT INTO openclaw_sessions (id, agent_id, openclaw_session_id, channel, status, task_id, created_at, updated_at)
     VALUES (?, ?, ?, 'mission-control', 'active', ?, datetime('now'), datetime('now'))`,
    [sessionDbId, builderId, sessionId, taskId]
  );

  const result = await processAgentSignal({
    sessionId,
    message: 'BLOCKED: workspace deadlock | need: refreshed isolated workspace',
  });

  assert.equal(result.handled, true);
  assert.equal(result.signal, 'blocked');

  const task = queryOne<{ status: string; planning_dispatch_error: string; status_reason: string }>(
    'SELECT status, planning_dispatch_error, status_reason FROM tasks WHERE id = ?',
    [taskId]
  );
  const session = queryOne<{ status: string }>('SELECT status FROM openclaw_sessions WHERE id = ?', [sessionDbId]);
  const agent = queryOne<{ status: string }>('SELECT status FROM agents WHERE id = ?', [builderId]);

  assert.equal(task?.status, 'assigned');
  assert.equal(task?.planning_dispatch_error, 'Blocked: workspace deadlock | need: refreshed isolated workspace');
  assert.equal(task?.status_reason, 'Blocked: workspace deadlock | need: refreshed isolated workspace');
  assert.equal(session?.status, 'ended');
  assert.equal(agent?.status, 'standby');
});
