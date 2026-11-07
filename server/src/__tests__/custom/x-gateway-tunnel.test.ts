import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'http';
import { initDb, getDb } from '../../db/index.js';
import { createApp } from '../../app.js';
import { createUser, createSession } from '../../services/auth.js';
import { encrypt } from '../../lib/crypto.js';
import { tunnelService } from '../../custom/x-gateway/tunnel-service.js';

describe('X Gateway Quick Tunnel Service', () => {
  beforeEach(() => {
    process.env.CLOUDFLARED_MOCK = 'true';
    tunnelService.resetForTesting();
  });

  afterAll(() => {
    delete process.env.CLOUDFLARED_MOCK;
    tunnelService.resetForTesting();
  });

  it('reports initial stopped state', () => {
    const status = tunnelService.getStatus();
    expect(status.state).toBe('stopped');
    expect(status.url).toBeNull();
    expect(status.uptimeSeconds).toBe(0);
    expect(status.cloudflaredInstalled).toBe(true);
  });

  it('starts and provides a public trycloudflare URL in mock mode', async () => {
    const status = await tunnelService.start(3001);
    expect(status.state).toBe('active');
    expect(status.url).toMatch(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    expect(status.port).toBe(3001);
    expect(status.startedAt).toBeGreaterThan(0);
  });

  it('stops cleanly and resets public URL', async () => {
    await tunnelService.start(3001);
    const stopped = tunnelService.stop();
    expect(stopped.state).toBe('stopped');
    expect(stopped.url).toBeNull();
  });

  it('records logs into the rolling ring buffer', async () => {
    await tunnelService.start(3001);
    const logs = tunnelService.getLogs();
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.some((l) => l.includes('Cloudflare Quick Tunnel'))).toBe(true);
  });
});

describe('X Gateway Tunnel Console Router API', () => {
  let server: Server;
  let base: string;
  let adminSessionToken: string;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    process.env.CLOUDFLARED_MOCK = 'true';
    initDb(':memory:');

    const enc = encrypt('test-key-val');
    getDb()
      .prepare(
        `INSERT INTO x_gateway_keys (provider, label, auth_method, encrypted_key, iv, auth_tag, status, enabled) VALUES ('openai', 'test-openai', 'api_key', ?, ?, ?, 'healthy', 1)`
      )
      .run(enc.encrypted, enc.iv, enc.authTag);

    const admin = createUser('admin-tunnel@example.com', 'AdminPass123!');
    adminSessionToken = createSession(admin.userId);

    const app = createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          base = `http://localhost:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    delete process.env.CLOUDFLARED_MOCK;
    tunnelService.resetForTesting();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    tunnelService.resetForTesting();
  });

  it('GET /api/x-gateway/tunnel/status returns current tunnel status', async () => {
    const res = await fetch(`${base}/api/x-gateway/tunnel/status`, {
      headers: { Authorization: `Bearer ${adminSessionToken}` },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.state).toBe('stopped');
    expect(data.cloudflaredInstalled).toBe(true);
  });

  it('POST /api/x-gateway/tunnel/start starts the tunnel', async () => {
    const res = await fetch(`${base}/api/x-gateway/tunnel/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminSessionToken}`,
      },
      body: JSON.stringify({ port: 3001 }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.state).toBe('active');
    expect(data.url).toContain('.trycloudflare.com');
  });

  it('GET /api/x-gateway/tunnel/logs returns log lines', async () => {
    await tunnelService.start(3001);
    const res = await fetch(`${base}/api/x-gateway/tunnel/logs`, {
      headers: { Authorization: `Bearer ${adminSessionToken}` },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.logs)).toBe(true);
    expect(data.logs.length).toBeGreaterThan(0);
  });

  it('POST /api/x-gateway/tunnel/stop stops the active tunnel', async () => {
    await tunnelService.start(3001);
    const res = await fetch(`${base}/api/x-gateway/tunnel/stop`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminSessionToken}` },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.state).toBe('stopped');
    expect(data.url).toBeNull();
  });
});
