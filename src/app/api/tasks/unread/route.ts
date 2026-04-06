import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// The UI polls this endpoint for unread badges. Server-side read tracking
// is not wired up yet in this local Mission Control baseline, so return an
// empty set instead of falling through to the dynamic task-id route.
export async function GET() {
  return NextResponse.json([]);
}
