import { NextRequest, NextResponse } from 'next/server';
import { createHmac } from 'crypto';
import { queryAll } from '@/lib/db';
import { processAgentSignal } from '@/lib/agent-signals';

/**
 * Verify HMAC-SHA256 signature of webhook request
 */
function verifyWebhookSignature(signature: string, rawBody: string): boolean {
  const webhookSecret = process.env.WEBHOOK_SECRET;
  
  if (!webhookSecret) {
    // Dev mode - skip validation
    return true;
  }

  if (!signature) {
    return false;
  }

  const expectedSignature = createHmac('sha256', webhookSecret)
    .update(rawBody)
    .digest('hex');

  return signature === expectedSignature;
}

/**
 * POST /api/webhooks/agent-completion
 * 
 * Receives completion notifications from agents.
 * Expected payload:
 * {
 *   "session_id": "mission-control-engineering",
 *   "message": "TASK_COMPLETE: Built the authentication system"
 * }
 * 
 * Or can be called with task_id directly:
 * {
 *   "task_id": "uuid",
 *   "summary": "Completed the task successfully"
 * }
 */
export async function POST(request: NextRequest) {
  try {
    // Read raw body for signature verification
    const rawBody = await request.text();
    
    // Verify webhook signature if WEBHOOK_SECRET is set
    const webhookSecret = process.env.WEBHOOK_SECRET;
    if (webhookSecret) {
      const signature = request.headers.get('x-webhook-signature');
      
      if (!signature || !verifyWebhookSignature(signature, rawBody)) {
        console.warn('[WEBHOOK] Invalid signature attempt');
        return NextResponse.json(
          { error: 'Unauthorized' },
          { status: 401 }
        );
      }
    }

    const body = JSON.parse(rawBody);
    if (body.task_id) {
      const result = await processAgentSignal({
        taskId: body.task_id,
        message: body.message || `TASK_COMPLETE: ${body.summary || 'Task finished'}`,
      });

      if (!result.handled) {
        return NextResponse.json({ error: 'No completion signal found in payload' }, { status: 400 });
      }

      return NextResponse.json({ success: true, task_id: result.taskId, signal: result.signal, error: result.error || null });
    }

    // Handle session-based completion (from message parsing)
    if (body.session_id && body.message) {
      const result = await processAgentSignal({
        sessionId: body.session_id,
        message: body.message,
      });

      if (!result.handled) {
        return NextResponse.json(
          { error: 'Invalid completion message format. Expected a TASK_COMPLETE/BLOCKED/TEST_PASS/TEST_FAIL/VERIFY_PASS/VERIFY_FAIL signal.' },
          { status: 400 }
        );
      }

      return NextResponse.json({ success: true, task_id: result.taskId, signal: result.signal, error: result.error || null });
    }

    return NextResponse.json(
      { error: 'Invalid payload. Provide either task_id or session_id + message' },
      { status: 400 }
    );
  } catch (error) {
    console.error('Agent completion webhook error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * GET /api/webhooks/agent-completion
 * 
 * Returns webhook status and recent completions
 */
export async function GET() {
  try {
    const recentCompletions = queryAll(
      `SELECT e.*, a.name as agent_name, t.title as task_title
       FROM events e
       LEFT JOIN agents a ON e.agent_id = a.id
       LEFT JOIN tasks t ON e.task_id = t.id
       WHERE e.type = 'task_completed'
       ORDER BY e.created_at DESC
       LIMIT 10`
    );

    return NextResponse.json({
      status: 'active',
      recent_completions: recentCompletions,
      endpoint: '/api/webhooks/agent-completion'
    });
  } catch (error) {
    console.error('Failed to fetch completion status:', error);
    return NextResponse.json(
      { error: 'Failed to fetch status' },
      { status: 500 }
    );
  }
}
