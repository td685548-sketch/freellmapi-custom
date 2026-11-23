import type { NextFunction, Request, Response } from 'express';

// Global concurrency cap for /v1 inference requests.
//
// The per-minute limiter (middleware/rateLimit.ts) counts REQUESTS, and the
// per-key concurrency cap (services/ratelimit.ts, opt-in via
// MAX_CONCURRENT_REQUESTS_PER_KEY) counts in-flight requests PER CREDENTIAL —
// but a slow stream counts as ONE request against both, so one key can hold
// ~1200 slow streams (120/min x a 600 s stream) with no ceiling anywhere.
// This middleware caps how many /v1 requests this process may have in flight
// at once, regardless of key, and answers 429 + Retry-After when full.
//
// Scope: mounted on /v1 in app.ts, after the RPM limiter and before the
// inference routers, so it covers chat/completions, completions, embeddings,
// rerank, search, decisions, /v1/messages, /v1/responses and /v1/moderations.
// Safe methods (GET/HEAD/OPTIONS) never take a slot: model discovery
// (GET /v1/models) and other cheap reads must keep working while inference
// is saturated. /v1beta, /thruline/v1, /mcp and /api are NOT covered —
// separate surfaces with their own traffic shapes; widening the mount is a
// one-line change if an operator wants it.
//
// Default: OFF (unset/0/invalid MAX_CONCURRENT_REQUESTS = no cap). This
// gateway's default install is a single user on a small box, and a global
// cap is an unmeasured magic number there — the same reason the per-key cap
// is opt-in ("a wrong default is worse than none", services/ratelimit.ts).
// Operators who expose the gateway set MAX_CONCURRENT_REQUESTS to the number
// of simultaneous slow streams their box can actually run.
//
// Counting: one module-level counter, shared by every limiter instance (like
// the shared proxyWindows store in middleware/rateLimit.ts) — a mount is
// one instance, but tests and a second mount must see the same number. A
// slot is released on BOTH res 'finish' (normal completion) and res 'close'
// (client abort, stream error — and also after a normal finish, so the
// release must be idempotent): 'finish' alone would leak the slot on abort
// and permanently shrink capacity, which is the failure this middleware
// exists to prevent in the other direction.
//
// 429 shape: the same OpenAI envelope the RPM limiter returns
// (rate_limit_error), with a Retry-After header. There is no known retry
// time — a slot frees when any in-flight stream ends — so Retry-After is a
// fixed 5 s: short enough to retry promptly, long enough to avoid a
// thundering herd. The body blames server capacity, never the caller's key.
// No X-RateLimit-* headers: the RPM limiter already sets those with per-minute
// semantics on the same responses, and overwriting them with concurrency
// numbers would lie about the RPM budget.

/** Fixed Retry-After (seconds) on a at-capacity 429. Exported so tests can
 *  assert the exact value instead of hard-coding a second copy of it. */
export const CONCURRENCY_RETRY_AFTER_SECONDS = 5;

/** In-flight /v1 requests right now. Test/diagnostics seam. */
let inFlight = 0;

export function inFlightRequests(): number {
  return inFlight;
}

/** Test hook: drop the in-flight count. The counter is process-wide and
 *  shared across limiter instances, so tests must reset it between cases
 *  instead of relying on a fresh instance. */
export function resetGlobalConcurrencyState(): void {
  inFlight = 0;
}

export function createGlobalConcurrencyLimiter(limit?: number | null) {
  const parsed = limit == null ? null : Math.floor(limit);
  const cap = parsed !== null && parsed > 0 ? parsed : null;

  return function globalConcurrencyLimit(req: Request, res: Response, next: NextFunction): void {
    // Cheap reads never hold a slot; every inference endpoint is a POST.
    if (cap === null || req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
      next();
      return;
    }

    if (inFlight >= cap) {
      res.setHeader('Retry-After', String(CONCURRENCY_RETRY_AFTER_SECONDS));
      res.status(429).json({
        error: {
          message: `Server is at capacity: too many concurrent inference requests (limit ${cap}). Retry in ${CONCURRENCY_RETRY_AFTER_SECONDS}s.`,
          type: 'rate_limit_error',
        },
      });
      return;
    }

    inFlight += 1;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      inFlight = Math.max(0, inFlight - 1);
    };
    res.on('finish', release);
    res.on('close', release);
    next();
  };
}
