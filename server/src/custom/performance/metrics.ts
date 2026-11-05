import { AsyncLocalStorage } from 'node:async_hooks';
import { createHistogram, monitorEventLoopDelay, performance } from 'node:perf_hooks';
import type { RecordableHistogram } from 'node:perf_hooks';
import type { RequestHandler } from 'express';

// Only these literal labels can reach reports. Never retain a caller's URL,
// query, SQL, bind arguments, headers, identity, response or exception.
export const MEASURED_ROUTES = new Set([
  '/api/ping', '/api/auth/status', '/api/profiles/active', '/api/models',
  '/api/fallback', '/api/fallback/routing', '/api/fallback/rate-limit-usage',
  '/api/fallback/token-usage', '/api/keys', '/api/keys/providers', '/api/health',
  '/api/analytics/summary', '/api/analytics/by-platform', '/api/analytics/by-client',
  '/api/analytics/timeline', '/api/analytics/by-model', '/api/analytics/by-key',
  '/api/analytics/errors', '/api/analytics/search', '/api/analytics/error-distribution',
  '/api/analytics/requests', '/api/cache/stats', '/api/logs',
]);

type Operation = 'prepare' | 'native_prepare' | 'execute';
interface Counters {
  prepare_calls: number; prepare_ms: number;
  native_prepare_calls: number; native_prepare_ms: number;
  db_calls: number; db_ms: number; db_errors: number;
}
interface Scope extends Counters { settled: boolean }
const scopes = new AsyncLocalStorage<Scope>();
const counters = (): Counters => ({
  prepare_calls: 0, prepare_ms: 0, native_prepare_calls: 0, native_prepare_ms: 0,
  db_calls: 0, db_ms: 0, db_errors: 0,
});

/** Measures synchronous work without catching, logging or replacing errors. */
export function measureDb<T>(operation: Operation, run: () => T): T {
  const scope = scopes.getStore();
  if (!scope || scope.settled) return run();
  const start = performance.now();
  try { return run(); }
  catch (error) { if (operation !== 'native_prepare') scope.db_errors++; throw error; }
  finally {
    const elapsed = performance.now() - start;
    if (operation === 'prepare') { scope.prepare_calls++; scope.prepare_ms += elapsed; }
    else if (operation === 'native_prepare') {
      scope.native_prepare_calls++; scope.native_prepare_ms += elapsed;
    } else { scope.db_calls++; scope.db_ms += elapsed; }
  }
}

const histogram = () => createHistogram({ lowest: 1, highest: 3_600_000_000, figures: 3 });
const record = (h: RecordableHistogram, ms: number) => h.record(Math.max(1, Math.min(3_600_000_000, Math.round(ms * 1000))));
const ms = (n: number) => Math.round(n * 1000) / 1000;
function distribution(h: RecordableHistogram) {
  return h.count ? { p50_ms: ms(h.percentile(50) / 1000), p95_ms: ms(h.percentile(95) / 1000), max_ms: ms(h.max / 1000) } : null;
}
function aggregate() {
  return { ...counters(), requests: 0, success: 0, redirects: 0, client_errors: 0,
    server_errors: 0, aborted: 0, duration: histogram(), database: histogram() };
}

export class PerformanceMetrics {
  private routes = new Map<string, ReturnType<typeof aggregate>>();
  private loop?: ReturnType<typeof monitorEventLoopDelay>;
  private timer?: ReturnType<typeof setInterval>;
  private since = performance.now();
  private utilization = performance.eventLoopUtilization();

  readonly middleware: RequestHandler = (req, res, next) => {
    if (req.method !== 'GET' || !MEASURED_ROUTES.has(req.path)) return next();
    const route = req.path; // validated fixed literal; no query string retained
    const scope: Scope = { ...counters(), settled: false };
    const start = performance.now();
    const settle = (completed: boolean) => {
      if (scope.settled) return;
      scope.settled = true;
      res.off('finish', finish);
      res.off('close', close);
      let totals = this.routes.get(route);
      if (!totals) { totals = aggregate(); this.routes.set(route, totals); }
      totals.requests++;
      if (!completed) totals.aborted++;
      else if (res.statusCode >= 500) totals.server_errors++;
      else if (res.statusCode >= 400) totals.client_errors++;
      else if (res.statusCode >= 300) totals.redirects++;
      else totals.success++;
      for (const key of Object.keys(counters()) as (keyof Counters)[]) totals[key] += scope[key];
      record(totals.duration, performance.now() - start);
      record(totals.database, scope.db_ms);
    };
    const finish = () => settle(true);
    const close = () => settle(res.writableFinished);
    res.once('finish', finish);
    res.once('close', close);
    scopes.run(scope, next);
  };

  snapshot(reset = false) {
    const now = performance.now();
    const current = performance.eventLoopUtilization();
    const utilization = performance.eventLoopUtilization(current, this.utilization);
    const report = {
      backend: process.env.FREEAPI_DB_DRIVER?.trim().toLowerCase() === 'turso' ? 'turso' : 'sqlite',
      native_prepare_measurement: 'turso_only',
      window_ms: ms(now - this.since), rss_mib: ms(process.memoryUsage().rss / 1024 ** 2),
      event_loop: this.loop && this.loop.count ? {
        p95_ms: ms(this.loop.percentile(95) / 1e6), max_ms: ms(this.loop.max / 1e6),
      } : null,
      event_loop_utilization: utilization.utilization,
      routes: Array.from(this.routes).filter(([, totals]) => totals.requests > 0).map(([route, totals]) => {
        const { duration, database, ...numeric } = totals;
        return { route, ...numeric, duration: distribution(duration), database: distribution(database) };
      }),
    };
    if (reset) {
      for (const totals of this.routes.values()) {
        Object.assign(totals, counters(), { requests: 0, success: 0, redirects: 0,
          client_errors: 0, server_errors: 0, aborted: 0 });
        totals.duration.reset(); totals.database.reset();
      }
      this.loop?.reset(); this.since = now; this.utilization = current;
    }
    return report;
  }

  start(emit?: (report: ReturnType<PerformanceMetrics['snapshot']>) => void) {
    if (this.loop) return;
    this.loop = monitorEventLoopDelay({ resolution: 20 });
    this.loop.enable();
    if (emit) {
      this.timer = setInterval(() => emit(this.snapshot(true)), 60_000);
      this.timer.unref();
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.loop?.disable(); this.loop = undefined;
  }
}

let processMetrics: PerformanceMetrics | undefined;
export function installPerformanceMetrics(): RequestHandler {
  if (process.env.CUSTOM_PERF_METRICS !== '1') return (_req, _res, next) => next();
  processMetrics ??= new PerformanceMetrics();
  processMetrics.start(report => console.log('[performance]', JSON.stringify(report)));
  return processMetrics.middleware;
}
export function stopPerformanceMetrics(): void {
  processMetrics?.stop(); processMetrics = undefined;
}
export function performanceSnapshot(reset = false) {
  return processMetrics?.snapshot(reset);
}
/** Internal benchmark mode: monitor without a periodic reset mid-workload. */
export function startManualPerformanceMetrics(): void {
  processMetrics ??= new PerformanceMetrics();
  processMetrics.start();
}

export function measureStartup<T>(phase: 'database_init' | 'cache_hydration', run: () => T): T {
  if (process.env.CUSTOM_PERF_METRICS !== '1') return run();
  const scope: Scope = { ...counters(), settled: false };
  const start = performance.now();
  let completed = false;
  try { return scopes.run(scope, () => { const value = run(); completed = true; return value; }); }
  finally {
    scope.settled = true;
    const { settled: _settled, ...numeric } = scope;
    console.log('[performance]', JSON.stringify({ phase, completed, duration_ms: ms(performance.now() - start), ...numeric }));
  }
}
