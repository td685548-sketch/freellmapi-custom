import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'http';

vi.mock('../../lib/proxy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/proxy.js')>();
  return {
    ...actual,
    proxyFetch: vi.fn(),
  };
});

import { initDb, getDb } from '../../db/index.js';
import { createApp } from '../../app.js';
import { createUser, createSession } from '../../services/auth.js';
import { setEnabled } from '../../custom/x-gateway/config.js';
import { createApiKeyAccount, invalidateXGatewayKeyCache } from '../../custom/provider-accounts/store.js';
import { proxyFetch } from '../../lib/proxy.js';

describe('X Gateway Media Image Generation', () => {
  let server: Server;
  let base: string;
  let adminSessionToken: string;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');

    const admin = createUser('admin@example.com', 'AdminPass123!');
    adminSessionToken = createSession(admin.userId);
    setEnabled(true);

    const app = createApp();
    await new Promise<void>(resolve => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          base = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>(resolve => {
      server.close(() => resolve());
    });
  });

  beforeEach(() => {
    vi.mocked(proxyFetch).mockReset();
    getDb().prepare('DELETE FROM x_gateway_keys').run();
    invalidateXGatewayKeyCache();
  });

  it('surfaces a clear error instead of SyntaxError when upstream returns 200 HTML', async () => {
    createApiKeyAccount({
      provider: 'openai',
      label: 'openai-html',
      key: 'sk-test-openai',
      models: ['dall-e-3'],
    });

    vi.mocked(proxyFetch).mockResolvedValueOnce(
      new Response('<!doctype html><html><body>Login</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );

    const res = await fetch(`${base}/api/thruline/media/test/image`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminSessionToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ prompt: 'a red fox', model: 'openai/dall-e-3' }),
    });

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message).toContain('returned non-JSON response');
    expect(body.error?.message).not.toContain('Unexpected token');
  });

  it('does not call /images/generations on unsupported web-cookie providers', async () => {
    createApiKeyAccount({
      provider: 'gemini-web',
      label: 'gem-web',
      key: 'cookie-val',
      models: ['gemini-2.5-pro'],
    });

    const res = await fetch(`${base}/api/thruline/media/test/image`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminSessionToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ prompt: 'a sunset', model: 'auto' }),
    });

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message).toContain("Provider 'gemini-web' does not support image generation");
    expect(proxyFetch).not.toHaveBeenCalled();
  });

  it('routes gemini native image models via :generateContent with IMAGE modality', async () => {
    createApiKeyAccount({
      provider: 'gemini',
      label: 'gem-api',
      key: 'AIza-test-key',
      models: ['gemini-3.1-flash-image-preview'],
    });

    vi.mocked(proxyFetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  { text: 'Here is your image' },
                  { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const res = await fetch(`${base}/api/thruline/media/test/image`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminSessionToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ prompt: 'a mountain', model: 'gemini/gemini-3.1-flash-image-preview' }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; provider: string; data: Array<{ b64_json?: string }> };
    expect(body.ok).toBe(true);
    expect(body.provider).toBe('gemini');
    expect(body.data).toEqual([{ b64_json: 'iVBORw0KGgo=' }]);

    const [calledUrl, calledInit] = vi.mocked(proxyFetch).mock.calls[0];
    expect(String(calledUrl)).toContain('/gemini-3.1-flash-image-preview:generateContent?key=AIza-test-key');
    const parsedReq = JSON.parse(String(calledInit?.body)) as { generationConfig?: { responseModalities?: string[] } };
    expect(parsedReq.generationConfig?.responseModalities).toEqual(['TEXT', 'IMAGE']);
  });

  it('routes gemini imagen models via :predict', async () => {
    createApiKeyAccount({
      provider: 'gemini',
      label: 'gem-imagen',
      key: 'AIza-test-key',
      models: ['imagen-3.0-generate-002'],
    });

    vi.mocked(proxyFetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          predictions: [{ bytesBase64Encoded: 'AAAA' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const res = await fetch(`${base}/api/thruline/media/test/image`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminSessionToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ prompt: 'a forest', model: 'gemini/imagen-3.0-generate-002' }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: Array<{ b64_json?: string }> };
    expect(body.ok).toBe(true);
    expect(body.data).toEqual([{ b64_json: 'AAAA' }]);
    expect(String(vi.mocked(proxyFetch).mock.calls[0][0])).toContain('/imagen-3.0-generate-002:predict?key=AIza-test-key');
  });
});
