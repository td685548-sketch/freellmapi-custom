import http from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { initDb } from '../../db/index.js';

describe('provider icons bundle and static caching', () => {
  let server: Server;
  let baseUrl = '';

  beforeAll(async () => {
    initDb(':memory:');
    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it('serves all provider logos in one cached JSON payload and downscales oversized PNGs', async () => {
    const res = await fetch(`${baseUrl}/api/provider-icons`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('max-age=86400');

    const etag = res.headers.get('etag');
    expect(etag).toBeTruthy();

    const data = (await res.json()) as { icons: Record<string, string> };
    expect(Object.keys(data.icons).length).toBeGreaterThan(50);
    expect(data.icons['gemini.png']).toMatch(/^data:image\/png;base64,/);

    if (data.icons['crush.png']) {
      // Original crush.png is ~773 KB (>1 MB base64); resized 64x64 data URI stays compact.
      expect(data.icons['crush.png'].length).toBeLessThan(64 * 1024);
    }

    const notModified = await fetch(`${baseUrl}/api/provider-icons`, {
      headers: { 'If-None-Match': etag! },
    });
    expect(notModified.status).toBe(304);
  });

  it('returns 404 directly for missing /providers/*.png instead of SPA index.html fallthrough', async () => {
    const res = await fetch(`${baseUrl}/providers/definitely-does-not-exist-999.png`);
    expect(res.status).toBe(404);
  });
});
