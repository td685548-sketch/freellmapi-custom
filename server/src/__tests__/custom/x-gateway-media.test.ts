import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { Server } from 'http';
import { initDb } from '../../db/index.js';
import { createApp } from '../../app.js';
import { createUser, createSession } from '../../services/auth.js';
import { setEnabled, getMediaDefaults } from '../../custom/x-gateway/config.js';

describe('X Gateway Media Providers', () => {
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

  it('retrieves media config with all 4 kinds and default settings', async () => {
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

    const imageKind = body.kinds.image as { endpoint: string; providers: unknown[]; suggestedModels: string[] };
    expect(imageKind.endpoint).toBe('/thruline/v1/images/generations');
    expect(imageKind.suggestedModels).toContain('dall-e-3');
    expect(Array.isArray(imageKind.providers)).toBe(true);
  });

  it('updates default settings and persists to config', async () => {
    const patch = {
      image: { defaultModel: 'dall-e-3' },
      tts: { defaultModel: 'tts-1-hd', defaultVoice: 'nova', defaultFormat: 'opus' },
      stt: { defaultModel: 'whisper-large-v3', defaultLanguage: 'vi' },
      embedding: { defaultModel: 'text-embedding-3-large', defaultDimensions: 3072 },
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
    const body = (await res.json()) as { ok: boolean; defaults: typeof patch };
    expect(body.ok).toBe(true);
    expect(body.defaults.image?.defaultModel).toBe('dall-e-3');
    expect(body.defaults.tts?.defaultVoice).toBe('nova');
    expect(body.defaults.embedding?.defaultDimensions).toBe(3072);

    const saved = getMediaDefaults();
    expect(saved.image?.defaultModel).toBe('dall-e-3');
    expect(saved.tts?.defaultFormat).toBe('opus');
    expect(saved.stt?.defaultLanguage).toBe('vi');
  });

  it('validates request payload on test endpoints', async () => {
    // Missing prompt on image test
    const imgRes = await fetch(`${base}/api/x-gateway/media/test/image`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminSessionToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ prompt: '' }),
    });
    expect(imgRes.status).toBe(400);

    // Missing input on TTS test
    const ttsRes = await fetch(`${base}/api/x-gateway/media/test/tts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminSessionToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ input: '' }),
    });
    expect(ttsRes.status).toBe(400);

    // Missing file on STT test
    const sttRes = await fetch(`${base}/api/x-gateway/media/test/stt`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminSessionToken}`,
      },
      body: new FormData(),
    });
    expect(sttRes.status).toBe(400);

    // Missing input on Embedding test
    const embRes = await fetch(`${base}/api/x-gateway/media/test/embedding`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminSessionToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ input: '' }),
    });
    expect(embRes.status).toBe(400);
  });
});

