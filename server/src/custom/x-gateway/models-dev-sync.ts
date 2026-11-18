import type {
  ModelsDevSyncResult,
  ModelsDevSyncStatus,
  SyncedModelSpecRecord,
} from '@freellmapi/shared/smart-routing-v2.js';
import { getDb, getSetting, setSetting } from '../../db/index.js';
import { assessProviderUrlWithPin, assertSafeHttpBaseUrlSync } from '../../lib/url-guard.js';
import { REASONING_EFFORT_ORDER } from './learned-caps.js';
import type { ModelPricingRate, ProviderPricingMap } from './pricing.js';

export const MODELS_DEV_API_URL = 'https://models.dev/api.json';
export const MODELS_DEV_ENABLED_SETTING_KEY = 'x_gateway_models_dev_sync_enabled';
export const MODELS_DEV_META_SETTING_KEY = 'x_gateway_models_dev_sync_meta';
export const DEFAULT_MODELS_DEV_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface RawModelsDevCost {
  input?: number;
  output?: number;
  reasoning?: number;
  cache_read?: number;
  cache_write?: number;
}

export interface RawModelsDevLimit {
  context?: number;
  input?: number;
  output?: number;
}

export interface RawModelsDevModalities {
  input?: string[];
  output?: string[];
}

export interface RawModelsDevReasoningOption {
  type?: string;
  values?: string[];
}

export interface RawModelsDevModel {
  id?: string;
  name?: string;
  family?: string;
  attachment?: boolean;
  reasoning?: boolean;
  reasoning_options?: RawModelsDevReasoningOption[];
  tool_call?: boolean;
  structured_output?: boolean;
  cost?: RawModelsDevCost;
  limit?: RawModelsDevLimit;
  modalities?: RawModelsDevModalities;
}

export interface RawModelsDevProvider {
  id?: string;
  name?: string;
  models?: Record<string, RawModelsDevModel>;
}

export type RawModelsDevCatalog = Record<string, RawModelsDevProvider>;

export const MODELS_DEV_PROVIDER_MAP: Readonly<Record<string, readonly string[]>> = {
  openai: ['openai', 'codex'],
  anthropic: ['anthropic', 'claude'],
  google: ['gemini', 'google'],
  'google-vertex': ['vertex', 'gemini'],
  'google-vertex-anthropic': ['vertex', 'anthropic', 'claude'],
  vertex_ai: ['vertex', 'gemini'],
  deepseek: ['deepseek'],
  groq: ['groq'],
  xai: ['xai'],
  mistral: ['mistral'],
  togetherai: ['together', 'openrouter'],
  together_ai: ['together', 'openrouter'],
  'fireworks-ai': ['fireworks'],
  fireworks: ['fireworks'],
  cerebras: ['cerebras'],
  cohere: ['cohere'],
  nvidia: ['nvidia'],
  nebius: ['nebius'],
  siliconflow: ['siliconflow'],
  huggingface: ['huggingface'],
  openrouter: ['openrouter'],
  perplexity: ['perplexity'],
  'github-copilot': ['github'],
  github: ['github'],
  alibaba: ['qwen', 'alibaba'],
  'alibaba-cn': ['qwen', 'alibaba'],
  zai: ['glm', 'zai'],
  moonshotai: ['kimi', 'moonshot'],
  'moonshotai-cn': ['kimi', 'moonshot'],
  moonshot: ['kimi', 'moonshot'],
  minimax: ['minimax'],
};

export function mapModelsDevProviderIds(providerId: string): string[] {
  const normalized = providerId.trim().toLowerCase();
  if (!normalized) return [];
  const mapped = MODELS_DEV_PROVIDER_MAP[normalized];
  return mapped ? [...mapped] : [normalized];
}

export function readModelsDevSyncEnvFlag(
  value: string | undefined = process.env.MODELS_DEV_SYNC_ENABLED,
): 'true' | 'false' | 'unset' {
  if (value == null) return 'unset';
  const normalized = value.trim().toLowerCase();
  if (!normalized) return 'unset';
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return 'true';
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return 'false';
  }
  return 'unset';
}

export function isModelsDevSyncEnvDisabled(): boolean {
  return readModelsDevSyncEnvFlag() === 'false';
}

export function isModelsDevSyncEnvForcedOn(): boolean {
  return readModelsDevSyncEnvFlag() === 'true';
}

function isTestRuntime(): boolean {
  return process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST);
}

export function isModelsDevSyncEnabled(): boolean {
  const envFlag = readModelsDevSyncEnvFlag();
  if (envFlag === 'false') return false;
  if (envFlag === 'true') return true;
  try {
    const raw = getSetting(MODELS_DEV_ENABLED_SETTING_KEY);
    if (raw === '1' || raw === 'true') return true;
    if (raw === '0' || raw === 'false') return false;
  } catch {
    return false;
  }
  return false;
}

export function setModelsDevSyncEnabled(enabled: boolean): boolean {
  setSetting(MODELS_DEV_ENABLED_SETTING_KEY, enabled ? 'true' : 'false');
  if (!enabled) {
    stopModelsDevPeriodicSync();
  } else if (!isModelsDevSyncEnvDisabled() && !isTestRuntime()) {
    startModelsDevPeriodicSync();
  }
  return isModelsDevSyncEnabled();
}

function extractEffortOptions(options: RawModelsDevReasoningOption[] | undefined): string[] | null {
  if (!Array.isArray(options)) return null;
  const values = options.flatMap(opt =>
    opt?.type === 'effort' && Array.isArray(opt.values) ? opt.values : [],
  );
  const filtered = values
    .filter((v): v is string => typeof v === 'string')
    .map(v => v.trim().toLowerCase())
    .filter(v => v.length > 0 && REASONING_EFFORT_ORDER.includes(v));
  return filtered.length > 0 ? [...new Set(filtered)] : null;
}

function finiteNonNegative(val: unknown): number | null {
  return typeof val === 'number' && Number.isFinite(val) && val >= 0 ? val : null;
}

function finitePositiveInt(val: unknown): number | null {
  return typeof val === 'number' && Number.isFinite(val) && val > 0 ? Math.trunc(val) : null;
}

export function transformModelsDevCatalog(
  raw: RawModelsDevCatalog,
  syncedAt = new Date().toISOString(),
): {
  records: SyncedModelSpecRecord[];
  providerCount: number;
} {
  const deduped = new Map<string, SyncedModelSpecRecord>();
  const providersSeen = new Set<string>();

  for (const [rawProviderId, providerEntry] of Object.entries(raw)) {
    if (!providerEntry || typeof providerEntry !== 'object' || !providerEntry.models) continue;
    const mappedProviders = mapModelsDevProviderIds(rawProviderId);
    if (mappedProviders.length === 0) continue;

    for (const [rawModelKey, model] of Object.entries(providerEntry.models)) {
      if (!model || typeof model !== 'object') continue;
      const modelId = (typeof model.id === 'string' && model.id.trim() ? model.id : rawModelKey).trim();
      if (!modelId) continue;

      const modalitiesInput = Array.isArray(model.modalities?.input)
        ? model.modalities!.input.filter((m): m is string => typeof m === 'string' && Boolean(m.trim())).map(m => m.trim().toLowerCase())
        : [];
      const modalitiesOutput = Array.isArray(model.modalities?.output)
        ? model.modalities!.output.filter((m): m is string => typeof m === 'string' && Boolean(m.trim())).map(m => m.trim().toLowerCase())
        : [];

      const hasVisualModality = [...modalitiesInput, ...modalitiesOutput].some(
        m => m.includes('image') || m.includes('video'),
      );
      const supportsVision = hasVisualModality
        ? true
        : typeof model.attachment === 'boolean'
          ? model.attachment
          : modalitiesInput.length > 0
            ? false
            : null;

      for (const provider of mappedProviders) {
        providersSeen.add(provider);
        const record: SyncedModelSpecRecord = {
          provider,
          modelId,
          displayName: typeof model.name === 'string' && model.name.trim() ? model.name.trim() : null,
          family: typeof model.family === 'string' && model.family.trim() ? model.family.trim() : null,
          contextWindow: finitePositiveInt(model.limit?.context),
          maxInputTokens: finitePositiveInt(model.limit?.input),
          maxOutputTokens: finitePositiveInt(model.limit?.output),
          modalitiesInput,
          modalitiesOutput,
          supportsTools: typeof model.tool_call === 'boolean' ? model.tool_call : null,
          supportsReasoning: typeof model.reasoning === 'boolean' ? model.reasoning : null,
          supportsVision,
          supportsStructuredOutput: typeof model.structured_output === 'boolean' ? model.structured_output : null,
          reasoningEfforts: extractEffortOptions(model.reasoning_options),
          inputCostPer1M: finiteNonNegative(model.cost?.input),
          outputCostPer1M: finiteNonNegative(model.cost?.output),
          cachedCostPer1M: finiteNonNegative(model.cost?.cache_read),
          reasoningCostPer1M: finiteNonNegative(model.cost?.reasoning),
          lastSyncedAt: syncedAt,
        };
        deduped.set(`${provider}::${modelId.toLowerCase()}`, record);
      }
    }
  }

  return {
    records: [...deduped.values()],
    providerCount: providersSeen.size,
  };
}

// ── SQLite Persistence & In-Memory Cache ─────────────────────────────────────

interface DbModelSpecRow {
  provider: string;
  model_id: string;
  display_name: string | null;
  family: string | null;
  context_window: number | null;
  max_input_tokens: number | null;
  max_output_tokens: number | null;
  modalities_input: string;
  modalities_output: string;
  supports_tools: number | null;
  supports_reasoning: number | null;
  supports_vision: number | null;
  supports_structured_output: number | null;
  reasoning_efforts: string | null;
  input_cost_per_1m: number | null;
  output_cost_per_1m: number | null;
  cached_cost_per_1m: number | null;
  reasoning_cost_per_1m: number | null;
  last_synced_at: string;
}

let specsCacheDb: unknown = null;
let specsByKey = new Map<string, SyncedModelSpecRecord>();
let specsByModelOnly = new Map<string, SyncedModelSpecRecord>();
let pricingMemo: ProviderPricingMap | null = null;
let syncGeneration = 0;

let periodicTimer: ReturnType<typeof setInterval> | null = null;
let activeIntervalMs = DEFAULT_MODELS_DEV_SYNC_INTERVAL_MS;
let lastRuntimeError: string | null = null;

export function getModelsDevSyncGeneration(): number {
  return syncGeneration;
}

function parseJsonStringArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === 'string' && v.length > 0)
      : [];
  } catch {
    return [];
  }
}

function dbBool(val: number | null): boolean | null {
  return val === 1 ? true : val === 0 ? false : null;
}

function rowToSpecRecord(row: DbModelSpecRow): SyncedModelSpecRecord {
  const efforts = parseJsonStringArray(row.reasoning_efforts);
  return {
    provider: row.provider,
    modelId: row.model_id,
    displayName: row.display_name ?? null,
    family: row.family ?? null,
    contextWindow: typeof row.context_window === 'number' ? row.context_window : null,
    maxInputTokens: typeof row.max_input_tokens === 'number' ? row.max_input_tokens : null,
    maxOutputTokens: typeof row.max_output_tokens === 'number' ? row.max_output_tokens : null,
    modalitiesInput: parseJsonStringArray(row.modalities_input),
    modalitiesOutput: parseJsonStringArray(row.modalities_output),
    supportsTools: dbBool(row.supports_tools),
    supportsReasoning: dbBool(row.supports_reasoning),
    supportsVision: dbBool(row.supports_vision),
    supportsStructuredOutput: dbBool(row.supports_structured_output),
    reasoningEfforts: efforts.length > 0 ? efforts : null,
    inputCostPer1M: typeof row.input_cost_per_1m === 'number' ? row.input_cost_per_1m : null,
    outputCostPer1M: typeof row.output_cost_per_1m === 'number' ? row.output_cost_per_1m : null,
    cachedCostPer1M: typeof row.cached_cost_per_1m === 'number' ? row.cached_cost_per_1m : null,
    reasoningCostPer1M: typeof row.reasoning_cost_per_1m === 'number' ? row.reasoning_cost_per_1m : null,
    lastSyncedAt: row.last_synced_at,
  };
}

function tryGetSpecsDb(): ReturnType<typeof getDb> | null {
  try {
    const db = getDb();
    const exists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'custom_models_dev_specs'")
      .get();
    return exists ? db : null;
  } catch {
    return null;
  }
}

function rebuildMemoryMaps(records: readonly SyncedModelSpecRecord[]): void {
  const nextByKey = new Map<string, SyncedModelSpecRecord>();
  const nextByModel = new Map<string, SyncedModelSpecRecord>();
  const nextPricing: ProviderPricingMap = {};

  for (const rec of records) {
    const prov = rec.provider.toLowerCase();
    const modLower = rec.modelId.toLowerCase();
    nextByKey.set(`${prov}::${modLower}`, rec);
    if (!nextByModel.has(modLower)) {
      nextByModel.set(modLower, rec);
    }
    if (rec.inputCostPer1M != null) {
      if (!nextPricing[prov]) nextPricing[prov] = {};
      const entry: ModelPricingRate = {
        input: rec.inputCostPer1M,
        output: rec.outputCostPer1M ?? 0,
      };
      if (rec.cachedCostPer1M != null) entry.cached = rec.cachedCostPer1M;
      if (rec.reasoningCostPer1M != null) entry.reasoning = rec.reasoningCostPer1M;
      nextPricing[prov][rec.modelId] = entry;
    }
  }

  specsByKey = nextByKey;
  specsByModelOnly = nextByModel;
  pricingMemo = nextPricing;
  syncGeneration += 1;
}

function ensureSpecsHydrated(): ReturnType<typeof getDb> | null {
  const db = tryGetSpecsDb();
  if (!db) return null;
  if (specsCacheDb === db) return db;

  specsCacheDb = db;
  const rows = db.prepare('SELECT * FROM custom_models_dev_specs').all() as DbModelSpecRow[];
  rebuildMemoryMaps(rows.map(rowToSpecRecord));
  return db;
}

export function saveSyncedModelSpecs(records: readonly SyncedModelSpecRecord[]): void {
  const db = tryGetSpecsDb();
  if (!db) {
    rebuildMemoryMaps(records);
    return;
  }

  const del = db.prepare('DELETE FROM custom_models_dev_specs');
  const ins = db.prepare(`
    INSERT INTO custom_models_dev_specs (
      provider, model_id, display_name, family, context_window, max_input_tokens, max_output_tokens,
      modalities_input, modalities_output, supports_tools, supports_reasoning, supports_vision,
      supports_structured_output, reasoning_efforts, input_cost_per_1m, output_cost_per_1m,
      cached_cost_per_1m, reasoning_cost_per_1m, last_synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    del.run();
    for (const rec of records) {
      ins.run(
        rec.provider.toLowerCase(),
        rec.modelId,
        rec.displayName,
        rec.family,
        rec.contextWindow,
        rec.maxInputTokens,
        rec.maxOutputTokens,
        JSON.stringify(rec.modalitiesInput),
        JSON.stringify(rec.modalitiesOutput),
        rec.supportsTools === null ? null : rec.supportsTools ? 1 : 0,
        rec.supportsReasoning === null ? null : rec.supportsReasoning ? 1 : 0,
        rec.supportsVision === null ? null : rec.supportsVision ? 1 : 0,
        rec.supportsStructuredOutput === null ? null : rec.supportsStructuredOutput ? 1 : 0,
        rec.reasoningEfforts ? JSON.stringify(rec.reasoningEfforts) : null,
        rec.inputCostPer1M,
        rec.outputCostPer1M,
        rec.cachedCostPer1M,
        rec.reasoningCostPer1M,
        rec.lastSyncedAt,
      );
    }
  });
  tx();
  specsCacheDb = db;
  rebuildMemoryMaps(records);
}

/**
 * Cached O(1) lookup for a synced `models.dev` model specification.
 * Respects the `MODELS_DEV_SYNC_ENABLED=0|false` hard kill-switch.
 */
export function getSyncedModelSpec(
  provider: string | null | undefined,
  modelId: string | null | undefined,
): SyncedModelSpecRecord | null {
  if (isModelsDevSyncEnvDisabled()) return null;
  ensureSpecsHydrated();

  const rawModel = (modelId ?? '').trim();
  if (!rawModel) return null;
  const prov = (provider ?? '').trim().toLowerCase();
  const modLower = rawModel.toLowerCase();

  if (prov) {
    const direct = specsByKey.get(`${prov}::${modLower}`);
    if (direct) return direct;
    const mapped = MODELS_DEV_PROVIDER_MAP[prov];
    if (mapped) {
      for (const alias of mapped) {
        const hit = specsByKey.get(`${alias}::${modLower}`);
        if (hit) return hit;
      }
    }
  }

  const slashIdx = modLower.indexOf('/');
  if (slashIdx > 0) {
    const prefix = modLower.slice(0, slashIdx);
    const stripped = modLower.slice(slashIdx + 1);
    if (prov) {
      const strippedHit = specsByKey.get(`${prov}::${stripped}`);
      if (strippedHit) return strippedHit;
    }
    const prefixHit = specsByKey.get(`${prefix}::${stripped}`);
    if (prefixHit) return prefixHit;
    const byStripped = specsByModelOnly.get(stripped);
    if (byStripped) return byStripped;
  }

  return specsByModelOnly.get(modLower) ?? null;
}

export function getModelsDevPricingMap(): ProviderPricingMap {
  if (isModelsDevSyncEnvDisabled()) return {};
  ensureSpecsHydrated();
  return pricingMemo ?? {};
}

export interface EffectiveModelCapabilities {
  contextWindow: number | null;
  maxOutputTokens: number | null;
  modalitiesInput: string[];
  modalitiesOutput: string[];
  supportsTools: boolean | null;
  supportsReasoning: boolean | null;
  supportsVision: boolean | null;
  reasoningEfforts: string[] | null;
  source: 'user_override' | 'models_dev' | 'builtin';
}

function readUserCustomModelCap(provider: string, modelId: string): Partial<EffectiveModelCapabilities> | null {
  try {
    const raw = getSetting('x_gateway_custom_model_caps');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const map = parsed as Record<string, unknown>;
    const provLower = provider.trim().toLowerCase();
    const modTrimmed = modelId.trim();
    const entry = map[`${provLower}/${modTrimmed}`]
      ?? map[`${provLower}:${modTrimmed}`]
      ?? map[modTrimmed];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const rec = entry as Record<string, unknown>;
    const out: Partial<EffectiveModelCapabilities> = {};
    if (typeof rec.contextWindow === 'number' && rec.contextWindow > 0) out.contextWindow = Math.trunc(rec.contextWindow);
    if (typeof rec.maxOutputTokens === 'number' && rec.maxOutputTokens > 0) out.maxOutputTokens = Math.trunc(rec.maxOutputTokens);
    if (Array.isArray(rec.modalitiesInput)) {
      out.modalitiesInput = rec.modalitiesInput.filter((x): x is string => typeof x === 'string');
    }
    if (Array.isArray(rec.modalitiesOutput)) {
      out.modalitiesOutput = rec.modalitiesOutput.filter((x): x is string => typeof x === 'string');
    }
    if (typeof rec.supportsTools === 'boolean') out.supportsTools = rec.supportsTools;
    if (typeof rec.supportsReasoning === 'boolean') out.supportsReasoning = rec.supportsReasoning;
    if (typeof rec.supportsVision === 'boolean') out.supportsVision = rec.supportsVision;
    if (Array.isArray(rec.reasoningEfforts)) {
      out.reasoningEfforts = rec.reasoningEfforts.filter((x): x is string => typeof x === 'string');
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * Resolve model capabilities strictly following priority order:
 *   1. User Override (`x_gateway_custom_model_caps`)
 *   2. Synced `models.dev` spec (`custom_models_dev_specs`)
 *   3. Builtin defaults
 */
export function resolveEffectiveModelCapabilities(
  provider: string,
  modelId: string,
  builtinDefaults?: Partial<Omit<EffectiveModelCapabilities, 'source'>>,
): EffectiveModelCapabilities {
  const userOverride = readUserCustomModelCap(provider, modelId);
  const synced = getSyncedModelSpec(provider, modelId);

  const source: EffectiveModelCapabilities['source'] = userOverride
    ? 'user_override'
    : synced
      ? 'models_dev'
      : 'builtin';

  return {
    contextWindow: userOverride?.contextWindow ?? synced?.contextWindow ?? builtinDefaults?.contextWindow ?? null,
    maxOutputTokens: userOverride?.maxOutputTokens ?? synced?.maxOutputTokens ?? builtinDefaults?.maxOutputTokens ?? null,
    modalitiesInput: userOverride?.modalitiesInput ?? synced?.modalitiesInput ?? builtinDefaults?.modalitiesInput ?? ['text'],
    modalitiesOutput: userOverride?.modalitiesOutput ?? synced?.modalitiesOutput ?? builtinDefaults?.modalitiesOutput ?? ['text'],
    supportsTools: userOverride?.supportsTools ?? synced?.supportsTools ?? builtinDefaults?.supportsTools ?? null,
    supportsReasoning: userOverride?.supportsReasoning ?? synced?.supportsReasoning ?? builtinDefaults?.supportsReasoning ?? null,
    supportsVision: userOverride?.supportsVision ?? synced?.supportsVision ?? builtinDefaults?.supportsVision ?? null,
    reasoningEfforts: userOverride?.reasoningEfforts ?? synced?.reasoningEfforts ?? builtinDefaults?.reasoningEfforts ?? null,
    source,
  };
}

// ── SSRF-Guarded Sync Execution ──────────────────────────────────────────────

interface PersistedSyncMeta {
  lastSyncAt: string | null;
  lastSyncModelCount: number;
  lastSyncProviderCount: number;
  lastError: string | null;
}

function readSyncMeta(): PersistedSyncMeta {
  try {
    const raw = getSetting(MODELS_DEV_META_SETTING_KEY);
    if (!raw) {
      return { lastSyncAt: null, lastSyncModelCount: 0, lastSyncProviderCount: 0, lastError: null };
    }
    const parsed = JSON.parse(raw) as Partial<PersistedSyncMeta>;
    return {
      lastSyncAt: typeof parsed.lastSyncAt === 'string' ? parsed.lastSyncAt : null,
      lastSyncModelCount: typeof parsed.lastSyncModelCount === 'number' ? parsed.lastSyncModelCount : 0,
      lastSyncProviderCount: typeof parsed.lastSyncProviderCount === 'number' ? parsed.lastSyncProviderCount : 0,
      lastError: typeof parsed.lastError === 'string' ? parsed.lastError : null,
    };
  } catch {
    return { lastSyncAt: null, lastSyncModelCount: 0, lastSyncProviderCount: 0, lastError: null };
  }
}

function writeSyncMeta(meta: PersistedSyncMeta): void {
  try {
    setSetting(MODELS_DEV_META_SETTING_KEY, JSON.stringify(meta));
  } catch {
    // Ignore when running without initialized DB.
  }
}

export interface SyncModelsDevOptions {
  dryRun?: boolean;
  url?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  resolveDns?: (hostname: string) => Promise<string[]>;
}

export async function syncModelsDevCatalog(opts?: SyncModelsDevOptions): Promise<ModelsDevSyncResult> {
  const dryRun = Boolean(opts?.dryRun);
  if (isModelsDevSyncEnvDisabled()) {
    const msg = 'models.dev sync is disabled by MODELS_DEV_SYNC_ENABLED';
    lastRuntimeError = msg;
    return {
      success: false,
      dryRun,
      modelCount: 0,
      providerCount: 0,
      syncedAt: null,
      error: msg,
    };
  }

  const targetUrl = (opts?.url ?? MODELS_DEV_API_URL).trim();
  try {
    // Synchronous scheme, credential, metadata, and private-literal guard first.
    assertSafeHttpBaseUrlSync(targetUrl, true);
    const parsedUrl = new URL(targetUrl);
    if (parsedUrl.protocol !== 'https:') {
      throw new Error('models.dev sync URL must use https protocol.');
    }

    const allowOfflineCanonicalTest =
      targetUrl === MODELS_DEV_API_URL
      && !opts?.resolveDns
      && isTestRuntime();

    const verdict = await assessProviderUrlWithPin(targetUrl, {
      blockPrivate: true,
      resolve: opts?.resolveDns,
      allowUnresolved: allowOfflineCanonicalTest,
    });
    if (!verdict.allowed) {
      throw new Error(`SSRF guard blocked models.dev URL: ${verdict.reason ?? 'disallowed target'}`);
    }

    const doFetch = opts?.fetchImpl ?? globalThis.fetch;
    const response = await doFetch(targetUrl, {
      method: 'GET',
      redirect: 'error',
      headers: { Accept: 'application/json' },
      signal: opts?.signal ?? AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      throw new Error(`models.dev fetch failed [${response.status}]: ${response.statusText}`);
    }

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('models.dev returned invalid JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('models.dev payload must be a JSON object');
    }

    const syncedAt = new Date().toISOString();
    const { records, providerCount } = transformModelsDevCatalog(
      parsed as RawModelsDevCatalog,
      syncedAt,
    );

    if (!dryRun) {
      saveSyncedModelSpecs(records);
      lastRuntimeError = null;
      writeSyncMeta({
        lastSyncAt: syncedAt,
        lastSyncModelCount: records.length,
        lastSyncProviderCount: providerCount,
        lastError: null,
      });
    }

    return {
      success: true,
      dryRun,
      modelCount: records.length,
      providerCount,
      syncedAt: dryRun ? null : syncedAt,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    lastRuntimeError = message;
    if (!dryRun) {
      const prev = readSyncMeta();
      writeSyncMeta({ ...prev, lastError: message });
    }
    return {
      success: false,
      dryRun,
      modelCount: 0,
      providerCount: 0,
      syncedAt: null,
      error: message,
    };
  }
}

export function getModelsDevSyncStatus(): ModelsDevSyncStatus {
  ensureSpecsHydrated();
  const meta = readSyncMeta();
  const storedCount = isModelsDevSyncEnvDisabled() ? 0 : specsByKey.size;
  return {
    enabled: isModelsDevSyncEnabled(),
    envOverride: readModelsDevSyncEnvFlag(),
    periodicActive: periodicTimer !== null,
    intervalMs: activeIntervalMs,
    lastSyncAt: meta.lastSyncAt,
    lastSyncModelCount: meta.lastSyncModelCount,
    lastSyncProviderCount: meta.lastSyncProviderCount,
    storedModelCount: storedCount,
    lastError: lastRuntimeError ?? meta.lastError,
  };
}

export function startModelsDevPeriodicSync(intervalMs = DEFAULT_MODELS_DEV_SYNC_INTERVAL_MS): boolean {
  if (isModelsDevSyncEnvDisabled()) return false;
  if (periodicTimer) return true;
  activeIntervalMs = Math.max(60_000, Math.trunc(intervalMs));
  periodicTimer = setInterval(() => {
    if (isModelsDevSyncEnvDisabled()) {
      stopModelsDevPeriodicSync();
      return;
    }
    void syncModelsDevCatalog();
  }, activeIntervalMs);
  if (typeof periodicTimer === 'object' && 'unref' in periodicTimer) {
    periodicTimer.unref?.();
  }
  return true;
}

export function stopModelsDevPeriodicSync(): void {
  if (periodicTimer) {
    clearInterval(periodicTimer);
    periodicTimer = null;
  }
}

export function clearModelsDevSyncedSpecs(): void {
  const db = tryGetSpecsDb();
  if (db) {
    db.prepare('DELETE FROM custom_models_dev_specs').run();
  }
  rebuildMemoryMaps([]);
  lastRuntimeError = null;
  writeSyncMeta({
    lastSyncAt: null,
    lastSyncModelCount: 0,
    lastSyncProviderCount: 0,
    lastError: null,
  });
}

export function resetModelsDevSyncForTests(): void {
  stopModelsDevPeriodicSync();
  clearModelsDevSyncedSpecs();
  specsCacheDb = null;
}
