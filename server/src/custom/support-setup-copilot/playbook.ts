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
import { getDb, getUnifiedApiKey } from '../../db/index.js';
import { decrypt } from '../../lib/crypto.js';
import type { SessionUser } from '../../services/auth.js';
import { PLAYGROUND_SESSION_HEADER } from '../playground-attribution.js';
import { resolveAccountProvider } from '../provider-accounts/execution.js';
import { resolveXGatewayAccountProxy } from '../provider-accounts/store.js';
import { getConfigSnapshot } from '../x-gateway/config.js';
import { withQuotaTracking } from '../x-gateway/quota/tracking.js';
import { resolveCandidateRoutes } from '../x-gateway/router.js';
import { listSupportTenants, type SupportTenant } from '../x-gateway/support-store.js';
import { listCopilotModelOptions, type CopilotUserScope } from './diagnostics.js';
import { createSetupProposal, getSetupProposalForUser } from './store.js';

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

    // Brand extraction (allow explicit brand in a later turn to update earlier brand)
    const brandPatterns = [
      /(?:tên\s*(?:shop|cửa hàng|thương hiệu|công ty|doanh nghiệp|dịch vụ|brand|tenant)\s*(?:là|:)|(?:shop|cửa hàng|thương hiệu|công ty|doanh nghiệp|brand)\s*(?:là|:)?)\s*([^\n,.;!?()]{2,50})/i,
      /(?:(?:brand|company|shop|store|business|service|tenant)\s+name\s*(?:is|:)|(?:brand|company|shop|store)\s+(?:is|:|called|named))\s*([^\n,.;!?()]{2,50})/i,
    ];
    for (const pat of brandPatterns) {
      const m = pat.exec(text);
      if (m?.[1]) {
        const candidate = m[1]
          .replace(/^(?:tên là|là)\s+/i, '')
          .replace(/^(?:mỹ phẩm|skincare|thời trang|phần mềm|saas|bán lẻ|bán hàng|giáo dục)\s+(?=[A-ZÀÁÂÃÈÉÊÌÍÒÓÔÕÙÚĂĐĨŨƠƯẠ-Ỹ])/i, '')
          .replace(/\s+(?:chuyên|bán|cung cấp|website|web|tại|ở|màu|giọng|đối thủ)\b.*$/i, '')
          .trim();
        const isGenericPronounOrStop =
          /^(?:tôi|mình|chúng\s+tôi|chúng\s+mình|bạn|của\s+tôi|của\s+mình|của\s+chúng\s+tôi|cho\s+tôi|giúp\s+tôi|mới|hiện\s+tại|này|ai|support|my|our|me|for\s+me|new|current)\b/i.test(
            candidate,
          );
        const hasUpperOrExplicit =
          /[A-ZÀÁÂÃÈÉÊÌÍÒÓÔÕÙÚĂĐĨŨƠƯẠ-Ỹ]/.test(candidate) ||
          /tên.*(?:là|:)|name\s*(?:is|:)|called|named/i.test(m[0]);
        if (candidate.length >= 2 && !isGenericPronounOrStop && hasUpperOrExplicit) {
          merged.brandName = candidate.slice(0, 80);
          break;
        }
      }
    }

    // Industry extraction
    for (const entry of INDUSTRY_PATTERNS) {
      if (entry.re.test(text)) {
        merged.industry = locale === 'vi' ? entry.vi : entry.en;
        break;
      }
    }

    // Website origin extraction
    const urlMatch = /(https?:\/\/[^\s,;"'<>)]+)/i.exec(text);
    if (urlMatch?.[1]) {
      merged.websiteOrigin = normalizeWebsiteOrigins(urlMatch[1])[0];
    } else {
      const domainMatch = /\b([a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:vn|com|net|org|io|co|ai|app|dev|edu|info))\b/i.exec(
        text,
      );
      if (domainMatch?.[1]) {
        merged.websiteOrigin = normalizeWebsiteOrigins(domainMatch[1])[0];
      }
    }

    // Language extraction
    if (/song ngữ|bilingual|việt\s*(?:&|và|\+)\s*anh|english\s*(?:&|and)\s*vietnamese/i.test(text)) {
      merged.language = 'bilingual';
    } else if (/tiếng anh|\benglish\b/i.test(text)) {
      merged.language = 'en';
    } else if (/tiếng việt|\bvietnamese\b/i.test(text)) {
      merged.language = 'vi';
    }

    // Tone extraction
    if (/đồng cảm|ân cần|empathetic/i.test(text)) merged.tone = 'empathetic';
    else if (/kỹ thuật|technical/i.test(text)) merged.tone = 'technical';
    else if (/chuyên nghiệp|trang trọng|lịch sự|professional|formal/i.test(text)) {
      merged.tone = 'professional';
    } else if (/thân thiện|nhiệt tình|gần gũi|vui vẻ|friendly/i.test(text)) {
      merged.tone = 'friendly';
    }

    // Primary color extraction (later user turn overrides earlier color)
    const hexMatch = /(#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3})\b/.exec(text);
    if (hexMatch?.[1]) {
      merged.primaryColor = normalizeHexColor(hexMatch[1]);
    } else {
      for (const [pattern, hex] of NAMED_COLORS) {
        if (pattern.test(text)) {
          merged.primaryColor = hex;
          break;
        }
      }
    }

    // Competitor keywords extraction
    const compMatch = /(?:đối thủ|không nhắc(?:\s+tên|\s+đến)?|tránh nhắc|competitor(?:s)?)\s*(?:là|:)?\s*([^\n.;!?]+)/i.exec(
      text,
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
      text,
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
    if (/không cần\s*(?:form|thu thập|nhập email)|no\s*intake/i.test(text)) {
      merged.requireContactIntake = false;
    } else if (
      /thu thập\s*(?:email|sđt|số điện thoại|thông tin)|nhập\s*email|pre-?chat|intake\s*form|collect.*email/i.test(
        text,
      )
    ) {
      merged.requireContactIntake = true;
    }

    // FAQ / Policy summary capture from informative user messages
    const hasPolicyKeywords =
      /đổi trả|bảo hành|hoàn tiền|giao hàng|ship|freeship|giá|thanh toán|giờ làm việc|chính sách|return|refund|shipping|warranty|pricing|hours|policy|sla/i.test(
        text,
      );
    const isMetaQuestion =
      /^(?:xin\s+chào|chào|hello|hi\b|bạn\s+có\s+thể|bạn\s+biết|hướng\s+dẫn|giải\s+thích|làm\s+sao|how\s+do|can\s+you\s+speak)/i.test(
        text.trim(),
      );
    const trimmed = text.trim();
    if (!isMetaQuestion && (hasPolicyKeywords || (!merged.faqSummaryOrPolicies && trimmed.length >= 60))) {
      merged.faqSummaryOrPolicies = trimmed.slice(0, 2000);
    }
  }

  // Explicit Quick Brief hint fields win last
  if (hint) {
    if (hint.brandName?.trim()) merged.brandName = hint.brandName.trim().slice(0, 80);
    if (hint.tenantSlug?.trim()) merged.tenantSlug = hint.tenantSlug.trim().slice(0, 48);
    if (hint.industry?.trim()) merged.industry = hint.industry.trim().slice(0, 80);
    if (hint.websiteOrigin?.trim()) merged.websiteOrigin = hint.websiteOrigin.trim().slice(0, 200);
    if (hint.language) merged.language = hint.language;
    if (hint.tone) merged.tone = hint.tone;
    if (hint.primaryColor?.trim()) merged.primaryColor = normalizeHexColor(hint.primaryColor);
    if (hint.faqSummaryOrPolicies?.trim()) {
      merged.faqSummaryOrPolicies = hint.faqSummaryOrPolicies.trim().slice(0, 2000);
    }
    if (hint.blockedTopics?.length) {
      merged.blockedTopics = normalizeStringList(hint.blockedTopics, 20, 80);
    }
    if (hint.competitorKeywords?.length) {
      merged.competitorKeywords = normalizeStringList(hint.competitorKeywords, 20, 80);
    }
    if (typeof hint.requireContactIntake === 'boolean') {
      merged.requireContactIntake = hint.requireContactIntake;
    }
    if (hint.defaultModel?.trim()) {
      merged.defaultModel = hint.defaultModel.trim().slice(0, 120);
    }
  }

  return merged;
}

const VI_DIACRITIC_RE =
  /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;

const VI_UNACCENTED_PHRASE_RE =
  /\b(?:xin\s+chao|chao\s+ban|ban\s+co\s+the|co\s+the\s+noi|tieng\s+viet|giup\s+toi|giup\s+minh|cho\s+toi|cho\s+minh|cua\s+toi|cua\s+minh|lam\s+sao|nhu\s+the\s+nao|thiet\s+lap|cai\s+dat|huong\s+dan|buoc\s*[1-7]|duoc\s+khong|tuy\s+ban|lam\s+luon|mac\s+dinh|chua\s+co\s+web|cam\s+on|ban\s+la\s+ai)\b/i;

const EXPLICIT_SPEAK_VI_RE =
  /\b(?:speak|talk\s+in|reply\s+in|use|switch\s+to)\s+vietnamese\b|(?:nói|dùng|trả\s+lời|giao\s+tiếp|chat)\s*(?:bằng\s*)?tiếng\s*việt|tieng\s+viet\s+(?:khong|duoc\s+khong|nhe|di)/i;

const EXPLICIT_SPEAK_EN_RE =
  /^(?:please\s+)?(?:can\s+you\s+)?(?:speak|talk\s+in|reply\s+in|switch\s+to)\s+english\b|(?:nói|trả\s+lời\s+bằng)\s+tiếng\s+anh\s+(?:với\s+(?:tôi|mình)|nhé|đi)/i;

const EN_SENTENCE_MARKER_RE =
  /\b(?:how\s+do|how\s+to|can\s+you|could\s+you|please|set\s+up|configure|explain|my\s+(?:shop|store|company|business|tenant)|auto-complete|standard\s+defaults|hello|hi\s+there|what\s+is|what\s+can\s+you|who\s+are\s+you|support\s+hours|onboarding|collect\s+customer)\b/i;

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

function isGuideQuestion(text: string): boolean {
  const lower = text.toLowerCase();
  const asksHow =
    /hướng dẫn|các bước|lộ trình|quy trình|làm sao|như thế nào|cách dùng|cách setup|tại sao|là gì|ở đâu|roadmap|how to|how do i|steps to|guide|explain|what does|what is|where do i|troubleshooting|kiểm tra tình trạng/i.test(
      lower,
    );
  const asksAutoDoIt =
    /setup giúp|setup thay|làm giúp|làm thay|cài đặt tự động|tự động setup|thiết lập giúp|thiết lập thay|tạo giúp|tạo giùm|hoàn thiện giúp|auto[- ]?setup|set up .*for me|configure .*for me|do it for me/i.test(
      lower,
    );
  return asksHow && !asksAutoDoIt;
}

function isLanguageOrCapabilityTurn(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length > 140) return false;
  return (
    EXPLICIT_SPEAK_VI_RE.test(trimmed) ||
    EXPLICIT_SPEAK_EN_RE.test(trimmed) ||
    /(?:bạn|ban|em|ai)\s+(?:có\s+thể|co\s+the|biết|biet)\s+(?:nói|noi)\s+(?:tiếng|tieng)|can\s+you\s+speak|do\s+you\s+speak|(?:bạn|ban)\s+(?:là|la)\s+ai|(?:bạn|ban)\s+(?:làm\s+được\s+gì|lam\s+duoc\s+gi)|chức\s+năng\s+của\s+bạn|who\s+are\s+you|what\s+can\s+you\s+do/i.test(
      trimmed,
    )
  );
}

function isGreetingOrThanksTurn(text: string): 'greeting' | 'thanks' | null {
  const trimmed = text.trim();
  if (trimmed.length > 60) return null;
  if (
    /^(?:(?:xin\s+)?(?:chào|chao)(?:\s+(?:bạn|ban|ad|em|anh|chị|ai|mình))?|alo|hi|hello|hey|good\s+(?:morning|afternoon|evening)|ban\s+oi|bạn\s+ơi)[!.?,\s]*$/i.test(
      trimmed,
    )
  ) {
    return 'greeting';
  }
  if (/^(?:cảm\s+ơn|cám\s+ơn|cam\s+on|thank\s+you|thanks|ok\s+cảm\s+ơn|ok\s+cam\s+on|tuyệt\s+vời)[!.?,\s]*$/i.test(trimmed)) {
    return 'thanks';
  }
  return null;
}

function matchSpecificStepQuestion(text: string): SupportSetupStepId | null {
  const trimmed = text.trim();
  // Only treat as a focused step question when user is asking a question / seeking explanation,
  // not when submitting a full multi-field business description.
  const looksLikeQuestion =
    /\?|làm\s+sao|như\s+thế\s+nào|là\s+gì|ở\s+đâu|cách\s+|giải\s+thích|bước\s*[1-7]|step\s*[1-7]|how\s+|what\s+|where\s+|explain/i.test(
      trimmed,
    );
  if (!looksLikeQuestion) return null;
  // Don't hijack explicit "explain all 7 steps" overview queries
  if (/(?:7|bảy|all|từng|các)\s*(?:bước|steps)/i.test(trimmed)) return null;

  if (/bước\s*1|step\s*1|system\s*prompt|nhân\s*cách|persona/i.test(trimmed)) return 'tenant_ai';
  if (/bước\s*2|step\s*2|knowledge|\brag\b|tài\s*liệu|tri\s*thức|\bfaq\b|\bpii\b|masking|che\s*(?:dữ\s*liệu|sđt|email)/i.test(trimmed)) {
    return 'knowledge_masking';
  }
  if (/bước\s*3|step\s*3|guardrail|firewall|tường\s*lửa|injection|quota|hạn\s*mức|chủ\s*đề\s*cấm/i.test(trimmed)) {
    return 'guardrails_quotas';
  }
  if (/bước\s*4|step\s*4|output\s*control|kiểm\s*soát\s*đầu\s*ra|redact|che\s*khóa/i.test(trimmed)) {
    return 'output_controls';
  }
  if (/bước\s*5|step\s*5|widget|nút\s*chat|khung\s*chat|intake|form\s*thu\s*thập/i.test(trimmed)) {
    return 'widget_appearance';
  }
  if (/bước\s*6|step\s*6|\bsla\b|routing|phân\s*luồng|service\s*desk|ticket/i.test(trimmed)) {
    return 'sla_routing';
  }
  if (/bước\s*7|step\s*7|\bcors\b|origin|nhúng|embed|<script|snippet|runtime|context\s*token/i.test(trimmed)) {
    return 'runtime_policy';
  }
  return null;
}

function asksAutoCompleteWithDefaults(text: string): boolean {
  return /tiêu chuẩn|mặc định|tùy bạn|tuy ban|sao cũng được|chọn giúp|tự chọn|làm luôn|tạo luôn|triển khai luôn|cứ đề xuất|chưa có website|không có website|chua co web|dùng cấu hình mặc định|auto[- ]?complete|standard defaults|tự đề xuất toàn bộ|use defaults|up to you|just set it up|no website yet/i.test(
    text,
  );
}

function hasSufficientContextForProposal(
  req: SupportSetupRequirements,
  targetMode: 'create_tenant' | 'update_tenant',
  activeTenant: SupportTenant | null,
  latestUserMessage: string,
  hasBaseProposal: boolean,
): boolean {
  if (hasBaseProposal) return true;
  if (asksAutoCompleteWithDefaults(latestUserMessage)) {
    return true;
  }
  const hasPolicyOrIndustry = Boolean(req.industry || req.faqSummaryOrPolicies);
  if (targetMode === 'update_tenant' && activeTenant) {
    return hasPolicyOrIndustry || Boolean(req.brandName || req.websiteOrigin || req.primaryColor || req.tone);
  }
  return Boolean(req.brandName && (hasPolicyOrIndustry || req.websiteOrigin || req.primaryColor || req.tone));
}

function buildKnowledgeDocs(params: {
  brandName: string;
  industry: string;
  language: SupportSetupLanguage;
  faqSummary: string;
  websiteHost: string;
}): SupportSetupKnowledgeDocSeed[] {
  const { brandName, industry, language, faqSummary, websiteHost } = params;
  const isVi = language === 'vi';

  if (isVi) {
    return [
      {
        title: `${brandName} - Tổng quan dịch vụ & Kênh hỗ trợ`,
        category: 'overview',
        tags: ['tong-quan', 'lien-he', 'ho-tro'],
        allowedRoles: ['guest', 'customer', 'staff', 'admin'],
        content: [
          `# Giới thiệu ${brandName}`,
          `- Lĩnh vực: ${industry}`,
          websiteHost ? `- Kênh chính thức: ${websiteHost}` : '- Kênh hỗ trợ: Trực tuyến qua Support Chat Widget',
          '- Thời gian phản hồi AI: Ngay lập tức 24/7; yêu cầu cần nhân viên xử lý sẽ được chuyển tới Service Desk theo mức ưu tiên.',
        ].join('\n'),
      },
      {
        title: `${brandName} - Chính sách & Câu hỏi thường gặp (FAQ)`,
        category: 'policy',
        tags: ['chinh-sach', 'faq', 'quy-dinh'],
        allowedRoles: ['guest', 'customer', 'staff', 'admin'],
        content: [
          `# Chính sách dịch vụ & FAQ của ${brandName}`,
          faqSummary
            ? `## Thông tin chính thức từ doanh nghiệp\n${faqSummary}`
            : '## Quy chuẩn phục vụ\n- Tư vấn minh bạch thông tin sản phẩm/dịch vụ, giá niêm yết và điều kiện áp dụng.\n- Mọi khiếu nại hoặc yêu cầu đặc biệt sẽ được tạo ticket để bộ phận chuyên trách hỗ trợ.',
          '',
          '## Quy tắc trả lời',
          '- Luôn trích dẫn thông tin từ tài liệu này hoặc xác nhận lại khi khách cần tra cứu đơn hàng/tài khoản riêng.',
          '- Không bịa đặt mã đơn hàng, giá khuyến mãi hết hạn hoặc cam kết ngoài chính sách.',
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
      ].join('\n'),
    },
    {
      title: `${brandName} - Core Policies & Frequently Asked Questions`,
      category: 'policy',
      tags: ['policy', 'faq', 'terms'],
      allowedRoles: ['guest', 'customer', 'staff', 'admin'],
      content: [
        `# ${brandName} Service Policies & FAQ`,
        faqSummary
          ? `## Business Policies & Key Facts\n${faqSummary}`
          : '## Standard Service Guidelines\n- Provide clear, accurate answers about pricing, eligibility, onboarding, and support hours.\n- Escalate billing disputes or account-specific changes to the Service Desk queue.',
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
}): string {
  const { brandName, industry, language, tone, faqSummary } = params;
  const langInstruction =
    language === 'vi'
      ? 'Always respond in clear, natural Vietnamese unless the customer explicitly writes in another language.'
      : language === 'bilingual'
        ? 'Respond in the same language as the customer (Vietnamese or English).'
        : 'Always respond in clear, concise English unless the customer writes in another language.';

  const toneInstruction: Record<SupportSetupTone, string> = {
    friendly: 'Use a warm, friendly, approachable customer-support tone.',
    professional: 'Use a polished, respectful, business-professional tone.',
    empathetic: 'Use an empathetic, patient, reassuring customer-care tone.',
    technical: 'Use a precise, solution-oriented technical support tone.',
  };

  return [
    `You are the official AI Customer Support Assistant for ${brandName} (${industry}).`,
    langInstruction,
    toneInstruction[tone],
    'Ground your answers in retrieved knowledge documents and authorized tools. Never fabricate order statuses, prices, credentials, or internal policies.',
    'If a customer needs account-specific actions beyond available tools, or asks to speak to a human, acknowledge clearly and guide them through escalation.',
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

  const brandName = (
    requirements.brandName?.trim() ||
    existingTenant?.name ||
    'Customer Support AI'
  ).slice(0, 80);

  const tenantSlug =
    targetMode === 'update_tenant' && existingTenant
      ? existingTenant.slug
      : sanitizeSlug(requirements.tenantSlug || brandName, existingSlugs);

  const language: SupportSetupLanguage =
    requirements.language ?? (locale === 'vi' ? 'vi' : 'en');
  const tone: SupportSetupTone = requirements.tone ?? 'friendly';
  const industry =
    requirements.industry?.trim() ||
    (language === 'en' ? 'Customer Service & Digital Products' : 'Dịch vụ khách hàng');
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
  const isVi = language === 'vi';
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
      ? `Xin chào! Tôi là trợ lý AI của ${brandName}. Bạn cần tư vấn thông tin hay hỗ trợ chính sách nào hôm nay?`
      : `Hello! I am the AI Support Assistant for ${brandName}. How can I help you today?`,
    SUPPORT_DESK_LIMITS.maxTextChars,
    'Hello! How can I help you today?',
  );
  const quickPrompts = isVi
    ? [
        sanitizeWidgetSafeText(`Chính sách dịch vụ của ${brandName}`, 80, 'Chính sách dịch vụ'),
        sanitizeWidgetSafeText('Hướng dẫn liên hệ & thời gian hỗ trợ', 80, 'Thời gian hỗ trợ'),
        sanitizeWidgetSafeText('Tôi cần gặp nhân viên tư vấn', 80, 'Gặp nhân viên'),
      ]
    : [
        sanitizeWidgetSafeText(`${brandName} policies and FAQ`, 80, 'Service policies'),
        sanitizeWidgetSafeText('Support hours & contact options', 80, 'Support hours'),
        sanitizeWidgetSafeText('Connect me with a human agent', 80, 'Speak to agent'),
      ];

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
        isVi ? 'Nhập câu hỏi của bạn...' : 'Ask a question...',
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
      summaryEn: `Allowed origins: ${allowedOrigins.join(', ')} · maxCompletionTokens: ${runtimePayload.maxCompletionTokens}`,
      summaryVi: `CORS cho phép: ${allowedOrigins.join(', ')} · maxCompletionTokens: ${runtimePayload.maxCompletionTokens}`,
      highlightsEn: [
        `Bind CORS origins to ${allowedOrigins.join(', ')}`,
        'Set bounded runtime limits (640 completion tokens, 3 model/tool turns)',
      ],
      highlightsVi: [
        `Cấu hình CORS cho ${allowedOrigins.join(', ')}`,
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

function formatGuideReply(
  locale: 'vi' | 'en',
  diagnostic: SupportSetupTenantDiagnostic | null,
  canCreateTenant: boolean,
  canEditAny = true,
): { reply: string; quickReplies: string[] } {
  const stepIcon = (status: SupportSetupTenantDiagnostic['steps'][number]['status']) =>
    status === 'complete'
      ? '✅'
      : status === 'partial'
        ? '🟡'
        : status === 'restricted'
          ? '🔒'
          : '⭕';

  if (locale === 'vi') {
    const statusHeader = diagnostic
      ? `Hiện tại tenant **${diagnostic.tenant.name}** đang hoàn thành **${diagnostic.completedSteps}/${diagnostic.totalSteps} bước**:\n` +
        diagnostic.steps
          .map((st, idx) => `${idx + 1}. ${stepIcon(st.status)} ${st.summaryVi}`)
          .join('\n')
      : canCreateTenant
        ? 'Bạn chưa chọn hoặc chưa tạo Support Tenant nào. Tôi có thể hướng dẫn hoặc tự động tạo mới trọn bộ thay cho bạn!'
        : 'Hãy chọn tenant được phân quyền để xem tiến độ thiết lập chi tiết.';

    const footerLine =
      canEditAny || canCreateTenant
        ? 'Nếu bạn thấy phức tạp, chỉ cần nói **"Setup giúp tôi"** — tôi sẽ hỏi bạn vài thông tin ngắn gọn rồi đề xuất kế hoạch để bạn duyệt và tự triển khai các bước trong phạm vi quyền của bạn!'
        : 'Tài khoản hiện tại của bạn đang ở chế độ **Chỉ xem (Read-Only)** nên tôi có thể giải thích chi tiết từng bước, nhưng sẽ không tự động thay đổi cấu hình vượt quyền của bạn.';

    const reply = [
      'Để có **1 con AI Support hoàn chỉnh** chạy mượt trên website/app, hệ thống gồm **7 bước cốt lõi**:',
      '',
      '1. **AI Support Gateway** (`/thruline/support`): Tạo Tenant, chọn model mặc định và viết System Prompt định hình vai trò trợ lý.',
      '2. **Knowledge & Evidence** (`/thruline/support-knowledge`): Nạp FAQ/chính sách (**lưu ý:** bật quyền `guest` & `customer` để widget khách hàng tìm thấy tài liệu) và bật PII Masking che email/SĐT/thẻ.',
      '3. **Support Governance** (`/thruline/support-guardrails`): Bật tường lửa chống prompt injection, chủ đề cấm, từ khóa đối thủ và hạn mức theo vai trò.',
      '4. **Output Controls** (`/thruline/support-output`): Chuyển chế độ sang `enforce` và bật che khóa bí mật đầu ra.',
      '5. **Widget Appearance** (`/thruline/support-desk`): Bật widget chat, chỉnh màu thương hiệu, lời chào và câu gợi ý nhanh.',
      '6. **SLA & Auto-Routing** (`/thruline/support-desk`): Bật mục tiêu phản hồi SLA và quy tắc phân loại bộ phận (Billing, Technical, Returns).',
      '7. **Integration Studio** (`/thruline/support-integration`): Giới hạn domain CORS hợp lệ, kiểm tra Readiness và copy mã `<script>` nhúng lên website.',
      '',
      statusHeader,
      '',
      footerLine,
    ].join('\n');

    const quickReplies: string[] = [];
    if (diagnostic && canEditAny) {
      quickReplies.push('Hoàn thiện cấu hình tiêu chuẩn cho tenant hiện tại');
    }
    if (canCreateTenant) {
      quickReplies.push(
        diagnostic
          ? 'Tạo mới 1 AI Support trọn gói thay cho tôi'
          : 'Thiết lập tự động trọn gói AI Support thay cho tôi',
      );
    }

    return { reply, quickReplies };
  }

  const statusHeader = diagnostic
    ? `Current tenant **${diagnostic.tenant.name}** readiness: **${diagnostic.completedSteps}/${diagnostic.totalSteps} steps complete**:\n` +
      diagnostic.steps
        .map((st, idx) => `${idx + 1}. ${stepIcon(st.status)} ${st.summaryEn}`)
        .join('\n')
    : 'No Support Tenant selected yet. I can guide you or create and configure a complete tenant for you.';

  const footerLine =
    canEditAny || canCreateTenant
      ? 'If you prefer, just say **"Set it up for me"** — I will ask a few reasonable questions, show you a transparent plan for consent, and deploy the steps permitted by your role once you approve.'
      : 'Your current account has **Read-Only** access, so I can walk you through any step, without modifying settings beyond your permissions.';

  const reply = [
    'Building a production-ready **AI Support Assistant** takes **7 core steps**:',
    '',
    '1. **AI Support Gateway** (`/thruline/support`): Create your Tenant, pick a default model, and set the System Prompt.',
    '2. **Knowledge & Evidence** (`/thruline/support-knowledge`): Add FAQs/policies (ensure `guest` & `customer` are in `allowedRoles`) and enable PII Masking.',
    '3. **Support Governance** (`/thruline/support-guardrails`): Enable prompt-injection firewall, blocked topics, competitor filters, and role quotas.',
    '4. **Output Controls** (`/thruline/support-output`): Set output policy mode to `enforce` and enable credential redaction.',
    '5. **Widget Appearance** (`/thruline/support-desk`): Enable the embeddable chat widget, brand colors, welcome message, and quick prompts.',
    '6. **SLA & Auto-Routing** (`/thruline/support-desk`): Enable SLA targets and keyword routing rules for Service Desk departments.',
    '7. **Integration Studio** (`/thruline/support-integration`): Lock allowed CORS origins, verify Integration Readiness, and embed the `<script>` snippet.',
    '',
    statusHeader,
    '',
    footerLine,
  ].join('\n');

  const quickReplies: string[] = [];
  if (diagnostic && canEditAny) {
    quickReplies.push('Auto-complete current tenant with standard defaults');
  }
  if (canCreateTenant) {
    quickReplies.push(
      diagnostic
        ? 'Create a brand-new AI Support setup for me'
        : 'Set up a complete AI Support assistant for me',
    );
  }

  return { reply, quickReplies };
}

const STEP_FOCUSED_GUIDES: Record<
  SupportSetupStepId,
  { vi: string; en: string }
> = {
  tenant_ai: {
    vi: [
      '**Bước 1 — Tenant & Nhân cách AI** (`/thruline/support` · tab *AI & Prompt*):',
      '- Định nghĩa **System Prompt** (vai trò, giọng điệu, ranh giới trả lời), chọn **Model mặc định** (`auto` để tự chuyển đổi dự phòng) và bật `allowGuest` nếu muốn khách vãng lai chat ngay trên web.',
      '- Bạn có thể cho mình biết tên shop + giọng điệu mong muốn để mình soạn sẵn System Prompt cho bạn duyệt!',
    ].join('\n'),
    en: [
      '**Step 1 — Tenant & AI Persona** (`/thruline/support` · *AI & Prompt* tab):',
      '- Configure the **System Prompt** (role, tone, grounding boundaries), choose a **Default Model** (`auto` for automatic failover), and enable `allowGuest` for website visitors.',
      '- Share your brand name and preferred tone if you want me to draft and apply it for you!',
    ].join('\n'),
  },
  knowledge_masking: {
    vi: [
      '**Bước 2 — Tri thức FAQ (RAG) & Che dữ liệu nhạy cảm** (`/thruline/support-knowledge`):',
      '- Nạp các bài FAQ, bảng giá, chính sách đổi trả/bảo hành. **Lưu ý quan trọng:** nhớ tích quyền `guest` và `customer` trong `allowedRoles` thì khách chat ngoài widget mới tra cứu được tài liệu.',
      '- Bật **PII Masking** (`email`, `phone`, `credit_card`, `api_key`) để tự động che SĐT/email/thẻ của khách trước khi gửi lên model.',
    ].join('\n'),
    en: [
      '**Step 2 — Knowledge Base (RAG) & PII Masking** (`/thruline/support-knowledge`):',
      '- Add your FAQs, pricing, and return policies. **Important:** include `guest` and `customer` in `allowedRoles` so customer widgets can retrieve those articles.',
      '- Turn on **PII Masking** (`email`, `phone`, `credit_card`, `api_key`) to redact sensitive user data automatically.',
    ].join('\n'),
  },
  guardrails_quotas: {
    vi: [
      '**Bước 3 — Tường lửa Prompt & Hạn mức vai trò** (`/thruline/support-guardrails`):',
      '- Bật 4 bộ chặn **Prompt Injection** (chống khách dùng mẹo ép AI lộ prompt hoặc vượt rào), thêm **chủ đề cấm** và **từ khóa đối thủ**.',
      '- Đặt **Role Quotas** (VD: khách vãng lai 20 lượt/giờ, khách hàng đăng nhập 80 lượt/giờ) để bảo vệ hạn mức token.',
    ].join('\n'),
    en: [
      '**Step 3 — Prompt Firewall & Role Quotas** (`/thruline/support-guardrails`):',
      '- Enable all 4 **Prompt Injection** detectors, add **blocked topics** and **competitor keywords**, and set hourly request/token quotas per user role (`guest`, `customer`, `staff`).',
    ].join('\n'),
  },
  output_controls: {
    vi: [
      '**Bước 4 — Kiểm soát an toàn đầu ra** (`/thruline/support-output`):',
      '- Chuyển chế độ sang **`enforce`** và bật **Che khóa bí mật (`redactCredentials`)** để mọi câu trả lời của AI đều được quét lần cuối trước khi hiển thị cho khách.',
    ].join('\n'),
    en: [
      '**Step 4 — Output Safety Controls** (`/thruline/support-output`):',
      '- Set mode to **`enforce`** and enable **`redactCredentials`** so outbound AI replies are scrubbed for leaked secrets or restricted terms before reaching customers.',
    ].join('\n'),
  },
  widget_appearance: {
    vi: [
      '**Bước 5 — Giao diện Chat Widget & Form liên hệ** (`/thruline/support-desk`):',
      '- Bật Widget nhúng web, chọn **màu thương hiệu**, tiêu đề, lời chào mở đầu và 3 câu hỏi gợi ý nhanh.',
      '- Tùy chọn bật **Pre-chat Intake** nếu bạn muốn thu thập Tên & Email khách trước khi bắt đầu hội thoại.',
    ].join('\n'),
    en: [
      '**Step 5 — Customer Chat Widget & Intake** (`/thruline/support-desk`):',
      '- Enable the embeddable widget, customize brand colors, welcome message, quick prompts, and optionally require a Name/Email intake form before chat.',
    ].join('\n'),
  },
  sla_routing: {
    vi: [
      '**Bước 6 — SLA Service Desk & Tự động phân luồng** (`/thruline/support-desk`):',
      '- Thiết lập thời gian cam kết phản hồi (VD: khẩn cấp 5 phút, cao 15 phút) và quy tắc từ khóa để tự chuyển ticket về đúng bộ phận **Đổi trả (`returns`)**, **Thanh toán (`billing`)** hoặc **Kỹ thuật (`technical`)**.',
    ].join('\n'),
    en: [
      '**Step 6 — Service Desk SLA & Department Routing** (`/thruline/support-desk`):',
      '- Configure first-response/resolution SLA targets and keyword rules to auto-route escalated tickets to `returns`, `billing`, or `technical` queues.',
    ].join('\n'),
  },
  runtime_policy: {
    vi: [
      '**Bước 7 — Tên miền CORS, Giới hạn Runtime & Mã nhúng** (`/thruline/support-integration`):',
      '- Khóa **Allowed Origins (CORS)** đúng tên miền website của bạn, đặt giới hạn token/lượt gọi tool mỗi câu trả lời, sau đó copy đoạn mã `<script>` dán vào trước thẻ `</body>` trên website.',
    ].join('\n'),
    en: [
      '**Step 7 — CORS Origins, Runtime Limits & Embed Snippet** (`/thruline/support-integration`):',
      '- Lock **Allowed Origins (CORS)** to your website domain, set safe token/tool turn limits, and paste the `<script>` snippet into your site.',
    ].join('\n'),
  },
};

function tryBuildConversationalSpecialReply(params: {
  latestUserMessage: string;
  locale: 'vi' | 'en';
  diagnostic: SupportSetupTenantDiagnostic | null;
  canCreateTenant: boolean;
  canEditAny: boolean;
}): { reply: string; quickReplies: string[] } | null {
  const { latestUserMessage, locale, diagnostic, canCreateTenant, canEditAny } = params;
  const tenantInfoVi = diagnostic
    ? `Hiện tại tenant **${diagnostic.tenant.name}** của bạn đang hoàn thành **${diagnostic.completedSteps}/${diagnostic.totalSteps} bước**.`
    : canCreateTenant
      ? 'Bạn có thể chọn một tenant sẵn có hoặc nhờ mình tạo mới hoàn toàn một AI Support.'
      : '';
  const tenantInfoEn = diagnostic
    ? `Your active tenant **${diagnostic.tenant.name}** currently has **${diagnostic.completedSteps}/${diagnostic.totalSteps} steps** ready.`
    : canCreateTenant
      ? 'You can pick an existing tenant or ask me to create a brand-new AI Support setup.'
      : '';

  const defaultActionChips =
    locale === 'vi'
      ? [
          ...(diagnostic && canEditAny
            ? ['Hoàn thiện cấu hình tiêu chuẩn cho tenant hiện tại']
            : canCreateTenant
              ? ['Tạo mới 1 AI Support trọn gói thay cho tôi']
              : []),
          'Hướng dẫn chi tiết 7 bước setup',
          ...(canEditAny
            ? ['Shop mỹ phẩm GlowSkin, đổi trả 7 ngày, màu hồng #ec4899, giọng thân thiện']
            : []),
        ]
      : [
          ...(diagnostic && canEditAny
            ? ['Auto-complete current tenant with standard defaults']
            : canCreateTenant
              ? ['Create a brand-new AI Support setup for me']
              : []),
          'How do I set up a complete AI Support assistant step by step?',
          ...(canEditAny
            ? ['GlowSkin Skincare shop, 7-day returns, #ec4899 pink, friendly tone']
            : []),
        ];

  if (isLanguageOrCapabilityTurn(latestUserMessage)) {
    if (locale === 'vi') {
      return {
        reply: [
          'Dạ hoàn toàn được ạ — mình giao tiếp bằng **tiếng Việt** 100% nhé!',
          '',
          `Mình là **Trợ lý Setup AI Support**. ${tenantInfoVi}`.trim(),
          canEditAny
            ? '- **Nếu muốn mình làm thay trọn gói:** Bạn chỉ cần kể ngắn gọn về shop/dịch vụ (hoặc bấm *"Hoàn thiện cấu hình tiêu chuẩn"* bên dưới), mình sẽ lên sẵn phương án 7 bước và chờ bạn bấm **Đồng ý** mới triển khai.\n- **Nếu muốn tìm hiểu từng phần:** Bạn thắc mắc bước nào (System Prompt, nạp FAQ, che SĐT/email, chặn từ khóa, chỉnh màu Widget, SLA hay nhúng web) cứ hỏi tự nhiên nhé!'
            : '- Mình có thể giải thích cặn kẽ từng bước cấu hình và chẩn đoán tiến độ hiện tại cho bạn bất cứ lúc nào.',
        ].join('\n'),
        quickReplies: defaultActionChips,
      };
    }
    return {
      reply: [
        'Yes! I can communicate fluently in **English** (or **Vietnamese** whenever you prefer).',
        '',
        `I am your **AI Support Setup Copilot**. ${tenantInfoEn}`.trim(),
        canEditAny
          ? '- **Auto-setup for you:** Share a quick summary of your business (or pick standard defaults below), and I will prepare a full 7-step plan for your approval before changing anything.\n- **Step-by-step coaching:** Ask me about any specific step (RAG, PII masking, firewall, widget, SLA, or website embed) anytime!'
          : '- Ask me about any of the 7 setup studios and I will walk you through it clearly.',
      ].join('\n'),
      quickReplies: defaultActionChips,
    };
  }

  const greetKind = isGreetingOrThanksTurn(latestUserMessage);
  if (greetKind === 'greeting') {
    return {
      reply:
        locale === 'vi'
          ? [
              `Chào bạn! 👋 ${tenantInfoVi}`.trim(),
              '',
              canEditAny
                ? 'Bạn muốn mình **giải thích cách làm từng bước**, hay muốn mình **tự thiết kế & cấu hình trọn gói** cho doanh nghiệp của bạn (có bước duyệt trước khi chạy)?'
                : 'Bạn muốn mình giải thích bước nào trong quy trình 7 bước AI Support hôm nay?',
            ].join('\n')
          : [
              `Hello! 👋 ${tenantInfoEn}`.trim(),
              '',
              canEditAny
                ? 'Would you like me to **walk you through the setup steps**, or **build and deploy the setup for you** (with your approval first)?'
                : 'Which of the 7 AI Support setup steps would you like me to explain?',
            ].join('\n'),
      quickReplies: defaultActionChips,
    };
  }

  if (greetKind === 'thanks') {
    return {
      reply:
        locale === 'vi'
          ? 'Rất vui được hỗ trợ bạn! Nếu bạn cần tinh chỉnh thêm màu sắc, lời chào Widget, bổ sung câu hỏi FAQ hay kiểm tra mã nhúng website thì cứ nhắn mình nhé.'
          : 'Happy to help! Let me know anytime if you want to tweak widget colors, add FAQs, or check your website embed snippet.',
      quickReplies: defaultActionChips.slice(0, 2),
    };
  }

  const focusedStep = matchSpecificStepQuestion(latestUserMessage);
  if (focusedStep) {
    const stepGuide = STEP_FOCUSED_GUIDES[focusedStep];
    const diagStep = diagnostic?.steps.find((s) => s.stepId === focusedStep);
    const liveLineVi =
      diagStep && diagStep.canView !== false
        ? `\n\n**Trạng thái hiện tại trên ${diagnostic!.tenant.name}:** ${diagStep.summaryVi}`
        : '';
    const liveLineEn =
      diagStep && diagStep.canView !== false
        ? `\n\n**Current status on ${diagnostic!.tenant.name}:** ${diagStep.summaryEn}`
        : '';
    return {
      reply:
        locale === 'vi'
          ? `${stepGuide.vi}${liveLineVi}`
          : `${stepGuide.en}${liveLineEn}`,
      quickReplies: defaultActionChips,
    };
  }

  return null;
}

function buildGatherRequirementsReply(
  locale: 'vi' | 'en',
  reqs: SupportSetupRequirements,
  activeTenant: SupportTenant | null,
  priorUserTurnCount = 1,
): { reply: string; missingQuestions: string[]; quickReplies: string[] } {
  const missingVi: string[] = [];
  const missingEn: string[] = [];

  if (!reqs.brandName && !activeTenant) {
    missingVi.push('**Tên thương hiệu / dịch vụ** và **lĩnh vực hoạt động** (VD: Shop mỹ phẩm GlowSkin, nền tảng SaaS TechFlow…)');
    missingEn.push('**Brand / service name** and **industry** (e.g., GlowSkin Skincare Shop, TechFlow SaaS…)');
  } else if (!reqs.industry) {
    missingVi.push('**Lĩnh vực kinh doanh / sản phẩm chính** của bạn');
    missingEn.push('Your **core industry / product line**');
  }

  if (!reqs.faqSummaryOrPolicies) {
    missingVi.push('**Chính sách & FAQ cốt lõi** (VD: đổi trả mấy ngày, phí ship, giờ làm việc, bảng giá hoặc bảo hành)');
    missingEn.push('**Core policies / FAQs** (e.g., return window, shipping rules, support hours, pricing)');
  }

  if (!reqs.websiteOrigin || !reqs.primaryColor || !reqs.tone) {
    missingVi.push('**Domain website** (nếu đã có), **màu chủ đạo** (VD: xanh dương, hồng #ec4899) và **giọng điệu** (thân thiện / chuyên nghiệp / kỹ thuật)');
    missingEn.push('**Website origin** (if available), **brand color** (e.g. #2563eb), and **tone** (friendly / professional / technical)');
  }

  if (!reqs.competitorKeywords?.length && !reqs.blockedTopics?.length && priorUserTurnCount <= 1) {
    missingVi.push('**Quy tắc an toàn tùy chọn**: Tên đối thủ hoặc chủ đề nhạy cảm không được nhắc tới, và có cần thu thập Email/Tên khách trước khi chat không?');
    missingEn.push('**Optional safety rules**: Any competitor names or restricted topics to block, and whether customers should fill a contact intake form before chatting?');
  }

  const capturedVi: string[] = [];
  const capturedEn: string[] = [];
  if (reqs.brandName) {
    capturedVi.push(`thương hiệu **${reqs.brandName}**`);
    capturedEn.push(`brand **${reqs.brandName}**`);
  } else if (activeTenant) {
    capturedVi.push(`tenant **${activeTenant.name}**`);
    capturedEn.push(`tenant **${activeTenant.name}**`);
  }
  if (reqs.industry) {
    capturedVi.push(`ngành **${reqs.industry}**`);
    capturedEn.push(`industry **${reqs.industry}**`);
  }
  if (reqs.primaryColor) {
    capturedVi.push(`màu **${reqs.primaryColor}**`);
    capturedEn.push(`color **${reqs.primaryColor}**`);
  }
  if (reqs.tone) {
    capturedVi.push(`giọng **${reqs.tone}**`);
    capturedEn.push(`tone **${reqs.tone}**`);
  }

  if (locale === 'vi') {
    const reply =
      priorUserTurnCount <= 1
        ? [
            'Mình sẵn sàng **thiết lập trọn bộ 7 bước AI Support** thay cho bạn! Để lên bản cấu hình sát thực tế nhất (và trình bạn duyệt trước khi chạy), bạn chia sẻ giúp mình vài thông tin ngắn nhé:',
            '',
            ...missingVi.map((q, i) => `${i + 1}. ${q}`),
            '',
            'Bạn cứ mô tả tự nhiên trong 1 tin nhắn, hoặc nhắn **"dùng mặc định"** nếu muốn mình tự chọn thông số chuẩn ngay!',
          ].join('\n')
        : [
            capturedVi.length > 0
              ? `Mình đang chuẩn bị cấu hình cho ${capturedVi.join(', ')}. Để bản kế hoạch hoàn chỉnh hơn, bạn bổ sung giúp mình thêm:`
              : 'Để mình tạo bản kế hoạch sát với nhu cầu của bạn nhất, bạn cho mình biết thêm ngắn gọn nhé:',
            '',
            ...missingVi.slice(0, 3).map((q, i) => `${i + 1}. ${q}`),
            '',
            '💡 *Chưa có sẵn thông tin trên? Bạn chỉ cần bấm **"Dùng cấu hình mặc định & lên kế hoạch ngay"** bên dưới để mình tạo bản nháp luôn!*',
          ].join('\n');

    const quickReplies = activeTenant
      ? [
          'Dùng cấu hình mặc định & lên kế hoạch ngay',
          'Shop mỹ phẩm GlowSkin, website https://glowskin.vn, đổi trả 7 ngày, freeship đơn 300k, màu hồng #ec4899, giọng thân thiện',
          'Phần mềm SaaS TechFlow, website https://techflow.io, hỗ trợ kỹ thuật 24/7, giọng chuyên nghiệp, thu thập email khách',
        ]
      : [
          'Dùng cấu hình mặc định & lên kế hoạch ngay',
          'Shop mỹ phẩm GlowSkin, website https://glowskin.vn, đổi trả 7 ngày, freeship đơn 300k, màu hồng #ec4899, giọng thân thiện',
          'Phần mềm SaaS TechFlow, website https://techflow.io, hỗ trợ kỹ thuật 24/7, giọng chuyên nghiệp, thu thập email khách',
        ];

    return { reply, missingQuestions: missingVi, quickReplies };
  }

  const reply =
    priorUserTurnCount <= 1
      ? [
          'I can **configure all 7 AI Support steps** for you and present a plan for your approval before making any changes. Please share a few quick details:',
          '',
          ...missingEn.map((q, i) => `${i + 1}. ${q}`),
          '',
          'Reply naturally in one message, or say **"use defaults"** if you want me to pick smart defaults right away!',
        ].join('\n')
      : [
          capturedEn.length > 0
            ? `Got it — preparing setup for ${capturedEn.join(', ')}. Could you share one or two quick details, or let me fill in defaults?`
            : 'Just share a couple of quick details below — or click **"Use smart defaults & generate plan now"** to proceed immediately:',
          '',
          ...missingEn.slice(0, 3).map((q, i) => `${i + 1}. ${q}`),
        ].join('\n');

  const quickReplies = activeTenant
    ? [
        'Auto-complete current tenant with standard defaults',
        'GlowSkin Skincare shop, website https://glowskin.vn, 7-day returns, #ec4899 pink, friendly English tone',
        'TechFlow SaaS platform, website https://techflow.io, 24/7 onboarding & API help, professional tone, collect customer email',
      ]
    : [
        'Use smart defaults & generate plan now',
        'GlowSkin Skincare shop, website https://glowskin.vn, 7-day returns, #ec4899 pink, friendly English tone',
        'TechFlow SaaS platform, website https://techflow.io, 24/7 onboarding & API help, professional tone, collect customer email',
      ];

  return { reply, missingQuestions: missingEn, quickReplies };
}

interface LlmCoachOutput {
  intent?: SupportSetupChatIntent;
  reply?: string;
  missingQuestions?: string[];
  suggestedQuickReplies?: string[];
  extractedRequirements?: Partial<SupportSetupRequirements>;
}

export interface GatewayLoopbackContext {
  host: string;
  port: number;
  sessionToken?: string;
}

function extractCompletionText(rawContent: unknown): string {
  if (typeof rawContent === 'string') return rawContent.trim();
  if (Array.isArray(rawContent)) {
    return rawContent
      .map((b) =>
        typeof b === 'object' && b !== null && 'text' in b && typeof (b as { text?: unknown }).text === 'string'
          ? (b as { text: string }).text
          : '',
      )
      .join('')
      .trim();
  }
  return '';
}

export function parseLlmCoachResponse(rawText: string): LlmCoachOutput | null {
  const trimmed = rawText.trim();
  if (!trimmed) return null;

  const unwrapped = trimmed.replace(/^```(?:json)?\s*|\s*```$/gi, '').trim();
  const candidates = [unwrapped];
  const firstBrace = unwrapped.indexOf('{');
  const lastBrace = unwrapped.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const slice = unwrapped.slice(firstBrace, lastBrace + 1);
    if (slice !== unwrapped) candidates.push(slice);
  }

  for (const jsonCandidate of candidates) {
    try {
      const parsed = JSON.parse(jsonCandidate) as LlmCoachOutput;
      if (parsed && typeof parsed === 'object' && typeof parsed.reply === 'string' && parsed.reply.trim()) {
        return parsed;
      }
    } catch {
      // Try next extraction strategy
    }
  }

  // If a model answered in natural prose instead of strict JSON, preserve its natural reply
  // as long as it doesn't look like truncated broken JSON.
  if (!unwrapped.startsWith('{')) {
    return { reply: unwrapped };
  }
  return null;
}

function hasEnabledMainGatewayKeys(): boolean {
  try {
    const row = getDb()
      .prepare('SELECT COUNT(*) AS c FROM keys WHERE enabled = 1')
      .get() as { c: number } | undefined;
    return Number(row?.c ?? 0) > 0;
  } catch {
    return false;
  }
}

async function tryLlmCoachTurn(params: {
  messages: SupportSetupChatMessage[];
  locale: 'vi' | 'en';
  targetMode: 'create_tenant' | 'update_tenant';
  diagnostic: SupportSetupTenantDiagnostic | null;
  extracted: SupportSetupRequirements;
  gatewayLoopback?: GatewayLoopbackContext;
}): Promise<{ output: LlmCoachOutput; modelUsed: string } | null> {
  const languageDirective =
    params.locale === 'vi'
      ? 'CRITICAL LANGUAGE RULE: You MUST write "reply", "missingQuestions", and "suggestedQuickReplies" 100% in natural, friendly Vietnamese (Tiếng Việt) — even if earlier messages in history were in English!'
      : 'CRITICAL LANGUAGE RULE: You MUST write "reply", "missingQuestions", and "suggestedQuickReplies" in natural, friendly English.';

  const systemContent = [
    'You are the FreeLLMAPI AI Support Setup Copilot — a warm, intelligent, conversational assistant.',
    'You NEVER mutate tenant configuration directly; you either converse/answer questions naturally (intent="guide"), ask 1–3 concise, context-aware follow-up questions when needed (intent="gather_requirements"), or prepare a setup plan for customer consent (intent="propose_setup").',
    'NEVER repeat a generic boilerplate message verbatim. Directly address what the user just asked or said first!',
    languageDirective,
    `Target mode: ${params.targetMode}.`,
    params.diagnostic
      ? `Active tenant "${params.diagnostic.tenant.name}" (${params.diagnostic.completedSteps}/7 complete): ${JSON.stringify(
          params.diagnostic.steps
            .filter((s) => s.canView !== false)
            .map((s) => ({ stepId: s.stepId, status: s.status })),
        )}`
      : 'Active tenant: none selected (new tenant creation).',
    `Already extracted requirements: ${JSON.stringify(params.extracted)}`,
    '',
    SUPPORT_SETUP_TRAINING_GUIDE,
    '',
    'Respond with valid JSON matching:',
    '{"intent":"guide"|"gather_requirements"|"propose_setup","reply":"...","missingQuestions":["..."],"suggestedQuickReplies":["..."],"extractedRequirements":{"brandName":"...","industry":"...","websiteOrigin":"...","language":"vi"|"en"|"bilingual","tone":"friendly"|"professional"|"empathetic"|"technical","primaryColor":"#2563eb","faqSummaryOrPolicies":"...","blockedTopics":[],"competitorKeywords":[],"requireContactIntake":false}}',
  ].join('\n');

  const turnMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: systemContent },
    ...params.messages.slice(-12),
  ];

  const matchesRequestedLocale = (replyText: string): boolean => {
    if (params.locale === 'vi') {
      // Guard against small models echoing an earlier English turn when user switched to Vietnamese
      return VI_DIACRITIC_RE.test(replyText) || VI_UNACCENTED_PHRASE_RE.test(replyText);
    }
    return true;
  };

  // 1. Try Thruline X-Gateway OAuth/provider accounts if active
  try {
    if (getConfigSnapshot().enabled) {
      const { candidates } = resolveCandidateRoutes('auto', 'chat');
      if (candidates && candidates.length > 0) {
        const signal = AbortSignal.timeout(12_000);
        for (const candidate of candidates.slice(0, 2)) {
          const { account, modelId } = candidate;
          const provider = resolveAccountProvider(account);
          if (!provider) continue;
          try {
            const credential = decrypt(account.encrypted_key, account.iv, account.auth_tag);
            const proxy = resolveXGatewayAccountProxy(account);
            const res = await withQuotaTracking(account, modelId, proxy, () =>
              provider.chatCompletion(
                credential,
                turnMessages,
                modelId,
                { temperature: 0.35, max_tokens: 900, signal },
                { platform: account.platform, keyId: account.id, modelId },
              ),
            );
            const text = extractCompletionText(res.choices?.[0]?.message?.content);
            const parsed = parseLlmCoachResponse(text);
            if (parsed?.reply && matchesRequestedLocale(parsed.reply)) {
              return { output: parsed, modelUsed: modelId };
            }
          } catch {
            // Try next candidate or main FreeLLMAPI gateway
          }
        }
      }
    }
  } catch {
    // Fall through to main FreeLLMAPI gateway
  }

  // 2. Fallback to main FreeLLMAPI /v1/chat/completions router when provider keys are configured
  if (params.gatewayLoopback?.port && hasEnabledMainGatewayKeys()) {
    try {
      const { host, port, sessionToken } = params.gatewayLoopback;
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        authorization: `Bearer ${getUnifiedApiKey()}`,
        'user-agent': 'freellm-support-setup-copilot',
        host: `127.0.0.1:${port}`,
      };
      if (sessionToken) {
        headers[PLAYGROUND_SESSION_HEADER] = sessionToken;
      }
      const upstream = await fetch(`http://${host}:${port}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: 'auto',
          temperature: 0.35,
          max_tokens: 900,
          messages: turnMessages,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (upstream.ok) {
        const body = (await upstream.json()) as {
          model?: string;
          choices?: Array<{ message?: { content?: unknown } }>;
        };
        const text = extractCompletionText(body.choices?.[0]?.message?.content);
        const parsed = parseLlmCoachResponse(text);
        if (parsed?.reply && matchesRequestedLocale(parsed.reply)) {
          return { output: parsed, modelUsed: body.model || 'auto' };
        }
      }
    } catch {
      // Fall back cleanly to conversational coach
    }
  }

  return null;
}

export async function runSupportSetupCopilotTurn(params: {
  user: SessionUser;
  scope: CopilotUserScope;
  messages: SupportSetupChatMessage[];
  tenantId?: number | null;
  targetMode?: 'create_tenant' | 'update_tenant';
  locale?: 'vi' | 'en';
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
      priorTargetMode = prior.targetMode;
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

  // Strict RBAC boundary: if a non-operator explicitly asks to create a brand-new tenant,
  // refuse cleanly without creating a tenant OR silently mutating another tenant.
  if (!scope.canCreateTenant && (params.targetMode === 'create_tenant' || latestCreatePhrase)) {
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
          ? `Tài khoản của bạn không có quyền tạo Support Tenant mới (AI chỉ thực thi đúng trong phạm vi quyền của người dùng hiện tại).${assignedHintVi}`
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
  // but must NEVER be prompted for auto-deploy requirements or receive a pending_consent proposal.
  if (canEditSet.size === 0) {
    const specialReadOnly = tryBuildConversationalSpecialReply({
      latestUserMessage,
      locale,
      diagnostic,
      canCreateTenant: false,
      canEditAny: false,
    });
    if (specialReadOnly) {
      return {
        ok: true,
        replyLocale: locale,
        reply: specialReadOnly.reply,
        intent: 'guide',
        missingQuestions: [],
        suggestedQuickReplies: specialReadOnly.quickReplies,
        proposal: null,
        modelUsed: null,
        usedFallback: true,
      };
    }
    if (isGuideQuestion(latestUserMessage)) {
      const guide = formatGuideReply(locale, diagnostic, false, false);
      return {
        ok: true,
        replyLocale: locale,
        reply: guide.reply,
        intent: 'guide',
        missingQuestions: [],
        suggestedQuickReplies: guide.quickReplies,
        proposal: null,
        modelUsed: null,
        usedFallback: true,
      };
    }
    return {
      ok: true,
      replyLocale: locale,
      reply:
        locale === 'vi'
          ? 'Tài khoản hiện tại của bạn đang ở chế độ **Chỉ xem (Read-Only)** trên tenant này (chưa có quyền chỉnh sửa cấu hình). AI tuân thủ nghiêm ngặt quyền người dùng nên sẽ không tạo bản đề xuất tự động triển khai — tuy nhiên tôi vẫn có thể giải thích chi tiết cách hoạt động của từng bước nếu bạn cần!'
          : 'Your current account has **Read-Only** access on this tenant (no edit permissions granted). Because the Copilot strictly enforces your user permissions, it cannot generate or deploy configuration changes — however, I can still explain any of the 7 setup steps in detail!',
      intent: 'guide',
      missingQuestions: [],
      suggestedQuickReplies: [
        locale === 'vi'
          ? 'Hướng dẫn tôi chi tiết từng bước để có 1 con AI Support hoàn chỉnh'
          : 'How do I set up a complete AI Support assistant step by step?',
      ],
      proposal: null,
      modelUsed: null,
      usedFallback: true,
    };
  }

  const extracted = extractRequirementsFromMessages(
    messages,
    baseRequirements,
    requirementsHint,
    locale,
  );

  // Attempt live LLM coach (Thruline accounts first, then main FreeLLMAPI /v1/chat/completions router)
  const llm = await tryLlmCoachTurn({
    messages,
    locale,
    targetMode,
    diagnostic,
    extracted,
    gatewayLoopback,
  });

  const mergedRequirements = llm?.output.extractedRequirements
    ? extractRequirementsFromMessages([], extracted, llm.output.extractedRequirements, locale)
    : extracted;

  const explicitBriefSubmitted = Boolean(
    requirementsHint &&
      (requirementsHint.brandName?.trim() ||
        requirementsHint.industry?.trim() ||
        requirementsHint.faqSummaryOrPolicies?.trim()),
  );

  const specialConversational = !explicitBriefSubmitted && !baseProposalId
    ? tryBuildConversationalSpecialReply({
        latestUserMessage,
        locale,
        diagnostic,
        canCreateTenant: scope.canCreateTenant,
        canEditAny: canEditSet.size > 0,
      })
    : null;

  let intent: SupportSetupChatIntent;
  if (explicitBriefSubmitted) {
    intent = 'propose_setup';
  } else if (specialConversational || (isGuideQuestion(latestUserMessage) && !baseProposalId)) {
    intent = 'guide';
  } else if (
    hasSufficientContextForProposal(
      mergedRequirements,
      targetMode,
      effectiveTenant,
      latestUserMessage,
      Boolean(baseProposalId),
    ) ||
    (llm?.output.intent === 'propose_setup' &&
      (effectiveTenant !== null || Boolean(mergedRequirements.brandName)))
  ) {
    intent = 'propose_setup';
  } else if (llm?.output.intent === 'guide') {
    intent = 'guide';
  } else {
    intent = 'gather_requirements';
  }

  if (intent === 'guide') {
    const fallbackGuide =
      specialConversational ??
      formatGuideReply(locale, diagnostic, scope.canCreateTenant, canEditSet.size > 0);
    return {
      ok: true,
      replyLocale: locale,
      reply: llm?.output.reply ? llm.output.reply : fallbackGuide.reply,
      intent: 'guide',
      missingQuestions: [],
      suggestedQuickReplies:
        llm?.output.suggestedQuickReplies?.length
          ? llm.output.suggestedQuickReplies.slice(0, 4)
          : fallbackGuide.quickReplies,
      proposal: null,
      modelUsed: llm?.modelUsed ?? null,
      usedFallback: !llm,
    };
  }

  if (intent === 'gather_requirements') {
    const priorUserTurnCount = messages.filter((m) => m.role === 'user').length;
    const gather = buildGatherRequirementsReply(
      locale,
      mergedRequirements,
      effectiveTenant,
      priorUserTurnCount,
    );
    return {
      ok: true,
      replyLocale: locale,
      reply: llm?.output.reply ? llm.output.reply : gather.reply,
      intent: 'gather_requirements',
      missingQuestions:
        llm?.output.missingQuestions?.length
          ? llm.output.missingQuestions.slice(0, 5)
          : gather.missingQuestions,
      suggestedQuickReplies:
        llm?.output.suggestedQuickReplies?.length
          ? llm.output.suggestedQuickReplies.slice(0, 4)
          : gather.quickReplies,
      proposal: null,
      modelUsed: llm?.modelUsed ?? null,
      usedFallback: !llm,
    };
  }

  // intent === 'propose_setup' -> build & persist pending_consent proposal (NO side effects on tenant!)
  const draft = buildSanitizedSetupProposal({
    userId: user.userId,
    targetMode: effectiveTenant ? 'update_tenant' : 'create_tenant',
    existingTenant: effectiveTenant,
    requirements: mergedRequirements,
    canEditSteps: canEditSet,
    canViewSteps: effectiveTargetEntry?.canViewSteps,
    canCreateTenant: scope.canCreateTenant,
    isPlatformOperator: scope.isPlatformOperator,
    locale,
  });

  const savedProposal = createSetupProposal(draft);
  const permittedCount = savedProposal.steps.filter((s) => s.canApply).length;

  const fallbackProposeReply =
    locale === 'vi'
      ? [
          `Mình đã chuẩn bị xong **kế hoạch thiết lập trọn gói (${permittedCount}/7 bước)** cho **${savedProposal.tenantName}** (\`${savedProposal.tenantSlug}\`).`,
          '',
          '- Mình **chưa tự ý thay đổi cấu hình** trên hệ thống.',
          '- Vui lòng xem chi tiết từng bước trong thẻ **Chờ xác nhận triển khai** bên dưới, bỏ chọn bước nào bạn chưa muốn chạy (nếu cần), rồi bấm **Đồng ý & Tự động triển khai** — hoặc nhắn lại cho mình nếu muốn chỉnh sửa màu sắc, giọng điệu hay chính sách!',
        ].join('\n')
      : [
          `I prepared a **complete setup plan (${permittedCount}/7 steps)** for **${savedProposal.tenantName}** (\`${savedProposal.tenantSlug}\`).`,
          '',
          '- **No configuration has been changed yet.**',
          '- Please review each step in the **Consent Required** card below, uncheck anything you want to skip, and click **Approve & Auto-Deploy** — or tell me what you would like adjusted!',
        ].join('\n');

  return {
    ok: true,
    replyLocale: locale,
    reply:
      llm?.output.intent === 'propose_setup' && llm.output.reply
        ? llm.output.reply
        : fallbackProposeReply,
    intent: 'propose_setup',
    missingQuestions: [],
    suggestedQuickReplies:
      locale === 'vi'
        ? ['Đổi màu sang xanh dương #2563eb', 'Yêu cầu khách nhập email trước khi chat']
        : ['Switch primary color to #2563eb', 'Require customer email intake before chat'],
    proposal: savedProposal,
    modelUsed: llm?.modelUsed ?? null,
    usedFallback: !llm,
  };
}
