import type { LearnedModelCapRecord } from '@freellmapi/shared/smart-routing-v2.js';
import { getDb } from '../../db/index.js';
import { endpointScopeForBaseUrl } from '../../lib/endpoint-scope.js';
import { sanitizeProviderErrorMessage } from '../../lib/error-redaction.js';
import type { CompletionOptions } from '../../providers/base.js';

export const MIN_PLAUSIBLE_MAX_TOKENS_CEILING = 256;
export const THINKING_HEADROOM_TOKENS = 1024;
export const MIN_THINKING_BUDGET_TOKENS = 1024;

export const REASONING_EFFORT_ORDER: readonly string[] = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const;

const MAX_TOKENS_PARAM_RE =
  /\b(max_tokens|max_completion_tokens|max_output_tokens|maxoutputtokens|max_new_tokens)\b/i;

const PROSE_CEILING_PHRASE =
  '(?:less than or equal to|must be less than|at most|no (?:more|greater) than|(?:cannot|must not|can not) exceed|greater than the maximum|maximum output tokens|maximum allowed value|max output tokens|maximum value|output limit|maximum is)\\W{0,4}(?:of\\s+)?\\W{0,2}(\\d{3,7})';

const PROSE_MAX_TOKENS_CEILING_RE = new RegExp(
  `\\b(?:max_tokens|max_completion_tokens|max_output_tokens|maxoutputtokens|max_new_tokens)\\b[^.;]{0,80}?${PROSE_CEILING_PHRASE}`,
  'i',
);

const INCLUSIVE_MAX_TOKENS_RE =
  /\b(?:max_tokens|max_completion_tokens|max_output_tokens|maxoutputtokens|max_new_tokens)\b[^\n]*?(?:expected a value|must be|should be|value|is)\s*<=\s*(\d+)/i;

const EXCLUSIVE_MAX_TOKENS_RE =
  /\b(?:max_tokens|max_completion_tokens|max_output_tokens|maxoutputtokens|max_new_tokens)\b[^\n]*?(?:expected a value|value)\s*<\s*(\d+)/i;

const THINKING_RANGE_RE =
  /\b(?:thinking_?budget|budget_tokens)\b[^\d-]*(?:must be in the range|in range|range)[^\d-]*\[\s*-?\d+\s*,\s*(\d+)\s*\]/i;

const THINKING_INCLUSIVE_RE =
  /\b(?:thinking[._]?budget|budget_tokens)\b[^\n]*?(?:expected a value|must be|should be|value)\s*<=\s*(\d+)/i;

const THINKING_EXCLUSIVE_RE =
  /\b(?:thinking[._]?budget|budget_tokens)\b[^\n]*?(?:expected a value|value)\s*<\s*(\d+)/i;

const THINKING_PROSE_RE = new RegExp(
  `\\b(?:thinking[._]?budget|budget_tokens)\\b[^.;]{0,80}?${PROSE_CEILING_PHRASE}`,
  'i',
);

const REASONING_EFFORT_MENTION_RE = /\breasoning[_.\s-]?effort\b/i;
const REASONING_LIST_INTRO_RE =
  /(?:expected one of|supported (?:types|values|efforts) are|must be one of|valid values(?: are)?|please use|allowed values(?: are)?)[:\s]*([^.\n;]+)/i;

/**
 * Unescape JSON-serialized comparison operators (`\u003c`, `\u003d`, `\u003e`, `\u0026`)
 * that several upstreams return inside 400 error strings.
 */
export function unescapeJsonOperators(raw: string): string {
  return raw
    .replace(/\\u003[cC]/g, '<')
    .replace(/\\u003[dD]/g, '=')
    .replace(/\\u003[eE]/g, '>')
    .replace(/\\u0026/g, '&');
}

function plausibleMaxTokens(value: number, floor: number): number | null {
  return Number.isFinite(value) && value >= floor ? Math.trunc(value) : null;
}

/**
 * Clause-safe parser for `max_tokens` ceilings in upstream 400/422 error payloads.
 * Handles JSON-escaped `\u003c`/`\u003d` bounds, exclusive `< N` bounds (`N - 1`),
 * and prose ceilings while ignoring thinking_budget, context_window, and TPM clauses.
 */
export function parseLearnedMaxTokensCeiling(
  errText: unknown,
  minCeiling = MIN_PLAUSIBLE_MAX_TOKENS_CEILING,
): number | null {
  if (errText == null) return null;
  const raw = typeof errText === 'string' ? errText : String(errText);
  if (!raw) return null;

  const normalized = unescapeJsonOperators(raw);
  if (!MAX_TOKENS_PARAM_RE.test(normalized)) return null;

  for (const clause of normalized.split(/[;\n]|(?<!\.)\.\s/)) {
    if (!MAX_TOKENS_PARAM_RE.test(clause)) continue;
    if (/\b(?:budget_tokens|thinking_?budget)\b/i.test(clause)) continue;
    // Do not misread Cloudflare-style combined input+output context window errors.
    if (/input and maximum output tokens[^\n]*context window/i.test(clause)) continue;

    const inclusive = INCLUSIVE_MAX_TOKENS_RE.exec(clause);
    if (inclusive) {
      return plausibleMaxTokens(Number(inclusive[1]), minCeiling);
    }
    const exclusive = EXCLUSIVE_MAX_TOKENS_RE.exec(clause);
    if (exclusive) {
      return plausibleMaxTokens(Number(exclusive[1]) - 1, minCeiling);
    }
    const prose = PROSE_MAX_TOKENS_CEILING_RE.exec(clause);
    if (prose) {
      return plausibleMaxTokens(Number(prose[1]), minCeiling);
    }
  }

  return null;
}

/**
 * Extract the upstream-advertised maximum thinking budget from a 400/422 error body.
 */
export function parseLearnedThinkingBudgetCeiling(errText: unknown): number | null {
  if (errText == null) return null;
  const raw = typeof errText === 'string' ? errText : String(errText);
  if (!raw) return null;
  const normalized = unescapeJsonOperators(raw);

  const rangeMatch = THINKING_RANGE_RE.exec(normalized);
  if (rangeMatch) {
    const val = Number(rangeMatch[1]);
    return Number.isFinite(val) && val >= MIN_PLAUSIBLE_MAX_TOKENS_CEILING ? Math.trunc(val) : null;
  }

  for (const clause of normalized.split(/[;\n]|(?<!\.)\.\s/)) {
    if (!/\b(?:thinking[._]?budget|budget_tokens)\b/i.test(clause)) continue;
    const inclusive = THINKING_INCLUSIVE_RE.exec(clause);
    if (inclusive) {
      const val = Number(inclusive[1]);
      return Number.isFinite(val) && val >= MIN_PLAUSIBLE_MAX_TOKENS_CEILING ? Math.trunc(val) : null;
    }
    const exclusive = THINKING_EXCLUSIVE_RE.exec(clause);
    if (exclusive) {
      const val = Number(exclusive[1]) - 1;
      return Number.isFinite(val) && val >= MIN_PLAUSIBLE_MAX_TOKENS_CEILING ? Math.trunc(val) : null;
    }
    const prose = THINKING_PROSE_RE.exec(clause);
    if (prose) {
      const val = Number(prose[1]);
      return Number.isFinite(val) && val >= MIN_PLAUSIBLE_MAX_TOKENS_CEILING ? Math.trunc(val) : null;
    }
  }

  return null;
}

/**
 * Extract accepted `reasoning_effort` enum values from an upstream 400/422 error body.
 */
export function parseLearnedReasoningEffortEnum(errText: unknown): string[] | null {
  if (errText == null) return null;
  const raw = typeof errText === 'string' ? errText : String(errText);
  if (!raw) return null;
  const normalized = unescapeJsonOperators(raw);
  if (!REASONING_EFFORT_MENTION_RE.test(normalized)) return null;

  const intro = REASONING_LIST_INTRO_RE.exec(normalized);
  const candidateSlice = intro
    ? intro[1]!
    : (/in\s*\[([^\]]+)\]/i.exec(normalized)?.[1] ?? '');
  if (!candidateSlice) return null;

  const tokens = candidateSlice
    .split(/,|\||\b(?:and|or)\b|&/i)
    .map(token =>
      token
        .replace(/[`'"]/g, '')
        .replace(/\([^)]*\)/g, '')
        .trim()
        .toLowerCase()
        .replace(/^[^a-z]+|[^a-z]+$/g, ''),
    )
    .filter(token => token.length > 0 && REASONING_EFFORT_ORDER.includes(token));

  return tokens.length > 0 ? [...new Set(tokens)] : null;
}

/**
 * Clamp a top-level `max_tokens` down to `cap`, automatically squeezing
 * `thinking.budget_tokens <= cap - 1024` (or dropping `thinking` if `< 1024`)
 * so Anthropic/Claude-compatible payloads remain contract-valid.
 */
export function clampTopLevelMaxTokens(body: unknown, cap: number): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  if (!(Number.isFinite(cap) && cap > 0)) return false;
  const rec = body as {
    max_tokens?: unknown;
    max_completion_tokens?: unknown;
    thinking?: Record<string, unknown> | null;
  };

  let modified = false;
  const currentMax = Number(rec.max_tokens);
  if (Number.isFinite(currentMax) && currentMax > cap) {
    rec.max_tokens = Math.trunc(cap);
    modified = true;
  }

  const currentCompletionMax = Number(rec.max_completion_tokens);
  if (Number.isFinite(currentCompletionMax) && currentCompletionMax > cap) {
    rec.max_completion_tokens = Math.trunc(cap);
    modified = true;
  }

  const effectiveTopMax = Number.isFinite(Number(rec.max_tokens))
    ? Number(rec.max_tokens)
    : Number.isFinite(Number(rec.max_completion_tokens))
      ? Number(rec.max_completion_tokens)
      : null;

  if (effectiveTopMax != null && effectiveTopMax <= cap && rec.thinking && typeof rec.thinking === 'object') {
    const budget = Number(rec.thinking.budget_tokens);
    if (Number.isFinite(budget) && budget > effectiveTopMax - THINKING_HEADROOM_TOKENS) {
      const squeezed = Math.trunc(effectiveTopMax - THINKING_HEADROOM_TOKENS);
      if (squeezed < MIN_THINKING_BUDGET_TOKENS) {
        delete rec.thinking;
      } else {
        rec.thinking = { ...rec.thinking, budget_tokens: squeezed };
      }
      modified = true;
    }
  }

  return modified;
}

/**
 * Clamp `thinking.budget_tokens` down to a learned `maxThinkingBudget`, while also
 * respecting `max_tokens - 1024` headroom if `max_tokens` is set on the body.
 */
export function clampThinkingBudget(body: unknown, maxThinkingBudget: number): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  if (!(Number.isFinite(maxThinkingBudget) && maxThinkingBudget > 0)) return false;
  const rec = body as {
    max_tokens?: unknown;
    thinking?: Record<string, unknown> | null;
  };
  if (!rec.thinking || typeof rec.thinking !== 'object') return false;
  const current = Number(rec.thinking.budget_tokens);
  if (!Number.isFinite(current)) return false;

  let targetCap = Math.trunc(maxThinkingBudget);
  const topMax = Number(rec.max_tokens);
  if (Number.isFinite(topMax) && topMax > 0) {
    targetCap = Math.min(targetCap, Math.trunc(topMax - THINKING_HEADROOM_TOKENS));
  }
  if (current <= targetCap && targetCap >= MIN_THINKING_BUDGET_TOKENS) return false;

  if (targetCap < MIN_THINKING_BUDGET_TOKENS) {
    delete rec.thinking;
  } else {
    rec.thinking = { ...rec.thinking, budget_tokens: targetCap };
  }
  return true;
}

/**
 * Nearest-tier clamping for `reasoning_effort`: smallest accepted value >= requested rank,
 * falling back to greatest accepted value when requested exceeds every accepted value.
 */
export function clampReasoningEffortToLearned(
  effort: string | null | undefined,
  supported: readonly string[] | null | undefined,
): string | null {
  if (!effort || !supported || supported.length === 0) return null;
  const normalized = effort.trim().toLowerCase();
  const acceptedSet = new Set(supported.map(s => s.trim().toLowerCase()));
  if (acceptedSet.has(normalized)) return normalized;

  const rank = REASONING_EFFORT_ORDER.indexOf(normalized);
  if (rank === -1) return null;

  let nearestAbove: string | null = null;
  let nearestAboveRank = Number.POSITIVE_INFINITY;
  let highest: string | null = null;
  let highestRank = -1;

  for (const candidate of acceptedSet) {
    const r = REASONING_EFFORT_ORDER.indexOf(candidate);
    if (r < 0) continue;
    if (r >= rank && r < nearestAboveRank) {
      nearestAboveRank = r;
      nearestAbove = candidate;
    }
    if (r > highestRank) {
      highestRank = r;
      highest = candidate;
    }
  }

  return nearestAbove ?? highest;
}

// ── SQLite Write-Through Cache ───────────────────────────────────────────────

interface DbLearnedCapRow {
  provider: string;
  model_id: string;
  endpoint_scope: string;
  max_output_tokens: number | null;
  max_thinking_budget: number | null;
  supported_reasoning_efforts: string | null;
  last_error_sample: string | null;
  hit_count: number;
  updated_at: string;
}

const memoryCaps = new Map<string, LearnedModelCapRecord>();
let hydratedDb: unknown = null;

function normalizeIdentity(
  provider: string | null | undefined,
  modelId: string | null | undefined,
  endpointScope?: string | null,
): { provider: string; modelId: string; endpointScope: string; key: string } | null {
  const p = (provider ?? '').trim().toLowerCase();
  const m = (modelId ?? '').trim().toLowerCase();
  if (!p || !m) return null;
  const scope = endpointScopeForBaseUrl(endpointScope);
  return {
    provider: p,
    modelId: m,
    endpointScope: scope,
    key: `${p}::${m}::${scope}`,
  };
}

function parseEffortsJson(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const valid = parsed.filter(
      (item): item is string => typeof item === 'string' && REASONING_EFFORT_ORDER.includes(item),
    );
    return valid.length > 0 ? valid : null;
  } catch {
    return null;
  }
}

function rowToRecord(row: DbLearnedCapRow): LearnedModelCapRecord {
  return {
    provider: row.provider,
    modelId: row.model_id,
    endpointScope: row.endpoint_scope,
    maxOutputTokens: typeof row.max_output_tokens === 'number' ? row.max_output_tokens : null,
    maxThinkingBudget: typeof row.max_thinking_budget === 'number' ? row.max_thinking_budget : null,
    supportedReasoningEfforts: parseEffortsJson(row.supported_reasoning_efforts),
    lastErrorSample: row.last_error_sample ?? null,
    hitCount: typeof row.hit_count === 'number' ? row.hit_count : 1,
    updatedAt: row.updated_at,
  };
}

function tryGetLearnedCapsDb(): ReturnType<typeof getDb> | null {
  try {
    const db = getDb();
    const exists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'custom_learned_model_caps'")
      .get();
    if (!exists) return null;
    return db;
  } catch {
    return null;
  }
}

function ensureHydrated(): ReturnType<typeof getDb> | null {
  const db = tryGetLearnedCapsDb();
  if (!db) return null;
  if (hydratedDb === db) return db;

  memoryCaps.clear();
  hydratedDb = db;
  const rows = db
    .prepare('SELECT * FROM custom_learned_model_caps ORDER BY updated_at DESC')
    .all() as DbLearnedCapRow[];
  for (const row of rows) {
    const id = normalizeIdentity(row.provider, row.model_id, row.endpoint_scope);
    if (!id) continue;
    memoryCaps.set(id.key, rowToRecord(row));
  }
  return db;
}

function persistRecord(db: ReturnType<typeof getDb> | null, record: LearnedModelCapRecord): void {
  if (!db) return;
  db.prepare(`
    INSERT INTO custom_learned_model_caps (
      provider, model_id, endpoint_scope, max_output_tokens, max_thinking_budget,
      supported_reasoning_efforts, last_error_sample, hit_count, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider, model_id, endpoint_scope) DO UPDATE SET
      max_output_tokens = excluded.max_output_tokens,
      max_thinking_budget = excluded.max_thinking_budget,
      supported_reasoning_efforts = excluded.supported_reasoning_efforts,
      last_error_sample = COALESCE(excluded.last_error_sample, custom_learned_model_caps.last_error_sample),
      hit_count = excluded.hit_count,
      updated_at = excluded.updated_at
  `).run(
    record.provider,
    record.modelId,
    record.endpointScope,
    record.maxOutputTokens,
    record.maxThinkingBudget,
    record.supportedReasoningEfforts ? JSON.stringify(record.supportedReasoningEfforts) : null,
    record.lastErrorSample,
    record.hitCount,
    record.updatedAt,
  );
}

function formatErrorSample(rawError: unknown): string | null {
  if (rawError == null) return null;
  const text = rawError instanceof Error ? rawError.message : String(rawError);
  const trimmed = sanitizeProviderErrorMessage(unescapeJsonOperators(text)).trim();
  return trimmed ? trimmed.slice(0, 280) : null;
}

function isSubset(a: readonly string[], b: ReadonlySet<string>): boolean {
  return a.every(item => b.has(item));
}

export function getLearnedModelCapRecord(
  provider: string | null | undefined,
  modelId: string | null | undefined,
  endpointScope?: string | null,
): LearnedModelCapRecord | null {
  ensureHydrated();
  const id = normalizeIdentity(provider, modelId, endpointScope);
  if (!id) return null;
  const hit = memoryCaps.get(id.key);
  if (!hit) return null;
  return {
    ...hit,
    supportedReasoningEfforts: hit.supportedReasoningEfforts ? [...hit.supportedReasoningEfforts] : null,
  };
}

export function getLearnedMaxTokensCap(
  provider: string | null | undefined,
  modelId: string | null | undefined,
  endpointScope?: string | null,
): number | null {
  return getLearnedModelCapRecord(provider, modelId, endpointScope)?.maxOutputTokens ?? null;
}

export function getLearnedThinkingBudgetCap(
  provider: string | null | undefined,
  modelId: string | null | undefined,
  endpointScope?: string | null,
): number | null {
  return getLearnedModelCapRecord(provider, modelId, endpointScope)?.maxThinkingBudget ?? null;
}

export function getLearnedReasoningEfforts(
  provider: string | null | undefined,
  modelId: string | null | undefined,
  endpointScope?: string | null,
): string[] | null {
  return getLearnedModelCapRecord(provider, modelId, endpointScope)?.supportedReasoningEfforts ?? null;
}

export function recordLearnedMaxTokensCap(
  provider: string | null | undefined,
  modelId: string | null | undefined,
  cap: number,
  endpointScope?: string | null,
  errorSample?: unknown,
): number | null {
  if (!Number.isFinite(cap) || cap < MIN_PLAUSIBLE_MAX_TOKENS_CEILING) return null;
  const db = ensureHydrated();
  const id = normalizeIdentity(provider, modelId, endpointScope);
  if (!id) return null;

  const existing = memoryCaps.get(id.key);
  const rounded = Math.trunc(cap);
  const nextCap = existing?.maxOutputTokens != null
    ? Math.min(existing.maxOutputTokens, rounded)
    : rounded;
  const now = new Date().toISOString();
  const sample = formatErrorSample(errorSample);

  const nextRecord: LearnedModelCapRecord = {
    provider: id.provider,
    modelId: id.modelId,
    endpointScope: id.endpointScope,
    maxOutputTokens: nextCap,
    maxThinkingBudget: existing?.maxThinkingBudget ?? null,
    supportedReasoningEfforts: existing?.supportedReasoningEfforts ?? null,
    lastErrorSample: sample ?? existing?.lastErrorSample ?? null,
    hitCount: existing ? existing.hitCount + 1 : 1,
    updatedAt: now,
  };

  memoryCaps.set(id.key, nextRecord);
  persistRecord(db, nextRecord);
  return nextCap;
}

export function recordLearnedThinkingBudgetCap(
  provider: string | null | undefined,
  modelId: string | null | undefined,
  budgetCap: number,
  endpointScope?: string | null,
  errorSample?: unknown,
): number | null {
  if (!Number.isFinite(budgetCap) || budgetCap < MIN_PLAUSIBLE_MAX_TOKENS_CEILING) return null;
  const db = ensureHydrated();
  const id = normalizeIdentity(provider, modelId, endpointScope);
  if (!id) return null;

  const existing = memoryCaps.get(id.key);
  const rounded = Math.trunc(budgetCap);
  const nextBudget = existing?.maxThinkingBudget != null
    ? Math.min(existing.maxThinkingBudget, rounded)
    : rounded;
  const now = new Date().toISOString();
  const sample = formatErrorSample(errorSample);

  const nextRecord: LearnedModelCapRecord = {
    provider: id.provider,
    modelId: id.modelId,
    endpointScope: id.endpointScope,
    maxOutputTokens: existing?.maxOutputTokens ?? null,
    maxThinkingBudget: nextBudget,
    supportedReasoningEfforts: existing?.supportedReasoningEfforts ?? null,
    lastErrorSample: sample ?? existing?.lastErrorSample ?? null,
    hitCount: existing ? existing.hitCount + 1 : 1,
    updatedAt: now,
  };

  memoryCaps.set(id.key, nextRecord);
  persistRecord(db, nextRecord);
  return nextBudget;
}

export function recordLearnedReasoningEfforts(
  provider: string | null | undefined,
  modelId: string | null | undefined,
  acceptedEfforts: readonly string[],
  endpointScope?: string | null,
  errorSample?: unknown,
): string[] | null {
  const valid = [...new Set(
    acceptedEfforts
      .map(v => (typeof v === 'string' ? v.trim().toLowerCase() : ''))
      .filter(v => v.length > 0 && REASONING_EFFORT_ORDER.includes(v)),
  )];
  if (valid.length === 0) return null;

  const db = ensureHydrated();
  const id = normalizeIdentity(provider, modelId, endpointScope);
  if (!id) return null;

  const existing = memoryCaps.get(id.key);
  let chosen = valid;
  if (existing?.supportedReasoningEfforts) {
    const existingArr = existing.supportedReasoningEfforts;
    const validSet = new Set(valid);
    const existingSet = new Set(existingArr);
    if (isSubset(existingArr, validSet)) {
      chosen = existingArr;
    } else if (isSubset(valid, existingSet)) {
      chosen = valid;
    } else {
      const intersection = existingArr.filter(item => validSet.has(item));
      chosen = intersection.length > 0 ? intersection : existingArr;
    }
  }

  const now = new Date().toISOString();
  const sample = formatErrorSample(errorSample);
  const nextRecord: LearnedModelCapRecord = {
    provider: id.provider,
    modelId: id.modelId,
    endpointScope: id.endpointScope,
    maxOutputTokens: existing?.maxOutputTokens ?? null,
    maxThinkingBudget: existing?.maxThinkingBudget ?? null,
    supportedReasoningEfforts: chosen,
    lastErrorSample: sample ?? existing?.lastErrorSample ?? null,
    hitCount: existing ? existing.hitCount + 1 : 1,
    updatedAt: now,
  };

  memoryCaps.set(id.key, nextRecord);
  persistRecord(db, nextRecord);
  return [...chosen];
}

/**
 * Inspect an upstream 400/422 error and persist any advertised ceilings for
 * `max_tokens`, `thinking.budget_tokens`, or `reasoning_effort`.
 */
export function learnCapsFromUpstreamError(
  target: { provider: string; modelId: string; endpointScope?: string | null },
  err: unknown,
  opts?: { minMaxTokensCeiling?: number },
): {
  learned: boolean;
  maxOutputTokens?: number;
  maxThinkingBudget?: number;
  supportedReasoningEfforts?: string[];
} {
  const status = typeof (err as { status?: unknown })?.status === 'number'
    ? (err as { status: number }).status
    : typeof (err as { statusCode?: unknown })?.statusCode === 'number'
      ? (err as { statusCode: number }).statusCode
      : 0;
  if (status !== 0 && status !== 400 && status !== 422) {
    return { learned: false };
  }

  const message = err instanceof Error ? err.message : String(err ?? '');
  if (!message) return { learned: false };

  let learned = false;
  const out: {
    learned: boolean;
    maxOutputTokens?: number;
    maxThinkingBudget?: number;
    supportedReasoningEfforts?: string[];
  } = { learned: false };

  const maxOut = parseLearnedMaxTokensCeiling(
    message,
    opts?.minMaxTokensCeiling ?? MIN_PLAUSIBLE_MAX_TOKENS_CEILING,
  );
  if (maxOut != null) {
    const stored = recordLearnedMaxTokensCap(
      target.provider,
      target.modelId,
      maxOut,
      target.endpointScope,
      message,
    );
    if (stored != null) {
      out.maxOutputTokens = stored;
      learned = true;
    }
  }

  const maxThink = parseLearnedThinkingBudgetCeiling(message);
  if (maxThink != null) {
    const stored = recordLearnedThinkingBudgetCap(
      target.provider,
      target.modelId,
      maxThink,
      target.endpointScope,
      message,
    );
    if (stored != null) {
      out.maxThinkingBudget = stored;
      learned = true;
    }
  }

  const efforts = parseLearnedReasoningEffortEnum(message);
  if (efforts != null) {
    const stored = recordLearnedReasoningEfforts(
      target.provider,
      target.modelId,
      efforts,
      target.endpointScope,
      message,
    );
    if (stored != null) {
      out.supportedReasoningEfforts = stored;
      learned = true;
    }
  }

  out.learned = learned;
  return out;
}

/**
 * Proactively apply any learned ceilings to `CompletionOptions` and optional raw request body
 * before dispatching upstream (including squeezing `thinking.budget_tokens <= max_tokens - 1024`).
 */
export function applyLearnedCapsToDispatch(
  target: { provider: string; modelId: string; endpointScope?: string | null },
  options: CompletionOptions,
  rawBody?: Record<string, unknown>,
): { options: CompletionOptions; clamped: boolean } {
  const record = getLearnedModelCapRecord(target.provider, target.modelId, target.endpointScope);
  let clamped = false;
  let nextOptions: CompletionOptions = { ...options };

  if (record?.maxOutputTokens != null) {
    if (typeof nextOptions.max_tokens === 'number' && nextOptions.max_tokens > record.maxOutputTokens) {
      nextOptions = { ...nextOptions, max_tokens: record.maxOutputTokens };
      clamped = true;
    }
    if (rawBody && clampTopLevelMaxTokens(rawBody, record.maxOutputTokens)) {
      clamped = true;
    }
  } else if (rawBody && typeof nextOptions.max_tokens === 'number' && nextOptions.max_tokens > 0) {
    // Even without a learned max_tokens cap, keep thinking.budget_tokens contract-valid under max_tokens.
    if (clampTopLevelMaxTokens(rawBody, nextOptions.max_tokens)) {
      clamped = true;
    }
  }

  if (record?.maxThinkingBudget != null && rawBody) {
    if (clampThinkingBudget(rawBody, record.maxThinkingBudget)) {
      clamped = true;
    }
  }

  if (record?.supportedReasoningEfforts && nextOptions.reasoning_effort) {
    const clampedEffort = clampReasoningEffortToLearned(
      nextOptions.reasoning_effort,
      record.supportedReasoningEfforts,
    );
    if (clampedEffort && clampedEffort !== nextOptions.reasoning_effort) {
      const mapped = (clampedEffort === 'xhigh' || clampedEffort === 'max' || clampedEffort === 'ultra')
        ? 'high'
        : clampedEffort;
      nextOptions = {
        ...nextOptions,
        reasoning_effort: mapped as CompletionOptions['reasoning_effort'],
      };
      if (rawBody && typeof rawBody.reasoning_effort === 'string') {
        rawBody.reasoning_effort = clampedEffort;
      }
      clamped = true;
    }
  }

  return { options: nextOptions, clamped };
}

export function listLearnedModelCaps(): LearnedModelCapRecord[] {
  ensureHydrated();
  return [...memoryCaps.values()]
    .map(rec => ({
      ...rec,
      supportedReasoningEfforts: rec.supportedReasoningEfforts ? [...rec.supportedReasoningEfforts] : null,
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function clearLearnedModelCaps(filter?: {
  provider?: string;
  modelId?: string;
  endpointScope?: string;
}): number {
  const db = ensureHydrated();
  const prov = filter?.provider?.trim().toLowerCase();
  const mod = filter?.modelId?.trim().toLowerCase();
  const scope = filter?.endpointScope !== undefined ? endpointScopeForBaseUrl(filter.endpointScope) : undefined;

  if (!prov && !mod && scope === undefined) {
    const count = memoryCaps.size;
    memoryCaps.clear();
    if (db) {
      db.prepare('DELETE FROM custom_learned_model_caps').run();
    }
    return count;
  }

  let removed = 0;
  for (const [key, rec] of [...memoryCaps.entries()]) {
    if (prov && rec.provider !== prov) continue;
    if (mod && rec.modelId !== mod) continue;
    if (scope !== undefined && rec.endpointScope !== scope) continue;
    memoryCaps.delete(key);
    removed += 1;
    if (db) {
      db.prepare(
        'DELETE FROM custom_learned_model_caps WHERE provider = ? AND model_id = ? AND endpoint_scope = ?',
      ).run(rec.provider, rec.modelId, rec.endpointScope);
    }
  }
  return removed;
}

export function resetLearnedModelCapsForTests(): void {
  memoryCaps.clear();
  const db = tryGetLearnedCapsDb();
  if (db) {
    db.prepare('DELETE FROM custom_learned_model_caps').run();
    hydratedDb = db;
  } else {
    hydratedDb = null;
  }
}
