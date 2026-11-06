import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { checkKeyHealth } from '../../services/health.js';
import { getCachedKeyStatus, getUsableKeysByPlatform, setKeyCacheTestOverride } from '../../services/key-cache.js';

// A probe refreshes timestamps and error text on every key every pass. Only a
// changed verdict should throw away the in-memory key registry.

function addKey(status: string): number {
  const k = encrypt('gsk_test');
  return Number(getDb().prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('groq','k',?,?,?,?,1)`)
    .run(k.encrypted, k.iv, k.authTag, status).lastInsertRowid);
}

describe('health probe and the key registry', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    setKeyCacheTestOverride(true);
    vi.spyOn(global, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ data: [{ id: 'm' }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
  });
  afterEach(() => { vi.restoreAllMocks(); setKeyCacheTestOverride(null); });

  it('keeps the registry when the verdict is unchanged', async () => {
    const id = addKey('healthy');
    getUsableKeysByPlatform();
    expect(getCachedKeyStatus(id)).toBe('healthy');
    expect(await checkKeyHealth(id)).toBe('healthy');
    expect(getCachedKeyStatus(id)).toBe('healthy'); // still loaded
  });

  it('drops the registry when the verdict changes', async () => {
    const id = addKey('unknown');
    getUsableKeysByPlatform();
    expect(getCachedKeyStatus(id)).toBe('unknown');
    expect(await checkKeyHealth(id)).toBe('healthy');
    expect(getCachedKeyStatus(id)).toBeUndefined(); // reloaded on next use
    expect(getUsableKeysByPlatform().get('groq')![0]!.status).toBe('healthy');
  });
});
