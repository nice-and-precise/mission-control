import type Database from 'better-sqlite3';
import { getMissionControlUrl } from '@/lib/config';
import { getDb, queryOne } from '@/lib/db';
import { bootstrapCoreAgentsRaw, cloneWorkflowTemplates } from '@/lib/bootstrap-agents';
import type { Workspace } from '@/lib/types';

export function generateWorkspaceSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function generateUniqueWorkspaceSlug(db: Database.Database, name: string): string {
  const baseSlug = generateWorkspaceSlug(name) || 'workspace';
  let slug = baseSlug;
  let attempt = 2;

  while (db.prepare('SELECT id FROM workspaces WHERE slug = ?').get(slug)) {
    slug = `${baseSlug}-${attempt}`;
    attempt += 1;
  }

  return slug;
}

interface CreateWorkspaceInput {
  name: string;
  description?: string | null;
  icon?: string | null;
  cost_cap_daily?: number | null;
  cost_cap_monthly?: number | null;
  bootstrap?: boolean;
}

export function createWorkspaceRecord(
  input: CreateWorkspaceInput,
  db: Database.Database = getDb(),
): Workspace {
  const name = input.name.trim();
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const slug = generateUniqueWorkspaceSlug(db, name);

  db.prepare(
    `INSERT INTO workspaces (
       id, name, slug, description, icon, cost_cap_daily, cost_cap_monthly, reserved_cost_usd,
       budget_status, budget_block_reason, created_at, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'clear', NULL, ?, ?)`
  ).run(
    id,
    name,
    slug,
    input.description || null,
    input.icon || '📁',
    input.cost_cap_daily ?? 20,
    input.cost_cap_monthly ?? 100,
    now,
    now,
  );

  if (input.bootstrap !== false) {
    cloneWorkflowTemplates(db, id);
    bootstrapCoreAgentsRaw(db, id, getMissionControlUrl());
  }

  return db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as Workspace;
}

export function getWorkspaceByIdOrSlug(idOrSlug: string): Workspace | undefined {
  return queryOne<Workspace>(
    'SELECT * FROM workspaces WHERE id = ? OR slug = ?',
    [idOrSlug, idOrSlug]
  );
}

function buildInClause(ids: string[]): string {
  return ids.map(() => '?').join(', ');
}

export function hardDeleteWorkspace(
  workspaceId: string,
  db: Database.Database = getDb(),
): boolean {
  const existing = db.prepare('SELECT id FROM workspaces WHERE id = ?').get(workspaceId) as { id: string } | undefined;
  if (!existing || workspaceId === 'default') {
    return false;
  }

  return db.transaction(() => {
    const agentIds = (
      db.prepare('SELECT id FROM agents WHERE workspace_id = ?').all(workspaceId) as { id: string }[]
    ).map(row => row.id);

    if (agentIds.length > 0) {
      const placeholders = buildInClause(agentIds);
      db.prepare(`DELETE FROM openclaw_sessions WHERE agent_id IN (${placeholders})`).run(...agentIds);
      db.prepare(`DELETE FROM work_checkpoints WHERE agent_id IN (${placeholders})`).run(...agentIds);
      db.prepare(`DELETE FROM agent_mailbox WHERE from_agent_id IN (${placeholders}) OR to_agent_id IN (${placeholders})`).run(
        ...agentIds,
        ...agentIds,
      );
      db.prepare(`UPDATE tasks SET assigned_agent_id = NULL WHERE assigned_agent_id IN (${placeholders})`).run(...agentIds);
      db.prepare(`UPDATE tasks SET created_by_agent_id = NULL WHERE created_by_agent_id IN (${placeholders})`).run(...agentIds);
      db.prepare(`UPDATE events SET agent_id = NULL WHERE agent_id IN (${placeholders})`).run(...agentIds);
      db.prepare(`UPDATE messages SET sender_agent_id = NULL WHERE sender_agent_id IN (${placeholders})`).run(...agentIds);
      db.prepare(`UPDATE research_cycles SET agent_id = NULL WHERE agent_id IN (${placeholders})`).run(...agentIds);
      db.prepare(`UPDATE cost_events SET agent_id = NULL WHERE agent_id IN (${placeholders})`).run(...agentIds);
      db.prepare(`UPDATE knowledge_entries SET created_by_agent_id = NULL WHERE created_by_agent_id IN (${placeholders})`).run(...agentIds);
      db.prepare(`DELETE FROM agents WHERE id IN (${placeholders})`).run(...agentIds);
    }

    db.prepare('DELETE FROM workflow_templates WHERE workspace_id = ?').run(workspaceId);
    db.prepare('DELETE FROM knowledge_entries WHERE workspace_id = ?').run(workspaceId);
    db.prepare('DELETE FROM cost_caps WHERE workspace_id = ?').run(workspaceId);
    db.prepare('DELETE FROM cost_events WHERE workspace_id = ?').run(workspaceId);
    db.prepare('DELETE FROM workspaces WHERE id = ?').run(workspaceId);

    return true;
  })();
}
