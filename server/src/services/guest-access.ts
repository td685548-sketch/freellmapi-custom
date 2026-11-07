import type { NextFunction, Request, Response } from 'express';
import { getSetting, setSetting } from '../db/index.js';
import { GUEST_PERMISSIONS, type GuestPermission } from '@freellmapi/shared/guest-access.js';
import type { SessionUser } from './auth.js';

// Visitors who are not signed in ("guests") may read what an administrator allows, nothing more:
//  - only GET requests without any credential,
//  - only the exact routes listed below, each tied to one guest permission,
//  - answered from a 30-second copy shared by every guest, so anonymous traffic costs the
//    database (Turso) at most one computation per route and half minute.
// A guest request is marked so the permission gates let it through; every other request is untouched.

const SETTING_KEY = 'guest_permissions';
const KNOWN = new Set<string>(GUEST_PERMISSIONS.map(p => p.key));
const CACHE_MS = 30_000;

/** Exact paths (no trailing slash) a guest may read, and the permission each needs. */
const GUEST_ROUTES: Array<[RegExp, GuestPermission]> = [
  [/^\/api\/profiles\/active$/, 'view_models'],
  [/^\/api\/fallback$/, 'view_models'],
  [/^\/api\/fallback\/(?:token-usage|routing|rate-limit-usage)$/, 'view_models'],
  [/^\/api\/usage\/profiles$/, 'view_usage_profiles'],
  [/^\/api\/usage\/(?:daily\/(?:profiles|end-users)|export\/(?:profiles|end-users)\.csv)$/, 'view_usage_profiles'],
  [/^\/api\/usage\/accounts$/, 'view_usage_accounts'],
  [/^\/api\/usage\/(?:daily\/accounts|export\/accounts\.csv)$/, 'view_usage_accounts'],
];

/** Fields a guest never receives: which stored key or custom endpoint serves a model. */
const REDACT: Record<string, (body: unknown) => unknown> = {
  '/api/fallback': (body) => Array.isArray(body)
    ? body.map((e: Record<string, unknown>) => ({ ...e, keyId: null, keyLabel: null, endpointScope: null, qualifiedModelId: null }))
    : body,
};

export function getGuestPermissions(): GuestPermission[] {
  try {
    const v: unknown = JSON.parse(getSetting(SETTING_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((p): p is GuestPermission => typeof p === 'string' && KNOWN.has(p)) : [];
  } catch { return []; }
}

export function setGuestPermissions(list: readonly string[]): GuestPermission[] {
  const clean = [...new Set(list.filter(p => KNOWN.has(p)))] as GuestPermission[];
  setSetting(SETTING_KEY, JSON.stringify(clean));
  cache.clear();
  return clean;
}

/** The session a guest request carries: no account, only the guest permissions. */
export function guestSession(permissions: GuestPermission[]): SessionUser & { guest: true } {
  return { userId: 0, email: '', role: 'member', isPrimary: false, permissions, guest: true } as SessionUser & { guest: true };
}

export function isGuestRequest(req: Request): boolean {
  return (req as Request & { guestAccess?: boolean }).guestAccess === true;
}

const cache = new Map<string, { at: number; status: number; type: string | undefined; body: unknown }>();

/** Tests only. */
export function resetGuestCache(): void { cache.clear(); }

function hasCredential(req: Request): boolean {
  return Boolean(req.headers.authorization || req.headers['x-dashboard-token']);
}

/** Mounted on /api before the permission gates. */
export function guestAccessMiddleware(req: Request, res: Response, next: NextFunction): void {
  if ((req.method !== 'GET' && req.method !== 'HEAD') || hasCredential(req)) { next(); return; }
  const path = req.originalUrl.split('?')[0]!.replace(/\/+$/, '');
  const needed = GUEST_ROUTES.find(([re]) => re.test(path))?.[1];
  const isSessionProbe = path === '/api/user/session';
  if (!needed && !isSessionProbe) { next(); return; }
  const permissions = getGuestPermissions();
  if (permissions.length === 0) { next(); return; }

  // The dashboard asks who it is talking to; a guest is told its permissions.
  if (isSessionProbe) { res.json({ userId: 0, email: '', role: 'guest', isPrimary: false, permissions, guest: true }); return; }
  if (!permissions.includes(needed!)) { next(); return; }

  const user = guestSession(permissions);
  const marked = req as Request & { user?: SessionUser; guestAccess?: boolean };
  marked.user = user;
  marked.guestAccess = true;

  // One shared copy per route and query (minus `fresh`, which guests may not force).
  const params = new URLSearchParams(req.originalUrl.split('?')[1] ?? '');
  params.delete('fresh');
  const key = `${path}?${[...params].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('&')}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    if (hit.type) res.setHeader('Content-Type', hit.type);
    res.setHeader('X-Guest-Cache', 'hit');
    res.status(hit.status).send(hit.body as never);
    return;
  }
  const send = res.send.bind(res);
  const redact = REDACT[path];
  res.send = ((raw: unknown) => {
    let body = raw;
    if (redact && typeof raw === 'string' && res.statusCode === 200) {
      try { body = JSON.stringify(redact(JSON.parse(raw))); } catch { body = '[]'; }
    }
    if (cache.size >= 500) { const now = Date.now(); for (const [k, v] of cache) if (now - v.at >= CACHE_MS) cache.delete(k); }
    if (res.statusCode === 200 && cache.size < 500) cache.set(key, { at: Date.now(), status: 200, type: res.getHeader('Content-Type') as string | undefined, body });
    return send(body as never);
  }) as typeof res.send;
  next();
}
