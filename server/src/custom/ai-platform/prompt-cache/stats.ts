import type { Response } from 'express';
import {
  PROMPT_CACHE_LIMITS,
  type PromptCacheGroupBy,
  type PromptCacheStatsResponse,
  type PromptCacheStatsRow,
} from '@freellmapi/shared/ai-platform-prompt-cache.js';
import { getDb } from '../../../db/index.js';
import {
  DEFAULT_MODEL_PRICING,
  resolveModelPricing,
  type ModelPricingRate,
} from '../../x-gateway/pricing.js';
import type { Wire } from '../wire/detect.js';
import type { OutputFilter, OutputFilterContext } from '../wire/interceptor.js';

export interface ExtractedCacheUsage {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface CacheUsageFilterContext {
  getRoute?: () => { platform: string; modelId: string } | null;
  getUpstreamUsage?: () => ExtractedCacheUsage | null;
  res?: Response;
}

interface CacheStatsAggRow {
  key: string;
  requests: number;
  requests_with_hit: number;
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  est_saved_micro_usd: number;
}

const DAY_MS = 86_400_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonNegInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

/** Extracts normalized input and prompt-cache token counts from any of the 4 wire usage payloads. */
export function extractCacheUsage(wire: Wire, usage: unknown): ExtractedCacheUsage | null {
  const u = asRecord(usage);
  if (!u) return null;

  if (wire === 'openai-chat') {
    const promptTokens = nonNegInt(u.prompt_tokens);
    const details = asRecord(u.prompt_tokens_details);
    const cachedTokens = nonNegInt(details?.cached_tokens);
    if (promptTokens === undefined && cachedTokens === undefined) return null;
    const cacheReadTokens = cachedTokens ?? 0;
    return {
      inputTokens: promptTokens ?? cacheReadTokens,
      cacheReadTokens,
      cacheWriteTokens: 0,
    };
  }

  if (wire === 'anthropic') {
    const baseInput = nonNegInt(u.input_tokens);
    const cacheRead = nonNegInt(u.cache_read_input_tokens);
    const cacheWrite = nonNegInt(u.cache_creation_input_tokens);
    if (baseInput === undefined && cacheRead === undefined && cacheWrite === undefined) {
      return null;
    }
    const cacheReadTokens = cacheRead ?? 0;
    const cacheWriteTokens = cacheWrite ?? 0;
    return {
      inputTokens: (baseInput ?? 0) + cacheReadTokens + cacheWriteTokens,
      cacheReadTokens,
      cacheWriteTokens,
    };
  }

  if (wire === 'responses') {
    const input = nonNegInt(u.input_tokens);
    const details = asRecord(u.input_tokens_details);
    const cached = nonNegInt(details?.cached_tokens);
    if (input === undefined && cached === undefined) return null;
    const cacheReadTokens = cached ?? 0;
    return {
      inputTokens: input ?? cacheReadTokens,
      cacheReadTokens,
      cacheWriteTokens: 0,
    };
  }

  // gemini
  const prompt = nonNegInt(u.promptTokenCount);
  const cached = nonNegInt(u.cachedContentTokenCount);
  if (prompt === undefined && cached === undefined) return null;
  const cacheReadTokens = cached ?? 0;
  return {
    inputTokens: prompt ?? cacheReadTokens,
    cacheReadTokens,
    cacheWriteTokens: 0,
  };
}

function getPricingSafely(platform: string, model: string): ModelPricingRate {
  try {
    return resolveModelPricing(platform, model);
  } catch {
    return resolveModelPricing(platform, model, DEFAULT_MODEL_PRICING);
  }
}

/**
 * Estimates net cache savings in micro-USD (1 USD = 1,000,000 micro-USD).
 * Because pricing rates are $/1M tokens, `tokens * rateDiffUsd` yields micro-USD directly.
 */
export function estimateCacheSavingsMicroUsd(
  platform: string,
  model: string,
  cacheReadTokens: number,
  cacheWriteTokens: number,
): number {
  const safeRead = Math.max(0, Number(cacheReadTokens) || 0);
  const safeWrite = Math.max(0, Number(cacheWriteTokens) || 0);
  if (safeRead === 0 && safeWrite === 0) return 0;

  const rate = getPricingSafely(platform, model);
  const cachedRate = rate.cached ?? rate.input;
  const cacheCreationRate = rate.cache_creation ?? rate.input;

  const readSavings = safeRead * (rate.input - cachedRate);
  const writeSavings = safeWrite * (rate.input - cacheCreationRate);
  return Math.max(0, Math.round(readSavings + writeSavings));
}

/** Upserts one response's prompt cache counters into `custom_ai_cache_usage_daily`. */
export function recordCacheUsage(input: {
  day?: string;
  profileId: number;
  platform: string;
  model: string;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}): void {
  const day =
    input.day && /^\d{4}-\d{2}-\d{2}$/.test(input.day)
      ? input.day
      : new Date().toISOString().slice(0, 10);
  const profileId =
    Number.isFinite(input.profileId) && input.profileId >= 0 ? Math.floor(input.profileId) : 0;
  const platform = input.platform.trim() || 'unknown';
  const model = input.model.trim() || 'unknown';
  const inputTokens = Math.max(0, Math.floor(Number(input.inputTokens) || 0));
  const cacheReadTokens = Math.max(0, Math.floor(Number(input.cacheReadTokens) || 0));
  const cacheWriteTokens = Math.max(0, Math.floor(Number(input.cacheWriteTokens) || 0));
  const requestsWithHit = cacheReadTokens > 0 ? 1 : 0;
  const estSavedMicroUsd = estimateCacheSavingsMicroUsd(
    platform,
    model,
    cacheReadTokens,
    cacheWriteTokens,
  );

  getDb()
    .prepare(
      `INSERT INTO custom_ai_cache_usage_daily (
         day, profile_id, platform, model,
         requests, requests_with_hit,
         input_tokens, cache_read_tokens, cache_write_tokens, est_saved_micro_usd
       ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
       ON CONFLICT(day, profile_id, platform, model) DO UPDATE SET
         requests = custom_ai_cache_usage_daily.requests + 1,
         requests_with_hit = custom_ai_cache_usage_daily.requests_with_hit + excluded.requests_with_hit,
         input_tokens = custom_ai_cache_usage_daily.input_tokens + excluded.input_tokens,
         cache_read_tokens = custom_ai_cache_usage_daily.cache_read_tokens + excluded.cache_read_tokens,
         cache_write_tokens = custom_ai_cache_usage_daily.cache_write_tokens + excluded.cache_write_tokens,
         est_saved_micro_usd = custom_ai_cache_usage_daily.est_saved_micro_usd + excluded.est_saved_micro_usd`,
    )
    .run(
      day,
      profileId,
      platform,
      model,
      requestsWithHit,
      inputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      estSavedMicroUsd,
    );
}

function resolveTarget(context?: CacheUsageFilterContext): { platform: string; model: string } {
  const route = context?.getRoute?.();
  if (route && (route.platform || route.modelId)) {
    return {
      platform: route.platform.trim() || 'unknown',
      model: route.modelId.trim() || 'unknown',
    };
  }

  const rawHeader =
    context?.res?.getHeader?.('X-Routed-Via') ?? context?.res?.getHeader?.('x-routed-via');
  const headerStr = Array.isArray(rawHeader)
    ? String(rawHeader[0] ?? '')
    : rawHeader !== undefined
      ? String(rawHeader)
      : '';
  const trimmed = headerStr.trim();
  if (trimmed) {
    const slashIdx = trimmed.indexOf('/');
    if (slashIdx > 0) {
      return {
        platform: trimmed.slice(0, slashIdx).trim() || 'unknown',
        model: trimmed.slice(slashIdx + 1).trim() || 'unknown',
      };
    }
    return { platform: trimmed, model: 'unknown' };
  }

  return { platform: 'unknown', model: 'unknown' };
}

function mergeUsage(
  extracted: ExtractedCacheUsage | null,
  upstream: ExtractedCacheUsage | null,
): ExtractedCacheUsage | null {
  if (!extracted && !upstream) return null;
  if (!extracted) return upstream;
  if (!upstream) return extracted;

  const preferUpstreamCache = upstream.cacheReadTokens > 0 || upstream.cacheWriteTokens > 0;
  const cacheReadTokens = preferUpstreamCache
    ? Math.max(extracted.cacheReadTokens, upstream.cacheReadTokens)
    : extracted.cacheReadTokens;
  const cacheWriteTokens = preferUpstreamCache
    ? Math.max(extracted.cacheWriteTokens, upstream.cacheWriteTokens)
    : extracted.cacheWriteTokens;
  const inputTokens = Math.max(
    extracted.inputTokens,
    upstream.inputTokens,
    cacheReadTokens + cacheWriteTokens,
  );
  return { inputTokens, cacheReadTokens, cacheWriteTokens };
}

function isAnthropicMessageStartPlaceholder(wire: Wire, usage: unknown): boolean {
  if (wire !== 'anthropic') return false;
  const u = asRecord(usage);
  if (!u) return false;
  return (
    u.output_tokens === 0 &&
    u.cache_read_input_tokens === undefined &&
    u.cache_creation_input_tokens === undefined
  );
}

function extractUsageFromBody(wire: Wire, body: Record<string, unknown>): unknown {
  if (wire === 'openai-chat') return body.usage;
  if (wire === 'anthropic') return body.usage ?? asRecord(body.message)?.usage;
  if (wire === 'responses') return body.usage ?? asRecord(body.response)?.usage;
  return body.usageMetadata;
}

/**
 * Builds an interceptor filter that records prompt cache usage once per response
 * and restores stripped protocol cache fields on non-stream Anthropic/Gemini JSON bodies.
 */
export function cacheUsageFilter(
  profileId: number,
  wire: Wire,
  context?: CacheUsageFilterContext,
): OutputFilter {
  let attached = false;
  let recorded = false;
  let pendingUsage: ExtractedCacheUsage | null = null;

  const commitOnce = (extracted: ExtractedCacheUsage | null): void => {
    if (recorded) return;
    const upstream = context?.getUpstreamUsage?.() ?? null;
    const merged = mergeUsage(extracted ?? pendingUsage, upstream);
    if (!merged) return;

    recorded = true;
    const target = resolveTarget(context);
    try {
      recordCacheUsage({
        profileId,
        platform: target.platform,
        model: target.model,
        inputTokens: merged.inputTokens,
        cacheReadTokens: merged.cacheReadTokens,
        cacheWriteTokens: merged.cacheWriteTokens,
      });
    } catch {
      // Hot-path stats recording must never fail an inference response.
    }
  };

  return {
    name: 'prompt-cache-stats',
    attach() {
      attached = true;
    },
    onUsage(usage: unknown) {
      if (recorded) return;
      const extracted = extractCacheUsage(wire, usage);
      if (extracted) {
        pendingUsage = mergeUsage(pendingUsage, extracted);
      }
      const upstream = context?.getUpstreamUsage?.() ?? null;
      if (attached && !upstream && isAnthropicMessageStartPlaceholder(wire, usage)) {
        // Anthropic streams emit an estimated message_start before upstream finishes; wait for message_delta/end.
        return;
      }
      if (extracted || upstream) {
        commitOnce(extracted);
      }
    },
    onResponseObject(body: Record<string, unknown>, _ctx: OutputFilterContext) {
      if (!recorded) {
        const bodyUsage = extractCacheUsage(wire, extractUsageFromBody(wire, body));
        commitOnce(bodyUsage);
      }

      const upstream = context?.getUpstreamUsage?.() ?? null;
      if (!upstream || (upstream.cacheReadTokens <= 0 && upstream.cacheWriteTokens <= 0)) {
        return;
      }

      if (wire === 'anthropic') {
        const existingUsage = asRecord(body.usage);
        const curRead = nonNegInt(existingUsage?.cache_read_input_tokens) ?? 0;
        const curWrite = nonNegInt(existingUsage?.cache_creation_input_tokens) ?? 0;
        if (curRead >= upstream.cacheReadTokens && curWrite >= upstream.cacheWriteTokens) {
          return;
        }
        const nextUsage: Record<string, unknown> = existingUsage
          ? { ...existingUsage }
          : {
              input_tokens: Math.max(
                0,
                upstream.inputTokens - upstream.cacheReadTokens - upstream.cacheWriteTokens,
              ),
              output_tokens: 0,
            };
        if (upstream.cacheReadTokens > 0 || nextUsage.cache_read_input_tokens === undefined) {
          nextUsage.cache_read_input_tokens = Math.max(curRead, upstream.cacheReadTokens);
        }
        if (upstream.cacheWriteTokens > 0 || nextUsage.cache_creation_input_tokens === undefined) {
          nextUsage.cache_creation_input_tokens = Math.max(curWrite, upstream.cacheWriteTokens);
        }
        return { ...body, usage: nextUsage };
      }

      if (wire === 'gemini' && upstream.cacheReadTokens > 0) {
        const existingMeta = asRecord(body.usageMetadata);
        const curCached = nonNegInt(existingMeta?.cachedContentTokenCount) ?? 0;
        if (curCached >= upstream.cacheReadTokens) return;
        const nextMeta: Record<string, unknown> = existingMeta
          ? { ...existingMeta, cachedContentTokenCount: upstream.cacheReadTokens }
          : {
              promptTokenCount: upstream.inputTokens,
              cachedContentTokenCount: upstream.cacheReadTokens,
            };
        return { ...body, usageMetadata: nextMeta };
      }
    },
    onBeforeTerminal() {
      if (!recorded) {
        commitOnce(null);
      }
      return { emit: '' };
    },
    dispose() {
      if (!recorded) {
        commitOnce(null);
      }
    },
  };
}

/** Aggregates prompt cache usage rows over the trailing `days` window grouped by day, profile, or model. */
export function getCacheStats(opts?: {
  days?: number;
  groupBy?: PromptCacheGroupBy;
}): PromptCacheStatsResponse {
  const rawDays = opts?.days ?? PROMPT_CACHE_LIMITS.defaultStatsDays;
  const days = Number.isFinite(rawDays)
    ? Math.min(PROMPT_CACHE_LIMITS.maxStatsDays, Math.max(1, Math.floor(rawDays)))
    : PROMPT_CACHE_LIMITS.defaultStatsDays;
  const groupBy: PromptCacheGroupBy =
    opts?.groupBy === 'profile' || opts?.groupBy === 'model' ? opts.groupBy : 'day';

  const nowMs = Date.now();
  const to = new Date(nowMs).toISOString().slice(0, 10);
  const from = new Date(nowMs - (days - 1) * DAY_MS).toISOString().slice(0, 10);

  let keyExpr = 'day';
  let orderExpr = 'day DESC';
  if (groupBy === 'profile') {
    keyExpr = 'CAST(profile_id AS TEXT)';
    orderExpr = 'SUM(cache_read_tokens) DESC, profile_id ASC';
  } else if (groupBy === 'model') {
    keyExpr = "platform || '/' || model";
    orderExpr = 'SUM(cache_read_tokens) DESC, key ASC';
  }

  const sql = `
    SELECT ${keyExpr} AS key,
           SUM(requests) AS requests,
           SUM(requests_with_hit) AS requests_with_hit,
           SUM(input_tokens) AS input_tokens,
           SUM(cache_read_tokens) AS cache_read_tokens,
           SUM(cache_write_tokens) AS cache_write_tokens,
           SUM(est_saved_micro_usd) AS est_saved_micro_usd
      FROM custom_ai_cache_usage_daily
     WHERE day >= ? AND day <= ?
     GROUP BY ${keyExpr}
     ORDER BY ${orderExpr}
  `;

  const rawRows = getDb().prepare(sql).all(from, to) as CacheStatsAggRow[];
  const rows: PromptCacheStatsRow[] = rawRows.map((r) => {
    const requests = Number(r.requests) || 0;
    const requestsWithHit = Number(r.requests_with_hit) || 0;
    const inputTokens = Number(r.input_tokens) || 0;
    const cacheReadTokens = Number(r.cache_read_tokens) || 0;
    const cacheWriteTokens = Number(r.cache_write_tokens) || 0;
    const estSavedMicroUsd = Number(r.est_saved_micro_usd) || 0;
    return {
      key: r.key,
      requests,
      requestsWithHit,
      hitRate: inputTokens > 0 ? cacheReadTokens / inputTokens : 0,
      requestHitRate: requests > 0 ? requestsWithHit / requests : 0,
      inputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      estSavedUsd: Number((estSavedMicroUsd / 1_000_000).toFixed(6)),
    };
  });

  return { days, groupBy, rows };
}
