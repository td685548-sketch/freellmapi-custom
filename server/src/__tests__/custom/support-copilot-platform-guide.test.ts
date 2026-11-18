import http, { type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { recordServerLocalAddress } from '../../custom/ai-platform/orchestrator/engine.js';
import {
  classifyHumanConversationalAct,
  extractOpenDomainTopic,
} from '../../custom/support-setup-copilot/human-dialogue.js';
import { buildHumanCoachSystemPrompt } from '../../custom/support-setup-copilot/llm-coach.js';
import { extractRequirementsFromMessages } from '../../custom/support-setup-copilot/playbook.js';
import {
  buildPlatformExpertReply,
  describePlatformRoute,
  matchPlatformKnowledgeQuestion,
  PLATFORM_EXPERT_KNOWLEDGE,
} from '../../custom/support-setup-copilot/platform-guide.js';
import { createSupportTenant } from '../../custom/x-gateway/support-store.js';
import { getDb, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { createSession, createUser } from '../../services/auth.js';
import { invalidateKeyCache } from '../../services/key-cache.js';
import { setUserPermissions } from '../../services/users.js';

function assertFluentHumanReply(reply: string) {
  expect(reply.trim().length).toBeGreaterThan(60);
  // Never dump stiff numbered intake questionnaires
  expect(reply).not.toMatch(/(?:^|\n)\s*1[.)]\s+.+\n\s*2[.)]\s+/m);
  expect(reply).not.toContain('Lĩnh vực kinh doanh / sản phẩm chính của bạn');
  // Balanced Markdown bold markers
  const boldMarkers = (reply.match(/\*\*/g) ?? []).length;
  expect(boldMarkers % 2).toBe(0);
}

describe('AI Support Setup Copilot — Platform & Current-Page Expertise', () => {
  let server: Server;
  let base: string;
  let mockUpstream: Server;
  let mockUpstreamPort: number;
  let lastUpstreamSystemPrompt = '';
  let nextMockLlmJson: Record<string, unknown> | null = null;

  let adminToken: string;
  let viewerToken: string;
  let thrulineReadOnlyToken: string;
  let tenantId: number;

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
      body: (await res.json().catch(() => null)) as Record<string, any> | null,
    };
  }

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = 'd'.repeat(64);
    initDb(':memory:');

    mockUpstream = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            messages?: Array<{ role: string; content: string }>;
          };
          lastUpstreamSystemPrompt =
            parsed.messages?.find((m) => m.role === 'system')?.content ?? '';
        } catch {
          lastUpstreamSystemPrompt = '';
        }
        const payload = nextMockLlmJson ?? {
          intent: 'guide',
          reply:
            'Mình giải thích nhanh về **Providers (`/thruline/providers`)** bạn đang mở nhé: đây là nơi kết nối tài khoản OAuth và API key của các hãng AI để cấp nguồn xoay vòng tự động cho FreeLLMAPI & Thruline!',
          missingQuestions: [],
          suggestedQuickReplies: [
            'Combo dùng để làm gì?',
            'Mình muốn dựng trợ lý AI Support cho web/shop',
          ],
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl_platform_expert',
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: 'mock-platform-specialist',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: JSON.stringify(payload) },
                finish_reason: 'stop',
              },
            ],
          }),
        );
      });
    });
    mockUpstream.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => mockUpstream.once('listening', () => resolve()));
    mockUpstreamPort = (mockUpstream.address() as { port: number }).port;

    const app = createApp();
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const { port } = server.address() as { port: number };
    base = `http://127.0.0.1:${port}`;
    recordServerLocalAddress({
      socket: { localAddress: '127.0.0.1', localPort: port },
    } as any);

    const admin = createUser('platform-admin@example.com', 'AdminPass123!');
    adminToken = createSession(admin.userId);

    tenantId = createSupportTenant({
      name: 'EXE',
      slug: 'exe',
      defaultModel: 'auto',
      systemPrompt: 'EXE support prompt ready for visitors.',
      createdBy: admin.userId,
    }).tenant.id;

    const viewer = createUser('platform-viewer@example.com', 'UserPass123!', 'member');
    viewerToken = createSession(viewer.userId);
    const assignRes = await hit(
      `/api/admin/tenant-memberships/tenants/${tenantId}/users/${viewer.userId}`,
      'PUT',
      { rolePreset: 'viewer' },
      adminToken,
    );
    expect(assignRes.status).toBe(200);

    const thrulineViewer = createUser('thruline-viewer@example.com', 'UserPass123!', 'member');
    setUserPermissions(thrulineViewer.userId, ['use_x_gateway'], admin.userId);
    thrulineReadOnlyToken = createSession(thrulineViewer.userId);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => mockUpstream.close(() => resolve()));
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM auth_request_limits').run();
  });

  it('answers holistic website & platform questions ("web này làm gì?", unaccented "web nay dung de lam gi", "Thruline dùng để làm gì", English) fluently across locales', async () => {
    // 1. Accented & unaccented Vietnamese under BOTH 'vi' and 'en' UI locales
    for (const uiLocale of ['vi', 'en'] as const) {
      for (const question of [
        'web này làm gì?',
        'web nay dung de lam gi',
        'day la web gi vay',
        'trang web này là gì',
        'hệ thống này là gì',
        'FreeLLMAPI là gì?',
        'Thruline dùng để làm gì?',
        'thruline la cai gi vay',
        'thruline hoat dong the nao',
      ]) {
        const res = await hit(
          '/api/support-setup-copilot/chat',
          'POST',
          {
            tenantId,
            locale: uiLocale,
            currentPath: '/thruline/providers',
            messages: [{ role: 'user', content: question }],
          },
          adminToken,
        );
        expect(res.status).toBe(200);
        expect(res.body?.intent).toBe('guide');
        expect(res.body?.proposal).toBeNull();
        expect(res.body?.replyLocale).toBe('vi');
        const reply = String(res.body?.reply ?? '');
        assertFluentHumanReply(reply);
        expect(reply).toMatch(/FreeLLMAPI/i);
        expect(reply).toMatch(/Thruline/i);
        expect(reply).toMatch(/Tenant AI Portal|\/tenant-portal/i);
        expect(reply).toMatch(/AI Hub|\/assistants/i);
        expect(reply).toMatch(/Support/i);
      }
    }

    // 2. English platform questions (even when UI locale defaults to 'vi')
    for (const enQuestion of [
      'what does this website do?',
      'what is freellmapi?',
      'what does Thruline do?',
    ]) {
      const res = await hit(
        '/api/support-setup-copilot/chat',
        'POST',
        {
          tenantId,
          locale: 'vi',
          currentPath: '/thruline/home',
          messages: [{ role: 'user', content: enQuestion }],
        },
        adminToken,
      );
      expect(res.status).toBe(200);
      expect(res.body?.intent).toBe('guide');
      expect(res.body?.proposal).toBeNull();
      expect(res.body?.replyLocale).toBe('en');
      const reply = String(res.body?.reply ?? '');
      assertFluentHumanReply(reply);
      expect(reply).toMatch(/FreeLLMAPI/i);
      expect(reply).toMatch(/Thruline/i);
      expect(reply).toMatch(/Tenant AI Portal/i);
      expect(reply).toMatch(/Personal AI Hub|\/assistants/i);
    }

    // 3. Anti-repetition across consecutive platform overview questions
    const match = matchPlatformKnowledgeQuestion('web này làm gì?', '/thruline/home')!;
    expect(match.kind).toBe('platform_overview');
    const first = buildPlatformExpertReply({ match, locale: 'vi', currentPath: '/thruline/home' });
    const second = buildPlatformExpertReply({
      match,
      locale: 'vi',
      currentPath: '/thruline/home',
      priorAssistantMessages: [first.reply],
    });
    expect(second.reply).not.toBe(first.reply);
  });

  it('explains the exact current page accurately via currentPath ("trang này dùng để làm gì?", "what is this page for?")', async () => {
    const routeCases: Array<{
      path: string;
      question: string;
      locale: 'vi' | 'en';
      expectedPattern: RegExp;
    }> = [
      {
        path: '/thruline/providers',
        question: 'trang này dùng để làm gì?',
        locale: 'vi',
        expectedPattern: /Providers|OAuth|xoay vòng/i,
      },
      {
        path: '/thruline/combos',
        question: 'trang nay dung de lam gi',
        locale: 'en',
        expectedPattern: /Combos|dự phòng|failover|model ảo/i,
      },
      {
        path: '/thruline/token-savers',
        question: 'mục này dùng sao?',
        locale: 'vi',
        expectedPattern: /Token Savers|Agentic Token Compactor|Cache/i,
      },
      {
        path: '/thruline/savers',
        question: 'what is this page for?',
        locale: 'en',
        expectedPattern: /Token Savers|Agentic Token Compactor/i,
      },
      {
        path: '/thruline/cli-tools',
        question: 'màn hình này dùng sao?',
        locale: 'vi',
        expectedPattern: /CLI Tools|Claude Code|Cursor|Codex/i,
      },
      {
        path: '/thruline/skills',
        question: 'what is this screen for?',
        locale: 'en',
        expectedPattern: /Skills Hub|SKILL\.md/i,
      },
      {
        path: '/thruline/translator',
        question: 'trang này làm gì?',
        locale: 'vi',
        expectedPattern: /Protocol Translator|OpenAI|Anthropic|Gemini/i,
      },
      {
        path: '/thruline/quota',
        question: 'trang này để làm gì?',
        locale: 'vi',
        expectedPattern: /Quota|cooldown|rate-limit/i,
      },
      {
        path: '/thruline/support-guardrails',
        question: 'mục này để làm gì?',
        locale: 'vi',
        expectedPattern: /Guardrails|Prompt Injection|quota/i,
      },
      {
        path: '/tenant-portal',
        question: 'trang này dùng để làm gì?',
        locale: 'vi',
        expectedPattern: /Tenant AI Portal|RBAC|Service Desk/i,
      },
      {
        path: '/assistants',
        question: 'trang này dùng để làm gì?',
        locale: 'vi',
        expectedPattern: /AI Hub|Coding|Eco|Balanced|Max/i,
      },
      {
        path: '/thruline/providers',
        question: 'day la trang gi',
        locale: 'en',
        expectedPattern: /Providers|OAuth|xoay vòng/i,
      },
      {
        path: '/thruline/combos',
        question: 'chỗ này là gì?',
        locale: 'vi',
        expectedPattern: /Combos|dự phòng|model ảo/i,
      },
      {
        path: '/thruline/savers',
        question: 'chỗ này dùng để làm gì?',
        locale: 'vi',
        expectedPattern: /Token Savers|Agentic Token Compactor/i,
      },
    ];

    for (const tc of routeCases) {
      const desc = describePlatformRoute(tc.path, tc.locale);
      expect(desc).not.toBeNull();

      const res = await hit(
        '/api/support-setup-copilot/chat',
        'POST',
        {
          tenantId,
          locale: tc.locale,
          currentPath: tc.path,
          messages: [{ role: 'user', content: tc.question }],
        },
        adminToken,
      );
      expect(res.status).toBe(200);
      expect(res.body?.intent).toBe('guide');
      expect(res.body?.proposal).toBeNull();
      if (tc.question === 'day la trang gi') {
        expect(res.body?.replyLocale).toBe('vi');
      }
      const reply = String(res.body?.reply ?? '');
      assertFluentHumanReply(reply);
      expect(reply).toMatch(tc.expectedPattern);
    }

    // Practical how-to & workspace comparison questions (both VI & EN)
    const howToCases: Array<[string, RegExp]> = [
      ['làm sao lấy api key?', /\/thruline\/providers|\/thruline\/endpoint|pk_sup_/i],
      ['combo dùng để làm gì?', /\/thruline\/combos|Combo/i],
      ['how do I create model combos?', /\/thruline\/combos|Combo/i],
      ['khác nhau giữa thruline và tenant portal?', /Thruline[\s\S]*Tenant AI Portal/i],
      ['what is the difference between Thruline and Tenant Portal?', /Thruline[\s\S]*Tenant AI Portal/i],
      ['how to add provider keys?', /\/thruline\/providers|OAuth/i],
      ['token savers là gì?', /Token Savers|Agentic Token Compactor/i],
      ['cli tools là gì?', /CLI Tools|Claude Code|Cursor/i],
      ['kết nối claude code kiểu gì?', /CLI Tools|Claude Code|Cursor/i],
      ['kết nối cursor thế nào?', /CLI Tools|Claude Code|Cursor/i],
      ['cấu hình codex ở đâu?', /CLI Tools|Claude Code|Codex/i],
      ['protocol translator dùng để làm gì?', /Protocol Translator|OpenAI|Gemini/i],
    ];

    for (const [q, pat] of howToCases) {
      const res = await hit(
        '/api/support-setup-copilot/chat',
        'POST',
        {
          tenantId,
          currentPath: '/tenant-portal',
          messages: [{ role: 'user', content: q }],
        },
        adminToken,
      );
      expect(res.status, `${q}: ${JSON.stringify(res.body)}`).toBe(200);
      expect(res.body?.intent).toBe('guide');
      expect(res.body?.proposal).toBeNull();
      expect(String(res.body?.reply ?? '')).toMatch(pat);
    }
  });

  it('strictly distinguishes platform questions from user-owned business websites ("tôi đang có web boardgame, và muốn setup") with zero regression or requirement pollution', async () => {
    const userBusinessMessages = [
      'tôi đang có web boardgame, và muốn setup',
      'toi dang co web boardgame, va muon setup',
      'dự án này bên mình bán boardgame, bạn giúp được gì?',
      'web này bên mình bán giày, bạn giúp được gì?',
      'trang web này của mình chuyên đồ gốm, muốn setup',
      'web của tôi bán giày sneaker chính hãng',
      'web của mình bán mỹ phẩm skincare, đổi trả 7 ngày',
      'trang web bên mình chuyên cho thuê lều cắm trại',
      'Shop mình có combo skincare giá 399k, đổi trả 7 ngày',
      'I have a boardgame website and want to set up customer support',
      'my website sells handmade ceramics',
    ];

    for (const msg of userBusinessMessages) {
      expect(matchPlatformKnowledgeQuestion(msg, '/thruline/providers')).toBeNull();
    }

    // Copilot-self capability pushback stays 'capability_or_pushback' (not hijacked by platform_guide)
    expect(matchPlatformKnowledgeQuestion('bạn có thể làm gì mà', '/thruline/support')).toBeNull();
    expect(classifyHumanConversationalAct('bạn có thể làm gì mà', '/thruline/support')).toBe(
      'capability_or_pushback',
    );
    expect(classifyHumanConversationalAct('ban co the lam gi ma', '/thruline/support')).toBe(
      'capability_or_pushback',
    );

    // Platform questions are never misclassified as open-domain shop topics or SaaS industry requirements
    expect(extractOpenDomainTopic('web này làm gì?', 'vi')).toBeNull();
    expect(extractOpenDomainTopic('web nay dung de lam gi', 'vi')).toBeNull();
    expect(extractOpenDomainTopic('trang web này là gì', 'vi')).toBeNull();

    const unpolluted = extractRequirementsFromMessages(
      [
        { role: 'user', content: 'nền tảng này làm gì vậy?' },
        { role: 'user', content: 'làm sao lấy api key?' },
      ],
      {},
      undefined,
      'vi',
    );
    expect(unpolluted.industry).toBeUndefined();
    expect(unpolluted.websiteOrigin).toBeUndefined();

    // End-to-end check: "tôi đang có web boardgame, và muốn setup" still enters warm boardgame discovery
    const boardgameRes = await hit(
      '/api/support-setup-copilot/chat',
      'POST',
      {
        tenantId,
        locale: 'vi',
        currentPath: '/thruline/support',
        messages: [{ role: 'user', content: 'tôi đang có web boardgame, và muốn setup' }],
      },
      adminToken,
    );
    expect(boardgameRes.status).toBe(200);
    expect(boardgameRes.body?.intent).toBe('gather_requirements');
    expect(boardgameRes.body?.proposal).toBeNull();
    expect(String(boardgameRes.body?.reply ?? '').toLowerCase()).toContain('boardgame');
  });

  it('gives read-only viewers helpful platform & current-page answers instead of Read-Only refusals, while keeping RBAC write guards intact', async () => {
    for (const token of [viewerToken, thrulineReadOnlyToken]) {
      const platformRes = await hit(
        '/api/support-setup-copilot/chat',
        'POST',
        {
          tenantId,
          targetMode: 'create_tenant',
          locale: 'vi',
          currentPath: '/thruline/providers',
          messages: [{ role: 'user', content: 'web này làm gì?' }],
        },
        token,
      );
      expect(platformRes.status).toBe(200);
      expect(platformRes.body?.intent).toBe('guide');
      expect(platformRes.body?.proposal).toBeNull();
      const reply = String(platformRes.body?.reply ?? '');
      expect(reply).toContain('FreeLLMAPI');
      expect(reply).toContain('Thruline');
      expect(reply).not.toContain('không có quyền tạo Support Tenant');
      expect(reply).not.toContain('Chỉ xem (Read-Only)');

      const pageRes = await hit(
        '/api/support-setup-copilot/chat',
        'POST',
        {
          tenantId,
          locale: 'vi',
          currentPath: '/thruline/providers',
          messages: [{ role: 'user', content: 'trang này dùng để làm gì?' }],
        },
        token,
      );
      expect(pageRes.status).toBe(200);
      expect(pageRes.body?.intent).toBe('guide');
      expect(pageRes.body?.proposal).toBeNull();
      expect(String(pageRes.body?.reply ?? '')).toMatch(/Providers|OAuth/i);
    }

    // Explicit tenant creation by read-only viewer MUST still be refused cleanly
    const unauthorizedCreate = await hit(
      '/api/support-setup-copilot/chat',
      'POST',
      {
        targetMode: 'create_tenant',
        locale: 'vi',
        messages: [{ role: 'user', content: 'Tạo mới 1 tenant AI Support tên Hack' }],
      },
      viewerToken,
    );
    expect(unauthorizedCreate.status).toBe(200);
    expect(unauthorizedCreate.body?.proposal).toBeNull();
    expect(String(unauthorizedCreate.body?.reply ?? '')).toContain('không có quyền tạo');
  });

  it('injects PLATFORM_EXPERT_KNOWLEDGE + currentPath context into live LLM coach prompts and routes live LLM platform replies cleanly', async () => {
    const promptVi = buildHumanCoachSystemPrompt({
      messages: [{ role: 'user', content: 'trang này làm gì?' }],
      locale: 'vi',
      targetMode: 'update_tenant',
      currentPath: '/thruline/combos',
      diagnostic: null,
      extracted: {},
    });
    expect(promptVi).toContain(PLATFORM_EXPERT_KNOWLEDGE);
    expect(promptVi).toContain('currentPath = "/thruline/combos"');
    expect(promptVi).toContain('Combos');

    // Enable local mock upstream LLM route in api_keys
    const db = getDb();
    const enc = encrypt('no-key');
    const upstreamUrl = `http://127.0.0.1:${mockUpstreamPort}/v1`;
    const keyRow = db
      .prepare(
        `INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
         VALUES ('custom', 'Platform Guide Mock', ?, ?, ?, 'healthy', 1, ?)`,
      )
      .run(enc.encrypted, enc.iv, enc.authTag, upstreamUrl);
    const keyId = Number(keyRow.lastInsertRowid);
    const modelRow = db
      .prepare(
        `INSERT INTO models (
           platform, model_id, display_name, intelligence_rank, speed_rank,
           size_label, monthly_token_budget, supports_vision, supports_tools,
           context_window, enabled, key_id, endpoint_scope
         ) VALUES ('custom', 'mock-platform-specialist', 'Mock Specialist', 90, 90, '70B', 'unlimited', 0, 1, 64000, 1, ?, ?)`,
      )
      .run(keyId, upstreamUrl);
    db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)').run(
      Number(modelRow.lastInsertRowid),
    );
    invalidateKeyCache();

    nextMockLlmJson = null;
    const liveRes = await hit(
      '/api/support-setup-copilot/chat',
      'POST',
      {
        tenantId,
        locale: 'vi',
        currentPath: '/thruline/providers',
        messages: [{ role: 'user', content: 'trang này dùng để làm gì?' }],
      },
      adminToken,
    );
    expect(liveRes.status).toBe(200);
    expect(liveRes.body?.usedFallback).toBe(false);
    expect(liveRes.body?.intent).toBe('guide');
    expect(liveRes.body?.proposal).toBeNull();
    expect(String(liveRes.body?.reply ?? '')).toContain('/thruline/providers');
    expect(lastUpstreamSystemPrompt).toContain('currentPath = "/thruline/providers"');
    expect(lastUpstreamSystemPrompt).toContain('FreeLLMAPI');

    // Guardrail: if an upstream model mistakenly responds with gather_requirements on a platform question,
    // playbook enforces intent='guide', proposal=null, and falls back to accurate specialist knowledge!
    nextMockLlmJson = {
      intent: 'gather_requirements',
      reply: 'Cho mình xin tên shop của bạn nhé?',
      extractedRequirements: { industry: 'Hallucinated Shop' },
    };
    const guardedRes = await hit(
      '/api/support-setup-copilot/chat',
      'POST',
      {
        tenantId,
        locale: 'vi',
        currentPath: '/thruline/combos',
        messages: [{ role: 'user', content: 'trang này dùng để làm gì?' }],
      },
      adminToken,
    );
    expect(guardedRes.status).toBe(200);
    expect(guardedRes.body?.intent).toBe('guide');
    expect(guardedRes.body?.proposal).toBeNull();
    expect(guardedRes.body?.usedFallback).toBe(true);
    expect(guardedRes.body?.modelUsed).toBeNull();
    expect(String(guardedRes.body?.reply ?? '')).toContain('Combos');
    expect(String(guardedRes.body?.reply ?? '')).not.toContain('Cho mình xin tên shop');
  });
});
