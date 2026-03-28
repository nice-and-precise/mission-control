import { parseAgentSignal } from '@/lib/agent-signals';

const GATEWAY_HTTP_URL =
  process.env.OPENCLAW_GATEWAY_URL?.replace('ws://', 'http://').replace('wss://', 'https://') ||
  'http://127.0.0.1:18789';
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || '';
const DEFAULT_HISTORY_LIMIT = 100;

export interface GatewayTranscriptItem {
  role?: string;
  content?: unknown;
  timestamp?: number | string;
  message?: {
    role?: string;
    content?: unknown;
    errorMessage?: string;
    stopReason?: string;
    timestamp?: number | string;
  };
  errorMessage?: string;
  stopReason?: string;
}

export interface GatewaySessionHistoryPayload {
  sessionKey?: string;
  items?: GatewayTranscriptItem[];
  messages?: GatewayTranscriptItem[];
  hasMore?: boolean;
  nextCursor?: string | null;
}

export type GatewayTaskRunOutcome =
  | {
      kind: 'signal';
      message: string;
    }
  | {
      kind: 'runtime_blocked';
      message: string;
      error: string;
    }
  | {
      kind: 'none';
    };

export interface GatewayRunWindowInspection {
  outcome: GatewayTaskRunOutcome;
  hasActivity: boolean;
}

type GatewaySessionHistoryResolver = (
  sessionKeyOrId: string,
  limit: number,
) => Promise<GatewaySessionHistoryPayload>;

let gatewaySessionHistoryResolverForTests: GatewaySessionHistoryResolver | null = null;

export function setGatewaySessionHistoryResolverForTests(
  resolver: GatewaySessionHistoryResolver | null,
): void {
  gatewaySessionHistoryResolverForTests = resolver;
}

export async function loadGatewaySessionHistory(
  sessionKeyOrId: string,
  limit = DEFAULT_HISTORY_LIMIT,
): Promise<GatewaySessionHistoryPayload> {
  if (gatewaySessionHistoryResolverForTests) {
    return gatewaySessionHistoryResolverForTests(sessionKeyOrId, limit);
  }

  if (!GATEWAY_TOKEN) {
    throw new Error('OPENCLAW_GATEWAY_TOKEN is not configured for session history lookups.');
  }

  const url = new URL(
    `/sessions/${encodeURIComponent(sessionKeyOrId)}/history`,
    `${GATEWAY_HTTP_URL.replace(/\/$/, '')}/`,
  );
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('includeTools', '1');

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${GATEWAY_TOKEN}`,
    },
    cache: 'no-store',
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gateway session history lookup failed (${response.status}): ${errorText}`);
  }

  return response.json() as Promise<GatewaySessionHistoryPayload>;
}

export async function resolveTaskRunOutcomeFromGatewayHistory(args: {
  sessionKey: string;
  sessionId?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  limit?: number;
}): Promise<GatewayTaskRunOutcome> {
  return (await inspectGatewayRunWindowFromGatewayHistory(args)).outcome;
}

export async function inspectGatewayRunWindowFromGatewayHistory(args: {
  sessionKey: string;
  sessionId?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  limit?: number;
}): Promise<GatewayRunWindowInspection> {
  const sessionRefs = [args.sessionId, args.sessionKey]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .filter((value, index, values) => values.indexOf(value) === index);
  const payload = await loadGatewaySessionHistoryWithFallback(
    sessionRefs,
    args.limit || DEFAULT_HISTORY_LIMIT,
  );
  const items = filterTranscriptItemsToRunWindow(
    getTranscriptItems(payload),
    args.startedAt || null,
    args.endedAt || null,
  );
  const hasActivity = items.length > 0;

  for (const item of items) {
    const role = getItemRole(item);
    if (role !== 'assistant') continue;

    const text = extractTextContent(item);
    if (!text) continue;

    const signalMessage = findSignalMessage(text);
    if (signalMessage) {
      return {
        hasActivity,
        outcome: {
          kind: 'signal',
          message: signalMessage,
        },
      };
    }
  }

  for (const item of items) {
    const role = getItemRole(item);
    if (role !== 'assistant') continue;

    const runtimeError = extractRuntimeError(item);
    if (runtimeError) {
      return {
        hasActivity,
        outcome: {
          kind: 'runtime_blocked',
          error: runtimeError,
          message: `BLOCKED: OpenClaw runtime failure: ${runtimeError}`,
        },
      };
    }
  }

  return {
    hasActivity,
    outcome: { kind: 'none' },
  };
}

async function loadGatewaySessionHistoryWithFallback(
  sessionRefs: string[],
  limit: number,
): Promise<GatewaySessionHistoryPayload> {
  let lastError: Error | null = null;

  for (const sessionRef of sessionRefs) {
    try {
      return await loadGatewaySessionHistory(sessionRef, limit);
    } catch (error) {
      lastError = error as Error;
    }
  }

  throw lastError || new Error('No session reference was available for gateway history lookup.');
}

function getTranscriptItems(payload: GatewaySessionHistoryPayload): GatewayTranscriptItem[] {
  const items = Array.isArray(payload.items) ? payload.items : [];
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const source = items.length > 0 ? items : messages;
  return [...source].reverse();
}

function filterTranscriptItemsToRunWindow(
  items: GatewayTranscriptItem[],
  startedAt: string | null,
  endedAt: string | null,
): GatewayTranscriptItem[] {
  const startedAtMs = normalizeGatewayTimestamp(startedAt);
  const endedAtMs = normalizeGatewayTimestamp(endedAt);

  if (!startedAtMs && !endedAtMs) {
    return items;
  }

  const filtered = items.filter((item) => {
    const timestamp = getItemTimestamp(item);
    if (timestamp === null) {
      return true;
    }

    if (startedAtMs !== null && timestamp < startedAtMs) {
      return false;
    }

    if (endedAtMs !== null && timestamp > endedAtMs) {
      return false;
    }

    return true;
  });

  return filtered.length > 0 ? filtered : items;
}

function getItemRole(item: GatewayTranscriptItem): string | null {
  const role = optionalString(item.role) || optionalString(item.message?.role);
  return role ? role.toLowerCase() : null;
}

function getItemTimestamp(item: GatewayTranscriptItem): number | null {
  return normalizeGatewayTimestamp(item.timestamp) ?? normalizeGatewayTimestamp(item.message?.timestamp);
}

function extractTextContent(item: GatewayTranscriptItem): string {
  return extractContentText(item.content) || extractContentText(item.message?.content) || '';
}

function extractContentText(content: unknown): string {
  if (typeof content === 'string') return content.trim();

  if (Array.isArray(content)) {
    return content
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return '';
        const record = entry as Record<string, unknown>;
        return typeof record.text === 'string' ? record.text : '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  return '';
}

function findSignalMessage(text: string): string | null {
  const normalized = text.trim();
  if (!normalized) return null;

  if (parseAgentSignal(normalized)) {
    return normalized;
  }

  const lines = normalized
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse();

  for (const line of lines) {
    if (parseAgentSignal(line)) {
      return line;
    }
  }

  return null;
}

function extractRuntimeError(item: GatewayTranscriptItem): string | null {
  const errorMessage =
    optionalString(item.errorMessage) || optionalString(item.message?.errorMessage);
  if (errorMessage) {
    return compactWhitespace(errorMessage);
  }

  const stopReason =
    optionalString(item.stopReason)?.toLowerCase() ||
    optionalString(item.message?.stopReason)?.toLowerCase() ||
    null;

  if (stopReason === 'error') {
    return 'agent run stopped with stopReason=error before emitting a workflow marker';
  }

  return null;
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function normalizeGatewayTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const numericValue = Number(value);
    if (Number.isFinite(numericValue)) {
      return numericValue;
    }

    const parsedValue = Date.parse(value);
    if (!Number.isNaN(parsedValue)) {
      return parsedValue;
    }
  }

  return null;
}
