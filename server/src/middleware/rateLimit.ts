import type { Request, Response, NextFunction } from 'express';
import { extractInferenceToken } from './user-rate-limit.js';
import {
  getMemoizedUserKey,
  hashUserApiKey,
  USER_KEY_PREFIX,
  validateUserApiKey,
  withUserKeyMemo,
  type ValidatedUserKey,
} from '../services/user-keys.js';
import { isXGatewayClientKey, validateXGatewayClientKey } from '../custom/x-gateway/client-keys.js';

// Fixed-window rate limiter for the public proxy surfaces (/v1, /v1beta,
// /thruline/v1, /mcp, /v1/t/:token, Ollama /api/* — #35, item #6).
//
// These surfaces authenticate with API keys but have no password login like
// the dashboard does, so without this an attacker who can reach the server
// could brute-force a key or flood upstream providers. This caps how many
// requests one credential can make per minute and returns a standard
// OpenAI-shaped 429 once the cap is exceeded.
//
// ONE store, shared by every limiter instance (and one instance mounted on
// every surface in app.ts): previously each createProxyRateLimiter() call
// built its own Map, so the six mounts each allowed 120/min/IP — the same
// key got ~600-720/min across the surfaces. Counting is per KEY HASH, not
// per IP: a key keeps one budget no matter which IP it arrives from, and a
// flood of guesses on one key shares one budget instead of getting a fresh
// 120/min per source IP. Requests with no credential still fall back to a
// per-IP bucket, so unauthenticated brute-force traffic is capped too.
//
// A validated personal key (`sk-flm-…`) or X Gateway key (`sk-xgw-…`) is
// limited by its own rpmLimit (default 60, from user_api_keys.rpm_limit /
// x_gateway_client_keys.rpm_limit) instead of the global PROXY_RATE_LIMIT_RPM
// — the per-user sliding window in middleware/user-rate-limit.ts enforces the
// same limit per user id on /v1, /v1beta and /thruline/v1; this limiter is
// what enforces it on the surfaces that gate does not cover (/mcp, Ollama
// /api/*, /v1/t/:token) and what stops one key from stacking the global
// budget once per surface. Any other credential (unified key, client-profile
// key, URL token, unknown) gets the global limit, bucketed by its hash.
//
// Tune the global limit with PROXY_RATE_LIMIT_RPM (requests per minute);
// set it to 0 to turn this limiter off entirely (the per-user gate above is
// unaffected). Only the SHA-256 hash of a credential is ever kept — never
// the credential itself.

const WINDOW_MS = 60_000;
const DEFAULT_RPM = 120;
// Bound the bucket map so a flood of distinct credentials / source addresses
// can't grow it without limit; expired entries are pruned opportunistically.
const MAX_TRACKED_BUCKETS = 10_000;

// Shared by every proxy limiter instance: the budget is per credential (or
// per IP when unauthenticated), not per mount point.
const proxyWindows = new Map<string, WindowState>();

/** Test hook: drop all proxy rate-limit windows. The store is process-wide
 * and shared across limiter instances, so tests that reuse a limit must
 * reset it between cases instead of relying on a fresh instance. */
export function resetProxyRateLimitState(): void {
  proxyWindows.clear();
}

interface WindowState {
  count: number;
  resetAt: number;
}

function parseLimit(): number {
  const raw = process.env.PROXY_RATE_LIMIT_RPM;
  if (raw === undefined || raw.trim() === '') return DEFAULT_RPM;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_RPM;
  return Math.floor(n);
}

/** The `:token` of a /v1/t/:token request — the limiter is mounted on that
 * path, so Express has already populated req.params by the time it runs. */
function urlToken(req: Request): string | undefined {
  const token = (req.params as Record<string, unknown> | undefined)?.token;
  return typeof token === 'string' && token.trim() ? token.trim() : undefined;
}

interface ProxyBucket {
  /** Map key: `ip:<ip>`, `userkey:<sha256>` (validated personal/X Gateway
   * key, limited by its rpmLimit) or `key:<sha256>` (any other credential). */
  key: string;
  /** Effective requests-per-minute for this bucket. */
  limit: number;
}

/**
 * Resolve the bucket and limit for one request.
 *
 * The user gate runs before this limiter on /v1 and /v1beta (see app.ts) and
 * already validated the key: reuse its answer via req.user / the request memo
 * instead of a second database lookup. On surfaces the gate does not cover
 * (/mcp, Ollama /api/*), a personal key is validated here — one indexed
 * lookup — so its rpmLimit is enforced there too.
 */
function resolveProxyBucket(req: Request, globalLimit: number): ProxyBucket {
  const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
  const token = extractInferenceToken(req) ?? urlToken(req);
  if (!token) return { key: `ip:${ip}`, limit: globalLimit };

  const keyHash = hashUserApiKey(token);
  const gateUser: ValidatedUserKey | null =
    (req as Request & { user?: ValidatedUserKey }).user ?? getMemoizedUserKey();
  if (gateUser) return { key: `userkey:${keyHash}`, limit: Math.max(1, gateUser.rpmLimit) };

  if (token.startsWith(USER_KEY_PREFIX)) {
    const validated = validateUserApiKey(token);
    if (validated) return { key: `userkey:${keyHash}`, limit: Math.max(1, validated.rpmLimit) };
    // Revoked/unknown personal key: still bucket by its hash (not the IP),
    // so a flood of guesses on one key shares one budget.
    return { key: `userkey:${keyHash}`, limit: globalLimit };
  }
  if (isXGatewayClientKey(token)) {
    const validated = validateXGatewayClientKey(token);
    if (validated) return { key: `userkey:${keyHash}`, limit: Math.max(1, validated.rpmLimit) };
    return { key: `userkey:${keyHash}`, limit: globalLimit };
  }
  // Unified key, client-profile key, URL token, or anything else: bucket by
  // credential hash with the global flood-guard limit.
  return { key: `key:${keyHash}`, limit: globalLimit };
}

export function createProxyRateLimiter(rpmLimit?: number) {
  const limit = rpmLimit !== undefined ? Math.floor(Math.max(0, rpmLimit)) : parseLimit();

  return function proxyRateLimit(req: Request, res: Response, next: NextFunction): void {
    if (limit === 0) {
      next();
      return;
    }

    // Open the per-request user-key memo (reused when the gate already opened
    // one): a personal key validated here is then reused by userInferenceGate
    // and resolveAuth instead of being looked up three times, and next() runs
    // inside the scope so downstream handlers share it.
    withUserKeyMemo(() => proxyRateLimitCounted(req, res, next, limit));
  };
}

function proxyRateLimitCounted(req: Request, res: Response, next: NextFunction, limit: number): void {
  const now = Date.now();
  const bucket = resolveProxyBucket(req, limit);
  const effectiveLimit = bucket.limit;

  let state = proxyWindows.get(bucket.key);
  if (!state || now >= state.resetAt) {
    state = { count: 0, resetAt: now + WINDOW_MS };
    proxyWindows.set(bucket.key, state);
  }
  state.count += 1;

  if (proxyWindows.size > MAX_TRACKED_BUCKETS) {
    for (const [key, value] of proxyWindows) {
      if (now >= value.resetAt) proxyWindows.delete(key);
    }
  }

  res.setHeader('X-RateLimit-Limit', String(effectiveLimit));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, effectiveLimit - state.count)));
  res.setHeader('X-RateLimit-Reset', String(Math.ceil(state.resetAt / 1000)));

  if (state.count > effectiveLimit) {
    const retryAfter = Math.max(1, Math.ceil((state.resetAt - now) / 1000));
    res.setHeader('Retry-After', String(retryAfter));
    res.status(429).json({
      error: {
        message: `Rate limit exceeded: more than ${effectiveLimit} requests per minute. Retry in ${retryAfter}s.`,
        type: 'rate_limit_error',
      },
    });
    return;
  }

  next();
}

// Per-IP fixed-window rate limiter for the /api/* admin surface.
//
// This is a flood guard, not the brute-force guard: dashboard login already has
// its own per-email lockout (routes/auth.ts), and the admin endpoints that
// re-verify a password — GET /api/keys/export and POST /api/keys/:id/reveal —
// get their own much tighter limiters mounted in app.ts. The broad cap therefore has to clear normal
// dashboard traffic with room to spare. Opening the dashboard fans out across
// keys, health, models, analytics, settings and profiles, and several of those
// poll, so a single user legitimately spends dozens of requests a minute.
//
// Tune with ADMIN_RATE_LIMIT_RPM (requests per minute per IP); 0 disables it.
const ADMIN_DEFAULT_RPM = 600;

function parseAdminLimit(): number {
  const raw = process.env.ADMIN_RATE_LIMIT_RPM;
  if (raw === undefined || raw.trim() === '') return ADMIN_DEFAULT_RPM;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return ADMIN_DEFAULT_RPM;
  return Math.floor(n);
}

export function createAdminRateLimiter(rpm?: number) {
  const limit = rpm !== undefined ? Math.floor(Math.max(0, rpm)) : parseAdminLimit();
  const windows = new Map<string, WindowState>();

  return function adminRateLimit(req: Request, res: Response, next: NextFunction): void {
    if (limit === 0) {
      next();
      return;
    }

    const now = Date.now();
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';

    let state = windows.get(ip);
    if (!state || now >= state.resetAt) {
      state = { count: 0, resetAt: now + WINDOW_MS };
      windows.set(ip, state);
    }
    state.count += 1;

    if (windows.size > MAX_TRACKED_BUCKETS) {
      for (const [key, value] of windows) {
        if (now >= value.resetAt) windows.delete(key);
      }
    }

    res.setHeader('X-RateLimit-Limit', String(limit));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, limit - state.count)));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(state.resetAt / 1000)));

    if (state.count > limit) {
      const retryAfter = Math.max(1, Math.ceil((state.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({
        error: {
          message: `Rate limit exceeded: more than ${limit} requests per minute. Retry in ${retryAfter}s.`,
          type: 'rate_limit_error',
        },
      });
      return;
    }

    next();
  };
}
