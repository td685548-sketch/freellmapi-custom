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
import { decrypt } from '../../lib/crypto.js';
import type { SessionUser } from '../../services/auth.js';
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
    const trimmed = text.trim();
    if (hasPolicyKeywords || (!merged.faqSummaryOrPolicies && trimmed.length >= 60)) {
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

function isGuideQuestion(text: string): boolean {
  const lower = text.toLowerCase();
  const asksHow =
    /hướng dẫn|các bước|làm sao|như thế nào|cách dùng|cách setup|tại sao|là gì|roadmap|how to|how do i|steps to|guide|explain|what does|troubleshooting|kiểm tra tình trạng/i.test(
      lower,
    );
  const asksAutoDoIt =
    /setup giúp|setup thay|làm giúp|làm thay|cài đặt tự động|tự động setup|thiết lập giúp|thiết lập thay|tạo giúp|tạo giùm|hoàn thiện giúp|auto[- ]?setup|set up for me|configure for me|do it for me/i.test(
      lower,
    );
  return asksHow && !asksAutoDoIt;
}

function asksAutoCompleteWithDefaults(text: string): boolean {
  return /tiêu chuẩn|mặc định|auto[- ]?complete|standard defaults|tự đề xuất toàn bộ/i.test(text);
}

function hasSufficientContextForProposal(
  req: SupportSetupRequirements,
  targetMode: 'create_tenant' | 'update_tenant',
  activeTenant: SupportTenant | null,
  latestUserMessage: string,
  hasBaseProposal: boolean,
): boolean {
  if (hasBaseProposal) return true;
  if (asksAutoCompleteWithDefaults(latestUserMessage) && (activeTenant !== null || Boolean(req.brandName))) {
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

function buildGatherRequirementsReply(
  locale: 'vi' | 'en',
  reqs: SupportSetupRequirements,
  activeTenant: SupportTenant | null,
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
    missingVi.push('**Domain website** (để mở CORS & bảo mật), **màu chủ đạo** (VD: xanh dương, hồng #ec4899) và **giọng điệu** (thân thiện / chuyên nghiệp / kỹ thuật)');
    missingEn.push('**Website origin** (for CORS), **brand color** (e.g. #2563eb), and **tone** (friendly / professional / technical)');
  }

  if (!reqs.competitorKeywords?.length && !reqs.blockedTopics?.length) {
    missingVi.push('**Quy tắc an toàn tùy chọn**: Có tên đối thủ hoặc chủ đề nhạy cảm nào AI không được phép nhắc tới không? Có cần form thu thập Email/Tên khách trước khi chat không?');
    missingEn.push('**Optional safety rules**: Any competitor names or restricted topics to block, and whether customers should fill a contact intake form before chatting?');
  }

  if (locale === 'vi') {
    const reply = [
      'Tôi sẵn sàng **thiết lập trọn bộ 7 bước AI Support** thay cho bạn! Để cấu hình chuẩn xác cho doanh nghiệp của bạn (và trình bạn duyệt trước khi triển khai), hãy cho tôi biết vài thông tin hợp lý sau:',
      '',
      ...missingVi.map((q, i) => `${i + 1}. ${q}`),
      '',
      'Bạn có thể trả lời tự nhiên trong 1 tin nhắn (hoặc mở mục **Phiếu thông tin nhanh** ngay phía trên ô nhập).',
    ].join('\n');

    const quickReplies = activeTenant
      ? [
          'Hoàn thiện cấu hình tiêu chuẩn cho tenant hiện tại',
          `Shop mỹ phẩm GlowSkin, website https://glowskin.vn, đổi trả 7 ngày, freeship đơn 300k, màu hồng #ec4899, giọng thân thiện`,
          `Phần mềm SaaS TechFlow, website https://techflow.io, hỗ trợ kỹ thuật 24/7, giọng chuyên nghiệp, thu thập email khách`,
        ]
      : [
          `Shop mỹ phẩm GlowSkin, website https://glowskin.vn, đổi trả 7 ngày, freeship đơn 300k, màu hồng #ec4899, giọng thân thiện`,
          `Phần mềm SaaS TechFlow, website https://techflow.io, hỗ trợ kỹ thuật 24/7, giọng chuyên nghiệp, thu thập email khách`,
        ];

    return { reply, missingQuestions: missingVi, quickReplies };
  }

  const reply = [
    'I can **configure all 7 AI Support steps** for you and present a plan for your approval before making any changes. Please share a few quick details:',
    '',
    ...missingEn.map((q, i) => `${i + 1}. ${q}`),
    '',
    'Reply naturally in one message, or pick a starter template below.',
  ].join('\n');

  const quickReplies = activeTenant
    ? [
        'Auto-complete current tenant with standard defaults',
        'GlowSkin Skincare shop, website https://glowskin.vn, 7-day returns, #ec4899 pink, friendly English tone',
        'TechFlow SaaS platform, website https://techflow.io, 24/7 onboarding & API help, professional tone, collect customer email',
      ]
    : [
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

async function tryLlmCoachTurn(params: {
  messages: SupportSetupChatMessage[];
  locale: 'vi' | 'en';
  targetMode: 'create_tenant' | 'update_tenant';
  diagnostic: SupportSetupTenantDiagnostic | null;
  extracted: SupportSetupRequirements;
}): Promise<{ output: LlmCoachOutput; modelUsed: string } | null> {
  try {
    if (!getConfigSnapshot().enabled) return null;
    const { candidates } = resolveCandidateRoutes('auto', 'chat');
    if (!candidates || candidates.length === 0) return null;

    const systemContent = [
      'You are the FreeLLMAPI AI Support Setup Copilot.',
      'You NEVER mutate tenant configuration directly; you either guide the user, ask reasonable requirements questions (intent="gather_requirements"), or prepare a setup plan for consent (intent="propose_setup").',
      `Language preference: ${params.locale === 'vi' ? 'Vietnamese' : 'English'}.`,
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
      'Respond ONLY with valid JSON matching:',
      '{"intent":"guide"|"gather_requirements"|"propose_setup","reply":"...","missingQuestions":["..."],"suggestedQuickReplies":["..."],"extractedRequirements":{"brandName":"...","industry":"...","websiteOrigin":"...","language":"vi"|"en"|"bilingual","tone":"friendly"|"professional"|"empathetic"|"technical","primaryColor":"#2563eb","faqSummaryOrPolicies":"...","blockedTopics":[],"competitorKeywords":[],"requireContactIntake":false}}',
    ].join('\n');

    const turnMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: systemContent },
      ...params.messages.slice(-12),
    ];

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
            { temperature: 0.2, max_tokens: 900, signal },
            { platform: account.platform, keyId: account.id, modelId },
          ),
        );
        const rawContent = res.choices?.[0]?.message?.content;
        const text =
          typeof rawContent === 'string'
            ? rawContent.trim()
            : Array.isArray(rawContent)
              ? rawContent
                  .map((b) =>
                    typeof b === 'object' && b !== null && 'text' in b && typeof b.text === 'string'
                      ? b.text
                      : '',
                  )
                  .join('')
                  .trim()
              : '';
        if (!text) continue;
        const unwrapped = text.replace(/^```(?:json)?\s*|\s*```$/gi, '').trim();
        const parsed = JSON.parse(unwrapped) as LlmCoachOutput;
        if (parsed && typeof parsed === 'object' && typeof parsed.reply === 'string' && parsed.reply.trim()) {
          return { output: parsed, modelUsed: modelId };
        }
      } catch {
        // Fall through to next candidate or deterministic coach
      }
    }
  } catch {
    // No candidate routes or unavailable
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
}): Promise<SupportSetupChatResponse> {
  const {
    user,
    scope,
    messages,
    tenantId,
    locale = 'vi',
    requirementsHint,
    baseProposalId,
    diagnostic,
  } = params;

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
    if (isGuideQuestion(latestUserMessage)) {
      const guide = formatGuideReply(locale, diagnostic, false, false);
      return {
        ok: true,
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

  // Attempt live LLM coach when routes exist, then enforce deterministic state machine invariants
  const llm = await tryLlmCoachTurn({
    messages,
    locale,
    targetMode,
    diagnostic,
    extracted,
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

  let intent: SupportSetupChatIntent;
  if (explicitBriefSubmitted) {
    intent = 'propose_setup';
  } else if (isGuideQuestion(latestUserMessage) && !baseProposalId) {
    intent = 'guide';
  } else if (
    hasSufficientContextForProposal(
      mergedRequirements,
      targetMode,
      effectiveTenant,
      latestUserMessage,
      Boolean(baseProposalId),
    )
  ) {
    intent = 'propose_setup';
  } else {
    intent = 'gather_requirements';
  }

  if (intent === 'guide') {
    const guide = formatGuideReply(locale, diagnostic, scope.canCreateTenant, canEditSet.size > 0);
    return {
      ok: true,
      reply: llm?.output.intent === 'guide' && llm.output.reply ? llm.output.reply : guide.reply,
      intent: 'guide',
      missingQuestions: [],
      suggestedQuickReplies:
        llm?.output.intent === 'guide' && llm.output.suggestedQuickReplies?.length
          ? llm.output.suggestedQuickReplies.slice(0, 4)
          : guide.quickReplies,
      proposal: null,
      modelUsed: llm?.modelUsed ?? null,
      usedFallback: !llm,
    };
  }

  if (intent === 'gather_requirements') {
    const gather = buildGatherRequirementsReply(locale, mergedRequirements, effectiveTenant);
    return {
      ok: true,
      reply:
        llm?.output.intent === 'gather_requirements' && llm.output.reply
          ? llm.output.reply
          : gather.reply,
      intent: 'gather_requirements',
      missingQuestions:
        llm?.output.intent === 'gather_requirements' && llm.output.missingQuestions?.length
          ? llm.output.missingQuestions.slice(0, 5)
          : gather.missingQuestions,
      suggestedQuickReplies:
        llm?.output.intent === 'gather_requirements' && llm.output.suggestedQuickReplies?.length
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
          `Tôi đã chuẩn bị xong **kế hoạch thiết lập trọn gói (${permittedCount}/7 bước)** cho **${savedProposal.tenantName}** (\`${savedProposal.tenantSlug}\`).`,
          '',
          '- Tôi **chưa tự ý thay đổi cấu hình** trên hệ thống.',
          '- Vui lòng xem chi tiết từng bước trong thẻ **Chờ xác nhận triển khai** bên dưới, bỏ chọn bước nào bạn chưa muốn chạy (nếu cần), rồi bấm **Đồng ý & Tự động triển khai** — hoặc nhắn lại cho tôi nếu muốn chỉnh sửa màu sắc, giọng điệu hay chính sách!',
        ].join('\n')
      : [
          `I prepared a **complete setup plan (${permittedCount}/7 steps)** for **${savedProposal.tenantName}** (\`${savedProposal.tenantSlug}\`).`,
          '',
          '- **No configuration has been changed yet.**',
          '- Please review each step in the **Consent Required** card below, uncheck anything you want to skip, and click **Approve & Auto-Deploy** — or tell me what you would like adjusted!',
        ].join('\n');

  return {
    ok: true,
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
