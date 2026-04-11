import { NextResponse } from 'next/server';
import { runProductProgramAuditAndSync } from '@/lib/autopilot/product-program-sync';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    let syncOnDrift = true;
    try {
      const body = await request.json();
      if (typeof body?.syncOnDrift === 'boolean') {
        syncOnDrift = body.syncOnDrift;
      }
    } catch {
      // Default behavior is sync-on-drift.
    }

    return NextResponse.json(
      runProductProgramAuditAndSync(id, { syncOnDrift, triggeredBy: 'manual' }),
    );
  } catch (error) {
    console.error('Failed to run product program audit/sync:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to audit/sync Product Program' },
      { status: 500 },
    );
  }
}