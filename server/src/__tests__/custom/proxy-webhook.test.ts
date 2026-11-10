import express, { type Express } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { constantTimeEqual, proxyWebhookRouter } from '../../custom/proxy-webhook/router.js';
import * as proxyPool from '../../custom/x-gateway/proxy-pool.js';
import * as proxyLib from '../../lib/proxy.js';

describe('MiProxy Webhook & Proxy Auto-Update', () => {
  let app: Express;
  let mockEntries: proxyPool.ProxyPoolEntry[];

  beforeEach(() => {
    vi.restoreAllMocks();

    mockEntries = [
      {
        id: 1,
        name: 'Residential-US-1',
        proxyUrl: 'http://198.51.100.1:8080',
        enabled: true,
        boundAccounts: 2,
        createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: '2026-11-01T00:00:00.000Z',
        webhookEnabled: true,
        webhookToken: 'token_entry_1_abcdef1234567890',
        lastWebhookAt: 1762800000000,
        lastTestOk: true,
        lastTestLatency: 45,
        lastTestMessage: null,
        lastTestAt: '2026-11-01T00:05:00.000Z',
      },
      {
        id: 2,
        name: 'Mobile-Vietnam',
        proxyUrl: 'http://198.51.100.2:8080',
        enabled: true,
        boundAccounts: 0,
        createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: '2026-11-01T00:00:00.000Z',
        webhookEnabled: false,
        webhookToken: null,
        lastWebhookAt: 0,
        lastTestOk: null,
        lastTestLatency: null,
        lastTestMessage: null,
        lastTestAt: null,
      },
    ];

    vi.spyOn(proxyPool, 'listProxyPool').mockImplementation(() => [...mockEntries]);

    vi.spyOn(proxyPool, 'updateProxyWebhookUrl').mockImplementation((id, newUrl, timestamp) => {
      const idx = mockEntries.findIndex(e => e.id === id);
      if (idx === -1) throw new Error('Not found');
      mockEntries[idx] = {
        ...mockEntries[idx],
        proxyUrl: newUrl,
        lastWebhookAt: timestamp,
        updatedAt: new Date().toISOString(),
      };
      return mockEntries[idx];
    });

    vi.spyOn(proxyPool, 'recordProxyTestResult').mockImplementation((id, ok, latencyMs, message) => {
      const idx = mockEntries.findIndex(e => e.id === id);
      if (idx !== -1) {
        mockEntries[idx] = {
          ...mockEntries[idx],
          lastTestOk: ok,
          lastTestLatency: latencyMs,
          lastTestMessage: message ?? null,
          lastTestAt: new Date().toISOString(),
        };
      }
    });

    vi.spyOn(proxyLib, 'probeProxyUrl').mockImplementation(async (url, options) => {
      // Mock probe test without downloading or executing any external binaries (ngrok/pinggy)
      if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
        return { ok: true, latencyMs: 65, error: undefined, status: 204 };
      }
      return { ok: false, latencyMs: 0, error: 'Connection refused' };
    });

    app = express();
    app.use(express.json());
    app.use('/api/proxy-webhook', proxyWebhookRouter);

    delete process.env.PROXY_WEBHOOK_TOKEN;
    delete process.env.PROXY_WEBHOOK_TARGET_NAME;
  });

  afterEach(() => {
    delete process.env.PROXY_WEBHOOK_TOKEN;
    delete process.env.PROXY_WEBHOOK_TARGET_NAME;
  });

  async function callWebhook(path: string, body?: unknown) {
    const server = app.listen(0, '127.0.0.1');
    if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
    const address = server.address() as { port: number };

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
        method: 'POST',
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await response.text();
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
      return { status: response.status, body: json };
    } finally {
      server.close();
    }
  }

  describe('constantTimeEqual', () => {
    it('returns true for matching strings', () => {
      expect(constantTimeEqual('secret123', 'secret123')).toBe(true);
      expect(constantTimeEqual('', '')).toBe(true);
    });

    it('returns false for different length strings without timing leak', () => {
      expect(constantTimeEqual('short', 'longer_secret')).toBe(false);
      expect(constantTimeEqual('longer_secret', 'short')).toBe(false);
    });

    it('returns false for same length mismatched strings', () => {
      expect(constantTimeEqual('secret123', 'secret456')).toBe(false);
    });

    it('returns false for null or undefined values', () => {
      expect(constantTimeEqual(null, 'secret')).toBe(false);
      expect(constantTimeEqual('secret', undefined)).toBe(false);
      expect(constantTimeEqual(null, undefined)).toBe(false);
    });
  });

  describe('Authentication Gates', () => {
    it('returns 401 when token query param is missing', async () => {
      const res = await callWebhook('/api/proxy-webhook', {
        url: 'http://qnkwc-118-70-12-223.run.pinggy-free.link:41561',
        type: 'pinggy',
      });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('unauthorized');
      expect(proxyPool.updateProxyWebhookUrl).not.toHaveBeenCalled();
    });

    it('returns 401 when token is invalid', async () => {
      const res = await callWebhook('/api/proxy-webhook?token=invalid_wrong_token', {
        url: 'http://qnkwc-118-70-12-223.run.pinggy-free.link:41561',
        type: 'pinggy',
      });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('unauthorized');
      expect(proxyPool.updateProxyWebhookUrl).not.toHaveBeenCalled();
    });

    it('returns 404 when global token is valid but target proxy cannot be found', async () => {
      process.env.PROXY_WEBHOOK_TOKEN = 'global_super_secret_token';
      const res = await callWebhook('/api/proxy-webhook?token=global_super_secret_token&id=9999', {
        url: 'http://qnkwc-118-70-12-223.run.pinggy-free.link:41561',
        type: 'pinggy',
      });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('not_found');
    });
  });

  describe('Request Body Validation', () => {
    it('returns 400 when body is not an object', async () => {
      const res = await callWebhook('/api/proxy-webhook?token=token_entry_1_abcdef1234567890', [1, 2, 3]);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_body');
    });

    it('returns 400 when proxy URL is missing or does not start with http:// or https://', async () => {
      const res = await callWebhook('/api/proxy-webhook?token=token_entry_1_abcdef1234567890', {
        url: 'ftp://bad-proxy:8080',
        type: 'manual',
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_url');
    });

    it('returns 400 when proxy URL hostname is malformed', async () => {
      const res = await callWebhook('/api/proxy-webhook?token=token_entry_1_abcdef1234567890', {
        url: 'http://:8080',
        type: 'manual',
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_url');
    });

    it('returns 400 when timestamp is non-numeric', async () => {
      const res = await callWebhook('/api/proxy-webhook?token=token_entry_1_abcdef1234567890', {
        url: 'http://qnkwc-118-70-12-223.run.pinggy-free.link:41561',
        timestamp: 'invalid-time',
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_timestamp');
    });
  });

  describe('Outdated Timestamp & Overwrite Protection', () => {
    it('ignores outdated payload when timestamp is older than last_webhook_at without failing', async () => {
      // Entry 1 has lastWebhookAt = 1762800000000
      const oldTimestamp = 1762800000000 - 50000;
      const res = await callWebhook('/api/proxy-webhook?token=token_entry_1_abcdef1234567890', {
        url: 'http://old-tunnel.run.pinggy-free.link:41561',
        type: 'pinggy',
        timestamp: oldTimestamp,
      });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.ignored).toBe(true);
      expect(res.body.reason).toBe('Outdated timestamp');
      // Should not update URL in pool
      expect(proxyPool.updateProxyWebhookUrl).not.toHaveBeenCalled();
    });
  });

  describe('Successful Webhook Updates & Probing', () => {
    it('updates proxy via per-proxy token, runs forward proxy probe and records test status', async () => {
      const newTimestamp = 1762800000000 + 100000;
      const newUrl = 'http://qnkwc-118-70-12-223.run.pinggy-free.link:41561';

      const res = await callWebhook('/api/proxy-webhook?token=token_entry_1_abcdef1234567890', {
        url: newUrl,
        type: 'pinggy',
        timestamp: newTimestamp,
      });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.id).toBe(1);
      expect(res.body.name).toBe('Residential-US-1');
      expect(res.body.type).toBe('pinggy');
      expect(res.body.test.ok).toBe(true);
      expect(res.body.test.latencyMs).toBe(65);

      expect(proxyPool.updateProxyWebhookUrl).toHaveBeenCalledWith(1, newUrl, newTimestamp);
      expect(proxyLib.probeProxyUrl).toHaveBeenCalledWith(newUrl, {
        targetUrl: 'https://www.gstatic.com/generate_204',
        timeoutMs: 10_000,
        mode: 'forward',
      });
      expect(proxyPool.recordProxyTestResult).toHaveBeenCalledWith(1, true, 65, null);
    });

    it('updates proxy via global token targeting by name', async () => {
      process.env.PROXY_WEBHOOK_TOKEN = 'global_auth_secret_999';
      const newUrl = 'http://mobile-proxy.run.pinggy-free.link:38888';
      const newTimestamp = Date.now();

      const res = await callWebhook('/api/proxy-webhook?token=global_auth_secret_999&target=Mobile-Vietnam', {
        url: newUrl,
        type: 'manual',
        timestamp: newTimestamp,
      });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.id).toBe(2);
      expect(res.body.name).toBe('Mobile-Vietnam');
      expect(proxyPool.updateProxyWebhookUrl).toHaveBeenCalledWith(2, newUrl, newTimestamp);
    });

    it('is idempotent when sending identical proxy url multiple times', async () => {
      const url = 'http://same-tunnel.run.pinggy-free.link:41561';
      const ts1 = 1762800000000 + 200000;
      const ts2 = 1762800000000 + 200001;

      const res1 = await callWebhook('/api/proxy-webhook?token=token_entry_1_abcdef1234567890', {
        url,
        type: 'manual',
        timestamp: ts1,
      });
      expect(res1.status).toBe(200);
      expect(res1.body.ok).toBe(true);

      const res2 = await callWebhook('/api/proxy-webhook?token=token_entry_1_abcdef1234567890', {
        url,
        type: 'manual',
        timestamp: ts2,
      });
      expect(res2.status).toBe(200);
      expect(res2.body.ok).toBe(true);
    });
  });
});
