import { NextRequest, NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';
import { run } from '@/lib/db';
import { broadcast } from '@/lib/events';

function verifyGitHubSignature(signature: string, rawBody: string): boolean {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) return true; // dev mode bypass if not set

  if (!signature || !signature.startsWith('sha256=')) {
    return false;
  }

  const expectedSignature = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.text();
    const signature = req.headers.get('x-hub-signature-256');

    if (!verifyGitHubSignature(signature || '', rawBody)) {
      console.warn('[GitHub Webhook] Invalid signature attempt');
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const event = req.headers.get('x-github-event');
    if (event !== 'pull_request') {
      return NextResponse.json({ ignored: true, reason: 'Not a pull_request event' });
    }

    const body = JSON.parse(rawBody);
    
    // We only care about merged PRs
    if (body.action !== 'closed' || !body.pull_request?.merged) {
      return NextResponse.json({ ignored: true, reason: 'PR not merged' });
    }

    const headRef = body.pull_request.head.ref; // e.g. autopilot/feature-task_abcd1234
    if (!headRef) {
      return NextResponse.json({ ignored: true, reason: 'No head ref' });
    }

    // Extract task ID from branch name or body
    const match = headRef.match(/-(task_[a-z0-9-]+)$/i);
    const taskId = match ? match[1] : null;

    if (!taskId) {
      return NextResponse.json({ ignored: true, reason: 'No task ID found in branch name' });
    }

    // Update the task to done
    run(
      `UPDATE tasks 
       SET status = 'done', merge_status = 'merged', updated_at = datetime('now') 
       WHERE id = ?`,
      [taskId]
    );

    // Record activity
    run(
      `INSERT INTO task_activities (id, task_id, activity_type, message, created_at)
       VALUES (lower(hex(randomblob(16))), ?, 'status_changed', ?, datetime('now'))`,
      [taskId, `Task merged into default branch via GitHub PR #${body.pull_request.number}`]
    );

    // Broadcast the update so UI refreshes
    broadcast({
      type: 'task_updated',
      payload: { taskId, status: 'done' }
    });

    console.log(`[GitHub Webhook] Marked task ${taskId} as done (PR #${body.pull_request.number} merged)`);
    return NextResponse.json({ success: true, task_id: taskId });

  } catch (error) {
    console.error('[GitHub Webhook] Error processing payload:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
