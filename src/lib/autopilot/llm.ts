import { isOpenClawAgentTarget, validateProviderModelOverride } from '@/lib/openclaw/model-catalog';
import { getAutopilotDefaultModel } from '@/lib/openclaw/model-policy';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { extractTextContent, loadGatewaySessionHistory } from '@/lib/openclaw/session-history';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';

/**
 * Lightweight LLM completion via OpenClaw Gateway's OpenAI-compatible endpoint.
 * Uses /v1/chat/completions for stateless prompt→response (no agent sessions).
 */

const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL?.replace('ws://', 'http://').replace('wss://', 'https://') || 'http://127.0.0.1:18789';
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || '';
const GATEWAY_SCOPES = 'operator.read,operator.write';
const DEFAULT_MODEL = getAutopilotDefaultModel();
const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 5_000; // 5s, 10s, 20s exponential backoff
const SESSION_COMPLETION_POLL_MS = 1_000;
const DEFAULT_SESSION_AGENT_TARGET = 'openclaw/worker';
const STRICT_JSON_RETRY_INSTRUCTION = 'Return exactly one valid JSON object or array. No markdown, no prose, no code fences, and no trailing text. Ensure every string, brace, and bracket is closed.';
const OPENCLAW_CLI_PATH = process.env.OPENCLAW_CLI_PATH || `${homedir()}/.openclaw/bin/openclaw`;
const execFileAsync = promisify(execFile);

export type CompletionTransport = 'http' | 'session' | 'agent-cli';

export type CompletionStatusEvent =
  | {
      type: 'transport_started';
      transport: CompletionTransport;
      requestedModel: string;
      attempt: number;
    }
  | {
      type: 'transport_retry';
      transport: 'http';
      requestedModel: string;
      attempt: number;
      delayMs: number;
      error: string;
    }
  | {
      type: 'transport_fallback';
      fromTransport: CompletionTransport;
      toTransport: CompletionTransport;
      requestedModel: string;
      reason: string;
    }
  | {
      type: 'transport_fallback_skipped';
      fromTransport: CompletionTransport;
      requestedModel: string;
      reason: string;
    }
  | {
      type: 'json_retry';
      requestedModel: string;
      remainingMs: number;
    };

export interface CompletionOptions {
  model?: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  onStatus?: (event: CompletionStatusEvent) => void | Promise<void>;
}

export interface CompletionResult {
  content: string;
  model: string;
  requestedModel: string;
  resolvedModel: string;
  transport: CompletionTransport;
  finishReason?: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

interface AssistantResponseSnapshot {
  text: string;
  finishReason?: string;
}

interface ParsedCliResult {
  status?: string;
  result?: {
    finishReason?: string;
    payloads?: Array<{ text?: string | null; stopReason?: string | null }>;
    meta?: {
      finishReason?: string;
      agentMeta?: {
        provider?: string;
        model?: string;
        finishReason?: string;
        lastCallUsage?: {
          input?: number;
          output?: number;
          total?: number;
        };
      };
    };
  };
}

async function notifyStatus(
  callback: CompletionOptions['onStatus'],
  event: CompletionStatusEvent,
): Promise<void> {
  if (!callback) {
    return;
  }

  try {
    await callback(event);
  } catch (error) {
    console.error('[LLM] Completion status callback failed:', error);
  }
}

function remainingTimeMs(deadline: number): number {
  return Math.max(deadline - Date.now(), 0);
}

function normalizeCompletionMode(value: string | undefined): CompletionTransport {
  const normalized = (value || 'http').trim().toLowerCase();
  if (normalized === 'session' || normalized === 'agent-cli') {
    return normalized;
  }
  return 'http';
}

const AUTOPILOT_COMPLETION_MODE = normalizeCompletionMode(process.env.OPENCLAW_AUTOPILOT_COMPLETION_MODE);

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function resolveSessionModel(session: Record<string, unknown> | undefined, requestedModel: string): string {
  const provider = optionalString(session?.modelProvider);
  const model = optionalString(session?.model);
  const combined = `${provider || ''}/${model || ''}`.replace(/^\/|\/$/g, '');
  return combined || model || requestedModel;
}

function formatCompletionDiagnostic(result: Pick<CompletionResult, 'transport' | 'requestedModel' | 'resolvedModel' | 'finishReason'>): string {
  const parts = [
    `transport=${result.transport}`,
    `requested=${result.requestedModel}`,
    `resolved=${result.resolvedModel}`,
  ];
  if (result.finishReason) {
    parts.push(`finish_reason=${result.finishReason}`);
  }
  return parts.join(' ');
}

function buildJSONParseError(result: CompletionResult, afterRetry: boolean): Error {
  const retryText = afterRetry ? ' after retry' : '';
  return new Error(
    `Failed to parse JSON from LLM response${retryText} (${formatCompletionDiagnostic(result)}). ` +
    `Raw content (first 500 chars): ${result.content.slice(0, 500)}`,
  );
}

function buildStrictJSONRetrySystemPrompt(systemPrompt?: string): string {
  return systemPrompt
    ? `${systemPrompt}\n\n${STRICT_JSON_RETRY_INSTRUCTION}`
    : STRICT_JSON_RETRY_INSTRUCTION;
}

export function resolveCompletionTransport(
  model: string,
  configuredMode: CompletionTransport = AUTOPILOT_COMPLETION_MODE,
): CompletionTransport {
  if (!isOpenClawAgentTarget(model) && configuredMode === 'agent-cli') {
    return 'session';
  }
  return configuredMode;
}

function resolveHttpFallbackTransport(model: string): CompletionTransport | null {
  if (!isOpenClawAgentTarget(model)) {
    // Provider-model HTTP completions are the fix for the giant-session-context bug.
    // Falling back to a session-backed path reintroduces that failure mode.
    return AUTOPILOT_COMPLETION_MODE === 'http' ? null : 'session';
  }

  return AUTOPILOT_COMPLETION_MODE === 'session' ? 'session' : 'agent-cli';
}

async function runCompletionTransport(
  transport: CompletionTransport,
  prompt: string,
  options: CompletionOptions,
): Promise<CompletionResult> {
  if (transport === 'agent-cli') {
    return completeViaAgentCli(prompt, options);
  }
  if (transport === 'session') {
    return completeViaSession(prompt, options);
  }
  return completeViaHttp(prompt, options);
}

function getSessionCompletionAgentTarget(model: string): string {
  if (isOpenClawAgentTarget(model)) {
    return model;
  }
  return DEFAULT_SESSION_AGENT_TARGET;
}

function getAgentIdForCompletion(model: string): string {
  if (model === 'openclaw' || model === 'openclaw/default') {
    return 'main';
  }

  if (model.startsWith('openclaw/')) {
    return model.slice('openclaw/'.length) || 'main';
  }

  if (model.startsWith('agent:')) {
    return model.split(':')[1] || 'main';
  }

  return 'worker';
}

function buildSessionKey(agentTarget: string): string {
  const suffix = crypto.randomUUID();
  const normalizedTarget = agentTarget.startsWith('openclaw/')
    ? agentTarget.slice('openclaw/'.length)
    : agentTarget.replace(/^agent:/, '').replace(/[^\w-]+/g, '-');
  return `agent:${normalizedTarget || 'worker'}:mc-autopilot:${suffix}`;
}

function buildSessionPrompt(prompt: string, systemPrompt?: string): string {
  if (!systemPrompt) {
    return prompt;
  }

  return `${systemPrompt}\n\n---\n\n${prompt}`;
}

function parseUsageFromSession(session: Record<string, unknown> | undefined): CompletionResult['usage'] {
  const promptTokens = Number(session?.inputTokens || 0);
  const completionTokens = Number(session?.outputTokens || 0);
  const totalTokens = Number(session?.totalTokens || (promptTokens + completionTokens));
  return {
    promptTokens,
    completionTokens,
    totalTokens,
  };
}

function getLatestAssistantResponse(
  items: Array<Record<string, unknown>>,
  userSentAt: number,
): AssistantResponseSnapshot | null {
  let latestResponse: AssistantResponseSnapshot | null = null;

  for (const item of items) {
    const record = item as Record<string, unknown>;
    const text = extractTextContent(record as any);
    if (!text) continue;

    const role = typeof record.role === 'string'
      ? record.role
      : (record.message && typeof (record.message as Record<string, unknown>).role === 'string'
        ? String((record.message as Record<string, unknown>).role)
        : '');
    if (role.toLowerCase() !== 'assistant') continue;

    const timestampValue =
      record.timestamp
      ?? (record.message && (record.message as Record<string, unknown>).timestamp);
    const timestampMs = typeof timestampValue === 'number'
      ? timestampValue
      : typeof timestampValue === 'string'
        ? Date.parse(timestampValue)
        : NaN;

    if (Number.isFinite(timestampMs) && timestampMs < userSentAt) continue;
    latestResponse = {
      text,
      finishReason: optionalString(record.stopReason)
        || optionalString(record.message && (record.message as Record<string, unknown>).stopReason),
    };
  }

  return latestResponse;
}

async function completeViaSession(prompt: string, options: CompletionOptions): Promise<CompletionResult> {
  const {
    model = DEFAULT_MODEL,
    systemPrompt,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  await notifyStatus(options.onStatus, {
    type: 'transport_started',
    transport: 'session',
    requestedModel: model,
    attempt: 1,
  });

  const agentTarget = getSessionCompletionAgentTarget(model);
  const sessionKey = buildSessionKey(agentTarget);
  const client = getOpenClawClient();
  if (!client.isConnected()) {
    await client.connect();
  }

  if (!isOpenClawAgentTarget(model)) {
    await client.patchSessionModel(sessionKey, model);
  }

  const requestStartedAt = Date.now();
  console.log(`[completeViaSession] Sending to sessionKey=${sessionKey} model=${model} agentTarget=${agentTarget}`);
  await client.call('chat.send', {
    sessionKey,
    message: buildSessionPrompt(prompt, systemPrompt),
    idempotencyKey: `mc-autopilot-${requestStartedAt}-${crypto.randomUUID()}`,
  });

  const deadline = requestStartedAt + timeoutMs;
  let lastAssistantSignature = '';
  let lastSession: Record<string, unknown> | undefined;

  while (Date.now() < deadline) {
    const history = await loadGatewaySessionHistory(sessionKey, 50, { includeTools: true });
    const items = history.items as Array<Record<string, unknown>>;
    const assistantResponse = getLatestAssistantResponse(items, requestStartedAt);
    const session = await client.getSessionByKey(sessionKey) as unknown as Record<string, unknown> | undefined;
    lastSession = session;
    const status = typeof session?.status === 'string' ? session.status.toLowerCase() : '';

    if (assistantResponse?.text) {
      const responseSignature = `${assistantResponse.text}\u0000${assistantResponse.finishReason || ''}`;
      if (status === 'done' || status === 'completed' || responseSignature === lastAssistantSignature) {
        const resolvedModel = resolveSessionModel(session, model);
        return {
          content: assistantResponse.text,
          model: resolvedModel,
          requestedModel: model,
          resolvedModel,
          transport: 'session',
          finishReason: assistantResponse.finishReason,
          usage: parseUsageFromSession(session),
        };
      }
      lastAssistantSignature = responseSignature;
    }

    if (status === 'failed' || status === 'error' || status === 'aborted') {
      throw new Error(
        `Session-backed autopilot completion failed: ${status} (` +
        `${formatCompletionDiagnostic({
          transport: 'session',
          requestedModel: model,
          resolvedModel: resolveSessionModel(session, model),
          finishReason: undefined,
        })})`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, SESSION_COMPLETION_POLL_MS));
  }

  throw new Error(
    `Session-backed autopilot completion timed out after ${timeoutMs}ms` +
    (lastSession?.status ? ` (last status: ${String(lastSession.status)})` : ''),
  );
}

async function completeViaAgentCli(prompt: string, options: CompletionOptions): Promise<CompletionResult> {
  const {
    model = DEFAULT_MODEL,
    systemPrompt,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  await notifyStatus(options.onStatus, {
    type: 'transport_started',
    transport: 'agent-cli',
    requestedModel: model,
    attempt: 1,
  });

  const agentId = getAgentIdForCompletion(model);
  const timeoutSeconds = Math.max(30, Math.ceil(timeoutMs / 1000));
  const { stdout } = await execFileAsync(
    OPENCLAW_CLI_PATH,
    [
      'agent',
      '--agent', agentId,
      '--message', buildSessionPrompt(prompt, systemPrompt),
      '--timeout', String(timeoutSeconds),
      '--json',
    ],
    {
      timeout: timeoutMs + 5_000,
      maxBuffer: 10 * 1024 * 1024,
      env: process.env,
    },
  );

  const parsed = JSON.parse(stdout.trim()) as ParsedCliResult;

  if (parsed.status !== 'ok') {
    throw new Error(`OpenClaw agent CLI completion failed with status "${parsed.status || 'unknown'}".`);
  }

  const content = (parsed.result?.payloads || [])
    .map((payload) => typeof payload?.text === 'string' ? payload.text.trim() : '')
    .filter(Boolean)
    .join('\n\n');
  const usage = parsed.result?.meta?.agentMeta?.lastCallUsage;
  const provider = parsed.result?.meta?.agentMeta?.provider;
  const runtimeModel = parsed.result?.meta?.agentMeta?.model;
  const resolvedModel = !isOpenClawAgentTarget(model)
    ? model
    : `${provider || ''}/${runtimeModel || ''}`.replace(/^\/|\/$/g, '') || runtimeModel || model;
  const finishReason = optionalString(parsed.result?.finishReason)
    || optionalString(parsed.result?.meta?.finishReason)
    || optionalString(parsed.result?.meta?.agentMeta?.finishReason)
    || optionalString(parsed.result?.payloads?.find((payload) => optionalString(payload.stopReason))?.stopReason);

  return {
    content,
    model: resolvedModel,
    requestedModel: model,
    resolvedModel,
    transport: 'agent-cli',
    finishReason,
    usage: {
      promptTokens: Number(usage?.input || 0),
      completionTokens: Number(usage?.output || 0),
      totalTokens: Number(usage?.total || 0),
    },
  };
}

async function completeViaHttp(prompt: string, options: CompletionOptions): Promise<CompletionResult> {
  const {
    model = DEFAULT_MODEL,
    systemPrompt,
    temperature = 0.7,
    maxTokens = 8192,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  const messages: Array<{ role: string; content: string }> = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: prompt });

  let lastError: Error | null = null;
  const deadline = Date.now() + timeoutMs;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const remainingMs = remainingTimeMs(deadline);
    if (remainingMs <= 0) {
      break;
    }

    if (attempt > 0) {
      const delay = Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1), Math.max(remainingMs - 1, 0));
      if (delay <= 0) {
        break;
      }
      await notifyStatus(options.onStatus, {
        type: 'transport_retry',
        transport: 'http',
        requestedModel: model,
        attempt: attempt + 1,
        delayMs: delay,
        error: lastError?.message || 'Retrying after transport failure.',
      });
      console.log(`[LLM] Retry ${attempt}/${MAX_RETRIES} after ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    await notifyStatus(options.onStatus, {
      type: 'transport_started',
      transport: 'http',
      requestedModel: model,
      attempt: attempt + 1,
    });

    const controller = new AbortController();
    const requestTimeoutMs = Math.max(1, remainingTimeMs(deadline));
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

    try {
      const response = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: buildGatewayRequestHeaders(model),
        body: JSON.stringify({
          model: resolveGatewayModelTarget(model),
          messages,
          temperature,
          max_tokens: maxTokens,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`LLM completion failed (${response.status}): ${errorText}`);
      }

      const data = await response.json() as {
        model?: string;
        choices?: Array<{ message?: { content?: string }; finish_reason?: string | null }>;
        usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      };

      const content = data.choices?.[0]?.message?.content || '';
      const finishReason = optionalString(data.choices?.[0]?.finish_reason);
      const gatewayModel = optionalString(data.model);
      const resolvedModel = isOpenClawAgentTarget(model)
        ? (gatewayModel || model)
        : (gatewayModel && gatewayModel !== 'openclaw' ? gatewayModel : model);

      console.log(
        '[LLM] Response usage:',
        JSON.stringify(data.usage || null),
        formatCompletionDiagnostic({
          transport: 'http',
          requestedModel: model,
          resolvedModel,
          finishReason,
        }),
      );

      return {
        content,
        model: resolvedModel,
        requestedModel: model,
        resolvedModel,
        transport: 'http',
        finishReason,
        usage: {
          promptTokens: data.usage?.prompt_tokens || 0,
          completionTokens: data.usage?.completion_tokens || 0,
          totalTokens: data.usage?.total_tokens || 0,
        },
      };
    } catch (error) {
      clearTimeout(timeout);
      lastError = error instanceof Error ? error : new Error(String(error));
      const isAbort = lastError.name === 'AbortError' || lastError.message.includes('aborted');
      const isNetwork = lastError.message.includes('fetch failed') || lastError.message.includes('ECONNREFUSED') || lastError.message.includes('ECONNRESET');

      if (isAbort || isNetwork) {
        console.error(`[LLM] Attempt ${attempt + 1} failed (${isAbort ? 'timeout/abort' : 'network'}): ${lastError.message}`);
        continue;
      }

      throw lastError;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError || new Error(`LLM completion failed after retries within ${timeoutMs}ms`);
}

function tryParseJSON<T>(text: string): T | null {
  try {
    return JSON.parse(text.trim()) as T;
  } catch {
    return null;
  }
}

function extractBalancedJSONCandidate(text: string, startIndex: number): string | null {
  const opening = text[startIndex];
  if (opening !== '{' && opening !== '[') {
    return null;
  }

  const stack: string[] = [opening];
  let inString = false;
  let escaped = false;

  for (let index = startIndex + 1; index < text.length; index += 1) {
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

    if (char === '{' || char === '[') {
      stack.push(char);
      continue;
    }

    if (char === '}' || char === ']') {
      const current = stack[stack.length - 1];
      const expected = current === '{' ? '}' : ']';
      if (char !== expected) {
        return null;
      }
      stack.pop();
      if (stack.length === 0) {
        return text.slice(startIndex, index + 1);
      }
    }
  }

  return null;
}

function extractBalancedJSONFromText(text: string): string | null {
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char !== '{' && char !== '[') {
      continue;
    }

    const candidate = extractBalancedJSONCandidate(text, index);
    if (candidate) {
      return candidate;
    }
  }

  return null;
}

/**
 * Strip markdown code fences from around JSON content.
 * Returns the inner content if fences are found, null otherwise.
 */
function stripCodeFences(text: string): string | null {
  const patterns = [
    /```(?:json)?\s*([\s\S]*?)```/i,
    /```(?:json)?\s*([\s\S]*)```/i,
    /```(?:json)?\s*([\[{][\s\S]*)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]?.trim()) {
      return match[1].trim();
    }
  }

  return null;
}

/**
 * Recover a truncated JSON array by collecting all balanced top-level elements.
 * Handles cases where the model output was cut off mid-array (e.g. the closing ]
 * is missing or the last element is incomplete).
 */
function recoverTruncatedArray(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('[')) {
    return null;
  }

  // If the array is already balanced, let normal parsing handle it
  if (extractBalancedJSONCandidate(trimmed, 0)) {
    return null;
  }

  // Array is truncated — collect all balanced top-level elements
  const elements: string[] = [];
  let i = 1; // Skip the opening [

  while (i < trimmed.length) {
    const char = trimmed[i];
    if (char === '{' || char === '[') {
      const candidate = extractBalancedJSONCandidate(trimmed, i);
      if (candidate) {
        elements.push(candidate);
        i += candidate.length;
        continue;
      }
      break; // Unbalanced structure — stop collecting
    }
    i++;
  }

  if (elements.length > 0) {
    console.warn(
      `[LLM] Recovered ${elements.length} element(s) from truncated JSON array (original length: ${trimmed.length} chars)`,
    );
    return '[' + elements.join(',') + ']';
  }

  return null;
}

function parseRecoverableJSON<T>(text: string): T | null {
  const direct = tryParseJSON<T>(text);
  if (direct !== null) {
    return direct;
  }

  const balanced = extractBalancedJSONFromText(text);
  if (balanced) {
    return tryParseJSON<T>(balanced);
  }

  return null;
}

export function extractStructuredJSON<T = unknown>(text: string): T | null {
  // 1. Direct JSON.parse — handles clean JSON
  const direct = tryParseJSON<T>(text.trim());
  if (direct !== null) {
    return direct;
  }

  // 2. Strip markdown code fences (models like Qwen wrap JSON in ```json ... ```)
  const stripped = stripCodeFences(text);
  const candidate = stripped ?? text.trim();

  // 3. Try direct parse on stripped content
  if (stripped) {
    const parsed = tryParseJSON<T>(stripped);
    if (parsed !== null) {
      return parsed;
    }
  }

  // 4. Recover truncated arrays BEFORE balanced extraction —
  //    balanced extraction would grab just the first {} object,
  //    but truncated recovery collects ALL balanced elements.
  const recovered = recoverTruncatedArray(candidate);
  if (recovered) {
    const parsed = tryParseJSON<T>(recovered);
    if (parsed !== null) {
      return parsed;
    }
  }

  // 5. Try balanced extraction (finds first complete JSON structure)
  const balanced = extractBalancedJSONFromText(candidate);
  if (balanced) {
    const parsed = tryParseJSON<T>(balanced);
    if (parsed !== null) {
      return parsed;
    }
  }

  return null;
}

export function buildGatewayRequestHeaders(model: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${GATEWAY_TOKEN}`,
    'x-openclaw-scopes': GATEWAY_SCOPES,
  };

  if (!isOpenClawAgentTarget(model)) {
    headers['x-openclaw-model'] = model;
  }

  return headers;
}

export function resolveGatewayModelTarget(model: string): string {
  if (isOpenClawAgentTarget(model)) {
    return model;
  }

  return 'openclaw';
}

/**
 * Send a prompt and get a completion response.
 * Uses the Gateway's /v1/chat/completions endpoint — stateless, no agent session.
 */
export async function complete(prompt: string, options: CompletionOptions = {}): Promise<CompletionResult> {
  const {
    model = DEFAULT_MODEL,
  } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  await validateProviderModelOverride(model);
  const transport = resolveCompletionTransport(model);

  try {
    return await runCompletionTransport(transport, prompt, {
      ...options,
      timeoutMs,
    });
  } catch (error) {
    if (transport !== 'http') {
      throw error;
    }

    const fallbackTransport = resolveHttpFallbackTransport(model);
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (!fallbackTransport) {
      await notifyStatus(options.onStatus, {
        type: 'transport_fallback_skipped',
        fromTransport: 'http',
        requestedModel: model,
        reason: errorMessage,
      });
      throw error;
    }

    const remainingMs = remainingTimeMs(deadline);
    if (remainingMs <= 0) {
      throw error;
    }

    await notifyStatus(options.onStatus, {
      type: 'transport_fallback',
      fromTransport: 'http',
      toTransport: fallbackTransport,
      requestedModel: model,
      reason: errorMessage,
    });
    console.warn(
      `[LLM] HTTP completion path failed for requested model ${model}; ` +
      `falling back to ${fallbackTransport}: ${errorMessage}`,
    );
    return runCompletionTransport(fallbackTransport, prompt, {
      ...options,
      timeoutMs: remainingMs,
    });
  }
}

/**
 * Send a prompt and parse the response as JSON.
 * Handles markdown code blocks and embedded JSON.
 */
export async function completeJSON<T = unknown>(prompt: string, options: CompletionOptions = {}): Promise<{
  data: T;
  raw: string;
  model: string;
  requestedModel: string;
  resolvedModel: string;
  transport: CompletionTransport;
  finishReason?: string;
  usage: CompletionResult['usage'];
}> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  const firstResult = await complete(prompt, {
    ...options,
    timeoutMs,
  });
  const firstParsed = extractStructuredJSON<T>(firstResult.content);

  if (firstParsed !== null) {
    return {
      data: firstParsed,
      raw: firstResult.content,
      model: firstResult.model,
      requestedModel: firstResult.requestedModel,
      resolvedModel: firstResult.resolvedModel,
      transport: firstResult.transport,
      finishReason: firstResult.finishReason,
      usage: firstResult.usage,
    };
  }

  const remainingMs = remainingTimeMs(deadline);
  if (remainingMs <= 0) {
    const parseError = buildJSONParseError(firstResult, false);
    parseError.message = `${parseError.message} No time remained for strict JSON retry.`;
    throw parseError;
  }

  await notifyStatus(options.onStatus, {
    type: 'json_retry',
    requestedModel: firstResult.requestedModel,
    remainingMs,
  });

  const retryResult = await complete(prompt, {
    ...options,
    timeoutMs: remainingMs,
    temperature: 0,
    systemPrompt: buildStrictJSONRetrySystemPrompt(options.systemPrompt),
  });
  const retryParsed = extractStructuredJSON<T>(retryResult.content);
  if (retryParsed !== null) {
    return {
      data: retryParsed,
      raw: retryResult.content,
      model: retryResult.model,
      requestedModel: retryResult.requestedModel,
      resolvedModel: retryResult.resolvedModel,
      transport: retryResult.transport,
      finishReason: retryResult.finishReason,
      usage: retryResult.usage,
    };
  }

  throw buildJSONParseError(retryResult, true);
}
