/**
 * "System" Target for the Setup Copilot — platform-wide scope for full-power
 * admins (wildcard permission). Unlike a tenant Target it never touches a
 * Support Tenant: it only offers the 9 system settings (consent-gated
 * proposals, applied by the existing Consent Card flow) and platform guidance.
 * Identity, Error Doctor, personal actions and permission grant/revoke are
 * handled earlier by the router, exactly as for every other Target.
 *
 * Deterministic on purpose (no LLM call): the system-settings evaluator and
 * the platform guide are already the source of truth for these questions.
 */
import type { SupportSetupChatMessage, SupportSetupChatResponse } from '@freellmapi/shared/support-setup-copilot.js';
import { permissionGranted } from '@freellmapi/shared/permissions.js';
import type { SessionUser } from '../../services/auth.js';
import { buildPlatformExpertReply, matchPlatformKnowledgeQuestion } from './platform-guide.js';
import { resolveSystemSettingsTurnResponse } from './playbook.js';
import { evaluateSystemSettingsProposal } from './system-settings.js';
import { SupportSetupCopilotError } from './store.js';

/** The System Target is for full-power admins only (primary admin or `*`). */
export function canUseSystemTarget(user: SessionUser | undefined): boolean {
  return permissionGranted(user, '*');
}

export function buildSystemTargetOverviewReply(locale: 'vi' | 'en'): string {
  return locale === 'vi'
    ? [
        'Bạn đang ở mục tiêu **Toàn hệ thống** (quyền admin đầy đủ). Ở đây mình không chỉnh tenant nào — mình giúp bạn với:',
        '- **Cài đặt hệ thống**: Thruline gateway, token savers, route-health TTL, response cache, nén prompt, hợp nhất model, MCP server, kiểm tra cập nhật, Ollama emulation.',
        '- **Phân quyền**: cấp hoặc thu hồi quyền toàn cục cho người dùng khác.',
        '- **Hướng dẫn nền tảng**: hỏi mình tính năng nào nằm ở đâu và dùng ra sao.',
        'Mọi thay đổi đều chỉ là **đề xuất** — bạn bấm Duyệt trên thẻ xác nhận thì mới áp dụng.',
      ].join('\n')
    : [
        'You are on the **System-wide** target (full admin access). I will not touch any tenant here — I can help with:',
        '- **System settings**: Thruline gateway, token savers, route-health TTL, response cache, prompt compression, model unification, MCP server, update checks, Ollama emulation.',
        '- **Permissions**: grant or revoke global permissions for other users.',
        '- **Platform guidance**: ask where a feature lives and how to use it.',
        'Every change is only a **proposal** — nothing is applied until you approve it on the Consent Card.',
      ].join('\n');
}

export function systemTargetQuickReplies(locale: 'vi' | 'en'): string[] {
  return locale === 'vi'
    ? [
        'Bật response cache',
        'Bật nén prompt',
        'Bạn có thể hỗ trợ bật/tắt những cài đặt hệ thống nào?',
        'Quyền của tôi là gì?',
      ]
    : [
        'Turn on the response cache',
        'Turn on prompt compression',
        'What system settings can you help toggle?',
        'What are my permissions?',
      ];
}

export function handleSystemTargetChatTurn(params: {
  user: SessionUser;
  messages: SupportSetupChatMessage[];
  locale: 'vi' | 'en';
  currentPath?: string;
}): SupportSetupChatResponse {
  const { user, messages, locale, currentPath } = params;
  if (!canUseSystemTarget(user)) {
    throw new SupportSetupCopilotError(
      403,
      'forbidden',
      'The System target is only available to administrators with full access.',
    );
  }

  const latest = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';

  const systemResponse = resolveSystemSettingsTurnResponse({
    evalResult: evaluateSystemSettingsProposal({ user, messages, locale }),
    userId: user.userId,
    locale,
  });
  if (systemResponse) return systemResponse;

  const platformMatch = matchPlatformKnowledgeQuestion(latest, currentPath);
  if (platformMatch) {
    const expert = buildPlatformExpertReply({
      match: platformMatch,
      locale,
      currentPath,
      diagnostic: null,
      canCreateTenant: false,
      canEditAny: false,
      priorAssistantMessages: messages.filter((m) => m.role === 'assistant').map((m) => m.content),
    });
    return {
      ok: true,
      replyLocale: locale,
      reply: expert.reply,
      intent: 'guide',
      missingQuestions: [],
      suggestedQuickReplies: expert.suggestedQuickReplies,
      proposal: null,
      userDiagnostic: null,
      actionProposal: null,
      modelUsed: null,
      usedFallback: true,
    };
  }

  return {
    ok: true,
    replyLocale: locale,
    reply: buildSystemTargetOverviewReply(locale),
    intent: 'guide',
    missingQuestions: [],
    suggestedQuickReplies: systemTargetQuickReplies(locale),
    proposal: null,
    userDiagnostic: null,
    actionProposal: null,
    modelUsed: null,
    usedFallback: true,
  };
}
