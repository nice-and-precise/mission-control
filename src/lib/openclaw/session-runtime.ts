import { queryAll, run } from '@/lib/db';
import { syncReservedSpendTotals } from '@/lib/costs/budget-policy';
import { recordCostEvent } from '@/lib/costs/tracker';
import { getOpenClawClient, type OpenClawClient } from './client';
import {
  canonicalMissionControlModelId,
  estimateMissionControlModelCost,
  getMissionControlPricingKind,
  supportsMissionEstimateAccounting,
  supportsProviderActualAccounting,
} from './model-policy';
import { buildAgentSessionKey } from './routing';
import type { GatewayConfigSnapshot } from './model-catalog';
import type { OpenClawSession, OpenClawSessionInfo } from '@/lib/types';

interface SessionRoutingRow extends OpenClawSession {
  role?: string | null;
  session_key_prefix?: string | null;
  workspace_id?: string | null;
  product_id?: string | null;
  task_status?: string | null;
}

interface ProviderCostMetadata {
  provider: string;
  modelId: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface SessionCostRecord {
  costUsd: number;
  tokensInput: number;
  tokensOutput: number;
  pricingBasis: 'token_priced' | 'request_estimate';
  ledgerType: 'provider_actual' | 'mission_estimate';
  provider: string;
}

interface UsageSnapshot {
  sessionKey: string;
  runtimeSessionId?: string;
  modelId?: string;
  modelProvider?: string;
  status?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  updatedAt?: number;
  endedAt?: number;
  externalId: string;
}

export interface SessionBindingResult {
  sessionKey: string;
  requestedModel: string;
  boundModel?: string;
  runtimeSessionId?: string;
  bindingStatus: 'bound' | 'failed';
  bindingError?: string;
  usageStart: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
}

export interface BuildUsageSyncSummary {
  priced: number;
  unpriced: number;
  pending: number;
  skipped: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function readString(record: Record<string, unknown> | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readNumber(record: Record<string, unknown> | null, key: string): number {
  const value = record?.[key];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}

function normalizeProviderModelId(model?: string | null, provider?: string | null): string | undefined {
  const normalizedModel = (model || '').trim();
  if (!normalizedModel) return undefined;
  if (normalizedModel.includes('/')) return canonicalMissionControlModelId(normalizedModel);
  const normalizedProvider = (provider || '').trim();
  return canonicalMissionControlModelId(
    normalizedProvider ? `${normalizedProvider}/${normalizedModel}` : normalizedModel,
  );
}

export function resolveOpenClawSessionKey(session: Pick<SessionRoutingRow, 'openclaw_session_id' | 'session_key' | 'role' | 'session_key_prefix'>): string {
  const persistedKey = (session.session_key || '').trim();
  if (persistedKey) {
    return persistedKey;
  }

  const storedSessionId = session.openclaw_session_id.trim();
  if (storedSessionId.startsWith('agent:')) {
    return storedSessionId;
  }

  return buildAgentSessionKey(storedSessionId, {
    role: session.role || undefined,
    session_key_prefix: session.session_key_prefix || undefined,
  });
}

function extractUsageSnapshot(raw: OpenClawSessionInfo, fallbackSessionKey?: string): UsageSnapshot | null {
  const record = asRecord(raw);
  const sessionKey = readString(record, 'key') || readString(record, 'sessionKey') || fallbackSessionKey;
  if (!sessionKey) {
    return null;
  }

  const modelProvider = readString(record, 'modelProvider');
  const modelId = normalizeProviderModelId(readString(record, 'model'), modelProvider);
  const inputTokens = readNumber(record, 'inputTokens');
  const outputTokens = readNumber(record, 'outputTokens');
  const cacheReadTokens = readNumber(record, 'cacheRead');
  const cacheWriteTokens = readNumber(record, 'cacheWrite');
  const updatedAt = readNumber(record, 'updatedAt') || undefined;
  const endedAt = readNumber(record, 'endedAt') || undefined;
  const status = readString(record, 'status');
  const runtimeSessionId = readString(record, 'sessionId') || readString(record, 'id');

  return {
    sessionKey,
    runtimeSessionId,
    modelId,
    modelProvider,
    status,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    updatedAt,
    endedAt,
    externalId: [
      sessionKey,
      runtimeSessionId || 'runtime:unknown',
      updatedAt || 0,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      modelId || 'model:unknown',
    ].join(':'),
  };
}

function extractProvidersConfig(snapshot: GatewayConfigSnapshot | Record<string, unknown> | null | undefined): Record<string, { models?: unknown[] }> {
  const snapshotRecord = asRecord(snapshot);
  const configRecord = asRecord(snapshotRecord?.config);
  const modelsRecord = asRecord(configRecord?.models);
  const providersRecord = asRecord(modelsRecord?.providers);
  if (providersRecord) {
    return providersRecord as Record<string, { models?: unknown[] }>;
  }

  return snapshotRecord as Record<string, { models?: unknown[] }> || {};
}

function findProviderCostMetadata(
  snapshot: GatewayConfigSnapshot | Record<string, unknown> | null | undefined,
  modelId?: string,
  providerHint?: string,
): ProviderCostMetadata | null {
  const normalizedModelId = (modelId || '').trim();
  if (!normalizedModelId) {
    return null;
  }

  const slashIndex = normalizedModelId.indexOf('/');
  const providerFromModel = slashIndex === -1 ? undefined : normalizedModelId.slice(0, slashIndex);
  const rawModelId = slashIndex === -1 ? normalizedModelId : normalizedModelId.slice(slashIndex + 1);
  const providers = extractProvidersConfig(snapshot);
  const providersToCheck = Array.from(new Set([providerHint, providerFromModel].filter(Boolean))) as string[];

  for (const providerName of providersToCheck) {
    const provider = providers[providerName];
    if (!provider || !Array.isArray(provider.models)) continue;

    for (const rawModel of provider.models) {
      const modelRecord = asRecord(rawModel);
      const candidateId = readString(modelRecord, 'id');
      if (!candidateId) continue;
      if (candidateId !== rawModelId && candidateId !== normalizedModelId) continue;

      const costRecord = asRecord(modelRecord?.cost);
      const input = readNumber(costRecord, 'input');
      const output = readNumber(costRecord, 'output');
      if (input <= 0 && output <= 0 && readNumber(costRecord, 'cacheRead') <= 0 && readNumber(costRecord, 'cacheWrite') <= 0) {
        return null;
      }

      return {
        provider: providerName,
        modelId: `${providerName}/${candidateId}`,
        input,
        output,
        cacheRead: readNumber(costRecord, 'cacheRead'),
        cacheWrite: readNumber(costRecord, 'cacheWrite'),
      };
    }
  }

  return null;
}

function computeUsageCostUsd(snapshot: UsageSnapshot, session: SessionRoutingRow, pricing: ProviderCostMetadata): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
} {
  const inputTokens = Math.max(snapshot.inputTokens - (session.usage_start_input_tokens || 0), 0);
  const outputTokens = Math.max(snapshot.outputTokens - (session.usage_start_output_tokens || 0), 0);
  const cacheReadTokens = Math.max(snapshot.cacheReadTokens - (session.usage_start_cache_read_tokens || 0), 0);
  const cacheWriteTokens = Math.max(snapshot.cacheWriteTokens - (session.usage_start_cache_write_tokens || 0), 0);

  const costUsd = ((inputTokens / 1_000_000) * pricing.input)
    + ((outputTokens / 1_000_000) * pricing.output)
    + ((cacheReadTokens / 1_000_000) * pricing.cacheRead)
    + ((cacheWriteTokens / 1_000_000) * pricing.cacheWrite);

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    costUsd,
  };
}

function shouldAwaitMoreUsage(session: SessionRoutingRow, snapshot: UsageSnapshot): boolean {
  const normalizedTaskStatus = (session.task_status || '').trim().toLowerCase();
  const normalizedSessionStatus = (session.status || '').trim().toLowerCase();
  const normalizedGatewayStatus = (snapshot.status || '').trim().toLowerCase();
  const taskStillExecuting = normalizedTaskStatus === 'assigned' || normalizedTaskStatus === 'in_progress';
  const sessionStillActive = normalizedSessionStatus === 'active'
    || normalizedGatewayStatus === 'active'
    || normalizedGatewayStatus === 'running'
    || normalizedGatewayStatus === 'streaming'
    || normalizedGatewayStatus === 'queued'
    || normalizedGatewayStatus === 'pending'
    || normalizedGatewayStatus === 'working';

  return taskStillExecuting && sessionStillActive;
}

function markUsagePending(sessionId: string, now: string, reason: string): void {
  run(
    `UPDATE openclaw_sessions
     SET usage_sync_status = 'pending',
         usage_sync_reason = ?,
         updated_at = ?
     WHERE id = ?`,
    [reason, now, sessionId],
  );
}

function markUsageUnpriced(session: SessionRoutingRow, now: string, reason: string, externalId: string): void {
  run(
    `UPDATE openclaw_sessions
     SET usage_external_id = ?,
         usage_sync_status = 'unpriced',
         usage_sync_reason = ?,
         usage_synced_at = ?,
         updated_at = ?
     WHERE id = ?`,
    [externalId, reason, now, now, session.id],
  );

  if (session.task_id) {
    run(
      `UPDATE tasks
       SET reserved_cost_usd = 0,
           budget_status = 'blocked',
           budget_block_reason = ?,
           updated_at = ?
       WHERE id = ?`,
      [reason, now, session.task_id],
    );
  }

  if (session.workspace_id) {
    syncReservedSpendTotals(session.workspace_id, session.product_id || undefined);
  }
}

function markZeroUsageReconciled(session: SessionRoutingRow, now: string, externalId: string): void {
  run(
    `UPDATE openclaw_sessions
     SET usage_external_id = ?,
         usage_sync_status = 'priced',
         usage_sync_reason = 'no_usage_delta',
         usage_synced_at = ?,
         updated_at = ?
     WHERE id = ?`,
    [externalId, now, now, session.id],
  );

  if (session.task_id) {
    run(
      `UPDATE tasks
       SET reserved_cost_usd = 0,
           budget_status = 'clear',
           budget_block_reason = NULL,
           updated_at = ?
       WHERE id = ?`,
      [now, session.task_id],
    );
  }

  if (session.workspace_id) {
    syncReservedSpendTotals(session.workspace_id, session.product_id || undefined);
  }
}

async function ensureClientReady(client: OpenClawClient): Promise<void> {
  if (!client.isConnected()) {
    await client.connect();
  }
}

export async function bindOpenClawSessionModel(args: {
  session: SessionRoutingRow;
  requestedModel: string;
  client?: OpenClawClient;
}): Promise<SessionBindingResult> {
  const client = args.client || getOpenClawClient();
  await ensureClientReady(client);

  const sessionKey = resolveOpenClawSessionKey(args.session);
  let patchResult: Record<string, unknown> = {};
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      patchResult = await client.patchSessionModel(sessionKey, args.requestedModel);
      lastError = null;
      break;
    } catch (err) {
      lastError = err as Error;
      if (attempt === 1 && /Request timeout: sessions\.patch/i.test(lastError.message || '')) {
        // One targeted retry after reconnect handles transient gateway stalls.
        client.forceReconnect();
        await ensureClientReady(client);
        continue;
      }
      throw err;
    }
  }
  if (lastError) {
    throw lastError;
  }

  const patchRecord = asRecord(patchResult);
  const resolvedRecord = asRecord(patchRecord?.resolved);
  const patchedKey = readString(patchRecord, 'key') || sessionKey;
  const confirmedSession = await client.getSessionByKey(patchedKey);
  const confirmedSnapshot = confirmedSession ? extractUsageSnapshot(confirmedSession, patchedKey) : null;
  const boundModel = normalizeProviderModelId(
    confirmedSnapshot?.modelId || readString(resolvedRecord, 'model'),
    confirmedSnapshot?.modelProvider || readString(resolvedRecord, 'modelProvider'),
  );

  if (!boundModel || boundModel !== args.requestedModel) {
    return {
      sessionKey: patchedKey,
      requestedModel: args.requestedModel,
      boundModel,
      runtimeSessionId: confirmedSnapshot?.runtimeSessionId || readString(asRecord(patchRecord?.entry), 'sessionId'),
      bindingStatus: 'failed',
      bindingError: boundModel
        ? `OpenClaw bound ${boundModel}, expected ${args.requestedModel}.`
        : `OpenClaw did not confirm the requested model ${args.requestedModel}.`,
      usageStart: {
        inputTokens: confirmedSnapshot?.inputTokens || 0,
        outputTokens: confirmedSnapshot?.outputTokens || 0,
        cacheReadTokens: confirmedSnapshot?.cacheReadTokens || 0,
        cacheWriteTokens: confirmedSnapshot?.cacheWriteTokens || 0,
      },
    };
  }

  return {
    sessionKey: patchedKey,
    requestedModel: args.requestedModel,
    boundModel,
    runtimeSessionId: confirmedSnapshot?.runtimeSessionId || readString(asRecord(patchRecord?.entry), 'sessionId'),
    bindingStatus: 'bound',
    usageStart: {
      inputTokens: confirmedSnapshot?.inputTokens || 0,
      outputTokens: confirmedSnapshot?.outputTokens || 0,
      cacheReadTokens: confirmedSnapshot?.cacheReadTokens || 0,
      cacheWriteTokens: confirmedSnapshot?.cacheWriteTokens || 0,
    },
  };
}

export function rememberOpenClawRunId(sessionKey: string, runId?: string | null): void {
  const normalizedKey = sessionKey.trim();
  const normalizedRunId = (runId || '').trim();
  if (!normalizedKey || !normalizedRunId) {
    return;
  }

  const now = new Date().toISOString();
  const activeRootUpdates = run(
    `UPDATE openclaw_sessions
     SET last_run_id = ?, updated_at = ?
     WHERE session_key = ?
       AND COALESCE(session_type, 'persistent') != 'subagent'
       AND status = 'active'`,
    [normalizedRunId, now, normalizedKey],
  ).changes;

  if (activeRootUpdates > 0) {
    return;
  }

  const fallbackRow = queryAll<{ id: string }>(
    `SELECT id
     FROM openclaw_sessions
     WHERE session_key = ?
       AND COALESCE(session_type, 'persistent') != 'subagent'
     ORDER BY updated_at DESC, created_at DESC
     LIMIT 1`,
    [normalizedKey],
  )[0];

  if (!fallbackRow?.id) {
    return;
  }

  run(
    `UPDATE openclaw_sessions
     SET last_run_id = ?, updated_at = ?
     WHERE id = ?`,
    [normalizedRunId, now, fallbackRow.id],
  );
}

export async function syncOpenClawBuildUsage(filters: {
  taskId?: string;
  workspaceId?: string;
  productId?: string;
  client?: OpenClawClient;
} = {}): Promise<BuildUsageSyncSummary> {
  const where: string[] = [
    `os.task_id IS NOT NULL`,
    `os.session_type != 'subagent'`,
    `COALESCE(os.binding_status, 'unbound') = 'bound'`,
  ];
  const params: unknown[] = [];

  if (filters.taskId) {
    where.push('os.task_id = ?');
    params.push(filters.taskId);
  }
  if (filters.workspaceId) {
    where.push('t.workspace_id = ?');
    params.push(filters.workspaceId);
  }
  if (filters.productId) {
    where.push('t.product_id = ?');
    params.push(filters.productId);
  }

  const sessions = queryAll<SessionRoutingRow>(
    `SELECT
       os.*,
       a.role,
       a.session_key_prefix,
       t.workspace_id,
       t.product_id,
       t.status AS task_status
     FROM openclaw_sessions os
     LEFT JOIN agents a ON a.id = os.agent_id
     LEFT JOIN tasks t ON t.id = os.task_id
     WHERE ${where.join(' AND ')}
     ORDER BY os.updated_at DESC`,
    params,
  );

  if (sessions.length === 0) {
    return { priced: 0, unpriced: 0, pending: 0, skipped: 0 };
  }

  const client = filters.client || getOpenClawClient();
  await ensureClientReady(client);

  const [gatewaySessions, config] = await Promise.all([
    client.listSessions(),
    client.getConfig().catch(() => ({})),
  ]);

  const snapshotsByKey = new Map<string, UsageSnapshot>();
  for (const gatewaySession of gatewaySessions) {
    const snapshot = extractUsageSnapshot(gatewaySession);
    if (snapshot) {
      snapshotsByKey.set(snapshot.sessionKey, snapshot);
    }
  }

  const summary: BuildUsageSyncSummary = { priced: 0, unpriced: 0, pending: 0, skipped: 0 };
  const now = new Date().toISOString();

  for (const session of sessions) {
    const sessionKey = resolveOpenClawSessionKey(session);
    const snapshot = snapshotsByKey.get(sessionKey);
    if (!snapshot) {
      markUsagePending(session.id, now, 'session_usage_not_found');
      summary.pending += 1;
      continue;
    }

    if (session.usage_external_id && session.usage_external_id === snapshot.externalId) {
      summary.skipped += 1;
      continue;
    }

    if (shouldAwaitMoreUsage(session, snapshot)) {
      markUsagePending(session.id, now, 'run_still_active');
      summary.pending += 1;
      continue;
    }

    const effectiveModel = session.bound_model || snapshot.modelId || session.requested_model || undefined;
    const costRecord = buildSessionCostRecord(config, session, snapshot, effectiveModel);
    if (!costRecord || !effectiveModel) {
      markUsageUnpriced(session, now, 'usage_missing_accountable_pricing', snapshot.externalId);
      summary.unpriced += 1;
      continue;
    }

    const usage = computeUsageCostUsd(snapshot, session, costRecord.ledgerType === 'provider_actual'
      ? findProviderCostMetadata(config, effectiveModel, snapshot.modelProvider)!
      : {
          provider: costRecord.provider,
          modelId: effectiveModel,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        });
    if (costRecord.ledgerType === 'provider_actual'
      && usage.inputTokens === 0
      && usage.outputTokens === 0
      && usage.cacheReadTokens === 0
      && usage.cacheWriteTokens === 0) {
      markZeroUsageReconciled(session, now, snapshot.externalId);
      summary.skipped += 1;
      continue;
    }

    recordCostEvent({
      workspace_id: session.workspace_id || 'default',
      product_id: session.product_id || null,
      task_id: session.task_id || null,
      agent_id: session.agent_id || null,
      event_type: 'build_task',
      provider: costRecord.provider,
      model: effectiveModel,
      tokens_input: costRecord.ledgerType === 'provider_actual' ? usage.inputTokens : 0,
      tokens_output: costRecord.ledgerType === 'provider_actual' ? usage.outputTokens : 0,
      cost_usd: costRecord.costUsd,
      ledger_type: costRecord.ledgerType,
      pricing_basis: costRecord.pricingBasis,
      metadata: JSON.stringify({
        session_key: sessionKey,
        usage_external_id: snapshot.externalId,
        run_id: session.last_run_id || null,
        cache_read_tokens: costRecord.ledgerType === 'provider_actual' ? usage.cacheReadTokens : 0,
        cache_write_tokens: costRecord.ledgerType === 'provider_actual' ? usage.cacheWriteTokens : 0,
        usage_accounting: costRecord.ledgerType,
      }),
    });

    run(
      `UPDATE openclaw_sessions
       SET session_key = ?,
           usage_external_id = ?,
           usage_sync_status = 'priced',
           usage_sync_reason = NULL,
           usage_synced_at = ?,
           updated_at = ?
       WHERE id = ?`,
      [sessionKey, snapshot.externalId, now, now, session.id],
    );

    summary.priced += 1;
  }

  return summary;
}

function buildSessionCostRecord(
  snapshot: GatewayConfigSnapshot | Record<string, unknown> | null | undefined,
  session: SessionRoutingRow,
  usageSnapshot: UsageSnapshot,
  effectiveModel?: string,
): SessionCostRecord | null {
  const normalizedModel = (effectiveModel || '').trim();
  if (!normalizedModel) {
    return null;
  }

  if (supportsProviderActualAccounting(normalizedModel)) {
    const pricing = findProviderCostMetadata(snapshot, normalizedModel, usageSnapshot.modelProvider);
    if (!pricing) {
      return null;
    }
    const usage = computeUsageCostUsd(usageSnapshot, session, pricing);
    return {
      costUsd: usage.costUsd,
      tokensInput: usage.inputTokens,
      tokensOutput: usage.outputTokens,
      pricingBasis: 'token_priced',
      ledgerType: 'provider_actual',
      provider: pricing.provider,
    };
  }

  if (supportsMissionEstimateAccounting(normalizedModel)) {
    const estimatedCostUsd = estimateMissionControlModelCost(normalizedModel, { requestCount: 1 });
    if (estimatedCostUsd == null) {
      return null;
    }
    return {
      costUsd: estimatedCostUsd,
      tokensInput: 0,
      tokensOutput: 0,
      pricingBasis: 'request_estimate',
      ledgerType: 'mission_estimate',
      provider: canonicalMissionControlModelId(normalizedModel).split('/')[0],
    };
  }

  return null;
}
