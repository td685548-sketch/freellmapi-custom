import fs from 'node:fs';
import http, { type Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CloudAiRuntimePack, CloudSignedLease } from '@freellmapi/shared/cloud-entitlement.js';
import { createApp } from '../../app.js';
import { recordServerLocalAddress } from '../../custom/ai-platform/orchestrator/engine.js';
import { configureCloudEntitlementForTesting } from '../../custom/cloud-entitlement/service.js';
import { encrypt } from '../../lib/crypto.js';
import { invalidateKeyCache } from '../../services/key-cache.js';
import { getKbCorpus } from '../../custom/support-setup-copilot/kb/corpus.js';
import { searchKbLexical } from '../../custom/support-setup-copilot/kb/index.js';
import {
  composeKbGroundedReply,
  isTroubleshootingQuestion,
} from '../../custom/support-setup-copilot/kb/answer.js';
import {
  DEFAULT_PERSONAL_KEY_RPM,
  DEFAULT_PROXY_RATE_LIMIT_RPM,
} from '../../custom/support-setup-copilot/kb/sources/web-options.js';
import { createSupportTenant } from '../../custom/x-gateway/support-store.js';
import { getDb, initDb } from '../../db/index.js';
import { buildKbQueryFromMessages, formatKbForPrompt } from '../../custom/support-setup-copilot/kb/prompt.js';
import { createSession, createUser } from '../../services/auth.js';
import { checkUserRateLimit } from '../../services/user-quotas.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const admin = { role: 'admin', isPrimary: true } as const;

// The message the user really sent: the Error Doctor's own headline fed back as a "how do I fix it?".
const REAL_QUESTION =
  'Cần xử lý ngay: Lỗi HTTP 429 — Chạm trần tốc độ gọi (Rate-Limit). Làm sao xử lý?';

describe('Web options KB — the numbers come from the product, not from memory', () => {
  const text = (id: string): string => getKbCorpus().find((c) => c.id === id)!.text;

  it('pins the literals that have no exported constant', () => {
    expect(checkUserRateLimit(987654).limit).toBe(DEFAULT_PERSONAL_KEY_RPM);
    const src = fs.readFileSync(path.resolve(HERE, '../../middleware/rateLimit.ts'), 'utf8');
    expect(src).toMatch(new RegExp(`const DEFAULT_RPM = ${DEFAULT_PROXY_RATE_LIMIT_RPM};`));
  });

  it('states the real default role quotas and runtime bounds', () => {
    const quotas = text('opt:tenant-role-quotas');
    expect(quotas).toContain('guest: 15 requests / 8000 tokens per 1h');
    expect(quotas).toContain('customer: 60 requests / 40000 tokens per 1h');
    expect(quotas).toContain('admin: unlimited requests / unlimited tokens per 1h');
    expect(text('opt:tenant-max-model-calls')).toContain('max completion tokens (1–4096, default 512)');
    expect(text('opt:upstream-rate-limit-options')).toContain('default 5, max 1440');
  });

  it('covers every 429 code the runtime can return', () => {
    const hub = text('opt:429-which-limit');
    for (const code of [
      'user_rate_limit_exceeded', 'rate_limit_error', 'user_quota_exceeded', 'client_quota_exceeded',
      'quota_exceeded', 'guest_session_rate_limited', 'routing_exhausted',
    ]) expect(hub, code).toContain(code);
  });
});

describe('Web options KB — retrieval and question detection', () => {
  it('ranks the 429 option hub first for the real question and for variants', () => {
    for (const q of [
      REAL_QUESTION,
      'xử lý lỗi 429 như thế nào',
      'bị 429 rate limit',
      'Lỗi HTTP 429 — Chạm trần tốc độ gọi (Rate-Limit) xử lý sao',
      'my api returns 429 too many requests how to fix',
    ]) {
      const hits = searchKbLexical(q, { caller: admin, limit: 3 });
      expect(hits.map((h) => h.chunk.id), q).toContain('opt:429-which-limit');
      expect(hits[0]!.chunk.source, q).toMatch(/option|troubleshooting/);
    }
  });

  it('finds the exact option for option-style questions', () => {
    const top = (q: string) => searchKbLexical(q, { caller: admin, limit: 3 }).map((h) => h.chunk.id);
    expect(top('khách vãng lai chat bị chặn quota_exceeded, chỉnh quota guest ở đâu')).toContain('opt:tenant-role-quotas');
    expect(top('nâng giới hạn RPM của key ở đâu')).toContain('opt:user-key-rpm');
    expect(top('routing_exhausted tất cả route đang cooldown thêm tài khoản xoay vòng')).toContain('opt:upstream-rate-limit-options');
  });

  it('detects error/limit questions but leaves setup chatter alone', () => {
    for (const q of [REAL_QUESTION, 'xử lý lỗi 429 sao', 'why am I getting rate limited', 'quota exceeded là gì, sửa sao', 'bị timeout 504', 'lỗi api sao vậy', 'sao bi loi 502']) {
      expect(isTroubleshootingQuestion(q), q).toBe(true);
    }
    for (const q of [
      'Hướng dẫn tôi 7 bước cấu hình AI Support',
      'setup giúp mình AI support cho shop giày',
      'đổi màu widget sang xanh',
      'xin chào',
      'Tôi bán hàng giá 500k, hỗ trợ khách 24/7',
      'sao trả lời cứng nhắc vậy',
      'sao tra loi cung nhac vay',
      'viết lời chào thân thiện hơn',
      'tôi đang có web boardgame, và muốn setup',
      'đổi trả nếu lỗi nhà sản xuất thì sao',
    ]) {
      expect(isTroubleshootingQuestion(q), q).toBe(false);
    }
  });

  it('composes a reply from the lead option and refuses to answer from non-answerable chunks', () => {
    const hits = searchKbLexical(REAL_QUESTION, { caller: admin, limit: 5 });
    const vi = composeKbGroundedReply(hits, 'vi')!;
    expect(vi.reply).toContain('user_rate_limit_exceeded');
    expect(vi.reply).toContain('/users');
    expect(vi.reply).not.toContain('7 mảnh ghép');
    expect(composeKbGroundedReply(hits.filter((h) => h.chunk.source === 'page'), 'vi')).toBeNull();
  });
});

/** Mock verified cloud lease (project test hook) so nothing touches a live activation token. */
function installMockCloudLease(): void {
  process.env.FREEAPI_AI_ACTIVATION_TOKEN = 'dummy-test-token-never-sent';
  const lease: CloudSignedLease = {
    licenseId: 'test-lic-webopt', label: 'Test License', instanceId: 'test-inst-webopt',
    scopes: ['ai_platform', 'customer_ai', 'support_copilot', 'support_suite', 'tenant_portal'],
    packVersion: 4, packHash: 'hash-webopt',
    issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  };
  const pack: CloudAiRuntimePack = {
    version: 4,
    supportCoachPack: {
      personaVi: 'Mock Persona Vi', personaEn: 'Mock Persona En',
      playbookReference: 'Mock Playbook', outputContract: 'Mock Output Contract',
    },
    supportAgentCopilotInstruction: 'Mock Copilot Instruction',
    customerAiDirective: 'ACTIVE', supportGatewayDirective: 'ACTIVE', aiPlatformCapabilityGrant: 'ACTIVE',
  };
  configureCloudEntitlementForTesting({
    activeLeaseRecord: { lease, tokenHash: 'dummy-hash', signature: 'dummy-sig', runtimePack: pack, verifiedAtMs: Date.now() },
  });
}

describe('Setup Copilot chat — 429 answered from the web options', () => {
  let server: Server;
  let base: string;
  let mockUpstream: Server;
  let mockUpstreamPort: number;
  let lastSystemPrompt = '';
  let adminToken: string;
  let tenantId: number;

  const chat = async (content: string) => {
    const res = await fetch(`${base}/api/support-setup-copilot/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        tenantId, locale: 'vi', currentPath: '/thruline/support',
        messages: [{ role: 'user', content }],
      }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = 'f'.repeat(64);
    initDb(':memory:');
    installMockCloudLease();
    mockUpstream = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages?: Array<{ role: string; content: string }> };
        lastSystemPrompt = parsed.messages?.find((m) => m.role === 'system')?.content ?? '';
        const payload = {
          intent: 'guide',
          reply: 'Lỗi 429 có nhiều loại: nếu thấy `user_rate_limit_exceeded` thì nâng RPM của key ở **Users (`/users`)**; nếu là `quota_exceeded` trên widget thì chỉnh **Role quotas** ở bước 3.',
          missingQuestions: [],
          suggestedQuickReplies: ['Mở trang Users'],
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'c1', object: 'chat.completion', created: 1, model: 'mock-429',
          choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(payload) }, finish_reason: 'stop' }],
        }));
      });
    });
    mockUpstream.listen(0, '127.0.0.1');
    await new Promise<void>((r) => mockUpstream.once('listening', () => r()));
    mockUpstreamPort = (mockUpstream.address() as { port: number }).port;

    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', () => r()));
    const { port } = server.address() as { port: number };
    base = `http://127.0.0.1:${port}`;
    recordServerLocalAddress({ socket: { localAddress: '127.0.0.1', localPort: port } } as never);

    const a = createUser('web-options-admin@example.com', 'AdminPass123!');
    adminToken = createSession(a.userId);
    tenantId = createSupportTenant({
      name: 'Chưa giàu đã lớn', slug: 'chua-giau', defaultModel: 'auto',
      systemPrompt: 'Prompt đã sẵn sàng cho khách truy cập.', createdBy: a.userId,
    }).tenant.id;
  });

  afterAll(async () => {
    configureCloudEntitlementForTesting(null);
    delete process.env.FREEAPI_AI_ACTIVATION_TOKEN;
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => mockUpstream.close(() => r()));
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM auth_request_limits').run();
  });

  it('with NO model route: answers from the web options, not the 7-step roadmap or a questionnaire', async () => {
    for (const q of [REAL_QUESTION, 'bị 429 rate limit', 'Lỗi HTTP 429 — Chạm trần tốc độ gọi (Rate-Limit) xử lý sao']) {
      const { status, body } = await chat(q);
      expect(status, JSON.stringify(body)).toBe(200);
      expect(body.intent, q).toBe('guide');
      expect(body.reply, q).toContain('user_rate_limit_exceeded');
      expect(body.reply, q).toContain('/thruline/support-guardrails');
      expect(body.reply, q).not.toContain('7 mảnh ghép');
      expect(body.reply, q).not.toMatch(/(?:^|\n)\s*1[.)]\s+.+\n\s*2[.)]\s+/m);
      expect(body.proposal, q).toBeNull();
      expect(body.usedFallback, q).toBe(true);
    }
  });

  it('still gives the roadmap for a genuine "7 steps" question', async () => {
    const { body } = await chat('Hướng dẫn tôi 7 bước cấu hình AI Support');
    expect(body.reply).toContain('7 mảnh ghép');
  });

  it('with a model route: the retrieved 429 options are in the prompt and the model answer is used', async () => {
    const db = getDb();
    const enc = encrypt('no-key');
    const url = `http://127.0.0.1:${mockUpstreamPort}/v1`;
    const key = db.prepare(
      `INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
       VALUES ('custom', 'Web options mock', ?, ?, ?, 'healthy', 1, ?)`,
    ).run(enc.encrypted, enc.iv, enc.authTag, url);
    const model = db.prepare(
      `INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
         monthly_token_budget, supports_vision, supports_tools, context_window, enabled, key_id, endpoint_scope)
       VALUES ('custom', 'mock-429', 'Mock 429', 90, 90, '70B', 'unlimited', 0, 1, 64000, 1, ?, ?)`,
    ).run(Number(key.lastInsertRowid), url);
    db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)').run(Number(model.lastInsertRowid));
    invalidateKeyCache();

    const { status, body } = await chat(REAL_QUESTION);
    expect(status, JSON.stringify(body)).toBe(200);
    expect(body.usedFallback).toBe(false);
    expect(body.reply).toContain('Users');
    expect(lastSystemPrompt).toContain('RETRIEVED PLATFORM KNOWLEDGE');
    expect(lastSystemPrompt).toContain('user_rate_limit_exceeded');
    expect(lastSystemPrompt).toContain('guest: 15 requests / 8000 tokens per 1h');
  });
});
