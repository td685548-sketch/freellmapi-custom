import http from 'node:http';
import type { Server } from 'node:http';
import zlib from 'node:zlib';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import type { Scheduler } from '../../lib/scheduler.js';
import {
  createResourceAwareScheduler,
  isApiCompressionEnabled,
  isProbeOnlyRequest,
  isResourceSaverEnabled,
  isServerIdle,
  recordRealTraffic,
  resetResourceSaverStateForTests,
} from '../../custom/render-resource-saver.js';
import { resetFlagsCacheForTests, setFlags } from '../../custom/ai-platform/flags.js';
import {
  enqueueReindexJob,
  getScopeIndexSnapshot,
  setEmbeddingsRunnerForTests,
  startIndexWorker,
  stopIndexWorker,
} from '../../custom/ai-platform/retrieval/indexer.js';
import { upsertSupportWebhookSubscription } from '../../custom/x-gateway/support-crm-webhooks.js';
import {
  drainSupportEventOutbox,
  enqueueSupportPartnerEvent,
  getSupportEventWorkerHealth,
  listSupportEventOutbox,
  startSupportEventWorker,
  stopSupportEventWorker,
} from '../../custom/x-gateway/support-event-outbox.js';
import { createSupportTenant } from '../../custom/x-gateway/support-store.js';
import { mintDashboardToken, dashboardSessionHeaders } from '../helpers/auth.js';

function rawHttpGet(
  port: number,
  pathname: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method: 'GET', headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk as Buffer));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(predicate()).toBe(true);
}

function makeManualScheduler() {
  const afterJobs: Array<{ ms: number; fn: () => void | Promise<void>; cancelled: boolean }> = [];
  const everyJobs: Array<{ ms: number; name?: string; fn: () => void | Promise<void>; cancelled: boolean }> = [];

  const scheduler: Scheduler = {
    after(ms, fn) {
      const entry = { ms, fn, cancelled: false };
      afterJobs.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    every(ms, fn, opts) {
      const entry = { ms, name: opts?.name, fn, cancelled: false };
      everyJobs.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
  };

  return { scheduler, afterJobs, everyJobs };
}

describe('render resource saver', () => {
  let dashboardToken: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    dashboardToken = mintDashboardToken('saver-test@example.com');
  });

  afterEach(() => {
    stopSupportEventWorker();
    stopIndexWorker();
    setEmbeddingsRunnerForTests(null);
    resetFlagsCacheForTests();
    resetResourceSaverStateForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  afterAll(() => {
    stopSupportEventWorker();
    stopIndexWorker();
  });

  it('detects Render and production Turso environments while respecting overrides', () => {
    expect(isResourceSaverEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isResourceSaverEnabled({ RENDER: 'true' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isResourceSaverEnabled({ RENDER_SERVICE_ID: 'srv-123' } as NodeJS.ProcessEnv)).toBe(true);
    expect(
      isResourceSaverEnabled({
        NODE_ENV: 'production',
        FREEAPI_DB_DRIVER: 'turso',
      } as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(
      isResourceSaverEnabled({
        NODE_ENV: 'production',
        FREEAPI_DB_DRIVER: 'sqlite',
      } as NodeJS.ProcessEnv),
    ).toBe(false);
    expect(
      isResourceSaverEnabled({
        RENDER: 'true',
        FREEAPI_RESOURCE_SAVER: '0',
      } as NodeJS.ProcessEnv),
    ).toBe(false);
    expect(
      isResourceSaverEnabled({
        FREEAPI_RESOURCE_SAVER: '1',
      } as NodeJS.ProcessEnv),
    ).toBe(true);

    // Local Production SQLite enables /api/* JSON compression automatically while keeping resource saver off
    expect(
      isApiCompressionEnabled({
        NODE_ENV: 'production',
        FREEAPI_DB_DRIVER: 'sqlite',
      } as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(
      isApiCompressionEnabled({
        NODE_ENV: 'production',
        FREEAPI_API_COMPRESSION: '0',
      } as NodeJS.ProcessEnv),
    ).toBe(false);
    expect(isApiCompressionEnabled({ NODE_ENV: 'test' } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('identifies probe-only health requests cleanly', () => {
    expect(isProbeOnlyRequest('GET', '/api/ping')).toBe(true);
    expect(isProbeOnlyRequest('HEAD', '/api/ping/')).toBe(true);
    expect(isProbeOnlyRequest('GET', '/livez')).toBe(true);
    expect(isProbeOnlyRequest('GET', '/readyz')).toBe(true);
    expect(isProbeOnlyRequest('POST', '/api/ping')).toBe(false);
    expect(isProbeOnlyRequest('GET', '/api/keys')).toBe(false);
    expect(isProbeOnlyRequest('POST', '/v1/chat/completions')).toBe(false);
  });

  it('defers long after() passes while idle, wakes on real traffic, and caps max idle delay', async () => {
    vi.stubEnv('RENDER', 'true');
    vi.stubEnv('FREEAPI_IDLE_WINDOW_MS', '60000');
    vi.stubEnv('FREEAPI_IDLE_HEALTH_INTERVAL_MS', '3600000');

    let clockMs = 1_000_000;
    resetResourceSaverStateForTests(clockMs);

    const base = makeManualScheduler();
    const aware = createResourceAwareScheduler(base.scheduler, () => clockMs);

    const ranAt: number[] = [];
    aware.after(900_000, () => {
      ranAt.push(clockMs);
    });
    expect(base.afterJobs).toHaveLength(1);

    // Advance past health interval, still within active window? No — >60s with no real traffic -> idle.
    clockMs += 900_000;
    expect(isServerIdle(clockMs)).toBe(true);
    await base.afterJobs[0]!.fn();
    expect(ranAt).toHaveLength(0);
    // Fallback timer armed for the remaining idle ceiling (3_600_000 - 900_000 = 2_700_000 ms).
    expect(base.afterJobs).toHaveLength(2);
    expect(base.afterJobs[1]!.ms).toBe(2_700_000);

    // Real traffic wakes the deferred pass via setImmediate and cancels the fallback timer.
    recordRealTraffic(clockMs);
    await new Promise<void>((resolve) => setImmediate(() => resolve()));
    expect(ranAt).toEqual([clockMs]);
    expect(base.afterJobs[1]!.cancelled).toBe(true);

    // Firing the fallback ceiling when remaining idle still executes once.
    const ranIdle: number[] = [];
    aware.after(900_000, () => {
      ranIdle.push(clockMs);
    });
    clockMs += 900_000;
    await base.afterJobs[2]!.fn();
    expect(ranIdle).toHaveLength(0);
    expect(base.afterJobs).toHaveLength(4);
    clockMs += 2_700_000;
    await base.afterJobs[3]!.fn();
    expect(ranIdle).toEqual([clockMs]);
  });

  it('throttles cooldown-probe every() ticks while idle and wakes on traffic', async () => {
    vi.stubEnv('RENDER', 'true');
    vi.stubEnv('FREEAPI_IDLE_WINDOW_MS', '60000');

    let clockMs = 2_000_000;
    resetResourceSaverStateForTests(clockMs);

    const base = makeManualScheduler();
    const aware = createResourceAwareScheduler(base.scheduler, () => clockMs);

    let runs = 0;
    const cancel = aware.every(60_000, () => {
      runs++;
    }, { name: 'cooldown-probe' });
    expect(base.everyJobs).toHaveLength(1);

    // Move into idle state.
    clockMs += 120_000;
    for (let i = 0; i < 9; i++) {
      await base.everyJobs[0]!.fn();
    }
    expect(runs).toBe(0);

    // 10th idle tick runs.
    await base.everyJobs[0]!.fn();
    expect(runs).toBe(1);

    // Another idle tick is skipped and queues a wake callback; real traffic triggers it.
    await base.everyJobs[0]!.fn();
    expect(runs).toBe(1);
    recordRealTraffic(clockMs);
    await new Promise<void>((resolve) => setImmediate(() => resolve()));
    expect(runs).toBe(2);

    cancel();
    expect(base.everyJobs[0]!.cancelled).toBe(true);
  });

  it('gzips large /api JSON responses on Render without compressing /api/ping or /v1/*', async () => {
    vi.stubEnv('RENDER', 'true');
    resetResourceSaverStateForTests(Date.now() - 60 * 60 * 1000);

    const app = createApp();
    const server: Server = app.listen(0, '127.0.0.1');
    if (!server.listening) {
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    }
    const port = (server.address() as { port: number }).port;

    try {
      // Probe-only /api/ping must remain uncompressed and preserve idle state.
      const pingRes = await rawHttpGet(port, '/api/ping', { 'Accept-Encoding': 'gzip' });
      expect(pingRes.status).toBe(200);
      expect(pingRes.headers['content-encoding']).toBeUndefined();
      expect(isServerIdle()).toBe(true);

      // Large authenticated /api/models GET response must be gzipped when RENDER=true.
      const modelsRes = await rawHttpGet(port, '/api/models', {
        ...dashboardSessionHeaders(dashboardToken),
        'Accept-Encoding': 'gzip',
      });
      expect(modelsRes.status).toBe(200);
      expect(modelsRes.headers['content-encoding']).toBe('gzip');
      const inflated = zlib.gunzipSync(modelsRes.body).toString('utf8');
      expect(inflated.length).toBeGreaterThan(2048);
      expect(() => JSON.parse(inflated)).not.toThrow();
      expect(isServerIdle()).toBe(false);

      // /v1/* routes must stay uncompressed (regression guard).
      const openApiRes = await rawHttpGet(port, '/v1/openapi.json', { 'Accept-Encoding': 'gzip' });
      expect(openApiRes.status).toBe(200);
      expect(openApiRes.body.length).toBeGreaterThan(2048);
      expect(openApiRes.headers['content-encoding']).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('avoids empty outbox UPDATE churn while keeping worker healthy and delivering enqueued events', async () => {
    const db = getDb();
    const stop = startSupportEventWorker();

    await waitFor(() => getSupportEventWorkerHealth().healthy);
    expect(getSupportEventWorkerHealth()).toEqual({ running: true, healthy: true });

    const prepareSpy = vi.spyOn(db, 'prepare');
    await drainSupportEventOutbox();
    const sqlStatements = prepareSpy.mock.calls.map(([sql]) => String(sql));
    expect(sqlStatements.some((sql) => /\bUPDATE\s+x_support_partner_deliveries\b/i.test(sql))).toBe(false);
    expect(sqlStatements.some((sql) => /\bJOIN\s+x_support_partner_events\b/i.test(sql))).toBe(false);
    prepareSpy.mockRestore();

    const { tenant } = createSupportTenant({ name: 'Resource Saver Outbox Tenant' });
    upsertSupportWebhookSubscription(String(tenant.id), {
      name: 'Test Delivery Hook',
      targetUrl: 'https://93.184.216.34/webhook',
      events: ['ticket.created'],
      enabled: true,
    });

    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    enqueueSupportPartnerEvent({
      tenantId: tenant.id,
      event: 'ticket.created',
      payload: { ticketId: 't_1' },
      dedupKey: `dedup-${Date.now()}`,
    });

    await waitFor(() => listSupportEventOutbox(tenant.id)[0]?.status === 'delivered');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    stop();
  });

  it('skips empty retrieval indexer polls when idle and wakes immediately when a job is enqueued', async () => {
    stopIndexWorker();
    setFlags({ retrieval: true });

    const db = getDb();
    const prepareSpy = vi.spyOn(db, 'prepare');
    startIndexWorker(30);

    await new Promise((resolve) => setTimeout(resolve, 220));

    const sqlCalls = prepareSpy.mock.calls.map(([sql]) => String(sql));
    const summaryPollCount = sqlCalls.filter((sql) =>
      /SELECT COUNT\(\*\) AS cnt.*FROM custom_ai_index_jobs/is.test(sql),
    ).length;
    const totalIndexReads = sqlCalls.filter((sql) => /FROM\s+custom_ai_index_jobs\b/i.test(sql)).length;
    expect(summaryPollCount).toBe(1);
    expect(totalIndexReads).toBeLessThanOrEqual(3);
    prepareSpy.mockRestore();

    setEmbeddingsRunnerForTests(async (_model, inputs) => ({
      model: 'text-embedding-3-small',
      vectors: inputs.map(() => [0.1, 0.2]),
      usage: { promptTokens: 1, totalTokens: 1 },
    }));

    enqueueReindexJob({ kind: 'agent', id: 'saver-agent' }, 'reindex');
    await waitFor(
      () => getScopeIndexSnapshot({ kind: 'agent', id: 'saver-agent' }).recentJobs[0]?.status === 'succeeded',
    );
  });
});
