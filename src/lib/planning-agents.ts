import { getDb } from '@/lib/db';
import type { GeneratedPlanningSpec, SuggestedPlanningAgent } from '@/lib/types';

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === 'string') return item.trim();
      if (typeof item === 'number' || typeof item === 'boolean') return String(item);
      if (!item || typeof item !== 'object') return '';
      // Extract meaningful text from objects instead of producing [object Object]
      const c = item as Record<string, unknown>;
      const text = String(c.label || c.name || c.title || c.description || c.action || c.value || '').trim();
      if (text) return text;
      // Last resort: compact JSON so the value is at least readable
      try { return JSON.stringify(item); } catch { return ''; }
    })
    .filter(Boolean);
}

function toExecutionPlanSteps(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((step) => {
      if (typeof step === 'string') return step.trim();
      if (!step || typeof step !== 'object') return '';
      const candidate = step as Record<string, unknown>;
      return String(candidate.action || candidate.step || candidate.title || '').trim();
    })
    .filter(Boolean);
}

function extractChangeActions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === 'string') return item.trim();
      if (!item || typeof item !== 'object') return '';
      const c = item as Record<string, unknown>;
      const loc = String(c.location || '').trim();
      const action = String(c.action || c.description || '').trim();
      if (!action) return '';
      return loc ? `${loc}: ${action}` : action;
    })
    .filter(Boolean);
}

function buildLooseSpecConstraints(candidate: Record<string, unknown>): Record<string, unknown> {
  const knownKeys = new Set([
    'title',
    'summary',
    'deliverables',
    'success_criteria',
    'constraints',
    'execution_plan',
    'goal',
    'canonical_repo',
    'canonical_branch',
    'prohibited_terms_source',
    'prohibited_terms',
    'target_artifacts',
    'method',
    'output',
    'steps',
    'estimated_duration_minutes',
    'risk',
  ]);

  const passthrough: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(candidate)) {
    if (!knownKeys.has(key)) {
      passthrough[key] = value;
    }
  }
  if (candidate.canonical_repo) passthrough.canonical_repo = candidate.canonical_repo;
  if (candidate.canonical_branch) passthrough.canonical_branch = candidate.canonical_branch;
  if (candidate.prohibited_terms_source) passthrough.prohibited_terms_source = candidate.prohibited_terms_source;
  if (Array.isArray(candidate.prohibited_terms)) passthrough.prohibited_terms = candidate.prohibited_terms;
  if (typeof candidate.risk === 'string' && candidate.risk.trim()) passthrough.risk = candidate.risk.trim();
  if (typeof candidate.estimated_duration_minutes === 'number') {
    passthrough.estimated_duration_minutes = candidate.estimated_duration_minutes;
  }

  return passthrough;
}

export function parsePlanningSpecValue(value: string | object | null | undefined): GeneratedPlanningSpec | null {
  if (!value) return null;

  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== 'object') return null;

    const candidate = parsed as Record<string, unknown>;
    const title = String(candidate.title || candidate.goal || candidate.task || '').trim();
    const summary = String(candidate.summary || candidate.goal || candidate.method || candidate.output || candidate.task || '').trim();
    const deliverables = toStringArray(candidate.deliverables);
    const successCriteria = toStringArray(candidate.success_criteria);
    const explicitConstraints =
      candidate.constraints && typeof candidate.constraints === 'object'
        ? candidate.constraints as Record<string, unknown>
        : null;
    const executionPlanCandidate =
      candidate.execution_plan && typeof candidate.execution_plan === 'object'
        ? candidate.execution_plan as Record<string, unknown>
        : null;
    const executionPlanSteps = executionPlanCandidate
      ? toExecutionPlanSteps(executionPlanCandidate.steps)
      : toExecutionPlanSteps(candidate.steps);

    const normalizedDeliverables = deliverables.length > 0
      ? deliverables
      : toStringArray(candidate.target_artifacts).length > 0
        ? toStringArray(candidate.target_artifacts)
        : extractChangeActions(candidate.changes);

    const normalizedSuccessCriteria = successCriteria.length > 0
      ? successCriteria
      : toStringArray(candidate.output).length > 0
        ? toStringArray(candidate.output)
        : (typeof candidate.output === 'string' && candidate.output.trim())
          ? [candidate.output.trim()]
          : (typeof candidate.validation === 'string' && candidate.validation.trim())
            ? [candidate.validation.trim()]
            : toStringArray(candidate.checks);

    const normalizedConstraints = explicitConstraints || buildLooseSpecConstraints(candidate);

    return {
      title,
      summary,
      deliverables: normalizedDeliverables,
      success_criteria: normalizedSuccessCriteria,
      constraints: normalizedConstraints,
      execution_plan: executionPlanCandidate
        ? {
            approach: typeof executionPlanCandidate.approach === 'string'
              ? executionPlanCandidate.approach
              : typeof candidate.method === 'string'
                ? candidate.method
                : undefined,
            steps: executionPlanSteps,
          }
        : executionPlanSteps.length > 0 || typeof candidate.method === 'string'
          ? {
              approach: typeof candidate.method === 'string' ? candidate.method : undefined,
              steps: executionPlanSteps,
            }
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
