import { NextRequest, NextResponse } from 'next/server';
import { getCostOverview } from '@/lib/costs/reporting';
import { syncOpenClawBuildUsage } from '@/lib/openclaw/session-runtime';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const workspaceId = searchParams.get('workspace_id') || 'default';
    const productId = searchParams.get('product_id') || undefined;
    await syncOpenClawBuildUsage({ workspaceId, productId }).catch((error) => {
      console.warn('[costs] build usage sync failed:', error);
    });
    const overview = getCostOverview(workspaceId, productId);
    return NextResponse.json(overview);
  } catch (error) {
    console.error('Failed to fetch cost overview:', error);
    return NextResponse.json({ error: 'Failed to fetch cost overview' }, { status: 500 });
  }
}
