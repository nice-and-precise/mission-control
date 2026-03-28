import { NextResponse } from 'next/server';

interface RouteParams {
  params: Promise<{ id: string }>;
}

// GET /api/openclaw/sessions/[id]/history - Get conversation history
export async function GET(_request: Request, { params }: RouteParams) {
  const { id } = await params;

  return NextResponse.json(
    {
      error: 'Session history is not available from the OpenClaw Gateway RPC surface Mission Control currently uses.',
      session_id: id,
      supported: false,
      suggestion: 'Use /api/openclaw/sessions/[id] for session metadata or the live task stream for current output.',
    },
    { status: 501 }
  );
}
