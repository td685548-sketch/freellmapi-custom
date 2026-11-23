import http, { type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { PERMISSION_GATES } from '../../custom/register.js';
import {
  classifyScenarioRequest,
  detectScenarioWireSurface,
} from '../../custom/scenario-routing/classifier.js';
import { generateIdePackageBundle } from '../../custom/scenario-routing/ide-packager.js';
import { clearVerifyPingsForTests } from '../../custom/scenario-routing/store.js';
import { getDb, initDb, setSetting } from '../../db/index.js';
import { logRequest } from '../../lib/request-log.js';
import { createSession, createUser } from '../../services/auth.js';
import { dashboardSessionHeaders } from '../helpers/auth.js';
import { clearReasoningMemory } from '../../routes/proxy.js';
import { mintUserApiKey } from '../../services/user-keys.js';
import { IDE_PACKAGER_TOOLS } from '@freellmapi/shared/scenario-routing.js';

let mockUpstream: Server;
let mockUpstreamUrl: string;
let lastUpstreamModel: string | null = null;

let appServer: Server;
let baseUrl: string;

let adminId: number;
let adminToken: string;
let memberAId: number;
let memberAToken: string;
let memberAKey1: { id: number; key: string; keyPrefix: string };
let memberAKey2: { id: number; key: string; keyPrefix: string };

let memberBId: number;
let memberBToken: string;
let memberBKey: { id: number; key: string; keyPrefix: string };

async function apiRequest(
  path: string,
  options?: {
    method?: string;
    body?: unknown;
    token?: string;
    headers?: Record<string, string>;
  },
) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: options?.method ?? 'GET',
    headers: {
      ...(options?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      // Phase 3: session tokens (64 hex chars) go as the flm_session cookie;
      // personal API keys (sk-flm-…) and the fake key stay Bearer — including
      // on /api routes such as verify-ping, which authenticates by key.
      ...(options?.token
        ? (/^[0-9a-f]{64}$/.test(options.token)
          ? { ...dashboardSessionHeaders(options.token) }
          : { Authorization: `Bearer ${options.token}` })
        : {}),
      ...(options?.headers ?? {}),
    },
    body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const json = (await res.json().catch(() => null)) as Record<string, any> | null;
  return { status: res.status, headers: res.headers, body: json };
}

describe('Spec 039: Scenario-Based Auto-Routing & 1-Click IDE Config Packager', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    initDb(':memory:');
    clearVerifyPingsForTests();
    clearReasoningMemory();

    // Start local mock OpenAI-compatible upstream provider
    mockUpstream = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk.toString();
      });
      req.on('end', () => {
        let parsed: Record<string, any> = {};
        try {
          parsed = JSON.parse(raw || '{}');
        } catch {
          parsed = {};
        }
        const model = typeof parsed.model === 'string' ? parsed.model : 'eco-fast-model';
        lastUpstreamModel = model;

        if (parsed.stream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          const chunk1 = {
            id: 'chatcmpl-stream-1',
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: { role: 'assistant', content: `Streamed from ${model}` }, finish_reason: null }],
          };
          const chunk2 = {
            id: 'chatcmpl-stream-1',
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 },
          };
          res.write(`data: ${JSON.stringify(chunk1)}\n\n`);
          res.write(`data: ${JSON.stringify(chunk2)}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-mock-1',
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: `Served by ${model}` },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 80, completion_tokens: 40, total_tokens: 120 },
          }),
        );
      });
    });

    mockUpstream.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => mockUpstream.once('listening', () => resolve()));
    const upstreamPort = (mockUpstream.address() as { port: number }).port;
    mockUpstreamUrl = `http://127.0.0.1:${upstreamPort}/v1`;

    // Boot Express app
    const app = createApp();
    appServer = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => appServer.once('listening', () => resolve()));
    const appPort = (appServer.address() as { port: number }).port;
    baseUrl = `http://127.0.0.1:${appPort}`;

    // Create Admin, Member A, and Member B
    const admin = createUser('scenario-admin@example.com', 'AdminPass123!');
    adminId = admin.userId;
    adminToken = createSession(adminId);

    const memberA = createUser('member-a@example.com', 'MemberAPass123!', 'member');
    memberAId = memberA.userId;
    memberAToken = createSession(memberAId);
    memberAKey1 = mintUserApiKey(memberAId, 'Cursor Laptop');
    memberAKey2 = mintUserApiKey(memberAId, 'Claude Code CLI');

    const memberB = createUser('member-b@example.com', 'MemberBPass123!', 'member');
    memberBId = memberB.userId;
    memberBToken = createSession(memberBId);
    memberBKey = mintUserApiKey(memberBId, 'Member B Key');

    // Isolate fallback chain to our two deterministic custom models
    const db = getDb();
    db.prepare("DELETE FROM settings WHERE key = 'active_profile_id'").run();
    setSetting('explore_enabled', 'false');
    db.prepare('UPDATE models SET enabled = 0').run();
    db.prepare('DELETE FROM fallback_config').run();

    // Register eco-fast-model & frontier-max-model against local mock upstream
    const regEco = await apiRequest('/api/keys/custom', {
      method: 'POST',
      token: adminToken,
      body: {
        baseUrl: mockUpstreamUrl,
        apiKey: 'mock-upstream-secret',
        model: 'eco-fast-model',
        displayName: 'Eco Fast Model',
      },
    });
    expect(regEco.status).toBe(201);

    const regMax = await apiRequest('/api/keys/custom', {
      method: 'POST',
      token: adminToken,
      body: {
        baseUrl: mockUpstreamUrl,
        model: 'frontier-max-model',
        displayName: 'Frontier Max Model',
      },
    });
    expect(regMax.status).toBe(201);

    // Configure clear speed vs intelligence characteristics + historical stats so bandit presets are 100% deterministic
    db.prepare(
      `UPDATE models
       SET intelligence_rank = 60, speed_rank = 1, size_label = 'Small', supports_vision = 1, supports_tools = 1, context_window = 128000
       WHERE model_id = 'eco-fast-model'`,
    ).run();

    db.prepare(
      `UPDATE models
       SET intelligence_rank = 1, speed_rank = 10, size_label = 'Frontier', supports_vision = 1, supports_tools = 1, context_window = 256000
       WHERE model_id = 'frontier-max-model'`,
    ).run();

    const customKeyRow = db
      .prepare("SELECT id FROM api_keys WHERE platform = 'custom' LIMIT 1")
      .get() as { id: number };

    for (let i = 0; i < 60; i++) {
      // eco-fast-model: ultra fast (50ms latency, 30ms TTFB, 300 output tokens => ~6000 tok/s)
      logRequest('custom', 'eco-fast-model', customKeyRow.id, 'success', 100, 300, 50, null, 30);
      // frontier-max-model: slow & deep (6000ms latency, 4900ms TTFB, 10 output tokens => ~1.6 tok/s)
      logRequest('custom', 'frontier-max-model', customKeyRow.id, 'success', 100, 10, 6000, null, 4900);
    }
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => appServer.close(() => resolve()));
    await new Promise<void>((resolve) => mockUpstream.close(() => resolve()));
    getDb().close();
  });

  describe('1. Deterministic Zero-Latency Scenario Classifier', () => {
    it('detects supported /v1 wire surfaces accurately without matching count_tokens', () => {
      expect(detectScenarioWireSurface('/chat/completions')).toBe('chat_completions');
      expect(detectScenarioWireSurface('/v1/chat/completions')).toBe('chat_completions');
      expect(detectScenarioWireSurface('/messages')).toBe('anthropic_messages');
      expect(detectScenarioWireSurface('/v1/messages')).toBe('anthropic_messages');
      expect(detectScenarioWireSurface('/v1/messages/count_tokens')).toBeNull();
      expect(detectScenarioWireSurface('/responses')).toBe('responses');
      expect(detectScenarioWireSurface('/v1/responses')).toBe('responses');
    });

    it('classifies background scenarios (titles, commits, compaction, tiny Haiku utility) in EN & VI', () => {
      const titleRes = classifyScenarioRequest({
        model: 'auto',
        messages: [
          { role: 'system', content: 'Generate a concise 3-6 word title for this conversation.' },
          { role: 'user', content: 'Fixing TypeScript ESLint config in monorepo' },
        ],
      });
      expect(titleRes.scenario).toBe('background');

      const viCommit = classifyScenarioRequest({
        model: 'auto',
        messages: [{ role: 'user', content: 'Hãy viết commit message ngắn gọn cho git diff này' }],
      });
      expect(viCommit.scenario).toBe('background');

      const unaccentedViTitle = classifyScenarioRequest({
        model: 'auto',
        messages: [{ role: 'user', content: 'Tao tieu de ngan cho doan chat nay' }],
      });
      expect(unaccentedViTitle.scenario).toBe('background');

      const compaction = classifyScenarioRequest(
        {
          model: 'claude-sonnet-4-5',
          messages: [
            {
              role: 'user',
              content: 'Please summarize the conversation so far for context compaction.',
            },
          ],
        },
        { wireSurface: 'anthropic_messages' },
      );
      expect(compaction.scenario).toBe('background');

      const subagentHaiku = classifyScenarioRequest(
        {
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 100,
          messages: [{ role: 'user', content: 'Extract the primary topic word.' }],
        },
        { wireSurface: 'anthropic_messages' },
      );
      expect(subagentHaiku.scenario).toBe('background');
    });

    it('classifies think scenarios across OpenAI reasoning_effort, Anthropic thinking, Responses reasoning, and complex architecture prompts', () => {
      const openaiThink = classifyScenarioRequest({
        model: 'auto',
        reasoning_effort: 'high',
        messages: [{ role: 'user', content: 'Fix bug in parser.ts' }],
      });
      expect(openaiThink.scenario).toBe('think');

      const anthropicThink = classifyScenarioRequest(
        {
          model: 'claude-sonnet-4-5',
          thinking: { type: 'enabled', budget_tokens: 16000 },
          messages: [{ role: 'user', content: 'Refactor state machine' }],
        },
        { wireSurface: 'anthropic_messages' },
      );
      expect(anthropicThink.scenario).toBe('think');

      const anthropicDisabled = classifyScenarioRequest(
        {
          model: 'claude-sonnet-4-5',
          thinking: { type: 'disabled' },
          messages: [{ role: 'user', content: 'Add a CSS class to header' }],
        },
        { wireSurface: 'anthropic_messages' },
      );
      expect(anthropicDisabled.scenario).toBe('default');

      const responsesThink = classifyScenarioRequest(
        {
          model: 'auto',
          reasoning: { effort: 'medium' },
          input: 'Optimize query planner',
        },
        { wireSurface: 'responses' },
      );
      expect(responsesThink.scenario).toBe('think');

      const heuristicArch = classifyScenarioRequest({
        model: 'auto',
        messages: [
          {
            role: 'user',
            content:
              'Perform a root cause analysis of this race condition and propose a distributed architecture with trade-offs step by step.',
          },
        ],
      });
      expect(heuristicArch.scenario).toBe('think');

      const viArch = classifyScenarioRequest({
        model: 'auto',
        messages: [
          {
            role: 'user',
            content: 'Thiet ke kien truc phan tan va phan tich nguyen nhan goc cua deadlock.',
          },
        ],
      });
      expect(viArch.scenario).toBe('think');
    });

    it('classifies vision, webSearch, longContext, and default accurately across all wire formats', () => {
      const openaiVision = classifyScenarioRequest({
        model: 'auto',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What UI bug is in this screenshot?' },
              {
                type: 'image_url',
                image_url: { url: `data:image/png;base64,${'A'.repeat(300_000)}` },
              },
            ],
          },
        ],
      });
      expect(openaiVision.scenario).toBe('vision');
      // Base64 image data must NOT falsely inflate estimatedInputTokens to >60k!
      expect(openaiVision.estimatedInputTokens).toBeLessThan(5_000);

      const anthropicSearch = classifyScenarioRequest(
        {
          model: 'claude-sonnet-4-5',
          tools: [{ type: 'web_search_20250305', name: 'web_search' }],
          messages: [{ role: 'user', content: 'Latest Node.js 24 release notes' }],
        },
        { wireSurface: 'anthropic_messages' },
      );
      expect(anthropicSearch.scenario).toBe('webSearch');

      const responsesLongContext = classifyScenarioRequest(
        {
          model: 'auto',
          input: 'x'.repeat(60_000), // ~15,000 tokens
        },
        { wireSurface: 'responses', longContextThreshold: 10_000 },
      );
      expect(responsesLongContext.scenario).toBe('longContext');

      const standardTurn = classifyScenarioRequest({
        model: 'auto',
        messages: [{ role: 'user', content: 'Write a TypeScript helper to format dates as ISO.' }],
      });
      expect(standardTurn.scenario).toBe('default');

      // Script-weighted estimate: Vietnamese and CJK text must NOT be
      // undercounted at chars/4, or long-context routing never triggers.
      const vietnameseTurn = classifyScenarioRequest({
        model: 'auto',
        messages: [{ role: 'user', content: 'à'.repeat(100) }],
      });
      // 100 accented chars = 40 tokens; chars/4 would have said 25.
      expect(vietnameseTurn.estimatedInputTokens).toBe(40);
      const cjkTurn = classifyScenarioRequest({
        model: 'auto',
        messages: [{ role: 'user', content: '你好世界'.repeat(10) }],
      });
      // 40 CJK chars = 40 tokens; chars/4 would have said 10.
      expect(cjkTurn.estimatedInputTokens).toBe(40);

      // Sub-millisecond performance check
      const t0 = performance.now();
      for (let i = 0; i < 100; i++) {
        classifyScenarioRequest({
          model: 'auto',
          messages: [{ role: 'user', content: 'Implement a binary search function in TypeScript' }],
        });
      }
      const elapsedMs = performance.now() - t0;
      expect(elapsedMs).toBeLessThan(80);
    });
  });

  describe('2. Per-User & Per-Key Policy Isolation, RBAC & Surface Integrity', () => {
    it('preserves PERMISSION_GATES frozen surface and enforces RBAC on /api/scenario-routing/*', async () => {
      expect(PERMISSION_GATES.length).toBeGreaterThanOrEqual(19);
      expect(PERMISSION_GATES.some((g) => g.path === '/api/keys')).toBe(true);
      expect(PERMISSION_GATES.some((g) => g.path === '/api/scenario-routing')).toBe(false);

      // Unauthenticated requests are rejected with 401
      const unauth = await apiRequest('/api/scenario-routing/config');
      expect(unauth.status).toBe(401);

      // Upstream gated routes remain forbidden to unprivileged members
      const memberKeysPage = await apiRequest('/api/keys', { token: memberAToken });
      expect(memberKeysPage.status).toBe(403);

      // Admin scenario inspection endpoint is 403 for members and 200 for admins
      const memberAdminTry = await apiRequest(`/api/scenario-routing/admin/user/${memberBId}`, {
        token: memberAToken,
      });
      expect(memberAdminTry.status).toBe(403);

      const adminInspect = await apiRequest(`/api/scenario-routing/admin/user/${memberAId}`, {
        token: adminToken,
      });
      expect(adminInspect.status).toBe(200);
    });

    it('isolates scenario policies strictly between Member A and Member B', async () => {
      // Member A saves account-wide policy
      const saveA = await apiRequest('/api/scenario-routing/policy', {
        method: 'PUT',
        token: memberAToken,
        body: {
          enabled: true,
          longContextThreshold: 48000,
          rules: {
            background: { enabled: true, targetMode: 'eco', targetModel: null, overrideExplicitModel: true },
            think: { enabled: true, targetMode: 'max', targetModel: null, overrideExplicitModel: false },
          },
        },
      });
      expect(saveA.status).toBe(200);
      expect(saveA.body?.policy?.enabled).toBe(true);
      expect(saveA.body?.policy?.longContextThreshold).toBe(48000);

      // Member B's config remains untouched (disabled, 60000 default)
      const cfgB = await apiRequest('/api/scenario-routing/config', { token: memberBToken });
      expect(cfgB.status).toBe(200);
      expect(cfgB.body?.accountPolicy?.enabled).toBe(false);
      expect(cfgB.body?.accountPolicy?.longContextThreshold).toBe(60000);

      // Member B cannot read, mutate, or delete Member A's key policy
      const crossWrite = await apiRequest('/api/scenario-routing/policy', {
        method: 'PUT',
        token: memberBToken,
        body: {
          keyId: memberAKey1.id,
          enabled: true,
        },
      });
      expect(crossWrite.status).toBe(404);

      const crossDelete = await apiRequest(`/api/scenario-routing/policy/${memberAKey1.id}`, {
        method: 'DELETE',
        token: memberBToken,
      });
      expect(crossDelete.status).toBe(404);

      const crossPackage = await apiRequest('/api/scenario-routing/ide-package', {
        method: 'POST',
        token: memberBToken,
        body: {
          toolId: 'claude-code',
          rawApiKey: memberAKey1.key,
        },
      });
      expect(crossPackage.status).toBe(403);
    });
  });

  describe('3. End-to-End /v1 Scenario Auto-Routing, Safe Fallback & Telemetry', () => {
    it('offloads background requests to Eco model and routes think requests to Max model across /v1 surfaces', async () => {
      clearReasoningMemory();

      // 1. Background request on /v1/chat/completions -> routes to eco-fast-model & records quota savings
      const bgRes = await apiRequest('/v1/chat/completions', {
        method: 'POST',
        token: memberAKey1.key,
        body: {
          model: 'auto',
          messages: [
            { role: 'system', content: 'Generate a concise 3-6 word title for this conversation.' },
            { role: 'user', content: 'Setting up Vite and Vitest in our project' },
          ],
        },
      });
      expect(bgRes.status).toBe(200);
      expect(bgRes.headers.get('x-freellm-scenario')).toBe('background');
      expect(bgRes.headers.get('x-freellm-scenario-mode')).toBe('eco');
      expect(lastUpstreamModel).toBe('eco-fast-model');
      expect(bgRes.body?.choices?.[0]?.message?.content).toContain('eco-fast-model');

      // 2. Think request on /v1/messages (Anthropic wire) -> routes to frontier-max-model & preserves Anthropic shape
      clearReasoningMemory();
      const thinkAnthropic = await apiRequest('/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': memberAKey1.key,
          'anthropic-version': '2023-06-01',
        },
        body: {
          model: 'claude-sonnet-4-5',
          max_tokens: 512,
          thinking: { type: 'enabled', budget_tokens: 12000 },
          messages: [{ role: 'user', content: 'Design a lock-free ring buffer' }],
        },
      });
      expect(thinkAnthropic.status).toBe(200);
      expect(thinkAnthropic.headers.get('x-freellm-scenario')).toBe('think');
      expect(thinkAnthropic.headers.get('x-freellm-scenario-mode')).toBe('max');
      expect(lastUpstreamModel).toBe('frontier-max-model');
      expect(thinkAnthropic.body?.type).toBe('message');
      expect(thinkAnthropic.body?.content?.[0]?.text).toContain('frontier-max-model');

      // 3. Responses API (/v1/responses) streaming & non-streaming compatibility
      clearReasoningMemory();
      const responsesBg = await apiRequest('/v1/responses', {
        method: 'POST',
        token: memberAKey1.key,
        body: {
          model: 'auto',
          input: 'Write a git commit message for fixing the typo in README.md',
        },
      });
      expect(responsesBg.status).toBe(200);
      expect(responsesBg.headers.get('x-freellm-scenario')).toBe('background');
      expect(responsesBg.body?.object).toBe('response');
      expect(lastUpstreamModel).toBe('eco-fast-model');

      // 4. Streaming SSE compatibility on /v1/chat/completions
      const streamRes = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${memberAKey1.key}`,
        },
        body: JSON.stringify({
          model: 'auto',
          stream: true,
          reasoning_effort: 'high',
          messages: [{ role: 'user', content: 'Stream deep analysis' }],
        }),
      });
      expect(streamRes.status).toBe(200);
      expect(streamRes.headers.get('x-freellm-scenario')).toBe('think');
      const streamText = await streamRes.text();
      expect(streamText).toContain('Streamed from frontier-max-model');
      expect(streamText).toContain('[DONE]');

      // Check cumulative telemetry & estimated high-tier quota saved for Member A (isolated from Member B)
      const cfgA = await apiRequest('/api/scenario-routing/config', { token: memberAToken });
      expect(cfgA.status).toBe(200);
      expect(cfgA.body?.telemetry?.totalHits).toBe(4);
      expect(cfgA.body?.telemetry?.totalOffloadedHits).toBe(2);
      expect(cfgA.body?.telemetry?.estimatedTokensSaved).toBeGreaterThan(0);
      expect(cfgA.body?.telemetry?.byScenario?.background?.hitCount).toBe(2);
      expect(cfgA.body?.telemetry?.byScenario?.think?.hitCount).toBe(2);

      const cfgB = await apiRequest('/api/scenario-routing/config', { token: memberBToken });
      expect(cfgB.body?.telemetry?.totalHits).toBe(0);
    });

    it('supports per-key policy overrides and safely falls back when targetModel is unavailable', async () => {
      // Configure per-key override on memberAKey2 pointing background to a non-existent/disabled model
      const overrideRes = await apiRequest('/api/scenario-routing/policy', {
        method: 'PUT',
        token: memberAToken,
        body: {
          keyId: memberAKey2.id,
          enabled: true,
          rules: {
            background: {
              enabled: true,
              targetMode: 'eco',
              targetModel: 'unavailable-ghost-model-999',
              overrideExplicitModel: true,
            },
          },
        },
      });
      expect(overrideRes.status).toBe(200);

      clearReasoningMemory();
      const fallbackCall = await apiRequest('/v1/chat/completions', {
        method: 'POST',
        token: memberAKey2.key,
        body: {
          model: 'frontier-max-model',
          messages: [{ role: 'user', content: 'Generate a short title for this chat' }],
        },
      });
      expect(fallbackCall.status).toBe(200);
      expect(fallbackCall.headers.get('x-freellm-scenario')).toBe('background');
      expect(fallbackCall.headers.get('x-freellm-scenario-fallback')).toBe('tier_preset');
      expect(lastUpstreamModel).toBe('eco-fast-model');

      // Now point memberAKey2 default scenario to a valid routable targetModel ('frontier-max-model')
      await apiRequest('/api/scenario-routing/policy', {
        method: 'PUT',
        token: memberAToken,
        body: {
          keyId: memberAKey2.id,
          enabled: true,
          rules: {
            default: {
              enabled: true,
              targetMode: 'max',
              targetModel: 'frontier-max-model',
              overrideExplicitModel: true,
            },
          },
        },
      });

      clearReasoningMemory();
      const pinnedCall = await apiRequest('/v1/chat/completions', {
        method: 'POST',
        token: memberAKey2.key,
        body: {
          model: 'auto',
          messages: [{ role: 'user', content: 'Write a unit test for add(a, b)' }],
        },
      });
      expect(pinnedCall.status).toBe(200);
      expect(pinnedCall.headers.get('x-freellm-scenario')).toBe('default');
      expect(pinnedCall.headers.get('x-freellm-scenario-target')).toBe('frontier-max-model');
      expect(lastUpstreamModel).toBe('frontier-max-model');

      // Delete per-key override and verify cleanup
      const delRes = await apiRequest(`/api/scenario-routing/policy/${memberAKey2.id}`, {
        method: 'DELETE',
        token: memberAToken,
      });
      expect(delRes.status).toBe(200);
      expect(delRes.body?.deleted).toBe(true);
    });
  });

  describe('4. 1-Click Personalized IDE Config Packager & Live Connection Verifier', () => {
    it('generates clean, shell-safe config bundles for all 6 coding agents', async () => {
      for (const toolId of IDE_PACKAGER_TOOLS) {
        const res = await apiRequest('/api/scenario-routing/ide-package', {
          method: 'POST',
          token: memberAToken,
          body: {
            toolId,
            gatewayUrl: 'https://gateway.example.com/v1/',
            keyId: memberAKey1.id,
            rawApiKey: memberAKey1.key,
          },
        });
        expect(res.status).toBe(200);
        const bundle = res.body?.bundle;
        expect(bundle.toolId).toBe(toolId);
        expect(bundle.hasRawKey).toBe(true);
        expect(bundle.files.length).toBeGreaterThanOrEqual(1);
        expect(bundle.powershellSnippet).toContain('verify-ping');
        expect(bundle.bashSnippet).toContain('verify-ping');

        if (toolId === 'claude-code') {
          expect(bundle.baseUrl).toBe('https://gateway.example.com');
          expect(bundle.files[0].content).toContain('ANTHROPIC_BASE_URL');
          expect(bundle.files[0].content).toContain(memberAKey1.key);
        } else {
          expect(bundle.baseUrl).toBe('https://gateway.example.com/v1');
        }
      }

      // Shell injection characters in gatewayUrl or keyPrefix are stripped safely
      const sanitized = generateIdePackageBundle({
        toolId: 'codex',
        gatewayUrl: 'https://example.com"; rm -rf /',
        rawApiKey: 'sk-flm-safe$(whoami)`id`',
      });
      expect(sanitized.baseUrl).toBe('http://127.0.0.1:3001/v1');
      expect(sanitized.bashSnippet).not.toContain('`');
      expect(sanitized.bashSnippet).not.toContain('$(');
    });

    it('verifies live IDE connection via verify-ping with Personal API Key and isolates status per user', async () => {
      // Fresh Member B key starts unverified
      const beforeStatus = await apiRequest(
        `/api/scenario-routing/connection-status?keyId=${memberBKey.id}`,
        { token: memberBToken },
      );
      expect(beforeStatus.status).toBe(200);
      expect(beforeStatus.body?.status?.connected).toBe(false);
      expect(beforeStatus.body?.status?.verifiedVia).toBe('none');

      // Invalid personal key is rejected with 401
      const badPing = await apiRequest('/api/scenario-routing/verify-ping', {
        method: 'POST',
        token: 'sk-flm-invalid-nonexistent-key-0000',
      });
      expect(badPing.status).toBe(401);

      // Terminal 1-liner sends POST /api/scenario-routing/verify-ping with Member B's Personal API Key
      const livePing = await apiRequest('/api/scenario-routing/verify-ping', {
        method: 'POST',
        token: memberBKey.key,
      });
      expect(livePing.status).toBe(200);
      expect(livePing.body?.ok).toBe(true);
      expect(livePing.body?.status?.connected).toBe(true);
      expect(livePing.body?.status?.verifiedVia).toBe('verify_ping');

      // Dashboard poller immediately sees green connected status
      const afterStatus = await apiRequest(
        `/api/scenario-routing/connection-status?keyId=${memberBKey.id}`,
        { token: memberBToken },
      );
      expect(afterStatus.status).toBe(200);
      expect(afterStatus.body?.status?.connected).toBe(true);
      expect(afterStatus.body?.status?.verifiedVia).toBe('verify_ping');
    });
  });
});
