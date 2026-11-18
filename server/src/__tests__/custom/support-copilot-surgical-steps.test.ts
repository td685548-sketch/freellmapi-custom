import { beforeAll, describe, expect, it } from 'vitest';
import { SUPPORT_SETUP_STEP_IDS, type SupportSetupStepId } from '@freellmapi/shared/support-setup-copilot.js';
import '../../app.js';
import { applySupportSetupProposal } from '../../custom/support-setup-copilot/executor.js';
import { buildSanitizedSetupProposal } from '../../custom/support-setup-copilot/playbook.js';
import { createSetupProposal } from '../../custom/support-setup-copilot/store.js';
import {
  analyzeSurgicalSupportEdit,
  applySurgicalStepScopingAndMerge,
  SURGICAL_STEP_REQUIRED_PERMISSION,
} from '../../custom/support-setup-copilot/surgical-steps.js';
import {
  getSupportGuardrailPolicy,
  updateSupportGuardrailPolicy,
} from '../../custom/x-gateway/support-guardrails.js';
import {
  getSupportMaskingPolicy,
  listSupportKnowledgeDocs,
  updateSupportMaskingPolicy,
  upsertSupportKnowledgeDoc,
} from '../../custom/x-gateway/support-knowledge.js';
import {
  getSupportOutputPolicy,
  saveSupportOutputPolicy,
} from '../../custom/x-gateway/support-output-store.js';
import {
  getSupportRuntimePolicy,
  updateSupportRuntimePolicy,
} from '../../custom/x-gateway/support-runtime-store.js';
import {
  getSupportDeskSlaPolicy,
  getSupportDeskWidgetConfig,
  updateSupportDeskSlaPolicy,
  updateSupportDeskWidgetConfig,
} from '../../custom/x-gateway/support-service-desk-store.js';
import {
  createSupportTenant,
  createSupportTool,
  getSupportTenant,
  type SupportTenant,
} from '../../custom/x-gateway/support-store.js';
import { initDb } from '../../db/index.js';
import { createUser, type SessionUser } from '../../services/auth.js';

describe('Support Setup Copilot — Surgical Step Detection & Live Existing-Config Merger', () => {
  let adminUser: SessionUser;
  let richTenant: SupportTenant;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = 'c'.repeat(64);
    initDb(':memory:');

    const createdAdmin = createUser('surgical-admin@example.com', 'AdminPass123!');
    adminUser = {
      userId: createdAdmin.userId,
      email: 'surgical-admin@example.com',
      role: 'admin',
      isPrimary: true,
    };

    richTenant = createSupportTenant({
      name: 'BoardGame Hub VN',
      slug: 'boardgame-hub-vn',
      defaultModel: 'auto',
      systemPrompt:
        'You are the official BoardGame Hub VN concierge. Always recommend games by player count and play duration.',
      allowedOrigins: ['https://shop.boardgamehub.vn'],
      allowGuest: false,
      createdBy: adminUser.userId,
    }).tenant;

    // Seed rich custom configurations across all 7 stores so we can prove zero clobbering!
    upsertSupportKnowledgeDoc(String(richTenant.id), {
      title: 'BoardGame Hub - Rental Rules',
      category: 'policy',
      content: 'Deposit 200k VND; free 3-day boardgame rental for members.',
      tags: ['rental', 'deposit'],
      allowedRoles: ['guest', 'customer', 'staff', 'admin'],
      enabled: true,
    });
    updateSupportMaskingPolicy(String(richTenant.id), {
      enabled: true,
      builtinDetectors: ['email', 'phone'],
      unmaskedRoles: ['admin', 'staff'],
    });

    updateSupportGuardrailPolicy(String(richTenant.id), {
      enabled: true,
      blockPromptInjection: true,
      injectionDetectors: ['ignore_instructions', 'system_prompt_leak'],
      blockedTopics: ['pirated print-and-play PDFs'],
      competitorKeywords: ['OldRivalGames'],
      maxInputLength: 3200,
      bypassRoles: ['admin'],
      roleQuotas: {
        guest: { maxRequestsPerWindow: 25, maxTokensPerWindow: 15000, windowSeconds: 3600 },
        customer: { maxRequestsPerWindow: 120, maxTokensPerWindow: 90000, windowSeconds: 3600 },
      },
    });

    const out0 = getSupportOutputPolicy(richTenant.id);
    saveSupportOutputPolicy({
      tenantId: richTenant.id,
      expectedVersion: out0.version,
      policy: {
        mode: 'enforce',
        blockedTerms: [{ id: 'custom_secret_code', text: 'INTERNAL-DEALER-PRICE' }],
        maxOutputChars: 12000,
        redactCredentials: true,
      },
    });

    const w0 = getSupportDeskWidgetConfig(richTenant.id);
    updateSupportDeskWidgetConfig(
      richTenant.id,
      {
        enabled: true,
        appearance: {
          primaryColor: '#2563eb',
          secondaryColor: '#1d4ed8',
          title: 'Trợ lý Bàn Chơi VIP',
          subtitle: 'Tư vấn luật chơi 24/7',
          welcomeMessage: 'Chào hội trưởng! Bạn đang tìm boardgame cho mấy người chơi?',
          position: 'bottom-left',
          quickPrompts: ['Gợi ý game cho 4-6 người', 'Bảng giá thuê boardgame cuối tuần'],
          theme: 'dark',
          headerStyle: 'solid',
          avatarPreset: 'sparkles',
          showStatusDot: true,
          launcherStyle: 'pill',
          launcherLabel: 'Hỏi luật game',
          borderRadius: 'pill',
          widgetSize: 'large',
          fontFamily: 'inter',
          edgeOffsetPx: 32,
          inputPlaceholder: 'Nhập tên game hoặc số người chơi...',
          sendButtonLabel: 'Hỏi ngay',
          showPoweredBy: false,
          autoOpenDelaySeconds: 5,
        },
        intake: {
          required: true,
          fields: [
            {
              key: 'member_phone',
              label: 'Số điện thoại Zalo',
              type: 'text',
              required: true,
            },
          ],
        },
      },
      w0.version,
    );

    const sla0 = getSupportDeskSlaPolicy(richTenant.id);
    updateSupportDeskSlaPolicy(
      richTenant.id,
      {
        enabled: true,
        targets: {
          urgent: { firstResponseMinutes: 10, resolutionMinutes: 45 },
          high: { firstResponseMinutes: 20, resolutionMinutes: 180 },
          medium: { firstResponseMinutes: 60, resolutionMinutes: 720 },
          low: { firstResponseMinutes: 180, resolutionMinutes: 2880 },
        },
        routingRules: [
          {
            id: 'vip_missing_pieces',
            department: 'returns',
            keywords: ['thiếu quân cờ', 'rách bài', 'missing card'],
          },
        ],
      },
      sla0.version,
    );

    const tool = createSupportTool(richTenant.id, {
      name: 'check_game_stock',
      description: 'Check boardgame inventory',
      method: 'POST',
      endpointUrl: 'https://api.boardgamehub.vn/stock',
      allowedRoles: ['customer', 'staff', 'admin'],
    });
    updateSupportRuntimePolicy(richTenant.id, {
      allowedModels: ['auto'],
      toolPolicies: [{ toolId: tool.id, mode: 'approval_required' }],
      maxCompletionTokens: 900,
      maxModelCalls: 2,
      maxToolCalls: 1,
      maxContextChars: 20000,
      maxToolResultChars: 6000,
      maxHistoryMessages: 30,
    });
  });

  function buildBaselineStepsForRichTenant(
    canEditSteps: ReadonlySet<SupportSetupStepId> = new Set(SUPPORT_SETUP_STEP_IDS),
  ) {
    const tenant = getSupportTenant(richTenant.id);
    return buildSanitizedSetupProposal({
      userId: adminUser.userId,
      targetMode: 'update_tenant',
      existingTenant: tenant,
      requirements: {
        brandName: tenant.name,
        primaryColor: '#ec4899',
      },
      canEditSteps,
      canCreateTenant: true,
      isPlatformOperator: true,
      locale: 'vi',
    }).steps;
  }

  describe('analyzeSurgicalSupportEdit — non-interference & intent boundaries', () => {
    it('returns isSurgical=false when there is no existing tenant or when explicit Quick Brief is submitted', () => {
      expect(
        analyzeSurgicalSupportEdit({
          messages: [{ role: 'user', content: 'đổi mỗi màu widget sang hồng #ec4899 thôi' }],
          locale: 'vi',
          hasExistingTenant: false,
        }),
      ).toEqual({ isSurgical: false, targetedSteps: [], patches: {} });

      expect(
        analyzeSurgicalSupportEdit({
          messages: [{ role: 'user', content: 'đổi mỗi màu widget sang hồng #ec4899 thôi' }],
          locale: 'vi',
          hasExistingTenant: true,
          explicitBriefSubmitted: true,
        }),
      ).toEqual({ isSurgical: false, targetedSteps: [], patches: {} });
    });

    it('returns isSurgical=false for explicit full 7-step setup requests in VI (accented/unaccented) & EN', () => {
      const fullPrompts = [
        'setup toàn bộ 7 bước cho shop của mình nhé',
        'thiet lap day du tu dau cho tenant nay',
        'cấu hình trọn gói cho shop mỹ phẩm GlowSkin',
        'Please set up all 7 steps from scratch',
        'Run a full setup with standard defaults',
        'tôi đang có web boardgame, và muốn setup',
      ];

      for (const content of fullPrompts) {
        const res = analyzeSurgicalSupportEdit({
          messages: [{ role: 'user', content }],
          locale: 'vi',
          hasExistingTenant: true,
        });
        expect(res, `Expected non-surgical for: ${content}`).toEqual({
          isSurgical: false,
          targetedSteps: [],
          patches: {},
        });
      }
    });

    it('returns isSurgical=false for pure questions / how-to / where-is inquiries so guide mode handles them', () => {
      const questions = [
        'widget là gì?',
        'cách đổi màu ở đâu?',
        'đổi màu widget ở chỗ nào vậy bạn?',
        'lam sao de them domain vao CORS?',
        'where can I change the widget color?',
        'how do I block competitor keywords?',
        'what is SLA routing?',
      ];

      for (const content of questions) {
        const res = analyzeSurgicalSupportEdit({
          messages: [{ role: 'user', content }],
          locale: 'vi',
          hasExistingTenant: true,
          llmTargetSteps: ['widget_appearance'], // must NOT override a pure question
        });
        expect(res, `Expected non-surgical for question: ${content}`).toEqual({
          isSurgical: false,
          targetedSteps: [],
          patches: {},
        });
      }
    });
  });

  describe('analyzeSurgicalSupportEdit — accented VI, unaccented VI & EN across all 7 steps', () => {
    it('detects widget_appearance edits (colors, position, enable/disable, intake, title, greeting) without diacritic collisions', () => {
      // Hex + color name
      const pink = analyzeSurgicalSupportEdit({
        messages: [{ role: 'user', content: 'đổi mỗi màu widget sang hồng #ec4899 thôi' }],
        locale: 'vi',
        hasExistingTenant: true,
      });
      expect(pink).toEqual({
        isSurgical: true,
        targetedSteps: ['widget_appearance'],
        patches: { widget_appearance: { primaryColor: '#ec4899' } },
      });

      // Unaccented color names
      expect(
        analyzeSurgicalSupportEdit({
          messages: [{ role: 'user', content: 'doi mau nut chat sang xanh la giup minh' }],
          locale: 'vi',
          hasExistingTenant: true,
        }).patches.widget_appearance,
      ).toEqual({ primaryColor: '#10b981' });

      expect(
        analyzeSurgicalSupportEdit({
          messages: [{ role: 'user', content: 'change widget color to purple' }],
          locale: 'en',
          hasExistingTenant: true,
        }).patches.widget_appearance,
      ).toEqual({ primaryColor: '#8b5cf6' });

      // Position + diacritic collision guard: "do khach kho thay" must NOT match red ("đỏ")!
      const posLeft = analyzeSurgicalSupportEdit({
        messages: [
          { role: 'user', content: 'doi vi tri nut chat sang goc trai do khach kho thay' },
        ],
        locale: 'vi',
        hasExistingTenant: true,
      });
      expect(posLeft).toEqual({
        isSurgical: true,
        targetedSteps: ['widget_appearance'],
        patches: { widget_appearance: { position: 'left' } },
      });

      // Pre-chat email intake
      const intakeOn = analyzeSurgicalSupportEdit({
        messages: [{ role: 'user', content: 'bật thu thập email trước khi chat' }],
        locale: 'vi',
        hasExistingTenant: true,
      });
      expect(intakeOn).toEqual({
        isSurgical: true,
        targetedSteps: ['widget_appearance'],
        patches: { widget_appearance: { requireContactIntake: true } },
      });

      // Turning off intake on widget must NOT disable widgetEnabled!
      const intakeOff = analyzeSurgicalSupportEdit({
        messages: [{ role: 'user', content: 'tắt thu thập email trên widget' }],
        locale: 'vi',
        hasExistingTenant: true,
      });
      expect(intakeOff.patches.widget_appearance).toEqual({ requireContactIntake: false });

      // Quoted greeting containing "ở đâu" should NOT be rejected as a pure question
      const titleAndGreeting = analyzeSurgicalSupportEdit({
        messages: [
          {
            role: 'user',
            content:
              'đổi tiêu đề widget thành "Hỗ trợ BoardGame" và đổi lời chào thành "Bạn ở đâu mình cũng giao game tận nơi!"',
          },
        ],
        locale: 'vi',
        hasExistingTenant: true,
      });
      expect(titleAndGreeting.isSurgical).toBe(true);
      expect(titleAndGreeting.patches.widget_appearance).toEqual({
        widgetTitle: 'Hỗ trợ BoardGame',
        widgetGreeting: 'Bạn ở đâu mình cũng giao game tận nơi!',
      });
    });

    it('detects tenant_ai, knowledge_masking, guardrails_quotas, output_controls, sla_routing, and runtime_policy patches', () => {
      // tenant_ai
      expect(
        analyzeSurgicalSupportEdit({
          messages: [{ role: 'user', content: 'đổi model mặc định sang gemini-2.5-flash' }],
          locale: 'vi',
          hasExistingTenant: true,
        }),
      ).toEqual({
        isSurgical: true,
        targetedSteps: ['tenant_ai'],
        patches: { tenant_ai: { defaultModel: 'gemini-2.5-flash' } },
      });

      expect(
        analyzeSurgicalSupportEdit({
          messages: [
            {
              role: 'user',
              content:
                'switch default model to gpt-4o-mini, disable guest chat, and add instruction for AI: Always greet VIP members warmly',
            },
          ],
          locale: 'en',
          hasExistingTenant: true,
        }).patches.tenant_ai,
      ).toEqual({
        defaultModel: 'gpt-4o-mini',
        allowGuest: false,
        systemPromptAppend: 'Always greet VIP members warmly',
      });

      // knowledge_masking
      expect(
        analyzeSurgicalSupportEdit({
          messages: [
            {
              role: 'user',
              content: 'thêm chính sách đổi trả 14 ngày nếu hộp game còn nguyên seal và bật che SĐT',
            },
          ],
          locale: 'vi',
          hasExistingTenant: true,
        }),
      ).toEqual({
        isSurgical: true,
        targetedSteps: ['knowledge_masking'],
        patches: {
          knowledge_masking: {
            faqDocContent: 'chính sách đổi trả 14 ngày nếu hộp game còn nguyên seal',
            maskingEnabled: true,
          },
        },
      });

      // guardrails_quotas (single-letter competitor X + unaccented "den" must NOT trigger black color)
      const compRes = analyzeSurgicalSupportEdit({
        messages: [{ role: 'user', content: 'chặn nhắc tên đối thủ X' }],
        locale: 'vi',
        hasExistingTenant: true,
      });
      expect(compRes).toEqual({
        isSurgical: true,
        targetedSteps: ['guardrails_quotas'],
        patches: { guardrails_quotas: { addCompetitorKeywords: ['X'] } },
      });

      const unaccentedComp = analyzeSurgicalSupportEdit({
        messages: [{ role: 'user', content: 'chan nhac den doi thu Alpha, Beta thoi nhe' }],
        locale: 'vi',
        hasExistingTenant: true,
      });
      expect(unaccentedComp).toEqual({
        isSurgical: true,
        targetedSteps: ['guardrails_quotas'],
        patches: { guardrails_quotas: { addCompetitorKeywords: ['Alpha', 'Beta'] } },
      });

      // output_controls
      expect(
        analyzeSurgicalSupportEdit({
          messages: [
            {
              role: 'user',
              content: 'chuyển kiểm soát đầu ra sang monitor và đặt maxOutputChars 8000',
            },
          ],
          locale: 'vi',
          hasExistingTenant: true,
        }),
      ).toEqual({
        isSurgical: true,
        targetedSteps: ['output_controls'],
        patches: {
          output_controls: {
            outputMode: 'monitor',
            maxOutputChars: 8000,
          },
        },
      });

      // sla_routing
      expect(
        analyzeSurgicalSupportEdit({
          messages: [{ role: 'user', content: 'đặt SLA phản hồi 5 phút' }],
          locale: 'vi',
          hasExistingTenant: true,
        }),
      ).toEqual({
        isSurgical: true,
        targetedSteps: ['sla_routing'],
        patches: { sla_routing: { urgentFirstResponseMinutes: 5 } },
      });

      // runtime_policy
      expect(
        analyzeSurgicalSupportEdit({
          messages: [{ role: 'user', content: 'thêm domain https://boardgame.vn vào CORS' }],
          locale: 'vi',
          hasExistingTenant: true,
        }),
      ).toEqual({
        isSurgical: true,
        targetedSteps: ['runtime_policy'],
        patches: {
          runtime_policy: { addAllowedOrigins: ['https://boardgame.vn'] },
        },
      });
    });

    it('merges valid llmTargetSteps when consistent with a surgical change request', () => {
      const res = analyzeSurgicalSupportEdit({
        messages: [{ role: 'user', content: 'đổi màu widget sang #ec4899' }],
        locale: 'vi',
        hasExistingTenant: true,
        llmTargetSteps: ['widget_appearance', 'sla_routing'],
      });
      expect(res.isSurgical).toBe(true);
      expect(res.targetedSteps).toEqual(['widget_appearance', 'sla_routing']);
    });
  });

  describe('applySurgicalStepScopingAndMerge — live DB preservation & end-to-end executor apply', () => {
    it('preserves existing custom title, greeting, position, theme & intake when changing ONLY widget color, and leaves other 6 steps unchecked', async () => {
      const tenant = getSupportTenant(richTenant.id);
      const baselineSteps = buildBaselineStepsForRichTenant();
      const analysis = analyzeSurgicalSupportEdit({
        messages: [{ role: 'user', content: 'đổi mỗi màu widget sang hồng #ec4899 thôi' }],
        locale: 'vi',
        hasExistingTenant: true,
      });

      const merged = applySurgicalStepScopingAndMerge({
        existingTenant: tenant,
        baselineSteps,
        analysis,
        canEditSteps: new Set(SUPPORT_SETUP_STEP_IDS),
        locale: 'vi',
      });

      expect(merged.outcome).toBe('scoped');
      if (merged.outcome !== 'scoped') return;

      expect(merged.targetedSteps).toEqual(['widget_appearance']);
      expect(merged.deniedSteps).toEqual([]);
      expect(merged.steps.filter((s) => s.enabledByDefault).map((s) => s.stepId)).toEqual([
        'widget_appearance',
      ]);

      const widgetStep = merged.steps.find((s) => s.stepId === 'widget_appearance')!;
      const payload = widgetStep.payload as Record<string, any>;
      expect(payload.enabled).toBe(true);
      expect(payload.appearance.primaryColor).toBe('#ec4899');
      // All existing custom widget fields MUST be preserved!
      expect(payload.appearance.title).toBe('Trợ lý Bàn Chơi VIP');
      expect(payload.appearance.welcomeMessage).toBe(
        'Chào hội trưởng! Bạn đang tìm boardgame cho mấy người chơi?',
      );
      expect(payload.appearance.position).toBe('bottom-left');
      expect(payload.appearance.theme).toBe('dark');
      expect(payload.appearance.quickPrompts).toEqual([
        'Gợi ý game cho 4-6 người',
        'Bảng giá thuê boardgame cuối tuần',
      ]);
      expect(payload.intake).toEqual({
        required: true,
        fields: [{ key: 'member_phone', label: 'Số điện thoại Zalo', type: 'text', required: true }],
      });

      // Consent-gated human reply check
      expect(merged.replyVi).toContain('#ec4899');
      expect(merged.replyVi).toContain('Approve');

      // Verify end-to-end execution via applySupportSetupProposal applies ONLY widget_appearance!
      const proposal = createSetupProposal({
        id: 'prop_surgical_widget_color',
        userId: adminUser.userId,
        targetMode: 'update_tenant',
        tenantId: tenant.id,
        tenantName: tenant.name,
        tenantSlug: tenant.slug,
        status: 'pending_consent',
        summary: merged.summaryVi,
        requirements: {},
        steps: merged.steps,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      });

      const applied = await applySupportSetupProposal({
        user: adminUser,
        proposalId: proposal.id,
        approved: true,
        serverOrigin: 'http://127.0.0.1:3001',
      });

      expect(applied.stepResults.filter((r) => r.status === 'applied').map((r) => r.stepId)).toEqual([
        'widget_appearance',
      ]);

      const afterWidget = getSupportDeskWidgetConfig(tenant.id);
      expect(afterWidget.appearance.primaryColor).toBe('#ec4899');
      expect(afterWidget.appearance.title).toBe('Trợ lý Bàn Chơi VIP');
      expect(afterWidget.appearance.position).toBe('bottom-left');
      expect(afterWidget.intake.fields[0]?.key).toBe('member_phone');

      // Other stores remain 100% untouched!
      expect(getSupportTenant(tenant.id).systemPrompt).toContain('BoardGame Hub VN concierge');
      expect(getSupportTenant(tenant.id).allowGuest).toBe(false);
      expect(getSupportMaskingPolicy(String(tenant.id)).builtinDetectors).toEqual([
        'email',
        'phone',
      ]);
      expect(getSupportGuardrailPolicy(String(tenant.id)).competitorKeywords).toEqual([
        'OldRivalGames',
      ]);
      expect(getSupportDeskSlaPolicy(tenant.id).routingRules[0]?.id).toBe('vip_missing_pieces');
    });

    it('adds a new CORS origin while preserving existing origins, runtime bounds, and approval_required toolPolicies', async () => {
      const tenant = getSupportTenant(richTenant.id);
      const baselineSteps = buildBaselineStepsForRichTenant();
      const analysis = analyzeSurgicalSupportEdit({
        messages: [{ role: 'user', content: 'thêm domain https://boardgame.vn vào CORS' }],
        locale: 'vi',
        hasExistingTenant: true,
      });

      const merged = applySurgicalStepScopingAndMerge({
        existingTenant: tenant,
        baselineSteps,
        analysis,
        canEditSteps: new Set(SUPPORT_SETUP_STEP_IDS),
        locale: 'vi',
      });

      expect(merged.outcome).toBe('scoped');
      if (merged.outcome !== 'scoped') return;

      expect(merged.steps.filter((s) => s.enabledByDefault).map((s) => s.stepId)).toEqual([
        'runtime_policy',
      ]);

      const runtimeStep = merged.steps.find((s) => s.stepId === 'runtime_policy')!;
      const payload = runtimeStep.payload as Record<string, any>;
      expect(payload.allowedOrigins).toEqual([
        'https://shop.boardgamehub.vn',
        'https://boardgame.vn',
      ]);
      expect(payload.maxCompletionTokens).toBe(900);
      expect(payload.maxModelCalls).toBe(2);
      expect(payload.maxToolCalls).toBe(1);
      expect(payload.maxContextChars).toBe(20000);

      const proposal = createSetupProposal({
        id: 'prop_surgical_cors_add',
        userId: adminUser.userId,
        targetMode: 'update_tenant',
        tenantId: tenant.id,
        tenantName: tenant.name,
        tenantSlug: tenant.slug,
        status: 'pending_consent',
        summary: merged.summaryVi,
        requirements: {},
        steps: merged.steps,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      });

      await applySupportSetupProposal({
        user: adminUser,
        proposalId: proposal.id,
        approved: true,
        serverOrigin: 'http://127.0.0.1:3001',
      });

      expect(getSupportTenant(tenant.id).allowedOrigins).toEqual([
        'https://shop.boardgamehub.vn',
        'https://boardgame.vn',
      ]);
      const afterRuntime = getSupportRuntimePolicy(tenant.id);
      expect(afterRuntime.maxCompletionTokens).toBe(900);
      expect(afterRuntime.toolPolicies).toHaveLength(1);
      expect(afterRuntime.toolPolicies[0]?.mode).toBe('approval_required');
    });

    it('handles multi-step surgical edits, preserves existing competitors/SLA/KB/output rules, and validates defaultModel against availableModelIds', () => {
      const tenant = getSupportTenant(richTenant.id);
      const baselineSteps = buildBaselineStepsForRichTenant();

      // Multi-step: competitor + SLA + model (with invalid model fallback check)
      const multiAnalysis = analyzeSurgicalSupportEdit({
        messages: [
          {
            role: 'user',
            content:
              'chặn nhắc tên đối thủ RivalBoard, đặt SLA phản hồi 60 phút và đổi model mặc định sang nonexistent-model-xyz',
          },
        ],
        locale: 'vi',
        hasExistingTenant: true,
      });

      expect(multiAnalysis.isSurgical).toBe(true);
      expect(multiAnalysis.targetedSteps).toEqual([
        'tenant_ai',
        'guardrails_quotas',
        'sla_routing',
      ]);

      const merged = applySurgicalStepScopingAndMerge({
        existingTenant: tenant,
        baselineSteps,
        analysis: multiAnalysis,
        canEditSteps: new Set(SUPPORT_SETUP_STEP_IDS),
        locale: 'vi',
        availableModelIds: new Set(['auto', 'gemini-2.5-flash']),
      });

      expect(merged.outcome).toBe('scoped');
      if (merged.outcome !== 'scoped') return;

      expect(merged.steps.filter((s) => s.enabledByDefault).map((s) => s.stepId)).toEqual([
        'tenant_ai',
        'guardrails_quotas',
        'sla_routing',
      ]);

      // Invalid model safely kept current tenant.defaultModel ('auto') and preserved systemPrompt
      const aiPayload = merged.steps.find((s) => s.stepId === 'tenant_ai')!.payload as Record<
        string,
        any
      >;
      expect(aiPayload.defaultModel).toBe('auto');
      expect(aiPayload.systemPrompt).toBe(tenant.systemPrompt);
      expect(aiPayload.allowGuest).toBe(false);

      // Valid model updates cleanly while still preserving systemPrompt & allowGuest
      const validModelAnalysis = analyzeSurgicalSupportEdit({
        messages: [{ role: 'user', content: 'switch default model to gemini-2.5-flash' }],
        locale: 'en',
        hasExistingTenant: true,
      });
      const validModelMerged = applySurgicalStepScopingAndMerge({
        existingTenant: tenant,
        baselineSteps,
        analysis: validModelAnalysis,
        canEditSteps: new Set(SUPPORT_SETUP_STEP_IDS),
        locale: 'en',
        availableModelIds: new Set(['auto', 'gemini-2.5-flash']),
      });
      expect(validModelMerged.outcome).toBe('scoped');
      if (validModelMerged.outcome === 'scoped') {
        const validAi = validModelMerged.steps.find((s) => s.stepId === 'tenant_ai')!
          .payload as Record<string, any>;
        expect(validAi.defaultModel).toBe('gemini-2.5-flash');
        expect(validAi.systemPrompt).toBe(tenant.systemPrompt);
      }

      // Guardrails preserved 'OldRivalGames' + added 'RivalBoard' + preserved custom quotas
      const guardPayload = merged.steps.find((s) => s.stepId === 'guardrails_quotas')!
        .payload as Record<string, any>;
      expect(guardPayload.competitorKeywords).toEqual(['OldRivalGames', 'RivalBoard']);
      expect(guardPayload.blockedTopics).toEqual(['pirated print-and-play PDFs']);
      expect(guardPayload.roleQuotas.guest.maxRequestsPerWindow).toBe(25);

      // SLA raised urgent resolutionMinutes >= firstResponseMinutes (60 >= 45 -> 60) and kept routingRules
      const slaPayload = merged.steps.find((s) => s.stepId === 'sla_routing')!.payload as Record<
        string,
        any
      >;
      expect(slaPayload.targets.urgent).toEqual({
        firstResponseMinutes: 60,
        resolutionMinutes: 60,
      });
      expect(slaPayload.routingRules).toEqual([
        {
          id: 'vip_missing_pieces',
          department: 'returns',
          keywords: ['thiếu quân cờ', 'rách bài', 'missing card'],
        },
      ]);

      // Also verify KB masking-only toggle keeps docs=[] so existing KB docs aren't overwritten
      const maskingToggle = analyzeSurgicalSupportEdit({
        messages: [{ role: 'user', content: 'disable PII masking' }],
        locale: 'en',
        hasExistingTenant: true,
      });
      const maskingMerged = applySurgicalStepScopingAndMerge({
        existingTenant: tenant,
        baselineSteps,
        analysis: maskingToggle,
        canEditSteps: new Set(SUPPORT_SETUP_STEP_IDS),
        locale: 'en',
      });
      expect(maskingMerged.outcome).toBe('scoped');
      if (maskingMerged.outcome === 'scoped') {
        const kbPayload = maskingMerged.steps.find((s) => s.stepId === 'knowledge_masking')!
          .payload as Record<string, any>;
        expect(kbPayload.docs).toEqual([]);
        expect(kbPayload.masking.enabled).toBe(false);
        expect(kbPayload.masking.builtinDetectors).toEqual(['email', 'phone']);
        expect(listSupportKnowledgeDocs(String(tenant.id))).toHaveLength(1);
      }
    });
  });

  describe('applySurgicalStepScopingAndMerge — RBAC permission denial & partial-permission scoping', () => {
    it('returns outcome=permission_denied naming the exact missing tenant permission when user lacks edit access for the targeted step', () => {
      const tenant = getSupportTenant(richTenant.id);
      // Simulate ai_configurator who has AI/KB/Guardrails/Widget, but lacks edit_tenant_integration
      const aiConfiguratorSteps = new Set<SupportSetupStepId>([
        'tenant_ai',
        'knowledge_masking',
        'guardrails_quotas',
        'output_controls',
        'widget_appearance',
        'sla_routing',
      ]);
      const baselineSteps = buildBaselineStepsForRichTenant(aiConfiguratorSteps);

      const corsAnalysis = analyzeSurgicalSupportEdit({
        messages: [{ role: 'user', content: 'thêm domain https://boardgame.vn vào CORS' }],
        locale: 'vi',
        hasExistingTenant: true,
      });

      const denied = applySurgicalStepScopingAndMerge({
        existingTenant: tenant,
        baselineSteps,
        analysis: corsAnalysis,
        canEditSteps: aiConfiguratorSteps,
        locale: 'vi',
      });

      expect(denied.outcome).toBe('permission_denied');
      if (denied.outcome !== 'permission_denied') return;

      expect(denied.deniedSteps).toEqual(['runtime_policy']);
      expect(denied.requiredPermissions).toEqual(['edit_tenant_integration']);
      expect(denied.replyVi).toContain('edit_tenant_integration');
      expect(denied.replyEn).toContain('edit_tenant_integration');

      // Also verify every step maps to its exact documented tenant permission
      expect(SURGICAL_STEP_REQUIRED_PERMISSION).toEqual({
        tenant_ai: 'edit_tenant_ai',
        knowledge_masking: 'edit_tenant_knowledge',
        guardrails_quotas: 'edit_tenant_guardrails',
        output_controls: 'edit_tenant_guardrails',
        widget_appearance: 'edit_tenant_widget',
        sla_routing: 'edit_tenant_widget',
        runtime_policy: 'edit_tenant_integration',
      });
    });

    it('scopes cleanly to permittedSteps and scrubs deniedSteps when a multi-step edit crosses a permission boundary', () => {
      const tenant = getSupportTenant(richTenant.id);
      const widgetOnlySteps = new Set<SupportSetupStepId>(['widget_appearance', 'sla_routing']);
      const baselineSteps = buildBaselineStepsForRichTenant(widgetOnlySteps);

      const analysis = analyzeSurgicalSupportEdit({
        messages: [
          {
            role: 'user',
            content:
              'đổi vị trí nút chat sang góc phải và thêm domain https://boardgame.vn vào CORS',
          },
        ],
        locale: 'vi',
        hasExistingTenant: true,
      });

      const res = applySurgicalStepScopingAndMerge({
        existingTenant: tenant,
        baselineSteps,
        analysis,
        canEditSteps: widgetOnlySteps,
        locale: 'vi',
      });

      expect(res.outcome).toBe('scoped');
      if (res.outcome !== 'scoped') return;

      expect(res.targetedSteps).toEqual(['widget_appearance']);
      expect(res.deniedSteps).toEqual(['runtime_policy']);
      expect(res.requiredPermissions).toEqual(['edit_tenant_integration']);
      expect(res.steps.filter((s) => s.enabledByDefault).map((s) => s.stepId)).toEqual([
        'widget_appearance',
      ]);

      const scrubbedRuntime = res.steps.find((s) => s.stepId === 'runtime_policy')!;
      expect(scrubbedRuntime.canApply).toBe(false);
      expect(scrubbedRuntime.enabledByDefault).toBe(false);
      expect(scrubbedRuntime.payload).toEqual({});
      expect(res.replyVi).toContain('edit_tenant_integration');
    });
  });
});
