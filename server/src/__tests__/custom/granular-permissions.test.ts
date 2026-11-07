import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { getDb, initDb } from '../../db/index.js';
import { createApp } from '../../app.js';
import { createUser, createSession, validateSession } from '../../services/auth.js';
import { permissionForAction } from '../../custom/permission-actions.js';
import { permissionGranted, PERMISSION_GROUPS, parseStoredPermissions } from '@freellmapi/shared/permissions.js';
import { cachePersistenceEnabled, clearCache } from '../../services/cache.js';
import { encrypt } from '../../lib/crypto.js';

vi.mock('../../services/builtin-model-discovery.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../services/builtin-model-discovery.js')>(),
  triggerBuiltinModelDiscovery: vi.fn(),
}));

describe('Granular permissions and cache preferences', () => {
  let server: Server;
  let base: string;
  let ownerId: number;
  let actorId: number;
  let targetId: number;
  let actorToken: string;
  let ownerToken: string;
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    ownerId = createUser('root-grants@example.com', 'Password123!').userId;
    actorId = createUser('secondary-grants@example.com', 'Password123!', 'admin').userId;
    targetId = createUser('target-grants@example.com', 'Password123!', 'member').userId;
    actorToken = createSession(actorId);
    ownerToken = createSession(ownerId);
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => { server?.close(); });
  beforeEach(() => {
    grant([]);
    getDb().prepare("UPDATE users SET role = 'member', permissions = '[]' WHERE id = ?").run(targetId);
    getDb().prepare("DELETE FROM settings WHERE key IN ('response_cache_enabled', 'response_cache_persist')").run();
    clearCache();
  });
  function grant(permissions: string[]) {
    getDb().prepare('UPDATE users SET permissions = ? WHERE id = ?').run(JSON.stringify(permissions), actorId);
  }
  async function hit(path: string, method = 'GET', body?: unknown, token = actorToken) {
    const response = await fetch(base + path, { method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json().catch(() => null) };
  }

  it('keeps parent implication one-way for every group and every child', () => {
    for (const group of PERMISSION_GROUPS) for (const child of group.children) {
      expect(permissionGranted({ permissions: [group.key] }, child.key)).toBe(true);
      expect(permissionGranted({ permissions: [child.key] }, group.key)).toBe(false);
      for (const sibling of group.children) if (sibling.key !== child.key)
        expect(permissionGranted({ permissions: [child.key] }, sibling.key)).toBe(false);
    }
    expect(parseStoredPermissions('[]', 'admin', false)).toEqual([]);
    expect(parseStoredPermissions(null, 'admin', false)).toEqual(['*']);
    expect(parseStoredPermissions('broken', 'admin', false)).toEqual([]);
    expect(parseStoredPermissions('[]', 'admin', true)).toEqual(['*']);
  });

  it('restricts secondary administrators immediately while retaining primary and legacy full access', async () => {
    expect(validateSession(actorToken)?.permissions).toEqual([]);
    expect((await hit('/api/keys')).status).toBe(403);
    expect((await hit('/api/keys', 'GET', undefined, ownerToken)).status).toBe(200);
    grant(['manage_keys']);
    expect((await hit('/api/keys')).status).toBe(200);
  });

  const operations = [
    ['view_keys', 'GET', '/api/keys'], ['add_keys', 'POST', '/api/keys'],
    ['edit_keys', 'PATCH', '/api/keys/999'], ['delete_keys', 'DELETE', '/api/keys/999'],
    ['reveal_keys', 'POST', '/api/keys/999/reveal'], ['export_keys', 'GET', '/api/keys/export'],
    ['test_keys', 'POST', '/api/health/check-all'], ['view_users', 'GET', '/api/admin/users'],
    ['view_invites', 'GET', '/api/invites'], ['create_invites', 'POST', '/api/invites'],
    ['view_requests', 'GET', '/api/admin/registration-requests'],
    ['approve_requests', 'POST', '/api/admin/registration-requests/999/approve'],
    ['view_backups', 'GET', '/api/backups'], ['create_backups', 'POST', '/api/backups'],
    ['restore_backups', 'POST', '/api/backups/999/restore'],
    ['view_server_logs', 'GET', '/api/logs'], ['clear_server_logs', 'POST', '/api/logs/clear'],
    ['view_analytics', 'GET', '/api/analytics/provider-tiers'],
    ['view_usage_accounts', 'GET', '/api/usage/accounts'], ['view_usage_profiles', 'GET', '/api/usage/profiles'],
    ['edit_cache', 'PUT', '/api/cache/config'], ['clear_cache', 'DELETE', '/api/cache'],
    ['reveal_gateway_key', 'GET', '/api/settings/api-key'],
  ] as const;
  it('denies every unrelated operation for each isolated child, before side effects', async () => {
    const before = (getDb().prepare('SELECT COUNT(*) AS n FROM api_keys').get() as { n: number }).n;
    for (const [held] of operations) {
      grant([held]);
      for (const [required, method, path] of operations) if (required !== held)
        expect((await hit(path, method, method === 'GET' ? undefined : { enabled: true })).status, `${held} must not unlock ${method} ${path}`).toBe(403);
    }
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM api_keys').get() as { n: number }).n).toBe(before);
    expect(getDb().prepare("SELECT value FROM settings WHERE key = 'response_cache_enabled'").get()).toBeUndefined();
  }, 20000);

  it('lets add-only submit new-key validation without listing other keys', async () => {
    grant(['add_keys']);
    expect((await hit('/api/keys', 'POST', {})).status).toBe(400);
    expect((await hit('/api/keys')).status).toBe(403);
    expect((await hit('/api/keys/import-selected', 'POST', { keys: [] })).status).toBe(403);
    expect((await hit('/api/settings/url-tokens')).status).toBe(403);
    const added = await hit('/api/keys', 'POST', { platform: 'groq', key: 'gsk_' + 'x'.repeat(32), label: 'local fixture' });
    expect(added.status).toBe(201);
    try {
      expect((await hit(`/api/keys/${added.body.id}`, 'PATCH', { label: 'unauthorized change' })).status).toBe(403);
      expect((await hit(`/api/keys/${added.body.id}`, 'DELETE')).status).toBe(403);
      expect((await hit(`/api/keys/${added.body.id}/reveal`, 'POST', { password: 'Password123!' })).status).toBe(403);
      expect(getDb().prepare('SELECT label FROM api_keys WHERE id = ?').get(added.body.id)).toEqual({ label: 'local fixture' });
    } finally { getDb().prepare('DELETE FROM api_keys WHERE id = ?').run(added.body.id); }
  });

  it('does not let add-only mutate old keyless/custom credentials through upsert', async () => {
    grant(['add_keys']);
    const cipher = encrypt('no-key');
    const insert = getDb().prepare(`INSERT INTO api_keys
      (platform, label, base_url, encrypted_key, iv, auth_tag, enabled) VALUES (?, 'protected', ?, ?, ?, ?, 0)`);
    const ids = [
      Number(insert.run('kilo', null, cipher.encrypted, cipher.iv, cipher.authTag).lastInsertRowid),
      Number(insert.run('custom', 'https://relay.example/v1', cipher.encrypted, cipher.iv, cipher.authTag).lastInsertRowid),
    ];
    try {
      expect((await hit('/api/keys', 'POST', { platform: 'kilo', key: '' })).status).toBe(403);
      expect((await hit('/api/keys/custom', 'POST', { baseUrl: 'https://relay.example/v1', apiKey: 'NEW_TEST_CREDENTIAL' })).status).toBe(403);
      for (const id of ids) expect(getDb().prepare('SELECT label, enabled FROM api_keys WHERE id = ?').get(id)).toEqual({ label: 'protected', enabled: 0 });
    } finally { for (const id of ids) getDb().prepare('DELETE FROM api_keys WHERE id = ?').run(id); }
  });

  it('does not let model management become credential creation/deletion authority', async () => {
    grant(['manage_key_models']);
    expect((await hit('/api/embeddings/custom', 'POST', { baseUrl: 'https://relay.example/v1', model: 'test', apiKey: 'local_test' })).status).toBe(403);
    expect((await hit('/api/media/custom', 'POST', { baseUrl: 'https://relay.example/v1', model: 'test', apiKey: 'local_test' })).status).toBe(403);
    expect((await hit('/api/media/custom/999', 'DELETE')).status).toBe(403);
  });

  it('keeps gateway secrets outside read-only system settings', async () => {
    grant(['view_settings']);
    expect((await hit('/api/settings/version')).status).toBe(200);
    expect((await hit('/api/settings/api-key')).status).toBe(403);
    expect((await hit('/api/settings/url-tokens')).status).toBe(403);
    expect((await hit('/api/client-profiles')).status).toBe(403);
    expect((await hit('/api/settings/proxy')).status).toBe(403);
  });

  it('falls back to the parent for unknown administrative operations', () => {
    for (const group of PERMISSION_GROUPS)
      expect(permissionForAction(group.key, 'POST', '/api/new-unclassified-operation')).toBe(group.key);
    expect(permissionForAction('manage_keys', 'POST', '/api/keys/999/reveal-extra')).toBe('manage_keys');
  });

  it('maps every leaf capability to a real administrative operation', () => {
    const mapped = [
      ...operations.map(([permission, method, path]) => {
        const group = PERMISSION_GROUPS.find(g => g.children.some(c => c.key === permission))!;
        expect(permissionForAction(group.key, method, path)).toBe(permission);
        return permission;
      }),
      ...([
        ['manage_keys', 'POST', '/api/keys/import-selected', 'import_keys'],
        ['manage_keys', 'PUT', '/api/embeddings', 'manage_key_models'],
        ['manage_users', 'PATCH', '/api/admin/users/2/role', 'edit_user_roles'],
        ['manage_users', 'PUT', '/api/admin/users/2/permissions', 'edit_user_permissions'],
        ['manage_users', 'PUT', '/api/admin/users/2/quota', 'edit_user_quotas'],
        ['manage_users', 'POST', '/api/admin/users/2/revoke-sessions', 'revoke_user_sessions'],
        ['manage_users', 'POST', '/api/admin/users/2/revoke-keys', 'revoke_user_keys'],
        ['manage_invites', 'DELETE', '/api/invites/2', 'revoke_invites'],
        ['manage_requests', 'POST', '/api/admin/registration-requests/2/reject', 'reject_requests'],
        ['manage_settings', 'GET', '/api/settings/version', 'view_settings'],
        ['manage_settings', 'GET', '/api/settings/proxy', 'reveal_proxy_credentials'],
        ['manage_settings', 'PUT', '/api/settings/proxy', 'edit_settings'],
        ['manage_settings', 'PUT', '/api/fallback', 'manage_routing'],
        ['manage_settings', 'POST', '/api/compression/preview', 'manage_compression'],
        ['manage_settings', 'GET', '/api/savers', 'view_settings'],
        ['manage_settings', 'PUT', '/api/savers', 'manage_compression'],
        ['manage_settings', 'GET', '/api/client-profiles', 'view_client_profiles'],
        ['manage_settings', 'POST', '/api/client-profiles', 'edit_client_profiles'],
        ['manage_settings', 'POST', '/api/update', 'manage_updates'],
        ['manage_settings', 'POST', '/api/settings/api-key/regenerate', 'rotate_gateway_key'],
        ['manage_settings', 'GET', '/api/cache/stats', 'view_cache'],
        ['manage_backups', 'GET', '/api/backups/2/download', 'download_backups'],
        ['manage_backups', 'DELETE', '/api/backups/2', 'delete_backups'],
        ['manage_backups', 'PUT', '/api/backups/schedule', 'schedule_backups'],
        ['manage_x_gateway', 'PUT', '/api/x-gateway/enabled', 'edit_x_settings'],
        ['manage_x_gateway', 'POST', '/api/x-gateway/combos', 'edit_x_combos'],
        ['manage_x_gateway', 'GET', '/api/x-gateway/usage', 'view_x_usage'],
        ['manage_x_gateway', 'POST', '/api/x-gateway/test', 'use_x_gateway'],
        ['view_logs', 'GET', '/api/audit', 'view_audit_log'],
      ] as const).map(([parent, method, path, permission]) => {
        expect(permissionForAction(parent, method, path)).toBe(permission);
        return permission;
      }),
    ];
    expect(new Set(mapped)).toEqual(new Set(PERMISSION_GROUPS.flatMap(g => g.children.map(c => c.key))));
  });

  it('keeps cache configuration atomic, persistent in settings, and distinct from flushing', async () => {
    grant(['view_cache']);
    expect((await hit('/api/cache/preferences')).status).toBe(200);
    expect((await hit('/api/cache/preferences', 'PUT', { enabled: true })).status).toBe(403);
    grant(['edit_cache']);
    expect((await hit('/api/cache/preferences', 'PUT', { enabled: true, persist: false })).body).toMatchObject({ enabled: true, persist: false });
    expect(cachePersistenceEnabled()).toBe(false);
    expect((await hit('/api/cache/preferences', 'PUT', { enabled: false, persist: 'bad' })).status).toBe(400);
    expect((await hit('/api/cache/preferences')).body.enabled).toBe(true);
    expect((await hit('/api/cache', 'DELETE')).status).toBe(403);
    grant(['clear_cache']);
    expect((await hit('/api/cache', 'DELETE')).status).toBe(200);
    expect((await hit('/api/cache/preferences', 'PUT', { enabled: false })).status).toBe(403);
  });

  it('prevents self-grants and grants beyond a restricted actor, including role promotion', async () => {
    grant(['edit_user_permissions', 'edit_user_roles', 'view_keys']);
    expect((await hit(`/api/admin/users/${actorId}/permissions`, 'PUT', { permissions: ['*'] })).status).toBe(409);
    expect((await hit(`/api/admin/users/${targetId}/permissions`, 'PUT', { permissions: ['manage_keys'] })).status).toBe(403);
    expect((await hit(`/api/admin/users/${targetId}/permissions`, 'PUT', { permissions: ['view_keys'] })).status).toBe(200);
    expect((await hit(`/api/admin/users/${ownerId}/permissions`, 'PUT', { permissions: [] })).status).toBe(403);
    expect((await hit(`/api/admin/users/${targetId}/role`, 'PATCH', { role: 'admin' })).status).toBe(200);
    const promoted = getDb().prepare('SELECT role, permissions FROM users WHERE id = ?').get(targetId) as { role: string; permissions: string };
    expect(promoted).toEqual({ role: 'admin', permissions: '["view_keys"]' });
    expect((await hit(`/api/admin/users/${targetId}/permissions`, 'PUT', { permissions: ['*'] })).status).toBe(403);
  });
});
