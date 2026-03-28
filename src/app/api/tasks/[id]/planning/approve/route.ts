import { NextRequest, NextResponse } from 'next/server';
import { getDb, queryOne, run } from '@/lib/db';
import { createConvoy } from '@/lib/convoy';
import { handleStageTransition, getTaskRoles, populateTaskRolesFromAgents } from '@/lib/workflow-engine';
import { buildPlanningSpecMarkdown, parsePlanningSpecValue } from '@/lib/planning-agents';

export const dynamic = 'force-dynamic';

// POST /api/tasks/[id]/planning/approve - Lock spec and start execution
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;

  try {
    const task = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as {
      id: string;
      title: string;
      description?: string | null;
      status: string;
      workspace_id: string;
      planning_complete?: number;
      planning_spec?: string;
      planning_agents?: string;
    } | undefined;

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    if (!task.planning_complete || !task.planning_spec) {
      return NextResponse.json({ error: 'Planning is not complete yet' }, { status: 400 });
    }

    const existingSpec = getDb().prepare(
      'SELECT * FROM planning_specs WHERE task_id = ?'
    ).get(taskId);
    if (existingSpec) {
      return NextResponse.json({ error: 'Spec already locked' }, { status: 400 });
    }

    const parsedSpec = parsePlanningSpecValue(task.planning_spec);
    if (!parsedSpec) {
      return NextResponse.json({ error: 'Stored planning spec is invalid' }, { status: 400 });
    }

    const suggestedAgents = task.planning_agents ? JSON.parse(task.planning_agents) : [];
    const specMarkdown = buildPlanningSpecMarkdown(task, parsedSpec, suggestedAgents);

    const specId = crypto.randomUUID();
    getDb().prepare(`
      INSERT INTO planning_specs (id, task_id, spec_markdown, locked_at)
      VALUES (?, ?, ?, datetime('now'))
    `).run(specId, taskId, specMarkdown);

    run('DELETE FROM task_roles WHERE task_id = ?', [taskId]);
    populateTaskRolesFromAgents(taskId, task.workspace_id);

    const roles = getTaskRoles(taskId);
    const builderRole = roles.find((role) => role.role.toLowerCase() === 'builder');
    if (!builderRole) {
      run('DELETE FROM planning_specs WHERE id = ?', [specId]);
      return NextResponse.json(
        { error: 'No workspace builder is available for this task' },
        { status: 400 }
      );
    }

    getDb().prepare(`
      UPDATE tasks
      SET assigned_agent_id = ?,
          status = 'assigned',
          planning_dispatch_error = NULL,
          status_reason = 'Planning approved — builder dispatching',
          updated_at = datetime('now')
      WHERE id = ?
    `).run(builderRole.agent_id, taskId);

    getDb().prepare(`
      INSERT INTO task_activities (id, task_id, agent_id, activity_type, message)
      VALUES (?, ?, ?, 'status_changed', 'Planning approved — builder dispatching')
    `).run(crypto.randomUUID(), taskId, builderRole.agent_id);

    let convoyCreated = false;
    try {
      const specData = JSON.parse(task.planning_spec);
      if (specData.convoy === true && Array.isArray(specData.subtasks) && specData.subtasks.length > 0) {
        createConvoy({
          parentTaskId: taskId,
          name: task.title,
          strategy: 'planning',
          decompositionSpec: JSON.stringify(specData),
          subtasks: specData.subtasks.map((subtask: { title: string; description?: string }) => ({
            title: subtask.title,
            description: subtask.description,
          })),
        });
        convoyCreated = true;
      }
    } catch (err) {
      console.warn('[Planning Approve] Convoy auto-creation failed:', err);
    }

    const handoff = await handleStageTransition(taskId, 'assigned', {
      previousStatus: 'planning',
    });

    if (!handoff.success) {
      return NextResponse.json({
        error: handoff.error || 'Failed to dispatch builder after approval',
        convoyCreated,
      }, { status: 500 });
    }

    const spec = getDb().prepare('SELECT * FROM planning_specs WHERE id = ?').get(specId);
    return NextResponse.json({
      success: true,
      spec,
      specMarkdown,
      convoyCreated,
      dispatched: true,
      builderAgentId: handoff.newAgentId,
      builderAgentName: handoff.newAgentName,
    });
  } catch (error) {
    console.error('Failed to approve spec:', error);
    return NextResponse.json({ error: 'Failed to approve spec' }, { status: 500 });
  }
}
