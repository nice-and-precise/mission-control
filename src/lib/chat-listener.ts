/**
 * Chat Listener — captures agent responses to user chat messages.
 *
 * Strategy: tracks which sessionKeys have pending user chat messages.
 * When a state=final chat_event arrives on a tracked session, stores
 * it as the agent's reply and clears the tracking.
 */
import { getOpenClawClient } from '@/lib/openclaw/client';
import { createNote } from '@/lib/task-notes';
import { broadcast } from '@/lib/events';
import { parseAgentSignal, processAgentSignal } from '@/lib/agent-signals';
import { rememberOpenClawRunId } from '@/lib/openclaw/session-runtime';
import { isRuntimeBootEnabled } from '@/lib/runtime-boot';

const GLOBAL_LISTENER_KEY = '__chat_listener_attached__';

// Sessions awaiting a reply: sessionKey → { taskId, sentAt }
const PENDING_KEY = '__chat_pending_replies__';
if (!(PENDING_KEY in globalThis)) {
  (globalThis as Record<string, unknown>)[PENDING_KEY] = new Map<string, { taskId: string; sentAt: number }>();
}
const pendingReplies = (globalThis as unknown as Record<string, Map<string, { taskId: string; sentAt: number }>>)[PENDING_KEY];

interface ChatEventPayload {
  runId?: string;
  sessionKey?: string;
  seq?: number;
  state?: string;
  message?: string | { role?: string; content?: unknown };
}

/**
 * Mark a session as expecting a reply from the agent.
 * Called by the chat route after sending a message.
 */
export function expectReply(sessionKey: string, taskId: string): void {
  pendingReplies.set(sessionKey, { taskId, sentAt: Date.now() });
  // Auto-expire after 5 minutes
  const expiryTimer = setTimeout(() => {
    const entry = pendingReplies.get(sessionKey);
    if (entry && Date.now() - entry.sentAt >= 300000) {
      pendingReplies.delete(sessionKey);
    }
  }, 300000);
  expiryTimer.unref?.();
}

export function extractContent(message: ChatEventPayload['message']): string {
  if (typeof message === 'string') return message;
  if (!message || typeof message !== 'object') return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return (message.content as Array<{ type?: string; text?: string }>)
      .filter(c => (c.type === 'text' || c.type === 'output_text') && c.text)
      .map(c => c.text!)
      .join('\n');
  }
  return '';
}

export function attachChatListener(): void {
  if (!isRuntimeBootEnabled()) return;
  if ((globalThis as Record<string, unknown>)[GLOBAL_LISTENER_KEY]) return;
  (globalThis as Record<string, unknown>)[GLOBAL_LISTENER_KEY] = true;

  const client = getOpenClawClient();

  client.on('chat_event', (payload: ChatEventPayload) => {
    if (!payload.sessionKey) return;

    if (payload.runId) {
      rememberOpenClawRunId(payload.sessionKey, payload.runId);
    }

    // Only process final (complete) messages
    if (payload.state !== 'final') return;

    // Skip user messages (state would be 'user' but we filter for 'final' already)
    const content = extractContent(payload.message);
    if (!content.trim()) return;

    if (parseAgentSignal(content)) {
      pendingReplies.delete(payload.sessionKey);
      void processAgentSignal({
        sessionKey: payload.sessionKey,
        message: content,
      }).catch((err) => {
        console.error('[ChatListener] Failed to process agent signal:', err);
      });
      return;
    }

    // Check if this session is expecting a reply
    const pending = pendingReplies.get(payload.sessionKey);
    if (!pending) return;

    // Skip dispatch-template content that leaks through
    if (content.includes('NEW TASK ASSIGNED') || content.includes('OUTPUT DIRECTORY:')) return;

    // Got the reply — store it and clear the pending flag
    pendingReplies.delete(payload.sessionKey);

    try {
      console.log(`[ChatListener] Agent replied for task ${pending.taskId}: ${content.slice(0, 100)}...`);
      const note = createNote(pending.taskId, content.trim(), 'direct', 'assistant');
      broadcast({ type: 'note_delivered', payload: { taskId: pending.taskId, noteId: note.id } });
    } catch (err) {
      console.error('[ChatListener] Failed to store agent response:', err);
    }
  });

  console.log('[ChatListener] Attached to OpenClaw client');
}
