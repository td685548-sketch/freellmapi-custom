import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, regenerateUnifiedKey } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';

// #1642: SSE keep-alive pings through the real proxy route. Upstreams here
// stream a reasoning token first (the hop proves itself alive), then go
// quiet before the first text token (the reasoning-window shape that made
// Claude Code abort live); with STREAM_KEEPALIVE_MS set the response must
// carry comment-line pings during that silence, and with it unset (default)
// the byte stream must be byte-for-byte what it was before. A hop that dies
// before ANY token never pings at all — pinging it would commit the response
// and lose invisible failover — so total silence stays ping-free.

async function streamRequest(app: Express, body: any, signal?: AbortSignal) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + regenerateUnifiedKey() },
    body: JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  server.close();
  return { status: res.status, headers: res.headers, text };
}

const sse = (...payloads: (object | string)[]) =>
  payloads.map(p => `data: ${typeof p === 'string' ? p : JSON.stringify(p)}\n\n`).join('');

const roleChunk = { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: null }, finish_reason: null }] };
const reasoningChunk = (s: string) => ({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { reasoning_content: s }, finish_reason: null }] });
const textChunk = (s: string, finish: string | null = null) => ({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { content: s }, finish_reason: finish }] });
const finishChunk = (reason: string) => ({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: {}, finish_reason: reason }] });

/** Upstream whose first SSE bytes arrive `delayMs` after the request. */
function mockSilentThenStream(delayMs: number, body: string) {
  const origFetch = global.fetch;
  let calls = 0;
  vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    // Only intercept provider upstreams; the test's own localhost request
    // goes through.
    if (/127\.0\.0\.1|localhost/.test(urlStr)) return origFetch(url as any, init);
    calls++;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => {
          controller.enqueue(new TextEncoder().encode(body));
          controller.close();
        }, delayMs);
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  });
  return { calls: () => calls };
}

/** Upstream that goes quiet for `delayMs`, then dies mid-response. */
function mockSilentThenDie(delayMs: number) {
  const origFetch = global.fetch;
  let calls = 0;
  vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    if (/127\.0\.0\.1|localhost/.test(urlStr)) return origFetch(url as any, init);
    calls++;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => {
          controller.error(new Error('upstream exploded mid-stream'));
        }, delayMs);
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  });
  return { calls: () => calls };
}

/**
 * Upstream that proves itself alive with a reasoning token immediately, then
 * goes quiet for `delayMs` before streaming the rest. This is the shape the
 * alive-gated keep-alive serves: chunks are flowing upstream, the wire is
 * silent, and the client watchdog needs resetting.
 */
function mockReasoningThenStream(delayMs: number, body: string) {
  const origFetch = global.fetch;
  let calls = 0;
  vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    if (/127\.0\.0\.1|localhost/.test(urlStr)) return origFetch(url as any, init);
    calls++;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse(reasoningChunk('thinking…'))));
        setTimeout(() => {
          controller.enqueue(new TextEncoder().encode(body));
          controller.close();
        }, delayMs);
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  });
  return { calls: () => calls };
}

/** Upstream that proves itself alive with a reasoning token, then dies. */
function mockReasoningThenDie(delayMs: number) {
  const origFetch = global.fetch;
  let calls = 0;
  vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    if (/127\.0\.0\.1|localhost/.test(urlStr)) return origFetch(url as any, init);
    calls++;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse(reasoningChunk('thinking…'))));
        setTimeout(() => {
          controller.error(new Error('upstream exploded mid-stream'));
        }, delayMs);
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  });
  return { calls: () => calls };
}

describe('proxy SSE keep-alive (#1642)', () => {
  let app: Express;
  let dashToken = '';

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(async () => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM requests').run();
    db.prepare('DELETE FROM rate_limit_cooldowns').run();
    db.prepare('DELETE FROM rate_limit_usage').run();
    const { status } = await restKey();
    expect(status).toBe(201);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.STREAM_KEEPALIVE_MS;
  });

  async function restKey() {
    // mint a groq key through the dashboard API (same shape as the other
    // stream-integrity suites)
    const server = app.listen(0, '127.0.0.1');
    if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
    const addr = server.address() as any;
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + dashToken },
      body: JSON.stringify({ platform: 'groq', key: 'gsk_keepalive', label: 't' }),
    });
    const status = res.status;
    await res.json().catch(() => null);
    server.close();
    return { status };
  }

  it('emits comment-line pings during a silent reasoning window when enabled', async () => {
    process.env.STREAM_KEEPALIVE_MS = '1000'; // 1s is the helper's floor
    // Reasoning token first (hop alive), then 2.6s of wire silence before the
    // first text token ≈ 2 scheduled pings (1000ms floor).
    const up = mockReasoningThenStream(2600, sse(roleChunk, textChunk('finally.'), finishChunk('stop'), '[DONE]'));
    const r = await streamRequest(app, { stream: true, messages: [{ role: 'user', content: 'keepalive ping test' }] });
    expect(r.status).toBe(200);
    expect(up.calls()).toBe(1);
    const pings = r.text.split('\n').filter(l => l === ': keepalive');
    expect(pings.length).toBeGreaterThanOrEqual(2);
    // Every ping is a bare SSE comment: a spec parser drops it, so the JSON
    // frames the client sees are unchanged.
    const frames = r.text.split('\n')
      .filter(l => l.startsWith('data: ') && l.trim() !== 'data: [DONE]')
      .map(l => JSON.parse(l.slice(6)));
    expect(frames.some(f => f.choices?.[0]?.delta?.content === 'finally.')).toBe(true);
  }, 15000);

  it('default (unset): a silent window streams no pings at all', async () => {
    expect(process.env.STREAM_KEEPALIVE_MS).toBeUndefined();
    const up = mockSilentThenStream(500, sse(roleChunk, textChunk('no heartbeat here.'), finishChunk('stop'), '[DONE]'));
    const r = await streamRequest(app, { stream: true, messages: [{ role: 'user', content: 'keepalive default-off test' }] });
    expect(r.status).toBe(200);
    expect(up.calls()).toBe(1);
    expect(r.text).not.toContain(': keepalive');
  }, 15000);

  it('once a ping committed the response, a dying stream ends honestly instead of failing over', async () => {
    // The documented trade of opting in: after bytes hit the wire there is no
    // invisible retry. The client gets an SSE error frame, not a hang, and
    // exactly one upstream was tried. The hop proved itself alive with a
    // reasoning token first, so the keep-alive had fired before the death.
    process.env.STREAM_KEEPALIVE_MS = '1000'; // 1s is the helper's floor
    const up = mockReasoningThenDie(1500);
    const r = await streamRequest(app, { stream: true, messages: [{ role: 'user', content: 'keepalive committed trade test' }] });
    expect(r.status).toBe(200);
    expect(up.calls()).toBe(1);
    expect(r.text).toContain(': keepalive');
    expect(r.text).toContain('"stream_error"');
    expect(r.text).toContain('data: [DONE]');
  }, 15000);

  it('a hop that dies before any token never pings, so failover stays invisible', async () => {
    // The alive gate: total silence is indistinguishable from a dead hop, so
    // no ping commits the response. The attempt fails over (or errors) with
    // zero bytes on the wire — never a keep-alive comment.
    process.env.STREAM_KEEPALIVE_MS = '1000'; // 1s is the helper's floor
    mockSilentThenDie(1500);
    const r = await streamRequest(app, { stream: true, messages: [{ role: 'user', content: 'keepalive silent-death test' }] });
    expect(r.text).not.toContain(': keepalive');
  }, 15000);
});
