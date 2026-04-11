import { createHash } from 'crypto';
import { getDb, queryOne, run } from './db';
import { broadcast } from './events';
import { cleanupTaskScopedAgents, parsePlanningSpecValue } from './planning-agents';
import type { GeneratedPlanningSpec, SuggestedPlanningAgent, Task } from './types';
import { getOpenClawClient } from './openclaw/client';
import { buildChatSendMessage } from './openclaw/session-commands';
import {
  extractTextContent,
  getOversizedHistoryOmissionMessage,
  hasOversizedHistoryOmission,
  loadGatewaySessionHistory,
} from './openclaw/session-history';

// Maximum input length for extractJSON to prevent ReDoS attacks
const MAX_EXTRACT_JSON_LENGTH = 1_000_000; // 1MB

export interface PlanningOption {
  id: string;
  label: string;
}

export interface PlanningQuestion {
  question: string;
  options: PlanningOption[];
}

export interface PlanningMessage {
  role: string;
  content: string;
  timestamp: number;
}

export interface PlanningCompletionPayload {
  status: 'complete';
  spec?: GeneratedPlanningSpec | Record<string, unknown>;
  agents?: SuggestedPlanningAgent[];
  execution_plan?: Record<string, unknown>;
}

export interface PlanningTranscriptResolution {
  messages: PlanningMessage[];
  completion: PlanningCompletionPayload | null;
  currentQuestion: PlanningQuestion | null;
  transcriptIssue?: {
    code: 'history_omitted' | 'gateway_timeout' | 'unstructured_response';
    message: string;
  } | null;
}

export interface PlanningTaskRow {
  id: string;
  planning_session_key?: string;
  planning_messages?: string;
  planning_complete?: number;
}

const INVALID_PLANNING_PAYLOAD_MESSAGE =
  'The planner replied without a valid question or completion payload after the last planning prompt. Retry or restart planning to recover.';
const PLANNING_AUTO_REPAIR_PREFIX = '[Mission Control planning recovery]';
function buildPlanningAutoRepairMessage(messages: PlanningMessage[]): string {
  const normalizedMessages = normalizePlanningMessages(messages);
  const originalContext = normalizedMessages
    .filter((message) => message.role === 'user' && !isPlanningAutoRepairPrompt(message.content))
    .map((message, index) => `${index === 0 ? 'Original planning request' : `User answer ${index}`}:\n${message.content}`)
    .join('\n\n');

  return `${PLANNING_AUTO_REPAIR_PREFIX}

Start a fresh planning run on this same task. The previous assistant reply did not match the planning contract.

Rules:
- Do not execute the task during planning.
- Do not scan files, produce findings, file lists, scan reports, or remediation summaries in this phase.
- Return ONLY valid JSON in exactly one of these top-level shapes:
  - Question shape: { "question": "...", "options": [...] }
  - Completion shape: { "status": "complete", "spec": {...}, "agents": [...], "execution_plan": {...} }

Use the conversation context below as ground truth and answer the planning request again from scratch.

${originalContext}`;
}

type OpenClawMessagesResolver = (
  sessionKey: string,
) => Promise<{
  messages: Array<{ role: string; content: string }>;
  transcriptIssue?: {
    code: 'history_omitted';
    message: string;
  } | null;
}>;

let openClawMessagesResolverForTests: OpenClawMessagesResolver | null = null;

function normalizeSuggestedPlanningAgents(agents: SuggestedPlanningAgent[] | null | undefined): SuggestedPlanningAgent[] {
  return (agents || []).map((agent) => ({
    name: agent.name || agent.agent_id || 'Planner Suggested Agent',
    role: agent.role || agent.instructions || 'builder',
    avatar_emoji: agent.avatar_emoji,
    soul_md: agent.soul_md,
    instructions: agent.instructions,
  }));
}

function findMatchingBrace(text: string, openIndex: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      depth += 1;
      continue;
    }

    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function repairMalformedConstraintsObject(text: string): string | null {
  const constraintsKey = '"constraints"';
  const constraintsIndex = text.indexOf(constraintsKey);
  if (constraintsIndex === -1) return null;

  const openBraceIndex = text.indexOf('{', constraintsIndex);
  if (openBraceIndex === -1) return null;

  const closeBraceIndex = findMatchingBrace(text, openBraceIndex);
  if (closeBraceIndex === -1) return null;

  const inner = text.slice(openBraceIndex + 1, closeBraceIndex);
  const lines = inner
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0 || lines.some((line) => line.includes(':'))) {
    return null;
  }

  const values = lines
    .map((line) => line.replace(/,+\s*$/, '').trim())
    .filter(Boolean);

  if (
    values.length === 0 ||
    values.some((value) => !value.startsWith('"') || !value.endsWith('"'))
  ) {
    return null;
  }

  const repairedInner = values
    .map((value, index) => `    "constraint_${index + 1}": ${value}`)
    .join(',\n');

  return `${text.slice(0, openBraceIndex + 1)}\n${repairedInner}\n  ${text.slice(closeBraceIndex)}`;
}

function tryParseJSON(text: string): object | null {
  try {
    return JSON.parse(text.trim());
  } catch {
    const repairedConstraints = repairMalformedConstraintsObject(text);
    if (repairedConstraints) {
      try {
        return JSON.parse(repairedConstraints.trim());
      } catch {
        return null;
      }
    }

    return null;
  }
}

/**
 * Extract JSON from a response that might have markdown code blocks or surrounding text.
 * Handles various formats:
 * - Direct JSON
 * - Markdown code blocks (```json ... ``` or ``` ... ```)
 * - JSON embedded in text (first { to last })
 */
export function extractJSON(text: string): object | null {
  // Security: Prevent ReDoS on massive inputs
  if (text.length > MAX_EXTRACT_JSON_LENGTH) {
    console.warn('[Planning Utils] Input exceeds maximum length for JSON extraction:', text.length);
    return null;
  }

  // First, try direct parse
  const direct = tryParseJSON(text);
  if (direct) {
    return direct;
  }

  // Try to extract from markdown code block (```json ... ``` or ``` ... ```)
  // Use greedy match first (handles nested backticks), then lazy as fallback
  const codeBlockGreedy = text.match(/```(?:json)?\s*([\s\S]*)```/);
  if (codeBlockGreedy) {
    const parsed = tryParseJSON(codeBlockGreedy[1]);
    if (parsed) {
      return parsed;
    }
  }
  const codeBlockLazy = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockLazy) {
    const parsed = tryParseJSON(codeBlockLazy[1]);
    if (parsed) {
      return parsed;
    }
  }
  // Handle unclosed code blocks (LLM generated opening ``` but no closing ```)
  const unclosedBlock = text.match(/```(?:json)?\s*(\{[\s\S]*)/);
  if (unclosedBlock) {
    const jsonCandidate = unclosedBlock[1].trim();
    const parsed = tryParseJSON(jsonCandidate);
    if (parsed) {
      return parsed;
    }
    // Try to find valid JSON by trimming from the end
    const lastBrace = jsonCandidate.lastIndexOf('}');
    if (lastBrace > 0) {
      const trimmedParsed = tryParseJSON(jsonCandidate.slice(0, lastBrace + 1));
      if (trimmedParsed) {
        return trimmedParsed;
      }
    }
  }

  // Try to find JSON object in the text (first { to last })
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const parsed = tryParseJSON(text.slice(firstBrace, lastBrace + 1));
    if (parsed) {
      return parsed;
    }
  }

  return null;
}

function normalizePlanningOptions(options: unknown): PlanningOption[] {
  if (Array.isArray(options) && options.length > 0) {
    const normalized = options
      .map((option) => {
        if (!option || typeof option !== 'object') return null;
        const candidate = option as Record<string, unknown>;
        const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
        const label = typeof candidate.label === 'string' ? candidate.label.trim() : '';
        if (!label) return null;
        return {
          id: id || label.toLowerCase().replace(/\s+/g, '-'),
          label,
        };
      })
      .filter((option): option is PlanningOption => option !== null);
    if (normalized.length > 0) {
      return normalized;
    }
  }

  return [
    { id: 'continue', label: 'Continue' },
    { id: 'other', label: 'Other' },
  ];
}

export function normalizePlanningMessages(messages: unknown): PlanningMessage[] {
  if (!Array.isArray(messages)) return [];

  return messages
    .map((message) => {
      if (!message || typeof message !== 'object') return null;
      const candidate = message as Record<string, unknown>;
      const role = typeof candidate.role === 'string' ? candidate.role : '';
      const content = typeof candidate.content === 'string' ? candidate.content : '';
      if (!role || !content) return null;

      const timestampValue = candidate.timestamp;
      const timestamp = typeof timestampValue === 'number' && Number.isFinite(timestampValue)
        ? timestampValue
        : Date.now();

      return { role, content, timestamp };
    })
    .filter((message): message is PlanningMessage => message !== null);
}

function isPlanningAutoRepairPrompt(content: string): boolean {
  return content.trim().startsWith(PLANNING_AUTO_REPAIR_PREFIX);
}

export function resolvePlanningTranscript(messages: PlanningMessage[]): PlanningTranscriptResolution {
  const normalizedMessages = normalizePlanningMessages(messages);
  let sawAssistantReplyWithoutValidPlanningPayload = false;

  for (let index = normalizedMessages.length - 1; index >= 0; index -= 1) {
    const message = normalizedMessages[index];
    if (message.role === 'user') {
      return {
        messages: normalizedMessages,
        completion: null,
        currentQuestion: null,
        transcriptIssue: sawAssistantReplyWithoutValidPlanningPayload
          ? {
              code: 'unstructured_response',
              message: INVALID_PLANNING_PAYLOAD_MESSAGE,
            }
          : null,
      };
    }

    if (message.role !== 'assistant') continue;

    const parsed = extractJSON(message.content) as Record<string, unknown> | null;
    if (!parsed) {
      sawAssistantReplyWithoutValidPlanningPayload = true;
      continue;
    }

    if (parsed.status === 'complete') {
      return {
        messages: normalizedMessages,
        completion: {
          status: 'complete',
          spec: (parsed.spec as GeneratedPlanningSpec | Record<string, unknown> | undefined) || {},
          agents: Array.isArray(parsed.agents) ? parsed.agents as SuggestedPlanningAgent[] : [],
          execution_plan: parsed.execution_plan && typeof parsed.execution_plan === 'object'
            ? parsed.execution_plan as Record<string, unknown>
            : undefined,
        },
        currentQuestion: null,
        transcriptIssue: null,
      };
    }

    if (typeof parsed.question === 'string' && parsed.question.trim().length > 0) {
      return {
        messages: normalizedMessages,
        completion: null,
        currentQuestion: {
          question: parsed.question.trim(),
          options: normalizePlanningOptions(parsed.options),
        },
        transcriptIssue: null,
      };
    }

    sawAssistantReplyWithoutValidPlanningPayload = true;
  }

  return {
    messages: normalizedMessages,
    completion: null,
    currentQuestion: null,
    transcriptIssue: null,
  };
}

export function shouldAutoRepairPlanningTranscript(messages: PlanningMessage[]): boolean {
  const normalizedMessages = normalizePlanningMessages(messages);
  if (normalizedMessages.length === 0) return false;

  const resolution = resolvePlanningTranscript(normalizedMessages);
  if (resolution.completion || resolution.currentQuestion || resolution.transcriptIssue?.code !== 'unstructured_response') {
    return false;
  }

  const lastMessage = normalizedMessages[normalizedMessages.length - 1];
  if (!lastMessage || lastMessage.role !== 'assistant') {
    return false;
  }

  for (let index = normalizedMessages.length - 2; index >= 0; index -= 1) {
    const candidate = normalizedMessages[index];
    if (candidate.role !== 'user') continue;
    return !isPlanningAutoRepairPrompt(candidate.content);
  }

  return true;
}

export async function attemptAutomaticPlanningRecovery(
  taskId: string,
  sessionKey: string,
  messages: PlanningMessage[],
): Promise<PlanningMessage[] | null> {
  if (!shouldAutoRepairPlanningTranscript(messages)) {
    return null;
  }

  const normalizedMessages = normalizePlanningMessages(messages);
  const lastAssistantMessage = normalizedMessages[normalizedMessages.length - 1];
  if (!lastAssistantMessage || lastAssistantMessage.role !== 'assistant') {
    return null;
  }

  const recoveryContent = buildPlanningAutoRepairMessage(normalizedMessages);
  const recoveryMessage = {
    role: 'user' as const,
    content: recoveryContent,
    timestamp: Date.now(),
  };
  const updatedMessages = [recoveryMessage];
  const idempotencyKey = `planning-auto-repair-${taskId}-${createHash('sha256')
    .update(lastAssistantMessage.content)
    .digest('hex')
    .slice(0, 16)}`;

  const client = getOpenClawClient();
  if (!client.isConnected()) {
    await client.connect();
  }

  await client.call('chat.send', {
    sessionKey,
    message: buildChatSendMessage(recoveryContent, 'planning_start'),
    idempotencyKey,
  });

  run(
    `UPDATE tasks
        SET planning_messages = ?,
            updated_at = datetime('now')
      WHERE id = ?`,
    [JSON.stringify(updatedMessages), taskId],
  );

  return updatedMessages;
}

export function mergeStoredMessagesWithOpenClaw(
  storedMessages: PlanningMessage[],
  openclawMessages: Array<{ role: string; content: string }>,
): { messages: PlanningMessage[]; changed: boolean } {
  const normalizedMessages = normalizePlanningMessages(storedMessages);
  const storedAssistantCount = normalizedMessages.filter((message) => message.role === 'assistant').length;

  if (openclawMessages.length <= storedAssistantCount) {
    return { messages: normalizedMessages, changed: false };
  }

  const mergedMessages = [...normalizedMessages];
  for (const message of openclawMessages.slice(storedAssistantCount)) {
    if (message.role !== 'assistant' || !message.content.trim()) continue;
    mergedMessages.push({
      role: 'assistant',
      content: message.content,
      timestamp: Date.now(),
    });
  }

  return {
    messages: mergedMessages,
    changed: mergedMessages.length !== normalizedMessages.length,
  };
}

export async function reconcilePlanningTranscript(
  task: PlanningTaskRow,
  options?: { refreshFromOpenClaw?: boolean; timeoutMs?: number },
): Promise<PlanningTranscriptResolution & { changed: boolean }> {
  let messages = normalizePlanningMessages(task.planning_messages ? JSON.parse(task.planning_messages) : []);
  let resolution = resolvePlanningTranscript(messages);
  let changed = false;
  let transcriptIssue = resolution.transcriptIssue || null;

  if (
    task.planning_session_key &&
    options?.refreshFromOpenClaw &&
    !resolution.completion
  ) {
    try {
      const { messages: openclawMessages, transcriptIssue: fetchedTranscriptIssue } = await getMessagesFromOpenClaw(
        task.planning_session_key,
        { timeoutMs: options?.timeoutMs },
      );
      const merged = mergeStoredMessagesWithOpenClaw(messages, openclawMessages);
      if (merged.changed) {
        messages = merged.messages;
        changed = true;
        resolution = resolvePlanningTranscript(messages);
      }
      transcriptIssue = fetchedTranscriptIssue || resolution.transcriptIssue || transcriptIssue;
    } catch (err) {
      const errorMessage = (err as Error).message;
      console.error('[reconcilePlanningTranscript] OpenClaw fetch failed, returning stored messages:', errorMessage);
      // Return stored messages but flag the fetch failure so callers know
      transcriptIssue = {
        code: /Request timeout: chat\.history/i.test(errorMessage) ? 'gateway_timeout' : 'history_omitted',
        message: /Request timeout: chat\.history/i.test(errorMessage)
          ? 'Timed out while waiting for OpenClaw transcript history — showing cached messages and retrying automatically.'
          : 'Failed to reach OpenClaw gateway — showing cached messages. The response may have arrived but could not be retrieved.',
      };
    }
  }

  return {
    ...resolution,
    messages,
    changed,
    transcriptIssue,
  };
}

export async function finalizePlanningCompletion(
  taskId: string,
  messages: PlanningMessage[],
  completion: PlanningCompletionPayload,
  options?: {
    statusReason?: string;
    activityMessage?: string | null;
  },
): Promise<Omit<PlanningCompletionPayload, 'spec'> & { spec: GeneratedPlanningSpec; agents: SuggestedPlanningAgent[] }> {
  const db = getDb();

  // Merge top-level execution_plan into spec before normalization — planners
  // sometimes place it alongside spec rather than inside it.
  const specInput = { ...(completion.spec || {}) } as Record<string, unknown>;
  if (!specInput.execution_plan && completion.execution_plan) {
    specInput.execution_plan = completion.execution_plan;
  }

  const normalizedSpec = parsePlanningSpecValue(specInput) || {
    title: '',
    summary: '',
    deliverables: [],
    success_criteria: [],
    constraints: {},
  };
  const savedAgents = normalizeSuggestedPlanningAgents(completion.agents);

  // Planner suggestions are informational task metadata only. If an earlier
  // build created task-scoped planner agents, clean them up during recovery.
  cleanupTaskScopedAgents(taskId);

  db.prepare('DELETE FROM task_roles WHERE task_id = ?').run(taskId);

  db.prepare(`
    UPDATE tasks
    SET planning_messages = ?,
        planning_spec = ?,
        planning_agents = ?,
        planning_complete = 1,
        assigned_agent_id = NULL,
        status = 'planning',
        planning_dispatch_error = NULL,
        status_reason = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(
    JSON.stringify(messages),
    JSON.stringify(normalizedSpec),
    JSON.stringify(savedAgents),
    options?.statusReason || 'Planning complete — awaiting approval before execution',
    taskId,
  );

  if (options?.activityMessage) {
    run(
      `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, created_at)
       VALUES (lower(hex(randomblob(16))), ?, NULL, 'status_changed', ?, datetime('now'))`,
      [taskId, options.activityMessage],
    );
  }

  const updatedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (updatedTask) {
    broadcast({ type: 'task_updated', payload: updatedTask });
  }

  return {
    ...completion,
    spec: normalizedSpec,
    agents: savedAgents,
  };
}

export function setOpenClawMessagesResolverForTests(resolver: OpenClawMessagesResolver | null): void {
  openClawMessagesResolverForTests = resolver;
}

/**
 * Get messages from OpenClaw API for a given session.
 * Returns assistant messages with text content extracted.
 */
export async function getMessagesFromOpenClaw(
  sessionKey: string,
  options?: { timeoutMs?: number },
): Promise<{
  messages: Array<{ role: string; content: string }>;
  transcriptIssue?: {
    code: 'history_omitted' | 'gateway_timeout';
    message: string;
  } | null;
}> {
  if (openClawMessagesResolverForTests) {
    return openClawMessagesResolverForTests(sessionKey);
  }

  try {
    const startedAt = Date.now();
    const history = await loadGatewaySessionHistory(sessionKey, 50, {
      includeTools: true,
      timeoutMs: options?.timeoutMs,
    });
    console.log(
      `[Planning Utils] Transcript refresh completed for ${sessionKey} in ${Date.now() - startedAt}ms`,
    );
    const messages: Array<{ role: string; content: string }> = [];

    for (const item of history.items) {
      if ((item.role || item.message?.role) !== 'assistant') continue;
      const content = extractTextContent(item);
      if (content) {
        messages.push({
          role: 'assistant',
          content,
        });
      }
    }

    return {
      messages,
      transcriptIssue: hasOversizedHistoryOmission(history.items)
        ? {
            code: 'history_omitted',
            message: getOversizedHistoryOmissionMessage(),
          }
        : null,
    };
  } catch (err) {
    console.error('[Planning Utils] Failed to get messages from OpenClaw:', err);
    return {
      messages: [],
      transcriptIssue: null,
    };
  }
}
