import { getDb, getSetting, setSetting } from '../db/index.js';
import { deliverAlert, type Delivery } from './usage-alerts.js';
import { dayOf, rollUpPending, subjectNames } from './usage-daily.js';

// A weekly summary (Monday to Sunday, UTC) of the gateway's attributed traffic, sent through the usage
// alert destinations (Logs page, webhook, email). Built from the long-term daily table, so it reads a
// week of daily rows, never the request log. Sent once per week, from the first finished request after
// Monday 00:00 UTC (an instance asleep all Monday sends it when it wakes).

const DAY_MS = 86_400_000;
const ENABLED_KEY = 'usage_report_weekly';
const LAST_SENT_KEY = 'usage_report_last_week';
const CHECK_EVERY_MS = 10 * 60 * 1000;
const TOP = 5;

export interface ReportSubject { name: string; requests: number; errors: number; tokens: number }
export interface WeeklyReport {
  /** Monday of the reported week, YYYY-MM-DD. */
  week: string
  from: string
  to: string
  totals: { requests: number; success: number; errors: number; tokens: number }
  /** The same totals for the week before. */
  previous: { requests: number; errors: number; tokens: number }
  topAccounts: ReportSubject[]
  topClientKeys: ReportSubject[]
  topEndUsers: Array<ReportSubject & { clientKey: string }>
}

/** Monday (UTC) of the last full week before `now`. */
export function lastFullWeek(now: number): { from: string; to: string } {
  const d = new Date(now);
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  const thisMonday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - sinceMonday);
  return { from: dayOf(thisMonday - 7 * DAY_MS), to: dayOf(thisMonday - DAY_MS) };
}

interface Agg { id: number; endUser: string; requests: number; errors: number; tokens: number; success: number }

function aggregate(kind: 'user' | 'profile' | 'end_user', from: string, to: string): Agg[] {
  return getDb().prepare(`
    SELECT subject_id AS id, end_user AS endUser, SUM(requests) AS requests, SUM(success) AS success, SUM(errors) AS errors,
           SUM(input_tokens + output_tokens) AS tokens
    FROM custom_usage_daily WHERE subject_kind = ? AND day >= ? AND day <= ?
    GROUP BY subject_id, end_user ORDER BY SUM(requests) DESC
  `).all(kind, from, to) as Agg[];
}

export function buildWeeklyReport(now = Date.now()): WeeklyReport {
  try { rollUpPending(now); } catch { /* report on what is stored */ }
  const { from, to } = lastFullWeek(now);
  const prevFrom = dayOf(Date.parse(`${from}T00:00:00Z`) - 7 * DAY_MS);
  const prevTo = dayOf(Date.parse(`${from}T00:00:00Z`) - DAY_MS);
  const users = aggregate('user', from, to);
  const profiles = aggregate('profile', from, to);
  const endUsers = aggregate('end_user', from, to);
  const sum = (rows: Agg[]) => rows.reduce((t, r) => ({ requests: t.requests + r.requests, success: t.success + r.success, errors: t.errors + r.errors, tokens: t.tokens + r.tokens }), { requests: 0, success: 0, errors: 0, tokens: 0 });
  // Accounts and client keys are separate traffic; end users are a breakdown of client-key traffic.
  const a = sum(users); const p = sum(profiles);
  const pa = sum(aggregate('user', prevFrom, prevTo)); const pp = sum(aggregate('profile', prevFrom, prevTo));
  const userNames = subjectNames('user', users.slice(0, TOP).map(r => r.id));
  const keyNames = subjectNames('profile', [...profiles.slice(0, TOP), ...endUsers.slice(0, TOP)].map(r => r.id));
  const subject = (names: Map<number, string>) => (r: Agg): ReportSubject => ({ name: names.get(r.id) ?? `#${r.id}`, requests: r.requests, errors: r.errors, tokens: r.tokens });
  return {
    week: from, from, to,
    totals: { requests: a.requests + p.requests, success: a.success + p.success, errors: a.errors + p.errors, tokens: a.tokens + p.tokens },
    previous: { requests: pa.requests + pp.requests, errors: pa.errors + pp.errors, tokens: pa.tokens + pp.tokens },
    topAccounts: users.slice(0, TOP).map(subject(userNames)),
    topClientKeys: profiles.slice(0, TOP).map(subject(keyNames)),
    topEndUsers: endUsers.slice(0, TOP).map(r => ({ ...subject(keyNames)(r), name: r.endUser, clientKey: keyNames.get(r.id) ?? `#${r.id}` })),
  };
}

const n = (v: number) => v.toLocaleString('en-US');
function change(current: number, previous: number): string {
  if (previous === 0) return current > 0 ? 'new' : 'no change';
  const pct = Math.round(((current - previous) / previous) * 100);
  return `${pct >= 0 ? '+' : ''}${pct}% vs the week before`;
}

/** The report as plain text: the first line works as an email subject. */
export function reportText(r: WeeklyReport): string {
  const t = r.totals;
  const rate = t.success + t.errors > 0 ? `${((t.errors / (t.success + t.errors)) * 100).toFixed(1)}% errors` : 'no finished requests';
  const lines = [
    `Weekly usage report ${r.from} to ${r.to}: ${n(t.requests)} requests, ${n(t.tokens)} tokens`,
    '',
    `Requests: ${n(t.requests)} (${change(t.requests, r.previous.requests)})`,
    `Tokens: ${n(t.tokens)} (${change(t.tokens, r.previous.tokens)})`,
    `Errors: ${n(t.errors)}, ${rate} (${change(t.errors, r.previous.errors)})`,
  ];
  const list = (title: string, rows: Array<ReportSubject & { clientKey?: string }>) => {
    if (rows.length === 0) return;
    lines.push('', `${title}:`);
    rows.forEach((s, i) => lines.push(`${i + 1}. ${s.name}${s.clientKey ? ` (${s.clientKey})` : ''}: ${n(s.requests)} requests, ${n(s.tokens)} tokens, ${n(s.errors)} errors`));
  };
  list('Busiest accounts', r.topAccounts);
  list('Busiest client keys', r.topClientKeys);
  list('Busiest end users', r.topEndUsers);
  return lines.join('\n');
}

export function sendWeeklyReport(now = Date.now()): Promise<{ report: WeeklyReport; delivery: Delivery }> {
  const report = buildWeeklyReport(now);
  return deliverAlert({ alert: 'weekly_report', level: 'info', subject: null, message: reportText(report), details: { report } }, now)
    .then(delivery => ({ report, delivery }));
}

export function reportSettings(): { enabled: boolean; lastSentWeek: string | null } {
  return { enabled: getSetting(ENABLED_KEY) === '1', lastSentWeek: getSetting(LAST_SENT_KEY) ?? null };
}
export function setReportEnabled(enabled: boolean): void { setSetting(ENABLED_KEY, enabled ? '1' : '0'); }

let lastCheckAt = 0;

/** Called after finished requests: a time check, and every 10 minutes two settings reads. */
export function maybeSendWeeklyReport(now = Date.now()): void {
  if (now - lastCheckAt < CHECK_EVERY_MS) return;
  lastCheckAt = now;
  try {
    const s = reportSettings();
    if (!s.enabled) return;
    const week = lastFullWeek(now).from;
    if (s.lastSentWeek === week) return;
    setSetting(LAST_SENT_KEY, week); // first: a slow delivery must not send it twice
    void sendWeeklyReport(now).catch(err => console.warn('[usage-report] could not send:', err instanceof Error ? err.message : err));
  } catch (err) {
    console.warn('[usage-report] check failed:', err instanceof Error ? err.message : err);
  }
}

/** Tests only. */
export function resetReportClock(): void { lastCheckAt = 0; }
