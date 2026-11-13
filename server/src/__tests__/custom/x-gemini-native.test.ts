import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import type { Server } from 'http';
import { initDb, getDb } from '../../db/index.js';
import { createApp } from '../../app.js';
import { createUser } from '../../services/auth.js';
import { mintUserApiKey } from '../../services/user-keys.js';
import { mintXGatewayClientKey, updateXGatewayClientKeyAccess } from '../../custom/x-gateway/client-keys.js';
import { encrypt } from '../../lib/crypto.js';

describe('X Gateway Gemini Native API & Ollama Emulation', () => {
  let server: Server;
  let base: string;
  let adminKey: string;
  let xgwKey: string;
  let restrictedKey: string;
  const realFetch = global.fetch;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');

    // Seed an X Gateway provider key
    const key = encrypt('gsk_gemini_test');
    getDb()
      .prepare(
        `INSERT INTO x_gateway_keys (provider, label, auth_method, encrypted_key, iv, auth_tag, status, enabled) VALUES ('groq', 'test-gemini-key', 'api_key', ?, ?, ?, 'healthy', 1)`
      )
      .run(key.encrypted, key.iv, key.authTag);

    // Admin user
    const admin = createUser('admin@example.com', 'AdminPass123!');
    const adminKeyObj = mintUserApiKey(admin.userId, 'Admin Key');
    adminKey = adminKeyObj.key;

    // Dedicated X Gateway client key
    const xgw = mintXGatewayClientKey(admin.userId, 'gemini-tester');
    xgwKey = xgw.key;

    // Restricted key
    const restricted = mintXGatewayClientKey(admin.userId, 'restricted-tester');
    restrictedKey = restricted.key;
    updateXGatewayClientKeyAccess(restricted.id, {
      restricted: true,
      allowedModels: ['gemini-2.0-flash'],
    });

    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', () => resolve()));
    const { port } = server.address() as { port: number };
    base = `http://127.0.0.1:${port}`;

    // Mock provider fetch
    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init: any) => {
      if (String(url).startsWith(`http://127.0.0.1:${port}`)) return realFetch(url, init);
      let isStream = false;
      try {
        if (init?.body && typeof init.body === 'string') {
          const parsed = JSON.parse(init.body);
          isStream = parsed.stream === true;
        }
      } catch {
        isStream = false;
      }

      if (isStream) {
        const sse = `data: ${JSON.stringify({
          id: 'chatcmpl-stream-test',
          object: 'chat.completion.chunk',
          created: Date.now(),
          model: 'llama-3.3-70b',
          choices: [{ delta: { content: 'Hello from Google Gemini emulation!' }, index: 0, finish_reason: null }],
        })}\n\ndata: ${JSON.stringify({
          id: 'chatcmpl-stream-test',
          object: 'chat.completion.chunk',
          created: Date.now(),
          model: 'llama-3.3-70b',
          choices: [{ delta: {}, index: 0, finish_reason: 'stop' }],
        })}\n\ndata: [DONE]\n\n`;
        return new Response(sse, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }

      return new Response(
        JSON.stringify({
          id: 'chatcmpl-gemini-test',
          object: 'chat.completion',
          created: Date.now(),
          model: 'llama-3.3-70b',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'Hello from Google Gemini emulation!' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 15, completion_tokens: 8, total_tokens: 23 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
  });

  afterAll(() => {
    server?.close();
    vi.restoreAllMocks();
  });

  describe('Google Gemini Native API (/v1beta)', () => {
    it('rejects /v1beta/models without API key (401)', async () => {
      const res = await realFetch(`${base}/v1beta/models`);
      expect(res.status).toBe(401);
      const data = await res.json() as any;
      expect(data.error).toBeDefined();
    });

    it('lists models with x-goog-api-key header', async () => {
      const res = await realFetch(`${base}/v1beta/models`, {
        headers: { 'x-goog-api-key': xgwKey },
      });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(Array.isArray(data.models)).toBe(true);
      expect(data.models.length).toBeGreaterThan(0);
      expect(data.models[0].supportedGenerationMethods).toContain('generateContent');
    });

    it('lists models with ?key= query parameter', async () => {
      const res = await realFetch(`${base}/v1beta/models?key=${encodeURIComponent(adminKey)}`);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(Array.isArray(data.models)).toBe(true);
    });

    it('rejects generateContent when unauthenticated (401)', async () => {
      const res = await realFetch(`${base}/v1beta/models/gemini-2.0-flash:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: 'Hello' }] }] }),
      });
      expect(res.status).toBe(401);
    });

    it('rejects disallowed model for restricted key (403)', async () => {
      const res = await realFetch(`${base}/v1beta/models/claude-3-5-sonnet:generateContent?key=${encodeURIComponent(restrictedKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: 'Hello' }] }] }),
      });
      expect(res.status).toBe(403);
      const data = await res.json() as any;
      expect(data.error.message).toContain('not allowed');
    });

    it('successfully processes generateContent for allowed model', async () => {
      const res = await realFetch(`${base}/v1beta/models/gemini-2.0-flash:generateContent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': xgwKey,
        },
        body: JSON.stringify({
          contents: [
            { role: 'user', parts: [{ text: 'Explain quantum computing simply' }] },
          ],
        }),
      });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(Array.isArray(data.candidates)).toBe(true);
      expect(data.candidates[0].content.parts[0].text).toBe('Hello from Google Gemini emulation!');
      expect(data.candidates[0].finishReason).toBe('STOP');
      expect(data.usageMetadata).toBeDefined();
    });

    it('handles streamGenerateContent returning text/event-stream chunks', async () => {
      const res = await realFetch(`${base}/v1beta/models/gemini-2.0-flash:streamGenerateContent?key=${encodeURIComponent(xgwKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: 'Stream this answer' }] }],
        }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const text = await res.text();
      expect(text).toContain('data: ');
      expect(text).toContain('Hello from Google Gemini emulation!');
    });
  });

  describe('Ollama Native API Emulation (/thruline/api)', () => {
    it('returns model tags for Ollama clients at /thruline/api/tags', async () => {
      const res = await realFetch(`${base}/thruline/api/tags`, {
        headers: { Authorization: `Bearer ${xgwKey}` },
      });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(Array.isArray(data.models)).toBe(true);
      expect(data.models.length).toBeGreaterThan(0);
      expect(data.models[0].details.format).toBe('gguf');
    });

    it('still answers at the pre-rename /x prefix', async () => {
      const res = await realFetch(`${base}/x/api/tags`, {
        headers: { Authorization: `Bearer ${xgwKey}` },
      });
      expect(res.status).toBe(200);
      expect(Array.isArray((await res.json() as any).models)).toBe(true);
    });

    it('returns Ollama version at /thruline/api/version', async () => {
      const res = await realFetch(`${base}/thruline/api/version`);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.version).toBe('0.5.1');
    });

    it('returns model info at /thruline/api/show', async () => {
      const res = await realFetch(`${base}/thruline/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'llama-3.3-70b' }),
      });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.modelfile).toContain('FROM llama-3.3-70b');
      expect(data.details.format).toBe('gguf');
    });
  });
});

