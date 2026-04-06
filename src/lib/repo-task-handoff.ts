import { queryAll, queryOne, run } from '@/lib/db';
import type { Task, TaskDeliverable } from '@/lib/types';

export const PR_DELIVERABLE_TITLE = 'Pull Request';
export const PR_DELIVERABLE_DESCRIPTION = 'Auto-synced from task pr_url for repo-backed testing/review handoff.';

export type DispatchDeliverablePreview = Pick<TaskDeliverable, 'deliverable_type' | 'title' | 'path'>;

type RepoTaskLike = Pick<Task, 'id' | 'repo_url' | 'repo_branch' | 'pr_url' | 'workspace_path'>;

interface RepoArtifactSectionInput {
  task: RepoTaskLike;
  fallbackPath: string;
  deliverables: DispatchDeliverablePreview[];
}

interface BuilderRepoInstructionsInput {
  taskId: string;
  missionControlUrl: string;
  nextStatus: string;
  updatedByAgentId: string;
  workspacePath: string;
  requirePullRequest?: boolean;
  authInstruction?: string;
}

interface StageCompletionInstructionsInput {
  taskId: string;
  missionControlUrl: string;
  nextStatus: string;
  updatedByAgentId: string;
  authInstruction?: string;
  repoBacked?: boolean;
}

export function isRepoBackedTask(task: Pick<Task, 'repo_url' | 'workspace_path'>): boolean {
  return Boolean(task.repo_url?.trim() || task.workspace_path?.trim());
}

export function getRepoTaskSurfacePath(task: Pick<Task, 'workspace_path'>, fallbackPath: string): string {
  return task.workspace_path?.trim() || fallbackPath;
}

export function getTaskDispatchDeliverables(taskId: string): DispatchDeliverablePreview[] {
  const rawDeliverables = queryAll<DispatchDeliverablePreview>(
    `SELECT deliverable_type, title, path
     FROM task_deliverables
     WHERE task_id = ?
     ORDER BY created_at DESC
     LIMIT 24`,
    [taskId],
  );

  const seen = new Set<string>();
  const uniqueFiles: DispatchDeliverablePreview[] = [];
  const uniqueOtherDeliverables: DispatchDeliverablePreview[] = [];

  for (const deliverable of rawDeliverables) {
    const key = [
      deliverable.deliverable_type,
      deliverable.title.trim(),
      deliverable.path?.trim() || '',
    ].join('::');

    if (seen.has(key)) continue;
    seen.add(key);

    if (deliverable.deliverable_type === 'file') {
      uniqueFiles.push(deliverable);
    } else {
      uniqueOtherDeliverables.push(deliverable);
    }
  }

  return [...uniqueFiles, ...uniqueOtherDeliverables].slice(0, 8);
}

export function supportsPullRequestWorkflow(repoUrl: string | null | undefined): boolean {
  const normalized = repoUrl?.trim().toLowerCase() || '';
  return normalized.startsWith('https://github.com/') || normalized.startsWith('git@github.com:');
}

export function formatDispatchDeliverables(deliverables: DispatchDeliverablePreview[]): string {
  if (deliverables.length === 0) {
    return '- None registered yet';
  }

  return deliverables
    .map((deliverable) => {
      const location = deliverable.path ? ` — ${deliverable.path}` : '';
      return `- [${deliverable.deliverable_type}] ${deliverable.title}${location}`;
    })
    .join('\n');
}

export function buildRepoArtifactSection({
  task,
  fallbackPath,
  deliverables,
}: RepoArtifactSectionInput): string {
  const workspacePath = getRepoTaskSurfacePath(task, fallbackPath);
  const repoLine = task.repo_url?.trim() ? `- **Repo:** ${task.repo_url}\n` : '';
  const branchLine = task.repo_branch?.trim() ? `- **Base branch:** ${task.repo_branch}\n` : '';
  const prLine = task.pr_url?.trim() ? `- **PR:** ${task.pr_url}\n` : '';

  return `**REPO CONTEXT:**\n${repoLine}${branchLine}${prLine}**REPO WORKSPACE:** ${workspacePath}\n- The shell tool is stateless: a standalone \`cd ${workspacePath}\` does not persist to later commands.\n- For shell commands, use \`cd ${workspacePath} && <command>\` in the same command.\n- For non-shell file tools such as \`read\`, \`edit\`, \`ls\`, \`find\`, or \`glob\`, use absolute paths under \`${workspacePath}\`, not bare relative paths.\n- Treat all relative paths in this task, the PR, and the deliverables list as relative to \`${workspacePath}\`.\n- Use this workspace and the registered deliverables as the primary testing/review surface.\n- Registered deliverables are authoritative; do not invent alternate top-level paths if the listed files already exist under this workspace.\n- If you inspect a deliverable, copy the absolute path exactly as listed below. Do not call \`read\` on \`services/...\`; call it on \`${workspacePath}/services/...\`.\n- If a path lookup fails from another working directory, retry with \`cd ${workspacePath} && <command>\` or the absolute path before concluding the file or directory is missing.\n- Do not fail solely because the root output directory is empty if repo deliverables or workspace evidence exist.\n**REGISTERED DELIVERABLES:**\n${formatDispatchDeliverables(deliverables)}\n`;
}

export function buildBuilderRepoInstructions({
  taskId,
  missionControlUrl,
  nextStatus,
  updatedByAgentId,
  workspacePath,
  requirePullRequest = true,
  authInstruction = '',
}: BuilderRepoInstructionsInput): string {
  const prInstructions = requirePullRequest
    ? `3. If you created or updated a PR, record it on the task:
   PATCH ${missionControlUrl}/api/tasks/${taskId}
   Body: {"pr_url": "<github PR url>", "pr_status": "open"}
4. Also register the PR itself as a deliverable:
   POST ${missionControlUrl}/api/tasks/${taskId}/deliverables
   Body: {"deliverable_type": "url", "title": "${PR_DELIVERABLE_TITLE}", "path": "<github PR url>", "description": "${PR_DELIVERABLE_DESCRIPTION}"}
5. Update status: PATCH ${missionControlUrl}/api/tasks/${taskId}
   Body: {"status": "${nextStatus}", "updated_by_agent_id": "${updatedByAgentId}"}`
    : `3. This repo remote does not support GitHub PR creation. Do not block on a PR URL.
4. Update status: PATCH ${missionControlUrl}/api/tasks/${taskId}
   Body: {"status": "${nextStatus}", "updated_by_agent_id": "${updatedByAgentId}"}`;

  return `**IMPORTANT FINAL RESPONSE CONTRACT:** Your final response MUST begin with exactly one of these prefixes:
- \`TASK_COMPLETE: [brief summary of what you did]\`
- \`BLOCKED: [what stopped you] | need: [specific input or fix] | meanwhile: [fallback progress if any]\`

Do not end the run with free-form prose that omits one of those prefixes.

**This is a repo-backed task. Your primary artifacts are changed-file deliverables plus the PR URL, not just a static output folder.**

**If you complete the work:** After finishing, you MUST call these APIs:
${authInstruction}
1. Log activity: POST ${missionControlUrl}/api/tasks/${taskId}/activities
   Body: {"activity_type": "completed", "message": "Description of what was done"}
2. Register the key changed files as deliverables (repeat as needed):
   POST ${missionControlUrl}/api/tasks/${taskId}/deliverables
   Body: {"deliverable_type": "file", "title": "Relative file path", "path": "${workspacePath}/path/to/file"}
${prInstructions}

**If you are blocked and cannot finish:** Reply with the required \`BLOCKED:\` prefix so Mission Control records the blocker explicitly instead of treating the run as missing a completion callback.`;
}

// Compact one-line banner prepended at the very TOP of tester/verifier dispatch messages.
// Purpose: ensure the model encounters the required output format BEFORE reading any task
// content, counteracting attention-decay on the full contract buried at the end.
export function buildContractBanner(role: 'tester' | 'verifier'): string {
  const passPrefix = role === 'tester' ? 'TEST_PASS' : 'VERIFY_PASS';
  const failPrefix = role === 'tester' ? 'TEST_FAIL' : 'VERIFY_FAIL';
  return `⚠️ **OUTPUT FORMAT REQUIRED** — Your final reply MUST begin with exactly one of:
\`${passPrefix}: [summary]\` | \`${failPrefix}: [reason]\` | \`BLOCKED: Mission Control callback failed: [details]\`
Full callback instructions are at the bottom of this message.`;
}

function buildTerminalContractLines(options: {
  passPrefix: 'TEST_PASS' | 'VERIFY_PASS';
  failPrefix: 'TEST_FAIL' | 'VERIFY_FAIL';
}): string {
  return `**IMPORTANT FINAL RESPONSE CONTRACT:** Your final response MUST begin with exactly one of these prefixes:
- \`${options.passPrefix}: [summary]\`
- \`${options.failPrefix}: [what failed]\`
- \`BLOCKED: Mission Control callback failed: [request + error] | need: [specific fix] | meanwhile: [what you verified]\`

Do not end the run with free-form prose that omits one of those prefixes.`;
}

export function buildTesterInstructions({
  taskId,
  missionControlUrl,
  nextStatus,
  updatedByAgentId,
  authInstruction = '',
  repoBacked = false,
}: StageCompletionInstructionsInput): string {
  const intro = repoBacked
    ? `**YOUR ROLE: TESTER** — Test the repo-backed deliverables for this task.

Review the registered deliverables, inspect the repo workspace, and run any applicable tests from that workspace.
The shell tool is stateless, so do not rely on a standalone \`cd\`. Use \`cd REPO_WORKSPACE && <command>\` in the same command.
**FILE ACCESS RULES:** For non-shell file tools such as \`read\`, \`edit\`, \`ls\`, \`find\`, or \`glob\`, use absolute paths under **REPO WORKSPACE**. If you inspect a deliverable, copy the absolute path exactly as listed. Do not call \`read\` on \`services/...\`; call it on \`/abs/path/services/...\`.
Use the PR as supporting context when available. Do not fail solely because the root output directory is empty if repo deliverables or workspace evidence exist.`
    : `**YOUR ROLE: TESTER** — Test the deliverables for this task.

Review the output directory for deliverables and run any applicable tests.`;

  return `${buildTerminalContractLines({ passPrefix: 'TEST_PASS', failPrefix: 'TEST_FAIL' })}

${intro}

You must complete the Mission Control callback API calls below before ending the run. If any callback fails, stop and end the run with the required \`BLOCKED:\` prefix instead of free-form prose.

**If tests PASS:**
${authInstruction}
1. Log activity: POST ${missionControlUrl}/api/tasks/${taskId}/activities
   Body: {"activity_type": "completed", "message": "Tests passed: [summary]"}
2. Update status: PATCH ${missionControlUrl}/api/tasks/${taskId}
   Body: {"status": "${nextStatus}", "updated_by_agent_id": "${updatedByAgentId}"}

**If tests FAIL:**
${authInstruction}
1. POST ${missionControlUrl}/api/tasks/${taskId}/fail
   Body: {"reason": "Detailed description of what failed${repoBacked ? ' in the repo workspace or deliverables' : ''} and what needs fixing"}`;
}

export function buildVerifierInstructions({
  taskId,
  missionControlUrl,
  nextStatus,
  updatedByAgentId,
  authInstruction = '',
  repoBacked = false,
}: StageCompletionInstructionsInput): string {
  const intro = repoBacked
    ? `**YOUR ROLE: VERIFIER** — Verify that the repo-backed work meets quality standards.

Review the registered deliverables, inspect the repo workspace, and use the PR as supporting context when available.
The shell tool is stateless, so do not rely on a standalone \`cd\`. Use \`cd REPO_WORKSPACE && <command>\` in the same command.
**FILE ACCESS RULES:** For non-shell file tools such as \`read\`, \`edit\`, \`ls\`, \`find\`, or \`glob\`, use absolute paths under **REPO WORKSPACE**. If you inspect a deliverable, copy the absolute path exactly as listed. Do not call \`read\` on \`services/...\`; call it on \`/abs/path/services/...\`.
Do not fail solely because the root output directory is empty if repo deliverables or workspace evidence exist.`
    : `**YOUR ROLE: VERIFIER** — Verify that all work meets quality standards.

Review deliverables, test results, and task requirements.`;

  return `${buildTerminalContractLines({ passPrefix: 'VERIFY_PASS', failPrefix: 'VERIFY_FAIL' })}

${intro}

You must complete the Mission Control callback API calls below before ending the run. If any callback fails, stop and end the run with the required \`BLOCKED:\` prefix instead of free-form prose.

**If verification PASSES:**
${authInstruction}
1. Log activity: POST ${missionControlUrl}/api/tasks/${taskId}/activities
   Body: {"activity_type": "completed", "message": "Verification passed: [summary]"}
2. Update status: PATCH ${missionControlUrl}/api/tasks/${taskId}
   Body: {"status": "${nextStatus}", "updated_by_agent_id": "${updatedByAgentId}"}

**If verification FAILS:**
${authInstruction}
1. POST ${missionControlUrl}/api/tasks/${taskId}/fail
   Body: {"reason": "Detailed description of what failed${repoBacked ? ' in the repo workspace or deliverables' : ''} and what needs fixing"}`;
}

export function syncTaskPrDeliverable(taskId: string, prUrl: string | null | undefined): void {
  const normalizedPrUrl = prUrl?.trim() || null;
  const matchingRows = queryAll<{ id: string }>(
    `SELECT id
     FROM task_deliverables
     WHERE task_id = ?
       AND deliverable_type = 'url'
       AND (
         path = ?
         OR (title = ? AND description = ?)
       )
     ORDER BY created_at ASC, id ASC`,
    [taskId, normalizedPrUrl, PR_DELIVERABLE_TITLE, PR_DELIVERABLE_DESCRIPTION],
  );

  if (!normalizedPrUrl) {
    run(
      `DELETE FROM task_deliverables
       WHERE task_id = ?
         AND deliverable_type = 'url'
         AND title = ?
         AND description = ?`,
      [taskId, PR_DELIVERABLE_TITLE, PR_DELIVERABLE_DESCRIPTION],
    );
    return;
  }

  const primary = matchingRows[0];
  if (primary) {
    run(
      `UPDATE task_deliverables
       SET path = ?, title = ?, description = ?
       WHERE id = ?`,
      [normalizedPrUrl, PR_DELIVERABLE_TITLE, PR_DELIVERABLE_DESCRIPTION, primary.id],
    );
    if (matchingRows.length > 1) {
      run(
        `DELETE FROM task_deliverables
         WHERE id IN (${matchingRows.slice(1).map(() => '?').join(', ')})`,
        matchingRows.slice(1).map((row) => row.id),
      );
    }
  } else {
    run(
      `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, path, description, created_at)
       VALUES (?, ?, 'url', ?, ?, ?, datetime('now'))`,
      [crypto.randomUUID(), taskId, PR_DELIVERABLE_TITLE, normalizedPrUrl, PR_DELIVERABLE_DESCRIPTION],
    );
  }

  run(
    `DELETE FROM task_deliverables
     WHERE task_id = ?
       AND deliverable_type = 'url'
       AND title = ?
       AND description = ?
       AND path = ?
       AND id NOT IN (
         SELECT id
         FROM task_deliverables
         WHERE task_id = ?
           AND deliverable_type = 'url'
           AND title = ?
           AND description = ?
           AND path = ?
         ORDER BY created_at ASC, id ASC
         LIMIT 1
       )`,
    [
      taskId,
      PR_DELIVERABLE_TITLE,
      PR_DELIVERABLE_DESCRIPTION,
      normalizedPrUrl,
      taskId,
      PR_DELIVERABLE_TITLE,
      PR_DELIVERABLE_DESCRIPTION,
      normalizedPrUrl,
    ],
  );
}
