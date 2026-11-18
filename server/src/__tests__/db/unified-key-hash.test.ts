import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { describe, expect, it, beforeAll, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import {
  getDb,
  getUnifiedApiKeyHash,
  getUnifiedApiKeyPrefix,
  getInternalLoopbackToken,
  hashUnifiedApiKey,
  initDb,
  regenerateUnifiedKey,
  resetInternalLoopbackTokenForTests,
  unifiedKeyPrefix,
  validateUnifiedApiKey,
} from '../../db/index.js';
import { up, down } from '../../db/migrations/20261118_210000_custom_unified_key_hash.js';
import { isWideBindHost, warnOnWideBind } from '../../middleware/allowed-hosts.js';
import { mintDashboardToken } from '../helpers/auth.js';

const LEGACY_KEY = 'freellmapi-legacy-plaintext-key-0123456789abcdef';

function freshDbWithLegacyKey() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)`);
  db.prepare(`INSERT INTO settings (key, value) VALUES ('unified_api_key', ?)`).run(LEGACY_KEY);
  return db;
}

describe('unified key hash migration', () => {
  it('hashes a legacy plaintext row in place and deletes it', () => {
    const db = freshDbWithLegacyKey();
    try {
      up(db);
      const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
      expect(rows.map(r => r.key).sort()).toEqual(['unified_api_key_hash', 'unified_api_key_prefix']);
      const hash = rows.find(r => r.key === 'unified_api_key_hash')!.value;
      expect(hash).toBe(createHash('sha256').update(LEGACY_KEY).digest('hex'));
      expect(rows.find(r => r.key === 'unified_api_key_prefix')!.value).toBe(unifiedKeyPrefix(LEGACY_KEY));
      // No plaintext survives anywhere in the table.
      expect(rows.some(r => r.value === LEGACY_KEY)).toBe(false);
    } finally {
      db.close();
    }
  });

  it('mints a hash-only key when no key exists at all', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)`);
      up(db);
      const hash = db.prepare(`SELECT value FROM settings WHERE key = 'unified_api_key_hash'`).get() as { value: string };
      expect(hash.value).toMatch(/^[0-9a-f]{64}$/);
      expect(db.prepare(`SELECT COUNT(*) AS n FROM settings WHERE key = 'unified_api_key'`).get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  it('is idempotent: a second run keeps the same hash', () => {
    const db = freshDbWithLegacyKey();
    try {
      up(db);
      const first = db.prepare(`SELECT value FROM settings WHERE key = 'unified_api_key_hash'`).get() as { value: string };
      up(db);
      const second = db.prepare(`SELECT value FROM settings WHERE key = 'unified_api_key_hash'`).get() as { value: string };
      expect(second.value).toBe(first.value);
    } finally {
      db.close();
    }
  });

  it('down removes the hash rows (plaintext is unrecoverable by design)', () => {
    const db = freshDbWithLegacyKey();
    try {
      up(db);
      down(db);
      expect(db.prepare('SELECT COUNT(*) AS n FROM settings').get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });
});

describe('unified key hash storage (initDb)', () => {
  let app: Express;
  let dashToken: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken('unified-key-hash@example.com');
  });

  it('stores only the hash after boot: no plaintext row exists', () => {
    const db = getDb();
    const legacy = db.prepare(`SELECT value FROM settings WHERE key = 'unified_api_key'`).get();
    expect(legacy).toBeUndefined();
    expect(getUnifiedApiKeyHash()).toMatch(/^[0-9a-f]{64}$/);
    expect(getUnifiedApiKeyPrefix()).toMatch(/^freellmapi-…[0-9a-f]{4}$/);
  });

  it('validates the minted key and rejects anything else', () => {
    const key = regenerateUnifiedKey();
    expect(validateUnifiedApiKey(key)).toBe(true);
    expect(validateUnifiedApiKey(`${key}x`)).toBe(false);
    expect(validateUnifiedApiKey('freellmapi-000000000000000000000000000000000000000000')).toBe(false);
    expect(validateUnifiedApiKey(undefined)).toBe(false);
    expect(getUnifiedApiKeyHash()).toBe(hashUnifiedApiKey(key));
  });

  it('regenerating revokes the previous key', () => {
    const first = regenerateUnifiedKey();
    expect(validateUnifiedApiKey(first)).toBe(true);
    regenerateUnifiedKey();
    expect(validateUnifiedApiKey(first)).toBe(false);
  });

  it('accepts the process-ephemeral internal loopback token, which is never persisted', () => {
    resetInternalLoopbackTokenForTests();
    const token = getInternalLoopbackToken();
    expect(validateUnifiedApiKey(token)).toBe(true);
    const db = getDb();
    const stored = db.prepare('SELECT value FROM settings').all() as { value: string }[];
    expect(stored.some(row => row.value === token)).toBe(false);
    expect(stored.some(row => row.value.includes(token.slice(0, 16)))).toBe(false);
    resetInternalLoopbackTokenForTests();
    expect(validateUnifiedApiKey(token)).toBe(false);
    expect(validateUnifiedApiKey(getInternalLoopbackToken())).toBe(true);
  });

  it('validates a legacy plaintext row until the migration runs (dev-mode fallback)', () => {
    const db = getDb();
    db.prepare(`DELETE FROM settings WHERE key IN ('unified_api_key_hash', 'unified_api_key_prefix')`).run();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('unified_api_key', ?)`).run(LEGACY_KEY);
    expect(validateUnifiedApiKey(LEGACY_KEY)).toBe(true);
    expect(validateUnifiedApiKey('wrong')).toBe(false);
    // Minting a new key removes the legacy row for good.
    regenerateUnifiedKey();
    expect(db.prepare(`SELECT value FROM settings WHERE key = 'unified_api_key'`).get()).toBeUndefined();
    expect(validateUnifiedApiKey(LEGACY_KEY)).toBe(false);
  });

  it('GET /api/settings/api-key never returns the key, only its prefix', async () => {
    regenerateUnifiedKey();
    const prefix = getUnifiedApiKeyPrefix();
    const server = app.listen(0, '127.0.0.1');
    if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
    try {
      const addr = server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${addr.port}/api/settings/api-key`, {
        headers: { Authorization: `Bearer ${dashToken}` },
      });
      const body = (await res.json()) as { apiKey: string | null; apiKeyPrefix: string | null; hasKey: boolean };
      expect(res.status).toBe(200);
      expect(body.apiKey).toBeNull();
      expect(body.apiKeyPrefix).toBe(prefix);
      expect(body.hasKey).toBe(true);
    } finally {
      server.close();
    }
  });

  it('POST /api/settings/api-key/regenerate returns the fresh key exactly once', async () => {
    const server = app.listen(0, '127.0.0.1');
    if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
    try {
      const addr = server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${addr.port}/api/settings/api-key/regenerate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${dashToken}` },
      });
      const body = (await res.json()) as { apiKey: string; apiKeyPrefix: string };
      expect(res.status).toBe(200);
      expect(body.apiKey).toMatch(/^freellmapi-[0-9a-f]{48}$/);
      expect(validateUnifiedApiKey(body.apiKey)).toBe(true);
      expect(body.apiKeyPrefix).toBe(unifiedKeyPrefix(body.apiKey));
      // A follow-up GET still does not reveal it.
      const get = await fetch(`http://127.0.0.1:${addr.port}/api/settings/api-key`, {
        headers: { Authorization: `Bearer ${dashToken}` },
      });
      const getBody = (await get.json()) as { apiKey: string | null };
      expect(getBody.apiKey).toBeNull();
    } finally {
      server.close();
    }
  });
});

describe('wide-bind boot warning', () => {
  it('flags :: and 0.0.0.0, not loopback', () => {
    expect(isWideBindHost('::')).toBe(true);
    expect(isWideBindHost('0.0.0.0')).toBe(true);
    expect(isWideBindHost('127.0.0.1')).toBe(false);
    expect(isWideBindHost('::1')).toBe(false);
    expect(isWideBindHost('localhost')).toBe(false);
  });

  it('warns on a wide bind with the host guard off, stays quiet otherwise', () => {
    const logger = { warn: vi.fn() };
    warnOnWideBind('::', [], logger);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0][0])).toContain('ALLOWED_HOSTS');

    logger.warn.mockClear();
    warnOnWideBind('::', ['example.com'], logger);
    warnOnWideBind('127.0.0.1', [], logger);
    warnOnWideBind('0.0.0.0', ['*'], logger);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
