
import { getMissionControlUrl } from '@/lib/config';


interface AutoDispatchOptions {
  taskId: string;
  taskTitle: string;
  agentId: string | null;
  agentName: string;
  workspaceId?: string;
}

/**
 * Narrow dispatch helper kept for server-side retry flows.
 *
 * Primary task creation/editing dispatch is now owned by server routes and the
 * workflow engine. Do not reintroduce this helper into client-side status
 * change flows; that was the source of earlier double-dispatch races.
 */
export async function triggerAutoDispatch(options: AutoDispatchOptions): Promise<{ success: boolean; error?: string }> {
  const { taskId, taskTitle, agentId, agentName, workspaceId } = options;

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

    if (dispatchRes.ok) {
      console.log(`[Auto-Dispatch] Task "${taskTitle}" auto-dispatched to ${agentName}`);
      return { success: true };
    } else {
      const errorData = await dispatchRes.json().catch(() => ({ error: 'Unknown error' }));
      console.error(`[Auto-Dispatch] Failed for task "${taskTitle}":`, errorData);
      return { success: false, error: errorData.error || 'Dispatch failed' };
    }
  } catch (dispatchError) {
    const errorMessage = dispatchError instanceof Error ? dispatchError.message : 'Unknown error';
    console.error(`[Auto-Dispatch] Error for task "${taskTitle}":`, errorMessage);
    return { success: false, error: errorMessage };
  }
}
