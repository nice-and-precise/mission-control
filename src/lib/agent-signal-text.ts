export function stripAgentResponseWrappers(text: string): string {
  let cleaned = text.trim();

  cleaned = cleaned.replace(/^```[a-z0-9_-]*\s*/i, '');
  cleaned = cleaned.replace(/\s*```$/i, '');
  cleaned = cleaned.replace(/^<final>\s*/i, '');
  cleaned = cleaned.replace(/\s*<\/final[>\)]?\s*$/i, '');

  return cleaned.trim();
}

export function sanitizeAgentSignalSummary(summary: string): string {
  return stripAgentResponseWrappers(summary)
    .replace(/\s*<\/[a-z0-9_-]+[>\)]?\s*$/i, '')
    .trim();
}
