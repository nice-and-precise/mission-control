import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { queryOne, queryAll, run } from '@/lib/db';
import { enforceBudgetPolicy, syncReservedSpendTotals } from '@/lib/costs/budget-policy';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { bindOpenClawSessionModel } from '@/lib/openclaw/session-runtime';
import { broadcast } from '@/lib/events';
import { getProjectsPath, getMissionControlUrl } from '@/lib/config';
import { isOpenClawAgentTarget } from '@/lib/openclaw/model-catalog';
import { getDispatchDefaultModelForRole } from '@/lib/openclaw/model-policy';
import { getRelevantKnowledge, formatKnowledgeForDispatch } from '@/lib/learner';
import { getTaskWorkflow, getWorkflowOwnerRoleForStatus } from '@/lib/workflow-engine';
import { syncGatewayAgentsToCatalog } from '@/lib/agent-catalog-sync';
import { pickDynamicAgent } from '@/lib/task-governance';
import { buildCheckpointContext } from '@/lib/checkpoint';
import { formatMailForDispatch } from '@/lib/mailbox';
import { getPendingNotesForDispatch } from '@/lib/task-notes';
import { expectReply } from '@/lib/chat-listener';
import { buildTaskFeatureBranch, createTaskWorkspace, determineIsolationStrategy, shouldForceFreshWorkspace } from '@/lib/workspace-isolation';
import { buildAgentSessionKey, buildPersistentAgentSessionId } from '@/lib/openclaw/routing';
import { buildTaskDispatchEnvelope } from '@/lib/openclaw/session-commands';
import {
  buildBuilderRepoInstructions,
  buildContractBanner,
  buildTesterInstructions,
  buildVerifierInstructions,
  buildRepoArtifactSection,
  getRepoTaskSurfacePath,
  getTaskDispatchDeliverables,
  isRepoBackedTask,
  supportsPullRequestWorkflow,
} from '@/lib/repo-task-handoff';
import type { Task, Agent, OpenClawSession, WorkflowStage, TaskImage } from '@/lib/types';

export const dynamic = 'force-dynamic';
interface RouteParams {
  params: Promise<{ id: string }>;
}

const AGENT_EXECUTING_STATUSES = ['in_progress', 'testing', 'review', 'verification', 'convoy_active'];

function findBlockingActiveTask(agentId: string, taskId: string, workspaceId: string): { id: string; title: string; status: string } | null {
  const placeholders = AGENT_EXECUTING_STATUSES.map(() => '?').join(', ');
  return queryOne<{ id: string; title: string; status: string }>(
    `SELECT id, title, status
     FROM tasks
     WHERE assigned_agent_id = ?
       AND id != ?
       AND workspace_id = ?
       AND status IN (${placeholders})
     ORDER BY updated_at DESC
     LIMIT 1`,
    [agentId, taskId, workspaceId, ...AGENT_EXECUTING_STATUSES]
  ) || null;
}

function queueTaskUntilAgentIsFree(args: {
  taskId: string;
  agentId: string;
  agentName: string;
  blockingTask: { id: string; title: string; status: string };
  now: string;
}): void {
  const message = `Waiting for ${args.agentName} to finish "${args.blockingTask.title}" before starting this task.`;
  run(
    `UPDATE tasks
     SET status = 'assigned',
         assigned_agent_id = ?,
         planning_dispatch_error = NULL,
         status_reason = ?,
         updated_at = ?
     WHERE id = ? AND status != 'done'`,
    [args.agentId, message, args.now, args.taskId]
  );

  const latestActivity = queryOne<{ message: string | null }>(
    `SELECT message
     FROM task_activities
     WHERE task_id = ?
       AND activity_type = 'status_changed'
     ORDER BY created_at DESC
     LIMIT 1`,
    [args.taskId]
  );

  if (latestActivity?.message !== message) {
    run(
      `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, created_at)
       VALUES (?, ?, ?, 'status_changed', ?, ?)`,
      [uuidv4(), args.taskId, args.agentId, message, args.now]
    );
  }
}

/**
 * POST /api/tasks/[id]/dispatch
 * 
 * Dispatches a task to its assigned agent's OpenClaw session.
 * Creates session if needed, sends task details to agent.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;

    // Keep canonical agent catalog synced before every dispatch (best-effort)
    await syncGatewayAgentsToCatalog({ reason: 'dispatch' }).catch(err => {
      console.warn('[Dispatch] agent catalog sync failed:', err);
    });

    // Get task with agent info
    const task = queryOne<Task & { assigned_agent_name?: string; workspace_id: string }>(
      `SELECT t.*, a.name as assigned_agent_name, a.is_master
       FROM tasks t
       LEFT JOIN agents a ON t.assigned_agent_id = a.id
       WHERE t.id = ?`,
      [id]
    );

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    let assignedAgentId = task.assigned_agent_id;
    if (!assignedAgentId) {
      const statusRoleMap: Record<string, string> = {
        assigned: 'builder',
        in_progress: 'builder',
        testing: 'tester',
        review: 'reviewer',
        verification: 'reviewer',
      };
      const dynamicAgent = pickDynamicAgent(id, statusRoleMap[task.status] || 'builder');
      if (dynamicAgent) {
        assignedAgentId = dynamicAgent.id;
        run('UPDATE tasks SET assigned_agent_id = ?, updated_at = datetime(\'now\') WHERE id = ?', [assignedAgentId, id]);
      }
    }

    if (!assignedAgentId) {
      return NextResponse.json(
        { error: 'Task has no routable agent' },
        { status: 400 }
      );
    }

    // Get agent details
    const agent = queryOne<Agent>(
      'SELECT * FROM agents WHERE id = ?',
      [assignedAgentId]
    );

    if (!agent) {
      return NextResponse.json({ error: 'Assigned agent not found' }, { status: 404 });
    }

    const now = new Date().toISOString();
    const configuredModel = (agent.model || '').trim();
    const effectiveDispatchModel = !configuredModel || isOpenClawAgentTarget(configuredModel)
      ? getDispatchDefaultModelForRole(agent.role)
      : configuredModel;
    const budget = enforceBudgetPolicy({
      action: 'dispatch',
      workspaceId: task.workspace_id,
      productId: task.product_id || undefined,
      taskId: task.id,
      model: effectiveDispatchModel,
      reserveCostUsd: task.estimated_cost_usd || 0,
    });
    if (!budget.ok) {
      const error = budget.message || 'Dispatch blocked by Mission Control budget policy.';
      run(
        `UPDATE tasks
         SET planning_dispatch_error = ?,
             status_reason = ?,
             updated_at = ?
         WHERE id = ?`,
        [error, error, now, id]
      );
      const blockedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [id]);
      if (blockedTask) {
        broadcast({ type: 'task_updated', payload: blockedTask });
      }
      return NextResponse.json(
        { error, reason_code: budget.reasonCode, model: effectiveDispatchModel },
        { status: 409 }
      );
    }

    // Check if dispatching to the master agent while there are other orchestrators available
    if (agent.is_master) {
      // Check for other master agents in the same workspace (excluding this one)
      const otherOrchestrators = queryAll<{
        id: string;
        name: string;
        role: string;
      }>(
        `SELECT id, name, role
         FROM agents
         WHERE is_master = 1
         AND id != ?
         AND workspace_id = ?
         AND status != 'offline'`,
        [agent.id, task.workspace_id]
      );

      if (otherOrchestrators.length > 0) {
        return NextResponse.json({
          success: false,
          warning: 'Other orchestrators available',
          message: `There ${otherOrchestrators.length === 1 ? 'is' : 'are'} ${otherOrchestrators.length} other orchestrator${otherOrchestrators.length === 1 ? '' : 's'} available in this workspace: ${otherOrchestrators.map(o => o.name).join(', ')}. Consider assigning this task to them instead.`,
          otherOrchestrators,
        }, { status: 409 }); // 409 Conflict - indicating there's an alternative
      }
    }

    // Connect to OpenClaw Gateway
    const client = getOpenClawClient();
    if (!client.isConnected()) {
      try {
        await client.connect();
      } catch (err) {
        console.error('Failed to connect to OpenClaw Gateway:', err);
        client.forceReconnect();
        return NextResponse.json(
          { error: 'Failed to connect to OpenClaw Gateway' },
          { status: 503 }
        );
      }
    }

    const desiredOpenclawSessionId = buildPersistentAgentSessionId(agent);

    // Get or create OpenClaw session for this agent
    let session = queryOne<OpenClawSession>(
      'SELECT * FROM openclaw_sessions WHERE agent_id = ? AND status = ? AND openclaw_session_id = ?',
      [agent.id, 'active', desiredOpenclawSessionId]
    );

    if (!session) {
      run(
        `UPDATE openclaw_sessions
         SET status = 'ended',
             active_task_id = NULL,
             ended_at = COALESCE(ended_at, ?),
             updated_at = ?
         WHERE agent_id = ?
           AND status = 'active'
           AND openclaw_session_id != ?`,
        [now, now, agent.id, desiredOpenclawSessionId]
      );

      // Create session record
      const sessionId = uuidv4();
      
      run(
        `INSERT INTO openclaw_sessions (id, agent_id, openclaw_session_id, channel, status, task_id, active_task_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [sessionId, agent.id, desiredOpenclawSessionId, 'mission-control', 'active', task.id, task.id, now, now]
      );

      session = queryOne<OpenClawSession>(
        'SELECT * FROM openclaw_sessions WHERE id = ?',
        [sessionId]
      );

      // Log session creation
      run(
        `INSERT INTO events (id, type, agent_id, message, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [uuidv4(), 'agent_status_changed', agent.id, `${agent.name} session created`, now]
      );
    }

    if (!session) {
      return NextResponse.json(
        { error: 'Failed to create agent session' },
        { status: 500 }
      );
    }

    // Always bind the active session to the task being dispatched so health
    // checks and session views reflect the real executing task.
    run(
      `UPDATE openclaw_sessions
       SET task_id = ?, active_task_id = ?, status = 'active', ended_at = NULL, updated_at = ?
       WHERE id = ?`,
      [task.id, task.id, now, session.id]
    );

    // Build task message for agent
    const priorityEmoji = {
      low: '🔵',
      normal: '⚪',
      high: '🟡',
      urgent: '🔴'
    }[task.priority] || '⚪';

    // Get project path for deliverables — with workspace isolation if needed
    const projectsPath = getProjectsPath();
    const projectDir = task.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    let taskProjectDir = `${projectsPath}/${projectDir}`;
    const missionControlUrl = getMissionControlUrl();

    // Create isolated workspace if parallel builds are possible
    // Only for builder dispatches (assigned/in_progress), not tester/reviewer
    let workspaceIsolated = false;
    let workspaceBranchName: string | undefined;
    let workspacePort: number | undefined;
    const isolationStrategy = determineIsolationStrategy(task as Task);
    const isBuilderDispatch = task.status === 'assigned' || task.status === 'in_progress' || task.status === 'inbox';
    if (isolationStrategy && isBuilderDispatch) {
      try {
      const forceFreshWorkspace = shouldForceFreshWorkspace(task as Task);
        const workspace = await createTaskWorkspace(task as Task, {
          forceFresh: forceFreshWorkspace,
        });
        taskProjectDir = workspace.path;
        workspaceIsolated = true;
        workspaceBranchName = workspace.branch;
        workspacePort = workspace.port;
        console.log(
          `[Dispatch] Created ${workspace.strategy} workspace for task ${task.id}: ${workspace.path}`
          + (forceFreshWorkspace ? ' (forced fresh workspace)' : '')
        );
      } catch (err) {
        const isolationError = `Workspace isolation failed: ${(err as Error).message}`;
        console.warn(`[Dispatch] ${isolationError}`);

        run(
          `UPDATE openclaw_sessions
           SET status = 'ended', active_task_id = NULL, ended_at = COALESCE(ended_at, ?), updated_at = ?
           WHERE id = ?`,
          [now, now, session.id]
        );
        run(
          `UPDATE agents
           SET status = 'standby', updated_at = ?
           WHERE id = ? AND status = 'working'`,
          [now, agent.id]
        );
        run(
          `UPDATE tasks
           SET status = 'assigned',
               planning_dispatch_error = ?,
               status_reason = ?,
               updated_at = ?
           WHERE id = ?`,
          [isolationError, isolationError, now, id]
        );
        run(
          `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, created_at)
           VALUES (?, ?, ?, 'status_changed', ?, ?)`,
          [uuidv4(), id, agent.id, isolationError, now]
        );

        const failedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [id]);
        if (failedTask) {
          broadcast({ type: 'task_updated', payload: failedTask });
        }

        return NextResponse.json(
          { error: isolationError },
          { status: 409 }
        );
      }
    }

    // Parse planning_spec and planning_agents if present (stored as JSON text on the task row)
    const rawTask = task as Task & { assigned_agent_name?: string; workspace_id: string; planning_spec?: string; planning_agents?: string };
    let planningSpecSection = '';
    let agentInstructionsSection = '';

    if (rawTask.planning_spec) {
      try {
        const spec = JSON.parse(rawTask.planning_spec);
        // planning_spec may be an object with spec_markdown, or a raw string
        const specText = typeof spec === 'string' ? spec : (spec.spec_markdown || JSON.stringify(spec, null, 2));
        planningSpecSection = `\n---\n**📋 PLANNING SPECIFICATION:**\n${specText}\n`;
      } catch {
        // If not valid JSON, treat as plain text
        planningSpecSection = `\n---\n**📋 PLANNING SPECIFICATION:**\n${rawTask.planning_spec}\n`;
      }
    }

    if (rawTask.planning_agents) {
      try {
        const agents = JSON.parse(rawTask.planning_agents);
        if (Array.isArray(agents)) {
          // Find instructions for this specific agent, or include all if none match
          const myInstructions = agents.find(
            (a: { agent_id?: string; name?: string; instructions?: string }) =>
              a.agent_id === agent.id || a.name === agent.name
          );
          if (myInstructions?.instructions) {
            agentInstructionsSection = `\n**🎯 YOUR INSTRUCTIONS:**\n${myInstructions.instructions}\n`;
          } else {
            // Include all agent instructions for context
            const allInstructions = agents
              .filter((a: { instructions?: string }) => a.instructions)
              .map((a: { name?: string; role?: string; instructions?: string }) =>
                `- **${a.name || a.role || 'Agent'}:** ${a.instructions}`
              )
              .join('\n');
            if (allInstructions) {
              agentInstructionsSection = `\n**🎯 AGENT INSTRUCTIONS:**\n${allInstructions}\n`;
            }
          }
        }
      } catch {
        // Ignore malformed planning_agents JSON
      }
    }

    // Inject relevant knowledge from the learner knowledge base
    let knowledgeSection = '';
    try {
      const knowledge = getRelevantKnowledge(task.workspace_id, task.title);
      knowledgeSection = formatKnowledgeForDispatch(knowledge);
    } catch {
      // Knowledge injection is best-effort
    }

    // Inject matched product skills (proven procedures from previous tasks)
    let skillsSection = '';
    if (task.product_id) {
      try {
        const { getMatchedSkills, formatSkillsForDispatch } = await import('@/lib/skills');
        const skills = getMatchedSkills(task.product_id, task.title, task.description || '', agent.name);
        skillsSection = formatSkillsForDispatch(skills);
      } catch {
        // Skills injection is best-effort
      }
    }

    if (task.status === 'inbox') {
      const error = 'Cannot dispatch an inbox task. Assign it first so workflow ownership is explicit.';
      run(
        `UPDATE tasks
         SET planning_dispatch_error = ?, status_reason = ?, updated_at = ?
         WHERE id = ?`,
        [error, error, now, id]
      );
      return NextResponse.json({ error }, { status: 409 });
    }

    // Determine role-specific instructions based on workflow template
    const workflow = getTaskWorkflow(id);
    let currentStage: WorkflowStage | undefined;
    let nextStage: WorkflowStage | undefined;
    if (workflow) {
      let stageIndex = workflow.stages.findIndex(s => s.status === task.status);
      // 'assigned' isn't a workflow stage — resolve to the 'build' stage (in_progress)
      if (stageIndex < 0 && task.status === 'assigned') {
        stageIndex = workflow.stages.findIndex(s => s.role === 'builder');
      }
      if (stageIndex >= 0) {
        currentStage = workflow.stages[stageIndex];
        nextStage = workflow.stages[stageIndex + 1];
      }
    }

    let expectedRole = task.status === 'assigned'
      ? 'builder'
      : getWorkflowOwnerRoleForStatus(workflow, task.status);

    if (expectedRole && (agent.role || '').toLowerCase() !== expectedRole.toLowerCase()) {
      const error = `Workflow mismatch: status ${task.status} is ${expectedRole}-owned but assigned agent ${agent.name} has role ${agent.role || 'unknown'}.`;
      run(
        `UPDATE tasks
         SET planning_dispatch_error = ?, status_reason = ?, updated_at = ?
         WHERE id = ?`,
        [error, error, now, id]
      );
      return NextResponse.json({ error }, { status: 409 });
    }

    if (workflow && currentStage && !currentStage.role) {
      const nextRole = (nextStage?.role || '').toLowerCase();
      const assignedRole = (agent.role || '').toLowerCase();

      if (nextStage?.status && nextRole && assignedRole === nextRole) {
        run(
          `UPDATE tasks
           SET status = ?,
               planning_dispatch_error = NULL,
               status_reason = NULL,
               updated_at = ?
           WHERE id = ?`,
          [nextStage.status, now, id],
        );
        run(
          `INSERT INTO events (id, type, task_id, message, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          [uuidv4(), 'task_status_changed', id, `Auto-advanced queue stage ${task.status} -> ${nextStage.status} for ${agent.name} dispatch`, now],
        );

        task.status = nextStage.status;
        currentStage = nextStage;
        const promotedStageIndex = workflow.stages.findIndex((s) => s.status === task.status);
        nextStage = promotedStageIndex >= 0 ? workflow.stages[promotedStageIndex + 1] : undefined;
        expectedRole = getWorkflowOwnerRoleForStatus(workflow, task.status);
      } else {
        const error = `Cannot dispatch queue stage ${task.status} directly. Advance it through the workflow engine instead.`;
        run(
          `UPDATE tasks
           SET planning_dispatch_error = ?, status_reason = ?, updated_at = ?
           WHERE id = ?`,
          [error, error, now, id]
        );
        return NextResponse.json({ error }, { status: 409 });
      }
    }

    const builderOwnedDispatch = expectedRole?.toLowerCase() === 'builder';
    const blockingTask = builderOwnedDispatch ? findBlockingActiveTask(agent.id, task.id, task.workspace_id) : null;

    if (builderOwnedDispatch && blockingTask) {
      queueTaskUntilAgentIsFree({
        taskId: task.id,
        agentId: agent.id,
        agentName: agent.name,
        blockingTask,
        now,
      });

      const queuedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [id]);
      if (queuedTask) {
        broadcast({ type: 'task_updated', payload: queuedTask });
      }

      return NextResponse.json({
        success: true,
        queued: true,
        task_id: task.id,
        agent_id: agent.id,
        message: `Task queued for ${agent.name}; agent is still busy with another active task.`,
        waiting_for_task_id: blockingTask.id,
        waiting_for_task_title: blockingTask.title,
      });
    }

    const isBuilder = !currentStage || currentStage.role === 'builder' || task.status === 'assigned';
    const isTester = currentStage?.role === 'tester';
    const isVerifier = currentStage?.role === 'verifier' || currentStage?.role === 'reviewer';
    const isRepoTask = isRepoBackedTask(task as Task);
    const nextStatus = nextStage?.status || 'review';
    const missionControlAuthInstruction = process.env.MC_API_TOKEN
      ? `**Mission Control callback auth:** Use the \`MC_API_TOKEN\` environment variable already available in this runtime for every Mission Control API call below.\n- Header: \`Authorization: Bearer $MC_API_TOKEN\`\n- Do not print, echo, or paste the token value into logs, files, or chat.\n`
      : `**Mission Control callback auth:** If \`MC_API_TOKEN\` is unavailable in this runtime, stop and end the run with:\n- \`BLOCKED: Mission Control callback failed: missing MC_API_TOKEN | need: runtime auth token exposure | meanwhile: no authenticated callback attempted\`\n`;
    const registeredDeliverables = getTaskDispatchDeliverables(task.id);
    const repoSurfacePath = getRepoTaskSurfacePath(task as Task, taskProjectDir);

    let completionInstructions: string;
    if (isBuilder && isRepoTask) {
      completionInstructions = buildBuilderRepoInstructions({
        taskId: task.id,
        missionControlUrl,
        nextStatus,
        updatedByAgentId: agent.id,
        workspacePath: taskProjectDir,
        requirePullRequest: supportsPullRequestWorkflow(task.repo_url),
        authInstruction: missionControlAuthInstruction,
      });
    } else if (isBuilder) {
      completionInstructions = `**IMPORTANT FINAL RESPONSE CONTRACT:** Your final response MUST begin with exactly one of these prefixes:
- \`TASK_COMPLETE: [brief summary of what you did]\`
- \`BLOCKED: [what stopped you] | need: [specific input or fix] | meanwhile: [fallback progress if any]\`

Do not end the run with free-form prose that omits one of those prefixes.

**If you complete the work:** After finishing, you MUST call these APIs:
${missionControlAuthInstruction}
1. Log activity: POST ${missionControlUrl}/api/tasks/${task.id}/activities
   Body: {"activity_type": "completed", "message": "Description of what was done"}
2. Register deliverable: POST ${missionControlUrl}/api/tasks/${task.id}/deliverables
   Body: {"deliverable_type": "file", "title": "File name", "path": "${taskProjectDir}/filename.html"}
3. Update status: PATCH ${missionControlUrl}/api/tasks/${task.id}
   Body: {"status": "${nextStatus}", "updated_by_agent_id": "${agent.id}"}

**If you are blocked and cannot finish:** Reply with the required \`BLOCKED:\` prefix so Mission Control records the blocker explicitly instead of treating the run as missing a completion callback.`;
    } else if (isTester && isRepoTask) {
      completionInstructions = buildTesterInstructions({
        taskId: task.id,
        missionControlUrl,
        nextStatus,
        updatedByAgentId: agent.id,
        authInstruction: missionControlAuthInstruction,
        repoBacked: true,
      });
    } else if (isTester) {
      completionInstructions = buildTesterInstructions({
        taskId: task.id,
        missionControlUrl,
        nextStatus,
        updatedByAgentId: agent.id,
        authInstruction: missionControlAuthInstruction,
      });
    } else if (isVerifier && isRepoTask) {
      completionInstructions = buildVerifierInstructions({
        taskId: task.id,
        missionControlUrl,
        nextStatus,
        updatedByAgentId: agent.id,
        authInstruction: missionControlAuthInstruction,
        repoBacked: true,
      });
    } else if (isVerifier) {
      completionInstructions = buildVerifierInstructions({
        taskId: task.id,
        missionControlUrl,
        nextStatus,
        updatedByAgentId: agent.id,
        authInstruction: missionControlAuthInstruction,
      });
    } else {
      // Fallback for unknown roles
      completionInstructions = `**IMPORTANT:** After completing work:
${missionControlAuthInstruction}
1. Update status: PATCH ${missionControlUrl}/api/tasks/${task.id}
   Body: {"status": "${nextStatus}", "updated_by_agent_id": "${agent.id}"}`;
    }

    // Compact output-format banner prepended at the very start of the dispatch message for
    // tester/verifier agents. This ensures the required PASS/FAIL/BLOCKED prefix contract is
    // the FIRST thing the model reads, not just the last section buried after all task content.
    const headerContractBanner = (isTester || isVerifier)
      ? buildContractBanner(isTester ? 'tester' : 'verifier') + '\n\n'
      : '';

    // Build image references section
    let imagesSection = '';
    if (task.images) {
      try {
        const images: TaskImage[] = JSON.parse(task.images);
        if (images.length > 0) {
          const imageList = images
            .map(img => `- ${img.original_name}: ${missionControlUrl}/api/task-images/${task.id}/${img.filename}`)
            .join('\n');
          imagesSection = `\n**Reference Images:**\n${imageList}\n`;
        }
      } catch {
        // Ignore malformed images JSON
      }
    }

    // Build repo/PR section for builder agents when task has a repo
    let repoSection = '';
    if ((task as Task & { repo_url?: string }).repo_url && isBuilder) {
      const repoUrl = (task as Task & { repo_url?: string }).repo_url!;
      const repoBranch = (task as Task & { repo_branch?: string }).repo_branch || 'main';
      const branchName = buildTaskFeatureBranch(task);
      const requirePullRequest = supportsPullRequestWorkflow(repoUrl);
      const pushStep = requirePullRequest
        ? '6. Push branch and create a Pull Request'
        : '6. Push branch back to origin so the repo-backed workspace has a reviewable branch state';
      const prSection = requirePullRequest
        ? `
**PR REQUIREMENTS:**
- Title: "\u{1F916} Autopilot: ${task.title}"
- Body must include:
  - What was built and why
  - Research backing (from the idea)
  - Technical approach taken
  - Any risks or trade-offs
  - Task ID: ${task.id}
- Target branch: ${repoBranch}
- After creating PR, report the PR URL:
  PATCH ${missionControlUrl}/api/tasks/${task.id}
  Body: {"pr_url": "<github PR url>", "pr_status": "open"}
`
        : `
**REVIEW HANDOFF:**
- This repo remote is not GitHub-backed, so do not block on creating a GitHub PR.
- Push the feature branch to origin if possible and continue with changed-file deliverables plus status callbacks.
- Leave \`pr_url\` unset unless you actually have a real PR URL.
`;

      repoSection = `
---
**\u{1F517} REPOSITORY:**
- **Repo:** ${repoUrl}
- **Base branch:** ${repoBranch}
- **Feature branch:** ${branchName}

**GIT WORKFLOW:**
1. First, verify you have git access: run \`git ls-remote ${repoUrl}\`
   - If this fails, report the error immediately via:
     PATCH ${missionControlUrl}/api/tasks/${task.id}
     Body: {"status_reason": "Git auth not configured: [error message]"}
     Then STOP — do not proceed without repo access.
2. Clone the repo (or use existing local copy)
3. Create branch \`${branchName}\` from \`${repoBranch}\`
4. Implement the feature
5. Commit with clear messages (reference task: ${task.id})
${pushStep}
${prSection}
`;
    } else if (isRepoTask) {
      repoSection = `${buildRepoArtifactSection({
        task: task as Task,
        fallbackPath: repoSurfacePath,
        deliverables: registeredDeliverables,
      })}\n`;
    }

    const roleLabel = currentStage?.label || 'Task';
    const taskMessage = `${headerContractBanner}${priorityEmoji} **${isBuilder ? 'NEW TASK ASSIGNED' : `${roleLabel.toUpperCase()} STAGE \u2014 ${task.title}`}**

**Title:** ${task.title}
${task.description ? `**Description:** ${task.description}\n` : ''}
**Priority:** ${task.priority.toUpperCase()}
${task.due_date ? `**Due:** ${task.due_date}\n` : ''}
**Task ID:** ${task.id}
${planningSpecSection}${agentInstructionsSection}${skillsSection}${knowledgeSection}${imagesSection}${buildCheckpointContext(task.id) || ''}${formatMailForDispatch(agent.id) || ''}${repoSection}
${isBuilder ? (workspaceIsolated
  ? `**\u{1F512} ISOLATED WORKSPACE:** ${taskProjectDir}\n- **Port:** ${workspacePort || 'default'} (use this for dev server, NOT the default)\n${workspaceBranchName ? `- **Branch:** ${workspaceBranchName}\n` : ''}- **IMPORTANT:** Do NOT modify files outside this workspace directory. Other agents may be working on the same project in parallel. All your work must stay within: ${taskProjectDir}\nCreate this directory if needed and save all deliverables there.\n`
  : `**OUTPUT DIRECTORY:** ${taskProjectDir}\nCreate this directory and save all deliverables there.\n`)
: isRepoTask
  ? ''
  : `**OUTPUT DIRECTORY:** ${taskProjectDir}\n`}
${completionInstructions}

If you need help or clarification, ask the orchestrator.`;

    // Inject any pending operator notes (queued via /btw chat)
    const { formatted: pendingNotes } = getPendingNotesForDispatch(id);
    const finalMessage = pendingNotes ? taskMessage + pendingNotes : taskMessage;
    const dispatchEnvelope = buildTaskDispatchEnvelope(session.openclaw_session_id, finalMessage);

    let boundSessionKey: string;
    let boundModel: string;
    try {
      const binding = await bindOpenClawSessionModel({
        session: {
          ...session,
          role: agent.role,
          session_key_prefix: agent.session_key_prefix || null,
        },
        requestedModel: effectiveDispatchModel,
        client,
      });

      if (binding.bindingStatus !== 'bound' || !binding.boundModel) {
        const error = binding.bindingError || `OpenClaw could not confirm model binding for ${effectiveDispatchModel}.`;
        run(`UPDATE tasks SET reserved_cost_usd = 0 WHERE id = ?`, [id]);
        syncReservedSpendTotals(task.workspace_id, task.product_id || undefined);
        run(
          `UPDATE openclaw_sessions
           SET session_key = ?,
               requested_model = ?,
               bound_model = ?,
               binding_status = 'failed',
               binding_error = ?,
               usage_sync_status = 'pending',
               usage_sync_reason = 'binding_failed',
               updated_at = ?
           WHERE id = ?`,
          [
            binding.sessionKey,
            binding.requestedModel,
            binding.boundModel || null,
            error,
            now,
            session.id,
          ],
        );
        run(
          `UPDATE tasks
           SET planning_dispatch_error = ?,
               status_reason = ?,
               updated_at = ?
           WHERE id = ?`,
          [error, error, now, id],
        );
        const blockedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [id]);
        if (blockedTask) {
          broadcast({ type: 'task_updated', payload: blockedTask });
        }
        return NextResponse.json(
          {
            error,
            requested_model: binding.requestedModel,
            bound_model: binding.boundModel || null,
            binding_status: 'failed',
          },
          { status: 409 },
        );
      }

      run(
        `UPDATE openclaw_sessions
         SET session_key = ?,
             requested_model = ?,
             bound_model = ?,
             binding_status = 'bound',
             binding_error = NULL,
             last_run_id = NULL,
             usage_external_id = NULL,
             usage_sync_status = 'pending',
             usage_sync_reason = NULL,
             usage_synced_at = NULL,
             usage_start_input_tokens = ?,
             usage_start_output_tokens = ?,
             usage_start_cache_read_tokens = ?,
             usage_start_cache_write_tokens = ?,
             updated_at = ?
         WHERE id = ?`,
        [
          binding.sessionKey,
          binding.requestedModel,
          binding.boundModel,
          binding.usageStart.inputTokens,
          binding.usageStart.outputTokens,
          binding.usageStart.cacheReadTokens,
          binding.usageStart.cacheWriteTokens,
          now,
          session.id,
        ],
      );

      boundSessionKey = binding.sessionKey;
      boundModel = binding.boundModel;
    } catch (err) {
      const error = `OpenClaw model binding failed: ${(err as Error).message}`;
      run(`UPDATE tasks SET reserved_cost_usd = 0 WHERE id = ?`, [id]);
      syncReservedSpendTotals(task.workspace_id, task.product_id || undefined);
      run(
        `UPDATE openclaw_sessions
         SET session_key = ?,
             requested_model = ?,
             bound_model = NULL,
             binding_status = 'failed',
             binding_error = ?,
             usage_sync_status = 'pending',
             usage_sync_reason = 'binding_failed',
             updated_at = ?
         WHERE id = ?`,
        [
          buildAgentSessionKey(dispatchEnvelope.openclawSessionId, agent),
          effectiveDispatchModel,
          error,
          now,
          session.id,
        ],
      );
      run(
        `UPDATE tasks
         SET planning_dispatch_error = ?,
             status_reason = ?,
             updated_at = ?
         WHERE id = ?`,
        [error, error, now, id],
      );
      const failedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [id]);
      if (failedTask) {
        broadcast({ type: 'task_updated', payload: failedTask });
      }
      return NextResponse.json(
        {
          error,
          requested_model: effectiveDispatchModel,
          bound_model: null,
          binding_status: 'failed',
        },
        { status: 409 },
      );
    }

    // Send message to agent's session using chat.send
    try {
      await client.call('chat.send', {
        sessionKey: boundSessionKey,
        message: dispatchEnvelope.message,
        idempotencyKey: `dispatch-${task.id}-${Date.now()}`
      });
      expectReply(boundSessionKey, task.id);

      run(
        `UPDATE tasks
         SET planning_dispatch_error = NULL,
             status_reason = NULL,
             updated_at = ?
         WHERE id = ?`,
        [now, id]
      );

      // Only move to in_progress for builder dispatch (task is in 'assigned' status)
      // For tester/reviewer/verifier, the task status is already correct
      if (task.status === 'assigned') {
        run(
          'UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?',
          ['in_progress', now, id]
        );
      }

      // Broadcast task update
      const updatedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [id]);
      if (updatedTask) {
        broadcast({
          type: 'task_updated',
          payload: updatedTask,
        });
      }

      // Update agent status to working
      run(
        'UPDATE agents SET status = ?, updated_at = ? WHERE id = ?',
        ['working', now, agent.id]
      );

      // Log dispatch event to events table
      const eventId = uuidv4();
      run(
        `INSERT INTO events (id, type, agent_id, task_id, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [eventId, 'task_dispatched', agent.id, task.id, `Task "${task.title}" dispatched to ${agent.name}`, now]
      );

      // Log dispatch activity to task_activities table (for Activity tab)
      const activityId = crypto.randomUUID();
      run(
        `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [activityId, task.id, agent.id, 'status_changed', `Task dispatched to ${agent.name} - Agent is now working on this task`, now]
      );

      return NextResponse.json({
        success: true,
        task_id: task.id,
        agent_id: agent.id,
        session_id: session.openclaw_session_id,
        session_key: boundSessionKey,
        message: 'Task dispatched to agent',
        model: boundModel,
        requested_model: effectiveDispatchModel,
        bound_model: boundModel,
        binding_status: 'bound',
        reserved_estimated_usd: budget.reserveCostUsd,
        budget_status: 'clear',
      });
    } catch (err) {
      console.error('Failed to send message to agent:', err);
      // Force-reconnect so the next dispatch attempt gets a fresh WebSocket
      const client2 = getOpenClawClient();
      client2.forceReconnect();
      run(`UPDATE tasks SET reserved_cost_usd = 0 WHERE id = ?`, [id]);
      syncReservedSpendTotals(task.workspace_id, task.product_id || undefined);
      // Reset task to 'assigned' so dispatch can be retried
      run(
        `UPDATE tasks SET status = 'assigned', planning_dispatch_error = ?, updated_at = datetime('now') WHERE id = ? AND status != 'done'`,
        [`Dispatch delivery failed: ${(err as Error).message}`, id]
      );
      const failedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [id]);
      if (failedTask) {
        broadcast({ type: 'task_updated', payload: failedTask });
      }
      return NextResponse.json(
        { error: `Failed to deliver task to agent: ${(err as Error).message}` },
        { status: 503 }
      );
    }
  } catch (error) {
    console.error('Failed to dispatch task:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
