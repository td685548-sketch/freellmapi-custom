/**
 * Real-service test suite for Support Agent Copilot (Spec 019 - US2).
 * Tasks: T013, T015, T016, T017.
 * Owned by Agent 2 (server/src/__tests__/custom/x-support-agent-copilot.test.ts).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectDb, defaultDbFactory, type Db } from '../../db/index.js';
import { runMigrations } from '../../db/migrate/runner.js';
import { nodeSqliteFactory } from '../../db/node-sqlite.js';
import { encrypt, initEncryptionKey } from '../../lib/crypto.js';
import * as routes from '../../custom/x-gateway/router.js';
import * as providers from '../../custom/provider-accounts/execution.js';
import type { BaseProvider } from '../../providers/base.js';

vi.mock('../../custom/x-gateway/quota/tracking.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../custom/x-gateway/quota/tracking.js')>()),
  withQuotaTracking: async (_account: unknown, _model: unknown, _proxy: unknown, call: () => Promise<unknown>) =>
    call(),
}));
import {
  createSupportTenant,
  ensureSupportTables,
  type SupportTenant,
} from '../../custom/x-gateway/support-store.js';
import {
  ensureSupportServiceDeskTables,
} from '../../custom/x-gateway/support-service-desk-store.js';
import {
  createSupportEvidenceSource,
  importSupportEvidenceRevision,
  publishSupportEvidenceRevision,
  updateSupportEvidencePolicy,
  updateSupportEvidenceSource,
} from '../../custom/x-gateway/support-evidence-store.js';
import {
  createOrAppendSupportConversation,
  getSupportConversationForUser,
  type SupportConversation,
} from '../../custom/x-gateway/support-workflows.js';
import {
  generateSupportAgentCopilot,
  readSupportAgentCopilotJob,
} from '../../custom/x-gateway/support-agent-copilot.js';
import { SUPPORT_DESK_LIMITS } from '@freellmapi/shared/support-service-desk.js';

describe('Support Agent Copilot (Spec 019 - US2)', () => {
  let db: Db;
  let tenant: SupportTenant;
  const actorId = 42;
  const otherActorId = 99;
  const completion = vi.fn();

  beforeEach(async () => {
    vi.stubEnv('ENCRYPTION_KEY', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');

    db = connectDb(':memory:', {
      factory: (dbPath) => {
        try {
          return defaultDbFactory()(dbPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ERR_DLOPEN_FAILED') throw error;
          return nodeSqliteFactory(dbPath);
        }
      },
    });

    await runMigrations(db, 'up');
    initEncryptionKey(db);
    ensureSupportTables();
    ensureSupportServiceDeskTables(db);

    tenant = createSupportTenant({
      name: 'Copilot Test Org',
      slug: 'copilot-test-org',
      defaultModel: 'test-model',
    }).tenant;

    const secret = encrypt('test-only-provider-key');
    vi.spyOn(routes, 'resolveCandidateRoutes').mockReturnValue({
      candidates: [
        {
          account: {
            id: 1,
            provider: 'test',
            platform: 'test',
            encrypted_key: secret.encrypted,
            iv: secret.iv,
            auth_tag: secret.authTag,
          },
          modelId: 'test-model',
        },
      ],
    } as ReturnType<typeof routes.resolveCandidateRoutes>);

    vi.spyOn(providers, 'resolveAccountProvider').mockReturnValue({
      chatCompletion: completion,
    } as unknown as BaseProvider);

    completion.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    db?.close?.();
  });

  async function publishKnowledgeDoc(params: {
    title: string;
    content: string;
    allowedRoles: Array<'guest' | 'customer' | 'staff' | 'admin'>;
  }): Promise<{ sourceId: string; revisionId: string; version: number }> {
    const src = createSupportEvidenceSource(tenant.id, {
      name: params.title,
      kind: 'text',
      allowedRoles: params.allowedRoles,
    });
    const rev = await importSupportEvidenceRevision({
      tenantId: tenant.id,
      sourceId: src.id,
      expectedVersion: src.version,
      title: params.title,
      format: 'text',
      content: params.content,
    });
    const published = publishSupportEvidenceRevision(tenant.id, src.id, rev.revision.id, rev.source.version);
    return { sourceId: src.id, revisionId: rev.revision.id, version: published.version };
  }

  function createTestConversation(params: {
    userId?: string;
    userRole?: string;
    subject?: string;
    question: string;
  }): SupportConversation {
    const userId = params.userId ?? 'cust_101';
    const userRole = params.userRole ?? 'customer';
    const subject = params.subject ?? 'Return Policy';
    return createOrAppendSupportConversation(String(tenant.id), {
      userId,
      userRole,
      userName: 'Test Customer',
      userEmail: 'customer@example.com',
      subject,
      message: {
        senderType: 'customer',
        senderId: userId,
        content: params.question,
      },
    });
  }

  // -------------------------------------------------------------------------
  // Test 1: Standard successful EN customer copilot draft generation
  // -------------------------------------------------------------------------
  it('generates grounded summary and 3 distinct drafts for English customer inquiry', async () => {
    await publishKnowledgeDoc({
      title: 'Return Policy',
      content: 'Customers can return undamaged items within 30 days of delivery for a full refund.',
      allowedRoles: ['customer', 'staff', 'admin'],
    });

    const conv = createTestConversation({
      question: 'How many days do I have to return an item?',
    });

    completion.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              summary: 'Customer is inquiring about the return window [1].',
              drafts: [
                {
                  tone: 'empathetic',
                  text: 'I understand you may wish to return your purchase. You have 30 days from delivery [1].',
                },
                {
                  tone: 'direct',
                  text: 'You can return undamaged items within 30 days of delivery [1].',
                },
                {
                  tone: 'technical',
                  text: 'Returns are accepted up to 30 days post-delivery per standard refund policy [1].',
                },
              ],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 },
    });

    const result = await generateSupportAgentCopilot({
      tenantId: tenant.id,
      actorId,
      input: { requestId: 'req_en_01', conversationId: conv.id },
    });

    expect(result.status).toBe('completed');
    expect(result.summary).toContain('[1]');
    expect(result.summaryCitations).toHaveLength(1);
    expect(result.summaryCitations[0].ordinal).toBe(1);
    expect(result.drafts).toHaveLength(3);

    const tones = result.drafts.map((d) => d.tone);
    expect(tones).toEqual(['empathetic', 'direct', 'technical']);

    for (const draft of result.drafts) {
      expect(draft.citations).toHaveLength(1);
      expect(draft.text).toContain('[1]');
    }

    expect(result.modelUsed).toBe('test-model');
    expect(result.usage.promptTokens).toBe(120);
    expect(result.usage.completionTokens).toBe(80);
    expect(result.usage.accounting).toBe('actual');
    expect(result.replayed).toBe(false);

    // Verify conversation transcript and customer quota were not modified
    const reloaded = getSupportConversationForUser(String(tenant.id), conv.id, {
      userId: conv.userId,
      role: 'customer',
    });
    expect(reloaded.messages).toHaveLength(1); // Still only 1 customer message
  });

  // -------------------------------------------------------------------------
  // Test 2: Standard successful VI customer copilot draft generation
  // -------------------------------------------------------------------------
  it('generates grounded summary and 3 distinct drafts for Vietnamese customer inquiry', async () => {
    await publishKnowledgeDoc({
      title: 'Chính sách bảo hành',
      content: 'Sản phẩm được bảo hành miễn phí trong vòng 12 tháng kể từ ngày kích hoạt.',
      allowedRoles: ['customer', 'staff', 'admin'],
    });

    const conv = createTestConversation({
      subject: 'Chính sách bảo hành',
      question: 'Thời gian bảo hành của thiết bị là bao lâu?',
    });

    completion.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              summary: 'Khách hàng hỏi về thời gian bảo hành thiết bị [1].',
              drafts: [
                {
                  tone: 'empathetic',
                  text: 'Dạ sản phẩm được bảo hành chính hãng trong 12 tháng nên bạn hoàn toàn an tâm nhé [1].',
                },
                {
                  tone: 'direct',
                  text: 'Sản phẩm được bảo hành miễn phí trong 12 tháng từ ngày kích hoạt [1].',
                },
                {
                  tone: 'technical',
                  text: 'Theo điều khoản bảo hành, thời hạn là 12 tháng tính từ ngày kích hoạt [1].',
                },
              ],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 150, completion_tokens: 90, total_tokens: 240 },
    });

    const result = await generateSupportAgentCopilot({
      tenantId: tenant.id,
      actorId,
      input: { requestId: 'req_vi_01', conversationId: conv.id },
    });

    expect(result.status).toBe('completed');
    expect(result.drafts).toHaveLength(3);
    expect(result.summaryCitations[0].title).toBe('Chính sách bảo hành');
  });

  // -------------------------------------------------------------------------
  // Test 3: Guest role conversation uses guest-scoped knowledge
  // -------------------------------------------------------------------------
  it('supports unauthenticated guest conversation with guest-visible knowledge', async () => {
    await publishKnowledgeDoc({
      title: 'Guest Shipping FAQ',
      content: 'Standard shipping takes 3 to 5 business days across all regions.',
      allowedRoles: ['guest', 'customer', 'staff', 'admin'],
    });

    const conv = createTestConversation({
      userId: 'guest_anon',
      userRole: 'guest',
      subject: 'Guest Shipping FAQ',
      question: 'How long does standard shipping take across regions?',
    });

    completion.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              summary: 'Guest shipping duration inquiry [1].',
              drafts: [
                { tone: 'empathetic', text: 'Standard delivery takes 3 to 5 business days [1].' },
                { tone: 'direct', text: 'Shipping takes 3 to 5 business days [1].' },
                { tone: 'technical', text: 'Logistics delivery SLA is 3 to 5 business days [1].' },
              ],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    });

    const result = await generateSupportAgentCopilot({
      tenantId: tenant.id,
      actorId,
      input: { requestId: 'req_guest_01', conversationId: conv.id },
    });

    expect(result.status).toBe('completed');
    expect(result.drafts).toHaveLength(3);
  });

  // -------------------------------------------------------------------------
  // Test 4: Staff role accessing staff-only SOP knowledge
  // -------------------------------------------------------------------------
  it('supports staff role conversation accessing staff-restricted knowledge', async () => {
    await publishKnowledgeDoc({
      title: 'Internal Courtesy Credit SOP',
      content: 'Staff members may authorize courtesy credits up to $50 without escalation.',
      allowedRoles: ['staff', 'admin'],
    });

    const conv = createTestConversation({
      userId: 'staff_user',
      userRole: 'staff',
      subject: 'Internal Courtesy Credit SOP',
      question: 'Can staff authorize courtesy credits up to 50 USD?',
    });

    completion.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              summary: 'Staff verifies authorized courtesy credit limit [1].',
              drafts: [
                { tone: 'empathetic', text: 'You may issue up to $50 courtesy credit [1].' },
                { tone: 'direct', text: 'Courtesy credit limit is $50 [1].' },
                { tone: 'technical', text: 'Staff authorization threshold allows up to $50 [1].' },
              ],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 110, completion_tokens: 55, total_tokens: 165 },
    });

    const result = await generateSupportAgentCopilot({
      tenantId: tenant.id,
      actorId,
      input: { requestId: 'req_staff_01', conversationId: conv.id },
    });

    expect(result.status).toBe('completed');
  });

  // -------------------------------------------------------------------------
  // Test 5: Admin role accessing admin-restricted governance knowledge
  // -------------------------------------------------------------------------
  it('supports admin role conversation accessing admin-restricted knowledge', async () => {
    await publishKnowledgeDoc({
      title: 'Tenant Security SLA',
      content: 'Daily security audits run at 00:00 UTC and only admins can rotate API keys.',
      allowedRoles: ['admin'],
    });

    const conv = createTestConversation({
      userId: 'admin_user',
      userRole: 'admin',
      subject: 'Tenant Security SLA',
      question: 'When do tenant daily security audits run?',
    });

    completion.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              summary: 'Admin audit schedule inquiry [1].',
              drafts: [
                { tone: 'empathetic', text: 'Security audits run at 00:00 UTC [1].' },
                { tone: 'direct', text: 'Audits execute daily at 00:00 UTC [1].' },
                { tone: 'technical', text: 'Security governance protocol schedules audits at 00:00 UTC [1].' },
              ],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 110, completion_tokens: 55, total_tokens: 165 },
    });

    const result = await generateSupportAgentCopilot({
      tenantId: tenant.id,
      actorId,
      input: { requestId: 'req_admin_01', conversationId: conv.id },
    });

    expect(result.status).toBe('completed');
  });

  // -------------------------------------------------------------------------
  // Test 6: Unsupported evidence role rejects with 403
  // -------------------------------------------------------------------------
  it('rejects unsupported customer role with 403 unsupported_evidence_role', async () => {
    const conv = createTestConversation({
      userRole: 'anonymous_superhero',
      question: 'Help me!',
    });

    await expect(
      generateSupportAgentCopilot({
        tenantId: tenant.id,
        actorId,
        input: { requestId: 'req_bad_role', conversationId: conv.id },
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: 'unsupported_evidence_role',
    });
  });

  // -------------------------------------------------------------------------
  // Test 7: Honest zero-model abstention when no sources match
  // -------------------------------------------------------------------------
  it('abstains with no_evidence without calling model when no sources match', async () => {
    const conv = createTestConversation({
      subject: 'Alien technology inquiry',
      question: 'How do quantum tachyons invert warp coils?',
    });

    const result = await generateSupportAgentCopilot({
      tenantId: tenant.id,
      actorId,
      input: { requestId: 'req_no_ev_01', conversationId: conv.id },
    });

    expect(result.status).toBe('abstained');
    expect(result.reason).toBe('no_evidence');
    expect(result.summary).toBe('');
    expect(result.drafts).toEqual([]);
    expect(result.summaryCitations).toEqual([]);
    expect(result.modelUsed).toBeNull();
    expect(result.usage.totalTokens).toBe(0);

    // Ensure model was never invoked
    expect(completion).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 8: Forged citations rejected as invalid_result
  // -------------------------------------------------------------------------
  it('rejects forged citations as abstained with invalid_result and retains spent cost', async () => {
    await publishKnowledgeDoc({
      title: 'Return Policy',
      content: 'Returns are accepted within 30 days of delivery.',
      allowedRoles: ['customer', 'staff', 'admin'],
    });

    const conv = createTestConversation({
      question: 'When can I return an item?',
    });

    // Model hallucinates an unauthorized citation
    completion.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              summary: 'Customer asks about returns [cite:cit_forged_9999].',
              drafts: [
                { tone: 'empathetic', text: 'Returns in 30 days [cite:cit_forged_9999].' },
                { tone: 'direct', text: '30 days [cite:cit_forged_9999].' },
                { tone: 'technical', text: 'Return window 30 days [cite:cit_forged_9999].' },
              ],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    });

    const result = await generateSupportAgentCopilot({
      tenantId: tenant.id,
      actorId,
      input: { requestId: 'req_forged_01', conversationId: conv.id },
    });

    expect(result.status).toBe('abstained');
    expect(result.reason).toBe('invalid_result');
    expect(result.summary).toBe('');
    expect(result.drafts).toEqual([]);
    expect(result.usage.totalTokens).toBe(150); // Incurred cost retained
  });

  // -------------------------------------------------------------------------
  // Test 9: Duplicate or missing tones rejected as invalid_result
  // -------------------------------------------------------------------------
  it('rejects duplicate tones as abstained with invalid_result', async () => {
    await publishKnowledgeDoc({
      title: 'Return Policy',
      content: 'Returns are accepted within 30 days of delivery.',
      allowedRoles: ['customer', 'staff', 'admin'],
    });

    const conv = createTestConversation({
      question: 'When can I return an item?',
    });

    // Model returns 2 empathetic drafts instead of 3 unique tones
    completion.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              summary: 'Customer asks about returns [1].',
              drafts: [
                { tone: 'empathetic', text: 'I understand. Returns in 30 days [1].' },
                { tone: 'empathetic', text: 'I feel your pain. Returns in 30 days [1].' },
                { tone: 'direct', text: '30 days [1].' },
              ],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    });

    const result = await generateSupportAgentCopilot({
      tenantId: tenant.id,
      actorId,
      input: { requestId: 'req_duptones_01', conversationId: conv.id },
    });

    expect(result.status).toBe('abstained');
    expect(result.reason).toBe('invalid_result');
  });

  // -------------------------------------------------------------------------
  // Test 10: Tool markup rejected as invalid_result
  // -------------------------------------------------------------------------
  it('rejects business tool markup in model output as invalid_result', async () => {
    await publishKnowledgeDoc({
      title: 'Return Policy',
      content: 'Returns are accepted within 30 days of delivery.',
      allowedRoles: ['customer', 'staff', 'admin'],
    });

    const conv = createTestConversation({
      question: 'When can I return an item?',
    });

    completion.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              summary: 'Customer asks about returns [1].',
              drafts: [
                {
                  tone: 'empathetic',
                  text: 'Returns in 30 days [1]. <support_tool_call>{"name":"refund"}</support_tool_call>',
                },
                { tone: 'direct', text: '30 days [1].' },
                { tone: 'technical', text: 'Return window 30 days [1].' },
              ],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    });

    const result = await generateSupportAgentCopilot({
      tenantId: tenant.id,
      actorId,
      input: { requestId: 'req_toolmarkup_01', conversationId: conv.id },
    });

    expect(result.status).toBe('abstained');
    expect(result.reason).toBe('invalid_result');
  });

  // -------------------------------------------------------------------------
  // Test 11: Malformed JSON or non-JSON text rejected as invalid_result
  // -------------------------------------------------------------------------
  it('rejects unparseable non-JSON text as abstained with invalid_result', async () => {
    await publishKnowledgeDoc({
      title: 'Return Policy',
      content: 'Returns are accepted within 30 days of delivery.',
      allowedRoles: ['customer', 'staff', 'admin'],
    });

    const conv = createTestConversation({
      question: 'When can I return an item?',
    });

    completion.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: 'I am sorry, but here is my plain text response instead of JSON.',
          },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
    });

    const result = await generateSupportAgentCopilot({
      tenantId: tenant.id,
      actorId,
      input: { requestId: 'req_malformed_01', conversationId: conv.id },
    });

    expect(result.status).toBe('abstained');
    expect(result.reason).toBe('invalid_result');
  });

  // -------------------------------------------------------------------------
  // Test 12: In-flight knowledge source change -> safe sources_changed abstention
  // -------------------------------------------------------------------------
  it('abstains with sources_changed when knowledge source is updated in-flight', async () => {
    const { sourceId, version } = await publishKnowledgeDoc({
      title: 'Return Policy',
      content: 'Returns are accepted within 30 days of delivery.',
      allowedRoles: ['customer', 'staff', 'admin'],
    });

    const conv = createTestConversation({
      question: 'When can I return an item?',
    });

    // In-flight: update the source allowedRoles during the model completion
    completion.mockImplementationOnce(async () => {
      updateSupportEvidenceSource(tenant.id, sourceId, { allowedRoles: ['staff'] }, version);
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: 'Customer asks about returns [1].',
                drafts: [
                  { tone: 'empathetic', text: 'Returns in 30 days [1].' },
                  { tone: 'direct', text: '30 days [1].' },
                  { tone: 'technical', text: 'Return window 30 days [1].' },
                ],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      };
    });

    const result = await generateSupportAgentCopilot({
      tenantId: tenant.id,
      actorId,
      input: { requestId: 'req_src_changed_01', conversationId: conv.id },
    });

    expect(result.status).toBe('abstained');
    expect(result.reason).toBe('sources_changed');
    expect(result.summary).toBe('');
    expect(result.drafts).toEqual([]);
    expect(result.usage.totalTokens).toBe(150);
  });

  // -------------------------------------------------------------------------
  // Test 13: Stale context revalidation on replay / GET -> 409 copilot_context_changed
  // -------------------------------------------------------------------------
  it('rejects GET/replay with 409 copilot_context_changed when conversation changed', async () => {
    await publishKnowledgeDoc({
      title: 'Return Policy',
      content: 'Returns are accepted within 30 days of delivery.',
      allowedRoles: ['customer', 'staff', 'admin'],
    });

    const conv = createTestConversation({
      question: 'When can I return an item?',
    });

    completion.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              summary: 'Customer asks about returns [1].',
              drafts: [
                { tone: 'empathetic', text: 'Returns in 30 days [1].' },
                { tone: 'direct', text: '30 days [1].' },
                { tone: 'technical', text: 'Return window 30 days [1].' },
              ],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    });

    const gen = await generateSupportAgentCopilot({
      tenantId: tenant.id,
      actorId,
      input: { requestId: 'req_stale_conv_01', conversationId: conv.id },
    });
    expect(gen.status).toBe('completed');

    // Mutate conversation by adding a new customer message
    createOrAppendSupportConversation(String(tenant.id), {
      conversationId: conv.id,
      userId: conv.userId,
      userRole: conv.userRole,
      message: {
        senderType: 'customer',
        senderId: conv.userId,
        content: 'Also, can I exchange for a different color?',
      },
    });

    // Replay should fail with 409 copilot_context_changed
    await expect(
      generateSupportAgentCopilot({
        tenantId: tenant.id,
        actorId,
        input: { requestId: 'req_stale_conv_01', conversationId: conv.id },
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'copilot_context_changed',
    });

    // GET by jobId should also fail with 409 copilot_context_changed
    expect(() =>
      readSupportAgentCopilotJob({
        tenantId: tenant.id,
        actorId,
        jobId: gen.jobId,
      }),
    ).toThrowError(/changed/i);
  });

  // -------------------------------------------------------------------------
  // Test 14: Replay of completed job returns cached result without duplicate charge
  // -------------------------------------------------------------------------
  it('returns cached result on exact request replay without calling model again', async () => {
    await publishKnowledgeDoc({
      title: 'Return Policy',
      content: 'Returns are accepted within 30 days of delivery.',
      allowedRoles: ['customer', 'staff', 'admin'],
    });

    const conv = createTestConversation({
      question: 'When can I return an item?',
    });

    completion.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              summary: 'Customer asks about returns [1].',
              drafts: [
                { tone: 'empathetic', text: 'Returns in 30 days [1].' },
                { tone: 'direct', text: '30 days [1].' },
                { tone: 'technical', text: 'Return window 30 days [1].' },
              ],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    });

    const first = await generateSupportAgentCopilot({
      tenantId: tenant.id,
      actorId,
      input: { requestId: 'req_replay_01', conversationId: conv.id },
    });
    expect(first.status).toBe('completed');
    expect(first.replayed).toBe(false);

    // Second call with same requestId and conversationId
    const second = await generateSupportAgentCopilot({
      tenantId: tenant.id,
      actorId,
      input: { requestId: 'req_replay_01', conversationId: conv.id },
    });
    expect(second.status).toBe('completed');
    expect(second.replayed).toBe(true);
    expect(second.jobId).toBe(first.jobId);

    // Provider was called only once
    expect(completion).toHaveBeenCalledTimes(1);

    // readSupportAgentCopilotJob also succeeds
    const read = readSupportAgentCopilotJob({
      tenantId: tenant.id,
      actorId,
      jobId: first.jobId,
    });
    expect(read.jobId).toBe(first.jobId);
    expect(read.replayed).toBe(true);

    // Different operator cannot read the job
    expect(() =>
      readSupportAgentCopilotJob({
        tenantId: tenant.id,
        actorId: otherActorId,
        jobId: first.jobId,
      }),
    ).toThrowError(/job not found/i);
  });

  // -------------------------------------------------------------------------
  // Test 15: Conflicting parameters under same requestId -> 409 request_conflict
  // -------------------------------------------------------------------------
  it('throws 409 request_conflict when requestId reused with different conversationId', async () => {
    await publishKnowledgeDoc({
      title: 'Return Policy',
      content: 'Returns are accepted within 30 days of delivery.',
      allowedRoles: ['customer', 'staff', 'admin'],
    });

    const convA = createTestConversation({ question: 'Question A' });
    const convB = createTestConversation({ question: 'Question B' });

    completion.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              summary: 'Summary [1].',
              drafts: [
                { tone: 'empathetic', text: 'A [1].' },
                { tone: 'direct', text: 'B [1].' },
                { tone: 'technical', text: 'C [1].' },
              ],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
    });

    await generateSupportAgentCopilot({
      tenantId: tenant.id,
      actorId,
      input: { requestId: 'req_conflict_id', conversationId: convA.id },
    });

    // Reusing same requestId for convB
    await expect(
      generateSupportAgentCopilot({
        tenantId: tenant.id,
        actorId,
        input: { requestId: 'req_conflict_id', conversationId: convB.id },
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'request_conflict',
    });
  });

  // -------------------------------------------------------------------------
  // Test 16: Hourly operator request limit (10/hr) -> 429 copilot_quota_exceeded
  // -------------------------------------------------------------------------
  it('enforces 10 requests per operator UTC hour limit with 429 copilot_quota_exceeded', async () => {
    const conv = createTestConversation({
      subject: 'Alien technology inquiry',
      question: 'Quantum query with no evidence',
    });

    // Exhaust 10 requests (zero-model abstentions count toward request quota)
    for (let i = 0; i < SUPPORT_DESK_LIMITS.copilotRequestsPerHour; i++) {
      await generateSupportAgentCopilot({
        tenantId: tenant.id,
        actorId,
        input: { requestId: `req_quota_loop_${i}`, conversationId: conv.id },
      });
    }

    // 11th request should be rejected
    await expect(
      generateSupportAgentCopilot({
        tenantId: tenant.id,
        actorId,
        input: { requestId: 'req_quota_loop_10', conversationId: conv.id },
      }),
    ).rejects.toMatchObject({
      status: 429,
      code: 'copilot_quota_exceeded',
    });
  });

  // -------------------------------------------------------------------------
  // Test 17: Provider failure -> 503 model_unavailable (no fallback success)
  // -------------------------------------------------------------------------
  it('fails with 503 model_unavailable when provider errors and refuses fallback', async () => {
    await publishKnowledgeDoc({
      title: 'Return Policy',
      content: 'Returns are accepted within 30 days of delivery.',
      allowedRoles: ['customer', 'staff', 'admin'],
    });

    const conv = createTestConversation({ question: 'How do returns work?' });

    completion.mockRejectedValueOnce(new Error('Upstream provider connection refused.'));

    await expect(
      generateSupportAgentCopilot({
        tenantId: tenant.id,
        actorId,
        input: { requestId: 'req_provider_fail_01', conversationId: conv.id },
      }),
    ).rejects.toMatchObject({
      status: 503,
      code: 'model_unavailable',
    });
  });

  // -------------------------------------------------------------------------
  // Test 18: Unprovenanced and redacted AI history is excluded from model context
  // -------------------------------------------------------------------------
  it('excludes unprovenanced and redacted AI messages from prompt sent to model', async () => {
    await publishKnowledgeDoc({
      title: 'Return Policy',
      content: 'Returns are accepted within 30 days of delivery.',
      allowedRoles: ['customer', 'staff', 'admin'],
    });

    const conv = createTestConversation({ question: 'Original customer inquiry' });

    // Append an unprovenanced legacy AI message
    createOrAppendSupportConversation(String(tenant.id), {
      conversationId: conv.id,
      userId: conv.userId,
      userRole: conv.userRole,
      message: {
        senderType: 'ai_assistant',
        content: 'SECRET_UNPROVENANCED_AI_TEXT',
      },
    });

    let sentMessages: Array<{ role: string; content: string }> = [];
    completion.mockImplementationOnce(async (_cred, msgs) => {
      sentMessages = msgs;
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: 'Summary [1].',
                drafts: [
                  { tone: 'empathetic', text: 'Empathetic draft [1].' },
                  { tone: 'direct', text: 'Direct draft [1].' },
                  { tone: 'technical', text: 'Technical draft [1].' },
                ],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      };
    });

    const res = await generateSupportAgentCopilot({
      tenantId: tenant.id,
      actorId,
      input: { requestId: 'req_clean_hist_01', conversationId: conv.id },
    });
    expect(res.status).toBe('completed');

    const serializedSent = JSON.stringify(sentMessages);
    expect(serializedSent).not.toContain('SECRET_UNPROVENANCED_AI_TEXT');
  });

  // -------------------------------------------------------------------------
  // Test 19: Concurrent identical request -> 409 copilot_in_progress
  // -------------------------------------------------------------------------
  it('rejects concurrent identical request with 409 copilot_in_progress', async () => {
    await publishKnowledgeDoc({
      title: 'Return Policy',
      content: 'Returns are accepted within 30 days of delivery.',
      allowedRoles: ['customer', 'staff', 'admin'],
    });

    const conv = createTestConversation({ question: 'When can I return an item?' });

    let releaseModel!: () => void;
    const modelGate = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });

    completion.mockImplementationOnce(async () => {
      await modelGate;
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: 'Summary [1].',
                drafts: [
                  { tone: 'empathetic', text: 'Empathetic [1].' },
                  { tone: 'direct', text: 'Direct [1].' },
                  { tone: 'technical', text: 'Technical [1].' },
                ],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 80, completion_tokens: 40, total_tokens: 120 },
      };
    });

    const firstPromise = generateSupportAgentCopilot({
      tenantId: tenant.id,
      actorId,
      input: { requestId: 'req_concurrent_01', conversationId: conv.id },
    });

    // Wait a tick so firstPromise has claimed the job and is awaiting the model
    await new Promise((r) => setTimeout(r, 20));

    await expect(
      generateSupportAgentCopilot({
        tenantId: tenant.id,
        actorId,
        input: { requestId: 'req_concurrent_01', conversationId: conv.id },
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'copilot_in_progress',
    });

    releaseModel();
    const firstResult = await firstPromise;
    expect(firstResult.status).toBe('completed');
    expect(completion).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Test 20: Abort / timeout -> 504 copilot_timeout
  // -------------------------------------------------------------------------
  it('fails with 504 copilot_timeout when signal aborts during model call', async () => {
    await publishKnowledgeDoc({
      title: 'Return Policy',
      content: 'Returns are accepted within 30 days of delivery.',
      allowedRoles: ['customer', 'staff', 'admin'],
    });

    const conv = createTestConversation({ question: 'When can I return an item?' });
    const ac = new AbortController();

    completion.mockImplementationOnce(async (_cred, _msgs, _model, opts) => {
      return new Promise((_resolve, reject) => {
        const sig = opts?.signal as AbortSignal | undefined;
        if (sig?.aborted) {
          reject(new Error('Aborted'));
          return;
        }
        sig?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
      });
    });

    setTimeout(() => ac.abort(), 20);

    await expect(
      generateSupportAgentCopilot({
        tenantId: tenant.id,
        actorId,
        input: { requestId: 'req_timeout_01', conversationId: conv.id },
        signal: ac.signal,
      }),
    ).rejects.toMatchObject({
      status: 504,
      code: 'copilot_timeout',
    });
  });

  // -------------------------------------------------------------------------
  // Test 21: Corrupt evidence policy fails closed with 503
  // -------------------------------------------------------------------------
  it('fails closed with 503 when evidence policy storage is corrupted', async () => {
    const conv = createTestConversation({ question: 'When can I return an item?' });

    updateSupportEvidencePolicy(tenant.id, { mode: 'required' }, 1);
    db.prepare(
      `UPDATE x_support_evidence_policies
          SET policy_json = 'CORRUPT_JSON'
        WHERE tenant_id = ?`,
    ).run(tenant.id);

    await expect(
      generateSupportAgentCopilot({
        tenantId: tenant.id,
        actorId,
        input: { requestId: 'req_corrupt_policy_01', conversationId: conv.id },
      }),
    ).rejects.toMatchObject({
      status: 503,
    });
    expect(completion).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 22: Deferred evidence policy change invalidates GET/replay with 409
  // -------------------------------------------------------------------------
  it('rejects GET/replay with 409 copilot_context_changed when evidence policy changes after generation', async () => {
    await publishKnowledgeDoc({
      title: 'Return Policy',
      content: 'Returns are accepted within 30 days of delivery.',
      allowedRoles: ['customer', 'staff', 'admin'],
    });

    const conv = createTestConversation({ question: 'When can I return an item?' });

    completion.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              summary: 'Summary [1].',
              drafts: [
                { tone: 'empathetic', text: 'Empathetic [1].' },
                { tone: 'direct', text: 'Direct [1].' },
                { tone: 'technical', text: 'Technical [1].' },
              ],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 90, completion_tokens: 45, total_tokens: 135 },
    });

    const gen = await generateSupportAgentCopilot({
      tenantId: tenant.id,
      actorId,
      input: { requestId: 'req_policy_change_01', conversationId: conv.id },
    });
    expect(gen.status).toBe('completed');

    // Mutate evidence policy after generation
    updateSupportEvidencePolicy(tenant.id, { topK: 5 }, 1);

    await expect(
      generateSupportAgentCopilot({
        tenantId: tenant.id,
        actorId,
        input: { requestId: 'req_policy_change_01', conversationId: conv.id },
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'copilot_context_changed',
    });

    expect(() =>
      readSupportAgentCopilotJob({
        tenantId: tenant.id,
        actorId,
        jobId: gen.jobId,
      }),
    ).toThrowError(/changed/i);
  });

  // -------------------------------------------------------------------------
  // Test 23: Assembled prompt exceeding 16000 chars -> 400 invalid_input
  // -------------------------------------------------------------------------
  it('rejects assembled prompt exceeding 16000 chars with 400 invalid_input without calling model', async () => {
    await publishKnowledgeDoc({
      title: 'Return Policy',
      content: 'Returns are accepted within 30 days of delivery.',
      allowedRoles: ['customer', 'staff', 'admin'],
    });

    const conv = createTestConversation({
      question: 'When can I return an item? ' + 'x'.repeat(16500),
    });

    await expect(
      generateSupportAgentCopilot({
        tenantId: tenant.id,
        actorId,
        input: { requestId: 'req_prompt_bound_01', conversationId: conv.id },
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: 'invalid_input',
    });
    expect(completion).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 24: Works when chat evidence mode is off (mode-agnostic)
  // -------------------------------------------------------------------------
  it('retrieves actual evidence packs even when chat evidence mode is off', async () => {
    updateSupportEvidencePolicy(tenant.id, { mode: 'off' }, 1);

    await publishKnowledgeDoc({
      title: 'Return Policy',
      content: 'Returns are accepted within 30 days of delivery.',
      allowedRoles: ['customer', 'staff', 'admin'],
    });

    const conv = createTestConversation({ question: 'When can I return an item?' });

    completion.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              summary: 'Summary [1].',
              drafts: [
                { tone: 'empathetic', text: 'Empathetic [1].' },
                { tone: 'direct', text: 'Direct [1].' },
                { tone: 'technical', text: 'Technical [1].' },
              ],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 90, completion_tokens: 45, total_tokens: 135 },
    });

    const result = await generateSupportAgentCopilot({
      tenantId: tenant.id,
      actorId,
      input: { requestId: 'req_mode_off_01', conversationId: conv.id },
    });

    expect(result.status).toBe('completed');
    expect(result.drafts).toHaveLength(3);
  });

  it('masks generated PII in initial result, replay and job GET', async () => {
    const { updateSupportMaskingPolicy } = await import('../../custom/x-gateway/support-knowledge.js');
    updateSupportMaskingPolicy(String(tenant.id), { enabled: true, builtinDetectors: ['email'], unmaskedRoles: [] });
    await publishKnowledgeDoc({ title: 'Return Policy', content: 'Customers can return undamaged items within 30 days for a refund.', allowedRoles: ['customer'] });
    const conv = createTestConversation({ question: 'How do I return an item?' });
    completion.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ summary: 'Contact private.person@example.com [1]', drafts: ['empathetic','direct','technical'].map(tone => ({ tone, text: 'Contact private.person@example.com [1]' })) }) } }], usage: {prompt_tokens:100, completion_tokens:80,total_tokens:180} });
    const params = { tenantId: tenant.id, actorId, input: {requestId:'mask_output', conversationId:conv.id} };
    const result = await generateSupportAgentCopilot(params);
    expect(result.status).toBe('completed');
    const replay = await generateSupportAgentCopilot(params);
    const fetched = readSupportAgentCopilotJob({tenantId:tenant.id,actorId,jobId:result.jobId});
    for (const item of [result,replay,fetched]) {
      expect(JSON.stringify(item)).not.toContain('private.person@example.com');
      expect(item.summary).toContain('[1]');
      expect(item.drafts).toHaveLength(3);
    }
    expect(completion).toHaveBeenCalledTimes(1);
  });

  it('cancels promptly and fences late output when a provider ignores AbortSignal', async () => {
    await publishKnowledgeDoc({title:'Return Policy',content:'Customers can return items within 30 days.',allowedRoles:['customer']});
    const conv = createTestConversation({question:'How do I return an item?'});
    let release!: (value: unknown) => void;
    completion.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const controller = new AbortController();
    const pending = generateSupportAgentCopilot({tenantId:tenant.id,actorId,input:{requestId:'ignore_abort',conversationId:conv.id},signal:controller.signal});
    const rejected = expect(pending).rejects.toMatchObject({status:504,code:'copilot_timeout'});
    await vi.waitFor(() => expect(completion).toHaveBeenCalledTimes(1));
    controller.abort();
    await rejected;
    const before = db.prepare('SELECT state,spent_tokens FROM x_support_desk_copilot_jobs WHERE request_id = ?').get('ignore_abort');
    expect(before).toMatchObject({state:'failed'});
    release({choices:[{message:{content:'late rejected output'}}],usage:{total_tokens:1}});
    await new Promise(resolve => setTimeout(resolve,10));
    expect(db.prepare('SELECT state,spent_tokens FROM x_support_desk_copilot_jobs WHERE request_id = ?').get('ignore_abort')).toEqual(before);
  });

  it('reports the same conservative token cost that is settled when usage is unavailable', async () => {
    await publishKnowledgeDoc({title:'Return Policy',content:'Customers can return items within 30 days.',allowedRoles:['customer']});
    const conv=createTestConversation({question:'How do I return an item?'});
    completion.mockResolvedValueOnce({choices:[{message:{content:JSON.stringify({summary:'Returns take 30 days [1]',drafts:['empathetic','direct','technical'].map(tone=>({tone,text:'You can return within 30 days [1]'}))})}}]});
    const result=await generateSupportAgentCopilot({tenantId:tenant.id,actorId,input:{requestId:'estimated_usage',conversationId:conv.id}});
    expect(result.status).toBe('completed');
    expect(result.usage.accounting).toBe('estimated');
    const row=db.prepare('SELECT spent_tokens FROM x_support_desk_copilot_jobs WHERE id = ?').get(result.jobId) as {spent_tokens:number};
    expect(result.usage.totalTokens).toBe(row.spent_tokens);
    expect(result.usage.totalTokens).toBe(result.usage.promptTokens+result.usage.completionTokens);
  });
});
