import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getFlags, setFlags } from '../../custom/ai-platform/flags.js';
import { SupportSetupCopilotError } from '../../custom/support-setup-copilot/store.js';
import {
  attachAdviceToActions,
  buildSystemAdvice,
  buildSystemAdvicePromptSection,
} from '../../custom/support-setup-copilot/system-advisor.js';
import {
  applySystemSettingsActions,
  buildSystemSettingAction,
  detectSystemSettingsIntent,
  evaluateSystemSettingsProposal,
} from '../../custom/support-setup-copilot/system-settings.js';
import { handleSystemTargetChatTurn } from '../../custom/support-setup-copilot/system-target.js';
import { tryBuildSystemAdviceReply } from '../../custom/support-setup-copilot/system-target-advice.js';
import {
  COPILOT_TOOL_GUARDS,
  COPILOT_TOOL_REGISTRY,
  executeCopilotTool,
  type CopilotToolDefinition,
} from '../../custom/support-setup-copilot/tools.js';
import { listSupportAuditLogs } from '../../custom/x-gateway/support-enterprise-router.js';
import { createSupportTenant } from '../../custom/x-gateway/support-store.js';
import { upsertSupportKnowledgeDoc } from '../../custom/x-gateway/support-knowledge.js';
import { getDb, initDb, setSetting } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { createUser, type SessionUser } from '../../services/auth.js';
import { CACHE_ENABLED_SETTING } from '../../services/cache.js';
import { setCompressionConfig } from '../../services/compression/config.js';
import { setUserPermissions } from '../../services/users.js';

const ALL_OFF = { retrieval: false, prompts: false, promptCache: false, mcpClient: false, outputGuard: false, orchestrator: false };

describe('Copilot admin settings — AI Platform switches, state-aware advice, reasons, guards', () => {
  let admin: SessionUser; // primary admin: wildcard permission
  let flagsOnly: SessionUser; // delegated: edit_ai_flags only
  let cacheOnly: SessionUser; // delegated: edit_cache only
  let nobody: SessionUser; // no system permission at all
  let tenantId: number;

  const withPerms = (u: SessionUser, permissions: string[]): SessionUser => ({ ...u, permissions });

  const addEmbeddingKey = (platform = 'google'): void => {
    const enc = encrypt('test-key');
    getDb()
      .prepare(
        `INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
         VALUES (?, 'advisor test', ?, ?, ?, 'healthy', 1)`,
      )
      .run(platform, enc.encrypted, enc.iv, enc.authTag);
  };

  const addRequests = (n: number, opts: { status: 'success' | 'error'; error?: string; inputTokens?: number }): void => {
    const stmt = getDb().prepare(
      `INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, error, created_at)
       VALUES ('openai', 'gpt-4o-mini', ?, ?, 50, 300, ?, datetime('now'))`,
    );
    for (let i = 0; i < n; i += 1) stmt.run(opts.status, opts.inputTokens ?? 100, opts.error ?? null);
  };

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    initDb(':memory:');
    admin = createUser('advisor-admin@example.com', 'AdminPass123!', 'admin');
    flagsOnly = createUser('advisor-flags@example.com', 'UserPass123!', 'member');
    cacheOnly = createUser('advisor-cache@example.com', 'UserPass123!', 'member');
    nobody = createUser('advisor-nobody@example.com', 'UserPass123!', 'member');
    setUserPermissions(flagsOnly.userId, ['edit_ai_flags'], admin.userId);
    setUserPermissions(cacheOnly.userId, ['edit_cache'], admin.userId);
    flagsOnly = withPerms(flagsOnly, ['edit_ai_flags']);
    cacheOnly = withPerms(cacheOnly, ['edit_cache']);
    nobody = withPerms(nobody, []);
    tenantId = createSupportTenant({
      name: 'Advisor Shop', slug: 'advisor-shop', defaultModel: 'auto', systemPrompt: 'Prompt sẵn sàng.', createdBy: admin.userId,
    }).tenant.id;
    upsertSupportKnowledgeDoc(String(tenantId), { title: 'Chính sách đổi trả', content: 'Đổi trả trong 7 ngày nếu còn nguyên tem.' });
  });

  beforeEach(() => {
    setFlags(ALL_OFF);
    setSetting(CACHE_ENABLED_SETTING, '0');
    setCompressionConfig({ mode: 'off' });
    const db = getDb();
    db.prepare('DELETE FROM requests').run();
    db.prepare("DELETE FROM api_keys WHERE label = 'advisor test'").run();
  });

  describe('ai_platform_pillars as a system setting', () => {
    it('proposes "bật retrieval" for a permitted user and shows current → proposed', () => {
      const res = evaluateSystemSettingsProposal({
        user: flagsOnly, locale: 'vi', messages: [{ role: 'user', content: 'bật retrieval giúp mình' }],
      });
      expect(res.outcome).toBe('proposed');
      if (res.outcome !== 'proposed') return;
      expect(res.actions).toHaveLength(1);
      expect(res.actions[0]).toMatchObject({
        settingId: 'ai_platform_pillars', requiredPermission: 'edit_ai_flags', canApply: true, payload: { retrieval: true },
      });
      expect(res.actions[0]!.currentValueEn).toContain('off');
      expect(res.actions[0]!.proposedValueEn).toContain('on');
      expect(getFlags().retrieval).toBe(false); // nothing applied by proposing
    });

    it('mirrors the user\'s permissions: no edit_ai_flags → denied, naming the permission', () => {
      const res = evaluateSystemSettingsProposal({
        user: cacheOnly, locale: 'en', messages: [{ role: 'user', content: 'turn on retrieval' }],
      });
      expect(res.outcome).toBe('permission_denied');
      if (res.outcome !== 'permission_denied') return;
      expect(res.missingPermissions).toEqual(['edit_ai_flags']);
      expect(res.replyEn).toContain('edit_ai_flags');
    });

    it('does not stage a Consent Card for a pillar that is already in the requested state', () => {
      setFlags({ retrieval: true });
      const res = evaluateSystemSettingsProposal({
        user: admin, locale: 'vi', messages: [{ role: 'user', content: 'bật retrieval' }],
      });
      expect(res.outcome).toBe('none');
    });

    it('parses several pillars in one message and keeps "mcp server" and "mcp client" apart', () => {
      const multi = detectSystemSettingsIntent([{ role: 'user', content: 'bật prompt cache và tắt output guard' }]);
      expect(multi).toEqual({
        kind: 'change_request',
        requests: [{ settingId: 'ai_platform_pillars', payload: { promptCache: true, outputGuard: false } }],
      });
      const server = detectSystemSettingsIntent([{ role: 'user', content: 'bật mcp server' }]);
      expect(server.kind === 'change_request' && server.requests.map((r) => r.settingId)).toEqual(['mcp_server']);
      for (const text of ['bật mcp client', 'enable mcp client']) {
        const client = detectSystemSettingsIntent([{ role: 'user', content: text }]);
        expect(client.kind === 'change_request' && client.requests.map((r) => r.settingId), text).toEqual(['ai_platform_pillars']);
      }
    });

    it('does not mistake a tenant FAQ request for a pillar, but does catch vectorizing documents', () => {
      const faq = detectSystemSettingsIntent([{ role: 'user', content: 'bật tìm kiếm ngữ nghĩa cho tài liệu FAQ' }]);
      expect(faq.kind === 'change_request' && faq.requests.map((r) => r.settingId)).toEqual(['ai_platform_pillars']);
      expect(detectSystemSettingsIntent([{ role: 'user', content: 'đổi màu widget sang xanh' }]).kind).toBe('none');
    });

    it('applies only after approval, re-checks the live permission, and ignores unknown keys', () => {
      const action = buildSystemSettingAction('ai_platform_pillars', { retrieval: true, bogus: true, outputGuard: 'yes' }, true);
      expect(action.payload).toEqual({ retrieval: true });

      expect(() => applySystemSettingsActions({ user: cacheOnly, actions: [action] })).toThrow(SupportSetupCopilotError);
      expect(getFlags().retrieval).toBe(false);

      const results = applySystemSettingsActions({ user: flagsOnly, actions: [action] });
      expect(results[0]).toMatchObject({ settingId: 'ai_platform_pillars', status: 'applied' });
      expect(getFlags()).toEqual({ ...ALL_OFF, retrieval: true });
    });
  });

  describe('advisor — recommendations come from measured state', () => {
    it('recommends vectorizing documents when documents exist and an embedding key is usable', () => {
      addEmbeddingKey('google');
      const advice = buildSystemAdvice(admin);
      const item = advice.items.find((i) => i.id === 'enable_retrieval');
      expect(item).toBeDefined();
      expect(item).toMatchObject({ kind: 'recommend', settingId: 'ai_platform_pillars', payload: { retrieval: true } });
      expect(item!.evidence.join(' ')).toMatch(/1 enabled knowledge document\(s\) across 1 tenant\(s\)/);
      expect(item!.evidence.join(' ')).toContain('google');
      expect(item!.reasonVi).toContain('1 tài liệu');
      expect(item!.reasonEn).toMatch(/sent to the embedding provider/);
    });

    it('does NOT offer to enable Retrieval without an embedding key — it explains the missing prerequisite', () => {
      const advice = buildSystemAdvice(admin);
      expect(advice.items.some((i) => i.kind === 'recommend')).toBe(false);
      const note = advice.items.find((i) => i.id === 'retrieval_needs_embedding_key');
      expect(note?.kind).toBe('attention');
      expect(note?.payload).toBeUndefined();
      expect(note?.reasonEn).toContain('/keys');
    });

    it('flags Retrieval that is on but cannot build vectors, and stays quiet when it is on and healthy', () => {
      setFlags({ retrieval: true });
      expect(buildSystemAdvice(admin).items.map((i) => i.id)).toEqual(['retrieval_on_without_key']);
      addEmbeddingKey('google');
      expect(buildSystemAdvice(admin).items).toEqual([]);
    });

    it('recommends Response Cache only when 429s are frequent, and says the threshold is a heuristic', () => {
      addRequests(3, { status: 'error', error: 'HTTP 429 rate limit exceeded' });
      addRequests(20, { status: 'success' });
      expect(buildSystemAdvice(admin).items.some((i) => i.id === 'enable_response_cache')).toBe(false);

      addRequests(10, { status: 'error', error: 'HTTP 429 rate limit exceeded' });
      const item = buildSystemAdvice(admin).items.find((i) => i.id === 'enable_response_cache');
      expect(item).toMatchObject({ kind: 'recommend', settingId: 'response_cache', payload: { enabled: true } });
      expect(item!.evidence.join(' ')).toContain('13 rate-limited of 33 requests');
      expect(item!.evidence.join(' ')).toContain('Heuristic');

      setSetting(CACHE_ENABLED_SETTING, '1');
      expect(buildSystemAdvice(admin).items.some((i) => i.id === 'enable_response_cache')).toBe(false);
    });

    it('recommends safe (lossless) compression for consistently long prompts', () => {
      addRequests(25, { status: 'success', inputTokens: 9000 });
      const item = buildSystemAdvice(admin).items.find((i) => i.id === 'enable_prompt_compression');
      expect(item).toMatchObject({ kind: 'recommend', settingId: 'prompt_compression', payload: { mode: 'lossless' } });
      expect(item!.evidence[0]).toContain('9000');
    });

    it('is permission-mirrored: a user only gets advice (and data) for areas they may change', () => {
      addEmbeddingKey('google');
      addRequests(10, { status: 'error', error: 'HTTP 429 rate limit exceeded' });

      const none = buildSystemAdvice(nobody);
      expect(none.items).toEqual([]);
      expect(none.hiddenAreas.map((h) => h.settingId).sort()).toEqual(['ai_platform_pillars', 'prompt_compression', 'response_cache']);

      const cache = buildSystemAdvice(cacheOnly);
      expect(cache.items.map((i) => i.id)).toEqual(['enable_response_cache']);
      expect(cache.hiddenAreas.map((h) => h.settingId)).toContain('ai_platform_pillars');

      const flags = buildSystemAdvice(flagsOnly);
      expect(flags.items.map((i) => i.id)).toEqual(['enable_retrieval']);

      expect(buildSystemAdvice(admin).items.map((i) => i.id).sort()).toEqual(['enable_response_cache', 'enable_retrieval']);
    });

    it('reports what it could not read instead of implying all is well', () => {
      const db = getDb();
      db.exec('ALTER TABLE requests RENAME TO requests_gone');
      try {
        expect(buildSystemAdvice(admin).unreadable).toContain('last-24h request statistics');
        expect(buildSystemAdvicePromptSection(admin, 'en')).toContain('Could NOT be read');
      } finally {
        db.exec('ALTER TABLE requests_gone RENAME TO requests');
      }
    });

    it('prompt section carries reasons for the model, and is empty for a user with no system permission', () => {
      addEmbeddingKey('google');
      const section = buildSystemAdvicePromptSection(admin, 'vi');
      expect(section).toContain('LIVE SYSTEM ADVICE');
      expect(section).toContain('setting.ai_platform_pillars');
      expect(section).toContain('Why:');
      expect(buildSystemAdvicePromptSection(nobody, 'vi')).toBe('');
    });
  });

  describe('reasons travel with the proposal', () => {
    it('attaches the advisor reason only when the proposal matches the recommendation', () => {
      addEmbeddingKey('google');
      const match = attachAdviceToActions([buildSystemSettingAction('ai_platform_pillars', { retrieval: true }, true)], admin)[0]!;
      expect(match.reasonVi).toContain('tài liệu');
      expect(match.evidence?.length).toBeGreaterThan(0);

      const superset = attachAdviceToActions(
        [buildSystemSettingAction('ai_platform_pillars', { retrieval: true, outputGuard: true }, true)], admin,
      )[0]!;
      expect(superset.reasonVi).toBeUndefined();

      const unrelated = attachAdviceToActions([buildSystemSettingAction('mcp_server', { enabled: true }, true)], admin)[0]!;
      expect(unrelated.reasonVi).toBeUndefined();
    });

    it('records the reason in the audit log when the change is applied', () => {
      addEmbeddingKey('google');
      const [action] = attachAdviceToActions([buildSystemSettingAction('ai_platform_pillars', { retrieval: true }, true)], flagsOnly);
      applySystemSettingsActions({ user: flagsOnly, actions: [action!] });
      const audit = listSupportAuditLogs('system').find(
        (a) => a.action === 'support.setup_copilot.system_settings_apply' && a.userId === String(flagsOnly.userId),
      );
      const reasons = (audit?.details as { reasons?: Array<{ settingId: string; reason: string }> })?.reasons;
      expect(reasons?.[0]).toMatchObject({ settingId: 'ai_platform_pillars' });
      expect(reasons?.[0]?.reason).toMatch(/embedding provider/);
    });
  });

  describe('tool pipeline — gate, then deny-only guards (DeepSeek Harness pattern)', () => {
    it('stages a pillar change with its reason, and the gate still stops users without the permission', async () => {
      addEmbeddingKey('google');
      const ok = await executeCopilotTool({ user: flagsOnly, toolId: 'setting.ai_platform_pillars', input: { retrieval: true } });
      expect(ok.status).toBe('executed');
      const action = (ok.result as { action: { reasonEn?: string } }).action;
      expect(action.reasonEn).toMatch(/embedding provider/);
      expect(getFlags().retrieval).toBe(false); // staging never writes

      const denied = await executeCopilotTool({ user: cacheOnly, toolId: 'setting.ai_platform_pillars', input: { retrieval: true } });
      expect(denied.status).toBe('denied');
      expect(denied.requiredPermission).toBe('edit_ai_flags');
    });

    it('a guard can only deny: an empty pillar patch is blocked even for a fully permitted admin', async () => {
      const res = await executeCopilotTool({ user: admin, toolId: 'setting.ai_platform_pillars', input: {} });
      expect(res.status).toBe('denied');
      expect(res.reason).toBe('empty_pillar_patch');
    });

    it('secret surfaces (keys, passwords, backups, invites) can never become a chat tool', () => {
      const secretGuard = COPILOT_TOOL_GUARDS[0]!;
      for (const id of ['admin_api_key', 'master_password', 'db_backup_restore', 'invite_codes', 'provider_secret']) {
        const fake = { id: `setting.${id}`, kind: 'system_setting', settingId: id } as unknown as CopilotToolDefinition;
        expect(secretGuard({ tool: fake, input: {} }), id).toBe('secret_surface_not_allowed_via_chat');
      }
      for (const tool of COPILOT_TOOL_REGISTRY.filter((t) => t.kind === 'system_setting')) {
        expect(secretGuard({ tool, input: {} }), tool.id).toBeNull(); // incl. thruline_token_savers
      }
    });

    it('system.advise returns permission-filtered advice and is refused without any system permission', async () => {
      addEmbeddingKey('google');
      const ok = await executeCopilotTool({ user: flagsOnly, toolId: 'system.advise', input: {} });
      expect(ok.status).toBe('executed');
      expect((ok.result as { items: Array<{ id: string }> }).items.map((i) => i.id)).toEqual(['enable_retrieval']);
      const refused = await executeCopilotTool({ user: nobody, toolId: 'system.advise', input: {} });
      expect(refused.status).toBe('denied');
    });
  });

  describe('System target (primary admin, no model call)', () => {
    const ask = (user: SessionUser, content: string) =>
      handleSystemTargetChatTurn({ user, messages: [{ role: 'user', content }], locale: 'vi' });

    it('answers "what should I change?" with measured reasons and a one-click command', () => {
      addEmbeddingKey('google');
      const res = ask(admin, 'Bạn gợi ý mình nên chỉnh gì?');
      expect(res.proposal).toBeNull();
      expect(res.reply).toContain('Căn cứ đo được');
      expect(res.reply).toContain('1 tài liệu');
      expect(res.suggestedQuickReplies).toContain('Bật retrieval');
    });

    it('says plainly when nothing argues for a change', () => {
      setFlags({ retrieval: true });
      addEmbeddingKey('google');
      expect(ask(admin, 'gợi ý giúp mình tối ưu hệ thống').reply).toContain('chưa thấy cài đặt nào cần đổi');
    });

    it('explains WHY from the knowledge base plus this system\'s numbers, and why not when it does not fit', () => {
      addEmbeddingKey('google');
      const why = ask(admin, 'tại sao nên bật retrieval?');
      expect(why.reply).toMatch(/vector/i);
      expect(why.reply).toContain('Với hệ thống của bạn lúc này');
      expect(why.reply).toContain('Căn cứ đo được');
      expect(why.suggestedQuickReplies).toContain('Bật retrieval');

      getDb().prepare("DELETE FROM api_keys WHERE label = 'advisor test'").run();
      const noKey = ask(admin, 'tại sao nên bật retrieval?');
      expect(noKey.reply).toContain('thiếu key embedding');
      expect(noKey.suggestedQuickReplies).not.toContain('Bật retrieval');
    });

    it('turns the suggestion into a Consent Card that carries the reason, and nothing applies until approval', () => {
      addEmbeddingKey('google');
      const res = ask(admin, 'Bật retrieval');
      expect(res.intent).toBe('propose_setup');
      const action = res.proposal?.systemActions?.[0];
      expect(action).toMatchObject({ settingId: 'ai_platform_pillars', payload: { retrieval: true }, canApply: true });
      expect(action?.reasonVi).toContain('1 tài liệu');
      expect(getFlags().retrieval).toBe(false);

      applySystemSettingsActions({ user: admin, actions: res.proposal!.systemActions! });
      expect(getFlags().retrieval).toBe(true);
    });

    it('leaves non-advice messages to the existing handlers', () => {
      expect(tryBuildSystemAdviceReply({ user: admin, messages: [{ role: 'user', content: 'bật response cache' }], locale: 'vi' })).toBeNull();
      expect(tryBuildSystemAdviceReply({ user: admin, messages: [{ role: 'user', content: 'xin chào' }], locale: 'vi' })).toBeNull();
    });

    it('the greeting mentions the AI Platform switches and the advice feature', () => {
      const res = ask(admin, 'xin chào');
      expect(res.reply).toContain('công tắc AI Platform');
      expect(res.suggestedQuickReplies[0]).toBe('Bạn gợi ý mình nên chỉnh gì?');
    });
  });
});
