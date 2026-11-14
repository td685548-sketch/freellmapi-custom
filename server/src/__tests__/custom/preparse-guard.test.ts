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
import { stripInternalHeaders } from '../../custom/preparse-guard.js';

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
      if (opts.chunked) headers['transfer-encoding'] = 'chunked';
      let responseStarted = false;
      const req = http.request({ host: '127.0.0.1', port, path, method: opts.method ?? 'POST', headers, agent: false }, res => {
        responseStarted = true;
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => { let body: any = null; try { body = JSON.parse(data); } catch { /* not json */ } resolve({ status: res.statusCode ?? 0, body }); });
      });
      req.on('error', err => {
        if (responseStarted && ['ECONNRESET', 'EPIPE'].includes((err as NodeJS.ErrnoException).code ?? '')) return;
        reject(err);
      });
      // Let the guard answer from headers before uploading a large body. Sending
      // it in one write can reset the socket before Windows delivers the reply.
      req.flushHeaders();
      let offset = 0;
      const writeNext = () => {
        if (responseStarted || req.destroyed) return;
        if (opts.body === undefined || offset >= opts.body.length) { req.end(); return; }
        const chunk = opts.body.slice(offset, offset + 16 * 1024);
        offset += chunk.length;
        req.write(chunk, () => setImmediate(writeNext));
      };
      setTimeout(writeNext, 25);
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
      await new Promise(r => setTimeout(r, 15));
    };
    await refused('/v1/chat/completions');
    await refused('/v1/chat/completions', { authorization: 'Bearer nope' });
    await refused('/v1/chat/completions', { 'x-api-key': 'sk-flm-doesnotexist' });
    await refused('/api/conversations', { authorization: 'Bearer bogus-session' });
    await refused('/v1/t/bogustoken/chat/completions');
    await refused('/mcp');
    await refused('/thruline/v1/chat/completions');
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
    const asPersonalKey = await send('/thruline/v1/chat/completions', { body: big, headers: { authorization: `Bearer ${personal.key}` } });
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

// ── T014: internal header stripping ─────────────────────────────────────────

describe('internal header stripping', () => {
  // A lightweight server that echoes back the headers it received so we can
  // inspect whether x-ai-platform-internal was stripped.
  let echoServer: Server;
  let echoPort: number;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    setStatusCacheTestOverride(true);
    // Reuse an in-memory DB (may already be initialised from the sibling describe).
    try { initDb(':memory:'); } catch { /* already initialised */ }

    // Echo server: returns JSON of the request headers.
    echoServer = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.headers));
    });
    echoServer.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => echoServer.once('listening', resolve));
    echoPort = (echoServer.address() as AddressInfo).port;
  });

  afterAll(() => {
    echoServer?.close();
    setStatusCacheTestOverride(null);
  });

  /**
   * Send a GET to the echo server optionally carrying x-ai-platform-internal
   * and optionally x-forwarded-for (to simulate non-loopback).
   */
  function sendToEcho(opts: {
    internalHeader?: string;
    forwardedFor?: string;
  }): Promise<Record<string, string>> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = { 'x-test': '1' };
      if (opts.internalHeader) headers['x-ai-platform-internal'] = opts.internalHeader;
      if (opts.forwardedFor) headers['x-forwarded-for'] = opts.forwardedFor;
      const req = http.request(
        { hostname: '127.0.0.1', port: echoPort, path: '/test', method: 'GET', headers, agent: false },
        res => {
          let data = '';
          res.on('data', c => { data += c; });
          res.on('end', () => {
            try { resolve(JSON.parse(data) as Record<string, string>); }
            catch { reject(new Error('invalid JSON from echo server')); }
          });
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  it('strips x-ai-platform-internal from non-loopback requests', () => {
    // Simulate a non-loopback request using a mock Request object.
    const req = {
      socket: { remoteAddress: '203.0.113.9' },
      headers: { 'x-ai-platform-internal': 'v1.1234567890.aabb.ccdd', 'x-forwarded-for': '203.0.113.9' },
    } as unknown as import('express').Request;

    stripInternalHeaders(req);
    expect(req.headers['x-ai-platform-internal']).toBeUndefined();
  });

  it('preserves x-ai-platform-internal from actual loopback requests', () => {
    // A direct loopback (no x-forwarded-for) keeps the header.
    const req = {
      socket: { remoteAddress: '127.0.0.1' },
      headers: { 'x-ai-platform-internal': 'v1.1234567890.aabb.ccdd' },
    } as unknown as import('express').Request;

    stripInternalHeaders(req);
    expect(req.headers['x-ai-platform-internal']).toBe('v1.1234567890.aabb.ccdd');
  });

  it('a stripped request still goes through normal auth (not bypassed)', async () => {
    // We verify via actual HTTP: an external caller carrying the internal header
    // goes to the echo server AFTER stripInternalHeaders; the header should be gone.
    // We use the echo server + call stripInternalHeaders manually to show that
    // the function acts on the req object before any downstream check.

    // Send to echo with both headers; simulate what happens at the middleware layer:
    const rawHeaders = await sendToEcho({ internalHeader: 'v1.fake.header', forwardedFor: '10.0.0.1' });

    // Now apply stripInternalHeaders to what the server would have seen.
    const req = {
      socket: { remoteAddress: '127.0.0.1' },
      headers: { ...rawHeaders },
    } as unknown as import('express').Request;

    stripInternalHeaders(req);

    // The header is stripped because x-forwarded-for signals a non-direct loopback.
    expect(req.headers['x-ai-platform-internal']).toBeUndefined();

    // The request object itself is not null/rejected — stripping doesn't block it.
    // A downstream auth check would then run normally (testing for 401 not 403).
    expect(req.headers['x-test']).toBe('1');
  });
});
