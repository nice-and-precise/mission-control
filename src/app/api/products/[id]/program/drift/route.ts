import { NextResponse } from 'next/server';
import { getProductProgramDriftSummary } from '@/lib/autopilot/product-program-sync';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    return NextResponse.json(getProductProgramDriftSummary(id));
  } catch (error) {
    console.error('Failed to compute product program drift:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to compute Product Program drift' },
      { status: 500 },
    );
  }
}