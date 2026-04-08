import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db';

test('migration 038 backfills existing cost events into legacy ledger columns', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mission-control-migration-'));
  const dbPath = join(dir, 'migration-038.sqlite');
  const db = new Database(dbPath);

  db.exec(`
    CREATE TABLE workspaces (id TEXT PRIMARY KEY);
    CREATE TABLE products (id TEXT PRIMARY KEY);
    CREATE TABLE cost_events (
      id TEXT PRIMARY KEY,
      product_id TEXT,
      workspace_id TEXT NOT NULL,
      task_id TEXT,
      cycle_id TEXT,
      agent_id TEXT,
      event_type TEXT NOT NULL,
      provider TEXT,
      model TEXT,
      tokens_input INTEGER DEFAULT 0,
      tokens_output INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      metadata TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE _migrations (id TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT DEFAULT (datetime('now')));
  `);

  for (let i = 1; i <= 37; i += 1) {
    db.prepare('INSERT INTO _migrations (id, name) VALUES (?, ?)').run(String(i).padStart(3, '0'), `migration-${i}`);
  }

  db.prepare(`
    INSERT INTO cost_events (
      id, workspace_id, event_type, provider, model, tokens_input, tokens_output, cost_usd
    ) VALUES ('legacy-event', 'ws-1', 'build_task', 'qwen', 'qwen/qwen3.6-plus', 10, 5, 1.25)
  `).run();

  runMigrations(db);

  const columns = db.prepare(`PRAGMA table_info(cost_events)`).all() as Array<{ name: string }>;
  assert.ok(columns.some(col => col.name === 'ledger_type'));
  assert.ok(columns.some(col => col.name === 'pricing_basis'));

  const row = db.prepare(
    `SELECT ledger_type, pricing_basis FROM cost_events WHERE id = 'legacy-event'`,
  ).get() as { ledger_type: string; pricing_basis: string };
  assert.equal(row.ledger_type, 'legacy_mixed');
  assert.equal(row.pricing_basis, 'legacy');

  db.close();
});
