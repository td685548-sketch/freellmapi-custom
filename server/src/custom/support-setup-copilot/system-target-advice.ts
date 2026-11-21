/**
 * Advice + "why?" answers for the System target (and any caller of it).
 *
 * The System target is deterministic by design (no model call), so this module
 * answers from two grounded sources only: the live advisor (`system-advisor.ts`,
 * measured state, permission-mirrored) and the product knowledge base (the
 * `setting:*` entries). It never stages a change itself — it offers quick replies
 * that go through the normal intent parser and Consent Card.
 */
import type {
  SupportSetupChatMessage,
  SupportSetupChatResponse,
  SupportSystemSettingId,
} from '@freellmapi/shared/support-setup-copilot.js';
import type { SessionUser } from '../../services/auth.js';
import { searchKbLexical } from './kb/index.js';
import { buildKbQueryFromMessages } from './kb/prompt.js';
import { buildSystemAdvice, type SystemAdviceItem } from './system-advisor.js';

function fold(input: string): string {
  return input
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const WHY_RE =
  /\b(?:tai\s+sao|vi\s+sao|giai\s+thich|co\s+nen|nen\s+khong|why|explain|should\s+i|is\s+it\s+worth|dang\s+de\s+bat)\b/;
const ADVICE_RE =
  /\b(?:goi\s+y|de\s+xuat\s+(?:cho\s+)?(?:minh|toi)|nen\s+(?:bat|tat|chinh|doi|cau\s+hinh)\s+(?:gi|nhung\s+gi|nhung\s+cai\s+nao)|toi\s+uu(?:\s+he\s+thong)?|tinh\s+trang\s+he\s+thong|kiem\s+tra\s+(?:he\s+thong|cau\s+hinh)|recommend|suggest|what\s+should\s+i\s+(?:change|turn|enable|do)|optimi[sz]e|health\s+check|review\s+my\s+(?:system|settings))\b/;

/** Command-style quick replies that the deterministic intent parser already understands. */
const ENABLE_COMMANDS: Readonly<Record<string, { vi: string; en: string }>> = {
  enable_retrieval: { vi: 'Bật retrieval', en: 'Turn on retrieval' },
  enable_response_cache: { vi: 'Bật response cache', en: 'Turn on response cache' },
  enable_prompt_compression: { vi: 'Bật nén prompt lossless', en: 'Turn on prompt compression lossless' },
};

function renderItem(item: SystemAdviceItem, locale: 'vi' | 'en'): string {
  const title = locale === 'vi' ? item.titleVi : item.titleEn;
  const reason = locale === 'vi' ? item.reasonVi : item.reasonEn;
  const evLabel = locale === 'vi' ? 'Căn cứ đo được' : 'Measured evidence';
  return `**${title}**\n${reason}\n_${evLabel}:_ ${item.evidence.join(' ')}`;
}

function unreadableLine(unreadable: string[], locale: 'vi' | 'en'): string {
  if (unreadable.length === 0) return '';
  return locale === 'vi'
    ? `\n\nMình **chưa đọc được** lúc này: ${unreadable.join(', ')} — nên chưa thể kết luận phần đó ổn hay không.`
    : `\n\nI **could not read** just now: ${unreadable.join(', ')} — so I cannot say whether that part is fine.`;
}

function respond(
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
    suggestedQuickReplies: quick.slice(0, 4),
    proposal: null,
    userDiagnostic: null,
    actionProposal: null,
    modelUsed: null,
    usedFallback: true,
  };
}

/** Returns a reply when the latest message asks for advice or for the reason behind a setting; otherwise null. */
export function tryBuildSystemAdviceReply(params: {
  user: SessionUser;
  messages: SupportSetupChatMessage[];
  locale: 'vi' | 'en';
  currentPath?: string;
}): SupportSetupChatResponse | null {
  const { user, messages, locale, currentPath } = params;
  const latest = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const folded = fold(latest);
  if (!folded) return null;

  const isWhy = WHY_RE.test(folded);
  const isAdvice = ADVICE_RE.test(folded);
  if (!isWhy && !isAdvice) return null;

  const advice = buildSystemAdvice(user);

  // "Why should I enable X?" — explain from the setting's knowledge entry plus what the advisor measured for it.
  if (isWhy) {
    const hits = searchKbLexical(buildKbQueryFromMessages(messages, currentPath), {
      caller: user,
      limit: 4,
      locale,
      currentPath,
    });
    const lead = hits.find((h) => h.chunk.id.startsWith('setting:'));
    if (lead) {
      const settingId = lead.chunk.id.slice('setting:'.length) as SupportSystemSettingId;
      const title = locale === 'vi' && lead.chunk.titleVi ? lead.chunk.titleVi : lead.chunk.title;
      const body = locale === 'vi' && lead.chunk.textVi ? lead.chunk.textVi : lead.chunk.text;
      const mine = advice.items.filter((i) => i.settingId === settingId);
      const parts: string[] = [`**${title}**`, body];
      if (mine.length > 0) {
        parts.push(locale === 'vi' ? '**Với hệ thống của bạn lúc này:**' : '**On your system right now:**');
        parts.push(...mine.map((i) => renderItem(i, locale)));
      } else {
        parts.push(
          locale === 'vi'
            ? '**Với hệ thống của bạn lúc này:** mình không thấy số liệu nào đang ủng hộ việc đổi cài đặt này, nên chưa gợi ý thay đổi.'
            : '**On your system right now:** I see no measured signal arguing for changing this, so I am not suggesting a change.',
        );
      }
      const quick = mine
        .filter((i) => i.kind === 'recommend' && ENABLE_COMMANDS[i.id])
        .map((i) => ENABLE_COMMANDS[i.id]![locale]);
      return respond(parts.join('\n\n') + unreadableLine(advice.unreadable, locale), quick, locale);
    }
    if (!isAdvice) return null;
  }

  // Open advice request.
  const lines: string[] = [];
  if (advice.items.length === 0) {
    lines.push(
      locale === 'vi'
        ? 'Mình vừa đo trạng thái hệ thống và **chưa thấy cài đặt nào cần đổi ngay** trong phạm vi quyền của bạn. Nếu bạn muốn, hỏi mình "tại sao nên bật …" để mình giải thích từng tính năng và nó có hợp với hệ thống của bạn không.'
        : 'I just measured the system and **see nothing that needs changing right now** within your permissions. Ask "why should I enable …" and I will explain a feature and whether it fits your system.',
    );
  } else {
    lines.push(
      locale === 'vi'
        ? 'Mình vừa đo trạng thái hệ thống của bạn và có các gợi ý sau (mình chưa đổi gì — bạn duyệt thì mới áp dụng):'
        : 'I just measured your system and have these suggestions (nothing has changed — it only applies after you approve):',
    );
    advice.items.forEach((item, i) => lines.push(`${i + 1}. ${renderItem(item, locale)}`));
  }
  if (advice.hiddenAreas.length > 0) {
    lines.push(
      locale === 'vi'
        ? `Có ${advice.hiddenAreas.length} nhóm cài đặt mình không xem được cho bạn vì tài khoản chưa có quyền tương ứng (${advice.hiddenAreas.map((h) => `\`${h.requiredPermission}\``).join(', ')}).`
        : `${advice.hiddenAreas.length} settings area(s) are not visible to you because your account lacks the permission (${advice.hiddenAreas.map((h) => `\`${h.requiredPermission}\``).join(', ')}).`,
    );
  }
  const quick = advice.items
    .filter((i) => i.kind === 'recommend' && ENABLE_COMMANDS[i.id])
    .map((i) => ENABLE_COMMANDS[i.id]![locale]);
  return respond(lines.join('\n\n') + unreadableLine(advice.unreadable, locale), quick, locale);
}
