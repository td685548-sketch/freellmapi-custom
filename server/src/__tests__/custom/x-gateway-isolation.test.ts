import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import type { Server } from 'http';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { createApp } from '../../app.js';
import { setEnabled } from '../../custom/x-gateway/config.js';
import { encrypt } from '../../lib/crypto.js';
import { setRoutingStrategy } from '../../services/router.js';

describe('X Gateway Isolation (US1 / Phase 3)', () => {
  let server: Server;
  let base: string;
  const realFetch = global.fetch;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    setRoutingStrategy('priority');

    // Seed a provider key
    const key = encrypt('gsk_isolation_test');
    getDb()
      .prepare(
        `INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('groq', 'test-key', ?, ?, ?, 'healthy', 1)`
      )
      .run(key.encrypted, key.iv, key.authTag);

    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', () => resolve()));
    const { port } = server.address() as { port: number };
    base = `http://127.0.0.1:${port}`;

    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init: any) => {
      if (String(url).startsWith(`http://127.0.0.1:${port}`)) return realFetch(url, init);
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-isolation',
          object: 'chat.completion',
          created: 123456789,
          model: 'llama-3.3-70b',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'Isolation response' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
  });

  afterAll(() => {
    server?.close();
    vi.restoreAllMocks();
  });

  async function get(path: string, token?: string) {
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await realFetch(`${base}${path}`, { method: 'GET', headers });
    const text = await res.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body };
  }

  async function postChat(path: string, model: string, token: string) {
    const res = await realFetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    const text = await res.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body };
  }

  it('/livez, /readyz, /api/ping return identical responses with gateway on and off', async () => {
    setEnabled(false);
    const livezOff = await get('/livez');
    const readyzOff = await get('/readyz');
    const pingOff = await get('/api/ping');

    setEnabled(true);
    const livezOn = await get('/livez');
    const readyzOn = await get('/readyz');
    const pingOn = await get('/api/ping');

    expect(livezOff.status).toBe(livezOn.status);
    expect(livezOff.body.status).toBe(livezOn.body.status);
    expect(livezOff.body.version).toBe(livezOn.body.version);
    expect(livezOff.body.stored_keys_decryptable).toBe(livezOn.body.stored_keys_decryptable);
    expect(typeof livezOff.body.uptime_s).toBe('number');
    expect(typeof livezOn.body.uptime_s).toBe('number');

    expect(readyzOff.status).toBe(readyzOn.status);
    expect(readyzOff.body).toEqual(readyzOn.body);

    expect(pingOff.status).toBe(pingOn.status);
    expect(pingOff.body.status).toBe(pingOn.body.status);
    expect(typeof pingOff.body.timestamp).toBe('string');
    expect(typeof pingOn.body.timestamp).toBe('string');
  });

  it('/v1/models returns identical responses with gateway on and off', async () => {
    const token = getUnifiedApiKey();

    setEnabled(false);
    const modelsOff = await get('/v1/models', token);

    setEnabled(true);
    const modelsOn = await get('/v1/models', token);

    expect(modelsOff.status).toBe(200);
    expect(modelsOn.status).toBe(200);
    expect(modelsOff.body).toEqual(modelsOn.body);
  });

  it('/v1/chat/completions returns identical responses with gateway on and off', async () => {
    const token = getUnifiedApiKey();
    const model = 'auto';

    setEnabled(false);
    const chatOff = await postChat('/v1/chat/completions', model, token);

    setEnabled(true);
    const chatOn = await postChat('/v1/chat/completions', model, token);

    expect(chatOff.status).toBe(200);
    expect(chatOn.status).toBe(200);
    expect(chatOff.body.object).toBe(chatOn.body.object);
    expect(chatOff.body.choices[0].message.content).toBe(chatOn.body.choices[0].message.content);
    expect(chatOff.body.model).toBe(chatOn.body.model);
  });

  it('/v1 client sending model: "combo:x" gets the ordinary unknown-model behaviour (not combo)', async () => {
    const token = getUnifiedApiKey();

    const res = await postChat('/v1/chat/completions', 'combo:test-combo', token);
    // On /v1, naming a non-existent or unrouted model returns model_not_found (400 or 404)
    expect([400, 404]).toContain(res.status);
    expect(res.body?.error?.code).toBe('model_not_found');
  });
});
