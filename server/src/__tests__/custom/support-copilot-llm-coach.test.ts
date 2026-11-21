import http, { type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CloudAiRuntimePack, CloudSignedLease } from '@freellmapi/shared/cloud-entitlement.js';
import { createApp } from '../../app.js';
import { recordServerLocalAddress } from '../../custom/ai-platform/orchestrator/engine.js';
import { configureCloudEntitlementForTesting } from '../../custom/cloud-entitlement/service.js';
import { invalidateXGatewayKeyCache } from '../../custom/provider-accounts/store.js';
import {
  buildHumanCoachSystemPrompt,
  enforceReplySecurityInvariant,
  extractLiveReasoning,
  extractPartialCoachReply,
  hasConfiguredMainGatewayRoutes,
  isRepetitiveAssistantReply,
  matchesRequestedLocale,
  normalizeLoopbackTarget,
  parseLlmCoachResponse,
  runHumanLikeLlmCoach,
} from '../../custom/support-setup-copilot/llm-coach.js';
import { invalidateConfigCache, setEnabled as setXGatewayEnabled } from '../../custom/x-gateway/config.js';
import { getDb, initDb, setSetting } from '../../db/index.js';
import { loadConfig } from '../../lib/config.js';
import { encrypt } from '../../lib/crypto.js';
import { invalidateKeyCache } from '../../services/key-cache.js';

interface RecordedUpstreamCall {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: {
    model?: string;
    temperature?: number;
    max_tokens?: number;
    messages?: Array<{ role: string; content: string }>;
  };
}

describe('Support Setup Copilot — Human-Like LLM Coach & Resilient Gateway Bridge', () => {
  let gatewayServer: Server;
  let gatewayPort: number;
  let mockUpstreamServer: Server;
  let mockUpstreamPort: number;

  const upstreamCalls: RecordedUpstreamCall[] = [];
  let nextUpstreamReplies: Array<{
    status?: number;
    content?: string;
    model?: string;
  }> = [];

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = 'c'.repeat(64);
    initDb(':memory:');

    // Local mock OpenAI-compatible upstream LLM server
    mockUpstreamServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsedBody: RecordedUpstreamCall['body'] = {};
        try {
          parsedBody = JSON.parse(raw) as RecordedUpstreamCall['body'];
        } catch {
          parsedBody = {};
        }
        upstreamCalls.push({
          path: req.url ?? '',
          headers: req.headers,
          body: parsedBody,
        });

        const scripted = nextUpstreamReplies.shift() ?? {
          status: 200,
          model: parsedBody.model || 'mock-human-coach-v1',
          content: JSON.stringify({
            intent: 'gather_requirements',
            reply:
              'Ồ bạn đang làm web boardgame thú vị quá! Với mảng boardgame, khách thường hay hỏi gợi ý trò chơi theo nhóm mấy người, luật chơi tóm tắt hoặc phí ship/thuê bộ game. Mình có thể lên bản nháp 7 bước chuẩn cho shop boardgame ngay bây giờ, hoặc bạn cho mình biết thêm tên web và chính sách đổi trả/ship để mình cá nhân hóa sát hơn nhé!',
            missingQuestions: ['Tên shop/website boardgame và chính sách giao hàng hoặc đổi trả'],
            suggestedQuickReplies: [
              'Lên bản mẫu cho web boardgame luôn giúp mình',
              'Shop mình tên BoardgameVN, freeship đơn từ 500k, đổi trả 3 ngày nếu thiếu chi tiết',
              'Tư vấn giúp mình cách nạp luật chơi & FAQ hiệu quả',
            ],
            extractedRequirements: {
              industry: 'Boardgame & Trò chơi bàn',
            },
          }),
        };

        const status = scripted.status ?? 200;
        if (status >= 400) {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `Mock upstream HTTP ${status}` } }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: `chatcmpl_mock_${upstreamCalls.length}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: scripted.model ?? parsedBody.model ?? 'mock-human-coach-v1',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: scripted.content ?? '',
                },
                finish_reason: 'stop',
              },
            ],
            usage: {
              prompt_tokens: 180,
              completion_tokens: 95,
              total_tokens: 275,
            },
          }),
        );
      });
    });

    mockUpstreamServer.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => mockUpstreamServer.once('listening', () => resolve()));
    mockUpstreamPort = (mockUpstreamServer.address() as { port: number }).port;

    // Start FreeLLMAPI Express app with strict ALLOWED_HOSTS simulating SnapDeploy production
    const cfg = {
      ...loadConfig(),
      allowedHosts: ['freellmapi-1d80d.containers.snapdeploy.app'],
    };
    const app = createApp(cfg);
    gatewayServer = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => gatewayServer.once('listening', () => resolve()));
    gatewayPort = (gatewayServer.address() as { port: number }).port;

    // Seed recorded server local address as Express middleware does on inbound requests
    recordServerLocalAddress({
      socket: { localAddress: '::ffff:127.0.0.1', localPort: gatewayPort },
    } as any);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => gatewayServer.close(() => resolve()));
    await new Promise<void>((resolve) => mockUpstreamServer.close(() => resolve()));
  });

  beforeEach(() => {
    upstreamCalls.length = 0;
    nextUpstreamReplies = [];
    const db = getDb();
    db.prepare('DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE platform = ?)').run(
      'custom',
    );
    db.prepare('DELETE FROM profile_models').run();
    db.prepare('DELETE FROM profiles').run();
    db.prepare("DELETE FROM settings WHERE key = 'active_profile_id'").run();
    db.prepare('DELETE FROM models WHERE platform = ?').run('custom');
    db.prepare('DELETE FROM api_keys').run();
    try {
      db.prepare('DELETE FROM x_gateway_keys').run();
    } catch {
      // Optional table depending on migration state
    }
    setXGatewayEnabled(false);
    invalidateKeyCache();
    invalidateXGatewayKeyCache();
    invalidateConfigCache();
  });

  it('fast-fails cleanly in :memory: DB when no Thruline or main-gateway routes are configured', async () => {
    expect(hasConfiguredMainGatewayRoutes()).toBe(false);

    const started = Date.now();
    const res = await runHumanLikeLlmCoach({
      messages: [{ role: 'user', content: 'tôi đang có web boardgame, và muốn setup' }],
      locale: 'vi',
      targetMode: 'create_tenant',
      diagnostic: null,
      extracted: {},
      gatewayLoopback: { host: '127.0.0.1', port: gatewayPort },
    });
    const elapsedMs = Date.now() - started;

    expect(res).toBeNull();
    expect(elapsedMs).toBeLessThan(200);
    expect(upstreamCalls).toHaveLength(0);
  });

  it('reaches main FreeLLMAPI /v1/chat/completions via api_keys (including keyless sentinel rows & SnapDeploy bridge IPs under ALLOWED_HOSTS)', async () => {
    const db = getDb();
    // Insert a keyless sentinel ('no-key') custom endpoint row into `api_keys` (the REAL table, not `keys`!)
    const enc = encrypt('no-key');
    const baseUrl = `http://127.0.0.1:${mockUpstreamPort}/v1`;
    const keyInfo = db
      .prepare(
        `INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
         VALUES ('custom', 'Local Keyless Mock', ?, ?, ?, 'healthy', 1, ?)`,
      )
      .run(enc.encrypted, enc.iv, enc.authTag, baseUrl);
    const keyId = Number(keyInfo.lastInsertRowid);

    const modelInfo = db
      .prepare(
        `INSERT INTO models (
           platform, model_id, display_name, intelligence_rank, speed_rank,
           size_label, monthly_token_budget, supports_vision, supports_tools,
           context_window, enabled, key_id, endpoint_scope
         ) VALUES ('custom', 'mock-coach-boardgame', 'Mock Coach', 90, 90, '70B', 'unlimited', 0, 1, 64000, 1, ?, ?)`,
      )
      .run(keyId, baseUrl);
    const modelDbId = Number(modelInfo.lastInsertRowid);

    db.prepare(
      'INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)',
    ).run(modelDbId);
    invalidateKeyCache();

    expect(hasConfiguredMainGatewayRoutes()).toBe(true);

    // Simulate Docker / SnapDeploy container bridge localAddress (`::ffff:172.17.0.5`)
    // AND omit gatewayLoopback on a second call to verify getRecordedServerAddress() fallback!
    const norm = normalizeLoopbackTarget({ host: '::ffff:172.17.0.5', port: gatewayPort });
    expect(norm?.primaryUrl).toBe(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`);
    expect(norm?.fallbackUrl).toBe(`http://172.17.0.5:${gatewayPort}/v1/chat/completions`);

    const coachRes = await runHumanLikeLlmCoach({
      messages: [{ role: 'user', content: 'tôi đang có web boardgame, và muốn setup' }],
      locale: 'vi',
      targetMode: 'create_tenant',
      diagnostic: null,
      extracted: {},
      gatewayLoopback: { host: '::ffff:172.17.0.5', port: gatewayPort },
    });

    expect(coachRes).not.toBeNull();
    expect(coachRes?.routeSource).toBe('main_gateway_loopback');
    expect(coachRes?.modelUsed).toContain('mock-coach-boardgame');
    expect(coachRes?.output.intent).toBe('gather_requirements');
    expect(coachRes?.output.reply).toContain('boardgame');
    expect(coachRes?.output.reply).not.toMatch(/1\.\s*Lĩnh vực/);
    expect(coachRes?.output.extractedRequirements?.industry).toBe('Boardgame & Trò chơi bàn');
    expect(coachRes?.output.suggestedQuickReplies?.some((q) => /boardgame/i.test(q))).toBe(true);

    // Verify system prompt sent to upstream contains empathetic Vietnamese persona & anti-form rules
    expect(upstreamCalls).toHaveLength(1);
    const systemMsg = upstreamCalls[0]?.body.messages?.find((m) => m.role === 'system')?.content ?? '';
    expect(systemMsg).toContain('mình – bạn');
    expect(systemMsg).toContain('CẤM TUYỆT ĐỐI kiểu máy móc / đổ form đánh số');
    expect(systemMsg).toContain('web boardgame');
  });

  it('automatically fails over from model="auto" to model="auto:balanced" when active routing profile chain is empty', async () => {
    const db = getDb();
    const enc = encrypt('sk-test-custom-key');
    const baseUrl = `http://127.0.0.1:${mockUpstreamPort}/v1`;
    const keyId = Number(
      db
        .prepare(
          `INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
           VALUES ('custom', 'Catalog Key', ?, ?, ?, 'healthy', 1, ?)`,
        )
        .run(enc.encrypted, enc.iv, enc.authTag, baseUrl).lastInsertRowid,
    );
    const modelDbId = Number(
      db
        .prepare(
          `INSERT INTO models (
             platform, model_id, display_name, intelligence_rank, speed_rank,
             size_label, monthly_token_budget, supports_vision, supports_tools,
             context_window, enabled, key_id, endpoint_scope
           ) VALUES ('custom', 'mock-global-fallback', 'Mock Global', 85, 85, '70B', 'unlimited', 0, 1, 64000, 1, ?, ?)`,
        )
        .run(keyId, baseUrl).lastInsertRowid,
    );
    db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)').run(modelDbId);

    // Create an EMPTY active routing profile so `model: "auto"` throws 400 ("has no enabled models")
    const emptyProfileId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('empty-chain')").run().lastInsertRowid,
    );
    setSetting('active_profile_id', String(emptyProfileId));
    invalidateKeyCache();

    const coachRes = await runHumanLikeLlmCoach({
      messages: [{ role: 'user', content: 'bạn có thể làm gì mà' }],
      locale: 'vi',
      targetMode: 'create_tenant',
      diagnostic: null,
      extracted: {},
      // Also omit gatewayLoopback to verify getRecordedServerAddress() fallback works!
    });

    expect(coachRes).not.toBeNull();
    expect(coachRes?.routeSource).toBe('main_gateway_loopback');
    expect(coachRes?.modelUsed).toContain('mock-global-fallback');
    expect(upstreamCalls).toHaveLength(1);
  });

  it('reaches Thruline x_gateway_keys (provider_accounts) directly even when public /thruline/v1 toggle is disabled', async () => {
    const db = getDb();
    // Explicitly keep X-Gateway public endpoint toggle OFF
    setXGatewayEnabled(false);

    const enc = encrypt('sk-thruline-account');
    db.prepare(
      `INSERT INTO x_gateway_keys (
         provider, label, auth_method, encrypted_key, iv, auth_tag,
         base_url, models_json, status, enabled, monthly_request_cap, monthly_token_cap
       ) VALUES (?, ?, 'api_key', ?, ?, ?, ?, ?, 'healthy', 1, 0, 0)`,
    ).run(
      'openrouter',
      'Thruline Primary Account',
      enc.encrypted,
      enc.iv,
      enc.authTag,
      `http://127.0.0.1:${mockUpstreamPort}/v1`,
      JSON.stringify([{ id: 'thruline-human-coach', name: 'Thruline Coach' }]),
    );
    invalidateXGatewayKeyCache();

    nextUpstreamReplies.push({
      status: 200,
      model: 'thruline-human-coach',
      content: JSON.stringify({
        intent: 'guide',
        reply:
          'Mình hiểu cảm giác đó — xin lỗi bạn nếu câu trước hơi khô khan nhé! Mình có thể tư vấn tự nhiên theo đúng mô hình web boardgame của bạn hoặc soạn sẵn bản nháp 7 bước để bạn xem và bấm duyệt ngay.',
        suggestedQuickReplies: ['Lên bản nháp cho web boardgame luôn đi', 'Giải thích ngắn gọn các bước trước'],
      }),
    });

    const res = await runHumanLikeLlmCoach({
      messages: [{ role: 'user', content: 'sao cứng nhắc thế, tư vấn cho mình đi' }],
      locale: 'vi',
      targetMode: 'create_tenant',
      diagnostic: null,
      extracted: { industry: 'Boardgame & Trò chơi bàn' },
    });

    expect(res).not.toBeNull();
    expect(res?.routeSource).toBe('thruline_account');
    expect(res?.modelUsed).toContain('thruline-human-coach');
    expect(res?.output.intent).toBe('guide');
    expect(res?.output.reply).toContain('web boardgame');
  });

  it('detects repetitive assistant replies and retries with cache bypass to guarantee fresh responses', async () => {
    const priorAssistant =
      'Mình đang chuẩn bị cấu hình cho tenant EXE. Để bản kế hoạch hoàn chỉnh hơn, bạn bổ sung giúp mình thêm lĩnh vực kinh doanh và chính sách chính nhé!';

    expect(
      isRepetitiveAssistantReply(priorAssistant, [{ role: 'assistant', content: priorAssistant }]),
    ).toBe(true);
    expect(
      isRepetitiveAssistantReply(
        'Mình đang chuẩn bị cấu hình cho tenant EXE! Để bản kế hoạch hoàn chỉnh hơn, bạn bổ sung giúp mình thêm lĩnh vực kinh doanh và chính sách nhé.',
        [{ role: 'assistant', content: priorAssistant }],
      ),
    ).toBe(true);
    expect(
      isRepetitiveAssistantReply(
        'Dạ mình có thể soạn trọn bộ cấu hình AI tư vấn luật chơi, gợi ý boardgame theo nhóm bạn và tự động tạo ticket đổi trả cho bạn duyệt ngay ạ!',
        [{ role: 'assistant', content: priorAssistant }],
      ),
    ).toBe(false);

    // Attempt 1 returns a lazy duplicate of priorAssistant; Attempt 2 returns a fresh human response
    nextUpstreamReplies.push(
      {
        status: 200,
        content: JSON.stringify({
          intent: 'gather_requirements',
          reply: priorAssistant,
        }),
      },
      {
        status: 200,
        content: JSON.stringify({
          intent: 'guide',
          reply:
            'Dạ với web boardgame của bạn, mình có thể tự thiết kế nhân cách AI am hiểu boardgame, tạo sẵn bộ FAQ luật chơi/đổi trả, bật che SĐT khách hàng và làm nút chat đẹp mắt trên web — tất cả đều trình bạn xem và bấm Đồng ý rồi mới chạy nhé!',
          suggestedQuickReplies: ['Lên bản mẫu cho web boardgame luôn đi'],
        }),
      },
    );

    const res = await runHumanLikeLlmCoach({
      messages: [
        { role: 'user', content: 'tôi đang có web boardgame, và muốn setup' },
        { role: 'assistant', content: priorAssistant },
        { role: 'user', content: 'bạn có thể làm gì mà' },
      ],
      locale: 'vi',
      targetMode: 'update_tenant',
      diagnostic: null,
      extracted: { industry: 'Boardgame' },
      // Point directly at standalone mock server port (exercises standalone mock loopback detection)
      gatewayLoopback: { host: '127.0.0.1', port: mockUpstreamPort },
    });

    expect(res).not.toBeNull();
    expect(upstreamCalls).toHaveLength(2);
    expect(upstreamCalls[1]?.headers['cache-control']).toBe('no-cache');
    expect(res?.output.intent).toBe('guide');
    expect(res?.output.reply).not.toBe(priorAssistant);
    expect(res?.output.reply).toContain('boardgame');
  });

  it('parses <think> reasoning blocks, prose-wrapped JSON with inline braces, trailing commas, and scrubs placeholder values', () => {
    const withReasoningAndBraces = [
      '<think>The user mentioned {boardgame} and wants setup. Schema has {"intent":"..."}.</think>',
      'Dưới đây là phản hồi dành cho bạn (ví dụ biến `{customer_name}`):',
      '```json',
      '{',
      '  "intent": "gather_requirements",',
      '  "reply": "Web boardgame hay quá bạn ơi! Bạn muốn mình lên bản nháp luôn hay chia sẻ thêm tên shop trước nhé?",',
      '  "suggestedQuickReplies": ["1. Lên bản nháp luôn giúp mình", "2. Tên shop là MeepleHouse"],',
      '  "extractedRequirements": {',
      '    "brandName": "...",',
      '    "industry": "Boardgame & Tabletop",',
      '    "primaryColor": "unknown",',
      '    "tone": "friendly",',
      '  },',
      '}',
      '```',
    ].join('\n');

    const parsed = parseLlmCoachResponse(withReasoningAndBraces);
    expect(parsed).not.toBeNull();
    expect(parsed?.intent).toBe('gather_requirements');
    expect(parsed?.reply).toContain('Web boardgame hay quá');
    expect(parsed?.suggestedQuickReplies).toEqual([
      'Lên bản nháp luôn giúp mình',
      'Tên shop là MeepleHouse',
    ]);
    // Placeholder "..." and "unknown" MUST be scrubbed so they never overwrite extracted requirements!
    expect(parsed?.extractedRequirements).toEqual({
      industry: 'Boardgame & Tabletop',
      tone: 'friendly',
    });

    // Truncated unclosed <think> returns null
    expect(parseLlmCoachResponse('<think>Still thinking without closing')).toBeNull();
    // Broken truncated JSON returns null instead of leaking raw braces to UI
    expect(parseLlmCoachResponse('{"intent":"guide","reply":"Đang viết dở')).toBeNull();
    // Plain natural prose without JSON is preserved cleanly
    const plain = parseLlmCoachResponse(
      'Chào bạn! Mình rất sẵn lòng đồng hành cùng bạn thiết lập trợ lý cho web boardgame nhé.',
    );
    expect(plain?.reply).toContain('web boardgame');
  });

  it('enforces consent security invariants and locale/persona prompt rules', () => {
    // False claim of immediate DB mutation gets an explicit safety clarification appended
    const unsafeReply = enforceReplySecurityInvariant(
      'Mình đã lưu thành công toàn bộ cấu hình 7 bước vào hệ thống cho shop của bạn rồi nhé!',
      'vi',
    );
    expect(unsafeReply).toContain('chưa tự ý ghi thay đổi nào vào hệ thống');

    // Truthful consent-aware reply is untouched
    const safeReply = enforceReplySecurityInvariant(
      'Mình đã soạn bản đề xuất bên dưới, hiện chưa thay đổi gì cho đến khi bạn bấm Đồng ý triển khai nhé!',
      'vi',
    );
    expect(safeReply).not.toContain('Lưu ý:');

    // Vietnamese locale check accepts both accented and natural unaccented Vietnamese, rejects pure English
    expect(matchesRequestedLocale('Chào bạn, mình hỗ trợ ngay nhé!', 'vi')).toBe(true);
    expect(matchesRequestedLocale('Chao ban, minh giup ban thiet lap ke hoach nhe', 'vi')).toBe(true);
    expect(matchesRequestedLocale('Hello! Please share your company name and policies.', 'vi')).toBe(false);

    // Read-only RBAC prompt includes read-only guard & anti-repetition history
    const promptEn = buildHumanCoachSystemPrompt({
      messages: [
        { role: 'assistant', content: 'Hi! Tell me about your store.' },
        { role: 'user', content: 'Can you set this up for my bakery?' },
      ],
      locale: 'en',
      targetMode: 'update_tenant',
      diagnostic: null,
      extracted: { industry: 'Bakery' },
      canCreateTenant: false,
      canEditSteps: new Set(),
    });
    expect(promptEn).toContain('READ-ONLY SCOPE');
    expect(promptEn).toContain('[Prior reply #1]: "Hi! Tell me about your store."');
    expect(promptEn).toContain('STRICT ANTI-FORM RULE');
  });

  it('fails over from model="auto" (HTTP 503 no_providers_configured) to model="auto:balanced" when Default profile contains only unkeyed built-in models while a custom model is enabled outside profile_models', async () => {
    const db = getDb();
    const enc = encrypt('no-key');
    const baseUrl = `http://127.0.0.1:${mockUpstreamPort}/v1`;
    const keyId = Number(
      db
        .prepare(
          `INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
           VALUES ('custom', 'Outside-Profile Custom Endpoint', ?, ?, ?, 'healthy', 1, ?)`,
        )
        .run(enc.encrypted, enc.iv, enc.authTag, baseUrl).lastInsertRowid,
    );
    const customModelDbId = Number(
      db
        .prepare(
          `INSERT INTO models (
             platform, model_id, display_name, intelligence_rank, speed_rank,
             size_label, monthly_token_budget, supports_vision, supports_tools,
             context_window, enabled, key_id, endpoint_scope
           ) VALUES ('custom', 'outside-profile-coach', 'Outside Profile Coach', 95, 95, '70B', 'unlimited', 0, 1, 64000, 1, ?, ?)`,
        )
        .run(keyId, baseUrl).lastInsertRowid,
    );
    db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)').run(
      customModelDbId,
    );

    // Seed Default profile pointing ONLY at an unkeyed built-in catalog model (so `model: "auto"` hits 503!)
    const seededBuiltin = db
      .prepare("SELECT id FROM models WHERE platform != 'custom' AND enabled = 1 LIMIT 1")
      .get() as { id: number };
    const defaultProfileId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('Default')").run().lastInsertRowid,
    );
    db.prepare(
      'INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, 1, 1)',
    ).run(defaultProfileId, seededBuiltin.id);
    setSetting('active_profile_id', String(defaultProfileId));
    invalidateKeyCache();

    const coachRes = await runHumanLikeLlmCoach({
      messages: [{ role: 'user', content: 'tôi đang có web boardgame, và muốn setup' }],
      locale: 'vi',
      targetMode: 'update_tenant',
      diagnostic: null,
      extracted: {},
      gatewayLoopback: { host: '127.0.0.1', port: gatewayPort },
    });

    expect(coachRes).not.toBeNull();
    expect(coachRes?.routeSource).toBe('main_gateway_loopback');
    expect(coachRes?.modelUsed).toContain('outside-profile-coach');
    expect(upstreamCalls).toHaveLength(1);
  });

  it('fails over from model="auto" to model="auto:balanced" when the "auto" loopback call times out', async () => {
    // Regression test for the live Setup Copilot failure "FreeLLMAPI auto: quá
    // 15 giây chưa trả lời": a slow first 'auto' candidate used to end the
    // whole turn because the Tier 2 catch returned null instead of trying the
    // next model. A fake fetch keeps this deterministic: the first call throws
    // like an aborted loopback request, the second answers normally.
    // A mock cloud lease (same pattern as support-copilot-model-source.test.ts)
    // is installed just for this test so it can run without a real activation
    // token; the other tests in this file keep relying on the real lease.
    process.env.FREEAPI_AI_ACTIVATION_TOKEN = ['test', 'fake', 'token'].join('-');
    const mockLease: CloudSignedLease = {
      licenseId: 'test-lic-coach-timeout', label: 'Test License', instanceId: 'test-inst-coach-timeout',
      scopes: ['ai_platform', 'customer_ai', 'support_copilot', 'support_suite', 'tenant_portal'],
      packVersion: 4, packHash: 'hash-coach-timeout',
      issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    };
    const mockPack: CloudAiRuntimePack = {
      version: 4,
      supportCoachPack: { personaVi: 'Persona Vi', personaEn: 'Persona En', playbookReference: 'Playbook', outputContract: 'Contract' },
      supportAgentCopilotInstruction: 'x', customerAiDirective: 'ACTIVE', supportGatewayDirective: 'ACTIVE', aiPlatformCapabilityGrant: 'ACTIVE',
    };
    configureCloudEntitlementForTesting({
      activeLeaseRecord: { lease: mockLease, tokenHash: 'dummy-hash', signature: 'dummy-sig', runtimePack: mockPack, verifiedAtMs: Date.now() },
    });
    try {
      const seenModels: Array<string | undefined> = [];
      const coachJson = JSON.stringify({
        intent: 'guide',
        reply:
          'Chào bạn! Mình hiểu rồi, để mình hướng dẫn bạn tạo tenant AI Support mới nhé. Trước tiên bạn cho mình biết tên shop và ngành hàng của bạn được không?',
      });
      let calls = 0;
      const fetchImpl = (async (_input: unknown, init?: { body?: unknown }) => {
        calls += 1;
        let model: string | undefined;
        try {
          model = (JSON.parse(String((init?.body as string) ?? '{}')) as { model?: string }).model;
        } catch {
          model = undefined;
        }
        seenModels.push(model);
        if (calls === 1) {
          throw Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' });
        }
        return new Response(
          JSON.stringify({
            id: 'chatcmpl_mock_timeout_failover',
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: 'mock-balanced-coach',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: coachJson },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 120, completion_tokens: 60, total_tokens: 180 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as unknown as typeof fetch;

      const coachRes = await runHumanLikeLlmCoach({
        messages: [{ role: 'user', content: 'tôi đang có web boardgame, và muốn setup' }],
        locale: 'vi',
        targetMode: 'create_tenant',
        diagnostic: null,
        extracted: {},
        gatewayLoopback: { host: '127.0.0.1', port: gatewayPort },
        fetchImpl,
        timeoutMs: 5_000,
      });

      expect(calls).toBe(2);
      expect(seenModels).toEqual(['auto', 'auto:balanced']);
      expect(coachRes).not.toBeNull();
      expect(coachRes?.routeSource).toBe('main_gateway_loopback');
      expect(coachRes?.modelUsed).toBe('mock-balanced-coach');
      expect(coachRes?.output.intent).toBe('guide');
    } finally {
      configureCloudEntitlementForTesting(null);
      delete process.env.FREEAPI_AI_ACTIVATION_TOKEN;
    }
  });
});

describe('live reasoning preview while the model streams (extractPartialCoachReply / extractLiveReasoning)', () => {
  it('reads the reply value out of a partially streamed JSON object', () => {
    expect(extractPartialCoachReply('{"intent":"guide","reply":"Cache giúp giảm')).toBe('Cache giúp giảm');
    expect(extractPartialCoachReply('{"reply":"a\\"b\\n c')).toBe('a"b\n c');
    expect(extractPartialCoachReply('{"reply":"abc\\')).toBe('abc');
    expect(extractPartialCoachReply('{"intent":"guide"')).toBe('');
    expect(extractPartialCoachReply('')).toBe('');
  });

  it('shows the thinking, then the forming reply underneath it', () => {
    expect(extractLiveReasoning('{"reply":"x"}', 'Người dùng hỏi về cache')).toBe('Người dùng hỏi về cache\n\nx');
    expect(extractLiveReasoning('<think>cần tra KB trước</think>{"intent":"guide"}', '')).toBe('cần tra KB trước');
    expect(extractLiveReasoning('<think>cần tra KB trước</think>{"intent":"guide","reply":"ok"}', '')).toBe('cần tra KB trước\n\nok');
    expect(extractLiveReasoning('<think>đang nghĩ dở', '')).toBe('đang nghĩ dở');
    expect(extractLiveReasoning('{"intent":"guide","reply":"Cache giúp', '')).toBe('Cache giúp');
    expect(extractLiveReasoning('{"intent":"guide"', '')).toBe('{"intent":"guide"');
  });
});
