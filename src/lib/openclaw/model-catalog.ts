import { existsSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { getOpenClawClient } from './client';
import { getMissionControlModelPolicy, listMissionControlPolicyModels, toPolicyOnlyProviderModel } from './model-policy';
import type { OpenClawAgentTarget, OpenClawModelsResponse, OpenClawProviderModel } from '@/lib/types';

const MAX_CONFIG_SIZE_BYTES = 1024 * 1024;

interface LocalOpenClawConfig {
  agents?: {
    defaults?: {
      model?: {
        primary?: string;
        fallbacks?: string[];
      };
      models?: Record<string, {
        alias?: string;
      }>;
    };
  };
  models?: {
    providers?: Record<string, {
      models?: Array<{
        id: string;
        name?: string;
      }>;
    }>;
  };
}

export interface GatewayConfigSnapshot {
  config?: LocalOpenClawConfig;
}

export interface OpenClawModelCatalog {
  defaultAgentTarget?: string;
  defaultProviderModel?: string;
  agentTargets: OpenClawAgentTarget[];
  providerModels: OpenClawProviderModel[];
  source: 'remote' | 'local' | 'fallback';
}

const FALLBACK_PROVIDER_MODELS: OpenClawProviderModel[] = listMissionControlPolicyModels().map((policy) =>
  toPolicyOnlyProviderModel(policy.id),
);

function uniqueSortedAgentTargets(targets: OpenClawAgentTarget[]): OpenClawAgentTarget[] {
  const seen = new Map<string, OpenClawAgentTarget>();
  for (const target of targets) {
    if (!target.id) continue;
    seen.set(target.id, target);
  }
  return Array.from(seen.values()).sort((a, b) => a.id.localeCompare(b.id));
}

function uniqueSortedProviderModels(models: OpenClawProviderModel[]): OpenClawProviderModel[] {
  const seen = new Map<string, OpenClawProviderModel>();
  for (const model of models) {
    if (!model.id) continue;
    seen.set(model.id, model);
  }
  return Array.from(seen.values()).sort((a, b) => a.id.localeCompare(b.id));
}

export function normalizeAgentTargets(agentIds: string[]): OpenClawAgentTarget[] {
  const dynamicTargets = agentIds
    .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    .map((id) => ({
      id: `openclaw/${id}`,
      label: `openclaw/${id}`,
    }));

  return uniqueSortedAgentTargets([
    { id: 'openclaw', label: 'openclaw' },
    { id: 'openclaw/default', label: 'openclaw/default' },
    ...dynamicTargets,
  ]);
}

export function extractProviderModelsFromConfig(config: LocalOpenClawConfig | undefined): OpenClawProviderModel[] {
  const models: OpenClawProviderModel[] = [];

  if (config?.models?.providers) {
    for (const [providerName, provider] of Object.entries(config.models.providers)) {
      for (const model of provider.models || []) {
        const id = `${providerName}/${model.id}`;
        models.push(buildDiscoveredProviderModel(id, model.name?.trim() || id, 'local'));
      }
    }
  }

  if (config?.agents?.defaults?.models) {
    for (const [id, modelConfig] of Object.entries(config.agents.defaults.models)) {
      models.push(buildDiscoveredProviderModel(id, modelConfig.alias?.trim() || id, 'local'));
    }
  }

  return uniqueSortedProviderModels(models);
}

export function extractDefaultProviderModel(config: LocalOpenClawConfig | undefined): string | undefined {
  return config?.agents?.defaults?.model?.primary;
}

export function isOpenClawAgentTarget(model: string): boolean {
  return model === 'openclaw'
    || model === 'openclaw/default'
    || model.startsWith('openclaw/')
    || model.startsWith('agent:');
}

export async function discoverRemoteModelCatalog(): Promise<OpenClawModelCatalog | null> {
  try {
    const client = getOpenClawClient();
    if (!client.isConnected()) {
      await client.connect();
    }

    const [agents, config] = await Promise.all([
      client.listAgents().catch(() => []),
      client.getConfig().catch(() => null),
    ]);
    const gatewayConfig = (config && typeof config === 'object' ? config as GatewayConfigSnapshot : null);

    const agentIds = agents
      .map((agent) => {
        if (!agent || typeof agent !== 'object') return null;
        const record = agent as Record<string, unknown>;
        const id = typeof record.id === 'string' ? record.id.trim() : '';
        return id || null;
      })
      .filter((id): id is string => Boolean(id));

    return {
      defaultAgentTarget: 'openclaw',
      defaultProviderModel: extractDefaultProviderModel(gatewayConfig?.config),
      agentTargets: normalizeAgentTargets(agentIds),
      providerModels: mergeProviderModels(extractProviderModelsFromConfig(gatewayConfig?.config), 'remote'),
      source: 'remote',
    };
  } catch (error) {
    console.warn('[models] Remote discovery failed:', error instanceof Error ? error.message : error);
    return null;
  }
}

export function discoverLocalModelCatalog(): OpenClawModelCatalog | null {
  const configPath = join(homedir(), '.openclaw', 'openclaw.json');

  try {
    if (!existsSync(configPath)) {
      return null;
    }

    const stats = statSync(configPath);
    if (stats.size > MAX_CONFIG_SIZE_BYTES) {
      console.warn(`[models] Local config too large (${(stats.size / 1024).toFixed(0)}KB), skipping`);
      return null;
    }

    const configContent = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(configContent) as LocalOpenClawConfig;

    return {
      defaultAgentTarget: 'openclaw',
      defaultProviderModel: extractDefaultProviderModel(config),
      agentTargets: normalizeAgentTargets([]),
      providerModels: mergeProviderModels(extractProviderModelsFromConfig(config), 'local'),
      source: 'local',
    };
  } catch (error) {
    console.warn('[models] Local discovery failed:', error instanceof Error ? error.message : error);
    return null;
  }
}

export async function loadOpenClawModelCatalog(mode: string): Promise<OpenClawModelCatalog> {
  let result: OpenClawModelCatalog | null = null;

  if (mode === 'remote' || mode === 'auto') {
    result = await discoverRemoteModelCatalog();
  }

  if (!result && (mode === 'local' || mode === 'auto')) {
    result = discoverLocalModelCatalog();
  }

  if (!result) {
    result = {
      defaultAgentTarget: 'openclaw',
      defaultProviderModel: undefined,
      agentTargets: normalizeAgentTargets([]),
      providerModels: mergeProviderModels(FALLBACK_PROVIDER_MODELS, 'fallback'),
      source: 'fallback',
    };
  }

  return result;
}

export async function validateProviderModelOverride(model: string): Promise<void> {
  if (isOpenClawAgentTarget(model)) {
    return;
  }

  const policy = getMissionControlModelPolicy(model);
  if (!policy.policy_allowed) {
    throw new Error(
      `Provider model override "${model}" is not allowed by the current OpenClaw agent policy. ` +
      `Use an agent target like "openclaw" or pick one of the configured provider models.`,
    );
  }
}

export function toOpenClawModelsResponse(catalog: OpenClawModelCatalog): OpenClawModelsResponse {
  return {
    defaultAgentTarget: catalog.defaultAgentTarget,
    defaultProviderModel: catalog.defaultProviderModel,
    agentTargets: catalog.agentTargets,
    providerModels: catalog.providerModels,
    source: catalog.source,
  };
}

function buildDiscoveredProviderModel(
  id: string,
  label: string,
  discoverySource: 'remote' | 'local' | 'fallback',
): OpenClawProviderModel {
  const policy = getMissionControlModelPolicy(id);
  return {
    id,
    label,
    policy_allowed: policy.policy_allowed,
    policy_reason: policy.policy_reason,
    priced: policy.priced,
    provider_family: policy.provider_family,
    discovery_source: discoverySource,
    discovered: true,
  };
}

function mergeProviderModels(
  discoveredModels: OpenClawProviderModel[],
  discoverySource: 'remote' | 'local' | 'fallback',
): OpenClawProviderModel[] {
  const merged = new Map<string, OpenClawProviderModel>();

  for (const discovered of discoveredModels) {
    const policy = getMissionControlModelPolicy(discovered.id);
    merged.set(discovered.id, {
      ...discovered,
      policy_allowed: policy.policy_allowed,
      policy_reason: policy.policy_reason,
      priced: policy.priced,
      provider_family: policy.provider_family,
      discovery_source: policy.policy_allowed ? (`policy+${discoverySource}` as OpenClawProviderModel['discovery_source']) : discoverySource,
      discovered: true,
    });
  }

  for (const policyModel of listMissionControlPolicyModels()) {
    if (policyModel.id === 'openai-codex/gpt-5.3-codex-spark') {
      continue;
    }
    if (!merged.has(policyModel.id)) {
      merged.set(policyModel.id, toPolicyOnlyProviderModel(policyModel.id));
    }
  }

  const sparkDiscovered = merged.has('openai-codex/gpt-5.3-codex-spark');
  if (sparkDiscovered) {
    const sparkPolicy = getMissionControlModelPolicy('openai-codex/gpt-5.3-codex-spark');
    merged.set('openai-codex/gpt-5.3-codex-spark', {
      ...(merged.get('openai-codex/gpt-5.3-codex-spark') as OpenClawProviderModel),
      policy_allowed: true,
      policy_reason: sparkPolicy.policy_reason || 'Entitlement-dependent Codex Spark model discovered at runtime.',
    });
  }

  return uniqueSortedProviderModels(Array.from(merged.values()));
}
