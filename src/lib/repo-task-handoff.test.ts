import test from 'node:test';
import assert from 'node:assert/strict';
import { queryAll, queryOne, run } from './db';
import {
  buildBuilderRepoInstructions,
  buildRepoArtifactSection,
  buildTesterInstructions,
  buildVerifierInstructions,
  getTaskDispatchDeliverables,
  getRepoTaskSurfacePath,
  isRepoBackedTask,
  PR_DELIVERABLE_DESCRIPTION,
  PR_DELIVERABLE_TITLE,
  supportsPullRequestWorkflow,
  syncTaskPrDeliverable,
  type DispatchDeliverablePreview,
} from './repo-task-handoff';

function ensureWorkspace(id: string) {
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at, updated_at)
     VALUES (?, ?, ?, datetime('now'), datetime('now'))`,
    [id, `Workspace ${id}`, id],
  );
}

function seedTask({
  id,
  workspaceId,
  repoUrl,
  repoBranch = 'main',
  workspacePath,
}: {
  id: string;
  workspaceId: string;
  repoUrl?: string;
  repoBranch?: string;
  workspacePath?: string;
}) {
  ensureWorkspace(workspaceId);
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, repo_url, repo_branch, workspace_path, created_at, updated_at)
     VALUES (?, 'Repo task', 'assigned', 'normal', ?, 'default', ?, ?, ?, datetime('now'), datetime('now'))`,
    [id, workspaceId, repoUrl || null, repoBranch, workspacePath || null],
  );
}

test('repo-backed tasks use workspace path as the primary surface', () => {
  assert.equal(
    getRepoTaskSurfacePath({ workspace_path: '/tmp/worktree' }, '/tmp/output'),
    '/tmp/worktree',
  );
  assert.equal(
    getRepoTaskSurfacePath({ workspace_path: undefined }, '/tmp/output'),
    '/tmp/output',
  );
  assert.equal(isRepoBackedTask({ repo_url: 'https://example.com/repo.git', workspace_path: undefined }), true);
  assert.equal(isRepoBackedTask({ repo_url: undefined, workspace_path: '/tmp/worktree' }), true);
  assert.equal(isRepoBackedTask({ repo_url: undefined, workspace_path: undefined }), false);
});

test('repo-backed tester/reviewer section includes workspace, PR, and deliverables', () => {
  const deliverables: DispatchDeliverablePreview[] = [
    { deliverable_type: 'file', title: 'src/app.ts', path: '/tmp/worktree/src/app.ts' },
    { deliverable_type: 'url', title: PR_DELIVERABLE_TITLE, path: 'https://github.com/example/repo/pull/12' },
  ];

  const section = buildRepoArtifactSection({
    task: {
      id: 'task-1',
      repo_url: 'https://github.com/example/repo',
      repo_branch: 'main',
      pr_url: 'https://github.com/example/repo/pull/12',
      workspace_path: '/tmp/worktree',
    },
    fallbackPath: '/tmp/output',
    deliverables,
  });

  assert.match(section, /\*\*REPO CONTEXT:\*\*/);
  assert.match(section, /\*\*REPO WORKSPACE:\*\* \/tmp\/worktree/);
  assert.match(section, /\*\*PR:\*\* https:\/\/github.com\/example\/repo\/pull\/12/);
  assert.match(section, /The shell tool is stateless: a standalone `cd \/tmp\/worktree` does not persist to later commands/);
  assert.match(section, /cd \/tmp\/worktree && <command>/);
  assert.match(section, /For non-shell file tools such as `read`, `edit`, `ls`, `find`, or `glob`, use absolute paths under `\/tmp\/worktree`/);
  assert.match(section, /Do not call `read` on `services\/\.\.\.`; call it on `\/tmp\/worktree\/services\/\.\.\.`/);
  assert.match(section, /do not invent alternate top-level paths/i);
  assert.match(section, /\[file\] src\/app\.ts/);
  assert.doesNotMatch(section, /\*\*OUTPUT DIRECTORY:\*\*/);
});

test('repo-backed builder instructions require changed files and PR deliverable registration', () => {
  const instructions = buildBuilderRepoInstructions({
    taskId: 'task-1',
    missionControlUrl: 'http://localhost:4000',
    nextStatus: 'testing',
    workspacePath: '/tmp/worktree',
    requirePullRequest: true,
    authInstruction: '**Mission Control callback auth:**\n- `Authorization: Bearer token`\n',
  });

  assert.match(instructions, /This is a repo-backed task/);
  assert.match(instructions, /Register the key changed files as deliverables/);
  assert.match(instructions, /PATCH http:\/\/localhost:4000\/api\/tasks\/task-1/);
  assert.match(instructions, /"pr_url": "<github PR url>", "pr_status": "open"/);
  assert.match(instructions, new RegExp(`"title": "${PR_DELIVERABLE_TITLE}"`));
  assert.match(instructions, /"path": "\/tmp\/worktree\/path\/to\/file"/);
});

test('repo-backed builder instructions do not require a PR for non-GitHub remotes', () => {
  const instructions = buildBuilderRepoInstructions({
    taskId: 'task-1',
    missionControlUrl: 'http://localhost:4000',
    nextStatus: 'testing',
    workspacePath: '/tmp/worktree',
    requirePullRequest: false,
  });

  assert.match(instructions, /does not support GitHub PR creation/i);
  assert.doesNotMatch(instructions, /"pr_url": "<github PR url>", "pr_status": "open"/);
  assert.doesNotMatch(instructions, new RegExp(`"title": "${PR_DELIVERABLE_TITLE}"`));
});

test('tester instructions require explicit callback completion and blocked fallback', () => {
  const instructions = buildTesterInstructions({
    taskId: 'task-1',
    missionControlUrl: 'http://localhost:4000',
    nextStatus: 'review',
    updatedByAgentId: 'agent-1',
    authInstruction: '**Mission Control callback auth:**\n- `Authorization: Bearer token`\n',
    repoBacked: true,
  });

  assert.match(instructions, /IMPORTANT FINAL RESPONSE CONTRACT/);
  assert.match(instructions, /`TEST_PASS: \[summary\]`/);
  assert.match(instructions, /`TEST_FAIL: \[what failed\]`/);
  assert.match(instructions, /`BLOCKED: Mission Control callback failed:/);
  assert.match(instructions, /must complete the Mission Control callback API calls below before ending the run/i);
  assert.match(instructions, /POST http:\/\/localhost:4000\/api\/tasks\/task-1\/fail/);
  assert.match(instructions, /"updated_by_agent_id": "agent-1"/);
  assert.match(instructions, /\*\*FILE ACCESS RULES:\*\*/);
  assert.match(instructions, /Do not call `read` on `services\/\.\.\.`; call it on `\/abs\/path\/services\/\.\.\.`/);
});

test('verifier instructions require explicit callback completion and blocked fallback', () => {
  const instructions = buildVerifierInstructions({
    taskId: 'task-1',
    missionControlUrl: 'http://localhost:4000',
    nextStatus: 'done',
    updatedByAgentId: 'agent-2',
    authInstruction: '**Mission Control callback auth:**\n- `Authorization: Bearer token`\n',
    repoBacked: false,
  });

  assert.match(instructions, /IMPORTANT FINAL RESPONSE CONTRACT/);
  assert.match(instructions, /`VERIFY_PASS: \[summary\]`/);
  assert.match(instructions, /`VERIFY_FAIL: \[what failed\]`/);
  assert.match(instructions, /`BLOCKED: Mission Control callback failed:/);
  assert.match(instructions, /must complete the Mission Control callback API calls below before ending the run/i);
  assert.match(instructions, /POST http:\/\/localhost:4000\/api\/tasks\/task-1\/fail/);
  assert.match(instructions, /"updated_by_agent_id": "agent-2"/);
});

test('verifier instructions require absolute-path file access for repo-backed review', () => {
  const instructions = buildVerifierInstructions({
    taskId: 'task-1',
    missionControlUrl: 'http://localhost:4000',
    nextStatus: 'done',
    updatedByAgentId: 'agent-2',
    repoBacked: true,
  });

  assert.match(instructions, /\*\*FILE ACCESS RULES:\*\*/);
  assert.match(instructions, /use absolute paths under \*\*REPO WORKSPACE\*\*/i);
  assert.match(instructions, /Do not call `read` on `services\/\.\.\.`; call it on `\/abs\/path\/services\/\.\.\.`/);
});

test('supportsPullRequestWorkflow only enables GitHub-backed remotes', () => {
  assert.equal(supportsPullRequestWorkflow('https://github.com/example/repo.git'), true);
  assert.equal(supportsPullRequestWorkflow('git@github.com:example/repo.git'), true);
  assert.equal(supportsPullRequestWorkflow('file:///Users/jordan/Projects/mission-control-smoke-source'), false);
  assert.equal(supportsPullRequestWorkflow('https://gitlab.com/example/repo.git'), false);
});

test('syncTaskPrDeliverable creates and updates one auto-synced PR deliverable', () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const taskId = crypto.randomUUID();
  seedTask({
    id: taskId,
    workspaceId,
    repoUrl: 'https://github.com/example/repo',
    workspacePath: '/tmp/worktree',
  });

  syncTaskPrDeliverable(taskId, 'https://github.com/example/repo/pull/1');
  syncTaskPrDeliverable(taskId, 'https://github.com/example/repo/pull/2');

  const rows = queryAll<{ title: string; path: string; description: string }>(
    `SELECT title, path, description
     FROM task_deliverables
     WHERE task_id = ? AND deliverable_type = 'url'`,
    [taskId],
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.title, PR_DELIVERABLE_TITLE);
  assert.equal(rows[0]?.path, 'https://github.com/example/repo/pull/2');
  assert.equal(rows[0]?.description, PR_DELIVERABLE_DESCRIPTION);
});

test('syncTaskPrDeliverable removes the auto-synced PR deliverable when pr_url is cleared', () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const taskId = crypto.randomUUID();
  seedTask({
    id: taskId,
    workspaceId,
    repoUrl: 'https://github.com/example/repo',
    workspacePath: '/tmp/worktree',
  });

  syncTaskPrDeliverable(taskId, 'https://github.com/example/repo/pull/3');
  syncTaskPrDeliverable(taskId, null);

  const row = queryOne<{ count: number }>(
    `SELECT COUNT(*) as count
     FROM task_deliverables
     WHERE task_id = ? AND deliverable_type = 'url' AND title = ?`,
    [taskId, PR_DELIVERABLE_TITLE],
  );

  assert.equal(Number(row?.count || 0), 0);
});

test('dispatch deliverable preview dedupes duplicate PR rows and preserves file coverage', () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const taskId = crypto.randomUUID();
  seedTask({
    id: taskId,
    workspaceId,
    repoUrl: 'https://github.com/example/repo',
    workspacePath: '/tmp/worktree',
  });

  const deliverables = [
    ['url', PR_DELIVERABLE_TITLE, 'https://github.com/example/repo/pull/9', PR_DELIVERABLE_DESCRIPTION],
    ['url', PR_DELIVERABLE_TITLE, 'https://github.com/example/repo/pull/9', PR_DELIVERABLE_DESCRIPTION],
    ['file', 'services/obituary-intelligence-engine/src/contracts.py', '/tmp/worktree/services/obituary-intelligence-engine/src/contracts.py', null],
    ['file', 'services/obituary-intelligence-engine/tests/test_modules.py', '/tmp/worktree/services/obituary-intelligence-engine/tests/test_modules.py', null],
    ['file', 'services/crm-adapter/src/leadContract.js', '/tmp/worktree/services/crm-adapter/src/leadContract.js', null],
  ] as const;

  deliverables.forEach(([type, title, path, description]) => {
    run(
      `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, path, description, created_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
      [crypto.randomUUID(), taskId, type, title, path, description],
    );
  });

  const preview = getTaskDispatchDeliverables(taskId);
  const prDeliverables = preview.filter((deliverable) => deliverable.deliverable_type === 'url');

  assert.equal(prDeliverables.length, 1);
  assert.ok(preview.some((deliverable) => deliverable.title === 'services/obituary-intelligence-engine/src/contracts.py'));
  assert.ok(preview.some((deliverable) => deliverable.title === 'services/obituary-intelligence-engine/tests/test_modules.py'));
});

test('syncTaskPrDeliverable canonicalizes and dedupes manual PR deliverables', () => {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const taskId = crypto.randomUUID();
  seedTask({
    id: taskId,
    workspaceId,
    repoUrl: 'https://github.com/example/repo',
    workspacePath: '/tmp/worktree',
  });

  run(
    `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, path, description, created_at)
     VALUES (?, ?, 'url', 'Pull Request', 'https://github.com/example/repo/pull/11', NULL, datetime('now'))`,
    [crypto.randomUUID(), taskId],
  );
  run(
    `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, path, description, created_at)
     VALUES (?, ?, 'url', 'Pull Request', 'https://github.com/example/repo/pull/11', ?, datetime('now'))`,
    [crypto.randomUUID(), taskId, PR_DELIVERABLE_DESCRIPTION],
  );

  syncTaskPrDeliverable(taskId, 'https://github.com/example/repo/pull/11');

  const rows = queryAll<{ title: string; path: string; description: string | null }>(
    `SELECT title, path, description
     FROM task_deliverables
     WHERE task_id = ? AND deliverable_type = 'url'`,
    [taskId],
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.title, PR_DELIVERABLE_TITLE);
  assert.equal(rows[0]?.path, 'https://github.com/example/repo/pull/11');
  assert.equal(rows[0]?.description, PR_DELIVERABLE_DESCRIPTION);
});
