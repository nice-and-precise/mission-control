import { runHealthCheckCycle } from '@/lib/agent-health';
import { acquireRuntimeLease } from '@/lib/runtime-leases';
import { isRuntimeBootEnabled } from '@/lib/runtime-boot';

const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 30_000;
const GLOBAL_HEALTH_TIMER_KEY = '__mcAgentHealthTimer__';
const HEALTH_SCHEDULER_LEASE = 'agent-health-scheduler';

let healthCheckRunnerForTests: (() => Promise<unknown>) | null = null;

function getHealthCheckIntervalMs(): number {
  const configured = Number(process.env.AGENT_HEALTH_CHECK_INTERVAL_MS || DEFAULT_HEALTH_CHECK_INTERVAL_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_HEALTH_CHECK_INTERVAL_MS;
}

async function runScheduledHealthCheck(reason: 'startup' | 'scheduled'): Promise<void> {
  const runner = healthCheckRunnerForTests || runHealthCheckCycle;
  const intervalMs = getHealthCheckIntervalMs();
  const ttlMs = Math.max(intervalMs * 3, 60_000);

  try {
    if (!acquireRuntimeLease(HEALTH_SCHEDULER_LEASE, { ttlMs })) {
      return;
    }
    await runner();
  } catch (error) {
    console.error(`[HealthScheduler] ${reason} health check failed:`, error);
  }
}

export function ensureHealthCheckScheduled(): void {
  if (!isRuntimeBootEnabled() && !healthCheckRunnerForTests) {
    return;
  }

  const globalState = globalThis as typeof globalThis & {
    __mcAgentHealthTimer__?: NodeJS.Timeout;
  };

  if (globalState[GLOBAL_HEALTH_TIMER_KEY]) {
    return;
  }

  const timer = setInterval(() => {
    void runScheduledHealthCheck('scheduled');
  }, getHealthCheckIntervalMs());
  timer.unref?.();

  globalState[GLOBAL_HEALTH_TIMER_KEY] = timer;
  void runScheduledHealthCheck('startup');
}

export function setHealthCheckRunnerForTests(runner: (() => Promise<unknown>) | null): void {
  healthCheckRunnerForTests = runner;
}

export function resetHealthCheckSchedulerForTests(): void {
  const globalState = globalThis as typeof globalThis & {
    __mcAgentHealthTimer__?: NodeJS.Timeout;
  };

  if (globalState[GLOBAL_HEALTH_TIMER_KEY]) {
    clearInterval(globalState[GLOBAL_HEALTH_TIMER_KEY]);
    delete globalState[GLOBAL_HEALTH_TIMER_KEY];
  }

  healthCheckRunnerForTests = null;
}
