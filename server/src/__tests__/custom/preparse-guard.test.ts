import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { getDb, getUnifiedApiKey, initDb } from '../../db/index.js';
import { createSession, createUser } from '../../services/auth.js';
import { mintUrlToken } from '../../services/url-tokens.js';
import { mintUserApiKey } from '../../services/user-keys.js';
import { clearStatusCache, setStatusCacheTestOverride } from '../../custom/status-cache.js';

// Large request bodies are refused BEFORE they are parsed unless the caller holds
// a credential, and the public liveness probes answer from a short-lived copy.

describe('pre-parse guard and public probes', () => {
  let server: Server;
  let port: number;
  let sessionToken: string;
  const big = JSON.stringify({ pad: 'x'.repeat(600 * 1024) });

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    setStatusCacheTestOverride(true);
    initDb(':memory:');
    sessionToken = createSession(createUser('guard@example.com', 'Password123!').userId);
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => { server?.close(); setStatusCacheTestOverride(null); });
  beforeEach(() => clearStatusCache());

  // Raw http: the guard answers before the upload finishes, so a write error after
  // the response is expected and must not fail the test.
  function send(path: string, opts: { body?: string; headers?: Record<string, string>; chunked?: boolean; method?: string } = {}) {
    return new Promise<{ status: number; body: any }>((resolve, reject) => {
      // A remote caller arrives through a proxy, so it carries a forwarded address; a bare
      // loopback connection is the operator's own machine and is deliberately not guarded.
      const headers: Record<string, string | number> = { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9', ...opts.headers };
      if (opts.body !== undefined && !opts.chunked) headers['content-length'] = Buffer.byteLength(opts.body);
      const req = http.request({ host: '127.0.0.1', port, path, method: opts.method ?? 'POST', headers }, res => {
        let data = '';
        let settled = false;
        const settle = () => {
          if (settled) return;
          settled = true;
          let body: any = null;
          try { body = JSON.parse(data); } catch { /* not json */ }
          resolve({ status: res.statusCode ?? 0, body });
        };
        res.on('data', c => { data += c; });
        res.on('end', settle);
        res.on('close', settle);
      });
      req.on('error', err => { if ((err as NodeJS.ErrnoException).code === 'ECONNRESET' || (err as NodeJS.ErrnoException).code === 'EPIPE') return; reject(err); });
      if (opts.body !== undefined) {
        if (opts.chunked) { for (let i = 0; i < opts.body.length; i += 64 * 1024) req.write(opts.body.slice(i, i + 64 * 1024)); } else req.write(opts.body);
      }
      req.end();
    });
  }

  it('refuses a large anonymous body on a public endpoint with 413', async () => {
    const res = await send('/api/auth/login', { body: big });
    expect(res.status).toBe(413);
    expect(res.body.error.message).toMatch(/unauthenticated endpoint/);
    expect(res.body.error.code).toBe('request_too_large');
  }, 15000);

  it('refuses a large body on a credentialed endpoint without a valid credential', async () => {
    const refused = async (path: string, headers: Record<string, string> = {}) => {
      const res = await send(path, { body: big, headers });
      expect(res.status, path).toBe(401);
      expect(res.body.error.message, path).toMatch(/body this large/); // from the guard, not the route
    };
    await refused('/v1/chat/completions');
    await refused('/v1/chat/completions', { authorization: 'Bearer nope' });
    await refused('/v1/chat/completions', { 'x-api-key': 'sk-flm-doesnotexist' });
    await refused('/api/conversations', { authorization: 'Bearer bogus-session' });
    await refused('/v1/t/bogustoken/chat/completions');
    await refused('/mcp');
    await refused('/x/v1/chat/completions');
  }, 30000);

  it('refuses a large chunked body (no Content-Length) the same way', async () => {
    const a = await send('/v1/chat/completions', { body: big, chunked: true });
    expect(a.status).toBe(401);
    expect(a.body.error.message).toMatch(/body this large/);
    const b = await send('/api/auth/login', { body: big, chunked: true });
    expect(b.status).toBe(413);
    expect(b.body.error.message).toMatch(/unauthenticated endpoint/);
  }, 30000);

  it('lets credential holders through to the normal handlers', async () => {
    const asKey = await send('/v1/chat/completions', { body: big, headers: { authorization: `Bearer ${getUnifiedApiKey()}` } });
    expect([401, 413]).not.toContain(asKey.status); // the handler rejects the body shape, not the guard
    const asXApiKey = await send('/v1/chat/completions', { body: big, headers: { 'x-api-key': getUnifiedApiKey() } });
    expect([401, 413]).not.toContain(asXApiKey.status);
    const asSession = await send('/api/conversations', { body: big, headers: { authorization: `Bearer ${sessionToken}` } });
    expect([401, 413]).not.toContain(asSession.status);
    const { token } = mintUrlToken('guard-test');
    const asUrlToken = await send(`/v1/t/${token}/chat/completions`, { body: big });
    expect(asUrlToken.body?.error?.message ?? '').not.toMatch(/body this large/);
    const personal = mintUserApiKey(createUser('admin-preparse@example.com', 'Password123!').userId);
    const asPersonalKey = await send('/x/v1/chat/completions', { body: big, headers: { authorization: `Bearer ${personal.key}` } });
    expect(asPersonalKey.body?.error?.message ?? '').not.toMatch(/body this large/);
  });

  it('does not guard a direct loopback connection (the operator\'s own machine)', async () => {
    const res = await send('/api/auth/login', { body: big, headers: { 'x-forwarded-for': '' } });
    expect(res.body?.error?.message ?? '').not.toMatch(/unauthenticated endpoint/);
  });

  it('leaves small bodies and GETs alone', async () => {
    const small = await send('/api/auth/login', { body: JSON.stringify({ email: 'a@b.co', password: 'wrongwrong' }) });
    expect(small.status).toBe(401); // bad credentials, not a size refusal
    expect((await send('/api/ping', { method: 'GET' })).status).toBe(200);
  });

  it('answers /livez and /readyz from a copy, so callers cannot drive database load', async () => {
    const db = getDb();
    let probes = 0;
    const prepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      const stmt = prepare(sql);
      if (/^\s*SELECT 1\s*$/.test(sql)) return { ...stmt, get: (...a: unknown[]) => { probes++; return stmt.get(...a); } } as any;
      return stmt;
    }) as typeof db.prepare;
    try {
      for (let i = 0; i < 25; i++) expect((await send('/livez', { method: 'GET' })).status).toBe(200);
      expect(probes).toBe(1);
      clearStatusCache();
      await send('/livez', { method: 'GET' });
      expect(probes).toBe(2);
    } finally { db.prepare = prepare; }
  });
});
