import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, initDb } from '../../../db/index.js';
import { setFlags, resetFlagsCacheForTests } from '../../../custom/ai-platform/flags.js';
import {
  createServer,
  deleteServer,
  getServerTransportConfig,
  listServerTools,
  listServers,
  recordServerOutcome,
  reviewTool,
  syncServerTools,
  testServer,
  updateServer,
} from '../../../custom/ai-platform/mcp-client/registry.js';

beforeEach(() => {
  initDb(':memory:');
  resetFlagsCacheForTests();
  setFlags({ mcpClient: true });
});

afterEach(() => {
  vi.useRealTimers();
  resetFlagsCacheForTests();
  try { getDb().close(); } catch { /* already closed */ }
});

describe('MCP registry (T037/T044)', () => {
  it('encrypts secrets via lib/crypto and never exposes ciphertext/iv/tag or plaintext in DTOs', async () => {
    const created = await createServer(
      {
        slug: 'github-tools',
        name: 'GitHub Tools',
        url: 'https://mcp.example.com/v1',
        authKind: 'bearer',
        secret: 'ghp_super_secret_token_123456',
      },
      1,
    );

    expect(created.slug).toBe('github-tools');
    expect(created.hasSecret).toBe(true);
    expect(created.revision).toBe(1);
    expect(JSON.stringify(created)).not.toContain('ghp_super_secret_token_123456');
    expect((created as unknown as Record<string, unknown>).auth_ciphertext).toBeUndefined();
    expect((created as unknown as Record<string, unknown>).auth_iv).toBeUndefined();
    expect((created as unknown as Record<string, unknown>).auth_tag).toBeUndefined();

    // Raw DB must store encrypted ciphertext, never plaintext
    const raw = getDb()
      .prepare('SELECT auth_ciphertext, auth_iv, auth_tag FROM custom_ai_mcp_servers WHERE id = ?')
      .get(created.id) as { auth_ciphertext: string; auth_iv: string; auth_tag: string };
    expect(raw.auth_ciphertext).toBeTruthy();
    expect(raw.auth_iv).toBeTruthy();
    expect(raw.auth_tag).toBeTruthy();
    expect(raw.auth_ciphertext).not.toContain('ghp_super_secret_token_123456');

    // Server-only transport config decrypts secret
    const cfg = getServerTransportConfig(created.id);
    expect(cfg.secret).toBe('ghp_super_secret_token_123456');
    expect(cfg.credentialGeneration).toBe(1);

    // List projection also omits secrets
    const listed = listServers();
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed[0])).not.toContain('ghp_super_secret_token_123456');
  });

  it('enforces optimistic concurrency revision, preserves secret when omitted, clears on null, and bumps generation on URL/secret change', async () => {
    const s1 = await createServer(
      {
        slug: 'docs-srv',
        name: 'Docs',
        url: 'https://docs.example.com/mcp',
        authKind: 'header',
        authHeaderName: 'X-Api-Key',
        secret: 'secret-one',
      },
      1,
    );

    // Patch without secret preserves secret
    const s2 = await updateServer(s1.id, { revision: 1, name: 'Docs Updated' }, 1);
    expect(s2.revision).toBe(2);
    expect(s2.hasSecret).toBe(true);
    expect(getServerTransportConfig(s1.id).secret).toBe('secret-one');
    expect(getServerTransportConfig(s1.id).credentialGeneration).toBe(1);

    // Stale revision throws 409 revision_conflict with current projection
    await expect(updateServer(s1.id, { revision: 1, name: 'Stale' }, 1)).rejects.toMatchObject({
      status: 409,
      code: 'revision_conflict',
      details: { current: expect.objectContaining({ id: s1.id, revision: 2, name: 'Docs Updated' }) },
    });

    // URL change bumps credentialGeneration
    const s3 = await updateServer(s1.id, { revision: 2, url: 'https://docs2.example.com/mcp' }, 1);
    expect(s3.revision).toBe(3);
    expect(getServerTransportConfig(s1.id).credentialGeneration).toBe(2);

    // secret: null clears secret and bumps credentialGeneration
    const s4 = await updateServer(s1.id, { revision: 3, authKind: 'none', secret: null }, 1);
    expect(s4.hasSecret).toBe(false);
    expect(getServerTransportConfig(s1.id).secret).toBeNull();
    expect(getServerTransportConfig(s1.id).credentialGeneration).toBe(3);
  });

  it('syncs tools as pending + write by default, resets to pending on schema change, marks missing, and enforces unique <=64 exposed_name', async () => {
    const srv = await createServer(
      {
        slug: 'very-long-server-slug-1234567890',
        name: 'Long Slug Server',
        url: 'https://tools.example.com/mcp',
        authKind: 'none',
      },
      1,
    );

    const longToolName = 'a_very_long_tool_name_that_exceeds_sixty_four_characters_easily_when_prefixed';
    const mockTransport1 = {
      mcpInitialize: vi.fn(async () => ({
        serverId: srv.id,
        revision: srv.revision,
        credentialGeneration: 1,
        origin: 'https://tools.example.com',
        sessionId: 'sess-1',
        protocolVersion: '2025-06-18',
        serverInfo: { name: 'mock-mcp' },
      })),
      mcpListTools: vi.fn(async () => [
        {
          name: longToolName,
          description: 'Read something',
          inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
          annotations: { readOnlyHint: true },
        },
        {
          name: 'ping',
          description: 'Ping',
          inputSchema: { type: 'object' },
        },
      ]),
    };

    const sync1 = await syncServerTools(srv.id, 1, undefined, mockTransport1);
    expect(sync1).toEqual({ added: 2, changed: 0, missing: 0, unchanged: 0 });

    const tools1 = listServerTools(srv.id);
    expect(tools1).toHaveLength(2);
    for (const t of tools1) {
      // Never trusts remote readOnlyHint: always pending + write by default
      expect(t.state).toBe('pending');
      expect(t.effect).toBe('write');
      expect(t.exposedName.length).toBeLessThanOrEqual(64);
    }

    // Approve 'ping' as read
    const pingTool = tools1.find((t) => t.name === 'ping')!;
    const reviewed = reviewTool(pingTool.id, { state: 'allowed', effect: 'read' }, 1);
    expect(reviewed.state).toBe('allowed');
    expect(reviewed.effect).toBe('read');

    // Second sync: 'ping' description changes -> resets to pending; longToolName missing -> missing_since set
    const mockTransport2 = {
      mcpInitialize: mockTransport1.mcpInitialize,
      mcpListTools: vi.fn(async () => [
        {
          name: 'ping',
          description: 'Ping v2 changed',
          inputSchema: { type: 'object' },
        },
      ]),
    };
    const sync2 = await syncServerTools(srv.id, 1, undefined, mockTransport2);
    expect(sync2).toEqual({ added: 0, changed: 1, missing: 1, unchanged: 0 });

    const tools2 = listServerTools(srv.id);
    const pingAfter = tools2.find((t) => t.name === 'ping')!;
    const longAfter = tools2.find((t) => t.name === longToolName)!;
    expect(pingAfter.state).toBe('pending');
    expect(longAfter.missingSince).not.toBeNull();
  });

  it('blocks deleting a bound server with 409 in_use unless force=true', async () => {
    const srv = await createServer(
      { slug: 'bound-srv', name: 'Bound', url: 'https://bound.example.com/mcp', authKind: 'none' },
      1,
    );
    const profileId = Number(
      getDb()
        .prepare("INSERT INTO client_profiles (name, token_hash, encrypted_key, iv, auth_tag) VALUES ('App A', 'th', 'ek', 'iv', 'tag')")
        .run().lastInsertRowid,
    );
    getDb().prepare(
      "INSERT INTO custom_ai_mcp_tools (server_id, name, input_schema_json, schema_hash, exposed_name, state) VALUES (?, 't1', '{}', 'h1', 'mcp__bound-srv__t1', 'allowed')",
    ).run(srv.id);
    const toolId = (getDb().prepare('SELECT id FROM custom_ai_mcp_tools WHERE server_id = ?').get(srv.id) as { id: number }).id;
    getDb().prepare("INSERT INTO custom_ai_tool_bindings (tool_id, scope_kind, scope_id) VALUES (?, 'profile', ?)").run(
      toolId,
      String(profileId),
    );

    await expect(Promise.resolve().then(() => deleteServer(srv.id))).rejects.toMatchObject({
      status: 409,
      code: 'in_use',
      details: {
        profiles: [{ id: profileId, name: 'App A' }],
      },
    });

    const forced = deleteServer(srv.id, { force: true });
    expect(forced).toEqual({ ok: true });
    expect(listServers()).toHaveLength(0);
  });

  it('opens circuit breaker after 5 failures for 60s, doubles up to 15m, and resets on success', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-14T00:00:00.000Z'));

    // Create server synchronously via async helper
    return createServer(
      { slug: 'cb-srv', name: 'CB', url: 'https://cb.example.com/mcp', authKind: 'none' },
      1,
    ).then((srv) => {
      for (let i = 1; i <= 4; i++) {
        const s = recordServerOutcome(srv.id, { ok: false, error: `err-${i}` });
        expect(s.status).toBe('error');
        expect(s.failCount).toBe(i);
        expect(s.pausedUntil).toBeNull();
      }

      // 5th failure -> paused for 60s
      const s5 = recordServerOutcome(srv.id, { ok: false, error: 'err-5' });
      expect(s5.status).toBe('paused');
      expect(s5.failCount).toBe(5);
      expect(s5.pausedUntil).toBe('2026-11-14T00:01:00.000Z');

      // 6th failure -> 120s
      const s6 = recordServerOutcome(srv.id, { ok: false, error: 'err-6' });
      expect(s6.pausedUntil).toBe('2026-11-14T00:02:00.000Z');

      // 9th failure -> capped at 900s (15m)
      recordServerOutcome(srv.id, { ok: false, error: 'err-7' });
      recordServerOutcome(srv.id, { ok: false, error: 'err-8' });
      const s9 = recordServerOutcome(srv.id, { ok: false, error: 'err-9' });
      expect(s9.pausedUntil).toBe('2026-11-14T00:15:00.000Z');

      // Success resets failCount and pausedUntil
      const ok = recordServerOutcome(srv.id, { ok: true, protocolVersion: '2025-06-18' });
      expect(ok.status).toBe('ok');
      expect(ok.failCount).toBe(0);
      expect(ok.pausedUntil).toBeNull();
      expect(ok.lastError).toBeNull();
    });
  });

  it('returns 409 pillar_disabled on testServer/syncServerTools when mcpClient flag is off', async () => {
    const srv = await createServer(
      { slug: 'flag-off', name: 'Flag Off', url: 'https://off.example.com/mcp', authKind: 'none' },
      1,
    );
    setFlags({ mcpClient: false });
    await expect(testServer(srv.id)).rejects.toMatchObject({ status: 409, code: 'pillar_disabled' });
    await expect(syncServerTools(srv.id, 1)).rejects.toMatchObject({ status: 409, code: 'pillar_disabled' });
  });
});
