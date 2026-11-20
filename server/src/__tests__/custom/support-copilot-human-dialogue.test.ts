import { describe, expect, it } from 'vitest';
import type {
  SupportSetupChatMessage,
  SupportSetupPlannedStep,
  SupportSetupProposal,
} from '@freellmapi/shared/support-setup-copilot.js';
import {
  buildHumanDialogueTurn,
  buildHumanProposalIntro,
  classifyHumanConversationalAct,
  enrichRequirementsWithOpenDomain,
  extractOpenDomainTopic,
  extractOpenDomainTopicFromMessages,
  isReplyTooSimilar,
  resolveDomainGuidanceFromIndustry,
} from '../../custom/support-setup-copilot/human-dialogue.js';

function assertNoRoboticNumberedForm(reply: string) {
  expect(reply).not.toMatch(/(?:^|\n)\s*1\.\s+.*\n\s*2\.\s+/);
  expect(reply).not.toContain('Lĩnh vực kinh doanh / sản phẩm chính của bạn');
  expect(reply).not.toContain('Để bản kế hoạch hoàn chỉnh hơn, bạn bổ sung giúp mình thêm:');
}

describe('AI Support Setup Copilot — Human-Like Dialogue & Open-Domain Understanding', () => {
  describe('extractOpenDomainTopic & open-domain enrichment', () => {
    it('extracts curated and niche businesses naturally in Vietnamese and English', () => {
      const boardgame = extractOpenDomainTopic('tôi đang có web boardgame, và muốn setup', 'vi');
      expect(boardgame).not.toBeNull();
      expect(boardgame?.industryVi).toContain('Boardgame');
      expect(boardgame?.shortLabelVi.toLowerCase()).toContain('boardgame');
      expect(boardgame?.customerScenariosVi.length).toBeGreaterThanOrEqual(3);
      expect(boardgame?.seedFaqHintVi.toLowerCase()).toContain('boardgame');

      const cafe = extractOpenDomainTopic('mình mới mở quán cà phê acoustic ở Đà Lạt', 'vi');
      expect(cafe).not.toBeNull();
      expect(cafe?.industryVi).toContain('cà phê');

      const sneaker = extractOpenDomainTopic('bên mình là shop giày sneaker chính hãng', 'vi');
      expect(sneaker).not.toBeNull();
      expect(sneaker?.industryVi).toContain('Sneaker');

      const yoga = extractOpenDomainTopic('tôi đang quản lý phòng tập yoga cho người đi làm', 'vi');
      expect(yoga).not.toBeNull();
      expect(yoga?.industryVi).toContain('Yoga');

      const studio = extractOpenDomainTopic('em có studio chụp ảnh kỷ yếu và chân dung', 'vi');
      expect(studio).not.toBeNull();
      expect(studio?.industryVi).toContain('Studio');

      const chineseCourse = extractOpenDomainTopic('bên mình bán khóa học tiếng Trung giao tiếp', 'vi');
      expect(chineseCourse).not.toBeNull();
      expect(chineseCourse?.industryVi).toContain('ngoại ngữ');

      const accounting = extractOpenDomainTopic('công ty mình làm dịch vụ kế toán thuế trọn gói', 'vi');
      expect(accounting).not.toBeNull();
      expect(accounting?.industryVi).toContain('Kế toán');
    });

    it('extracts arbitrary unseen open-domain businesses, communities, and services without hardcoded keywords', () => {
      const pottery = extractOpenDomainTopic('tôi mới mở tiệm gốm thủ công, muốn setup chatbot', 'vi');
      expect(pottery).not.toBeNull();
      expect(pottery?.source).toBe('open_phrase');
      expect(pottery?.industryVi.toLowerCase()).toContain('gốm thủ công');

      const camping = extractOpenDomainTopic('bên mình chuyên cho thuê lều cắm trại dã ngoại', 'vi');
      expect(camping).not.toBeNull();
      expect(camping?.industryVi.toLowerCase()).toContain('lều cắm trại');

      const aquascape = extractOpenDomainTopic('mình đang xây cộng đồng nuôi cá thủy sinh', 'vi');
      expect(aquascape).not.toBeNull();
      expect(aquascape?.industryVi.toLowerCase()).toContain('cá thủy sinh');

      const vinylEn = extractOpenDomainTopic(
        'I run a vintage vinyl record shop and want to set up customer support',
        'en',
      );
      expect(vinylEn).not.toBeNull();
      expect(vinylEn?.industryEn.toLowerCase()).toContain('vintage vinyl record shop');

      const solarEn = extractOpenDomainTopic(
        'we offer solar panel installation for residential homes',
        'en',
      );
      expect(solarEn).not.toBeNull();
      expect(solarEn?.industryEn.toLowerCase()).toContain('solar panel installation');
    });

    it('returns null for generic setup requests, meta questions, pushback, and affirmations', () => {
      const negatives = [
        'Hãy thiết lập giúp cho shop của tôi một con AI Support',
        'Setup tự động giúp tôi một con AI Support',
        'Hoàn thiện cấu hình tiêu chuẩn cho tenant hiện tại',
        'bạn có thể làm gì mà',
        'sao trả lời cứng nhắc thế',
        'tư vấn cho mình đi',
        'ok lên kế hoạch luôn đi',
        'chưa có website đâu',
        'xin chào bạn',
        'Tạo mới 1 tenant AI Support tên HackTenant',
      ];
      for (const msg of negatives) {
        expect(extractOpenDomainTopic(msg, 'vi')).toBeNull();
      }
    });

    it('preserves extracted topic across multi-turn history and resolves guidance from industry strings', () => {
      const history: SupportSetupChatMessage[] = [
        { role: 'user', content: 'tôi đang có web boardgame, và muốn setup' },
        { role: 'assistant', content: 'Ồ làm web boardgame hay quá bạn ơi!' },
        { role: 'user', content: 'bạn có thể làm gì mà' },
      ];
      const topic = extractOpenDomainTopicFromMessages(history, 'vi');
      expect(topic?.industryVi).toContain('Boardgame');

      const { requirements } = enrichRequirementsWithOpenDomain(history, {}, 'vi');
      expect(requirements.industry).toBe('Boardgame / Trò chơi bàn');

      const guidance = resolveDomainGuidanceFromIndustry('Boardgame / Trò chơi bàn', 'vi');
      expect(guidance?.widgetQuickPromptsVi.length).toBe(3);
    });
  });

  describe('Exact user screenshot regression: web boardgame -> bạn có thể làm gì mà', () => {
    it('responds like a warm human consultant to "tôi đang có web boardgame, và muốn setup" without dumping a form or asking their industry', () => {
      const turnA = buildHumanDialogueTurn({
        locale: 'vi',
        activeTenantName: 'EXE',
        targetMode: 'update_tenant',
        messages: [{ role: 'user', content: 'tôi đang có web boardgame, và muốn setup' }],
      });

      expect(turnA.intent).toBe('gather_requirements');
      expect(turnA.shouldProposeNow).toBe(false);
      expect(turnA.extractedRequirements.industry).toBe('Boardgame / Trò chơi bàn');

      // Warm, specific boardgame acknowledgment + realistic customer scenarios
      expect(turnA.reply.toLowerCase()).toContain('boardgame');
      expect(turnA.reply).toMatch(/số người chơi|luật chơi|bọc bài|sleeves|thiếu thành phần/i);
      assertNoRoboticNumberedForm(turnA.reply);

      // Must NEVER ask what their industry is when they just told us!
      expect(
        turnA.missingQuestions.some((q) => /lĩnh vực kinh doanh|mảng kinh doanh/i.test(q)),
      ).toBe(false);

      // Tailored quick-reply chips specific to Boardgame
      expect(
        turnA.suggestedQuickReplies.some((chip) => /boardgame/i.test(chip)),
      ).toBe(true);

      // Turn B: user follows up with "bạn có thể làm gì mà"
      const turnB = buildHumanDialogueTurn({
        locale: 'vi',
        activeTenantName: 'EXE',
        targetMode: 'update_tenant',
        messages: [
          { role: 'user', content: 'tôi đang có web boardgame, và muốn setup' },
          { role: 'assistant', content: turnA.reply },
          { role: 'user', content: 'bạn có thể làm gì mà' },
        ],
      });

      expect(turnB.act).toBe('capability_or_pushback');
      expect(turnB.intent).toBe('guide');
      expect(turnB.shouldProposeNow).toBe(false);
      assertNoRoboticNumberedForm(turnB.reply);
      expect(turnB.reply).not.toBe(turnA.reply);
      expect(isReplyTooSimilar(turnB.reply, [turnA.reply])).toBe(false);
      // Remembers their boardgame website naturally while explaining capabilities!
      expect(turnB.reply.toLowerCase()).toContain('boardgame');
    });
  });

  describe('Broad human conversational acts: capability, frustration, hesitation, affirmations', () => {
    it('understands diverse Vietnamese and English capability / pushback phrasings', () => {
      const capabilityInputs: Array<[string, 'vi' | 'en']> = [
        ['bạn có thể làm gì mà', 'vi'],
        ['bạn làm được gì', 'vi'],
        ['mày biết làm gì', 'vi'],
        ['em giúp được gì', 'vi'],
        ['bạn có thể nói tiếng việt không', 'vi'],
        ['what can you actually do', 'en'],
      ];

      for (const [input, locale] of capabilityInputs) {
        expect(classifyHumanConversationalAct(input)).toBe('capability_or_pushback');
        const res = buildHumanDialogueTurn({
          locale,
          messages: [{ role: 'user', content: input }],
        });
        expect(res.intent).toBe('guide');
        expect(res.shouldProposeNow).toBe(false);
        assertNoRoboticNumberedForm(res.reply);
      }

      // Teaching an English conversation course is a business domain, NOT a language-switch command
      expect(
        classifyHumanConversationalAct('mình dạy giao tiếp tiếng Anh cho người đi làm'),
      ).toBe('business_context');
    });

    it('apologizes warmly like a real human on stiffness/frustration complaints', () => {
      const complaints: Array<[string, 'vi' | 'en']> = [
        ['sao trả lời cứng nhắc thế', 'vi'],
        ['sao cứng nhắc vậy', 'vi'],
        ['hỏi nhiều quá', 'vi'],
        ['nói chuyện như máy vậy', 'vi'],
        ['đừng lặp lại nữa', 'vi'],
        ['why are you so robotic and asking too many questions', 'en'],
      ];

      for (const [complaint, locale] of complaints) {
        expect(classifyHumanConversationalAct(complaint)).toBe('frustration_pushback');
        const res = buildHumanDialogueTurn({
          locale,
          messages: [{ role: 'user', content: complaint }],
        });
        expect(res.intent).toBe('guide');
        expect(res.reply).toMatch(/xin lỗi|sorry|apologies/i);
        assertNoRoboticNumberedForm(res.reply);
      }
    });

    it('coaches gently without jargon when users hesitate or ask for advice', () => {
      const hesitations: Array<[string, 'vi' | 'en']> = [
        ['tôi chưa biết bắt đầu từ đâu', 'vi'],
        ['tư vấn cho mình đi', 'vi'],
        ['tư vấn giúp mình', 'vi'],
        ['mình không rành kỹ thuật', 'vi'],
        ['gợi ý giúp mình', 'vi'],
        ['I am not technical and do not know where to start', 'en'],
      ];

      for (const [text, locale] of hesitations) {
        expect(classifyHumanConversationalAct(text)).toBe('hesitation_or_advice');
        const res = buildHumanDialogueTurn({
          locale,
          messages: [{ role: 'user', content: text }],
        });
        expect(res.intent).toBe('guide');
        expect(res.shouldProposeNow).toBe(false);
        assertNoRoboticNumberedForm(res.reply);
      }
    });

    it('triggers shouldProposeNow=true on short affirmations and tailored draft chips, while respecting read-only mode', () => {
      const affirmations = [
        'ok',
        'ừ',
        'được đó',
        'làm đi',
        'triển luôn',
        'lên kế hoạch đi',
        'ok lên kế hoạch luôn đi',
        'ok bạn',
        'Lên luôn bản mẫu cho shop Boardgame để mình xem',
      ];

      for (const aff of affirmations) {
        expect(classifyHumanConversationalAct(aff)).toBe('affirmation_proceed');
        const res = buildHumanDialogueTurn({
          locale: 'vi',
          messages: [
            { role: 'user', content: 'tôi đang có web boardgame, và muốn setup' },
            { role: 'assistant', content: 'Ồ làm web boardgame hay quá bạn ơi!' },
            { role: 'user', content: aff },
          ],
        });
        expect(res.shouldProposeNow).toBe(true);
        expect(res.intent).toBe('propose_setup');
        expect(res.extractedRequirements.industry).toBe('Boardgame / Trò chơi bàn');
      }

      // Read-only viewer guard: even if user says "ok lên kế hoạch luôn đi", never propose
      const readOnlyTurn = buildHumanDialogueTurn({
        locale: 'vi',
        canCreateTenant: false,
        canEditAny: false,
        messages: [{ role: 'user', content: 'ok lên kế hoạch luôn đi' }],
      });
      expect(readOnlyTurn.shouldProposeNow).toBe(false);
      expect(readOnlyTurn.intent).toBe('guide');
      expect(readOnlyTurn.reply).toContain('Read-Only');
    });
  });

  describe('Multi-turn progression & strict anti-repetition guarantee', () => {
    it('progresses smoothly across boardgame -> stiffness complaint -> no website -> ok lên kế hoạch luôn đi with zero repetition', () => {
      const messages: SupportSetupChatMessage[] = [];
      const assistantHistory: string[] = [];

      const userTurns = [
        'tôi đang có web boardgame, và muốn setup',
        'sao trả lời cứng nhắc vậy',
        'chưa có website đâu',
        'ok lên kế hoạch luôn đi',
      ];

      let lastResult = null;
      for (const userText of userTurns) {
        messages.push({ role: 'user', content: userText });
        const turn = buildHumanDialogueTurn({
          locale: 'vi',
          activeTenantName: 'EXE',
          targetMode: 'update_tenant',
          messages,
        });
        expect(isReplyTooSimilar(turn.reply, assistantHistory)).toBe(false);
        assertNoRoboticNumberedForm(turn.reply);
        assistantHistory.push(turn.reply);
        messages.push({ role: 'assistant', content: turn.reply });
        lastResult = turn;
      }

      expect(new Set(assistantHistory).size).toBe(userTurns.length);
      expect(lastResult?.shouldProposeNow).toBe(true);
      expect(lastResult?.intent).toBe('propose_setup');
      expect(lastResult?.extractedRequirements.industry).toBe('Boardgame / Trò chơi bàn');
      expect(lastResult?.extractedRequirements.websiteOrigin).toBe('*');
    });

    it('never repeats or near-repeats any assistant reply across 6 consecutive vague user turns', () => {
      const messages: SupportSetupChatMessage[] = [];
      const assistantReplies: string[] = [];

      const vagueTurns = [
        'mình muốn tìm hiểu chút',
        'hmm chưa rõ nữa',
        'để mình nghĩ xem sao',
        'hơi phân vân quá',
        'vẫn chưa biết nói sao',
        'còn gì nữa nhỉ',
      ];

      for (const vague of vagueTurns) {
        messages.push({ role: 'user', content: vague });
        const res = buildHumanDialogueTurn({
          locale: 'vi',
          messages,
        });
        expect(isReplyTooSimilar(res.reply, assistantReplies)).toBe(false);
        assertNoRoboticNumberedForm(res.reply);
        assistantReplies.push(res.reply);
        messages.push({ role: 'assistant', content: res.reply });
      }

      expect(new Set(assistantReplies).size).toBe(vagueTurns.length);
    });
  });

  describe('buildHumanProposalIntro', () => {
    it('introduces pending_consent proposals warmly like a human teammate and adapts on refinement without repeating', () => {
      const mockSteps = Array.from({ length: 7 }, (_, idx) => ({
        stepId: 'tenant_ai',
        canApply: idx < 6,
        enabledByDefault: idx < 6,
        titleEn: 'Step',
        titleVi: 'Bước',
        summaryEn: 'Summary',
        summaryVi: 'Tóm tắt',
        highlightsEn: [],
        highlightsVi: [],
        payload: {},
      })) as unknown as SupportSetupPlannedStep[];

      const mockProposal: Pick<
        SupportSetupProposal,
        'tenantName' | 'tenantSlug' | 'targetMode' | 'requirements' | 'steps'
      > = {
        tenantName: 'Meeple House',
        tenantSlug: 'meeple-house',
        targetMode: 'create_tenant',
        requirements: {
          brandName: 'Meeple House',
          industry: 'Boardgame / Trò chơi bàn',
          primaryColor: '#ea580c',
          requireContactIntake: false,
        },
        steps: mockSteps,
      };

      const initialIntro = buildHumanProposalIntro({
        locale: 'vi',
        proposal: mockProposal,
      });

      expect(initialIntro.reply).toContain('Meeple House');
      expect(initialIntro.reply).toContain('Boardgame');
      expect(initialIntro.reply).toContain('Chờ xác nhận triển khai');
      expect(initialIntro.reply).toContain('6/7');
      expect(initialIntro.suggestedQuickReplies.length).toBeGreaterThanOrEqual(2);

      const refinementIntro = buildHumanProposalIntro({
        locale: 'vi',
        proposal: mockProposal,
        isRefinement: true,
        priorMessages: [{ role: 'assistant', content: initialIntro.reply }],
      });

      expect(refinementIntro.reply).toContain('Chờ xác nhận triển khai');
      expect(isReplyTooSimilar(refinementIntro.reply, [initialIntro.reply])).toBe(false);

      const enIntro = buildHumanProposalIntro({
        locale: 'en',
        proposal: {
          ...mockProposal,
          requirements: {
            ...mockProposal.requirements,
            industry: 'Board Games & Tabletop',
          },
        },
      });
      expect(enIntro.reply).toContain('Consent Required');
      expect(enIntro.reply).toContain('Board Games & Tabletop');
    });

    it('avoids nested broken Markdown bold, handles unaccented Vietnamese capability/topic turns, and omits self-echoing capability chips', () => {
      // 1. Turn-1 boardgame reply must have clean balanced `**` markers (no nested `**...**...**...**`)
      const turnA = buildHumanDialogueTurn({
        locale: 'vi',
        activeTenantName: 'EXE',
        targetMode: 'update_tenant',
        messages: [{ role: 'user', content: 'tôi đang có web boardgame, và muốn setup' }],
      });
      expect(turnA.reply).not.toContain('**dựng luôn bản mẫu trợ lý AI cho **');
      const boldTokenCount = (turnA.reply.match(/\*\*/g) ?? []).length;
      expect(boldTokenCount % 2).toBe(0);

      // 2. Unaccented Vietnamese topic + capability pushback ("toi dang co web boardgame va muon setup" -> "ban co the lam gi ma")
      const unaccentedTopic = extractOpenDomainTopic('toi dang co web boardgame va muon setup', 'vi');
      expect(unaccentedTopic?.industryVi).toBe('Boardgame / Trò chơi bàn');
      expect(unaccentedTopic?.shortLabelVi.toLowerCase()).toBe('web boardgame');

      expect(classifyHumanConversationalAct('ban co the lam gi ma')).toBe('capability_or_pushback');

      // 3. After answering "ban co the lam gi ma", suggestedQuickReplies must NOT self-echo "Bạn có thể làm được những gì cho web của mình?"
      const capTurn = buildHumanDialogueTurn({
        locale: 'vi',
        activeTenantName: 'EXE',
        targetMode: 'update_tenant',
        messages: [
          { role: 'user', content: 'toi dang co web boardgame, va muon setup' },
          { role: 'assistant', content: turnA.reply },
          { role: 'user', content: 'ban co the lam gi ma' },
        ],
      });
      expect(capTurn.intent).toBe('guide');
      expect(
        capTurn.suggestedQuickReplies.some((q) => /bạn có thể làm được những gì/i.test(q)),
      ).toBe(false);
    });
  });

  describe('Phase 3: permission_grant_revoke act', () => {
    it('classifies grant/revoke sentences as permission_grant_revoke', () => {
      const grantSentences = [
        'cấp quyền view_users cho lan@example.com',
        'Cấp quyền view_users, edit_settings cho lan@example.com',
        'thu hồi quyền view_users của lan@example.com',
        'grant view_users to lan@example.com',
        'revoke view_users from lan@example.com',
        'cấp quyền view_tenant_ai cho lan@example.com trên tenant acme',
        'cho lan@example.com làm ai_configurator trên tenant acme',
        'gỡ lan@example.com khỏi tenant acme',
      ];
      for (const text of grantSentences) {
        expect(
          classifyHumanConversationalAct(text),
          `Expected permission_grant_revoke for: ${text}`,
        ).toBe('permission_grant_revoke');
      }
    });

    it('still classifies identity questions and key rotations as before', () => {
      expect(classifyHumanConversationalAct('tôi có quyền gì?')).toBe(
        'identity_or_permissions',
      );
      expect(classifyHumanConversationalAct('what are my permissions')).toBe(
        'identity_or_permissions',
      );
      // No email + no grant target: not a grant/revoke act.
      expect(classifyHumanConversationalAct('xoay API key giúp mình')).not.toBe(
        'permission_grant_revoke',
      );
    });
  });
});
