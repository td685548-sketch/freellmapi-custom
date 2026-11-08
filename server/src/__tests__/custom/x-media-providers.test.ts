import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { Server } from 'http';
import { initDb } from '../../db/index.js';
import { createApp } from '../../app.js';
import { createUser, createSession } from '../../services/auth.js';
import { setEnabled } from '../../custom/x-gateway/config.js';

describe('X Gateway Media Providers & Web Kind', () => {
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
    await new Promise<void>((resolve) => {
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
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it('retrieves media config with web search & fetch kind', async () => {
    const res = await fetch(`${base}/api/x-gateway/media/config`, {
      headers: { Authorization: `Bearer ${adminSessionToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { defaults: Record<string, unknown>; kinds: Record<string, unknown> };

    expect(body.defaults).toBeDefined();
    expect(body.kinds.image).toBeDefined();
    expect(body.kinds.tts).toBeDefined();
    expect(body.kinds.stt).toBeDefined();
    expect(body.kinds.embedding).toBeDefined();
    expect(body.kinds.web).toBeDefined();

    const webKind = body.kinds.web as {
      label: string;
      endpoint: string;
      providers: unknown[];
      suggestedModels: string[];
    };
    expect(webKind.label).toBe('Web Search & Fetch');
    expect(webKind.endpoint).toBe('/x/v1/chat/completions');
    expect(webKind.suggestedModels).toContain('sonar-pro');
    expect(webKind.suggestedModels).toContain('tavily-search');
    expect(Array.isArray(webKind.providers)).toBe(true);
  });

  it('updates web media default model in media config', async () => {
    const patch = {
      web: { defaultModel: 'sonar-pro' },
    };

    const res = await fetch(`${base}/api/x-gateway/media/config`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${adminSessionToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(patch),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; defaults: { web?: { defaultModel?: string } } };
    expect(body.ok).toBe(true);
    expect(body.defaults.web?.defaultModel).toBe('sonar-pro');

    // Retrieve again to ensure persistence
    const checkRes = await fetch(`${base}/api/x-gateway/media/config`, {
      headers: { Authorization: `Bearer ${adminSessionToken}` },
    });
    const checkBody = (await checkRes.json()) as { defaults: { web?: { defaultModel?: string } } };
    expect(checkBody.defaults.web?.defaultModel).toBe('sonar-pro');
  });

  it('validates web search test request payload', async () => {
    // Missing query
    const invalidRes = await fetch(`${base}/api/x-gateway/media/test/web`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminSessionToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: '' }),
    });
    expect(invalidRes.status).toBe(400);

    // Empty body
    const emptyRes = await fetch(`${base}/api/x-gateway/media/test/web`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminSessionToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(emptyRes.status).toBe(400);
  });

  it('returns 503 or 404 when testing web search with no available accounts', async () => {
    const res = await fetch(`${base}/api/x-gateway/media/test/web`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminSessionToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: 'latest tech news' }),
    });

    // When no candidate accounts exist or are enabled
    expect([404, 503]).toContain(res.status);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message).toBeDefined();
  });

  it('supports wenyan level and custom prompt in savers API', async () => {
    const patch = {
      caveman: 'wenyan',
      ponytail: 'wenyan',
      customPrompt: 'Be ultra concise.',
    };

    const res = await fetch(`${base}/api/savers`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${adminSessionToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(patch),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { caveman: string; ponytail: string; customPrompt: string };
    expect(body.caveman).toBe('wenyan');
    expect(body.ponytail).toBe('wenyan');
    expect(body.customPrompt).toBe('Be ultra concise.');
  });
});
