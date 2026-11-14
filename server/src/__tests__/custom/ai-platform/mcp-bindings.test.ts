import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb, initDb } from '../../../db/index.js';
import {
  getBindings,
  setBindings,
  toolsForScope,
  validateScope,
} from '../../../custom/ai-platform/mcp-client/bindings.js';
import { createServer, recordServerOutcome } from '../../../custom/ai-platform/mcp-client/registry.js';

beforeEach(() => {
  initDb(':memory:');
});

afterEach(() => {
  try { getDb().close(); } catch { /* already closed */ }
});

describe('MCP bindings (T045:bindings)', () => {
  it('validates profile existence, support_tenant existence, and returns 409 scope_unavailable for agent before US7', () => {
    const profileId = Number(
      getDb()
        .prepare("INSERT INTO client_profiles (name, token_hash, encrypted_key, iv, auth_tag) VALUES ('P1', 'th1', 'ek1', 'iv1', 'tag1')")
        .run().lastInsertRowid,
    );

    expect(validateScope({ kind: 'profile', id: String(profileId) })).toEqual({
      kind: 'profile',
      id: String(profileId),
    });

    expect(() => validateScope({ kind: 'profile', id: '99999' })).toThrowError(
      expect.objectContaining({ status: 404, code: 'scope_not_found' }),
    );

    expect(() => validateScope({ kind: 'support_tenant', id: '1' })).toThrowError(
      expect.objectContaining({ status: 404, code: 'scope_not_found' }),
    );

    expect(() => validateScope({ kind: 'agent', id: '1' })).toThrowError(
      expect.objectContaining({ status: 409, code: 'scope_unavailable' }),
    );
  });

  it('filters toolsForScope by enabled/allowed/not-paused/not-missing and drops caller-alias collisions without renaming caller tools', async () => {
    const profileId = Number(
      getDb()
        .prepare("INSERT INTO client_profiles (name, token_hash, encrypted_key, iv, auth_tag) VALUES ('P2', 'th2', 'ek2', 'iv2', 'tag2')")
        .run().lastInsertRowid,
    );
    const scope = { kind: 'profile' as const, id: String(profileId) };

    const srvOk = await createServer(
      { slug: 'crm', name: 'CRM', url: 'https://crm.example.com/mcp', authKind: 'none' },
      1,
    );
    const srvPaused = await createServer(
      { slug: 'erp', name: 'ERP', url: 'https://erp.example.com/mcp', authKind: 'none' },
      1,
    );
    for (let i = 0; i < 5; i++) {
      recordServerOutcome(srvPaused.id, { ok: false, error: 'down' });
    }

    const insertTool = (
      serverId: number,
      name: string,
      exposedName: string,
      state: string,
      missingSince: string | null = null,
    ): number =>
      Number(
        getDb()
          .prepare(
            "INSERT INTO custom_ai_mcp_tools (server_id, name, input_schema_json, schema_hash, exposed_name, state, effect, missing_since) VALUES (?, ?, '{}', 'h1', ?, ?, 'read', ?)",
          )
          .run(serverId, name, exposedName, state, missingSince).lastInsertRowid,
      );

    const tAllowed = insertTool(srvOk.id, 'lookup', 'mcp__crm__lookup', 'allowed');
    const tCollide = insertTool(srvOk.id, 'search', 'mcp__crm__search', 'allowed');
    const tPending = insertTool(srvOk.id, 'draft', 'mcp__crm__draft', 'pending');
    const tMissing = insertTool(srvOk.id, 'gone', 'mcp__crm__gone', 'allowed', '2026-11-14T00:00:00.000Z');
    const tPaused = insertTool(srvPaused.id, 'inv', 'mcp__erp__inv', 'allowed');

    const binding = setBindings(scope, {
      toolIds: [tAllowed, tCollide, tPending, tMissing, tPaused],
      enabled: true,
      maxRounds: 5,
    });
    expect(binding.aiToolsEnabled).toBe(true);
    expect(binding.maxRounds).toBe(5);
    expect(getBindings(scope).toolIds).toHaveLength(5);

    const callerTools = [
      {
        type: 'function' as const,
        function: { name: 'mcp__crm__search', description: 'Caller search', parameters: {} },
      },
    ];
    const effective = toolsForScope(scope, callerTools);
    expect(effective.map((t) => t.exposedName)).toEqual(['mcp__crm__lookup']);
    // Caller tools are never mutated/renamed
    expect(callerTools[0].function.name).toBe('mcp__crm__search');

    // Disabling aiToolsEnabled hides all MCP tools
    setBindings(scope, { toolIds: [tAllowed], enabled: false });
    expect(toolsForScope(scope)).toEqual([]);
  });
});
