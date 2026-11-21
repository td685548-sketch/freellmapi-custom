/**
 * "System" Target for the Setup Copilot — platform-wide scope for any account
 * that can change at least one system setting (admins with the wildcard permission
 * can change all of them; delegated accounts only the ones they hold). Unlike a tenant Target it never touches a
 * Support Tenant: it only offers the system settings (consent-gated
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
import { tryGroundedGuideReply } from './grounded-guide.js';
import type { CopilotLlmCall } from './agent-loop.js';
import type { GatewayLoopbackContext } from './llm-coach.js';
import { buildPlatformExpertReply, matchPlatformKnowledgeQuestion } from './platform-guide.js';
import { resolveSystemSettingsTurnResponse } from './playbook.js';
import { evaluateSystemSettingsProposal, hasAnySystemSettingPermission } from './system-settings.js';
import { SupportSetupCopilotError } from './store.js';
import { traceDone } from './trace.js';
import { tryBuildSystemAdviceReply } from './system-target-advice.js';

/**
 * The System Target is offered to whoever could change at least one system setting by hand
 * (primary admin / `*`, or any delegated `edit_*` system permission). What they can actually
 * stage is still filtered per setting by the permission that setting needs, and re-checked
 * live when they approve — so the Copilot has exactly the user's own authority, no more.
 */
export function canUseSystemTarget(user: SessionUser | undefined): boolean {
  return permissionGranted(user, '*') || hasAnySystemSettingPermission(user);
}

export function buildSystemTargetOverviewReply(locale: 'vi' | 'en'): string {
  return locale === 'vi'
    ? [
        'Bạn đang ở mục tiêu **Toàn hệ thống** (mình chỉ làm được đúng những gì tài khoản của bạn có quyền). Ở đây mình không chỉnh tenant nào — mình giúp bạn với:',
        '- **Cài đặt hệ thống**: Thruline gateway, token savers, route-health TTL, response cache, nén prompt, hợp nhất model, MCP server, kiểm tra cập nhật, Ollama emulation, và **công tắc AI Platform** (vector hóa tài liệu/Retrieval, prompt cache, output guard…).',
        '- **Gợi ý theo trạng thái thật**: hỏi "nên chỉnh gì?" — mình đo hệ thống rồi nêu gợi ý kèm lý do và số liệu; hỏi "tại sao nên bật …" để mình giải thích.',
        '- **Phân quyền**: cấp hoặc thu hồi quyền toàn cục cho người dùng khác.',
        '- **Hướng dẫn nền tảng**: hỏi mình tính năng nào nằm ở đâu và dùng ra sao.',
        'Mọi thay đổi đều chỉ là **đề xuất** — bạn bấm Duyệt trên thẻ xác nhận thì mới áp dụng.',
      ].join('\n')
    : [
        'You are on the **System-wide** target (I can only do what your own account is permitted to do). I will not touch any tenant here — I can help with:',
        '- **System settings**: Thruline gateway, token savers, route-health TTL, response cache, prompt compression, model unification, MCP server, update checks, Ollama emulation, and the **AI Platform switches** (document vectorization/Retrieval, prompt cache, output guard…).',
        '- **Advice from the real state**: ask "what should I change?" — I measure the system and answer with reasons and numbers; ask "why enable …" for an explanation.',
        '- **Permissions**: grant or revoke global permissions for other users.',
        '- **Platform guidance**: ask where a feature lives and how to use it.',
        'Every change is only a **proposal** — nothing is applied until you approve it on the Consent Card.',
      ].join('\n');
}

export function systemTargetQuickReplies(locale: 'vi' | 'en'): string[] {
  return locale === 'vi'
    ? [
        'Bạn gợi ý mình nên chỉnh gì?',
        'Bật response cache',
        'Bạn có thể hỗ trợ bật/tắt những cài đặt hệ thống nào?',
        'Quyền của tôi là gì?',
      ]
    : [
        'What would you recommend I change?',
        'Turn on the response cache',
        'What system settings can you help toggle?',
        'What are my permissions?',
      ];
}

/** A bare greeting / thanks: the overview is the right answer to these. */
const GREETING_RE =
  /^(?:xin\s+chao|chao|hello|hi|hey|alo|help|tro\s+giup|giup\s+toi|giup\s+minh|cam\s+on|thanks?|thank\s+you|ok(?:ay)?)\b[\s\S]{0,20}$/;

function foldForGreeting(input: string): string {
  return input
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[\u0111\u0110]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Last-resort reply when nothing recognised the message and no model answered.
 * It says so plainly instead of reciting the capability list as if it were an answer.
 */
export function buildSystemTargetFallbackReply(rawMessage: string, locale: 'vi' | 'en'): string {
  const overview = buildSystemTargetOverviewReply(locale);
  const folded = foldForGreeting(rawMessage);
  if (!folded || GREETING_RE.test(folded)) return overview;
  const lead =
    locale === 'vi'
      ? 'Mình chưa hiểu câu này là yêu cầu về hệ thống, hoặc nó nằm ngoài việc mình làm được ở đây (mình không biết giờ, thời tiết hay chuyện ngoài web này). Mình **chưa đổi gì**. Nếu bạn muốn nhờ việc liên quan tới hệ thống, hãy nói rõ hơn nhé — ví dụ:'
      : 'I did not recognise that as a request about the system, or it is outside what I can do here (I do not know the time, the weather or anything outside this app). I have **changed nothing**. If you want something about the system, tell me a bit more — for example:';
  return `${lead}\n\n${overview}`;
}

/** Scope rules for the model on the System target (it may answer, but only about this app, and never invent facts). */
const SYSTEM_TARGET_SCOPE_RULES = [
  'SYSTEM-WIDE TARGET RULES (MANDATORY):',
  '- The user is on the System-wide target: there is NO tenant here. Never ask tenant-setup questions (brand, tone, website) and never propose a tenant setup.',
  '- Answer ONLY about this app: its settings, pages, permissions, errors and how to use it, grounded in the retrieved knowledge and live system advice above.',
  '- If the message is outside this app (current time or date, weather, news, general chit-chat), say in one or two friendly sentences that you cannot help with that here and name one or two things you CAN help with. NEVER invent facts such as the time, a date or a number you were not given.',
  '- Always use `intent: "guide"`. To change a system setting the user must ask for it explicitly; you only explain it and the Consent Card flow handles the change.',
].join('\n');

type SystemTargetParams = {
  user: SessionUser;
  messages: SupportSetupChatMessage[];
  locale: 'vi' | 'en';
  currentPath?: string;
};

function assertSystemTargetAccess(user: SessionUser): void {
  if (!canUseSystemTarget(user)) {
    throw new SupportSetupCopilotError(
      403,
      'forbidden',
      'The System target needs permission to change at least one system setting.',
    );
  }
}

function guideResponse(
  reply: string,
  quick: string[],
  locale: 'vi' | 'en',
): SupportSetupChatResponse {
  return {
    ok: true,
    replyLocale: locale,
    reply,
    intent: 'guide',
    missingQuestions: [],
    suggestedQuickReplies: quick,
    proposal: null,
    userDiagnostic: null,
    actionProposal: null,
    modelUsed: null,
    usedFallback: true,
  };
}

/**
 * The rule-based part: settings requests, advice/"why" questions and knowledge-base matches.
 * Returns null when nothing here recognised the message.
 */
function tryDeterministicSystemTurn(params: SystemTargetParams): SupportSetupChatResponse | null {
  const { user, messages, locale, currentPath } = params;
  const latest = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';

  const systemResponse = resolveSystemSettingsTurnResponse({
    evalResult: evaluateSystemSettingsProposal({ user, messages, locale }),
    userId: user.userId,
    user,
    locale,
  });
  traceDone({
    kind: 'analyze',
    titleVi: 'Đối chiếu với các cài đặt hệ thống mình có thể chỉnh',
    titleEn: 'Matching against the system settings I can change',
    detailVi: systemResponse ? 'Khớp một yêu cầu cài đặt' : 'Không phải yêu cầu đổi cài đặt',
    detailEn: systemResponse ? 'Matched a settings request' : 'Not a settings change request',
  });
  if (systemResponse) {
    traceDone({
      kind: 'decide',
      titleVi: 'Lập đề xuất — chờ bạn duyệt trên thẻ xác nhận',
      titleEn: 'Preparing a proposal — waiting for your approval on the Consent Card',
    });
    return systemResponse;
  }

  // "What should I change?" / "why enable X?": answered from measured state + the KB, never from model guesses.
  const adviceResponse = tryBuildSystemAdviceReply({ user, messages, locale, currentPath });
  if (adviceResponse) return adviceResponse;

  const platformMatch = matchPlatformKnowledgeQuestion(latest, currentPath);
  traceDone({
    kind: 'knowledge',
    titleVi: 'Đối chiếu với hướng dẫn nền tảng',
    titleEn: 'Matching against the platform guide',
    detailVi: platformMatch ? 'Có mục hướng dẫn khớp' : 'Không có mục hướng dẫn khớp',
    detailEn: platformMatch ? 'A guide entry matched' : 'No guide entry matched',
  });
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
    return guideResponse(expert.reply, expert.suggestedQuickReplies, locale);
  }
  return null;
}

function systemTargetFallback(params: SystemTargetParams): SupportSetupChatResponse {
  traceDone({
    kind: 'decide',
    titleVi: 'Chưa có cách trả lời chắc chắn — nói rõ điều đó thay vì đoán',
    titleEn: 'No reliable answer — saying so instead of guessing',
  });
  const latest = [...params.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  return guideResponse(
    buildSystemTargetFallbackReply(latest, params.locale),
    systemTargetQuickReplies(params.locale),
    params.locale,
  );
}

/** Rule-based only (no model call): recognised requests, otherwise the honest fallback. */
export function handleSystemTargetChatTurn(params: SystemTargetParams): SupportSetupChatResponse {
  assertSystemTargetAccess(params.user);
  return tryDeterministicSystemTurn(params) ?? systemTargetFallback(params);
}

/**
 * Full System-target turn: the rule-based answers stay first (they are exact and cost nothing, and
 * every setting change goes through the Consent Card), then anything they did not recognise goes to
 * the same grounded agent loop the tenant flow uses (retrieved knowledge + read-only lookup tools),
 * and only if no model answers does the honest fallback reply.
 */
export async function handleSystemTargetChatTurnGrounded(
  params: SystemTargetParams & { gatewayLoopback?: GatewayLoopbackContext; llmCall?: CopilotLlmCall },
): Promise<SupportSetupChatResponse> {
  assertSystemTargetAccess(params.user);
  const deterministic = tryDeterministicSystemTurn(params);
  if (deterministic) return deterministic;
  traceDone({
    kind: 'decide',
    titleVi: 'Không khớp quy tắc nào — chuyển cho mô hình AI trả lời dựa trên kho tri thức',
    titleEn: 'No rule matched — handing it to the AI model, grounded in the knowledge base',
  });
  const grounded = await tryGroundedGuideReply({
    user: params.user,
    messages: params.messages,
    locale: params.locale,
    currentPath: params.currentPath,
    gatewayLoopback: params.gatewayLoopback,
    fallbackQuickReplies: systemTargetQuickReplies(params.locale),
    extraInstructions: SYSTEM_TARGET_SCOPE_RULES,
    ...(params.llmCall ? { llmCall: params.llmCall } : {}),
  });
  return grounded ?? systemTargetFallback(params);
}
