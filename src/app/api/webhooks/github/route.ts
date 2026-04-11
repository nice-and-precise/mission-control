import { NextRequest, NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';
import { run } from '@/lib/db';
import { broadcast } from '@/lib/events';

function verifyGitHubSignature(signature: string, rawBody: string): boolean {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') return false; // fail closed in prod
    return true; // dev mode bypass
  }

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

    const prUrl = body.pull_request.html_url;
    if (!prUrl) {
       return NextResponse.json({ ignored: true, reason: 'No PR html_url provided' });
    }

    // Identify task via stable identifier: the PR URL stored in the DB
    const tasks = queryAll<{ id: string }>(
      `SELECT id FROM tasks WHERE merge_pr_url = ? OR pr_url = ?`,
      [prUrl, prUrl]
    );

    if (!tasks || tasks.length === 0) {
      return NextResponse.json({ ignored: true, reason: 'No matching task found for this PR' });
    }

    const taskId = tasks[0].id;

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

    // Fetch the updated task for broadcast
    const updatedTask = queryOne(
      `SELECT * FROM tasks WHERE id = ?`,
      [taskId]
    );

    // Broadcast the update so UI refreshes
    if (updatedTask) {
      broadcast({
        type: 'task_updated',
        payload: updatedTask
      });
    }

    console.log(`[GitHub Webhook] Marked task ${taskId} as done (PR #${body.pull_request.number} merged)`);
    return NextResponse.json({ success: true, task_id: taskId });

  } catch (error) {
    console.error('[GitHub Webhook] Error processing payload:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
