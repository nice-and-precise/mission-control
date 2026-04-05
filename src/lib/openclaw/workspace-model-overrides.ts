import { queryOne } from '@/lib/db';
import { supportsMissionControlAccounting, getAutopilotDefaultModel } from '@/lib/openclaw/model-policy';
import { isOpenClawAgentTarget, validateProviderModelOverride } from '@/lib/openclaw/model-catalog';

interface WorkspaceModelOverrideRow {
  autopilot_model_override?: string | null;
  planning_model_override?: string | null;
}

function normalizeModelOverride(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function validateWorkspaceOverrideModel(value: unknown): Promise<string | null> {
  const model = normalizeModelOverride(value);
  if (!model) {
    return null;
  }

  await validateProviderModelOverride(model);

  if (!isOpenClawAgentTarget(model) && !supportsMissionControlAccounting(model)) {
    throw new Error(
      `Provider model override "${model}" does not have accountable pricing metadata in Mission Control policy.`,
    );
  }

  return model;
}

export function getWorkspaceModelOverrides(workspaceId: string): WorkspaceModelOverrideRow {
  const row = queryOne<WorkspaceModelOverrideRow>(
    `SELECT autopilot_model_override, planning_model_override FROM workspaces WHERE id = ?`,
    [workspaceId],
  );

  return {
    autopilot_model_override: normalizeModelOverride(row?.autopilot_model_override),
    planning_model_override: normalizeModelOverride(row?.planning_model_override),
  };
}

export async function resolveAutopilotModelForWorkspace(workspaceId: string): Promise<string> {
  const fallback = getAutopilotDefaultModel();
  const { autopilot_model_override } = getWorkspaceModelOverrides(workspaceId);
  if (!autopilot_model_override) {
    return fallback;
  }
  return (await validateWorkspaceOverrideModel(autopilot_model_override)) || fallback;
}

export async function resolvePlanningModelForWorkspace(workspaceId: string): Promise<string> {
  const fallback = process.env.PLANNING_MODEL || getAutopilotDefaultModel();
  const { planning_model_override } = getWorkspaceModelOverrides(workspaceId);
  if (!planning_model_override) {
    return fallback;
  }
  return (await validateWorkspaceOverrideModel(planning_model_override)) || fallback;
}
