import type { OpenClawProviderModel } from '@/lib/types';

export type PricingKind = 'token' | 'flat_request' | 'none';

interface ModelPricing {
  kind: PricingKind;
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
  estimatedUsdPerRequest?: number;
  note: string;
}

export interface MissionControlModelPolicy {
  id: string;
  label: string;
  policy_allowed: boolean;
  policy_reason?: string;
  priced: boolean;
  provider_family: string;
  pricing: ModelPricing;
}

const OPENCODE_GO_GLM5_USD_PER_REQUEST = 12 / 1150;
const OPENCODE_GO_KIMI_USD_PER_REQUEST = 12 / 1850;
const OPENCODE_GO_MINIMAX_M25_USD_PER_REQUEST = 12 / 20000;
const QWEN36_PLUS_INPUT_USD_PER_MILLION = 0.50;
const QWEN36_PLUS_OUTPUT_USD_PER_MILLION = 3.00;
const QWEN36_PLUS_CACHE_READ_USD_PER_MILLION = 0.05;
const QWEN36_PLUS_CACHE_WRITE_USD_PER_MILLION = 0.625;

/** Single source of truth for the default autopilot model. Change here to switch globally. */
const DEFAULT_AUTOPILOT_MODEL = 'qwen/qwen3.6-plus';

const MODEL_ID_ALIASES: Record<string, string> = {
  'qwen/qwen3.6-plus:free': 'qwen/qwen3.6-plus',
  'qwen/qwen3.6-plus-preview:free': 'qwen/qwen3.6-plus',
  'qwen/qwen3.5-plus-02-15': 'qwen/qwen3.6-plus',
  'qwen/qwen3.5-35b-a3b': 'qwen/qwen3.6-plus',
  'qwen/qwen3-max-thinking': 'qwen/qwen3.6-plus',
  'openrouter/qwen/qwen3.6-plus:free': 'qwen/qwen3.6-plus',
  'openrouter/qwen/qwen3.6-plus-preview:free': 'qwen/qwen3.6-plus',
  'openrouter/qwen/qwen3.5-plus-02-15': 'qwen/qwen3.6-plus',
  'openrouter/qwen/qwen3.5-35b-a3b': 'qwen/qwen3.6-plus',
  'openrouter/qwen/qwen3-max-thinking': 'qwen/qwen3.6-plus',
  'opencode/qwen3.6-plus-free': 'qwen/qwen3.6-plus',
  'nvidia/nemotron-3-super-120b-a12b:free': 'openrouter/nvidia/nemotron-3-super-120b-a12b:free',
};

export function canonicalMissionControlModelId(modelId: string): string {
  return MODEL_ID_ALIASES[modelId] || modelId;
}

const DOCS_BACKED_MODEL_POLICIES: MissionControlModelPolicy[] = [
  {
    id: 'openai-codex/gpt-5.3-codex-spark',
    label: 'openai-codex/gpt-5.3-codex-spark',
    policy_allowed: true,
    policy_reason: 'Entitlement-dependent Codex Spark model. Mission Control only surfaces it when runtime discovery returns it, and it remains blocked for spend-producing work until accountable pricing metadata exists.',
    provider_family: 'openai-codex',
    priced: false,
    pricing: {
      kind: 'none',
      note: 'No accountable Mission Control pricing metadata is configured for Codex Spark.',
    },
  },
  {
    id: 'openai-codex/gpt-5.4',
    label: 'openai-codex/gpt-5.4',
    policy_allowed: true,
    provider_family: 'openai-codex',
    priced: true,
    pricing: {
      kind: 'token',
      inputUsdPerMillion: 2.5,
      outputUsdPerMillion: 10,
      note: 'Estimated using current GPT-5.4 token pricing as Mission Control accounting metadata.',
    },
  },
  {
    id: 'opencode-go/kimi-k2.5',
    label: 'opencode-go/kimi-k2.5',
    policy_allowed: true,
    provider_family: 'opencode-go',
    priced: true,
    pricing: {
      kind: 'flat_request',
      estimatedUsdPerRequest: OPENCODE_GO_KIMI_USD_PER_REQUEST,
      note: 'Estimated from OpenCode Go documented $12 per 5-hour window and 1,850 Kimi K2.5 requests per window.',
    },
  },
  {
    id: 'opencode-go/glm-5',
    label: 'opencode-go/glm-5',
    policy_allowed: true,
    provider_family: 'opencode-go',
    priced: true,
    pricing: {
      kind: 'flat_request',
      estimatedUsdPerRequest: OPENCODE_GO_GLM5_USD_PER_REQUEST,
      note: 'Estimated from OpenCode Go documented $12 per 5-hour window and 1,150 GLM-5 requests per window.',
    },
  },
  {
    id: 'opencode-go-mm/minimax-m2.5',
    label: 'opencode-go-mm/minimax-m2.5',
    policy_allowed: true,
    provider_family: 'opencode-go-mm',
    priced: true,
    pricing: {
      kind: 'flat_request',
      estimatedUsdPerRequest: OPENCODE_GO_MINIMAX_M25_USD_PER_REQUEST,
      note: 'Estimated from OpenCode Go documented $12 per 5-hour window and 20,000 MiniMax M2.5 requests per window.',
    },
  },
  {
    id: 'qwen/qwen3.6-plus',
    label: 'qwen/qwen3.6-plus',
    policy_allowed: true,
    provider_family: 'qwen',
    priced: true,
    pricing: {
      kind: 'token',
      inputUsdPerMillion: QWEN36_PLUS_INPUT_USD_PER_MILLION,
      outputUsdPerMillion: QWEN36_PLUS_OUTPUT_USD_PER_MILLION,
      note: 'Alibaba Cloud Qwen 3.6 Plus Standard international pricing (2026-04). $0.50/M input, $3.00/M output, $0.05/M cache read, $0.625/M cache write.',
    },
  },
];

const POLICY_BY_ID = new Map(DOCS_BACKED_MODEL_POLICIES.map((entry) => [entry.id, entry]));

function providerFamilyForModel(modelId: string): string {
  const slash = modelId.indexOf('/');
  return slash === -1 ? modelId : modelId.slice(0, slash);
}

export function getMissionControlModelPolicy(modelId: string): MissionControlModelPolicy {
  const canonicalId = canonicalMissionControlModelId(modelId);
  const policy = POLICY_BY_ID.get(canonicalId);
  if (policy) {
    return policy;
  }

  return {
    id: canonicalId,
    label: canonicalId,
    policy_allowed: false,
    policy_reason: 'Not in the Mission Control docs-backed model policy allowlist.',
    provider_family: providerFamilyForModel(canonicalId),
    priced: false,
    pricing: {
      kind: 'none',
      note: 'No Mission Control accounting metadata is configured for this model.',
    },
  };
}

export function listMissionControlPolicyModels(): MissionControlModelPolicy[] {
  return [...DOCS_BACKED_MODEL_POLICIES];
}

export function getDispatchDefaultModelForRole(role?: string | null): string {
  switch ((role || '').trim().toLowerCase()) {
    case 'reviewer':
    case 'builder':
    case 'tester':
    case 'learner':
      return 'qwen/qwen3.6-plus';
    default:
      return getAutopilotDefaultModel();
  }
}

export function getAutopilotDefaultModel(): string {
  return process.env.AUTOPILOT_MODEL || DEFAULT_AUTOPILOT_MODEL;
}

export function supportsMissionControlAccounting(modelId: string): boolean {
  return getMissionControlModelPolicy(modelId).priced;
}

export function getMissionControlPricingKind(modelId: string): PricingKind {
  return getMissionControlModelPolicy(modelId).pricing.kind;
}

export function supportsProviderActualAccounting(modelId: string): boolean {
  const policy = getMissionControlModelPolicy(modelId);
  return policy.priced && policy.pricing.kind === 'token';
}

export function supportsMissionEstimateAccounting(modelId: string): boolean {
  const policy = getMissionControlModelPolicy(modelId);
  return policy.priced && policy.pricing.kind === 'flat_request';
}

export function estimateMissionControlModelCost(
  modelId: string,
  usage?: { promptTokens?: number; completionTokens?: number; requestCount?: number },
): number | null {
  const policy = getMissionControlModelPolicy(modelId);

  if (!policy.priced) {
    return null;
  }

  if (policy.pricing.kind === 'flat_request') {
    return (usage?.requestCount || 1) * (policy.pricing.estimatedUsdPerRequest || 0);
  }

  if (policy.pricing.kind === 'token') {
    const promptTokens = usage?.promptTokens || 0;
    const completionTokens = usage?.completionTokens || 0;
    return ((promptTokens / 1_000_000) * (policy.pricing.inputUsdPerMillion || 0))
      + ((completionTokens / 1_000_000) * (policy.pricing.outputUsdPerMillion || 0));
  }

  return null;
}

export function toPolicyOnlyProviderModel(modelId: string): OpenClawProviderModel {
  const policy = getMissionControlModelPolicy(modelId);
  return {
    id: policy.id,
    label: policy.label,
    policy_allowed: policy.policy_allowed,
    policy_reason: policy.policy_reason,
    priced: policy.priced,
    provider_family: policy.provider_family,
    discovery_source: 'policy',
    discovered: false,
  };
}
