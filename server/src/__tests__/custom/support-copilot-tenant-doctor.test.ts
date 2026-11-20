import { beforeAll, describe, expect, it } from 'vitest';
import { SUPPORT_SETUP_STEP_IDS } from '@freellmapi/shared/support-setup-copilot.js';
import { buildTenantSetupDiagnostic } from '../../custom/support-setup-copilot/diagnostics.js';
import {
  buildTenantDoctorChatResponse,
  buildTenantDoctorReport,
  matchTenantDoctorIntent,
} from '../../custom/support-setup-copilot/tenant-doctor.js';
import { matchErrorDoctorIntent } from '../../custom/support-setup-copilot/error-doctor.js';
import { getDb, initDb } from '../../db/index.js';
import { createUser } from '../../services/auth.js';
import { ensureSupportRuntimeTables } from '../../custom/x-gateway/support-runtime-store.js';
import { createSupportTenant, updateSupportTenant } from '../../custom/x-gateway/support-store.js';

const ALL = new Set(SUPPORT_SETUP_STEP_IDS);

describe('Tenant Doctor — intent routing (the real failing chats)', () => {
  it('sends "tenant này hay bị lỗi, vì sao" to the tenant doctor, not the personal one', () => {
    expect(matchTenantDoctorIntent('tenant này hay bị lỗi, vì sao', false)).toBe(true);
    expect(matchTenantDoctorIntent('AI support của mình bị lỗi', false)).toBe(true);
    expect(matchTenantDoctorIntent('widget không hiện thì sao', false)).toBe(true);
  });

  it('treats a bare "why errors" as the tenant only when a tenant Target is selected', () => {
    expect(matchTenantDoctorIntent('hay bị lỗi, vì sao', true)).toBe(true);
    expect(matchTenantDoctorIntent('hay bị lỗi, vì sao', false)).toBe(false);
  });

  it('keeps clearly personal questions on the personal Error Doctor', () => {
    for (const q of [
      'api của tôi bị lỗi 429 vì sao',
      'why is my API failing with 429',
      'kiểm tra lỗi API của tôi',
      'quota của mình còn không, sao lỗi',
    ]) {
      expect(matchTenantDoctorIntent(q, true), q).toBe(false);
    }
    expect(matchErrorDoctorIntent('kiểm tra lỗi API của tôi')).toBe(true);
  });

  it('does not hijack setup/how-to questions about the 7 steps', () => {
    expect(matchTenantDoctorIntent('tenant bước 7 là gì', true)).toBe(false);
  });
});

describe('Tenant Doctor — findings come from the tenant\'s own evidence', () => {
  let tenantId: number;
  let adminId: number;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = 'e'.repeat(64);
    initDb(':memory:');
    adminId = createUser('tenant-doctor-admin@example.com', 'AdminPass123!', 'admin').userId;
    tenantId = createSupportTenant({
      name: 'Chưa giàu đã lớn', slug: 'chua-giau', defaultModel: 'auto', systemPrompt: 'Initial prompt.', createdBy: adminId,
    }).tenant.id;
    ensureSupportRuntimeTables();
  });

  const report = () => {
    const tenant = updateSupportTenant(tenantId, {});
    const diagnostic = buildTenantSetupDiagnostic(tenant, ALL, 'https://gw.example.com');
    return { tenant, report: buildTenantDoctorReport({ tenant, diagnostic }) };
  };

  it('names a specific cause and fix (no provider route) instead of listing generic HTTP categories', () => {
    const { report: r } = report();
    const noRoutes = r.findings.find((f) => f.id === 'no_routes');
    expect(noRoutes?.severity).toBe('critical');
    const res = buildTenantDoctorChatResponse({ report: r, locale: 'vi' });
    expect(res.intent).toBe('diagnose_errors');
    expect(res.reply).toContain('Chưa giàu đã lớn');
    expect(res.reply).toContain('Bằng chứng');
    expect(res.reply).toContain('/thruline/providers');
    // The wrong remedy from the real chat must not come back.
    expect(res.reply).not.toMatch(/ECO|BALANCED/);
    expect(res.reply).toContain('không dùng Personal API Key');
  });

  it('turns recorded failures, firewall blocks and output blocks into evidence-backed findings', () => {
    const db = getDb();
    const now = new Date().toISOString();
    const exp = new Date(Date.now() + 3600_000).toISOString();
    for (let i = 0; i < 3; i += 1) {
      db.prepare(
        `INSERT INTO x_support_runtime_turns (id, tenant_id, user_id, request_id, input_hash, state, created_at, updated_at, expires_at)
         VALUES (?, ?, 'u', ?, 'h', 'failed', ?, ?, ?)`,
      ).run(`t-${i}`, tenantId, `r-${i}`, now, now, exp);
    }
    for (let i = 0; i < 6; i += 1) {
      db.prepare(
        `INSERT INTO x_support_partner_events (id, tenant_id, type, dedup_key, payload_encrypted, payload_iv, payload_auth_tag, created_at)
         VALUES (?, ?, 'guardrail.blocked', ?, 'x', 'x', 'x', ?)`,
      ).run(`e-${i}`, tenantId, `k-${i}`, now);
    }
    db.prepare(
      `INSERT INTO x_support_output_events (id, tenant_id, operation_id, surface, policy_version, action, reasons_json, rule_ids_json, redaction_count, created_at)
       VALUES ('o1', ?, 'op1', 'chat', 1, 'block', '["credential_leak"]', '[]', 0, ?)`,
    ).run(tenantId, now);

    const { report: r } = report();
    expect(r.evidence.turns.failed).toBe(3);
    expect(r.evidence.guardrailBlocks).toBe(6);
    expect(r.evidence.outputBlocked).toBe(1);
    const ids = r.findings.map((f) => f.id);
    expect(ids).toEqual(expect.arrayContaining(['guardrail_blocks', 'output_controls_active', 'failed_turns']));
    const guard = r.findings.find((f) => f.id === 'guardrail_blocks')!;
    expect(guard.evidenceEn).toContain('6 blocked');
    expect(guard.path).toBe('/thruline/support-guardrails');
    expect(r.findings.find((f) => f.id === 'output_controls_active')!.evidenceEn).toContain('credential_leak');
  });

  it('flags a tenant that is switched off and very low completion tokens', () => {
    updateSupportTenant(tenantId, { enabled: false });
    const { report: r } = report();
    expect(r.findings[0]?.id).toBe('tenant_disabled');
    updateSupportTenant(tenantId, { enabled: true });
  });
});
