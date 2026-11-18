import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { appendSupportAuditLog, listSupportAuditLogs } from '../../custom/x-gateway/support-enterprise-router.js';
import { getSupportGuardrailPolicy } from '../../custom/x-gateway/support-guardrails.js';
import {
  getSupportMaskingPolicy,
  listSupportKnowledgeDocs,
} from '../../custom/x-gateway/support-knowledge.js';
import { getSupportOutputPolicy } from '../../custom/x-gateway/support-output-store.js';
import { getSupportRuntimePolicy } from '../../custom/x-gateway/support-runtime-store.js';
import {
  getSupportDeskSlaPolicy,
  getSupportDeskWidgetConfig,
} from '../../custom/x-gateway/support-service-desk-store.js';
import {
  createSupportTenant,
  getSupportTenant,
  listSupportTenants,
} from '../../custom/x-gateway/support-store.js';
import { initDb } from '../../db/index.js';
import { createSession, createUser } from '../../services/auth.js';

let server: Server;
let base: string;

let primaryAdminId: number;
let primaryToken: string;
let unassignedUserToken: string;
let tenantMemberId: number;
let tenantMemberToken: string;
let existingTenantId: number;

async function hit(path: string, method = 'GET', body?: unknown, token?: string) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return {
    status: res.status,
    body: (await res.json().catch(() => null)) as Record<string, any> | null,
  };
}

describe('AI Support Setup Copilot (Guided Onboarding & Consent-Gated Auto-Deployment)', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = 'b'.repeat(64);
    initDb(':memory:');
    const app = createApp();
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const { port } = server.address() as { port: number };
    base = `http://127.0.0.1:${port}`;

    const admin = createUser('setup-admin@example.com', 'AdminPass123!');
    primaryAdminId = admin.userId;
    primaryToken = createSession(primaryAdminId);

    const outsider = createUser('outsider-setup@example.com', 'UserPass123!', 'member');
    unassignedUserToken = createSession(outsider.userId);

    const member = createUser('tenant-configurator@example.com', 'UserPass123!', 'member');
    tenantMemberId = member.userId;
    tenantMemberToken = createSession(tenantMemberId);

    existingTenantId = createSupportTenant({
      name: 'Existing Corp',
      slug: 'existing-corp',
      defaultModel: 'auto',
      systemPrompt: 'Initial prompt.',
      createdBy: primaryAdminId,
    }).tenant.id;

    // Grant ai_configurator preset to tenantMemberId on existingTenantId
    const assignRes = await hit(
      `/api/admin/tenant-memberships/tenants/${existingTenantId}/users/${tenantMemberId}`,
      'PUT',
      { rolePreset: 'ai_configurator' },
      primaryToken,
    );
    expect(assignRes.status).toBe(200);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('rejects unauthenticated requests and hides Copilot from unassigned members', async () => {
    const unauthStatus = await hit('/api/support-setup-copilot/status');
    expect(unauthStatus.status).toBe(401);

    const outsiderStatus = await hit('/api/support-setup-copilot/status', 'GET', undefined, unassignedUserToken);
    expect(outsiderStatus.status).toBe(200);
    expect(outsiderStatus.body?.visible).toBe(false);

    const outsiderChat = await hit(
      '/api/support-setup-copilot/chat',
      'POST',
      { messages: [{ role: 'user', content: 'Setup giúp tôi' }] },
      unassignedUserToken,
    );
    expect(outsiderChat.status).toBe(403);
  });

  it('coaches users through all 7 steps with live diagnostics in guide mode without creating proposals', async () => {
    const res = await hit(
      '/api/support-setup-copilot/chat',
      'POST',
      {
        tenantId: existingTenantId,
        locale: 'vi',
        messages: [
          {
            role: 'user',
            content: 'Hướng dẫn tôi chi tiết từng bước để có 1 con AI Support hoàn chỉnh',
          },
        ],
      },
      primaryToken,
    );

    expect(res.status).toBe(200);
    expect(res.body?.intent).toBe('guide');
    expect(res.body?.proposal).toBeNull();
    expect(String(res.body?.reply)).toContain('/thruline/support');
    expect(String(res.body?.reply)).toContain('/thruline/support-knowledge');
    expect(String(res.body?.reply)).toContain('/thruline/support-guardrails');
    expect(String(res.body?.reply)).toContain('/thruline/support-output');
    expect(String(res.body?.reply)).toContain('/thruline/support-desk');
    expect(String(res.body?.reply)).toContain('/thruline/support-integration');
    expect(String(res.body?.reply)).toContain('Existing Corp');
  });

  it('asks reasonable clarifying questions before proposing when requirements are missing', async () => {
    const tenantsBefore = listSupportTenants().length;
    const res = await hit(
      '/api/support-setup-copilot/chat',
      'POST',
      {
        targetMode: 'create_tenant',
        locale: 'vi',
        messages: [
          {
            role: 'user',
            content: 'Hãy thiết lập giúp cho shop của tôi một con AI Support',
          },
        ],
      },
      primaryToken,
    );

    expect(res.status).toBe(200);
    expect(res.body?.intent).toBe('gather_requirements');
    expect(res.body?.proposal).toBeNull();
    expect(Array.isArray(res.body?.missingQuestions)).toBe(true);
    expect((res.body?.missingQuestions as string[]).length).toBeGreaterThanOrEqual(3);
    expect(Array.isArray(res.body?.suggestedQuickReplies)).toBe(true);
    expect((res.body?.suggestedQuickReplies as string[]).length).toBeGreaterThanOrEqual(1);
    expect(listSupportTenants().length).toBe(tenantsBefore);
  });

  it('generates sanitized consent-gated proposals, supports refinement, enforces approved=true, and deploys end-to-end', async () => {
    const tenantsBefore = listSupportTenants().length;

    // 1. Propose full setup from customer requirements (without touching DB yet)
    const chatRes = await hit(
      '/api/support-setup-copilot/chat',
      'POST',
      {
        targetMode: 'create_tenant',
        locale: 'vi',
        messages: [
          { role: 'user', content: 'Setup tự động giúp tôi một con AI Support' },
          {
            role: 'user',
            content:
              'Shop mỹ phẩm GlowSkin, website https://glowskin.vn, đổi trả 7 ngày, freeship 300k, màu hồng #ec4899, giọng thân thiện, đối thủ RivalSkin',
          },
        ],
      },
      primaryToken,
    );

    expect(chatRes.status).toBe(200);
    expect(chatRes.body?.intent).toBe('propose_setup');
    const proposal = chatRes.body?.proposal;
    expect(proposal).toBeTruthy();
    expect(proposal.status).toBe('pending_consent');
    expect(proposal.targetMode).toBe('create_tenant');
    expect(proposal.tenantName).toBe('GlowSkin');
    expect(proposal.tenantSlug).toBe('glowskin');
    expect(proposal.requirements.primaryColor).toBe('#ec4899');
    expect(proposal.steps).toHaveLength(7);

    // Ensure no tenant was created prior to explicit customer approval
    expect(listSupportTenants().length).toBe(tenantsBefore);

    // 2. Refine the proposal using baseProposalId (overrides color + intake without losing GlowSkin/origin)
    const refineRes = await hit(
      '/api/support-setup-copilot/chat',
      'POST',
      {
        targetMode: 'create_tenant',
        locale: 'vi',
        baseProposalId: proposal.id,
        messages: [
          {
            role: 'user',
            content: 'Đổi màu sang xanh dương #2563eb và yêu cầu khách nhập email trước khi chat',
          },
        ],
      },
      primaryToken,
    );

    expect(refineRes.status).toBe(200);
    expect(refineRes.body?.intent).toBe('propose_setup');
    const refined = refineRes.body?.proposal;
    expect(refined.id).not.toBe(proposal.id);
    expect(refined.tenantName).toBe('GlowSkin');
    expect(refined.requirements.primaryColor).toBe('#2563eb');
    expect(refined.requirements.websiteOrigin).toBe('https://glowskin.vn');
    expect(refined.requirements.requireContactIntake).toBe(true);

    // 3. Reject applying without explicit approved: true
    const unapproved = await hit(
      `/api/support-setup-copilot/proposals/${refined.id}/apply`,
      'POST',
      { approved: false },
      primaryToken,
    );
    expect(unapproved.status).toBe(400);
    expect(unapproved.body?.error?.code).toBe('consent_required');
    expect(listSupportTenants().length).toBe(tenantsBefore);

    // 4. Another user cannot apply someone else's proposal
    const stolenApply = await hit(
      `/api/support-setup-copilot/proposals/${refined.id}/apply`,
      'POST',
      { approved: true },
      tenantMemberToken,
    );
    expect(stolenApply.status).toBe(404);

    // 5. Explicit approval deploys all 7 steps cleanly
    const applyRes = await hit(
      `/api/support-setup-copilot/proposals/${refined.id}/apply`,
      'POST',
      { approved: true },
      primaryToken,
    );
    expect(applyRes.status).toBe(200);
    expect(applyRes.body?.ok).toBe(true);
    expect(applyRes.body?.proposal?.status).toBe('applied');
    expect(applyRes.body?.diagnostic?.completedSteps).toBe(7);
    expect(applyRes.body?.diagnostic?.totalSteps).toBe(7);
    expect(String(applyRes.body?.diagnostic?.embedSnippet)).toContain('/thruline/v1/support/widget.js');

    const createdTenantId = Number(applyRes.body?.tenant?.id);
    expect(createdTenantId).toBeGreaterThan(0);

    // Verify real DB records across all 7 Support subsystems
    const tenant = getSupportTenant(createdTenantId);
    expect(tenant.enabled).toBe(true);
    expect(tenant.allowedOrigins).toEqual(['https://glowskin.vn']);
    expect(tenant.systemPrompt).toContain('GlowSkin');

    const kbDocs = listSupportKnowledgeDocs(String(createdTenantId));
    expect(kbDocs.length).toBeGreaterThanOrEqual(3);
    expect(kbDocs.every((d) => d.allowedRoles.includes('guest') && d.allowedRoles.includes('customer'))).toBe(true);

    const masking = getSupportMaskingPolicy(String(createdTenantId));
    expect(masking.enabled).toBe(true);

    const guardrails = getSupportGuardrailPolicy(String(createdTenantId));
    expect(guardrails.enabled).toBe(true);
    expect(guardrails.blockPromptInjection).toBe(true);
    expect(guardrails.competitorKeywords.some((k) => k.toLowerCase().includes('rivalskin'))).toBe(true);

    const outputPolicy = getSupportOutputPolicy(createdTenantId);
    expect(outputPolicy.mode).toBe('enforce');
    expect(outputPolicy.redactCredentials).toBe(true);
    expect(outputPolicy.blockedTerms.some((r) => r.text.toLowerCase().includes('rivalskin'))).toBe(true);

    const widgetConfig = getSupportDeskWidgetConfig(createdTenantId);
    expect(widgetConfig.enabled).toBe(true);
    expect(widgetConfig.appearance.primaryColor).toBe('#2563eb');
    expect(widgetConfig.intake.required).toBe(true);
    expect(widgetConfig.intake.fields.length).toBeGreaterThanOrEqual(2);

    const slaPolicy = getSupportDeskSlaPolicy(createdTenantId);
    expect(slaPolicy.enabled).toBe(true);
    expect(slaPolicy.routingRules.length).toBeGreaterThanOrEqual(3);

    const runtimePolicy = getSupportRuntimePolicy(createdTenantId);
    expect(runtimePolicy.maxCompletionTokens).toBe(640);

    // Ensure audit log recorded deployment
    const logs = listSupportAuditLogs(String(createdTenantId));
    expect(logs.some((entry) => entry.action === 'support.setup_copilot.apply')).toBe(true);

    // 6. Replaying the same proposal fails with 409
    const replay = await hit(
      `/api/support-setup-copilot/proposals/${refined.id}/apply`,
      'POST',
      { approved: true },
      primaryToken,
    );
    expect(replay.status).toBe(409);
    expect(replay.body?.error?.code).toBe('proposal_already_applied');
  });

  it('enforces granular Tenant-Portal RBAC for assigned tenant members', async () => {
    const statusRes = await hit('/api/support-setup-copilot/status', 'GET', undefined, tenantMemberToken);
    expect(statusRes.status).toBe(200);
    expect(statusRes.body?.visible).toBe(true);
    expect(statusRes.body?.canCreateTenant).toBe(false);
    expect(statusRes.body?.tenants).toHaveLength(1);
    expect(statusRes.body?.tenants[0]?.id).toBe(existingTenantId);

    const editable = statusRes.body?.tenants[0]?.canEditSteps as string[];
    expect(editable).toEqual(
      expect.arrayContaining([
        'tenant_ai',
        'knowledge_masking',
        'guardrails_quotas',
        'output_controls',
        'widget_appearance',
        'sla_routing',
      ]),
    );
    expect(editable).not.toContain('runtime_policy');

    const chatRes = await hit(
      '/api/support-setup-copilot/chat',
      'POST',
      {
        tenantId: existingTenantId,
        locale: 'en',
        messages: [
          {
            role: 'user',
            content: 'Existing Corp SaaS platform, support hours 24/7, professional English tone, collect customer email',
          },
        ],
      },
      tenantMemberToken,
    );
    expect(chatRes.status).toBe(200);
    expect(chatRes.body?.intent).toBe('propose_setup');
    const prop = chatRes.body?.proposal;
    expect(prop.targetMode).toBe('update_tenant');
    expect(prop.tenantId).toBe(existingTenantId);

    // Member cannot force-apply unpermitted step ('runtime_policy')
    const forbiddenApply = await hit(
      `/api/support-setup-copilot/proposals/${prop.id}/apply`,
      'POST',
      { approved: true, selectedSteps: ['runtime_policy'] },
      tenantMemberToken,
    );
    expect(forbiddenApply.status).toBe(403);

    // Member CAN apply permitted steps (default selectedSteps only include permitted ones)
    const permittedApply = await hit(
      `/api/support-setup-copilot/proposals/${prop.id}/apply`,
      'POST',
      { approved: true },
      tenantMemberToken,
    );
    expect(permittedApply.status).toBe(200);
    const runtimeResult = (permittedApply.body?.stepResults as Array<{ stepId: string; status: string }>).find(
      (r) => r.stepId === 'runtime_policy',
    );
    expect(runtimeResult?.status).toBe('skipped');
    const kbResult = (permittedApply.body?.stepResults as Array<{ stepId: string; status: string }>).find(
      (r) => r.stepId === 'knowledge_masking',
    );
    expect(kbResult?.status).toBe('applied');
  });

  it('supports declining a pending proposal cleanly without altering tenant state', async () => {
    appendSupportAuditLog({ tenantId: String(existingTenantId), action: 'test.marker' });
    const chatRes = await hit(
      '/api/support-setup-copilot/chat',
      'POST',
      {
        tenantId: existingTenantId,
        locale: 'vi',
        messages: [{ role: 'user', content: 'Hoàn thiện cấu hình tiêu chuẩn cho tenant hiện tại' }],
      },
      primaryToken,
    );
    expect(chatRes.status).toBe(200);
    const propId = chatRes.body?.proposal?.id as string;
    expect(propId).toBeTruthy();

    const declineRes = await hit(
      `/api/support-setup-copilot/proposals/${propId}/decline`,
      'POST',
      {},
      primaryToken,
    );
    expect(declineRes.status).toBe(200);
    expect(declineRes.body?.proposal?.status).toBe('declined');

    const applyDeclined = await hit(
      `/api/support-setup-copilot/proposals/${propId}/apply`,
      'POST',
      { approved: true },
      primaryToken,
    );
    expect(applyDeclined.status).toBe(409);
  });
});
