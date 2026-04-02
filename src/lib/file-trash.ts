import { existsSync, mkdirSync, renameSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function getTrashRoot(): string {
  const configured = process.env.MISSION_CONTROL_TRASH_DIR?.trim();
  return configured || path.join(os.homedir(), '.Trash');
}

function buildUniqueTrashPath(trashRoot: string, targetPath: string): string {
  const parsed = path.parse(targetPath);
  let attempt = path.join(trashRoot, parsed.base);
  let suffix = 1;

  while (existsSync(attempt)) {
    attempt = path.join(trashRoot, `${parsed.name}-${suffix}${parsed.ext}`);
    suffix += 1;
  }

  return attempt;
}

export function movePathToTrash(targetPath: string): string | null {
  if (!targetPath.trim() || !existsSync(targetPath)) {
    return null;
  }

  const trashRoot = getTrashRoot();
  mkdirSync(trashRoot, { recursive: true });

  const destination = buildUniqueTrashPath(trashRoot, targetPath);
  renameSync(targetPath, destination);
  return destination;
}
