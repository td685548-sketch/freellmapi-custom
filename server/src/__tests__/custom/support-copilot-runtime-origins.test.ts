import { beforeAll, describe, expect, it } from 'vitest';
import { SUPPORT_SETUP_STEP_IDS } from '@freellmapi/shared/support-setup-copilot.js';
import { buildTenantSetupDiagnostic } from '../../custom/support-setup-copilot/diagnostics.js';
import { buildSanitizedSetupProposal } from '../../custom/support-setup-copilot/playbook.js';
import { createSupportTenant, updateSupportTenant } from '../../custom/x-gateway/support-store.js';
import { createUser } from '../../services/auth.js';
import { initDb } from '../../db/index.js';

const ALL_STEPS = new Set(SUPPORT_SETUP_STEP_IDS);

describe('Setup Copilot step 7 (runtime_policy) — open vs locked origins', () => {
  let userId: number;
  let tenantId: number;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = 'b'.repeat(64);
    initDb(':memory:');
    userId = createUser('origins-admin@example.com', 'AdminPass123!').userId;
    tenantId = createSupportTenant({
      name: 'Origins Corp',
      slug: 'origins-corp',
      defaultModel: 'auto',
      systemPrompt: 'Initial prompt.',
      allowedOrigins: ['*'],
      createdBy: userId,
    }).tenant.id;
  });

  const step7 = (tenant: ReturnType<typeof updateSupportTenant>) =>
    buildTenantSetupDiagnostic(tenant, ALL_STEPS, 'https://gw.example.com').steps.find(
      (s) => s.stepId === 'runtime_policy',
    )!;

  it('is partial and tells the user how to finish when origins are open (*)', () => {
    const tenant = updateSupportTenant(tenantId, { allowedOrigins: ['*'] });
    const step = step7(tenant);
    expect(step.status).toBe('partial');
    expect(step.summaryEn).toContain('live website domain');
    expect(step.summaryVi).toContain('tên miền website thật');
  });

  it('becomes complete once origins are locked to a concrete domain', () => {
    const tenant = updateSupportTenant(tenantId, { allowedOrigins: ['https://shop.example.com'] });
    const step = step7(tenant);
    expect(step.status).toBe('complete');
    expect(step.summaryEn).not.toContain('live website domain');
  });

  it('does not claim to "bind" CORS to * when the full proposal keeps origins open', () => {
    const tenant = updateSupportTenant(tenantId, { allowedOrigins: ['*'] });
    const proposal = buildSanitizedSetupProposal({
      userId,
      targetMode: 'update_tenant',
      existingTenant: tenant,
      requirements: {},
      canEditSteps: ALL_STEPS,
      canViewSteps: ALL_STEPS,
      canCreateTenant: false,
      locale: 'en',
    });
    const runtime = proposal.steps.find((s) => s.stepId === 'runtime_policy')!;
    expect(runtime.summaryEn).toContain('left open (*)');
    expect(runtime.highlightsEn.join(' ')).not.toContain('Bind CORS origins to *');
    expect(runtime.highlightsEn.join(' ')).toContain('send me your website domain');
  });

  it('binds CORS to the real domain when the user supplied one', () => {
    const tenant = updateSupportTenant(tenantId, { allowedOrigins: ['*'] });
    const proposal = buildSanitizedSetupProposal({
      userId,
      targetMode: 'update_tenant',
      existingTenant: tenant,
      requirements: { websiteOrigin: 'shop.example.com' },
      canEditSteps: ALL_STEPS,
      canViewSteps: ALL_STEPS,
      canCreateTenant: false,
      locale: 'en',
    });
    const runtime = proposal.steps.find((s) => s.stepId === 'runtime_policy')!;
    expect(runtime.highlightsEn.join(' ')).toContain('Bind CORS origins to https://shop.example.com');
    expect((runtime.payload as { allowedOrigins: string[] }).allowedOrigins).toEqual([
      'https://shop.example.com',
    ]);
  });
});
