import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb, initDb } from '../../../db/index.js';
import { normalizeScope, parseScopeParam, purgeScope } from '../../../custom/ai-platform/scope.js';

describe('ai-platform/scope', () => {
  it('preserves neighboring ids and treats wildcard characters in agent ids literally', () => {
    const db = getDb();
    const keys = ['ai_platform_scope_profile_1_meta', 'ai_platform_scope_profile_10_meta',
      'ai_platform_scope_agent_a%_meta', 'ai_platform_scope_agent_abc_meta',
      'ai_platform_scope_agent_a_b_meta', 'ai_platform_scope_agent_axb_meta'];
    for (const key of keys) db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, 'test');
    expect(purgeScope('profile', '1')).toBe(1);
    expect(purgeScope('agent', 'a%')).toBe(1);
    expect(purgeScope('agent', 'a_b')).toBe(1);
    expect(db.prepare('SELECT key FROM settings WHERE key IN (?, ?, ?) ORDER BY key')
      .all(keys[1], keys[3], keys[5])).toHaveLength(3);
  });
  beforeEach(() => {
    initDb(':memory:');
  });

  afterEach(() => {
    try { getDb().close(); } catch { /* already closed */ }
  });

  it('normalizes positive integer ids for profile and support_tenant, and keeps agent id', () => {
    expect(normalizeScope({ kind: 'profile', id: '007' })).toEqual({ kind: 'profile', id: '7' });
    expect(normalizeScope({ kind: 'support_tenant', id: '12' })).toEqual({ kind: 'support_tenant', id: '12' });
    expect(normalizeScope({ kind: 'agent', id: 'billing-1' })).toEqual({ kind: 'agent', id: 'billing-1' });

    expect(parseScopeParam('support-tenant', '5')).toEqual({ kind: 'support_tenant', id: '5' });
    expect(() => normalizeScope({ kind: 'profile', id: '0' })).toThrow();
    expect(() => normalizeScope({ kind: 'support_tenant', id: '-3' })).toThrow();
    expect(() => normalizeScope({ kind: 'profile', id: 'abc' })).toThrow();
    expect(() => normalizeScope({ kind: 'agent', id: '   ' })).toThrow();
  });

  it('purgeScope removes only target scope entries and preserves global flags, retention, and other scopes', () => {
    const db = getDb();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('ai_platform_flags_v1', '{\"prompts\":false}')").run();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('ai_platform_retention_v1', '{\"runsDays\":30,\"toolCallsDays\":30,\"guardExcerptsDays\":7}')").run();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('ai_platform_scope_profile_7_meta', 'x')").run();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('ai_platform_scope_profile_8_meta', 'y')").run();

    const deleted = purgeScope('profile', '7');
    expect(deleted).toBe(1);

    const remaining = db
      .prepare("SELECT key FROM settings WHERE key LIKE 'ai_platform_%' ORDER BY key")
      .all() as Array<{ key: string }>;
    expect(remaining.map((r) => r.key)).toEqual([
      'ai_platform_flags_v1',
      'ai_platform_retention_v1',
      'ai_platform_scope_profile_8_meta',
    ]);
  });
});
