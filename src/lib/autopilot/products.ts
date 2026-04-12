import { v4 as uuidv4 } from 'uuid';
import { getDb, queryOne, queryAll, run } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { reconcileBudgetStateForScope } from '@/lib/costs/budget-policy';
import { createWorkspaceRecord, getWorkspaceByIdOrSlug } from '@/lib/workspaces';
import {
  mergeCanonicalProgramPathIntoSettings,
  normalizeProduct,
} from './product-program';
import type { Product, ProductWorkspaceMode } from '@/lib/types';

type CreateProductInput = {
  workspace_id?: string;
  workspace_mode?: ProductWorkspaceMode;
  name: string;
  description?: string;
  repo_url?: string;
  live_url?: string;
  canonical_program_path?: string | null;
  product_program?: string;
  icon?: string;
  settings?: string;
  build_mode?: string;
  default_branch?: string;
  cost_cap_per_task?: number | null;
  cost_cap_monthly?: number | null;
};

const PRODUCT_SELECT = `
  SELECT p.*,
         w.name as workspace_name,
         w.slug as workspace_slug,
         w.icon as workspace_icon,
         (
           SELECT completed_at
           FROM product_program_audits a
           WHERE a.product_id = p.id
           ORDER BY a.created_at DESC
           LIMIT 1
         ) as last_program_audit_at,
         (
           SELECT status
           FROM product_program_audits a
           WHERE a.product_id = p.id
           ORDER BY a.created_at DESC
           LIMIT 1
         ) as last_program_audit_status,
         (
           SELECT canonical_program_sha
           FROM product_program_audits a
           WHERE a.product_id = p.id
           ORDER BY a.created_at DESC
           LIMIT 1
         ) as last_canonical_program_sha,
         (
           SELECT product_program_sha
           FROM research_cycles rc
           WHERE rc.product_id = p.id
             AND rc.product_program_sha IS NOT NULL
             AND rc.product_program_sha != ''
           ORDER BY rc.started_at DESC
           LIMIT 1
         ) as last_research_program_sha,
         (
           SELECT product_program_sha
           FROM ideation_cycles ic
           WHERE ic.product_id = p.id
             AND ic.product_program_sha IS NOT NULL
             AND ic.product_program_sha != ''
           ORDER BY ic.started_at DESC
           LIMIT 1
         ) as last_ideation_program_sha
  FROM products p
  LEFT JOIN workspaces w ON w.id = p.workspace_id
`;

const DEFAULT_PRODUCT_TASK_CAP_USD = 15;
const DEFAULT_PRODUCT_MONTHLY_CAP_USD = 40;

export function createProduct(input: CreateProductInput): Product {
  const db = getDb();
  const id = uuidv4();
  const now = new Date().toISOString();
  const workspaceMode = input.workspace_mode || (input.workspace_id ? 'existing' : 'dedicated');
  let workspaceId = input.workspace_id?.trim();
  let managesWorkspace = 0;
  const mergedSettings = mergeCanonicalProgramPathIntoSettings(input.settings || null, input.canonical_program_path);

  const createdProduct = db.transaction(() => {
    if (workspaceMode === 'dedicated') {
      const workspace = createWorkspaceRecord(
        {
          name: input.name,
          description: input.description || `${input.name} product workspace`,
          icon: input.icon || '🚀',
          bootstrap: true,
        },
        db,
      );
      workspaceId = workspace.id;
      managesWorkspace = 1;
    } else {
      if (!workspaceId) {
        throw new Error('workspace_id is required when workspace_mode is "existing"');
      }
      const workspace = getWorkspaceByIdOrSlug(workspaceId);
      if (!workspace) {
        throw new Error(`Workspace ${workspaceId} not found`);
      }
      workspaceId = workspace.id;
    }

    db.prepare(
      `INSERT INTO products (
         id, workspace_id, workspace_mode, manages_workspace, name, description, repo_url, live_url,
         canonical_program_path, product_program, icon, settings, build_mode, default_branch, cost_cap_per_task, cost_cap_monthly,
         reserved_cost_usd, budget_status, budget_block_reason, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'clear', NULL, ?, ?)`
    ).run(
      id,
      workspaceId,
      workspaceMode,
      managesWorkspace,
      input.name,
      input.description || null,
      input.repo_url || null,
      input.live_url || null,
      input.canonical_program_path || null,
      input.product_program || null,
      input.icon || '🚀',
      mergedSettings,
      input.build_mode || 'plan_first',
      input.default_branch || 'main',
      input.cost_cap_per_task ?? DEFAULT_PRODUCT_TASK_CAP_USD,
      input.cost_cap_monthly ?? DEFAULT_PRODUCT_MONTHLY_CAP_USD,
      now,
      now,
    );

    return normalizeProduct(db.prepare(`${PRODUCT_SELECT} WHERE p.id = ?`).get(id) as Product);
  })();

  return createdProduct;
}

export function getProduct(id: string): Product | undefined {
  return normalizeProduct(queryOne<Product>(`${PRODUCT_SELECT} WHERE p.id = ?`, [id]));
}

export function listProducts(workspaceId?: string): Product[] {
  if (workspaceId) {
    return queryAll<Product>(
      `${PRODUCT_SELECT}
       WHERE p.workspace_id = ?
         AND p.status != 'archived'
      ORDER BY p.created_at DESC`,
      [workspaceId]
    ).map((product) => normalizeProduct(product) as Product);
  }
  return queryAll<Product>(
    `${PRODUCT_SELECT}
     WHERE p.status != 'archived'
     ORDER BY p.created_at DESC`
  ).map((product) => normalizeProduct(product) as Product);
}

export function updateProduct(id: string, updates: Partial<{
  name: string;
  description: string | null;
  repo_url: string | null;
  live_url: string | null;
  canonical_program_path: string | null;
  product_program: string;
  icon: string;
  status: string;
  settings: string | null;
  build_mode: string;
  default_branch: string;
  cost_cap_per_task: number | null;
  cost_cap_monthly: number | null;
  batch_review_threshold: number;
}>): Product | undefined {
  const fields: string[] = [];
  const values: unknown[] = [];
  const normalizedUpdates = { ...updates };

  if (Object.prototype.hasOwnProperty.call(normalizedUpdates, 'canonical_program_path')) {
    const currentProduct = getProduct(id);
    if (currentProduct) {
      normalizedUpdates.settings = mergeCanonicalProgramPathIntoSettings(
        normalizedUpdates.settings ?? currentProduct.settings ?? null,
        normalizedUpdates.canonical_program_path ?? null,
      );
    }
  }

  for (const [key, value] of Object.entries(normalizedUpdates)) {
    if (value !== undefined) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
  }

  if (fields.length === 0) return getProduct(id);

  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);

  run(`UPDATE products SET ${fields.join(', ')} WHERE id = ?`, values);
  const product = getProduct(id);
  if (product) {
    reconcileBudgetStateForScope(product.workspace_id, id);
  }
  return product;
}

export function archiveProduct(id: string): boolean {
  const result = run(
    `UPDATE products SET status = 'archived', updated_at = ? WHERE id = ?`,
    [new Date().toISOString(), id]
  );
  return result.changes > 0;
}
