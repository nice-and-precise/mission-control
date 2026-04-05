
import { getMissionControlUrl } from '@/lib/config';


interface AutoDispatchOptions {
  taskId: string;
  taskTitle: string;
  agentId: string | null;
  agentName: string;
  workspaceId?: string;
}

interface AutoDispatchResult {
  success: boolean;
  queued?: boolean;
  error?: string;
  waitingForTaskId?: string;
  waitingForTaskTitle?: string;
}

/**
 * Narrow dispatch helper kept for server-side retry flows.
 *
 * Primary task creation/editing dispatch is now owned by server routes and the
 * workflow engine. Do not reintroduce this helper into client-side status
 * change flows; that was the source of earlier double-dispatch races.
 */
export async function triggerAutoDispatch(options: AutoDispatchOptions): Promise<AutoDispatchResult> {
  const { taskId, taskTitle, agentId, agentName } = options;

  if (!agentId) {
    return { success: false, error: 'No agent ID provided for dispatch' };
  }

  try {
    const missionControlUrl =
      typeof window === 'undefined' ? getMissionControlUrl() : '';
    const headers: Record<string, string> = {};
    if (typeof window === 'undefined' && process.env.MC_API_TOKEN) {
      headers.Authorization = `Bearer ${process.env.MC_API_TOKEN}`;
    }

    const dispatchRes = await fetch(`${missionControlUrl}/api/tasks/${taskId}/dispatch`, {
      method: 'POST',
      headers,
    });

    const payload = await dispatchRes.json().catch(() => null) as {
      error?: string;
      queued?: boolean;
      message?: string;
      waiting_for_task_id?: string;
      waiting_for_task_title?: string;
    } | null;

    if (dispatchRes.ok) {
      if (payload?.queued) {
        console.log(`[Auto-Dispatch] Task "${taskTitle}" is queued behind another active task`);
        return {
          success: false,
          queued: true,
          error: payload.message || 'Dispatch queued until the assigned agent is free',
          waitingForTaskId: payload.waiting_for_task_id,
          waitingForTaskTitle: payload.waiting_for_task_title,
        };
      }
      console.log(`[Auto-Dispatch] Task "${taskTitle}" auto-dispatched to ${agentName}`);
      return { success: true };
    } else {
      console.error(`[Auto-Dispatch] Failed for task "${taskTitle}":`, payload);
      return { success: false, error: payload?.error || 'Dispatch failed' };
    }
  } catch (dispatchError) {
    const errorMessage = dispatchError instanceof Error ? dispatchError.message : 'Unknown error';
    console.error(`[Auto-Dispatch] Error for task "${taskTitle}":`, errorMessage);
    return { success: false, error: errorMessage };
  }
}
