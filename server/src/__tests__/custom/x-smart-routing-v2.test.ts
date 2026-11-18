import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import { getDb, initDb, setSetting } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import {
  learnOutputCapFromError,
  learnedOutputCap,
  parseMaxTokensCeiling,
  resetLearnedOutputCaps,
} from '../../lib/output-cap.js';
import {
  chooseRoutingPreset,
  getDecisionRoutingStatus,
  resetDecisionRoutingCache,
  routingStrategyHeader,
  setDecisionRoutingSettings,
} from '../../services/routing-decision.js';
import { setRoutingStrategy } from '../../services/router.js';
import { createSession, createUser } from '../../services/auth.js';
import { createCombo, setEnabled } from '../../custom/x-gateway/config.js';
import { mintXGatewayClientKey } from '../../custom/x-gateway/client-keys.js';
import { invalidateXGatewayKeyCache } from '../../custom/provider-accounts/store.js';
import {
  classifyIntentAndScenario,
  classifyPromptIntent,
  getScenarioRoutingPolicy,
  resetScenarioRoutingPolicyCache,
  setScenarioRoutingPolicy,
} from '../../custom/x-gateway/intent-router.js';
import {
  MIN_PLAUSIBLE_MAX_TOKENS_CEILING,
  clampReasoningEffortToLearned,
  clampTopLevelMaxTokens,
  clearLearnedModelCaps,
  getLearnedModelCapRecord,
  learnCapsFromUpstreamError,
  listLearnedModelCaps,
  parseLearnedMaxTokensCeiling,
  parseLearnedReasoningEffortEnum,
  parseLearnedThinkingBudgetCeiling,
  resetLearnedModelCapsForTests,
} from '../../custom/x-gateway/learned-caps.js';
import {
  getModelsDevSyncStatus,
  getSyncedModelSpec,
  readModelsDevSyncEnvFlag,
  resetModelsDevSyncForTests,
  resolveEffectiveModelCapabilities,
  syncModelsDevCatalog,
} from '../../custom/x-gateway/models-dev-sync.js';
import {
  getMergedPricing,
  resetPricingOverrides,
  updatePricingOverrides,
} from '../../custom/x-gateway/pricing.js';
import { mintDashboardToken } from '../helpers/auth.js';

const realFetch = globalThis.fetch;

async function startTestServer() {
  const app = createApp();
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve()))),
  };
}

function insertGatewayProviderAccount(opts: {
  provider: string;
  label: string;
  apiKey: string;
  models: string[];
  baseUrl?: string;
}): number {
  const { encrypted, iv, authTag } = encrypt(opts.apiKey);
  const info = getDb().prepare(`
    INSERT INTO x_gateway_keys (
      provider, label, auth_method, encrypted_key, iv, auth_tag,
      base_url, enabled, status, models_json
    ) VALUES (?, ?, 'api_key', ?, ?, ?, ?, 1, 'healthy', ?)
  `).run(
    opts.provider,
    opts.label,
    encrypted,
    iv,
    authTag,
    opts.baseUrl ?? null,
    JSON.stringify(opts.models.map(id => ({ id, name: id }))),
  );
  invalidateXGatewayKeyCache();
  return Number(info.lastInsertRowid);
}

describe('Spec 032 — Smart Routing v2, Persistent Learned Caps & models.dev Sync', () => {
  const savedModelsDevEnv = process.env.MODELS_DEV_SYNC_ENABLED;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    delete process.env.MODELS_DEV_SYNC_ENABLED;
    initDb(':memory:');
    resetScenarioRoutingPolicyCache();
    resetLearnedOutputCaps();
    resetLearnedModelCapsForTests();
    resetModelsDevSyncForTests();
    resetDecisionRoutingCache();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (savedModelsDevEnv === undefined) {
      delete process.env.MODELS_DEV_SYNC_ENABLED;
    } else {
      process.env.MODELS_DEV_SYNC_ENABLED = savedModelsDevEnv;
    }
    vi.restoreAllMocks();
  });

  describe('<1ms Multilingual Intent & Scenario Classifier', () => {
    it('classifies English, Vietnamese, and multilingual intents in sub-millisecond average time', () => {
      expect(classifyPromptIntent('Write an async TypeScript function to query the SQLite database').intent).toBe('code');
      expect(classifyPromptIntent('Hãy viết hàm TypeScript gỡ lỗi truy vấn SQL bất đồng bộ').intent).toBe('code');
      expect(classifyPromptIntent('Calculate the integral and eigenvalue of this matrix').intent).toBe('math');
      expect(classifyPromptIntent('Giải phương trình vi phân và tính tích phân của ma trận này').intent).toBe('math');
      expect(classifyPromptIntent('Prove this theorem step by step from first principles').intent).toBe('reasoning');
      expect(classifyPromptIntent('Chứng minh định lý này từng bước một bằng lập luận logic').intent).toBe('reasoning');
      expect(classifyPromptIntent('Write a creative sci-fi story and haiku poem about Mars').intent).toBe('creative');
      expect(classifyPromptIntent('Sáng tác một bài thơ và câu chuyện tiểu thuyết ngắn về mùa thu').intent).toBe('creative');
      expect(classifyPromptIntent('Xin chào, thủ đô của Việt Nam là gì?').intent).toBe('simple');
      expect(classifyPromptIntent('请用Python写一个快速排序算法函数').intent).toBe('code');

      const prompts = [
        'Viết code xử lý thuật toán đồ thị',
        'Tính đạo hàm và xác suất thống kê',
        'Chứng minh giả thuyết hội tụ từng bước',
        'Làm thơ lục bát về quê hương',
        'Xin chào bạn',
        'Compare the trade-offs of microservices versus modular monoliths across three dimensions in mid-sized teams with mixed cloud workloads and gradual migration plans over multiple quarters while balancing operational overhead and deployment velocity for fifty engineers across regions and compliance zones',
      ];
      const start = performance.now();
      for (let i = 0; i < 50; i += 1) {
        classifyIntentAndScenario({ prompt: prompts[i % prompts.length] });
      }
      const avgMs = (performance.now() - start) / 50;
      expect(avgMs).toBeLessThan(1);
    });

    it('detects background, vision, longContext, webSearch, think, and default agent scenario lanes', () => {
      const bgEn = classifyIntentAndScenario({
        prompt: 'Generate a concise 3-5 word title for this conversation.',
      });
      expect(bgEn.scenario).toBe('background');
      expect(bgEn.recommendedPreset).toBe('fastest');

      const bgVi = classifyIntentAndScenario({
        prompt: 'Tạo tiêu đề ngắn cho cuộc trò chuyện này và viết commit message.',
      });
      expect(bgVi.scenario).toBe('background');

      const vision = classifyIntentAndScenario({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Describe this screenshot' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
            ],
          },
        ],
      });
      expect(vision.scenario).toBe('vision');

      const longCtx = classifyIntentAndScenario({
        prompt: 'Summarize these logs',
        estimatedTokens: 75_000,
      });
      expect(longCtx.scenario).toBe('longContext');
      expect(longCtx.recommendedPreset).toBe('reliable');

      const webTool = classifyIntentAndScenario({
        prompt: 'Check release notes',
        tools: [{ type: 'function', function: { name: 'web_search', parameters: {} } }],
      });
      expect(webTool.scenario).toBe('webSearch');

      const webVi = classifyIntentAndScenario({
        prompt: 'Tìm kiếm trên mạng tin tức mới nhất hôm nay',
      });
      expect(webVi.scenario).toBe('webSearch');

      const think = classifyIntentAndScenario({
        prompt: 'Suy nghĩ kỹ và phân tích kiến trúc hệ thống phân tán',
        thinkingEnabled: true,
      });
      expect(think.scenario).toBe('think');
      expect(think.recommendedPreset).toBe('smartest');

      const def = classifyIntentAndScenario({
        prompt: 'Explain how browser rendering pipelines composite CSS transforms.',
      });
      expect(def.scenario).toBe('default');
    });

    it('supports zero-latency heuristic mode in routing-decision without network calls', async () => {
      setRoutingStrategy('decision');
      setDecisionRoutingSettings({ model: 'heuristic' });
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as unknown as typeof fetch;

      const hardPick = await chooseRoutingPreset([
        { role: 'user', content: 'Chứng minh định lý bất toàn bằng suy luận từng bước.' },
      ]);
      expect(hardPick).toEqual({
        strategy: 'smartest',
        source: 'heuristic',
        model: 'heuristic',
      });
      expect(routingStrategyHeader(hardPick)).toBe('smartest');

      const fastPick = await chooseRoutingPreset([
        { role: 'user', content: 'Xin chào, AI là gì?' },
      ]);
      expect(fastPick.strategy).toBe('fastest');
      expect(fastPick.source).toBe('heuristic');
      expect(fetchSpy).not.toHaveBeenCalled();

      const status = getDecisionRoutingStatus();
      expect(status.ready).toBe(true);
      expect(status.hasModels).toBe(true);
    });
  });

  describe('Persistent Learned Caps & Clause-Safe Parsing', () => {
    it('parses JSON-escaped \\u003c/\\u003d max_tokens ceilings and ignores bogus/unrelated clauses', () => {
      expect(
        parseLearnedMaxTokensCeiling(
          '{"error":{"message":"The parameter `max_tokens` integer above maximum, expected a value \\u003c\\u003d 131072, got 178586"}}',
        ),
      ).toBe(131072);

      expect(
        parseLearnedMaxTokensCeiling(
          'Invalid parameter `max_tokens`: expected a value \\u003c 8192',
        ),
      ).toBe(8191);

      // Bogus tiny ceilings below MIN_PLAUSIBLE_MAX_TOKENS_CEILING (256) are rejected
      expect(MIN_PLAUSIBLE_MAX_TOKENS_CEILING).toBe(256);
      expect(parseLearnedMaxTokensCeiling('max_tokens expected a value <= 1')).toBeNull();
      expect(parseLearnedMaxTokensCeiling('max_tokens expected a value <= 256')).toBe(256);

      // Never confuses thinking.budget_tokens or TPM limits with max_tokens
      expect(
        parseLearnedMaxTokensCeiling(
          'thinking.budget_tokens expected a value <= 32768; check request parameters',
        ),
      ).toBeNull();
      expect(
        parseLearnedMaxTokensCeiling('Request exceeds 30000 TPM limit; max_tokens=4096'),
      ).toBeNull();

      // Also wired into output-cap.ts parseMaxTokensCeiling
      expect(
        parseMaxTokensCeiling(
          'Upstream 400: max_tokens expected a value \\u003c\\u003d 65536',
        ),
      ).toBe(65536);
    });

    it('clamps max_tokens and squeezes thinking.budget_tokens <= cap - 1024 or drops thinking below 1024', () => {
      const payload1: Record<string, unknown> = {
        model: 'claude-sonnet-4-6',
        max_tokens: 128_000,
        thinking: { type: 'enabled', budget_tokens: 64_000 },
      };
      expect(clampTopLevelMaxTokens(payload1, 32_768)).toBe(true);
      expect(payload1.max_tokens).toBe(32_768);
      expect(payload1.thinking).toEqual({ type: 'enabled', budget_tokens: 31_744 });

      const payloadSmallCap: Record<string, unknown> = {
        model: 'claude-haiku-4-5',
        max_tokens: 16_384,
        thinking: { type: 'enabled', budget_tokens: 8_192 },
      };
      // 1536 - 1024 = 512 < 1024 -> thinking object must be removed
      expect(clampTopLevelMaxTokens(payloadSmallCap, 1_536)).toBe(true);
      expect(payloadSmallCap.max_tokens).toBe(1_536);
      expect(payloadSmallCap.thinking).toBeUndefined();
    });

    it('learns thinking_budget and reasoning_effort ceilings and persists write-through to SQLite', () => {
      expect(
        parseLearnedThinkingBudgetCeiling(
          '400 GenerateContentRequest.generation_config.thinking_config.thinking_budget: thinking_budget must be in the range [-1, 24576]',
        ),
      ).toBe(24576);

      expect(
        parseLearnedReasoningEffortEnum(
          "400 Invalid 'reasoning_effort': expected one of `low`, `medium`, or `high`.",
        ),
      ).toEqual(['low', 'medium', 'high']);

      expect(clampReasoningEffortToLearned('xhigh', ['low', 'medium', 'high'])).toBe('high');
      expect(clampReasoningEffortToLearned('minimal', ['low', 'high'])).toBe('low');
      expect(clampReasoningEffortToLearned('medium', ['low', 'high'])).toBe('high');

      const target = { provider: 'groq', modelId: 'openai/gpt-oss-120b', endpointScope: null };
      learnCapsFromUpstreamError(
        target,
        Object.assign(
          new Error(
            'max_tokens expected a value \\u003c\\u003d 32768; reasoning_effort must be one of low, medium, high',
          ),
          { status: 400 },
        ),
      );
      learnCapsFromUpstreamError(
        target,
        Object.assign(
          new Error('thinking_budget must be in the range [-1, 16384]'),
          { status: 400 },
        ),
      );

      // Verify persisted row in SQLite directly
      const dbRow = getDb()
        .prepare(
          'SELECT max_output_tokens, max_thinking_budget, supported_reasoning_efforts, hit_count FROM custom_learned_model_caps WHERE provider = ? AND model_id = ?',
        )
        .get('groq', 'openai/gpt-oss-120b') as {
        max_output_tokens: number;
        max_thinking_budget: number;
        supported_reasoning_efforts: string;
        hit_count: number;
      };
      expect(dbRow).toEqual({
        max_output_tokens: 32768,
        max_thinking_budget: 16384,
        supported_reasoning_efforts: JSON.stringify(['low', 'medium', 'high']),
        hit_count: 3,
      });

      // Also verify output-cap.ts write-through integration
      learnOutputCapFromError(
        { platform: 'ollama', modelId: 'nemotron-3-ultra' },
        Object.assign(new Error("max_tokens (128000) exceeds model's maximum output tokens (65536)"), { status: 400 }),
      );
      expect(learnedOutputCap('ollama', 'nemotron-3-ultra')).toBe(65536);
      expect(getLearnedModelCapRecord('ollama', 'nemotron-3-ultra')?.maxOutputTokens).toBe(65536);

      expect(listLearnedModelCaps().length).toBe(2);
      expect(clearLearnedModelCaps({ provider: 'ollama' })).toBe(1);
      expect(listLearnedModelCaps().length).toBe(1);
    });
  });

  describe('models.dev SSRF-Guarded Sync & Priority Resolution', () => {
    const sampleModelsDevCatalog = {
      openai: {
        id: 'openai',
        models: {
          'gpt-5.4-mini': {
            id: 'gpt-5.4-mini',
            name: 'GPT-5.4 Mini',
            family: 'gpt-5',
            tool_call: true,
            reasoning: true,
            structured_output: true,
            reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
            modalities: { input: ['text', 'image'], output: ['text'] },
            limit: { context: 400_000, input: 360_000, output: 65_536 },
            cost: { input: 0.4, output: 1.6, cache_read: 0.1, reasoning: 1.6 },
          },
        },
      },
      groq: {
        id: 'groq',
        models: {
          'qwen-qwq-32b': {
            id: 'qwen-qwq-32b',
            name: 'Qwen QwQ 32B',
            tool_call: true,
            reasoning: true,
            modalities: { input: ['text'], output: ['text'] },
            limit: { context: 131_072, output: 16_384 },
            cost: { input: 0.29, output: 0.39 },
          },
        },
      },
    };

    it('enforces SSRF guards against non-HTTPS, loopback, private, and metadata targets', async () => {
      const fetchSpy = vi.fn();

      const httpResult = await syncModelsDevCatalog({
        url: 'http://models.dev/api.json',
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });
      expect(httpResult.success).toBe(false);
      expect(httpResult.error).toMatch(/https/i);

      const metadataResult = await syncModelsDevCatalog({
        url: 'https://169.254.169.254/latest/meta-data',
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });
      expect(metadataResult.success).toBe(false);

      const rebindPrivateResult = await syncModelsDevCatalog({
        url: 'https://models.dev/api.json',
        resolveDns: async () => ['127.0.0.1'],
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });
      expect(rebindPrivateResult.success).toBe(false);
      expect(rebindPrivateResult.error).toMatch(/SSRF|private|blocked/i);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('honors MODELS_DEV_SYNC_ENABLED kill-switch, dry-run, and User Override > models.dev > Builtin priority', async () => {
      const mockCatalogFetch = vi.fn(async () =>
        new Response(JSON.stringify(sampleModelsDevCatalog), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

      // Dry-run parses without writing to SQLite
      const dry = await syncModelsDevCatalog({
        dryRun: true,
        resolveDns: async () => ['93.184.216.34'],
        fetchImpl: mockCatalogFetch as unknown as typeof fetch,
      });
      expect(dry.success).toBe(true);
      expect(dry.dryRun).toBe(true);
      expect(dry.modelCount).toBe(3); // openai->[openai,codex] + groq->[groq]
      expect(getModelsDevSyncStatus().storedModelCount).toBe(0);

      // Full sync writes to SQLite and populates cached lookup + pricing
      const synced = await syncModelsDevCatalog({
        dryRun: false,
        resolveDns: async () => ['93.184.216.34'],
        fetchImpl: mockCatalogFetch as unknown as typeof fetch,
      });
      expect(synced.success).toBe(true);
      expect(getModelsDevSyncStatus().storedModelCount).toBe(3);

      const spec = getSyncedModelSpec('openai', 'gpt-5.4-mini');
      expect(spec).toMatchObject({
        contextWindow: 400_000,
        maxOutputTokens: 65_536,
        modalitiesInput: ['text', 'image'],
        supportsTools: true,
        supportsReasoning: true,
        supportsVision: true,
        reasoningEfforts: ['low', 'medium', 'high'],
      });

      // Capability Priority: Builtin -> models.dev -> User Override
      const builtinOnly = resolveEffectiveModelCapabilities('openai', 'unknown-model', {
        contextWindow: 32_000,
        maxOutputTokens: 4_096,
      });
      expect(builtinOnly.source).toBe('builtin');
      expect(builtinOnly.contextWindow).toBe(32_000);

      const fromModelsDev = resolveEffectiveModelCapabilities('openai', 'gpt-5.4-mini', {
        contextWindow: 128_000,
        maxOutputTokens: 16_384,
      });
      expect(fromModelsDev.source).toBe('models_dev');
      expect(fromModelsDev.contextWindow).toBe(400_000);
      expect(fromModelsDev.maxOutputTokens).toBe(65_536);

      setSetting(
        'x_gateway_custom_model_caps',
        JSON.stringify({
          'openai/gpt-5.4-mini': { contextWindow: 200_000, maxOutputTokens: 8_192 },
        }),
      );
      const fromUserOverride = resolveEffectiveModelCapabilities('openai', 'gpt-5.4-mini', {
        contextWindow: 128_000,
      });
      expect(fromUserOverride.source).toBe('user_override');
      expect(fromUserOverride.contextWindow).toBe(200_000);
      expect(fromUserOverride.maxOutputTokens).toBe(8_192);

      // Pricing Priority: Builtin -> models.dev -> User Override
      resetPricingOverrides();
      expect(getMergedPricing().groq?.['qwen-qwq-32b']).toEqual({ input: 0.29, output: 0.39 });
      updatePricingOverrides({ groq: { 'qwen-qwq-32b': { input: 0.11, output: 0.22 } } });
      expect(getMergedPricing().groq?.['qwen-qwq-32b']).toMatchObject({ input: 0.11, output: 0.22 });

      // Kill-switch disables sync and hides synced lookups
      process.env.MODELS_DEV_SYNC_ENABLED = '0';
      expect(readModelsDevSyncEnvFlag()).toBe('false');
      expect(getSyncedModelSpec('openai', 'gpt-5.4-mini')).toBeNull();
      const killedSync = await syncModelsDevCatalog({
        fetchImpl: mockCatalogFetch as unknown as typeof fetch,
      });
      expect(killedSync.success).toBe(false);
      expect(killedSync.error).toMatch(/MODELS_DEV_SYNC_ENABLED/);
    });
  });

  describe('Admin Console Endpoints & /thruline/v1 Dispatch Integration', () => {
    it('serves /api/thruline/smart-routing/* with RBAC and routes/clamps /thruline/v1/chat/completions', async () => {
      const srv = await startTestServer();
      try {
        const adminToken = mintDashboardToken('admin@smart.local');
        const adminRow = getDb().prepare('SELECT id FROM users WHERE email = ?').get('admin@smart.local') as { id: number };

        // Create a read-only Thruline member (`use_x_gateway` only, no `edit_x_settings`)
        const reader = createUser('reader@smart.local', 'password123', 'member');
        getDb()
          .prepare('UPDATE users SET permissions = ? WHERE id = ?')
          .run(JSON.stringify(['use_x_gateway']), reader.userId);
        const readerToken = createSession(reader.userId);

        // Read-only user can GET policy and POST classify-preview, but gets 403 on PUT policy
        const getPolRes = await realFetch(`${srv.baseUrl}/api/thruline/smart-routing/policy`, {
          headers: { Authorization: `Bearer ${readerToken}` },
        });
        expect(getPolRes.status).toBe(200);

        const previewRes = await realFetch(`${srv.baseUrl}/api/thruline/smart-routing/classify-preview`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${readerToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ prompt: 'Tạo tiêu đề ngắn cho cuộc trò chuyện này' }),
        });
        expect(previewRes.status).toBe(200);
        const previewBody = (await previewRes.json()) as { scenario: string; durationMs: number };
        expect(previewBody.scenario).toBe('background');

        const forbiddenPut = await realFetch(`${srv.baseUrl}/api/thruline/smart-routing/policy`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${readerToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ enabled: true }),
        });
        expect(forbiddenPut.status).toBe(403);

        // Admin configures provider accounts + combos + Smart Routing v2 policy
        setEnabled(true, adminRow.id);
        insertGatewayProviderAccount({
          provider: 'groq',
          label: 'Groq Fast',
          apiKey: 'gsk-fast-test',
          models: ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile'],
        });
        createCombo(
          'bg-fast',
          [{ platform: 'groq', modelId: 'llama-3.1-8b-instant' }],
          adminRow.id,
          { strategy: 'fallback', description: 'Background fast lane' },
        );
        createCombo(
          'code-heavy',
          [{ platform: 'groq', modelId: 'llama-3.3-70b-versatile' }],
          adminRow.id,
          { strategy: 'fallback', description: 'Heavy coding lane' },
        );

        const putPolRes = await realFetch(`${srv.baseUrl}/api/thruline/smart-routing/policy`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${adminToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            enabled: true,
            decisionMode: 'heuristic',
            lanes: {
              default: 'combo:code-heavy',
              background: 'combo:bg-fast',
              think: 'combo:code-heavy',
              longContext: '',
              webSearch: '',
              vision: '',
            },
          }),
        });
        expect(putPolRes.status).toBe(200);
        expect(getScenarioRoutingPolicy().enabled).toBe(true);

        const clientKey = mintXGatewayClientKey(adminRow.id, 'SmartRoute E2E');
        const upstreamCalls: Array<{ model: string; maxTokens?: number }> = [];
        let rejectFirst70bCall = true;

        globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          if (url.startsWith(srv.baseUrl)) {
            return realFetch(input, init);
          }
          const parsedBody = init?.body ? (JSON.parse(String(init.body)) as { model: string; max_tokens?: number }) : { model: 'unknown' };
          upstreamCalls.push({ model: parsedBody.model, maxTokens: parsedBody.max_tokens });

          if (parsedBody.model === 'llama-3.3-70b-versatile' && rejectFirst70bCall && (parsedBody.max_tokens ?? 0) > 16384) {
            rejectFirst70bCall = false;
            return new Response(
              JSON.stringify({
                error: {
                  message: 'The parameter `max_tokens` expected a value \\u003c\\u003d 16384, got 100000',
                },
              }),
              { status: 400, headers: { 'content-type': 'application/json' } },
            );
          }

          return new Response(
            JSON.stringify({
              id: 'chatcmpl-test',
              object: 'chat.completion',
              created: Math.floor(Date.now() / 1000),
              model: parsedBody.model,
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: `Served by ${parsedBody.model}` },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }) as unknown as typeof fetch;

        // 1. Background prompt routes `auto` -> `combo:bg-fast` (`llama-3.1-8b-instant`)
        const bgChatRes = await realFetch(`${srv.baseUrl}/thruline/v1/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${clientKey.key}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'auto',
            messages: [{ role: 'user', content: 'Generate a concise 3-5 word title for this conversation.' }],
          }),
        });
        expect(bgChatRes.status).toBe(200);
        expect(bgChatRes.headers.get('x-smart-route-scenario')).toBe('background');
        expect(bgChatRes.headers.get('x-routed-via')).toBe('groq/llama-3.1-8b-instant');

        // 2. Coding prompt routes `auto` -> `combo:code-heavy` (`llama-3.3-70b-versatile`),
        //    hits escaped \u003c\u003d 16384 400 on max_tokens=100000, learns cap, clamps & retries immediately!
        const codeChatRes = await realFetch(`${srv.baseUrl}/thruline/v1/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${clientKey.key}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'auto',
            max_tokens: 100_000,
            thinking: { type: 'enabled', budget_tokens: 80_000 },
            messages: [{ role: 'user', content: 'Viết hàm TypeScript tối ưu thuật toán tìm kiếm nhị phân' }],
          }),
        });
        expect(codeChatRes.status).toBe(200);
        expect(codeChatRes.headers.get('x-smart-route-intent')).toBe('code');
        expect(codeChatRes.headers.get('x-routed-via')).toBe('groq/llama-3.3-70b-versatile');

        const calls70b = upstreamCalls.filter(c => c.model === 'llama-3.3-70b-versatile');
        expect(calls70b).toEqual([
          { model: 'llama-3.3-70b-versatile', maxTokens: 100_000 },
          { model: 'llama-3.3-70b-versatile', maxTokens: 16_384 },
        ]);

        // 3. Subsequent call pre-clamps max_tokens to 16384 with zero extra round-trips
        const secondCodeRes = await realFetch(`${srv.baseUrl}/thruline/v1/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${clientKey.key}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'auto',
            max_tokens: 90_000,
            messages: [{ role: 'user', content: 'Write another TypeScript function for sorting' }],
          }),
        });
        expect(secondCodeRes.status).toBe(200);
        expect(upstreamCalls.at(-1)).toEqual({
          model: 'llama-3.3-70b-versatile',
          maxTokens: 16_384,
        });

        // 4. Admin GET & DELETE /learned-caps
        const capsGetRes = await realFetch(`${srv.baseUrl}/api/thruline/smart-routing/learned-caps`, {
          headers: { Authorization: `Bearer ${adminToken}` },
        });
        expect(capsGetRes.status).toBe(200);
        const capsPayload = (await capsGetRes.json()) as { caps: Array<{ modelId: string; maxOutputTokens: number }> };
        expect(capsPayload.caps).toEqual([
          expect.objectContaining({ modelId: 'llama-3.3-70b-versatile', maxOutputTokens: 16_384 }),
        ]);

        const capsDelRes = await realFetch(`${srv.baseUrl}/api/thruline/smart-routing/learned-caps`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${adminToken}` },
        });
        expect(capsDelRes.status).toBe(200);
        const delPayload = (await capsDelRes.json()) as { cleared: number; caps: unknown[] };
        expect(delPayload.cleared).toBe(1);
        expect(delPayload.caps).toEqual([]);
      } finally {
        await srv.close();
      }
    });

    it('falls back gracefully to normal auto routing when a scenario lane target does not exist', () => {
      setScenarioRoutingPolicy({
        enabled: true,
        lanes: {
          default: 'combo:non-existent-combo',
          background: 'combo:missing-bg',
          think: '',
          longContext: '',
          webSearch: '',
          vision: '',
        },
      });
      expect(getScenarioRoutingPolicy().lanes.background).toBe('combo:missing-bg');
    });
  });
});
