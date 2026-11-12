import { getDb } from '../../db/index.js';

const GUARDRAILS_KEY = 'x_gateway_support_guardrails_v1';
const QUOTAS_KEY = 'x_gateway_support_quotas_v1';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SupportInjectionDetector =
  | 'ignore_instructions'
  | 'role_spoofing'
  | 'system_prompt_leak'
  | 'sql_injection_probe';

export interface SupportRoleQuotaRule {
  maxRequestsPerWindow: number; // 0 = unlimited
  maxTokensPerWindow: number; // 0 = unlimited
  windowSeconds: number;
}

export interface SupportGuardrailPolicy {
  tenantId: string;
  enabled: boolean;
  blockPromptInjection: boolean;
  injectionDetectors: SupportInjectionDetector[];
  blockedTopics: string[];
  competitorKeywords: string[];
  maxInputLength: number;
  bypassRoles: string[];
  roleQuotas: Record<string, SupportRoleQuotaRule>;
  updatedAt: string;
}

export interface SupportGuardrailEvaluation {
  allowed: boolean;
  blockedReason?: 'prompt_injection' | 'blocked_topic' | 'competitor_mention' | 'input_too_long';
  triggeredRules: string[];
  matchedTerms: string[];
  bypassedByRole: boolean;
  sanitizedText: string;
}

export interface SupportQuotaStatus {
  allowed: boolean;
  reason?: 'quota_exceeded_requests' | 'quota_exceeded_tokens';
  userId: string;
  userRole: string;
  requestsUsed: number;
  maxRequests: number;
  tokensUsed: number;
  maxTokens: number;
  windowSeconds: number;
  resetAt: string;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function readStore<T>(key: string): Record<string, T> {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  if (!row?.value) return {};
  try {
    const parsed = JSON.parse(row.value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, T>) : {};
  } catch {
    return {};
  }
}

function writeStore<T>(key: string, store: Record<string, T>): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, JSON.stringify(store));
}

function strList(v: unknown, fallback: string[]): string[] {
  if (!Array.isArray(v)) return fallback;
  return v.map((x) => String(x).trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

const ALL_DETECTORS: SupportInjectionDetector[] = [
  'ignore_instructions',
  'role_spoofing',
  'system_prompt_leak',
  'sql_injection_probe',
];

function defaultRoleQuotas(): Record<string, SupportRoleQuotaRule> {
  return {
    guest: { maxRequestsPerWindow: 15, maxTokensPerWindow: 8000, windowSeconds: 3600 },
    customer: { maxRequestsPerWindow: 60, maxTokensPerWindow: 40000, windowSeconds: 3600 },
    staff: { maxRequestsPerWindow: 300, maxTokensPerWindow: 200000, windowSeconds: 3600 },
    admin: { maxRequestsPerWindow: 0, maxTokensPerWindow: 0, windowSeconds: 3600 },
  };
}

function defaultPolicy(tenantId: string): SupportGuardrailPolicy {
  return {
    tenantId,
    enabled: true,
    blockPromptInjection: true,
    injectionDetectors: [...ALL_DETECTORS],
    blockedTopics: [],
    competitorKeywords: [],
    maxInputLength: 4000,
    bypassRoles: ['admin'],
    roleQuotas: defaultRoleQuotas(),
    updatedAt: new Date(0).toISOString(),
  };
}

function num(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function normalizeQuota(r: Partial<SupportRoleQuotaRule> | undefined, fb: SupportRoleQuotaRule): SupportRoleQuotaRule {
  const ws = num(r?.windowSeconds, fb.windowSeconds);
  return {
    maxRequestsPerWindow: num(r?.maxRequestsPerWindow, fb.maxRequestsPerWindow),
    maxTokensPerWindow: num(r?.maxTokensPerWindow, fb.maxTokensPerWindow),
    windowSeconds: ws > 0 ? ws : fb.windowSeconds,
  };
}

export function getSupportGuardrailPolicy(tenantId: string): SupportGuardrailPolicy {
  const tid = String(tenantId);
  const base = defaultPolicy(tid);
  const saved = readStore<Partial<SupportGuardrailPolicy>>(GUARDRAILS_KEY)[tid];
  if (!saved) return base;
  const quotas = { ...base.roleQuotas };
  for (const [role, rule] of Object.entries(saved.roleQuotas ?? {})) {
    quotas[role] = normalizeQuota(rule, quotas[role] ?? { maxRequestsPerWindow: 30, maxTokensPerWindow: 20000, windowSeconds: 3600 });
  }
  return {
    tenantId: tid,
    enabled: saved.enabled ?? base.enabled,
    blockPromptInjection: saved.blockPromptInjection ?? base.blockPromptInjection,
    injectionDetectors: strList(saved.injectionDetectors, base.injectionDetectors).filter(
      (d): d is SupportInjectionDetector => (ALL_DETECTORS as string[]).includes(d),
    ),
    blockedTopics: strList(saved.blockedTopics, base.blockedTopics),
    competitorKeywords: strList(saved.competitorKeywords, base.competitorKeywords),
    maxInputLength: num(saved.maxInputLength, base.maxInputLength),
    bypassRoles: strList(saved.bypassRoles, base.bypassRoles),
    roleQuotas: quotas,
    updatedAt: saved.updatedAt ?? base.updatedAt,
  };
}

export function updateSupportGuardrailPolicy(
  tenantId: string,
  patch: Partial<Omit<SupportGuardrailPolicy, 'tenantId' | 'updatedAt'>>,
): SupportGuardrailPolicy {
  const tid = String(tenantId);
  const cur = getSupportGuardrailPolicy(tid);
  const quotas = { ...cur.roleQuotas };
  for (const [role, rule] of Object.entries(patch.roleQuotas ?? {})) {
    quotas[role] = normalizeQuota(rule, quotas[role] ?? { maxRequestsPerWindow: 30, maxTokensPerWindow: 20000, windowSeconds: 3600 });
  }
  const next: SupportGuardrailPolicy = {
    ...cur,
    enabled: patch.enabled ?? cur.enabled,
    blockPromptInjection: patch.blockPromptInjection ?? cur.blockPromptInjection,
    injectionDetectors: patch.injectionDetectors
      ? patch.injectionDetectors.filter((d) => ALL_DETECTORS.includes(d))
      : cur.injectionDetectors,
    blockedTopics: patch.blockedTopics ? strList(patch.blockedTopics, []) : cur.blockedTopics,
    competitorKeywords: patch.competitorKeywords ? strList(patch.competitorKeywords, []) : cur.competitorKeywords,
    maxInputLength: patch.maxInputLength !== undefined ? num(patch.maxInputLength, cur.maxInputLength) : cur.maxInputLength,
    bypassRoles: patch.bypassRoles ? strList(patch.bypassRoles, []) : cur.bypassRoles,
    roleQuotas: quotas,
    updatedAt: new Date().toISOString(),
  };
  const store = readStore<SupportGuardrailPolicy>(GUARDRAILS_KEY);
  store[tid] = next;
  writeStore(GUARDRAILS_KEY, store);
  return next;
}

// ---------------------------------------------------------------------------
// Input guardrails
// ---------------------------------------------------------------------------

const INJECTION_PATTERNS: Record<SupportInjectionDetector, RegExp[]> = {
  ignore_instructions: [
    /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions|prompts|rules)/i,
    /disregard\s+(all\s+)?(previous|system)/i,
    /forget\s+your\s+(instructions|rules)/i,
  ],
  role_spoofing: [
    /i\s+am\s+(now\s+)?(an?\s+)?admin(istrator)?/i,
    /grant\s+me\s+admin/i,
    /override\s+(user\s+)?role\s+to\s+admin/i,
    /act\s+as\s+root/i,
  ],
  system_prompt_leak: [
    /reveal\s+(your\s+)?(system\s+prompt|signing\s+secret)/i,
    /show\s+(me\s+)?(the\s+)?system\s+(prompt|instructions)/i,
    /print\s+initial\s+instructions/i,
  ],
  sql_injection_probe: [/;\s*drop\s+table/i, /union\s+select\s+/i, /or\s+1\s*=\s*1/i],
};

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function findTerms(haystackLower: string, terms: string[]): string[] {
  const hits: string[] = [];
  for (const t of terms) {
    const needle = t.trim().toLowerCase();
    if (needle && haystackLower.includes(needle) && !hits.includes(t)) hits.push(t);
  }
  return hits;
}

export function evaluateSupportInputGuardrails(
  tenantId: string,
  input: { text: string; userId?: string; userRole: string },
): SupportGuardrailEvaluation {
  const policy = getSupportGuardrailPolicy(tenantId);
  const text = String(input.text ?? '');
  const bypassed = policy.bypassRoles.includes(input.userRole);
  if (!policy.enabled || bypassed) {
    return { allowed: true, triggeredRules: [], matchedTerms: [], bypassedByRole: bypassed, sanitizedText: text };
  }

  const sanitizedText = text.replace(CONTROL_CHARS, '').trim();
  const block = (
    blockedReason: NonNullable<SupportGuardrailEvaluation['blockedReason']>,
    triggeredRules: string[],
    matchedTerms: string[] = [],
  ): SupportGuardrailEvaluation => ({
    allowed: false,
    blockedReason,
    triggeredRules,
    matchedTerms,
    bypassedByRole: false,
    sanitizedText,
  });

  if (policy.maxInputLength > 0 && text.length > policy.maxInputLength) {
    return block('input_too_long', ['max_input_length']);
  }

  if (policy.blockPromptInjection) {
    const rules: string[] = [];
    const terms: string[] = [];
    for (const detector of policy.injectionDetectors) {
      for (const re of INJECTION_PATTERNS[detector] ?? []) {
        const m = re.exec(sanitizedText);
        if (m) {
          if (!rules.includes(detector)) rules.push(detector);
          terms.push(m[0]);
        }
      }
    }
    if (rules.length) return block('prompt_injection', rules, terms);
  }

  const lower = sanitizedText.toLowerCase();
  const topics = findTerms(lower, policy.blockedTopics);
  if (topics.length) return block('blocked_topic', ['blocked_topic'], topics);
  const competitors = findTerms(lower, policy.competitorKeywords);
  if (competitors.length) return block('competitor_mention', ['competitor_mention'], competitors);

  return { allowed: true, triggeredRules: [], matchedTerms: [], bypassedByRole: false, sanitizedText };
}

// ---------------------------------------------------------------------------
// Per-role quotas
// ---------------------------------------------------------------------------

interface QuotaCounter {
  userId: string;
  userRole: string;
  windowStart: number; // epoch ms
  requestsUsed: number;
  tokensUsed: number;
}

type QuotaTenantStore = Record<string, QuotaCounter>;

const FALLBACK_QUOTA: SupportRoleQuotaRule = { maxRequestsPerWindow: 30, maxTokensPerWindow: 20000, windowSeconds: 3600 };

function ruleFor(policy: SupportGuardrailPolicy, role: string): SupportRoleQuotaRule {
  return Object.prototype.hasOwnProperty.call(policy.roleQuotas, role) ? policy.roleQuotas[role] : FALLBACK_QUOTA;
}

function buildStatus(
  userId: string,
  userRole: string,
  rule: SupportRoleQuotaRule,
  counter: QuotaCounter | null,
  allowed: boolean,
  reason?: SupportQuotaStatus['reason'],
): SupportQuotaStatus {
  const resetMs = (counter?.windowStart ?? Date.now()) + rule.windowSeconds * 1000;
  return {
    allowed,
    ...(reason ? { reason } : {}),
    userId,
    userRole,
    requestsUsed: counter?.requestsUsed ?? 0,
    maxRequests: rule.maxRequestsPerWindow,
    tokensUsed: counter?.tokensUsed ?? 0,
    maxTokens: rule.maxTokensPerWindow,
    windowSeconds: rule.windowSeconds,
    resetAt: new Date(resetMs).toISOString(),
  };
}

function isUnlimited(policy: SupportGuardrailPolicy, role: string, rule: SupportRoleQuotaRule): boolean {
  return (
    policy.bypassRoles.includes(role) || (rule.maxRequestsPerWindow === 0 && rule.maxTokensPerWindow === 0)
  );
}

function activeCounter(store: QuotaTenantStore, userId: string, rule: SupportRoleQuotaRule, now: number): QuotaCounter | null {
  const c = store[userId];
  if (!c) return null;
  return now >= c.windowStart + rule.windowSeconds * 1000 ? null : c;
}

export function getSupportUserQuotaStatus(
  tenantId: string,
  input: { userId: string; userRole: string },
): SupportQuotaStatus {
  const tid = String(tenantId);
  const policy = getSupportGuardrailPolicy(tid);
  const rule = ruleFor(policy, input.userRole);
  const counter = activeCounter(readStore<QuotaTenantStore>(QUOTAS_KEY)[tid] ?? {}, input.userId, rule, Date.now());
  if (isUnlimited(policy, input.userRole, rule)) {
    return buildStatus(input.userId, input.userRole, rule, counter, true);
  }
  let reason: SupportQuotaStatus['reason'];
  if (rule.maxRequestsPerWindow > 0 && (counter?.requestsUsed ?? 0) + 1 > rule.maxRequestsPerWindow) {
    reason = 'quota_exceeded_requests';
  } else if (rule.maxTokensPerWindow > 0 && (counter?.tokensUsed ?? 0) >= rule.maxTokensPerWindow) {
    reason = 'quota_exceeded_tokens';
  }
  return buildStatus(input.userId, input.userRole, rule, counter, !reason, reason);
}

export function checkAndConsumeSupportUserQuota(
  tenantId: string,
  input: { userId: string; userRole: string; tokens?: number },
): SupportQuotaStatus {
  const tid = String(tenantId);
  const policy = getSupportGuardrailPolicy(tid);
  const rule = ruleFor(policy, input.userRole);
  const tokens = Math.max(0, Math.floor(Number(input.tokens ?? 0)) || 0);
  const now = Date.now();
  const store = readStore<QuotaTenantStore>(QUOTAS_KEY);
  const tenantStore = store[tid] ?? {};
  const existing = activeCounter(tenantStore, input.userId, rule, now);

  if (isUnlimited(policy, input.userRole, rule)) {
    return buildStatus(input.userId, input.userRole, rule, existing, true);
  }

  const counter: QuotaCounter = existing ?? {
    userId: input.userId,
    userRole: input.userRole,
    windowStart: now,
    requestsUsed: 0,
    tokensUsed: 0,
  };

  if (rule.maxRequestsPerWindow > 0 && counter.requestsUsed + 1 > rule.maxRequestsPerWindow) {
    return buildStatus(input.userId, input.userRole, rule, counter, false, 'quota_exceeded_requests');
  }
  if (rule.maxTokensPerWindow > 0 && counter.tokensUsed + tokens > rule.maxTokensPerWindow) {
    return buildStatus(input.userId, input.userRole, rule, counter, false, 'quota_exceeded_tokens');
  }

  counter.userRole = input.userRole;
  counter.requestsUsed += 1;
  counter.tokensUsed += tokens;
  tenantStore[input.userId] = counter;
  store[tid] = tenantStore;
  writeStore(QUOTAS_KEY, store);
  return buildStatus(input.userId, input.userRole, rule, counter, true);
}

export function resetSupportUserQuota(tenantId: string, userId?: string): void {
  const tid = String(tenantId);
  const store = readStore<QuotaTenantStore>(QUOTAS_KEY);
  if (!store[tid]) return;
  if (userId === undefined) delete store[tid];
  else delete store[tid][userId];
  writeStore(QUOTAS_KEY, store);
}
