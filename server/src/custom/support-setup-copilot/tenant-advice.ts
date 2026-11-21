/**
 * "Do you suggest anything to fix?" for a selected tenant (and the system, when the
 * caller may change system settings).
 *
 * Grounded only in what the platform measured: the tenant's 7-step readiness
 * diagnostic (what is partial/missing, and the exact rule that makes a step
 * complete), the tenant doctor's findings from its own recent turns, and the
 * permission-filtered system advice. Nothing here changes anything; the quick
 * replies it offers go through the normal Consent Card flows.
 */
import type {
  SupportSetupChatResponse,
  SupportSetupTenantDiagnostic,
} from '@freellmapi/shared/support-setup-copilot.js';
import type { SessionUser } from '../../services/auth.js';
import { getSupportTenant } from '../x-gateway/support-store.js';
import { getKbChunkById } from './kb/corpus.js';
import { buildSystemAdvice } from './system-advisor.js';
import { adviceQuickReplies, isAdviceRequest, renderAdviceItem } from './system-target-advice.js';
import { buildTenantDoctorReport } from './tenant-doctor.js';

const ICON: Record<SupportSetupTenantDiagnostic['steps'][number]['status'], string> = {
  complete: '✅',
  partial: '🟡',
  missing: '⭕',
  restricted: '🔒',
};

/** The sentence that defines "complete" for a step, taken from the knowledge base (never retyped here). */
function completionRule(stepId: string, locale: 'vi' | 'en'): string | null {
  const chunk = getKbChunkById(`step:${stepId}`);
  if (!chunk) return null;
  const text = locale === 'vi' && chunk.textVi ? chunk.textVi : chunk.text;
  const m = (locale === 'vi' ? /HOÀN TẤT khi[^.]*\./ : /COMPLETE when[^.]*\./).exec(text);
  return m ? m[0] : null;
}

/** Topics where "gợi ý …" means "give me a design/content idea", which the normal setup flow handles. */
const CONFIG_TOPIC_RE =
  /\b(?:mau|color|colour|widget|nut\s+chat|loi\s+chao|greeting|giong|tone|faq|tai\s+lieu|domain|ten\s+mien|cors|sla|prompt|slogan|nhan\s+cach|persona|logo|banner)\b/;

/** Advice request in the tenant flow: asks what to change, without naming a specific thing to design. */
export function isTenantAdviceRequest(rawMessage: string): boolean {
  if (!isAdviceRequest(rawMessage)) return false;
  const folded = rawMessage
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[\u0111\u0110]/g, 'd')
    .toLowerCase();
  return !CONFIG_TOPIC_RE.test(folded);
}

export function buildTenantAdviceResponse(params: {
  user: SessionUser;
  diagnostic: SupportSetupTenantDiagnostic | null;
  locale: 'vi' | 'en';
  /** Whether the caller can edit at least one step of this tenant. */
  canEditAny: boolean;
}): SupportSetupChatResponse {
  const { user, diagnostic, locale, canEditAny } = params;
  const vi = locale === 'vi';
  const sections: string[] = [];
  const quick: string[] = [];
  let anythingToSuggest = false;

  if (diagnostic) {
    const open = diagnostic.steps.filter((s) => s.canView !== false && s.status !== 'complete');
    sections.push(
      vi
        ? `Mình vừa kiểm tra **${diagnostic.tenant.name}** — đang **${diagnostic.completedSteps}/${diagnostic.totalSteps}** hạng mục hoàn tất.`
        : `I just checked **${diagnostic.tenant.name}** — **${diagnostic.completedSteps}/${diagnostic.totalSteps}** areas are complete.`,
    );
    if (open.length > 0) {
      anythingToSuggest = true;
      const lines = open.map((step, i) => {
        const n = diagnostic.steps.findIndex((s) => s.stepId === step.stepId) + 1;
        const summary = vi ? step.summaryVi : step.summaryEn;
        const rule = completionRule(step.stepId, locale);
        return `${i + 1}. ${ICON[step.status]} **${vi ? 'Bước' : 'Step'} ${n}**: ${summary}${rule ? `\n   ${rule}` : ''}\n   ${vi ? 'Mở' : 'Open'}: \`${step.thrulinePath}\``;
      });
      sections.push(
        (vi ? '**Những chỗ nên xử lý:**\n' : '**What is worth fixing:**\n') + lines.join('\n'),
      );
      if (canEditAny) {
        quick.push(vi ? 'Hoàn thiện cấu hình tiêu chuẩn cho tenant hiện tại' : 'Auto-complete current tenant with standard defaults');
      }
    } else {
      sections.push(
        vi
          ? 'Cả 7 hạng mục đều đã hoàn tất theo đúng tiêu chí của hệ thống nên mình **chưa thấy mục cấu hình nào cần sửa**.'
          : 'All 7 areas meet the system\'s completion rules, so I **see no configuration area that needs fixing**.',
      );
    }

    // What actually went wrong recently (the tenant's own evidence), not just what is unconfigured.
    try {
      const tenant = getSupportTenant(diagnostic.tenant.id);
      if (tenant) {
        const report = buildTenantDoctorReport({ tenant, diagnostic });
        const real = report.findings.filter((f) => f.severity !== 'info').slice(0, 2);
        if (real.length > 0) {
          anythingToSuggest = true;
          sections.push(
            (vi ? '**Lỗi thực tế gần đây của tenant này:**\n' : '**What actually failed recently on this tenant:**\n') +
              real
                .map(
                  (f) =>
                    `- **${vi ? f.titleVi : f.titleEn}** — ${vi ? f.causeVi : f.causeEn} (${vi ? f.evidenceVi : f.evidenceEn}) → ${vi ? f.fixVi : f.fixEn} (\`${f.path}\`)`,
                )
                .join('\n'),
          );
        }
      }
    } catch {
      sections.push(
        vi
          ? '_Mình chưa đọc được nhật ký lỗi gần đây của tenant lúc này nên chưa kết luận phần đó ổn._'
          : '_I could not read this tenant\'s recent error log just now, so I cannot say that part is fine._',
      );
    }
  }

  // System-level advice, only for what this user may change (permission-mirrored by the advisor).
  const advice = buildSystemAdvice(user);
  if (advice.items.length > 0) {
    anythingToSuggest = true;
    sections.push(
      (vi ? '**Gợi ý ở cấp hệ thống (theo quyền của bạn):**\n' : '**System-level suggestions (within your permissions):**\n') +
        advice.items.map((item, i) => `${i + 1}. ${renderAdviceItem(item, locale)}`).join('\n\n'),
    );
    quick.push(...adviceQuickReplies(advice.items, locale));
  }
  if (advice.unreadable.length > 0) {
    sections.push(
      vi
        ? `_Mình chưa đọc được lúc này: ${advice.unreadable.join(', ')}._`
        : `_Could not read just now: ${advice.unreadable.join(', ')}._`,
    );
  }

  if (!anythingToSuggest && !diagnostic) {
    sections.push(
      vi
        ? 'Mình chưa thấy gì cần đổi trong phạm vi quyền của bạn. Chọn một tenant ở mục **Mục tiêu** để mình kiểm tra cấu hình 7 bước của tenant đó.'
        : 'I see nothing to change within your permissions. Pick a tenant under **Target** and I will check its 7-step setup.',
    );
  }
  sections.push(
    vi
      ? 'Mình **chưa đổi gì** — mọi thay đổi chỉ áp dụng sau khi bạn duyệt trên thẻ xác nhận.'
      : 'I have **changed nothing** — every change applies only after you approve it on the Consent Card.',
  );
  if (diagnostic) {
    quick.push(vi ? 'Tenant này hay bị lỗi, vì sao?' : 'Why does this tenant fail?');
  }

  return {
    ok: true,
    replyLocale: locale,
    reply: sections.join('\n\n'),
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
