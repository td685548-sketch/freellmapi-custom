import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CloudAiRuntimePack, CloudSignedLease } from '@freellmapi/shared/cloud-entitlement.js';
import { createApp } from '../../app.js';
import { configureCloudEntitlementForTesting } from '../../custom/cloud-entitlement/service.js';
import { resolveCopilotUserScope } from '../../custom/support-setup-copilot/diagnostics.js';
import {
  filterLlmOutputByScope,
  MAX_LOOP_STEPS,
  MAX_TOOL_CALLS_PER_TURN,
  runCopilotAgentLoop,
  type CopilotLlmCall,
} from '../../custom/support-setup-copilot/agent-loop.js';
import { buildCallerIdentity } from '../../custom/support-setup-copilot/identity.js';
import type { LlmCoachOutput } from '../../custom/support-setup-copilot/llm-coach.js';
import {
  COPILOT_TOOL_REGISTRY,
  executeCopilotTool,
  filterAdmittedTools,
} from '../../custom/support-setup-copilot/tools.js';
import { listSupportAuditLogs } from '../../custom/x-gateway/support-enterprise-router.js';
import { createSupportTenant } from '../../custom/x-gateway/support-store.js';
import { getDb, initDb } from '../../db/index.js';
import { createSession, createUser, type SessionUser } from '../../services/auth.js';
import { isCacheEnabled } from '../../services/cache.js';

let server: Server;
let base: string;

let primaryAdmin: SessionUser;
let primaryToken: string;
let configurator: SessionUser;
let viewer: SessionUser;
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

/** Mock verified cloud lease so nothing touches the live activation token. */
function installMockCloudLease(): void {
  process.env.FREEAPI_AI_ACTIVATION_TOKEN = 'dummy-test-token-never-sent';
  const lease: CloudSignedLease = {
    licenseId: 'test-lic-loop',
    label: 'Test License',
    instanceId: 'test-inst-loop',
    scopes: ['ai_platform', 'customer_ai', 'support_copilot', 'support_suite', 'tenant_portal'],
    packVersion: 4,
    packHash: 'hash-loop',
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  };
  const pack: CloudAiRuntimePack = {
    version: 4,
    supportCoachPack: {
      personaVi: 'Mock Persona Vi',
      personaEn: 'Mock Persona En',
      playbookReference: 'Mock Playbook',
      outputContract: 'Mock Output Contract',
    },
    supportAgentCopilotInstruction: 'Mock Copilot Instruction',
    customerAiDirective: 'ACTIVE',
    supportGatewayDirective: 'ACTIVE',
    aiPlatformCapabilityGrant: 'ACTIVE',
  };
  configureCloudEntitlementForTesting({
    activeLeaseRecord: {
      lease,
      tokenHash: 'dummy-hash',
      signature: 'dummy-sig',
      runtimePack: pack,
      verifiedAtMs: Date.now(),
    },
  });
}

function proposalCount(): number {
  const db = getDb();
  const row = db
    .prepare('SELECT COUNT(*) AS c FROM custom_support_setup_proposals')
    .get() as { c: number } | undefined;
  return Number(row?.c ?? 0);
}

function userKeyCount(userId: number): number {
  const db = getDb();
  const row = db
    .prepare('SELECT COUNT(*) AS c FROM user_api_keys WHERE user_id = ? AND revoked = 0')
    .get(userId) as { c: number } | undefined;
  return Number(row?.c ?? 0);
}

function readUserPermissions(userId: number): string[] {
  const db = getDb();
  const row = db
    .prepare('SELECT permissions FROM users WHERE id = ?')
    .get(userId) as { permissions: string | null } | undefined;
  if (!row?.permissions) return [];
  try {
    const parsed: unknown = JSON.parse(row.permissions);
    return Array.isArray(parsed)
      ? parsed.filter((p): p is string => typeof p === 'string')
      : [];
  } catch {
    return [];
  }
}

function identityFor(user: SessionUser) {
  return buildCallerIdentity(user, resolveCopilotUserScope(user))!;
}

function fakeLlm(outputs: LlmCoachOutput[]): CopilotLlmCall {
  let calls = 0;
  return async () => {
    const output = outputs[Math.min(calls, outputs.length - 1)]!;
    calls += 1;
    return { output, modelUsed: 'fake-loop-model', routeSource: 'main_gateway_loopback' };
  };
}

describe('Setup Copilot — Agent Harness Loop (Phase 2)', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = 'b'.repeat(64);
    initDb(':memory:');
    installMockCloudLease();
    const app = createApp();
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const { port } = server.address() as { port: number };
    base = `http://127.0.0.1:${port}`;

    primaryAdmin = createUser('loop-admin@example.com', 'AdminPass123!');
    primaryToken = createSession(primaryAdmin.userId);

    configurator = createUser('loop-configurator@example.com', 'UserPass123!', 'member');
    viewer = createUser('loop-viewer@example.com', 'UserPass123!', 'member');

    existingTenantId = createSupportTenant({
      name: 'Loop Corp',
      slug: 'loop-corp',
      defaultModel: 'auto',
      systemPrompt: 'Initial prompt.',
      createdBy: primaryAdmin.userId,
    }).tenant.id;

    const assignConfigurator = await hit(
      `/api/admin/tenant-memberships/tenants/${existingTenantId}/users/${configurator.userId}`,
      'PUT',
      { rolePreset: 'ai_configurator' },
      primaryToken,
    );
    expect(assignConfigurator.status).toBe(200);

    const assignViewer = await hit(
      `/api/admin/tenant-memberships/tenants/${existingTenantId}/users/${viewer.userId}`,
      'PUT',
      { rolePreset: 'viewer' },
      primaryToken,
    );
    expect(assignViewer.status).toBe(200);
  });

  afterAll(async () => {
    configureCloudEntitlementForTesting(null);
    delete process.env.FREEAPI_AI_ACTIVATION_TOKEN;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe('COPILOT_TOOL_REGISTRY', () => {
    it('registers 7 tenant steps + 9 system settings + 3 personal actions + 4 permission tools + 3 read-only knowledge tools', () => {
      expect(COPILOT_TOOL_REGISTRY).toHaveLength(26);
      expect(COPILOT_TOOL_REGISTRY.filter((t) => t.kind === 'knowledge').map((t) => t.id)).toEqual([
        'kb.search',
        'settings.read',
        'tenant.diagnose',
      ]);
      expect(COPILOT_TOOL_REGISTRY.filter((t) => t.kind === 'knowledge').every((t) => t.sideEffect === 'none')).toBe(true);
      expect(COPILOT_TOOL_REGISTRY.filter((t) => t.kind === 'tenant_step')).toHaveLength(7);
      expect(COPILOT_TOOL_REGISTRY.filter((t) => t.kind === 'system_setting')).toHaveLength(9);
      expect(COPILOT_TOOL_REGISTRY.filter((t) => t.kind === 'personal_action')).toHaveLength(3);
      expect(COPILOT_TOOL_REGISTRY.filter((t) => t.kind === 'permission_grant')).toHaveLength(4);
      expect(
        COPILOT_TOOL_REGISTRY.filter((t) => t.kind === 'permission_grant').map((t) => t.id),
      ).toEqual([
        'permission.grant_global',
        'permission.revoke_global',
        'permission.grant_tenant',
        'permission.revoke_tenant',
      ]);
      const ids = COPILOT_TOOL_REGISTRY.map((t) => t.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('ai_configurator is admitted only to its own steps’ tools (never runtime_policy)', () => {
      const admitted = filterAdmittedTools({
        agentContext: identityFor(configurator),
        user: configurator,
        tenantId: existingTenantId,
      });
      const stepIds = admitted
        .filter((t) => t.kind === 'tenant_step')
        .map((t) => t.stepId);
      expect(stepIds).toHaveLength(6);
      expect(stepIds).toEqual(
        expect.arrayContaining([
          'tenant_ai',
          'knowledge_masking',
          'guardrails_quotas',
          'output_controls',
          'widget_appearance',
          'sla_routing',
        ]),
      );
      expect(stepIds).not.toContain('runtime_policy');
      // No global permissions → no system-setting tools, no permission
      // tools, but personal tools stay.
      expect(admitted.filter((t) => t.kind === 'system_setting')).toHaveLength(0);
      expect(admitted.filter((t) => t.kind === 'permission_grant')).toHaveLength(0);
      expect(admitted.filter((t) => t.kind === 'personal_action')).toHaveLength(3);
    });

    it('viewer is admitted to personal tools only — no tenant step, no system setting, no permission tool', () => {
      const admitted = filterAdmittedTools({
        agentContext: identityFor(viewer),
        user: viewer,
        tenantId: existingTenantId,
      });
      expect(admitted.filter((t) => t.kind === 'tenant_step')).toHaveLength(0);
      expect(admitted.filter((t) => t.kind === 'system_setting')).toHaveLength(0);
      expect(admitted.filter((t) => t.kind === 'permission_grant')).toHaveLength(0);
      expect(admitted.filter((t) => t.kind === 'personal_action')).toHaveLength(3);
    });

    it('platform operator is admitted to all 26 tools', () => {
      const admitted = filterAdmittedTools({
        agentContext: identityFor(primaryAdmin),
        user: primaryAdmin,
        tenantId: existingTenantId,
      });
      expect(admitted).toHaveLength(26);
    });
  });

  describe('executeCopilotTool — the pre-execute gate', () => {
    it('tool outside the caller’s scope → denied + audit log, handler never runs (no proposal created)', async () => {
      const before = proposalCount();
      const result = await executeCopilotTool({
        user: configurator,
        toolId: 'step.runtime_policy',
        input: {},
        tenantId: existingTenantId,
      });
      expect(result.status).toBe('denied');
      expect(result.reason).toContain('edit_tenant_integration');
      expect(result.requiredPermission).toBe('edit_tenant_integration');
      expect(proposalCount()).toBe(before);
      const denied = listSupportAuditLogs(String(existingTenantId)).filter(
        (e) =>
          e.action === 'support.setup_copilot.tool_denied' &&
          (e.details as Record<string, unknown>)?.toolId === 'step.runtime_policy',
      );
      expect(denied.length).toBeGreaterThanOrEqual(1);
      expect((denied[0]!.details as Record<string, unknown>).requiredPermission).toBe(
        'edit_tenant_integration',
      );
    });

    it('system-setting tool outside scope → denied and the setting value is untouched', async () => {
      const cacheBefore = isCacheEnabled();
      const result = await executeCopilotTool({
        user: viewer,
        toolId: 'setting.response_cache',
        input: { enabled: !cacheBefore },
        tenantId: existingTenantId,
      });
      expect(result.status).toBe('denied');
      expect(result.requiredPermission).toBe('edit_cache');
      expect(isCacheEnabled()).toBe(cacheBefore);
    });

    it('unknown tool id → rejected immediately', async () => {
      const result = await executeCopilotTool({
        user: configurator,
        toolId: 'step.delete_everything',
        input: {},
        tenantId: existingTenantId,
      });
      expect(result.status).toBe('rejected');
      expect(result.reason).toBe('unknown_tool');
    });

    it('invalid input → rejected immediately (zod schema)', async () => {
      const result = await executeCopilotTool({
        user: primaryAdmin,
        toolId: 'setting.response_cache',
        input: { enabled: 'yes' },
        tenantId: existingTenantId,
      });
      expect(result.status).toBe('rejected');
      expect(result.reason).toBe('invalid_input');
    });

    it('permitted tenant-step tool → executed as a staged proposal (nothing applied)', async () => {
      const before = proposalCount();
      const result = await executeCopilotTool({
        user: configurator,
        toolId: 'step.tenant_ai',
        input: {},
        tenantId: existingTenantId,
      });
      expect(result.status).toBe('executed');
      expect((result.result as Record<string, unknown>).stepId).toBe('tenant_ai');
      expect((result.result as Record<string, unknown>).status).toBe('proposed');
      expect(proposalCount()).toBe(before);
    });

    it('permitted personal-action tool → executed via the existing proposal builder, no key minted', async () => {
      const before = userKeyCount(configurator.userId);
      const result = await executeCopilotTool({
        user: configurator,
        toolId: 'action.create_personal_key',
        input: { name: 'Loop Key', routingMode: 'eco' },
        tenantId: existingTenantId,
      });
      expect(result.status).toBe('executed');
      const proposal = (result.result as Record<string, any>).proposal;
      expect(proposal.actionType).toBe('create_personal_key');
      expect(proposal.params.name).toBe('Loop Key');
      expect(userKeyCount(configurator.userId)).toBe(before);
    });

    it('permitted permission.grant_global → executed as a STAGED grant only (target unchanged)', async () => {
      const before = readUserPermissions(viewer.userId);
      const result = await executeCopilotTool({
        user: primaryAdmin,
        toolId: 'permission.grant_global',
        input: { targetEmail: 'loop-viewer@example.com', permissions: ['view_users'] },
        tenantId: existingTenantId,
      });
      expect(result.status).toBe('executed');
      const grant = (result.result as Record<string, any>).grant;
      expect(grant.scope).toBe('global');
      expect(grant.action).toBe('grant');
      expect(grant.targetEmail).toBe('loop-viewer@example.com');
      expect(grant.permissions).toEqual(['view_users']);
      expect(grant.newPermissions).toEqual(['view_users']);
      expect(readUserPermissions(viewer.userId)).toEqual(before);
      expect(proposalCount()).toBe(0);
      const executed = listSupportAuditLogs(String(existingTenantId)).filter(
        (e) =>
          e.action === 'support.setup_copilot.tool_executed' &&
          (e.details as Record<string, unknown>)?.toolId === 'permission.grant_global',
      );
      expect(executed.length).toBeGreaterThanOrEqual(1);
      expect((executed[0]!.details as Record<string, unknown>).targetEmail).toBe(
        'loop-viewer@example.com',
      );
    });

    it('permission tool without edit_user_permissions → denied + audit, no DB change', async () => {
      const before = readUserPermissions(viewer.userId);
      const result = await executeCopilotTool({
        user: viewer,
        toolId: 'permission.grant_global',
        input: { targetEmail: 'loop-configurator@example.com', permissions: ['view_users'] },
        tenantId: existingTenantId,
      });
      expect(result.status).toBe('denied');
      expect(result.reason).toBe('missing_permission:edit_user_permissions');
      expect(readUserPermissions(viewer.userId)).toEqual(before);
      const denied = listSupportAuditLogs(String(existingTenantId)).filter(
        (e) =>
          e.action === 'support.setup_copilot.tool_denied' &&
          (e.details as Record<string, unknown>)?.toolId === 'permission.grant_global',
      );
      expect(denied.length).toBeGreaterThanOrEqual(1);
    });

    it('permission tool with unknown target → denied (account_not_found), nothing staged', async () => {
      const result = await executeCopilotTool({
        user: primaryAdmin,
        toolId: 'permission.grant_global',
        input: { targetEmail: 'ghost@example.com', permissions: ['view_users'] },
        tenantId: existingTenantId,
      });
      expect(result.status).toBe('denied');
      expect(result.reason).toBe('account_not_found');
    });

    it('permission tool with unknown permission id → rejected (handler error)', async () => {
      const result = await executeCopilotTool({
        user: primaryAdmin,
        toolId: 'permission.grant_global',
        input: { targetEmail: 'loop-viewer@example.com', permissions: ['not_a_permission'] },
        tenantId: existingTenantId,
      });
      expect(result.status).toBe('rejected');
      expect(result.reason).toBe('handler_error');
    });

    it('permission tool granting to self → denied (self_permission_change)', async () => {
      const result = await executeCopilotTool({
        user: primaryAdmin,
        toolId: 'permission.grant_global',
        input: { targetEmail: 'loop-admin@example.com', permissions: ['view_users'] },
        tenantId: existingTenantId,
      });
      expect(result.status).toBe('denied');
      expect(result.reason).toBe('self_permission_change');
    });
  });

  describe('filterLlmOutputByScope', () => {
    it('drops targetSteps and systemActions the caller cannot apply', () => {
      const scope = resolveCopilotUserScope(configurator);
      const canEditSteps = scope.tenants[0]!.canEditSteps;
      const filtered = filterLlmOutputByScope(
        {
          intent: 'propose_setup',
          reply: 'Draft ready.',
          targetSteps: ['tenant_ai', 'runtime_policy', 'widget_appearance'],
          systemActions: [{ settingId: 'response_cache', payload: { enabled: true } }],
        },
        { user: configurator, canEditSteps },
      );
      expect(filtered.targetSteps).toEqual(['tenant_ai', 'widget_appearance']);
      expect(filtered.systemActions).toBeUndefined();
    });
  });

  describe('runCopilotAgentLoop', () => {
    const baseParams = (user: SessionUser) => ({
      user,
      scope: resolveCopilotUserScope(user),
      agentContext: identityFor(user),
      messages: [{ role: 'user' as const, content: 'Hoàn thiện cấu hình cho tenant này' }],
      locale: 'vi' as const,
      targetMode: 'update_tenant' as const,
      tenantId: existingTenantId,
      diagnostic: null,
      extracted: {},
      canCreateTenant: false,
      canEditSteps: resolveCopilotUserScope(user).tenants[0]?.canEditSteps ?? new Set(),
    });

    it('terminal intent with no tool calls → terminal after 1 step, 0 tool calls', async () => {
      const result = await runCopilotAgentLoop({
        ...baseParams(configurator),
        llmCall: fakeLlm([{ intent: 'guide', reply: 'Đây là hướng dẫn từng bước.' }]),
      });
      expect(result.outcome).toBe('terminal');
      expect(result.stepsTaken).toBe(1);
      expect(result.toolCallsMade).toBe(0);
      expect(result.output?.reply).toContain('hướng dẫn');
    });

    it('tool call then terminal reply → executes once and finishes', async () => {
      const result = await runCopilotAgentLoop({
        ...baseParams(configurator),
        llmCall: fakeLlm([
          {
            intent: 'gather_requirements',
            reply: 'Để mình chuẩn bị bước Tenant AI.',
            toolCalls: [{ id: 'step.tenant_ai', input: {} }],
          },
          { intent: 'guide', reply: 'Đã chuẩn bị xong bước Tenant AI cho bạn xem.' },
        ]),
      });
      expect(result.outcome).toBe('terminal');
      expect(result.stepsTaken).toBe(2);
      expect(result.toolCallsMade).toBe(1);
      expect(result.toolCalls[0]!.result.status).toBe('executed');
      expect(result.deniedToolIds).toHaveLength(0);
    });

    it('more than MAX_TOOL_CALLS_PER_TURN tool calls → loop stops (budget respected)', async () => {
      const alwaysTools = fakeLlm([
        {
          intent: 'gather_requirements',
          reply: 'Working…',
          toolCalls: [
            { id: 'action.create_personal_key', input: { name: 'K1' } },
            { id: 'action.create_personal_key', input: { name: 'K2' } },
            { id: 'action.create_personal_key', input: { name: 'K3' } },
          ],
        },
      ]);
      const result = await runCopilotAgentLoop({
        ...baseParams(configurator),
        llmCall: alwaysTools,
      });
      expect(result.toolCallsMade).toBe(MAX_TOOL_CALLS_PER_TURN);
      expect(result.outcome).toBe('budget_exhausted');
      expect(result.stepsTaken).toBeLessThanOrEqual(MAX_LOOP_STEPS);
      expect(result.toolCalls.every((c) => c.result.status === 'executed')).toBe(true);
      // Proposal-only: no key was actually minted despite 5 tool executions.
      expect(userKeyCount(configurator.userId)).toBe(0);
    });

    it('viewer proposal contains no canApply actions (steps + system actions filtered out)', async () => {
      const result = await runCopilotAgentLoop({
        ...baseParams(viewer),
        llmCall: fakeLlm([
          {
            intent: 'propose_setup',
            reply: 'Bản nháp cấu hình đây.',
            targetSteps: [
              'tenant_ai',
              'knowledge_masking',
              'guardrails_quotas',
              'output_controls',
              'widget_appearance',
              'sla_routing',
              'runtime_policy',
            ],
            systemActions: [{ settingId: 'response_cache', payload: { enabled: true } }],
          },
        ]),
      });
      expect(result.outcome).toBe('terminal');
      expect(result.output?.targetSteps).toBeUndefined();
      expect(result.output?.systemActions).toBeUndefined();
    });

    it('fake “already applied” LLM reply → disclaimer attached', async () => {
      const result = await runCopilotAgentLoop({
        ...baseParams(configurator),
        llmCall: fakeLlm([
          {
            intent: 'guide',
            reply: 'Mình đã áp dụng xong toàn bộ cấu hình cho tenant.',
          },
        ]),
      });
      expect(result.output?.reply).toContain('Mình đã áp dụng xong toàn bộ cấu hình');
      expect(result.output?.reply).toContain('Mình chưa tự ý ghi thay đổi nào');
    });

    it('denied tool inside the loop is recorded, not executed, and the loop continues', async () => {
      const result = await runCopilotAgentLoop({
        ...baseParams(configurator),
        llmCall: fakeLlm([
          {
            intent: 'gather_requirements',
            reply: 'Để mình thử bước runtime.',
            toolCalls: [{ id: 'step.runtime_policy', input: {} }],
          },
          { intent: 'guide', reply: 'Bạn chưa có quyền runtime_policy nên mình chỉ hướng dẫn.' },
        ]),
      });
      expect(result.toolCallsMade).toBe(1);
      expect(result.toolCalls[0]!.result.status).toBe('denied');
      expect(result.deniedToolIds).toEqual(['step.runtime_policy']);
      expect(result.outcome).toBe('terminal');
    });
  });
});
