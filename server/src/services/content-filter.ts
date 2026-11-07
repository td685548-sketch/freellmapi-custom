import { createHash } from 'node:crypto';
import { getDb } from '../db/index.js';
import {
  CONTENT_FILTER_LIMITS as L,
  type ContentFilterEvent, type ContentFilterMode, type ContentFilterReason, type ContentFilterSettings,
} from '@freellmapi/shared/content-filter.js';

// Content rules of a client key: which latest user messages are flagged, and what a flag does. The
// checks are pure string work on the request; only a flag touches the database (one event row,
// throttled per end user and reason).

const MODES: readonly ContentFilterMode[] = ['off', 'log', 'block'];
const DAY_MS = 24 * 60 * 60 * 1000;

export const CONTENT_FILTER_COLUMNS = 'cf_mode AS cfMode, cf_max_input_chars AS cfMaxInputChars, cf_block_injection AS cfBlockInjection, cf_repeat_limit AS cfRepeatLimit, cf_keywords AS cfKeywords';

export interface ContentFilterRow {
  cfMode: string | null; cfMaxInputChars: number | null; cfBlockInjection: number | null; cfRepeatLimit: number | null; cfKeywords: string | null;
}

/** Lowercase, NFC, trimmed, de-duplicated, within the limits. */
export function normalizeKeywords(list: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of list) {
    const k = raw.normalize('NFC').trim().toLowerCase();
    if (k && k.length <= L.maxKeywordLength) out.add(k);
    if (out.size >= L.maxKeywords) break;
  }
  return [...out];
}

function parseKeywords(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? normalizeKeywords(v.filter((k): k is string => typeof k === 'string')) : [];
  } catch { return []; }
}

export function contentFilterFromRow(row: ContentFilterRow): ContentFilterSettings {
  const mode = MODES.includes(row.cfMode as ContentFilterMode) ? row.cfMode as ContentFilterMode : 'off';
  const int = (v: number | null, min: number, max: number) => (typeof v === 'number' && Number.isInteger(v) ? Math.max(min, Math.min(max, v)) : null);
  return {
    mode,
    maxInputChars: int(row.cfMaxInputChars, L.minInputChars, L.maxInputChars),
    blockInjection: row.cfBlockInjection === 1,
    repeatLimit: int(row.cfRepeatLimit, L.minRepeatLimit, L.maxRepeatLimit),
    keywords: parseKeywords(row.cfKeywords),
  };
}

/** Null when the profile does not exist. */
export function getContentFilter(profileId: number): ContentFilterSettings | null {
  const row = getDb().prepare(`SELECT ${CONTENT_FILTER_COLUMNS} FROM client_profiles WHERE id = ?`).get(profileId) as ContentFilterRow | undefined;
  return row ? contentFilterFromRow(row) : null;
}

export function setContentFilter(profileId: number, s: ContentFilterSettings): void {
  getDb().prepare('UPDATE client_profiles SET cf_mode = ?, cf_max_input_chars = ?, cf_block_injection = ?, cf_repeat_limit = ?, cf_keywords = ? WHERE id = ?')
    .run(s.mode, s.maxInputChars, s.blockInjection ? 1 : 0, s.repeatLimit, s.keywords.length ? JSON.stringify(normalizeKeywords(s.keywords)) : null, profileId);
  keywordCache.delete(profileId);
}

// --- Rules ---------------------------------------------------------------------------------------

/** Well-known ways of telling a model to drop its instructions, in English and Vietnamese. Deliberately narrow. */
const INJECTION_RULES: Array<{ name: string; re: RegExp }> = [
  { name: 'ignore_instructions', re: /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all|your|the|system)\b[^.\n]{0,30}\b(?:instructions?|prompts?|rules|directions|guidelines)\b/ },
  { name: 'reveal_system_prompt', re: /\b(?:reveal|show|print|repeat|output|tell me|what is|what are|give me)\b[^.\n]{0,30}\b(?:your|the)\b[^.\n]{0,20}\b(?:system prompt|system message|initial instructions|hidden instructions|developer message)\b/ },
  { name: 'role_override', re: /\byou are now\b[^.\n]{0,30}\b(?:dan|jailbroken|unrestricted|unfiltered|in developer mode|no longer bound)\b|\b(?:developer|dan|god) mode\b|\bjailbreak(?:ing)?\b/ },
  { name: 'ignore_instructions', re: /(?:bỏ qua|phớt lờ|quên|bỏ hết|không cần tuân theo|không tuân theo)[^.\n]{0,40}(?:hướng dẫn|chỉ dẫn|chỉ thị|lệnh|quy tắc|yêu cầu)[^.\n]{0,20}(?:trước|ở trên|phía trên|ban đầu|hệ thống)/ },
  { name: 'reveal_system_prompt', re: /(?:tiết lộ|cho (?:tôi |mình )?xem|in ra|nhắc lại|đọc lại)[^.\n]{0,30}(?:system prompt|lời nhắc hệ thống|chỉ dẫn hệ thống|hướng dẫn hệ thống|prompt hệ thống|câu lệnh hệ thống)/ },
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const keywordCache = new Map<number, { source: string; rules: Array<{ keyword: string; re: RegExp }> }>();

function keywordRules(profileId: number, keywords: string[]): Array<{ keyword: string; re: RegExp }> {
  const source = keywords.join('\u0000');
  const cached = keywordCache.get(profileId);
  if (cached && cached.source === source) return cached.rules;
  // A whole word or phrase: not inside a longer word ("ass" does not match "class").
  const rules = keywords.map(keyword => ({ keyword, re: new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(keyword)}(?![\\p{L}\\p{N}])`, 'u') }));
  keywordCache.set(profileId, { source, rules });
  return rules;
}

// Repeats: in memory, per key + end user + message, over a sliding window. Bounded; the oldest entries go first.
const REPEAT_WINDOW_MS = L.repeatWindowMinutes * 60 * 1000;
const MAX_TRACKED = 50_000;
const seen = new Map<string, number[]>();

function countRepeat(profileId: number, endUser: string | null, text: string, now: number): number {
  const digest = createHash('sha1').update(text.trim().toLowerCase()).digest('base64');
  const key = `${profileId}\u0000${endUser ?? ''}\u0000${digest}`;
  const times = (seen.get(key) ?? []).filter(t => now - t < REPEAT_WINDOW_MS);
  times.push(now);
  seen.delete(key);
  seen.set(key, times);
  while (seen.size > MAX_TRACKED) seen.delete(seen.keys().next().value!);
  return times.length;
}

export interface Flag { reason: ContentFilterReason; detail: string }

/** The first rule the message breaks, or null. Repeats are counted for every message checked. */
export function checkMessage(profileId: number, endUser: string | null, text: string, s: ContentFilterSettings, now = Date.now()): Flag | null {
  const repeats = s.repeatLimit !== null ? countRepeat(profileId, endUser, text, now) : 0;
  if (s.maxInputChars !== null && text.length > s.maxInputChars) return { reason: 'too_long', detail: `${text.length} > ${s.maxInputChars} characters` };
  const lower = text.normalize('NFC').toLowerCase();
  for (const k of keywordRules(profileId, s.keywords)) if (k.re.test(lower)) return { reason: 'keyword', detail: k.keyword };
  if (s.blockInjection) for (const r of INJECTION_RULES) if (r.re.test(lower)) return { reason: 'prompt_injection', detail: r.name };
  if (s.repeatLimit !== null && repeats >= s.repeatLimit) return { reason: 'repeated', detail: `${repeats} times in ${L.repeatWindowMinutes} minutes` };
  return null;
}

// --- Events ----------------------------------------------------------------------------------------

// One event per key, end user and reason every 10 seconds at most, so a flood of flagged requests
// cannot turn into a flood of database writes.
const EVENT_THROTTLE_MS = 10_000;
const lastEvent = new Map<string, number>();
let lastPruneAt = 0;

/** Whether the event was written (false when throttled). */
export function recordEvent(profileId: number, endUser: string | null, flag: Flag, action: 'blocked' | 'logged', text: string, now = Date.now()): boolean {
  const key = `${profileId}\u0000${endUser ?? ''}\u0000${flag.reason}`;
  const last = lastEvent.get(key);
  if (last !== undefined && now - last < EVENT_THROTTLE_MS) return false;
  lastEvent.set(key, now);
  if (lastEvent.size > MAX_TRACKED) lastEvent.delete(lastEvent.keys().next().value!);
  const db = getDb();
  db.prepare('INSERT INTO custom_content_filter_events (profile_id, reason, detail, action, end_user, excerpt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(profileId, flag.reason, flag.detail.slice(0, 200), action, endUser, text.slice(0, L.excerptChars), new Date(now).toISOString());
  if (now - lastPruneAt > 60 * 60 * 1000) {
    lastPruneAt = now;
    db.prepare('DELETE FROM custom_content_filter_events WHERE created_at < ?').run(new Date(now - L.eventRetentionDays * DAY_MS).toISOString());
  }
  return true;
}

export function listEvents(profileId: number, limit: number = L.eventListLimit): ContentFilterEvent[] {
  return getDb().prepare('SELECT id, reason, detail, action, end_user AS endUser, excerpt, created_at AS createdAt FROM custom_content_filter_events WHERE profile_id = ? ORDER BY id DESC LIMIT ?')
    .all(profileId, Math.max(1, Math.min(L.eventListLimit, limit))) as ContentFilterEvent[];
}

/** Tests only. */
export function resetContentFilterState(): void { seen.clear(); lastEvent.clear(); keywordCache.clear(); lastPruneAt = 0; }
