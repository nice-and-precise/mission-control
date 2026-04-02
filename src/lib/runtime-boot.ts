export const RUNTIME_BOOT_ENV_FLAG = 'MISSION_CONTROL_RUNTIME_BOOT';

export function isRuntimeBootEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[RUNTIME_BOOT_ENV_FLAG] === '1';
}
