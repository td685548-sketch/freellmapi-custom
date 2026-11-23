import http, { type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import {
  detectConversationLocale,
  parseLlmCoachResponse,
} from '../../custom/support-setup-copilot/playbook.js';
import { appendSupportAuditLog, listSupportAuditLogs } from '../../custom/x-gateway/support-enterprise-router.js';
import { listSupportEvidenceSources } from '../../custom/x-gateway/support-evidence-store.js';
import { getSupportGuardrailPolicy } from '../../custom/x-gateway/support-guardrails.js';
import {
  getSupportMaskingPolicy,
  listSupportKnowledgeDocs,
} from '../../custom/x-gateway/support-knowledge.js';
import { getSupportOutputPolicy } from '../../custom/x-gateway/support-output-store.js';
import {
  getSupportRuntimePolicy,
  updateSupportRuntimePolicy,
} from '../../custom/x-gateway/support-runtime-store.js';
import {
  getSupportDeskSlaPolicy,
  getSupportDeskWidgetConfig,
} from '../../custom/x-gateway/support-service-desk-store.js';
import {
  createSupportTenant,
  createSupportTool,
  getSupportTenant,
  listSupportTenants,
} from '../../custom/x-gateway/support-store.js';
import { getDb, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { createSession, createUser } from '../../services/auth.js';
import { invalidateKeyCache } from '../../services/key-cache.js';
import { setUserPermissions } from '../../services/users.js';

import { dashboardSessionHeaders } from '../helpers/auth.js';
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
      ...(token ? { ...dashboardSessionHeaders(token) } : {}),
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

  it('blocks non-setup tenant members, read-only viewers, and Thruline read-only accounts from escalating read or write access', async () => {
    // 1. Member with ONLY non-setup tenant leaves (view_tenant_members, reply_tenant_desk, view_tenant_analytics)
    // must get visible: false and 403 on chat (zero setup diagnostics leaked).
    const nonSetupMember = createUser('team-only@example.com', 'UserPass123!', 'member');
    const nonSetupToken = createSession(nonSetupMember.userId);
    const assignNonSetup = await hit(
      `/api/admin/tenant-memberships/tenants/${existingTenantId}/users/${nonSetupMember.userId}`,
      'PUT',
      {
        rolePreset: 'custom',
        permissions: ['view_tenant_members', 'reply_tenant_desk', 'view_tenant_analytics'],
      },
      primaryToken,
    );
    expect(assignNonSetup.status).toBe(200);

    const nonSetupStatus = await hit('/api/support-setup-copilot/status', 'GET', undefined, nonSetupToken);
    expect(nonSetupStatus.status).toBe(200);
    expect(nonSetupStatus.body?.visible).toBe(false);
    expect(nonSetupStatus.body?.activeTenant).toBeNull();

    const nonSetupChat = await hit(
      '/api/support-setup-copilot/chat',
      'POST',
      { tenantId: existingTenantId, messages: [{ role: 'user', content: 'Setup giúp tôi' }] },
      nonSetupToken,
    );
    expect(nonSetupChat.status).toBe(403);

    // 2. Read-only Tenant Viewer ('viewer' preset): can view diagnostics & guide,
    // but NEVER generates pending_consent proposals and CANNOT create tenants.
    const viewerUser = createUser('tenant-viewer@example.com', 'UserPass123!', 'member');
    const viewerToken = createSession(viewerUser.userId);
    const assignViewer = await hit(
      `/api/admin/tenant-memberships/tenants/${existingTenantId}/users/${viewerUser.userId}`,
      'PUT',
      { rolePreset: 'viewer' },
      primaryToken,
    );
    expect(assignViewer.status).toBe(200);

    const viewerStatus = await hit('/api/support-setup-copilot/status', 'GET', undefined, viewerToken);
    expect(viewerStatus.status).toBe(200);
    expect(viewerStatus.body?.visible).toBe(true);
    expect(viewerStatus.body?.canCreateTenant).toBe(false);
    expect(viewerStatus.body?.tenants[0]?.canEditSteps).toEqual([]);

    const viewerAutoSetup = await hit(
      '/api/support-setup-copilot/chat',
      'POST',
      {
        tenantId: existingTenantId,
        locale: 'vi',
        requirementsHint: {
          brandName: 'Unauthorized Brand',
          industry: 'Retail',
          faqSummaryOrPolicies: 'No refunds',
        },
        messages: [
          {
            role: 'user',
            content: 'Shop mỹ phẩm GlowSkin, website https://glowskin.vn, đổi trả 7 ngày, setup giúp tôi',
          },
        ],
      },
      viewerToken,
    );
    expect(viewerAutoSetup.status).toBe(200);
    expect(viewerAutoSetup.body?.intent).toBe('guide');
    expect(viewerAutoSetup.body?.proposal).toBeNull();
    expect(String(viewerAutoSetup.body?.reply)).toContain('Read-Only');

    const viewerCreateAttempt = await hit(
      '/api/support-setup-copilot/chat',
      'POST',
      {
        targetMode: 'create_tenant',
        locale: 'vi',
        messages: [{ role: 'user', content: 'Tạo mới 1 tenant AI Support tên HackTenant' }],
      },
      viewerToken,
    );
    expect(viewerCreateAttempt.status).toBe(200);
    expect(viewerCreateAttempt.body?.intent).toBe('guide');
    expect(viewerCreateAttempt.body?.proposal).toBeNull();

    // 3. Thruline read-only operator ('use_x_gateway' WITHOUT 'edit_x_settings'):
    // output_controls requires 'edit_x_settings', so step 4 must be 'restricted' (canView: false).
    const thrulineViewer = createUser('thruline-readonly@example.com', 'UserPass123!', 'member');
    setUserPermissions(thrulineViewer.userId, ['use_x_gateway'], primaryAdminId);
    const thrulineViewerToken = createSession(thrulineViewer.userId);

    const thrulineStatus = await hit(
      `/api/support-setup-copilot/status?tenantId=${existingTenantId}`,
      'GET',
      undefined,
      thrulineViewerToken,
    );
    expect(thrulineStatus.status).toBe(200);
    expect(thrulineStatus.body?.visible).toBe(true);
    expect(thrulineStatus.body?.canCreateTenant).toBe(false);
    const outputDiag = (thrulineStatus.body?.activeTenant?.steps as Array<Record<string, any>>).find(
      (s) => s.stepId === 'output_controls',
    );
    expect(outputDiag?.status).toBe('restricted');
    expect(outputDiag?.canView).toBe(false);
    expect(outputDiag?.canEdit).toBe(false);
  });

  it('prevents cross-step write escalation, cross-section read leaks, Evidence library escalation, toolPolicy wiping, unlisted model injection, and cross-tenant access', async () => {
    const lockedTenant = createSupportTenant({
      name: 'Vault FinTech',
      slug: 'vault-fintech',
      defaultModel: 'auto',
      systemPrompt: 'Initial Vault prompt.',
      allowedOrigins: ['https://vault.fintech.example'],
      createdBy: primaryAdminId,
    }).tenant;

    const sensitiveTool = createSupportTool(lockedTenant.id, {
      name: 'refund_wire_transfer',
      description: 'Refund a high-value wire transfer',
      endpointUrl: 'https://api.fintech.example/refund',
      httpMethod: 'POST',
      allowedRoles: ['customer', 'admin'],
    });
    updateSupportRuntimePolicy(lockedTenant.id, {
      toolPolicies: [{ toolId: sensitiveTool.id, mode: 'approval_required' }],
    });

    // 1. Cross-tenant isolation: tenantMemberToken (only assigned to existingTenantId) cannot query or chat against lockedTenant
    const crossChat = await hit(
      '/api/support-setup-copilot/chat',
      'POST',
      {
        tenantId: lockedTenant.id,
        messages: [{ role: 'user', content: 'Hoàn thiện cấu hình tiêu chuẩn cho tenant hiện tại' }],
      },
      tenantMemberToken,
    );
    expect(crossChat.status).toBe(403);

    // 2. Single-leaf user with ONLY 'edit_tenant_ai' on lockedTenant:
    // - Cannot view Steps 2–7, embedSnippet, or allowedOrigins
    // - Cannot modify allowedOrigins even if supplying websiteOrigin in chat
    // - Cannot inject an unlisted internal model ID
    const aiOnlyUser = createUser('ai-only@example.com', 'UserPass123!', 'member');
    const aiOnlyToken = createSession(aiOnlyUser.userId);
    await hit(
      `/api/admin/tenant-memberships/tenants/${lockedTenant.id}/users/${aiOnlyUser.userId}`,
      'PUT',
      { rolePreset: 'custom', permissions: ['edit_tenant_ai'] },
      primaryToken,
    );

    const aiOnlyStatus = await hit(
      `/api/support-setup-copilot/status?tenantId=${lockedTenant.id}`,
      'GET',
      undefined,
      aiOnlyToken,
    );
    expect(aiOnlyStatus.status).toBe(200);
    expect(aiOnlyStatus.body?.activeTenant?.embedSnippet).toBe('');
    expect(aiOnlyStatus.body?.activeTenant?.tenant?.allowedOrigins).toEqual([]);
    const restrictedSteps = (aiOnlyStatus.body?.activeTenant?.steps as Array<Record<string, any>>).filter(
      (s) => s.stepId !== 'tenant_ai',
    );
    expect(restrictedSteps).toHaveLength(6);
    expect(restrictedSteps.every((s) => s.status === 'restricted' && s.canView === false && s.canEdit === false)).toBe(
      true,
    );

    const aiOnlyPropose = await hit(
      '/api/support-setup-copilot/chat',
      'POST',
      {
        tenantId: lockedTenant.id,
        locale: 'en',
        requirementsHint: {
          brandName: 'Vault FinTech AI',
          industry: 'FinTech Banking',
          websiteOrigin: 'https://attacker-origin.evil.test',
          faqSummaryOrPolicies: '24/7 card freeze support',
          defaultModel: 'unlisted-private-root-model-v9',
        },
        messages: [{ role: 'user', content: 'Set up Vault FinTech AI' }],
      },
      aiOnlyToken,
    );
    expect(aiOnlyPropose.status).toBe(200);
    const aiProp = aiOnlyPropose.body?.proposal;
    expect(aiProp).toBeTruthy();
    // Unlisted model was sanitized back to existing safe 'auto'
    expect(aiProp.requirements.defaultModel).toBe('auto');
    // Unpermitted steps have scrubbed empty payloads
    for (const step of aiProp.steps as Array<Record<string, any>>) {
      if (step.stepId === 'tenant_ai') {
        expect(step.canApply).toBe(true);
      } else {
        expect(step.canApply).toBe(false);
        expect(step.payload).toEqual({});
      }
    }

    const aiOnlyApply = await hit(
      `/api/support-setup-copilot/proposals/${aiProp.id}/apply`,
      'POST',
      { approved: true },
      aiOnlyToken,
    );
    expect(aiOnlyApply.status).toBe(200);
    // CRITICAL: allowedOrigins on lockedTenant MUST remain untouched!
    expect(getSupportTenant(lockedTenant.id).allowedOrigins).toEqual([
      'https://vault.fintech.example',
    ]);
    expect(getSupportTenant(lockedTenant.id).name).toBe('Vault FinTech AI');

    // Even if proposal_json in DB were tampered with an unlisted model, executor defense-in-depth blocks it with 403
    const secondAiChat = await hit(
      '/api/support-setup-copilot/chat',
      'POST',
      {
        tenantId: lockedTenant.id,
        locale: 'en',
        requirementsHint: { brandName: 'Vault FinTech AI', industry: 'FinTech' },
        messages: [{ role: 'user', content: 'Update AI persona' }],
      },
      aiOnlyToken,
    );
    const tamperedProp = secondAiChat.body?.proposal;
    tamperedProp.steps[0].payload.defaultModel = 'tampered-internal-model';
    getDb()
      .prepare('UPDATE custom_support_setup_proposals SET proposal_json = ? WHERE id = ?')
      .run(JSON.stringify(tamperedProp), tamperedProp.id);

    const tamperedApply = await hit(
      `/api/support-setup-copilot/proposals/${tamperedProp.id}/apply`,
      'POST',
      { approved: true },
      aiOnlyToken,
    );
    expect(tamperedApply.status).toBe(403);

    // 3. Single-leaf 'edit_tenant_knowledge' user seeds KB + masking WITHOUT writing Platform-Operator Evidence sources
    const kbOnlyUser = createUser('kb-only@example.com', 'UserPass123!', 'member');
    const kbOnlyToken = createSession(kbOnlyUser.userId);
    await hit(
      `/api/admin/tenant-memberships/tenants/${lockedTenant.id}/users/${kbOnlyUser.userId}`,
      'PUT',
      { rolePreset: 'custom', permissions: ['edit_tenant_knowledge'] },
      primaryToken,
    );

    const kbChat = await hit(
      '/api/support-setup-copilot/chat',
      'POST',
      {
        tenantId: lockedTenant.id,
        locale: 'en',
        requirementsHint: {
          brandName: 'Vault FinTech AI',
          industry: 'FinTech',
          faqSummaryOrPolicies: 'Wire transfers settle in 1 business day.',
        },
        messages: [{ role: 'user', content: 'Seed FAQ knowledge' }],
      },
      kbOnlyToken,
    );
    const kbApply = await hit(
      `/api/support-setup-copilot/proposals/${kbChat.body?.proposal?.id}/apply`,
      'POST',
      { approved: true },
      kbOnlyToken,
    );
    expect(kbApply.status).toBe(200);
    expect(listSupportKnowledgeDocs(String(lockedTenant.id)).length).toBeGreaterThanOrEqual(3);
    expect(listSupportEvidenceSources(lockedTenant.id)).toHaveLength(0);

    // 4. Single-leaf 'edit_tenant_integration' user updates CORS + runtime WITHOUT wiping approval_required toolPolicies
    const integrationOnlyUser = createUser('integration-only@example.com', 'UserPass123!', 'member');
    const integrationOnlyToken = createSession(integrationOnlyUser.userId);
    await hit(
      `/api/admin/tenant-memberships/tenants/${lockedTenant.id}/users/${integrationOnlyUser.userId}`,
      'PUT',
      { rolePreset: 'custom', permissions: ['edit_tenant_integration'] },
      primaryToken,
    );

    const intChat = await hit(
      '/api/support-setup-copilot/chat',
      'POST',
      {
        tenantId: lockedTenant.id,
        locale: 'en',
        requirementsHint: {
          brandName: 'Vault FinTech AI',
          industry: 'FinTech',
          websiteOrigin: 'https://app.fintech.example',
        },
        messages: [{ role: 'user', content: 'Configure CORS origin https://app.fintech.example' }],
      },
      integrationOnlyToken,
    );
    const intApply = await hit(
      `/api/support-setup-copilot/proposals/${intChat.body?.proposal?.id}/apply`,
      'POST',
      { approved: true },
      integrationOnlyToken,
    );
    expect(intApply.status).toBe(200);
    expect(getSupportTenant(lockedTenant.id).allowedOrigins).toEqual([
      'https://app.fintech.example',
    ]);
    expect(getSupportRuntimePolicy(lockedTenant.id).toolPolicies).toEqual([
      { toolId: sensitiveTool.id, mode: 'approval_required' },
    ]);
  });

  it('enforces live RBAC on TOCTOU permission downgrade or revocation after a proposal is drafted', async () => {
    const toctouUser = createUser('toctou-member@example.com', 'UserPass123!', 'member');
    const toctouToken = createSession(toctouUser.userId);

    // Initially grant ai_configurator (6 editable steps)
    await hit(
      `/api/admin/tenant-memberships/tenants/${existingTenantId}/users/${toctouUser.userId}`,
      'PUT',
      { rolePreset: 'ai_configurator' },
      primaryToken,
    );

    const draftRes = await hit(
      '/api/support-setup-copilot/chat',
      'POST',
      {
        tenantId: existingTenantId,
        locale: 'vi',
        messages: [{ role: 'user', content: 'Hoàn thiện cấu hình tiêu chuẩn cho tenant hiện tại' }],
      },
      toctouToken,
    );
    expect(draftRes.status).toBe(200);
    const proposalId = draftRes.body?.proposal?.id as string;
    expect(proposalId).toBeTruthy();

    // Admin downgrades user BEFORE apply: now ONLY allowed 'edit_tenant_widget' (revoking AI, KB, Guardrails)
    const downgradeRes = await hit(
      `/api/admin/tenant-memberships/tenants/${existingTenantId}/users/${toctouUser.userId}`,
      'PUT',
      { rolePreset: 'custom', permissions: ['edit_tenant_widget'] },
      primaryToken,
    );
    expect(downgradeRes.status).toBe(200);

    // GET /status immediately re-projects pendingProposals so revoked steps show canApply=false & empty payload
    const statusAfterDowngrade = await hit(
      `/api/support-setup-copilot/status?tenantId=${existingTenantId}`,
      'GET',
      undefined,
      toctouToken,
    );
    expect(statusAfterDowngrade.status).toBe(200);
    const projected = (statusAfterDowngrade.body?.pendingProposals as Array<Record<string, any>>).find(
      (p) => p.id === proposalId,
    );
    expect(projected).toBeTruthy();
    const projectedEditable = (projected?.steps as Array<Record<string, any>>)
      .filter((s) => s.canApply)
      .map((s) => s.stepId);
    expect(projectedEditable).toEqual(['widget_appearance', 'sla_routing']);

    // Default apply (which includes originally drafted steps that were just revoked) MUST fail with 403!
    const staleApply = await hit(
      `/api/support-setup-copilot/proposals/${proposalId}/apply`,
      'POST',
      { approved: true },
      toctouToken,
    );
    expect(staleApply.status).toBe(403);

    // Applying ONLY a still-permitted step ('widget_appearance') succeeds cleanly
    const scopedApply = await hit(
      `/api/support-setup-copilot/proposals/${proposalId}/apply`,
      'POST',
      { approved: true, selectedSteps: ['widget_appearance'] },
      toctouToken,
    );
    expect(scopedApply.status).toBe(200);
    const appliedIds = (scopedApply.body?.stepResults as Array<{ stepId: string; status: string }>)
      .filter((r) => r.status === 'applied')
      .map((r) => r.stepId);
    expect(appliedIds).toEqual(['widget_appearance']);

    // Draft one more proposal, then downgrade user to 'viewer' (0 edit steps) -> status hides pending proposals and apply fails 403
    const draft2 = await hit(
      '/api/support-setup-copilot/chat',
      'POST',
      {
        tenantId: existingTenantId,
        locale: 'vi',
        messages: [{ role: 'user', content: 'Hoàn thiện cấu hình tiêu chuẩn cho tenant hiện tại' }],
      },
      toctouToken,
    );
    const prop2Id = draft2.body?.proposal?.id as string;
    expect(prop2Id).toBeTruthy();

    await hit(
      `/api/admin/tenant-memberships/tenants/${existingTenantId}/users/${toctouUser.userId}`,
      'PUT',
      { rolePreset: 'viewer' },
      primaryToken,
    );

    const viewerStatus = await hit(
      `/api/support-setup-copilot/status?tenantId=${existingTenantId}`,
      'GET',
      undefined,
      toctouToken,
    );
    expect(viewerStatus.body?.pendingProposals).toEqual([]);

    const revokedApply = await hit(
      `/api/support-setup-copilot/proposals/${prop2Id}/apply`,
      'POST',
      { approved: true, selectedSteps: ['widget_appearance'] },
      toctouToken,
    );
    expect(revokedApply.status).toBe(403);
  });

  it('automatically switches to Vietnamese even when UI locale is English and varies replies naturally without repeating boilerplate', async () => {
    // 1. Exact reproduction of user screenshot: UI sends locale='en' after an English turn,
    // and user asks "bạn có thể nói tiếng việt không"
    const langAskRes = await hit(
      '/api/support-setup-copilot/chat',
      'POST',
      {
        tenantId: existingTenantId,
        locale: 'en',
        messages: [
          { role: 'user', content: 'Set up a complete AI Support assistant for me' },
          {
            role: 'assistant',
            content:
              'I can configure all 7 AI Support steps for you and present a plan for your approval before making any changes.',
          },
          { role: 'user', content: 'bạn có thể nói tiếng việt không' },
        ],
      },
      primaryToken,
    );

    expect(langAskRes.status).toBe(200);
    expect(langAskRes.body?.replyLocale).toBe('vi');
    expect(langAskRes.body?.intent).toBe('guide');
    expect(String(langAskRes.body?.reply)).toContain('tiếng Việt');
    expect(String(langAskRes.body?.reply)).not.toContain('I can **configure all 7 AI Support steps**');
    expect(
      (langAskRes.body?.suggestedQuickReplies as string[]).some((q) => /tiêu chuẩn|7 bước|GlowSkin/i.test(q)),
    ).toBe(true);

    // 2. Greeting in unaccented Vietnamese with UI locale='en' -> distinct warm Vietnamese greeting
    const greetRes = await hit(
      '/api/support-setup-copilot/chat',
      'POST',
      {
        tenantId: existingTenantId,
        locale: 'en',
        messages: [{ role: 'user', content: 'xin chao ban' }],
      },
      primaryToken,
    );
    expect(greetRes.status).toBe(200);
    expect(greetRes.body?.replyLocale).toBe('vi');
    expect(greetRes.body?.reply).not.toBe(langAskRes.body?.reply);
    expect(String(greetRes.body?.reply)).toContain('Chào bạn');

    // 3. Focused single-step question -> answers specifically about Step 2 (RAG & PII Masking)
    const step2Res = await hit(
      '/api/support-setup-copilot/chat',
      'POST',
      {
        tenantId: existingTenantId,
        locale: 'en',
        messages: [{ role: 'user', content: 'bước 2 nạp tài liệu FAQ làm sao để khách thấy được?' }],
      },
      primaryToken,
    );
    expect(step2Res.status).toBe(200);
    expect(step2Res.body?.replyLocale).toBe('vi');
    expect(step2Res.body?.intent).toBe('guide');
    expect(String(step2Res.body?.reply)).toContain('Bước 2');
    expect(String(step2Res.body?.reply)).toContain('allowedRoles');
    expect(step2Res.body?.reply).not.toBe(greetRes.body?.reply);

    // 4. User says "chưa có website, tùy bạn dùng mặc định làm luôn đi" -> immediately generates Vietnamese proposal!
    const proceedNowRes = await hit(
      '/api/support-setup-copilot/chat',
      'POST',
      {
        tenantId: existingTenantId,
        locale: 'en',
        messages: [
          { role: 'user', content: 'bạn có thể nói tiếng việt không' },
          { role: 'user', content: 'tôi chưa có website, tùy bạn dùng mặc định làm luôn giúp mình đi' },
        ],
      },
      primaryToken,
    );
    expect(proceedNowRes.status).toBe(200);
    expect(proceedNowRes.body?.replyLocale).toBe('vi');
    expect(proceedNowRes.body?.intent).toBe('propose_setup');
    expect(proceedNowRes.body?.proposal).toBeTruthy();
    expect(String(proceedNowRes.body?.reply)).toContain('Chờ xác nhận triển khai');
  });

  it('parses fenced, prose-wrapped, and plain-text LLM replies resiliently and detects conversation locale', () => {
    expect(
      detectConversationLocale([{ role: 'user', content: 'bạn có thể nói tiếng việt không' }], 'en'),
    ).toBe('vi');
    expect(
      detectConversationLocale([{ role: 'user', content: 'giup toi thiet lap shop' }], 'en'),
    ).toBe('vi');
    expect(
      detectConversationLocale([{ role: 'user', content: 'How do I configure CORS origins?' }], 'vi'),
    ).toBe('en');

    const proseWrapped = parseLlmCoachResponse(
      'Dưới đây là phản hồi:\n```json\n{"intent":"guide","reply":"Dạ mình hỗ trợ tiếng Việt 100% ạ!"}\n```',
    );
    expect(proseWrapped?.intent).toBe('guide');
    expect(proseWrapped?.reply).toBe('Dạ mình hỗ trợ tiếng Việt 100% ạ!');

    const plainProse = parseLlmCoachResponse(
      'Dạ chào bạn! Mình hoàn toàn giao tiếp bằng tiếng Việt tự nhiên nhé.',
    );
    expect(plainProse?.reply).toContain('tiếng Việt tự nhiên');
  });

  it('converses like a warm human onboarding specialist for open-domain businesses (boardgame regression + multi-turn progression) without numbered forms or repetition', async () => {
    const humanTestAdmin = createUser('human-persona-admin@example.com', 'AdminPass123!');
    setUserPermissions(humanTestAdmin.userId, ['*'], primaryAdminId);
    const humanAdminToken = createSession(humanTestAdmin.userId);

    const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    const assistantReplies: string[] = [];

    // Turn 1: Exact user message "tôi đang có web boardgame, và muốn setup" on an active tenant (like EXE)
    history.push({ role: 'user', content: 'tôi đang có web boardgame, và muốn setup' });
    const turn1 = await hit(
      '/api/support-setup-copilot/chat',
      'POST',
      {
        tenantId: existingTenantId,
        locale: 'vi',
        messages: [...history],
      },
      humanAdminToken,
    );

    expect(turn1.status).toBe(200);
    expect(turn1.body?.intent).toBe('gather_requirements');
    expect(turn1.body?.proposal).toBeNull();
    const reply1 = String(turn1.body?.reply ?? '');
    // Must warmly acknowledge boardgame and relevant customer questions, NEVER dump a numbered 1. 2. 3. form
    expect(reply1.toLowerCase()).toContain('boardgame');
    expect(reply1).toMatch(/người chơi|luật chơi|sleeves|mảnh ghép/i);
    expect(reply1).not.toMatch(/(?:^|\n)\s*1[.)]\s+/m);
    expect(reply1).not.toMatch(/lĩnh vực kinh doanh\s*\/\s*sản phẩm chính của bạn/i);
    expect(
      (turn1.body?.suggestedQuickReplies as string[]).some((q) => /boardgame|meeple/i.test(q)),
    ).toBe(true);
    history.push({ role: 'assistant', content: reply1 });
    assistantReplies.push(reply1);

    // Turn 2: Exact user pushback "bạn có thể làm gì mà"
    history.push({ role: 'user', content: 'bạn có thể làm gì mà' });
    const turn2 = await hit(
      '/api/support-setup-copilot/chat',
      'POST',
      {
        tenantId: existingTenantId,
        locale: 'vi',
        messages: [...history],
      },
      humanAdminToken,
    );

    expect(turn2.status).toBe(200);
    expect(turn2.body?.intent).toBe('guide');
    expect(turn2.body?.proposal).toBeNull();
    const reply2 = String(turn2.body?.reply ?? '');
    expect(reply2.toLowerCase()).toContain('boardgame');
    expect(reply2).not.toMatch(/(?:^|\n)\s*1[.)]\s+/m);
    expect(reply2).not.toBe(reply1);
    history.push({ role: 'assistant', content: reply2 });
    assistantReplies.push(reply2);

    // Turn 3: Frustration pushback "sao trả lời cứng nhắc vậy"
    history.push({ role: 'user', content: 'sao trả lời cứng nhắc vậy' });
    const turn3 = await hit(
      '/api/support-setup-copilot/chat',
      'POST',
      {
        tenantId: existingTenantId,
        locale: 'vi',
        messages: [...history],
      },
      humanAdminToken,
    );

    expect(turn3.status).toBe(200);
    expect(turn3.body?.intent).toBe('guide');
    expect(turn3.body?.proposal).toBeNull();
    const reply3 = String(turn3.body?.reply ?? '');
    expect(reply3).toMatch(/xin lỗi|máy móc|cứng nhắc/i);
    expect(reply3).not.toMatch(/(?:^|\n)\s*1[.)]\s+/m);
    history.push({ role: 'assistant', content: reply3 });
    assistantReplies.push(reply3);

    // Turn 4: "chưa có website đâu"
    history.push({ role: 'user', content: 'chưa có website đâu' });
    const turn4 = await hit(
      '/api/support-setup-copilot/chat',
      'POST',
      {
        tenantId: existingTenantId,
        locale: 'vi',
        messages: [...history],
      },
      humanAdminToken,
    );

    expect(turn4.status).toBe(200);
    expect(turn4.body?.intent).toBe('gather_requirements');
    expect(turn4.body?.proposal).toBeNull();
    const reply4 = String(turn4.body?.reply ?? '');
    expect(reply4).toMatch(/không sao|thử nghiệm|quản trị/i);
    expect(reply4).not.toMatch(/(?:^|\n)\s*1[.)]\s+/m);
    history.push({ role: 'assistant', content: reply4 });
    assistantReplies.push(reply4);

    // Turn 5: "ok lên bản mẫu luôn đi" -> generates pending_consent proposal tailored to Boardgame!
    history.push({ role: 'user', content: 'ok lên bản mẫu luôn đi' });
    const turn5 = await hit(
      '/api/support-setup-copilot/chat',
      'POST',
      {
        tenantId: existingTenantId,
        locale: 'vi',
        messages: [...history],
      },
      humanAdminToken,
    );

    expect(turn5.status).toBe(200);
    expect(turn5.body?.intent).toBe('propose_setup');
    const reply5 = String(turn5.body?.reply ?? '');
    expect(reply5).toContain('Chờ xác nhận triển khai');
    assistantReplies.push(reply5);

    // Guarantee zero repeated replies across all 5 turns
    expect(new Set(assistantReplies).size).toBe(5);

    const boardgameProposal = turn5.body?.proposal;
    expect(boardgameProposal).toBeTruthy();
    expect(boardgameProposal.status).toBe('pending_consent');
    expect(boardgameProposal.requirements.industry).toMatch(/Boardgame/i);
    expect(boardgameProposal.requirements.websiteOrigin).toBe('*');

    const tenantStep = (boardgameProposal.steps as Array<Record<string, any>>).find(
      (s) => s.stepId === 'tenant_ai',
    );
    expect(String(tenantStep?.payload?.systemPrompt ?? '')).toMatch(/Boardgame/i);
    expect(String(tenantStep?.payload?.systemPrompt ?? '')).toMatch(/người chơi|sleeves/i);

    const kbStep = (boardgameProposal.steps as Array<Record<string, any>>).find(
      (s) => s.stepId === 'knowledge_masking',
    );
    const kbCombinedContent = ((kbStep?.payload?.docs as Array<{ content: string }>) ?? [])
      .map((d) => d.content)
      .join('\n');
    expect(kbCombinedContent).toMatch(/boardgame/i);
    expect(kbCombinedContent).toMatch(/người chơi|bọc bài|mảnh ghép/i);

    const widgetStep = (boardgameProposal.steps as Array<Record<string, any>>).find(
      (s) => s.stepId === 'widget_appearance',
    );
    const widgetPrompts = (widgetStep?.payload?.appearance?.quickPrompts as string[]) ?? [];
    expect(widgetPrompts.some((p) => /boardgame|sleeves|mảnh ghép/i.test(p))).toBe(true);

    // Open-ended uncurated domain test: handmade ceramics shop ("tiệm gốm thủ công")
    const ceramicsRes = await hit(
      '/api/support-setup-copilot/chat',
      'POST',
      {
        targetMode: 'create_tenant',
        locale: 'vi',
        messages: [
          {
            role: 'user',
            content:
              'Mình đang mở tiệm gốm thủ công, tên là Gốm Mộc, đổi trả 7 ngày nếu nứt vỡ khi vận chuyển, màu cam',
          },
        ],
      },
      humanAdminToken,
    );
    expect(ceramicsRes.status).toBe(200);
    expect(ceramicsRes.body?.intent).toBe('propose_setup');
    expect(ceramicsRes.body?.proposal?.tenantName).toBe('Gốm Mộc');
    expect(String(ceramicsRes.body?.proposal?.requirements?.industry ?? '')).toMatch(/gốm thủ công/i);
    const ceramicsPrompt = String(
      (ceramicsRes.body?.proposal?.steps as Array<Record<string, any>>).find(
        (s) => s.stepId === 'tenant_ai',
      )?.payload?.systemPrompt ?? '',
    );
    expect(ceramicsPrompt).toMatch(/Gốm Mộc/);
    expect(ceramicsPrompt).toMatch(/gốm thủ công/i);

    // Polite >= 60-char exploratory setup request must NOT be stuffed into faqSummaryOrPolicies or trigger premature Turn-1 propose_setup
    const politeLongOpen =
      'chào bạn, hiện tại bên mình đang có một trang web bán boardgame và muốn setup';
    expect(politeLongOpen.length).toBeGreaterThanOrEqual(60);
    const politeTurn1 = await hit(
      '/api/support-setup-copilot/chat',
      'POST',
      {
        tenantId: existingTenantId,
        locale: 'vi',
        messages: [{ role: 'user', content: politeLongOpen }],
      },
      humanAdminToken,
    );
    expect(politeTurn1.status).toBe(200);
    expect(politeTurn1.body?.intent).toBe('gather_requirements');
    expect(politeTurn1.body?.proposal).toBeNull();

    const politeTurn2 = await hit(
      '/api/support-setup-copilot/chat',
      'POST',
      {
        tenantId: existingTenantId,
        locale: 'vi',
        messages: [
          { role: 'user', content: politeLongOpen },
          { role: 'assistant', content: String(politeTurn1.body?.reply ?? '') },
          { role: 'user', content: 'ok lên bản mẫu luôn đi' },
        ],
      },
      humanAdminToken,
    );
    expect(politeTurn2.status).toBe(200);
    expect(politeTurn2.body?.intent).toBe('propose_setup');
    const politeKbDocs =
      ((politeTurn2.body?.proposal?.steps as Array<Record<string, any>>).find(
        (s) => s.stepId === 'knowledge_masking',
      )?.payload?.docs as Array<{ content: string }>) ?? [];
    expect(politeKbDocs.map((d) => d.content).join('\n')).not.toContain(politeLongOpen);

    // Unaccented Vietnamese under English UI locale ("toi dang co web boardgame, va muon setup" -> "ban co the lam gi ma")
    const unaccented1 = await hit(
      '/api/support-setup-copilot/chat',
      'POST',
      {
        tenantId: existingTenantId,
        locale: 'en',
        messages: [{ role: 'user', content: 'toi dang co web boardgame, va muon setup' }],
      },
      humanAdminToken,
    );
    expect(unaccented1.status).toBe(200);
    expect(unaccented1.body?.replyLocale).toBe('vi');
    expect(unaccented1.body?.intent).toBe('gather_requirements');

    const unaccented2 = await hit(
      '/api/support-setup-copilot/chat',
      'POST',
      {
        tenantId: existingTenantId,
        locale: 'en',
        messages: [
          { role: 'user', content: 'toi dang co web boardgame, va muon setup' },
          { role: 'assistant', content: String(unaccented1.body?.reply ?? '') },
          { role: 'user', content: 'ban co the lam gi ma' },
        ],
      },
      humanAdminToken,
    );
    expect(unaccented2.status).toBe(200);
    expect(unaccented2.body?.replyLocale).toBe('vi');
    expect(unaccented2.body?.intent).toBe('guide');
    expect(
      (unaccented2.body?.suggestedQuickReplies as string[]).some((q) =>
        /bạn có thể làm được những gì/i.test(q),
      ),
    ).toBe(false);
  });

  it('preserves live LLM gather_requirements replies when tone/language are extracted and syncs propose_setup cards on pushback without ghost claims', async () => {
    const llmAdmin = createUser('live-llm-sync-admin@example.com', 'AdminPass123!');
    setUserPermissions(llmAdmin.userId, ['*'], primaryAdminId);
    const llmAdminToken = createSession(llmAdmin.userId);

    const scriptedOutputs: string[] = [];
    const mockUpstream = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        const content = scriptedOutputs.shift() ?? '{}';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: `chatcmpl_live_${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: 'live-boardgame-specialist',
            choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          }),
        );
      });
    });
    mockUpstream.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => mockUpstream.once('listening', () => resolve()));
    const upstreamPort = (mockUpstream.address() as { port: number }).port;

    const db = getDb();
    const enc = encrypt('no-key');
    const baseUrl = `http://127.0.0.1:${upstreamPort}/v1`;
    const keyId = Number(
      db
        .prepare(
          `INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
           VALUES ('custom', 'Live Test Upstream', ?, ?, ?, 'healthy', 1, ?)`,
        )
        .run(enc.encrypted, enc.iv, enc.authTag, baseUrl).lastInsertRowid,
    );
    const modelDbId = Number(
      db
        .prepare(
          `INSERT INTO models (
             platform, model_id, display_name, intelligence_rank, speed_rank,
             size_label, monthly_token_budget, supports_vision, supports_tools,
             context_window, enabled, key_id, endpoint_scope
           ) VALUES ('custom', 'live-boardgame-specialist', 'Live Specialist', 95, 95, '70B', 'unlimited', 0, 1, 64000, 1, ?, ?)`,
        )
        .run(keyId, baseUrl).lastInsertRowid,
    );
    db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)').run(
      modelDbId,
    );
    invalidateKeyCache();

    try {
      // 1. Live LLM returns gather_requirements + extracted industry + tone + language on active tenant:
      // must keep gather_requirements AND preserve the live LLM's exact reply!
      scriptedOutputs.push(
        JSON.stringify({
          intent: 'gather_requirements',
          reply:
            'Chào bạn! Mở web boardgame cực thú vị luôn — mình có thể giúp tư vấn game theo số người chơi và luật chơi ngay. Bạn muốn cho mình biết tên shop trước hay lên bản mẫu luôn nhé?',
          missingQuestions: ['Tên shop boardgame'],
          suggestedQuickReplies: ['Lên bản mẫu luôn đi'],
          extractedRequirements: {
            industry: 'Boardgame & Trò chơi bàn',
            tone: 'friendly',
            language: 'vi',
          },
        }),
      );

      const liveTurn1 = await hit(
        '/api/support-setup-copilot/chat',
        'POST',
        {
          tenantId: existingTenantId,
          locale: 'vi',
          messages: [{ role: 'user', content: 'tôi đang có web boardgame, và muốn setup' }],
        },
        llmAdminToken,
      );
      expect(liveTurn1.status).toBe(200);
      expect(liveTurn1.body?.usedFallback).toBe(false);
      expect(liveTurn1.body?.intent).toBe('gather_requirements');
      expect(liveTurn1.body?.proposal).toBeNull();
      expect(liveTurn1.body?.reply).toContain('Mở web boardgame cực thú vị luôn');

      // 2. User complains "sao trả lời cứng nhắc vậy", live LLM returns intent="propose_setup" promising a draft card below:
      // must honor propose_setup and attach the real pending_consent proposal card!
      scriptedOutputs.push(
        JSON.stringify({
          intent: 'propose_setup',
          reply:
            'Cho mình xin lỗi nhé! Mình vừa soạn sẵn luôn bản nháp cấu hình cho web boardgame ở thẻ bên dưới (chưa thay đổi hệ thống cho tới khi bạn bấm duyệt) để bạn xem ngay nha!',
          extractedRequirements: {
            industry: 'Boardgame & Trò chơi bàn',
          },
        }),
      );

      const liveTurn2 = await hit(
        '/api/support-setup-copilot/chat',
        'POST',
        {
          tenantId: existingTenantId,
          locale: 'vi',
          messages: [
            { role: 'user', content: 'tôi đang có web boardgame, và muốn setup' },
            { role: 'assistant', content: String(liveTurn1.body?.reply ?? '') },
            { role: 'user', content: 'sao trả lời cứng nhắc vậy' },
          ],
        },
        llmAdminToken,
      );
      expect(liveTurn2.status).toBe(200);
      expect(liveTurn2.body?.usedFallback).toBe(false);
      expect(liveTurn2.body?.intent).toBe('propose_setup');
      expect(liveTurn2.body?.proposal).toBeTruthy();
      expect(liveTurn2.body?.proposal?.status).toBe('pending_consent');
      expect(liveTurn2.body?.reply).toContain('bản nháp cấu hình cho web boardgame');

      // 3. On a pure capability question ("bạn có thể làm gì mà"), if a rogue model returns intent="propose_setup" claiming a card below,
      // intent stays 'guide' and the ghost-card reply is suppressed!
      scriptedOutputs.push(
        JSON.stringify({
          intent: 'propose_setup',
          reply: 'Mình vừa tạo sẵn thẻ đề xuất ở bên dưới cho bạn bấm duyệt ngay nhé (chưa lưu gì đâu)!',
        }),
      );

      const liveTurn3 = await hit(
        '/api/support-setup-copilot/chat',
        'POST',
        {
          tenantId: existingTenantId,
          locale: 'vi',
          messages: [{ role: 'user', content: 'bạn có thể làm gì mà' }],
        },
        llmAdminToken,
      );
      expect(liveTurn3.status).toBe(200);
      expect(liveTurn3.body?.intent).toBe('guide');
      expect(liveTurn3.body?.proposal).toBeNull();
      expect(String(liveTurn3.body?.reply ?? '')).not.toContain('thẻ đề xuất ở bên dưới');
    } finally {
      db.prepare('DELETE FROM fallback_config WHERE model_db_id = ?').run(modelDbId);
      db.prepare('DELETE FROM models WHERE id = ?').run(modelDbId);
      db.prepare('DELETE FROM api_keys WHERE id = ?').run(keyId);
      invalidateKeyCache();
      await new Promise<void>((resolve) => mockUpstream.close(() => resolve()));
    }
  });
});
