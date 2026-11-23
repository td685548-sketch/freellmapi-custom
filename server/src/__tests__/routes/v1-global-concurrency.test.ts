import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, regenerateUnifiedKey } from '../../db/index.js';
import { loadConfig } from '../../lib/config.js';
import { encrypt } from '../../lib/crypto.js';
import { setRoutingStrategy } from '../../services/router.js';
import { inFlightRequests, resetGlobalConcurrencyState } from '../../middleware/globalConcurrency.js';

// End-to-end proof that the global /v1 concurrency limiter is actually
// mounted in the app (not just correct in isolation): a hanging Groq
// upstream holds one chat/completions stream open, and while it is in
// flight a second inference request must 429 — then the slot frees when
// the stream ends and the next request succeeds. GET /v1/models must stay
// reachable throughout: it never takes a slot.

let app: Express;
let server: ReturnType<Express['listen']>;
let port: number;
let releaseUpstream: (() => void) | null = null;
let upstreamGate: Promise<void> | null = null;
let upstreamCalls = 0;

const cannedCompletion = {
  id: 'chatcmpl-x', object: 'chat.completion', created: 1, model: 'alpha-model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
};

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${regenerateUnifiedKey()}` };
}

function activeProfileId(): number | null {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = 'active_profile_id'").get() as { value: string } | undefined;
  return row ? Number(row.value) : null;
}

function addKey(platform: string): void {
  const secret = encrypt(`${platform}-concurrency-key`);
  getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'concurrency', ?, ?, ?, 'healthy', 1)
  `).run(platform, secret.encrypted, secret.iv, secret.authTag);
}

function addModel(modelId: string, priority: number): void {
  const db = getDb();
  const inserted = db.prepare(`
    INSERT INTO models (
      platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
      rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget,
      context_window, enabled, supports_vision, supports_tools
    )
    VALUES ('groq', ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, '~1M', 128000, 1, 0, 1)
  `).run(modelId, `Concurrency ${modelId}`, priority, priority, 'Small');
  const id = Number(inserted.lastInsertRowid);
  db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(id, priority);
  const profileId = activeProfileId();
  if (profileId != null) {
    db.prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, ?, 1)')
      .run(profileId, id, priority);
  }
}

// Groq chat completions hang on the gate until the test releases them; every
// other Groq URL answers immediately so a pre-dispatch probe can never wedge
// the test. Non-Groq traffic passes through to the real fetch.
function mockHangingUpstream(): void {
  const origFetch = global.fetch;
  upstreamGate = new Promise<void>(resolve => { releaseUpstream = resolve; });
  upstreamCalls = 0;
  vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    const u = typeof url === 'string' ? url : url.toString();
    if (u.includes('api.groq.com')) {
      if (u.includes('/openai/v1/chat/completions')) {
        upstreamCalls += 1;
        await upstreamGate;
      }
      return {
        ok: true, status: 200, headers: new Headers(),
        json: () => Promise.resolve(cannedCompletion),
      } as unknown as Response;
    }
    return origFetch(url as never, init as never);
  });
}

async function startServer(): Promise<void> {
  server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  port = (server.address() as { port: number }).port;
}

async function waitFor(fn: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function chatBody() {
  return { model: 'alpha-model', messages: [{ role: 'user', content: 'hi' }] };
}

async function postChat(headers: Record<string, string>): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(chatBody()),
  });
}

describe('global /v1 concurrency limit through the app', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    delete process.env.MAX_CONCURRENT_REQUESTS;
    initDb(':memory:');
    app = createApp({ ...loadConfig(), maxConcurrentRequests: 1 });
    setRoutingStrategy('priority');
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM profile_models').run();
    db.prepare('DELETE FROM fallback_config').run();
    db.prepare('DELETE FROM models').run();
    addKey('groq');
    addModel('alpha-model', 1);
    mockHangingUpstream();
    resetGlobalConcurrencyState();
  });

  afterEach(async () => {
    // Never leave a hung upstream behind: a failed assertion mid-test must
    // not wedge the next test (or the suite) on a pending fetch.
    releaseUpstream?.();
    releaseUpstream = null;
    vi.restoreAllMocks();
    resetGlobalConcurrencyState();
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('429s the second concurrent inference request while the first stream is in flight', async () => {
    await startServer();
    // Mint the auth header ONCE: regenerateUnifiedKey() rotates the key, so
    // a second call would invalidate the first request's credential before
    // the server processes it (a stale key 401s instead of hanging).
    const headers = authHeaders();
    const first = postChat(headers);
    await waitFor(() => upstreamCalls >= 1);
    expect(inFlightRequests()).toBe(1);

    // The second request must 429 even though its key is valid and its RPM
    // budget is untouched — the server, not the key, is at capacity.
    const second = await postChat(headers);
    expect(second.status).toBe(429);
    expect(second.headers.get('retry-after')).toBe('5');
    const body = await second.json() as { error: { message: string; type: string } };
    expect(body.error.type).toBe('rate_limit_error');
    expect(body.error.message).toMatch(/at capacity/i);
    expect(inFlightRequests()).toBe(1);

    // GET /v1/models stays reachable while inference is saturated.
    const models = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers });
    expect(models.status).toBe(200);
    await models.arrayBuffer();

    releaseUpstream?.();
    const firstRes = await first;
    expect(firstRes.status).toBe(200);
    await firstRes.arrayBuffer();
    expect(inFlightRequests()).toBe(0);

    const third = await postChat(headers);
    expect(third.status).toBe(200);
    await third.arrayBuffer();
    expect(inFlightRequests()).toBe(0);
  }, 30_000);

  it('admits concurrent streams when the cap is unset (the default)', async () => {
    app = createApp();
    await startServer();
    const headers = authHeaders();
    const first = postChat(headers);
    const second = postChat(headers);
    await waitFor(() => upstreamCalls >= 2);
    expect(inFlightRequests()).toBe(0);

    releaseUpstream?.();
    const [firstRes, secondRes] = await Promise.all([first, second]);
    expect(firstRes.status).toBe(200);
    expect(secondRes.status).toBe(200);
    await firstRes.arrayBuffer();
    await secondRes.arrayBuffer();
  }, 30_000);
});
