import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CloudAiRuntimePack, CloudSignedLease } from '@freellmapi/shared/cloud-entitlement.js';
import { createApp } from '../../app.js';
import { recordServerLocalAddress } from '../../custom/ai-platform/orchestrator/engine.js';
import { configureCloudEntitlementForTesting } from '../../custom/cloud-entitlement/service.js';
import {
  buildKeyClarificationResponse,
  extractKeyReferences,
  findKeysByReference,
  isSwitchKeyModeRequest,
  matchUserActionIntent,
} from '../../custom/support-setup-copilot/user-actions.js';
import { createSupportTenant } from '../../custom/x-gateway/support-store.js';
import { getDb, initDb } from '../../db/index.js';
import { createSession, createUser, type SessionUser } from '../../services/auth.js';
import { listUserApiKeys, mintUserApiKey } from '../../services/user-keys.js';

import { dashboardSessionHeaders } from '../helpers/auth.js';
function installMockCloudLease(): void {
  process.env.FREEAPI_AI_ACTIVATION_TOKEN = 'dummy-test-token-never-sent';
  const lease: CloudSignedLease = {
    licenseId: 'test-lic-keys', label: 'Test License', instanceId: 'test-inst-keys',
    scopes: ['ai_platform', 'customer_ai', 'support_copilot', 'support_suite', 'tenant_portal'],
    packVersion: 4, packHash: 'hash-keys',
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

/** A key shows as `sk-flm-6025…c359`; people copy the tail. */
const tailOf = (prefix: string): string => prefix.slice(-4);
const headOf = (prefix: string): string => prefix.slice('sk-flm-'.length, 'sk-flm-'.length + 4);

describe('key references — what the user may type for a masked key', () => {
  it('extracts the tail/head from every way the key list shows it', () => {
    expect(extractKeyReferences('Chuyển key …c86c sang ECO')).toEqual(['c86c']);
    expect(extractKeyReferences('Chuyển key ...c86c sang ECO')).toEqual(['c86c']);
    expect(extractKeyReferences('switch key sk-flm-6025…c359 to eco').sort()).toEqual(['6025', 'c359']);
    expect(extractKeyReferences('đổi key c359 sang eco')).toEqual(['c359']);
  });

  it('ignores numbers and words that are not a key reference', () => {
    expect(extractKeyReferences('chuyển key sang ECO giúp mình')).toEqual([]);
    expect(extractKeyReferences('đổi key của tôi sang eco, hạn mức 2024')).toEqual([]);
    expect(extractKeyReferences('switch my key to eco, it was added and dead')).toEqual([]);
  });

  it('recognises the switch request with the masked tail inside it (the screenshot case)', () => {
    for (const q of [
      'Chuyển key …c86c sang ECO giúp mình',
      'Chuyển key ...c86c sang ECO',
      'Switch key …c86c to ECO',
      'Chuyển key sk-flm-1234…c86c sang eco',
      'Chuyển key sang ECO',
    ]) expect(isSwitchKeyModeRequest(q), q).toBe(true);
    for (const q of ['Tạo Personal Key mới', 'hỏi sao API lỗi 429', 'đổi màu widget sang xanh']) {
      expect(isSwitchKeyModeRequest(q), q).toBe(false);
    }
  });
});

describe('switching a key by its masked tail', () => {
  let owner: SessionUser;
  let keys: Array<{ id: number; name: string; keyPrefix: string; routingMode: string }>;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = 'c'.repeat(64);
    initDb(':memory:');
    owner = createUser('keyswitch-owner@example.com', 'AdminPass123!', 'admin');
    // Three keys; the FIRST is already ECO, so the old "first key not in that mode" guess would skip it.
    mintUserApiKey(owner.userId, 'Cursor', { routingMode: 'eco' });
    mintUserApiKey(owner.userId, 'Claude Code', { routingMode: 'balanced' });
    mintUserApiKey(owner.userId, 'Scripts', { routingMode: 'max' });
    keys = listUserApiKeys(owner.userId).filter((k) => !k.revoked) as typeof keys;
  });

  it('has three distinguishable keys to test with', () => {
    expect(keys).toHaveLength(3);
    expect(new Set(keys.map((k) => tailOf(k.keyPrefix))).size).toBe(3);
  });

  it('switches exactly the key whose tail was named, whatever its position or current mode', () => {
    for (const k of keys.filter((x) => x.routingMode !== 'eco')) {
      for (const q of [`Chuyển key …${tailOf(k.keyPrefix)} sang ECO giúp mình`, `Chuyển key ...${tailOf(k.keyPrefix)} sang ECO`, `Switch key …${tailOf(k.keyPrefix)} to ECO`]) {
        const m = matchUserActionIntent(q, owner);
        expect(m?.actionType, q).toBe('switch_key_routing_mode');
        expect((m!.proposal.params as { keyId: number }).keyId, q).toBe(k.id);
        expect((m!.proposal.params as { routingMode: string }).routingMode, q).toBe('eco');
      }
    }
  });

  it('also finds a key by the head or by the full masked text', () => {
    const k = keys[1]!;
    for (const q of [`Chuyển key sk-flm-${headOf(k.keyPrefix)}…${tailOf(k.keyPrefix)} sang ECO`, `Chuyển key ${k.keyPrefix} sang ECO`]) {
      expect((matchUserActionIntent(q, owner)!.proposal.params as { keyId: number }).keyId, q).toBe(k.id);
    }
  });

  it('never guesses: a named key that matches nothing is NOT switched, and the user is asked', () => {
    const q = 'Chuyển key …0000 sang ECO giúp mình';
    expect(findKeysByReference(keys, q)).toMatchObject({ referenced: true, matches: [] });
    expect(matchUserActionIntent(q, owner)).toBeNull();
    const res = buildKeyClarificationResponse({ message: q, user: owner, locale: 'vi' })!;
    expect(res.proposal).toBeNull();
    expect(res.actionProposal).toBeNull();
    expect(res.reply).toContain('chưa đổi gì');
    for (const k of keys) expect(res.reply).toContain(k.keyPrefix);
    expect(res.suggestedQuickReplies[0]).toBe(`Chuyển key ${keys[0]!.keyPrefix} sang ECO`);
  });

  it('the quick replies it offers resolve to exactly one key each', () => {
    const res = buildKeyClarificationResponse({ message: 'Chuyển key …0000 sang ECO', user: owner, locale: 'vi' })!;
    for (const reply of res.suggestedQuickReplies) {
      const m = matchUserActionIntent(reply, owner);
      expect(m?.actionType, reply).toBe('switch_key_routing_mode');
    }
  });

  it('keeps the old behaviour when no key is named at all', () => {
    const m = matchUserActionIntent('Chuyển key sang ECO giúp mình', owner)!;
    expect(m.actionType).toBe('switch_key_routing_mode');
    expect(buildKeyClarificationResponse({ message: 'Chuyển key sang ECO giúp mình', user: owner, locale: 'vi' })).toBeNull();
  });

  it('only ever looks at the caller\'s own keys', () => {
    const other = createUser('keyswitch-other@example.com', 'UserPass123!', 'member');
    const theirs = mintUserApiKey(other.userId, 'Theirs');
    const q = `Chuyển key …${tailOf(theirs.keyPrefix)} sang ECO`;
    expect(matchUserActionIntent(q, owner)).toBeNull();
    const res = buildKeyClarificationResponse({ message: q, user: owner, locale: 'en' })!;
    expect(res.reply).not.toContain(theirs.keyPrefix);
    expect(res.reply).toContain('changed nothing');
  });
});

describe('the screenshot: a tenant is selected and the user asks to switch a key', () => {
  let server: Server;
  let base: string;
  let adminToken: string;
  let tenantId: number;
  let tail: string;

  const chat = async (content: string) => {
    const res = await fetch(`${base}/api/support-setup-copilot/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...dashboardSessionHeaders(adminToken) },
      body: JSON.stringify({ tenantId, targetMode: 'update_tenant', locale: 'vi', currentPath: '/thruline/support', messages: [{ role: 'user', content }] }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = 'd'.repeat(64);
    initDb(':memory:');
    installMockCloudLease();
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', () => r()));
    const { port } = server.address() as { port: number };
    base = `http://127.0.0.1:${port}`;
    recordServerLocalAddress({ socket: { localAddress: '127.0.0.1', localPort: port } } as never);
    const admin = createUser('keyswitch-http-admin@example.com', 'AdminPass123!');
    adminToken = createSession(admin.userId);
    mintUserApiKey(admin.userId, 'Cursor', { routingMode: 'eco' });
    mintUserApiKey(admin.userId, 'Scripts', { routingMode: 'balanced' });
    tail = tailOf(listUserApiKeys(admin.userId).find((k) => k.name === 'Scripts')!.keyPrefix);
    tenantId = createSupportTenant({
      name: 'Chưa giàu đã lớn', slug: 'chua-giau', defaultModel: 'auto', systemPrompt: 'Prompt đã sẵn sàng.', createdBy: admin.userId,
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

  it('stages a confirm card for the named key instead of the tenant questionnaire', async () => {
    const { status, body } = await chat(`Chuyển key …${tail} sang ECO giúp mình`);
    expect(status).toBe(200);
    expect(body.actionProposal?.actionType).toBe('switch_key_routing_mode');
    expect(body.actionProposal?.params?.keyName ?? body.actionProposal?.summaryVi).toBeTruthy();
    expect(String(body.reply)).not.toContain('bản mẫu mặc định');
    expect(String(body.reply)).not.toContain('bên mình đang bán sản phẩm');
  });

  it('asks which key (and changes nothing) when the named key does not exist', async () => {
    const { body } = await chat('Chuyển key …0000 sang ECO giúp mình');
    expect(body.actionProposal).toBeNull();
    expect(body.proposal).toBeNull();
    expect(String(body.reply)).toContain('chưa đổi gì');
    expect(String(body.reply)).not.toContain('bản mẫu mặc định');
  });
});
