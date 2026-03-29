import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import {
  closeDb,
  getDb,
  RUNTIME_BOOT_ENV_FLAG,
  setRuntimeSideEffectsInitializerForTests,
  shouldBootRuntimeSideEffects,
} from './db';

const previousDatabasePath = process.env.DATABASE_PATH;
const previousRuntimeBoot = process.env[RUNTIME_BOOT_ENV_FLAG];
const tempRoots: string[] = [];

afterEach(() => {
  closeDb();
  setRuntimeSideEffectsInitializerForTests(null);

  if (previousDatabasePath === undefined) {
    delete process.env.DATABASE_PATH;
  } else {
    process.env.DATABASE_PATH = previousDatabasePath;
  }

  if (previousRuntimeBoot === undefined) {
    delete process.env[RUNTIME_BOOT_ENV_FLAG];
  } else {
    process.env[RUNTIME_BOOT_ENV_FLAG] = previousRuntimeBoot;
  }

  while (tempRoots.length > 0) {
    const tempRoot = tempRoots.pop();
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }
});

function withTempDatabasePath(): string {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'mission-control-runtime-boot-'));
  tempRoots.push(tempRoot);
  const databasePath = path.join(tempRoot, 'mission-control.db');
  process.env.DATABASE_PATH = databasePath;
  return databasePath;
}

test('shouldBootRuntimeSideEffects only opts in when the runtime boot flag is set', () => {
  assert.equal(shouldBootRuntimeSideEffects({}), false);
  assert.equal(shouldBootRuntimeSideEffects({ [RUNTIME_BOOT_ENV_FLAG]: '0' }), false);
  assert.equal(shouldBootRuntimeSideEffects({ [RUNTIME_BOOT_ENV_FLAG]: '1' }), true);
});

test('getDb does not boot runtime side effects without the explicit runtime boot flag', () => {
  withTempDatabasePath();
  delete process.env[RUNTIME_BOOT_ENV_FLAG];

  let bootCalls = 0;
  setRuntimeSideEffectsInitializerForTests(() => {
    bootCalls += 1;
  });

  getDb();

  assert.equal(bootCalls, 0);
});

test('getDb boots runtime side effects when the explicit runtime boot flag is set', () => {
  withTempDatabasePath();
  process.env[RUNTIME_BOOT_ENV_FLAG] = '1';

  let bootCalls = 0;
  setRuntimeSideEffectsInitializerForTests(() => {
    bootCalls += 1;
  });

  getDb();
  getDb();

  assert.equal(bootCalls, 1);
});
