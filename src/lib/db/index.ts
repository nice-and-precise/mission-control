import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { schema } from './schema';
import { runMigrations } from './migrations';
import { ensureCatalogSyncScheduled } from '@/lib/agent-catalog-sync';
import { ensureHealthCheckScheduled } from '@/lib/agent-health-scheduler';
import { attachChatListener } from '@/lib/chat-listener';
import { isRuntimeBootEnabled, RUNTIME_BOOT_ENV_FLAG } from '@/lib/runtime-boot';

const DB_PATH = process.env.DATABASE_PATH || path.join(process.cwd(), 'mission-control.db');
let runtimeSideEffectsInitializerForTests: (() => void | Promise<void>) | null = null;

export function shouldBootRuntimeSideEffects(env: NodeJS.ProcessEnv = process.env): boolean {
  return isRuntimeBootEnabled(env);
}

function bootRuntimeSideEffects(): void {
  if (!shouldBootRuntimeSideEffects()) return;

  if (runtimeSideEffectsInitializerForTests) {
    void runtimeSideEffectsInitializerForTests();
    return;
  }

  // Keep Mission Control's agent catalog synced with OpenClaw-installed agents
  ensureCatalogSyncScheduled();
  ensureHealthCheckScheduled();
  attachChatListener();
}

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    const isNewDb = !fs.existsSync(DB_PATH);
    
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Initialize base schema (creates tables if they don't exist)
    db.exec(schema);

    // Run migrations for schema updates
    // This handles both new and existing databases
    runMigrations(db);

    bootRuntimeSideEffects();
    
    if (isNewDb) {
      console.log('[DB] New database created at:', DB_PATH);
    }
  }
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// Type-safe query helpers
export function queryAll<T>(sql: string, params: unknown[] = []): T[] {
  const stmt = getDb().prepare(sql);
  return stmt.all(...params) as T[];
}

export function queryOne<T>(sql: string, params: unknown[] = []): T | undefined {
  const stmt = getDb().prepare(sql);
  return stmt.get(...params) as T | undefined;
}

export function run(sql: string, params: unknown[] = []): Database.RunResult {
  const stmt = getDb().prepare(sql);
  return stmt.run(...params);
}

export function transaction<T>(fn: () => T): T {
  const db = getDb();
  return db.transaction(fn)();
}

export function setRuntimeSideEffectsInitializerForTests(
  initializer: (() => void | Promise<void>) | null,
): void {
  runtimeSideEffectsInitializerForTests = initializer;
}

// Export migration utilities for CLI use
export { runMigrations, getMigrationStatus } from './migrations';
export { RUNTIME_BOOT_ENV_FLAG };
