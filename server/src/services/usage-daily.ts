import { getDb, getSetting, setSetting } from '../db/index.js';

// Long-term usage: each finished UTC day of the request log rolled up once into custom_usage_daily
// (per account, client key, and end user of a client key). Today is read live from the log. The
// rollup runs at most every 10 minutes from a finished request (never while one is answered), reads
// only the day it rolls up through the created_at index, and catches up on missed days.

export type DailyKind = 'user' | 'profile' | 'end_user';

export interface DailyRow {
  day: string
  kind: DailyKind
  id: number
  endUser: string | null
  requests: number
  success: number
  errors: number
  inputTokens: number
  outputTokens: number
  /** Mean latency of the day's successful requests; null without any. */
  avgLatencyMs: number | null
}

const DAY_MS = 86_400_000;
const THROUGH_KEY = 'custom_usage_daily_through';
const CHECK_EVERY_MS = 10 * 60 * 1000;
/** Days rolled up in one pass at most: a first run backfills what the log still holds (up to 90 days)
 *  15 days at a time, one pass every 10 minutes, so no single pass holds the server for long on Turso. */
const MAX_DAYS_PER_PASS = 15;
const KEEP_DAYS = 731;
const KEEP_END_USER_DAYS = 400;
export const MAX_RANGE_DAYS = 731;

export const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const startOf = (day: string): string => `${day} 00:00:00`;
const nextDay = (day: string): string => dayOf(Date.parse(`${day}T00:00:00Z`) + DAY_MS);

// Closed set, spliced into SQL: how each kind groups the log.
const GROUPS: Record<DailyKind, { id: string; endUser: string; where: string; group: string }> = {
  user: { id: 'user_id', endUser: "''", where: 'user_id IS NOT NULL', group: 'user_id' },
  profile: { id: 'profile_id', endUser: "''", where: 'profile_id IS NOT NULL', group: 'profile_id' },
  end_user: { id: 'profile_id', endUser: 'end_user', where: 'profile_id IS NOT NULL AND end_user IS NOT NULL', group: 'profile_id, end_user' },
};

function aggregateSql(kind: DailyKind, idFilter: boolean): string {
  const g = GROUPS[kind];
  return `SELECT ? AS day, '${kind}' AS subject_kind, ${g.id} AS subject_id, ${g.endUser} AS end_user,
      COUNT(*) AS requests,
      SUM(status = 'success') AS success,
      SUM(status = 'error') AS errors,
      SUM(CASE WHEN status = 'success' THEN input_tokens ELSE 0 END) AS input_tokens,
      SUM(CASE WHEN status = 'success' THEN output_tokens ELSE 0 END) AS output_tokens,
      SUM(CASE WHEN status = 'success' THEN latency_ms ELSE 0 END) AS latency_ms_sum
    FROM requests
    WHERE ${g.where} AND created_at >= ? AND created_at < ?${idFilter ? ` AND ${g.id} = ?` : ''}
    GROUP BY ${g.group}`;
}

/** Replace one day's rows with a fresh rollup of the log. */
export function rollUpDay(day: string): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM custom_usage_daily WHERE day = ?').run(day);
    for (const kind of Object.keys(GROUPS) as DailyKind[]) {
      db.prepare(`INSERT INTO custom_usage_daily (day, subject_kind, subject_id, end_user, requests, success, errors, input_tokens, output_tokens, latency_ms_sum) ${aggregateSql(kind, false)}`)
        .run(day, startOf(day), startOf(nextDay(day)));
    }
  })();
}

/** Roll up every finished day not yet rolled up; returns how many days were. */
export function rollUpPending(now = Date.now()): number {
  const db = getDb();
  const yesterday = dayOf(now - DAY_MS);
  let from = getSetting(THROUGH_KEY);
  if (from) from = nextDay(from);
  else {
    const first = db.prepare('SELECT MIN(created_at) AS t FROM requests').get() as { t: string | null } | undefined;
    if (!first?.t) { setSetting(THROUGH_KEY, yesterday); return 0; }
    from = first.t.slice(0, 10);
  }
  let count = 0;
  for (let day = from; day <= yesterday && count < MAX_DAYS_PER_PASS; day = nextDay(day)) {
    rollUpDay(day);
    setSetting(THROUGH_KEY, day);
    count += 1;
  }
  if (count > 0) {
    db.prepare("DELETE FROM custom_usage_daily WHERE day < ?").run(dayOf(now - KEEP_DAYS * DAY_MS));
    db.prepare("DELETE FROM custom_usage_daily WHERE subject_kind = 'end_user' AND day < ?").run(dayOf(now - KEEP_END_USER_DAYS * DAY_MS));
  }
  return count;
}

let lastCheckAt = 0;

/** Cheap enough to call after every request: a time check, and once in 10 minutes one settings read. */
export function maybeRollUp(now = Date.now()): void {
  if (now - lastCheckAt < CHECK_EVERY_MS) return;
  lastCheckAt = now;
  try {
    if (getSetting(THROUGH_KEY) === dayOf(now - DAY_MS)) return;
    rollUpPending(now);
  } catch (err) {
    console.warn('[usage-daily] rollup failed:', err instanceof Error ? err.message : err);
  }
}

/** Tests only. */
export function resetDailyRollupClock(): void { lastCheckAt = 0; }

interface StoredRow { day: string; kind: DailyKind; id: number; endUser: string; requests: number; success: number; errors: number; inputTokens: number; outputTokens: number; latency: number }

const toRow = (r: StoredRow): DailyRow => ({
  day: r.day, kind: r.kind, id: r.id, endUser: r.kind === 'end_user' ? r.endUser : null,
  requests: r.requests, success: r.success ?? 0, errors: r.errors ?? 0, inputTokens: r.inputTokens ?? 0, outputTokens: r.outputTokens ?? 0,
  avgLatencyMs: r.success ? Math.round((r.latency ?? 0) / r.success) : null,
});

/**
 * Daily figures of one kind between two UTC days (inclusive), oldest first: stored rollups for past
 * days, the log for today. Missing past days are rolled up first. `id` narrows to one account / key.
 */
export function dailyUsage(kind: DailyKind, from: string, to: string, id: number | null = null, now = Date.now()): DailyRow[] {
  const db = getDb();
  const today = dayOf(now);
  if (from < today) { try { rollUpPending(now); } catch { /* the stored days still answer */ } }
  const cols = 'day, subject_kind AS kind, subject_id AS id, end_user AS endUser, requests, success, errors, input_tokens AS inputTokens, output_tokens AS outputTokens, latency_ms_sum AS latency';
  const pastTo = to < today ? to : dayOf(Date.parse(`${today}T00:00:00Z`) - DAY_MS);
  const rows: DailyRow[] = [];
  if (from <= pastTo) {
    const stored = (id === null
      ? db.prepare(`SELECT ${cols} FROM custom_usage_daily WHERE subject_kind = ? AND day >= ? AND day <= ? ORDER BY day, subject_id, end_user`).all(kind, from, pastTo)
      : db.prepare(`SELECT ${cols} FROM custom_usage_daily WHERE subject_kind = ? AND subject_id = ? AND day >= ? AND day <= ? ORDER BY day, end_user`).all(kind, id, from, pastTo)) as StoredRow[];
    rows.push(...stored.map(toRow));
  }
  if (to >= today && from <= today) {
    const live = db.prepare(`SELECT day, subject_kind AS kind, subject_id AS id, end_user AS endUser, requests, success, errors, input_tokens AS inputTokens, output_tokens AS outputTokens, latency_ms_sum AS latency FROM (${aggregateSql(kind, id !== null)}) ORDER BY subject_id, end_user`)
      .all(...[today, startOf(today), startOf(nextDay(today)), ...(id === null ? [] : [id])]) as StoredRow[];
    rows.push(...live.map(toRow));
  }
  return rows;
}

/** Names of the accounts / client keys in the rows (one statement). */
export function subjectNames(kind: DailyKind, ids: number[]): Map<number, string> {
  const out = new Map<number, string>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return out;
  const table = kind === 'user' ? 'SELECT id, email AS name FROM users' : 'SELECT id, name FROM client_profiles';
  for (let i = 0; i < unique.length; i += 500) {
    const chunk = unique.slice(i, i + 500);
    for (const r of getDb().prepare(`${table} WHERE id IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as Array<{ id: number; name: string }>) out.set(r.id, r.name);
  }
  return out;
}

/** A CSV cell: quoted when needed, and never read as a formula by a spreadsheet. */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(kind: DailyKind, rows: DailyRow[]): string {
  const names = subjectNames(kind, rows.map(r => r.id));
  const head = ['day', kind === 'user' ? 'account_id' : 'client_key_id', kind === 'user' ? 'account' : 'client_key', ...(kind === 'end_user' ? ['end_user'] : []),
    'requests', 'success', 'errors', 'input_tokens', 'output_tokens', 'avg_latency_ms'];
  const lines = [head.join(',')];
  for (const r of rows) {
    lines.push([r.day, r.id, names.get(r.id) ?? '', ...(kind === 'end_user' ? [r.endUser] : []), r.requests, r.success, r.errors, r.inputTokens, r.outputTokens, r.avgLatencyMs]
      .map(csvCell).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}
