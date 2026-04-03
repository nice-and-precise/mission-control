import { NextRequest, NextResponse } from 'next/server';
import { getCostBreakdown, getPerFeatureStats } from '@/lib/costs/reporting';
import { syncOpenClawBuildUsage } from '@/lib/openclaw/session-runtime';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const workspaceId = searchParams.get('workspace_id') || 'default';
    const productId = searchParams.get('product_id') || undefined;
    await syncOpenClawBuildUsage({ workspaceId, productId }).catch((error) => {
      console.warn('[costs/breakdown] build usage sync failed:', error);
    });
    const breakdown = getCostBreakdown(workspaceId, productId);
    const perFeature = getPerFeatureStats(workspaceId, productId);
    return NextResponse.json({ ...breakdown, per_feature: perFeature });
  } catch (error) {
    console.error('Failed to fetch cost breakdown:', error);
    return NextResponse.json({ error: 'Failed to fetch cost breakdown' }, { status: 500 });
  }
}
