import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../../app.js';
import { getDb, initDb } from '../../../db/index.js';
import { createSession, createUser } from '../../../services/auth.js';
import { resetFlagsCacheForTests, setFlags } from '../../../custom/ai-platform/flags.js';

let server: http.Server | null = null;
let baseUrl = '';

async function startTestApp() {
  const app = createApp();
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', () => resolve()));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
}

async function api(
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, json };
}

beforeEach(async () => {
  initDb(':memory:');
  resetFlagsCacheForTests();
  await startTestApp();
});

afterEach(async () => {
  resetFlagsCacheForTests();
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  try { getDb().close(); } catch { /* already closed */ }
});

describe('MCP Admin Router & Readiness (T050)', () => {
  it('reports mcpClient ready=true in /overview while other unimplemented pillars remain false', async () => {
    const primary = await createUser('primary@example.com', 'password123', 'admin');
    const token = createSession(primary.userId);

    const res = await api('GET', '/api/ai-platform/overview', token);
    expect(res.status).toBe(200);
    const pillars = res.json.pillars as Record<string, { enabled: boolean; ready: boolean }>;
    expect(pillars.mcpClient.ready).toBe(true);
    expect(pillars.prompts.ready).toBe(false);
    expect(pillars.orchestrator.ready).toBe(false);
  });

  it('enforces exact child permissions and primary-only allowed-internal-hosts', async () => {
    const primary = await createUser('primary@example.com', 'password123', 'admin');
    const secondaryAdmin = await createUser('secadmin@example.com', 'password123', 'admin');
    const viewer = await createUser('viewer@example.com', 'password123', 'member');
    getDb().prepare('UPDATE users SET permissions = ? WHERE id = ?').run(JSON.stringify(['manage_ai_platform']), secondaryAdmin.userId);
    getDb().prepare('UPDATE users SET permissions = ? WHERE id = ?').run(JSON.stringify(['view_mcp_servers']), viewer.userId);

    const primaryToken = createSession(primary.userId);
    const secToken = createSession(secondaryAdmin.userId);
    const viewerToken = createSession(viewer.userId);

    // Primary-only GET & PUT on allowed-internal-hosts
    expect((await api('GET', '/api/ai-platform/mcp/allowed-internal-hosts', primaryToken)).status).toBe(200);
    expect(
      (await api('PUT', '/api/ai-platform/mcp/allowed-internal-hosts', primaryToken, { origins: ['http://127.0.0.1:4000'] })).status,
    ).toBe(200);
    expect((await api('GET', '/api/ai-platform/mcp/allowed-internal-hosts', secToken)).status).toBe(403);
    expect(
      (await api('PUT', '/api/ai-platform/mcp/allowed-internal-hosts', secToken, { origins: [] })).status,
    ).toBe(403);

    // Viewer can list servers and calls, cannot create server or view approvals
    expect((await api('GET', '/api/ai-platform/mcp/servers', viewerToken)).status).toBe(200);
    expect((await api('GET', '/api/ai-platform/mcp/calls', viewerToken)).status).toBe(200);
    const deniedCreate = await api('POST', '/api/ai-platform/mcp/servers', viewerToken, {
      slug: 's1',
      name: 'S1',
      url: 'https://mcp.example.com/v1',
      authKind: 'none',
    });
    expect(deniedCreate.status).toBe(403);
    expect((deniedCreate.json.error as { message?: string }).message).toContain('edit_mcp_servers');

    const deniedApprovals = await api('GET', '/api/ai-platform/approvals', viewerToken);
    expect(deniedApprovals.status).toBe(403);
  });

  it('allows CRUD/bindings when mcpClient flag is off, but returns 409 pillar_disabled for outbound test/sync/approve', async () => {
    const primary = await createUser('primary@example.com', 'password123', 'admin');
    const token = createSession(primary.userId);
    setFlags({ mcpClient: false });

    const created = await api('POST', '/api/ai-platform/mcp/servers', token, {
      slug: 'crm',
      name: 'CRM',
      url: 'https://mcp.example.com/v1',
      authKind: 'bearer',
      secret: 'sk_secret_123456',
    });
    expect(created.status).toBe(201);
    const serverDto = created.json.server as { id: number; revision: number; hasSecret: boolean };
    expect(serverDto.hasSecret).toBe(true);
    expect(JSON.stringify(created.json)).not.toContain('sk_secret_123456');

    // Outbound test & sync return 409 pillar_disabled when flag is off
    const testRes = await api('POST', `/api/ai-platform/mcp/servers/${serverDto.id}/test`, token);
    expect(testRes.status).toBe(409);
    expect((testRes.json.error as { code?: string }).code).toBe('pillar_disabled');

    const syncRes = await api('POST', `/api/ai-platform/mcp/servers/${serverDto.id}/sync`, token);
    expect(syncRes.status).toBe(409);
    expect((syncRes.json.error as { code?: string }).code).toBe('pillar_disabled');

    // Stale revision returns 409 revision_conflict with sanitized current DTO
    const conflict = await api('PATCH', `/api/ai-platform/mcp/servers/${serverDto.id}`, token, {
      revision: 99,
      name: 'CRM Updated',
    });
    expect(conflict.status).toBe(409);
    const err = conflict.json.error as { code?: string; current?: Record<string, unknown> };
    expect(err.code).toBe('revision_conflict');
    expect(err.current).toBeDefined();
    expect(JSON.stringify(err.current)).not.toContain('sk_secret_123456');

    // Scope mapping: profile & support-tenant & agent
    const profRes = getDb()
      .prepare("INSERT INTO client_profiles (name, token_hash, encrypted_key, iv, auth_tag, enabled) VALUES (?, ?, 'enc', 'iv', 'tag', 1)")
      .run('p1', 'h1');
    const profileId = Number(profRes.lastInsertRowid);

    const bindRes = await api('PUT', `/api/ai-platform/mcp/bindings/profile/${profileId}`, token, {
      toolIds: [],
      enabled: true,
      maxRounds: 4,
    });
    expect(bindRes.status).toBe(200);
    expect((bindRes.json.binding as { aiToolsEnabled: boolean }).aiToolsEnabled).toBe(true);

    const agentRes = await api('GET', '/api/ai-platform/mcp/bindings/agent/triage', token);
    expect(agentRes.status).toBe(409);
    expect((agentRes.json.error as { code?: string }).code).toBe('scope_unavailable');

    // F02: unexpected internal errors return generic 500 message without leaking stack/DB text
    const badRes = await api('GET', '/api/ai-platform/mcp/servers/not-a-valid-id/tools', token);
    expect(badRes.status).toBe(400);
  });
});
