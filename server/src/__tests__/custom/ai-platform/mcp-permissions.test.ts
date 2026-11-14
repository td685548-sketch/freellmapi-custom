/**
 * T053 — MCP Permissions HTTP acceptance tests (401/403, primary-only origins,
 * manage_ai_platform does NOT auto-grant child permissions, flag-off CRUD vs outbound 409).
 *
 * NOTE: Requires Agent 3 (I0) router mounted at /api/ai-platform/mcp/* and /api/ai-platform/approvals*.
 * Without I0, HTTP calls to /api/ai-platform/mcp/* fail in RED state (404) until I0 is integrated.
 */

import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../../app.js';
import { initDb } from '../../../db/index.js';
import { createSession, createUser } from '../../../services/auth.js';
import { setUserPermissions } from '../../../services/users.js';

describe('MCP HTTP permissions & flag-off boundaries (T053)', () => {
  let server: Server;
  let base: string;
  let primaryToken: string;
  let parentOnlyToken: string;
  let viewOnlyToken: string;
  let editOnlyToken: string;
  let reviewOnlyToken: string;
  let approveOnlyToken: string;

  async function call(path: string, token?: string, method = 'GET', body?: unknown) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return {
      status: res.status,
      body: (await res.json().catch(() => null)) as Record<string, unknown> | null,
    };
  }

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    const primaryId = createUser('mcp-primary@example.com', 'Password123!').userId;
    primaryToken = createSession(primaryId);

    const parentId = createUser('mcp-parent@example.com', 'Password123!', 'member').userId;
    setUserPermissions(parentId, ['manage_ai_platform'], primaryId);
    parentOnlyToken = createSession(parentId);

    const viewId = createUser('mcp-view@example.com', 'Password123!', 'member').userId;
    setUserPermissions(viewId, ['view_mcp_servers'], primaryId);
    viewOnlyToken = createSession(viewId);

    const editId = createUser('mcp-edit@example.com', 'Password123!', 'member').userId;
    setUserPermissions(editId, ['edit_mcp_servers'], primaryId);
    editOnlyToken = createSession(editId);

    const reviewId = createUser('mcp-review@example.com', 'Password123!', 'member').userId;
    setUserPermissions(reviewId, ['review_mcp_tools'], primaryId);
    reviewOnlyToken = createSession(reviewId);

    const approveId = createUser('mcp-approve@example.com', 'Password123!', 'member').userId;
    setUserPermissions(approveId, ['approve_ai_actions'], primaryId);
    approveOnlyToken = createSession(approveId);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('rejects unauthenticated requests with 401', async () => {
    const res = await call('/api/ai-platform/mcp/servers');
    expect(res.status).toBe(401);
  });

  it('does not allow manage_ai_platform alone to satisfy child MCP/approval permissions', async () => {
    const listRes = await call('/api/ai-platform/mcp/servers', parentOnlyToken);
    expect(listRes.status).toBe(403);

    const createRes = await call('/api/ai-platform/mcp/servers', parentOnlyToken, 'POST', {
      slug: 's1',
      name: 'S1',
      url: 'https://example.com/mcp',
      authKind: 'none',
    });
    expect(createRes.status).toBe(403);

    const approvalsRes = await call('/api/ai-platform/approvals', parentOnlyToken);
    expect(approvalsRes.status).toBe(403);
  });

  it('enforces exact child permissions across MCP and approval routes', async () => {
    expect((await call('/api/ai-platform/mcp/servers', viewOnlyToken)).status).toBe(200);
    expect(
      (
        await call('/api/ai-platform/mcp/servers', viewOnlyToken, 'POST', {
          slug: 's1',
          name: 'S1',
          url: 'https://example.com/mcp',
          authKind: 'none',
        })
      ).status,
    ).toBe(403);

    expect((await call('/api/ai-platform/mcp/tools/1', editOnlyToken, 'PATCH', { state: 'allowed' })).status).toBe(403);
    expect((await call('/api/ai-platform/approvals', reviewOnlyToken)).status).toBe(403);
    expect((await call('/api/ai-platform/approvals', approveOnlyToken)).status).toBe(200);
    expect((await call('/api/ai-platform/mcp/servers', approveOnlyToken)).status).toBe(403);
  });

  it('restricts /mcp/allowed-internal-hosts to primary owner only', async () => {
    expect((await call('/api/ai-platform/mcp/allowed-internal-hosts', parentOnlyToken)).status).toBe(403);
    expect((await call('/api/ai-platform/mcp/allowed-internal-hosts', editOnlyToken)).status).toBe(403);
    expect(
      (
        await call('/api/ai-platform/mcp/allowed-internal-hosts', parentOnlyToken, 'PUT', {
          origins: ['http://127.0.0.1:9000'],
        })
      ).status,
    ).toBe(403);
    expect((await call('/api/ai-platform/mcp/allowed-internal-hosts', primaryToken)).status).toBe(200);
  });

  it('allows CRUD when mcpClient flag is off, but blocks outbound test/sync with 409 pillar_disabled', async () => {
    const created = await call('/api/ai-platform/mcp/servers', primaryToken, 'POST', {
      slug: 'flagoff-srv',
      name: 'Flagoff Server',
      url: 'https://example.com/mcp',
      authKind: 'none',
    });
    expect(created.status).toBe(201);
    const id = (created.body?.server as { id: number }).id;

    const testRes = await call(`/api/ai-platform/mcp/servers/${id}/test`, primaryToken, 'POST');
    expect(testRes.status).toBe(409);
    expect((testRes.body?.error as { code?: string })?.code).toBe('pillar_disabled');

    const syncRes = await call(`/api/ai-platform/mcp/servers/${id}/sync`, primaryToken, 'POST');
    expect(syncRes.status).toBe(409);
    expect((syncRes.body?.error as { code?: string })?.code).toBe('pillar_disabled');
  });
});
