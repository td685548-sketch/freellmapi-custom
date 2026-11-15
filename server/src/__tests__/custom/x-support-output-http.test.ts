import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { request as httpRequest, type Server } from 'node:http';
import { gzipSync } from 'node:zlib';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { createSession, createUser } from '../../services/auth.js';
import { setEnabled } from '../../custom/x-gateway/config.js';
import { createSupportTenant, type SupportTenant } from '../../custom/x-gateway/support-store.js';
import { appendSupportOutputEvent } from '../../custom/x-gateway/support-output-store.js';

describe('Support Output Controls HTTP Integration (Spec 020)', () => {
  let server: Server | undefined;
  let base: string;
  let tenantA: SupportTenant;
  let tenantB: SupportTenant;
  let adminToken: string;
  let editorToken: string;
  let viewerOnlyToken: string;
  let editOnlyToken: string;

  function createConsoleUserToken(email: string, permissions: string[]): string {
    const created = createUser(email, 'Pass123456!', 'member');
    getDb()
      .prepare('UPDATE users SET permissions = ? WHERE id = ?')
      .run(JSON.stringify(permissions), created.userId);
    return createSession(created.userId);
  }

  async function requestJson(
    path: string,
    options: { method?: string; token?: string; body?: unknown; rawBody?: string } = {},
  ) {
    const headers: Record<string, string> = {};
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    if (options.body !== undefined || options.rawBody !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(`${base}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.rawBody ?? (options.body !== undefined ? JSON.stringify(options.body) : undefined),
    });
    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
    }
    return { status: res.status, json };
  }

  beforeEach(async () => {
    server = undefined;
    vi.stubEnv('ENCRYPTION_KEY', '0'.repeat(64));
    initDb(':memory:');
    setEnabled(true);

    const primary = createUser('admin@output020.test', 'AdminPass123!');
    adminToken = createSession(primary.userId);
    editorToken = createConsoleUserToken('editor@output020.test', ['use_x_gateway', 'edit_x_settings']);
    viewerOnlyToken = createConsoleUserToken('viewer@output020.test', ['use_x_gateway']);
    editOnlyToken = createConsoleUserToken('editonly@output020.test', ['edit_x_settings']);

    tenantA = createSupportTenant({
      name: 'Tenant A',
      defaultModel: 'test-model',
      allowedOrigins: ['https://partner.example'],
    }).tenant;
    tenantB = createSupportTenant({
      name: 'Tenant B',
      defaultModel: 'test-model',
      allowedOrigins: ['https://other.example'],
    }).tenant;

    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    try {
      if (server && server.listening) {
        await new Promise<void>((resolve, reject) =>
          server!.close((err) => (err ? reject(err) : resolve())),
        );
      }
    } finally {
      server = undefined;
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  });

  it('rejects unauthenticated requests with 401 across all output endpoints and HEAD', async () => {
    const checks = [
      requestJson(`/api/thruline/support/tenants/${tenantA.id}/output-policy`, { method: 'GET' }),
      requestJson(`/api/thruline/support/tenants/${tenantA.id}/output-policy`, { method: 'HEAD' }),
      requestJson(`/api/thruline/support/tenants/${tenantA.id}/output-policy`, {
        method: 'PUT',
        body: {
          expectedVersion: 0,
          policy: { mode: 'off', blockedTerms: [], maxOutputChars: 16000, redactCredentials: false },
        },
      }),
      requestJson(`/api/thruline/support/tenants/${tenantA.id}/output-policy/preview`, {
        method: 'POST',
        body: {
          policy: { mode: 'enforce', blockedTerms: [], maxOutputChars: 16000, redactCredentials: false },
          text: 'hello',
        },
      }),
      requestJson(`/api/thruline/support/tenants/${tenantA.id}/output-events`, { method: 'GET' }),
    ];

    const results = await Promise.all(checks);
    for (const res of results) {
      expect(res.status).toBe(401);
    }
  });

  it('enforces editor-only permissions including case and trailing-slash variants', async () => {
    const restrictedPaths = [
      { method: 'GET', path: `/api/thruline/support/tenants/${tenantA.id}/output-policy` },
      { method: 'HEAD', path: `/api/thruline/support/tenants/${tenantA.id}/output-policy` },
      { method: 'GET', path: `/api/thruline/Support/Tenants/${tenantA.id}/Output-Policy/` },
      { method: 'HEAD', path: `/api/thruline/SUPPORT/tenants/${tenantA.id}/output-policy/` },
      { method: 'GET', path: `/api/thruline/support/tenants/${tenantA.id}/output-events?limit=10` },
      { method: 'GET', path: `/api/thruline/Support/Tenants/${tenantA.id}/Output-Events/` },
      {
        method: 'PUT',
        path: `/api/thruline/Support/Tenants/${tenantA.id}/Output-Policy/`,
        body: {
          expectedVersion: 0,
          policy: { mode: 'log', blockedTerms: [], maxOutputChars: 16000, redactCredentials: false },
        },
      },
      {
        method: 'POST',
        path: `/api/thruline/support/tenants/${tenantA.id}/output-policy/preview/`,
        body: {
          policy: { mode: 'enforce', blockedTerms: [], maxOutputChars: 16000, redactCredentials: false },
          text: 'hello',
        },
      },
    ];

    for (const token of [viewerOnlyToken, editOnlyToken]) {
      for (const reqCase of restrictedPaths) {
        const res = await requestJson(reqCase.path, {
          method: reqCase.method,
          token,
          body: reqCase.body,
        });
        expect(res.status).toBe(403);
      }
    }

    const okGet = await requestJson(`/api/thruline/support/tenants/${tenantA.id}/output-policy`, {
      token: editorToken,
    });
    expect(okGet.status).toBe(200);

    const adminGet = await requestJson(`/api/thruline/support/tenants/${tenantA.id}/output-policy`, {
      token: adminToken,
    });
    expect(adminGet.status).toBe(200);
  });

  it('returns 404 for unknown tenant and 400 for strict schema or query violations', async () => {
    const notFound = await requestJson('/api/thruline/support/tenants/999999/output-policy', {
      token: editorToken,
    });
    expect(notFound.status).toBe(404);

    const invalidCases = [
      // Unknown top-level field
      {
        method: 'PUT',
        path: `/api/thruline/support/tenants/${tenantA.id}/output-policy`,
        body: {
          expectedVersion: 0,
          extra: true,
          policy: { mode: 'off', blockedTerms: [], maxOutputChars: 16000, redactCredentials: false },
        },
      },
      // Client-supplied tenantId/version in nested policy
      {
        method: 'PUT',
        path: `/api/thruline/support/tenants/${tenantA.id}/output-policy`,
        body: {
          expectedVersion: 0,
          policy: {
            tenantId: tenantB.id,
            version: 9,
            mode: 'off',
            blockedTerms: [],
            maxOutputChars: 16000,
            redactCredentials: false,
          },
        },
      },
      // Non-integer maxOutputChars
      {
        method: 'PUT',
        path: `/api/thruline/support/tenants/${tenantA.id}/output-policy`,
        body: {
          expectedVersion: 0,
          policy: { mode: 'off', blockedTerms: [], maxOutputChars: 1000.5, redactCredentials: false },
        },
      },
      // Duplicate normalized term
      {
        method: 'PUT',
        path: `/api/thruline/support/tenants/${tenantA.id}/output-policy`,
        body: {
          expectedVersion: 0,
          policy: {
            mode: 'enforce',
            blockedTerms: [
              { id: 'r1', text: 'Secret Token' },
              { id: 'r2', text: '  secret   token ' },
            ],
            maxOutputChars: 16000,
            redactCredentials: false,
          },
        },
      },
      // Invalid preview nested metadata
      {
        method: 'POST',
        path: `/api/thruline/support/tenants/${tenantA.id}/output-policy/preview`,
        body: {
          policy: {
            version: 5,
            mode: 'enforce',
            blockedTerms: [],
            maxOutputChars: 16000,
            redactCredentials: false,
          },
          text: 'hello',
        },
      },
      // Invalid events limit
      {
        method: 'GET',
        path: `/api/thruline/support/tenants/${tenantA.id}/output-events?limit=101`,
      },
      // Invalid events query param
      {
        method: 'GET',
        path: `/api/thruline/support/tenants/${tenantA.id}/output-events?raw=true`,
      },
    ];

    for (const c of invalidCases) {
      const res = await requestJson(c.path, { method: c.method, token: editorToken, body: c.body });
      expect(res.status).toBe(400);
      expect((res.json as { error: { code: string } }).error.code).toBe('invalid_input');
    }
  });

  it('rejects oversized request bodies (> 256 KiB) with 413', async () => {
    const oversizedText = 'a'.repeat(270 * 1024);
    const res = await requestJson(`/api/thruline/support/tenants/${tenantA.id}/output-policy/preview`, {
      method: 'POST',
      token: editorToken,
      body: {
        policy: { mode: 'enforce', blockedTerms: [], maxOutputChars: 16000, redactCredentials: false },
        text: oversizedText,
      },
    });
    expect(res.status).toBe(413);
    expect((res.json as { error: { code: string } }).error.code).toBe('payload_too_large');
  });

  it('saves policy with OCC and returns 409 output_policy_conflict on stale expectedVersion', async () => {
    const initial = await requestJson(`/api/thruline/support/tenants/${tenantA.id}/output-policy`, {
      token: editorToken,
    });
    expect(initial.status).toBe(200);
    expect((initial.json as { policy: { version: number; mode: string } }).policy.version).toBe(0);
    expect((initial.json as { policy: { mode: string } }).policy.mode).toBe('off');

    const saved = await requestJson(`/api/thruline/support/tenants/${tenantA.id}/output-policy`, {
      method: 'PUT',
      token: editorToken,
      body: {
        expectedVersion: 0,
        policy: {
          mode: 'enforce',
          blockedTerms: [{ id: 'rule-1', text: 'internal-secret' }],
          maxOutputChars: 8000,
          redactCredentials: true,
        },
      },
    });
    expect(saved.status).toBe(200);
    expect((saved.json as { policy: { version: number } }).policy.version).toBe(1);

    const conflict = await requestJson(`/api/thruline/support/tenants/${tenantA.id}/output-policy`, {
      method: 'PUT',
      token: editorToken,
      body: {
        expectedVersion: 0,
        policy: {
          mode: 'log',
          blockedTerms: [],
          maxOutputChars: 16000,
          redactCredentials: false,
        },
      },
    });
    expect(conflict.status).toBe(409);
    expect((conflict.json as { error: { code: string } }).error.code).toBe('output_policy_conflict');
  });

  it('evaluates unsaved preview policy without persisting policy or events, and omits raw text on block', async () => {
    const sentinel = 'RAW_SENTINEL_DO_NOT_ECHO_991';
    const preview = await requestJson(`/api/thruline/support/tenants/${tenantA.id}/output-policy/preview`, {
      method: 'POST',
      token: editorToken,
      body: {
        policy: {
          mode: 'enforce',
          blockedTerms: [{ id: 'rule-sentinel', text: sentinel }],
          maxOutputChars: 16000,
          redactCredentials: false,
        },
        text: `Customer reply containing ${sentinel} inside.`,
      },
    });
    expect(preview.status).toBe(200);
    const body = preview.json as {
      ok: boolean;
      decision: { action: string; leaves: unknown[]; reasons: string[]; ruleIds: string[] };
    };
    expect(body.ok).toBe(true);
    expect(body.decision.action).toBe('block');
    expect(body.decision.leaves).toEqual([]);
    expect(body.decision.reasons).toContain('blocked_term');
    expect(body.decision.ruleIds).toEqual(['rule-sentinel']);
    expect(JSON.stringify(preview.json)).not.toContain(sentinel);

    // Policy remains default off (not persisted by preview)
    const policyAfter = await requestJson(`/api/thruline/support/tenants/${tenantA.id}/output-policy`, {
      token: editorToken,
    });
    expect((policyAfter.json as { policy: { version: number; mode: string } }).policy.version).toBe(0);
    expect((policyAfter.json as { policy: { mode: string } }).policy.mode).toBe('off');

    // No event emitted by preview
    const eventsAfter = await requestJson(`/api/thruline/support/tenants/${tenantA.id}/output-events`, {
      token: editorToken,
    });
    expect((eventsAfter.json as { items: unknown[] }).items).toEqual([]);
  });

  it('lists metadata-only output events with keyset pagination and tenant isolation', async () => {
    appendSupportOutputEvent({
      tenantId: tenantA.id,
      operationId: 'op-a-1',
      surface: 'chat',
      policyVersion: 1,
      action: 'block',
      reasons: ['blocked_term'],
      ruleIds: ['r1'],
      redactionCount: 0,
    });
    appendSupportOutputEvent({
      tenantId: tenantA.id,
      operationId: 'op-a-2',
      surface: 'copilot',
      policyVersion: 1,
      action: 'redact',
      reasons: ['credential'],
      ruleIds: [],
      redactionCount: 2,
    });
    appendSupportOutputEvent({
      tenantId: tenantB.id,
      operationId: 'op-b-1',
      surface: 'chat',
      policyVersion: 1,
      action: 'observe',
      reasons: ['too_long'],
      ruleIds: [],
      redactionCount: 0,
    });

    const page1 = await requestJson(`/api/thruline/support/tenants/${tenantA.id}/output-events?limit=1`, {
      token: editorToken,
    });
    expect(page1.status).toBe(200);
    const p1 = page1.json as {
      ok: boolean;
      items: Array<{ operationId: string; tenantId: number }>;
      nextCursor?: string;
    };
    expect(p1.items).toHaveLength(1);
    expect(p1.items[0]!.tenantId).toBe(tenantA.id);
    expect(p1.nextCursor).toBeTruthy();

    const page2 = await requestJson(
      `/api/thruline/support/tenants/${tenantA.id}/output-events?limit=1&before=${encodeURIComponent(p1.nextCursor!)}`,
      { token: editorToken },
    );
    expect(page2.status).toBe(200);
    const p2 = page2.json as { items: Array<{ operationId: string; tenantId: number }> };
    expect(p2.items).toHaveLength(1);
    expect(p2.items[0]!.operationId).not.toBe(p1.items[0]!.operationId);
    expect(p2.items[0]!.operationId).not.toBe('op-b-1');
  });
  it('enforces byte cap before attempting JSON parsing', async()=>{
    const result=await requestJson('/api/thruline/support/tenants/'+tenantA.id+'/output-policy/preview',{method:'POST',token:editorToken,rawBody:' '.repeat(300000)+'{not-json'});
    expect(result.status).toBe(413);
  });

  it('caps chunked and inflated JSON before global parsing on case-insensitive routes', async () => {
    const path = '/api/thruline/Support/Tenants/' + tenantA.id + '/Output-Policy/preview/';
    const bytes = ' '.repeat(300000) + '{not-json';
    const chunkedStatus = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(base + path, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + editorToken, 'Content-Type': 'application/json' },
      }, res => {
        res.resume();
        res.once('end', () => resolve(res.statusCode!));
      });
      req.once('error', reject);
      req.write(bytes.slice(0, 200000));
      req.end(bytes.slice(200000));
    });
    expect(chunkedStatus).toBe(413);

    const compressed = gzipSync(bytes);
    expect(compressed.byteLength).toBeLessThan(256 * 1024);
    const inflated = await fetch(base + path, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + editorToken,
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
      },
      body: compressed,
    });
    expect(inflated.status).toBe(413);
    expect(await inflated.json()).toMatchObject({ error: { code: 'payload_too_large' } });
  });

  it('returns safe JSON errors and still accepts small chunked requests', async () => {
    const path = '/api/thruline/support/tenants/' + tenantA.id + '/output-policy/preview';
    const invalid = await requestJson(path, { method: 'POST', token: editorToken, rawBody: '{not-json' });
    expect(invalid).toEqual({ status: 400, json: { error: { code: 'invalid_input', message: 'Invalid JSON request body.' } } });
    const body = JSON.stringify({
      policy: { mode: 'off', blockedTerms: [], maxOutputChars: 16000, redactCredentials: false },
      text: 'Small preview',
    });
    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest(base + path, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + editorToken, 'Content-Type': 'application/json' },
      }, res => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode!, body: text }));
      });
      req.once('error', reject);
      req.write(body.slice(0, 20));
      req.end(body.slice(20));
    });
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({ ok: true, decision: { action: 'allow' } });
  });
});
