/**
 * T107 / T110 / T111 / T112 — Versioned Prompts End-to-End HTTP Tests
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SYSTEM_PROMPT_VARIABLES } from '@freellmapi/shared/ai-platform-prompts.js';
import { createApp } from '../../../app.js';
import { resetFlagsCacheForTests, setFlags } from '../../../custom/ai-platform/flags.js';
import {
  executeSupportChatPipeline,
} from '../../../custom/x-gateway/support-router.js';
import {
  createSupportTenant,
  ensureSupportTables,
  getSupportTenant,
} from '../../../custom/x-gateway/support-store.js';
import { createApiKeyAccount, invalidateXGatewayKeyCache } from '../../../custom/provider-accounts/store.js';
import { defaultDbFactory, getDb, getUnifiedApiKey, initDb, setSetting } from '../../../db/index.js';
import { wrapTursoDatabase } from '../../../db/turso.js';
import { encrypt } from '../../../lib/crypto.js';
import { createSession, createUser } from '../../../services/auth.js';
import { setKeyCacheTestOverride } from '../../../services/key-cache.js';
import { resetKnowledgeIndexes } from '../../../services/profile-knowledge.js';
import { getActiveProfileId } from '../../../services/profile-models.js';
import { clearAllCooldowns } from '../../../services/ratelimit.js';
import { clearAllPenalties } from '../../../services/router.js';
import {
  startFakeProviderServer,
  type FakeProviderServer,
} from '../../helpers/ai-platform-fake-provider.js';

let appServer: http.Server | null = null;
let baseUrl = '';
let fakeProvider: FakeProviderServer;
const realFetch = global.fetch;

let primaryToken = '';
let profileKey = '';
let profileId = 0;

function seedModelsAndKeys(): void {
  setKeyCacheTestOverride(true);
  const db = getDb();

  for (const [platform, label, secret] of [
    ['groq', 'groq-prompts-e2e', 'gsk_prompts_e2e_test'],
    ['google', 'google-prompts-e2e', 'AIzaPromptsE2ETestKey'],
  ] as const) {
    const enc = encrypt(secret);
    db.prepare(
      `INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
       VALUES (?, ?, ?, ?, ?, 'healthy', 1)`,
    ).run(platform, label, enc.encrypted, enc.iv, enc.authTag);
  }

  db.prepare(
    `INSERT OR IGNORE INTO models
      (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window, enabled, supports_vision, supports_tools, source)
     VALUES
      ('groq', 'llama-3.3-70b-versatile', 'Llama 3.3 70B', 1, 10, 'Large', 60, 1000, 120000, NULL, '~10M', 128000, 1, 0, 1, 'catalog'),
      ('google', 'gemma-4-31b-it', 'Gemma 4 31B', 2, 9, 'Large', 60, 1000, 1000000, NULL, '~10M', 128000, 1, 1, 1, 'catalog')`,
  ).run();

  db.prepare(`UPDATE fallback_config SET enabled = 0`).run();
  const activeProfileId = getActiveProfileId(db);
  if (activeProfileId != null) {
    db.prepare(`UPDATE profile_models SET enabled = 0 WHERE profile_id = ?`).run(activeProfileId);
  }

  const upsertChain = (platform: string, modelId: string, priority: number) => {
    const row = db
      .prepare(`SELECT id FROM models WHERE platform = ? AND model_id = ? LIMIT 1`)
      .get(platform, modelId) as { id: number } | undefined;
    if (!row) throw new Error(`Missing model ${platform}/${modelId}`);
    db.prepare(
      `INSERT INTO fallback_config (model_db_id, priority, enabled)
       VALUES (?, ?, 1)
       ON CONFLICT(model_db_id) DO UPDATE SET priority = excluded.priority, enabled = 1`,
    ).run(row.id, priority);
    if (activeProfileId != null) {
      db.prepare(
        `INSERT INTO profile_models (profile_id, model_db_id, priority, enabled)
         VALUES (?, ?, ?, 1)
         ON CONFLICT(profile_id, model_db_id) DO UPDATE SET priority = excluded.priority, enabled = 1`,
      ).run(activeProfileId, row.id, priority);
    }
  };

  upsertChain('groq', 'llama-3.3-70b-versatile', 1);
  upsertChain('google', 'gemma-4-31b-it', 2);
  setSetting('routing_strategy', 'priority');
}

async function api(
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await realFetch(`${baseUrl}${path}`, {
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

async function chatOpenAi(
  token: string,
  userContent: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; upstreamBody: Record<string, unknown> }> {
  const res = await realFetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...extraHeaders,
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: userContent }],
    }),
  });
  const upstreamBody = (fakeProvider.requests.at(-1)?.bodyJson ?? {}) as Record<string, unknown>;
  return { status: res.status, upstreamBody };
}

describe('Versioned Prompts E2E (T107 / T110 / T111 / T112)', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    vi.stubEnv('FREEAPI_TURSO_BATCH_WRITES', '1');
    resetKnowledgeIndexes();
    initDb(':memory:', { factory: () => wrapTursoDatabase(defaultDbFactory()(':memory:'), true) });

    fakeProvider = await startFakeProviderServer({
      kind: 'scripted',
      text: 'prompt-e2e-ok',
      usage: { promptTokens: 15, completionTokens: 5, totalTokens: 20 },
    });
  });

  beforeEach(async () => {
    clearAllCooldowns();
    clearAllPenalties();
    resetFlagsCacheForTests();
    resetKnowledgeIndexes();

    initDb(':memory:', { factory: () => wrapTursoDatabase(defaultDbFactory()(':memory:'), true) });
    invalidateXGatewayKeyCache();
    seedModelsAndKeys();
    ensureSupportTables();
    createApiKeyAccount({
      provider: 'groq',
      key: 'gsk_support_e2e_test',
      label: 'groq-support-e2e',
    });

    const app = createApp();
    appServer = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => appServer!.once('listening', () => resolve()));
    baseUrl = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;

    const owner = await createUser('prompts-owner@example.com', 'OwnerPass123!', 'admin');
    primaryToken = createSession(owner.userId);

    const createdProfile = await api('POST', '/api/client-profiles', primaryToken, {
      name: 'Acme Support Key',
      systemPrompt: 'Initial v1 for {{profile_name}}.',
    });
    expect(createdProfile.status).toBe(201);
    profileId = Number(createdProfile.json.id);
    profileKey = String(createdProfile.json.key);

    await api('PUT', `/api/client-profiles/${profileId}/quota`, primaryToken, { rpmLimit: null });

    fakeProvider.clearRequests();

    vi.spyOn(global, 'fetch').mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const urlStr =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        if (urlStr.startsWith(baseUrl) || urlStr.startsWith(fakeProvider.url)) {
          return realFetch(input, init);
        }
        const parsed = new URL(urlStr);
        return realFetch(`${fakeProvider.url}${parsed.pathname}${parsed.search}`, init);
      },
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    resetFlagsCacheForTests();
    if (appServer) {
      await new Promise<void>((resolve) => appServer!.close(() => resolve()));
      appServer = null;
    }
    try {
      getDb().close();
    } catch {
      /* already closed */
    }
  });

  afterAll(async () => {
    await fakeProvider.close();
  });

  it('draft does not affect live chat; publish v2 and restore v1 take effect immediately across all 4 wires', async () => {
    setFlags({ prompts: true });

    // Overview marks prompts ready=true
    const overview = await api('GET', '/api/ai-platform/overview', primaryToken);
    expect(overview.status).toBe(200);
    const pillars = overview.json.pillars as Record<string, { enabled: boolean; ready: boolean }>;
    expect(pillars.prompts.ready).toBe(true);
    expect(pillars.prompts.enabled).toBe(true);

    // Initial v1 state
    const initialState = await api('GET', `/api/ai-platform/prompts/profile/${profileId}`, primaryToken);
    expect(initialState.status).toBe(200);
    const head1 = initialState.json.head as { publishedVersion: number; draftVersion: number | null; revision: number };
    expect(head1.publishedVersion).toBe(1);
    expect(head1.draftVersion).toBeNull();

    // Save draft v2 (with note)
    const draftRes = await api('PUT', `/api/ai-platform/prompts/profile/${profileId}/draft`, primaryToken, {
      body: 'Published v2 for {{profile_name}} on {{date}}.',
      note: 'Add date',
      revision: head1.revision,
    });
    expect(draftRes.status).toBe(200);
    const stateAfterDraft = await api('GET', `/api/ai-platform/prompts/profile/${profileId}`, primaryToken);
    const headAfterDraft = stateAfterDraft.json.head as { publishedVersion: number; draftVersion: number; revision: number };
    expect(headAfterDraft.publishedVersion).toBe(1);
    expect(headAfterDraft.draftVersion).toBe(2);

    // Live chat still uses published v1 (draft must NOT leak into live traffic)
    const chatWhileDraft = await chatOpenAi(profileKey, 'Hello while draft');
    expect(chatWhileDraft.status).toBe(200);
    const msgsWhileDraft = chatWhileDraft.upstreamBody.messages as Array<{ role: string; content: string }>;
    expect(msgsWhileDraft[0]).toEqual({
      role: 'system',
      content: 'Initial v1 for Acme Support Key.',
    });

    // Publish v2 -> takes effect immediately across all 4 wires
    const pubRes = await api('POST', `/api/ai-platform/prompts/profile/${profileId}/publish`, primaryToken, {
      revision: headAfterDraft.revision,
    });
    expect(pubRes.status).toBe(200);
    const today = new Date().toISOString().slice(0, 10);
    const expectedV2 = `Published v2 for Acme Support Key on ${today}.`;

    // 1. OpenAI chat
    const chatV2 = await chatOpenAi(profileKey, 'Hello OpenAI v2');
    expect(chatV2.status).toBe(200);
    expect((chatV2.upstreamBody.messages as Array<{ role: string; content: string }>)[0]?.content).toBe(expectedV2);

    // 2. Anthropic /v1/messages
    const anthRes = await realFetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': profileKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Hello Anthropic v2' }],
      }),
    });
    expect(anthRes.status).toBe(200);
    const anthUpstream = fakeProvider.requests.at(-1)?.bodyJson as { messages: Array<{ role: string; content: string }> };
    expect(anthUpstream.messages[0]?.content).toBe(expectedV2);

    // 3. Responses /v1/responses
    const respRes = await realFetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${profileKey}`,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        input: 'Hello Responses v2',
      }),
    });
    expect(respRes.status).toBe(200);
    const respUpstream = fakeProvider.requests.at(-1)?.bodyJson as { messages: Array<{ role: string; content: string }> };
    expect(respUpstream.messages[0]?.content).toBe(expectedV2);

    // 4. Gemini /v1beta/models/...:generateContent
    const gemRes = await realFetch(`${baseUrl}/v1beta/models/gemma-4-31b-it:generateContent`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': profileKey,
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Hello Gemini v2' }] }],
      }),
    });
    expect(gemRes.status).toBe(200);
    const gemUpstream = fakeProvider.requests.at(-1)?.bodyJson as {
      systemInstruction?: { parts: Array<{ text: string }> };
      contents?: Array<{ role: string; parts: Array<{ text: string }> }>;
    };
    const gemSystemText =
      gemUpstream.systemInstruction?.parts[0]?.text ?? gemUpstream.contents?.[0]?.parts[0]?.text;
    expect(gemSystemText).toBe(expectedV2);

    // Diff v1 vs v2
    const diffRes = await api(
      'GET',
      `/api/ai-platform/prompts/profile/${profileId}/diff?from=1&to=2`,
      primaryToken,
    );
    expect(diffRes.status).toBe(200);
    expect((diffRes.json.stats as { added: number; removed: number }).added).toBeGreaterThan(0);

    // Restore v1 -> creates v3 and takes effect immediately
    const stateBeforeRestore = await api('GET', `/api/ai-platform/prompts/profile/${profileId}`, primaryToken);
    const revBeforeRestore = (stateBeforeRestore.json.head as { revision: number }).revision;
    const restoreRes = await api('POST', `/api/ai-platform/prompts/profile/${profileId}/restore`, primaryToken, {
      version: 1,
      revision: revBeforeRestore,
    });
    expect(restoreRes.status).toBe(200);
    const restoreHead = restoreRes.json.head as { publishedVersion: number };
    expect(restoreHead.publishedVersion).toBe(3);

    const v3Res = await api('GET', `/api/ai-platform/prompts/profile/${profileId}/versions/3`, primaryToken);
    expect(v3Res.status).toBe(200);
    expect((v3Res.json.version as { restoredFrom: number }).restoredFrom).toBe(1);

    const chatV3 = await chatOpenAi(profileKey, 'Hello after restore');
    expect(chatV3.status).toBe(200);
    expect((chatV3.upstreamBody.messages as Array<{ role: string; content: string }>)[0]?.content).toBe(
      'Initial v1 for Acme Support Key.',
    );
  });

  it('handles x-freellm-vars safely (declared caller vars, no system override, no double-expansion, >2KB/malformed ignored)', async () => {
    setFlags({ prompts: true });

    const st = await api('GET', `/api/ai-platform/prompts/profile/${profileId}`, primaryToken);
    const rev = (st.json.head as { revision: number }).revision;
    const saveRes = await api('PUT', `/api/ai-platform/prompts/profile/${profileId}/draft`, primaryToken, {
      body: 'Brand={{brand|FallbackBrand}} Tier={{tier}} Date={{date}} User={{end_user_id}} Name={{end_user_name}} Lang={{language}}',
      variables: [
        { name: 'brand', source: 'caller', default: 'DefaultBrand' },
        { name: 'tier', source: 'custom', default: 'Gold' },
      ],
      revision: rev,
    });
    expect(saveRes.status).toBe(200);

    const st2 = await api('GET', `/api/ai-platform/prompts/profile/${profileId}`, primaryToken);
    const rev2 = (st2.json.head as { revision: number }).revision;
    await api('POST', `/api/ai-platform/prompts/profile/${profileId}/publish`, primaryToken, {
      revision: rev2,
    });

    const today = new Date().toISOString().slice(0, 10);

    // Valid caller vars + attempts to override system var `date` + inject `{{date}}` in value
    const res1 = await chatOpenAi(profileKey, 'Test vars', {
      'x-freellm-vars': JSON.stringify({
        brand: 'Literal {{date}}\x00!',
        date: '1999-01-01',
        undeclared_var: 'ignored',
      }),
      'x-end-user': 'u_99',
      'x-end-user-name': 'Alice Nguyen',
      'accept-language': 'vi-VN,vi;q=0.9',
    });
    expect(res1.status).toBe(200);
    const sys1 = (res1.upstreamBody.messages as Array<{ role: string; content: string }>)[0]?.content;
    expect(sys1).toBe(
      `Brand=Literal {{date}}! Tier=Gold Date=${today} User=u_99 Name=Alice Nguyen Lang=vi`,
    );

    // Caller var > 200 chars is truncated cleanly
    const longBrand = 'B'.repeat(250);
    const resTrunc = await chatOpenAi(profileKey, 'Test truncation', {
      'x-freellm-vars': JSON.stringify({ brand: longBrand }),
    });
    expect(resTrunc.status).toBe(200);
    const sysTrunc = (resTrunc.upstreamBody.messages as Array<{ role: string; content: string }>)[0]?.content;
    expect(sysTrunc).toContain(`Brand=${'B'.repeat(200)} `);

    // Oversized (>2KB) x-freellm-vars ignored silently -> falls back to inline/declared default
    const oversized = JSON.stringify({ brand: 'X'.repeat(2100) });
    expect(Buffer.byteLength(oversized, 'utf8')).toBeGreaterThan(2048);
    const res2 = await chatOpenAi(profileKey, 'Test oversized vars', {
      'x-freellm-vars': oversized,
    });
    expect(res2.status).toBe(200);
    const sys2 = (res2.upstreamBody.messages as Array<{ role: string; content: string }>)[0]?.content;
    expect(sys2).toContain('Brand=FallbackBrand');

    // Malformed JSON x-freellm-vars ignored silently
    const res3 = await chatOpenAi(profileKey, 'Test malformed vars', {
      'x-freellm-vars': '{broken-json',
    });
    expect(res3.status).toBe(200);
    const sys3 = (res3.upstreamBody.messages as Array<{ role: string; content: string }>)[0]?.content;
    expect(sys3).toContain('Brand=FallbackBrand');

    // When pillar flag is turned OFF, template passes through literally without substitution
    setFlags({ prompts: false });
    const resOff = await chatOpenAi(profileKey, 'Test pillar off', {
      'x-freellm-vars': JSON.stringify({ brand: 'Acme' }),
    });
    expect(resOff.status).toBe(200);
    const sysOff = (resOff.upstreamBody.messages as Array<{ role: string; content: string }>)[0]?.content;
    expect(sysOff).toBe(
      'Brand={{brand|FallbackBrand}} Tier={{tier}} Date={{date}} User={{end_user_id}} Name={{end_user_name}} Lang={{language}}',
    );
  });

  it('renders support tenant prompt via support-router (T111)', async () => {
    const { tenant } = createSupportTenant({
      name: 'Shop Tenant',
      slug: 'shop-tenant-prompts',
      systemPrompt: 'Hello {{end_user_name}} ({{end_user_id}}) from {{profile_name}} on {{date}}.',
    });

    const userContext = {
      tenantId: tenant.id,
      userId: 'cust_42',
      name: 'Bob Tran',
      role: 'customer',
      permissions: ['products:read'],
      verified: true,
    };

    // Flag off: literal template preserved
    setFlags({ prompts: false });
    let capturedPromptOff = '';
    await executeSupportChatPipeline({
      tenant,
      userContext,
      messages: [{ role: 'user', content: 'Hi' }],
      model: 'groq/llama-3.3-70b-versatile',
      hooks: {
        beforeModelCall: (msgs) => {
          capturedPromptOff = msgs[0]?.content ?? '';
        },
      },
    });
    expect(capturedPromptOff).toContain('Hello {{end_user_name}} ({{end_user_id}}) from {{profile_name}} on {{date}}.');

    // Flag on: template rendered
    setFlags({ prompts: true });
    const today = new Date().toISOString().slice(0, 10);
    let capturedPromptOn = '';
    await executeSupportChatPipeline({
      tenant,
      userContext,
      messages: [{ role: 'user', content: 'Hi' }],
      model: 'groq/llama-3.3-70b-versatile',
      hooks: {
        beforeModelCall: (msgs) => {
          capturedPromptOn = msgs[0]?.content ?? '';
        },
      },
    });
    expect(capturedPromptOn).toContain(`Hello Bob Tran (cust_42) from Shop Tenant on ${today}.`);

    // Publishing support_tenant prompt updates x_support_tenants.system_prompt
    const st = await api('GET', `/api/ai-platform/prompts/support-tenant/${tenant.id}`, primaryToken);
    expect(st.status).toBe(200);
    const rev = (st.json.head as { revision: number }).revision;
    await api('PUT', `/api/ai-platform/prompts/support-tenant/${tenant.id}/draft`, primaryToken, {
      body: 'V2 Tenant {{profile_name}}',
      revision: rev,
    });
    const st2 = await api('GET', `/api/ai-platform/prompts/support-tenant/${tenant.id}`, primaryToken);
    await api('POST', `/api/ai-platform/prompts/support-tenant/${tenant.id}/publish`, primaryToken, {
      revision: (st2.json.head as { revision: number }).revision,
    });
    expect(getSupportTenant(tenant.id).systemPrompt).toBe('V2 Tenant {{profile_name}}');
  });

  it('POST /try returns 409 pillar_disabled when off, calls loopback when on without charging client profile quota', async () => {
    // When prompts pillar is off -> 409 pillar_disabled
    setFlags({ prompts: false });
    const tryOff = await api('POST', `/api/ai-platform/prompts/profile/${profileId}/try`, primaryToken, {
      body: 'Draft try for {{profile_name}}',
      message: 'Ping?',
    });
    expect(tryOff.status).toBe(409);
    expect((tryOff.json.error as { code: string }).code).toBe('pillar_disabled');

    // When prompts pillar is on -> 200 and zero requests recorded against profileId
    setFlags({ prompts: true });
    const beforeCount = (
      getDb().prepare('SELECT COUNT(*) AS n FROM requests WHERE profile_id = ?').get(profileId) as {
        n: number;
      }
    ).n;
    expect(beforeCount).toBe(0);

    const tryOn = await api('POST', `/api/ai-platform/prompts/profile/${profileId}/try`, primaryToken, {
      body: 'System for {{profile_name}} using {{custom_var}}',
      variables: [{ name: 'custom_var', source: 'custom', default: 'val1' }],
      message: 'Test hello',
      model: 'llama-3.3-70b-versatile',
    });
    expect(tryOn.status).toBe(200);
    expect(tryOn.json.reply).toBe('prompt-e2e-ok');
    expect(tryOn.json.rendered).toBe('System for Acme Support Key using val1');
    expect(tryOn.json.missing).toEqual([]);

    const upstream = fakeProvider.requests.at(-1)?.bodyJson as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(upstream.messages[0]).toEqual({
      role: 'system',
      content: 'System for Acme Support Key using val1',
    });
    expect(upstream.messages[1]).toEqual({ role: 'user', content: 'Test hello' });

    const afterCount = (
      getDb().prepare('SELECT COUNT(*) AS n FROM requests WHERE profile_id = ?').get(profileId) as {
        n: number;
      }
    ).n;
    expect(afterCount).toBe(0);
    expect(getUnifiedApiKey()).toBeTruthy();
  });

  it('enforces validation (422), revision conflict (409), preview, discard, variables catalog, and RBAC matrix', async () => {
    const parentOnly = await createUser('parent@example.com', 'password123', 'member');
    const viewOnly = await createUser('view@example.com', 'password123', 'member');
    const editOnly = await createUser('edit@example.com', 'password123', 'member');
    const publishOnly = await createUser('publish@example.com', 'password123', 'member');

    getDb()
      .prepare('UPDATE users SET permissions = ? WHERE id = ?')
      .run(JSON.stringify(['manage_ai_platform']), parentOnly.userId);
    getDb()
      .prepare('UPDATE users SET permissions = ? WHERE id = ?')
      .run(JSON.stringify(['view_prompts']), viewOnly.userId);
    getDb()
      .prepare('UPDATE users SET permissions = ? WHERE id = ?')
      .run(JSON.stringify(['edit_prompts']), editOnly.userId);
    getDb()
      .prepare('UPDATE users SET permissions = ? WHERE id = ?')
      .run(JSON.stringify(['publish_prompts']), publishOnly.userId);

    const parentToken = createSession(parentOnly.userId);
    const viewToken = createSession(viewOnly.userId);
    const editToken = createSession(editOnly.userId);
    const publishToken = createSession(publishOnly.userId);

    // Unauthenticated -> 401
    expect((await api('GET', '/api/ai-platform/prompts/variables')).status).toBe(401);

    // manage_ai_platform parent alone -> 403 missing_permission
    for (const [method, path, body] of [
      ['GET', '/api/ai-platform/prompts/variables', undefined],
      ['GET', `/api/ai-platform/prompts/profile/${profileId}`, undefined],
      ['PUT', `/api/ai-platform/prompts/profile/${profileId}/draft`, { body: 'x', revision: 1 }],
      ['POST', `/api/ai-platform/prompts/profile/${profileId}/publish`, { revision: 1 }],
    ] as const) {
      const res = await api(method, path, parentToken, body);
      expect(res.status).toBe(403);
      expect((res.json.error as { code: string }).code).toBe('missing_permission');
    }

    // view_prompts only: reads ok, writes/preview/try/publish denied
    const varsRes = await api('GET', '/api/ai-platform/prompts/variables', viewToken);
    expect(varsRes.status).toBe(200);
    expect(varsRes.json.variables).toEqual(SYSTEM_PROMPT_VARIABLES);
    expect((await api('GET', `/api/ai-platform/prompts/profile/${profileId}`, viewToken)).status).toBe(200);
    expect((await api('PUT', `/api/ai-platform/prompts/profile/${profileId}/draft`, viewToken, { body: 'x', revision: 1 })).status).toBe(403);
    expect((await api('POST', `/api/ai-platform/prompts/profile/${profileId}/preview`, viewToken, { body: 'x' })).status).toBe(403);
    expect((await api('POST', `/api/ai-platform/prompts/profile/${profileId}/publish`, viewToken, { revision: 1 })).status).toBe(403);

    // edit_prompts only: preview/draft/discard ok, publish/restore denied
    const previewRes = await api('POST', `/api/ai-platform/prompts/profile/${profileId}/preview`, editToken, {
      body: 'Hi {{profile_name}} {{missing_var}}',
      variables: [{ name: 'missing_var', source: 'caller' }],
    });
    expect(previewRes.status).toBe(200);
    expect(previewRes.json.rendered).toBe('Hi Acme Support Key ');
    expect(previewRes.json.missing).toEqual(['missing_var']);

    // 422 invalid_template with line/column
    const invalidRes = await api('PUT', `/api/ai-platform/prompts/profile/${profileId}/draft`, editToken, {
      body: 'line 1\nline 2 {{bad_undeclared}}',
      revision: 1,
    });
    expect(invalidRes.status).toBe(422);
    expect((invalidRes.json.error as { code: string; line: number; column: number }).code).toBe('invalid_template');
    expect(invalidRes.json.line).toBe(2);
    expect(invalidRes.json.column).toBe(8);

    // 409 revision_conflict
    const conflictRes = await api('PUT', `/api/ai-platform/prompts/profile/${profileId}/draft`, editToken, {
      body: 'Valid body',
      revision: 999,
    });
    expect(conflictRes.status).toBe(409);
    expect((conflictRes.json.error as { code: string; current: unknown }).code).toBe('revision_conflict');
    expect((conflictRes.json.error as { current?: unknown }).current).toBeTruthy();

    // Save & discard draft with edit_prompts
    const saveOk = await api('PUT', `/api/ai-platform/prompts/profile/${profileId}/draft`, editToken, {
      body: 'Valid draft body',
      revision: 1,
    });
    expect(saveOk.status).toBe(200);
    expect((await api('POST', `/api/ai-platform/prompts/profile/${profileId}/publish`, editToken, { revision: 2 })).status).toBe(403);

    const discardRes = await api('DELETE', `/api/ai-platform/prompts/profile/${profileId}/draft?revision=2`, editToken);
    expect(discardRes.status).toBe(200);

    // Re-save draft, then publish_prompts user can publish but cannot edit
    const saveAgain = await api('PUT', `/api/ai-platform/prompts/profile/${profileId}/draft`, editToken, {
      body: 'Published by publisher',
      revision: 3,
    });
    expect(saveAgain.status).toBe(200);
    expect((await api('PUT', `/api/ai-platform/prompts/profile/${profileId}/draft`, publishToken, { body: 'no', revision: 4 })).status).toBe(403);
    const pubOk = await api('POST', `/api/ai-platform/prompts/profile/${profileId}/publish`, publishToken, { revision: 4 });
    expect(pubOk.status).toBe(200);
    const restoreOk = await api('POST', `/api/ai-platform/prompts/profile/${profileId}/restore`, publishToken, {
      version: 1,
      revision: 5,
    });
    expect(restoreOk.status).toBe(200);
  });
});
