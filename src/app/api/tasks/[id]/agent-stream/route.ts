import { NextRequest } from 'next/server';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { getTaskStreamState } from '@/lib/task-evidence';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface AgentEventPayload {
  runId?: string;
  stream?: string;
  data?: string;
  sessionKey?: string;
  seq?: number;
  ts?: string;
}

interface ChatEventPayload {
  runId?: string;
  sessionKey?: string;
  seq?: number;
  state?: string;
  message?: string | { role?: string; content?: unknown };
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const { id: taskId } = await params;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let messageIndex = 0;
      let streamState: 'connecting' | 'streaming' | 'no_session' | 'session_ended' | 'error' = 'connecting';
      let sessionPollInterval: NodeJS.Timeout | null = null;
      let keepAliveInterval: NodeJS.Timeout | null = null;
      let listenersAttached = false;
      let closed = false;
      let watchedSessionKeys = new Set<string>();
      const client = getOpenClawClient();

      const send = (data: object) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          cleanup();
        }
      };

      const cleanup = () => {
        closed = true;
        if (sessionPollInterval) clearInterval(sessionPollInterval);
        if (keepAliveInterval) clearInterval(keepAliveInterval);
        if (listenersAttached) {
          client.removeListener('agent_event', onAgentEvent);
          client.removeListener('chat_event', onChatEvent);
        }
        try { controller.close(); } catch {}
      };

      const sendStatus = (type: 'streaming' | 'no_session' | 'session_ended' | 'error') => {
        if (streamState === type) return;
        streamState = type;
        send({ type });
      };

      // Handler for real-time agent streaming events (tokens, tool calls, etc.)
      const onAgentEvent = (payload: AgentEventPayload) => {
        if (!payload.sessionKey || !watchedSessionKeys.has(payload.sessionKey)) return;

        send({
          type: 'agent_stream',
          index: messageIndex++,
          stream: payload.stream || 'unknown',
          data: payload.data || '',
          timestamp: payload.ts || new Date().toISOString(),
        });
      };

      // Handler for chat turn events (complete messages between user/agent)
      const onChatEvent = (payload: ChatEventPayload) => {
        if (!payload.sessionKey || !watchedSessionKeys.has(payload.sessionKey)) return;

        let role = 'system';
        let content = '';

        if (typeof payload.message === 'string') {
          // Simple string message
          content = payload.message;
          role = payload.state === 'user' ? 'user' : 'assistant';
        } else if (payload.message && typeof payload.message === 'object') {
          // Structured message
          role = payload.message.role || (payload.state === 'user' ? 'user' : 'assistant');
          if (typeof payload.message.content === 'string') {
            content = payload.message.content;
          } else if (Array.isArray(payload.message.content)) {
            content = (payload.message.content as Array<{ type?: string; text?: string }>)
              .filter(c => c.type === 'text' && c.text)
              .map(c => c.text!)
              .join('\n');
          }
        }

        if (content || payload.state) {
          send({
            type: 'message',
            index: messageIndex++,
            role,
            content: content || `[${payload.state}]`,
            state: payload.state,
            timestamp: new Date().toISOString(),
          });
        }
      };

      const ensureListeners = async () => {
        if (listenersAttached) return true;
        // Ensure we're connected
        if (!client.isConnected()) {
          try {
            await client.connect();
          } catch (err) {
            console.error('[AgentStream] Failed to connect:', err);
            sendStatus('error');
            return false;
          }
        }

        client.on('agent_event', onAgentEvent);
        client.on('chat_event', onChatEvent);
        listenersAttached = true;
        return true;
      };

      const refreshStreamState = async () => {
        try {
          const snapshot = await getTaskStreamState(taskId);
          watchedSessionKeys = new Set(snapshot.activeSessionKeys);

          if (snapshot.status === 'streaming') {
            const connected = await ensureListeners();
            if (connected) {
              sendStatus('streaming');
            }
            return;
          }

          if (snapshot.status === 'session_ended') {
            sendStatus('session_ended');
            return;
          }

          sendStatus('no_session');
        } catch (error) {
          console.error('[AgentStream] Failed to inspect task sessions:', error);
          sendStatus('error');
        }
      };

      const startPolling = () => {
        void refreshStreamState();
        sessionPollInterval = setInterval(() => {
          void refreshStreamState();
        }, 3000);
      };

      // Keep-alive ping
      keepAliveInterval = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          cleanup();
        }
      }, 15000);

      // Handle client disconnect
      request.signal.addEventListener('abort', () => {
        cleanup();
      });

      // Start
      startPolling();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
