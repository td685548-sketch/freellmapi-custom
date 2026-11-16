import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_GUARD_DETECTORS,
  DEFAULT_GUARD_POLICY_BASE,
} from '@freellmapi/shared/ai-platform-output-guard.js';
import { createApp } from '../../../app.js';
import { getDb, initDb } from '../../../db/index.js';
import { createSession, createUser } from '../../../services/auth.js';
import { resetFlagsCacheForTests } from '../../../custom/ai-platform/flags.js';
import {
  recordGuardEvent,
  resetGuardEventRateLimitForTests,
} from '../../../custom/ai-platform/output-guard/events.js';

let server: http.Server | null = null;
let baseUrl = '';

async function startTestApp() {
  const app = createApp();
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', () => resolve()));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
}

async function api(
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

function seedProfile(id: number): void {
  getDb()
    .prepare(
      'INSERT INTO client_profiles (id, name, token_hash, encrypted_key, iv, auth_tag) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(id, `p-${id}`, `th-${id}`, `ek-${id}`, `iv-${id}`, `tag-${id}`);
}

describe('Output Guard Admin Router (T068)', () => {
  beforeEach(async () => {
    initDb(':memory:');
    resetFlagsCacheForTests();
    resetGuardEventRateLimitForTests();
    seedProfile(1);
    await startTestApp();
  });

  afterEach(async () => {
    resetFlagsCacheForTests();
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
    try {
      getDb().close();
    } catch {
      /* already closed */
    }
  });

  it('enforces auth, exact child permissions (unrelated ai-platform perms denied), and route ordering', async () => {
    await createUser('primary@example.com', 'password123', 'admin');
    const overviewOnly = await createUser('overview@example.com', 'password123', 'member');
    const parentOnly = await createUser('parent@example.com', 'password123', 'member');
    const viewOnly = await createUser('view@example.com', 'password123', 'member');
    const editOnly = await createUser('edit@example.com', 'password123', 'member');
    const excerptOnly = await createUser('excerpt@example.com', 'password123', 'member');

    getDb()
      .prepare('UPDATE users SET permissions = ? WHERE id = ?')
      .run(JSON.stringify(['view_ai_platform', 'edit_ai_flags']), overviewOnly.userId);
    getDb()
      .prepare('UPDATE users SET permissions = ? WHERE id = ?')
      .run(JSON.stringify(['manage_ai_platform']), parentOnly.userId);
    getDb()
      .prepare('UPDATE users SET permissions = ? WHERE id = ?')
      .run(JSON.stringify(['view_output_guard']), viewOnly.userId);
    getDb()
      .prepare('UPDATE users SET permissions = ? WHERE id = ?')
      .run(JSON.stringify(['edit_output_guard']), editOnly.userId);
    getDb()
      .prepare('UPDATE users SET permissions = ? WHERE id = ?')
      .run(JSON.stringify(['view_guard_excerpts']), excerptOnly.userId);

    const overviewToken = createSession(overviewOnly.userId);
    const parentToken = createSession(parentOnly.userId);
    const viewToken = createSession(viewOnly.userId);
    const editToken = createSession(editOnly.userId);
    const excerptToken = createSession(excerptOnly.userId);

    // Unauthenticated -> 401
    expect((await api('GET', '/api/ai-platform/output-guard/profile/1')).status).toBe(401);

    // Unrelated AI platform permissions cannot access output-guard routes
    expect((await api('GET', '/api/ai-platform/output-guard/profile/1', overviewToken)).status).toBe(403);
    expect((await api('GET', '/api/ai-platform/output-guard/events', overviewToken)).status).toBe(403);

    // manage_ai_platform parent-only must NOT bypass exact child permission gates
    const parentGetPolicy = await api('GET', '/api/ai-platform/output-guard/profile/1', parentToken);
    expect(parentGetPolicy.status).toBe(403);
    expect((parentGetPolicy.json.error as { code: string }).code).toBe('missing_permission');

    const parentGetEvents = await api('GET', '/api/ai-platform/output-guard/events', parentToken);
    expect(parentGetEvents.status).toBe(403);
    expect((parentGetEvents.json.error as { code: string }).code).toBe('missing_permission');

    const parentPutPolicy = await api('PUT', '/api/ai-platform/output-guard/profile/1', parentToken, {
      ...DEFAULT_GUARD_POLICY_BASE,
      detectors: DEFAULT_GUARD_DETECTORS,
      revision: 0,
    });
    expect(parentPutPolicy.status).toBe(403);
    expect((parentPutPolicy.json.error as { code: string }).code).toBe('missing_permission');

    const parentTestPolicy = await api('POST', '/api/ai-platform/output-guard/profile/1/test', parentToken, {
      text: 'hello',
    });
    expect(parentTestPolicy.status).toBe(403);
    expect((parentTestPolicy.json.error as { code: string }).code).toBe('missing_permission');

    // view_output_guard can GET policy and GET events (not shadowed by :scope!)
    const getPolicyRes = await api('GET', '/api/ai-platform/output-guard/profile/1', viewToken);
    expect(getPolicyRes.status).toBe(200);
    expect((getPolicyRes.json.policy as { revision: number }).revision).toBe(0);

    const getEventsRes = await api('GET', '/api/ai-platform/output-guard/events', viewToken);
    expect(getEventsRes.status).toBe(200);
    expect(Array.isArray(getEventsRes.json.events)).toBe(true);

    // view_output_guard cannot PUT policy or GET excerpt
    const putDenied = await api('PUT', '/api/ai-platform/output-guard/profile/1', viewToken, {
      ...DEFAULT_GUARD_POLICY_BASE,
      detectors: DEFAULT_GUARD_DETECTORS,
      revision: 0,
    });
    expect(putDenied.status).toBe(403);

    // Seed an event with excerpt
    const ev = recordGuardEvent({
      scope: { kind: 'profile', id: '1' },
      endUser: 'u1',
      detector: 'keywords',
      action: 'blocked',
      wire: 'openai-chat',
      streamed: false,
      excerptSourceText: 'secret violation snippet',
      matchOffset: 0,
      matchLength: 6,
    });
    expect(ev.recorded).toBe(true);

    expect(
      (await api('GET', `/api/ai-platform/output-guard/events/${ev.id}/excerpt`, viewToken)).status,
    ).toBe(403);

    const parentGetExcerpt = await api(
      'GET',
      `/api/ai-platform/output-guard/events/${ev.id}/excerpt`,
      parentToken,
    );
    expect(parentGetExcerpt.status).toBe(403);
    expect((parentGetExcerpt.json.error as { code: string }).code).toBe('missing_permission');

    // view_guard_excerpts can read excerpt and records audit log WITHOUT plaintext excerpt in summary
    const excerptRes = await api(
      'GET',
      `/api/ai-platform/output-guard/events/${ev.id}/excerpt`,
      excerptToken,
    );
    expect(excerptRes.status).toBe(200);
    expect(excerptRes.json.excerpt).toContain('secret violation snippet');

    const auditRows = getDb()
      .prepare('SELECT method, route, area, target_id, summary FROM custom_audit_log ORDER BY id DESC LIMIT 5')
      .all() as Array<{ method: string; route: string; area: string; target_id: number | null; summary: string | null }>;
    expect(auditRows.some((r) => (r.summary ?? '').includes('secret violation snippet'))).toBe(false);
    expect(auditRows.some((r) => r.method === 'GET' && r.route.includes('excerpt') && r.target_id === ev.id)).toBe(true);

    // edit_output_guard can PUT policy even when flag is off
    const putOk = await api('PUT', '/api/ai-platform/output-guard/profile/1', editToken, {
      ...DEFAULT_GUARD_POLICY_BASE,
      mode: 'log',
      detectors: DEFAULT_GUARD_DETECTORS,
      revision: 0,
    });
    expect(putOk.status).toBe(200);
    expect((putOk.json.policy as { revision: number }).revision).toBe(1);
  });

  it('returns 409 pillar_disabled on /test when includeExternal=true while flag is off', async () => {
    const primary = await createUser('primary2@example.com', 'password123', 'admin');
    const token = createSession(primary.userId);

    const res = await api('POST', '/api/ai-platform/output-guard/profile/1/test', token, {
      text: 'hello world',
      includeExternal: true,
    });
    expect(res.status).toBe(409);
    expect((res.json.error as { code: string }).code).toBe('pillar_disabled');

    // Local dry-run /test succeeds even when flag is off
    const localTest = await api('POST', '/api/ai-platform/output-guard/profile/1/test', token, {
      text: 'hello world',
    });
    expect(localTest.status).toBe(200);
    expect(localTest.json.action).toBe('pass');

    // Overview reports implemented pillars ready=true
    const overview = await api('GET', '/api/ai-platform/overview', token);
    expect(overview.status).toBe(200);
    const pillars = overview.json.pillars as Record<string, { ready: boolean }>;
    expect(pillars.outputGuard.ready).toBe(true);
    expect(pillars.mcpClient.ready).toBe(true);
    expect(pillars.retrieval.ready).toBe(true);
    expect(pillars.prompts.ready).toBe(true);
  });
});
