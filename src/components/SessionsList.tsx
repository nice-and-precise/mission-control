/**
 * SessionsList Component
 * Displays OpenClaw sub-agent sessions for a task
 */

'use client';

import { useEffect, useState, useCallback } from 'react';
import { Fragment } from 'react';
import { Bot, CheckCircle, Circle, XCircle, Trash2, Check, History } from 'lucide-react';

interface SessionWithAgent {
  id: string;
  agent_id: string | null;
  openclaw_session_id: string;
  channel: string | null;
  status: string;
  session_type: string;
  task_id: string | null;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
  agent_name?: string;
  agent_avatar_emoji?: string;
}

interface SessionsListProps {
  taskId: string;
}

export function SessionsList({ taskId }: SessionsListProps) {
  const [sessions, setSessions] = useState<SessionWithAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedHistory, setExpandedHistory] = useState<Record<string, string[]>>({});

  const loadSessions = useCallback(async () => {
    try {
      const res = await fetch(`/api/tasks/${taskId}/subagent`);
      if (res.ok) {
        const data = await res.json();
        setSessions(data);
      }
    } catch (error) {
      console.error('Failed to load sessions:', error);
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'active':
        return <Circle className="w-4 h-4 text-green-500 fill-current animate-pulse" />;
      case 'completed':
        return <CheckCircle className="w-4 h-4 text-mc-accent" />;
      case 'failed':
        return <XCircle className="w-4 h-4 text-red-500" />;
      default:
        return <Circle className="w-4 h-4 text-mc-text-secondary" />;
    }
  };

  const formatDuration = (start: string, end?: string | null) => {
    const startTime = new Date(start).getTime();
    const endTime = end ? new Date(end).getTime() : Date.now();
    const duration = endTime - startTime;

    const seconds = Math.floor(duration / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  };

  const formatTimestamp = (timestamp: string) => {
    const date = new Date(timestamp);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  };

  const handleMarkComplete = async (sessionId: string) => {
    try {
      const res = await fetch(`/api/openclaw/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'completed',
          ended_at: new Date().toISOString(),
        }),
      });
      if (res.ok) {
        loadSessions();
      }
    } catch (error) {
      console.error('Failed to mark session complete:', error);
    }
  };

  const handleDelete = async (sessionId: string) => {
    if (!confirm('Delete this sub-agent session?')) return;
    try {
      const res = await fetch(`/api/openclaw/sessions/${sessionId}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        loadSessions();
      }
    } catch (error) {
      console.error('Failed to delete session:', error);
    }
  };

  const toggleHistory = async (sessionRef: string) => {
    if (expandedHistory[sessionRef]) {
      setExpandedHistory((prev) => {
        const next = { ...prev };
        delete next[sessionRef];
        return next;
      });
      return;
    }

    try {
      const res = await fetch(`/api/openclaw/sessions/${encodeURIComponent(sessionRef)}/history?limit=10`);
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to load history');
      }
      const lines = Array.isArray(data.items)
        ? data.items
            .map((item: { role?: string; content?: unknown; message?: { content?: unknown } }) => {
              const content = typeof item.content === 'string'
                ? item.content
                : Array.isArray(item.content)
                  ? item.content.map((entry) => (entry && typeof entry === 'object' && typeof (entry as { text?: string }).text === 'string') ? (entry as { text: string }).text : '').filter(Boolean).join('\n')
                  : '';
              const fallback = typeof item.message?.content === 'string' ? item.message.content : '';
              const text = (content || fallback || '').trim();
              return text ? `${item.role || 'message'}: ${text}` : null;
            })
            .filter((line: string | null): line is string => Boolean(line))
        : [];
      setExpandedHistory((prev) => ({ ...prev, [sessionRef]: lines.slice(-5) }));
    } catch (error) {
      console.error('Failed to load session history:', error);
      setExpandedHistory((prev) => ({
        ...prev,
        [sessionRef]: [error instanceof Error ? error.message : 'Failed to load session history'],
      }));
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="text-mc-text-secondary">Loading sessions...</div>
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-mc-text-secondary">
        <div className="text-4xl mb-2">🤖</div>
        <p>No sub-agent sessions yet</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {sessions.map((session) => (
        <Fragment key={session.id}>
          <div className="flex gap-3 p-3 bg-mc-bg rounded-lg border border-mc-border">
            {/* Agent Avatar */}
            <div className="flex-shrink-0">
              {session.agent_avatar_emoji ? (
                <span className="text-2xl">{session.agent_avatar_emoji}</span>
              ) : (
                <Bot className="w-8 h-8 text-mc-accent" />
              )}
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
              {/* Agent name and status */}
              <div className="flex items-center gap-2 mb-1">
                {getStatusIcon(session.status)}
                <span className="font-medium text-mc-text">
                  {session.agent_name || 'Sub-Agent'}
                </span>
                <span className="text-xs text-mc-text-secondary capitalize">
                  {session.status}
                </span>
              </div>

              {/* Session ID */}
              <div className="text-xs text-mc-text-secondary font-mono mb-2 truncate">
                Session: {session.openclaw_session_id}
              </div>

              {/* Duration and timestamps */}
              <div className="flex items-center gap-3 text-xs text-mc-text-secondary">
                <span>
                  Duration: {formatDuration(session.created_at, session.ended_at)}
                </span>
                <span>•</span>
                <span>Started {formatTimestamp(session.created_at)}</span>
              </div>

              {/* Channel */}
              {session.channel && (
                <div className="mt-2 text-xs text-mc-text-secondary">
                  Channel: <span className="font-mono">{session.channel}</span>
                </div>
              )}
            </div>

            {/* Action Buttons */}
            <div className="flex flex-col gap-1">
              {session.status === 'active' && (
                <button
                  onClick={() => handleMarkComplete(session.openclaw_session_id)}
                  className="p-1.5 hover:bg-mc-bg-tertiary rounded text-green-500"
                  title="Mark as complete"
                >
                  <Check className="w-4 h-4" />
                </button>
              )}
              <button
                onClick={() => toggleHistory(session.openclaw_session_id)}
                className="p-1.5 hover:bg-mc-bg-tertiary rounded text-mc-text-secondary"
                title="Toggle history"
              >
                <History className="w-4 h-4" />
              </button>
              <button
                onClick={() => handleDelete(session.openclaw_session_id)}
                className="p-1.5 hover:bg-mc-bg-tertiary rounded text-red-500"
                title="Delete session"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
          {expandedHistory[session.openclaw_session_id] && (
            <div className="ml-11 mt-2 rounded-lg border border-mc-border bg-mc-bg p-3 text-xs text-mc-text-secondary space-y-2">
              {expandedHistory[session.openclaw_session_id].map((line, index) => (
                <div key={`${session.openclaw_session_id}-${index}`} className="whitespace-pre-wrap break-words font-mono">
                  {line}
                </div>
              ))}
            </div>
          )}
        </Fragment>
      ))}
    </div>
  );
}
