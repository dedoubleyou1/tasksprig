const PROVIDERS: Record<string, string> = { openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google' };

/** Provider SDKs sometimes wrap an already-serialized JSON error inside another message string. */
function diagnosticText(message: string): string {
  const pieces: string[] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 6 || pieces.join('').length > 30000) return;
    if (typeof value === 'string') {
      const text = value.slice(0, 12000);
      pieces.push(text);
      const trimmed = text.trim().replace(/^Error:\s*/, '');
      const start = trimmed.indexOf('{');
      const candidates = [trimmed, ...(start > 0 ? [trimmed.slice(start)] : [])];
      for (const candidate of candidates) {
        try { const parsed: unknown = JSON.parse(candidate); if (parsed !== value) visit(parsed, depth + 1); break; } catch { /* Plain provider messages are normal. */ }
      }
    } else if (Array.isArray(value)) {
      value.slice(0, 20).forEach(item => visit(item, depth + 1));
    } else if (value && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value).slice(0, 30)) {
        if (typeof entry === 'number' || typeof entry === 'string') pieces.push(`${key}: ${String(entry)}`);
        visit(entry, depth + 1);
      }
    }
  };
  visit(message, 0);
  return pieces.join('\n').replace(/\\"/g, '"');
}

function redacted(message: string, apiKey: string): string {
  return (apiKey ? message.split(apiKey).join('[redacted]') : message)
    .replace(/(?:sk-|AIza)[A-Za-z0-9_-]{12,}/g, '[redacted]')
    .replace(/\b(?:api[_-]?key|authorization|token)\s*[:=]\s*["']?(?:Bearer\s+)?[^\s,"'}]+/gi, '[redacted]');
}

function retrySeconds(text: string): number | undefined {
  const seconds = text.match(/retry(?:delay)?["']?\s*[:=]\s*["']?(\d+(?:\.\d+)?)\s*s\b/i)
    ?? text.match(/retry\s+(?:in|after)\s+(?:about\s+)?(\d+(?:\.\d+)?)\s*(?:s\b|seconds?)/i);
  if (seconds) return Math.max(1, Math.ceil(Number(seconds[1])));
  const millis = text.match(/retry delay\s+(?:of\s+)?(\d+)\s*ms\b/i);
  return millis ? Math.max(1, Math.ceil(Number(millis[1]) / 1000)) : undefined;
}

/** Keep user-facing errors actionable; raw provider JSON and credentials never reach the conversation. */
export function formatAgentError(error: unknown, provider = '', apiKey = ''): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : 'The model request failed.';
  const safe = redacted(raw, apiKey);
  const diagnostic = diagnosticText(safe);
  const name = PROVIDERS[provider] ?? 'The model provider';
  if (/insufficient[_\s-]?quota|insufficient[_\s-]?(?:credits?|balance)|credit balance|out of credits|billing[_\s-]hard[_\s-]limit|payment required/i.test(diagnostic)
    || (/exceeded your current quota/i.test(diagnostic) && !/resource_exhausted|rate[_\s-]?limit|input[_\s-]?token/i.test(diagnostic))) {
    return `${name} has no available API credits or billing quota for this request; check API billing or choose another provider in Model settings.`;
  }
  if (/invalid[_\s-]?api[_\s-]?key|incorrect api key|api key (?:is )?not valid|authentication[_\s-]?error|unauthenticated|\b401\b/i.test(diagnostic)) {
    return `${name} could not authenticate the API key; update the key in Model settings.`;
  }
  if (/resource_exhausted|rate[_\s-]?limit|quota[_\s-]?(?:exceeded|exhausted)|\b429\b|retry delay.*exceeds/i.test(diagnostic)) {
    const inputTokens = /input[_\s-]?token|tokens? per minute|InputTokensPer/i.test(diagnostic);
    const wait = retrySeconds(diagnostic);
    const next = wait !== undefined && wait <= 3600 ? `try again in about ${wait} seconds` : 'wait for the limit to reset';
    return `${name}'s ${inputTokens ? 'input-token allowance' : 'request limit'} was reached; ${next}, or choose another model or provider.`;
  }
  if (/permission[_\s-]?denied|access denied|\b403\b/.test(diagnostic.toLowerCase())) {
    return `${name} denied access to this model; check the key's permissions or choose a model available to your account.`;
  }
  if (/model[_\s-]?not[_\s-]?found|does not exist|not found.*model/i.test(diagnostic)) {
    return `${name} could not find the selected model; check its model ID in Model settings.`;
  }
  if (/context[_\s-]?(?:length|window)|maximum context|too many input tokens|input.*too (?:long|large)/i.test(diagnostic)) {
    return 'The request is too large for the selected model; use a shorter request or choose a model with a larger context window.';
  }
  if (/fetch failed|ECONNRESET|ENOTFOUND|network error|connection error/i.test(diagnostic)) {
    return `Could not reach ${name === 'The model provider' ? 'the model provider' : name}; check the connection and try again.`;
  }
  if (/\b(?:500|502|503|504)\b|overloaded|service unavailable/i.test(diagnostic)) {
    return `${name} is temporarily unavailable; try again shortly or choose another provider.`;
  }
  // App validation errors stay useful; unknown structured SDK payloads get a concise fallback.
  if (/[{}]|\\"|"(?:error|message|code)"\s*:/.test(safe)) return `${name} could not complete the request; check Model settings or try again.`;
  return safe.split('\n')[0].slice(0, 600) || 'The model request failed. Try again.';
}
