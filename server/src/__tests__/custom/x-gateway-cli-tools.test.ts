import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { Server } from 'http';
import { initDb, getDb } from '../../db/index.js';
import { createApp } from '../../app.js';
import { createUser, createSession } from '../../services/auth.js';
import { encrypt } from '../../lib/crypto.js';

describe('X Gateway CLI Tools API', () => {
  let server: Server;
  let base: string;
  let adminSessionToken: string;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');

    // Seed a provider account for testing
    const enc = encrypt('test-groq-key');
    getDb()
      .prepare(
        `INSERT INTO x_gateway_keys (provider, label, auth_method, encrypted_key, iv, auth_tag, status, enabled) VALUES ('groq', 'groq-cli-test', 'api_key', ?, ?, ?, 'healthy', 1)`
      )
      .run(enc.encrypted, enc.iv, enc.authTag);

    const admin = createUser('admin-tools@example.com', 'AdminPass123!');
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
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('GET /api/x-gateway/tools returns tools list and status', async () => {
    const res = await fetch(`${base}/api/x-gateway/tools`, {
      headers: { Authorization: `Bearer ${adminSessionToken}` },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.tools).toBeInstanceOf(Array);
    expect(data.tools.length).toBeGreaterThanOrEqual(5);
    expect(data.tools.some((t: { id: string }) => t.id === 'claude')).toBe(true);
    expect(data.tools.some((t: { id: string }) => t.id === 'codex')).toBe(true);
    expect(data.tools.some((t: { id: string }) => t.id === 'cursor')).toBe(true);
    expect(data.usableAccounts).toBeGreaterThanOrEqual(1);
  });

  it('POST /api/x-gateway/tools/test succeeds when active provider account exists', async () => {
    const res = await fetch(`${base}/api/x-gateway/tools/test`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminSessionToken}`,
      },
      body: JSON.stringify({ toolId: 'claude' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.toolId).toBe('claude');
    expect(typeof data.latencyMs).toBe('number');
    expect(data.usableAccountsCount).toBeGreaterThanOrEqual(1);
    expect(data.message).toContain('X Gateway is ready for claude');
  });

  it('POST /api/x-gateway/tools/test validates request payload', async () => {
    const res = await fetch(`${base}/api/x-gateway/tools/test`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminSessionToken}`,
      },
      body: JSON.stringify({ toolId: '' }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.ok).toBe(false);
  });

  it('requires authentication to access /api/x-gateway/tools', async () => {
    const res = await fetch(`${base}/api/x-gateway/tools`);
    expect(res.status).toBe(401);
  });
});
