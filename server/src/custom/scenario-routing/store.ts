import { getDb } from '../../db/index.js';
import { getUsableKeysForPlatform } from '../../services/key-cache.js';
import { customEndpointKeyIds } from '../../services/custom-endpoint.js';
import { parseModelScope, scopeAllows } from '../../lib/model-scope.js';
import {
  DEFAULT_LONG_CONTEXT_THRESHOLD,
  DEFAULT_SCENARIO_RULES,
  MAX_LONG_CONTEXT_THRESHOLD,
  MIN_LONG_CONTEXT_THRESHOLD,
  SCENARIO_IDS,
  SCENARIO_ROUTING_MODES,
  type IdeConnectionStatusDto,
  type ScenarioCatalogModelOption,
  type ScenarioId,
  type ScenarioRoutingMode,
  type ScenarioRoutingPolicyDto,
  type ScenarioRuleConfig,
  type ScenarioRulesMap,
  type ScenarioStatItem,
  type ScenarioTelemetrySummary,
} from '@freellmapi/shared/scenario-routing.js';

export class ScenarioRoutingError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

interface PolicyRow {
  id: number;
  user_id: number;
  key_id: number | null;
  enabled: number;
  long_context_threshold: number;
  rules_json: string;
  created_at: string;
  updated_at: string;
}

interface StatRow {
  scenario: string;
  hit_count: number;
  offloaded_count: number;
  total_tokens: number;
  estimated_tokens_saved: number;
  last_model: string | null;
  last_routed_mode: string | null;
  last_hit_at: string | null;
}

const VALID_MODES = new Set<string>(SCENARIO_ROUTING_MODES);
const VALID_SCENARIOS = new Set<string>(SCENARIO_IDS);

// Ephemeral in-memory verification ping map keyed by `${userId}:${keyId ?? 0}`
const recentVerifyPings = new Map<string, string>();

export function recordVerifyPing(userId: number, keyId: number | null): string {
  const iso = new Date().toISOString();
  recentVerifyPings.set(`${userId}:${keyId ?? 0}`, iso);
  recentVerifyPings.set(`${userId}:0`, iso);
  if (recentVerifyPings.size > 5_000) {
    const oldestKey = recentVerifyPings.keys().next().value;
    if (oldestKey) recentVerifyPings.delete(oldestKey);
  }
  return iso;
}

export function clearVerifyPingsForTests(): void {
  recentVerifyPings.clear();
}

export function normalizeThreshold(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return DEFAULT_LONG_CONTEXT_THRESHOLD;
  return Math.max(
    MIN_LONG_CONTEXT_THRESHOLD,
    Math.min(MAX_LONG_CONTEXT_THRESHOLD, Math.trunc(num)),
  );
}

function normalizeMode(raw: unknown, fallback: ScenarioRoutingMode): ScenarioRoutingMode {
  return typeof raw === 'string' && VALID_MODES.has(raw)
    ? (raw as ScenarioRoutingMode)
    : fallback;
}

export function cloneDefaultRules(): ScenarioRulesMap {
  return {
    background: { ...DEFAULT_SCENARIO_RULES.background },
    think: { ...DEFAULT_SCENARIO_RULES.think },
    longContext: { ...DEFAULT_SCENARIO_RULES.longContext },
    vision: { ...DEFAULT_SCENARIO_RULES.vision },
    webSearch: { ...DEFAULT_SCENARIO_RULES.webSearch },
    default: { ...DEFAULT_SCENARIO_RULES.default },
  };
}

export function parseScenarioRulesJson(raw: string | null | undefined): ScenarioRulesMap {
  const base = cloneDefaultRules();
  if (!raw) return base;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return base;
    for (const id of SCENARIO_IDS) {
      const entry = parsed[id];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const obj = entry as Record<string, unknown>;
      const def = DEFAULT_SCENARIO_RULES[id];
      const modelStr =
        typeof obj.targetModel === 'string' ? obj.targetModel.trim() : '';
      base[id] = {
        enabled: typeof obj.enabled === 'boolean' ? obj.enabled : def.enabled,
        targetMode: normalizeMode(obj.targetMode, def.targetMode),
        targetModel: modelStr.length > 0 ? modelStr.slice(0, 160) : null,
        overrideExplicitModel:
          typeof obj.overrideExplicitModel === 'boolean'
            ? obj.overrideExplicitModel
            : def.overrideExplicitModel,
      };
    }
    return base;
  } catch {
    return base;
  }
}

function rowToPolicyDto(row: PolicyRow): ScenarioRoutingPolicyDto {
  return {
    id: row.id,
    userId: row.user_id,
    keyId: row.key_id ?? null,
    enabled: Boolean(row.enabled),
    longContextThreshold: normalizeThreshold(row.long_context_threshold),
    rules: parseScenarioRulesJson(row.rules_json),
    updatedAt: row.updated_at,
  };
}

export function defaultPolicyDto(userId: number, keyId: number | null = null): ScenarioRoutingPolicyDto {
  return {
    id: null,
    userId,
    keyId,
    // Account-level scenario routing is opt-in or pre-seeded with smart defaults;
    // when no row exists yet, `enabled` defaults to false so legacy traffic never changes unexpectedly
    // until the user saves/enables their Scenario Policy!
    enabled: false,
    longContextThreshold: DEFAULT_LONG_CONTEXT_THRESHOLD,
    rules: cloneDefaultRules(),
    updatedAt: null,
  };
}

export function assertUserOwnsKey(userId: number, keyId: number): { id: number; name: string; keyPrefix: string } {
  const db = getDb();
  const row = db
    .prepare(
      'SELECT id, name, key_prefix FROM user_api_keys WHERE id = ? AND user_id = ? AND revoked = 0',
    )
    .get(keyId, userId) as { id: number; name: string; key_prefix: string } | undefined;
  if (!row) {
    throw new ScenarioRoutingError(
      404,
      'key_not_found',
      'Active personal API key not found for your account.',
    );
  }
  return { id: row.id, name: row.name, keyPrefix: row.key_prefix };
}

export function getAccountScenarioPolicy(userId: number): ScenarioRoutingPolicyDto {
  const db = getDb();
  const row = db
    .prepare(
      'SELECT * FROM custom_scenario_routing_policies WHERE user_id = ? AND key_id IS NULL LIMIT 1',
    )
    .get(userId) as PolicyRow | undefined;
  return row ? rowToPolicyDto(row) : defaultPolicyDto(userId, null);
}

export function listKeyScenarioPolicies(userId: number): ScenarioRoutingPolicyDto[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT p.*
       FROM custom_scenario_routing_policies p
       JOIN user_api_keys k ON k.id = p.key_id AND k.user_id = p.user_id AND k.revoked = 0
       WHERE p.user_id = ? AND p.key_id IS NOT NULL
       ORDER BY p.key_id DESC`,
    )
    .all(userId) as PolicyRow[];
  return rows.map(rowToPolicyDto);
}

/**
 * Resolves the effective policy for an incoming inference request:
 * 1. Active per-key policy (`keyId` match) if saved
 * 2. Else account-wide default policy (`key_id IS NULL`) if saved
 * 3. Else null (inactive)
 */
export function resolveEffectiveScenarioPolicy(
  userId: number,
  keyId?: number | null,
): ScenarioRoutingPolicyDto | null {
  const db = getDb();
  if (keyId && keyId > 0) {
    const keyRow = db
      .prepare(
        'SELECT * FROM custom_scenario_routing_policies WHERE user_id = ? AND key_id = ? LIMIT 1',
      )
      .get(userId, keyId) as PolicyRow | undefined;
    if (keyRow) {
      const dto = rowToPolicyDto(keyRow);
      return dto.enabled ? dto : null;
    }
  }
  const userRow = db
    .prepare(
      'SELECT * FROM custom_scenario_routing_policies WHERE user_id = ? AND key_id IS NULL LIMIT 1',
    )
    .get(userId) as PolicyRow | undefined;
  if (!userRow) return null;
  const dto = rowToPolicyDto(userRow);
  return dto.enabled ? dto : null;
}

export interface UpsertScenarioPolicyInput {
  keyId?: number | null;
  enabled: boolean;
  longContextThreshold?: number;
  rules?: Partial<Record<ScenarioId, Partial<ScenarioRuleConfig>>>;
}

export function upsertScenarioPolicy(
  userId: number,
  input: UpsertScenarioPolicyInput,
): ScenarioRoutingPolicyDto {
  const db = getDb();
  const keyId = input.keyId !== undefined && input.keyId !== null ? Number(input.keyId) : null;
  if (keyId !== null) {
    if (!Number.isInteger(keyId) || keyId <= 0) {
      throw new ScenarioRoutingError(400, 'invalid_key_id', 'Invalid personal API key ID.');
    }
    assertUserOwnsKey(userId, keyId);
  }

  const existing = keyId === null
    ? (db
        .prepare(
          'SELECT * FROM custom_scenario_routing_policies WHERE user_id = ? AND key_id IS NULL LIMIT 1',
        )
        .get(userId) as PolicyRow | undefined)
    : (db
        .prepare(
          'SELECT * FROM custom_scenario_routing_policies WHERE user_id = ? AND key_id = ? LIMIT 1',
        )
        .get(userId, keyId) as PolicyRow | undefined);

  const mergedRules = existing ? parseScenarioRulesJson(existing.rules_json) : cloneDefaultRules();
  if (input.rules && typeof input.rules === 'object') {
    for (const id of SCENARIO_IDS) {
      const patch = input.rules[id];
      if (!patch || typeof patch !== 'object') continue;
      const cur = mergedRules[id];
      const nextModel =
        patch.targetModel === null
          ? null
          : typeof patch.targetModel === 'string'
            ? patch.targetModel.trim().slice(0, 160) || null
            : cur.targetModel;
      mergedRules[id] = {
        enabled: typeof patch.enabled === 'boolean' ? patch.enabled : cur.enabled,
        targetMode:
          patch.targetMode !== undefined ? normalizeMode(patch.targetMode, cur.targetMode) : cur.targetMode,
        targetModel: nextModel,
        overrideExplicitModel:
          typeof patch.overrideExplicitModel === 'boolean'
            ? patch.overrideExplicitModel
            : cur.overrideExplicitModel,
      };
    }
  }

  const threshold =
    input.longContextThreshold !== undefined
      ? normalizeThreshold(input.longContextThreshold)
      : existing
        ? normalizeThreshold(existing.long_context_threshold)
        : DEFAULT_LONG_CONTEXT_THRESHOLD;
  const enabledInt = input.enabled ? 1 : 0;
  const rulesJson = JSON.stringify(mergedRules);

  if (existing) {
    db.prepare(
      `UPDATE custom_scenario_routing_policies
       SET enabled = ?, long_context_threshold = ?, rules_json = ?, updated_at = datetime('now')
       WHERE id = ? AND user_id = ?`,
    ).run(enabledInt, threshold, rulesJson, existing.id, userId);
    const updated = db
      .prepare('SELECT * FROM custom_scenario_routing_policies WHERE id = ?')
      .get(existing.id) as PolicyRow;
    return rowToPolicyDto(updated);
  }

  const inserted = db
    .prepare(
      `INSERT INTO custom_scenario_routing_policies
       (user_id, key_id, enabled, long_context_threshold, rules_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    )
    .run(userId, keyId, enabledInt, threshold, rulesJson);

  const created = db
    .prepare('SELECT * FROM custom_scenario_routing_policies WHERE id = ?')
    .get(inserted.lastInsertRowid) as PolicyRow;
  return rowToPolicyDto(created);
}

export function deleteKeyScenarioPolicy(userId: number, keyId: number): boolean {
  const db = getDb();
  const res = db
    .prepare('DELETE FROM custom_scenario_routing_policies WHERE user_id = ? AND key_id = ?')
    .run(userId, keyId);
  return res.changes > 0;
}

/**
 * Checks whether a candidate `targetModel` exists, is enabled, has at least one
 * usable provider key right now, and satisfies request capabilities (vision, context window).
 * Guarantees safe fallback to tier routing when a configured targetModel is unavailable!
 */
export function isRoutableScenarioTargetModel(
  modelId: string | null | undefined,
  constraints?: {
    requireVision?: boolean;
    minContextTokens?: number;
  },
): boolean {
  const clean = modelId?.trim();
  if (!clean) return false;
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, platform, model_id, supports_vision, context_window, key_id
       FROM models
       WHERE model_id = ? AND enabled = 1`,
    )
    .all(clean) as Array<{
    id: number;
    platform: string;
    model_id: string;
    supports_vision: number;
    context_window: number | null;
    key_id: number | null;
  }>;

  if (rows.length === 0) return false;

  for (const row of rows) {
    if (constraints?.requireVision && !row.supports_vision) continue;
    if (
      constraints?.minContextTokens &&
      row.context_window !== null &&
      row.context_window < constraints.minContextTokens
    ) {
      continue;
    }
    const keys = getUsableKeysForPlatform(row.platform, db);
    if (keys.length === 0) continue;
    const endpointKeys =
      row.platform === 'custom' && row.key_id !== null
        ? customEndpointKeyIds(db, row.key_id)
        : null;
    const hasScopedKey = keys.some(
      (k) =>
        (!endpointKeys || endpointKeys.has(k.id)) &&
        scopeAllows(parseModelScope(k.model_scope_json), row.model_id),
    );
    if (hasScopedKey) return true;
  }

  return false;
}

export function listRoutableCatalogModelsForScenarioUi(): ScenarioCatalogModelOption[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT platform, model_id, display_name, size_label, context_window, supports_vision, supports_tools, key_id
       FROM models
       WHERE enabled = 1
       ORDER BY intelligence_rank ASC, id ASC`,
    )
    .all() as Array<{
    platform: string;
    model_id: string;
    display_name: string;
    size_label: string;
    context_window: number | null;
    supports_vision: number;
    supports_tools: number;
    key_id: number | null;
  }>;

  const seen = new Set<string>();
  const result: ScenarioCatalogModelOption[] = [];
  for (const row of rows) {
    if (seen.has(row.model_id)) continue;
    const keys = getUsableKeysForPlatform(row.platform, db);
    if (keys.length === 0) continue;
    const endpointKeys =
      row.platform === 'custom' && row.key_id !== null
        ? customEndpointKeyIds(db, row.key_id)
        : null;
    const usable = keys.some(
      (k) =>
        (!endpointKeys || endpointKeys.has(k.id)) &&
        scopeAllows(parseModelScope(k.model_scope_json), row.model_id),
    );
    if (!usable) continue;
    seen.add(row.model_id);
    result.push({
      modelId: row.model_id,
      displayName: row.display_name || row.model_id,
      platform: row.platform,
      sizeLabel: row.size_label || 'Medium',
      contextWindow: row.context_window ?? null,
      supportsVision: Boolean(row.supports_vision),
      supportsTools: Boolean(row.supports_tools),
    });
    if (result.length >= 60) break;
  }
  return result;
}

export function recordScenarioRoutingHit(params: {
  userId: number;
  keyId?: number | null;
  scenario: ScenarioId;
  routedMode: ScenarioRoutingMode;
  routedModel: string | null;
  totalTokens: number;
  offloadedToEco: boolean;
}): void {
  if (!VALID_SCENARIOS.has(params.scenario)) return;
  try {
    const db = getDb();
    const keyVal = params.keyId && params.keyId > 0 ? params.keyId : 0;
    const tokens = Math.max(0, Math.trunc(params.totalTokens || 0));
    const saved = params.offloadedToEco ? Math.max(tokens, 120) : 0;
    const offloadedInc = params.offloadedToEco ? 1 : 0;

    db.prepare(
      `INSERT INTO custom_scenario_routing_stats
       (user_id, key_id, scenario, hit_count, offloaded_count, total_tokens, estimated_tokens_saved, last_model, last_routed_mode, last_hit_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(user_id, key_id, scenario) DO UPDATE SET
         hit_count = custom_scenario_routing_stats.hit_count + 1,
         offloaded_count = custom_scenario_routing_stats.offloaded_count + excluded.offloaded_count,
         total_tokens = custom_scenario_routing_stats.total_tokens + excluded.total_tokens,
         estimated_tokens_saved = custom_scenario_routing_stats.estimated_tokens_saved + excluded.estimated_tokens_saved,
         last_model = COALESCE(excluded.last_model, custom_scenario_routing_stats.last_model),
         last_routed_mode = excluded.last_routed_mode,
         last_hit_at = datetime('now')`,
    ).run(
      params.userId,
      keyVal,
      params.scenario,
      offloadedInc,
      tokens,
      saved,
      params.routedModel ?? null,
      params.routedMode,
    );
  } catch {
    // Telemetry is best-effort and must never fail inference responses.
  }
}

export function getUserScenarioTelemetry(
  userId: number,
  keyId?: number | null,
): ScenarioTelemetrySummary {
  const db = getDb();
  const rows = (
    keyId && keyId > 0
      ? db
          .prepare(
            `SELECT scenario,
                    SUM(hit_count) AS hit_count,
                    SUM(offloaded_count) AS offloaded_count,
                    SUM(total_tokens) AS total_tokens,
                    SUM(estimated_tokens_saved) AS estimated_tokens_saved,
                    MAX(last_model) AS last_model,
                    MAX(last_routed_mode) AS last_routed_mode,
                    MAX(last_hit_at) AS last_hit_at
             FROM custom_scenario_routing_stats
             WHERE user_id = ? AND key_id = ?
             GROUP BY scenario`,
          )
          .all(userId, keyId)
      : db
          .prepare(
            `SELECT scenario,
                    SUM(hit_count) AS hit_count,
                    SUM(offloaded_count) AS offloaded_count,
                    SUM(total_tokens) AS total_tokens,
                    SUM(estimated_tokens_saved) AS estimated_tokens_saved,
                    MAX(last_model) AS last_model,
                    MAX(last_routed_mode) AS last_routed_mode,
                    MAX(last_hit_at) AS last_hit_at
             FROM custom_scenario_routing_stats
             WHERE user_id = ?
             GROUP BY scenario`,
          )
          .all(userId)
  ) as StatRow[];

  const byScenario = {} as Record<ScenarioId, ScenarioStatItem>;
  for (const id of SCENARIO_IDS) {
    byScenario[id] = {
      scenario: id,
      hitCount: 0,
      offloadedCount: 0,
      totalTokens: 0,
      estimatedTokensSaved: 0,
      lastModel: null,
      lastRoutedMode: null,
      lastHitAt: null,
    };
  }

  let totalHits = 0;
  let totalOffloadedHits = 0;
  let totalTokens = 0;
  let estimatedTokensSaved = 0;

  for (const row of rows) {
    if (!VALID_SCENARIOS.has(row.scenario)) continue;
    const id = row.scenario as ScenarioId;
    const item: ScenarioStatItem = {
      scenario: id,
      hitCount: Number(row.hit_count ?? 0),
      offloadedCount: Number(row.offloaded_count ?? 0),
      totalTokens: Number(row.total_tokens ?? 0),
      estimatedTokensSaved: Number(row.estimated_tokens_saved ?? 0),
      lastModel: row.last_model ?? null,
      lastRoutedMode: row.last_routed_mode ?? null,
      lastHitAt: row.last_hit_at ?? null,
    };
    byScenario[id] = item;
    totalHits += item.hitCount;
    totalOffloadedHits += item.offloadedCount;
    totalTokens += item.totalTokens;
    estimatedTokensSaved += item.estimatedTokensSaved;
  }

  return {
    totalHits,
    totalOffloadedHits,
    totalTokens,
    estimatedTokensSaved,
    byScenario,
  };
}

export function getIdeConnectionStatus(
  userId: number,
  gatewayBaseUrl: string,
  keyId?: number | null,
): IdeConnectionStatusDto {
  const db = getDb();
  let keyRow:
    | { id: number; name: string; key_prefix: string; last_used_at: string | null }
    | undefined;

  if (keyId && keyId > 0) {
    keyRow = db
      .prepare(
        'SELECT id, name, key_prefix, last_used_at FROM user_api_keys WHERE id = ? AND user_id = ? AND revoked = 0',
      )
      .get(keyId, userId) as typeof keyRow;
  } else {
    keyRow = db
      .prepare(
        'SELECT id, name, key_prefix, last_used_at FROM user_api_keys WHERE user_id = ? AND revoked = 0 ORDER BY COALESCE(last_used_at, created_at) DESC, id DESC LIMIT 1',
      )
      .get(userId) as typeof keyRow;
  }

  const recentReqRow = db
    .prepare(
      `SELECT COUNT(*) AS cnt, MAX(created_at) AS lastTs
       FROM requests
       WHERE user_id = ?
         AND created_at >= datetime('now', '-5 minutes')`,
    )
    .get(userId) as { cnt: number; lastTs: string | null } | undefined;

  const recentRequests5m = Number(recentReqRow?.cnt ?? 0);
  const lastInferenceAt = recentReqRow?.lastTs ?? keyRow?.last_used_at ?? null;
  const pingKey = `${userId}:${keyRow?.id ?? 0}`;
  const pingIso = recentVerifyPings.get(pingKey) ?? recentVerifyPings.get(`${userId}:0`) ?? null;

  const pingRecent =
    pingIso !== null && Date.now() - Date.parse(pingIso) <= 10 * 60 * 1000;

  let keyUsedRecently = false;
  if (keyRow?.last_used_at) {
    const parsedTs = Date.parse(
      keyRow.last_used_at.includes('T')
        ? keyRow.last_used_at
        : `${keyRow.last_used_at.replace(' ', 'T')}Z`,
    );
    if (Number.isFinite(parsedTs) && Date.now() - parsedTs <= 5 * 60 * 1000) {
      keyUsedRecently = true;
    }
  }

  const verifiedVia: IdeConnectionStatusDto['verifiedVia'] = pingRecent
    ? 'verify_ping'
    : recentRequests5m > 0 || keyUsedRecently
      ? 'recent_inference'
      : 'none';

  return {
    connected: verifiedVia !== 'none',
    verifiedVia,
    keyId: keyRow?.id ?? null,
    keyName: keyRow?.name ?? null,
    keyPrefix: keyRow?.key_prefix ?? null,
    lastVerifiedAt: pingIso,
    lastInferenceAt,
    recentRequests5m,
    gatewayBaseUrl,
  };
}
