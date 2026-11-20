import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import {
  DESKTOP_SESSION_TTL_MS,
  DESKTOP_USER_EMAIL,
  createUser,
  desktopSessionToken,
  userCount,
  validateSession,
} from '../../services/auth.js';

// Session mitigations: desktopSessionToken() used to create the hidden machine
// account only on an empty database and then sign in as the lowest-id user,
// so a database that already had a real user made the desktop shell silently
// authenticate as that account (the primary admin, typically). It must always
// resolve the desktop@localhost account by email, and the session it mints
// must be short-lived (24h, not the browser's 30 days) because the shell can
// mint a fresh one on demand.

beforeEach(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
});

describe('desktopSessionToken', () => {
  it('signs in as desktop@localhost, never as a pre-existing real user', () => {
    const admin = createUser('admin@example.com', 'AdminPass123!');
    expect(admin.role).toBe('admin');
    expect(userCount()).toBe(1);

    const token = desktopSessionToken();

    expect(userCount()).toBe(2);
    const session = validateSession(token);
    expect(session?.email).toBe(DESKTOP_USER_EMAIL);
    expect(session?.userId).not.toBe(admin.userId);
    expect(session?.role).toBe('member');
  });

  it('reuses the existing desktop@localhost account instead of creating another', () => {
    createUser('admin@example.com', 'AdminPass123!');
    desktopSessionToken();
    expect(userCount()).toBe(2);

    const token = desktopSessionToken();
    expect(userCount()).toBe(2);
    expect(validateSession(token)?.email).toBe(DESKTOP_USER_EMAIL);
  });

  it('still creates the hidden account on a fresh database', () => {
    const token = desktopSessionToken();
    expect(userCount()).toBe(1);
    expect(validateSession(token)?.email).toBe(DESKTOP_USER_EMAIL);
  });

  it('mints a desktop session that expires within 24 hours', () => {
    const before = Date.now();
    const token = desktopSessionToken();
    const after = Date.now();

    expect(DESKTOP_SESSION_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(validateSession(token)?.email).toBe(DESKTOP_USER_EMAIL);
    const row = getDb().prepare('SELECT expires_at_ms FROM sessions').get() as { expires_at_ms: number };
    expect(row.expires_at_ms).toBeGreaterThan(before + DESKTOP_SESSION_TTL_MS - 60_000);
    expect(row.expires_at_ms).toBeLessThanOrEqual(after + DESKTOP_SESSION_TTL_MS);
  });
});
