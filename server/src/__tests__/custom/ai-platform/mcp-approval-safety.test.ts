import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb, initDb } from '../../../db/index.js';
import { createServer, reviewTool, updateServer } from '../../../custom/ai-platform/mcp-client/registry.js';
import { setBindings } from '../../../custom/ai-platform/mcp-client/bindings.js';
import {
  assertApprovalExecutable,
  assertScopeEffective,
  captureApprovalSnapshot,
  isScopeEffective,
  validateApprovalSnapshot,
} from '../../../custom/ai-platform/mcp-client/approval-safety.js';

beforeEach(() => {
  initDb(':memory:');
});

afterEach(() => {
  try { getDb().close(); } catch { /* already closed */ }
});

function insertProfile(name: string, enabled = 1, aiToolsEnabled = 1): number {
  return Number(
    getDb()
      .prepare(
        `INSERT INTO client_profiles (name, token_hash, encrypted_key, iv, auth_tag, enabled, ai_tools_enabled)
         VALUES (?, ?, 'ek', 'iv', 'tag', ?, ?)`,
      )
      .run(name, `th-${name}-${Math.random()}`, enabled, aiToolsEnabled).lastInsertRowid,
  );
}

function insertTool(serverId: number, name: string, schemaHash = 'hash-v1', state = 'allowed'): number {
  return Number(
    getDb()
      .prepare(
        `INSERT INTO custom_ai_mcp_tools
           (server_id, name, input_schema_json, schema_hash, exposed_name, state, effect)
         VALUES (?, ?, '{"type":"object"}', ?, ?, ?, 'write')`,
      )
      .run(serverId, name, schemaHash, `mcp__srv__${name}`, state).lastInsertRowid,
  );
}

describe('MCP approval safety (F03 & F04)', () => {
  it('fails closed for legacy rows without snapshot_json and invalid JSON', async () => {
    const missing = await validateApprovalSnapshot(null);
    expect(missing.ok).toBe(false);
    expect(missing.code).toBe('legacy_missing_snapshot');

    await expect(assertApprovalExecutable(null)).rejects.toMatchObject({
      status: 409,
      code: 'legacy_missing_snapshot',
    });
    await expect(assertApprovalExecutable('{not-json')).rejects.toMatchObject({
      status: 409,
      code: 'invalid_snapshot',
    });
  });

  it('rejects execution when schemaHash, serverUrl, credentialGeneration, or tool state drifts after approval creation', async () => {
    const profileId = insertProfile('Active Profile', 1);
    const scope = { kind: 'profile' as const, id: String(profileId) };
    const srv = await createServer(
      {
        slug: 'srv-1',
        name: 'Srv 1',
        url: 'https://mcp1.example.com/v1',
        authKind: 'bearer',
        secret: 'opaque-secret-v1',
      },
      1,
    );
    const toolId = insertTool(srv.id, 'create_ticket', 'hash-v1', 'allowed');
    setBindings(scope, { toolIds: [toolId], enabled: true });

    const snap = await captureApprovalSnapshot({ toolId, scopeKind: 'profile', scopeId: String(profileId) });
    expect(snap).not.toBeNull();
    expect(snap!.schemaHash).toBe('hash-v1');
    expect(snap!.credentialGeneration).toBe(1);

    const okRes = await validateApprovalSnapshot(snap);
    expect(okRes.ok).toBe(true);

    // Drift 1: schema_hash changes
    getDb().prepare("UPDATE custom_ai_mcp_tools SET schema_hash = 'hash-v2' WHERE id = ?").run(toolId);
    expect((await validateApprovalSnapshot(snap)).code).toBe('schema_changed');
    getDb().prepare("UPDATE custom_ai_mcp_tools SET schema_hash = 'hash-v1' WHERE id = ?").run(toolId);

    // Drift 2: credential rotation bumps credentialGeneration
    await updateServer(srv.id, { revision: 1, secret: 'opaque-secret-v2' }, 1);
    expect((await validateApprovalSnapshot(snap)).code).toBe('credential_changed');

    // Re-capture on v2, then change URL
    const snap2 = await captureApprovalSnapshot({ toolId, scopeKind: 'profile', scopeId: String(profileId) });
    await updateServer(srv.id, { revision: 2, url: 'https://mcp2.example.com/v1' }, 1);
    expect((await validateApprovalSnapshot(snap2)).code).toBe('server_url_changed');

    // Re-capture on v3, then block tool
    const snap3 = await captureApprovalSnapshot({ toolId, scopeKind: 'profile', scopeId: String(profileId) });
    reviewTool(toolId, { state: 'blocked' }, 1);
    expect((await validateApprovalSnapshot(snap3)).code).toBe('tool_not_allowed');
  });

  it('enforces effective scope enablement for disabled profiles and support tenants (F04)', async () => {
    const profileId = insertProfile('Disabled Profile', 0);
    expect(await isScopeEffective('profile', String(profileId))).toBe(false);
    await expect(assertScopeEffective('profile', String(profileId))).rejects.toMatchObject({
      status: 403,
      code: 'scope_not_effective',
    });

    getDb().prepare('UPDATE client_profiles SET enabled = 1 WHERE id = ?').run(profileId);
    expect(await isScopeEffective('profile', String(profileId))).toBe(true);

    getDb().prepare('UPDATE client_profiles SET ai_tools_enabled = 0 WHERE id = ?').run(profileId);
    expect(await isScopeEffective('profile', String(profileId))).toBe(false);

    // Missing support tenant is not effective
    expect(await isScopeEffective('support_tenant', 'missing-tenant')).toBe(false);
  });
});
