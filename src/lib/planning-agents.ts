import { getDb } from '@/lib/db';
import type { GeneratedPlanningSpec, SuggestedPlanningAgent } from '@/lib/types';

export function parsePlanningSpecValue(value: string | object | null | undefined): GeneratedPlanningSpec | null {
  if (!value) return null;

  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== 'object') return null;

    const candidate = parsed as Record<string, unknown>;
    return {
      title: String(candidate.title || ''),
      summary: String(candidate.summary || ''),
      deliverables: Array.isArray(candidate.deliverables) ? candidate.deliverables.map(String) : [],
      success_criteria: Array.isArray(candidate.success_criteria) ? candidate.success_criteria.map(String) : [],
      constraints: candidate.constraints && typeof candidate.constraints === 'object'
        ? candidate.constraints as Record<string, unknown>
        : {},
      execution_plan: candidate.execution_plan && typeof candidate.execution_plan === 'object'
        ? candidate.execution_plan as GeneratedPlanningSpec['execution_plan']
        : undefined,
    };
  } catch {
    return null;
  }
}

export function cleanupTaskScopedAgents(taskId: string): number {
  const db = getDb();
  const agentRows = db.prepare(
    `SELECT id FROM agents WHERE task_id = ? AND COALESCE(scope, 'workspace') = 'task'`
  ).all(taskId) as Array<{ id: string }>;

  if (agentRows.length === 0) return 0;

  const agentIds = agentRows.map((row) => row.id);
  const placeholders = agentIds.map(() => '?').join(', ');

  db.prepare(`DELETE FROM conversation_participants WHERE agent_id IN (${placeholders})`).run(...agentIds);
  db.prepare(`DELETE FROM messages WHERE sender_agent_id IN (${placeholders})`).run(...agentIds);
  db.prepare(`DELETE FROM openclaw_sessions WHERE agent_id IN (${placeholders})`).run(...agentIds);
  db.prepare(`DELETE FROM agent_health WHERE agent_id IN (${placeholders})`).run(...agentIds);
  db.prepare(`DELETE FROM task_roles WHERE task_id = ? AND agent_id IN (${placeholders})`).run(taskId, ...agentIds);
  db.prepare(`DELETE FROM task_activities WHERE task_id = ? AND agent_id IN (${placeholders})`).run(taskId, ...agentIds);
  db.prepare(`DELETE FROM events WHERE task_id = ? AND agent_id IN (${placeholders})`).run(taskId, ...agentIds);
  db.prepare(`DELETE FROM agents WHERE id IN (${placeholders})`).run(...agentIds);

  return agentIds.length;
}

export function buildPlanningSpecMarkdown(
  task: { title: string; description?: string | null },
  spec: GeneratedPlanningSpec,
  suggestedAgents: SuggestedPlanningAgent[] = []
): string {
  const lines: string[] = [];

  lines.push(`# ${spec.title || task.title}`);
  lines.push('');
  lines.push('**Status:** SPEC LOCKED ✅');
  lines.push('');

  if (task.description) {
    lines.push('## Original Request');
    lines.push(task.description);
    lines.push('');
  }

  if (spec.summary) {
    lines.push('## Summary');
    lines.push(spec.summary);
    lines.push('');
  }

  if (spec.deliverables.length > 0) {
    lines.push('## Deliverables');
    for (const deliverable of spec.deliverables) {
      lines.push(`- ${deliverable}`);
    }
    lines.push('');
  }

  if (spec.success_criteria.length > 0) {
    lines.push('## Success Criteria');
    for (const criterion of spec.success_criteria) {
      lines.push(`- ${criterion}`);
    }
    lines.push('');
  }

  if (spec.execution_plan?.approach || (spec.execution_plan?.steps?.length || 0) > 0) {
    lines.push('## Execution Plan');
    if (spec.execution_plan?.approach) {
      lines.push(spec.execution_plan.approach);
      lines.push('');
    }
    for (const step of spec.execution_plan?.steps || []) {
      lines.push(`- ${step}`);
    }
    lines.push('');
  }

  if (Object.keys(spec.constraints).length > 0) {
    lines.push('## Constraints');
    lines.push('```json');
    lines.push(JSON.stringify(spec.constraints, null, 2));
    lines.push('```');
    lines.push('');
  }

  if (suggestedAgents.length > 0) {
    lines.push('## Planner-Suggested Task Agents');
    for (const agent of suggestedAgents) {
      lines.push(`- ${agent.avatar_emoji || '🤖'} ${agent.name} — ${agent.role}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push(`*Spec locked at ${new Date().toISOString()}*`);

  return lines.join('\n');
}
