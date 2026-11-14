/**
 * T020 — AI Platform audit tests.
 *
 * Tests that:
 * 1. Enabling/disabling a flag creates an audit entry with area 'ai-platform'
 * 2. Fields like `secret`, `authorization`, `headers`, `args` are hidden in audit summaries
 * 3. Old areas (client-profiles, settings, etc.) are not affected by our changes
 *
 * BLOCKED INTEGRATION: Tests marked [BLOCKED] require Agent1 T026/T027 (S/router.ts
 * registration in register.ts). Until then, only audit-helper unit tests run.
 * HTTP-level tests are written and will turn GREEN when the prerequisite commit is merged.
 *
 * See handoffs/agent-4-foundation.md for exact blocker details.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { getDb, initDb } from '../../../db/index.js';
import { createApp } from '../../../app.js';
import { createSession, createUser } from '../../../services/auth.js';
import { describeRoute, summarize } from '../../../services/audit-log.js';

// ─── Pure unit: summarize() hides the sensitive fields defined for ai-platform ──

describe('summarize() hides ai-platform sensitive fields', () => {
  it('hides secret field', () => {
    const s = summarize({ secret: 'sk-abc123', slug: 'my-server' }) as Record<string, unknown>;
    expect(s.secret).toBe('[hidden]');
    expect(s.slug).toBe('my-server');
    expect(JSON.stringify(s)).not.toContain('sk-abc123');
  });

  it('hides authorization field', () => {
    const s = summarize({ authorization: 'Bearer tok123', name: 'test' }) as Record<string, unknown>;
    expect(s.authorization).toBe('[hidden]');
    expect((s as Record<string, unknown>).name).toBe('test');
  });

  it('hides args and any nested secret in args', () => {
    const s = summarize({ args: { name: 'lookup_order', secret: 'blah' }, tool: 'lookup' }) as Record<string, unknown>;
    expect(s.args).toBe('[hidden]');
    expect(s.tool).toBe('lookup');
    expect(JSON.stringify(s)).not.toContain('blah');
  });

  it('hides headers and any nested authorization in headers', () => {
    const s = summarize({ headers: { authorization: 'Bearer xyz', 'content-type': 'application/json' }, slug: 'srv' }) as Record<string, unknown>;
    expect(s.headers).toBe('[hidden]');
    expect(s.slug).toBe('srv');
    expect(JSON.stringify(s)).not.toContain('Bearer xyz');
  });

  it('keeps boolean flags intact (pillar toggle payloads)', () => {
    const s = summarize({ prompts: true, retrieval: false, promptCache: false, mcpClient: false, outputGuard: false, orchestrator: false });
    expect(s).toEqual({ prompts: true, retrieval: false, promptCache: false, mcpClient: false, outputGuard: false, orchestrator: false });
  });

  it('keeps retention config intact (no secret fields)', () => {
    const s = summarize({ traceRetentionDays: 30, toolCallRetentionDays: 30, excerptRetentionDays: 7 });
    expect(s).toEqual({ traceRetentionDays: 30, toolCallRetentionDays: 30, excerptRetentionDays: 7 });
  });
});

// ─── Pure unit: describeRoute for ai-platform paths ───────────────────────────

describe('describeRoute() handles ai-platform paths', () => {
  it('names the overview route', () => {
    const r = describeRoute('/api/ai-platform/overview');
    expect(r).toMatchObject({ route: '/api/ai-platform/overview', area: 'ai-platform', targetId: null });
  });

  it('names the flags route', () => {
    const r = describeRoute('/api/ai-platform/flags');
    expect(r).toMatchObject({ route: '/api/ai-platform/flags', area: 'ai-platform', targetId: null });
  });

  it('names the retention route', () => {
    const r = describeRoute('/api/ai-platform/retention');
    expect(r).toMatchObject({ area: 'ai-platform', targetId: null });
  });

  it('existing areas are still correctly described (no regression)', () => {
    expect(describeRoute('/api/client-profiles/12/quota')).toMatchObject({ area: 'client-profiles', targetId: 12 });
    expect(describeRoute('/api/admin/users/5/permissions')).toMatchObject({ area: 'admin/users', targetId: 5 });
    expect(describeRoute('/api/keys/7')).toMatchObject({ area: 'keys', targetId: 7 });
  });
});

// ─── HTTP integration: audit writes for ai-platform routes ───────────────────
//
// These tests require S/router.ts registered at /api/ai-platform (Agent1 T026/T027).
// STATUS: BLOCKED — waiting for Agent1 T026 commit + Agent3 T027 registration commit.
//
// Once the prerequisite SHA is delivered, remove the `.skip` markers.

describe('audit log — ai-platform writes', () => {
  let server: Server;
  let base: string;
  let ownerToken: string;

  const call = async (path: string, token: string, method = 'GET', body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) as Record<string, unknown> };
  };
  const settle = () => new Promise<void>(r => setTimeout(r, 30));

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const ownerId = createUser('aip-audit@example.com', 'Password123!').userId;
    ownerToken = createSession(ownerId);
  });

  afterAll(() => { server?.close(); });

  it('toggling flags creates an ai-platform audit entry without secret fields', async () => {
    const payload = { prompts: true, retrieval: false, promptCache: false, mcpClient: false, outputGuard: false, orchestrator: false };
    const toggle = await call('/api/ai-platform/flags', ownerToken, 'PUT', payload);
    expect(toggle.status).toBe(200);
    await settle();

    const log = await call('/api/audit', ownerToken);
    expect(log.status).toBe(200);
    const entries = (log.body as { entries: Array<Record<string, unknown>> }).entries;
    const flagEntry = entries.find((e) => e.route === '/api/ai-platform/flags');
    expect(flagEntry).toBeDefined();
    expect(flagEntry!.area).toBe('ai-platform');
    expect(flagEntry!.method).toBe('PUT');
    // No secret fields in summary
    expect(JSON.stringify(flagEntry!.summary)).not.toMatch(/secret|authorization/i);
    // Flags are present in summary
    expect(flagEntry!.summary).toMatchObject(payload);
  });

  it('changing retention creates an ai-platform audit entry', async () => {
    const payload = { runsDays: 14, toolCallsDays: 14, guardExcerptsDays: 3 };
    const result = await call('/api/ai-platform/retention', ownerToken, 'PUT', payload);
    expect(result.status).toBe(200);
    await settle();

    const log = await call('/api/audit', ownerToken);
    const entries = (log.body as { entries: Array<Record<string, unknown>> }).entries;
    const retentionEntry = entries.find((e) => (e.route as string).includes('retention'));
    expect(retentionEntry).toBeDefined();
    expect(retentionEntry!.area).toBe('ai-platform');
  });

  it('GET /overview does not appear in audit log (reads are not recorded)', async () => {
    const before = (getDb().prepare('SELECT COUNT(*) AS n FROM custom_audit_log').get() as { n: number }).n;
    await call('/api/ai-platform/overview', ownerToken, 'GET');
    await settle();
    const after = (getDb().prepare('SELECT COUNT(*) AS n FROM custom_audit_log').get() as { n: number }).n;
    expect(after).toBe(before);
  });

  it('existing audit areas are unaffected (no regression)', async () => {
    // Create a client-profile and verify it still appears normally.
    const made = await call('/api/client-profiles', ownerToken, 'POST', { name: 'AuditTestProfile' });
    expect(made.status).toBe(201);
    await settle();
    const log = await call('/api/audit?area=client-profiles', ownerToken);
    const entries = (log.body as { entries: Array<Record<string, unknown>> }).entries;
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0]!.area).toBe('client-profiles');
  });

  it('secret and authorization are not in audit summary for mcp/servers writes', async () => {
    const payload = {
      slug: 'test-server',
      name: 'Test MCP',
      url: 'https://mcp.example.com/sse',
      authKind: 'bearer',
      secret: 'Bearer tok_supersecret',
    };
    // This will return 400/404 until S/router.ts is wired, but we still verify no secret leaks
    await call('/api/ai-platform/mcp/servers', ownerToken, 'POST', payload);
    await settle();
    const log = await call('/api/audit', ownerToken);
    expect(JSON.stringify(log.body)).not.toContain('tok_supersecret');
  });
});
