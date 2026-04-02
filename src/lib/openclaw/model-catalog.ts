import { existsSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { getOpenClawClient } from './client';
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

const FALLBACK_PROVIDER_MODELS: OpenClawProviderModel[] = [
  { id: 'anthropic/claude-sonnet-4-5', label: 'anthropic/claude-sonnet-4-5' },
  { id: 'anthropic/claude-opus-4-5', label: 'anthropic/claude-opus-4-5' },
  { id: 'anthropic/claude-haiku-4-5', label: 'anthropic/claude-haiku-4-5' },
  { id: 'openai/gpt-4o', label: 'openai/gpt-4o' },
  { id: 'openai/o1', label: 'openai/o1' },
];

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
        models.push({ id, label: model.name?.trim() || id });
      }
    }
  }

  if (config?.agents?.defaults?.models) {
    for (const [id, modelConfig] of Object.entries(config.agents.defaults.models)) {
      models.push({ id, label: modelConfig.alias?.trim() || id });
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
      providerModels: extractProviderModelsFromConfig(gatewayConfig?.config),
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
      providerModels: extractProviderModelsFromConfig(config),
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
      providerModels: FALLBACK_PROVIDER_MODELS,
      source: 'fallback',
    };
  }

  return result;
}

export async function validateProviderModelOverride(model: string): Promise<void> {
  if (isOpenClawAgentTarget(model)) {
    return;
  }

  const catalog = await loadOpenClawModelCatalog('auto');
  const allowed = new Set(catalog.providerModels.map((entry) => entry.id));
  if (!allowed.has(model)) {
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
