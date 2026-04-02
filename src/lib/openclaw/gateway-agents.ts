export type GatewayAgentModelConfig = {
  primary?: string;
  fallbacks?: string[];
  [key: string]: unknown;
};

export type GatewayAgentModel = string | GatewayAgentModelConfig | null;

export interface GatewayAgentLike {
  id?: string;
  name?: string;
  label?: string;
  model?: GatewayAgentModel;
  [key: string]: unknown;
}

export interface NormalizedGatewayAgentModel {
  primaryModel: string | null;
  rawModelConfig: Record<string, unknown> | null;
  warning?: string;
}

export interface NormalizedGatewayAgent extends GatewayAgentLike {
  gatewayId: string | null;
  displayName: string | null;
  primaryModel: string | null;
  rawModelConfig: Record<string, unknown> | null;
  warning?: string;
}

export function normalizeGatewayAgentModel(model: unknown): NormalizedGatewayAgentModel {
  if (typeof model === 'string') {
    const primaryModel = model.trim();
    return {
      primaryModel: primaryModel.length > 0 ? primaryModel : null,
      rawModelConfig: null,
    };
  }

  if (model == null) {
    return {
      primaryModel: null,
      rawModelConfig: null,
    };
  }

  if (typeof model === 'object' && !Array.isArray(model)) {
    const record = model as Record<string, unknown>;
    const primaryModel =
      typeof record.primary === 'string' && record.primary.trim().length > 0
        ? record.primary.trim()
        : null;
    const hasValidPrimary =
      record.primary === undefined
      || (typeof record.primary === 'string' && record.primary.trim().length > 0);
    const hasValidFallbacks =
      record.fallbacks === undefined
      || (Array.isArray(record.fallbacks) && record.fallbacks.every((entry) => typeof entry === 'string'));

    if (hasValidPrimary && hasValidFallbacks) {
      return {
        primaryModel,
        rawModelConfig: record,
      };
    }

    return {
      primaryModel,
      rawModelConfig: record,
      warning: 'Unsupported gateway model object shape',
    };
  }

  return {
    primaryModel: null,
    rawModelConfig: null,
    warning: `Unsupported gateway model value type: ${typeof model}`,
  };
}

export function normalizeGatewayAgent(agent: unknown): NormalizedGatewayAgent | null {
  if (!agent || typeof agent !== 'object') {
    return null;
  }

  const record = agent as GatewayAgentLike;
  const gatewayId = pickTrimmedString(record.id) || pickTrimmedString(record.name);
  const displayName = pickTrimmedString(record.name) || pickTrimmedString(record.label) || gatewayId;
  const normalizedModel = normalizeGatewayAgentModel(record.model);

  return {
    ...record,
    gatewayId,
    displayName,
    primaryModel: normalizedModel.primaryModel,
    rawModelConfig: normalizedModel.rawModelConfig,
    warning: normalizedModel.warning,
  };
}

function pickTrimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}
