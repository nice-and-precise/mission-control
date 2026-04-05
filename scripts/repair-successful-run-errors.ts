import { closeDb } from '@/lib/db';
import { repairSuccessfulTaskRunErrors } from '@/lib/task-run-error-repair';

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function getArgValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

async function main(): Promise<void> {
  const apply = hasFlag('--apply');
  const workspaceId = getArgValue('--workspace-id') || null;
  const nowOverride = getArgValue('--now');
  const now = nowOverride || new Date().toISOString();

  const summary = repairSuccessfulTaskRunErrors(now, {
    dryRun: !apply,
    workspaceId,
  });

  const mode = apply ? 'APPLY' : 'DRY_RUN';
  console.log(`[TaskRunErrorRepair] mode=${mode} timestamp=${now} workspace=${workspaceId || 'all'}`);
  console.log(JSON.stringify(summary, null, 2));

  if (!apply) {
    console.log('[TaskRunErrorRepair] No rows changed. Re-run with --apply to persist updates.');
  }
}

main()
  .catch((error) => {
    console.error('[TaskRunErrorRepair] Failed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    closeDb();
  });
