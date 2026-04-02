import { NextRequest, NextResponse } from 'next/server';
import { listOpenClawBackgroundTasks } from '@/lib/openclaw/background-tasks';
import type { OpenClawBackgroundTasksResponse } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const taskId = searchParams.get('taskId') || undefined;
    const result = await listOpenClawBackgroundTasks(taskId);
    return NextResponse.json<OpenClawBackgroundTasksResponse>(result);
  } catch (error) {
    console.error('Failed to load OpenClaw background tasks:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to load background tasks' },
      { status: 500 },
    );
  }
}
