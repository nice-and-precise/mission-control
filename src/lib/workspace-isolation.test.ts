import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, queryAll, queryOne, run } from './db';
import { getOpenClawClient } from './openclaw/client';
import {
  assertWorkspaceRootSupported,
  buildTaskFeatureBranch,
  createTaskWorkspace,
  findFileProviderManagedAncestor,
  shouldForceFreshWorkspace,
} from './workspace-isolation';
import type { Task } from './types';

const tempRoots = new Set<string>();
const originalProjectsPath = process.env.PROJECTS_PATH;

afterEach(() => {
  process.env.PROJECTS_PATH = originalProjectsPath;

  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  tempRoots.clear();

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
    [id, `Workspace ${id}`, id],
  );
}

function initOriginRepo(repoDir: string): void {
  mkdirSync(repoDir, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Mission Control Tests'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'mission-control-tests@example.com'], { cwd: repoDir, stdio: 'pipe' });

  mkdirSync(path.join(repoDir, 'services/crm-adapter/src'), { recursive: true });
  writeFileSync(path.join(repoDir, 'services/crm-adapter/src/app.js'), 'module.exports = { ok: true };\n');
  execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: repoDir, stdio: 'pipe' });
}

test('createTaskWorkspace forceFresh recreates a legacy workspace clone and releases stale active ports', async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'mission-control-workspace-isolation-'));
  tempRoots.add(tempRoot);

  const projectsPath = path.join(tempRoot, 'projects');
  process.env.PROJECTS_PATH = projectsPath;
  mkdirSync(projectsPath, { recursive: true });

  const originRepo = path.join(tempRoot, 'origin-repo');
  initOriginRepo(originRepo);

  const workspaceId = `ws-${crypto.randomUUID()}`;
  const taskId = crypto.randomUUID();
  const title = 'Refresh Workspace';
  const projectDir = path.join(projectsPath, 'refresh-workspace');
  const workspaceDir = path.join(projectDir, '.workspaces', `task-${taskId}`);

  mkdirSync(path.dirname(workspaceDir), { recursive: true });
  execFileSync('git', ['clone', originRepo, workspaceDir], { stdio: 'pipe' });
  writeFileSync(
    path.join(workspaceDir, '.mc-workspace.json'),
    JSON.stringify({ taskId, strategy: 'worktree' }, null, 2),
  );

  ensureWorkspace(workspaceId);
  run(
    `INSERT INTO tasks
      (id, title, status, priority, workspace_id, business_id, repo_url, repo_branch, workspace_path, workspace_strategy, workspace_port, created_at, updated_at)
     VALUES (?, ?, 'assigned', 'normal', ?, 'default', ?, 'main', ?, 'worktree', 4200, datetime('now'), datetime('now'))`,
    [taskId, title, workspaceId, originRepo, workspaceDir],
  );
  run(
    `INSERT INTO workspace_ports (id, task_id, port, product_id, status, created_at)
     VALUES (?, ?, 4200, NULL, 'active', datetime('now'))`,
    [crypto.randomUUID(), taskId],
  );
  run(
    `INSERT INTO workspace_ports (id, task_id, port, product_id, status, created_at)
     VALUES (?, ?, 4201, NULL, 'active', datetime('now'))`,
    [crypto.randomUUID(), taskId],
  );

  const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
  assert.ok(task, 'Expected a seeded task');
  assert.equal(existsSync(path.join(projectDir, '.repo')), false, 'Legacy workspace should not start with a repo cache');

  const workspace = await createTaskWorkspace(task, { forceFresh: true });

  assert.equal(workspace.path, workspaceDir);
  assert.ok(existsSync(path.join(projectDir, '.repo', '.git')), 'Expected a fresh repo cache to be created');
  assert.ok(existsSync(path.join(workspaceDir, '.git')), 'Expected a recreated workspace checkout');

  const ports = queryAll<{ port: number; status: string }>(
    'SELECT port, status FROM workspace_ports WHERE task_id = ? ORDER BY port',
    [taskId],
  );
  const activePorts = ports.filter((entry) => entry.status === 'active');
  const releasedPorts = ports.filter((entry) => entry.status === 'released').map((entry) => entry.port);

  assert.equal(activePorts.length, 1);
  assert.equal(activePorts[0].port, workspace.port);
  assert.equal(workspace.port, 4200);
  assert.deepEqual(releasedPorts.sort((a, b) => a - b), [4200, 4201]);
});

test('findFileProviderManagedAncestor detects file-provider markers on Darwin paths', () => {
  const detected = findFileProviderManagedAncestor('/Users/jordan/Documents/Shared/projects', {
    platform: 'darwin',
    readAttributeNames: (candidatePath) => {
      if (candidatePath === '/Users/jordan/Documents') {
        return ['com.apple.file-provider-domain-id', 'com.apple.fileprovider.detached#B'];
      }
      return [];
    },
  });

  assert.deepEqual(detected, {
    path: '/Users/jordan/Documents',
    attributes: ['com.apple.file-provider-domain-id', 'com.apple.fileprovider.detached#B'],
  });
});

test('assertWorkspaceRootSupported throws a clear error for file-provider managed roots', () => {
  const originalProjectsPath = process.env.PROJECTS_PATH;
  process.env.PROJECTS_PATH = '/Users/jordan/Documents/Shared/projects';

  try {
    assert.throws(
      () => assertWorkspaceRootSupported(),
      /file-provider-managed directory/,
    );
  } finally {
    process.env.PROJECTS_PATH = originalProjectsPath;
  }
});

test('shouldForceFreshWorkspace recognizes invalidation blocker hints', () => {
  assert.equal(
    shouldForceFreshWorkspace({
      planning_dispatch_error: 'Blocked: previous dispatch invalidated because workspace isolation failed and used a non-isolated path',
      status_reason: null,
    } as Task),
    true,
  );
  assert.equal(
    shouldForceFreshWorkspace({
      planning_dispatch_error: null,
      status_reason: 'Blocked: workspace deadlock | need: fresh isolated redispatch',
    } as Task),
    true,
  );
  assert.equal(
    shouldForceFreshWorkspace({
      planning_dispatch_error: 'Blocked: waiting on operator input',
      status_reason: null,
    } as Task),
    false,
  );
});

test('buildTaskFeatureBranch is deterministic per task and unique across same-title tasks', () => {
  assert.equal(
    buildTaskFeatureBranch({
      id: '9213d315-5008-4413-92ac-e91bb38ccb17',
      title: 'Deduplicate repeated PR deliverables in repo-backed dispatch context',
    } as Task),
    'autopilot/deduplicate-repeated-pr-deliverables-in-9213d315',
  );

  assert.notEqual(
    buildTaskFeatureBranch({
      id: '9213d315-5008-4413-92ac-e91bb38ccb17',
      title: 'Deduplicate repeated PR deliverables in repo-backed dispatch context',
    } as Task),
    buildTaskFeatureBranch({
      id: 'd731e283-4589-459d-abbf-20b918ec36f0',
      title: 'Deduplicate repeated PR deliverables in repo-backed dispatch context',
    } as Task),
  );
});
