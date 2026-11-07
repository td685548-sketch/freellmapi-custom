import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'http';

vi.mock('../../custom/provider-accounts/chatgpt-web-image.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../custom/provider-accounts/chatgpt-web-image.js')>();
  return {
    ...actual,
    generateChatGptWebImages: vi.fn(async () => ({
      created: 42,
      data: [{ b64_json: 'QUJD', mime_type: 'image/png' }],
    })),
  };
});

import { initDb } from '../../db/index.js';
import { createApp } from '../../app.js';
import { createSession, createUser } from '../../services/auth.js';
import { mintUserApiKey } from '../../services/user-keys.js';
import { setEnabled } from '../../custom/x-gateway/config.js';
import { createApiKeyAccount } from '../../custom/provider-accounts/store.js';
import { generateChatGptWebImages } from '../../custom/provider-accounts/chatgpt-web-image.js';

const realFetch = global.fetch;

describe('X Gateway ChatGPT Web image routing', () => {
  let server: Server;
  let base: string;
  let adminKey: string;
  let adminSessionToken: string;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');

    const admin = createUser('images-admin@example.com', 'AdminPass123!');
    adminKey = mintUserApiKey(admin.userId, 'Admin Key').key;
    adminSessionToken = createSession(admin.userId);
    createApiKeyAccount({
      provider: 'chatgpt-web',
      key: '__Secure-next-auth.session-token=test-cookie',
      label: 'CG image account',
    });
    setEnabled(true);

    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', () => resolve()));
    const { port } = server.address() as { port: number };
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server?.close();
    vi.mocked(generateChatGptWebImages).mockReset();
  });

  it('routes /x/v1/images/generations through the picture_v2 flow for chatgpt-web', async () => {
    const res = await realFetch(`${base}/x/v1/images/generations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-image-2', prompt: 'a red cube', n: 1, size: '1024x1024' }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-routed-via')).toBe('chatgpt-web/gpt-image-2');
    await expect(res.json()).resolves.toEqual({
      created: 42,
      data: [{ b64_json: 'QUJD', mime_type: 'image/png' }],
    });
    expect(generateChatGptWebImages).toHaveBeenCalledWith(expect.objectContaining({
      credential: '__Secure-next-auth.session-token=test-cookie',
      prompt: 'a red cube',
      n: 1,
      size: '1024x1024',
      baseUrl: 'https://chatgpt.com',
      platform: 'custom',
    }));
  });

  it('routes model:auto to the image model instead of the account chat model', async () => {
    vi.mocked(generateChatGptWebImages).mockClear();
    const res = await realFetch(`${base}/x/v1/images/generations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'auto', prompt: 'a red cube' }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-routed-via')).toBe('chatgpt-web/gpt-image-2');
    expect(generateChatGptWebImages).toHaveBeenCalledTimes(1);
  });

  it('returns 429 when the ChatGPT account is out of image quota', async () => {
    vi.mocked(generateChatGptWebImages).mockRejectedValueOnce(Object.assign(
      new Error('ChatGPT account has hit its image generation quota'),
      { status: 429 },
    ));

    const res = await realFetch(`${base}/x/v1/images/generations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-image-2', prompt: 'a red cube' }),
    });

    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toMatchObject({
      error: { message: expect.stringContaining('quota') },
    });
  });

  it('returns 401 when the stored cookie is no longer signed in', async () => {
    vi.mocked(generateChatGptWebImages).mockRejectedValueOnce(Object.assign(
      new Error('ChatGPT session is not signed in'),
      { status: 401 },
    ));

    const res = await realFetch(`${base}/x/v1/images/generations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-image-2', prompt: 'a red cube' }),
    });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({
      error: { message: expect.stringContaining('not signed in') },
    });
  });

  it('propagates the same status through the Playground image tester', async () => {
    vi.mocked(generateChatGptWebImages).mockRejectedValueOnce(Object.assign(
      new Error('ChatGPT account has hit its image generation quota'),
      { status: 429 },
    ));

    const res = await realFetch(`${base}/api/x-gateway/media/test/image`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminSessionToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-image-2', prompt: 'a red cube' }),
    });

    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toMatchObject({
      error: { message: expect.stringContaining('quota') },
    });
  });
});
