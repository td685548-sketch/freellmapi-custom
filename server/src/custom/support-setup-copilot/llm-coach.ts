import {
  SUPPORT_SETUP_STEP_IDS,
  type SupportSetupChatIntent,
  type SupportSetupChatMessage,
  type SupportSetupLanguage,
  type SupportSetupRequirements,
  type SupportSetupStepId,
  type SupportSetupTenantDiagnostic,
  type SupportSetupTone,
  type SupportSystemSettingId,
} from '@freellmapi/shared/support-setup-copilot.js';
import { getDb, getInternalLoopbackToken } from '../../db/index.js';
import { decrypt } from '../../lib/crypto.js';
import type { SessionUser } from '../../services/auth.js';
import { getRecordedServerAddress } from '../ai-platform/orchestrator/engine.js';
import { PLAYGROUND_SESSION_HEADER } from '../playground-attribution.js';
import { resolveAccountProvider } from '../provider-accounts/execution.js';
import { resolveXGatewayAccountProxy } from '../provider-accounts/store.js';
import { withQuotaTracking } from '../x-gateway/quota/tracking.js';
import {
  recordCandidateFailure,
  recordCandidateSuccess,
} from '../x-gateway/route-cooldown.js';
import {
  recordRouteOutcome,
  resolveCandidateRoutes,
  type CandidateRoute,
} from '../x-gateway/router.js';
import {
  ensureVerifiedCloudRuntimePack,
  requireVerifiedCloudRuntimePack,
} from '../cloud-entitlement/service.js';
import { buildPlatformPromptSection } from './platform-guide.js';
import { buildKbQueryFromMessages, formatKbForPrompt, searchKb } from './kb/index.js';
import {
  buildAccountOnlyIdentityBlock,
  buildIdentityPromptBlock,
  type CopilotAgentContext,
} from './identity.js';
import {
  buildSystemSettingsPromptSection,
  hasAnySystemSettingPermission,
  isSupportSystemSettingId,
} from './system-settings.js';

export interface GatewayLoopbackContext {
  host: string;
  port: number;
  sessionToken?: string;
  /**
   * Force attempting HTTP loopback even when main DB key tables are empty
   * (e.g. standalone local mock server in tests).
   */
  forceLoopback?: boolean;
}

export interface LlmCoachSystemActionSuggestion {
  settingId: SupportSystemSettingId;
  payload?: Record<string, unknown>;
}

export interface LlmCoachToolCall {
  id: string;
  input: Record<string, unknown>;
}

export interface LlmCoachOutput {
  intent?: SupportSetupChatIntent;
  reply: string;
  missingQuestions?: string[];
  suggestedQuickReplies?: string[];
  extractedRequirements?: Partial<SupportSetupRequirements>;
  targetSteps?: SupportSetupStepId[];
  systemActions?: LlmCoachSystemActionSuggestion[];
  /** Tool calls the model wants the agent loop to execute (Phase 2). Never applied directly — gated + proposal-only. */
  toolCalls?: LlmCoachToolCall[];
}

/** Filtered tool schemas offered to the LLM (Phase 2: only step-admitted tools). */
export interface LlmCoachToolSchema {
  id: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LlmCoachTurnInput {
  user?: SessionUser;
  messages: SupportSetupChatMessage[];
  locale: 'vi' | 'en';
  targetMode: 'create_tenant' | 'update_tenant';
  currentPath?: string;
  diagnostic: SupportSetupTenantDiagnostic | null;
  extracted: SupportSetupRequirements;
  canCreateTenant?: boolean;
  canEditSteps?: ReadonlySet<SupportSetupStepId>;
  gatewayLoopback?: GatewayLoopbackContext;
  /** DB-grounded caller identity (Phase 0). When present, its trusted block is injected into the system prompt. */
  agentContext?: CopilotAgentContext;
  /** Filtered tool schemas for the agent loop (Phase 2). Only admitted tools are listed; absent = no tools offered. */
  toolSchemas?: ReadonlyArray<LlmCoachToolSchema>;
  /** Optional fetch override for unit/integration tests. */
  fetchImpl?: typeof fetch;
  /** Optional per-request timeout in ms (defaults to 15_000). */
  timeoutMs?: number;
}

export interface LlmCoachTurnResult {
  output: LlmCoachOutput;
  modelUsed: string;
  routeSource: 'thruline_account' | 'main_gateway_loopback';
}

const VALID_INTENTS = new Set<SupportSetupChatIntent>([
  'guide',
  'gather_requirements',
  'propose_setup',
]);
const VALID_LANGUAGES = new Set<SupportSetupLanguage>(['vi', 'en', 'bilingual']);
const VALID_TONES = new Set<SupportSetupTone>([
  'friendly',
  'professional',
  'empathetic',
  'technical',
]);

const VI_DIACRITIC_RE =
  /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;

const VI_UNACCENTED_CONVERSATIONAL_RE =
  /\b(?:xin\s+chao|chao\s+ban|minh|toi\s+(?:dang|muon|can|co|chua|khong)|minh\s+(?:dang|muon|can|co|chua|khong|moi)|ben\s+(?:minh|toi|em)|va\s+muon|(?:muon|can)\s+(?:setup|thiet\s+lap|cai\s+dat|tu\s+van|lam)|ban\s+(?:co\s+the|lam\s+duoc|biết|biet|oi)|co\s+the\s+(?:lam|noi|giup)|lam\s+gi\s+ma|la\s+(?:cai\s+)?gi|lam\s+gi|de\s+lam\s+gi|dung\s+de|dung\s+sao|dung\s+the\s+nao|day\s+la\s+(?:trang|web|website|he\s+thong|ung\s+dung|nen\s+tang|muc|man\s+hinh|cho|tab|cong\s+cu)|hoat\s+dong\s+(?:sao|ra\s+sao|kieu\s+gi|the\s+nao|nhu\s+the\s+nao)|ra\s+sao|kieu\s+gi|cho\s+nay|web\s+nay|trang\s+(?:web\s+)?nay|he\s+thong\s+nay|ung\s+dung\s+nay|nen\s+tang\s+nay|muc\s+nay|man\s+hinh\s+nay|gioi\s+thieu|ket\s+noi|cau\s+hinh|khac\s+nhau|khac\s+gi|tieng\s+viet|giup\s+(?:toi|minh|ban)|cho\s+(?:toi|minh|ban)|cua\s+(?:toi|minh|ban)|lam\s+sao|nhu\s+the\s+nao|thiet\s+lap|cai\s+dat|huong\s+dan|duoc\s+khong|tuy\s+ban|lam\s+luon|mac\s+dinh|chua\s+co|khong\s+co|sao\s+(?:tra\s+loi|cung\s+nhac|hoi)|cam\s+on|nhe|nha|luon\s+di|ke\s+hoach)\b/i;

const TOOL_MARKUP_RE =
  /<support_tool_call[\s\S]*?<\/support_tool_call>|<support_tool_result[\s\S]*?<\/support_tool_result>|<\/?support_tool_(?:call|result)[^>]*>/gi;

const PLACEHOLDER_VALUE_RE =
  /^(?:\.{2,}|…+|null|undefined|none|n\/a|na|unknown|tbd|todo|string|boolean|chưa\s*(?:rõ|có|biết)|không\s*rõ|<[^>]+>|\?+)$/i;

const FALSE_ALREADY_APPLIED_RE =
  /(?:mình\s+|tôi\s+|hệ\s+thống\s+)?đã\s+(?:lưu|áp\s+dụng|triển\s+khai|cập\s+nhật|kích\s+hoạt)\s+(?:xong|thành\s+công)\s+(?:toàn\s+bộ\s+|các\s+)?(?:cấu\s+hình|thiết\s+lập|7\s+bước|tenant)|\b(?:i\s+have|we\s+have|system\s+has)\s+already\s+(?:applied|deployed|saved|activated)\s+(?:all\s+|the\s+|your\s+)?(?:configuration|settings|7\s+steps|tenant)\b/i;

const CONSENT_NEGATION_GUARD_RE =
  /chưa\s+(?:tự\s+ý|thay\s+đổi|áp\s+dụng|lưu|triển\s+khai)|chờ\s+(?:bạn\s+)?(?:xác\s+nhận|duyệt|bấm)|khi\s+bạn\s+(?:bấm\s+)?(?:đồng\s+ý|duyệt)|not\s+(?:yet\s+)?(?:changed|applied|deployed|saved)|no\s+configuration\s+has\s+been\s+changed|until\s+you\s+(?:approve|confirm)|pending\s+(?:your\s+)?(?:approval|consent)/i;

function extractCompletionText(rawContent: unknown): string {
  if (typeof rawContent === 'string') return rawContent.trim();
  if (Array.isArray(rawContent)) {
    return rawContent
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part && typeof (part as { text?: unknown }).text === 'string') {
          return (part as { text: string }).text;
        }
        return '';
      })
      .join('')
      .trim();
  }
  return '';
}

function stripReasoningBlocks(raw: string): string | null {
  let text = raw.trim();
  if (!text) return null;
  // Strip closed <think>...</think> / <thinking>...</thinking> reasoning traces
  text = text.replace(/<(?:think|thinking)\b[^>]*>[\s\S]*?<\/(?:think|thinking)>/gi, '').trim();
  // If an unclosed <think> tag remains at the beginning (truncated reasoning), discard
  if (/^<(?:think|thinking)\b[^>]*>/i.test(text)) {
    return null;
  }
  return text || null;
}

/**
 * Extracts balanced `{ ... }` top-level JSON object substrings from arbitrary text,
 * ignoring braces inside quoted JSON strings.
 */
function extractBalancedJsonObjects(text: string): string[] {
  const results: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        results.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return results;
}

function cleanScalarString(val: unknown, maxLen: number): string | undefined {
  if (typeof val !== 'string') return undefined;
  const cleaned = val.replace(/\s+/g, ' ').trim();
  if (!cleaned || PLACEHOLDER_VALUE_RE.test(cleaned)) return undefined;
  return cleaned.slice(0, maxLen);
}

function cleanStringArray(val: unknown, maxItems: number, maxLen: number, stripNumberPrefix = false): string[] | undefined {
  if (!Array.isArray(val)) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of val) {
    if (typeof item !== 'string') continue;
    let cleaned = item.replace(TOOL_MARKUP_RE, ' ').replace(/\s+/g, ' ').trim();
    if (stripNumberPrefix) {
      cleaned = cleaned.replace(/^(?:\d+[.)]\s*|[-•*]\s*)/, '').trim();
    }
    if (!cleaned || PLACEHOLDER_VALUE_RE.test(cleaned)) continue;
    cleaned = cleaned.slice(0, maxLen).trim();
    const key = cleaned.toLowerCase();
    if (!cleaned || seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= maxItems) break;
  }
  return out.length > 0 ? out : undefined;
}

function sanitizeExtractedRequirements(raw: unknown): Partial<SupportSetupRequirements> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  const out: Partial<SupportSetupRequirements> = {};

  const brandName = cleanScalarString(rec.brandName, 80);
  if (brandName) out.brandName = brandName;

  const tenantSlug = cleanScalarString(rec.tenantSlug, 48);
  if (tenantSlug) out.tenantSlug = tenantSlug;

  const industry = cleanScalarString(rec.industry, 80);
  if (industry) out.industry = industry;

  const websiteOrigin = cleanScalarString(rec.websiteOrigin, 200);
  if (websiteOrigin) out.websiteOrigin = websiteOrigin;

  if (typeof rec.language === 'string' && VALID_LANGUAGES.has(rec.language.trim() as SupportSetupLanguage)) {
    out.language = rec.language.trim() as SupportSetupLanguage;
  }

  if (typeof rec.tone === 'string' && VALID_TONES.has(rec.tone.trim() as SupportSetupTone)) {
    out.tone = rec.tone.trim() as SupportSetupTone;
  }

  const primaryColor = cleanScalarString(rec.primaryColor, 40);
  if (primaryColor) out.primaryColor = primaryColor;

  const faqSummaryOrPolicies = cleanScalarString(rec.faqSummaryOrPolicies, 2000);
  if (faqSummaryOrPolicies) out.faqSummaryOrPolicies = faqSummaryOrPolicies;

  const blockedTopics = cleanStringArray(rec.blockedTopics, 20, 80);
  if (blockedTopics) out.blockedTopics = blockedTopics;

  const competitorKeywords = cleanStringArray(rec.competitorKeywords, 20, 80);
  if (competitorKeywords) out.competitorKeywords = competitorKeywords;

  if (typeof rec.requireContactIntake === 'boolean') {
    out.requireContactIntake = rec.requireContactIntake;
  }

  const defaultModel = cleanScalarString(rec.defaultModel, 120);
  if (defaultModel) out.defaultModel = defaultModel;

  return Object.keys(out).length > 0 ? out : undefined;
}

export function enforceReplySecurityInvariant(
  rawReply: string,
  locale: 'vi' | 'en' = 'vi',
): string {
  const cleaned = rawReply.replace(TOOL_MARKUP_RE, '').trim();
  if (!cleaned) return '';

  if (FALSE_ALREADY_APPLIED_RE.test(cleaned) && !CONSENT_NEGATION_GUARD_RE.test(cleaned)) {
    const note =
      locale === 'vi'
        ? '\n\n*(Lưu ý: Mình chưa tự ý ghi thay đổi nào vào hệ thống — các bước cấu hình chỉ chạy sau khi bạn xem thẻ đề xuất và bấm Đồng ý triển khai nhé.)*'
        : '\n\n*(Note: No settings have been modified yet — changes only take effect once you review the proposal card and click Approve.)*';
    return `${cleaned}${note}`;
  }
  return cleaned;
}

const VALID_STEP_ID_SET = new Set<string>(SUPPORT_SETUP_STEP_IDS);

function sanitizeTargetSteps(raw: unknown): SupportSetupStepId[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: SupportSetupStepId[] = [];
  const seen = new Set<SupportSetupStepId>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!VALID_STEP_ID_SET.has(trimmed)) continue;
    const stepId = trimmed as SupportSetupStepId;
    if (seen.has(stepId)) continue;
    seen.add(stepId);
    out.push(stepId);
  }
  return out.length > 0 ? out : undefined;
}

function sanitizeToolCalls(raw: unknown): LlmCoachToolCall[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: LlmCoachToolCall[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.id !== 'string' || !rec.id.trim()) continue;
    const id = rec.id.trim().slice(0, 120);
    if (seen.has(id)) continue;
    seen.add(id);
    const input =
      rec.input && typeof rec.input === 'object' && !Array.isArray(rec.input)
        ? (rec.input as Record<string, unknown>)
        : {};
    out.push({ id, input });
    if (out.length >= 10) break;
  }
  return out.length > 0 ? out : undefined;
}

function sanitizeSystemActions(raw: unknown): LlmCoachSystemActionSuggestion[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: LlmCoachSystemActionSuggestion[] = [];
  const seen = new Set<SupportSystemSettingId>();
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    if (!isSupportSystemSettingId(rec.settingId)) continue;
    if (seen.has(rec.settingId)) continue;
    seen.add(rec.settingId);
    const payload =
      rec.payload && typeof rec.payload === 'object' && !Array.isArray(rec.payload)
        ? (rec.payload as Record<string, unknown>)
        : undefined;
    out.push({
      settingId: rec.settingId,
      ...(payload ? { payload } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

function tryParseJsonCandidate(candidate: string): LlmCoachOutput | null {
  const attempts = [candidate, candidate.replace(/,\s*([}\]])/g, '$1')];
  for (const jsonStr of attempts) {
    try {
      const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;

      const rawReply =
        typeof parsed.reply === 'string'
          ? parsed.reply
          : typeof parsed.message === 'string'
            ? parsed.message
            : typeof parsed.response === 'string'
              ? parsed.response
              : typeof parsed.answer === 'string'
                ? parsed.answer
                : '';

      const cleanReply = rawReply.replace(TOOL_MARKUP_RE, '').trim();
      if (!cleanReply) continue;

      const rawIntent = typeof parsed.intent === 'string' ? parsed.intent.trim() : '';
      const intent = VALID_INTENTS.has(rawIntent as SupportSetupChatIntent)
        ? (rawIntent as SupportSetupChatIntent)
        : undefined;

      const missingQuestions = cleanStringArray(parsed.missingQuestions, 4, 240, true);
      const suggestedQuickReplies = cleanStringArray(parsed.suggestedQuickReplies, 4, 120, true);
      const extractedRequirements = sanitizeExtractedRequirements(parsed.extractedRequirements);
      const targetSteps = sanitizeTargetSteps(parsed.targetSteps);
      const systemActions = sanitizeSystemActions(parsed.systemActions);
      const toolCalls = sanitizeToolCalls(parsed.toolCalls);

      return {
        ...(intent ? { intent } : {}),
        reply: cleanReply,
        ...(missingQuestions ? { missingQuestions } : {}),
        ...(suggestedQuickReplies ? { suggestedQuickReplies } : {}),
        ...(extractedRequirements ? { extractedRequirements } : {}),
        ...(targetSteps ? { targetSteps } : {}),
        ...(systemActions ? { systemActions } : {}),
        ...(toolCalls ? { toolCalls } : {}),
      };
    } catch {
      // Try next candidate
    }
  }
  return null;
}

/**
 * Resiliently parses LLM coach output across strict JSON, ```json fenced blocks,
 * `<think>...</think>` reasoning prefixes, prose-wrapped JSON, and natural prose fallbacks.
 */
export function parseLlmCoachResponse(rawText: string): LlmCoachOutput | null {
  if (typeof rawText !== 'string') return null;
  const withoutThinking = stripReasoningBlocks(rawText);
  if (!withoutThinking) return null;

  const candidates: string[] = [];

  // 1. Explicit markdown code fences ```json ... ``` (prefer last fence if multiple)
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)\s*```/gi;
  const fencedBlocks = [...withoutThinking.matchAll(fenceRegex)]
    .map((m) => m[1]?.trim() ?? '')
    .filter(Boolean);
  for (let i = fencedBlocks.length - 1; i >= 0; i -= 1) {
    candidates.push(fencedBlocks[i]!);
  }

  // 2. Unwrapped full string
  const unwrapped = withoutThinking.replace(/^```(?:json)?\s*|\s*```$/gi, '').trim();
  if (unwrapped.startsWith('{') && unwrapped.endsWith('}')) {
    candidates.push(unwrapped);
  }

  // 3. String-aware balanced JSON object blocks (prefer last complete object in output)
  const balanced = extractBalancedJsonObjects(unwrapped);
  for (let i = balanced.length - 1; i >= 0; i -= 1) {
    if (!candidates.includes(balanced[i]!)) {
      candidates.push(balanced[i]!);
    }
  }

  for (const candidate of candidates) {
    const parsed = tryParseJsonCandidate(candidate);
    if (parsed) return parsed;
  }

  // 4. Natural prose fallback: if the model wrote directly to the user in natural prose
  // (and it is not a broken/truncated JSON fragment), preserve its conversational reply!
  const proseCandidate = unwrapped.replace(TOOL_MARKUP_RE, '').trim();
  if (
    proseCandidate &&
    !proseCandidate.startsWith('{') &&
    !proseCandidate.startsWith('```') &&
    !/^"?intent"?\s*:/i.test(proseCandidate)
  ) {
    return { reply: proseCandidate };
  }

  return null;
}

function normalizeForSimilarity(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[`*_#~>•\-.,!?;:()[\]{}"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function wordShingles(normalized: string): Set<string> {
  const words = normalized.split(' ').filter(Boolean);
  if (words.length < 3) return new Set(words);
  const shingles = new Set<string>();
  for (let i = 0; i <= words.length - 2; i += 1) {
    shingles.add(`${words[i]} ${words[i + 1]}`);
  }
  return shingles;
}

/**
 * Returns true if `candidateReply` repeats or near-identically echoes any prior
 * assistant message in the conversation history.
 */
export function isRepetitiveAssistantReply(
  candidateReply: string,
  messages: readonly SupportSetupChatMessage[],
): boolean {
  const normCandidate = normalizeForSimilarity(candidateReply);
  if (!normCandidate) return true;

  const candidateShingles = wordShingles(normCandidate);

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    const normPrior = normalizeForSimilarity(msg.content);
    if (!normPrior) continue;

    if (normCandidate === normPrior) return true;

    // Catch copy-pasted boilerplate openings
    if (
      normCandidate.length >= 90 &&
      normPrior.length >= 90 &&
      normCandidate.slice(0, 80) === normPrior.slice(0, 80)
    ) {
      return true;
    }

    // Catch near-duplicate paraphrases via word-bigram Jaccard overlap
    if (normCandidate.length >= 40 && normPrior.length >= 40 && candidateShingles.size > 0) {
      const priorShingles = wordShingles(normPrior);
      if (priorShingles.size > 0) {
        let intersection = 0;
        for (const sh of candidateShingles) {
          if (priorShingles.has(sh)) intersection += 1;
        }
        const union = candidateShingles.size + priorShingles.size - intersection;
        if (union > 0 && intersection / union >= 0.8) {
          return true;
        }
      }
    }
  }

  return false;
}

export function matchesRequestedLocale(replyText: string, locale: 'vi' | 'en'): boolean {
  if (locale === 'vi') {
    return VI_DIACRITIC_RE.test(replyText) || VI_UNACCENTED_CONVERSATIONAL_RE.test(replyText);
  }
  return true;
}

/**
 * Answer-quality rules that go with retrieved knowledge. They target the
 * failure modes seen in real chats: listing symptoms without a cause, giving
 * a remedy that does not fit the user's scope, and stopping before the next step.
 */
export const KB_ANSWER_RULES = [
  'ANSWER QUALITY RULES (apply to every guide / diagnostic reply):',
  '- Answer the user\'s actual question first, in plain language. When asked "why", state the specific cause and the evidence for it — never just list error categories.',
  '- Match the remedy to the scope of the problem. A problem with a TENANT is fixed in the tenant\'s 7 setup steps or in the platform providers; a tenant has no key of its own and never takes a Personal API key. A Personal API key only authenticates one person\'s own client.',
  '- Finish the job: after a fix, say the exact next click (page path) and how to verify it worked. If you suggest creating something, also say where it is used afterwards.',
  '- Use ONLY the retrieved knowledge and the live workspace data above for product facts (pages, settings, fields, defaults). If they do not cover it, say so plainly and ask one short clarifying question instead of guessing.',
  '- Never paste raw lists of every setting; pick the few that matter to this question.',
].join('\n');

export function buildHumanCoachSystemPrompt(params: {
  user?: SessionUser;
  messages: readonly SupportSetupChatMessage[];
  locale: 'vi' | 'en';
  targetMode: 'create_tenant' | 'update_tenant';
  currentPath?: string;
  diagnostic: SupportSetupTenantDiagnostic | null;
  extracted: SupportSetupRequirements;
  canCreateTenant?: boolean;
  canEditSteps?: ReadonlySet<SupportSetupStepId>;
  /** DB-grounded caller identity (Phase 0). Falls back to an account-only block when absent. */
  agentContext?: CopilotAgentContext;
  /** Filtered tool schemas for the agent loop (Phase 2). Only admitted tools are listed; absent = no tools offered. */
  toolSchemas?: ReadonlyArray<LlmCoachToolSchema>;
  /** Pre-rendered "RETRIEVED PLATFORM KNOWLEDGE" section (RAG). Omitted = no retrieval block. */
  knowledgeSection?: string;
}): string {
  const {
    user,
    messages,
    locale,
    targetMode,
    currentPath,
    diagnostic,
    extracted,
    canCreateTenant = true,
    canEditSteps,
    agentContext,
    toolSchemas,
    knowledgeSection,
  } = params;

  const editableList = canEditSteps
    ? [...canEditSteps]
    : canCreateTenant
      ? [...SUPPORT_SETUP_STEP_IDS]
      : [];

  const priorAssistantReplies = messages
    .filter((m) => m.role === 'assistant' && m.content.trim().length > 0)
    .slice(-4)
    .map((m, idx) => `  [Prior reply #${idx + 1}]: "${m.content.replace(/\s+/g, ' ').trim().slice(0, 220)}"`);

  const priorUserTurns = messages.filter((m) => m.role === 'user').length;
  const coachPack = requireVerifiedCloudRuntimePack().supportCoachPack;
  const personaBlock = locale === 'vi' ? coachPack.personaVi : coachPack.personaEn;

  const antiRepetitionBlock =
    priorAssistantReplies.length > 0
      ? [
          'STRICT ANTI-REPETITION RULE:',
          'Below are your previous replies in this conversation. You MUST NOT repeat, copy, or closely paraphrase any of them. Use fresh openings, acknowledge what changed in the user’s latest message, and move the conversation forward:',
          ...priorAssistantReplies,
        ].join('\n')
      : 'STRICT ANTI-REPETITION RULE: Never use canned robotic openings; tailor your opening directly to the user’s message.';

  const diagnosticSummary = diagnostic
    ? `Active tenant: "${diagnostic.tenant.name}" (slug: "${diagnostic.tenant.slug}", readiness: ${diagnostic.completedSteps}/${diagnostic.totalSteps} steps complete). Step statuses: ${JSON.stringify(
        diagnostic.steps
          .filter((s) => s.canView !== false)
          .map((s) => ({ stepId: s.stepId, status: s.status, canEdit: s.canEdit })),
      )}`
    : 'Active tenant: none selected (new tenant creation flow).';

  const securityAndContextBlock = [
    'LIVE WORKSPACE & SECURITY INVARIANTS (MANDATORY):',
    `- Target mode: ${targetMode}. User turn count so far: ${priorUserTurns}.`,
    `- Permissions: canCreateTenant=${canCreateTenant}, editableSteps=${JSON.stringify(editableList)}.`,
    `- ${diagnosticSummary}`,
    `- Requirements already captured from conversation: ${JSON.stringify(extracted)}`,
    '- **CONSENT INVARIANT**: You NEVER apply or save configuration directly during chat. NEVER claim that changes have already been saved, applied, or deployed. When `intent` is `"propose_setup"`, introduce your draft warmly like a teammate handing over a ready-to-review plan, and let them know nothing is changed until they review the Consent Card below and click Approve.',
    editableList.length === 0 && !canCreateTenant
      ? hasAnySystemSettingPermission(user)
        ? '- **DELEGATED SYSTEM SETTINGS SCOPE**: This user has 0 editable Tenant Support steps (cannot create/edit Support Tenants), so use `intent: "guide"` for Tenant Support topics, EXCEPT they CAN propose permitted Platform/Thruline system settings listed below.'
        : '- **READ-ONLY SCOPE**: This user has read-only access (0 editable steps). Always use `intent: "guide"` and never promise to auto-deploy changes.'
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  const platformSection = buildPlatformPromptSection(currentPath, locale);
  const systemSettingsSection = buildSystemSettingsPromptSection(user, locale);

  // Phase 2: only the step-admitted tools are offered to the model. When no
  // schemas are passed the section is omitted entirely (pre-Phase-2 callers
  // and existing prompt tests are unaffected).
  const toolSection =
    toolSchemas === undefined
      ? ''
      : toolSchemas.length === 0
        ? [
            'AVAILABLE COPILOT TOOLS: none — this caller has no tool admitted in the current scope.',
            'Do not emit any toolCalls. Answer with a terminal intent (guide / gather_requirements / propose_setup) only.',
          ].join('\n')
        : [
            'AVAILABLE COPILOT TOOLS (permission-filtered — these are the ONLY tools you may call):',
            ...toolSchemas.map(
              (t) =>
                `- ${t.id}: ${t.description} Input JSON schema: ${JSON.stringify(t.inputSchema)}`,
            ),
            'TOOL-CALL RULES: to use a tool, return a `toolCalls` array alongside your JSON reply, e.g. {"toolCalls": [{"id": "<tool id>", "input": {...}}]}. Only use the ids listed above — any other id is rejected immediately and counts against your budget. Tool calls NEVER apply anything: they only stage a proposal for the user to review on the Consent Card, and nothing changes until the user clicks Approve. If no tool is needed, omit `toolCalls` and answer with a terminal intent.',
          ].join('\n');

  // Permission-aware identity (Phase 0): server-provided, trusted. The model
  // must only repeat this identity and never invent permissions.
  const identityBlock = agentContext
    ? buildIdentityPromptBlock(agentContext)
    : user
      ? buildAccountOnlyIdentityBlock(user)
      : '';

  return [
    personaBlock,
    '',
    antiRepetitionBlock,
    '',
    securityAndContextBlock,
    '',
    identityBlock,
    '',
    systemSettingsSection,
    '',
    toolSection,
    '',
    platformSection,
    '',
    knowledgeSection ? `${KB_ANSWER_RULES}\n\n${knowledgeSection}` : '',
    '',
    coachPack.playbookReference,
    '',
    coachPack.outputContract,
  ].join('\n');
}

/**
 * Checks whether main FreeLLMAPI (`api_keys`) has any enabled provider key,
 * custom endpoint, or keyless sentinel row (`'no-key'`) configured.
 *
 * NOTE: Previously `playbook.ts` queried `FROM keys` (a non-existent table!),
 * which threw `SqliteError: no such table: keys` and disabled main-gateway routing.
 */
export function hasConfiguredMainGatewayRoutes(): boolean {
  try {
    const db = getDb();
    const row = db
      .prepare(
        "SELECT COUNT(*) AS c FROM api_keys WHERE enabled = 1 AND status NOT IN ('invalid', 'disabled')",
      )
      .get() as { c: number } | undefined;
    return Number(row?.c ?? 0) > 0;
  } catch {
    return false;
  }
}

function safeGetRecordedPort(): number {
  try {
    return getRecordedServerAddress().localPort ?? 0;
  } catch {
    return 0;
  }
}

function safeGetInternalLoopbackToken(): string {
  try {
    return getInternalLoopbackToken();
  } catch {
    return '';
  }
}

/**
 * Normalizes loopback URLs so reverse-proxied Docker / SnapDeploy containers
 * (where `req.socket.localAddress` is an internal bridge IP like `172.17.0.5`)
 * connect to `127.0.0.1:${port}` first.
 *
 * Why this matters:
 * 1) WHATWG `fetch()` (Undici) treats `Host` as a forbidden request header and
 *    derives `Host` strictly from the request URL.
 * 2) When `ALLOWED_HOSTS` is enabled in production, `createHostGuard` allows
 *    `127.0.0.1`, `localhost`, `::1`, and the public domain — rejecting
 *    `Host: 172.17.0.5:3001` with HTTP 403 Forbidden!
 * 3) If `gatewayLoopback` was omitted by a caller, falls back to `getRecordedServerAddress()`.
 */
export function normalizeLoopbackTarget(loopback?: GatewayLoopbackContext): {
  primaryUrl: string;
  fallbackUrl?: string;
  port: number;
  sessionToken?: string;
} | null {
  const recorded = (() => {
    try {
      return getRecordedServerAddress();
    } catch {
      return { localAddress: '127.0.0.1', localPort: 0 };
    }
  })();

  const port = loopback?.port && loopback.port > 0 ? loopback.port : recorded.localPort;
  if (!port || port <= 0) return null;

  const rawHost = (loopback?.host || recorded.localAddress || '127.0.0.1')
    .trim()
    .replace(/^::ffff:/i, '');
  const bareHost = rawHost.replace(/^\[|\]$/g, '').toLowerCase();

  const isIpv6Loopback = bareHost === '::1';
  const primaryHost = isIpv6Loopback ? '[::1]' : '127.0.0.1';
  const primaryUrl = `http://${primaryHost}:${port}/v1/chat/completions`;

  let fallbackUrl: string | undefined;
  if (isIpv6Loopback) {
    fallbackUrl = `http://127.0.0.1:${port}/v1/chat/completions`;
  } else if (
    bareHost &&
    bareHost !== '127.0.0.1' &&
    bareHost !== 'localhost' &&
    bareHost !== '0.0.0.0' &&
    bareHost !== '::'
  ) {
    const formattedRaw = bareHost.includes(':') ? `[${bareHost}]` : bareHost;
    fallbackUrl = `http://${formattedRaw}:${port}/v1/chat/completions`;
  }

  return {
    primaryUrl,
    ...(fallbackUrl ? { fallbackUrl } : {}),
    port,
    sessionToken: loopback?.sessionToken,
  };
}

function shouldAttemptMainGatewayLoopback(
  params: LlmCoachTurnInput,
  resolvedPort: number,
): boolean {
  if (params.gatewayLoopback?.forceLoopback) return true;
  if (params.fetchImpl) return true;
  if (typeof globalThis.fetch === 'function' && 'mock' in globalThis.fetch) return true;
  if (hasConfiguredMainGatewayRoutes()) return true;

  // If a caller/test explicitly supplied a standalone mock server port different
  // from the main Express app's recorded port, allow loopback to reach that mock.
  const recordedPort = safeGetRecordedPort();
  if (
    params.gatewayLoopback?.port &&
    params.gatewayLoopback.port > 0 &&
    recordedPort !== params.gatewayLoopback.port
  ) {
    return true;
  }

  // Otherwise we are on an unconfigured in-process server (e.g. `:memory:` test
  // with 0 `api_keys` and 0 `x_gateway_keys`), so fast-fail immediately.
  return resolvedPort > 0 && false;
}

function collectThrulineCandidates(preferredModel?: string): CandidateRoute[] {
  const seen = new Set<string>();
  const collected: CandidateRoute[] = [];

  const pushAll = (routes: CandidateRoute[]) => {
    for (const r of routes) {
      const key = `${r.account.id}:${r.modelId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push(r);
    }
  };

  // Note: Do NOT gate on `getConfigSnapshot().enabled`! Operators often connect
  // OAuth/API accounts in `/thruline/accounts` (`x_gateway_keys`) without exposing
  // the public `/thruline/v1` proxy endpoint, just like `executeSupportChatPipeline`.
  if (preferredModel && preferredModel.trim() && preferredModel.trim().toLowerCase() !== 'auto') {
    try {
      const preferred = resolveCandidateRoutes(preferredModel.trim(), 'chat');
      pushAll(preferred.candidates);
    } catch {
      // Ignore and continue to auto candidates
    }
  }

  try {
    const autoRoutes = resolveCandidateRoutes('auto', 'chat');
    pushAll(autoRoutes.candidates);
  } catch {
    // Thruline tables may be uninitialized in standalone unit tests
  }

  return collected;
}

function buildCorrectiveRetryNotice(locale: 'vi' | 'en'): string {
  return locale === 'vi'
    ? 'LƯU Ý QUAN TRỌNG: Hãy trả lời 100% bằng tiếng Việt tự nhiên, ấm áp, tuyệt đối KHÔNG lặp lại nguyên văn câu trả lời trước đó của assistant và trả về đúng 1 JSON object hợp lệ.'
    : 'IMPORTANT REMINDER: Respond in warm, natural English without repeating any prior assistant message, and output a single valid JSON object.';
}

function validateParsedCoachOutput(
  rawText: string,
  params: LlmCoachTurnInput,
): { valid: LlmCoachOutput | null; needsRetry: boolean } {
  const parsed = parseLlmCoachResponse(rawText);
  if (!parsed || !parsed.reply.trim()) {
    return { valid: null, needsRetry: false };
  }

  const safeReply = enforceReplySecurityInvariant(parsed.reply, params.locale);
  if (!safeReply) {
    return { valid: null, needsRetry: false };
  }

  if (!matchesRequestedLocale(safeReply, params.locale)) {
    return { valid: null, needsRetry: true };
  }

  if (isRepetitiveAssistantReply(safeReply, params.messages)) {
    return { valid: null, needsRetry: true };
  }

  return {
    valid: {
      ...parsed,
      reply: safeReply,
    },
    needsRetry: false,
  };
}

/**
 * Executes a warm, empathetic, human-like onboarding coach turn via any available LLM route:
 * 1. Thruline `provider_accounts` (`x_gateway_keys`: OAuth, freeTier, webCookie, API keys, custom nodes)
 *    even when the external `/thruline/v1` toggle is off.
 * 2. Main FreeLLMAPI `/v1/chat/completions` loopback (`api_keys`, custom endpoints, profiles,
 *    and keyless sentinel routes), normalized to `127.0.0.1` so Docker/SnapDeploy `ALLOWED_HOSTS`
 *    guards never reject internal bridge IPs, with automatic `'auto'` -> `'auto:balanced'` failover.
 * 3. Instant fast-fail in `:memory:` tests when no upstream or mock route is configured.
 */
export async function runHumanLikeLlmCoach(
  params: LlmCoachTurnInput,
): Promise<LlmCoachTurnResult | null> {
  await ensureVerifiedCloudRuntimePack('support_copilot');
  let knowledgeSection: string | undefined;
  try {
    const hits = await searchKb(buildKbQueryFromMessages(params.messages, params.currentPath), {
      caller: params.user,
      limit: 5,
      locale: params.locale,
      currentPath: params.currentPath,
    });
    knowledgeSection = formatKbForPrompt(hits, params.locale);
  } catch {
    // Retrieval must never break a chat turn.
    knowledgeSection = undefined;
  }
  const systemPrompt = buildHumanCoachSystemPrompt({ ...params, toolSchemas: params.toolSchemas, knowledgeSection });
  const baseTurnMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: systemPrompt },
    ...params.messages.slice(-14).map((m) => ({
      role: m.role,
      content: m.content,
    })),
  ];

  const timeoutMs = params.timeoutMs ?? 15_000;

  // -------------------------------------------------------------------------
  // Tier 1: Thruline provider accounts (`x_gateway_keys`)
  // -------------------------------------------------------------------------
  const candidates = collectThrulineCandidates(params.diagnostic?.tenant.defaultModel);
  if (candidates.length > 0) {
    for (const candidate of candidates.slice(0, 4)) {
      const { account, modelId } = candidate;
      const provider = resolveAccountProvider(account);
      if (!provider) continue;

      let credential = '';
      try {
        credential = decrypt(account.encrypted_key, account.iv, account.auth_tag);
      } catch {
        // AccountProvider resolves OAuth / refreshed credentials internally via withAccountCredential
        credential = '';
      }

      const proxy = resolveXGatewayAccountProxy(account);
      const startedAt = Date.now();

      try {
        const signal = AbortSignal.timeout(Math.min(timeoutMs, 12_000));
        const res = await withQuotaTracking(account, modelId, proxy, () =>
          provider.chatCompletion(
            credential,
            baseTurnMessages,
            modelId,
            { temperature: 0.45, max_tokens: 1000, signal },
            { platform: account.platform, keyId: account.id, modelId },
          ),
        );

        recordCandidateSuccess(account.id, modelId);
        recordRouteOutcome(`${account.id}:${modelId}`, { latencyMs: Date.now() - startedAt });

        const text = extractCompletionText(res.choices?.[0]?.message?.content);
        const check = validateParsedCoachOutput(text, params);
        if (check.valid) {
          return {
            output: check.valid,
            modelUsed: res.model || `${account.provider}/${modelId}`,
            routeSource: 'thruline_account',
          };
        }

        if (check.needsRetry) {
          const retrySignal = AbortSignal.timeout(Math.min(timeoutMs, 10_000));
          const retryMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
            ...baseTurnMessages,
            { role: 'system', content: buildCorrectiveRetryNotice(params.locale) },
          ];
          const retryRes = await withQuotaTracking(account, modelId, proxy, () =>
            provider.chatCompletion(
              credential,
              retryMessages,
              modelId,
              { temperature: 0.65, max_tokens: 1000, signal: retrySignal },
              { platform: account.platform, keyId: account.id, modelId },
            ),
          );
          const retryText = extractCompletionText(retryRes.choices?.[0]?.message?.content);
          const retryCheck = validateParsedCoachOutput(retryText, params);
          if (retryCheck.valid) {
            return {
              output: retryCheck.valid,
              modelUsed: retryRes.model || `${account.provider}/${modelId}`,
              routeSource: 'thruline_account',
            };
          }
        }
      } catch (err) {
        try {
          recordCandidateFailure(account.id, modelId, err);
          recordRouteOutcome(`${account.id}:${modelId}`, { error: true });
        } catch {
          // Best-effort health bookkeeping
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Tier 2: Main FreeLLMAPI `/v1/chat/completions` loopback
  // -------------------------------------------------------------------------
  const loopbackTarget = normalizeLoopbackTarget(params.gatewayLoopback);
  if (!loopbackTarget || !shouldAttemptMainGatewayLoopback(params, loopbackTarget.port)) {
    return null;
  }

  const doFetch = params.fetchImpl ?? globalThis.fetch;
  const unifiedKey = safeGetInternalLoopbackToken();
  const baseHeaders: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'freellm-support-setup-copilot',
  };
  if (unifiedKey) {
    baseHeaders.authorization = `Bearer ${unifiedKey}`;
  }
  if (loopbackTarget.sessionToken) {
    baseHeaders[PLAYGROUND_SESSION_HEADER] = loopbackTarget.sessionToken;
  }

  const postLoopback = async (
    model: string,
    turnMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    temperature: number,
    bypassCache: boolean,
  ): Promise<Response> => {
    const headers = bypassCache
      ? { ...baseHeaders, 'cache-control': 'no-cache' }
      : baseHeaders;
    const init: RequestInit = {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        temperature,
        max_tokens: 1000,
        messages: turnMessages,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    };
    try {
      return await doFetch(loopbackTarget.primaryUrl, init);
    } catch (primaryErr) {
      if (!loopbackTarget.fallbackUrl) throw primaryErr;
      return await doFetch(loopbackTarget.fallbackUrl, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
    }
  };

  // Try `'auto'` first; if the active routing profile chain has 0 enabled models (`400`/`404`) OR
  // its seeded models have no active provider keys while another custom/catalog key is configured
  // outside `profile_models` (`503 no_providers_configured` / `429 routing_exhausted`),
  // automatically fail over to `'auto:balanced'` which spans all enabled catalog/custom models.
  const modelsToTry = ['auto', 'auto:balanced'];
  for (let i = 0; i < modelsToTry.length; i += 1) {
    const modelCandidate = modelsToTry[i]!;
    try {
      const upstream = await postLoopback(modelCandidate, baseTurnMessages, 0.45, false);
      if (!upstream.ok) {
        if (
          i === 0 &&
          (upstream.status === 400 ||
            upstream.status === 404 ||
            upstream.status === 503 ||
            upstream.status === 429)
        ) {
          continue;
        }
        return null;
      }

      const body = (await upstream.json().catch(() => null)) as {
        model?: string;
        _routed_via?: { model?: string };
        choices?: Array<{ message?: { content?: unknown } }>;
      } | null;

      const routedHeader = upstream.headers?.get?.('x-routed-via') ?? undefined;
      const modelUsed =
        body?._routed_via?.model || routedHeader || body?.model || modelCandidate;

      const text = extractCompletionText(body?.choices?.[0]?.message?.content);
      const check = validateParsedCoachOutput(text, params);
      if (check.valid) {
        return {
          output: check.valid,
          modelUsed,
          routeSource: 'main_gateway_loopback',
        };
      }

      if (check.needsRetry) {
        const retryMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
          ...baseTurnMessages,
          { role: 'system', content: buildCorrectiveRetryNotice(params.locale) },
        ];
        const retryUpstream = await postLoopback(modelCandidate, retryMessages, 0.65, true);
        if (retryUpstream.ok) {
          const retryBody = (await retryUpstream.json().catch(() => null)) as {
            model?: string;
            _routed_via?: { model?: string };
            choices?: Array<{ message?: { content?: unknown } }>;
          } | null;
          const retryText = extractCompletionText(retryBody?.choices?.[0]?.message?.content);
          const retryCheck = validateParsedCoachOutput(retryText, params);
          if (retryCheck.valid) {
            const retryRoutedHeader = retryUpstream.headers?.get?.('x-routed-via') ?? undefined;
            return {
              output: retryCheck.valid,
              modelUsed:
                retryBody?._routed_via?.model ||
                retryRoutedHeader ||
                retryBody?.model ||
                modelUsed,
              routeSource: 'main_gateway_loopback',
            };
          }
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  return null;
}
