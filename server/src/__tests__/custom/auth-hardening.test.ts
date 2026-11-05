import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { getDb, initDb } from '../../db/index.js';
import { createApp } from '../../app.js';
import { createUser } from '../../services/auth.js';
import { createRegistrationRequest, approveRegistrationRequest, listRegistrationRequests } from '../../services/registration-requests.js';
import { mintUserApiKey, validateUserApiKey, withUserKeyMemo } from '../../services/user-keys.js';

describe('auth hardening', () => {
  let server: Server;
  let base: string;
  let adminId: number;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    adminId = createUser('root-hardening@example.com', 'Password123!').userId;
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => { server?.close(); });

  const post = (path: string, body: unknown) => fetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  it('throttles guessing against a pending registration but never ordinary logins', async () => {
    createRegistrationRequest('pending-h@example.com', 'RealPassword1!');
    createUser('active-h@example.com', 'Password123!', 'member');
    // Upstream's own throttle starts refusing wrong passwords after a few tries,
    // but this pre-check runs before it, so the correct password is the thing to
    // bound: it answers 403 for a bounded number of attempts, then 429.
    const good: number[] = [];
    for (let i = 0; i < 12; i++) good.push((await post('/api/auth/login', { email: 'pending-h@example.com', password: 'RealPassword1!' })).status);
    expect(good.slice(0, 10)).toEqual(Array(10).fill(403));
    expect(good.slice(10)).toEqual([429, 429]);

    for (let i = 0; i < 15; i++) {
      const res = await post('/api/auth/login', { email: 'active-h@example.com', password: 'Password123!' });
      expect(res.status).toBe(200);
    }
  });

  it('rate limits invite probing', async () => {
    let last = 0;
    for (let i = 0; i < 32; i++) last = (await fetch(`${base}/api/auth/validate-invite?code=NOPE-${i}`)).status;
    expect(last).toBe(429);
  });

  it('approves a request atomically: user, key and status together', () => {
    const req = createRegistrationRequest('approve-h@example.com', 'Password123!');
    const approved = approveRegistrationRequest(req.id, adminId);
    expect(getDb().prepare('SELECT role FROM users WHERE id = ?').get(approved.userId)).toEqual({ role: 'member' });
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM user_api_keys WHERE user_id = ?').get(approved.userId)).toEqual({ n: 1 });
    expect(listRegistrationRequests('pending').some(r => r.email === 'approve-h@example.com')).toBe(false);

    // A failure part way rolls everything back and leaves the request pending.
    const second = createRegistrationRequest('rollback-h@example.com', 'Password123!');
    getDb().exec('CREATE TRIGGER fail_key BEFORE INSERT ON user_api_keys BEGIN SELECT RAISE(ABORT, \'boom\'); END;');
    try {
      expect(() => approveRegistrationRequest(second.id, adminId)).toThrow(/boom/);
    } finally {
      getDb().exec('DROP TRIGGER fail_key');
    }
    expect(getDb().prepare('SELECT id FROM users WHERE email = ?').get('rollback-h@example.com')).toBeUndefined();
    expect(listRegistrationRequests('pending').some(r => r.email === 'rollback-h@example.com')).toBe(true);
  });

  it('reuses one key lookup within a request scope only', () => {
    const { id, key } = mintUserApiKey(adminId, 'memo');
    withUserKeyMemo(() => {
      expect(validateUserApiKey(key)).not.toBeNull();
      getDb().prepare('UPDATE user_api_keys SET revoked = 1 WHERE id = ?').run(id);
      expect(validateUserApiKey(key)).not.toBeNull(); // answered from the request's memo
    });
    expect(validateUserApiKey(key)).toBeNull(); // the next request sees the revocation
  });
});
