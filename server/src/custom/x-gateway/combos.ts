export const COMBO_NAME_RE = /^[a-z0-9\-_.]{1,48}$/;
export const RESERVED_PREFIXES = ['auto:', 'combo:'];
export const RESERVED_NAMES = new Set(['auto']);
export const MAX_COMBOS = 50;
export const MAX_ENTRIES = 20;
export const MAX_COMBO_DESCRIPTION = 200;

/** How a combo walks its steps when the first one cannot serve a request. */
export type ComboStrategy = 'fallback' | 'round-robin' | 'smart' | 'fusion';

export const COMBO_STRATEGIES: readonly ComboStrategy[] = ['fallback', 'round-robin', 'smart', 'fusion'];
export const DEFAULT_COMBO_STRATEGY: ComboStrategy = 'fallback';

export function isComboStrategy(value: unknown): value is ComboStrategy {
  return typeof value === 'string' && (COMBO_STRATEGIES as readonly string[]).includes(value);
}

/** Unknown/absent values degrade to `fallback` instead of rejecting traffic. */
export function normalizeComboStrategy(value: unknown): ComboStrategy {
  return isComboStrategy(value) ? value : DEFAULT_COMBO_STRATEGY;
}

export interface ComboEntry {
  platform: string;
  modelId: string;
}

export interface ComboValidationError {
  error: string;
}

export function validateComboName(name: string): ComboValidationError | null {
  const lower = name.toLowerCase();
  if (!COMBO_NAME_RE.test(lower)) {
    return { error: 'Combo name must be 1-48 characters of a-z, 0-9, -, _, .' };
  }
  if (RESERVED_NAMES.has(lower)) {
    return { error: 'Combo name cannot be a reserved word' };
  }
  for (const prefix of RESERVED_PREFIXES) {
    if (lower.startsWith(prefix)) {
      return { error: `Combo name cannot start with "${prefix}"` };
    }
  }
  return null;
}

export function validateComboMeta(strategy: unknown, description: unknown): string | null {
  if (strategy !== undefined && !isComboStrategy(strategy)) {
    return `Strategy must be one of: ${COMBO_STRATEGIES.join(', ')}`;
  }
  if (description !== undefined) {
    if (typeof description !== 'string') return 'Description must be a string';
    if (description.trim().length > MAX_COMBO_DESCRIPTION) {
      return `Description must be at most ${MAX_COMBO_DESCRIPTION} characters`;
    }
  }
  return null;
}

export function validateComboEntries(entries: unknown): entries is ComboEntry[] {
  if (!Array.isArray(entries)) return false;
  if (entries.length < 1 || entries.length > MAX_ENTRIES) return false;
  const seen = new Set<string>();
  for (const e of entries) {
    if (!e || typeof e !== 'object') return false;
    const entry = e as Record<string, unknown>;
    if (typeof entry.platform !== 'string' || !entry.platform.trim()) return false;
    if (typeof entry.modelId !== 'string' || !entry.modelId.trim()) return false;
    const key = `${entry.platform}:${entry.modelId}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

export interface ValidateComboOptions {
  existingModelIds?: Iterable<string>;
  totalCombos?: number;
  strategy?: unknown;
  description?: unknown;
}

export function validateCombo(
  name: string,
  entries: unknown,
  opts?: ValidateComboOptions,
): { valid: true } | { valid: false; error: string } {
  if (typeof name !== 'string') {
    return { valid: false, error: 'Combo name must be a string' };
  }
  const lower = name.toLowerCase();
  const nameError = validateComboName(lower);
  if (nameError) {
    return { valid: false, error: nameError.error };
  }

  const metaError = validateComboMeta(opts?.strategy, opts?.description);
  if (metaError) {
    return { valid: false, error: metaError };
  }

  if (opts?.existingModelIds) {
    const ids = new Set(Array.from(opts.existingModelIds).map(id => id.toLowerCase()));
    if (ids.has(lower)) {
      return { valid: false, error: `Combo name cannot equal an existing model id: ${lower}` };
    }
  }

  if (opts?.totalCombos !== undefined && opts.totalCombos >= MAX_COMBOS) {
    return { valid: false, error: `Maximum limit of ${MAX_COMBOS} combos reached` };
  }

  if (!validateComboEntries(entries)) {
    if (!Array.isArray(entries)) {
      return { valid: false, error: 'Entries must be an array' };
    }
    if (entries.length < 1 || entries.length > MAX_ENTRIES) {
      return { valid: false, error: `Entries count must be between 1 and ${MAX_ENTRIES}` };
    }
    const seen = new Set<string>();
    for (const e of entries) {
      if (!e || typeof e !== 'object') {
        return { valid: false, error: 'Each entry must be an object with platform and modelId' };
      }
      const entry = e as Record<string, unknown>;
      if (typeof entry.platform !== 'string' || !entry.platform.trim() || typeof entry.modelId !== 'string' || !entry.modelId.trim()) {
        return { valid: false, error: 'Each entry must have non-empty platform and modelId strings' };
      }
      const key = `${entry.platform}:${entry.modelId}`;
      if (seen.has(key)) {
        return { valid: false, error: `Duplicate entry found: ${key}` };
      }
      seen.add(key);
    }
    return { valid: false, error: 'Invalid combo entries' };
  }

  return { valid: true };
}

/*
 * Round-robin cursor. Each `round-robin` combo remembers the step that served its
 * previous request and starts the next one there, so load rotates across steps
 * instead of always hammering the first healthy account. The cursor lives in
 * memory: a restart simply restarts the rotation, which is harmless.
 */
const rotationCursors = new Map<string, number>();

export function rotateComboEntries(name: string, entries: ComboEntry[]): ComboEntry[] {
  if (entries.length <= 1) return entries;
  const key = name.toLowerCase();
  const cursor = (rotationCursors.get(key) ?? 0) % entries.length;
  rotationCursors.set(key, (cursor + 1) % entries.length);
  if (cursor === 0) return entries;
  return [...entries.slice(cursor), ...entries.slice(0, cursor)];
}

export function resetComboRotation(name?: string): void {
  if (name === undefined) {
    rotationCursors.clear();
    return;
  }
  rotationCursors.delete(name.toLowerCase());
}

/*
 * Preset combos. The definitions below mirror the 9Router starter set and are
 * matched against the models of the accounts that are actually usable right
 * now, so generating presets never invents a route that cannot be served.
 */
export interface ComboPresetCandidate {
  platform: string;
  modelId: string;
  /** Account belongs to a free/free-tier provider or the model is marked free. */
  free?: boolean;
}

export interface ComboPreset {
  name: string;
  description: string;
  strategy: ComboStrategy;
  entries: ComboEntry[];
}

export const COMBO_PRESET_NAMES = ['coding-flagship', 'fast-autocomplete', 'reasoning-deep', 'free-fallback'] as const;

const NON_CHAT_MODEL_RE =
  /(image|imagen|dall-?e|flux|diffusion|sdxl|seedream|ideogram|recraft|nano-?banana|midjourney|wanx|veo|video|tts|speech|voice|whisper|transcri|embed|rerank|moderation|guard|audio|music|sonar|search|scrape|reader)/i;

const FREE_MODEL_RE = /\bfree\b/i;

function modelScore(modelId: string, rules: Array<[RegExp, number]>): number {
  let score = 0;
  for (const [pattern, weight] of rules) {
    if (pattern.test(modelId)) score = Math.max(score, weight);
  }
  return score;
}

interface ComboPresetDefinition {
  name: (typeof COMBO_PRESET_NAMES)[number];
  strategy: ComboStrategy;
  description: string;
  maxSteps: number;
  score: (candidate: ComboPresetCandidate) => number;
}

function isFreeCandidate(candidate: ComboPresetCandidate): boolean {
  return candidate.free === true || FREE_MODEL_RE.test(candidate.modelId);
}

const PRESET_DEFINITIONS: readonly ComboPresetDefinition[] = [
  {
    name: 'coding-flagship',
    strategy: 'fallback',
    description: 'Strongest coding models first, then progressively cheaper fallbacks.',
    maxSteps: 4,
    score: candidate => modelScore(candidate.modelId, [
      [/(claude[-_.]?(opus|sonnet)|claude-(4|5)\b)/i, 10],
      [/(gpt-5(\.\d)?|gpt-6|codex)/i, 9],
      [/(coder|kimi-k[23]|deepseek-v4|glm-5|qwen3-max)/i, 7],
      [/(gemini-(3|4)|grok-4)/i, 6],
    ]),
  },
  {
    name: 'fast-autocomplete',
    strategy: 'round-robin',
    description: 'Low-latency models for inline completion, rotated across providers.',
    maxSteps: 4,
    score: candidate => {
      if (/(opus|thinking|reason|ultra)/i.test(candidate.modelId)) return 0;
      return modelScore(candidate.modelId, [
        [/(flash|lite|mini|nano|haiku|highspeed|fast|turbo|instant|small)/i, 10],
        [/(gpt-oss|llama-3\.3|qwen3-32b|mimo)/i, 6],
      ]);
    },
  },
  {
    name: 'reasoning-deep',
    strategy: 'smart',
    description: 'Reasoning-first models ordered by recent latency and error rate.',
    maxSteps: 3,
    score: candidate => modelScore(candidate.modelId, [
      [/(thinking|reason|deepseek-r1|qwq|\bo[134]\b|o[134]-)/i, 10],
      [/(opus|sol|astra|gpt-6)/i, 9],
      [/(kimi-k[23]|deepseek-v4|glm-5|gemini-4|grok-4|pro\b|max\b)/i, 6],
    ]),
  },
  {
    name: 'free-fallback',
    strategy: 'fallback',
    description: 'Free-tier accounts first, so overflow traffic never bills a paid provider.',
    maxSteps: 5,
    score: candidate => {
      if (!isFreeCandidate(candidate)) return 0;
      return modelScore(candidate.modelId, [
        [/(flash|lite|mini|haiku|highspeed|fast|turbo|free)/i, 5],
        [/(gpt-oss|llama|qwen|glm|kimi|deepseek|mimo|gemini)/i, 3],
      ]) || 1;
    },
  },
];

/**
 * Build the preset combos that can be served by the given pool of models.
 * Presets without a single matching model are omitted, so callers only ever
 * persist routable combos. `platform:modelId` duplicates are dropped and each
 * preset prefers distinct model ids to maximise failover value.
 */
export function buildComboPresets(available: readonly ComboPresetCandidate[]): ComboPreset[] {
  const unique = new Map<string, ComboPresetCandidate>();
  for (const candidate of available) {
    if (!candidate.platform || !candidate.modelId) continue;
    if (NON_CHAT_MODEL_RE.test(candidate.modelId)) continue;
    const key = `${candidate.platform}:${candidate.modelId}`;
    if (!unique.has(key)) unique.set(key, candidate);
  }
  const pool = [...unique.values()];

  const presets: ComboPreset[] = [];
  for (const definition of PRESET_DEFINITIONS) {
    const ranked = pool
      .map(candidate => ({ candidate, score: definition.score(candidate) }))
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score);

    const seenModels = new Set<string>();
    const entries: ComboEntry[] = [];
    for (const { candidate } of ranked) {
      const modelKey = candidate.modelId.toLowerCase();
      if (seenModels.has(modelKey)) continue;
      seenModels.add(modelKey);
      entries.push({ platform: candidate.platform, modelId: candidate.modelId });
      if (entries.length >= definition.maxSteps) break;
    }

    if (entries.length > 0) {
      presets.push({
        name: definition.name,
        description: definition.description,
        strategy: definition.strategy,
        entries,
      });
    }
  }
  return presets;
}
