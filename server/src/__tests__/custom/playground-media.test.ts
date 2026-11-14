import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  downloadProviderImage,
  isProviderImageUrl,
  playgroundMediaUrl,
  readPlaygroundMedia,
  storePlaygroundMedia,
  xPlaygroundMediaRouter,
} from '../../custom/x-gateway/playground-media.js';
import { getDb, initDb } from '../../db/index.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

describe('playground media', () => {
  beforeEach(() => {
    initDb(':memory:');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('only accepts Google image assets, never placeholder paths', () => {
    expect(isProviderImageUrl('https://lh3.googleusercontent.com/gg/abc=1024')).toBe(true);
    expect(isProviderImageUrl('http://lh3.googleusercontent.com/gg/abc')).toBe(false);
    expect(isProviderImageUrl('https://googleusercontent.com/gg/abc')).toBe(true);
    expect(isProviderImageUrl('https://notgoogleusercontent.com.evil.test/gg/abc')).toBe(false);
    expect(isProviderImageUrl('https://example.com/gg/abc')).toBe(false);
    expect(isProviderImageUrl('https://lh3.googleusercontent.com/image_generation_content/0_973')).toBe(false);
    expect(isProviderImageUrl('https://lh3.googleusercontent.com/image_collection/image_retrieval/12')).toBe(false);
    expect(isProviderImageUrl('not a url')).toBe(false);
  });

  it('stores image bytes and serves them back by capability id', () => {
    const id = storePlaygroundMedia(PNG, 'image/png');
    expect(id).toMatch(/^[a-f0-9]{32}$/);
    expect(playgroundMediaUrl(id!)).toBe(`/api/thruline/playground/media/${id}`);
    const stored = readPlaygroundMedia(id!);
    expect(stored?.contentType).toBe('image/png');
    expect(stored?.bytes.equals(PNG)).toBe(true);
  });

  it('refuses empty payloads and non-image content types', () => {
    expect(storePlaygroundMedia(Buffer.alloc(0), 'image/png')).toBeNull();
    expect(storePlaygroundMedia(Buffer.from('<html>'), 'text/html')).toBeNull();
  });

  it('drops expired rows instead of serving them', () => {
    const id = storePlaygroundMedia(PNG, 'image/png')!;
    getDb().prepare('UPDATE playground_media SET expires_at_ms = ? WHERE id = ?').run(Date.now() - 1, id);
    expect(readPlaygroundMedia(id)).toBeNull();
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM playground_media WHERE id = ?').get(id)).toMatchObject({ n: 0 });
  });

  it('downloads with the account cookie and rejects non-image responses', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers.Cookie).toBe('__Secure-1PSID=abc');
      return new Response(PNG, { status: 200, headers: { 'Content-Type': 'image/png' } });
    });

    await expect(downloadProviderImage('https://lh3.googleusercontent.com/gg/abc', '__Secure-1PSID=abc'))
      .resolves.toMatchObject({ contentType: 'image/png' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValue(new Response('<html></html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    }));
    await expect(downloadProviderImage('https://lh3.googleusercontent.com/gg/abc', '__Secure-1PSID=abc'))
      .resolves.toBeNull();

    await expect(downloadProviderImage('https://example.com/a.png')).resolves.toBeNull();
  });

  it('upgrades http image URLs to https before fetching', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      expect(String(input)).toBe('https://lh3.googleusercontent.com/gg/a.png');
      return new Response(PNG, { status: 200, headers: { 'Content-Type': 'image/png' } });
    });

    await expect(downloadProviderImage('http://lh3.googleusercontent.com/gg/a.png'))
      .resolves.toMatchObject({ contentType: 'image/png' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(isProviderImageUrl('https://work.fife.usercontent.google.com/a.png')).toBe(true);
  });

  describe('capability route', () => {
    let server: Server;
    let origin: string;

    beforeEach(async () => {
      const app = express();
      app.use('/api/thruline/playground/media', xPlaygroundMediaRouter);
      await new Promise<void>((resolve) => {
        server = app.listen(0, '127.0.0.1', resolve);
      });
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('serves stored bytes without a session and 404s everything else', async () => {
      const id = storePlaygroundMedia(PNG, 'image/png')!;
      const ok = await fetch(`${origin}${playgroundMediaUrl(id)}`);
      expect(ok.status).toBe(200);
      expect(ok.headers.get('content-type')).toBe('image/png');
      expect(ok.headers.get('x-content-type-options')).toBe('nosniff');
      expect(Buffer.from(await ok.arrayBuffer()).equals(PNG)).toBe(true);

      expect((await fetch(`${origin}/api/thruline/playground/media/${'0'.repeat(32)}`)).status).toBe(404);
      expect((await fetch(`${origin}/api/thruline/playground/media/../../etc/passwd`)).status).toBe(404);
    });
  });
});
