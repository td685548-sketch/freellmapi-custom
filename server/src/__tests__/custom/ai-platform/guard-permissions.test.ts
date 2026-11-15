/**
 * Output Guard HTTP Permissions, Scope, Validation & Flag-Off Boundaries (Agent 4).
 *
 * Tests real createApp() + SQLite DB over localhost:0.
 * In RED state before Agent 1 router is mounted, /api/ai-platform/output-guard/* returns 404.
 */

import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../../app.js';
import { resetFlagsCacheForTests, setFlags } from '../../../custom/ai-platform/flags.js';
import { getDb, initDb } from '../../../db/index.js';
import { hashClientProfileKey } from '../../../lib/system-prompt.js';
import { createSession, createUser } from '../../../services/auth.js';
import { setUserPermissions } from '../../../services/users.js';

describe('Output Guard HTTP permissions & boundaries', () => {
  let server: Server;
  let base: string;
  let primaryId: number;
  let primaryToken: string;
  let parentOnlyToken: string;
  let viewOnlyToken: string;
  let editOnlyToken: string;
  let excerptOnlyToken: string;
  let profileId = 0;

  async function call(path: string, token?: string, method = 'GET', body?: unknown) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return {
      status: res.status,
      body: (await res.json().catch(() => null)) as Record<string, unknown> | null,
    };
  }

  function validPolicyPayload(revision = 0) {
    return {
      mode: 'block',
      failMode: 'allow',
      detectors: {
        keywords: { enabled: true, terms: ['forbidden-term'] },
        patterns: { enabled: false, rules: [] },
        promptLeak: { enabled: true, minShingles: 2 },
        pii: { enabled: true, action: 'mask' },
        maxLength: { enabled: false, chars: 20000 },
        moderation: { enabled: false },
        judge: { enabled: false, model: 'auto', criteria: '' },
      },
      replacementText: 'Blocked by guard',
      bypassRoles: [],
      holdChars: 200,
      maxDelayMs: 300,
      revision,
    };
  }

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    resetFlagsCacheForTests();
    setFlags({ outputGuard: false });

    const profRes = getDb()
      .prepare(
        `INSERT INTO client_profiles (name, token_hash, encrypted_key, iv, auth_tag, enabled)
         VALUES (?, ?, 'enc', 'iv', 'tag', 1)`,
      )
      .run('guard-perm-profile', hashClientProfileKey('flm_guard_perm_1'));
    profileId = Number(profRes.lastInsertRowid);

    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    primaryId = createUser('guard-primary@example.com', 'Password123!').userId;
    primaryToken = createSession(primaryId);

    const parentId = createUser('guard-parent@example.com', 'Password123!', 'member').userId;
    setUserPermissions(parentId, ['manage_ai_platform'], primaryId);
    parentOnlyToken = createSession(parentId);

    const viewId = createUser('guard-view@example.com', 'Password123!', 'member').userId;
    setUserPermissions(viewId, ['view_output_guard'], primaryId);
    viewOnlyToken = createSession(viewId);

    const editId = createUser('guard-edit@example.com', 'Password123!', 'member').userId;
    setUserPermissions(editId, ['edit_output_guard'], primaryId);
    editOnlyToken = createSession(editId);

    const excerptId = createUser('guard-excerpt@example.com', 'Password123!', 'member').userId;
    setUserPermissions(excerptId, ['view_guard_excerpts'], primaryId);
    excerptOnlyToken = createSession(excerptId);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('rejects unauthenticated requests with 401', async () => {
    const getRes = await call(`/api/ai-platform/output-guard/profile/${profileId}`);
    expect(getRes.status).toBe(401);
    const eventsRes = await call('/api/ai-platform/output-guard/events');
    expect(eventsRes.status).toBe(401);
    const excerptRes = await call('/api/ai-platform/output-guard/events/1/excerpt');
    expect(excerptRes.status).toBe(401);
  });

  it('rejects manage_ai_platform parent-only user with 403 on all output-guard endpoints', async () => {
    expect((await call(`/api/ai-platform/output-guard/profile/${profileId}`, parentOnlyToken)).status).toBe(403);
    expect((await call(`/api/ai-platform/output-guard/profile/${profileId}`, parentOnlyToken, 'PUT', validPolicyPayload(0))).status).toBe(403);
    expect((await call(`/api/ai-platform/output-guard/profile/${profileId}/test`, parentOnlyToken, 'POST', { text: 'hello' })).status).toBe(403);
    expect((await call('/api/ai-platform/output-guard/events', parentOnlyToken)).status).toBe(403);
    expect((await call('/api/ai-platform/output-guard/events/1/excerpt', parentOnlyToken)).status).toBe(403);
  });

  it('enforces exact child permissions for view_output_guard, edit_output_guard, and view_guard_excerpts', async () => {
    // view_output_guard: GET policy, POST local test, GET events allowed; PUT and excerpt 403
    expect((await call(`/api/ai-platform/output-guard/profile/${profileId}`, viewOnlyToken)).status).toBe(200);
    expect((await call(`/api/ai-platform/output-guard/profile/${profileId}/test`, viewOnlyToken, 'POST', { text: 'hello' })).status).toBe(200);
    expect((await call('/api/ai-platform/output-guard/events', viewOnlyToken)).status).toBe(200);
    expect((await call(`/api/ai-platform/output-guard/profile/${profileId}`, viewOnlyToken, 'PUT', validPolicyPayload(0))).status).toBe(403);
    expect((await call('/api/ai-platform/output-guard/events/1/excerpt', viewOnlyToken)).status).toBe(403);

    // edit_output_guard: cannot GET policy, POST test, GET events, or GET excerpt
    expect((await call(`/api/ai-platform/output-guard/profile/${profileId}`, editOnlyToken)).status).toBe(403);
    expect((await call(`/api/ai-platform/output-guard/profile/${profileId}/test`, editOnlyToken, 'POST', { text: 'hello' })).status).toBe(403);
    expect((await call('/api/ai-platform/output-guard/events', editOnlyToken)).status).toBe(403);
    expect((await call('/api/ai-platform/output-guard/events/1/excerpt', editOnlyToken)).status).toBe(403);

    // view_guard_excerpts: cannot GET policy, PUT policy, POST test, or GET events
    expect((await call(`/api/ai-platform/output-guard/profile/${profileId}`, excerptOnlyToken)).status).toBe(403);
    expect((await call(`/api/ai-platform/output-guard/profile/${profileId}`, excerptOnlyToken, 'PUT', validPolicyPayload(0))).status).toBe(403);
    expect((await call(`/api/ai-platform/output-guard/profile/${profileId}/test`, excerptOnlyToken, 'POST', { text: 'hello' })).status).toBe(403);
    expect((await call('/api/ai-platform/output-guard/events', excerptOnlyToken)).status).toBe(403);
    // Non-existent event ID with view_guard_excerpts returns 404 (not 403)
    expect((await call('/api/ai-platform/output-guard/events/999999/excerpt', excerptOnlyToken)).status).toBe(404);
  });

  it('allows local CRUD and local tester when flag is off, but rejects includeExternal with 409 pillar_disabled', async () => {
    setFlags({ outputGuard: false });

    const putRes = await call(
      `/api/ai-platform/output-guard/profile/${profileId}`,
      primaryToken,
      'PUT',
      validPolicyPayload(0),
    );
    expect(putRes.status).toBe(200);

    const localTest = await call(
      `/api/ai-platform/output-guard/profile/${profileId}/test`,
      primaryToken,
      'POST',
      { text: 'contains forbidden-term here', includeExternal: false },
    );
    expect(localTest.status).toBe(200);
    expect(localTest.body?.action).toBe('blocked');

    const extTest = await call(
      `/api/ai-platform/output-guard/profile/${profileId}/test`,
      primaryToken,
      'POST',
      { text: 'hello', includeExternal: true },
    );
    expect(extTest.status).toBe(409);
  });

  it('returns 409 scope_unavailable for agent scope, 409 on revision conflict, and 422 on unsafe regex', async () => {
    const agentRes = await call('/api/ai-platform/output-guard/agent/triage', primaryToken);
    expect(agentRes.status).toBe(409);

    const current = await call(`/api/ai-platform/output-guard/profile/${profileId}`, primaryToken);
    expect(current.status).toBe(200);
    const rev = (current.body?.policy as { revision: number }).revision;

    // Stale revision -> 409
    const stalePut = await call(
      `/api/ai-platform/output-guard/profile/${profileId}`,
      primaryToken,
      'PUT',
      validPolicyPayload(rev + 99),
    );
    expect(stalePut.status).toBe(409);

    // Unsafe/ReDoS regex -> 422
    const badRegexPayload = validPolicyPayload(rev);
    badRegexPayload.detectors.patterns = {
      enabled: true,
      rules: [{ id: 'redos', name: 'ReDoS', pattern: '(a+)+$', flags: '' }],
    };
    const badRes = await call(
      `/api/ai-platform/output-guard/profile/${profileId}`,
      primaryToken,
      'PUT',
      badRegexPayload,
    );
    expect(badRes.status).toBe(422);
  });
});
