import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CloudAiRuntimePack, CloudSignedLease } from '@freellmapi/shared/cloud-entitlement.js';
import { createApp } from '../../app.js';
import { recordServerLocalAddress } from '../../custom/ai-platform/orchestrator/engine.js';
import { configureCloudEntitlementForTesting } from '../../custom/cloud-entitlement/service.js';
import { isTenantAdviceRequest } from '../../custom/support-setup-copilot/tenant-advice.js';
import { createSupportTenant } from '../../custom/x-gateway/support-store.js';
import { getDb, initDb } from '../../db/index.js';
import { createSession, createUser } from '../../services/auth.js';
import { setUserPermissions } from '../../services/users.js';

/** Mock verified cloud lease (project test hook) so nothing touches a live activation token. */
function installMockCloudLease(): void {
  process.env.FREEAPI_AI_ACTIVATION_TOKEN = 'dummy-test-token-never-sent';
  const lease: CloudSignedLease = {
    licenseId: 'test-lic-advice', label: 'Test License', instanceId: 'test-inst-advice',
    scopes: ['ai_platform', 'customer_ai', 'support_copilot', 'support_suite', 'tenant_portal'],
    packVersion: 4, packHash: 'hash-advice',
    issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  };
  const pack: CloudAiRuntimePack = {
    version: 4,
    supportCoachPack: { personaVi: 'Persona Vi', personaEn: 'Persona En', playbookReference: 'Playbook', outputContract: 'Contract' },
    supportAgentCopilotInstruction: 'x', customerAiDirective: 'ACTIVE', supportGatewayDirective: 'ACTIVE', aiPlatformCapabilityGrant: 'ACTIVE',
  };
  configureCloudEntitlementForTesting({
    activeLeaseRecord: { lease, tokenHash: 'dummy-hash', signature: 'dummy-sig', runtimePack: pack, verifiedAtMs: Date.now() },
  });
}

describe('isTenantAdviceRequest — only "what would you change?" questions', () => {
  it('matches the real question and its variants', () => {
    for (const q of [
      'bạn có đề xuất sửa gì không',
      'bạn có đề xuất sửa gì không?',
      'nên sửa gì',
      'còn thiếu gì không',
      'gợi ý giúp mình nên chỉnh gì',
      'what should I fix',
      'do you have any suggestions?',
      'what is missing',
    ]) expect(isTenantAdviceRequest(q), q).toBe(true);
  });

  it('leaves design/content ideas, setup requests and business descriptions to the normal flow', () => {
    for (const q of [
      'gợi ý màu cho widget',
      'gợi ý lời chào thân thiện',
      'setup giúp mình AI support cho shop giày',
      'xin chào',
      'đổi màu widget sang xanh',
      `Mình bán mỹ phẩm GlowSkin, tên thương hiệu là GlowSkin, nên bạn viết giọng điệu thân thiện và ${'mô tả sản phẩm '.repeat(12)}`,
    ]) expect(isTenantAdviceRequest(q), q).toBe(false);
  });
});

describe('Copilot routing — advice for a selected tenant, and the System target by permission', () => {
  let server: Server;
  let base: string;
  let adminToken: string;
  let cacheToken: string;
  let viewerToken: string;
  let tenantId: number;

  const call = async (path: string, token: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, any> | null };
  };
  const chat = (token: string, content: string, extra: Record<string, unknown> = {}) =>
    call('/api/support-setup-copilot/chat', token, { locale: 'vi', currentPath: '/thruline/support', messages: [{ role: 'user', content }], ...extra });

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = 'b'.repeat(64);
    initDb(':memory:');
    installMockCloudLease();
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', () => r()));
    const { port } = server.address() as { port: number };
    base = `http://127.0.0.1:${port}`;
    recordServerLocalAddress({ socket: { localAddress: '127.0.0.1', localPort: port } } as never);

    const admin = createUser('advice-route-admin@example.com', 'AdminPass123!');
    adminToken = createSession(admin.userId);
    const cache = createUser('advice-route-cache@example.com', 'UserPass123!', 'member');
    setUserPermissions(cache.userId, ['edit_cache'], admin.userId);
    cacheToken = createSession(cache.userId);
    const viewer = createUser('advice-route-viewer@example.com', 'UserPass123!', 'member');
    setUserPermissions(viewer.userId, ['view_cache', 'view_settings'], admin.userId);
    viewerToken = createSession(viewer.userId);

    tenantId = createSupportTenant({
      name: 'Chưa giàu đã lớn', slug: 'chua-giau', defaultModel: 'auto', systemPrompt: 'Prompt đã sẵn sàng cho khách.', createdBy: admin.userId,
    }).tenant.id;
  });

  afterAll(async () => {
    configureCloudEntitlementForTesting(null);
    delete process.env.FREEAPI_AI_ACTIVATION_TOKEN;
    await new Promise<void>((r) => server.close(() => r()));
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM auth_request_limits').run();
  });

  it('the screenshot case: with a tenant selected, "bạn có đề xuất sửa gì không" is answered from the tenant\'s real state', async () => {
    const { status, body } = await chat(adminToken, 'bạn có đề xuất sửa gì không', { tenantId, targetMode: 'update_tenant' });
    expect(status).toBe(200);
    expect(body?.intent).toBe('guide');
    expect(body?.proposal).toBeNull();
    expect(body?.reply).toContain('Chưa giàu đã lớn');
    expect(body?.reply).toMatch(/\*\*\d\/7\*\* hạng mục/);
    expect(body?.reply).toContain('Bước');
    expect(body?.reply).toContain('chưa đổi gì');
    // NOT the intake questionnaire from the screenshot
    expect(body?.reply).not.toContain('bản mẫu mặc định');
    expect(body?.reply).not.toContain('bên mình đang bán sản phẩm');
    expect(body?.suggestedQuickReplies).toContain('Hoàn thiện cấu hình tiêu chuẩn cho tenant hiện tại');
  });

  it('a design question is NOT hijacked: "gợi ý màu cho widget" stays in the normal setup flow', async () => {
    const { body } = await chat(adminToken, 'gợi ý màu cho widget', { tenantId, targetMode: 'update_tenant' });
    expect(body?.reply).not.toContain('Mình vừa kiểm tra');
  });

  it('an account with only edit_cache is offered the System target and gets exactly its own authority there', async () => {
    const status = await call('/api/support-setup-copilot/status', cacheToken);
    expect(status.body?.canUseSystemTarget).toBe(true);

    const ok = await chat(cacheToken, 'Bật response cache', { targetMode: 'system' });
    expect(ok.status).toBe(200);
    expect(ok.body?.proposal?.systemActions?.[0]).toMatchObject({ settingId: 'response_cache', canApply: true });

    const denied = await chat(cacheToken, 'Bật retrieval', { targetMode: 'system' });
    expect(denied.status).toBe(200);
    expect(denied.body?.proposal).toBeNull();
    expect(denied.body?.reply).toContain('edit_ai_flags');
  });

  it('an account with no system permission is not offered the System target and cannot use it', async () => {
    const status = await call('/api/support-setup-copilot/status', viewerToken);
    expect(Boolean(status.body?.canUseSystemTarget)).toBe(false); // field absent or false: never offered
    const res = await chat(viewerToken, 'Bật response cache', { targetMode: 'system' });
    expect(res.status).toBe(403);
  });

  it('the System target answers the same advice question without touching any tenant', async () => {
    const { body } = await chat(adminToken, 'bạn có đề xuất sửa gì không', { targetMode: 'system' });
    expect(body?.intent).toBe('guide');
    expect(body?.proposal).toBeNull();
    expect(body?.reply).not.toContain('Chưa giàu đã lớn');
    expect(String(body?.reply)).toMatch(/đo trạng thái hệ thống|chưa thấy cài đặt nào cần đổi/);
  });
});
