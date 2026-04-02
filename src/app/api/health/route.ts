import { NextResponse } from 'next/server';
import { getMissionControlHealth } from '@/lib/health';

export const dynamic = 'force-dynamic';

// GET /api/health - Check Mission Control runtime and database health
export async function GET() {
  try {
    return NextResponse.json(getMissionControlHealth());
  } catch (error) {
    console.error('Mission Control health check failed:', error);
    return NextResponse.json(
      {
        status: 'error',
        error: error instanceof Error ? error.message : 'Internal server error',
      },
      { status: 500 },
    );
  }
}
