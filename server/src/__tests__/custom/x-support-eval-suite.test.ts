import { describe, it, expect, beforeEach } from 'vitest';
import { initDb } from '../../db/index.js';
import {
  getLatestSupportSecurityBenchmark,
  listSupportSecurityBenchmarks,
  runSupportTenantSecurityBenchmark,
} from '../../custom/x-gateway/support-eval-suite.js';
import { updateSupportGuardrailPolicy } from '../../custom/x-gateway/support-guardrails.js';
import {
  seedDefaultSupportKnowledgeDocs,
  updateSupportMaskingPolicy,
  upsertSupportKnowledgeDoc,
} from '../../custom/x-gateway/support-knowledge.js';

const T = 'tenant_1';
const failed = (r: ReturnType<typeof runSupportTenantSecurityBenchmark>) =>
  r.checks.filter((c) => !c.passed).map((c) => c.id);

beforeEach(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
});

describe('support security benchmark', () => {
  it('default tenant scores 100 / grade A with 11 passing checks', () => {
    seedDefaultSupportKnowledgeDocs(T);
    const r = runSupportTenantSecurityBenchmark(T);
    expect(r.id).toMatch(/^bmk_/);
    expect(r.scorePct).toBe(100);
    expect(r.grade).toBe('A');
    expect(r.totalChecks).toBeGreaterThanOrEqual(10);
    expect(r.failedChecks).toBe(0);
    expect(r.passedChecks).toBe(r.totalChecks);
    expect(r.recommendations).toEqual([]);
    expect(new Set(r.checks.map((c) => c.category))).toEqual(
      new Set(['prompt_firewall', 'rag_role_isolation', 'pii_masking', 'quota_governance']),
    );
  });

  it('passes on a tenant with no knowledge docs', () => {
    expect(runSupportTenantSecurityBenchmark(T).grade).toBe('A');
  });

  it('disabling the firewall fails all firewall probes and degrades to F', () => {
    updateSupportGuardrailPolicy(T, { enabled: false });
    const r = runSupportTenantSecurityBenchmark(T);
    expect(failed(r)).toEqual(
      expect.arrayContaining(['firewall_enabled', 'probe_ignore_instructions', 'probe_role_spoofing', 'probe_system_prompt_leak', 'probe_sql_injection']),
    );
    expect(r.scorePct).toBeLessThan(60);
    expect(r.grade).toBe('F');
  });

  it('disabling only blockPromptInjection is detected', () => {
    updateSupportGuardrailPolicy(T, { blockPromptInjection: false });
    const r = runSupportTenantSecurityBenchmark(T);
    expect(failed(r)).toContain('firewall_enabled');
    expect(failed(r)).toContain('probe_sql_injection');
  });

  it('removing a single detector fails only its probe', () => {
    updateSupportGuardrailPolicy(T, { injectionDetectors: ['ignore_instructions', 'role_spoofing', 'system_prompt_leak'] });
    const r = runSupportTenantSecurityBenchmark(T);
    expect(failed(r)).toEqual(['probe_sql_injection']);
    expect(r.grade).toBe('A');
    expect(r.scorePct).toBe(91);
  });

  it('guest in bypassRoles is flagged', () => {
    updateSupportGuardrailPolicy(T, { bypassRoles: ['admin', 'guest'] });
    const r = runSupportTenantSecurityBenchmark(T);
    expect(failed(r)).toEqual(
      expect.arrayContaining(['non_admin_bypass_safety', 'probe_ignore_instructions', 'probe_system_prompt_leak']),
    );
    expect(r.checks.find((c) => c.id === 'non_admin_bypass_safety')?.details).toContain('guest');
    expect(r.grade).not.toBe('A');
  });

  it('customer in unmaskedRoles or disabled masking fails PII check', () => {
    updateSupportMaskingPolicy(T, { unmaskedRoles: ['admin', 'customer'] });
    expect(failed(runSupportTenantSecurityBenchmark(T))).toContain('pii_masking_customer');
    updateSupportMaskingPolicy(T, { unmaskedRoles: ['admin'], enabled: false });
    const r = runSupportTenantSecurityBenchmark(T);
    expect(failed(r)).toEqual(expect.arrayContaining(['pii_masking_customer', 'pii_masking_guest']));
  });

  it('missing detector (e.g. email) fails PII check', () => {
    updateSupportMaskingPolicy(T, { builtinDetectors: ['phone', 'credit_card'] });
    const r = runSupportTenantSecurityBenchmark(T);
    expect(failed(r)).toContain('pii_masking_customer');
  });

  it('unlimited guest/customer quotas fail governance check', () => {
    updateSupportGuardrailPolicy(T, {
      roleQuotas: { guest: { maxRequestsPerWindow: 0, maxTokensPerWindow: 0, windowSeconds: 3600 } },
    });
    const r = runSupportTenantSecurityBenchmark(T);
    expect(failed(r)).toEqual(['quota_limits_enforced']);
    expect(r.checks.find((c) => c.id === 'quota_limits_enforced')?.severity).toBe('medium');
  });

  it('RAG isolation passes with restricted docs (admin-only never reaches guest/customer)', () => {
    seedDefaultSupportKnowledgeDocs(T);
    upsertSupportKnowledgeDoc(T, { title: 'Admin Vault', content: 'secret margin refund policy', allowedRoles: ['admin'], tags: ['margin'] });
    const r = runSupportTenantSecurityBenchmark(T);
    expect(r.checks.find((c) => c.id === 'rag_guest_isolation')?.passed).toBe(true);
    expect(r.checks.find((c) => c.id === 'rag_customer_isolation')?.details).toContain('docs checked');
  });

  it('generates one actionable recommendation per failed check', () => {
    updateSupportGuardrailPolicy(T, { enabled: false });
    const r = runSupportTenantSecurityBenchmark(T);
    expect(r.recommendations).toHaveLength(r.failedChecks);
    expect(r.recommendations.some((x) => x.startsWith('[CRITICAL] Prompt Firewall Enabled & Active'))).toBe(true);
    expect(r.recommendations.every((x) => /^\[(CRITICAL|HIGH|MEDIUM)\]/.test(x))).toBe(true);
  });

  it('grades use the documented thresholds', () => {
    // 6 failed of 11 -> 45 -> F ; 2 failed -> 82 -> B ; 3 failed -> 73 -> C
    updateSupportGuardrailPolicy(T, { injectionDetectors: ['ignore_instructions', 'role_spoofing'] });
    const r = runSupportTenantSecurityBenchmark(T);
    expect(r.failedChecks).toBe(2);
    expect(r.scorePct).toBe(82);
    expect(r.grade).toBe('B');
    updateSupportMaskingPolicy(T, { enabled: false });
    const r2 = runSupportTenantSecurityBenchmark(T);
    expect(r2.failedChecks).toBe(4);
    expect(r2.scorePct).toBe(64);
    expect(r2.grade).toBe('D');
  });

  it('persists history newest-first, returns latest, isolates tenants', () => {
    expect(getLatestSupportSecurityBenchmark(T)).toBeNull();
    const a = runSupportTenantSecurityBenchmark(T);
    updateSupportGuardrailPolicy(T, { enabled: false });
    const b = runSupportTenantSecurityBenchmark(T);
    expect(listSupportSecurityBenchmarks(T).map((x) => x.id)).toEqual([b.id, a.id]);
    expect(getLatestSupportSecurityBenchmark(T)?.id).toBe(b.id);
    expect(listSupportSecurityBenchmarks('tenant_2')).toEqual([]);
  });

  it('keeps at most 25 reports per tenant', () => {
    for (let i = 0; i < 27; i++) runSupportTenantSecurityBenchmark(T);
    expect(listSupportSecurityBenchmarks(T)).toHaveLength(25);
  });
});
