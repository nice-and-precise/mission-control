import { NextRequest, NextResponse } from 'next/server';
import { createProviderBillingSnapshot, getProviderBillingReconciliation } from '@/lib/costs/reconciliation';
import { CreateProviderBillingSnapshotSchema } from '@/lib/validation';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const workspaceId = searchParams.get('workspace_id') || 'default';
    const productId = searchParams.get('product_id') || undefined;
    return NextResponse.json(getProviderBillingReconciliation(workspaceId, productId));
  } catch (error) {
    console.error('Failed to fetch provider billing reconciliation:', error);
    return NextResponse.json({ error: 'Failed to fetch provider billing reconciliation' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const validation = CreateProviderBillingSnapshotSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json({ error: 'Validation failed', details: validation.error.issues }, { status: 400 });
    }
    return NextResponse.json(createProviderBillingSnapshot(validation.data), { status: 201 });
  } catch (error) {
    console.error('Failed to import provider billing snapshot:', error);
    return NextResponse.json({ error: 'Failed to import provider billing snapshot' }, { status: 500 });
  }
}
