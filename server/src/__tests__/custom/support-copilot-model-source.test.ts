import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CloudAiRuntimePack, CloudSignedLease } from '@freellmapi/shared/cloud-entitlement.js';
import { createApp } from '../../app.js';
import { recordServerLocalAddress } from '../../custom/ai-platform/orchestrator/engine.js';
import { configureCloudEntitlementForTesting } from '../../custom/cloud-entitlement/service.js';
import { runHumanLikeLlmCoach } from '../../custom/support-setup-copilot/llm-coach.js';
import { getCopilotModelSource, isCopilotModelSource, setCopilotModelSource } from '../../custom/support-setup-copilot/model-source.js';
import { runWithTrace, traceUsage } from '../../custom/support-setup-copilot/trace.js';
import { getDb, initDb } from '../../db/index.js';
import { createSession, createUser, type SessionUser } from '../../services/auth.js';
import { setUserPermissions } from '../../services/users.js';

import { dashboardSessionHeaders } from '../helpers/auth.js';
function installMockCloudLease(): void {
  process.env.FREEAPI_AI_ACTIVATION_TOKEN = 'dummy-test-token-never-sent';
  const lease: CloudSignedLease = {
    licenseId: 'test-lic-source', label: 'Test License', instanceId: 'test-inst-source',
    scopes: ['ai_platform', 'customer_ai', 'support_copilot', 'support_suite', 'tenant_portal'],
    packVersion: 4, packHash: 'hash-source',
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

describe('model source setting', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    initDb(':memory:');
  });

  it('defaults to both, so existing setups behave exactly as before', () => {
    expect(getCopilotModelSource()).toBe('both');
  });

  it('stores one of the three sources and ignores anything else', () => {
    for (const s of ['thruline', 'freellmapi', 'both'] as const) {
      setCopilotModelSource(s);
      expect(getCopilotModelSource()).toBe(s);
    }
    expect(isCopilotModelSource('both')).toBe(true);
    for (const bad of ['', 'all', 'THRULINE', null, undefined, 3]) expect(isCopilotModelSource(bad)).toBe(false);
  });
});

describe('the Copilot honours the chosen source', () => {
  let admin: SessionUser;
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = 'b'.repeat(64);
    initDb(':memory:');
    installMockCloudLease();
    admin = createUser('source-admin@example.com', 'AdminPass123!');
  });
  afterAll(() => {
    configureCloudEntitlementForTesting(null);
    delete process.env.FREEAPI_AI_ACTIVATION_TOKEN;
    setCopilotModelSource('both');
  });

  const run = async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ model: 'fake/m', choices: [{ message: { content: JSON.stringify({ intent: 'guide', reply: 'Response cache giúp giảm số lần gọi nhà cung cấp.' }) } }] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const out = await runWithTrace(() => {}, async () => {
      const result = await runHumanLikeLlmCoach({
        user: admin,
        messages: [{ role: 'user', content: 'cho mình hỏi về cài đặt cache' }],
        locale: 'vi', targetMode: 'update_tenant', diagnostic: null, extracted: {},
        gatewayLoopback: { host: '127.0.0.1', port: 9, forceLoopback: true },
        fetchImpl,
      });
      return { result, usage: traceUsage() };
    });
    return { calls, ...out };
  };

  it('"both" and "freellmapi" call the FreeLLMAPI gateway, and the usage says which source answered', async () => {
    for (const source of ['both', 'freellmapi'] as const) {
      setCopilotModelSource(source);
      const { calls, result, usage } = await run();
      expect(calls, source).toBe(1);
      expect(result?.routeSource, source).toBe('main_gateway_loopback');
      expect(usage?.source, source).toBe('freellmapi');
    }
  });

  it('"thruline" never calls the FreeLLMAPI gateway: with no Thruline account connected there is simply no model answer', async () => {
    setCopilotModelSource('thruline');
    const { calls, result, usage } = await run();
    expect(calls).toBe(0);
    expect(result).toBeNull();
    expect(usage?.modelCalls).toBe(0);
    expect(usage?.source).toBeUndefined();
  });
});

describe('GET/PUT /api/support-setup-copilot/model-source', () => {
  let server: Server;
  let base: string;
  let adminToken: string;
  let memberToken: string;

  const call = async (token: string, method: 'GET' | 'PUT', body?: unknown) => {
    const res = await fetch(`${base}/api/support-setup-copilot/model-source`, {
      method,
      headers: { 'Content-Type': 'application/json', ...dashboardSessionHeaders(token) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, any> | null };
  };

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = 'c'.repeat(64);
    initDb(':memory:');
    installMockCloudLease();
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', () => r()));
    const { port } = server.address() as { port: number };
    base = `http://127.0.0.1:${port}`;
    recordServerLocalAddress({ socket: { localAddress: '127.0.0.1', localPort: port } } as never);
    const adminUser = createUser('source-http-admin@example.com', 'AdminPass123!');
    adminToken = createSession(adminUser.userId);
    const member = createUser('source-http-member@example.com', 'UserPass123!', 'member');
    setUserPermissions(member.userId, ['edit_cache'], adminUser.userId);
    memberToken = createSession(member.userId);
  });
  afterAll(async () => {
    configureCloudEntitlementForTesting(null);
    delete process.env.FREEAPI_AI_ACTIVATION_TOKEN;
    await new Promise<void>((r) => server.close(() => r()));
  });
  beforeEach(() => {
    getDb().prepare('DELETE FROM auth_request_limits').run();
  });

  it('anyone using the Copilot can read it; only edit_settings can change it', async () => {
    const read = await call(memberToken, 'GET');
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ ok: true, source: 'both', canEdit: false });
    expect(read.body?.available).toEqual({ thruline: expect.any(Boolean), freellmapi: expect.any(Boolean) });

    const denied = await call(memberToken, 'PUT', { source: 'thruline' });
    expect(denied.status).toBe(403);
    expect((await call(memberToken, 'GET')).body?.source).toBe('both'); // unchanged

    const ok = await call(adminToken, 'PUT', { source: 'thruline' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ source: 'thruline', canEdit: true });
    expect((await call(memberToken, 'GET')).body?.source).toBe('thruline'); // it is system-wide
  });

  it('rejects a value that is not one of the three sources', async () => {
    for (const source of ['all', '', 5, null]) {
      expect((await call(adminToken, 'PUT', { source })).status).toBe(400);
    }
    expect((await call(adminToken, 'PUT', {})).status).toBe(400);
  });
});
