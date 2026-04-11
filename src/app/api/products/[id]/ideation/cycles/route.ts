import { NextRequest, NextResponse } from 'next/server';
import { getIdeationCycles } from '@/lib/autopilot/ideation';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const cycles = getIdeationCycles(id);
    return NextResponse.json(cycles);
  } catch (error) {
    console.error('Failed to fetch ideation cycles:', error);
    return NextResponse.json({ error: 'Failed to fetch ideation cycles' }, { status: 500 });
  }
}
