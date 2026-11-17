import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@freellmapi/shared/types.js';
import type {
  ContextAssemblySummary,
  ContextPolicyResponse,
  ContextPreview,
  ContextStats,
} from '@freellmapi/shared/context-budget.js';
import type { Providers } from '../../../providers/base.js';

function estimateRough(text: string): number {
  return Math.max(8, Math.ceil(text.length / 3.4));
}

const chatCompletion = vi.fn(
  async (_apiKey: string, messages: ChatMessage[], modelId: string) => {
    const isSummary = messages.some(
      (m) => typeof m.content === 'string' && m.content.includes('running summary'),
    );
    const reply = isSummary
      ? 'Khach VIP khach-vip-01 hoi bao hanh 24 thang cho don ORD-8841-VN va hoan tien 3 ngay.'
      : 'Da ghi nhan yeu cau ho tro cho don hang ORD-8841-VN va chinh sach bao hanh 24 thang.';

    const totalChars = messages.reduce(
      (acc, m) => acc + (typeof m.content === 'string' ? m.content.length : 40),
      0,
    );
    const promptTokens = Math.max(12, Math.round(totalChars / 3.1));
    const completionTokens = estimateRough(reply);

    return {
      id: `chatcmpl_web_e2e_${modelId}`,
      object: 'chat.completion',
      created: 1700000000,
      model: modelId,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: reply },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    };
  },
);

const streamChatCompletion = vi.fn();
const fakeProvider = {
  name: 'groq',
  chatCompletion,
  streamChatCompletion,
} as unknown as Providers;

vi.mock('../../../providers/index.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getProvider: () => fakeProvider,
    resolveProvider: () => fakeProvider,
  };
});

const { createApp } = await import('../../../app.js');
const { loadConfig } = await import('../../../lib/config.js');
const { defaultDbFactory, getDb, initDb } = await import('../../../db/index.js');
const { wrapTursoDatabase } = await import('../../../db/turso.js');
const { encrypt } = await import('../../../lib/crypto.js');
const { createSession, createUser } = await import('../../../services/auth.js');
const { setKeyCacheTestOverride } = await import('../../../services/key-cache.js');
const { invalidateModelListingCache } = await import('../../../services/model-listing.js');
const { setRoutingStrategy } = await import('../../../services/router.js');

describe('context-budget full-stack web E2E flow', () => {
  let server: Server;
  let baseUrl: string;
  let tempClientDist: string;
  const realFetch = global.fetch;
  let ownerToken: string;
  let viewerToken: string;
  let profileId: number;
  let profileKey: string;

  async function requestJson<T = Record<string, unknown>>(
    reqPath: string,
    opts: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; headers: Headers; body: T }> {
    const res = await realFetch(`${baseUrl}${reqPath}`, {
      method: opts.method ?? 'GET',
      headers: {
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...opts.headers,
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let body: unknown = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { status: res.status, headers: res.headers, body: body as T };
  }

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    vi.stubEnv('FREEAPI_TURSO_BATCH_WRITES', '1');
    vi.stubEnv('PROXY_RATE_LIMIT_RPM', '0');
    setKeyCacheTestOverride(true);
    initDb(':memory:', { factory: () => wrapTursoDatabase(defaultDbFactory()(':memory:'), true) });

    tempClientDist = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-web-dist-'));
    fs.mkdirSync(path.join(tempClientDist, 'assets'), { recursive: true });
    fs.writeFileSync(
      path.join(tempClientDist, 'index.html'),
      '<!doctype html><html><body><div id="root"></div><script type="module" src="/assets/index.js"></script></body></html>',
    );
    fs.writeFileSync(path.join(tempClientDist, 'assets', 'index.js'), 'console.log("ok");\n');

    const enc = encrypt('gsk_web_e2e_secret');
    const db = getDb();
    db.prepare(
      `INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
       VALUES ('groq', 'web-e2e-groq', ?, ?, ?, 'healthy', 1)`,
    ).run(enc.encrypted, enc.iv, enc.authTag);

    db.prepare('UPDATE models SET enabled = 0').run();
    db.prepare('UPDATE fallback_config SET enabled = 0').run();
    db.prepare('UPDATE profile_models SET enabled = 0').run();
    const largeRes = db
      .prepare(
        `INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, context_window, enabled)
         VALUES ('groq', 'web-e2e-128k', 'Web E2E 128k', 1, 1, 'Large', 131072, 1)`,
      )
      .run();
    const smallRes = db
      .prepare(
        `INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, context_window, enabled)
         VALUES ('groq', 'web-e2e-8k', 'Web E2E 8k', 10, 10, 'Small', 8192, 1)`,
      )
      .run();
    const largeId = Number(largeRes.lastInsertRowid);
    const smallId = Number(smallRes.lastInsertRowid);

    db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)').run(
      largeId,
    );
    db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 2, 1)').run(
      smallId,
    );
    const profiles = db.prepare('SELECT id FROM profiles').all() as Array<{ id: number }>;
    for (const p of profiles) {
      db.prepare(
        'INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, 1, 1)',
      ).run(p.id, largeId);
      db.prepare(
        'INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, 2, 1)',
      ).run(p.id, smallId);
    }
    setRoutingStrategy('priority');
    invalidateModelListingCache();

    const cfg = {
      ...loadConfig(),
      clientDist: tempClientDist,
      serveStaticAssets: true,
      proxyRateLimitRpm: 0,
    };
    server = createApp(cfg).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;

    const owner = createUser('web-e2e-owner@example.com', 'OwnerPass123!');
    ownerToken = createSession(owner.userId);

    const viewer = createUser('web-e2e-viewer@example.com', 'ViewerPass123!', 'member');
    viewerToken = createSession(viewer.userId);
    const permRes = await requestJson(`/api/admin/users/${viewer.userId}/permissions`, {
      method: 'PUT',
      token: ownerToken,
      body: { permissions: ['view_client_profiles'] },
    });
    expect(permRes.status).toBe(200);

    const created = await requestJson<{ id: number; key: string }>('/api/client-profiles', {
      method: 'POST',
      token: ownerToken,
      body: {
        name: 'web-e2e-profile',
        systemPrompt: 'You are a helpful Vietnamese support assistant.',
      },
    });
    expect(created.status).toBe(201);
    profileId = created.body.id;
    profileKey = created.body.key;

    await requestJson(`/api/client-profiles/${profileId}/quota`, {
      method: 'PUT',
      token: ownerToken,
      body: { rpmLimit: null },
    });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (tempClientDist) {
      fs.rmSync(tempClientDist, { recursive: true, force: true });
    }
  });

  it('serves SPA routes + CSP headers and verifies suggested banner, 32-turn fold, preview, stats, request report, reset, and RBAC', async () => {
    // 1. Static SPA, deep link, asset chunk & CSP
    const rootRes = await realFetch(`${baseUrl}/`);
    expect(rootRes.status).toBe(200);
    expect(rootRes.headers.get('content-type')).toContain('text/html');
    expect(rootRes.headers.get('content-security-policy')).toBeTruthy();

    const usageRes = await realFetch(`${baseUrl}/profiles/${profileId}/usage`);
    expect(usageRes.status).toBe(200);
    expect(usageRes.headers.get('content-type')).toContain('text/html');
    expect(await usageRes.text()).toContain('<div id="root"></div>');

    const assetRes = await realFetch(`${baseUrl}/assets/index.js`);
    expect(assetRes.status).toBe(200);
    expect(await assetRes.text()).toContain('console.log');

    const unauth = await requestJson(`/api/client-profiles/${profileId}/context-policy`);
    expect(unauth.status).toBe(401);

    // 2. Suggested conversion banner when Stored Conversations is enabled on inherited policy
    const convSave = await requestJson(`/api/client-profiles/${profileId}/conversation-settings`, {
      method: 'PUT',
      token: ownerToken,
      body: {
        enabled: true,
        ttlHours: 168,
        maxMessages: 60,
        maxChars: 24000,
        summarize: true,
      },
    });
    expect(convSave.status).toBe(200);

    const initialPolicy = await requestJson<ContextPolicyResponse>(
      `/api/client-profiles/${profileId}/context-policy`,
      { token: ownerToken },
    );
    expect(initialPolicy.status).toBe(200);
    expect(initialPolicy.body.policy.inherited).toBe(true);
    expect(initialPolicy.body.policy.enabled).toBe(false);
    expect(initialPolicy.body.suggested).toEqual({ maxInputTokens: 8000, summarize: true });

    // 3. Enable policy (4,000 budget, summarize on) and run 32 multi-turn chat completions
    const savePolicy = await requestJson<ContextPolicyResponse>(
      `/api/client-profiles/${profileId}/context-policy`,
      {
        method: 'PUT',
        token: ownerToken,
        body: {
          enabled: true,
          preset: 'custom',
          maxInputTokens: 4000,
          outputReserveTokens: 1024,
          safetyMarginPct: 10,
          summarySharePct: 15,
          knowledgeSharePct: 25,
          dropBlockTurns: 4,
          summarize: true,
          clientHistoryMode: 'passthrough',
        },
      },
    );
    expect(savePolicy.status).toBe(200);
    expect(savePolicy.body.policy.enabled).toBe(true);
    expect(savePolicy.body.policy.inherited).toBe(false);

    const pad =
      'Chi tiet kiem tra don hang ORD-8841-VN, thoi han bao hanh 24 thang va quy trinh hoan tien 3 ngay lam viec. '.repeat(
        4,
      );
    for (let turn = 1; turn <= 32; turn++) {
      const chatRes = await requestJson('/v1/chat/completions', {
        method: 'POST',
        token: profileKey,
        headers: {
          'x-conversation-id': 'conv-web-01',
          'x-end-user': 'khach-vip-01',
        },
        body: {
          model: 'auto',
          messages: [
            { role: 'system', content: 'Be accurate and concise.' },
            { role: 'user', content: `Luot hoi #${turn}: ${pad}` },
          ],
        },
      });
      expect(chatRes.status).toBe(200);
      expect(chatRes.headers.get('x-freellm-context')).toBeTruthy();
    }

    // Poll preview until asynchronous summary folding completes (up to 2500ms)
    let preview: ContextPreview | null = null;
    for (let attempt = 0; attempt < 50; attempt++) {
      const prevRes = await requestJson<ContextPreview>(
        `/api/client-profiles/${profileId}/conversations/conv-web-01/context-preview?endUser=khach-vip-01`,
        { token: ownerToken },
      );
      expect(prevRes.status).toBe(200);
      preview = prevRes.body;
      if (preview.summary.coversThroughMessageId !== null) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(preview).not.toBeNull();
    expect(preview!.budget.effective).toBeLessThanOrEqual(4000);
    expect(preview!.summary.coversThroughMessageId).not.toBeNull();
    expect(preview!.segments.some((s) => s.kind === 'mandatory' && s.sent)).toBe(true);
    expect(preview!.segments.some((s) => s.kind === 'summary' && s.sent)).toBe(true);
    expect(preview!.segments.some((s) => s.kind === 'history' && s.sent)).toBe(true);
    expect(preview!.segments.some((s) => s.kind === 'history' && !s.sent)).toBe(true);

    // 4. Stats & recent request context report endpoints
    const statsRes = await requestJson<ContextStats>(
      `/api/client-profiles/${profileId}/context-stats?days=7`,
      { token: ownerToken },
    );
    expect(statsRes.status).toBe(200);
    expect(statsRes.body.requests).toBeGreaterThanOrEqual(32);
    expect(statsRes.body.estimateError.samples).toBeGreaterThanOrEqual(32);
    expect(statsRes.body.estimateError.within15PctRate).not.toBeNull();

    const reqList = await requestJson<{ requests: Array<{ id: number }> }>(
      `/api/client-profiles/${profileId}/requests?limit=25`,
      { token: ownerToken },
    );
    expect(reqList.status).toBe(200);
    expect(reqList.body.requests.length).toBeGreaterThan(0);

    const firstReqId = reqList.body.requests[0]!.id;
    const reqCtx = await requestJson<ContextAssemblySummary>(
      `/api/client-profiles/${profileId}/requests/${firstReqId}/context`,
      { token: ownerToken },
    );
    expect(reqCtx.status).toBe(200);
    expect(reqCtx.body.budget).toBeLessThanOrEqual(4000);

    // At least one recent chat request (excluding the asynchronous summary-fold request) sent & dropped history
    const chatReports: ContextAssemblySummary[] = [];
    for (const r of reqList.body.requests.slice(0, 8)) {
      const ctx = await requestJson<ContextAssemblySummary>(
        `/api/client-profiles/${profileId}/requests/${r.id}/context`,
        { token: ownerToken },
      );
      if (ctx.status === 200) chatReports.push(ctx.body);
    }
    expect(chatReports.some((c) => c.histSent > 0 && c.histDropped > 0)).toBe(true);

    // 5. Dynamic budget increase reflected immediately + ?model= target simulation + ?days=30 stats + system settings
    const defaultSettingsRes = await requestJson<{ enabled: boolean; preset: string; fallbackWindowTokens: number; imageTokens: number }>(
      '/api/settings/context-policy',
      { token: ownerToken },
    );
    expect(defaultSettingsRes.status).toBe(200);
    expect(defaultSettingsRes.body.enabled).toBe(false);

    const putDefaultRes = await requestJson<{ enabled: boolean; preset: string; fallbackWindowTokens: number; imageTokens: number }>(
      '/api/settings/context-policy',
      {
        method: 'PUT',
        token: ownerToken,
        body: { fallbackWindowTokens: 16384, imageTokens: 512 },
      },
    );
    expect(putDefaultRes.status).toBe(200);
    expect(putDefaultRes.body.fallbackWindowTokens).toBe(16384);
    expect(putDefaultRes.body.imageTokens).toBe(512);

    const updateBudget = await requestJson<ContextPolicyResponse>(
      `/api/client-profiles/${profileId}/context-policy`,
      {
        method: 'PUT',
        token: ownerToken,
        body: { maxInputTokens: 12000 },
      },
    );
    expect(updateBudget.status).toBe(200);

    const updatedPreview = await requestJson<ContextPreview>(
      `/api/client-profiles/${profileId}/conversations/conv-web-01/context-preview?endUser=khach-vip-01`,
      { token: ownerToken },
    );
    expect(updatedPreview.status).toBe(200);
    expect(updatedPreview.body.budget.effective).toBe(12000);

    const simulated8k = await requestJson<ContextPreview>(
      `/api/client-profiles/${profileId}/conversations/conv-web-01/context-preview?endUser=khach-vip-01&model=${encodeURIComponent('groq:web-e2e-8k')}`,
      { token: ownerToken },
    );
    expect(simulated8k.status).toBe(200);
    expect(simulated8k.body.model.key).toBe('groq:web-e2e-8k');
    expect(simulated8k.body.model.contextWindow).toBe(8192);
    expect(simulated8k.body.budget.effective).toBeLessThan(12000);

    const stats30Res = await requestJson<ContextStats>(
      `/api/client-profiles/${profileId}/context-stats?days=30`,
      { token: ownerToken },
    );
    expect(stats30Res.status).toBe(200);
    expect(stats30Res.body.days).toBe(30);
    expect(stats30Res.body.requests).toBeGreaterThanOrEqual(32);

    // 6. RBAC: member with view_client_profiles can read policy/stats, but gets 403 on write/delete/preview
    const viewerPolicy = await requestJson(`/api/client-profiles/${profileId}/context-policy`, {
      token: viewerToken,
    });
    expect(viewerPolicy.status).toBe(200);

    const viewerStats = await requestJson(
      `/api/client-profiles/${profileId}/context-stats?days=7`,
      { token: viewerToken },
    );
    expect(viewerStats.status).toBe(200);

    const viewerPut = await requestJson(`/api/client-profiles/${profileId}/context-policy`, {
      method: 'PUT',
      token: viewerToken,
      body: { enabled: false },
    });
    expect(viewerPut.status).toBe(403);

    const viewerDel = await requestJson(`/api/client-profiles/${profileId}/context-policy`, {
      method: 'DELETE',
      token: viewerToken,
    });
    expect(viewerDel.status).toBe(403);

    const viewerPreview = await requestJson(
      `/api/client-profiles/${profileId}/conversations/conv-web-01/context-preview?endUser=khach-vip-01`,
      { token: viewerToken },
    );
    expect(viewerPreview.status).toBe(403);

    // 7. Reset by owner restores Inherited + Suggested banner
    const delRes = await requestJson(`/api/client-profiles/${profileId}/context-policy`, {
      method: 'DELETE',
      token: ownerToken,
    });
    expect(delRes.status).toBe(204);

    const afterReset = await requestJson<ContextPolicyResponse>(
      `/api/client-profiles/${profileId}/context-policy`,
      { token: ownerToken },
    );
    expect(afterReset.status).toBe(200);
    expect(afterReset.body.policy.inherited).toBe(true);
    expect(afterReset.body.policy.enabled).toBe(false);
    expect(afterReset.body.suggested).toEqual({ maxInputTokens: 8000, summarize: true });
  }, 30_000);
});
