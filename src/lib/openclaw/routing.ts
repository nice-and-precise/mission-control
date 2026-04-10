import type { Agent } from '@/lib/types';

export const DEFAULT_SESSION_KEY_PREFIX = 'agent:main:';
export const BUILDER_SESSION_KEY_PREFIX = 'agent:coder:';

type AgentRoutingInfo = Partial<Pick<Agent, 'role' | 'session_key_prefix'>> | null | undefined;
type AgentIdentityInfo = Pick<Agent, 'id' | 'name'>;

function slugifySessionSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'agent';
}

export function inferSessionKeyPrefixFromRole(role?: string | null): string {
  switch ((role || '').trim().toLowerCase()) {
    case 'builder':
      return BUILDER_SESSION_KEY_PREFIX;
    default:
      return DEFAULT_SESSION_KEY_PREFIX;
  }
}

export function normalizeSessionKeyPrefix(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.endsWith(':') ? trimmed : `${trimmed}:`;
}

export function getAgentSessionKeyPrefix(agent?: AgentRoutingInfo): string {
  const explicitPrefix = normalizeSessionKeyPrefix(agent?.session_key_prefix);
  if (explicitPrefix) {
    return explicitPrefix;
  }

  return inferSessionKeyPrefixFromRole(agent?.role);
}

export function buildAgentSessionKey(
  openclawSessionId: string,
  agent?: AgentRoutingInfo,
): string {
  return `${getAgentSessionKeyPrefix(agent)}${openclawSessionId}`;
}

export function buildPersistentAgentSessionId(agent: AgentIdentityInfo): string {
  return `mission-control-${slugifySessionSegment(agent.name)}-${agent.id.slice(0, 8)}`;
}
