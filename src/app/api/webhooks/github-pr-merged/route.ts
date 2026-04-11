import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { db } from '@/lib/db';

/**
 * GitHub PR merged webhook handler
 * 
 * Closes Mission Control tasks when their associated GitHub PRs are merged.
 * Configured in GitHub Settings > Webhooks with event: pull_request
 * 
 * Verification:
 * - Validates GitHub webhook signature (X-Hub-Signature-256)
 * - Checks PR payload action === 'closed' && merged === true
 * - Finds task by PR URL (extracted from PR body comment)
 * 
 * Action:
 * - Updates task status: planning -> done
 * - Marks delivery completed with merged PR SHA
 * - Logs task_activity record for audit
 */

const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || '';

function verifyGitHubSignature(req: NextRequest, payload: string): boolean {
  if (!GITHUB_WEBHOOK_SECRET) {
    console.warn('[PR-Merge] GITHUB_WEBHOOK_SECRET not configured. Skipping signature verification.');
    return process.env.NODE_ENV !== 'production';
  }

  const signature = req.headers.get('x-hub-signature-256');
  if (!signature) {
    console.error('[PR-Merge] Missing X-Hub-Signature-256 header');
    return false;
  }

  const hmac = crypto.createHmac('sha256', GITHUB_WEBHOOK_SECRET);
  hmac.update(payload);
  const hash = `sha256=${hmac.digest('hex')}`;

  const isValid = crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(hash)
  );

  return isValid;
}

/**
 * Extract task ID from PR body comment.
 * Operators add comment like: "<!-- MC-TASK: f47ac10b-58cc-4372-a567-0e02b2c3d479 -->"
 */
function extractTaskIdFromBody(prBody: string | null): string | null {
  if (!prBody) return null;
  
  const match = prBody.match(/<!-- MC-TASK: ([a-f0-9\-]+) -->/);
  return match ? match[1] : null;
}

/**
 * Alternative: Search task_deliverables table for this PR URL
 */
async function findTaskIdByPrUrl(prUrl: string): Promise<string | null> {
  try {
    const deliverable = await db.query(
      'SELECT task_id FROM task_deliverables WHERE deliverable_url = ?',
      [prUrl]
    );
    
    if (deliverable && deliverable.length > 0) {
      return deliverable[0].task_id;
    }
  } catch (err) {
    console.error('[PR-Merge] Error querying task_deliverables:', err);
  }
  
  return null;
}

export async function POST(req: NextRequest) {
  try {
    // Read and verify payload
    const payload = await req.text();
    
    if (!verifyGitHubSignature(req, payload)) {
      console.warn('[PR-Merge] Signature verification failed');
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }

    const event = JSON.parse(payload);
    
    // Only process PR closed events
    if (event.action !== 'closed' || !event.pull_request.merged) {
      console.log(`[PR-Merge] Skipping event action=${event.action}, merged=${event.pull_request.merged}`);
      return NextResponse.json({ message: 'Not a merged PR event' }, { status: 200 });
    }

    const pr = event.pull_request;
    const prUrl = pr.html_url;
    const prSha = pr.merge_commit_sha;
    
    console.log(`[PR-Merge] Processing merged PR: ${prUrl} (sha: ${prSha})`);

    // Method 1: Try extracting task ID from PR body comment
    let taskId = extractTaskIdFromBody(pr.body);
    
    // Method 2: Fallback to searching task_deliverables
    if (!taskId) {
      taskId = await findTaskIdByPrUrl(prUrl);
    }

    if (!taskId) {
      console.warn(`[PR-Merge] Could not find task ID for PR: ${prUrl}`);
      return NextResponse.json({ 
        message: 'Task ID not found in PR body or deliverables',
        prUrl 
      }, { status: 200 });
    }

    // Fetch task and verify it's in a valid state
    const taskResult = await db.query(
      'SELECT id, status, product_id FROM tasks WHERE id = ?',
      [taskId]
    );

    if (!taskResult || taskResult.length === 0) {
      console.warn(`[PR-Merge] Task not found: ${taskId}`);
      return NextResponse.json({ 
        message: 'Task not found',
        taskId 
      }, { status: 404 });
    }

    const task = taskResult[0];
    
    // Only close tasks that are in planning or assigned
    if (!['planning', 'assigned', 'in_progress', 'testing', 'review'].includes(task.status)) {
      console.log(`[PR-Merge] Task ${taskId} already in final state: ${task.status}`);
      return NextResponse.json({ 
        message: 'Task already in final state',
        taskId,
        currentStatus: task.status
      }, { status: 200 });
    }

    // Update task status to done
    await db.query(
      'UPDATE tasks SET status = ?, completed_at = datetime("now") WHERE id = ?',
      ['done', taskId]
    );

    // Record deliverable
    await db.query(
      'INSERT OR REPLACE INTO task_deliverables (id, task_id, deliverable_url, deliverable_sha, delivered_at) VALUES (?, ?, ?, ?, datetime("now"))',
      [`deliverable_${taskId}_${Date.now()}`, taskId, prUrl, prSha]
    );

    // Log activity for audit trail
    await db.query(
      'INSERT INTO task_activities (id, task_id, activity_type, details, created_at) VALUES (?, ?, ?, ?, datetime("now"))',
      [
        `activity_${taskId}_${Date.now()}`,
        taskId,
        'pr_merged',
        JSON.stringify({ prUrl, prSha, automation: 'github_webhook' })
      ]
    );

    console.log(`[PR-Merge] ✓ Closed task ${taskId} for PR ${prUrl}`);

    return NextResponse.json({ 
      success: true,
      taskId,
      prUrl,
      status: 'done'
    }, { status: 200 });

  } catch (error) {
    console.error('[PR-Merge] Webhook handler error:', error);
    return NextResponse.json(
      { error: 'Internal server error', details: String(error) },
      { status: 500 }
    );
  }
}

/**
 * GitHub webhook delivery log (for debugging)
 * GET returns last 10 deliveries
 */
export async function GET(req: NextRequest) {
  try {
    const deliveries = await db.query(
      'SELECT * FROM task_activities WHERE activity_type = "pr_merged" ORDER BY created_at DESC LIMIT 10'
    );

    return NextResponse.json({
      message: 'Recent PR-merged task closures',
      count: deliveries.length,
      deliveries
    }, { status: 200 });
  } catch (error) {
    console.error('[PR-Merge] Error fetching logs:', error);
    return NextResponse.json(
      { error: 'Failed to fetch logs' },
      { status: 500 }
    );
  }
}
