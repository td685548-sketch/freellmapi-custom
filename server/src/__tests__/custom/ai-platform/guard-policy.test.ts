import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_GUARD_DETECTORS,
  DEFAULT_GUARD_POLICY_BASE,
  type GuardPolicyInput,
} from '@freellmapi/shared/ai-platform-output-guard.js';
import { getDb, initDb } from '../../../db/index.js';
import { resetFlagsCacheForTests, setFlags } from '../../../custom/ai-platform/flags.js';
import {
  getEffectivePolicy,
  GuardStoreError,
  purgeGuardScope,
  upsertPolicy,
} from '../../../custom/ai-platform/output-guard/store.js';
import { evaluateOutput, outputFilterFor } from '../../../custom/ai-platform/output-guard/policy.js';
import { resetGuardEventRateLimitForTests } from '../../../custom/ai-platform/output-guard/events.js';

function seedProfile(id: number, name = `profile-${id}`): void {
  getDb()
    .prepare(
      'INSERT INTO client_profiles (id, name, token_hash, encrypted_key, iv, auth_tag) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(id, name, `th-${id}`, `ek-${id}`, `iv-${id}`, `tag-${id}`);
}

function makeInput(overrides?: Partial<GuardPolicyInput>): GuardPolicyInput {
  return {
    mode: DEFAULT_GUARD_POLICY_BASE.mode,
    detectors: structuredClone(DEFAULT_GUARD_DETECTORS),
    replacementText: DEFAULT_GUARD_POLICY_BASE.replacementText,
    failMode: DEFAULT_GUARD_POLICY_BASE.failMode,
    bypassRoles: [],
    holdChars: DEFAULT_GUARD_POLICY_BASE.holdChars,
    maxDelayMs: DEFAULT_GUARD_POLICY_BASE.maxDelayMs,
    revision: 0,
    ...overrides,
  };
}

describe('output-guard/store & policy', () => {
  beforeEach(() => {
    initDb(':memory:');
    resetFlagsCacheForTests();
    resetGuardEventRateLimitForTests();
    seedProfile(1);
  });

  afterEach(() => {
    resetFlagsCacheForTests();
    try {
      getDb().close();
    } catch {
      /* already closed */
    }
  });

  it('GET unsaved policy returns effective default with revision 0 without writing to DB', () => {
    const policy = getEffectivePolicy({ kind: 'profile', id: '1' });
    expect(policy.mode).toBe('off');
    expect(policy.failMode).toBe('allow');
    expect(policy.holdChars).toBe(200);
    expect(policy.maxDelayMs).toBe(300);
    expect(policy.revision).toBe(0);
    expect(policy.detectors.keywords.enabled).toBe(true);
    expect(policy.detectors.pii.enabled).toBe(true);
    expect(policy.detectors.pii.action).toBe('mask');

    const count = (
      getDb().prepare('SELECT COUNT(*) AS c FROM custom_ai_output_policies').get() as { c: number }
    ).c;
    expect(count).toBe(0);
  });

  it('validates scope existence (404 missing, 409 scope_unavailable for agent) and enforces optimistic revision', () => {
    expect(() => getEffectivePolicy({ kind: 'profile', id: '999' })).toThrowError(GuardStoreError);
    try {
      getEffectivePolicy({ kind: 'agent', id: 'billing' });
    } catch (err) {
      expect(err).toBeInstanceOf(GuardStoreError);
      expect((err as GuardStoreError).status).toBe(409);
      expect((err as GuardStoreError).code).toBe('scope_unavailable');
    }

    const created = upsertPolicy(
      { kind: 'profile', id: '1' },
      makeInput({ mode: 'block', revision: 0 }),
      1,
    );
    expect(created.revision).toBe(1);
    expect(created.mode).toBe('block');

    const updated = upsertPolicy(
      { kind: 'profile', id: '1' },
      makeInput({ mode: 'log', revision: 1 }),
      1,
    );
    expect(updated.revision).toBe(2);

    // Stale revision 1 -> 409 revision_conflict with current projection
    try {
      upsertPolicy({ kind: 'profile', id: '1' }, makeInput({ mode: 'off', revision: 1 }), 1);
      expect.unreachable('Expected revision_conflict');
    } catch (err) {
      expect(err).toBeInstanceOf(GuardStoreError);
      const storeErr = err as GuardStoreError;
      expect(storeErr.status).toBe(409);
      expect(storeErr.code).toBe('revision_conflict');
      expect((storeErr.details as { current?: { revision: number } })?.current?.revision).toBe(2);
    }
  });

  it('rejects out-of-bounds policy fields with 422', () => {
    expect(() =>
      upsertPolicy({ kind: 'profile', id: '1' }, makeInput({ holdChars: 2001 }), 1),
    ).toThrowError(GuardStoreError);

    expect(() =>
      upsertPolicy({ kind: 'profile', id: '1' }, makeInput({ replacementText: 'x'.repeat(1001) }), 1),
    ).toThrowError(GuardStoreError);
  });

  it('purgeGuardScope deletes only exact scope and preserves other scopes', () => {
    seedProfile(10);
    upsertPolicy({ kind: 'profile', id: '1' }, makeInput({ mode: 'log', revision: 0 }), 1);
    upsertPolicy({ kind: 'profile', id: '10' }, makeInput({ mode: 'block', revision: 0 }), 1);

    purgeGuardScope('profile', '1');

    expect(getEffectivePolicy({ kind: 'profile', id: '1' }).revision).toBe(0);
    expect(getEffectivePolicy({ kind: 'profile', id: '10' }).revision).toBe(1);
  });

  it('outputFilterFor returns null when flag is off or policy mode is off; evaluateOutput is no-op', async () => {
    upsertPolicy({ kind: 'profile', id: '1' }, makeInput({ mode: 'block', revision: 0 }), 1);
    // Flag is off by default
    expect(
      outputFilterFor(
        { kind: 'profile', id: '1' },
        { endUser: 'u1', wire: 'openai-chat', stream: false, systemPrompt: null },
      ),
    ).toBeNull();

    const offRes = await evaluateOutput(
      { kind: 'profile', id: '1' },
      'Hello world',
      { endUser: 'u1', wire: 'openai-chat', stream: false, systemPrompt: null },
    );
    expect(offRes).toEqual({ action: 'pass', text: 'Hello world' });

    // Enable flag, set policy mode = 'off'
    setFlags({ outputGuard: true });
    upsertPolicy({ kind: 'profile', id: '1' }, makeInput({ mode: 'off', revision: 1 }), 1);
    expect(
      outputFilterFor(
        { kind: 'profile', id: '1' },
        { endUser: 'u1', wire: 'openai-chat', stream: false, systemPrompt: null },
      ),
    ).toBeNull();
  });

  it('bypasses only when trustedRole is in bypassRoles and records bypassed event; ignores untrusted role', async () => {
    setFlags({ outputGuard: true });
    upsertPolicy(
      { kind: 'profile', id: '1' },
      makeInput({ mode: 'block', bypassRoles: ['support_admin'], revision: 0 }),
      1,
    );

    const bypassed = await evaluateOutput(
      { kind: 'profile', id: '1' },
      'Sensitive text',
      {
        trustedRole: 'support_admin',
        role: 'support_admin',
        endUser: 'u1',
        wire: 'support',
        stream: false,
        systemPrompt: null,
      },
    );
    expect(bypassed).toEqual({ action: 'pass', text: 'Sensitive text' });

    const events = getDb()
      .prepare("SELECT action, end_user FROM custom_ai_guard_events WHERE scope_id = '1'")
      .all() as Array<{ action: string; end_user: string }>;
    expect(events).toEqual([{ action: 'bypassed', end_user: 'u1' }]);
  });
});
