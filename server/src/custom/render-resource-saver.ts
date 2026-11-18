import compression from 'compression';
import type { RequestHandler } from 'express';
import { tursoEnabled } from '../db/turso.js';
import type { Scheduler } from '../lib/scheduler.js';

export const DEFAULT_IDLE_WINDOW_MS = 30 * 60 * 1000;
export const DEFAULT_IDLE_HEALTH_MAX_INTERVAL_MS = 4 * 60 * 60 * 1000;
export const DEFAULT_IDLE_COOLDOWN_SKIP_FACTOR = 10;

const MIN_IDLE_WINDOW_MS = 60 * 1000;
const MIN_IDLE_HEALTH_MAX_INTERVAL_MS = 5 * 60 * 1000;

const PROBE_ONLY_PATHS = new Set(['/api/ping', '/ping', '/livez', '/readyz']);
const STREAMING_API_PATH_RE = /^\/(?:translator|thruline\/usage\/stream)(?:\/|$)/;

let lastRealTrafficAt = Date.now();
const deferredWakeCallbacks = new Set<() => void>();
let wakeScheduled = false;

function parseBoundedPositiveInt(
  raw: string | undefined,
  fallback: number,
  minValue: number,
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(minValue, Math.floor(parsed));
}

export function getIdleWindowMs(env: NodeJS.ProcessEnv = process.env): number {
  return parseBoundedPositiveInt(env.FREEAPI_IDLE_WINDOW_MS, DEFAULT_IDLE_WINDOW_MS, MIN_IDLE_WINDOW_MS);
}

export function getIdleHealthMaxIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  return parseBoundedPositiveInt(
    env.FREEAPI_IDLE_HEALTH_INTERVAL_MS,
    DEFAULT_IDLE_HEALTH_MAX_INTERVAL_MS,
    MIN_IDLE_HEALTH_MAX_INTERVAL_MS,
  );
}

/**
 * Enables automatic resource-saving adaptations on Render or hosted production
 * Turso deployments while keeping local dev/desktop/test runs unchanged unless
 * explicitly toggled via FREEAPI_RESOURCE_SAVER=1|0.
 */
export function isResourceSaverEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const override = env.FREEAPI_RESOURCE_SAVER?.trim();
  if (override === '1') return true;
  if (override === '0') return false;
  return (
    env.RENDER === 'true' ||
    Boolean(env.RENDER_SERVICE_ID) ||
    (env.NODE_ENV === 'production' && tursoEnabled(env))
  );
}

export function isProbeOnlyRequest(method: string, path: string): boolean {
  const normalizedMethod = method.toUpperCase();
  if (normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD') return false;
  const normalizedPath = path.length > 1 ? path.replace(/\/+$/, '') : path;
  return PROBE_ONLY_PATHS.has(normalizedPath);
}

/**
 * Marks real caller activity and asynchronously wakes any deferred background
 * maintenance passes without adding latency to the HTTP request.
 */
export function recordRealTraffic(now = Date.now()): void {
  lastRealTrafficAt = now;
  if (deferredWakeCallbacks.size > 0 && !wakeScheduled) {
    wakeScheduled = true;
    const timer = setImmediate(() => {
      wakeScheduled = false;
      const callbacks = [...deferredWakeCallbacks];
      deferredWakeCallbacks.clear();
      for (const callback of callbacks) {
        try {
          callback();
        } catch {
          // Best-effort wake; scheduled tasks handle and log their own errors.
        }
      }
    });
    timer.unref?.();
  }
}

export function isServerIdle(
  now = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return now - lastRealTrafficAt >= getIdleWindowMs(env);
}

export function createActivityTrackerMiddleware(): RequestHandler {
  return (req, _res, next) => {
    const rawPath = (req.originalUrl || req.path || '').split('?')[0] || req.path || '';
    if (!isProbeOnlyRequest(req.method, rawPath)) {
      recordRealTraffic();
    }
    next();
  };
}

const apiJsonCompression = compression({
  threshold: 2048,
  level: 6,
  filter(req, res) {
    const accept = req.headers.accept;
    if (typeof accept === 'string' && accept.includes('text/event-stream')) {
      return false;
    }
    const contentType = String(res.getHeader('Content-Type') ?? '');
    if (contentType.includes('text/event-stream')) {
      return false;
    }
    return compression.filter(req, res);
  },
});

/**
 * Compresses large `/api/*` GET JSON responses (>2 KiB) when resource saver is
 * active, while bypassing `/api/ping` and SSE endpoints so streaming responses
 * are never buffered.
 */
export function createApiJsonCompressionMiddleware(): RequestHandler {
  return (req, res, next) => {
    if (
      !isResourceSaverEnabled() ||
      req.method !== 'GET' ||
      req.path === '/ping' ||
      STREAMING_API_PATH_RE.test(req.path)
    ) {
      next();
      return;
    }
    apiJsonCompression(req, res, next);
  };
}

/**
 * Wraps the process scheduler so long-interval health passes and idle cooldown
 * scans back off automatically when only Render health pings are hitting the server,
 * and wake promptly when real traffic returns.
 */
export function createResourceAwareScheduler(
  base: Scheduler,
  clock: () => number = Date.now,
): Scheduler {
  let lastHealthRunAt = clock();

  return {
    after(ms: number, fn: () => void | Promise<void>): () => void {
      if (!isResourceSaverEnabled() || ms < 60_000) {
        return base.after(ms, fn);
      }

      let cancelled = false;
      let executed = false;
      let activeCancel: (() => void) | null = null;
      let wakeFn: (() => void) | null = null;

      const clearDeferred = () => {
        if (wakeFn) {
          deferredWakeCallbacks.delete(wakeFn);
          wakeFn = null;
        }
      };

      activeCancel = base.after(ms, async () => {
        if (cancelled || executed) return;
        const now = clock();
        const maxIdleIntervalMs = getIdleHealthMaxIntervalMs();
        if (!isServerIdle(now) || now - lastHealthRunAt >= maxIdleIntervalMs) {
          executed = true;
          activeCancel = null;
          lastHealthRunAt = now;
          await fn();
          return;
        }

        const remainingUntilMax = Math.max(1_000, maxIdleIntervalMs - (now - lastHealthRunAt));
        const runDeferred = () => {
          if (cancelled || executed) return;
          executed = true;
          clearDeferred();
          activeCancel?.();
          activeCancel = null;
          lastHealthRunAt = clock();
          void fn();
        };

        wakeFn = runDeferred;
        deferredWakeCallbacks.add(runDeferred);
        activeCancel = base.after(remainingUntilMax, runDeferred);
      });

      return () => {
        cancelled = true;
        clearDeferred();
        activeCancel?.();
        activeCancel = null;
      };
    },

    every(ms: number, fn: () => void | Promise<void>, opts?: { name?: string }): () => void {
      if (opts?.name !== 'cooldown-probe') {
        return base.every(ms, fn, opts);
      }

      let cancelled = false;
      let skippedTicks = 0;
      let wakeFn: (() => void) | null = null;

      const clearWake = () => {
        if (wakeFn) {
          deferredWakeCallbacks.delete(wakeFn);
          wakeFn = null;
        }
      };

      const cancelBase = base.every(ms, async () => {
        if (cancelled) return;
        if (
          isResourceSaverEnabled() &&
          isServerIdle(clock()) &&
          skippedTicks < DEFAULT_IDLE_COOLDOWN_SKIP_FACTOR - 1
        ) {
          skippedTicks++;
          if (!wakeFn) {
            wakeFn = () => {
              wakeFn = null;
              if (cancelled) return;
              skippedTicks = 0;
              void fn();
            };
            deferredWakeCallbacks.add(wakeFn);
          }
          return;
        }
        skippedTicks = 0;
        clearWake();
        await fn();
      }, opts);

      return () => {
        cancelled = true;
        clearWake();
        cancelBase();
      };
    },
  };
}

/** Test seam: resets tracked traffic timestamp and clears pending wake callbacks. */
export function resetResourceSaverStateForTests(initialTrafficAt = Date.now()): void {
  lastRealTrafficAt = initialTrafficAt;
  deferredWakeCallbacks.clear();
  wakeScheduled = false;
}
