import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONTEXT_POLICY_DEFAULT, CONTEXT_PRESETS } from '@freellmapi/shared/context-budget.js';
import { connectDb } from '../../../db/index.js';
import { runMigrations } from '../../../db/migrate/runner.js';
import {
  clearContextPolicyCache,
  ContextPolicyError,
  deleteContextPolicy,
  getContextPolicyDefault,
  pruneOrphanPolicies,
  resolveContextPolicy,
  saveContextPolicy,
  setContextPolicyDefault,
  suggestedFromConversationSettings,
} from '../../../custom/context-budget/policy.js';

type TestDb = ReturnType<typeof connectDb>;

function insertProfile(db: TestDb, id: number, name = `profile-${id}`): void {
  db.prepare(
    `INSERT INTO client_profiles (id, name, token_hash, encrypted_key, iv, auth_tag)
     VALUES (?, ?, ?, 'e', 'i', 't')`,
  ).run(id, name, `hash-${id}`);
}

describe('context-budget policy store', () => {
  let db: TestDb;

  beforeEach(async () => {
    clearContextPolicyCache();
    db = connectDb(':memory:');
    await runMigrations(db, 'up');
    insertProfile(db, 1);
    insertProfile(db, 2);
  });

  afterEach(() => {
    clearContextPolicyCache();
    db.close();
  });

  it('returns CONTEXT_POLICY_DEFAULT when settings key context_policy_default is absent', () => {
    expect(getContextPolicyDefault()).toEqual(CONTEXT_POLICY_DEFAULT);
  });

  it('resolves inherited default policy when profile has no row in custom_context_policies', () => {
    const policy = resolveContextPolicy(1);

    expect(policy.inherited).toBe(true);
    expect(policy.enabled).toBe(CONTEXT_POLICY_DEFAULT.enabled);
    expect(policy.preset).toBe(CONTEXT_POLICY_DEFAULT.preset);
    expect(policy.maxInputTokens).toBe(CONTEXT_PRESETS.balanced.maxInputTokens);
    expect(policy.outputReserveTokens).toBe(CONTEXT_PRESETS.balanced.outputReserveTokens);
    expect(policy.safetyMarginPct).toBe(CONTEXT_PRESETS.balanced.safetyMarginPct);
    expect(policy.summarySharePct).toBe(CONTEXT_PRESETS.balanced.summarySharePct);
    expect(policy.knowledgeSharePct).toBe(CONTEXT_PRESETS.balanced.knowledgeSharePct);
    expect(policy.dropBlockTurns).toBe(CONTEXT_PRESETS.balanced.dropBlockTurns);
    expect(policy.summarize).toBe(CONTEXT_PRESETS.balanced.summarize);
    expect(policy.clientHistoryMode).toBe(CONTEXT_PRESETS.balanced.clientHistoryMode);
    expect(policy.knowledgeMinScore).toBe(CONTEXT_PRESETS.balanced.knowledgeMinScore);
  });

  it('updates and persists system default via setContextPolicyDefault and invalidates inherited cache', () => {
    // Prime cache for profile 1 with initial default.
    expect(resolveContextPolicy(1).enabled).toBe(false);

    const updated = setContextPolicyDefault({
      enabled: true,
      preset: 'saver',
      fallbackWindowTokens: 16384,
      imageTokens: 512,
    });

    expect(updated).toEqual({
      enabled: true,
      preset: 'saver',
      fallbackWindowTokens: 16384,
      imageTokens: 512,
    });
    expect(getContextPolicyDefault()).toEqual(updated);

    const resolved = resolveContextPolicy(1);
    expect(resolved.inherited).toBe(true);
    expect(resolved.enabled).toBe(true);
    expect(resolved.preset).toBe('saver');
    expect(resolved.maxInputTokens).toBe(CONTEXT_PRESETS.saver.maxInputTokens);
    expect(resolved.knowledgeSharePct).toBe(CONTEXT_PRESETS.saver.knowledgeSharePct);
  });

  it('rejects invalid system default settings with context_policy_invalid', () => {
    const invalidInputs = [
      { preset: 'custom' },
      { fallbackWindowTokens: 512 },
      { fallbackWindowTokens: 2_000_000 },
      { imageTokens: 32 },
      { imageTokens: 8192 },
      { enabled: 'yes' },
      { extraField: true },
    ];

    for (const input of invalidInputs) {
      let caught: unknown;
      try {
        setContextPolicyDefault(input as never);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ContextPolicyError);
      expect((caught as ContextPolicyError).code).toBe('context_policy_invalid');
    }
  });

  it('applies preset numeric values when preset is not custom and rejects mismatched numeric fields', () => {
    const saved = saveContextPolicy(1, {
      enabled: true,
      preset: 'saver',
      clientHistoryMode: 'trim_on_overflow',
      knowledgeMinScore: 0.45,
    });

    expect(saved.inherited).toBe(false);
    expect(saved.enabled).toBe(true);
    expect(saved.preset).toBe('saver');
    expect(saved.maxInputTokens).toBe(8000);
    expect(saved.outputReserveTokens).toBe(1024);
    expect(saved.safetyMarginPct).toBe(10);
    expect(saved.summarySharePct).toBe(15);
    expect(saved.knowledgeSharePct).toBe(20);
    expect(saved.dropBlockTurns).toBe(4);
    expect(saved.clientHistoryMode).toBe('trim_on_overflow');
    expect(saved.knowledgeMinScore).toBe(0.45);

    // Switching to max_context overwrites previous saver numbers cleanly.
    const maxCtx = saveContextPolicy(1, { preset: 'max_context' });
    expect(maxCtx.maxInputTokens).toBeNull();
    expect(maxCtx.outputReserveTokens).toBe(2048);
    expect(maxCtx.knowledgeSharePct).toBe(30);
    expect(maxCtx.dropBlockTurns).toBe(8);

    // Providing a numeric field that disagrees with the non-custom preset must throw context_policy_preset_mismatch.
    for (const badPatch of [
      { preset: 'saver', maxInputTokens: 16000 },
      { preset: 'balanced', outputReserveTokens: 2048 },
      { preset: 'balanced', safetyMarginPct: 5 },
      { preset: 'balanced', summarySharePct: 10 },
      { preset: 'balanced', knowledgeSharePct: 20 },
      { preset: 'balanced', dropBlockTurns: 8 },
      { maxInputTokens: 12000 }, // profile 1 is currently 'max_context', not 'custom'
    ]) {
      let caught: unknown;
      try {
        saveContextPolicy(1, badPatch as never);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ContextPolicyError);
      expect((caught as ContextPolicyError).code).toBe('context_policy_preset_mismatch');
    }
  });

  it('validates custom budgets, share sums, bounds, and unknown fields with exact error codes', () => {
    const custom = saveContextPolicy(1, {
      enabled: true,
      preset: 'custom',
      maxInputTokens: 12000,
      outputReserveTokens: 1500,
      safetyMarginPct: 12,
      summarySharePct: 30,
      knowledgeSharePct: 50,
      dropBlockTurns: 6,
      summarize: false,
      clientHistoryMode: 'enforce_budget',
      knowledgeMinScore: 0.7,
    });
    expect(custom.maxInputTokens).toBe(12000);
    expect(custom.summarySharePct + custom.knowledgeSharePct).toBe(80);

    // maxInputTokens < 2000 -> context_policy_budget_too_small
    expect(() => saveContextPolicy(1, { preset: 'custom', maxInputTokens: 1999 })).toThrowError(ContextPolicyError);
    try {
      saveContextPolicy(1, { preset: 'custom', maxInputTokens: 1999 });
    } catch (err) {
      expect((err as ContextPolicyError).code).toBe('context_policy_budget_too_small');
    }

    // summarySharePct + knowledgeSharePct > 80 -> context_policy_shares_too_large
    try {
      saveContextPolicy(1, { preset: 'custom', summarySharePct: 45, knowledgeSharePct: 40 });
      expect.unreachable('should have thrown context_policy_shares_too_large');
    } catch (err) {
      expect(err).toBeInstanceOf(ContextPolicyError);
      expect((err as ContextPolicyError).code).toBe('context_policy_shares_too_large');
    }

    // Also checks sum against existing persisted field when only one share is updated.
    try {
      saveContextPolicy(1, { preset: 'custom', summarySharePct: 35 }); // 35 + existing 50 = 85 > 80
      expect.unreachable('should have thrown context_policy_shares_too_large');
    } catch (err) {
      expect(err).toBeInstanceOf(ContextPolicyError);
      expect((err as ContextPolicyError).code).toBe('context_policy_shares_too_large');
    }

    // Out-of-bounds or unknown fields -> context_policy_invalid
    const invalidCases = [
      { preset: 'custom', maxInputTokens: 1_000_001 },
      { preset: 'custom', maxInputTokens: 2500.5 },
      { preset: 'custom', outputReserveTokens: 64 },
      { preset: 'custom', outputReserveTokens: 40000 },
      { preset: 'custom', safetyMarginPct: -1 },
      { preset: 'custom', safetyMarginPct: 31 },
      { preset: 'custom', summarySharePct: 61 },
      { preset: 'custom', knowledgeSharePct: -1 },
      { preset: 'custom', dropBlockTurns: 0 },
      { preset: 'custom', dropBlockTurns: 17 },
      { preset: 'custom', knowledgeMinScore: -0.1 },
      { preset: 'custom', knowledgeMinScore: 1.1 },
      { preset: 'custom', clientHistoryMode: 'drop_all' },
      { preset: 'custom', unknownField: 123 },
    ];

    for (const bad of invalidCases) {
      try {
        saveContextPolicy(1, bad as never);
        expect.unreachable(`expected context_policy_invalid for ${JSON.stringify(bad)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(ContextPolicyError);
        expect((err as ContextPolicyError).code).toBe('context_policy_invalid');
      }
    }
  });

  it('caches resolved policies per profile_id and invalidates on save and delete', () => {
    saveContextPolicy(1, { enabled: true, preset: 'balanced' });
    const first = resolveContextPolicy(1);
    expect(first.maxInputTokens).toBe(16000);

    // Direct DB edit without cache invalidation must still return cached value.
    db.prepare('UPDATE custom_context_policies SET max_input_tokens = 24000 WHERE profile_id = 1').run();
    expect(resolveContextPolicy(1).maxInputTokens).toBe(16000);

    // saveContextPolicy invalidates the profile cache entry.
    saveContextPolicy(1, { preset: 'saver' });
    expect(resolveContextPolicy(1).maxInputTokens).toBe(8000);

    // deleteContextPolicy removes the row and invalidates cache back to inherited default.
    expect(deleteContextPolicy(1)).toBe(true);
    expect(deleteContextPolicy(1)).toBe(false);
    const afterDelete = resolveContextPolicy(1);
    expect(afterDelete.inherited).toBe(true);
    expect(afterDelete.enabled).toBe(false);
    expect(afterDelete.preset).toBe('balanced');
  });

  it('computes suggested policy from conversation settings', () => {
    expect(suggestedFromConversationSettings({ maxChars: 12000, summarize: true })).toEqual({
      maxInputTokens: 4000,
      summarize: true,
    });
    expect(suggestedFromConversationSettings({ maxChars: 1000, summarize: false })).toEqual({
      maxInputTokens: 2000,
      summarize: false,
    });
    expect(suggestedFromConversationSettings({ maxChars: 6400, summarize: true })).toEqual({
      maxInputTokens: 2000,
      summarize: true,
    });
    expect(suggestedFromConversationSettings({ maxChars: 6401, summarize: true })).toEqual({
      maxInputTokens: 3000,
      summarize: true,
    });
  });

  it('prunes orphan policies whose profile_id no longer exists in client_profiles', () => {
    saveContextPolicy(1, { enabled: true, preset: 'saver' });
    saveContextPolicy(2, { enabled: true, preset: 'balanced' });
    // Prime cache for profile 2.
    expect(resolveContextPolicy(2).preset).toBe('balanced');

    db.prepare('DELETE FROM client_profiles WHERE id = 2').run();

    const removed = pruneOrphanPolicies();
    expect(removed).toBe(1);

    const remaining = db.prepare('SELECT profile_id FROM custom_context_policies').all() as Array<{ profile_id: number }>;
    expect(remaining).toEqual([{ profile_id: 1 }]);
    expect(resolveContextPolicy(2).inherited).toBe(true);
  });
});
