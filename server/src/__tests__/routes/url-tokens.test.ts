import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { getDb, regenerateUnifiedKey, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { mintDashboardToken, dashboardSessionHeaders } from '../helpers/auth.js';

async function request(
  app: Express,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const address = server.address() as { port: number };
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  server.close();
  let json: any;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, body: json };
}

describe('revocable URL-token aliases', () => {
  let app: Express;
  let dashboardToken: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashboardToken = mintDashboardToken();
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM url_tokens').run();
    getDb().prepare('DELETE FROM api_keys').run();
    getDb().prepare('DELETE FROM requests').run();
    getDb().prepare('DELETE FROM rate_limit_usage').run();
    getDb().prepare('DELETE FROM rate_limit_cooldowns').run();
    const key = encrypt('gsk_url_token_test');
    getDb().prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('groq', 'url-token-test', ?, ?, ?, 'healthy', 1)
    `).run(key.encrypted, key.iv, key.authTag);
  });

  afterEach(() => vi.restoreAllMocks());

  it('mints once, authenticates a headerless alias, and revokes immediately', async () => {
    const minted = await request(app, 'POST', '/api/settings/url-tokens', { label: 'VS Code' }, {
      ...dashboardSessionHeaders(dashboardToken),
    });
    expect(minted.status).toBe(201);
    expect(minted.body.token).toMatch(/^flmurl_/);

    const originalFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).includes('api.groq.com/openai/v1/chat/completions')) {
        return {
          ok: true,
          headers: new Headers(),
          json: async () => ({
            id: 'chatcmpl-url-token',
            object: 'chat.completion',
            created: 1,
            model: 'openai/gpt-oss-120b',
            choices: [{
              index: 0,
              message: { role: 'assistant', content: 'headerless response' },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
          }),
        } as any;
      }
      return originalFetch(url, init);
    });

    const models = await request(app, 'GET', `/v1/t/${minted.body.token}/models`);
    expect(models.status).toBe(200);
    expect(models.body.data[0].id).toBe('auto');

    const chat = await request(app, 'POST', `/v1/t/${minted.body.token}/chat/completions`, {
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(chat.status).toBe(200);
    expect(chat.body.choices[0].message.content).toBe('headerless response');

    const responses = await request(app, 'POST', `/v1/t/${minted.body.token}/responses`, {
      input: 'hello',
      stream: false,
    });
    expect(responses.status).toBe(200);
    expect(responses.body.object).toBe('response');
    expect(responses.body.output_text).toBe('headerless response');

    const ollamaTags = await request(app, 'GET', `/v1/t/${minted.body.token}/api/tags`);
    expect(ollamaTags.status).toBe(200);
    expect(ollamaTags.body.models.length).toBeGreaterThan(0);

    const revoked = await request(app, 'DELETE', `/api/settings/url-tokens/${minted.body.id}`, undefined, {
      ...dashboardSessionHeaders(dashboardToken),
    });
    expect(revoked.status).toBe(204);
    expect((await request(app, 'GET', `/v1/t/${minted.body.token}/models`)).status).toBe(401);
  });

  it('never accepts the unified API key as a URL credential', async () => {
    const response = await request(app, 'GET', `/v1/t/${regenerateUnifiedKey()}/models`);
    expect(response.status).toBe(401);
  });

  it('mints chat-scoped tokens with a 90-day default expiry', async () => {
    const minted = await request(app, 'POST', '/api/settings/url-tokens', { label: 'expiry-default' }, {
      ...dashboardSessionHeaders(dashboardToken),
    });
    expect(minted.status).toBe(201);
    expect(minted.body.scope).toBe('chat');
    expect(typeof minted.body.expiresAt).toBe('string');
    const days = (new Date(minted.body.expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(89);
    expect(days).toBeLessThan(91);

    const listed = await request(app, 'GET', '/api/settings/url-tokens', undefined, {
      ...dashboardSessionHeaders(dashboardToken),
    });
    expect(listed.status).toBe(200);
    expect(listed.body.tokens[0]).toMatchObject({ scope: 'chat', expiresAt: minted.body.expiresAt });
  });

  it('honours a per-token expiresInDays and rejects out-of-range values', async () => {
    const minted = await request(app, 'POST', '/api/settings/url-tokens', { label: 'short', expiresInDays: 30 }, {
      ...dashboardSessionHeaders(dashboardToken),
    });
    expect(minted.status).toBe(201);
    const days = (new Date(minted.body.expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31);

    for (const bad of [0, -1, 3651, 'soon']) {
      const rejected = await request(app, 'POST', '/api/settings/url-tokens', { label: 'bad', expiresInDays: bad }, {
        ...dashboardSessionHeaders(dashboardToken),
      });
      expect(rejected.status).toBe(400);
    }
  });

  it('rejects an expired token without any manual revoke', async () => {
    const minted = await request(app, 'POST', '/api/settings/url-tokens', { label: 'will-expire' }, {
      ...dashboardSessionHeaders(dashboardToken),
    });
    expect(minted.status).toBe(201);
    expect((await request(app, 'GET', `/v1/t/${minted.body.token}/models`)).status).toBe(200);

    getDb().prepare("UPDATE url_tokens SET expires_at = datetime('now', '-1 day') WHERE id = ?")
      .run(minted.body.id);
    const expired = await request(app, 'GET', `/v1/t/${minted.body.token}/models`);
    expect(expired.status).toBe(401);
    expect(expired.body.error?.message).toMatch(/expired/i);
  });

  it('grandfathers pre-expiry tokens (expires_at NULL) until revoked', async () => {
    const minted = await request(app, 'POST', '/api/settings/url-tokens', { label: 'legacy' }, {
      ...dashboardSessionHeaders(dashboardToken),
    });
    expect(minted.status).toBe(201);
    getDb().prepare('UPDATE url_tokens SET expires_at = NULL WHERE id = ?').run(minted.body.id);
    // No expiry recorded: the token keeps working, as it did before the
    // migration — revoking it is the operator's explicit act.
    expect((await request(app, 'GET', `/v1/t/${minted.body.token}/models`)).status).toBe(200);
  });

  it('does not let a URL token read the unified-only /v1/usage ledger', async () => {
    const minted = await request(app, 'POST', '/api/settings/url-tokens', { label: 'widget' }, {
      ...dashboardSessionHeaders(dashboardToken),
    });
    expect(minted.status).toBe(201);

    // The middleware injects the unified key for headerless clients — the
    // usage route must not treat that injection as the real unified key.
    const viaToken = await request(app, 'GET', `/v1/t/${minted.body.token}/usage`);
    expect(viaToken.status).toBe(403);
    expect(viaToken.body.error?.type).toBe('permission_error');

    // The genuine unified key keeps its read.
    const viaUnified = await request(app, 'GET', '/v1/usage', undefined, {
      Authorization: `Bearer ${regenerateUnifiedKey()}`,
    });
    expect(viaUnified.status).toBe(200);
    expect(typeof viaUnified.body.requests).toBe('number');
  });
});
