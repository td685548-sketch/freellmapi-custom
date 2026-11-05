/** Synthetic-only HTTP baseline. Never import env.js/index.ts or accept a DB URL. */
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const args = new Map(process.argv.slice(2).map(arg => {
  const match = /^--([a-z]+)=(.+)$/.exec(arg);
  if (!match || !['samples', 'keys', 'ledger', 'concurrency', 'output', 'overhead', 'routes'].includes(match[1])) {
    throw new Error('Expected --samples=N --keys=N --ledger=N --concurrency=1,5,10 --output=PATH or --overhead=N');
  }
  return [match[1], match[2]];
}));
function integer(value: string, min: number, max: number) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error('Invalid benchmark size');
  return n;
}
const samples = integer(args.get('samples') ?? '100', 1, 100_000);
const keyCount = integer(args.get('keys') ?? '60', 1, 300);
const ledgerCount = integer(args.get('ledger') ?? '1000', 1, 100_000);
const concurrency = (args.get('concurrency') ?? '1,5,10').split(',').map(n => integer(n, 1, 10));
const overhead = args.has('overhead') ? integer(args.get('overhead')!, 100, 100_000) : 0;

// Override before loading any application modules; keep production files and
// provider credentials completely out of this disposable fixture.
Object.assign(process.env, {
  NODE_ENV: 'test', FREEAPI_DB_DRIVER: 'sqlite', ENCRYPTION_KEY: 'a'.repeat(64),
  CUSTOM_PERF_METRICS: '1', CLOUDFLARE_NEURON_ANALYTICS: '0', ADMIN_RATE_LIMIT_RPM: '10000000',
  ALLOWED_HOSTS: 'localhost,127.0.0.1',
});
const localFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname !== '127.0.0.1') throw new Error('Benchmark refuses external HTTP requests');
  return localFetch(input, init);
};
const { createApp } = await import('../app.js');
const { initDb, getDb } = await import('../db/index.js');
const { createUser, createSession } = await import('../services/auth.js');
const { encrypt } = await import('../lib/crypto.js');
const { loadConfig } = await import('../lib/config.js');
const { performanceSnapshot, stopPerformanceMetrics, startManualPerformanceMetrics, measureStartup } = await import('../custom/performance/metrics.js');

const routes = [
  '/api/fallback', '/api/fallback/routing', '/api/fallback/rate-limit-usage',
  '/api/keys', '/api/health', '/api/analytics/summary',
  '/api/analytics/by-model', '/api/analytics/requests', '/api/logs',
];
const selectedRoutes = args.has('routes') ? args.get('routes')!.split(',') : routes;
if (selectedRoutes.some(route => !routes.includes(route))) throw new Error('Unknown benchmark route');

function fixture() {
  const start = performance.now();
  measureStartup('database_init', () => initDb(':memory:'));
  const db = getDb();
  const admin = createUser('benchmark-admin@example.invalid', 'synthetic-password', 'admin');
  const member = createUser('benchmark-member@example.invalid', 'synthetic-password', 'member');
  const tokens = { admin: createSession(admin.userId), member: createSession(member.userId) };
  const fake = encrypt('synthetic-provider-credential-never-used');
  db.transaction(() => {
    db.prepare('DELETE FROM api_keys').run();
    const key = db.prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag)
      VALUES ('groq', ?, ?, ?, ?)`);
    for (let i = 0; i < keyCount; i++) key.run(`synthetic-${i}`, fake.encrypted, fake.iv, fake.authTag);
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const request = db.prepare(`INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, created_at)
      VALUES ('groq', 'synthetic-model', 'success', 10, 20, 100, ?)`);
    for (let i = 0; i < ledgerCount; i++) request.run(timestamp);
    db.prepare(`INSERT INTO request_hourly (hour, total_requests, success_count, error_count, input_tokens, output_tokens)
      VALUES (?, ?, ?, 0, ?, ?)`)
      .run(timestamp.slice(0, 13) + ':00:00', ledgerCount, ledgerCount, ledgerCount * 10, ledgerCount * 20);
    const setting = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    for (const [name, value] of Object.entries({ total_requests: ledgerCount, total_input_tokens: ledgerCount * 10,
      total_output_tokens: ledgerCount * 20, first_request_at: timestamp })) setting.run(name, String(value));
  })();
  return { tokens, fixture_ms: performance.now() - start };
}

function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => Math.round(sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] * 1000) / 1000;
  return { p50_ms: at(0.5), p95_ms: at(0.95), max_ms: at(1) };
}

const workloads: unknown[] = [];
async function run(enabled: boolean, count: number, paths: string[], roles: ('admin' | 'member')[], levels: number[]) {
  process.env.CUSTOM_PERF_METRICS = enabled ? '1' : '0';
  if (enabled) startManualPerformanceMetrics();
  const { tokens, fixture_ms } = fixture();
  const config = loadConfig();
  const server = createApp(config).listen(0, '127.0.0.1');
  // Match index.ts: the benchmark should not introduce Node's default 5s
  // keep-alive races when synchronous DB work temporarily occupies the loop.
  server.keepAliveTimeout = 75_000;
  server.headersTimeout = 76_000;
  await new Promise<void>(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    for (const role of roles) for (const path of paths) for (const parallel of levels) {
      const hit = async () => {
        const started = performance.now();
        try {
          const response = await fetch(origin + path, {
            headers: { Authorization: `Bearer ${tokens[role]}` }, signal: AbortSignal.timeout(30_000),
          });
          await response.arrayBuffer(); // consume, never print payload or credentials
          return { duration: performance.now() - started, status: response.status, timeout: false };
        } catch (error) {
          return { duration: performance.now() - started, status: 0,
            timeout: error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError') };
        }
      };
      for (let i = 0; i < 5; i++) await hit();
      performanceSnapshot(true); // warm-up is never mixed with the workload
      const durations: number[] = [];
      const statuses: Record<number, number> = {};
      let next = 0, timeouts = 0, rssPeak = process.memoryUsage().rss;
      await Promise.all(Array.from({ length: parallel }, async () => {
        while (next++ < count) {
          const result = await hit();
          durations.push(result.duration); statuses[result.status] = (statuses[result.status] ?? 0) + 1;
          if (result.timeout) timeouts++;
          rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
        }
      }));
      const serverMetrics = performanceSnapshot(true);
      const serverSamples = serverMetrics?.routes.reduce((sum, row) => sum + row.requests, 0);
      const httpResponses = count - (statuses[0] ?? 0);
      // A connection failure can occur before the server receives a request.
      // Keep those failures rather than demanding one server sample per attempt.
      if (enabled && (serverSamples === undefined || serverSamples < httpResponses || serverSamples > count)) {
        throw new Error('Server/client sample counts differ; refusing a partial benchmark report');
      }
      const denied = role === 'member' && !['/api/fallback', '/api/fallback/routing'].includes(path);
      const expected = denied ? 403 : 200;
      workloads.push({ enabled, role, route: path, concurrency: parallel, samples: durations.length,
        statuses, expected_status: expected, failures: durations.length - (statuses[expected] ?? 0), timeouts,
        network_errors: (statuses[0] ?? 0) - timeouts, client_http_responses: httpResponses,
        server_samples: serverSamples ?? null,
        ...distribution(durations), rss_peak_mib: rssPeak / 1024 ** 2,
        server: serverMetrics ?? null, fixture_ms });
      console.log(JSON.stringify({ measured: path, role, enabled, concurrency: parallel, ...distribution(durations), statuses }));
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections();
    });
    stopPerformanceMetrics(); getDb().close?.();
  }
}

if (overhead) {
  // Alternate order across repetitions to expose warm-up/order bias.
  for (const enabled of [false, true, true, false]) await run(enabled, overhead, ['/api/logs'], ['admin'], [1]);
} else {
  for (let repetition = 0; repetition < 2; repetition++) await run(true, samples, selectedRoutes, ['admin', 'member'], concurrency);
}
function sourceMetadata() {
  try {
    return { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(),
      working_tree_dirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0 };
  } catch { return { commit: 'unavailable', working_tree_dirty: null }; }
}
const report = {
  phase: 'P01', generated_at: new Date().toISOString(), ...sourceMetadata(),
  node: process.version, platform: process.platform, backend: 'in_memory_sqlite', warm: true,
  keep_alive_timeout_ms: 75_000,
  fixture: { keys: keyCount, ledger: ledgerCount },
  limitations: ['Render cold start, remote DB RTT and native RPCs not measured',
    'No browser waterfall or time-to-data measurement', 'No provider calls; no live credentials or database',
    'native_prepare counters apply to Turso only; SQLite preparation is represented by prepare_calls',
    'fixture_ms includes migration, user creation and seeding; not a Render boot measurement'],
  workloads,
};
writeFileSync(args.get('output') ?? 'dashboard-baseline.json', JSON.stringify(report, null, 2) + '\n');
