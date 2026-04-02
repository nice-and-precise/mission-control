'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import type { OpenClawBackgroundTask, OpenClawBackgroundTasksResponse } from '@/lib/types';

interface BackgroundTasksListProps {
  taskId: string;
}

export function BackgroundTasksList({ taskId }: BackgroundTasksListProps) {
  const [tasks, setTasks] = useState<OpenClawBackgroundTask[]>([]);
  const [status, setStatus] = useState<OpenClawBackgroundTasksResponse['status']>('ok');
  const [warning, setWarning] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadTasks = useCallback(async () => {
    setLoading(true);
    setError(null);
    setStatus('ok');
    setWarning(null);
    try {
      const res = await fetch(`/api/openclaw/background-tasks?taskId=${encodeURIComponent(taskId)}`);
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to load detached work');
      }
      setTasks(Array.isArray(data.tasks) ? data.tasks : []);
      setStatus(data.status === 'degraded' ? 'degraded' : 'ok');
      setWarning(typeof data.warning === 'string' ? data.warning : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load detached work');
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    loadTasks();
  }, [loadTasks]);

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-8 text-mc-text-secondary">
        <Loader2 className="w-4 h-4 animate-spin" />
        <span>Loading detached work...</span>
      </div>
    );
  }

  if (error) {
    return <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">{error}</div>;
  }

  if (tasks.length === 0) {
    return (
      <div className="space-y-3">
        {status === 'degraded' && warning && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <div>
                <div className="font-medium text-amber-100">Detached work is temporarily unavailable</div>
                <div>{warning}</div>
              </div>
            </div>
          </div>
        )}
        {status === 'ok' && (
          <div className="flex flex-col items-center justify-center py-8 text-mc-text-secondary">
            <div className="text-4xl mb-2">🧵</div>
            <p>No detached OpenClaw work is linked to this task.</p>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {status === 'degraded' && warning && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <div>
              <div className="font-medium text-amber-100">Detached work is temporarily degraded</div>
              <div>{warning}</div>
            </div>
          </div>
        </div>
      )}
      {tasks.map((task) => (
        <div key={task.id} className="rounded-lg border border-mc-border bg-mc-bg p-3 space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div className="font-medium text-sm text-mc-text">
              {task.runtimeKind || 'detached'} • {task.status || 'unknown'}
            </div>
            <div className="text-xs text-mc-text-secondary font-mono">
              {task.runId || task.id}
            </div>
          </div>
          {task.sessionKey && (
            <div className="text-xs text-mc-text-secondary">
              Session: <span className="font-mono break-all">{task.sessionKey}</span>
            </div>
          )}
          <div className="text-xs text-mc-text-secondary flex flex-wrap gap-x-3 gap-y-1">
            {task.startedAt && <span>Started {new Date(task.startedAt).toLocaleString()}</span>}
            {task.endedAt && <span>Ended {new Date(task.endedAt).toLocaleString()}</span>}
            {task.updatedAt && !task.endedAt && <span>Updated {new Date(task.updatedAt).toLocaleString()}</span>}
          </div>
          {task.correlatedSession && (
            <div className="text-xs text-mc-text-secondary">
              Linked MC session: <span className="font-mono">{task.correlatedSession.openclawSessionId}</span>
              {task.correlatedSession.agentName ? ` • ${task.correlatedSession.agentName}` : ''}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
