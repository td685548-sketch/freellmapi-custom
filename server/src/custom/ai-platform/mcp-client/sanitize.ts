const SENSITIVE_KEY_RE =
  /^(authorization|api[_-]?key|secret|token|password|passwd|credential|private[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|x-api-key|cookie|set-cookie)$/i;

const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi;
const SK_TOKEN_RE = /\bsk-[A-Za-z0-9_-]{8,}\b/g;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

function normalizeSecrets(secretValues?: readonly (string | null | undefined)[]): string[] {
  if (!secretValues || secretValues.length === 0) return [];
  const seen = new Set<string>();
  for (const raw of secretValues) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (trimmed.length >= 6) {
      seen.add(trimmed);
    }
  }
  return Array.from(seen).sort((a, b) => b.length - a.length);
}

/**
 * Redacts any known secret values (including opaque credentials without
 * `sk-`/`Bearer` prefixes) from a string.
 */
export function scrubCredentialEcho(
  text: string,
  secretValues?: readonly (string | null | undefined)[],
): string {
  if (!text) return text;
  let out = text;
  for (const secret of normalizeSecrets(secretValues)) {
    if (out.includes(secret)) {
      out = out.split(secret).join('[REDACTED]');
    }
  }
  return out;
}

/**
 * Redacts opaque credentials, Bearer/sk- tokens, and email addresses from text.
 */
export function sanitizeMcpText(
  text: string | null | undefined,
  secretValues?: readonly (string | null | undefined)[],
): string {
  if (text === null || text === undefined) return '';
  let out = scrubCredentialEcho(String(text), secretValues);
  out = out.replace(BEARER_RE, 'Bearer [REDACTED]');
  out = out.replace(SK_TOKEN_RE, '[REDACTED]');
  out = out.replace(EMAIL_RE, '[REDACTED_EMAIL]');
  return out;
}

/**
 * Recursively scrubs sensitive object keys and credential echoes from any JSON value.
 */
export function scrubSensitiveKeys(
  value: unknown,
  secretValues?: readonly (string | null | undefined)[],
  depth = 0,
): unknown {
  if (depth > 20) return '[TRUNCATED]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return sanitizeMcpText(value, secretValues);
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((item) => scrubSensitiveKeys(item, secretValues, depth + 1));
  }
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEY_RE.test(k)) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = scrubSensitiveKeys(v, secretValues, depth + 1);
    }
  }
  return out;
}

/**
 * Alias for recursively sanitizing arbitrary MCP metadata/result values.
 */
export function sanitizeMcpValue(
  value: unknown,
  secretValues?: readonly (string | null | undefined)[],
): unknown {
  return scrubSensitiveKeys(value, secretValues, 0);
}

/**
 * Extracts and sanitizes an error message so upstream credential echoes never leak.
 */
export function sanitizeMcpError(
  err: unknown,
  secretValues?: readonly (string | null | undefined)[],
): string {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : String(err ?? 'Unknown MCP error');
  return sanitizeMcpText(raw, secretValues);
}

function containsSecretEcho(value: unknown, secrets: string[], depth = 0): boolean {
  if (depth > 20 || value === null || value === undefined) return false;
  if (typeof value === 'string') {
    if (secrets.some((s) => value.includes(s))) return true;
    return BEARER_RE.test(value) || SK_TOKEN_RE.test(value);
  }
  if (typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    return value.some((item) => containsSecretEcho(item, secrets, depth + 1));
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (secrets.some((s) => k.includes(s))) return true;
    if (containsSecretEcho(v, secrets, depth + 1)) return true;
  }
  return false;
}

/**
 * Validates that a tool's input/output schema and description do not echo
 * configured credentials. Rejects unsafe schemas instead of mutating
 * enum/required/property semantics.
 */
export function assertSafeToolSchema(
  schema: Record<string, unknown>,
  description?: string | null,
  secretValues?: readonly (string | null | undefined)[],
): { ok: true } | { ok: false; reason: string } {
  const secrets = normalizeSecrets(secretValues);
  // Reset stateful global regexes before testing
  BEARER_RE.lastIndex = 0;
  SK_TOKEN_RE.lastIndex = 0;
  if (description && containsSecretEcho(description, secrets)) {
    return { ok: false, reason: 'Tool description echoes credential material.' };
  }
  BEARER_RE.lastIndex = 0;
  SK_TOKEN_RE.lastIndex = 0;
  if (containsSecretEcho(schema, secrets)) {
    return { ok: false, reason: 'Tool schema echoes credential material.' };
  }
  return { ok: true };
}
