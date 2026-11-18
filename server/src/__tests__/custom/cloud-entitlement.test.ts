import crypto from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudAiRuntimePack, CloudSignedLease } from '@freellmapi/shared/cloud-entitlement.js';
import { initDb } from '../../db/index.js';
import {
  CloudEntitlementError,
  activateWithToken,
  checkActivationRequestApproval,
  clearSavedActivationToken,
  configureCloudEntitlementForTesting,
  ensureCloudEntitlementActive,
  getCloudEntitlementStatus,
  refreshCloudEntitlementLease,
  requireVerifiedCloudRuntimePack,
  submitActivationRequest,
} from '../../custom/cloud-entitlement/service.js';
import { requireCloudAiEntitlement } from '../../custom/cloud-entitlement/gate.js';
import { ENV_AI_ACTIVATION_TOKEN } from '../../custom/cloud-entitlement/constants.js';

function sha256Hex(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

describe('Cloud Entitlement Service & Security Gate', () => {
  const originalEnvToken = process.env[ENV_AI_ACTIVATION_TOKEN];

  let testEdPrivateKeyPem: string;
  let testEdPublicKeyPem: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = 'c'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    delete process.env[ENV_AI_ACTIVATION_TOKEN];

    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    testEdPublicKeyPem = publicKey;
    testEdPrivateKeyPem = privateKey;

    configureCloudEntitlementForTesting(null);
  });

  afterEach(async () => {
    configureCloudEntitlementForTesting(null);
    await clearSavedActivationToken();
    if (originalEnvToken) {
      process.env[ENV_AI_ACTIVATION_TOKEN] = originalEnvToken;
    } else {
      delete process.env[ENV_AI_ACTIVATION_TOKEN];
    }
    vi.restoreAllMocks();
  });

  function createMockRuntimePack(): CloudAiRuntimePack {
    return {
      version: 1,
      supportCoachPack: {
        personaVi: 'Bạn là chuyên viên huấn luyện hỗ trợ Thruline.',
        personaEn: 'You are the Thruline Support Coach.',
        playbookReference: '1. Greet 2. Diagnose 3. Triage 4. Resolve',
        outputContract: '{"diagnosis": "string", "nextStep": "string"}',
      },
      supportAgentCopilotInstruction: 'Assist human agents with factual context and playbook compliance.',
      customerAiDirective: 'Provide empathetic, accurate, and concise AI assistance.',
      supportGatewayDirective: 'Route customer requests to appropriate specialized support channels.',
      aiPlatformCapabilityGrant: 'grant_ai_platform_full',
    };
  }

  function createMockLease(pack: CloudAiRuntimePack, label = 'Test Commercial License'): {
    lease: CloudSignedLease;
    signature: string;
  } {
    const packHash = sha256Hex(JSON.stringify(pack));
    const lease: CloudSignedLease = {
      licenseId: 'lic-test-5678',
      label,
      instanceId: 'inst-test-001',
      scopes: ['customer_ai', 'support_suite', 'support_copilot', 'ai_platform', 'tenant_portal'],
      packVersion: 1,
      packHash,
      issuedAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    };
    const canonicalLeaseBytes = Buffer.from(JSON.stringify(lease), 'utf8');
    const sigBytes = crypto.sign(null, canonicalLeaseBytes, testEdPrivateKeyPem);
    const signature = sigBytes.toString('base64url');
    return { lease, signature };
  }

  it('reports unactivated state and blocks runtime pack access when no token is present', async () => {
    const status = await getCloudEntitlementStatus({ canManage: true });
    expect(status.active).toBe(false);
    expect(status.state).toBe('unactivated');
    expect(status.license).toBeNull();

    expect(() => requireVerifiedCloudRuntimePack('support_suite')).toThrow(
      CloudEntitlementError,
    );

    try {
      requireVerifiedCloudRuntimePack('support_suite');
    } catch (err) {
      const entitlementErr = err as CloudEntitlementError;
      expect(entitlementErr.status).toBe(403);
      expect(entitlementErr.code).toBe('ai_activation_required');
    }
  });

  it('activates successfully with valid Ed25519 signed lease and provides runtime pack', async () => {
    const mockPack = createMockRuntimePack();
    const { lease, signature } = createMockLease(mockPack, 'Acme Corp License');

    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/v1/lease')) {
        return new Response(
          JSON.stringify({
            ok: true,
            lease,
            signature,
            runtimePack: mockPack,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('Not found', { status: 404 });
    });

    configureCloudEntitlementForTesting({
      publicKeyPem: testEdPublicKeyPem,
      baseUrl: 'https://mock-gate.test',
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    const activeRecord = await activateWithToken('flm_act_valid_test_token_12345678');
    expect(activeRecord.lease.label).toBe('Acme Corp License');
    expect(activeRecord.lease.scopes).toContain('support_suite');

    // Verification of runtime pack
    const pack = requireVerifiedCloudRuntimePack('support_suite');
    expect(pack.supportCoachPack.personaEn).toBe('You are the Thruline Support Coach.');
    expect(pack.supportAgentCopilotInstruction).toContain('Assist human agents');

    // Status reflection
    const status = await getCloudEntitlementStatus({ canManage: true });
    expect(status.active).toBe(true);
    expect(status.state).toBe('active');
    expect(status.license?.label).toBe('Acme Corp License');
  });

  it('rejects tampered or corrupted lease signatures', async () => {
    const mockPack = createMockRuntimePack();
    const { lease } = createMockLease(mockPack, 'Acme Corp License');
    const corruptSignature = 'corrupted_signature_payload_xyz';

    const mockFetch = vi.fn().mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          ok: true,
          lease,
          signature: corruptSignature,
          runtimePack: mockPack,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    configureCloudEntitlementForTesting({
      publicKeyPem: testEdPublicKeyPem,
      baseUrl: 'https://mock-gate.test',
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    await expect(activateWithToken('flm_act_tampered_test_token')).rejects.toThrow(
      CloudEntitlementError,
    );

    const status = await getCloudEntitlementStatus({ canManage: true });
    expect(status.active).toBe(false);
  });

  it('handles remote revocation by transitioning state to revoked and discarding lease', async () => {
    const mockPack = createMockRuntimePack();
    const { lease, signature } = createMockLease(mockPack, 'License to be Revoked');

    let isRevoked = false;
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/v1/lease')) {
        if (isRevoked) {
          return new Response(
            JSON.stringify({
              ok: false,
              error: 'license_revoked',
              message: 'This activation token was revoked by the repository owner.',
            }),
            { status: 403, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({
            ok: true,
            lease,
            signature,
            runtimePack: mockPack,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('Not found', { status: 404 });
    });

    configureCloudEntitlementForTesting({
      publicKeyPem: testEdPublicKeyPem,
      baseUrl: 'https://mock-gate.test',
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    await activateWithToken('flm_act_revocable_token_123456');
    expect(await ensureCloudEntitlementActive()).toBeTruthy();

    // 2. Owner revokes license
    isRevoked = true;
    configureCloudEntitlementForTesting({
      publicKeyPem: testEdPublicKeyPem,
      baseUrl: 'https://mock-gate.test',
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    // Forced online sync receives 403 license_revoked and purges local lease
    const refreshed = await refreshCloudEntitlementLease({ forceOnline: true });
    expect(refreshed).toBeNull();

    const active = await ensureCloudEntitlementActive('support_suite');
    expect(active).toBeNull();

    const status = await getCloudEntitlementStatus({ canManage: true });
    expect(status.active).toBe(false);
    expect(status.state).toBe('revoked');
  });

  it('executes zero-plaintext RSA request creation and auto-claim approval', async () => {
    let capturedPublicKeySpki = '';
    const issuedPlainToken = 'flm_act_auto_issued_from_rsa_test_1234567890';
    let encryptedTokenB64 = '';

    const mockPack = createMockRuntimePack();
    const { lease, signature } = createMockLease(mockPack, 'Auto Claimed License');

    const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/v1/requests') && !url.includes('/status')) {
        const body = JSON.parse(String(init?.body || '{}'));
        capturedPublicKeySpki = body.publicKeySpkiB64;
        return new Response(
          JSON.stringify({
            ok: true,
            requestId: 'req-uuid-999',
            status: 'pending',
            createdAt: new Date().toISOString(),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }

      if (url.includes('/v1/requests/req-uuid-999/status')) {
        // Encrypt plainToken with the client's captured ephemeral RSA public key
        const cipherBuffer = crypto.publicEncrypt(
          {
            key: capturedPublicKeySpki,
            padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
            oaepHash: 'sha256',
          },
          Buffer.from(issuedPlainToken, 'utf8'),
        );
        encryptedTokenB64 = cipherBuffer.toString('base64url');

        return new Response(
          JSON.stringify({
            ok: true,
            requestId: 'req-uuid-999',
            status: 'approved',
            decisionNote: 'Granted for team evaluation',
            encryptedTokenB64,
            updatedAt: new Date().toISOString(),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }

      if (url.includes('/v1/lease')) {
        return new Response(
          JSON.stringify({
            ok: true,
            lease,
            signature,
            runtimePack: mockPack,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }

      return new Response('Not found', { status: 404 });
    });

    configureCloudEntitlementForTesting({
      publicKeyPem: testEdPublicKeyPem,
      baseUrl: 'https://mock-gate.test',
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    // 1. Submit request
    const reqResult = await submitActivationRequest({
      orgName: 'Alpha Tech',
      contactInfo: 'admin@alphatech.example',
      note: 'Evaluating AI platform capabilities',
      serverOrigin: 'https://alphatech.example',
    });

    expect(reqResult.requestId).toBe('req-uuid-999');
    expect(reqResult.status).toBe('pending');
    expect(capturedPublicKeySpki).toContain('BEGIN PUBLIC KEY');

    // 2. Check approval and auto-claim
    const checkResult = await checkActivationRequestApproval('https://alphatech.example');
    expect(checkResult.activated).toBe(true);
    expect(checkResult.request.status).toBe('approved');

    // 3. System is now active without anyone having to copy-paste tokens!
    const status = await getCloudEntitlementStatus({ canManage: true });
    expect(status.active).toBe(true);
    expect(status.license?.label).toBe('Auto Claimed License');
  });

  it('express middleware requireCloudAiEntitlement blocks inactive requests and passes active ones', async () => {
    const middleware = requireCloudAiEntitlement('support_suite');

    // Inactive test
    let nextCalled = false;
    let sentStatus = 0;
    let sentJson: unknown = null;

    const mockReq = {} as any;
    const mockRes = {
      status(code: number) {
        sentStatus = code;
        return this;
      },
      json(data: unknown) {
        sentJson = data;
        return this;
      },
    } as any;
    const mockNext = () => {
      nextCalled = true;
    };

    await middleware(mockReq, mockRes, mockNext);
    expect(nextCalled).toBe(false);
    expect(sentStatus).toBe(403);
    expect((sentJson as any)?.error?.code).toBe('ai_activation_required');

    // Active test
    const mockPack = createMockRuntimePack();
    const { lease, signature } = createMockLease(mockPack, 'Middleware Test');
    const mockFetch = vi.fn().mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          ok: true,
          lease,
          signature,
          runtimePack: mockPack,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    configureCloudEntitlementForTesting({
      publicKeyPem: testEdPublicKeyPem,
      baseUrl: 'https://mock-gate.test',
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    await activateWithToken('flm_act_middleware_test_token_123');

    nextCalled = false;
    await middleware(mockReq, mockRes, mockNext);
    expect(nextCalled).toBe(true);
  });
});
