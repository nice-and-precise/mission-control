/**
 * Parallel Build Isolation
 *
 * Provides filesystem isolation for concurrent tasks targeting the same product.
 * Two strategies:
 *   - worktree: git worktree per task (for repo-backed projects)
 *   - sandbox:  rsync copy per task (for non-repo projects)
 */

import { execFileSync, execSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { queryOne, queryAll, run } from '@/lib/db';
import { getProjectsPath } from '@/lib/config';
import type { Task, Product } from '@/lib/types';

// ─── Types ───────────────────────────────────────────────────────────

export type IsolationStrategy = 'worktree' | 'sandbox';

export interface WorkspaceInfo {
  path: string;
  strategy: IsolationStrategy;
  branch?: string;
  baseBranch: string;
  baseCommit?: string;
  port: number;
}

export interface CreateTaskWorkspaceOptions {
  forceFresh?: boolean;
}

interface WorkspaceMetadata {
  taskId: string;
  productId?: string;
  createdAt: string;
  strategy: IsolationStrategy;
  branch?: string;
  baseBranch: string;
  baseCommit?: string;
  status: 'active' | 'merged' | 'abandoned';
  agentId?: string;
  isolatedPort: number;
}

export interface MergeResult {
  success: boolean;
  status: 'merged' | 'conflict' | 'pr_created' | 'failed';
  prUrl?: string;
  conflictFiles?: string[];
  mergeCommit?: string;
  mergeLog?: string;
}

export interface WorkspaceStatus {
  exists: boolean;
  strategy?: IsolationStrategy;
  path?: string;
  port?: number;
  branch?: string;
  baseBranch?: string;
  baseCommit?: string;
  filesChanged?: number;
  insertions?: number;
  deletions?: number;
  mergeStatus?: string;
  conflicts?: string[];
}

export function buildTaskFeatureBranch(task: Pick<Task, 'id' | 'title'>): string {
  const normalizedTitle = task.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const titleSlug = normalizedTitle.slice(0, 40).replace(/-+$/g, '') || 'task';
  const taskSuffix = task.id.replace(/[^a-z0-9]+/gi, '').toLowerCase().slice(0, 8) || 'task';
  return `autopilot/${titleSlug}-${taskSuffix}`;
}

// ─── Port Allocator ──────────────────────────────────────────────────

const PORT_RANGE_START = 4200;
const PORT_RANGE_END = 4299;
const FILE_PROVIDER_MARKERS = [
  'com.apple.file-provider-domain-id',
  'com.apple.fileprovider.detached',
] as const;
const FORCE_FRESH_WORKSPACE_HINTS = [
  'resource deadlock avoided',
  'workspace is still not healthy',
  'isolated workspace still returns',
  'previous dispatch invalidated',
  'fresh isolated redispatch',
] as const;

export function allocatePort(taskId: string, productId?: string): number {
  // Find the first available port in the range
  const usedPorts = queryAll<{ port: number }>(
    `SELECT port FROM workspace_ports WHERE status = 'active' ORDER BY port`
  ).map(r => r.port);

  let port = PORT_RANGE_START;
  while (port <= PORT_RANGE_END) {
    if (!usedPorts.includes(port)) break;
    port++;
  }

  if (port > PORT_RANGE_END) {
    throw new Error('No available ports for workspace isolation (4200-4299 exhausted)');
  }

  const id = uuidv4();
  run(
    `INSERT INTO workspace_ports (id, task_id, port, product_id, status, created_at)
     VALUES (?, ?, ?, ?, 'active', ?)`,
    [id, taskId, port, productId || null, new Date().toISOString()]
  );

  return port;
}

export function releasePort(taskId: string): void {
  run(
    `UPDATE workspace_ports SET status = 'released', released_at = ? WHERE task_id = ? AND status = 'active'`,
    [new Date().toISOString(), taskId]
  );
}

export function shouldForceFreshWorkspace(
  task: Pick<Task, 'planning_dispatch_error' | 'status_reason'>,
): boolean {
  const blockerText = `${task.planning_dispatch_error || ''}\n${task.status_reason || ''}`.toLowerCase();
  return FORCE_FRESH_WORKSPACE_HINTS.some((hint) => blockerText.includes(hint));
}

// ─── Strategy Detection ──────────────────────────────────────────────

export function determineIsolationStrategy(task: Task): IsolationStrategy | null {
  // If task has a repo URL, always use worktree
  if (task.repo_url) return 'worktree';

  // If other tasks are actively building the same product, use sandbox
  if (task.product_id) {
    const activeSiblings = queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM tasks
       WHERE product_id = ? AND id != ?
       AND status IN ('in_progress', 'assigned', 'convoy_active', 'testing')`,
      [task.product_id, task.id]
    );
    if ((activeSiblings?.count || 0) > 0) return 'sandbox';
  }

  return null;
}

// ─── Project Path Resolution ─────────────────────────────────────────

function getProductProjectDir(task: Task): string {
  const projectsPath = getProjectsPath();
  const product = task.product_id
    ? queryOne<Pick<Product, 'id' | 'name' | 'repo_url'>>(
        'SELECT id, name, repo_url FROM products WHERE id = ?',
        [task.product_id],
      )
    : undefined;
  const projectDir =
    getRepoDirectoryName(task.repo_url || product?.repo_url || null) ||
    (product?.id
      ? `${slugifyPathSegment(product.name || 'product')}-${product.id.slice(0, 8)}`
      : slugifyPathSegment(task.title));
  return path.resolve(projectsPath.replace('~', process.env.HOME || ''), projectDir);
}

function slugifyPathSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
}

function getRepoDirectoryName(repoUrl?: string | null): string | null {
  const normalized = repoUrl?.trim().replace(/\/+$/, '').replace(/\.git$/, '');
  if (!normalized) {
    return null;
  }

  const parts = normalized.split(/[/:]/).filter(Boolean);
  const repoName = parts.at(-1);
  return repoName ? slugifyPathSegment(repoName) : null;
}

function fetchOriginIfPresent(repoDir: string): void {
  try {
    execSync('git fetch origin', { cwd: repoDir, stdio: 'pipe', timeout: 120000 });
  } catch {
    // Local-only repos may not have an origin remote.
  }
}

function resolveCommitForRef(repoDir: string, ref: string): string | undefined {
  try {
    return execSync(`git rev-parse --verify "${ref}^{commit}"`, {
      cwd: repoDir,
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 10000,
    }).trim();
  } catch {
    return undefined;
  }
}

function resolveBaseRef(repoDir: string, baseBranch: string): { baseRef: string; baseCommit?: string } {
  for (const candidate of [`origin/${baseBranch}`, baseBranch, 'HEAD']) {
    const baseCommit = resolveCommitForRef(repoDir, candidate);
    if (baseCommit) {
      return { baseRef: candidate, baseCommit };
    }
  }

  return { baseRef: 'HEAD' };
}

function resetWorkspaceToBase(
  workspaceDir: string,
  branchName: string,
  baseBranch: string,
): { branch: string; baseCommit?: string } {
  fetchOriginIfPresent(workspaceDir);
  const { baseRef, baseCommit } = resolveBaseRef(workspaceDir, baseBranch);

  execSync(`git checkout -B "${branchName}" "${baseRef}"`, {
    cwd: workspaceDir,
    stdio: 'pipe',
    timeout: 30000,
  });
  execSync(`git reset --hard "${baseRef}"`, {
    cwd: workspaceDir,
    stdio: 'pipe',
    timeout: 30000,
  });
  execSync('git clean -fdx', { cwd: workspaceDir, stdio: 'pipe', timeout: 30000 });

  return { branch: branchName, baseCommit };
}

function createOrResetWorktree(
  repoDir: string,
  workspaceDir: string,
  branchName: string,
  baseRef: string,
): void {
  try {
    execSync(`git worktree add "${workspaceDir}" -B "${branchName}" "${baseRef}"`, {
      cwd: repoDir,
      stdio: 'pipe',
      timeout: 120000,
    });
    return;
  } catch (err) {
    try {
      execSync(`git worktree add "${workspaceDir}" --detach "${baseRef}"`, {
        cwd: repoDir,
        stdio: 'pipe',
        timeout: 120000,
      });
      execSync(`git checkout -B "${branchName}" "${baseRef}"`, {
        cwd: workspaceDir,
        stdio: 'pipe',
        timeout: 30000,
      });
      return;
    } catch {
      throw new Error(`Failed to create git worktree: ${(err as Error).message}`);
    }
  }
}

function getRecordedSuccessfulMerge(task: Pick<Task, 'id' | 'workspace_path' | 'merge_pr_url' | 'merge_status'>): MergeResult | null {
  if (!task.workspace_path || !task.merge_status || !['merged', 'pr_created'].includes(task.merge_status)) {
    return null;
  }

  const existing = queryOne<{ status: 'merged' | 'pr_created'; merge_commit?: string | null }>(
    `SELECT status, merge_commit
     FROM workspace_merges
     WHERE task_id = ?
       AND workspace_path = ?
       AND status IN ('merged', 'pr_created')
     ORDER BY COALESCE(merged_at, created_at) DESC
     LIMIT 1`,
    [task.id, task.workspace_path],
  );

  if (!existing) {
    return null;
  }

  return {
    success: true,
    status: existing.status,
    prUrl: task.merge_pr_url || undefined,
    mergeCommit: existing.merge_commit || undefined,
  };
}

function getPathAncestors(targetPath: string): string[] {
  const ancestors: string[] = [];
  let currentPath = path.resolve(targetPath);

  while (true) {
    ancestors.push(currentPath);
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      break;
    }
    currentPath = parentPath;
  }

  return ancestors;
}

function readExtendedAttributeNames(candidatePath: string): string[] {
  try {
    const output = execFileSync('xattr', ['-l', candidatePath], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    return output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.split(':')[0]?.trim() || '')
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function findFileProviderManagedAncestor(
  targetPath: string,
  options?: {
    platform?: NodeJS.Platform;
    readAttributeNames?: (candidatePath: string) => string[];
  },
): { path: string; attributes: string[] } | null {
  const platform = options?.platform || process.platform;
  if (platform !== 'darwin') {
    return null;
  }

  const readAttributeNames = options?.readAttributeNames || readExtendedAttributeNames;
  for (const candidatePath of getPathAncestors(targetPath)) {
    const attributes = readAttributeNames(candidatePath).filter((attribute) =>
      FILE_PROVIDER_MARKERS.some((marker) => attribute === marker || attribute.startsWith(`${marker}#`)),
    );

    if (attributes.length > 0) {
      return { path: candidatePath, attributes };
    }
  }

  return null;
}

export function assertWorkspaceRootSupported(
  projectsPath = getProjectsPath(),
  options?: {
    platform?: NodeJS.Platform;
    readAttributeNames?: (candidatePath: string) => string[];
  },
): void {
  const resolvedProjectsPath = path.resolve(projectsPath.replace('~', process.env.HOME || ''));
  const fileProviderAncestor = findFileProviderManagedAncestor(resolvedProjectsPath, options);
  if (!fileProviderAncestor) {
    return;
  }

  throw new Error(
    `Workspace root ${resolvedProjectsPath} is inside a file-provider-managed directory (${fileProviderAncestor.path}: ${fileProviderAncestor.attributes.join(', ')}). Move Mission Control projects to a non-file-provider root such as /Users/jordan/Projects.`
  );
}

function getWorkspacesRoot(projectDir: string): string {
  return path.join(projectDir, '.workspaces');
}

function getTaskWorkspaceDir(projectDir: string, taskId: string): string {
  return path.join(getWorkspacesRoot(projectDir), `task-${taskId}`);
}

function getRepoCacheDir(projectDir: string): string {
  return path.join(projectDir, '.repo');
}

function isGitRepoDir(dir: string): boolean {
  return existsSync(path.join(dir, '.git'));
}

function reuseExistingTaskWorkspace(
  workspaceDir: string,
  branchName: string,
  baseBranch: string,
  port: number,
): WorkspaceInfo | null {
  if (!isGitRepoDir(workspaceDir)) {
    return null;
  }

  const { branch, baseCommit } = resetWorkspaceToBase(workspaceDir, branchName, baseBranch);

  return {
    path: workspaceDir,
    strategy: 'worktree',
    branch,
    baseBranch,
    baseCommit,
    port,
  };
}

function removeRegisteredWorktree(repoDir: string, workspaceDir: string): void {
  if (!isGitRepoDir(repoDir)) {
    return;
  }

  try {
    const worktrees = execSync('git worktree list --porcelain', {
      cwd: repoDir,
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 10000,
    });
    if (!worktrees.includes(`worktree ${workspaceDir}\n`)) {
      return;
    }

    execSync(`git worktree remove "${workspaceDir}" --force`, {
      cwd: repoDir,
      stdio: 'pipe',
      timeout: 30000,
    });
    execSync('git worktree prune', { cwd: repoDir, stdio: 'pipe', timeout: 30000 });
  } catch {
    // Fall back to direct filesystem cleanup below.
  }
}

function removeExistingTaskWorkspace(
  task: Task,
  projectDir: string,
  workspaceDir: string,
): void {
  if (!existsSync(workspaceDir)) {
    return;
  }

  removeRegisteredWorktree(projectDir, workspaceDir);

  const repoCacheDir = getRepoCacheDir(projectDir);
  removeRegisteredWorktree(repoCacheDir, workspaceDir);

  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
}

function ensureRepoCache(projectDir: string, repoUrl: string, baseBranch: string): string {
  mkdirSync(projectDir, { recursive: true });

  const repoCacheDir = getRepoCacheDir(projectDir);
  if (!isGitRepoDir(repoCacheDir)) {
    rmSync(repoCacheDir, { recursive: true, force: true });
    execSync(`git clone --branch "${baseBranch}" "${repoUrl}" "${repoCacheDir}"`, {
      stdio: 'pipe',
      timeout: 120000,
    });
    return repoCacheDir;
  }

  execSync('git fetch origin', { cwd: repoCacheDir, stdio: 'pipe', timeout: 120000 });
  execSync(`git checkout "${baseBranch}"`, { cwd: repoCacheDir, stdio: 'pipe', timeout: 120000 });
  try {
    execSync(`git reset --hard "origin/${baseBranch}"`, {
      cwd: repoCacheDir,
      stdio: 'pipe',
      timeout: 120000,
    });
  } catch {
    execSync('git reset --hard HEAD', { cwd: repoCacheDir, stdio: 'pipe', timeout: 120000 });
  }

  return repoCacheDir;
}

// ─── Workspace Creation ──────────────────────────────────────────────

export async function createTaskWorkspace(
  task: Task,
  options: CreateTaskWorkspaceOptions = {},
): Promise<WorkspaceInfo> {
  assertWorkspaceRootSupported();

  const strategy = determineIsolationStrategy(task);
  if (!strategy) {
    // No isolation needed — return the original project dir
    const projectDir = getProductProjectDir(task);
    return {
      path: projectDir,
      strategy: 'sandbox',
      baseBranch: task.repo_branch || 'main',
      port: 0, // Use default port
    };
  }

  const projectDir = getProductProjectDir(task);
  const workspaceDir = getTaskWorkspaceDir(projectDir, task.id);
  const baseBranch = task.repo_branch || 'main';
  releasePort(task.id);
  const port = allocatePort(task.id, task.product_id);

  // Ensure .workspaces directory exists
  const workspacesRoot = getWorkspacesRoot(projectDir);
  mkdirSync(workspacesRoot, { recursive: true });

  // Add .workspaces to .gitignore if it's a git repo
  const gitignorePath = path.join(projectDir, '.gitignore');
  if (existsSync(path.join(projectDir, '.git'))) {
    try {
      const gitignore = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf-8') : '';
      if (!gitignore.includes('.workspaces')) {
        writeFileSync(gitignorePath, gitignore.trimEnd() + '\n.workspaces/\n');
      }
    } catch {
      // Best effort
    }
  }

  let result: WorkspaceInfo;

  if (strategy === 'worktree') {
    result = await createWorktreeWorkspace(task, projectDir, workspaceDir, baseBranch, port, options);
  } else {
    result = await createSandboxWorkspace(task, projectDir, workspaceDir, baseBranch, port, options);
  }

  // Write workspace metadata file
  const metadata: WorkspaceMetadata = {
    taskId: task.id,
    productId: task.product_id,
    createdAt: new Date().toISOString(),
    strategy,
    branch: result.branch,
    baseBranch,
    baseCommit: result.baseCommit,
    status: 'active',
    agentId: task.assigned_agent_id || undefined,
    isolatedPort: port,
  };
  writeFileSync(path.join(workspaceDir, '.mc-workspace.json'), JSON.stringify(metadata, null, 2));

  // Persist to DB
  const now = new Date().toISOString();
  run(
    `UPDATE tasks SET workspace_path = ?, workspace_strategy = ?, workspace_port = ?,
     workspace_base_commit = ?, merge_status = 'pending', updated_at = ? WHERE id = ?`,
    [result.path, strategy, port, result.baseCommit || null, now, task.id]
  );

  return result;
}

async function createWorktreeWorkspace(
  task: Task,
  projectDir: string,
  workspaceDir: string,
  baseBranch: string,
  port: number,
  options: CreateTaskWorkspaceOptions = {},
): Promise<WorkspaceInfo> {
  const branchName = buildTaskFeatureBranch(task);

  if (!options.forceFresh) {
    const reusableWorkspace = reuseExistingTaskWorkspace(workspaceDir, branchName, baseBranch, port);
    if (reusableWorkspace) {
      return reusableWorkspace;
    }
  }

  if (existsSync(workspaceDir)) {
    removeExistingTaskWorkspace(task, projectDir, workspaceDir);
  }

  // Check if this is a cloned repo or we need to clone
  const isGitRepo = isGitRepoDir(projectDir);

  if (isGitRepo) {
    // Use git worktree from existing repo
    fetchOriginIfPresent(projectDir);
    const { baseRef, baseCommit } = resolveBaseRef(projectDir, baseBranch);
    createOrResetWorktree(projectDir, workspaceDir, branchName, baseRef);

    return { path: workspaceDir, strategy: 'worktree', branch: branchName, baseBranch, baseCommit, port };
  }

  // Not a local git repo — clone from repo_url
  if (task.repo_url) {
    try {
      const repoCacheDir = ensureRepoCache(projectDir, task.repo_url, baseBranch);
      const { baseRef, baseCommit } = resolveBaseRef(repoCacheDir, baseBranch);
      createOrResetWorktree(repoCacheDir, workspaceDir, branchName, baseRef);
      return { path: workspaceDir, strategy: 'worktree', branch: branchName, baseBranch, baseCommit, port };
    } catch (err) {
      throw new Error(`Failed to clone repo: ${(err as Error).message}`);
    }
  }

  throw new Error('Worktree strategy requires a git repo or repo_url');
}

async function createSandboxWorkspace(
  task: Task,
  projectDir: string,
  workspaceDir: string,
  baseBranch: string,
  port: number,
  options: CreateTaskWorkspaceOptions = {},
): Promise<WorkspaceInfo> {
  // Ensure source directory exists
  if (!existsSync(projectDir)) {
    mkdirSync(projectDir, { recursive: true });
  }

  if (options.forceFresh && existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }

  // rsync the project directory, excluding heavy/generated dirs
  try {
    execSync(
      `rsync -a --exclude='.workspaces' --exclude='node_modules' --exclude='.next' --exclude='.git' --exclude='dist' --exclude='build' "${projectDir}/" "${workspaceDir}/"`,
      { stdio: 'pipe', timeout: 60000 }
    );
  } catch (err) {
    // If rsync fails (e.g., empty dir), just create the workspace
    mkdirSync(workspaceDir, { recursive: true });
  }

  return { path: workspaceDir, strategy: 'sandbox', baseBranch, port };
}

// ─── Workspace Status ────────────────────────────────────────────────

export function getWorkspaceStatus(task: Task): WorkspaceStatus {
  if (!task.workspace_path || !existsSync(task.workspace_path)) {
    return { exists: false };
  }

  const strategy = task.workspace_strategy as IsolationStrategy | undefined;
  const result: WorkspaceStatus = {
    exists: true,
    strategy,
    path: task.workspace_path,
    port: task.workspace_port || undefined,
    baseBranch: task.repo_branch || 'main',
    baseCommit: task.workspace_base_commit || undefined,
    mergeStatus: task.merge_status || undefined,
  };

  // Read metadata for branch info
  const metadataPath = path.join(task.workspace_path, '.mc-workspace.json');
  if (existsSync(metadataPath)) {
    try {
      const metadata: WorkspaceMetadata = JSON.parse(readFileSync(metadataPath, 'utf-8'));
      result.branch = metadata.branch;
    } catch {
      // Ignore
    }
  }

  // Get diff stats
  if (strategy === 'worktree' && existsSync(path.join(task.workspace_path, '.git'))) {
    try {
      const diffStat = execSync(
        `git diff --stat HEAD~1 2>/dev/null || git diff --stat --cached 2>/dev/null || echo ""`,
        { cwd: task.workspace_path, encoding: 'utf-8', timeout: 10000 }
      );
      const lines = diffStat.trim().split('\n');
      const summary = lines[lines.length - 1] || '';
      const filesMatch = summary.match(/(\d+) files? changed/);
      const insertMatch = summary.match(/(\d+) insertions?/);
      const deleteMatch = summary.match(/(\d+) deletions?/);
      result.filesChanged = filesMatch ? parseInt(filesMatch[1]) : 0;
      result.insertions = insertMatch ? parseInt(insertMatch[1]) : 0;
      result.deletions = deleteMatch ? parseInt(deleteMatch[1]) : 0;
    } catch {
      // Ignore diff errors
    }
  } else if (strategy === 'sandbox') {
    // For sandbox, count files that differ from original
    const projectDir = path.dirname(path.dirname(task.workspace_path)); // Up from .workspaces/task-xxx
    try {
      const diff = execSync(
        `diff -rq "${projectDir}" "${task.workspace_path}" --exclude='.workspaces' --exclude='node_modules' --exclude='.next' --exclude='.mc-workspace.json' 2>/dev/null | wc -l`,
        { encoding: 'utf-8', timeout: 10000 }
      ).trim();
      result.filesChanged = parseInt(diff) || 0;
    } catch {
      // Ignore
    }
  }

  return result;
}

// ─── Merge Operations ────────────────────────────────────────────────

export async function mergeWorkspace(task: Task, options?: { force?: boolean; createPR?: boolean }): Promise<MergeResult> {
  if (!task.workspace_path || !task.workspace_strategy) {
    return { success: false, status: 'failed', mergeLog: 'No workspace to merge' };
  }

  if (!existsSync(task.workspace_path)) {
    return { success: false, status: 'failed', mergeLog: 'Workspace directory not found' };
  }

  const now = new Date().toISOString();
  const mergeId = uuidv4();

  if (task.workspace_strategy === 'worktree') {
    return mergeWorktree(task, mergeId, now, options);
  } else {
    return mergeSandbox(task, mergeId, now, options);
  }
}

async function mergeWorktree(
  task: Task,
  mergeId: string,
  now: string,
  options?: { force?: boolean; createPR?: boolean }
): Promise<MergeResult> {
  const workspacePath = task.workspace_path!;
  const baseBranch = task.repo_branch || 'main';

  // Read metadata for branch name
  let branch = buildTaskFeatureBranch(task);
  const metadataPath = path.join(workspacePath, '.mc-workspace.json');
  if (existsSync(metadataPath)) {
    try {
      const metadata = JSON.parse(readFileSync(metadataPath, 'utf-8'));
      if (metadata.branch) branch = metadata.branch;
    } catch { /* ignore */ }
  }

  try {
    // Stage and commit any uncommitted changes
    try {
      execSync(`git add -A && git diff --cached --quiet || git commit -m "Autopilot: final changes for ${task.title}"`, {
        cwd: workspacePath, stdio: 'pipe', shell: '/bin/sh'
      });
    } catch { /* nothing to commit */ }

    // Push branch to remote
    let pushed = false;
    try {
      execSync(`git push origin "${branch}" 2>&1`, { cwd: workspacePath, stdio: 'pipe', timeout: 60000 });
      pushed = true;
    } catch (err) {
      // May not have remote push access
      console.warn(`[Workspace] Push failed for ${branch}:`, (err as Error).message);
    }

    // Create PR if pushed and requested (or if repo_url suggests GitHub)
    let prUrl: string | undefined;
    if (pushed && (options?.createPR !== false) && task.repo_url?.includes('github.com')) {
      try {
        const prBody = `## Autopilot Build\n\n- **Task:** ${task.title}\n- **Task ID:** ${task.id}\n- **Branch:** ${branch}\n- **Base:** ${baseBranch}`;
        const result = execSync(
          `gh pr create --title "\u{1F916} Autopilot: ${task.title}" --body "${prBody.replace(/"/g, '\\"')}" --base "${baseBranch}" --head "${branch}" 2>&1`,
          { cwd: workspacePath, encoding: 'utf-8', timeout: 30000 }
        ).trim();
        // gh pr create outputs the PR URL
        if (result.includes('github.com')) {
          prUrl = result.split('\n').pop()?.trim();
        }
      } catch (err) {
        console.warn('[Workspace] PR creation failed:', (err as Error).message);
      }
    }

    const status = prUrl ? 'pr_created' : (pushed ? 'merged' : 'merged');
    const mergeCommit = (() => {
      try { return execSync('git rev-parse HEAD', { cwd: workspacePath, encoding: 'utf-8' }).trim(); }
      catch { return undefined; }
    })();

    // Record merge
    run(
      `INSERT INTO workspace_merges (id, task_id, workspace_path, strategy, base_commit, merge_commit, status, merged_by, created_at, merged_at)
       VALUES (?, ?, ?, 'worktree', ?, ?, ?, 'auto', ?, ?)`,
      [mergeId, task.id, workspacePath, task.workspace_base_commit, mergeCommit, status, now, now]
    );

    // Update task
    run(
      `UPDATE tasks SET merge_status = ?, merge_pr_url = ?, updated_at = ? WHERE id = ?`,
      [status, prUrl || null, now, task.id]
    );

    return { success: true, status: status as MergeResult['status'], prUrl, mergeCommit };
  } catch (err) {
    const errorMsg = (err as Error).message;
    run(
      `INSERT INTO workspace_merges (id, task_id, workspace_path, strategy, status, merge_log, created_at)
       VALUES (?, ?, ?, 'worktree', 'failed', ?, ?)`,
      [mergeId, task.id, workspacePath, errorMsg, now]
    );
    run(`UPDATE tasks SET merge_status = 'conflict', updated_at = ? WHERE id = ?`, [now, task.id]);
    return { success: false, status: 'failed', mergeLog: errorMsg };
  }
}

async function mergeSandbox(
  task: Task,
  mergeId: string,
  now: string,
  _options?: { force?: boolean }
): Promise<MergeResult> {
  const workspacePath = task.workspace_path!;
  // The project dir is two levels up: .workspaces/task-xxx → .workspaces → projectDir
  const projectDir = path.dirname(path.dirname(workspacePath));

  try {
    // Check for conflicts: files modified in both workspace and main project since workspace creation
    let conflictFiles: string[] = [];
    try {
      const diff = execSync(
        `diff -rq "${projectDir}" "${workspacePath}" --exclude='.workspaces' --exclude='node_modules' --exclude='.next' --exclude='.mc-workspace.json' --exclude='.git' --exclude='dist' --exclude='build' 2>/dev/null || true`,
        { encoding: 'utf-8', timeout: 30000 }
      );
      // Parse diff output for changed files
      const changedFiles = diff.split('\n')
        .filter(l => l.startsWith('Files ') && l.includes(' differ'))
        .map(l => {
          const match = l.match(/Files (.+?) and (.+?) differ/);
          return match ? match[2].replace(workspacePath + '/', '') : null;
        })
        .filter(Boolean) as string[];

      if (changedFiles.length > 0) {
        // rsync changes from workspace back to project
        execSync(
          `rsync -a --exclude='.workspaces' --exclude='node_modules' --exclude='.next' --exclude='.mc-workspace.json' --exclude='.git' --exclude='dist' --exclude='build' "${workspacePath}/" "${projectDir}/"`,
          { stdio: 'pipe', timeout: 60000 }
        );
      }
    } catch (err) {
      conflictFiles = [`Merge error: ${(err as Error).message}`];
    }

    const status = conflictFiles.length > 0 ? 'conflict' : 'merged';

    run(
      `INSERT INTO workspace_merges (id, task_id, workspace_path, strategy, status, conflict_files, merged_by, created_at, merged_at)
       VALUES (?, ?, ?, 'sandbox', ?, ?, 'auto', ?, ?)`,
      [mergeId, task.id, workspacePath, status, conflictFiles.length > 0 ? JSON.stringify(conflictFiles) : null, now, now]
    );
    run(`UPDATE tasks SET merge_status = ?, updated_at = ? WHERE id = ?`, [status, now, task.id]);

    return { success: status === 'merged', status: status as MergeResult['status'], conflictFiles: conflictFiles.length > 0 ? conflictFiles : undefined };
  } catch (err) {
    const errorMsg = (err as Error).message;
    run(
      `INSERT INTO workspace_merges (id, task_id, workspace_path, strategy, status, merge_log, created_at)
       VALUES (?, ?, ?, 'sandbox', 'failed', ?, ?)`,
      [mergeId, task.id, workspacePath, errorMsg, now]
    );
    run(`UPDATE tasks SET merge_status = 'conflict', updated_at = ? WHERE id = ?`, [now, task.id]);
    return { success: false, status: 'failed', mergeLog: errorMsg };
  }
}

// ─── Cleanup ─────────────────────────────────────────────────────────

export function cleanupWorkspace(task: Task): boolean {
  if (!task.workspace_path) return false;

  const workspacePath = task.workspace_path;
  const projectDir = path.dirname(path.dirname(workspacePath));

  try {
    if (task.workspace_strategy === 'worktree') {
      // Remove git worktree
      try {
        execSync(`git worktree remove "${workspacePath}" --force`, { cwd: projectDir, stdio: 'pipe' });
      } catch {
        // Fallback: just remove the directory
        execSync(`rm -rf "${workspacePath}"`, { stdio: 'pipe' });
      }

      // Try to delete the branch
      const metadataPath = path.join(workspacePath, '.mc-workspace.json');
      if (existsSync(metadataPath)) {
        try {
          const metadata = JSON.parse(readFileSync(metadataPath, 'utf-8'));
          if (metadata.branch) {
            execSync(`git branch -D "${metadata.branch}" 2>/dev/null || true`, { cwd: projectDir, stdio: 'pipe' });
          }
        } catch { /* ignore */ }
      }
    } else {
      // Remove sandbox directory
      execSync(`rm -rf "${workspacePath}"`, { stdio: 'pipe' });
    }

    // Release port
    releasePort(task.id);

    // Update task
    const now = new Date().toISOString();
    run(
      `UPDATE tasks SET workspace_path = NULL, workspace_port = NULL, updated_at = ? WHERE id = ?`,
      [now, task.id]
    );

    // Update metadata status
    const metadataPath = path.join(workspacePath, '.mc-workspace.json');
    if (existsSync(metadataPath)) {
      try {
        const metadata = JSON.parse(readFileSync(metadataPath, 'utf-8'));
        metadata.status = 'abandoned';
        writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
      } catch { /* ignore */ }
    }

    return true;
  } catch (err) {
    console.error(`[Workspace] Cleanup failed for task ${task.id}:`, err);
    return false;
  }
}

// ─── Active Workspaces Query ─────────────────────────────────────────

export function getActiveWorkspaces(productId: string): Array<{
  taskId: string;
  taskTitle: string;
  branch?: string;
  port?: number;
  agentName?: string;
  strategy?: string;
  filesChanged?: number;
  createdAt: string;
}> {
  const tasks = queryAll<Task & { agent_name?: string }>(
    `SELECT t.*, a.name as agent_name FROM tasks t
     LEFT JOIN agents a ON t.assigned_agent_id = a.id
     WHERE t.product_id = ? AND t.workspace_path IS NOT NULL
     AND t.status IN ('assigned', 'in_progress', 'convoy_active', 'testing', 'review', 'verification')
     ORDER BY t.created_at DESC`,
    [productId]
  );

  return tasks.map(t => {
    let branch: string | undefined;
    if (t.workspace_path && existsSync(path.join(t.workspace_path, '.mc-workspace.json'))) {
      try {
        const meta = JSON.parse(readFileSync(path.join(t.workspace_path, '.mc-workspace.json'), 'utf-8'));
        branch = meta.branch;
      } catch { /* ignore */ }
    }

    return {
      taskId: t.id,
      taskTitle: t.title,
      branch,
      port: t.workspace_port || undefined,
      agentName: (t as { agent_name?: string }).agent_name,
      strategy: t.workspace_strategy,
      filesChanged: undefined, // Computed on-demand to avoid perf hit
      createdAt: t.created_at,
    };
  });
}

// ─── Merge Lock ──────────────────────────────────────────────────────

const MERGE_LOCKS = new Map<string, boolean>();

export function acquireMergeLock(productId: string): boolean {
  if (MERGE_LOCKS.get(productId)) return false;
  MERGE_LOCKS.set(productId, true);
  return true;
}

export function releaseMergeLock(productId: string): void {
  MERGE_LOCKS.delete(productId);
}

export async function triggerWorkspaceMerge(taskId: string): Promise<MergeResult | null> {
  const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (!task || !task.workspace_path || !task.workspace_strategy) return null;

  const existingSuccessfulMerge = getRecordedSuccessfulMerge(task);
  if (existingSuccessfulMerge) {
    return existingSuccessfulMerge;
  }

  // Acquire merge lock for the product
  const lockKey = task.product_id || task.id;
  if (!acquireMergeLock(lockKey)) {
    // Another merge in progress — queue this one
    run(`UPDATE tasks SET merge_status = 'pending', updated_at = ? WHERE id = ?`, [new Date().toISOString(), taskId]);
    return null;
  }

  try {
    const result = await mergeWorkspace(task, { createPR: true });
    return result;
  } finally {
    releaseMergeLock(lockKey);
    // Check for queued merges
    const queued = queryOne<Task>(
      `SELECT * FROM tasks WHERE product_id = ? AND merge_status = 'pending' AND status = 'done' AND workspace_path IS NOT NULL AND id != ?`,
      [task.product_id, taskId]
    );
    if (queued) {
      // Fire-and-forget the next merge
      triggerWorkspaceMerge(queued.id).catch(err =>
        console.error('[Workspace] Queued merge failed:', err)
      );
    }
  }
}
