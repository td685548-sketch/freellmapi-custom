import {
  SUPPORT_SETUP_STEP_IDS,
  type SupportSetupGuardrailsPayload,
  type SupportSetupKnowledgeDocSeed,
  type SupportSetupKnowledgeMaskingPayload,
  type SupportSetupOutputControlsPayload,
  type SupportSetupPlannedStep,
  type SupportSetupRuntimePayload,
  type SupportSetupSlaRoutingPayload,
  type SupportSetupStepId,
  type SupportSetupTenantAiPayload,
  type SupportSetupTone,
  type SupportSetupWidgetPayload,
  type SupportSetupChatMessage,
} from '@freellmapi/shared/support-setup-copilot.js';
import {
  SUPPORT_OUTPUT_LIMITS,
  type SupportOutputMode,
  type SupportOutputRule,
} from '@freellmapi/shared/support-output.js';
import { RUNTIME_POLICY_BOUNDS } from '@freellmapi/shared/support-runtime.js';
import {
  SUPPORT_DESK_LIMITS,
  type SupportDeskIntakeField,
  type SupportDeskWidgetPosition,
} from '@freellmapi/shared/support-service-desk.js';
import { getSupportGuardrailPolicy } from '../x-gateway/support-guardrails.js';
import {
  getSupportMaskingPolicy,
  listSupportKnowledgeDocs,
} from '../x-gateway/support-knowledge.js';
import { getSupportOutputPolicy } from '../x-gateway/support-output-store.js';
import { getSupportRuntimePolicy } from '../x-gateway/support-runtime-store.js';
import {
  getSupportDeskSlaPolicy,
  getSupportDeskWidgetConfig,
} from '../x-gateway/support-service-desk-store.js';
import type { SupportTenant } from '../x-gateway/support-store.js';

export type SurgicalTenantEditPermission =
  | 'edit_tenant_ai'
  | 'edit_tenant_knowledge'
  | 'edit_tenant_guardrails'
  | 'edit_tenant_widget'
  | 'edit_tenant_integration';

export const SURGICAL_STEP_REQUIRED_PERMISSION: Readonly<
  Record<SupportSetupStepId, SurgicalTenantEditPermission>
> = {
  tenant_ai: 'edit_tenant_ai',
  knowledge_masking: 'edit_tenant_knowledge',
  guardrails_quotas: 'edit_tenant_guardrails',
  output_controls: 'edit_tenant_guardrails',
  widget_appearance: 'edit_tenant_widget',
  sla_routing: 'edit_tenant_widget',
  runtime_policy: 'edit_tenant_integration',
};

const STEP_LABELS: Readonly<
  Record<SupportSetupStepId, { vi: string; en: string; permLabelVi: string; permLabelEn: string }>
> = {
  tenant_ai: {
    vi: 'Tenant & Nhân cách AI',
    en: 'Tenant & AI Persona',
    permLabelVi: 'Chỉnh sửa cấu hình AI & Model',
    permLabelEn: 'Edit AI configuration',
  },
  knowledge_masking: {
    vi: 'Kho tri thức FAQ & Che dữ liệu nhạy cảm',
    en: 'Knowledge Base & PII Masking',
    permLabelVi: 'Chỉnh sửa Kho tri thức & Che PII',
    permLabelEn: 'Edit knowledge & masking',
  },
  guardrails_quotas: {
    vi: 'Tường lửa Prompt & Hạn mức',
    en: 'Prompt Firewall & Role Quotas',
    permLabelVi: 'Chỉnh sửa Tường lửa & Kiểm soát đầu ra',
    permLabelEn: 'Edit guardrails & output rules',
  },
  output_controls: {
    vi: 'Kiểm soát an toàn đầu ra',
    en: 'Output Safety Controls',
    permLabelVi: 'Chỉnh sửa Tường lửa & Kiểm soát đầu ra',
    permLabelEn: 'Edit guardrails & output rules',
  },
  widget_appearance: {
    vi: 'Giao diện Widget & Thu thập thông tin',
    en: 'Customer Chat Widget & Intake',
    permLabelVi: 'Tùy chỉnh Widget & SLA',
    permLabelEn: 'Customize widget & SLA',
  },
  sla_routing: {
    vi: 'SLA Service Desk & Phân luồng',
    en: 'Service Desk SLA & Routing',
    permLabelVi: 'Tùy chỉnh Widget & SLA',
    permLabelEn: 'Customize widget & SLA',
  },
  runtime_policy: {
    vi: 'Tên miền CORS & Giới hạn Runtime',
    en: 'CORS Allowed Origins & Runtime Limits',
    permLabelVi: 'Chỉnh sửa Tích hợp, CORS & Runtime',
    permLabelEn: 'Edit integration & webhooks',
  },
};

export interface SurgicalWidgetAppearancePatch {
  primaryColor?: string;
  position?: 'left' | 'right';
  widgetEnabled?: boolean;
  requireContactIntake?: boolean;
  widgetTitle?: string;
  widgetGreeting?: string;
}

export interface SurgicalTenantAiPatch {
  defaultModel?: string;
  tone?: SupportSetupTone;
  allowGuest?: boolean;
  tenantName?: string;
  systemPrompt?: string;
  systemPromptAppend?: string;
  tenantEnabled?: boolean;
}

export interface SurgicalKnowledgeMaskingPatch {
  faqDocContent?: string;
  faqDocTitle?: string;
  maskingEnabled?: boolean;
}

export interface SurgicalGuardrailsQuotasPatch {
  addBlockedTopics?: string[];
  addCompetitorKeywords?: string[];
  blockPromptInjection?: boolean;
  guardrailsEnabled?: boolean;
}

export type SurgicalRequestedOutputMode = 'monitor' | 'redact' | 'block';

export interface SurgicalOutputControlsPatch {
  outputMode?: SurgicalRequestedOutputMode;
  redactCredentials?: boolean;
  maxOutputChars?: number;
}

export interface SurgicalSlaRoutingPatch {
  urgentFirstResponseMinutes?: number;
  slaEnabled?: boolean;
}

export interface SurgicalRuntimePolicyPatch {
  addAllowedOrigins?: string[];
  replaceAllowedOrigins?: string[];
  maxCompletionTokens?: number;
}

export interface SurgicalStepPatches {
  tenant_ai?: SurgicalTenantAiPatch;
  knowledge_masking?: SurgicalKnowledgeMaskingPatch;
  guardrails_quotas?: SurgicalGuardrailsQuotasPatch;
  output_controls?: SurgicalOutputControlsPatch;
  widget_appearance?: SurgicalWidgetAppearancePatch;
  sla_routing?: SurgicalSlaRoutingPatch;
  runtime_policy?: SurgicalRuntimePolicyPatch;
}

export interface SurgicalEditAnalysis {
  isSurgical: boolean;
  targetedSteps: SupportSetupStepId[];
  patches: SurgicalStepPatches;
}

export interface AnalyzeSurgicalSupportEditParams {
  messages: SupportSetupChatMessage[];
  locale: 'vi' | 'en';
  hasExistingTenant: boolean;
  explicitBriefSubmitted?: boolean;
  llmTargetSteps?: SupportSetupStepId[];
}

export interface ApplySurgicalStepScopingParams {
  existingTenant: SupportTenant;
  baselineSteps: SupportSetupPlannedStep[];
  analysis: SurgicalEditAnalysis;
  canEditSteps: ReadonlySet<SupportSetupStepId>;
  locale: 'vi' | 'en';
  availableModelIds?: ReadonlySet<string>;
}

export interface SurgicalPermissionDeniedResult {
  outcome: 'permission_denied';
  deniedSteps: SupportSetupStepId[];
  requiredPermissions: SurgicalTenantEditPermission[];
  replyVi: string;
  replyEn: string;
  reply: string;
}

export interface SurgicalScopedMergeResult {
  outcome: 'scoped';
  targetedSteps: SupportSetupStepId[];
  deniedSteps: SupportSetupStepId[];
  requiredPermissions: SurgicalTenantEditPermission[];
  steps: SupportSetupPlannedStep[];
  replyVi: string;
  replyEn: string;
  reply: string;
  summaryVi: string;
  summaryEn: string;
  summary: string;
}

export interface SurgicalNotApplicableResult {
  outcome: 'not_surgical';
  steps: SupportSetupPlannedStep[];
}

export type SurgicalScopingAndMergeResult =
  | SurgicalPermissionDeniedResult
  | SurgicalScopedMergeResult
  | SurgicalNotApplicableResult;

const VALID_STEP_SET = new Set<string>(SUPPORT_SETUP_STEP_IDS);

const UNSAFE_WIDGET_TEXT_RE =
  /[<>]|https?:\/\/|javascript:|data:|vbscript:|url\s*\(|expression\s*\(/gi;

function foldVietnameseAscii(input: string): string {
  return input
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[\u0111\u0110]/gu, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function stripControlChars(input: string): string {
  let out = '';
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (
      (code >= 0 && code <= 8) ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      code === 127
    ) {
      continue;
    }
    out += input[i];
  }
  return out;
}

function sanitizeSurgicalWidgetText(raw: string, maxLen: number, fallback: string): string {
  const replacedUrls = raw.replace(/https?:\/\/([A-Za-z0-9.-]+(?::\d+)?)[^\s<>"']*/gi, '$1');
  const cleaned = stripControlChars(replacedUrls)
    .replace(UNSAFE_WIDGET_TEXT_RE, ' ')
    .replace(/\s+/g, ' ')
    .normalize('NFC')
    .trim();
  if (!cleaned) return fallback.slice(0, maxLen);
  return cleaned.slice(0, maxLen).trim();
}

function stripTrailingPoliteParticles(raw: string): string {
  return raw
    .replace(
      /\s+(?:giúp\s+(?:mình|tôi|em)|giup\s+(?:minh|toi|em)|cho\s+(?:mình|tôi|em)|cho\s+(?:minh|toi|em)|thôi\s+nhé|thoi\s+nhe|thôi\s+nha|thoi\s+nha|luôn\s+nhé|luon\s+nhe|nhé|nhe|nha|thôi|thoi|ạ|a|đi|di|please|right\s+now|only|just\s+that)\s*[.!?]*$/i,
      '',
    )
    .replace(/^[:"'`“”\s]+|[:"'`“”.!?\s]+$/g, '')
    .trim();
}

function expandShortHex(hex: string): string {
  const trimmed = hex.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(trimmed)) return trimmed;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(trimmed);
  if (short) {
    return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  }
  return '#2563eb';
}

function darkenHex(hex: string): string {
  const clean = expandShortHex(hex).slice(1);
  const r = Math.max(0, Math.round(parseInt(clean.slice(0, 2), 16) * 0.8));
  const g = Math.max(0, Math.round(parseInt(clean.slice(2, 4), 16) * 0.8));
  const b = Math.max(0, Math.round(parseInt(clean.slice(4, 6), 16) * 0.8));
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function mergeUniqueStrings(existing: readonly string[], incoming: readonly string[], maxItems = 40): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of [...existing, ...incoming]) {
    const cleaned = String(item ?? '').replace(/\s+/g, ' ').trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= maxItems) break;
  }
  return out;
}

function extractOriginsFromText(raw: string): string[] {
  const candidates: string[] = [];
  const urlMatches = raw.matchAll(/https?:\/\/[^\s,;"'<>()]+/gi);
  for (const m of urlMatches) {
    if (m[0]) candidates.push(m[0].replace(/[.,!?;:]+$/, ''));
  }
  const bareMatches = raw.matchAll(
    /(?<![/@\w.-])\b((?:localhost|127\.0\.0\.1)(?::\d{2,5})?|(?:[a-z0-9-]+\.)+(?:vn|com|net|org|io|co|ai|app|dev|edu|info|shop|store|me|xyz)(?::\d{2,5})?)\b/gi,
  );
  for (const m of bareMatches) {
    if (m[1]) candidates.push(m[1]);
  }

  const origins: string[] = [];
  for (const token of candidates) {
    const withProto = /^https?:\/\//i.test(token)
      ? token
      : /^(?:localhost|127\.0\.0\.1)\b/i.test(token)
        ? `http://${token}`
        : `https://${token}`;
    try {
      const parsed = new URL(withProto);
      if (
        (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
        (parsed.hostname.includes('.') ||
          parsed.hostname === 'localhost' ||
          parsed.hostname === '127.0.0.1')
      ) {
        if (!origins.includes(parsed.origin)) {
          origins.push(parsed.origin);
        }
      }
    } catch {
      // Ignore invalid URL candidates
    }
  }
  return origins;
}

const NEXT_SURGICAL_CLAUSE_BOUNDARY_RE =
  /(?:,\s*|\s+(?:và|va|and|rồi|roi|đồng\s+thời|dong\s+thoi|also)\s+)(?=(?:đổi|doi|thay|sửa|sua|chỉnh|chinh|cập\s+nhật|cap\s+nhat|thêm|them|bổ\s+sung|bo\s+sung|bật|bat|tắt|tat|chặn|chan|cấm|cam|đặt|dat|chuyển|chuyen|set|change|update|switch|move|enable|disable|turn\s+on|turn\s+off|add|block|forbid|ban|rename|replace)\s+(?:mỗi\s+|moi\s+|riêng\s+|rieng\s+|the\s+)?(?:màu|mau|vị\s+trí|vi\s+tri|tiêu\s+đề|tieu\s+de|lời\s+chào|loi\s+chao|widget|nút\s+chat|nut\s+chat|thu\s+thập|thu\s+thap|model|giọng|giong|khách\s+vãng\s+lai|khach\s+vang\s+lai|tên\s+tenant|ten\s+tenant|system\s*prompt|hướng\s+dẫn|huong\s+dan|che\b|ẩn\b|pii\b|mask|nhắc|nhac|đối\s+thủ|doi\s+thu|chủ\s+đề|chu\s+de|tường\s+lửa|tuong\s+lua|guardrails?|prompt[\s-]*injection|kiểm\s+soát\s+đầu\s+ra|kiem\s+soat\s+dau\s+ra|output|maxoutputchars|sla\b|domain|cors|origins?|maxcompletiontokens|default\s+model|guest\s+chat|pre-?chat|competitors?|topics?|urgent\s+sla))/i;

function truncateAtNextSurgicalClause(rawFragment: string): string {
  const m = NEXT_SURGICAL_CLAUSE_BOUNDARY_RE.exec(rawFragment);
  return m && m.index > 0 ? rawFragment.slice(0, m.index).trim() : rawFragment;
}

function parseEntityList(rawFragment: string, isVietnameseContext: boolean): string[] {
  const bounded = truncateAtNextSurgicalClause(rawFragment);
  const cleanedTail = stripTrailingPoliteParticles(bounded);
  if (!cleanedTail) return [];
  const splitRe = isVietnameseContext
    ? /,|;|\bvà\b|\bva\b|\band\b/i
    : /,|;|\bvà\b|\band\b/i;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const piece of cleanedTail.split(splitRe)) {
    const item = stripTrailingPoliteParticles(
      piece.replace(/^["'`“”:]+|["'`“”.:]+$/g, '').trim(),
    ).slice(0, 80);
    if (!item || item.length < 1) continue;
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= 20) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Intent Guard Patterns (Full Setup vs. Pure Guide Question vs. Surgical Change)
// ---------------------------------------------------------------------------

const FULL_SETUP_FOLDED_RE =
  /\b(?:setup\s+toan\s+bo|thiet\s+lap\s+toan\s+bo|cau\s+hinh\s+toan\s+bo|cai\s+dat\s+toan\s+bo|toan\s+bo\s+7\s+buoc|ca\s+7\s+buoc|day\s+du\s+7\s+buoc|thiet\s+lap\s+day\s+du|thiet\s+lap\s+tu\s+dau|setup\s+tu\s+dau|setup\s+lai\s+tu\s+dau|cau\s+hinh\s+lai\s+toan\s+bo|cau\s+hinh\s+tron\s+goi|setup\s+tron\s+goi|thiet\s+lap\s+tron\s+goi|lam\s+lai\s+tu\s+dau|lam\s+lai\s+het|hoan\s+thien\s+cau\s+hinh\s+tieu\s+chuan|set\s+up\s+all\s+(?:7|seven)\s+steps|all\s+(?:7|seven)\s+steps|full\s+setup|complete\s+setup|full\s+onboarding|set\s*up\s+from\s+scratch|reconfigure\s+everything|configure\s+everything|auto-complete\s+current\s+tenant|standard\s+defaults)\b/i;

const PURE_QUESTION_PREFIX_FOLDED_RE =
  /^(?:cho\s+(?:minh|toi|em)\s+hoi\s+)?(?:cach|lam\s+sao|lam\s+the\s+nao|huong\s+dan(?:\s+cach)?|chi\s+(?:minh|toi|em)\s+cach|how\s+(?:do\s+i|can\s+i|to|should\s+i)|where\s+(?:do\s+i|can\s+i|is|are|to)|what\s+(?:is|are|does)|explain|tell\s+me\s+about)\b/i;

const PURE_QUESTION_CLAUSE_FOLDED_RE =
  /\b(?:o\s+dau|cho\s+nao|muc\s+nao|tab\s+nao|trang\s+nao|la\s+(?:cai\s+)?gi|de\s+lam\s+gi|hoat\s+dong\s+(?:sao|ra\s+sao|the\s+nao|nhu\s+the\s+nao)|khac\s+nhau|khac\s+gi|where\s+(?:do\s+i|can\s+i|to)\s+(?:change|update|set|add|configure|enable|disable|edit)|hien\s+tai\s+la\s+gi|dang\s+la\s+(?:gi|bao\s+nhieu)|lam\s+sao(?:\s+de)?|lam\s+the\s+nao(?:\s+de)?|nhu\s+the\s+nao|the\s+nao|how\s+(?:do\s+i|can\s+i|to|should\s+i))\b/i;

function isPureGuideOrHowToQuestion(raw: string, folded: string): boolean {
  if (PURE_QUESTION_PREFIX_FOLDED_RE.test(folded)) {
    return true;
  }
  // Strip quoted literal values so phrases inside a new greeting/prompt don't look like questions
  const withoutQuotes = foldVietnameseAscii(
    raw.replace(/"[^"]*"|'[^']*'|“[^”]*”/g, ' '),
  );
  return PURE_QUESTION_CLAUSE_FOLDED_RE.test(withoutQuotes);
}

const SURGICAL_ACTION_FOLDED_RE =
  /\b(?:doi|thay\s+doi|thay|sua|chinh(?:\s+sua)?|cap\s+nhat|them|bo\s+sung|nap|bat|kich\s+hoat|mo|cho\s+phep|tat|vo\s+hieu(?:\s+hoa)?|an|bo|go|chan|cam|khong\s+nhac|tranh\s+nhac|khong\s+tra\s+loi|dat|chuyen|nang|tang|giam|gioi\s+han|make|change|update|modify|edit|adjust|customize|set|switch|move|put|enable|activate|turn\s+on|allow|require|collect|disable|deactivate|turn\s+off|disallow|remove|hide|add|append|include|whitelist|replace|restrict|block|forbid|ban|prevent|increase|decrease|raise|lower|rename)\b/i;

const COLOR_RULES: ReadonlyArray<{
  hex: string;
  enRe: RegExp;
  viAccentedRe: RegExp;
  viFoldedAfterMauRe: RegExp;
}> = [
  {
    hex: '#ec4899',
    enRe: /\b(?:pink|rose)\b/i,
    viAccentedRe: /\bhồng\b/i,
    viFoldedAfterMauRe: /\bmau\b[^.;\n]{0,35}?\bhong\b|\bsang\s+hong\b/i,
  },
  {
    hex: '#ef4444',
    enRe: /\b(?:red|crimson)\b/i,
    viAccentedRe: /\bđỏ\b/i,
    viFoldedAfterMauRe: /\bmau\b[^.;\n]{0,35}?\b(?:sang\s+|thanh\s+|la\s+)?do\b/i,
  },
  {
    hex: '#10b981',
    enRe: /\b(?:emerald|green)\b/i,
    viAccentedRe: /xanh\s+(?:lá|lục)/i,
    viFoldedAfterMauRe: /\bxanh\s+(?:la|luc)\b/i,
  },
  {
    hex: '#2563eb',
    enRe: /\b(?:blue|cobalt|indigo)\b/i,
    viAccentedRe: /xanh\s+(?:dương|da\s+trời|biển)|màu\s+xanh\b/i,
    viFoldedAfterMauRe: /\b(?:xanh\s+(?:duong|da\s+troi|bien)|mau\s+xanh)\b/i,
  },
  {
    hex: '#8b5cf6',
    enRe: /\b(?:purple|violet)\b/i,
    viAccentedRe: /\btím\b/i,
    viFoldedAfterMauRe: /\bmau\b[^.;\n]{0,35}?\btim\b|\bsang\s+tim\b/i,
  },
  {
    hex: '#f97316',
    enRe: /\b(?:orange|amber)\b/i,
    viAccentedRe: /màu\s+cam\b|(?:sang|thành)\s+cam\b/i,
    viFoldedAfterMauRe: /\bmau\b[^.;\n]{0,35}?\bcam\b/i,
  },
  {
    hex: '#eab308',
    enRe: /\b(?:yellow|gold)\b/i,
    viAccentedRe: /\bvàng\b/i,
    viFoldedAfterMauRe: /\bmau\b[^.;\n]{0,35}?\bvang\b|\bsang\s+vang\b/i,
  },
  {
    hex: '#111827',
    enRe: /\bblack\b/i,
    viAccentedRe: /\bđen\b/i,
    viFoldedAfterMauRe: /\bmau\b[^.;\n]{0,35}?\bden\b/i,
  },
  {
    hex: '#475569',
    enRe: /\b(?:white|gray|grey|slate)\b/i,
    viAccentedRe: /\b(?:trắng|xám)\b/i,
    viFoldedAfterMauRe: /\bmau\b[^.;\n]{0,35}?\b(?:trang|xam)\b/i,
  },
];

function extractColorPatch(raw: string): string | undefined {
  const rawWithoutUrls = raw.replace(/https?:\/\/\S+/gi, ' ');
  const foldedWithoutUrls = foldVietnameseAscii(rawWithoutUrls);
  const hex6 = /(#[0-9a-fA-F]{6})\b/.exec(rawWithoutUrls);
  const hasColorOrWidgetCue =
    /\b(?:mau|color|colour|widget|theme|hex|nut\s+chat|khung\s+chat)\b/i.test(foldedWithoutUrls);
  if (hex6?.[1] && (hasColorOrWidgetCue || SURGICAL_ACTION_FOLDED_RE.test(foldedWithoutUrls))) {
    return expandShortHex(hex6[1]);
  }
  const hex3 = /(#[0-9a-fA-F]{3})\b/.exec(rawWithoutUrls);
  if (hex3?.[1] && hasColorOrWidgetCue) {
    return expandShortHex(hex3[1]);
  }
  if (!hasColorOrWidgetCue) return undefined;

  for (const rule of COLOR_RULES) {
    if (
      rule.enRe.test(foldedWithoutUrls) ||
      rule.viAccentedRe.test(rawWithoutUrls) ||
      rule.viFoldedAfterMauRe.test(foldedWithoutUrls)
    ) {
      return rule.hex;
    }
  }
  return undefined;
}

function extractCapturedValue(match: RegExpExecArray | null, keepQuotedRaw = true): string | undefined {
  if (!match) return undefined;
  for (let i = 1; i < match.length; i += 1) {
    const val = match[i];
    if (val !== undefined && val.trim().length > 0) {
      // Quoted groups come first in our patterns; unquoted group is last
      const isUnquotedLast = i === match.length - 1;
      const cleaned = isUnquotedLast || !keepQuotedRaw
        ? stripTrailingPoliteParticles(truncateAtNextSurgicalClause(val))
        : val.trim();
      return cleaned || undefined;
    }
  }
  return undefined;
}

/**
 * Analyzes whether the user's latest chat turn on an existing Support Tenant is
 * requesting a targeted / surgical configuration change on specific step(s)
 * rather than a full 7-step onboarding setup or a pure platform/how-to question.
 */
export function analyzeSurgicalSupportEdit(
  params: AnalyzeSurgicalSupportEditParams,
): SurgicalEditAnalysis {
  const empty: SurgicalEditAnalysis = {
    isSurgical: false,
    targetedSteps: [],
    patches: {},
  };

  if (!params.hasExistingTenant || params.explicitBriefSubmitted) {
    return empty;
  }

  const latestUserMsg = [...params.messages]
    .reverse()
    .find((m) => m.role === 'user' && m.content.trim().length > 0);
  if (!latestUserMsg) {
    return empty;
  }

  const raw = latestUserMsg.content.trim();
  const folded = foldVietnameseAscii(raw);
  if (!folded) {
    return empty;
  }

  // Never intercept explicit full 7-step / from-scratch onboarding setup requests
  if (FULL_SETUP_FOLDED_RE.test(folded)) {
    return empty;
  }

  // Never intercept pure guide / "what is" / "where to" / "how do I" questions
  if (isPureGuideOrHowToQuestion(raw, folded)) {
    return empty;
  }

  const isViContext =
    params.locale === 'vi' ||
    /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(raw) ||
    /\b(?:doi|thay|sua|them|bat|tat|chan|sang|thanh|vao|cho|cua|minh|toi|thoi|nhe|goc\s+trai|goc\s+phai|mac\s+dinh|doi\s+thu|truoc\s+khi)\b/i.test(
      folded,
    );

  const hasActionCue = SURGICAL_ACTION_FOLDED_RE.test(folded);
  const patches: SurgicalStepPatches = {};
  const targetedSet = new Set<SupportSetupStepId>();

  // -------------------------------------------------------------------------
  // Step 5: widget_appearance
  // -------------------------------------------------------------------------
  const widgetPatch: SurgicalWidgetAppearancePatch = {};

  if (hasActionCue) {
    const color = extractColorPatch(raw);
    if (color) {
      widgetPatch.primaryColor = color;
    }

    if (
      /\b(?:goc\s+trai|ben\s+trai|phia\s+trai|bottom-left|bottom\s+left)\b/i.test(folded) ||
      /\b(?:widget|nut\s+chat|chat\s+button|launcher)\b[^.;\n]{0,40}\b(?:to\s+(?:the\s+)?left|left\s+(?:corner|side))\b/i.test(
        folded,
      )
    ) {
      widgetPatch.position = 'left';
    } else if (
      /\b(?:goc\s+phai|ben\s+phai|phia\s+phai|bottom-right|bottom\s+right)\b/i.test(folded) ||
      /\b(?:widget|nut\s+chat|chat\s+button|launcher)\b[^.;\n]{0,40}\b(?:to\s+(?:the\s+)?right|right\s+(?:corner|side))\b/i.test(
        folded,
      )
    ) {
      widgetPatch.position = 'right';
    }

    // Contact intake (must run before widgetEnabled check so "tắt thu thập email trên widget" never disables widget)
    const disableIntake =
      /\b(?:tat|bo|go|khong\s+can|khong\s+bat(?:\s+buoc)?|disable|turn\s+off|remove|skip)\b[^.;\n]{0,35}\b(?:thu\s+thap|nhap|dien)\s+(?:email|sdt|so\s+dien\s+thoai|thong\s+tin|ten|lien\s+he)\b/i.test(
        folded,
      ) ||
      /\b(?:tat|bo|go|disable|turn\s+off|remove|skip)\b[^.;\n]{0,35}\b(?:pre-?chat|intake(?:\s+form)?|contact\s+intake|email\s+(?:before\s+chat|collection|intake))\b/i.test(
        folded,
      ) ||
      /\b(?:without|no)\s+(?:pre-?chat\s+|customer\s+)?(?:email|contact)\s+intake\b/i.test(folded);

    const enableIntake =
      !disableIntake &&
      (/\b(?:bat|yeu\s+cau|them|mo|can|bat\s+buoc|enable|turn\s+on|require|collect)\b[^.;\n]{0,35}\b(?:thu\s+thap|nhap|dien)\s+(?:email|sdt|so\s+dien\s+thoai|thong\s+tin|ten|lien\s+he)\b/i.test(
        folded,
      ) ||
        /\bthu\s+thap\s+(?:email|sdt|so\s+dien\s+thoai|thong\s+tin)\s+truoc\s+khi\s+chat\b/i.test(
          folded,
        ) ||
        /\b(?:bat|yeu\s+cau|enable|turn\s+on|require|collect)\b[^.;\n]{0,40}\b(?:pre-?chat(?:\s+form|\s+email|\s+intake)?|intake\s+form|contact\s+intake|customer\s+email\s+before\s+chat|email\s+before\s+chat(?:ting)?|email\s+intake)\b/i.test(
          folded,
        ));

    if (disableIntake) {
      widgetPatch.requireContactIntake = false;
    } else if (enableIntake) {
      widgetPatch.requireContactIntake = true;
    }

    // Explicit widget enable/disable
    if (
      /\b(?:tat|an|vo\s+hieu(?:\s+hoa)?|disable|turn\s+off|hide)\s+(?:khung\s+chat\s+|nut\s+chat\s+|cua\s+so\s+|chat\s+|customer\s+|embeddable\s+)?widget\b/i.test(
        folded,
      )
    ) {
      widgetPatch.widgetEnabled = false;
    } else if (
      /\b(?:bat|hien(?:\s+thi)?|kich\s+hoat|mo|enable|turn\s+on|activate|show)\s+(?:khung\s+chat\s+|nut\s+chat\s+|cua\s+so\s+|chat\s+|customer\s+|embeddable\s+)?widget\b/i.test(
        folded,
      )
    ) {
      widgetPatch.widgetEnabled = true;
    }

    // Widget title
    const titleViMatch =
      /(?:đổi|doi|sửa|sua|đặt|dat|cập\s+nhật|cap\s+nhat|chuyển|chuyen)\s+(?:tiêu\s+đề|tieu\s+de|tên\s+hiển\s+thị|ten\s+hien\s+thi)\s*(?:của\s+|cua\s+)?(?:widget|khung\s+chat|chat\s+widget)?\s*(?:thành|thanh|sang|là|la|:)\s*(?:"([^"]+)"|'([^']+)'|“([^”]+)”|([^\n,.;!?]+))/i.exec(
        raw,
      );
    const titleEnMatch =
      /(?:change|update|set|rename)\s+(?:the\s+)?(?:chat\s+)?widget\s+(?:header\s+)?title\s*(?:to|as|:)\s*(?:"([^"]+)"|'([^']+)'|“([^”]+)”|([^\n,.;!?]+))/i.exec(
        raw,
      );
    const extractedTitle = extractCapturedValue(titleViMatch ?? titleEnMatch);
    if (extractedTitle) {
      widgetPatch.widgetTitle = sanitizeSurgicalWidgetText(
        extractedTitle,
        SUPPORT_DESK_LIMITS.maxLabelChars,
        extractedTitle,
      );
    }

    // Widget greeting / welcome message
    const greetingViMatch =
      /(?:đổi|doi|sửa|sua|đặt|dat|cập\s+nhật|cap\s+nhat|chuyển|chuyen)\s+(?:lời\s+chào|loi\s+chao|câu\s+chào|cau\s+chao|tin\s+nhắn\s+chào|tin\s+nhan\s+chao)(?:\s+mở\s+đầu|\s+mo\s+dau|\s+widget|\s+của\s+widget|\s+cua\s+widget)?\s*(?:thành|thanh|sang|là|la|:)\s*(?:"([^"]+)"|'([^']+)'|“([^”]+)”|([^\n;]+))/i.exec(
        raw,
      );
    const greetingEnMatch =
      /(?:change|update|set)\s+(?:the\s+)?(?:widget\s+)?(?:welcome\s+message|greeting(?:\s+message)?)\s*(?:to|as|:)\s*(?:"([^"]+)"|'([^']+)'|“([^”]+)”|([^\n;]+))/i.exec(
        raw,
      );
    const extractedGreeting = extractCapturedValue(greetingViMatch ?? greetingEnMatch);
    if (extractedGreeting) {
      widgetPatch.widgetGreeting = sanitizeSurgicalWidgetText(
        extractedGreeting,
        SUPPORT_DESK_LIMITS.maxTextChars,
        extractedGreeting,
      );
    }
  }

  if (Object.keys(widgetPatch).length > 0) {
    patches.widget_appearance = widgetPatch;
    targetedSet.add('widget_appearance');
  }

  // -------------------------------------------------------------------------
  // Step 1: tenant_ai
  // -------------------------------------------------------------------------
  const aiPatch: SurgicalTenantAiPatch = {};

  if (hasActionCue) {
    const modelMatch =
      /(?:đổi|doi|chuyển|chuyen|đặt|dat|chọn|chon|dùng|dung|cập\s+nhật|cap\s+nhat|sửa|sua|change|switch|set|update|use)\s+(?:con\s+|the\s+)?(?:default\s+|ai\s+|chat\s+)?model(?:\s+mặc\s+định|\s+mac\s+dinh|\s+ai|\s+chính|\s+chinh)?\s*(?:mặc\s+định\s+|mac\s+dinh\s+)?(?:sang|thành|thanh|là|la|về|ve|to|as|:)\s*["'`“]?([A-Za-z0-9][A-Za-z0-9._:/-]{1,119})["'`”]?/i.exec(
        raw,
      );
    if (modelMatch?.[1]) {
      const cleanedModel = modelMatch[1].replace(/[.,!?;:]+$/, '').trim();
      if (cleanedModel) {
        aiPatch.defaultModel = cleanedModel;
      }
    }

    // Tone change (requires explicit tone action cue so general descriptive chat never triggers)
    if (
      /(?:(?:doi|thay|chuyen|dat|chinh|sua|cap\s+nhat|change|switch|set|update|make)\s+(?:the\s+)?(?:giong(?:\s+dieu|\s+ai|\s+van)?|phong\s+cach(?:\s+tra\s+loi)?|tone|persona\s+voice)|(?:giong(?:\s+dieu|\s+ai|\s+van)?|phong\s+cach(?:\s+tra\s+loi)?|tone|persona\s+voice)\s*(?:sang|thanh|la|to|as|:))/i.test(
        folded,
      )
    ) {
      if (/\b(?:dong\s+cam|an\s+can|thau\s+hieu|empathetic|caring)\b/i.test(folded)) {
        aiPatch.tone = 'empathetic';
      } else if (/\b(?:ky\s+thuat|chuyen\s+sau|technical)\b/i.test(folded)) {
        aiPatch.tone = 'technical';
      } else if (/\b(?:chuyen\s+nghiep|trang\s+trong|lich\s+su|professional|formal)\b/i.test(folded)) {
        aiPatch.tone = 'professional';
      } else if (/\b(?:than\s+thien|gan\s+gui|nhiet\s+tinh|vui\s+ve|friendly|warm)\b/i.test(folded)) {
        aiPatch.tone = 'friendly';
      }
    }

    // Guest chat access
    if (
      /\b(?:tat|chan|cam|khong\s+cho(?:\s+phep)?|disable|disallow|block|turn\s+off)\b[^.;\n]{0,30}\b(?:khach\s+vang\s+lai|guest(?:\s+chat|\s+access|\s+sessions?|\s+mode|\s+users?))\b/i.test(
        folded,
      )
    ) {
      aiPatch.allowGuest = false;
    } else if (
      /\b(?:bat|cho\s+phep|mo|kich\s+hoat|enable|allow|turn\s+on)\b[^.;\n]{0,30}\b(?:khach\s+vang\s+lai|guest(?:\s+chat|\s+access|\s+sessions?|\s+mode|\s+users?))\b/i.test(
        folded,
      )
    ) {
      aiPatch.allowGuest = true;
    }

    // Rename tenant
    const tenantNameViMatch =
      /(?:đổi|doi|sửa|sua|cập\s+nhật|cap\s+nhat|đặt\s+lại|dat\s+lai)\s+tên\s+tenant\s*(?:thành|thanh|sang|là|la|:)\s*(?:"([^"]+)"|'([^']+)'|“([^”]+)”|([^\n,.;!?]+))/i.exec(
        raw,
      );
    const tenantNameEnMatch =
      /(?:rename|change|update|set)\s+(?:the\s+)?tenant(?:\s+display)?\s+name\s*(?:to|as|:)\s*(?:"([^"]+)"|'([^']+)'|“([^”]+)”|([^\n,.;!?]+))/i.exec(
        raw,
      );
    const extractedTenantName = extractCapturedValue(tenantNameViMatch ?? tenantNameEnMatch);
    if (extractedTenantName) {
      aiPatch.tenantName = extractedTenantName.slice(0, 80);
    }

    // System prompt append vs replace
    const promptAppendMatch =
      /(?:thêm|them|bổ\s+sung|bo\s+sung|nối\s+thêm|noi\s+them|append|add)\s+(?:hướng\s+dẫn|huong\s+dan|quy\s+tắc|quy\s+tac|lưu\s+ý|luu\s+y|chỉ\s+thị|chi\s+thi|instructions?|rules?)\s*(?:cho\s+ai|vào\s+system\s*prompt|vao\s+system\s*prompt|to\s+(?:the\s+)?system\s*prompt|for\s+(?:the\s+)?ai)?\s*(?:là|la|:)\s*(?:"([^"]+)"|'([^']+)'|“([^”]+)”|(.+))/i.exec(
        raw,
      );
    const promptReplaceMatch =
      /(?:đổi|doi|thay(?:\s+thế|\s+the)?|sửa|sua|đặt|dat|cập\s+nhật|cap\s+nhat|set|replace|change|update)\s+(?:the\s+)?system\s*prompt\s*(?:thành|thanh|sang|là|la|to|with|:)\s*(?:"([^"]+)"|'([^']+)'|“([^”]+)”|(.+))/i.exec(
        raw,
      );
    const appendedPrompt = extractCapturedValue(promptAppendMatch);
    const replacedPrompt = extractCapturedValue(promptReplaceMatch);
    if (appendedPrompt) {
      aiPatch.systemPromptAppend = appendedPrompt.slice(0, 4000);
    } else if (replacedPrompt) {
      aiPatch.systemPrompt = replacedPrompt.slice(0, 4000);
    }
  }

  if (Object.keys(aiPatch).length > 0) {
    patches.tenant_ai = aiPatch;
    targetedSet.add('tenant_ai');
  }

  // -------------------------------------------------------------------------
  // Step 2: knowledge_masking
  // -------------------------------------------------------------------------
  const kbPatch: SurgicalKnowledgeMaskingPatch = {};

  if (hasActionCue) {
    const disableMasking =
      /\b(?:tat|bo|vo\s+hieu(?:\s+hoa)?|disable|turn\s+off)\s+(?:tinh\s+nang\s+|che\s+do\s+)?(?:(?:che|an|mask(?:ing)?)\s+(?:du\s+lieu\s+nhay\s+cam|thong\s+tin\s+ca\s+nhan|pii|sdt|so\s+dien\s+thoai|email|the|credit\s+card|api\s*keys?)|pii\s+masking)\b/i.test(
        folded,
      );
    const enableMasking =
      !disableMasking &&
      /\b(?:bat|kich\s+hoat|mo|enable|turn\s+on)\s+(?:tinh\s+nang\s+|che\s+do\s+)?(?:(?:che|an|mask(?:ing)?)\s+(?:du\s+lieu\s+nhay\s+cam|thong\s+tin\s+ca\s+nhan|pii|sdt|so\s+dien\s+thoai|email|the|credit\s+card|api\s*keys?)|pii\s+masking)\b/i.test(
        folded,
      );

    if (disableMasking) {
      kbPatch.maskingEnabled = false;
    } else if (enableMasking) {
      kbPatch.maskingEnabled = true;
    }

    const faqViMatch =
      /(?:thêm|them|bổ\s+sung|bo\s+sung|cập\s+nhật|cap\s+nhat|đổi|doi|sửa|sua|nạp|nap)\s+(?:tài\s+liệu\s+|tai\s+lieu\s+|bài\s+viết\s+|bai\s+viet\s+|mục\s+|muc\s+)?((?:chính\s+sách|chinh\s+sach|faq|câu\s+hỏi\s+thường\s+gặp|cau\s+hoi\s+thuong\s+gap)\b[^\n]*)/i.exec(
        raw,
      );
    const faqEnMatch =
      /(?:add|append|update|change|set)\s+(?:a\s+|the\s+|new\s+)?((?:faq|return\s+policy|refund\s+policy|shipping\s+policy|warranty\s+policy|knowledge\s+(?:doc|article|policy))\b[^\n]*)/i.exec(
        raw,
      );
    const rawFaqCapture = (faqViMatch?.[1] ?? faqEnMatch?.[1])?.trim();
    if (rawFaqCapture) {
      const cleanedFaq = stripTrailingPoliteParticles(
        truncateAtNextSurgicalClause(
          rawFaqCapture.replace(
            /^(?:faq|câu\s+hỏi\s+thường\s+gặp|cau\s+hoi\s+thuong\s+gap)\s*(?:là|la|về|ve|:|-)?\s*/i,
            '',
          ),
        ),
      );
      if (cleanedFaq.length >= 4) {
        kbPatch.faqDocContent = cleanedFaq.slice(0, 4000);
      }
    }
  }

  if (Object.keys(kbPatch).length > 0) {
    patches.knowledge_masking = kbPatch;
    targetedSet.add('knowledge_masking');
  }

  // -------------------------------------------------------------------------
  // Step 3: guardrails_quotas
  // -------------------------------------------------------------------------
  const guardPatch: SurgicalGuardrailsQuotasPatch = {};

  if (hasActionCue) {
    const compViMatch =
      /(?:chặn(?:\s+nhắc(?:\s+tên|\s+đến)?)?|chan(?:\s+nhac(?:\s+ten|\s+den)?)?|cấm\s+nhắc(?:\s+tên|\s+đến)?|cam\s+nhac(?:\s+ten|\s+den)?|không\s+(?:được\s+)?nhắc(?:\s+tên|\s+đến)?|khong\s+(?:duoc\s+)?nhac(?:\s+ten|\s+den)?|tránh\s+nhắc(?:\s+tên|\s+đến)?|tranh\s+nhac(?:\s+ten|\s+den)?|thêm\s+(?:từ\s+khóa\s+)?đối\s+thủ|them\s+(?:tu\s+khoa\s+)?doi\s+thu)\s*(?:tên\s+|ten\s+)?(?:đối\s+thủ|doi\s+thu)?\s*(?:là|la|:)?\s*([^\n.;!?]+)/i.exec(
        raw,
      );
    const compEnMatch =
      /(?:block(?:\s+mentioning)?|forbid(?:\s+mentioning)?|ban(?:\s+mentioning)?|add)\s+(?:competitor(?:\s+names?|\s+keywords?)?|rival)\s*(?:keywords?\s*)?(?:like|:)?\s*([^\n.;!?]+)/i.exec(
        raw,
      );
    const hasExplicitCompetitorCue =
      /\b(?:doi\s+thu|competitors?|rival)\b/i.test(folded) || Boolean(compEnMatch);
    if (hasExplicitCompetitorCue) {
      const compFragment = compViMatch?.[1] ?? compEnMatch?.[1];
      if (compFragment) {
        const parsedComp = parseEntityList(compFragment, isViContext);
        if (parsedComp.length > 0) {
          guardPatch.addCompetitorKeywords = parsedComp;
        }
      }
    }

    const topicViMatch =
      /(?:chặn\s+chủ\s+đề|chan\s+chu\s+de|thêm\s+chủ\s+đề\s+(?:cấm|chặn)|them\s+chu\s+de\s+(?:cam|chan)|cấm\s+chủ\s+đề|cam\s+chu\s+de|không\s+trả\s+lời\s+(?:về\s+)?(?:chủ\s+đề\s+)?|khong\s+tra\s+loi\s+(?:ve\s+)?(?:chu\s+de\s+)?|tránh\s+nói\s+về|tranh\s+noi\s+ve)\s*(?:là|la|:)?\s*([^\n.;!?]+)/i.exec(
        raw,
      );
    const topicEnMatch =
      /(?:block|forbid|ban|add\s+blocked)\s+topics?\s*(?:like|about|:)?\s*([^\n.;!?]+)/i.exec(raw);
    const topicFragment = topicViMatch?.[1] ?? topicEnMatch?.[1];
    if (topicFragment) {
      const parsedTopics = parseEntityList(topicFragment, isViContext);
      if (parsedTopics.length > 0) {
        guardPatch.addBlockedTopics = parsedTopics;
      }
    }

    if (
      /\b(?:tat|vo\s+hieu(?:\s+hoa)?|disable|turn\s+off)\s+(?:chan\s+|chong\s+|bao\s+ve\s+)?prompt[\s-]*injection\b/i.test(
        folded,
      )
    ) {
      guardPatch.blockPromptInjection = false;
    } else if (
      /\b(?:bat|kich\s+hoat|enable|turn\s+on)\s+(?:chan\s+|chong\s+|bao\s+ve\s+)?prompt[\s-]*injection\b/i.test(
        folded,
      )
    ) {
      guardPatch.blockPromptInjection = true;
    }

    if (
      /\b(?:tat|vo\s+hieu(?:\s+hoa)?|disable|turn\s+off)\s+(?:tuong\s+lua(?:\s+prompt)?|guardrails?)\b/i.test(
        folded,
      )
    ) {
      guardPatch.guardrailsEnabled = false;
    } else if (
      /\b(?:bat|kich\s+hoat|enable|turn\s+on)\s+(?:tuong\s+lua(?:\s+prompt)?|guardrails?)\b/i.test(
        folded,
      )
    ) {
      guardPatch.guardrailsEnabled = true;
    }
  }

  if (Object.keys(guardPatch).length > 0) {
    patches.guardrails_quotas = guardPatch;
    targetedSet.add('guardrails_quotas');
  }

  // -------------------------------------------------------------------------
  // Step 4: output_controls
  // -------------------------------------------------------------------------
  const outPatch: SurgicalOutputControlsPatch = {};

  if (hasActionCue) {
    const hasOutputCue =
      /\b(?:kiem\s+soat\s+dau\s+ra|che\s+do\s+dau\s+ra|output\s*(?:controls?|policy|mode|safety))\b/i.test(
        folded,
      );
    if (hasOutputCue) {
      if (/\b(?:monitor|log|giam\s+sat|chi\s+ghi\s+log)\b/i.test(folded)) {
        outPatch.outputMode = 'monitor';
      } else if (/\bredact\b|\bche\s+tu\s+cam\b/i.test(folded)) {
        outPatch.outputMode = 'redact';
      } else if (/\b(?:block|enforce|chan(?:\s+dau\s+ra|\s+phan\s+hoi)?|thuc\s+thi)\b/i.test(folded)) {
        outPatch.outputMode = 'block';
      }
    }

    if (
      /\b(?:tat|disable|turn\s+off)\s+(?:tu\s+dong\s+)?(?:che|an|redact(?:ing)?)\s+(?:khoa\s+bi\s+mat|credentials?|secret\s+keys?)\b/i.test(
        folded,
      ) ||
      /\bredactcredentials\s*(?:=|:|\s+to\s+)\s*false\b/i.test(folded)
    ) {
      outPatch.redactCredentials = false;
    } else if (
      /\b(?:bat|enable|turn\s+on)\s+(?:tu\s+dong\s+)?(?:che|an|redact(?:ing)?)\s+(?:khoa\s+bi\s+mat|credentials?|secret\s+keys?)\b/i.test(
        folded,
      ) ||
      /\bredactcredentials\s*(?:=|:|\s+to\s+)\s*true\b/i.test(folded)
    ) {
      outPatch.redactCredentials = true;
    }

    const maxOutMatch =
      /(?:maxOutputChars|max\s+output\s+(?:chars|characters|length)|giới\s+hạn\s+ký\s+tự\s+đầu\s+ra|gioi\s+han\s+ky\s+tu\s+dau\s+ra|độ\s+dài\s+phản\s+hồi\s+tối\s+đa|do\s+dai\s+phan\s+hoi\s+toi\s+da)\s*(?:sang|thành|thanh|lên|len|xuống|xuong|là|la|to|=|:)?\s*(\d{3,6})\b/i.exec(
        raw,
      );
    if (maxOutMatch?.[1]) {
      outPatch.maxOutputChars = clampInt(
        Number.parseInt(maxOutMatch[1], 10),
        SUPPORT_OUTPUT_LIMITS.maxOutputCharsMin,
        SUPPORT_OUTPUT_LIMITS.maxOutputCharsMax,
      );
    }
  }

  if (Object.keys(outPatch).length > 0) {
    patches.output_controls = outPatch;
    targetedSet.add('output_controls');
  }

  // -------------------------------------------------------------------------
  // Step 6: sla_routing
  // -------------------------------------------------------------------------
  const slaPatch: SurgicalSlaRoutingPatch = {};

  if (hasActionCue) {
    if (/\bsla\b/i.test(folded)) {
      const slaMinMatch =
        /\bsla\b[^.;\n]{0,45}?(\d{1,4})\s*(?:phut|p|mins?|minutes?)\b/i.exec(folded) ??
        /(\d{1,4})\s*(?:phut|p|mins?|minutes?)\b[^.;\n]{0,30}?\bsla\b/i.exec(folded);
      if (slaMinMatch?.[1]) {
        slaPatch.urgentFirstResponseMinutes = clampInt(
          Number.parseInt(slaMinMatch[1], 10),
          1,
          SUPPORT_DESK_LIMITS.maxSlaMinutes,
        );
      }

      if (/\b(?:tat|vo\s+hieu(?:\s+hoa)?|disable|turn\s+off)\s+(?:theo\s+doi\s+)?sla\b/i.test(folded)) {
        slaPatch.slaEnabled = false;
      } else if (
        /\b(?:bat|kich\s+hoat|mo|enable|turn\s+on)\s+(?:theo\s+doi\s+)?sla\b/i.test(folded)
      ) {
        slaPatch.slaEnabled = true;
      }
    }
  }

  if (Object.keys(slaPatch).length > 0) {
    patches.sla_routing = slaPatch;
    targetedSet.add('sla_routing');
  }

  // -------------------------------------------------------------------------
  // Step 7: runtime_policy
  // -------------------------------------------------------------------------
  const runtimePatch: SurgicalRuntimePolicyPatch = {};

  if (hasActionCue) {
    const hasCorsOrOriginCue =
      /\b(?:cors|origins?|domains?|whitelists?|ten\s+mien)\b/i.test(folded);
    if (hasCorsOrOriginCue) {
      const extractedOrigins = extractOriginsFromText(raw);
      if (extractedOrigins.length > 0) {
        const isExplicitReplace =
          /\b(?:thay\s+the|thay\s+danh\s+sach|dat\s+lai|chi\s+cho\s+phep|replace|overwrite|only\s+allow)\b/i.test(
            folded,
          ) || /\ballowed\s+origins?\s+to\b[^.;\n]*\bonly\b/i.test(folded);
        if (isExplicitReplace) {
          runtimePatch.replaceAllowedOrigins = extractedOrigins;
        } else {
          runtimePatch.addAllowedOrigins = extractedOrigins;
        }
      }
    }

    const maxTokensMatch =
      /(?:maxCompletionTokens|max\s+completion\s+tokens?|token\s+trả\s+lời\s+tối\s+đa|token\s+tra\s+loi\s+toi\s+da|giới\s+hạn\s+token(?:\s+trả\s+lời|\s+completion)?|gioi\s+han\s+token(?:\s+tra\s+loi|\s+completion)?)\s*(?:sang|thành|thanh|lên|len|xuống|xuong|là|la|to|=|:)?\s*(\d{2,5})\b/i.exec(
        raw,
      );
    if (maxTokensMatch?.[1]) {
      runtimePatch.maxCompletionTokens = clampInt(
        Number.parseInt(maxTokensMatch[1], 10),
        RUNTIME_POLICY_BOUNDS.maxCompletionTokens.min,
        RUNTIME_POLICY_BOUNDS.maxCompletionTokens.max,
      );
    }
  }

  if (Object.keys(runtimePatch).length > 0) {
    patches.runtime_policy = runtimePatch;
    targetedSet.add('runtime_policy');
  }

  // Merge valid llmTargetSteps when consistent with a targeted change request (not full 7-step)
  if (
    Array.isArray(params.llmTargetSteps) &&
    params.llmTargetSteps.length > 0 &&
    (hasActionCue || targetedSet.size > 0)
  ) {
    const validLlmSteps = params.llmTargetSteps.filter((s): s is SupportSetupStepId =>
      VALID_STEP_SET.has(s),
    );
    const uniqueLlmSteps = [...new Set(validLlmSteps)];
    if (uniqueLlmSteps.length > 0 && uniqueLlmSteps.length < SUPPORT_SETUP_STEP_IDS.length) {
      for (const s of uniqueLlmSteps) {
        targetedSet.add(s);
      }
    }
  }

  // Guard: If 5+ distinct steps were matched in a single broad business description without an explicit
  // surgical narrowing cue ("mỗi", "chỉ", "riêng", "thôi", "only", "just"), treat as full onboarding setup.
  const hasExplicitSurgicalNarrowing =
    /\b(?:moi|chi|rieng|thoi|only|just)\b/i.test(folded);
  if (targetedSet.size >= 5 && !hasExplicitSurgicalNarrowing) {
    return empty;
  }

  if (targetedSet.size === 0) {
    return empty;
  }

  const orderedTargets = SUPPORT_SETUP_STEP_IDS.filter((id) => targetedSet.has(id));
  return {
    isSurgical: true,
    targetedSteps: orderedTargets,
    patches,
  };
}

// ---------------------------------------------------------------------------
// Live Tenant Store Merging & Step-Level RBAC Scoping
// ---------------------------------------------------------------------------

const TONE_DIRECTIVES: Readonly<Record<SupportSetupTone, string>> = {
  friendly: 'Speak like a warm, helpful, approachable human support specialist — never stiff or robotic.',
  professional: 'Use a polished, respectful, reassuring professional tone.',
  empathetic: 'Use an empathetic, patient, caring customer-support tone.',
  technical: 'Use a clear, accurate, solution-oriented technical support tone.',
};

const TONE_LABELS_VI: Readonly<Record<SupportSetupTone, string>> = {
  friendly: 'thân thiện',
  professional: 'chuyên nghiệp',
  empathetic: 'đồng cảm',
  technical: 'kỹ thuật',
};

function applyNonDestructiveToneToPrompt(
  existingPrompt: string,
  tone: SupportSetupTone,
  tenantName: string,
): string {
  const directive = TONE_DIRECTIVES[tone];
  const trimmed = existingPrompt.trim();
  if (!trimmed) {
    return `You are the official AI Customer Support Assistant for ${tenantName}.\n${directive}`;
  }
  const existingToneLineRe =
    /^(?:Speak like a warm, helpful.*|Use a (?:polished|empathetic|clear, accurate).*tone\.|Communication tone:.*)$/im;
  if (existingToneLineRe.test(trimmed)) {
    return trimmed.replace(existingToneLineRe, directive);
  }
  return `${trimmed}\n${directive}`;
}

function resolveValidatedModel(
  requestedModel: string | undefined,
  currentModel: string,
  availableModelIds?: ReadonlySet<string>,
): { model: string; fellBackFrom?: string } {
  const fallback = currentModel || 'auto';
  if (!requestedModel || !requestedModel.trim()) {
    return { model: fallback };
  }
  const candidate = requestedModel.trim();
  if (!availableModelIds) {
    return { model: candidate };
  }
  if (candidate === 'auto' || candidate === fallback || availableModelIds.has(candidate)) {
    return { model: candidate };
  }
  const lower = candidate.toLowerCase();
  for (const allowed of availableModelIds) {
    if (allowed.toLowerCase() === lower) {
      return { model: allowed };
    }
  }
  return { model: fallback, fellBackFrom: candidate };
}

function mapOutputModeToPolicyMode(
  requested: SurgicalRequestedOutputMode | undefined,
  currentMode: SupportOutputMode,
  redactCredentialsPatch?: boolean,
): SupportOutputMode {
  if (requested === 'monitor') return 'log';
  if (requested === 'redact' || requested === 'block') return 'enforce';
  if (redactCredentialsPatch === true && currentMode === 'off') return 'enforce';
  return currentMode;
}

function buildPermissionDeniedReply(params: {
  tenantName: string;
  deniedSteps: SupportSetupStepId[];
  requiredPermissions: SurgicalTenantEditPermission[];
}): { replyVi: string; replyEn: string } {
  const { tenantName, deniedSteps, requiredPermissions } = params;
  const stepNamesVi = deniedSteps.map((s) => `**${STEP_LABELS[s].vi}**`).join(', ');
  const stepNamesEn = deniedSteps.map((s) => `**${STEP_LABELS[s].en}**`).join(', ');
  const permDetailsVi = requiredPermissions
    .map((perm) => {
      const sampleStep = SUPPORT_SETUP_STEP_IDS.find(
        (s) => SURGICAL_STEP_REQUIRED_PERMISSION[s] === perm,
      )!;
      return `\`${perm}\` (${STEP_LABELS[sampleStep].permLabelVi})`;
    })
    .join(', ');
  const permDetailsEn = requiredPermissions
    .map((perm) => {
      const sampleStep = SUPPORT_SETUP_STEP_IDS.find(
        (s) => SURGICAL_STEP_REQUIRED_PERMISSION[s] === perm,
      )!;
      return `\`${perm}\` (${STEP_LABELS[sampleStep].permLabelEn})`;
    })
    .join(', ');

  const replyVi =
    `Mình hiểu bạn đang muốn cập nhật riêng mục ${stepNamesVi} cho tenant **${tenantName}**, nhưng tài khoản hiện tại của bạn chưa được cấp quyền ${permDetailsVi}. ` +
    `Vì Copilot luôn tôn trọng chặt chẽ phân quyền và không đề xuất sang các bước không liên quan, hiện chưa có thay đổi nào được tạo hay áp dụng. ` +
    `Bạn nhờ **Tenant Owner** hoặc **Quản trị viên hệ thống** bật thêm quyền ${requiredPermissions.map((p) => `\`${p}\``).join(', ')} cho tài khoản rồi nhắn lại mình hỗ trợ ngay nhé!`;

  const replyEn =
    `I see you'd like to update ${stepNamesEn} on tenant **${tenantName}**, right now your account doesn't have the required ${permDetailsEn} permission. ` +
    `Because the Copilot strictly honors per-step RBAC and won't overwrite unrelated steps, no changes have been proposed or applied. ` +
    `Please ask a **Tenant Owner** or **Platform Admin** to grant ${requiredPermissions.map((p) => `\`${p}\``).join(', ')} on this tenant, and I'll be happy to prepare that exact update right away!`;

  return { replyVi, replyEn };
}

function buildDefaultBaselineStep(stepId: SupportSetupStepId): SupportSetupPlannedStep {
  return {
    stepId,
    canApply: false,
    enabledByDefault: false,
    titleEn: STEP_LABELS[stepId].en,
    titleVi: STEP_LABELS[stepId].vi,
    summaryEn: STEP_LABELS[stepId].en,
    summaryVi: STEP_LABELS[stepId].vi,
    highlightsEn: [],
    highlightsVi: [],
    payload: {},
  };
}

/**
 * Applies per-step RBAC verification and merges surgical field patches directly onto
 * the tenant's live existing DB configurations so only the requested step(s) have
 * `enabledByDefault: true` and all untouched fields inside each targeted step are preserved.
 */
export function applySurgicalStepScopingAndMerge(
  params: ApplySurgicalStepScopingParams,
): SurgicalScopingAndMergeResult {
  const {
    existingTenant,
    baselineSteps,
    analysis,
    canEditSteps,
    locale,
    availableModelIds,
  } = params;

  if (!analysis.isSurgical || analysis.targetedSteps.length === 0) {
    return {
      outcome: 'not_surgical',
      steps: baselineSteps,
    };
  }

  const permittedSteps = analysis.targetedSteps.filter((stepId) => canEditSteps.has(stepId));
  const deniedSteps = analysis.targetedSteps.filter((stepId) => !canEditSteps.has(stepId));
  const requiredPermissions: SurgicalTenantEditPermission[] = [
    ...new Set(deniedSteps.map((stepId) => SURGICAL_STEP_REQUIRED_PERMISSION[stepId])),
  ];

  if (permittedSteps.length === 0) {
    const { replyVi, replyEn } = buildPermissionDeniedReply({
      tenantName: existingTenant.name,
      deniedSteps,
      requiredPermissions,
    });
    return {
      outcome: 'permission_denied',
      deniedSteps,
      requiredPermissions,
      replyVi,
      replyEn,
      reply: locale === 'vi' ? replyVi : replyEn,
    };
  }

  const permittedSet = new Set<SupportSetupStepId>(permittedSteps);
  const baselineById = new Map<SupportSetupStepId, SupportSetupPlannedStep>(
    baselineSteps.map((s) => [s.stepId, s]),
  );

  const changeBulletsVi: string[] = [];
  const changeBulletsEn: string[] = [];

  const mergedSteps: SupportSetupPlannedStep[] = SUPPORT_SETUP_STEP_IDS.map((stepId) => {
    const baseStep = baselineById.get(stepId) ?? buildDefaultBaselineStep(stepId);
    const hasPerm = canEditSteps.has(stepId);

    // Unpermitted steps are strictly scrubbed and unchecked
    if (!hasPerm) {
      return {
        ...baseStep,
        canApply: false,
        enabledByDefault: false,
        highlightsEn: [],
        highlightsVi: [],
        payload: {},
      };
    }

    // Permitted steps that the user did NOT ask to modify stay unchecked (`enabledByDefault: false`)
    if (!permittedSet.has(stepId)) {
      return {
        ...baseStep,
        canApply: true,
        enabledByDefault: false,
      };
    }

    // Targeted & permitted step -> merge surgical patch onto live existing DB config!
    switch (stepId) {
      case 'tenant_ai': {
        const patch = analysis.patches.tenant_ai ?? {};
        const nextName = patch.tenantName?.trim()
          ? patch.tenantName.trim().slice(0, 80)
          : existingTenant.name;
        const modelRes = resolveValidatedModel(
          patch.defaultModel,
          existingTenant.defaultModel || 'auto',
          availableModelIds,
        );
        const nextSystemPrompt =
          patch.systemPrompt !== undefined
            ? patch.systemPrompt
            : patch.systemPromptAppend !== undefined
              ? existingTenant.systemPrompt.trim()
                ? `${existingTenant.systemPrompt.trim()}\n\n${patch.systemPromptAppend}`
                : patch.systemPromptAppend
              : patch.tone !== undefined
                ? applyNonDestructiveToneToPrompt(
                    existingTenant.systemPrompt,
                    patch.tone,
                    nextName,
                  )
                : existingTenant.systemPrompt;
        const nextAllowGuest = patch.allowGuest ?? existingTenant.allowGuest;
        const nextEnabled = patch.tenantEnabled ?? existingTenant.enabled;

        const payload: SupportSetupTenantAiPayload = {
          name: nextName,
          slug: existingTenant.slug,
          defaultModel: modelRes.model,
          systemPrompt: nextSystemPrompt,
          allowGuest: nextAllowGuest,
          enabled: nextEnabled,
        };

        const hlVi: string[] = [];
        const hlEn: string[] = [];
        if (patch.defaultModel !== undefined) {
          if (modelRes.fellBackFrom) {
            hlVi.push(
              `Model "${modelRes.fellBackFrom}" không nằm trong danh sách khả dụng nên giữ nguyên model an toàn "${modelRes.model}"`,
            );
            hlEn.push(
              `Model "${modelRes.fellBackFrom}" is not in available models; safely keeping "${modelRes.model}"`,
            );
          } else {
            hlVi.push(`Đổi model mặc định sang "${modelRes.model}"`);
            hlEn.push(`Switch default model to "${modelRes.model}"`);
          }
        }
        if (patch.tenantName !== undefined) {
          hlVi.push(`Đổi tên hiển thị tenant thành "${nextName}"`);
          hlEn.push(`Rename tenant display name to "${nextName}"`);
        }
        if (patch.tone !== undefined) {
          hlVi.push(`Cập nhật giọng điệu phản hồi sang ${TONE_LABELS_VI[patch.tone]} (giữ nguyên hướng dẫn hiện có)`);
          hlEn.push(`Update AI tone to ${patch.tone} while preserving existing instructions`);
        }
        if (patch.allowGuest !== undefined) {
          hlVi.push(nextAllowGuest ? 'Bật cho phép khách vãng lai chat' : 'Tắt phiên chat khách vãng lai');
          hlEn.push(nextAllowGuest ? 'Enable guest chat sessions' : 'Disable guest chat sessions');
        }
        if (patch.systemPromptAppend !== undefined) {
          hlVi.push('Bổ sung hướng dẫn mới vào cuối System Prompt hiện tại');
          hlEn.push('Append new instruction to existing System Prompt');
        } else if (patch.systemPrompt !== undefined) {
          hlVi.push('Cập nhật nội dung System Prompt theo yêu cầu');
          hlEn.push('Update System Prompt content as requested');
        }
        if (hlVi.length === 0) {
          hlVi.push(`Cập nhật cấu hình Tenant AI (giữ nguyên các trường hiện có của "${nextName}")`);
          hlEn.push(`Update Tenant AI configuration (preserving existing fields on "${nextName}")`);
        }
        hlVi.push('Giữ nguyên toàn bộ các trường Tenant AI còn lại không thay đổi');
        hlEn.push('Preserve all untouched Tenant AI settings from live store');

        changeBulletsVi.push(hlVi[0]!);
        changeBulletsEn.push(hlEn[0]!);

        return {
          ...baseStep,
          canApply: true,
          enabledByDefault: true,
          summaryVi: `Cập nhật chọn lọc Tenant AI · model: ${modelRes.model} · khách vãng lai: ${nextAllowGuest ? 'BẬT' : 'TẮT'}`,
          summaryEn: `Surgical Tenant AI update · model: ${modelRes.model} · guest chat: ${nextAllowGuest ? 'ON' : 'OFF'}`,
          highlightsVi: hlVi,
          highlightsEn: hlEn,
          payload: payload as unknown as Record<string, unknown>,
        };
      }

      case 'knowledge_masking': {
        const patch = analysis.patches.knowledge_masking ?? {};
        const tid = String(existingTenant.id);
        const liveMasking = getSupportMaskingPolicy(tid);
        const liveDocs = listSupportKnowledgeDocs(tid);

        const docs: SupportSetupKnowledgeDocSeed[] = [];
        if (patch.faqDocContent?.trim()) {
          const targetTitle =
            patch.faqDocTitle?.trim() ||
            (locale === 'vi'
              ? `${existingTenant.name} - Chính sách & FAQ cập nhật`
              : `${existingTenant.name} - Updated Policy & FAQ`);
          const matchingExisting = liveDocs.find(
            (d) => d.title.trim().toLowerCase() === targetTitle.trim().toLowerCase(),
          );
          const mergedContent = matchingExisting
            ? `${matchingExisting.content.trim()}\n\n${patch.faqDocContent.trim()}`
            : patch.faqDocContent.trim();
          docs.push({
            title: targetTitle,
            category: matchingExisting?.category || 'policy',
            content: mergedContent,
            tags: matchingExisting?.tags?.length ? [...matchingExisting.tags] : ['policy', 'faq'],
            allowedRoles: matchingExisting?.allowedRoles?.length
              ? mergeUniqueStrings(matchingExisting.allowedRoles, ['guest', 'customer'])
              : ['guest', 'customer', 'staff', 'admin'],
          });
        }

        const nextMaskingEnabled = patch.maskingEnabled ?? liveMasking.enabled;
        const payload: SupportSetupKnowledgeMaskingPayload = {
          docs,
          masking: {
            enabled: nextMaskingEnabled,
            builtinDetectors:
              liveMasking.builtinDetectors.length > 0
                ? [...liveMasking.builtinDetectors]
                : ['email', 'phone', 'credit_card', 'api_key'],
            unmaskedRoles: [...liveMasking.unmaskedRoles],
          },
        };

        const hlVi: string[] = [];
        const hlEn: string[] = [];
        if (docs.length > 0) {
          hlVi.push(`Cập nhật tài liệu "${docs[0]!.title}" (giữ nguyên ${liveDocs.length} tài liệu hiện có)`);
          hlEn.push(`Upsert "${docs[0]!.title}" while keeping all ${liveDocs.length} existing KB doc(s)`);
        }
        if (patch.maskingEnabled !== undefined) {
          hlVi.push(
            nextMaskingEnabled
              ? 'Bật tự động che PII (giữ nguyên danh sách bộ dò & vai trò hiện tại)'
              : 'Tắt tự động che PII (giữ nguyên toàn bộ tài liệu tri thức hiện tại)',
          );
          hlEn.push(
            nextMaskingEnabled
              ? 'Enable PII masking while preserving existing detectors & unmasked roles'
              : 'Disable PII masking without touching existing knowledge articles',
          );
        }
        if (hlVi.length === 0) {
          hlVi.push('Cập nhật chọn lọc Kho tri thức & Che PII');
          hlEn.push('Surgical Knowledge Base & PII Masking update');
        }

        changeBulletsVi.push(hlVi[0]!);
        changeBulletsEn.push(hlEn[0]!);

        return {
          ...baseStep,
          canApply: true,
          enabledByDefault: true,
          summaryVi: `Cập nhật chọn lọc KB & PII · ${docs.length > 0 ? `+${docs.length} mục FAQ` : 'giữ nguyên KB'} · che PII: ${nextMaskingEnabled ? 'BẬT' : 'TẮT'}`,
          summaryEn: `Surgical KB & Masking update · ${docs.length > 0 ? `+${docs.length} FAQ doc` : 'existing KB untouched'} · PII masking: ${nextMaskingEnabled ? 'ON' : 'OFF'}`,
          highlightsVi: hlVi,
          highlightsEn: hlEn,
          payload: payload as unknown as Record<string, unknown>,
        };
      }

      case 'guardrails_quotas': {
        const patch = analysis.patches.guardrails_quotas ?? {};
        const liveGuard = getSupportGuardrailPolicy(String(existingTenant.id));

        const nextTopics = mergeUniqueStrings(
          liveGuard.blockedTopics,
          patch.addBlockedTopics ?? [],
        );
        const nextCompetitors = mergeUniqueStrings(
          liveGuard.competitorKeywords,
          patch.addCompetitorKeywords ?? [],
        );
        const nextBlockInjection = patch.blockPromptInjection ?? liveGuard.blockPromptInjection;
        const nextEnabled =
          patch.guardrailsEnabled ??
          (patch.addBlockedTopics?.length ||
          patch.addCompetitorKeywords?.length ||
          patch.blockPromptInjection === true
            ? true
            : liveGuard.enabled);

        const clonedQuotas: SupportSetupGuardrailsPayload['roleQuotas'] = {};
        for (const [role, rule] of Object.entries(liveGuard.roleQuotas)) {
          clonedQuotas[role] = { ...rule };
        }

        const payload: SupportSetupGuardrailsPayload = {
          enabled: nextEnabled,
          blockPromptInjection: nextBlockInjection,
          injectionDetectors: [...liveGuard.injectionDetectors],
          blockedTopics: nextTopics,
          competitorKeywords: nextCompetitors,
          maxInputLength: liveGuard.maxInputLength,
          bypassRoles: [...liveGuard.bypassRoles],
          roleQuotas: clonedQuotas,
        };

        const hlVi: string[] = [];
        const hlEn: string[] = [];
        if (patch.addCompetitorKeywords?.length) {
          hlVi.push(
            `Chặn thêm từ khóa đối thủ: ${patch.addCompetitorKeywords.join(', ')} (tổng ${nextCompetitors.length} đối thủ)`,
          );
          hlEn.push(
            `Block competitor keyword(s): ${patch.addCompetitorKeywords.join(', ')} (${nextCompetitors.length} total)`,
          );
        }
        if (patch.addBlockedTopics?.length) {
          hlVi.push(
            `Chặn thêm chủ đề: ${patch.addBlockedTopics.join(', ')} (tổng ${nextTopics.length} chủ đề cấm)`,
          );
          hlEn.push(
            `Add blocked topic(s): ${patch.addBlockedTopics.join(', ')} (${nextTopics.length} total)`,
          );
        }
        if (patch.blockPromptInjection !== undefined) {
          hlVi.push(
            nextBlockInjection ? 'Bật chống tấn công Prompt Injection' : 'Tắt chặn Prompt Injection',
          );
          hlEn.push(
            nextBlockInjection ? 'Enable prompt-injection shield' : 'Disable prompt-injection blocking',
          );
        }
        if (patch.guardrailsEnabled !== undefined) {
          hlVi.push(nextEnabled ? 'Bật tường lửa Guardrails' : 'Tắt tường lửa Guardrails');
          hlEn.push(nextEnabled ? 'Enable Guardrails firewall' : 'Disable Guardrails firewall');
        }
        if (hlVi.length === 0) {
          hlVi.push('Cập nhật chọn lọc Tường lửa Guardrails');
          hlEn.push('Surgical Guardrails update');
        }
        hlVi.push('Giữ nguyên hạn mức quota theo vai trò và các quy tắc hiện có');
        hlEn.push('Preserve existing per-role quotas, detectors, and prior rules');

        changeBulletsVi.push(hlVi[0]!);
        changeBulletsEn.push(hlEn[0]!);

        return {
          ...baseStep,
          canApply: true,
          enabledByDefault: true,
          summaryVi: `Cập nhật chọn lọc Guardrails · ${nextTopics.length} chủ đề cấm · ${nextCompetitors.length} từ khóa đối thủ`,
          summaryEn: `Surgical Guardrails update · ${nextTopics.length} blocked topic(s) · ${nextCompetitors.length} competitor keyword(s)`,
          highlightsVi: hlVi,
          highlightsEn: hlEn,
          payload: payload as unknown as Record<string, unknown>,
        };
      }

      case 'output_controls': {
        const patch = analysis.patches.output_controls ?? {};
        const liveOut = getSupportOutputPolicy(existingTenant.id);

        const nextMode = mapOutputModeToPolicyMode(
          patch.outputMode,
          liveOut.mode,
          patch.redactCredentials,
        );
        const nextRedact =
          patch.redactCredentials ??
          (patch.outputMode === 'redact' ? true : liveOut.redactCredentials);
        const nextMaxChars =
          patch.maxOutputChars !== undefined
            ? clampInt(
                patch.maxOutputChars,
                SUPPORT_OUTPUT_LIMITS.maxOutputCharsMin,
                SUPPORT_OUTPUT_LIMITS.maxOutputCharsMax,
              )
            : liveOut.maxOutputChars;
        const preservedTerms: SupportOutputRule[] = liveOut.blockedTerms.map((r) => ({
          id: r.id,
          text: r.text,
        }));

        const payload: SupportSetupOutputControlsPayload = {
          mode: nextMode,
          blockedTerms: preservedTerms,
          maxOutputChars: nextMaxChars,
          redactCredentials: nextRedact,
        };

        const hlVi: string[] = [];
        const hlEn: string[] = [];
        if (patch.outputMode !== undefined) {
          hlVi.push(`Chuyển chế độ kiểm soát đầu ra sang "${patch.outputMode}" (policy mode: ${nextMode})`);
          hlEn.push(`Set output control behavior to "${patch.outputMode}" (policy mode: ${nextMode})`);
        }
        if (patch.redactCredentials !== undefined) {
          hlVi.push(
            nextRedact
              ? 'Bật tự động che khóa bí mật ở đầu ra'
              : 'Tắt tự động che khóa bí mật ở đầu ra',
          );
          hlEn.push(
            nextRedact
              ? 'Enable outbound credential redaction'
              : 'Disable outbound credential redaction',
          );
        }
        if (patch.maxOutputChars !== undefined) {
          hlVi.push(`Đặt giới hạn độ dài phản hồi tối đa ${nextMaxChars} ký tự`);
          hlEn.push(`Set maxOutputChars ceiling to ${nextMaxChars} characters`);
        }
        if (hlVi.length === 0) {
          hlVi.push('Cập nhật chọn lọc Kiểm soát đầu ra');
          hlEn.push('Surgical Output Controls update');
        }
        hlVi.push(`Giữ nguyên ${preservedTerms.length} từ cấm đầu ra hiện có`);
        hlEn.push(`Preserve all ${preservedTerms.length} existing blocked output rule(s)`);

        changeBulletsVi.push(hlVi[0]!);
        changeBulletsEn.push(hlEn[0]!);

        return {
          ...baseStep,
          canApply: true,
          enabledByDefault: true,
          summaryVi: `Cập nhật chọn lọc Đầu ra · mode: ${nextMode} · redactCredentials: ${nextRedact ? 'BẬT' : 'TẮT'} · max: ${nextMaxChars}`,
          summaryEn: `Surgical Output Controls · mode: ${nextMode} · redactCredentials: ${nextRedact ? 'ON' : 'OFF'} · max: ${nextMaxChars}`,
          highlightsVi: hlVi,
          highlightsEn: hlEn,
          payload: payload as unknown as Record<string, unknown>,
        };
      }

      case 'widget_appearance': {
        const patch = analysis.patches.widget_appearance ?? {};
        const liveWidget = getSupportDeskWidgetConfig(existingTenant.id);
        const isFreshDefaultWidget = liveWidget.updatedAt === '1970-01-01T00:00:00.000Z';

        const nextEnabled =
          patch.widgetEnabled !== undefined
            ? patch.widgetEnabled
            : patch.requireContactIntake === true
              ? true
              : isFreshDefaultWidget
                ? true
                : liveWidget.enabled;

        const nextPrimaryColor = patch.primaryColor
          ? expandShortHex(patch.primaryColor)
          : liveWidget.appearance.primaryColor;
        const nextSecondaryColor = patch.primaryColor
          ? darkenHex(nextPrimaryColor)
          : (liveWidget.appearance.secondaryColor ?? darkenHex(nextPrimaryColor));
        const nextPosition: SupportDeskWidgetPosition =
          patch.position === 'left'
            ? 'bottom-left'
            : patch.position === 'right'
              ? 'bottom-right'
              : liveWidget.appearance.position;
        const nextTitle = patch.widgetTitle
          ? sanitizeSurgicalWidgetText(
              patch.widgetTitle,
              SUPPORT_DESK_LIMITS.maxLabelChars,
              liveWidget.appearance.title,
            )
          : liveWidget.appearance.title;
        const nextWelcomeMessage =
          patch.widgetGreeting !== undefined
            ? sanitizeSurgicalWidgetText(
                patch.widgetGreeting,
                SUPPORT_DESK_LIMITS.maxTextChars,
                liveWidget.appearance.welcomeMessage,
              )
            : liveWidget.appearance.welcomeMessage;

        const clonedFields: SupportDeskIntakeField[] = liveWidget.intake.fields.map((f) => ({
          ...f,
          ...(f.options ? { options: [...f.options] } : {}),
        }));

        let nextIntakeRequired = liveWidget.intake.required;
        let nextIntakeFields = clonedFields;

        if (patch.requireContactIntake === true) {
          nextIntakeRequired = nextEnabled;
          if (nextIntakeFields.length === 0) {
            nextIntakeFields = [
              {
                key: 'customer_name',
                label: locale === 'vi' ? 'Họ và tên' : 'Full Name',
                type: 'text',
                required: true,
              },
              {
                key: 'customer_email',
                label: 'Email',
                type: 'email',
                required: true,
              },
            ];
          } else if (!nextIntakeFields.some((f) => f.required)) {
            nextIntakeFields = nextIntakeFields.map((f, idx) =>
              idx === 0 ? { ...f, required: true } : f,
            );
          }
        } else if (patch.requireContactIntake === false) {
          nextIntakeRequired = false;
        } else if (!nextEnabled && nextIntakeRequired) {
          // Enforce SupportDeskWidgetConfig invariant: intake.required=true requires enabled=true
          nextIntakeRequired = false;
        }

        const payload: SupportSetupWidgetPayload = {
          enabled: nextEnabled,
          appearance: {
            ...liveWidget.appearance,
            primaryColor: nextPrimaryColor,
            secondaryColor: nextSecondaryColor,
            title: nextTitle,
            welcomeMessage: nextWelcomeMessage,
            position: nextPosition,
            quickPrompts: [...liveWidget.appearance.quickPrompts],
          },
          intake: {
            required: nextIntakeRequired,
            fields: nextIntakeFields,
          },
        };

        const hlVi: string[] = [];
        const hlEn: string[] = [];
        if (patch.primaryColor !== undefined) {
          hlVi.push(`Đổi màu chủ đạo Widget sang ${nextPrimaryColor}`);
          hlEn.push(`Change widget primary color to ${nextPrimaryColor}`);
        }
        if (patch.position !== undefined) {
          hlVi.push(
            `Chuyển vị trí nút chat sang ${nextPosition === 'bottom-left' ? 'góc trái (bottom-left)' : 'góc phải (bottom-right)'}`,
          );
          hlEn.push(`Move widget launcher position to ${nextPosition}`);
        }
        if (patch.widgetEnabled !== undefined) {
          hlVi.push(nextEnabled ? 'Bật hiển thị Widget trên web' : 'Tắt hiển thị Widget trên web');
          hlEn.push(nextEnabled ? 'Enable embeddable customer widget' : 'Disable embeddable customer widget');
        }
        if (patch.requireContactIntake !== undefined) {
          hlVi.push(
            nextIntakeRequired
              ? 'Bật thu thập thông tin liên hệ (Email/Tên) trước khi chat'
              : 'Tắt form thu thập thông tin trước khi chat',
          );
          hlEn.push(
            nextIntakeRequired
              ? 'Enable pre-chat contact intake before starting chat'
              : 'Disable pre-chat contact intake form',
          );
        }
        if (patch.widgetTitle !== undefined) {
          hlVi.push(`Đổi tiêu đề Widget thành "${nextTitle}"`);
          hlEn.push(`Update widget title to "${nextTitle}"`);
        }
        if (patch.widgetGreeting !== undefined) {
          hlVi.push(`Cập nhật lời chào mở đầu thành "${nextWelcomeMessage}"`);
          hlEn.push(`Update widget greeting message to "${nextWelcomeMessage}"`);
        }
        if (hlVi.length === 0) {
          hlVi.push('Cập nhật chọn lọc Giao diện Widget');
          hlEn.push('Surgical Widget Appearance update');
        }
        hlVi.push(
          `Giữ nguyên tiêu đề "${nextTitle}", vị trí ${nextPosition} và các tùy chỉnh Widget hiện có khác`,
        );
        hlEn.push(
          `Preserve existing widget title "${nextTitle}", position (${nextPosition}), greeting, and quick prompts`,
        );

        changeBulletsVi.push(hlVi[0]!);
        changeBulletsEn.push(hlEn[0]!);

        return {
          ...baseStep,
          canApply: true,
          enabledByDefault: true,
          summaryVi: `Cập nhật chọn lọc Widget · màu ${nextPrimaryColor} · vị trí ${nextPosition} · intake ${nextIntakeRequired ? 'bắt buộc' : 'tùy chọn'}`,
          summaryEn: `Surgical Widget update · color ${nextPrimaryColor} · ${nextPosition} · intake ${nextIntakeRequired ? 'required' : 'optional'}`,
          highlightsVi: hlVi,
          highlightsEn: hlEn,
          payload: payload as unknown as Record<string, unknown>,
        };
      }

      case 'sla_routing': {
        const patch = analysis.patches.sla_routing ?? {};
        const liveSla = getSupportDeskSlaPolicy(existingTenant.id);
        const isFreshDefaultSla = liveSla.updatedAt === '1970-01-01T00:00:00.000Z';

        const nextUrgentFirst =
          patch.urgentFirstResponseMinutes !== undefined
            ? clampInt(patch.urgentFirstResponseMinutes, 1, SUPPORT_DESK_LIMITS.maxSlaMinutes)
            : liveSla.targets.urgent.firstResponseMinutes;
        const nextUrgentRes = clampInt(
          Math.max(liveSla.targets.urgent.resolutionMinutes, nextUrgentFirst),
          1,
          SUPPORT_DESK_LIMITS.maxSlaMinutes,
        );
        const nextEnabled =
          patch.slaEnabled !== undefined
            ? patch.slaEnabled
            : patch.urgentFirstResponseMinutes !== undefined && isFreshDefaultSla
              ? true
              : liveSla.enabled;

        const payload: SupportSetupSlaRoutingPayload = {
          enabled: nextEnabled,
          targets: {
            urgent: {
              firstResponseMinutes: nextUrgentFirst,
              resolutionMinutes: nextUrgentRes,
            },
            high: { ...liveSla.targets.high },
            medium: { ...liveSla.targets.medium },
            low: { ...liveSla.targets.low },
          },
          routingRules: liveSla.routingRules.map((r) => ({
            id: r.id,
            department: r.department,
            keywords: [...r.keywords],
          })),
        };

        const hlVi: string[] = [];
        const hlEn: string[] = [];
        if (patch.urgentFirstResponseMinutes !== undefined) {
          hlVi.push(`Đặt mục tiêu SLA phản hồi đầu tiên (khẩn cấp) thành ${nextUrgentFirst} phút`);
          hlEn.push(`Set urgent SLA first-response target to ${nextUrgentFirst} minute(s)`);
        }
        if (patch.slaEnabled !== undefined) {
          hlVi.push(nextEnabled ? 'Bật theo dõi SLA Service Desk' : 'Tắt theo dõi SLA Service Desk');
          hlEn.push(nextEnabled ? 'Enable Service Desk SLA tracking' : 'Disable Service Desk SLA tracking');
        }
        if (hlVi.length === 0) {
          hlVi.push('Cập nhật chọn lọc SLA & Phân luồng');
          hlEn.push('Surgical SLA & Routing update');
        }
        hlVi.push(`Giữ nguyên ${payload.routingRules.length} quy tắc phân luồng bộ phận hiện có`);
        hlEn.push(`Preserve all ${payload.routingRules.length} existing department routing rule(s)`);

        changeBulletsVi.push(hlVi[0]!);
        changeBulletsEn.push(hlEn[0]!);

        return {
          ...baseStep,
          canApply: true,
          enabledByDefault: true,
          summaryVi: `Cập nhật chọn lọc SLA · ${nextEnabled ? 'BẬT' : 'TẮT'} · phản hồi khẩn: ${nextUrgentFirst} phút · giữ ${payload.routingRules.length} rule phân luồng`,
          summaryEn: `Surgical SLA update · ${nextEnabled ? 'ON' : 'OFF'} · urgent response: ${nextUrgentFirst}m · ${payload.routingRules.length} routing rule(s) kept`,
          highlightsVi: hlVi,
          highlightsEn: hlEn,
          payload: payload as unknown as Record<string, unknown>,
        };
      }

      case 'runtime_policy': {
        const patch = analysis.patches.runtime_policy ?? {};
        const liveRuntime = getSupportRuntimePolicy(existingTenant.id);
        const existingOrigins =
          existingTenant.allowedOrigins && existingTenant.allowedOrigins.length > 0
            ? [...existingTenant.allowedOrigins]
            : ['*'];

        let nextOrigins: string[];
        if (patch.replaceAllowedOrigins && patch.replaceAllowedOrigins.length > 0) {
          nextOrigins = mergeUniqueStrings([], patch.replaceAllowedOrigins, 50);
        } else if (patch.addAllowedOrigins && patch.addAllowedOrigins.length > 0) {
          const concreteExisting = existingOrigins.filter((o) => o !== '*');
          nextOrigins = mergeUniqueStrings(concreteExisting, patch.addAllowedOrigins, 50);
        } else {
          nextOrigins = existingOrigins;
        }
        if (nextOrigins.length === 0) {
          nextOrigins = ['*'];
        }

        const nextMaxTokens =
          patch.maxCompletionTokens !== undefined
            ? clampInt(
                patch.maxCompletionTokens,
                RUNTIME_POLICY_BOUNDS.maxCompletionTokens.min,
                RUNTIME_POLICY_BOUNDS.maxCompletionTokens.max,
              )
            : liveRuntime.maxCompletionTokens;

        const payload: SupportSetupRuntimePayload = {
          allowedOrigins: nextOrigins,
          allowedModels: [...liveRuntime.allowedModels],
          maxCompletionTokens: nextMaxTokens,
          maxModelCalls: liveRuntime.maxModelCalls,
          maxToolCalls: liveRuntime.maxToolCalls,
          maxContextChars: liveRuntime.maxContextChars,
          maxToolResultChars: liveRuntime.maxToolResultChars,
          maxHistoryMessages: liveRuntime.maxHistoryMessages,
        };

        const hlVi: string[] = [];
        const hlEn: string[] = [];
        if (patch.addAllowedOrigins?.length) {
          hlVi.push(
            `Thêm domain CORS: ${patch.addAllowedOrigins.join(', ')} (danh sách hợp lệ: ${nextOrigins.join(', ')})`,
          );
          hlEn.push(
            `Add CORS origin(s): ${patch.addAllowedOrigins.join(', ')} (active origins: ${nextOrigins.join(', ')})`,
          );
        } else if (patch.replaceAllowedOrigins?.length) {
          hlVi.push(`Cập nhật danh sách CORS thành: ${nextOrigins.join(', ')}`);
          hlEn.push(`Replace CORS allowed origins with: ${nextOrigins.join(', ')}`);
        }
        if (patch.maxCompletionTokens !== undefined) {
          hlVi.push(`Đặt giới hạn maxCompletionTokens thành ${nextMaxTokens}`);
          hlEn.push(`Set maxCompletionTokens limit to ${nextMaxTokens}`);
        }
        if (hlVi.length === 0) {
          hlVi.push('Cập nhật chọn lọc CORS & Giới hạn Runtime');
          hlEn.push('Surgical CORS & Runtime Limits update');
        }
        hlVi.push(
          `Giữ nguyên giới hạn runtime hiện có (maxModelCalls=${liveRuntime.maxModelCalls}, maxToolCalls=${liveRuntime.maxToolCalls}, maxContextChars=${liveRuntime.maxContextChars})`,
        );
        hlEn.push(
          `Preserve existing runtime bounds (maxModelCalls=${liveRuntime.maxModelCalls}, maxToolCalls=${liveRuntime.maxToolCalls}, maxContextChars=${liveRuntime.maxContextChars})`,
        );

        changeBulletsVi.push(hlVi[0]!);
        changeBulletsEn.push(hlEn[0]!);

        return {
          ...baseStep,
          canApply: true,
          enabledByDefault: true,
          summaryVi: `Cập nhật chọn lọc Runtime & CORS · origins: ${nextOrigins.join(', ')} · maxCompletionTokens: ${nextMaxTokens}`,
          summaryEn: `Surgical Runtime & CORS update · origins: ${nextOrigins.join(', ')} · maxCompletionTokens: ${nextMaxTokens}`,
          highlightsVi: hlVi,
          highlightsEn: hlEn,
          payload: payload as unknown as Record<string, unknown>,
        };
      }
    }
  });

  const untouchedCount = SUPPORT_SETUP_STEP_IDS.length - permittedSteps.length;
  const targetedLabelsVi = permittedSteps.map((s) => STEP_LABELS[s].vi).join(', ');
  const targetedLabelsEn = permittedSteps.map((s) => STEP_LABELS[s].en).join(', ');

  const summaryVi = `Cập nhật chọn lọc ${permittedSteps.length}/7 bước (${targetedLabelsVi}) cho "${existingTenant.name}" — giữ nguyên toàn bộ cấu hình còn lại.`;
  const summaryEn = `Surgical update for ${permittedSteps.length}/7 step(s) (${targetedLabelsEn}) on "${existingTenant.name}" — all other settings preserved.`;

  const partialDeniedNoteVi =
    deniedSteps.length > 0
      ? ` Lưu ý: phần ${deniedSteps.map((s) => `**${STEP_LABELS[s].vi}**`).join(', ')} chưa được tích chọn vì tài khoản cần thêm quyền ${requiredPermissions.map((p) => `\`${p}\``).join(', ')}.`
      : '';
  const partialDeniedNoteEn =
    deniedSteps.length > 0
      ? ` Note: ${deniedSteps.map((s) => `**${STEP_LABELS[s].en}**`).join(', ')} was omitted because your account requires ${requiredPermissions.map((p) => `\`${p}\``).join(', ')}.`
      : '';

  const replyVi =
    `Mình đã chuẩn bị bản cập nhật chọn lọc đúng phần bạn yêu cầu cho tenant **${existingTenant.name}**: ${changeBulletsVi.join('; ')}. ` +
    `Chỉ riêng ${permittedSteps.length === 1 ? `bước **${targetedLabelsVi}**` : `${permittedSteps.length} bước (**${targetedLabelsVi}**)`} được tích chọn mặc định; ${untouchedCount} bước còn lại cùng toàn bộ các thiết lập hiện có của bạn đều được giữ nguyên 100%.${partialDeniedNoteVi} ` +
    `Chưa có thay đổi nào được ghi vào hệ thống cho tới khi bạn kiểm tra và bấm **Đồng ý triển khai (Approve)** bên dưới nhé!`;

  const replyEn =
    `I've prepared a surgical update specifically for tenant **${existingTenant.name}**: ${changeBulletsEn.join('; ')}. ` +
    `Only ${permittedSteps.length === 1 ? `**${targetedLabelsEn}**` : `${permittedSteps.length} steps (**${targetedLabelsEn}**)`} ${permittedSteps.length === 1 ? 'is' : 'are'} checked by default — the remaining ${untouchedCount} step(s) and all your other existing settings stay 100% untouched.${partialDeniedNoteEn} ` +
    `Nothing has been changed on the live tenant yet until you review and click **Approve** below!`;

  return {
    outcome: 'scoped',
    targetedSteps: permittedSteps,
    deniedSteps,
    requiredPermissions,
    steps: mergedSteps,
    replyVi,
    replyEn,
    reply: locale === 'vi' ? replyVi : replyEn,
    summaryVi,
    summaryEn,
    summary: locale === 'vi' ? summaryVi : summaryEn,
  };
}
