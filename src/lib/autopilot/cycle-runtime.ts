import { queryAll, run } from '@/lib/db';
import { emitAutopilotActivity } from './activity';

type CycleType = 'research' | 'ideation';

interface RunningCycleRow {
  id: string;
  product_id: string;
  current_phase?: string | null;
  started_at: string;
  last_heartbeat?: string | null;
}

const HEARTBEAT_INTERVAL_MS = 15_000;
const STALE_CYCLE_THRESHOLD_MS = 90_000;

const TABLE_BY_TYPE: Record<CycleType, 'research_cycles' | 'ideation_cycles'> = {
  research: 'research_cycles',
  ideation: 'ideation_cycles',
};

function cycleLabel(cycleType: CycleType): string {
  return cycleType === 'research' ? 'Research' : 'Ideation';
}

function timestampToMs(value?: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function startCycleHeartbeat(cycleType: CycleType, cycleId: string): () => void {
  const table = TABLE_BY_TYPE[cycleType];

  const touch = () => {
    run(
      `UPDATE ${table} SET last_heartbeat = ? WHERE id = ? AND status = 'running'`,
      [new Date().toISOString(), cycleId],
    );
  };

  touch();

  const interval = setInterval(touch, HEARTBEAT_INTERVAL_MS);
  if (typeof interval.unref === 'function') {
    interval.unref();
  }

  return () => clearInterval(interval);
}

export function recoverStaleCycles(cycleType: CycleType, productId: string): void {
  const table = TABLE_BY_TYPE[cycleType];
  const staleBefore = Date.now() - STALE_CYCLE_THRESHOLD_MS;
  const cycles = queryAll<RunningCycleRow>(
    `SELECT id, product_id, current_phase, started_at, last_heartbeat
       FROM ${table}
      WHERE product_id = ? AND status = 'running'`,
    [productId],
  );

  for (const cycle of cycles) {
    const heartbeatMs = timestampToMs(cycle.last_heartbeat) ?? timestampToMs(cycle.started_at);
    if (heartbeatMs === null || heartbeatMs >= staleBefore) {
      continue;
    }

    const heartbeatAt = cycle.last_heartbeat || cycle.started_at;
    const detail =
      `${cycleLabel(cycleType)} cycle interrupted after Mission Control lost its worker. ` +
      `Last heartbeat: ${heartbeatAt}. Phase: ${cycle.current_phase || 'unknown'}.`;

    run(
      `UPDATE ${table}
          SET status = 'interrupted',
              completed_at = ?,
              error_message = ?
        WHERE id = ? AND status = 'running'`,
      [new Date().toISOString(), detail, cycle.id],
    );

    emitAutopilotActivity({
      productId: cycle.product_id,
      cycleId: cycle.id,
      cycleType,
      eventType: 'error',
      message: `${cycleLabel(cycleType)} cycle interrupted`,
      detail,
    });
  }
}
