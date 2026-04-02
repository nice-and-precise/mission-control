export type ChatSendPurpose =
  | 'task_dispatch'
  | 'task_note'
  | 'direct_chat'
  | 'checkpoint_restore';

export interface TaskDispatchEnvelope {
  openclawSessionId: string;
  message: string;
}

const FRESH_RUN_COMMAND = '/new';

export function shouldStartFreshRun(purpose: ChatSendPurpose): boolean {
  return purpose === 'task_dispatch';
}

export function buildChatSendMessage(message: string, purpose: ChatSendPurpose): string {
  if (!shouldStartFreshRun(purpose)) {
    return message;
  }

  return `${FRESH_RUN_COMMAND}\n\n${message}`;
}

export function buildTaskDispatchEnvelope(
  openclawSessionId: string,
  message: string,
): TaskDispatchEnvelope {
  return {
    openclawSessionId,
    message: buildChatSendMessage(message, 'task_dispatch'),
  };
}
