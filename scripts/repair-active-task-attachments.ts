import { closeDb } from '@/lib/db';
import { repairActiveRootSessionAttachments } from '@/lib/task-session-cleanup';

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
  const nowOverride = getArgValue('--now');
  const now = nowOverride || new Date().toISOString();

  const summary = repairActiveRootSessionAttachments(now, { dryRun: !apply });

  const mode = apply ? 'APPLY' : 'DRY_RUN';
  console.log(`[SessionRepair] mode=${mode} timestamp=${now}`);
  console.log(JSON.stringify(summary, null, 2));

  if (!apply) {
    console.log('[SessionRepair] No rows changed. Re-run with --apply to persist updates.');
  }
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes('openclaw_sessions.active_task_id is missing') ||
      message.includes('no such column: active_task_id')
    ) {
      console.warn(`[SessionRepair] Skipped: ${message}`);
      console.warn('[SessionRepair] This database has not applied the active_task_id migration yet.');
      return;
    }

    console.error('[SessionRepair] Failed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    closeDb();
  });
