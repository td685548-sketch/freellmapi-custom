import type { NextFunction, Request, Response } from 'express';
import { getDb } from '../db/index.js';
import type { SessionUser } from './auth.js';

// Who changed what on the dashboard, and when. One middleware on /api records every successful write
// by a signed-in account once its response has gone out, so no route has to remember to log. What was
// sent is kept as a short summary with every secret-looking field removed.

export interface AuditEntry {
  id: number
  createdAt: string
  actorId: number | null
  actorEmail: string | null
  ip: string | null
  method: string
  path: string
  /** The path with ids replaced by :id, e.g. PUT /api/client-profiles/:id/quota. */
  route: string
  /** The first part of the path after /api, e.g. client-profiles, admin/users, keys. */
  area: string
  targetId: number | null
  status: number
  /** What was sent, secrets removed; null without a body. */
  summary: unknown
}

const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** Not changes an operator audits: signing in and out, and the Playground saving its chats. */
const SKIP = /^\/api\/(?:auth|conversations|playground)(?:\/|$)/;
const SECRET = /pass(?:word)?|secret|token|api[-_]?key|^key$|^keys$|private|credential|cookie|authorization|encrypted|^value$|^code$/i;
const MAX_STRING = 200;
const MAX_SUMMARY = 2_000;
const KEEP_DAYS = 180;
const MAX_ROWS = 100_000;
const DAY_MS = 86_400_000;

/** Two-word areas so the users page and its requests do not all read "admin". */
const TWO_PART = new Set(['admin', 'settings', 'user']);

export function describeRoute(path: string): { route: string; area: string; targetId: number | null } {
  const parts = path.split('?')[0]!.replace(/\/+$/, '').split('/').filter(Boolean); // ['api', ...]
  const rest = parts.slice(1);
  const area = rest.length === 0 ? '' : TWO_PART.has(rest[0]!) && rest[1] && !/^\d+$/.test(rest[1]) ? `${rest[0]}/${rest[1]}` : rest[0]!;
  const firstId = rest.find(p => /^\d+$/.test(p));
  return {
    route: '/' + parts.map(p => (/^\d+$/.test(p) ? ':id' : p)).join('/'),
    area,
    targetId: firstId ? Number(firstId) : null,
  };
}

const stripUrlCredentials = (s: string) => s.replace(/\/\/[^/@\s]+@/g, '//***@');

/** A copy of the body that is safe and small to keep. */
export function summarize(body: unknown, depth = 0): unknown {
  if (body === null || body === undefined) return null;
  if (typeof body === 'string') return stripUrlCredentials(body.length > MAX_STRING ? `${body.slice(0, MAX_STRING)}…` : body);
  if (typeof body === 'number' || typeof body === 'boolean') return body;
  if (depth >= 3) return '…';
  if (Array.isArray(body)) {
    const items = body.slice(0, 20).map(v => summarize(v, depth + 1));
    return body.length > 20 ? [...items, `… ${body.length - 20} more`] : items;
  }
  if (typeof body === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body as Record<string, unknown>).slice(0, 40)) out[k] = SECRET.test(k) ? '[hidden]' : summarize(v, depth + 1);
    return out;
  }
  return null;
}

let lastPruneAt = 0;

function record(req: Request, res: Response): void {
  const user = (req as Request & { user?: SessionUser }).user;
  if (!user || res.statusCode >= 400) return;
  const path = req.originalUrl.split('?')[0]!;
  const { route, area, targetId } = describeRoute(path);
  let summary: string | null = null;
  const body = req.body as unknown;
  if (body && typeof body === 'object' && Object.keys(body as object).length > 0) {
    summary = JSON.stringify(summarize(body));
    if (summary.length > MAX_SUMMARY) summary = JSON.stringify({ truncated: summary.slice(0, MAX_SUMMARY) });
  }
  const now = Date.now();
  const db = getDb();
  db.prepare('INSERT INTO custom_audit_log (created_at, actor_id, actor_email, ip, method, path, route, area, target_id, status, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(new Date(now).toISOString(), user.userId, user.email, (req.ip ?? '').replace(/^::ffff:/, '') || null, req.method, path.slice(0, 300), route.slice(0, 300), area.slice(0, 60), targetId, res.statusCode, summary);
  if (now - lastPruneAt > 60 * 60 * 1000) {
    lastPruneAt = now;
    db.prepare('DELETE FROM custom_audit_log WHERE created_at < ?').run(new Date(now - KEEP_DAYS * DAY_MS).toISOString());
    const top = db.prepare('SELECT MAX(id) AS hi FROM custom_audit_log').get() as { hi: number | null } | undefined;
    if (top?.hi && top.hi > MAX_ROWS) db.prepare('DELETE FROM custom_audit_log WHERE id <= ?').run(top.hi - MAX_ROWS);
  }
}

/** Mounted on /api before every router; it only listens for the response's end. */
export function auditMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (WRITE.has(req.method) && !SKIP.test(req.originalUrl)) {
    res.once('finish', () => {
      try { record(req, res); } catch (err) { console.warn('[audit] could not record:', err instanceof Error ? err.message : err); }
    });
  }
  next();
}

export interface AuditQuery { actorId?: number; area?: string; q?: string; before?: number; limit?: number }

/** Newest first, paged by id. `q` matches the path, the actor's email or the summary. */
export function listAudit(query: AuditQuery): { entries: AuditEntry[]; areas: string[] } {
  const where: string[] = [];
  const args: unknown[] = [];
  if (query.actorId) { where.push('actor_id = ?'); args.push(query.actorId); }
  if (query.area) { where.push('area = ?'); args.push(query.area); }
  if (query.before) { where.push('id < ?'); args.push(query.before); }
  if (query.q) {
    const like = `%${query.q.replace(/[\\%_]/g, c => `\\${c}`)}%`;
    where.push("(path LIKE ? ESCAPE '\\' OR actor_email LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\')");
    args.push(like, like, like);
  }
  const limit = Math.max(1, Math.min(200, query.limit ?? 50));
  const db = getDb();
  const rows = db.prepare(`SELECT id, created_at AS createdAt, actor_id AS actorId, actor_email AS actorEmail, ip, method, path, route, area, target_id AS targetId, status, summary
    FROM custom_audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`).all(...args, limit) as Array<Omit<AuditEntry, 'summary'> & { summary: string | null }>;
  const areas = (db.prepare('SELECT DISTINCT area FROM custom_audit_log ORDER BY area').all() as Array<{ area: string }>).map(r => r.area);
  return {
    entries: rows.map(r => ({ ...r, summary: r.summary ? (() => { try { return JSON.parse(r.summary!); } catch { return r.summary; } })() : null })),
    areas,
  };
}

/** Tests only. */
export function resetAuditPrune(): void { lastPruneAt = 0; }
