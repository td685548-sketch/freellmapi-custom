import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb, initDb } from '../../../db/index.js';
import { maskData, maskText } from '../../../custom/ai-platform/masking.js';

describe('ai-platform/masking', () => {
  beforeEach(() => {
    initDb(':memory:');
  });

  afterEach(() => {
    try { getDb().close(); } catch { /* already closed */ }
  });

  it('masks sensitive PII in profile and agent scopes using built-in default policy without writing tenant settings', () => {
    const raw = 'Contact alice@example.com or +1 415 555 0199 with sk-secret1234567890';
    const maskedProfile = maskText({ kind: 'profile', id: '1' }, raw, 'admin');
    expect(maskedProfile).not.toContain('alice@example.com');
    expect(maskedProfile).not.toContain('555 0199');

    const maskedAgent = maskData(
      { kind: 'agent', id: 'triage' },
      { email: 'bob@example.com', nested: ['safe', 'carol@example.com'] },
    );
    expect(maskedAgent.email).not.toContain('bob@example.com');
    expect(maskedAgent.nested[1]).not.toContain('carol@example.com');

    // Profile masking must not write fake tenant policies into settings
    const rows = getDb()
      .prepare("SELECT key FROM settings WHERE key LIKE 'x_gateway_support_masking%'")
      .all();
    expect(rows).toEqual([]);
  });

  it('delegates support_tenant scope to support masking policy', () => {
    const out = maskText({ kind: 'support_tenant', id: '42' }, 'Email: user@domain.com', 'customer');
    expect(out).not.toContain('user@domain.com');
  });
});
