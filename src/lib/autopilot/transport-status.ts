import { run } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { emitAutopilotActivity } from './activity';
import type { CompletionStatusEvent, CompletionTransport } from './llm';

type CycleType = 'research' | 'ideation';

interface RuntimeStatusPayload {
  kind: 'llm_runtime_status';
  stage: CompletionStatusEvent['type'];
  message: string;
  detail?: string;
  requestedModel: string;
  transport?: CompletionTransport;
  fromTransport?: CompletionTransport;
  toTransport?: CompletionTransport;
  attempt?: number;
  delayMs?: number;
  remainingMs?: number;
  updatedAt: string;
}

interface ActivityDescriptor {
  eventType: string;
  message: string;
  detail?: string;
}

const CYCLE_TABLE: Record<CycleType, string> = {
  research: 'research_cycles',
  ideation: 'ideation_cycles',
};

function transportLabel(transport: CompletionTransport): string {
  switch (transport) {
    case 'agent-cli':
      return 'agent CLI';
    case 'session':
      return 'session';
    case 'http':
    default:
      return 'HTTP';
  }
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(1, Math.ceil(ms / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function describeEvent(event: CompletionStatusEvent): {
  activity: ActivityDescriptor;
  runtime: Omit<RuntimeStatusPayload, 'updatedAt'>;
} {
  switch (event.type) {
    case 'transport_started': {
      const label = transportLabel(event.transport);
      const retrySuffix = event.attempt > 1 ? ` (attempt ${event.attempt})` : '';
      return {
        activity: {
          eventType: 'transport_started',
          message: `${label} transport running${retrySuffix}`,
          detail: `Model: ${event.requestedModel}`,
        },
        runtime: {
          kind: 'llm_runtime_status',
          stage: event.type,
          message: `${label} transport running${retrySuffix}.`,
          detail: `Model: ${event.requestedModel}`,
          requestedModel: event.requestedModel,
          transport: event.transport,
          attempt: event.attempt,
        },
      };
    }

    case 'transport_retry':
      return {
        activity: {
          eventType: 'transport_retry',
          message: `HTTP retry scheduled (attempt ${event.attempt})`,
          detail: `Retry in ${formatDuration(event.delayMs)}. ${event.error}`,
        },
        runtime: {
          kind: 'llm_runtime_status',
          stage: event.type,
          message: `HTTP retry scheduled (attempt ${event.attempt}).`,
          detail: `Retry in ${formatDuration(event.delayMs)}. ${event.error}`,
          requestedModel: event.requestedModel,
          transport: 'http',
          attempt: event.attempt,
          delayMs: event.delayMs,
        },
      };

    case 'transport_fallback': {
      const target = transportLabel(event.toTransport);
      return {
        activity: {
          eventType: 'transport_fallback',
          message: `HTTP transport failed; falling back to ${target}`,
          detail: event.reason,
        },
        runtime: {
          kind: 'llm_runtime_status',
          stage: event.type,
          message: `HTTP transport failed; falling back to ${target}.`,
          detail: event.reason,
          requestedModel: event.requestedModel,
          fromTransport: event.fromTransport,
          toTransport: event.toTransport,
        },
      };
    }

    case 'transport_fallback_skipped':
      return {
        activity: {
          eventType: 'transport_fallback_skipped',
          message: 'HTTP transport failed; fallback skipped',
          detail: event.reason,
        },
        runtime: {
          kind: 'llm_runtime_status',
          stage: event.type,
          message: 'HTTP transport failed; fallback skipped.',
          detail: event.reason,
          requestedModel: event.requestedModel,
          fromTransport: event.fromTransport,
        },
      };

    case 'json_retry':
      return {
        activity: {
          eventType: 'json_retry',
          message: 'Retrying with strict JSON enforcement',
          detail: `Remaining budget: ${formatDuration(event.remainingMs)}`,
        },
        runtime: {
          kind: 'llm_runtime_status',
          stage: event.type,
          message: 'Retrying with strict JSON enforcement.',
          detail: `Remaining budget: ${formatDuration(event.remainingMs)}`,
          requestedModel: event.requestedModel,
          remainingMs: event.remainingMs,
        },
      };
  }
}

export async function recordAutopilotTransportStatus(input: {
  productId: string;
  cycleId: string;
  cycleType: CycleType;
  event: CompletionStatusEvent;
  variantLabel?: string;
}): Promise<void> {
  const { productId, cycleId, cycleType, event, variantLabel = '' } = input;
  const { activity, runtime } = describeEvent(event);
  const now = new Date().toISOString();
  const runtimePayload: RuntimeStatusPayload = {
    ...runtime,
    updatedAt: now,
  };

  run(
    `UPDATE ${CYCLE_TABLE[cycleType]} SET phase_data = ?, last_heartbeat = ? WHERE id = ?`,
    [JSON.stringify(runtimePayload), now, cycleId],
  );

  emitAutopilotActivity({
    productId,
    cycleId,
    cycleType,
    eventType: activity.eventType,
    message: `${activity.message}${variantLabel}`,
    detail: activity.detail,
  });

  if (cycleType === 'research') {
    broadcast({
      type: 'research_phase',
      payload: { productId, cycleId, phase: 'llm_polling', runtimeStatus: runtimePayload },
    });
    return;
  }

  broadcast({
    type: 'ideation_phase',
    payload: { productId, ideationId: cycleId, phase: 'llm_polling', runtimeStatus: runtimePayload },
  });
}