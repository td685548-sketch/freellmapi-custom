import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb } from '../../db/index.js';
import { resetProxyRateLimitState } from '../../middleware/rateLimit.js';

async function request(app: Express, headers: Record<string, string> = {}) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}/v1/chat/completions`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  });

  const text = await res.text();
  server.close();

  let json: any = null;
  try { json = JSON.parse(text); } catch {}

  return { status: res.status, body: json, headers: res.headers };
}

describe('Proxy per-IP rate limiting (#35 item #6)', () => {
  const originalRpm = process.env.PROXY_RATE_LIMIT_RPM;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  // The proxy limiter store is process-wide and shared across surfaces and
  // limiter instances: reset it so each test starts from a clean window.
  beforeEach(() => {
    resetProxyRateLimitState();
  });

  afterAll(() => {
    if (originalRpm === undefined) delete process.env.PROXY_RATE_LIMIT_RPM;
    else process.env.PROXY_RATE_LIMIT_RPM = originalRpm;
  });

  it('returns 429 once the per-minute cap is exceeded', async () => {
    // Limiter reads the env at createApp() time, so set it before building.
    process.env.PROXY_RATE_LIMIT_RPM = '3';
    const app = createApp();

    // First 3 requests pass the limiter (they 401 on auth, but the limiter is
    // upstream of auth, so each one still counts against the window).
    for (let i = 0; i < 3; i++) {
      const res = await request(app);
      expect(res.status).not.toBe(429);
    }

    // The 4th trips the limit.
    const limited = await request(app);
    expect(limited.status).toBe(429);
    expect(limited.body.error.type).toBe('rate_limit_error');
    expect(limited.headers.get('retry-after')).toBeTruthy();
    expect(limited.headers.get('x-ratelimit-limit')).toBe('3');
  });

  it('does not rate-limit when PROXY_RATE_LIMIT_RPM=0', async () => {
    process.env.PROXY_RATE_LIMIT_RPM = '0';
    const app = createApp();

    for (let i = 0; i < 5; i++) {
      const res = await request(app);
      expect(res.status).not.toBe(429);
    }
  });

  it('shares one budget per API-key hash across /v1, /v1beta and /mcp', async () => {
    // Previously every mount built its own Map, so the same key got 120/min
    // on EACH surface (~600-720/min in total). One shared limiter must cap
    // the key once across all of them.
    process.env.PROXY_RATE_LIMIT_RPM = '3';
    const app = createApp();
    const token = 'Bearer shared-cross-surface-key';

    async function hit(path: string, method = 'GET', auth?: string) {
      const server = app.listen(0, '127.0.0.1');
      if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
      const addr = server.address() as any;
      const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
        ...(method === 'POST' ? { body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) } : {}),
      });
      const text = await res.text();
      server.close();
      let json: any = null;
      try { json = JSON.parse(text); } catch {}
      return { status: res.status, body: json };
    }

    // Three /v1 calls spend the key's whole budget (they 401 on auth, but
    // the limiter is upstream of auth, so each one still counts).
    for (let i = 0; i < 3; i++) {
      const res = await hit('/v1/chat/completions', 'POST', token);
      expect(res.status).not.toBe(429);
    }

    // The same key on /v1beta and /mcp is already out of budget.
    const v1beta = await hit('/v1beta/models', 'GET', token);
    expect(v1beta.status).toBe(429);
    expect(v1beta.body.error.type).toBe('rate_limit_error');
    const mcp = await hit('/mcp', 'GET', token);
    expect(mcp.status).toBe(429);

    // A different key still has its own full budget on /v1beta.
    const other = await hit('/v1beta/models', 'GET', 'Bearer a-different-key');
    expect(other.status).not.toBe(429);
  });
});
