import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { getDb, transaction } from '@/lib/db';
import { getProduct } from '@/lib/autopilot/products';
import {
  hashProductProgram,
  readCanonicalProductProgram,
} from '@/lib/autopilot/product-program';

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const product = getProduct(params.id);
    if (!product) {
      return NextResponse.json({ error: 'Product not found' }, { status: 404 });
    }

    const canonical = await readCanonicalProductProgram(product);
    const beforeSha = hashProductProgram(product.product_program || '');
    const afterSha = hashProductProgram(canonical.content);
    const driftDetected = beforeSha !== afterSha;
    const now = new Date().toISOString();
    const auditId = uuidv4();

    transaction(() => {
      const db = getDb();
      db.prepare(
        `UPDATE products
         SET product_program = ?, canonical_program_path = ?, updated_at = ?
         WHERE id = ?`
      ).run(canonical.content, product.canonical_program_path || canonical.resolvedPath, now, product.id);

      db.prepare(
        `INSERT INTO product_program_audits (
           id, product_id, status, triggered_by, drift_detected, synced,
           db_program_sha_before, db_program_sha_after, canonical_program_sha,
           summary_json, created_at, completed_at
         )
         VALUES (?, ?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        auditId,
        product.id,
        'completed',
        driftDetected ? 1 : 0,
        1,
        beforeSha,
        afterSha,
        afterSha,
        JSON.stringify({
          source: canonical.source,
          resolved_path: canonical.resolvedPath,
          drift_detected: driftDetected,
        }),
        now,
        now,
      );
    });

    const updated = getProduct(product.id);
    return NextResponse.json(updated);
  } catch (err) {
    console.error('[SyncProgram]', err);
    const message = err instanceof Error ? err.message : 'Internal server error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
