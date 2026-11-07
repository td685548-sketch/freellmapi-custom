import { getDb } from '../db/index.js';
import { runWriteGroup, type WriteStatement } from '../lib/write-group.js';
import {
  CONVERSATION_LIMITS as L,
  type ConversationSettings, type StoredConversation, type StoredMessage,
} from '@freellmapi/shared/conversations.js';

// Conversations a client key's web app keeps on the server (X-Conversation-Id). Only plain user/assistant
// text is stored; a turn is written when the model's reply completed, so a failed request leaves nothing
// half-stored and the web app can simply retry it.

const ID_RE = new RegExp(L.idPattern);
const HOUR_MS = 60 * 60 * 1000;

/** The id as sent, or null when it is missing or has characters outside `A-Z a-z 0-9 . _ : -` (max 128). */
export function normalizeConversationId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  return ID_RE.test(v) ? v : null;
}

const clamp = (v: number | null | undefined, min: number, max: number, fallback: number): number =>
  typeof v === 'number' && Number.isInteger(v) ? Math.max(min, Math.min(max, v)) : fallback;

interface SettingsRow { convEnabled: number; ttl: number | null; maxMessages: number | null; maxChars: number | null; convSummarize?: number | null }

export function settingsFromRow(row: SettingsRow): ConversationSettings {
  return {
    enabled: row.convEnabled === 1,
    ttlHours: clamp(row.ttl, L.minTtlHours, L.maxTtlHours, L.defaultTtlHours),
    maxMessages: clamp(row.maxMessages, L.minMaxMessages, L.maxMaxMessages, L.defaultMaxMessages),
    maxChars: clamp(row.maxChars, L.minMaxChars, L.maxMaxChars, L.defaultMaxChars),
    summarize: row.convSummarize === 1,
  };
}

export const SETTINGS_COLUMNS = 'conv_enabled AS convEnabled, conv_ttl_hours AS ttl, conv_max_messages AS maxMessages, conv_max_chars AS maxChars, conv_summarize AS convSummarize';

/** Null when the profile does not exist. */
export function getConversationSettings(profileId: number): ConversationSettings | null {
  const row = getDb().prepare(`SELECT ${SETTINGS_COLUMNS} FROM client_profiles WHERE id = ?`).get(profileId) as SettingsRow | undefined;
  return row ? settingsFromRow(row) : null;
}

export function setConversationSettings(profileId: number, s: ConversationSettings): void {
  getDb().prepare('UPDATE client_profiles SET conv_enabled = ?, conv_ttl_hours = ?, conv_max_messages = ?, conv_max_chars = ?, conv_summarize = ? WHERE id = ?')
    .run(s.enabled ? 1 : 0, s.ttlHours, s.maxMessages, s.maxChars, s.summarize ? 1 : 0, profileId);
}

const cutoff = (ttlHours: number, now: number) => new Date(now - ttlHours * HOUR_MS).toISOString();
const expiresAt = (updatedAt: string, ttlHours: number) => new Date(Date.parse(updatedAt) + ttlHours * HOUR_MS).toISOString();

interface ConvRow { id: number; endUser: string | null; updatedAt: string }

function deleteConversationRows(ids: number[]): void {
  if (ids.length === 0) return;
  const marks = ids.map(() => '?').join(',');
  runWriteGroup(getDb(), [
    { sql: `DELETE FROM custom_conversation_messages WHERE conversation_id IN (${marks})`, params: ids },
    { sql: `DELETE FROM custom_conversations WHERE id IN (${marks})`, params: ids },
  ]);
}

export type HistoryResult =
  | { ok: true; conversationId: number | null; history: Array<{ role: 'user' | 'assistant'; content: string }>; summary: string | null }
  | { ok: false; reason: 'end_user_mismatch' };

/**
 * The earlier turns to put in front of the new messages: the newest ones within `maxMessages` and
 * `maxChars`, starting with a user turn. A conversation started for an end user can only be continued
 * for that same end user; one started without an end user can be continued by any request of the key.
 */
export function loadHistory(profileId: number, key: string, endUser: string | null, s: ConversationSettings, now = Date.now()): HistoryResult {
  const db = getDb();
  const row = db.prepare('SELECT id, end_user AS endUser, updated_at AS updatedAt, summary FROM custom_conversations WHERE profile_id = ? AND conv_key = ?')
    .get(profileId, key) as (ConvRow & { summary: string | null }) | undefined;
  if (!row) return { ok: true, conversationId: null, history: [], summary: null };
  if (row.updatedAt < cutoff(s.ttlHours, now)) {
    deleteConversationRows([row.id]);
    return { ok: true, conversationId: null, history: [], summary: null };
  }
  if (row.endUser !== null && row.endUser !== endUser) return { ok: false, reason: 'end_user_mismatch' };

  const newest = db.prepare('SELECT role, content FROM custom_conversation_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?')
    .all(row.id, s.maxMessages) as Array<{ role: 'user' | 'assistant'; content: string }>;
  const kept: typeof newest = [];
  let chars = 0;
  for (const m of newest) {
    if (chars + m.content.length > s.maxChars) break;
    chars += m.content.length;
    kept.push(m);
  }
  kept.reverse();
  while (kept.length > 0 && kept[0]!.role !== 'user') kept.shift();
  return { ok: true, conversationId: row.id, history: kept, summary: s.summarize && row.summary ? row.summary : null };
}

/** Most characters of earlier turns folded into the summary in one call. */
const MAX_FOLD_CHARS = 16_000;

/**
 * Turns that no longer fit the history window and are not in the summary yet, oldest first, within
 * MAX_FOLD_CHARS; with the current summary. Null when there is nothing to fold.
 */
export function foldableTurns(conversationId: number, s: ConversationSettings): { summary: string | null; turns: Array<{ id: number; role: string; content: string }> } | null {
  const db = getDb();
  const conv = db.prepare('SELECT summary, summarized_through AS through FROM custom_conversations WHERE id = ?').get(conversationId) as { summary: string | null; through: number } | undefined;
  if (!conv) return null;
  // The oldest message still sent as history, by the same count and character rules as loadHistory;
  // everything older (and newer than the summary) is foldable.
  const newest = db.prepare('SELECT id, role, LENGTH(content) AS len FROM custom_conversation_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?')
    .all(conversationId, s.maxMessages + 1) as Array<{ id: number; role: string; len: number }>;
  const kept: typeof newest = [];
  let used = 0;
  for (const m of newest.slice(0, s.maxMessages)) {
    if (used + m.len > s.maxChars) break;
    used += m.len;
    kept.push(m);
  }
  while (kept.length > 0 && kept[kept.length - 1]!.role !== 'user') kept.pop(); // oldest first must be a user turn
  if (kept.length === newest.length) return null; // everything still fits
  const firstKept = kept.length ? kept[kept.length - 1]!.id : Number.MAX_SAFE_INTEGER;
  const rows = db.prepare('SELECT id, role, content FROM custom_conversation_messages WHERE conversation_id = ? AND id > ? AND id < ? ORDER BY id LIMIT 200')
    .all(conversationId, conv.through, firstKept) as Array<{ id: number; role: string; content: string }>;
  const turns: typeof rows = [];
  let chars = 0;
  for (const r of rows) {
    if (turns.length > 0 && chars + r.content.length > MAX_FOLD_CHARS) break;
    chars += r.content.length;
    turns.push(r);
  }
  return turns.length ? { summary: conv.summary, turns } : null;
}

export function saveSummary(conversationId: number, summary: string, throughId: number): void {
  getDb().prepare('UPDATE custom_conversations SET summary = ?, summarized_through = MAX(summarized_through, ?) WHERE id = ?')
    .run(summary.slice(0, 4_000), throughId, conversationId);
}

/** Store one completed turn: the request's new messages, then the reply. */
export function appendTurn(
  profileId: number, key: string, endUser: string | null, conversationId: number | null,
  turn: Array<{ role: 'user' | 'assistant'; content: string }>, reply: string, s: ConversationSettings, now = Date.now(),
): number {
  const db = getDb();
  const at = new Date(now).toISOString();
  let id = conversationId;
  if (id === null) {
    db.prepare('INSERT OR IGNORE INTO custom_conversations (profile_id, conv_key, end_user, message_count, chars, created_at, updated_at) VALUES (?, ?, ?, 0, 0, ?, ?)')
      .run(profileId, key, endUser, at, at);
    id = (db.prepare('SELECT id FROM custom_conversations WHERE profile_id = ? AND conv_key = ?').get(profileId, key) as { id: number }).id;
  }
  const messages = [...turn, { role: 'assistant' as const, content: reply }]
    .map(m => ({ role: m.role, content: m.content.slice(0, L.maxStoredMessageChars) }));
  const chars = messages.reduce((n, m) => n + m.content.length, 0);
  const writes: WriteStatement[] = messages.map(m => ({
    sql: 'INSERT INTO custom_conversation_messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)',
    params: [id, m.role, m.content, at],
  }));
  writes.push({
    sql: 'UPDATE custom_conversations SET message_count = message_count + ?, chars = chars + ?, updated_at = ? WHERE id = ?',
    params: [messages.length, chars, at, id],
  });
  runWriteGroup(db, writes);
  compact(id, s);
  maybePruneConversations(now);
  return id;
}

// Only the newest `maxMessages` are ever sent, so once a conversation holds twice that many the older
// ones are dropped. Amortized: one trim every `maxMessages` stored messages.
// With summaries on, only messages already folded into the summary are dropped (unless a conversation
// grows to ten times the limit, e.g. because summaries keep failing).
function compact(id: number, s: ConversationSettings): void {
  const db = getDb();
  const row = db.prepare('SELECT message_count AS n, summarized_through AS through FROM custom_conversations WHERE id = ?').get(id) as { n: number; through: number } | undefined;
  if (!row || row.n <= Math.max(2 * s.maxMessages, 40)) return;
  const keep = Math.max(s.maxMessages, 20);
  const onlyFolded = s.summarize && row.n <= 10 * Math.max(s.maxMessages, 20);
  runWriteGroup(db, [
    {
      sql: `DELETE FROM custom_conversation_messages WHERE conversation_id = ? AND id < (SELECT id FROM custom_conversation_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)${onlyFolded ? ' AND id <= ?' : ''}`,
      params: onlyFolded ? [id, id, keep - 1, row.through] : [id, id, keep - 1],
    },
    {
      sql: 'UPDATE custom_conversations SET message_count = (SELECT COUNT(*) FROM custom_conversation_messages WHERE conversation_id = ?), chars = (SELECT COALESCE(SUM(LENGTH(content)), 0) FROM custom_conversation_messages WHERE conversation_id = ?) WHERE id = ?',
      params: [id, id, id],
    },
  ]);
}

interface ListRow { id: string; endUser: string | null; messages: number; chars: number; createdAt: string; updatedAt: string }
const LIST_COLUMNS = 'conv_key AS id, end_user AS endUser, message_count AS messages, chars, created_at AS createdAt, updated_at AS updatedAt';

/** Live conversations of a key, most recently used first. */
export function listConversations(profileId: number, s: ConversationSettings, opts: { endUser?: string | null; limit?: number } = {}, now = Date.now()): StoredConversation[] {
  const limit = Math.max(1, Math.min(L.listLimit, opts.limit ?? L.listLimit));
  const since = cutoff(s.ttlHours, now);
  const rows = (opts.endUser
    ? getDb().prepare(`SELECT ${LIST_COLUMNS} FROM custom_conversations WHERE profile_id = ? AND end_user = ? AND updated_at >= ? ORDER BY updated_at DESC LIMIT ?`).all(profileId, opts.endUser, since, limit)
    : getDb().prepare(`SELECT ${LIST_COLUMNS} FROM custom_conversations WHERE profile_id = ? AND updated_at >= ? ORDER BY updated_at DESC LIMIT ?`).all(profileId, since, limit)) as ListRow[];
  return rows.map(r => ({ ...r, expiresAt: expiresAt(r.updatedAt, s.ttlHours) }));
}

/** A live conversation and its stored messages, oldest first; null when there is none. */
export function getConversation(profileId: number, key: string, s: ConversationSettings, now = Date.now()): { conversation: StoredConversation; messages: StoredMessage[] } | null {
  const db = getDb();
  const row = db.prepare(`SELECT rowid AS rid, summary, ${LIST_COLUMNS} FROM custom_conversations WHERE profile_id = ? AND conv_key = ?`)
    .get(profileId, key) as (ListRow & { rid: number; summary: string | null }) | undefined;
  if (!row || row.updatedAt < cutoff(s.ttlHours, now)) return null;
  const messages = db.prepare('SELECT role, content, created_at AS createdAt FROM custom_conversation_messages WHERE conversation_id = ? ORDER BY id')
    .all(row.rid) as StoredMessage[];
  const { rid: _rid, ...conversation } = row;
  return { conversation: { ...conversation, expiresAt: expiresAt(row.updatedAt, s.ttlHours) }, messages };
}

export function deleteConversation(profileId: number, key: string): boolean {
  const row = getDb().prepare('SELECT id FROM custom_conversations WHERE profile_id = ? AND conv_key = ?').get(profileId, key) as { id: number } | undefined;
  if (!row) return false;
  deleteConversationRows([row.id]);
  return true;
}

/** Every conversation of one end user of the key; returns how many were deleted. */
export function deleteEndUserConversations(profileId: number, endUser: string): number {
  const ids = (getDb().prepare('SELECT id FROM custom_conversations WHERE profile_id = ? AND end_user = ?').all(profileId, endUser) as Array<{ id: number }>).map(r => r.id);
  for (let i = 0; i < ids.length; i += 200) deleteConversationRows(ids.slice(i, i + 200));
  return ids.length;
}

/**
 * Delete conversations past their key's time limit, and once a day those of deleted keys. Each delete is
 * a range on (profile_id, updated_at), so a pass reads only the rows it removes plus the key list.
 */
export function pruneConversations(now = Date.now(), includeOrphans = false): number {
  const db = getDb();
  const profiles = db.prepare(`SELECT id, ${SETTINGS_COLUMNS} FROM client_profiles`).all() as Array<SettingsRow & { id: number }>;
  let removed = 0;
  for (const p of profiles) {
    const before = cutoff(settingsFromRow(p).ttlHours, now);
    const stale = db.prepare('SELECT id FROM custom_conversations WHERE profile_id = ? AND updated_at < ? LIMIT 500').all(p.id, before) as Array<{ id: number }>;
    if (stale.length === 0) continue;
    for (let i = 0; i < stale.length; i += 200) deleteConversationRows(stale.slice(i, i + 200).map(r => r.id));
    removed += stale.length;
  }
  if (includeOrphans) {
    const orphans = db.prepare('SELECT id FROM custom_conversations WHERE profile_id NOT IN (SELECT id FROM client_profiles) LIMIT 500').all() as Array<{ id: number }>;
    for (let i = 0; i < orphans.length; i += 200) deleteConversationRows(orphans.slice(i, i + 200).map(r => r.id));
    removed += orphans.length;
  }
  return removed;
}

const PRUNE_EVERY_MS = HOUR_MS;
let lastPruneAt = 0;
let passes = 0;

/** At most once an hour, from a conversation write (no timer; orphans of deleted keys every 24th pass). */
export function maybePruneConversations(now = Date.now()): void {
  if (now - lastPruneAt < PRUNE_EVERY_MS) return;
  lastPruneAt = now;
  passes += 1;
  try { pruneConversations(now, passes % 24 === 1); } catch (err) {
    console.warn('[conversations] prune failed:', err instanceof Error ? err.message : err);
  }
}

/** Tests only. */
export function resetConversationPruning(): void { lastPruneAt = 0; passes = 0; }
