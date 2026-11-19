// Context-budget defaults: the system-wide default policy is ON with the
// `balanced` preset, and `balanced` trims client history on overflow instead
// of passing it through verbatim. A stored `context_policy_default` setting
// (or a per-profile row) still wins over these code defaults.
import { describe, it, expect, beforeEach } from 'vitest';
import { CONTEXT_POLICY_DEFAULT, CONTEXT_PRESETS } from '@freellmapi/shared/context-budget.js';
import { initDb } from '../../db/index.js';
import { getContextPolicyDefault } from '../../custom/context-budget/policy.js';

describe('context-budget defaults (on by default, balanced)', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('defaults to enabled with the balanced preset', () => {
    expect(CONTEXT_POLICY_DEFAULT.enabled).toBe(true);
    expect(CONTEXT_POLICY_DEFAULT.preset).toBe('balanced');
    expect(getContextPolicyDefault()).toEqual(CONTEXT_POLICY_DEFAULT);
  });

  it('balanced trims client history on overflow; the other presets still pass through', () => {
    expect(CONTEXT_PRESETS.balanced.clientHistoryMode).toBe('trim_on_overflow');
    expect(CONTEXT_PRESETS.saver.clientHistoryMode).toBe('passthrough');
    expect(CONTEXT_PRESETS.max_context.clientHistoryMode).toBe('passthrough');
  });
});
