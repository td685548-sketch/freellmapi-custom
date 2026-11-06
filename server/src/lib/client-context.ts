import { AsyncLocalStorage } from 'async_hooks';
import type { NextFunction, Request, Response } from 'express';
import { classifyClientAgent, type ClientAgent } from './client-classifier.js';
import type { PresetStrategy } from '../services/scoring.js';

export interface ClientContext {
  ip: string | null;
  userAgent: string | null;
  agent: ClientAgent | null;
  /** The preset a decision model picked for this request (#1354), read by the
   *  router while the 'decision' strategy is active. Unset = Balanced. */
  routingStrategy?: PresetStrategy;
  /** The account behind a personal `sk-flm-…` key, set by the per-user gate;
   *  unset for the unified key, client profiles and dashboard sessions. */
  userId?: number;
  /** Tokens of the successful rows logged in this request, so the per-user gate
   *  can book them with the request count it already writes (no extra write). */
  userTokens?: number;
  /** The client profile (`sk-cp-…` key) behind this request, set by the profile gate. */
  profileId?: number;
  /** Lowercase model ids this request may be routed to (a client profile's allowlist); unset = any. */
  allowedModels?: ReadonlySet<string>;
}

// Request-scoped caller identity, readable from anywhere below the middleware
// without threading parameters through every logRequest() call site (the chat
// proxy, responses, anthropic, fusion, embeddings and media paths all log).
const storage = new AsyncLocalStorage<ClientContext>();

// Resolve the client IP. With Express's `trust proxy` disabled (the default),
// this is the socket peer address and a spoofed X-Forwarded-For from a LAN
// client is ignored. When TRUST_PROXY (#1024) opts into trusting a reverse
// proxy, `req.ip` walks the configured trusted-proxy chain and returns the
// first untrusted address — instead of trusting the leftmost caller-supplied
// X-Forwarded-For value, which would let any direct caller spoof it.
function resolveClientIp(req: Request): string | null {
  const raw = req.ip ?? req.socket.remoteAddress ?? null;
  // Normalize IPv4-mapped IPv6 ("::ffff:192.168.0.5" -> "192.168.0.5").
  return raw?.replace(/^::ffff:/i, '') ?? null;
}

// Privacy opt-out: REQUEST_ANALYTICS_LOG_CLIENT=false stores nulls instead of
// the caller's IP/UA. Read per request (not at module load) so tests and
// embedders can toggle it without re-importing.
function clientLoggingEnabled(): boolean {
  return process.env.REQUEST_ANALYTICS_LOG_CLIENT !== 'false';
}

export function clientContextMiddleware(req: Request, _res: Response, next: NextFunction): void {
  if (!clientLoggingEnabled()) {
    storage.run({ ip: null, userAgent: null, agent: null }, next);
    return;
  }
  const ua = req.headers['user-agent'];
  storage.run({
    ip: resolveClientIp(req),
    userAgent: typeof ua === 'string' ? ua.slice(0, 256) : null,
    agent: classifyClientAgent(req),
  }, next);
}

export function getClientContext(): ClientContext {
  return storage.getStore() ?? { ip: null, userAgent: null, agent: null };
}

/** Record this request's decision-picked preset (#1354). A no-op outside a
 *  request scope (tests, background work), which then routes as Balanced. */
export function setRequestRoutingStrategy(strategy: PresetStrategy | undefined): void {
  const store = storage.getStore();
  if (store) store.routingStrategy = strategy;
}

/** Attribute this request to a personal-key account (per-user analytics). Returns
 *  the live context so the caller can read `userTokens` after the response. */
export function setRequestUser(userId: number): ClientContext | undefined {
  const store = storage.getStore();
  if (store) store.userId = userId;
  return store;
}

/** Add a logged success row's tokens to this request's per-user / per-profile tally. */
export function noteRequestTokens(tokens: number): void {
  const store = storage.getStore();
  if ((store?.userId !== undefined || store?.profileId !== undefined) && tokens > 0) store.userTokens = (store.userTokens ?? 0) + tokens;
}

/** Attribute this request to a client profile (per-profile analytics). */
export function setRequestProfile(profileId: number): ClientContext | undefined {
  const store = storage.getStore();
  if (store) store.profileId = profileId;
  return store;
}

/** Restrict this request's routing to these model ids (lowercase). */
export function setRequestAllowedModels(models: ReadonlySet<string>): void {
  const store = storage.getStore();
  if (store) store.allowedModels = models;
}
