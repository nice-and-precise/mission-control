import { parseAgentSignal } from '@/lib/agent-signals';
import { getOpenClawClient } from './client';

const DEFAULT_HISTORY_LIMIT = 100;
const OVERSIZED_HISTORY_PLACEHOLDER = '[chat.history omitted: message too large]';

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
  sessionId?: string;
  sessionKey?: string;
  items?: GatewayTranscriptItem[];
  messages?: GatewayTranscriptItem[];
  hasMore?: boolean;
  nextCursor?: string | null;
}

export interface NormalizedGatewaySessionHistory {
  sessionRef: string;
  resolvedSessionKey: string | null;
  resolvedSessionId: string | null;
  items: GatewayTranscriptItem[];
  hasMore: boolean;
  nextCursor: string | null;
  source: 'chat.history';
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
) => Promise<GatewaySessionHistoryPayload | NormalizedGatewaySessionHistory>;

let gatewaySessionHistoryResolverForTests: GatewaySessionHistoryResolver | null = null;

export function setGatewaySessionHistoryResolverForTests(
  resolver: GatewaySessionHistoryResolver | null,
): void {
  gatewaySessionHistoryResolverForTests = resolver;
}

export async function loadGatewaySessionHistory(
  sessionKeyOrId: string,
  limit = DEFAULT_HISTORY_LIMIT,
  options?: { includeTools?: boolean },
): Promise<NormalizedGatewaySessionHistory> {
  if (gatewaySessionHistoryResolverForTests) {
    const payload = await gatewaySessionHistoryResolverForTests(sessionKeyOrId, limit);
    const normalized = normalizeGatewaySessionHistoryPayload(sessionKeyOrId, payload);
    return {
      ...normalized,
      items: options?.includeTools ? normalized.items : stripToolEvents(normalized.items),
    };
  }

  const client = getOpenClawClient();
  if (!client.isConnected()) {
    await client.connect();
  }

  const resolvedSession = await resolveGatewaySessionForHistory(sessionKeyOrId);
  const payload = await client.call<unknown>('chat.history', {
    sessionKey: resolvedSession.sessionKey,
    limit,
  });
  const normalized = normalizeGatewaySessionHistoryPayload(sessionKeyOrId, payload);
  const items = options?.includeTools ? normalized.items : stripToolEvents(normalized.items);

  return {
    ...normalized,
    resolvedSessionKey: resolvedSession.sessionKey,
    resolvedSessionId: resolvedSession.sessionId,
    items,
  };
}

export function normalizeGatewaySessionHistoryPayload(
  sessionRef: string,
  payload: GatewaySessionHistoryPayload | NormalizedGatewaySessionHistory | unknown,
): NormalizedGatewaySessionHistory {
  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const items = Array.isArray(record.items)
    ? record.items as GatewayTranscriptItem[]
    : Array.isArray(record.messages)
      ? record.messages as GatewayTranscriptItem[]
      : Array.isArray(payload)
        ? payload as GatewayTranscriptItem[]
        : [];

  return {
    sessionRef,
    resolvedSessionKey:
      optionalString(record.resolvedSessionKey) ||
      optionalString(record.sessionKey) ||
      optionalString(record.session_key) ||
      (sessionRef.includes(':') ? sessionRef : null),
    resolvedSessionId:
      optionalString(record.resolvedSessionId) ||
      optionalString(record.sessionId) ||
      optionalString(record.session_id) ||
      (!sessionRef.includes(':') ? sessionRef : null),
    items,
    hasMore: Boolean(record.hasMore),
    nextCursor: optionalString(record.nextCursor),
    source: 'chat.history',
  };
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
      const payload = await loadGatewaySessionHistory(sessionRef, limit, { includeTools: true });
      return {
        sessionId: payload.resolvedSessionId || undefined,
        sessionKey: payload.resolvedSessionKey || undefined,
        items: payload.items,
        hasMore: payload.hasMore,
        nextCursor: payload.nextCursor,
      };
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

async function resolveGatewaySessionForHistory(sessionKeyOrId: string): Promise<{
  sessionKey: string;
  sessionId: string | null;
}> {
  if (sessionKeyOrId.includes(':')) {
    return {
      sessionKey: sessionKeyOrId,
      sessionId: null,
    };
  }

  const client = getOpenClawClient();
  const sessions = await client.listSessions();
  const session = sessions.find((candidate) => {
    const candidateId = optionalString(candidate.sessionId) || optionalString(candidate.id);
    return candidateId === sessionKeyOrId;
  });

  if (!session?.key) {
    throw new Error(`Unable to resolve OpenClaw session key for session reference: ${sessionKeyOrId}`);
  }

  return {
    sessionKey: session.key,
    sessionId: optionalString(session.sessionId) || optionalString(session.id),
  };
}

function stripToolEvents(items: GatewayTranscriptItem[]): GatewayTranscriptItem[] {
  return items.flatMap((item) => {
    const role = getItemRole(item);
    if (role === 'toolresult' || role === 'tool') {
      return [];
    }

    const filteredItem = stripToolContentFromItem(item);
    if (!filteredItem) {
      return [];
    }

    return [filteredItem];
  });
}

function stripToolContentFromItem(item: GatewayTranscriptItem): GatewayTranscriptItem | null {
  const nextItem: GatewayTranscriptItem = {
    ...item,
    message: item.message ? { ...item.message } : undefined,
  };

  const filteredContent = stripToolContent(item.content);
  if (filteredContent !== undefined) {
    nextItem.content = filteredContent;
  }

  if (nextItem.message) {
    const filteredMessageContent = stripToolContent(nextItem.message.content);
    if (filteredMessageContent !== undefined) {
      nextItem.message.content = filteredMessageContent;
    }
  }

  const hasStandaloneContent = hasRenderableContent(nextItem.content);
  const hasMessageContent = hasRenderableContent(nextItem.message?.content);
  const hasMessageMetadata =
    optionalString(nextItem.message?.errorMessage) || optionalString(nextItem.message?.stopReason);
  const hasItemMetadata = optionalString(nextItem.errorMessage) || optionalString(nextItem.stopReason);

  if (!hasStandaloneContent && !hasMessageContent && !hasMessageMetadata && !hasItemMetadata) {
    return null;
  }

  return nextItem;
}

function stripToolContent(content: unknown): unknown {
  if (!Array.isArray(content)) {
    return content;
  }

  const filtered = content.filter((entry) => {
    if (!entry || typeof entry !== 'object') return true;
    const record = entry as Record<string, unknown>;
    return record.type !== 'toolCall' && record.type !== 'toolResult';
  });

  return filtered;
}

function hasRenderableContent(content: unknown): boolean {
  if (typeof content === 'string') {
    return content.trim().length > 0;
  }

  if (Array.isArray(content)) {
    return content.some((entry) => {
      if (typeof entry === 'string') {
        return entry.trim().length > 0;
      }
      if (!entry || typeof entry !== 'object') {
        return false;
      }
      const record = entry as Record<string, unknown>;
      return (
        (typeof record.text === 'string' && record.text.trim().length > 0) ||
        (typeof record.thinking === 'string' && record.thinking.trim().length > 0)
      );
    });
  }

  return false;
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

export function extractTextContent(item: GatewayTranscriptItem): string {
  return extractContentText(item.content) || extractContentText(item.message?.content) || '';
}

export function extractContentText(content: unknown): string {
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

export function hasOversizedHistoryOmission(items: GatewayTranscriptItem[]): boolean {
  return items.some((item) => extractTextContent(item).includes(OVERSIZED_HISTORY_PLACEHOLDER));
}

export function getOversizedHistoryOmissionMessage(): string {
  return 'OpenClaw omitted one or more oversized transcript entries from session history. Planning recovery needs the full transcript.';
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
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
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
