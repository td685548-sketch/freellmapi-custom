import {
  DEFAULT_AI_PLATFORM_RETENTION,
  type AiPlatformRetention,
} from '@freellmapi/shared/ai-platform.js';
import {
  OUTPUT_GUARD_LIMITS,
  type GuardDetectorId,
  type GuardEventAction,
  type GuardEventExcerptResponse,
  type GuardEventsListResponse,
  type GuardEventsQuery,
  type GuardEventView,
  type GuardWire,
  type Scope,
  type ScopeKind,
} from '@freellmapi/shared/ai-platform-output-guard.js';
import { getDb } from '../../../db/index.js';
import { decrypt, encrypt } from '../../../lib/crypto.js';
import { normalizeScope, parseScopeParam } from '../scope.js';
import { GuardStoreError } from './store.js';

const RETENTION_KEY = 'ai_platform_retention_v1';
const DAY_MS = 86_400_000;

export interface RecordGuardEventInput {
  scope: Scope;
  endUser: string | null;
  detector: GuardDetectorId;
  action: GuardEventAction;
  wire: GuardWire;
  streamed: boolean;
  runId?: string | null;
  excerptSourceText?: string | null;
  matchOffset?: number;
  matchLength?: number;
  now?: Date;
}

export interface RecordGuardEventResult {
  recorded: boolean;
  id?: number;
  throttled?: boolean;
}

interface RateBucket {
  windowStartMs: number;
  count: number;
}

const rateLimitMap = new Map<string, RateBucket>();

export function resetGuardEventRateLimitForTests(): void {
  rateLimitMap.clear();
}

function checkRateLimit(
  scope: Scope,
  endUser: string | null,
  detector: GuardDetectorId,
  nowMs: number,
): boolean {
  const key = `${scope.kind}:${scope.id}:${endUser ?? ''}:${detector}`;
  const existing = rateLimitMap.get(key);
  if (existing && nowMs - existing.windowStartMs < OUTPUT_GUARD_LIMITS.eventRateLimitWindowMs) {
    if (existing.count >= OUTPUT_GUARD_LIMITS.eventRateLimitMaxPerKey) {
      return false;
    }
    existing.count += 1;
    // Refresh insertion order for LRU eviction
    rateLimitMap.delete(key);
    rateLimitMap.set(key, existing);
    return true;
  }

  if (rateLimitMap.size >= OUTPUT_GUARD_LIMITS.eventRateLimitMaxKeys) {
    const oldestKey = rateLimitMap.keys().next().value;
    if (oldestKey !== undefined) rateLimitMap.delete(oldestKey);
  }
  rateLimitMap.set(key, { windowStartMs: nowMs, count: 1 });
  return true;
}

function readExcerptTtlDays(): number {
  try {
    const row = getDb()
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(RETENTION_KEY) as { value?: string } | undefined;
    if (!row?.value) return OUTPUT_GUARD_LIMITS.excerptTtlDays;
    const parsed = JSON.parse(row.value) as Partial<AiPlatformRetention>;
    const days = Number(parsed.guardExcerptsDays);
    if (Number.isInteger(days) && days >= 1 && days <= 3650) return days;
  } catch {
    /* fallback to default */
  }
  return DEFAULT_AI_PLATFORM_RETENTION.guardExcerptsDays;
}

function sliceExcerptAroundMatch(
  text: string,
  matchOffset?: number,
  matchLength?: number,
): string {
  const maxChars = OUTPUT_GUARD_LIMITS.excerptMaxChars;
  if (text.length <= maxChars) return text;

  const safeOffset =
    typeof matchOffset === 'number' && Number.isFinite(matchOffset) && matchOffset >= 0
      ? Math.min(Math.floor(matchOffset), text.length)
      : 0;
  const safeLen =
    typeof matchLength === 'number' && Number.isFinite(matchLength) && matchLength > 0
      ? Math.min(Math.floor(matchLength), text.length - safeOffset)
      : 0;

  if (safeLen >= maxChars) {
    return text.slice(safeOffset, safeOffset + maxChars);
  }

  const padding = Math.floor((maxChars - safeLen) / 2);
  let start = Math.max(0, safeOffset - padding);
  let end = start + maxChars;
  if (end > text.length) {
    end = text.length;
    start = Math.max(0, end - maxChars);
  }
  return text.slice(start, end);
}

export function recordGuardEvent(input: RecordGuardEventInput): RecordGuardEventResult {
  const norm = normalizeScope(input.scope);
  const now = input.now ?? new Date();
  const nowMs = now.getTime();

  if (!checkRateLimit(norm, input.endUser, input.detector, nowMs)) {
    return { recorded: false, throttled: true };
  }

  let ciphertext: string | null = null;
  let iv: string | null = null;
  let tag: string | null = null;
  let expiresAt: string | null = null;

  if (input.excerptSourceText && input.excerptSourceText.length > 0) {
    const excerpt = sliceExcerptAroundMatch(
      input.excerptSourceText,
      input.matchOffset,
      input.matchLength,
    );
    const enc = encrypt(excerpt);
    ciphertext = enc.encrypted;
    iv = enc.iv;
    tag = enc.authTag;
    const ttlDays = readExcerptTtlDays();
    expiresAt = new Date(nowMs + ttlDays * DAY_MS).toISOString();
  }

  const res = getDb()
    .prepare(
      `INSERT INTO custom_ai_guard_events (
        scope_kind, scope_id, end_user, detector, action, wire, streamed, run_id,
        excerpt_ciphertext, excerpt_iv, excerpt_tag, excerpt_expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      norm.kind,
      norm.id,
      input.endUser ?? null,
      input.detector,
      input.action,
      input.wire,
      input.streamed ? 1 : 0,
      input.runId ?? null,
      ciphertext,
      iv,
      tag,
      expiresAt,
      now.toISOString(),
    );

  return { recorded: true, id: Number(res.lastInsertRowid) };
}

function parseScopeQueryString(raw?: string): Scope | undefined {
  if (!raw || !raw.trim()) return undefined;
  const trimmed = raw.trim();
  const sep = trimmed.includes('/') ? '/' : trimmed.includes(':') ? ':' : null;
  if (!sep) {
    throw new GuardStoreError('Invalid scope query parameter.', 'invalid_scope', 400);
  }
  const idx = trimmed.indexOf(sep);
  try {
    return parseScopeParam(trimmed.slice(0, idx), trimmed.slice(idx + 1));
  } catch (err) {
    throw new GuardStoreError(
      err instanceof Error ? err.message : 'Invalid scope query parameter.',
      'invalid_scope',
      400,
    );
  }
}

export function listGuardEvents(
  query: GuardEventsQuery,
  now: Date = new Date(),
): GuardEventsListResponse {
  const scope = parseScopeQueryString(query.scope);
  const rawLimit = query.limit ?? OUTPUT_GUARD_LIMITS.defaultListLimit;
  if (!Number.isInteger(rawLimit) || rawLimit <= 0) {
    throw new GuardStoreError('limit must be a positive integer.', 'invalid_limit', 400);
  }
  const limit = Math.min(rawLimit, OUTPUT_GUARD_LIMITS.maxListLimit);

  let beforeId: number | undefined;
  if (query.before !== undefined && query.before !== '') {
    if (!/^\d+$/.test(query.before)) {
      throw new GuardStoreError('before cursor must be a positive integer.', 'invalid_cursor', 400);
    }
    beforeId = Number(query.before);
  }

  const where: string[] = [];
  const params: unknown[] = [];

  if (scope) {
    where.push('scope_kind = ? AND scope_id = ?');
    params.push(scope.kind, scope.id);
  }
  if (query.detector) {
    where.push('detector = ?');
    params.push(query.detector);
  }
  if (query.action) {
    where.push('action = ?');
    params.push(query.action);
  }
  if (beforeId !== undefined) {
    where.push('id < ?');
    params.push(beforeId);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const rows = getDb()
    .prepare(
      `SELECT id, scope_kind, scope_id, end_user, detector, action, wire, streamed, run_id,
              (excerpt_ciphertext IS NOT NULL) AS has_cipher,
              excerpt_expires_at, created_at
         FROM custom_ai_guard_events
         ${whereSql}
        ORDER BY id DESC
        LIMIT ?`,
    )
    .all(...params, limit + 1) as Array<{
    id: number;
    scope_kind: ScopeKind;
    scope_id: string;
    end_user: string | null;
    detector: GuardDetectorId;
    action: GuardEventAction;
    wire: GuardWire;
    streamed: number;
    run_id: string | null;
    has_cipher: number;
    excerpt_expires_at: string | null;
    created_at: string;
  }>;

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nowMs = now.getTime();

  const events: GuardEventView[] = page.map((r) => {
    const expired = Boolean(r.excerpt_expires_at && Date.parse(r.excerpt_expires_at) <= nowMs);
    return {
      id: r.id,
      scopeKind: r.scope_kind,
      scopeId: r.scope_id,
      endUser: r.end_user,
      detector: r.detector,
      action: r.action,
      wire: r.wire,
      streamed: Boolean(r.streamed),
      runId: r.run_id,
      hasExcerpt: Boolean(r.has_cipher) && !expired,
      excerptExpired: expired,
      excerptExpiresAt: r.excerpt_expires_at,
      createdAt: r.created_at,
    };
  });

  const nextBefore = hasMore && page.length > 0 ? String(page[page.length - 1]!.id) : null;
  return { events, nextBefore };
}

export function getGuardExcerpt(
  id: number,
  now: Date = new Date(),
): GuardEventExcerptResponse {
  const row = getDb()
    .prepare(
      `SELECT excerpt_ciphertext, excerpt_iv, excerpt_tag, excerpt_expires_at
         FROM custom_ai_guard_events
        WHERE id = ?`,
    )
    .get(id) as
    | {
        excerpt_ciphertext: string | null;
        excerpt_iv: string | null;
        excerpt_tag: string | null;
        excerpt_expires_at: string | null;
      }
    | undefined;

  if (!row) {
    throw new GuardStoreError('Guard event not found.', 'not_found', 404);
  }

  if (row.excerpt_expires_at && Date.parse(row.excerpt_expires_at) <= now.getTime()) {
    throw new GuardStoreError('Guard event excerpt has expired.', 'excerpt_expired', 410);
  }

  if (!row.excerpt_ciphertext || !row.excerpt_iv || !row.excerpt_tag || !row.excerpt_expires_at) {
    throw new GuardStoreError('Guard event has no stored excerpt.', 'not_found', 404);
  }

  const excerpt = decrypt(row.excerpt_ciphertext, row.excerpt_iv, row.excerpt_tag);
  return {
    excerpt,
    expiresAt: row.excerpt_expires_at,
  };
}

export function pruneGuardEvents(
  now: Date = new Date(),
): { purgedExcerpts: number; prunedEvents: number } {
  const db = getDb();
  const nowIso = now.toISOString();
  const retentionCutoffIso = new Date(
    now.getTime() - OUTPUT_GUARD_LIMITS.eventsRetentionDays * DAY_MS,
  ).toISOString();

  const purgedExcerpts = db
    .prepare(
      `UPDATE custom_ai_guard_events
          SET excerpt_ciphertext = NULL,
              excerpt_iv = NULL,
              excerpt_tag = NULL
        WHERE excerpt_expires_at IS NOT NULL
          AND datetime(excerpt_expires_at) <= datetime(?)
          AND (excerpt_ciphertext IS NOT NULL OR excerpt_iv IS NOT NULL OR excerpt_tag IS NOT NULL)`,
    )
    .run(nowIso).changes;

  const prunedEvents = db
    .prepare(
      `DELETE FROM custom_ai_guard_events
        WHERE datetime(created_at) <= datetime(?)`,
    )
    .run(retentionCutoffIso).changes;

  return { purgedExcerpts, prunedEvents };
}
