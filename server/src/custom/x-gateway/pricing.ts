import { getSetting, setSetting } from '../../db/index.js';

export const PRICING_OVERRIDES_SETTING_KEY = 'x_gateway_pricing_overrides';

export interface ModelPricingRate {
  input: number;
  output: number;
  cached?: number;
  reasoning?: number;
  cache_creation?: number;
}

export type ProviderPricingMap = Record<string, Record<string, ModelPricingRate>>;

export const VALID_PRICING_FIELDS = [
  'input',
  'output',
  'cached',
  'reasoning',
  'cache_creation',
] as const;

export type PricingField = (typeof VALID_PRICING_FIELDS)[number];

/**
 * Default pricing rates in USD per 1,000,000 tokens ($/1M tokens),
 * organized by provider and model ID.
 */
export const DEFAULT_MODEL_PRICING: ProviderPricingMap = {
  openai: {
    'gpt-4o': { input: 2.5, output: 10.0, cached: 1.25, reasoning: 15.0, cache_creation: 2.5 },
    'gpt-4o-mini': { input: 0.15, output: 0.6, cached: 0.075, reasoning: 0.9, cache_creation: 0.15 },
    'gpt-4.1': { input: 2.0, output: 8.0, cached: 0.5, reasoning: 8.0, cache_creation: 2.0 },
    'gpt-4.1-mini': { input: 0.4, output: 1.6, cached: 0.1, reasoning: 1.6, cache_creation: 0.4 },
    'gpt-5': { input: 1.25, output: 10.0, cached: 0.625, reasoning: 10.0, cache_creation: 1.25 },
    'gpt-5-mini': { input: 0.25, output: 2.0, cached: 0.125, reasoning: 2.0, cache_creation: 0.25 },
    'gpt-5-codex': { input: 1.25, output: 10.0, cached: 0.625, reasoning: 10.0, cache_creation: 1.25 },
    'gpt-5.2': { input: 1.75, output: 14.0, cached: 0.175, reasoning: 14.0, cache_creation: 1.75 },
    'gpt-5.3-codex': { input: 1.75, output: 14.0, cached: 0.175, reasoning: 14.0, cache_creation: 1.75 },
    'o1': { input: 15.0, output: 60.0, cached: 7.5, reasoning: 90.0, cache_creation: 15.0 },
    'o1-mini': { input: 3.0, output: 12.0, cached: 1.5, reasoning: 18.0, cache_creation: 3.0 },
    'o3-mini': { input: 1.1, output: 4.4, cached: 0.55, reasoning: 4.4, cache_creation: 1.1 },
  },
  anthropic: {
    'claude-opus-4-6': { input: 5.0, output: 25.0, cached: 0.5, reasoning: 25.0, cache_creation: 6.25 },
    'claude-sonnet-4-6': { input: 3.0, output: 15.0, cached: 0.3, reasoning: 15.0, cache_creation: 3.75 },
    'claude-sonnet-4-5-20250929': { input: 3.0, output: 15.0, cached: 0.3, reasoning: 15.0, cache_creation: 3.75 },
    'claude-haiku-4-5-20251001': { input: 1.0, output: 5.0, cached: 0.1, reasoning: 5.0, cache_creation: 1.25 },
    'claude-3-5-sonnet-20241022': { input: 3.0, output: 15.0, cached: 1.5, reasoning: 15.0, cache_creation: 3.0 },
  },
  gemini: {
    'gemini-2.5-pro': { input: 2.0, output: 12.0, cached: 0.25, reasoning: 18.0, cache_creation: 2.0 },
    'gemini-2.5-flash': { input: 0.3, output: 2.5, cached: 0.03, reasoning: 3.75, cache_creation: 0.3 },
    'gemini-2.5-flash-lite': { input: 0.15, output: 1.25, cached: 0.015, reasoning: 1.875, cache_creation: 0.15 },
    'gemini-3-flash-preview': { input: 0.5, output: 3.0, cached: 0.03, reasoning: 4.5, cache_creation: 0.5 },
    'gemini-3-pro-preview': { input: 2.0, output: 12.0, cached: 0.25, reasoning: 18.0, cache_creation: 2.0 },
  },
  deepseek: {
    'deepseek-chat': { input: 0.14, output: 0.28, cached: 0.014, reasoning: 0.28, cache_creation: 0.14 },
    'deepseek-reasoner': { input: 0.55, output: 2.19, cached: 0.14, reasoning: 2.19, cache_creation: 0.55 },
    'deepseek-r1': { input: 0.55, output: 2.19, cached: 0.14, reasoning: 2.19, cache_creation: 0.55 },
  },
  groq: {
    'llama-3.3-70b-versatile': { input: 0.59, output: 0.79, cached: 0.29, reasoning: 0.79 },
    'llama-3.1-8b-instant': { input: 0.05, output: 0.08, cached: 0.025, reasoning: 0.08 },
    'openai/gpt-oss-120b': { input: 0.15, output: 0.6, cached: 0.075, reasoning: 0.6 },
    'deepseek-r1-distill-llama-70b': { input: 0.75, output: 0.99, cached: 0.375, reasoning: 0.99 },
  },
  openrouter: {
    'auto': { input: 2.0, output: 8.0, cached: 1.0, reasoning: 12.0, cache_creation: 2.0 },
    'anthropic/claude-sonnet-4': { input: 3.0, output: 15.0, cached: 0.3, reasoning: 15.0, cache_creation: 3.75 },
    'openai/gpt-4o': { input: 2.5, output: 10.0, cached: 1.25, reasoning: 15.0 },
    'google/gemini-2.5-flash': { input: 0.3, output: 2.5, cached: 0.03, reasoning: 3.75 },
    'deepseek/deepseek-chat': { input: 0.14, output: 0.28, cached: 0.014, reasoning: 0.28 },
  },
  mistral: {
    'mistral-large-latest': { input: 2.0, output: 6.0, cached: 1.0, reasoning: 6.0 },
    'mistral-small-latest': { input: 0.15, output: 0.6, cached: 0.075, reasoning: 0.6 },
    'codestral-latest': { input: 0.3, output: 0.9, cached: 0.15, reasoning: 0.9 },
  },
  kimi: {
    'kimi-k2.5': { input: 1.2, output: 4.8, cached: 0.6, reasoning: 7.2 },
    'kimi-k2-thinking': { input: 1.5, output: 6.0, cached: 0.75, reasoning: 9.0 },
    'kimi-latest': { input: 1.0, output: 4.0, cached: 0.5, reasoning: 6.0 },
  },
  qwen: {
    'qwen3-coder-plus': { input: 1.0, output: 4.0, cached: 0.5, reasoning: 6.0 },
    'qwen3-coder-flash': { input: 0.5, output: 2.0, cached: 0.25, reasoning: 3.0 },
  },
  xai: {
    'grok-3': { input: 3.0, output: 15.0, cached: 0.75, reasoning: 15.0 },
    'grok-3-mini': { input: 0.3, output: 0.5, cached: 0.075, reasoning: 0.5 },
    'grok-code-fast-1': { input: 0.5, output: 2.0, cached: 0.25, reasoning: 3.0 },
  },
};

const PATTERN_FALLBACKS: Array<{ pattern: RegExp; rate: ModelPricingRate }> = [
  { pattern: /claude-opus/i, rate: { input: 5.0, output: 25.0, cached: 0.5, reasoning: 25.0, cache_creation: 6.25 } },
  { pattern: /claude-sonnet/i, rate: { input: 3.0, output: 15.0, cached: 0.3, reasoning: 15.0, cache_creation: 3.75 } },
  { pattern: /claude-haiku/i, rate: { input: 1.0, output: 5.0, cached: 0.1, reasoning: 5.0, cache_creation: 1.25 } },
  { pattern: /gpt-4o-mini|gpt-4\.1-mini|gpt-5-mini/i, rate: { input: 0.2, output: 0.8, cached: 0.1, reasoning: 0.8 } },
  { pattern: /gpt-5|gpt-4o|gpt-4/i, rate: { input: 2.0, output: 10.0, cached: 0.5, reasoning: 10.0 } },
  { pattern: /\bo1\b|\bo3\b/i, rate: { input: 3.0, output: 12.0, cached: 1.5, reasoning: 15.0 } },
  { pattern: /gemini.*flash-lite/i, rate: { input: 0.15, output: 1.25, cached: 0.015, reasoning: 1.875 } },
  { pattern: /gemini.*flash/i, rate: { input: 0.3, output: 2.5, cached: 0.03, reasoning: 3.75 } },
  { pattern: /gemini.*pro/i, rate: { input: 2.0, output: 12.0, cached: 0.25, reasoning: 18.0 } },
  { pattern: /deepseek/i, rate: { input: 0.14, output: 0.28, cached: 0.014, reasoning: 0.28 } },
  { pattern: /llama|mixtral|gemma/i, rate: { input: 0.2, output: 0.6, cached: 0.1, reasoning: 0.6 } },
  { pattern: /qwen/i, rate: { input: 0.5, output: 2.0, cached: 0.25, reasoning: 3.0 } },
  { pattern: /kimi/i, rate: { input: 1.0, output: 4.0, cached: 0.5, reasoning: 6.0 } },
  { pattern: /grok/i, rate: { input: 1.0, output: 4.0, cached: 0.25, reasoning: 4.0 } },
];

export const FALLBACK_PRICING_RATE: ModelPricingRate = {
  input: 1.0,
  output: 3.0,
  cached: 0.5,
  reasoning: 3.0,
};

function clonePricingMap(source: ProviderPricingMap): ProviderPricingMap {
  const out: ProviderPricingMap = {};
  for (const [provider, models] of Object.entries(source)) {
    out[provider] = {};
    for (const [model, rate] of Object.entries(models)) {
      out[provider][model] = { ...rate };
    }
  }
  return out;
}

export function getDefaultPricing(): ProviderPricingMap {
  return clonePricingMap(DEFAULT_MODEL_PRICING);
}

export function getPricingOverrides(): ProviderPricingMap {
  const raw = getSetting(PRICING_OVERRIDES_SETTING_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const sanitized: ProviderPricingMap = {};
    for (const [provider, models] of Object.entries(parsed as Record<string, unknown>)) {
      if (!models || typeof models !== 'object' || Array.isArray(models)) continue;
      for (const [model, rateObj] of Object.entries(models as Record<string, unknown>)) {
        if (!rateObj || typeof rateObj !== 'object' || Array.isArray(rateObj)) continue;
        const r = rateObj as Record<string, unknown>;
        const input = typeof r.input === 'number' && Number.isFinite(r.input) && r.input >= 0 ? r.input : undefined;
        const output = typeof r.output === 'number' && Number.isFinite(r.output) && r.output >= 0 ? r.output : undefined;
        if (input === undefined && output === undefined) continue;
        if (!sanitized[provider]) sanitized[provider] = {};
        const entry: ModelPricingRate = {
          input: input ?? DEFAULT_MODEL_PRICING[provider]?.[model]?.input ?? FALLBACK_PRICING_RATE.input,
          output: output ?? DEFAULT_MODEL_PRICING[provider]?.[model]?.output ?? FALLBACK_PRICING_RATE.output,
        };
        if (typeof r.cached === 'number' && Number.isFinite(r.cached) && r.cached >= 0) entry.cached = r.cached;
        if (typeof r.reasoning === 'number' && Number.isFinite(r.reasoning) && r.reasoning >= 0) entry.reasoning = r.reasoning;
        if (typeof r.cache_creation === 'number' && Number.isFinite(r.cache_creation) && r.cache_creation >= 0) {
          entry.cache_creation = r.cache_creation;
        }
        sanitized[provider][model] = entry;
      }
    }
    return sanitized;
  } catch {
    return {};
  }
}

export function getMergedPricing(): ProviderPricingMap {
  const merged = clonePricingMap(DEFAULT_MODEL_PRICING);
  const overrides = getPricingOverrides();
  for (const [provider, models] of Object.entries(overrides)) {
    if (!merged[provider]) merged[provider] = {};
    for (const [model, rate] of Object.entries(models)) {
      const base = merged[provider][model] ?? {
        input: FALLBACK_PRICING_RATE.input,
        output: FALLBACK_PRICING_RATE.output,
      };
      merged[provider][model] = {
        ...base,
        ...rate,
      };
    }
  }
  return merged;
}

export function validatePricingPatch(
  body: unknown,
): { ok: true; patch: Record<string, Record<string, Partial<ModelPricingRate>>> } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Invalid pricing data format' };
  }

  const entries = Object.entries(body as Record<string, unknown>);
  if (entries.length === 0) {
    return { ok: false, error: 'Pricing patch cannot be empty' };
  }

  const patch: Record<string, Record<string, Partial<ModelPricingRate>>> = {};
  for (const [provider, models] of entries) {
    if (!provider.trim() || !models || typeof models !== 'object' || Array.isArray(models)) {
      return { ok: false, error: `Invalid pricing for provider: ${provider}` };
    }
    patch[provider] = {};
    for (const [model, rate] of Object.entries(models as Record<string, unknown>)) {
      if (!model.trim() || !rate || typeof rate !== 'object' || Array.isArray(rate)) {
        return { ok: false, error: `Invalid pricing for model: ${provider}/${model}` };
      }
      const fieldEntries = Object.entries(rate as Record<string, unknown>);
      if (fieldEntries.length === 0) {
        return { ok: false, error: `Empty pricing object for model: ${provider}/${model}` };
      }
      const modelPatch: Partial<ModelPricingRate> = {};
      for (const [field, val] of fieldEntries) {
        if (!VALID_PRICING_FIELDS.includes(field as PricingField)) {
          return { ok: false, error: `Invalid pricing field: ${field} for ${provider}/${model}` };
        }
        if (typeof val !== 'number' || Number.isNaN(val) || !Number.isFinite(val) || val < 0) {
          return {
            ok: false,
            error: `Invalid pricing value for ${field} in ${provider}/${model}: must be a non-negative number`,
          };
        }
        modelPatch[field as PricingField] = val;
      }
      patch[provider][model] = modelPatch;
    }
  }

  return { ok: true, patch };
}

export function updatePricingOverrides(
  patch: Record<string, Record<string, Partial<ModelPricingRate>>>,
): ProviderPricingMap {
  const currentOverrides = getPricingOverrides();
  const defaults = DEFAULT_MODEL_PRICING;

  for (const [provider, models] of Object.entries(patch)) {
    if (!currentOverrides[provider]) currentOverrides[provider] = {};
    for (const [model, partialRate] of Object.entries(models)) {
      const existing = currentOverrides[provider][model] ?? defaults[provider]?.[model] ?? {
        input: FALLBACK_PRICING_RATE.input,
        output: FALLBACK_PRICING_RATE.output,
      };
      currentOverrides[provider][model] = {
        ...existing,
        ...partialRate,
      };
    }
  }

  setSetting(PRICING_OVERRIDES_SETTING_KEY, JSON.stringify(currentOverrides));
  return getMergedPricing();
}

export function resetPricingOverrides(provider?: string | null, model?: string | null): ProviderPricingMap {
  if (!provider) {
    setSetting(PRICING_OVERRIDES_SETTING_KEY, JSON.stringify({}));
    return getMergedPricing();
  }

  const currentOverrides = getPricingOverrides();
  if (currentOverrides[provider]) {
    if (model) {
      delete currentOverrides[provider][model];
      if (Object.keys(currentOverrides[provider]).length === 0) {
        delete currentOverrides[provider];
      }
    } else {
      delete currentOverrides[provider];
    }
    setSetting(PRICING_OVERRIDES_SETTING_KEY, JSON.stringify(currentOverrides));
  }

  return getMergedPricing();
}

export function resolveModelPricing(
  provider: string | undefined | null,
  model: string | undefined | null,
  pricingMap?: ProviderPricingMap,
): ModelPricingRate {
  const map = pricingMap ?? getMergedPricing();
  const normProvider = (provider ?? '').trim().toLowerCase();
  const rawModel = (model ?? '').trim();

  if (rawModel.toLowerCase().includes(':free') || rawModel.toLowerCase().startsWith('cline-free/')) {
    return { input: 0, output: 0, cached: 0, reasoning: 0, cache_creation: 0 };
  }

  if (normProvider && rawModel && map[normProvider]?.[rawModel]) {
    return map[normProvider][rawModel];
  }

  const slashIdx = rawModel.indexOf('/');
  const strippedModel = slashIdx >= 0 ? rawModel.slice(slashIdx + 1) : rawModel;
  const prefixProvider = slashIdx > 0 ? rawModel.slice(0, slashIdx).toLowerCase() : '';

  if (normProvider && strippedModel && map[normProvider]?.[strippedModel]) {
    return map[normProvider][strippedModel];
  }

  if (prefixProvider && strippedModel && map[prefixProvider]?.[strippedModel]) {
    return map[prefixProvider][strippedModel];
  }

  // Search across all providers for exact model match
  for (const models of Object.values(map)) {
    if (rawModel && models[rawModel]) return models[rawModel];
    if (strippedModel && models[strippedModel]) return models[strippedModel];
  }

  // Pattern fallback
  for (const { pattern, rate } of PATTERN_FALLBACKS) {
    if (pattern.test(rawModel) || pattern.test(strippedModel)) {
      return rate;
    }
  }

  // Provider-level average if provider exists in map
  if (normProvider && map[normProvider]) {
    const entries = Object.values(map[normProvider]);
    if (entries.length > 0) {
      const avgInput = entries.reduce((sum, e) => sum + e.input, 0) / entries.length;
      const avgOutput = entries.reduce((sum, e) => sum + e.output, 0) / entries.length;
      return { input: Number(avgInput.toFixed(4)), output: Number(avgOutput.toFixed(4)) };
    }
  }

  return FALLBACK_PRICING_RATE;
}

export function calculateRequestCost(
  provider: string | undefined | null,
  model: string | undefined | null,
  promptTokens: number,
  completionTokens: number,
  cachedTokens = 0,
  reasoningTokens = 0,
  pricingMap?: ProviderPricingMap,
): number {
  const rate = resolveModelPricing(provider, model, pricingMap);
  const safePrompt = Math.max(0, Number(promptTokens) || 0);
  const safeCompletion = Math.max(0, Number(completionTokens) || 0);
  const safeCached = Math.max(0, Number(cachedTokens) || 0);
  const safeReasoning = Math.max(0, Number(reasoningTokens) || 0);

  const nonCachedInput = Math.max(0, safePrompt - safeCached);
  const cachedRate = rate.cached ?? rate.input;
  const reasoningRate = rate.reasoning ?? rate.output;

  const cost =
    (nonCachedInput * rate.input) / 1_000_000 +
    (safeCached * cachedRate) / 1_000_000 +
    (safeCompletion * rate.output) / 1_000_000 +
    (safeReasoning * reasoningRate) / 1_000_000;

  return cost;
}
