import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import { createUser } from '../../services/auth.js';
import { mintUserApiKey, validateUserApiKey } from '../../services/user-keys.js';

// last_used_at is written at most once a minute per key: the hot path must not
// pay a database write on every authenticated request.

describe('user key last_used_at throttling', () => {
  let userId: number;
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    userId = createUser('lastused@example.com', 'Password123!').userId;
  });
  afterEach(() => { vi.useRealTimers(); });

  const lastUsed = (id: number) =>
    (getDb().prepare('SELECT last_used_at AS t FROM user_api_keys WHERE id = ?').get(id) as { t: string | null }).t;

  it('writes on first use, skips repeats within a minute, then writes again', () => {
    vi.useFakeTimers({ now: new Date('2026-11-05T10:00:00Z'), toFake: ['Date'] });
    const { id, key } = mintUserApiKey(userId, 'throttle');
    expect(lastUsed(id)).toBeNull();

    expect(validateUserApiKey(key)?.userId).toBe(userId);
    const first = lastUsed(id);
    expect(first).not.toBeNull();

    // Reset the column behind the service's back: if the next call wrote, it
    // would come back non-null.
    getDb().prepare('UPDATE user_api_keys SET last_used_at = NULL WHERE id = ?').run(id);
    vi.setSystemTime(new Date('2026-11-05T10:00:30Z'));
    validateUserApiKey(key);
    validateUserApiKey(key);
    expect(lastUsed(id)).toBeNull();

    vi.setSystemTime(new Date('2026-11-05T10:01:01Z'));
    validateUserApiKey(key);
    expect(lastUsed(id)).not.toBeNull();
  });

  it('still rejects revoked keys immediately and never throttles validation itself', () => {
    const { id, key } = mintUserApiKey(userId, 'revoked');
    expect(validateUserApiKey(key)).not.toBeNull();
    getDb().prepare('UPDATE user_api_keys SET revoked = 1 WHERE id = ?').run(id);
    expect(validateUserApiKey(key)).toBeNull();
  });
});
