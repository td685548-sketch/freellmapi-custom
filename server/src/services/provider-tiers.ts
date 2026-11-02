import { createHash } from 'node:crypto';
import type { ProviderTier, ProviderTierRange, ProviderTierRow, ProviderTiersResponse } from '@freellmapi/shared/provider-tiers.js';
import { getDb } from '../db/index.js';
import { providerDisplayName } from '../lib/provider-identity.js';
import { BANDIT_PRESETS, expectedReliability, intelligenceComposite, intelligenceScore, speedScore, TIER_VALUE } from './scoring.js';

export const PROVIDER_TIER_MIN_SAMPLES = 20;

export function tierForScore(score: number | null, samples: number): ProviderTier | null {
  if (score === null || samples < PROVIDER_TIER_MIN_SAMPLES) return null;
  if (score >= .85) return 'S';
  if (score >= .75) return 'A';
  if (score >= .65) return 'B';
  if (score >= .5) return 'C';
  return 'D';
}

interface Observation {
  platform: string; scope: string; model_id: string; size_label: string | null; intelligence_rank: number | null;
  samples: number; successes: number; output_tokens: number; latency_ms: number; ttfb_ms: number | null;
}

// Explicit metadata only. Never load/decrypt key material to render analytics.
export function providerTiers(range: ProviderTierRange): ProviderTiersResponse {
  const db = getDb();
  const days = { '24h': 1, '7d': 7, '30d': 30, '90d': 90, all: 0 }[range];
  const since = days === 0 ? '0000-01-01 00:00:00'
    : new Date(Date.now() - days * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  const keys = db.prepare(`SELECT platform,
    CASE WHEN platform = 'custom' THEN COALESCE(rtrim(trim(base_url), '/'), '') ELSE '' END AS scope,
    COUNT(*) AS linked,
    SUM(CASE WHEN enabled = 1 AND status IN ('healthy', 'unknown') THEN 1 ELSE 0 END) AS usable
    FROM api_keys GROUP BY platform, scope`).all() as Array<{ platform: string; scope: string; linked: number; usable: number }>;
  const observations = db.prepare(`SELECT r.platform,
    CASE WHEN r.platform = 'custom'
      THEN COALESCE(NULLIF(rtrim(trim(m.endpoint_scope), '/'), ''), rtrim(trim(k.base_url), '/'), '')
      ELSE '' END AS scope,
    r.model_id, m.size_label, m.intelligence_rank,
    COUNT(*) AS samples,
    SUM(CASE WHEN r.status = 'success' THEN 1 ELSE 0 END) AS successes,
    SUM(CASE WHEN r.status = 'success' AND r.output_tokens > 0 AND r.latency_ms > 0 THEN r.output_tokens ELSE 0 END) AS output_tokens,
    SUM(CASE WHEN r.status = 'success' AND r.output_tokens > 0 AND r.latency_ms > 0 THEN r.latency_ms ELSE 0 END) AS latency_ms,
    AVG(CASE WHEN r.status = 'success' AND r.ttfb_ms > 0 THEN r.ttfb_ms END) AS ttfb_ms
    FROM requests r
    LEFT JOIN api_keys k ON k.id = r.key_id
    LEFT JOIN models m ON m.id = r.model_db_id
    WHERE r.created_at >= ? AND r.request_type = 'chat' AND r.status IN ('success', 'error')
      AND r.key_id IS NOT NULL
    GROUP BY r.platform, scope, r.model_id, m.size_label, m.intelligence_rank`).all(since) as Observation[];

  const composite = (r: Observation): number | null => r.size_label && Object.hasOwn(TIER_VALUE, r.size_label)
    && r.intelligence_rank !== null ? intelligenceComposite(r.size_label, r.intelligence_rank) : null;
  const known = observations.flatMap(r => { const c = composite(r); return c === null ? [] : [c]; });
  const min = known.length ? Math.min(...known) : 0;
  const max = known.length ? Math.max(...known) : 0;
  const groups = new Map<string, { row: ProviderTierRow; observations: Observation[] }>();
  function ensure(platform: string, scope: string) {
    const identity = JSON.stringify([platform, scope]);
    let group = groups.get(identity);
    if (!group) {
      group = {
        row: {
          providerId: platform === 'custom' ? `custom:${createHash('sha256').update(scope).digest('hex').slice(0, 20)}` : platform,
          platform, name: providerDisplayName(platform, scope), linkedKeyCount: 0, usableKeyCount: 0,
          samples: 0, successes: 0, modelCount: 0, reliability: null, speed: null, intelligence: null, score: null, tier: null,
        }, observations: [],
      };
      groups.set(identity, group);
    }
    return group;
  }
  for (const k of keys) Object.assign(ensure(k.platform, k.scope).row, { linkedKeyCount: k.linked, usableKeyCount: k.usable });
  for (const r of observations) ensure(r.platform, r.scope).observations.push(r);
  for (const { row, observations: obs } of groups.values()) {
    row.samples = obs.reduce((n, r) => n + r.samples, 0);
    row.successes = obs.reduce((n, r) => n + r.successes, 0);
    row.modelCount = new Set(obs.map(r => r.model_id)).size;
    if (!row.samples) continue;
    row.reliability = expectedReliability(row.successes, row.samples - row.successes);
    // Aggregate measured model axes by attempt count, excluding unknown axes.
    for (const axis of ['speed', 'intelligence'] as const) {
      let sum = 0;
      let weight = 0;
      for (const r of obs) {
        const c = composite(r);
        const value = axis === 'speed'
          ? r.latency_ms > 0 || r.ttfb_ms !== null ? speedScore(r.latency_ms > 0 ? r.output_tokens * 1000 / r.latency_ms : 0, r.ttfb_ms) : null
          : c === null ? null : intelligenceScore(c, min, max);
        if (value !== null) { sum += value * r.samples; weight += r.samples; }
      }
      row[axis] = weight ? sum / weight : null;
    }
    let weighted = 0;
    let weights = 0;
    for (const axis of ['reliability', 'speed', 'intelligence'] as const) {
      const value = row[axis];
      if (value !== null) { weighted += value * BANDIT_PRESETS.balanced[axis]; weights += BANDIT_PRESETS.balanced[axis]; }
    }
    row.score = weighted / weights;
    row.tier = tierForScore(row.score, row.samples);
  }
  const rows = [...groups.values()].map(g => g.row).sort((a, b) =>
    Number(b.tier !== null) - Number(a.tier !== null) || (b.score ?? -1) - (a.score ?? -1) || a.name.localeCompare(b.name));
  return { range, generatedAt: new Date().toISOString(), minSamples: PROVIDER_TIER_MIN_SAMPLES, rows };
}
