import { randomUUID } from 'node:crypto';
import type { ModelListPageInfo } from '@freellmapi/shared';
import { getDb } from '../db/index.js';
import { parseBudget } from '../lib/budget.js';
import { qualifiedModelMemberId } from '../lib/endpoint-scope.js';
import { countUsableKeysByPlatform } from './key-cache.js';
import { groupRows, getUnifyOverrides } from './model-groups.js';
import { overriddenFieldNames } from './model-state.js';
import { getAllPenalties, getRoutingScores, type ChainRow, type RoutingScore } from './router.js';
import { getCooldownCeilingMs, modelWindowUsage, modelWindowUsedFraction } from './ratelimit.js';
import { getDecisionRoutingStatus } from './routing-decision.js';

export const MODEL_PAGE_SIZE = 20;
const REUSE_MS = 30_000;
const RETAIN_MS = 5 * 60_000;
const MAX_SNAPSHOTS = 16;
type Db = ReturnType<typeof getDb>;
type IndexRow = ChainRow & {
  catalog_enabled: number; chain_priority: number | null; chain_enabled: number | null;
  catalog_priority: number | null; key_label: string | null; speed_rank: number;
  source: string; endpoint_group: string | null;
};
type Group = { key: string; label: string; canonicalId: string; members: IndexRow[]; rank: number; depleted: boolean };
export type ModelListSort = 'rank' | 'model' | 'reliability' | 'speed' | 'intelligence' | 'guardrails' | 'score' | 'on';
export interface ModelListSelection {
  profileId: number | null; search: string; vision: boolean; tools: boolean; context: number;
  sort?: ModelListSort; direction: 'asc' | 'desc'; offset: number; snapshot?: string;
}
type Snapshot = {
  id: string; at: number; touchedAt: number; profileId: number | null; groups: Group[];
  byId: Map<number, IndexRow>;
  endpointCollisions: Set<number>;
  scores: Map<number, RoutingScore>; keyCounts: Map<string, number>;
  routing: ReturnType<typeof getRoutingScores>;
  budgetRows: IndexRow[];
  tokenSummary: ModelListPageInfo['tokenSummary']; unconfiguredPlatforms: string[];
};
let caches = new WeakMap<Db, Map<string, Snapshot>>();

export function invalidateModelListPages(): void { caches = new WeakMap(); }

export class ModelListPageExpired extends Error {
  constructor() { super('The model list changed or expired. Reload the list to continue.'); }
}

function limits(row: IndexRow) {
  return { rpm: row.rpm_limit, rpd: row.rpd_limit, tpm: row.tpm_limit, tpd: null };
}
function identity(row: IndexRow) { return { platform: row.platform, modelId: row.model_id, keyId: row.key_id }; }

function buildSnapshot(db: Db, profileId: number | null, now: number): Snapshot {
  // Only identities, scoring/filter fields and priority. Overrides/tombstones and
  // other detail joins are deliberately deferred until the selected group page.
  const rows = db.prepare(`
    SELECT m.id AS model_db_id, m.platform, m.model_id, m.display_name,
           m.intelligence_rank, m.speed_rank, m.size_label, m.monthly_token_budget,
           m.rpm_limit, m.rpd_limit, m.tpm_limit, m.tpd_limit,
           m.supports_vision, m.supports_tools, m.context_window, m.key_id,
           m.endpoint_scope, m.source, m.enabled AS catalog_enabled, ak.label AS key_label,
           c.priority AS chain_priority, c.enabled AS chain_enabled,
           ${profileId == null ? 'c' : 'fc'}.priority AS catalog_priority,
           (SELECT k.group_label FROM api_keys k
             WHERE m.platform = 'custom' AND m.endpoint_scope != ''
               AND k.platform = 'custom' AND rtrim(k.base_url, '/') = m.endpoint_scope
               AND k.group_label IS NOT NULL ORDER BY k.id LIMIT 1) AS endpoint_group
      FROM models m
      LEFT JOIN ${profileId == null ? 'fallback_config c ON c.model_db_id = m.id' : 'profile_models c ON c.model_db_id = m.id AND c.profile_id = ?'}
      ${profileId == null ? '' : 'LEFT JOIN fallback_config fc ON fc.model_db_id = m.id'}
      LEFT JOIN api_keys ak ON ak.id = m.key_id
     ORDER BY m.id
  `).all(...(profileId == null ? [] : [profileId])) as IndexRow[];
  const enabled = rows.filter(r => r.catalog_enabled === 1 && (profileId != null || r.chain_priority != null));
  const named = enabled.filter(r => r.chain_priority != null);
  let tail = named.reduce((max, r) => Math.max(max, r.chain_priority ?? 0), 0);
  const unnamed = enabled.filter(r => r.chain_priority == null).sort((a, b) =>
    (a.catalog_priority ?? Infinity) - (b.catalog_priority ?? Infinity) || a.model_db_id - b.model_db_id);
  for (const row of unnamed) row.priority = ++tail;
  for (const row of enabled) {
    if (row.chain_priority != null) row.priority = row.chain_priority;
    row.enabled = row.chain_enabled ?? 0;
  }
  const routing = getRoutingScores(enabled, true);
  const scores = new Map(routing.scores.map(s => [s.modelDbId, s]));
  const keyCounts = countUsableKeysByPlatform(db);
  const configuredIds = new Set(enabled.filter(r => (keyCounts.get(r.platform) ?? 0) > 0).map(r => r.model_db_id));
  const endpoints = new Map<string, Set<string>>();
  for (const r of enabled) if (configuredIds.has(r.model_db_id) && (r.platform === 'custom' || r.key_id != null) && r.endpoint_scope) {
    const key = `${r.platform}\0${r.model_id}`;
    const scopes = endpoints.get(key) ?? new Set<string>();
    scopes.add(r.endpoint_scope); endpoints.set(key, scopes);
  }
  const endpointCollisions = new Set(enabled.filter(r =>
    configuredIds.has(r.model_db_id) && (endpoints.get(`${r.platform}\0${r.model_id}`)?.size ?? 0) > 1).map(r => r.model_db_id));
  const manual = routing.strategy === 'priority';
  // Group ALL catalog identities first, including disabled rows, so canonical
  // slug collisions keep exactly the same identity as the model detail page.
  const groups: Group[] = groupRows(rows, getUnifyOverrides()).map(g => {
    const members = (g.members as IndexRow[]).filter(m => configuredIds.has(m.model_db_id));
    members.sort((a, b) => manual ? a.priority - b.priority : (scores.get(b.model_db_id)?.score ?? 0) - (scores.get(a.model_db_id)?.score ?? 0));
    return {
      key: g.groupKey, label: g.groupLabel, canonicalId: g.canonicalId, members, rank: 0,
      depleted: members.length > 0 && members.every(m => (modelWindowUsedFraction(identity(m), limits(m), now) ?? 0) >= 1),
    };
  }).filter(g => g.members.length > 0);
  const priority = (g: Group) => Math.min(...g.members.map(m => m.priority));
  const score = (g: Group) => Math.max(...g.members.map(m => scores.get(m.model_db_id)?.score ?? 0));
  groups.sort((a, b) => (manual ? 0 : Number(a.depleted) - Number(b.depleted))
    || (manual ? priority(a) - priority(b) : score(b) - score(a)) || priority(a) - priority(b) || a.key.localeCompare(b.key));
  groups.forEach((g, i) => { g.rank = i + 1; });
  const budgetPlatforms = new Set((db.prepare('SELECT DISTINCT platform FROM api_keys WHERE enabled = 1').all() as { platform: string }[]).map(k => k.platform));
  const budgetRows = enabled.filter(r => budgetPlatforms.has(r.platform) && (profileId == null || r.chain_priority != null));
  let totalBudget = 0; let totalUsed = 0;
  for (const row of budgetRows) {
    totalBudget += parseBudget(row.monthly_token_budget) * Math.max(1, keyCounts.get(row.platform) ?? 0);
    totalUsed += scores.get(row.model_db_id)?.monthlyUsedTokens ?? 0;
  }
  return {
    id: randomUUID(), at: now, touchedAt: now, profileId, groups, scores, keyCounts, routing, budgetRows,
    byId: new Map(enabled.map(r => [r.model_db_id, r])),
    endpointCollisions,
    tokenSummary: { totalBudget, totalUsed },
    unconfiguredPlatforms: [...new Set(enabled.filter(r => !configuredIds.has(r.model_db_id)).map(r => r.platform))],
  };
}

function snapshotFor(selection: ModelListSelection, now: number): Snapshot {
  const db = getDb();
  let cache = caches.get(db);
  if (!cache) { cache = new Map(); caches.set(db, cache); }
  for (const [id, snap] of cache) if (now < snap.at || now - snap.touchedAt >= RETAIN_MS) cache.delete(id);
  if (selection.snapshot) {
    const found = cache.get(selection.snapshot);
    if (!found || found.profileId !== selection.profileId) throw new ModelListPageExpired();
    found.touchedAt = now;
    cache.delete(found.id); cache.set(found.id, found);
    return found;
  }
  for (const snap of [...cache.values()].reverse()) {
    if (snap.profileId === selection.profileId && now - snap.at < REUSE_MS) return snap;
  }
  const created = buildSnapshot(db, selection.profileId, now);
  cache.set(created.id, created);
  while (cache.size > MAX_SNAPSHOTS) cache.delete(cache.keys().next().value!);
  return created;
}

function sortValue(g: Group, col: ModelListSort, scores: Snapshot['scores']): string | number | null {
  const rows = g.members.map(m => scores.get(m.model_db_id)).filter((s): s is RoutingScore => !!s);
  const best = rows.reduce<RoutingScore | undefined>((prev, row) => !prev || row.score > prev.score ? row : prev, undefined);
  switch (col) {
    case 'rank': return g.rank;
    case 'model': return g.label.toLowerCase();
    case 'on': return Number(g.members.some(m => m.enabled === 1));
    case 'score': return best?.score ?? null;
    case 'guardrails': return (best?.headroom ?? 1) * (best?.rateLimit ?? 1);
    case 'intelligence': return rows.length ? Math.max(...rows.map(r => r.intelligence)) : null;
    case 'speed': case 'reliability': {
      const measured = rows.filter(r => r.totalRequests > 0);
      return measured.length ? Math.max(...measured.map(r => r[col])) : null;
    }
  }
}

export function readModelListBudget(profileId: number | null) {
  const snap = snapshotFor({ profileId, search: '', vision: false, tools: false, context: 0, direction: 'asc', offset: 0 }, Date.now());
  return {
    ...snap.tokenSummary,
    models: snap.budgetRows.slice().sort((a, b) => a.intelligence_rank - b.intelligence_rank || a.priority - b.priority).map(m => ({
      displayName: m.display_name, platform: m.platform, modelId: m.model_id, intelligenceRank: m.intelligence_rank,
      budget: parseBudget(m.monthly_token_budget) * Math.max(1, snap.keyCounts.get(m.platform) ?? 1),
      used: snap.scores.get(m.model_db_id)?.monthlyUsedTokens ?? 0,
    })),
  };
}

function selectedGroups(snap: Snapshot, selection: ModelListSelection) {
  const query = selection.search.trim().toLowerCase();
  const matching = snap.groups.filter(g => {
    if (selection.vision && !g.members.some(m => m.supports_vision)) return false;
    if (selection.tools && !g.members.some(m => m.supports_tools)) return false;
    if (selection.context && Math.max(...g.members.map(m => m.context_window ?? 0)) < selection.context) return false;
    return !query || [g.label, g.canonicalId, ...g.members.flatMap(m =>
      [m.platform, m.model_id, m.display_name, m.key_label ?? '', (m.endpoint_scope ?? '').replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/+$/, '')])]
      .join(' ').toLowerCase().includes(query);
  });
  if (selection.sort) matching.sort((a, b) => {
    const av = sortValue(a, selection.sort!, snap.scores); const bv = sortValue(b, selection.sort!, snap.scores);
    if (av === null || bv === null) return av === bv ? a.rank - b.rank : av === null ? 1 : -1;
    const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
    return (selection.direction === 'asc' ? cmp : -cmp) || a.rank - b.rank;
  });
  return matching;
}

function liveData(snap: Snapshot, selected: IndexRow[], now: number) {
  const selectedIds = new Set(selected.map(m => m.model_db_id));
  const { peakHours, ...routing } = snap.routing;
  return {
    tokenSummary: snap.tokenSummary,
    routing: {
      ...routing, scores: routing.scores.filter(s => selectedIds.has(s.modelDbId)),
      peakHoursAdjust: peakHours.enabled, peakStartHour: peakHours.startHour,
      peakEndHour: peakHours.endHour, peakTimezone: peakHours.timezone,
      cooldownCeilingMs: getCooldownCeilingMs(), decision: getDecisionRoutingStatus(),
    },
    rateLimitUsage: {
      generatedAtMs: now,
      rows: selected.map(original => {
        const m = snap.byId.get(original.model_db_id) ?? original;
        return { modelDbId: m.model_db_id, platform: m.platform, modelId: m.model_id,
          ...modelWindowUsage(identity(m), limits(m), now) };
      }),
    },
  };
}

/** One periodic request refreshes all groups explicitly opened by the user.
 * Their pinned order is retained; unseen groups never enter this response. */
export function readModelListLive(selection: ModelListSelection, count: number, now = Date.now()) {
  const pinned = snapshotFor(selection, now);
  const selected = selectedGroups(pinned, selection).slice(0, count).flatMap(g => g.members);
  const fresh = snapshotFor({ ...selection, snapshot: undefined, offset: 0 }, now);
  return liveData(fresh, selected, now);
}

export function readModelListPage(selection: ModelListSelection, now = Date.now()) {
  const snap = snapshotFor(selection, now);
  const matching = selectedGroups(snap, selection);
  const page = matching.slice(selection.offset, selection.offset + MODEL_PAGE_SIZE);
  const ids = page.flatMap(g => g.members.map(m => m.model_db_id));
  // The expensive joins only hydrate the requested 20 GROUPS, never the tail.
  const details = ids.length ? getDb().prepare(`
    SELECT m.id, mo.overrides_json, ts.source AS tombstone_source, ts.reason AS tombstone_reason
      FROM models m
      LEFT JOIN model_overrides mo ON mo.platform = m.platform AND mo.model_id = m.model_id
      LEFT JOIN catalog_model_tombstones ts ON ts.kind = 'chat' AND ts.platform = m.platform AND ts.model_id = m.model_id
     WHERE m.id IN (${ids.map(() => '?').join(',')})
  `).all(...ids) as Array<{ id: number; overrides_json: string | null; tombstone_source: string | null; tombstone_reason: string | null }> : [];
  const detailById = new Map(details.map(d => [d.id, d]));
  const penalties = new Map(getAllPenalties().map(p => [p.modelDbId, p]));
  const entries = page.flatMap(g => g.members.filter(r => detailById.has(r.model_db_id)).map(r => {
    const detail = detailById.get(r.model_db_id)!; const penalty = penalties.get(r.model_db_id);
    return {
      modelDbId: r.model_db_id, groupKey: g.key, groupLabel: g.label, canonicalId: g.canonicalId,
      priority: r.priority, effectivePriority: r.priority + (penalty?.penalty ?? 0),
      enabled: r.enabled === 1, penalty: penalty?.penalty ?? 0, rateLimitHits: penalty?.count ?? 0,
      platform: r.platform, modelId: r.model_id, displayName: r.display_name,
      intelligenceRank: r.intelligence_rank, speedRank: r.speed_rank, sizeLabel: r.size_label,
      rpmLimit: r.rpm_limit, rpdLimit: r.rpd_limit, tpmLimit: r.tpm_limit, tpdLimit: r.tpd_limit,
      contextWindow: r.context_window, monthlyTokenBudget: r.monthly_token_budget,
      monthlyTokenBudgetTokens: parseBudget(r.monthly_token_budget) * Math.max(1, snap.keyCounts.get(r.platform) ?? 1),
      supportsVision: r.supports_vision === 1, supportsTools: r.supports_tools === 1,
      source: r.platform === 'custom' || r.key_id != null ? 'custom' : r.source === 'discovered' ? 'discovered' : 'catalog',
      keyId: r.key_id, keyLabel: r.key_label, endpointScope: r.endpoint_scope || null,
      endpointCollision: snap.endpointCollisions.has(r.model_db_id),
      qualifiedModelId: qualifiedModelMemberId(r.platform, r.model_id, r.endpoint_scope),
      keyCount: snap.keyCounts.get(r.platform) ?? 0, hasOverrides: detail.overrides_json != null,
      overrideFields: overriddenFieldNames(detail.overrides_json),
      retiredUpstream: detail.tombstone_source === 'upstream_eol',
      retiredReason: detail.tombstone_source === 'upstream_eol' ? detail.tombstone_reason : null,
    };
  }));
  const info: ModelListPageInfo = {
    snapshot: snap.id, nextOffset: selection.offset + MODEL_PAGE_SIZE < matching.length ? selection.offset + MODEL_PAGE_SIZE : null,
    totalGroups: snap.groups.length, matchedGroups: matching.length,
    ranks: Object.fromEntries(page.map(g => [g.key, g.rank])),
    groupKeys: page.map(g => g.key),
    unconfiguredPlatforms: snap.unconfiguredPlatforms, tokenSummary: snap.tokenSummary,
  };
  return {
    ...info, entries, ...liveData(snap, page.flatMap(g => g.members), now),
  };
}
