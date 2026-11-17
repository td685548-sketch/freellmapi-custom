import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { getDb, initDb, setSetting } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { createSession, createUser } from '../../services/auth.js';
import { setKeyCacheTestOverride } from '../../services/key-cache.js';
import { setUserPermissions } from '../../services/users.js';
import { resetGuestCache, setGuestPermissions } from '../../services/guest-access.js';
import { addToActiveChain } from '../helpers/chain.js';

describe('Customer AI Hub, Smart Key Routing & Dual-Persona Intelligence', () => {
  let server: Server;
  let base: string;
  const realFetch = global.fetch;
  const upstreamCalls: Array<{ url: string; body: any }> = [];

  let adminId: number;
  let adminToken: string;
  let memberId: number;
  let memberToken: string;
  let delegateId: number;
  let delegateToken: string;

  async function api(path: string, method = 'GET', body?: unknown, token?: string) {
    const res = await realFetch(`${base}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return {
      status: res.status,
      body: await res.json().catch(() => null) as any,
      headers: res.headers,
    };
  }

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    setKeyCacheTestOverride(true);
    initDb(':memory:');
    setSetting('routing_explore_enabled', '0');

    const db = getDb();
    const key = encrypt('gsk_customer_ai_test');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('groq', 'test-groq', ?, ?, ?, 'healthy', 1)
    `).run(key.encrypted, key.iv, key.authTag);

    // Ensure two distinct groq models exist: one fast small model and one smart large model.
    db.prepare('UPDATE models SET enabled = 0').run();
    db.prepare('DELETE FROM profile_models').run();
    db.prepare('DELETE FROM fallback_config').run();

    const fastIns = db.prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, context_window, enabled, source)
      VALUES ('groq', 'fast-eco-8b', 'Fast Eco 8B', 10, 1, 'Small', 32768, 1, 'seed')
    `).run();
    const smartIns = db.prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, context_window, enabled, source)
      VALUES ('groq', 'smart-max-70b', 'Smart Max 70B', 1, 8, 'Frontier', 131072, 1, 'seed')
    `).run();
    const fastId = Number(fastIns.lastInsertRowid);
    const smartId = Number(smartIns.lastInsertRowid);
    db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1), (?, 2, 1)').run(smartId, fastId);
    addToActiveChain(smartId, 1, true);
    addToActiveChain(fastId, 2, true);

    for (let i = 0; i < 20; i++) {
      db.prepare(`
        INSERT INTO requests (platform, model_id, status, latency_ms, ttfb_ms, input_tokens, output_tokens, created_at)
        VALUES ('groq', 'fast-eco-8b', 'success', 300, 150, 100, 2000, datetime('now'))
      `).run();
      db.prepare(`
        INSERT INTO requests (platform, model_id, status, latency_ms, ttfb_ms, input_tokens, output_tokens, created_at)
        VALUES ('groq', 'smart-max-70b', 'success', 9500, 8500, 100, 40, datetime('now'))
      `).run();
    }

    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    adminId = createUser('admin-ai@example.com', 'AdminPass123!').userId;
    adminToken = createSession(adminId);

    memberId = createUser('member-ai@example.com', 'MemberPass123!', 'member').userId;
    memberToken = createSession(memberId);

    delegateId = createUser('delegate-ai@example.com', 'DelegatePass123!', 'member').userId;
    delegateToken = createSession(delegateId);

    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init: any) => {
      if (String(url).startsWith(base)) return realFetch(url, init);
      const body = JSON.parse(String(init?.body ?? '{}'));
      upstreamCalls.push({ url: String(url), body });
      return new Response(JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: 1,
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: `Reply from ${body.model}` }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 15, completion_tokens: 10, total_tokens: 25 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
  });

  afterAll(() => {
    server?.close();
    vi.restoreAllMocks();
    setKeyCacheTestOverride(null);
  });

  beforeEach(() => {
    upstreamCalls.length = 0;
    resetGuestCache();
    setGuestPermissions([]);
    setUserPermissions(delegateId, [], adminId);
    const db = getDb();
    db.prepare('DELETE FROM user_api_keys').run();
    db.prepare('DELETE FROM custom_user_ai_preferences').run();
    db.prepare('DELETE FROM requests WHERE user_id IS NOT NULL').run();
    db.prepare("DELETE FROM custom_ai_assistants WHERE slug NOT IN ('code-reviewer', 'fast-pair-coder', 'sql-api-architect', 'bilingual-tech-writer')").run();
    db.prepare('UPDATE custom_ai_assistants SET enabled = 1, playground_runs = 0').run();
  });

  it('separates customer catalog (no systemPrompt, respects audience) from admin authoring', async () => {
    // Admin creates an admin_only assistant
    const created = await api('/api/ai-platform/customer-assistants', 'POST', {
      slug: 'internal-ops-bot',
      name: 'Internal Ops Bot',
      description: 'Admin only internal bot',
      category: 'productivity',
      systemPrompt: 'SECRET ADMIN SYSTEM PROMPT',
      recommendedRoutingMode: 'max',
      starterPrompts: ['Check node status'],
      audience: 'admin_only',
      enabled: true,
    }, adminToken);
    expect(created.status).toBe(201);
    expect(created.body.assistant.systemPrompt).toBe('SECRET ADMIN SYSTEM PROMPT');

    // Member sees published non-admin assistants WITHOUT systemPrompt
    const memberCatalog = await api('/api/user/ai-hub/catalog', 'GET', undefined, memberToken);
    expect(memberCatalog.status).toBe(200);
    const memberSlugs = memberCatalog.body.assistants.map((a: any) => a.slug);
    expect(memberSlugs).toContain('code-reviewer');
    expect(memberSlugs).toContain('sql-api-architect');
    expect(memberSlugs).not.toContain('internal-ops-bot');
    for (const item of memberCatalog.body.assistants) {
      expect(item.systemPrompt).toBeUndefined();
      expect(JSON.stringify(item)).not.toContain('senior software engineer');
    }

    // Admin catalog view in customer hub sees admin_only too, while Admin Studio sees full systemPrompt
    const adminStudio = await api('/api/ai-platform/customer-assistants', 'GET', undefined, adminToken);
    expect(adminStudio.status).toBe(200);
    expect(adminStudio.body.assistants.some((a: any) => a.slug === 'internal-ops-bot' && a.systemPrompt === 'SECRET ADMIN SYSTEM PROMPT')).toBe(true);

    // Member cannot access Admin Studio or Anomaly Radar
    expect((await api('/api/ai-platform/customer-assistants', 'GET', undefined, memberToken)).status).toBe(403);
    expect((await api('/api/ai-platform/anomaly-radar', 'GET', undefined, memberToken)).status).toBe(403);

    // Delegate with view_prompts can read studio, cannot edit
    setUserPermissions(delegateId, ['view_prompts'], adminId);
    expect((await api('/api/ai-platform/customer-assistants', 'GET', undefined, delegateToken)).status).toBe(200);
    expect((await api('/api/ai-platform/customer-assistants', 'POST', {
      slug: 'blocked-create',
      name: 'Blocked',
      systemPrompt: 'Should fail',
    }, delegateToken)).status).toBe(403);
  });

  it('injects bound assistant systemPrompt + personal customInstructions and routes by eco vs max on sk-flm keys', async () => {
    const catalog = await api('/api/user/ai-hub/catalog', 'GET', undefined, memberToken);
    const reviewer = catalog.body.assistants.find((a: any) => a.slug === 'code-reviewer');
    expect(reviewer).toBeDefined();

    // Save custom instructions for member
    const prefs = await api('/api/user/ai-hub/preferences', 'PUT', {
      customInstructions: 'Always answer in concise Vietnamese.',
      applyCustomInstructionsToKeys: true,
    }, memberToken);
    expect(prefs.status).toBe(200);
    expect(prefs.body.preferences.customInstructions).toBe('Always answer in concise Vietnamese.');

    // Mint personal key & bind to code-reviewer + max mode
    const minted = await api('/api/user/keys', 'POST', { name: 'IDE Key' }, memberToken);
    expect(minted.status).toBe(201);
    const keyId = minted.body.key.id;
    const secretKey = minted.body.key.key as string;

    const bound = await api(`/api/user/ai-hub/keys/${keyId}`, 'PATCH', {
      routingMode: 'max',
      assistantId: reviewer.id,
    }, memberToken);
    expect(bound.status).toBe(200);
    expect(bound.body.key).toMatchObject({
      id: keyId,
      routingMode: 'max',
      assistantId: reviewer.id,
      assistantSlug: 'code-reviewer',
    });

    // Call /v1/chat/completions with personal key in Max mode
    const maxRes = await api('/v1/chat/completions', 'POST', {
      model: 'auto',
      messages: [{ role: 'user', content: 'Review my code' }],
    }, secretKey);
    expect(maxRes.status).toBe(200);
    expect(upstreamCalls).toHaveLength(1);
    expect(upstreamCalls[0]!.body.model).toBe('smart-max-70b');
    expect(upstreamCalls[0]!.body.messages[0]).toMatchObject({
      role: 'system',
    });
    expect(upstreamCalls[0]!.body.messages[0].content).toContain('senior software engineer');
    expect(upstreamCalls[0]!.body.messages[0].content).toContain('Always answer in concise Vietnamese.');

    // Disable applying custom instructions to keys & switch key to Eco mode
    await api('/api/user/ai-hub/preferences', 'PUT', {
      customInstructions: 'Always answer in concise Vietnamese.',
      applyCustomInstructionsToKeys: false,
    }, memberToken);
    await api(`/api/user/ai-hub/keys/${keyId}`, 'PATCH', {
      routingMode: 'eco',
      assistantId: null,
    }, memberToken);

    const ecoRes = await api('/v1/chat/completions', 'POST', {
      model: 'auto',
      messages: [{ role: 'user', content: 'Quick hello' }],
    }, secretKey);
    expect(ecoRes.status).toBe(200);
    expect(upstreamCalls).toHaveLength(2);
    expect(upstreamCalls[1]!.body.model).toBe('fast-eco-8b');
    expect(upstreamCalls[1]!.body.messages).toEqual([{ role: 'user', content: 'Quick hello' }]);
  });

  it('supports session-authenticated AI Hub assistant chat without exposing unified key or systemPrompt', async () => {
    await api('/api/user/ai-hub/preferences', 'PUT', {
      customInstructions: 'Prefer TypeScript snippets.',
      applyCustomInstructionsToKeys: true,
    }, memberToken);

    const chatRes = await api('/api/user/ai-hub/assistants/fast-pair-coder/chat', 'POST', {
      messages: [{ role: 'user', content: 'Write a hello test' }],
      routingMode: 'eco',
    }, memberToken);
    expect(chatRes.status).toBe(200);
    expect(chatRes.body.model).toBe('fast-eco-8b');
    expect(chatRes.body.routingMode).toBe('eco');
    expect(chatRes.body.reply).toContain('Reply from fast-eco-8b');
    expect(JSON.stringify(chatRes.body)).not.toContain('concise, fast pair programmer');

    // Verify upstream received server-composed prompt and user attribution recorded
    expect(upstreamCalls[0]!.body.messages[0].content).toContain('concise, fast pair programmer');
    expect(upstreamCalls[0]!.body.messages[0].content).toContain('Prefer TypeScript snippets.');
    const reqRow = getDb().prepare('SELECT user_id FROM requests ORDER BY id DESC LIMIT 1').get() as { user_id: number | null };
    expect(reqRow.user_id).toBe(memberId);

    const catalogAfter = await api('/api/user/ai-hub/catalog', 'GET', undefined, memberToken);
    const fastCoder = catalogAfter.body.assistants.find((a: any) => a.slug === 'fast-pair-coder');
    expect(fastCoder.playgroundRuns).toBe(1);

    // Member cannot chat with admin_only assistant
    await api('/api/ai-platform/customer-assistants', 'POST', {
      slug: 'admin-secret-bot',
      name: 'Admin Secret Bot',
      systemPrompt: 'Top secret admin prompt',
      audience: 'admin_only',
    }, adminToken);
    const forbiddenChat = await api('/api/user/ai-hub/assistants/admin-secret-bot/chat', 'POST', {
      messages: [{ role: 'user', content: 'hello' }],
    }, memberToken);
    expect(forbiddenChat.status).toBe(404);
  });

  it('builds personalized Customer Quota Coach and allows 1-click switch to Eco', async () => {
    const minted = await api('/api/user/keys', 'POST', { name: 'Laptop Key' }, memberToken);
    const keyId = minted.body.key.id;
    await api(`/api/user/ai-hub/keys/${keyId}`, 'PATCH', { routingMode: 'max' }, memberToken);

    const db = getDb();
    for (let i = 0; i < 6; i++) {
      db.prepare(`
        INSERT INTO requests (user_id, platform, model_id, status, latency_ms, input_tokens, output_tokens, created_at)
        VALUES (?, 'groq', 'smart-max-70b', 'success', 500, 400, 300, datetime('now'))
      `).run(memberId);
    }

    const coachBefore = await api('/api/user/ai-hub/coach', 'GET', undefined, memberToken);
    expect(coachBefore.status).toBe(200);
    expect(coachBefore.body.report.totalRequests).toBe(6);
    expect(coachBefore.body.report.routingBreakdown.max).toBe(1);
    expect(coachBefore.body.report.tips.some((t: any) => t.id === 'switch-to-eco' && t.recommendedMode === 'eco')).toBe(true);

    const ecoRes = await api('/api/user/ai-hub/keys/apply-eco', 'POST', { keyId }, memberToken);
    expect(ecoRes.status).toBe(200);
    expect(ecoRes.body.updatedCount).toBe(1);

    const keysAfter = await api('/api/user/keys', 'GET', undefined, memberToken);
    expect(keysAfter.body.keys[0].routingMode).toBe('eco');
  });

  it('detects fleet anomalies in Admin Anomaly Radar, mitigates via Eco, and unbinds keys on assistant delete', async () => {
    const minted = await api('/api/user/keys', 'POST', { name: 'Looping Script Key' }, memberToken);
    const keyId = minted.body.key.id;
    const customAssistant = await api('/api/ai-platform/customer-assistants', 'POST', {
      slug: 'temp-assistant',
      name: 'Temp Assistant',
      systemPrompt: 'Temporary prompt for binding test',
      audience: 'all_members',
    }, adminToken);
    const tempId = customAssistant.body.assistant.id as number;
    await api(`/api/user/ai-hub/keys/${keyId}`, 'PATCH', { assistantId: tempId, routingMode: 'max' }, memberToken);

    const db = getDb();
    // Simulate a token spike for memberId in the last 24h (60,000 tokens vs 0 baseline)
    db.prepare(`
      INSERT INTO requests (user_id, platform, model_id, status, latency_ms, input_tokens, output_tokens, created_at)
      VALUES (?, 'groq', 'smart-max-70b', 'success', 1200, 40000, 20000, datetime('now'))
    `).run(memberId);

    const radar = await api('/api/ai-platform/anomaly-radar?hours=24', 'GET', undefined, adminToken);
    expect(radar.status).toBe(200);
    expect(radar.body.report.boundPersonalKeys).toBe(1);
    const spike = radar.body.report.anomalies.find((a: any) => a.userId === memberId);
    expect(spike).toBeDefined();
    expect(spike.kind).toBe('token_spike');
    expect(spike.activeNonEcoKeys).toBe(1);

    // Admin switches anomalous member keys to Eco
    const mitigate = await api(`/api/ai-platform/anomaly-radar/users/${memberId}/apply-eco`, 'POST', {}, adminToken);
    expect(mitigate.status).toBe(200);
    expect(mitigate.body.updatedCount).toBe(1);

    const radarAfter = await api('/api/ai-platform/anomaly-radar?hours=24', 'GET', undefined, adminToken);
    expect(radarAfter.body.report.ecoPersonalKeys).toBe(1);

    // Deleting the assistant cleanly unbinds personal keys
    const deleted = await api(`/api/ai-platform/customer-assistants/${tempId}`, 'DELETE', undefined, adminToken);
    expect(deleted.status).toBe(200);
    const keysAfter = await api('/api/user/keys', 'GET', undefined, memberToken);
    expect(keysAfter.body.keys[0].assistantId).toBeNull();
  });
});
