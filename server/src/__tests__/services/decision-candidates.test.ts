import { beforeEach, describe, expect, it } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { listDecisionCandidates, listDecisionModels } from '../../services/decision.js';
import { getDecisionRoutingStatus } from '../../services/routing-decision.js';
import { seedDecisionModels } from '../helpers/decision-models.js';

// Routing status reads a slimmed-down view of the decision models. It must keep
// agreeing with the full dashboard view for every key state.

function addKey(platform: string, status: string, enabled: number): void {
  const { encrypted, iv, authTag } = encrypt(`${platform}-${status}-${enabled}`);
  getDb().prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'k', ?, ?, ?, ?, ?)`).run(platform, encrypted, iv, authTag, status, enabled);
}

describe('decision candidates', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    seedDecisionModels();
    // A decision row on a platform that has no decision adapter.
    getDb().prepare(`INSERT INTO media_models (platform, model_id, display_name, modality, priority, enabled)
      VALUES ('nonexistent', 'x', 'X', 'decision', 9, 1)`).run();
  });

  const cases: Array<[string, Array<[string, string, number]>]> = [
    ['no keys', []],
    ['healthy key', [['cloudflare', 'healthy', 1]]],
    ['unknown status counts as usable', [['cloudflare', 'unknown', 1]]],
    ['disabled and unhealthy keys do not', [['cloudflare', 'healthy', 0], ['cloudflare', 'invalid', 1], ['openrouter', 'rate_limited', 1]]],
    ['mixed', [['cloudflare', 'healthy', 1], ['cloudflare', 'healthy', 1], ['openrouter', 'invalid', 1], ['nonexistent', 'healthy', 1]]],
  ];

  for (const [name, keys] of cases) {
    it(`agrees with the full model list: ${name}`, () => {
      for (const [platform, status, enabled] of keys) addKey(platform, status, enabled);
      const full = listDecisionModels();
      const slim = listDecisionCandidates();
      expect(slim).toEqual(full.map(m => ({
        id: m.id, platform: m.platform, modelId: m.modelId, priority: m.priority, enabled: m.enabled, healthyKeyCount: m.healthyKeyCount,
      })));
    });
  }

  it('drives readiness from healthy keys only', () => {
    expect(getDecisionRoutingStatus().ready).toBe(false);
    addKey('cloudflare', 'healthy', 1);
    expect(getDecisionRoutingStatus().ready).toBe(true);
  });
});
