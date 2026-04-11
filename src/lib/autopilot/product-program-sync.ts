import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { queryAll, queryOne, run } from '@/lib/db';
import type { Product, ProductProgramAudit, ProductProgramDriftSummary } from '@/lib/types';
import { emitAutopilotActivity } from './activity';
import { getResearchPrograms } from './ab-testing';

type TaskAuditRow = {
  id: string;
  title: string;
  updated_at: string;
  merge_status?: string;
  merge_pr_url?: string;
  idea_id?: string;
};

type CycleAuditRow = {
  id: string;
  status: string;
  completed_at?: string;
  product_program_sha?: string;
};

function parseSettings(settings?: string): Record<string, unknown> {
  if (!settings) return {};
  try {
    const parsed = JSON.parse(settings);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function repoNameFromUrl(repoUrl?: string): string | null {
  if (!repoUrl) return null;
  const trimmed = repoUrl.trim().replace(/\/$/, '');
  const lastSegment = trimmed.split('/').pop();
  return lastSegment ? lastSegment.replace(/\.git$/i, '') : null;
}

export function hashProductProgram(programText: string): string {
  return crypto.createHash('sha256').update(programText).digest('hex');
}

function resolveCanonicalRepoRoot(product: Product): string | null {
  const settings = parseSettings(product.settings);
  const explicitRoot = settings.repo_checkout_path;
  if (typeof explicitRoot === 'string' && explicitRoot.trim()) {
    return explicitRoot.trim();
  }

  const repoName = repoNameFromUrl(product.repo_url);
  if (!repoName) return null;

  const candidates = [
    path.resolve(process.cwd(), '..', repoName),
    process.env.WORKSPACE_BASE_PATH ? path.resolve(process.env.WORKSPACE_BASE_PATH, repoName) : null,
    process.env.PROJECTS_PATH ? path.resolve(process.env.PROJECTS_PATH, repoName) : null,
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  }

  return null;
}

export function resolveCanonicalProgramPath(product: Product): string | null {
  const settings = parseSettings(product.settings);
  const explicitPath = settings.canonical_program_path;
  if (typeof explicitPath === 'string' && explicitPath.trim()) {
    return explicitPath.trim();
  }

  const repoRoot = resolveCanonicalRepoRoot(product);
  if (!repoRoot) return null;

  const candidate = path.join(repoRoot, 'docs', 'PRODUCT_PROGRAM.md');
  return fs.existsSync(candidate) ? candidate : null;
}

export function getCurrentProgramProvenance(productId: string, product?: Product): { sha: string; snapshot: string } {
  const resolvedProduct = product || queryOne<Product>('SELECT * FROM products WHERE id = ?', [productId]);
  if (!resolvedProduct) {
    throw new Error(`Product ${productId} not found`);
  }

  const primaryProgram = resolvedProduct.product_program || '';
  const programs = getResearchPrograms(productId);
  const hasVariants = programs.some((entry) => entry.variantId !== null);

  const snapshot = hasVariants
    ? JSON.stringify({
        primaryProgram,
        variants: programs.map((entry) => ({
          variantId: entry.variantId,
          variantName: entry.variantName,
          program: entry.program,
        })),
      })
    : primaryProgram;

  return {
    sha: hashProductProgram(primaryProgram),
    snapshot,
  };
}

function readCanonicalProductProgram(product: Product): { text: string; sha: string; programPath: string } | null {
  const programPath = resolveCanonicalProgramPath(product);
  if (!programPath) return null;

  const text = fs.readFileSync(programPath, 'utf8');
  return {
    text,
    sha: hashProductProgram(text),
    programPath,
  };
}

function mapCycleRow(row: CycleAuditRow | undefined, dbSha: string, canonicalSha?: string) {
  if (!row) return undefined;
  return {
    id: row.id,
    status: row.status,
    completed_at: row.completed_at,
    product_program_sha: row.product_program_sha,
    matches_db_program: Boolean(row.product_program_sha && row.product_program_sha === dbSha),
    matches_canonical_program: Boolean(canonicalSha && row.product_program_sha && row.product_program_sha === canonicalSha),
  };
}

export function getProductProgramDriftSummary(productId: string): ProductProgramDriftSummary {
  const product = queryOne<Product>('SELECT * FROM products WHERE id = ?', [productId]);
  if (!product) {
    throw new Error(`Product ${productId} not found`);
  }

  const dbProgram = product.product_program || '';
  const dbProgramSha = hashProductProgram(dbProgram);
  const canonical = readCanonicalProductProgram(product);
  const latestResearch = queryOne<CycleAuditRow>(
    `SELECT id, status, completed_at, product_program_sha
       FROM research_cycles
      WHERE product_id = ?
      ORDER BY started_at DESC
      LIMIT 1`,
    [productId],
  );
  const latestIdeation = queryOne<CycleAuditRow>(
    `SELECT id, status, completed_at, product_program_sha
       FROM ideation_cycles
      WHERE product_id = ?
      ORDER BY started_at DESC
      LIMIT 1`,
    [productId],
  );
  const latestAudit = queryOne<ProductProgramAudit>(
    `SELECT * FROM product_program_audits WHERE product_id = ? ORDER BY created_at DESC LIMIT 1`,
    [productId],
  );
  const recentCompletedTasks = queryAll<TaskAuditRow>(
    `SELECT id, title, updated_at, merge_status, merge_pr_url, idea_id
       FROM tasks
      WHERE product_id = ?
        AND status = 'done'
      ORDER BY updated_at DESC
      LIMIT 15`,
    [productId],
  );

  if (!canonical) {
    return {
      canonical_available: false,
      drift_detected: false,
      message: 'Canonical PRODUCT_PROGRAM.md could not be resolved from a local repo checkout. Configure canonical_program_path or repo_checkout_path in product settings to enable sync guarding.',
      db_program_sha: dbProgramSha,
      recent_completed_tasks: recentCompletedTasks,
      latest_research: mapCycleRow(latestResearch, dbProgramSha),
      latest_ideation: mapCycleRow(latestIdeation, dbProgramSha),
      latest_audit: latestAudit,
    };
  }

  const driftDetected = canonical.sha !== dbProgramSha;
  return {
    canonical_available: true,
    drift_detected: driftDetected,
    message: driftDetected
      ? 'Mission Control Product Program is out of sync with squti canonical PRODUCT_PROGRAM.md. Run Audit & Sync Program before research or ideation.'
      : 'Mission Control Product Program matches the canonical squti PRODUCT_PROGRAM.md.',
    canonical_program_path: canonical.programPath,
    db_program_sha: dbProgramSha,
    canonical_program_sha: canonical.sha,
    recent_completed_tasks: recentCompletedTasks,
    latest_research: mapCycleRow(latestResearch, dbProgramSha, canonical.sha),
    latest_ideation: mapCycleRow(latestIdeation, dbProgramSha, canonical.sha),
    latest_audit: latestAudit,
  };
}

export function assertProductProgramInSync(productId: string, cycleType: 'research' | 'ideation'): void {
  const drift = getProductProgramDriftSummary(productId);
  if (drift.canonical_available && drift.drift_detected) {
    emitAutopilotActivity({
      productId,
      cycleId: `program:${productId}`,
      cycleType: 'program',
      eventType: 'program_sync_blocked_run',
      message: `${cycleType === 'research' ? 'Research' : 'Ideation'} blocked by Product Program drift`,
      detail: drift.message,
    });
    throw new Error(drift.message);
  }
}

export function runProductProgramAuditAndSync(
  productId: string,
  options?: { syncOnDrift?: boolean; triggeredBy?: 'manual' | 'automatic' },
) {
  const product = queryOne<Product>('SELECT * FROM products WHERE id = ?', [productId]);
  if (!product) {
    throw new Error(`Product ${productId} not found`);
  }

  const auditId = uuidv4();
  const createdAt = new Date().toISOString();
  const triggeredBy = options?.triggeredBy || 'manual';

  emitAutopilotActivity({
    productId,
    cycleId: auditId,
    cycleType: 'program',
    eventType: 'program_sync_started',
    message: 'Program audit started',
    detail: 'Reviewing completed work against canonical squti PRODUCT_PROGRAM.md',
  });

  try {
    const before = getProductProgramDriftSummary(productId);
    const canonical = readCanonicalProductProgram(product);
    let synced = false;
    let dbProgramShaAfter = before.db_program_sha;

    if (canonical && before.drift_detected && options?.syncOnDrift !== false) {
      run(
        `UPDATE products SET product_program = ?, updated_at = ? WHERE id = ?`,
        [canonical.text, new Date().toISOString(), productId],
      );
      synced = true;
      dbProgramShaAfter = canonical.sha;
    }

    const after = getProductProgramDriftSummary(productId);
    const summary = {
      canonical_available: before.canonical_available,
      drift_detected_before: before.drift_detected,
      drift_detected_after: after.drift_detected,
      synced,
      recent_completed_task_count: before.recent_completed_tasks.length,
      recent_completed_tasks: before.recent_completed_tasks,
      latest_research: after.latest_research,
      latest_ideation: after.latest_ideation,
      recommendation: after.drift_detected
        ? 'Resolve Product Program drift before running research or ideation.'
        : 'Product Program is in sync. Safe to run a fresh research cycle.',
    };

    run(
      `INSERT INTO product_program_audits (id, product_id, status, triggered_by, drift_detected, synced, db_program_sha_before, db_program_sha_after, canonical_program_sha, summary_json, created_at, completed_at)
       VALUES (?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        auditId,
        productId,
        triggeredBy,
        before.drift_detected ? 1 : 0,
        synced ? 1 : 0,
        before.db_program_sha,
        dbProgramShaAfter,
        before.canonical_program_sha || null,
        JSON.stringify(summary),
        createdAt,
        new Date().toISOString(),
      ],
    );

    emitAutopilotActivity({
      productId,
      cycleId: auditId,
      cycleType: 'program',
      eventType: before.drift_detected ? 'program_sync_completed' : 'program_audit_completed',
      message: before.drift_detected ? 'Program audit completed and DB copy synced' : 'Program audit completed with no drift',
      detail: summary.recommendation,
    });

    return {
      audit_id: auditId,
      ...summary,
      db_program_sha_before: before.db_program_sha,
      db_program_sha_after: dbProgramShaAfter,
      canonical_program_sha: before.canonical_program_sha,
      canonical_program_path: before.canonical_program_path,
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    run(
      `INSERT INTO product_program_audits (id, product_id, status, triggered_by, drift_detected, synced, db_program_sha_before, db_program_sha_after, canonical_program_sha, summary_json, created_at, completed_at)
       VALUES (?, ?, 'failed', ?, 0, 0, NULL, NULL, NULL, ?, ?, ?)`,
      [auditId, productId, triggeredBy, JSON.stringify({ error: errMsg }), createdAt, new Date().toISOString()],
    );
    emitAutopilotActivity({
      productId,
      cycleId: auditId,
      cycleType: 'program',
      eventType: 'error',
      message: 'Program audit failed',
      detail: errMsg,
    });
    throw error;
  }
}