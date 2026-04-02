import { NextRequest, NextResponse } from 'next/server';
import { loadGatewaySessionHistory } from '@/lib/openclaw/session-history';

export const dynamic = 'force-dynamic';
interface RouteParams {
  params: Promise<{ id: string }>;
}

// GET /api/openclaw/sessions/[id]/history - Get conversation history
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { id: sessionRef } = await params;
  const url = new URL(request.url);
  const includeTools = url.searchParams.get('includeTools') === '1';
  const limitParam = Number.parseInt(url.searchParams.get('limit') || '', 10);
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 100;

  try {
    const history = await loadGatewaySessionHistory(sessionRef, limit, { includeTools });
    return NextResponse.json(history);
  } catch (error) {
    console.error('Failed to load OpenClaw session history:', error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Failed to load session history',
        sessionRef,
      },
      { status: 500 },
    );
  }
}
