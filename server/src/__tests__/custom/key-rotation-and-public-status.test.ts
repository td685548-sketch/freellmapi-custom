import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { createSession, createUser } from '../../services/auth.js';
import {
  mintUserApiKey,
  validateUserApiKey,
} from '../../services/user-keys.js';
import { resetPublicStatusCacheForTests } from '../../routes/public-status.js';

let server: Server;
let base: string;
let memberId: number;
let memberToken: string;
let otherMemberId: number;
let otherMemberToken: string;

async function hit(path: string, method = 'GET', body?: unknown, token?: string) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return {
    status: res.status,
    headers: res.headers,
    body: (await res.json().catch(() => null)) as Record<string, any> | null,
  };
}

describe('1-Click Key Rotation & Public Operational Status', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = 'e'.repeat(64);
    initDb(':memory:');

    const app = createApp();
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const { port } = server.address() as { port: number };
    base = `http://127.0.0.1:${port}`;

    const member1 = createUser('rotation-user@example.com', 'Pass123456!');
    memberId = member1.userId;
    memberToken = createSession(memberId);

    const member2 = createUser('other-user@example.com', 'Pass123456!');
    otherMemberId = member2.userId;
    otherMemberToken = createSession(otherMemberId);
  });

  afterAll(async () => {
    resetPublicStatusCacheForTests();
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    getDb().close();
  });

  it('rotates personal API keys atomically: revokes old key and issues new key preserving config', async () => {
    // 1. Mint an initial key
    const initial = mintUserApiKey(memberId, 'My Cursor Key', { routingMode: 'eco' });
    expect(validateUserApiKey(initial.key)?.keyId).toBe(initial.id);

    // 2. Rotate the key
    const rotatedRes = await hit(`/api/user/keys/${initial.id}/rotate`, 'POST', {}, memberToken);
    expect(rotatedRes.status).toBe(200);
    expect(rotatedRes.body?.oldKeyId).toBe(initial.id);
    expect(rotatedRes.body?.key?.name).toBe('My Cursor Key');
    expect(rotatedRes.body?.key?.routingMode).toBe('eco');
    expect(rotatedRes.body?.key?.key).toMatch(/^sk-flm-[0-9a-f]{48}$/);

    const newKeyString = rotatedRes.body?.key?.key as string;
    const newKeyId = rotatedRes.body?.key?.id as number;

    // 3. Old key is immediately revoked and fails validation
    expect(validateUserApiKey(initial.key)).toBeNull();

    // 4. New key is active and validates
    const valid = validateUserApiKey(newKeyString);
    expect(valid).not.toBeNull();
    expect(valid?.keyId).toBe(newKeyId);
    expect(valid?.userId).toBe(memberId);
    expect(valid?.routingMode).toBe('eco');

    // 5. Trying to rotate the old revoked key again returns 404
    const duplicateRotate = await hit(`/api/user/keys/${initial.id}/rotate`, 'POST', {}, memberToken);
    expect(duplicateRotate.status).toBe(404);

    // 6. Another user cannot rotate this key
    const foreignRotate = await hit(`/api/user/keys/${newKeyId}/rotate`, 'POST', {}, otherMemberToken);
    expect(foreignRotate.status).toBe(404);
  });

  it('serves unauthenticated /api/public/status with model counts and platform families', async () => {
    resetPublicStatusCacheForTests();
    const res = await hit('/api/public/status', 'GET');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('public, max-age=10');
    expect(res.body?.status).toBe('operational');
    expect(res.body?.models?.total).toBeGreaterThan(0);
    expect(res.body?.models?.chat).toBeGreaterThan(0);
    expect(Array.isArray(res.body?.families)).toBe(true);
    expect(res.body?.families.length).toBeGreaterThan(0);

    // Assert zero leaked secrets
    const rawJson = JSON.stringify(res.body);
    expect(rawJson).not.toContain('Bearer');
    expect(rawJson).not.toContain('sk-');
    expect(rawJson).not.toContain('password');
  });
});
