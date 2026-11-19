import crypto from 'crypto';
import { getDb, validateUnifiedApiKey } from '../db/index.js';

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// URL tokens buy headerless INFERENCE only — chat/completions, responses,
// and the Ollama chat/tags surface mounted under /v1/t/:token. They never
// buy the install-wide spend ledger (/v1/usage); routes that gate on the
// unified key must check the urlTokenAuthenticated request flag, not just
// the injected Authorization header (see routes/url-tokens.ts).
export const URL_TOKEN_SCOPE = 'chat' as const;

// Default lifetime for newly minted tokens. A leaked token used to be valid
// forever (only manual revoke stopped it); 90 days bounds the blast radius
// of a URL that lands in a log, a chat history, or a Referer header.
// Override with URL_TOKEN_TTL_DAYS (1..3650 days); an invalid value falls
// back to the default instead of failing boot.
export const DEFAULT_URL_TOKEN_TTL_DAYS = 90;
export const MAX_URL_TOKEN_TTL_DAYS = 3650;

export function defaultUrlTokenTtlDays(): number {
  const raw = Number.parseInt(String(process.env.URL_TOKEN_TTL_DAYS ?? ''), 10);
  if (!Number.isInteger(raw) || raw < 1) return DEFAULT_URL_TOKEN_TTL_DAYS;
  return Math.min(raw, MAX_URL_TOKEN_TTL_DAYS);
}

export interface UrlTokenRow {
  id: number;
  label: string;
  tokenPrefix: string;
  scope: typeof URL_TOKEN_SCOPE;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export function listUrlTokens(): UrlTokenRow[] {
  const rows = getDb().prepare(`
    SELECT id, label, token_prefix, created_at, expires_at, last_used_at, revoked_at
    FROM url_tokens
    ORDER BY id DESC
  `).all() as Array<{
    id: number;
    label: string;
    token_prefix: string;
    created_at: string;
    expires_at: string | null;
    last_used_at: string | null;
    revoked_at: string | null;
  }>;
  return rows.map(row => ({
    id: row.id,
    label: row.label,
    tokenPrefix: row.token_prefix,
    scope: URL_TOKEN_SCOPE,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  }));
}

export function mintUrlToken(
  label: string,
  options: { expiresInDays?: number } = {},
): UrlTokenRow & { token: string } {
  const requested = options.expiresInDays ?? defaultUrlTokenTtlDays();
  const days = Number.isInteger(requested)
    ? Math.min(Math.max(requested, 1), MAX_URL_TOKEN_TTL_DAYS)
    : defaultUrlTokenTtlDays();
  const token = `flmurl_${crypto.randomBytes(24).toString('base64url')}`;
  const prefix = `${token.slice(0, 12)}…`;
  const result = getDb().prepare(`
    INSERT INTO url_tokens (token_hash, label, token_prefix, expires_at)
    VALUES (?, ?, ?, datetime('now', ?))
  `).run(hashToken(token), label.trim(), prefix, `+${days} days`);
  const row = listUrlTokens().find(entry => entry.id === Number(result.lastInsertRowid))!;
  return { ...row, token };
}

export function revokeUrlToken(id: number): boolean {
  return getDb().prepare(`
    UPDATE url_tokens SET revoked_at = datetime('now')
    WHERE id = ? AND revoked_at IS NULL
  `).run(id).changes > 0;
}

export function validateUrlToken(token: string): boolean {
  if (!token || validateUnifiedApiKey(token)) {
    if (token) {
      console.warn('[URL tokens] Rejected a raw unified API key in a tokenized URL');
    }
    return false;
  }
  const hash = hashToken(token);
  // expires_at IS NULL only for tokens minted before the expiry migration
  // (grandfathered: valid until revoked). Every token minted after it
  // carries an expiry and stops working past it without any manual revoke.
  const row = getDb().prepare(`
    SELECT id FROM url_tokens
    WHERE token_hash = ? AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > datetime('now'))
  `).get(hash) as { id: number } | undefined;
  if (!row) return false;
  getDb().prepare(
    "UPDATE url_tokens SET last_used_at = datetime('now') WHERE id = ?",
  ).run(row.id);
  return true;
}
