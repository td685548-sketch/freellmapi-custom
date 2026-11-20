import crypto from 'node:crypto';
import {
  SUPPORT_SETUP_PROPOSAL_TTL_SECONDS,
  SUPPORT_SETUP_STEP_IDS,
  type SupportSetupChatIntent,
  type SupportSetupChatMessage,
  type SupportSetupChatResponse,
  type SupportSetupGuardrailsPayload,
  type SupportSetupKnowledgeDocSeed,
  type SupportSetupKnowledgeMaskingPayload,
  type SupportSetupLanguage,
  type SupportSetupOutputControlsPayload,
  type SupportSetupPlannedStep,
  type SupportSetupProposal,
  type SupportSetupRequirements,
  type SupportSetupRuntimePayload,
  type SupportSetupSlaRoutingPayload,
  type SupportSetupStepId,
  type SupportSetupTenantAiPayload,
  type SupportSetupTenantDiagnostic,
  type SupportSetupTone,
  type SupportSetupWidgetPayload,
} from '@freellmapi/shared/support-setup-copilot.js';
import { DEFAULT_RUNTIME_POLICY } from '@freellmapi/shared/support-runtime.js';
import {
  DEFAULT_SUPPORT_DESK_SLA_POLICY,
  DEFAULT_SUPPORT_DESK_WIDGET_CONFIG,
  SUPPORT_DESK_LIMITS,
} from '@freellmapi/shared/support-service-desk.js';
import { SUPPORT_OUTPUT_LIMITS } from '@freellmapi/shared/support-output.js';
import type { SessionUser } from '../../services/auth.js';
import { listSupportTenants, type SupportTenant } from '../x-gateway/support-store.js';
import { listCopilotModelOptions, type CopilotUserScope } from './diagnostics.js';
import {
  buildHumanDialogueTurn,
  buildHumanProposalIntro,
  classifyHumanConversationalAct,
  enrichRequirementsWithOpenDomain,
  isIdentityOrPermissionsQuestion,
  resolveDomainGuidanceFromIndustry,
  type OpenDomainTopicInsight,
} from './human-dialogue.js';
import {
  buildCallerIdentity,
  buildIdentityReply,
  identitySuggestedQuickReplies,
} from './identity.js';
import { runCopilotAgentLoop, type CopilotLoopResult } from './agent-loop.js';
import {
  parseLlmCoachResponse,
  type GatewayLoopbackContext,
  type LlmCoachOutput,
} from './llm-coach.js';
import {
  buildPermissionGrantProposal,
  collectStagedPermissionGrants,
  describePermissionGrant,
  handlePermissionGrantChatTurn,
} from './permission-grants.js';
import { matchPlatformKnowledgeQuestion } from './platform-guide.js';
import { createSetupProposal, getSetupProposalForUser } from './store.js';
import {
  analyzeSurgicalSupportEdit,
  applySurgicalStepScopingAndMerge,
} from './surgical-steps.js';
import {
  evaluateSystemSettingsProposal,
  hasAnySystemSettingPermission,
  type EvaluateSystemSettingsProposalResult,
} from './system-settings.js';

export { parseLlmCoachResponse, type GatewayLoopbackContext, type LlmCoachOutput };

const UNSAFE_WIDGET_TEXT_RE = /[<>]|https?:\/\/|javascript:|data:|vbscript:|url\s*\(|expression\s*\(/gi;

export const SUPPORT_SETUP_TRAINING_GUIDE = `
AI Support 7-Step Setup Playbook (Thruline & Tenant AI Portal):
1. Tenant & AI Persona (/thruline/support | tab: AI & Prompt):
   - Create or enable a Support Tenant with a public key (pk_sup_...), defaultModel (e.g. 'auto'), systemPrompt, allowGuest, and role configs (guest/customer/staff/admin).
2. Knowledge Base & PII Masking (/thruline/support-knowledge | tab: Knowledge & RAG):
   - Author or import FAQ/policy documents. IMPORTANT: Include 'guest' and 'customer' in allowedRoles so customer chat widgets can retrieve them; admin-only docs remain invisible to customers.
   - Enable PII Masking (email, phone, credit_card, api_key) so sensitive user data is masked before reaching the LLM.
3. Prompt Firewall & Quotas (/thruline/support-guardrails | tab: Guardrails & Output):
   - Enable prompt-injection detection (ignore_instructions, role_spoofing, system_prompt_leak, sql_injection_probe), configure blockedTopics, competitorKeywords, and per-role request/token quotas.
4. Output Controls (/thruline/support-output | tab: Guardrails & Output):
   - Set mode to 'enforce', enable redactCredentials=true, configure maxOutputChars and blockedTerms so leaked keys or forbidden terms are stopped before reaching users.
5. Embeddable Widget & Intake (/thruline/support-desk | tab: Widget & Service Desk):
   - Set widget enabled=true, configure brand primaryColor/secondaryColor, safe title/subtitle/welcomeMessage/quickPrompts (plain text without HTML or URLs), and optional pre-chat intake fields.
6. Service Desk SLA & Auto-Routing (/thruline/support-desk | tab: Widget & Service Desk):
   - Enable SLA targets (urgent/high/medium/low firstResponseMinutes & resolutionMinutes) and keyword routing rules to billing/technical/returns/general departments.
7. Integration, CORS Origins & Runtime Bounds (/thruline/support-integration | tab: Integration & Keys):
   - Restrict allowedOrigins to production site origins, configure runtime limits (maxCompletionTokens, maxModelCalls, maxToolCalls, maxContextChars), copy the <script> embed snippet, and sign X-Support-Context-Token on partner backends when logged-in users connect.
`.trim();

function stripControlChars(input: string): string {
  let out = '';
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if ((code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127) {
      continue;
    }
    out += input[i];
  }
  return out;
}

function capitalizeInitial(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  return trimmed[0]!.toUpperCase() + trimmed.slice(1);
}

/**
 * Ensures text stored in widget appearance passes support-widget-profile.ts assertSafeText()
 * by turning full URLs into clean hostnames and stripping markup/script schemes.
 */
export function sanitizeWidgetSafeText(
  raw: string | undefined,
  maxLen: number,
  fallback = '',
): string {
  if (!raw || typeof raw !== 'string') return fallback.slice(0, maxLen);
  const replacedUrls = raw.replace(/https?:\/\/([A-Za-z0-9.-]+(?::\d+)?)[^\s<>"']*/gi, '$1');
  const cleaned = stripControlChars(replacedUrls)
    .replace(UNSAFE_WIDGET_TEXT_RE, ' ')
    .replace(/\s+/g, ' ')
    .normalize('NFC')
    .trim();
  if (!cleaned) return fallback.slice(0, maxLen);
  return cleaned.slice(0, maxLen).trim();
}

export function sanitizeSlug(
  raw: string,
  existingSlugs?: ReadonlySet<string>,
): string {
  const ascii = raw
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[\u0111\u0110]/gu, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

  const base = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(ascii) ? ascii : 'support-ai';
  if (!existingSlugs || !existingSlugs.has(base)) {
    return base;
  }
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base.slice(0, 34)}-${i}`;
    if (!existingSlugs.has(candidate)) return candidate;
  }
  return `${base.slice(0, 30)}-${crypto.randomBytes(3).toString('hex')}`;
}

const NAMED_COLORS: Array<[RegExp, string]> = [
  [/\b(?:pink|rose)\b|màu hồng|\bhồng\b/i, '#ec4899'],
  [/\b(?:purple|violet)\b|màu tím|\btím\b/i, '#7c3aed'],
  [/\b(?:emerald|green)\b|xanh lá|xanh lục/i, '#16a34a'],
  [/\b(?:teal|cyan)\b|xanh ngọc/i, '#0d9488'],
  [/\b(?:orange|amber)\b|màu cam|\bcam\b/i, '#ea580c'],
  [/\b(?:red|crimson)\b|màu đỏ|\bđỏ\b/i, '#dc2626'],
  [/\b(?:gold|yellow)\b|màu vàng|\bvàng\b/i, '#ca8a04'],
  [/\b(?:slate|black|dark)\b|màu đen|\bđen\b/i, '#1e293b'],
  [/\b(?:blue|cobalt|indigo)\b|xanh dương|\bxanh\b/i, '#2563eb'],
];

export function normalizeHexColor(raw?: string): string {
  if (raw && typeof raw === 'string') {
    const trimmed = raw.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toLowerCase();
    const shortMatch = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/.exec(trimmed);
    if (shortMatch) {
      return `#${shortMatch[1]}${shortMatch[1]}${shortMatch[2]}${shortMatch[2]}${shortMatch[3]}${shortMatch[3]}`.toLowerCase();
    }
    for (const [pattern, hex] of NAMED_COLORS) {
      if (pattern.test(trimmed)) return hex;
    }
  }
  return '#2563eb';
}

function darkenHex(hex: string): string {
  const clean = normalizeHexColor(hex).slice(1);
  const r = Math.max(0, Math.round(parseInt(clean.slice(0, 2), 16) * 0.8));
  const g = Math.max(0, Math.round(parseInt(clean.slice(2, 4), 16) * 0.8));
  const b = Math.max(0, Math.round(parseInt(clean.slice(4, 6), 16) * 0.8));
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

export function normalizeWebsiteOrigins(raw?: string): string[] {
  if (!raw || typeof raw !== 'string') return ['*'];
  const tokens = raw
    .split(/[\s,;]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  const origins: string[] = [];
  for (const token of tokens) {
    if (token === '*') {
      if (!origins.includes('*')) origins.push('*');
      continue;
    }
    const candidate = /^https?:\/\//i.test(token) ? token : `https://${token}`;
    try {
      const parsed = new URL(candidate);
      if (['http:', 'https:'].includes(parsed.protocol) && parsed.hostname.includes('.')) {
        if (!origins.includes(parsed.origin)) origins.push(parsed.origin);
      } else if (
        ['http:', 'https:'].includes(parsed.protocol) &&
        (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
      ) {
        if (!origins.includes(parsed.origin)) origins.push(parsed.origin);
      }
    } catch {
      // Ignore malformed host tokens
    }
  }
  return origins.length > 0 ? origins : ['*'];
}

function normalizeStringList(items: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(items)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (typeof item !== 'string') continue;
    const cleaned = item.replace(/\s+/g, ' ').trim().slice(0, maxLen);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= maxItems) break;
  }
  return out;
}

function parseListFragment(fragment: string): string[] {
  return fragment
    .split(/,|;|\bvà\b|\band\b/i)
    .map((s) => s.replace(/^["'`:]+|["'`.:]+$/g, '').trim())
    .filter((s) => s.length >= 2 && s.length <= 80);
}

const INDUSTRY_PATTERNS: Array<{ re: RegExp; en: string; vi: string }> = [
  {
    re: /mỹ phẩm|skincare|beauty|cosmetic|thời trang|fashion|bán hàng|bán lẻ|ecommerce|e-commerce|thương mại điện tử|retail|cosmetics/i,
    en: 'E-commerce & Retail',
    vi: 'Thương mại điện tử & Bán lẻ',
  },
  {
    re: /\bsaas\b|phần mềm|software|công nghệ|\bapi\b|platform|nền tảng|\btech\b|\bapp\b/i,
    en: 'SaaS & Technology',
    vi: 'Phần mềm SaaS & Công nghệ',
  },
  {
    re: /giáo dục|khóa học|học viện|trung tâm|education|edtech|training/i,
    en: 'Education & Training',
    vi: 'Giáo dục & Đào tạo',
  },
  {
    re: /y tế|phòng khám|nha khoa|\bspa\b|clinic|healthcare|wellness/i,
    en: 'Healthcare & Wellness',
    vi: 'Y tế & Chăm sóc sức khỏe',
  },
  {
    re: /du lịch|khách sạn|booking|travel|hotel|hospitality|tour/i,
    en: 'Travel & Hospitality',
    vi: 'Du lịch & Khách sạn',
  },
  {
    re: /tài chính|ngân hàng|fintech|bảo hiểm|finance|banking/i,
    en: 'Financial Services',
    vi: 'Tài chính & Dịch vụ',
  },
];

const PURE_CATEGORY_NOT_BRAND_RE =
  /^(?:board\s*-?\s*games?|trò\s+chơi\s+bàn|tabletop|sneakers?|giày(?:\s+sneaker)?|yoga|pilates|gym|fitness|cà\s+phê(?:\s+acoustic)?|cafe(?:\s+acoustic)?|trà\s+sữa|mỹ\s+phẩm|skincare|thời\s+trang|quần\s+áo|chụp\s+ảnh|kế\s+toán|tiếng\s+(?:trung|anh|nhật|hàn)|thú\s+cưng|pet\s+shop)$/i;

export function extractRequirementsFromMessages(
  messages: SupportSetupChatMessage[],
  base?: Partial<SupportSetupRequirements>,
  hint?: Partial<SupportSetupRequirements>,
  locale: 'vi' | 'en' = 'vi',
): SupportSetupRequirements {
  const merged: SupportSetupRequirements = {
    ...(base ?? {}),
  };

  for (const msg of messages) {
    if (msg.role !== 'user') continue;
    const text = msg.content;
    if (!text || !text.trim()) continue;
    const trimmed = text.trim();
    const act = classifyHumanConversationalAct(trimmed);
    if (act === 'platform_guide') {
      continue;
    }

    // Brand extraction (allow explicit brand in a later turn to update earlier brand)
    const explicitBrandMarker =
      /tên\s*(?:(?:shop|cửa hàng|quán|tiệm|web|website|thương hiệu|công ty|doanh nghiệp|dịch vụ|dự án|brand|tenant)\s*)?(?:là|:)|(?:brand|company|shop|store|business|service|tenant)\s*(?:name\s*)?(?:is|:|called|named)/i.test(
        trimmed,
      );

    if (act === 'business_context' || explicitBrandMarker) {
      const brandPatterns = [
        /(?:tên\s*(?:(?:shop|cửa hàng|quán|tiệm|web|website|thương hiệu|công ty|doanh nghiệp|dịch vụ|dự án|brand|tenant)\s*)?(?:là|:)|(?:shop|cửa hàng|thương hiệu|công ty|doanh nghiệp|brand)\s*(?:là|:)?)\s*([^\n,.;!?()]{2,50})/i,
        /(?:(?:brand|company|shop|store|business|service|tenant)\s+name\s*(?:is|:)|(?:brand|company|shop|store)\s+(?:is|:|called|named))\s*([^\n,.;!?()]{2,50})/i,
      ];
      for (const pat of brandPatterns) {
        const m = pat.exec(trimmed);
        if (m?.[1]) {
          const isExplicitMatch =
            /tên.*(?:là|:)|name\s*(?:is|:)|\b(?:brand|company|shop|store)\s+(?:is|:|called|named)/i.test(
              m[0],
            );
          const candidate = m[1]
            .replace(/^(?:tên là|là)\s+/i, '')
            .replace(
              /^(?:mỹ phẩm|skincare|thời trang|phần mềm|saas|bán lẻ|bán hàng|giáo dục|giày\s+sneaker|boardgame)\s+(?=[A-ZÀÁÂÃÈÉÊÌÍÒÓÔÕÙÚĂĐĨŨƠƯẠ-Ỹ])/i,
              '',
            )
            .replace(
              /\s+(?:chuyên|bán|cung cấp|website|web|tại|ở|màu|giọng|đối thủ|để\s+mình|để\s+xem|muốn|cần|và\s+muốn|nhé|nha)\b.*$/i,
              '',
            )
            .trim();
          const isGenericPronounOrStop =
            /^(?:tôi|mình|chúng\s+tôi|chúng\s+mình|bạn|của\s+tôi|của\s+mình|của\s+chúng\s+tôi|cho\s+tôi|giúp\s+tôi|mới|hiện\s+tại|này|ai|support|my|our|me|for\s+me|new|current)\b/i.test(
              candidate,
            );
          const isCategoryOnlyWithoutExplicitName =
            !isExplicitMatch && PURE_CATEGORY_NOT_BRAND_RE.test(candidate);
          const hasUpperOrExplicit =
            /[A-ZÀÁÂÃÈÉÊÌÍÒÓÔÕÙÚĂĐĨŨƠƯẠ-Ỹ]/.test(candidate) || isExplicitMatch;
          if (
            candidate.length >= 2 &&
            !isGenericPronounOrStop &&
            !isCategoryOnlyWithoutExplicitName &&
            hasUpperOrExplicit
          ) {
            merged.brandName = candidate.slice(0, 80);
            break;
          }
        }
      }
    }

    // Legacy industry baseline (refined & expanded below by open-domain topic engine)
    for (const entry of INDUSTRY_PATTERNS) {
      if (entry.re.test(trimmed)) {
        merged.industry = locale === 'vi' ? entry.vi : entry.en;
        break;
      }
    }

    // Website origin extraction
    const urlMatch = /(https?:\/\/[^\s,;"'<>)]+)/i.exec(trimmed);
    if (urlMatch?.[1]) {
      merged.websiteOrigin = normalizeWebsiteOrigins(urlMatch[1])[0];
    } else {
      const domainMatch = /\b([a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:vn|com|net|org|io|co|ai|app|dev|edu|info))\b/i.exec(
        trimmed,
      );
      if (domainMatch?.[1]) {
        merged.websiteOrigin = normalizeWebsiteOrigins(domainMatch[1])[0];
      }
    }

    // Language extraction (ignore meta capability questions like "bạn có thể nói tiếng việt không")
    if (act !== 'capability_or_pushback') {
      if (/song ngữ|bilingual|việt\s*(?:&|và|\+)\s*anh|english\s*(?:&|and)\s*vietnamese/i.test(trimmed)) {
        merged.language = 'bilingual';
      } else if (/tiếng anh|\benglish\b/i.test(trimmed)) {
        merged.language = 'en';
      } else if (/tiếng việt|\bvietnamese\b/i.test(trimmed)) {
        merged.language = 'vi';
      }
    }

    // Tone extraction
    if (/đồng cảm|ân cần|empathetic/i.test(trimmed)) merged.tone = 'empathetic';
    else if (/kỹ thuật|technical/i.test(trimmed) && act === 'business_context') merged.tone = 'technical';
    else if (/chuyên nghiệp|trang trọng|lịch sự|professional|formal/i.test(trimmed)) {
      merged.tone = 'professional';
    } else if (/thân thiện|nhiệt tình|gần gũi|vui vẻ|friendly/i.test(trimmed)) {
      merged.tone = 'friendly';
    }

    // Primary color extraction (later user turn overrides earlier color)
    const hexMatch = /(#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3})\b/.exec(trimmed);
    if (hexMatch?.[1]) {
      merged.primaryColor = normalizeHexColor(hexMatch[1]);
    } else if (act === 'business_context') {
      for (const [pattern, hex] of NAMED_COLORS) {
        if (pattern.test(trimmed)) {
          merged.primaryColor = hex;
          break;
        }
      }
    }

    // Competitor keywords extraction
    const compMatch = /(?:đối thủ|không nhắc(?:\s+tên|\s+đến)?|tránh nhắc|competitor(?:s)?)\s*(?:là|:)?\s*([^\n.;!?]+)/i.exec(
      trimmed,
    );
    if (compMatch?.[1]) {
      const extracted = parseListFragment(compMatch[1]);
      if (extracted.length > 0) {
        merged.competitorKeywords = normalizeStringList(
          [...(merged.competitorKeywords ?? []), ...extracted],
          20,
          80,
        );
      }
    }

    // Blocked topics extraction
    const topicMatch = /(?:chủ đề cấm|chủ đề chặn|không trả lời về|tránh nói về|blocked topics?)\s*(?:là|:)?\s*([^\n.;!?]+)/i.exec(
      trimmed,
    );
    if (topicMatch?.[1]) {
      const extracted = parseListFragment(topicMatch[1]);
      if (extracted.length > 0) {
        merged.blockedTopics = normalizeStringList(
          [...(merged.blockedTopics ?? []), ...extracted],
          20,
          80,
        );
      }
    }

    // Contact intake flag (later user turn overrides earlier flag)
    if (
      /không cần\s*(?:form|thu thập|nhập email)|(?:without|no)\s*(?:customer\s*)?(?:email\s*)?intake/i.test(
        trimmed,
      )
    ) {
      merged.requireContactIntake = false;
    } else if (
      /thu thập\s*(?:email|sđt|số điện thoại|thông tin)|nhập\s*email|pre-?chat|intake\s*form|collect.*email|require.*email\s*intake/i.test(
        trimmed,
      )
    ) {
      merged.requireContactIntake = true;
    }

    // FAQ / Policy summary capture from informative business messages (never meta/pushback/hesitation/exploratory setup requests)
    const hasPolicyKeywords =
      /đổi trả|bảo hành|hoàn tiền|giao hàng|ship|freeship|giá|thanh toán|giờ làm việc|mở cửa|bảo lưu|chính sách|return|refund|shipping|warranty|pricing|hours|policy|sla/i.test(
        trimmed,
      );
    const isExploratorySetupRequest =
      /(?:muốn|cần|đang\s+muốn|nhờ|giúp|hộ|muon|can|nho|giup)\s*(?:mình\s+|tôi\s+|em\s+|bạn\s+)?(?:setup|thiết\s*lập|thiet\s*lap|cài\s*đặt|cai\s*dat|tạo|làm\s*(?:con\s*ai|bot|chatbot|ai\s*support)|tư\s*vấn|tu\s*van)|(?:setup|thiết\s*lập|thiet\s*lap|cài\s*đặt|cai\s*dat|tạo)\s*(?:giúp|giup|thay|cho|hộ)|\b(?:want|would\s+like|need|looking)\s+to\s+(?:set\s+up|configure|build|create)\b|\b(?:set\s+up|configure)\s+.*\bfor\s+(?:me|my|our)\b/i.test(
        trimmed,
      );
    if (
      act === 'business_context' &&
      (hasPolicyKeywords ||
        (!merged.faqSummaryOrPolicies && trimmed.length >= 60 && !isExploratorySetupRequest))
    ) {
      merged.faqSummaryOrPolicies = trimmed.slice(0, 2000);
    }
  }

  // Enrich with open-domain business/topic understanding ("web boardgame", "quán cà phê acoustic", etc.)
  const { requirements: domainEnriched } = enrichRequirementsWithOpenDomain(
    messages,
    merged,
    locale,
    hint?.industry,
  );

  // Explicit Quick Brief / LLM hint fields win last
  if (hint) {
    if (hint.brandName?.trim()) domainEnriched.brandName = hint.brandName.trim().slice(0, 80);
    if (hint.tenantSlug?.trim()) domainEnriched.tenantSlug = hint.tenantSlug.trim().slice(0, 48);
    if (hint.industry?.trim()) domainEnriched.industry = hint.industry.trim().slice(0, 80);
    if (hint.websiteOrigin?.trim()) domainEnriched.websiteOrigin = hint.websiteOrigin.trim().slice(0, 200);
    if (hint.language) domainEnriched.language = hint.language;
    if (hint.tone) domainEnriched.tone = hint.tone;
    if (hint.primaryColor?.trim()) domainEnriched.primaryColor = normalizeHexColor(hint.primaryColor);
    if (hint.faqSummaryOrPolicies?.trim()) {
      domainEnriched.faqSummaryOrPolicies = hint.faqSummaryOrPolicies.trim().slice(0, 2000);
    }
    if (hint.blockedTopics?.length) {
      domainEnriched.blockedTopics = normalizeStringList(hint.blockedTopics, 20, 80);
    }
    if (hint.competitorKeywords?.length) {
      domainEnriched.competitorKeywords = normalizeStringList(hint.competitorKeywords, 20, 80);
    }
    if (typeof hint.requireContactIntake === 'boolean') {
      domainEnriched.requireContactIntake = hint.requireContactIntake;
    }
    if (hint.defaultModel?.trim()) {
      domainEnriched.defaultModel = hint.defaultModel.trim().slice(0, 120);
    }
  }

  return domainEnriched;
}

const VI_DIACRITIC_RE =
  /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;

const VI_UNACCENTED_PHRASE_RE =
  /\b(?:xin\s+chao|chao\s+ban|toi\s+(?:dang|muon|can|co|chua|khong)|minh\s+(?:dang|muon|can|co|chua|khong|moi)|ben\s+(?:minh|toi|em)|va\s+muon|(?:muon|can)\s+(?:setup|thiet\s+lap|cai\s+dat|tu\s+van|lam)|ban\s+co\s+the|ban\s+lam\s+duoc|lam\s+gi\s+ma|la\s+(?:cai\s+)?gi|lam\s+gi|de\s+lam\s+gi|dung\s+de|dung\s+sao|dung\s+the\s+nao|day\s+la\s+(?:trang|web|website|he\s+thong|ung\s+dung|nen\s+tang|muc|man\s+hinh|cho|tab|cong\s+cu)|hoat\s+dong\s+(?:sao|ra\s+sao|kieu\s+gi|the\s+nao|nhu\s+the\s+nao)|ra\s+sao|kieu\s+gi|cho\s+nay|web\s+nay|trang\s+(?:web\s+)?nay|he\s+thong\s+nay|ung\s+dung\s+nay|nen\s+tang\s+nay|muc\s+nay|man\s+hinh\s+nay|gioi\s+thieu|lay\s+api\s*keys?|ket\s+noi|cau\s+hinh|o\s+dau|khac\s+nhau|khac\s+gi|tai\s+khoan|co\s+the\s+(?:lam|noi|giup)|tieng\s+viet|giup\s+toi|giup\s+minh|cho\s+toi|cho\s+minh|cua\s+toi|cua\s+minh|lam\s+sao|nhu\s+the\s+nao|thiet\s+lap|cai\s+dat|huong\s+dan|buoc\s*[1-7]|duoc\s+khong|tuy\s+ban|lam\s+luon|mac\s+dinh|chua\s+co|khong\s+co|sao\s+(?:tra\s+loi|cung\s+nhac|hoi|goi\s+api|bi\s+loi)|bi\s+loi|gap\s+loi|chan\s+doan|kiem\s+tra\s+(?:tai\s+khoan|loi|key)|tao\s+(?:personal\s*)?(?:api\s*)?key|chuyen\s+key|nguoi\s+moi|thanh\s+vien\s+moi|doi\s+mau|doi\s+mat\s+khau|xoa\s+api\s+keys?|(?:bat|tat)\s+(?:response\s+cache|cache|thruline|mcp|compression|unification|ollama|auto\s+update)|hoi\s+nhieu|nhu\s+may|cam\s+on|ban\s+la\s+ai|ban\s+oi|cung\s+nhac|tu\s+van|len\s+ke\s+hoach|len\s+ban\s+mau|trien\s+luon|ok\s+ban)\b/i;

const EXPLICIT_SPEAK_VI_RE =
  /\b(?:speak|talk\s+in|reply\s+in|use|switch\s+to)\s+vietnamese\b|(?:nói|dùng|trả\s+lời|giao\s+tiếp|chat)\s*(?:bằng\s*)?tiếng\s*việt|tieng\s+viet\s+(?:khong|duoc\s+khong|nhe|di)/i;

const EXPLICIT_SPEAK_EN_RE =
  /^(?:please\s+)?(?:can\s+you\s+)?(?:speak|talk\s+in|reply\s+in|switch\s+to)\s+english\b|(?:nói|trả\s+lời\s+bằng)\s+tiếng\s+anh\s+(?:với\s+(?:tôi|mình)|nhé|đi)/i;

const EN_SENTENCE_MARKER_RE =
  /\b(?:how\s+do|how\s+to|can\s+you|could\s+you|please|set\s+up|configure|explain|tell\s+me\s+about|difference\s+between|my\s+(?:shop|store|company|business|tenant|errors?|account|api|keys?|requests?|quota)|diagnose|troubleshoot|why\s+(?:are|is|do|did|am\s+i)|create\s+(?:a\s+|an\s+|new\s+)?(?:personal\s+)?(?:api\s+)?key|mint\s+(?:a\s+|new\s+|personal\s+)|switch\s+(?:my\s+|the\s+)?(?:personal\s+)?(?:api\s+)?key|open\s+onboarding|auto-complete|standard\s+defaults|hello|hi\s+there|what\s+is|what\s+does|what\s+are|what\s+can\s+you|who\s+are\s+you|support\s+hours|onboarding|collect\s+customer)\b/i;

/**
 * Automatically detects the user's preferred conversation language ('vi' | 'en')
 * from their actual chat messages so Vietnamese users get fluent Vietnamese replies
 * even when the dashboard navbar dropdown is set to English (and vice versa).
 */
export function detectConversationLocale(
  messages: readonly SupportSetupChatMessage[],
  fallbackLocale: 'vi' | 'en' = 'vi',
): 'vi' | 'en' {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (!msg || msg.role !== 'user') continue;
    const text = msg.content.trim();
    if (!text) continue;
    if (EXPLICIT_SPEAK_VI_RE.test(text)) return 'vi';
    if (EXPLICIT_SPEAK_EN_RE.test(text)) return 'en';
    if (VI_DIACRITIC_RE.test(text) || VI_UNACCENTED_PHRASE_RE.test(text)) return 'vi';
    if (EN_SENTENCE_MARKER_RE.test(text)) return 'en';
  }
  return fallbackLocale;
}

function buildKnowledgeDocs(params: {
  brandName: string;
  industry: string;
  language: SupportSetupLanguage;
  faqSummary: string;
  websiteHost: string;
  domainGuidance?: OpenDomainTopicInsight | null;
}): SupportSetupKnowledgeDocSeed[] {
  const { brandName, industry, language, faqSummary, websiteHost } = params;
  const isVi = language === 'vi';
  const domain =
    params.domainGuidance ?? resolveDomainGuidanceFromIndustry(industry, isVi ? 'vi' : 'en');

  if (isVi) {
    const scenarioLinesVi = domain
      ? [
          '',
          `## Các tình huống hỗ trợ trọng tâm (${domain.industryVi})`,
          ...domain.customerScenariosVi.map((sc) => `- Hỗ trợ ${sc}.`),
        ]
      : [];

    const policyBodyVi = [
      faqSummary ? `## Chính sách & thông tin từ ${brandName}\n${faqSummary}` : '',
      domain
        ? `## Hướng dẫn tư vấn chuyên ngành (${domain.industryVi})\n- ${domain.seedFaqHintVi}\n${domain.customerScenariosVi.map((sc) => `- Giải đáp chu đáo khi khách cần ${sc}.`).join('\n')}`
        : !faqSummary
          ? '## Quy chuẩn phục vụ\n- Tư vấn minh bạch thông tin sản phẩm/dịch vụ, giá niêm yết và điều kiện áp dụng.\n- Mọi khiếu nại hoặc yêu cầu đặc biệt sẽ được tạo ticket để bộ phận chuyên trách hỗ trợ.'
          : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    return [
      {
        title: `${brandName} - Tổng quan dịch vụ & Kênh hỗ trợ`,
        category: 'overview',
        tags: ['tong-quan', 'lien-he', 'ho-tro'],
        allowedRoles: ['guest', 'customer', 'staff', 'admin'],
        content: [
          `# Giới thiệu ${brandName}`,
          `- Lĩnh vực hoạt động: ${industry}`,
          websiteHost
            ? `- Kênh chính thức: ${websiteHost}`
            : '- Kênh hỗ trợ: Trực tuyến qua khung chat AI Support',
          '- Thời gian phản hồi AI: Ngay lập tức 24/7; yêu cầu cần nhân viên xử lý sẽ được chuyển tới Service Desk theo mức ưu tiên.',
          ...scenarioLinesVi,
        ].join('\n'),
      },
      {
        title: `${brandName} - Chính sách & Câu hỏi thường gặp (FAQ)`,
        category: 'policy',
        tags: ['chinh-sach', 'faq', 'quy-dinh'],
        allowedRoles: ['guest', 'customer', 'staff', 'admin'],
        content: [
          `# Chính sách dịch vụ & FAQ của ${brandName}`,
          policyBodyVi,
          '',
          '## Quy tắc trả lời chuẩn xác',
          '- Luôn bám sát thông tin từ kho tri thức này hoặc xác nhận lại khi khách cần tra cứu đơn hàng/tài khoản riêng.',
          '- Không tự suy đoán mã đơn hàng, giá khuyến mãi hết hạn hoặc cam kết nằm ngoài quy định.',
        ].join('\n'),
      },
      {
        title: `${brandName} - Bảo mật thông tin & Chuyển tiếp nhân viên`,
        category: 'escalation',
        tags: ['bao-mat', 'chuyen-vien', 'ticket'],
        allowedRoles: ['guest', 'customer', 'staff', 'admin'],
        content: [
          `# Bảo mật & Quy trình hỗ trợ nâng cao (${brandName})`,
          '- Hệ thống tự động che email, số điện thoại, số thẻ và khóa bí mật để bảo vệ quyền riêng tư của khách hàng.',
          '- Các vấn đề thanh toán, hoàn tiền, lỗi kỹ thuật khẩn cấp hoặc khiếu nại sẽ được định tuyến tới bộ phận phụ trách (Billing, Technical, Returns, General).',
        ].join('\n'),
      },
    ];
  }

  const scenarioLinesEn = domain
    ? [
        '',
        `## Core Customer Support Scenarios (${domain.industryEn})`,
        ...domain.customerScenariosEn.map((sc) => `- Assist customers with ${sc}.`),
      ]
    : [];

  const policyBodyEn = [
    faqSummary ? `## Official Policies & Key Facts (${brandName})\n${faqSummary}` : '',
    domain
      ? `## Domain Support Guidelines (${domain.industryEn})\n- ${domain.seedFaqHintEn}\n${domain.customerScenariosEn.map((sc) => `- Provide clear, friendly help with ${sc}.`).join('\n')}`
      : !faqSummary
        ? '## Standard Service Guidelines\n- Provide clear, accurate answers about pricing, eligibility, onboarding, and support hours.\n- Escalate billing disputes or account-specific changes to the Service Desk queue.'
        : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  return [
    {
      title: `${brandName} - Overview & Support Channels`,
      category: 'overview',
      tags: ['overview', 'contact', 'support'],
      allowedRoles: ['guest', 'customer', 'staff', 'admin'],
      content: [
        `# About ${brandName}`,
        `- Industry: ${industry}`,
        websiteHost ? `- Official domain: ${websiteHost}` : '- Official channel: Embedded Support Chat Widget',
        '- Availability: 24/7 instant AI assistance with automatic escalation to human specialists via Service Desk.',
        ...scenarioLinesEn,
      ].join('\n'),
    },
    {
      title: `${brandName} - Core Policies & Frequently Asked Questions`,
      category: 'policy',
      tags: ['policy', 'faq', 'terms'],
      allowedRoles: ['guest', 'customer', 'staff', 'admin'],
      content: [
        `# ${brandName} Service Policies & FAQ`,
        policyBodyEn,
        '',
        '## Grounding Rules',
        '- Answer strictly from verified policies and available tools; never invent order IDs or unsupported promises.',
      ].join('\n'),
    },
    {
      title: `${brandName} - Privacy Protection & Human Escalation`,
      category: 'escalation',
      tags: ['privacy', 'security', 'escalation'],
      allowedRoles: ['guest', 'customer', 'staff', 'admin'],
      content: [
        `# Privacy & Escalation Policy (${brandName})`,
        '- Personal identifiers (emails, phone numbers, payment cards, and secret keys) are masked automatically.',
        '- Urgent billing, technical incidents, and refund requests are routed to the appropriate Service Desk department.',
      ].join('\n'),
    },
  ];
}

function buildSystemPrompt(params: {
  brandName: string;
  industry: string;
  language: SupportSetupLanguage;
  tone: SupportSetupTone;
  faqSummary: string;
  domainGuidance?: OpenDomainTopicInsight | null;
}): string {
  const { brandName, industry, language, tone, faqSummary } = params;
  const isVi = language === 'vi';
  const domain =
    params.domainGuidance ?? resolveDomainGuidanceFromIndustry(industry, isVi ? 'vi' : 'en');

  const langInstruction =
    language === 'vi'
      ? 'Always respond in natural, warm, conversational Vietnamese unless the customer explicitly writes in another language.'
      : language === 'bilingual'
        ? 'Respond naturally in the same language as the customer (Vietnamese or English).'
        : 'Always respond in clear, natural, human-friendly English unless the customer writes in another language.';

  const toneInstruction: Record<SupportSetupTone, string> = {
    friendly: 'Speak like a warm, helpful, approachable human support specialist — never stiff or robotic.',
    professional: 'Use a polished, respectful, reassuring professional tone.',
    empathetic: 'Use an empathetic, patient, caring customer-support tone.',
    technical: 'Use a clear, accurate, solution-oriented technical support tone.',
  };

  const domainLine = domain
    ? isVi
      ? `Domain focus (${domain.industryVi}): ${domain.seedFaqHintVi} Typical customer inquiries include: ${domain.customerScenariosVi.join('; ')}.`
      : `Domain focus (${domain.industryEn}): ${domain.seedFaqHintEn} Typical customer inquiries include: ${domain.customerScenariosEn.join('; ')}.`
    : '';

  return [
    `You are the official AI Customer Support Assistant for ${brandName} (${industry}).`,
    langInstruction,
    toneInstruction[tone],
    domainLine,
    'Ground your answers in retrieved knowledge documents and authorized tools. Never fabricate order statuses, prices, credentials, or internal policies.',
    'If a customer needs account-specific actions beyond available tools, or asks to speak to a human teammate, acknowledge warmly and guide them through escalation.',
    faqSummary ? `Core business context summary: ${faqSummary.slice(0, 600)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildSanitizedSetupProposal(params: {
  userId: number;
  targetMode: 'create_tenant' | 'update_tenant';
  existingTenant: SupportTenant | null;
  requirements: SupportSetupRequirements;
  canEditSteps: ReadonlySet<SupportSetupStepId>;
  canViewSteps?: ReadonlySet<SupportSetupStepId>;
  canCreateTenant: boolean;
  isPlatformOperator?: boolean;
  locale: 'vi' | 'en';
}): SupportSetupProposal {
  const {
    userId,
    targetMode,
    existingTenant,
    requirements,
    canEditSteps,
    canViewSteps,
    canCreateTenant,
    isPlatformOperator = false,
    locale,
  } = params;

  const existingSlugs =
    targetMode === 'create_tenant' && canCreateTenant
      ? new Set(listSupportTenants().map((t) => t.slug.toLowerCase()))
      : new Set<string>();

  const language: SupportSetupLanguage =
    requirements.language ?? (locale === 'vi' ? 'vi' : 'en');
  const isVi = language === 'vi';
  const tone: SupportSetupTone = requirements.tone ?? 'friendly';
  const industry =
    requirements.industry?.trim() ||
    (language === 'en' ? 'Customer Service & Digital Products' : 'Dịch vụ khách hàng');

  const domainGuidance = resolveDomainGuidanceFromIndustry(industry, isVi ? 'vi' : 'en');

  const fallbackBrandName = domainGuidance
    ? capitalizeInitial(isVi ? domainGuidance.shortLabelVi : domainGuidance.shortLabelEn)
    : 'Customer Support AI';

  const brandName = (
    requirements.brandName?.trim() ||
    existingTenant?.name ||
    fallbackBrandName
  ).slice(0, 80);

  const tenantSlug =
    targetMode === 'update_tenant' && existingTenant
      ? existingTenant.slug
      : sanitizeSlug(requirements.tenantSlug || brandName, existingSlugs);

  const primaryColor = normalizeHexColor(requirements.primaryColor);
  const secondaryColor = darkenHex(primaryColor);

  const canSeeOrigins =
    isPlatformOperator ||
    canEditSteps.has('runtime_policy') ||
    Boolean(canViewSteps?.has('runtime_policy'));
  const allowedOrigins = requirements.websiteOrigin?.trim()
    ? normalizeWebsiteOrigins(requirements.websiteOrigin)
    : targetMode === 'update_tenant' && existingTenant && canSeeOrigins
      ? [...(existingTenant.allowedOrigins?.length ? existingTenant.allowedOrigins : ['*'])]
      : ['*'];

  const requestedModel = requirements.defaultModel?.trim() || existingTenant?.defaultModel || 'auto';
  const safeModelIds = new Set<string>([
    'auto',
    ...listCopilotModelOptions().map((m) => m.id),
    ...(existingTenant?.defaultModel ? [existingTenant.defaultModel] : []),
  ]);
  const defaultModel =
    isPlatformOperator || safeModelIds.has(requestedModel)
      ? requestedModel
      : existingTenant?.defaultModel || 'auto';

  const faqSummary = requirements.faqSummaryOrPolicies?.trim() || '';
  const blockedTopics = normalizeStringList(requirements.blockedTopics, 20, 80);
  const competitorKeywords = normalizeStringList(requirements.competitorKeywords, 20, 80);
  const requireContactIntake = Boolean(requirements.requireContactIntake);

  const originsOpen = allowedOrigins.includes('*');
  const firstOriginHost =
    allowedOrigins.find((o) => o !== '*')
      ? allowedOrigins.find((o) => o !== '*')!.replace(/^https?:\/\//i, '')
      : '';

  // 1. Tenant & AI Persona payload (allowedOrigins is strictly scoped to runtime_policy / edit_tenant_integration)
  const tenantPayload: SupportSetupTenantAiPayload = {
    name: brandName,
    slug: tenantSlug,
    defaultModel,
    systemPrompt: buildSystemPrompt({
      brandName,
      industry,
      language,
      tone,
      faqSummary,
      domainGuidance,
    }),
    allowGuest: true,
    enabled: true,
  };

  // 2. Knowledge Base & Masking payload
  const docs = buildKnowledgeDocs({
    brandName,
    industry,
    language,
    faqSummary,
    websiteHost: firstOriginHost,
    domainGuidance,
  });
  const knowledgePayload: SupportSetupKnowledgeMaskingPayload = {
    docs,
    masking: {
      enabled: true,
      builtinDetectors: ['email', 'phone', 'credit_card', 'api_key'],
      unmaskedRoles: ['admin'],
    },
  };

  // 3. Guardrails & Quotas payload
  const guardrailsPayload: SupportSetupGuardrailsPayload = {
    enabled: true,
    blockPromptInjection: true,
    injectionDetectors: [
      'ignore_instructions',
      'role_spoofing',
      'system_prompt_leak',
      'sql_injection_probe',
    ],
    blockedTopics:
      blockedTopics.length > 0
        ? blockedTopics
        : ['internal system credentials', 'illegal activity'],
    competitorKeywords,
    maxInputLength: 4000,
    bypassRoles: ['admin'],
    roleQuotas: {
      guest: { maxRequestsPerWindow: 20, maxTokensPerWindow: 12000, windowSeconds: 3600 },
      customer: { maxRequestsPerWindow: 80, maxTokensPerWindow: 60000, windowSeconds: 3600 },
      staff: { maxRequestsPerWindow: 300, maxTokensPerWindow: 200000, windowSeconds: 3600 },
      admin: { maxRequestsPerWindow: 0, maxTokensPerWindow: 0, windowSeconds: 3600 },
    },
  };

  // 4. Output Controls payload
  const outputBlockedTerms: Array<{ id: string; text: string }> = [];
  const seenNormalizedTerms = new Set<string>();
  const addOutputTerm = (id: string, rawText: string) => {
    const text = rawText.trim().slice(0, SUPPORT_OUTPUT_LIMITS.ruleTextMaxLength);
    if (!text) return;
    const norm = text
      .normalize('NFKC')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
    if (!norm || seenNormalizedTerms.has(norm)) return;
    seenNormalizedTerms.add(norm);
    outputBlockedTerms.push({ id, text });
  };
  competitorKeywords.slice(0, 10).forEach((kw, idx) => addOutputTerm(`comp_${idx + 1}`, kw));

  const outputPayload: SupportSetupOutputControlsPayload = {
    mode: 'enforce',
    blockedTerms: outputBlockedTerms,
    maxOutputChars: SUPPORT_OUTPUT_LIMITS.maxOutputCharsDefault,
    redactCredentials: true,
  };

  // 5. Widget Appearance & Intake payload (strictly compliant with support-widget-profile.ts)
  const safeTitle = sanitizeWidgetSafeText(
    isVi ? `Trợ lý ${brandName}` : `${brandName} Support`,
    SUPPORT_DESK_LIMITS.maxLabelChars,
    'Support Assistant',
  );
  const safeSubtitle = sanitizeWidgetSafeText(
    isVi ? `Hỗ trợ ${industry}` : `${industry} Assistant`,
    SUPPORT_DESK_LIMITS.maxSubtitleChars,
    '24/7 Support',
  );
  const safeWelcome = sanitizeWidgetSafeText(
    isVi
      ? domainGuidance
        ? `Chào bạn! Mình là trợ lý của ${brandName}. Bạn cần mình tư vấn hay kiểm tra thông tin gì cứ nhắn thoải mái nhé!`
        : `Chào bạn! Mình là trợ lý hỗ trợ của ${brandName}. Hôm nay mình giúp gì được cho bạn?`
      : `Hi there! I am the support assistant for ${brandName}. How can I help you today?`,
    SUPPORT_DESK_LIMITS.maxTextChars,
    'Hello! How can I help you today?',
  );
  const rawQuickPrompts = domainGuidance
    ? isVi
      ? domainGuidance.widgetQuickPromptsVi
      : domainGuidance.widgetQuickPromptsEn
    : isVi
      ? [
          `Chính sách dịch vụ của ${brandName}`,
          'Hướng dẫn liên hệ & thời gian hỗ trợ',
          'Mình cần gặp nhân viên tư vấn',
        ]
      : [
          `${brandName} policies and FAQ`,
          'Support hours & contact options',
          'Connect me with a human teammate',
        ];
  const quickPrompts = rawQuickPrompts
    .slice(0, 4)
    .map((qp, idx) =>
      sanitizeWidgetSafeText(qp, 80, isVi ? `Câu hỏi gợi ý ${idx + 1}` : `Quick question ${idx + 1}`),
    );

  const widgetPayload: SupportSetupWidgetPayload = {
    enabled: true,
    appearance: {
      ...DEFAULT_SUPPORT_DESK_WIDGET_CONFIG.appearance,
      primaryColor,
      secondaryColor,
      title: safeTitle,
      subtitle: safeSubtitle,
      welcomeMessage: safeWelcome,
      position: 'bottom-right',
      quickPrompts,
      theme: 'light',
      headerStyle: 'gradient',
      avatarPreset: 'bot',
      showStatusDot: true,
      launcherStyle: 'pill',
      launcherLabel: sanitizeWidgetSafeText(
        isVi ? 'Chat hỗ trợ' : 'Chat with us',
        SUPPORT_DESK_LIMITS.maxLauncherLabelChars,
        'Chat with us',
      ),
      borderRadius: 'rounded',
      widgetSize: 'standard',
      fontFamily: 'system',
      edgeOffsetPx: 24,
      inputPlaceholder: sanitizeWidgetSafeText(
        isVi ? 'Nhắn câu hỏi của bạn tại đây...' : 'Ask us anything...',
        SUPPORT_DESK_LIMITS.maxLabelChars,
        'Ask a question...',
      ),
      sendButtonLabel: sanitizeWidgetSafeText(
        isVi ? 'Gửi' : 'Send',
        SUPPORT_DESK_LIMITS.maxSendLabelChars,
        'Send',
      ),
      showPoweredBy: true,
      autoOpenDelaySeconds: 0,
    },
    intake: requireContactIntake
      ? {
          required: true,
          fields: [
            {
              key: 'customer_name',
              label: isVi ? 'Họ và tên' : 'Full Name',
              type: 'text',
              required: true,
            },
            {
              key: 'customer_email',
              label: 'Email',
              type: 'email',
              required: true,
            },
          ],
        }
      : { required: false, fields: [] },
  };

  // 6. Service Desk SLA & Routing payload
  const slaPayload: SupportSetupSlaRoutingPayload = {
    enabled: true,
    targets: {
      urgent: { ...DEFAULT_SUPPORT_DESK_SLA_POLICY.targets.urgent },
      high: { ...DEFAULT_SUPPORT_DESK_SLA_POLICY.targets.high },
      medium: { ...DEFAULT_SUPPORT_DESK_SLA_POLICY.targets.medium },
      low: { ...DEFAULT_SUPPORT_DESK_SLA_POLICY.targets.low },
    },
    routingRules: [
      {
        id: 'route_returns',
        department: 'returns',
        keywords: ['refund', 'return', 'exchange', 'hoàn tiền', 'đổi trả', 'bảo hành'],
      },
      {
        id: 'route_billing',
        department: 'billing',
        keywords: ['invoice', 'payment', 'charge', 'billing', 'thanh toán', 'hóa đơn'],
      },
      {
        id: 'route_technical',
        department: 'technical',
        keywords: ['error', 'bug', 'login', 'crash', 'lỗi', 'đăng nhập', 'kỹ thuật'],
      },
    ],
  };

  // 7. Integration Runtime Policy & CORS Origins payload
  // Preserve existing toolPolicies on update_tenant so approval_required webhook gates are never cleared.
  const runtimePayload: SupportSetupRuntimePayload = {
    allowedOrigins,
    allowedModels: defaultModel === 'auto' ? [] : [defaultModel],
    ...(targetMode === 'create_tenant' ? { toolPolicies: DEFAULT_RUNTIME_POLICY.toolPolicies } : {}),
    maxCompletionTokens: 640,
    maxModelCalls: 3,
    maxToolCalls: 3,
    maxContextChars: 16000,
    maxToolResultChars: 8000,
    maxHistoryMessages: 40,
  };

  const canDoTenantAi = targetMode === 'create_tenant' ? canCreateTenant : canEditSteps.has('tenant_ai');
  const canEditAfterCreate = (step: SupportSetupStepId) =>
    targetMode === 'create_tenant' ? canCreateTenant : canEditSteps.has(step);

  const steps: SupportSetupPlannedStep[] = [
    {
      stepId: 'tenant_ai',
      canApply: canDoTenantAi,
      enabledByDefault: canDoTenantAi,
      titleEn: targetMode === 'create_tenant' ? 'Create Tenant & AI Persona' : 'Update Tenant & AI Persona',
      titleVi: targetMode === 'create_tenant' ? 'Tạo Tenant & Nhân cách AI' : 'Cập nhật Tenant & Nhân cách AI',
      summaryEn: `${brandName} (${tenantSlug}) · model: ${defaultModel} · tone: ${tone}`,
      summaryVi: `${brandName} (${tenantSlug}) · model: ${defaultModel} · giọng điệu: ${tone}`,
      highlightsEn: [
        `Configure System Prompt tailored for ${brandName} (${industry})`,
        `Set default model "${defaultModel}" and allow guest widget sessions`,
      ],
      highlightsVi: [
        `Thiết lập System Prompt chuyên biệt cho ${brandName} (${industry})`,
        `Dùng model "${defaultModel}" và bật phiên chat khách vãng lai`,
      ],
      payload: tenantPayload as unknown as Record<string, unknown>,
    },
    {
      stepId: 'knowledge_masking',
      canApply: canEditAfterCreate('knowledge_masking'),
      enabledByDefault: canEditAfterCreate('knowledge_masking'),
      titleEn: 'Seed Knowledge Base & PII Masking',
      titleVi: 'Nạp tri thức FAQ & Che dữ liệu nhạy cảm',
      summaryEn: `${docs.length} knowledge docs (guest/customer visible) + email/phone/card/key masking`,
      summaryVi: `${docs.length} tài liệu FAQ (mở cho khách) + tự động che email/SĐT/thẻ/key`,
      highlightsEn: docs.map((d) => d.title),
      highlightsVi: docs.map((d) => d.title),
      payload: knowledgePayload as unknown as Record<string, unknown>,
    },
    {
      stepId: 'guardrails_quotas',
      canApply: canEditAfterCreate('guardrails_quotas'),
      enabledByDefault: canEditAfterCreate('guardrails_quotas'),
      titleEn: 'Prompt Firewall & Role Quotas',
      titleVi: 'Tường lửa Prompt & Hạn mức vai trò',
      summaryEn: `Injection shield ON · ${guardrailsPayload.blockedTopics.length} blocked topic(s) · ${competitorKeywords.length} competitor keyword(s)`,
      summaryVi: `Chống injection BẬT · ${guardrailsPayload.blockedTopics.length} chủ đề cấm · ${competitorKeywords.length} từ khóa đối thủ`,
      highlightsEn: [
        'Enable all 4 prompt-injection detectors',
        'Protect quotas per role (guest 20 req/hr, customer 80 req/hr)',
      ],
      highlightsVi: [
        'Bật đủ 4 bộ phát hiện prompt injection',
        'Giới hạn hạn mức an toàn theo vai trò (guest 20 lượt/giờ, customer 80 lượt/giờ)',
      ],
      payload: guardrailsPayload as unknown as Record<string, unknown>,
    },
    {
      stepId: 'output_controls',
      canApply: canEditAfterCreate('output_controls'),
      enabledByDefault: canEditAfterCreate('output_controls'),
      titleEn: 'Output Safety Controls',
      titleVi: 'Kiểm soát an toàn đầu ra',
      summaryEn: `Mode: enforce · Credential redaction ON · ${outputBlockedTerms.length} blocked output term(s)`,
      summaryVi: `Chế độ: enforce · Che khóa bí mật BẬT · ${outputBlockedTerms.length} từ cấm đầu ra`,
      highlightsEn: [
        'Enforce outbound credential redaction before responses reach customers',
        outputBlockedTerms.length > 0
          ? `Block ${outputBlockedTerms.length} competitor/restricted term(s) in AI replies`
          : 'Enforce 16,000-char safe output ceiling',
      ],
      highlightsVi: [
        'Bắt buộc kiểm tra & che khóa bí mật trước khi gửi câu trả lời cho khách',
        outputBlockedTerms.length > 0
          ? `Chặn ${outputBlockedTerms.length} từ khóa đối thủ/nhạy cảm trong câu trả lời`
          : 'Giới hạn độ dài phản hồi an toàn tối đa 16.000 ký tự',
      ],
      payload: outputPayload as unknown as Record<string, unknown>,
    },
    {
      stepId: 'widget_appearance',
      canApply: canEditAfterCreate('widget_appearance'),
      enabledByDefault: canEditAfterCreate('widget_appearance'),
      titleEn: 'Customer Chat Widget & Branding',
      titleVi: 'Giao diện Widget & Thương hiệu',
      summaryEn: `Enabled · color ${primaryColor} · ${quickPrompts.length} quick prompts · intake ${requireContactIntake ? 'required' : 'optional'}`,
      summaryVi: `BẬT · màu ${primaryColor} · ${quickPrompts.length} câu gợi ý · form liên hệ ${requireContactIntake ? 'bắt buộc' : 'tùy chọn'}`,
      highlightsEn: [
        `Title "${safeTitle}" with welcome message and ${quickPrompts.length} quick prompts`,
        requireContactIntake ? 'Pre-chat name & email intake enabled' : 'Zero-friction instant chat enabled',
      ],
      highlightsVi: [
        `Tiêu đề "${safeTitle}", lời chào mở đầu và ${quickPrompts.length} gợi ý câu hỏi nhanh`,
        requireContactIntake ? 'Bật form thu thập Tên & Email trước khi chat' : 'Cho phép khách chat ngay không cần điền form',
      ],
      payload: widgetPayload as unknown as Record<string, unknown>,
    },
    {
      stepId: 'sla_routing',
      canApply: canEditAfterCreate('sla_routing'),
      enabledByDefault: canEditAfterCreate('sla_routing'),
      titleEn: 'Service Desk SLA & Department Routing',
      titleVi: 'SLA Service Desk & Phân luồng bộ phận',
      summaryEn: 'SLA active (5m urgent / 15m high) · 3 keyword routing rules (returns, billing, technical)',
      summaryVi: 'SLA BẬT (5p khẩn / 15p cao) · 3 quy tắc phân luồng (đổi trả, thanh toán, kỹ thuật)',
      highlightsEn: [
        'Enable SLA first-response and resolution targets across all 4 priorities',
        'Auto-route tickets to returns, billing, or technical departments',
      ],
      highlightsVi: [
        'Bật mục tiêu thời gian phản hồi đầu & xử lý cho cả 4 mức ưu tiên',
        'Tự động phân luồng ticket sang Đổi trả, Thanh toán hoặc Kỹ thuật',
      ],
      payload: slaPayload as unknown as Record<string, unknown>,
    },
    {
      stepId: 'runtime_policy',
      canApply: canEditAfterCreate('runtime_policy'),
      enabledByDefault: canEditAfterCreate('runtime_policy'),
      titleEn: 'Integration CORS Origins & Runtime Limits',
      titleVi: 'Tên miền CORS & Giới hạn Runtime',
      summaryEn: originsOpen
        ? `Origins left open (*) for testing · maxCompletionTokens: ${runtimePayload.maxCompletionTokens} · step stays partial until you share your live domain`
        : `Allowed origins: ${allowedOrigins.join(', ')} · maxCompletionTokens: ${runtimePayload.maxCompletionTokens}`,
      summaryVi: originsOpen
        ? `CORS đang để mở (*) để thử nghiệm · maxCompletionTokens: ${runtimePayload.maxCompletionTokens} · bước này còn "một phần" cho đến khi bạn cho mình tên miền thật`
        : `CORS cho phép: ${allowedOrigins.join(', ')} · maxCompletionTokens: ${runtimePayload.maxCompletionTokens}`,
      highlightsEn: [
        originsOpen
          ? 'Keep CORS open (*) for now — send me your website domain to lock it down'
          : `Bind CORS origins to ${allowedOrigins.join(', ')}`,
        'Set bounded runtime limits (640 completion tokens, 3 model/tool turns)',
      ],
      highlightsVi: [
        originsOpen
          ? 'Tạm giữ CORS mở (*) — gửi mình tên miền website để khóa lại'
          : `Cấu hình CORS cho ${allowedOrigins.join(', ')}`,
        'Đặt giới hạn an toàn runtime (640 token trả lời, tối đa 3 lượt gọi model/tool)',
      ],
      payload: runtimePayload as unknown as Record<string, unknown>,
    },
  ];

  // Scrub unpermitted step payloads so proposals never carry mutation payloads outside the user's RBAC grants
  const sanitizedSteps: SupportSetupPlannedStep[] = steps.map((step) =>
    step.canApply
      ? step
      : {
          ...step,
          enabledByDefault: false,
          highlightsEn: [],
          highlightsVi: [],
          payload: {},
        },
  );

  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + SUPPORT_SETUP_PROPOSAL_TTL_SECONDS * 1000).toISOString();

  return {
    id: `prop_${crypto.randomUUID()}`,
    userId,
    targetMode,
    tenantId: targetMode === 'update_tenant' && existingTenant ? existingTenant.id : null,
    tenantName: brandName,
    tenantSlug,
    status: 'pending_consent',
    summary:
      locale === 'vi'
        ? `Kế hoạch triển khai hoàn chỉnh AI Support cho "${brandName}" (${industry}) gồm ${sanitizedSteps.filter((s) => s.canApply).length}/7 bước sẵn sàng.`
        : `Complete AI Support setup plan for "${brandName}" (${industry}) with ${sanitizedSteps.filter((s) => s.canApply).length}/7 permitted steps ready.`,
    requirements: {
      ...requirements,
      brandName,
      tenantSlug,
      industry,
      language,
      tone,
      primaryColor,
      ...(canEditSteps.has('runtime_policy') || canCreateTenant
        ? { websiteOrigin: allowedOrigins[0] }
        : {}),
      blockedTopics,
      competitorKeywords,
      requireContactIntake,
      defaultModel,
    },
    steps: sanitizedSteps,
    createdAt,
    expiresAt,
  };
}

const STIFF_NUMBERED_FORM_RE = /(?:^|\n)\s*1[.)]\s+.+\n\s*2[.)]\s+/m;

/**
 * A numbered list is a *questionnaire* (the robotic "1. brand? 2. site?" form)
 * only when most items are questions. Step-by-step instructions ("1. Open …
 * 2. Click …") are exactly what a "how do I …" answer needs and must not be
 * discarded in favour of a canned reply.
 */
export function looksLikeQuestionnaire(reply: string): boolean {
  if (!STIFF_NUMBERED_FORM_RE.test(reply)) return false;
  const items = reply.split('\n').filter((l) => /^\s*\d+[.)]\s+/.test(l));
  const questions = items.filter((l) => /\?\s*(?:\*\*|_|\))?\s*$/.test(l.trim())).length;
  return items.length > 0 && questions / items.length >= 0.5;
}

function resolveSystemSettingsTurnResponse(params: {
  evalResult: EvaluateSystemSettingsProposalResult;
  userId: number;
  locale: 'vi' | 'en';
  llmReply?: string;
  modelUsed?: string | null;
}): SupportSetupChatResponse | null {
  const { evalResult, userId, locale, llmReply, modelUsed = null } = params;
  if (evalResult.outcome === 'none') {
    return null;
  }

  if (
    evalResult.outcome === 'unsupported_sensitive' ||
    evalResult.outcome === 'permission_denied'
  ) {
    return {
      ok: true,
      replyLocale: locale,
      reply: locale === 'vi' ? evalResult.replyVi : evalResult.replyEn,
      intent: 'guide',
      missingQuestions: [],
      suggestedQuickReplies: evalResult.suggestedQuickReplies,
      proposal: null,
      modelUsed,
      usedFallback: !modelUsed,
    };
  }

  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + SUPPORT_SETUP_PROPOSAL_TTL_SECONDS * 1000).toISOString();
  const savedProposal = createSetupProposal({
    id: `prop_${crypto.randomUUID()}`,
    userId,
    targetMode: 'system_settings',
    tenantId: null,
    tenantName: 'System Settings',
    tenantSlug: 'system-settings',
    status: 'pending_consent',
    summary: locale === 'vi' ? evalResult.summaryVi : evalResult.summaryEn,
    requirements: {},
    steps: [],
    systemActions: evalResult.actions,
    createdAt,
    expiresAt,
  });

  const useLlmReply = Boolean(
    llmReply &&
      !STIFF_NUMBERED_FORM_RE.test(llmReply) &&
      evalResult.missingPermissions.length === 0,
  );

  return {
    ok: true,
    replyLocale: locale,
    reply: useLlmReply
      ? llmReply!
      : locale === 'vi'
        ? evalResult.replyVi
        : evalResult.replyEn,
    intent: 'propose_setup',
    missingQuestions: [],
    suggestedQuickReplies: evalResult.suggestedQuickReplies,
    proposal: savedProposal,
    modelUsed,
    usedFallback: !modelUsed,
  };
}

/**
 * Phase 3: turn gate-authorized, tool-staged permission grants (server
 * records from the agent loop — never raw LLM text) into a pending_consent
 * proposal. Returns null when the loop staged no grant tool call.
 */
function resolvePermissionGrantLoopResponse(params: {
  loopResult: CopilotLoopResult;
  userId: number;
  locale: 'vi' | 'en';
}): SupportSetupChatResponse | null {
  const { loopResult, userId, locale } = params;
  const grants = collectStagedPermissionGrants(loopResult.toolCalls);
  if (grants.length === 0) return null;
  const savedProposal = buildPermissionGrantProposal({ userId, grants, locale });
  const lines = grants.map((g) => describePermissionGrant(g, locale)).join('\n');
  return {
    ok: true,
    replyLocale: locale,
    reply:
      locale === 'vi'
        ? `Mình đã chuẩn bị sẵn đề xuất thay đổi quyền theo đúng yêu cầu của bạn:\n${lines}\n\nMình **chưa thay đổi gì cả** — bạn kiểm tra lại rồi bấm **Xác nhận áp dụng** khi đã sẵn sàng nhé!`
        : `I've prepared the permission change proposal based on your request:\n${lines}\n\nNothing has been changed yet — please review it and click **Approve & Apply** whenever you're ready!`,
    intent: 'propose_setup',
    missingQuestions: [],
    suggestedQuickReplies:
      locale === 'en'
        ? ['What are my permissions?', 'Guide me on configuring AI Support']
        : ['Tôi có quyền gì?', 'Hướng dẫn mình cấu hình AI Support'],
    proposal: savedProposal,
    modelUsed: loopResult.modelUsed,
    usedFallback: false,
  };
}

export async function runSupportSetupCopilotTurn(params: {
  user: SessionUser;
  scope: CopilotUserScope;
  messages: SupportSetupChatMessage[];
  tenantId?: number | null;
  targetMode?: 'create_tenant' | 'update_tenant';
  locale?: 'vi' | 'en';
  currentPath?: string;
  requirementsHint?: Partial<SupportSetupRequirements>;
  baseProposalId?: string;
  diagnostic: SupportSetupTenantDiagnostic | null;
  gatewayLoopback?: GatewayLoopbackContext;
}): Promise<SupportSetupChatResponse> {
  const {
    user,
    scope,
    messages,
    tenantId,
    locale: uiLocale = 'vi',
    currentPath,
    requirementsHint,
    baseProposalId,
    diagnostic,
    gatewayLoopback,
  } = params;

  // Automatically honor the language the user is actually writing in!
  const locale = detectConversationLocale(messages, uiLocale);

  const targetEntry =
    tenantId && tenantId > 0
      ? scope.tenants.find((t) => t.tenant.id === tenantId) ?? null
      : null;

  let baseRequirements: Partial<SupportSetupRequirements> | undefined;
  let priorTargetMode: 'create_tenant' | 'update_tenant' | undefined;
  if (baseProposalId) {
    try {
      const prior = getSetupProposalForUser(baseProposalId, user.userId);
      baseRequirements = prior.requirements;
      if (prior.targetMode === 'create_tenant' || prior.targetMode === 'update_tenant') {
        priorTargetMode = prior.targetMode;
      }
    } catch {
      baseRequirements = undefined;
    }
  }

  const allUserText = messages
    .filter((m) => m.role === 'user')
    .map((m) => m.content)
    .join('\n');
  const explicitCreatePhrase =
    /tạo\s*(?:mới|thêm)\s*(?:1\s*|một\s*)?(?:tenant|con\s*ai|ai\s*support)|create\s+(?:a\s+)?(?:brand-?new|new)\s+(?:tenant|ai\s+support)/i.test(
      allUserText,
    );

  const latestUserMessage =
    [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const latestCreatePhrase =
    /tạo\s*(?:mới|thêm)\s*(?:1\s*|một\s*)?(?:tenant|con\s*ai|ai\s*support)|create\s+(?:a\s+)?(?:brand-?new|new)\s+(?:tenant|ai\s+support)/i.test(
      latestUserMessage,
    );
  const latestPlatformMatch = matchPlatformKnowledgeQuestion(latestUserMessage, currentPath);

  // Permission-aware identity (Phase 1): identity/permissions questions are
  // answered DETERMINISTICALLY from the DB-grounded identity record — never
  // by the LLM, and before any system-settings / proposal evaluation.
  const agentContext = buildCallerIdentity(user, scope);
  if (agentContext && isIdentityOrPermissionsQuestion(latestUserMessage)) {
    return {
      ok: true,
      replyLocale: locale,
      reply: buildIdentityReply(agentContext, locale),
      intent: 'guide',
      missingQuestions: [],
      suggestedQuickReplies: identitySuggestedQuickReplies(locale),
      proposal: null,
      modelUsed: null,
      usedFallback: true,
    };
  }

  const explicitBriefSubmitted = Boolean(
    requirementsHint &&
      (requirementsHint.brandName?.trim() ||
        requirementsHint.industry?.trim() ||
        requirementsHint.faqSummaryOrPolicies?.trim()),
  );

  // Phase 3: deterministic grant/revoke. Runs BEFORE the system-settings
  // pre-eval so an authorized grant is never refused by the sensitive
  // mutation guard, and before the read-only / create-tenant gates so a
  // delegated edit_user_permissions admin (no tenant access) can still use
  // it. Unauthorized requests get a denial reply, never a staged proposal.
  const grantResponse = handlePermissionGrantChatTurn({
    user,
    scope,
    messages,
    tenantId,
    locale,
  });
  if (grantResponse) return grantResponse;

  // System Settings first (BEFORE create_tenant / canEditSet.size === 0 gates so delegated
  // edit_cache / edit_settings / manage_compression admins and sensitive-action guardrails
  // work cleanly without wasting an LLM call).
  if (!latestCreatePhrase && !explicitBriefSubmitted) {
    const preSysEval = evaluateSystemSettingsProposal({
      user,
      messages,
      locale,
    });
    const preSysResponse = resolveSystemSettingsTurnResponse({
      evalResult: preSysEval,
      userId: user.userId,
      locale,
    });
    if (preSysResponse) {
      return preSysResponse;
    }
  }

  // Strict RBAC boundary: if a non-operator explicitly asks to create a brand-new tenant,
  // refuse cleanly without creating a tenant OR silently mutating another tenant.
  if (
    !scope.canCreateTenant &&
    (latestCreatePhrase || (params.targetMode === 'create_tenant' && !latestPlatformMatch))
  ) {
    const assignedHintVi =
      scope.tenants.length > 0 && scope.tenants.some((t) => t.canEditSteps.size > 0)
        ? ` Bạn có thể chọn tenant được phân quyền (**${scope.tenants[0]!.tenant.name}**) để cập nhật các bước trong phạm vi quyền của mình.`
        : '';
    const assignedHintEn =
      scope.tenants.length > 0 && scope.tenants.some((t) => t.canEditSteps.size > 0)
        ? ` You can select your assigned tenant (**${scope.tenants[0]!.tenant.name}**) to update the steps within your granted permissions.`
        : '';
    return {
      ok: true,
      replyLocale: locale,
      reply:
        locale === 'vi'
          ? `Tài khoản của bạn không có quyền tạo Support Tenant mới (mình chỉ thực thi đúng trong phạm vi quyền của người dùng hiện tại).${assignedHintVi}`
          : `Your account does not have permission to create new Support Tenants (the Copilot strictly operates within your user permissions).${assignedHintEn}`,
      intent: 'guide',
      missingQuestions: [],
      suggestedQuickReplies:
        scope.tenants.length > 0 && scope.tenants[0]!.canEditSteps.size > 0
          ? [
              locale === 'vi'
                ? 'Hoàn thiện cấu hình tiêu chuẩn cho tenant hiện tại'
                : 'Auto-complete current tenant with standard defaults',
            ]
          : [
              locale === 'vi'
                ? 'Hướng dẫn tôi chi tiết từng bước để có 1 con AI Support hoàn chỉnh'
                : 'How do I set up a complete AI Support assistant step by step?',
            ],
      proposal: null,
      modelUsed: null,
      usedFallback: true,
    };
  }

  const targetMode: 'create_tenant' | 'update_tenant' =
    scope.canCreateTenant &&
    (params.targetMode === 'create_tenant' ||
      explicitCreatePhrase ||
      priorTargetMode === 'create_tenant' ||
      !targetEntry)
      ? params.targetMode === 'update_tenant' && targetEntry
        ? 'update_tenant'
        : targetEntry && !explicitCreatePhrase && priorTargetMode !== 'create_tenant' && params.targetMode !== 'create_tenant'
          ? 'update_tenant'
          : 'create_tenant'
      : 'update_tenant';

  const effectiveTargetEntry =
    targetMode === 'update_tenant' ? targetEntry ?? scope.tenants[0] ?? null : null;
  const effectiveTenant = effectiveTargetEntry?.tenant ?? null;

  const canEditSet =
    targetMode === 'create_tenant'
      ? new Set<SupportSetupStepId>(scope.canCreateTenant ? SUPPORT_SETUP_STEP_IDS : [])
      : effectiveTargetEntry?.canEditSteps ?? new Set<SupportSetupStepId>();

  // Read-only accounts (0 editable steps and cannot create tenants) can receive coaching/diagnostics,
  // but must NEVER be prompted for auto-deploy requirements or receive a pending_consent tenant proposal.
  if (canEditSet.size === 0) {
    if (effectiveTenant !== null) {
      const readOnlySurgical = analyzeSurgicalSupportEdit({
        messages,
        locale,
        hasExistingTenant: true,
        explicitBriefSubmitted,
      });
      if (readOnlySurgical.isSurgical) {
        const scopedDenied = applySurgicalStepScopingAndMerge({
          existingTenant: effectiveTenant,
          baselineSteps: [],
          analysis: readOnlySurgical,
          canEditSteps: canEditSet,
          locale,
        });
        if (scopedDenied.outcome === 'permission_denied') {
          return {
            ok: true,
            replyLocale: locale,
            reply: scopedDenied.reply,
            intent: 'guide',
            missingQuestions: [],
            suggestedQuickReplies:
              locale === 'vi'
                ? [
                    'Kiểm tra trạng thái 7 bước của tenant này',
                    'Hướng dẫn tôi 7 bước cấu hình AI Support',
                  ]
                : [
                    'Check the 7-step diagnostics on this tenant',
                    'Walk me through the 7 AI Support setup steps',
                  ],
            proposal: null,
            modelUsed: null,
            usedFallback: true,
          };
        }
      }
    }

    const readOnlyDialogue = buildHumanDialogueTurn({
      messages,
      locale,
      currentPath,
      diagnostic,
      activeTenantName: effectiveTenant?.name ?? diagnostic?.tenant.name ?? null,
      targetMode,
      canCreateTenant: false,
      canEditAny: false,
      hasBaseProposal: false,
    });
    const canProposeSystemSettings = hasAnySystemSettingPermission(user);
    // Phase 2: the read-only path also runs through the bounded agent loop
    // (admitted tools only — personal actions + permitted system settings),
    // so a viewer can never be offered a tenant-step tool.
    const readOnlyLoop =
      readOnlyDialogue.act === 'platform_guide' ||
      readOnlyDialogue.act === 'permission_grant_revoke' ||
      canProposeSystemSettings
        ? await runCopilotAgentLoop({
            user,
            scope,
            agentContext,
            messages,
            locale,
            targetMode,
            tenantId: effectiveTenant?.id ?? null,
            currentPath,
            diagnostic,
            extracted: {},
            canCreateTenant: false,
            canEditSteps: canEditSet,
            gatewayLoopback,
          })
        : null;
    const readOnlyLlm = readOnlyLoop?.output
      ? { output: readOnlyLoop.output, modelUsed: readOnlyLoop.modelUsed }
      : null;

    if (readOnlyLlm?.output.systemActions?.length && !explicitBriefSubmitted) {
      const postReadOnlySys = evaluateSystemSettingsProposal({
        user,
        messages,
        locale,
        llmSuggestedActions: readOnlyLlm.output.systemActions,
      });
      const sysResp = resolveSystemSettingsTurnResponse({
        evalResult: postReadOnlySys,
        userId: user.userId,
        locale,
        llmReply:
          readOnlyLlm.output.intent === 'propose_setup' ? readOnlyLlm.output.reply : undefined,
        modelUsed: readOnlyLlm.modelUsed,
      });
      if (sysResp) {
        return sysResp;
      }
    }

    if (readOnlyLoop) {
      const grantResp = resolvePermissionGrantLoopResponse({
        loopResult: readOnlyLoop,
        userId: user.userId,
        locale,
      });
      if (grantResp) return grantResp;
    }

    const useReadOnlyLlm = Boolean(
      readOnlyLlm?.output.reply &&
        (readOnlyLlm.output.intent === 'guide' || !readOnlyLlm.output.intent) &&
        !looksLikeQuestionnaire(readOnlyLlm.output.reply),
    );
    return {
      ok: true,
      replyLocale: locale,
      reply: useReadOnlyLlm ? readOnlyLlm!.output.reply : readOnlyDialogue.reply,
      intent: 'guide',
      missingQuestions: [],
      suggestedQuickReplies:
        useReadOnlyLlm && readOnlyLlm?.output.suggestedQuickReplies?.length
          ? readOnlyLlm.output.suggestedQuickReplies.slice(0, 4)
          : readOnlyDialogue.suggestedQuickReplies,
      proposal: null,
      modelUsed: useReadOnlyLlm ? (readOnlyLlm?.modelUsed ?? null) : null,
      usedFallback: !useReadOnlyLlm,
    };
  }

  const extracted = extractRequirementsFromMessages(
    messages,
    baseRequirements,
    requirementsHint,
    locale,
  );

  // Attempt live human-like LLM coach via the bounded Phase 2 agent loop
  // (Thruline accounts first, then main FreeLLMAPI /v1/chat/completions
  // router). The loop — not a single LLM call — drives tool use, and its
  // output is already scope-filtered (targetSteps/systemActions the caller
  // cannot apply are dropped before any proposal is built).
  const loopResult = await runCopilotAgentLoop({
    user,
    scope,
    agentContext,
    messages,
    locale,
    targetMode,
    tenantId: effectiveTenant?.id ?? null,
    currentPath,
    diagnostic,
    extracted,
    canCreateTenant: scope.canCreateTenant,
    canEditSteps: canEditSet,
    gatewayLoopback,
  });
  const llm = loopResult.output
    ? { output: loopResult.output, modelUsed: loopResult.modelUsed }
    : null;

  if (llm?.output.systemActions?.length && !explicitBriefSubmitted) {
    const postLlmSys = evaluateSystemSettingsProposal({
      user,
      messages,
      locale,
      llmSuggestedActions: llm.output.systemActions,
    });
    const sysResp = resolveSystemSettingsTurnResponse({
      evalResult: postLlmSys,
      userId: user.userId,
      locale,
      llmReply: llm.output.intent === 'propose_setup' ? llm.output.reply : undefined,
      modelUsed: llm.modelUsed,
    });
    if (sysResp) {
      return sysResp;
    }
  }

  // Phase 3: LLM-staged permission grants from the loop's tool records
  // (gate-authorized, server-grounded — never raw LLM text).
  const loopGrantResponse = resolvePermissionGrantLoopResponse({
    loopResult,
    userId: user.userId,
    locale,
  });
  if (loopGrantResponse) return loopGrantResponse;

  const mergedRequirements =
    !latestPlatformMatch && llm?.output.extractedRequirements
      ? extractRequirementsFromMessages([], extracted, llm.output.extractedRequirements, locale)
      : extracted;

  if (effectiveTenant !== null) {
    const surgicalAnalysis = analyzeSurgicalSupportEdit({
      messages,
      locale,
      hasExistingTenant: true,
      explicitBriefSubmitted,
      llmTargetSteps: llm?.output.targetSteps,
    });

    if (surgicalAnalysis.isSurgical) {
      const baselineDraft = buildSanitizedSetupProposal({
        userId: user.userId,
        targetMode: 'update_tenant',
        existingTenant: effectiveTenant,
        requirements: mergedRequirements,
        canEditSteps: canEditSet,
        canViewSteps: effectiveTargetEntry?.canViewSteps,
        canCreateTenant: scope.canCreateTenant,
        isPlatformOperator: scope.isPlatformOperator,
        locale,
      });

      const availableModelIds = scope.isPlatformOperator
        ? undefined
        : new Set<string>([
            'auto',
            ...listCopilotModelOptions().map((m) => m.id),
            ...(effectiveTenant.defaultModel ? [effectiveTenant.defaultModel] : []),
          ]);

      const scoped = applySurgicalStepScopingAndMerge({
        existingTenant: effectiveTenant,
        baselineSteps: baselineDraft.steps,
        analysis: surgicalAnalysis,
        canEditSteps: canEditSet,
        locale,
        availableModelIds,
      });

      if (scoped.outcome === 'permission_denied') {
        return {
          ok: true,
          replyLocale: locale,
          reply: scoped.reply,
          intent: 'guide',
          missingQuestions: [],
          suggestedQuickReplies:
            locale === 'vi'
              ? [
                  'Cập nhật các mục tôi được phân quyền ở tenant này',
                  'Kiểm tra trạng thái 7 bước của tenant hiện tại',
                ]
              : [
                  'Update the steps I have permission for on this tenant',
                  'Check the 7-step readiness of this tenant',
                ],
          proposal: null,
          modelUsed: llm?.modelUsed ?? null,
          usedFallback: !llm,
        };
      }

      if (scoped.outcome === 'scoped') {
        const savedSurgicalProposal = createSetupProposal({
          ...baselineDraft,
          isSurgical: true,
          targetedSteps: scoped.targetedSteps,
          summary: scoped.summary,
          steps: scoped.steps,
        });

        const llmSurgicalStiff = Boolean(
          llm?.output.reply && STIFF_NUMBERED_FORM_RE.test(llm.output.reply),
        );
        const useLlmSurgicalReply = Boolean(
          llm?.output.intent === 'propose_setup' &&
            llm.output.reply &&
            !llmSurgicalStiff &&
            scoped.deniedSteps.length === 0,
        );

        return {
          ok: true,
          replyLocale: locale,
          reply: useLlmSurgicalReply ? llm!.output.reply : scoped.reply,
          intent: 'propose_setup',
          missingQuestions: [],
          suggestedQuickReplies:
            useLlmSurgicalReply && llm?.output.suggestedQuickReplies?.length
              ? llm.output.suggestedQuickReplies.slice(0, 4)
              : locale === 'vi'
                ? [
                    'Kiểm tra các bước cấu hình còn lại của tenant',
                    'Hướng dẫn gắn mã nhúng widget lên website',
                  ]
                : [
                    'Check the remaining steps on this tenant',
                    'Show me how to embed the widget on my site',
                  ],
          proposal: savedSurgicalProposal,
          modelUsed: llm?.modelUsed ?? null,
          usedFallback: !llm,
        };
      }
    }
  }

  const isProposalRefinementTurn = Boolean(
    baseProposalId &&
      ['business_context', 'affirmation_proceed', 'no_website_reassurance'].includes(
        classifyHumanConversationalAct(latestUserMessage, currentPath),
      ),
  );

  const humanTurn = buildHumanDialogueTurn({
    messages,
    locale,
    currentPath,
    requirements: mergedRequirements,
    diagnostic,
    activeTenantName: effectiveTenant?.name ?? diagnostic?.tenant.name ?? null,
    targetMode,
    canCreateTenant: scope.canCreateTenant,
    canEditAny: canEditSet.size > 0,
    hasBaseProposal: isProposalRefinementTurn,
    identityReply: agentContext ? buildIdentityReply(agentContext, locale) : undefined,
  });

  const finalRequirements = humanTurn.extractedRequirements;
  const canSatisfyLlmProposal =
    effectiveTenant !== null ||
    Boolean(finalRequirements.brandName || finalRequirements.industry || humanTurn.topic);

  const llmWantsImmediateProposalOnPushback =
    llm?.output.intent === 'propose_setup' &&
    canSatisfyLlmProposal &&
    (humanTurn.act === 'frustration_pushback' || humanTurn.act === 'hesitation_or_advice');

  let intent: SupportSetupChatIntent;
  if (explicitBriefSubmitted || isProposalRefinementTurn) {
    intent = 'propose_setup';
  } else if (llmWantsImmediateProposalOnPushback) {
    intent = 'propose_setup';
  } else if (humanTurn.intent === 'guide') {
    intent = 'guide';
  } else if (humanTurn.act === 'affirmation_proceed') {
    intent = 'propose_setup';
  } else if (llm?.output.intent === 'gather_requirements') {
    intent = 'gather_requirements';
  } else if (llm?.output.intent === 'guide') {
    intent = 'guide';
  } else if (
    humanTurn.shouldProposeNow ||
    (llm?.output.intent === 'propose_setup' &&
      humanTurn.act !== 'no_website_reassurance' &&
      canSatisfyLlmProposal)
  ) {
    intent = 'propose_setup';
  } else {
    intent = 'gather_requirements';
  }

  const llmReplyHasStiffNumberedForm =
    Boolean(llm?.output.reply && STIFF_NUMBERED_FORM_RE.test(llm.output.reply)) &&
    humanTurn.act !== 'roadmap_guide';

  if (intent === 'guide') {
    const llmMatchesGuideIntent =
      humanTurn.act === 'platform_guide'
        ? llm?.output.intent === 'guide' || !llm?.output.intent
        : llm?.output.intent !== 'propose_setup';
    const useLlmGuideReply = Boolean(
      llm?.output.reply && llmMatchesGuideIntent && !looksLikeQuestionnaire(llm.output.reply),
    );
    return {
      ok: true,
      replyLocale: locale,
      reply: useLlmGuideReply ? llm!.output.reply : humanTurn.reply,
      intent: 'guide',
      missingQuestions: [],
      suggestedQuickReplies:
        useLlmGuideReply && llm?.output.suggestedQuickReplies?.length
          ? llm.output.suggestedQuickReplies.slice(0, 4)
          : humanTurn.suggestedQuickReplies,
      proposal: null,
      modelUsed: useLlmGuideReply ? (llm?.modelUsed ?? null) : null,
      usedFallback: !useLlmGuideReply,
    };
  }

  if (intent === 'gather_requirements') {
    const useLlmGatherReply = Boolean(
      llm?.output.reply &&
        llm.output.intent !== 'propose_setup' &&
        !llmReplyHasStiffNumberedForm,
    );
    return {
      ok: true,
      replyLocale: locale,
      reply: useLlmGatherReply ? llm!.output.reply : humanTurn.reply,
      intent: 'gather_requirements',
      missingQuestions:
        useLlmGatherReply && llm?.output.missingQuestions?.length
          ? llm.output.missingQuestions.slice(0, 5)
          : humanTurn.missingQuestions,
      suggestedQuickReplies:
        useLlmGatherReply && llm?.output.suggestedQuickReplies?.length
          ? llm.output.suggestedQuickReplies.slice(0, 4)
          : humanTurn.suggestedQuickReplies,
      proposal: null,
      modelUsed: useLlmGatherReply ? (llm?.modelUsed ?? null) : null,
      usedFallback: !useLlmGatherReply,
    };
  }

  // intent === 'propose_setup' -> build & persist pending_consent proposal (NO side effects on tenant!)
  const draft = buildSanitizedSetupProposal({
    userId: user.userId,
    targetMode: effectiveTenant ? 'update_tenant' : 'create_tenant',
    existingTenant: effectiveTenant,
    requirements: finalRequirements,
    canEditSteps: canEditSet,
    canViewSteps: effectiveTargetEntry?.canViewSteps,
    canCreateTenant: scope.canCreateTenant,
    isPlatformOperator: scope.isPlatformOperator,
    locale,
  });

  const savedProposal = createSetupProposal(draft);
  const proposalIntro = buildHumanProposalIntro({
    locale,
    proposal: savedProposal,
    priorMessages: messages,
    isRefinement: isProposalRefinementTurn,
    topic: humanTurn.topic,
  });

  const useLlmProposeReply = Boolean(
    llm?.output.intent === 'propose_setup' &&
      llm.output.reply &&
      !llmReplyHasStiffNumberedForm,
  );

  return {
    ok: true,
    replyLocale: locale,
    reply: useLlmProposeReply ? llm!.output.reply : proposalIntro.reply,
    intent: 'propose_setup',
    missingQuestions: [],
    suggestedQuickReplies:
      useLlmProposeReply && llm?.output.suggestedQuickReplies?.length
        ? llm.output.suggestedQuickReplies.slice(0, 4)
        : proposalIntro.suggestedQuickReplies,
    proposal: savedProposal,
    modelUsed: llm?.modelUsed ?? null,
    usedFallback: !llm,
  };
}
