import { getDb } from '@/lib/db';
import { shouldBootRuntimeSideEffects } from '@/lib/db';

const DEFAULT_APP_VERSION = '2.4.0';

export type MissionControlHealth = {
  status: 'ok';
  version: string;
  uptime_seconds: number;
  node_version: string;
  runtime_boot_enabled: boolean;
  openclaw_gateway_url: string;
  database: {
    connected: true;
  };
};

type HealthDeps = {
  appVersion?: string;
  env?: NodeJS.ProcessEnv;
  nodeVersion?: string;
  uptimeSeconds?: number;
  dbCheck?: () => void;
};

function defaultDbCheck(): void {
  getDb().prepare('SELECT 1').get();
}

export function getMissionControlHealth({
  appVersion = process.env.npm_package_version || DEFAULT_APP_VERSION,
  env = process.env,
  nodeVersion = process.versions.node,
  uptimeSeconds = Math.floor(process.uptime()),
  dbCheck = defaultDbCheck,
}: HealthDeps = {}): MissionControlHealth {
  dbCheck();

  return {
    status: 'ok',
    version: appVersion,
    uptime_seconds: uptimeSeconds,
    node_version: nodeVersion,
    runtime_boot_enabled: shouldBootRuntimeSideEffects(env),
    openclaw_gateway_url: env.OPENCLAW_GATEWAY_URL || 'ws://127.0.0.1:18789',
    database: {
      connected: true,
    },
  };
}
