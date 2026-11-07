import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'http';

vi.mock('../../custom/provider-accounts/chatgpt-web-image.js', () => ({
  generateChatGptWebImages: vi.fn(async () => ({
    created: 42,
    data: [{ b64_json: 'QUJD', mime_type: 'image/png' }],
  })),
}));

import { initDb } from '../../db/index.js';
import { createApp } from '../../app.js';
import { createUser } from '../../services/auth.js';
import { mintUserApiKey } from '../../services/user-keys.js';
import { setEnabled } from '../../custom/x-gateway/config.js';
import { createApiKeyAccount } from '../../custom/provider-accounts/store.js';
import { generateChatGptWebImages } from '../../custom/provider-accounts/chatgpt-web-image.js';

const realFetch = global.fetch;

describe('X Gateway ChatGPT Web image routing', () => {
  let server: Server;
  let base: string;
  let adminKey: string;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');

    const admin = createUser('images-admin@example.com', 'AdminPass123!');
    adminKey = mintUserApiKey(admin.userId, 'Admin Key').key;
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
});
