import { NextRequest, NextResponse } from 'next/server';
import { getAllProductScores } from '@/lib/autopilot/health-score';

/**
 * GET /api/products/[id]/health/scores
 * Returns all product health scores as a map { productId: score }.
 * Note: the `id` path segment is unused — this returns scores for all products.
 * This is the batch health scores endpoint for this deployment.
 */
export async function GET() {
  try {
    const scores = getAllProductScores();
    return NextResponse.json(scores);
  } catch (error) {
    console.error('[API] Batch health scores error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch health scores' },
      { status: 500 }
    );
  }
}
