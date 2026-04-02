import test from 'node:test';
import assert from 'node:assert/strict';
import { queryAll, queryOne, run } from './db';
import { buildPlanningSpecMarkdown, cleanupTaskScopedAgents } from './planning-agents';

function ensureWorkspace(id: string) {
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at, updated_at)
     VALUES (?, ?, ?, datetime('now'), datetime('now'))`,
    [id, `Workspace ${id}`, id]
  );
}

test('cleanupTaskScopedAgents removes task-scoped planner agents and related rows', () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const taskId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  ensureWorkspace(workspaceId);

  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, created_at, updated_at)
     VALUES (?, 'Cleanup Task', 'planning', 'normal', ?, 'default', datetime('now'), datetime('now'))`,
    [taskId, workspaceId]
  );
  run(
    `INSERT INTO agents (id, workspace_id, name, role, status, source, scope, task_id, created_at, updated_at)
     VALUES (?, ?, 'Task Planner', 'builder', 'standby', 'local', 'task', ?, datetime('now'), datetime('now'))`,
    [agentId, workspaceId, taskId]
  );
  run(
    `INSERT INTO task_roles (id, task_id, role, agent_id, created_at)
     VALUES (lower(hex(randomblob(16))), ?, 'builder', ?, datetime('now'))`,
    [taskId, agentId]
  );
  run(
    `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, created_at)
     VALUES (lower(hex(randomblob(16))), ?, ?, 'status_changed', 'planner activity', datetime('now'))`,
    [taskId, agentId]
  );

  cleanupTaskScopedAgents(taskId);

  const remainingAgents = queryAll<{ id: string }>(
    `SELECT id FROM agents WHERE task_id = ? AND COALESCE(scope, 'workspace') = 'task'`,
    [taskId]
  );
  const remainingRoles = queryAll<{ id: string }>('SELECT id FROM task_roles WHERE task_id = ?', [taskId]);
  assert.equal(remainingAgents.length, 0);
  assert.equal(remainingRoles.length, 0);
});

test('buildPlanningSpecMarkdown includes planner-suggested agents section', () => {
  const markdown = buildPlanningSpecMarkdown(
    {
      title: 'Validator',
      description: 'Validate Monday config before running scans',
    },
    {
      title: 'Validator',
      summary: 'Check readiness and mappings before launch',
      deliverables: ['validator endpoint'],
      success_criteria: ['operators see actionable errors'],
      constraints: {},
    },
    [
      {
        name: 'CRMAgent',
        role: 'builder',
        avatar_emoji: '🔌',
      },
    ]
  );

  assert.match(markdown, /## Planner-Suggested Task Agents/);
  assert.match(markdown, /CRMAgent/);
  assert.match(markdown, /Validate Monday config before running scans/);
});
