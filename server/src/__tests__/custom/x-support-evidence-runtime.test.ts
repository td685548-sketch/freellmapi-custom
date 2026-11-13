import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import { setEnabled } from '../../custom/x-gateway/config.js';
import {
  createSupportTenant,
  type SupportTenant,
  type SupportUserContext,
} from '../../custom/x-gateway/support-store.js';
import { updateSupportMaskingPolicy } from '../../custom/x-gateway/support-knowledge.js';
import {
  executeSupportTurn,
  SupportRuntimeError,
} from '../../custom/x-gateway/support-runtime.js';
import {
  getSupportConversationForUser,
  listSupportConversations,
  createOrAppendSupportConversation,
} from '../../custom/x-gateway/support-workflows.js';
import { getSupportUserQuotaStatus } from '../../custom/x-gateway/support-guardrails.js';
import {
  createSupportEvidenceSource,
  importSupportEvidenceRevision,
  publishSupportEvidenceRevision,
  updateSupportEvidencePolicy,
  updateSupportEvidenceSource,
  getSupportMessageEvidence,
} from '../../custom/x-gateway/support-evidence-store.js';
import { getSupportEvidenceSnapshotId } from '../../custom/x-gateway/support-evidence-retrieval.js';

describe('Support Evidence Runtime Integration (Spec 018)', () => {
  let tenant: SupportTenant;
  let customerCtx: SupportUserContext;
  let staffCtx: SupportUserContext;
  let guestUnsignedCtx: SupportUserContext;

  beforeEach(() => {
    vi.stubEnv('ENCRYPTION_KEY', '0'.repeat(64));
    initDb(':memory:');
    setEnabled(true);
    tenant = createSupportTenant({
      name: 'Evidence Runtime Tenant',
      defaultModel: 'test-model',
      allowGuest: true,
    }).tenant;

    customerCtx = {
      tenantId: tenant.id,
      userId: 'cust-1',
      role: 'customer',
      name: 'Customer One',
      permissions: [],
      verified: true,
    };
    staffCtx = {
      tenantId: tenant.id,
      userId: 'staff-1',
      role: 'staff',
      name: 'Staff One',
      permissions: [],
      verified: true,
    };
    guestUnsignedCtx = {
      tenantId: tenant.id,
      userId: 'guest',
      role: 'guest',
      name: 'Guest',
      permissions: [],
      verified: false,
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  async function publishTextSource(options: {
    name: string;
    title: string;
    content: string;
    allowedRoles: Array<'guest' | 'customer' | 'staff' | 'admin'>;
  }) {
    const created = createSupportEvidenceSource(tenant.id, {
      name: options.name,
      kind: 'text',
      allowedRoles: options.allowedRoles,
    });
    const imported = await importSupportEvidenceRevision({
      tenantId: tenant.id,
      sourceId: created.id,
      expectedVersion: created.version,
      title: options.title,
      format: 'text',
      content: options.content,
    });
    const published = publishSupportEvidenceRevision(
      tenant.id,
      created.id,
      imported.revision.id,
      imported.source.version,
    );
    return { source: published, revision: imported.revision };
  }

  function enableRequiredMode() {
    return updateSupportEvidencePolicy(
      tenant.id,
      { mode: 'required', includeLegacyDocs: false, topK: 3, minCoverage: 0.25 },
      1,
    );
  }

  it('preserves 017 off-mode behavior without evidence metadata', async () => {
    const generate = vi.fn(async (ctx) => {
      expect(ctx.disableTools).toBe(false);
      return {
        reply: 'Standard 017 reply',
        userContext: customerCtx,
        allowedTools: [],
        toolTrace: [],
        modelUsed: 'test-model',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };
    });

    const result = await executeSupportTurn({
      tenant,
      userContext: customerCtx,
      input: {
        tenantKey: tenant.publicKey,
        requestId: 'off-mode-1',
        messages: [{ role: 'user', content: 'Hello' }],
      },
      generate,
    });

    expect(result.runtime.replySource).toBe('model');
    expect(result.runtime.evidence).toBeUndefined();
    expect(result.modelUsed).toBe('test-model');
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('denies unsupported caller roles in required mode with 403 unsupported_evidence_role', async () => {
    enableRequiredMode();
    const customRoleCtx: SupportUserContext = {
      ...customerCtx,
      role: 'vip_partner',
    };
    const generate = vi.fn();

    await expect(
      executeSupportTurn({
        tenant,
        userContext: customRoleCtx,
        input: {
          tenantKey: tenant.publicKey,
          requestId: 'bad-role-1',
          messages: [{ role: 'user', content: 'Refund policy?' }],
        },
        generate,
      }),
    ).rejects.toMatchObject({ status: 403, code: 'unsupported_evidence_role' });
    expect(generate).not.toHaveBeenCalled();
  });

  it('returns zero-model knowledge_abstention on no-match without calling provider and charges 1 request / 0 tokens', async () => {
    enableRequiredMode();
    const generate = vi.fn();

    const result = await executeSupportTurn({
      tenant,
      userContext: customerCtx,
      input: {
        tenantKey: tenant.publicKey,
        requestId: 'no-match-1',
        messages: [{ role: 'user', content: 'Completely unknown topic xyz123' }],
      },
      generate,
    });

    expect(generate).not.toHaveBeenCalled();
    expect(result.modelUsed).toBeNull();
    expect(result.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
    expect(result.runtime.replySource).toBe('knowledge_abstention');
    expect(result.runtime.evidence).toMatchObject({
      requestId: 'no-match-1',
      status: 'abstained',
      reason: 'no_matches',
      citations: [],
    });
    expect(result.runtime.conversationId).toBeTruthy();

    const quota = getSupportUserQuotaStatus(String(tenant.id), {
      userId: customerCtx.userId,
      userRole: customerCtx.role,
    });
    expect(quota.requestsUsed).toBe(1);
    expect(quota.tokensUsed).toBe(0);

    const conv = getSupportConversationForUser(String(tenant.id), result.runtime.conversationId!, {
      userId: customerCtx.userId,
      role: customerCtx.role,
    });
    expect(conv.messages).toHaveLength(1);
    expect(conv.messages[0].senderType).toBe('customer');
    expect(conv.messages[0].responseNotice).toEqual({
      requestId: 'no-match-1',
      reason: 'no_matches',
    });
  });

  it('disables tools/CRM in required mode, validates citations, canonicalizes markers, and stores durable provenance', async () => {
    const { source } = await publishTextSource({
      name: 'Refund Guide',
      title: 'Refund Policy',
      content: 'Refunds are processed within 7 business days for eligible orders.',
      allowedRoles: ['customer'],
    });
    enableRequiredMode();

    const generate = vi.fn(async (ctx) => {
      expect(ctx.disableTools).toBe(true);
      await expect(
        ctx.invokeWebhook({ id: 1, name: 'refund' } as never, {}),
      ).rejects.toMatchObject({ status: 403, code: 'tools_disabled' });

      const match = /\[cite:(cit_[A-Za-z0-9_-]+)\]/.exec(ctx.trustedContext);
      expect(match).not.toBeNull();
      return {
        reply: `Refunds take 7 business days [cite:${match![1]}].`,
        userContext: customerCtx,
        allowedTools: [],
        toolTrace: [],
        modelUsed: 'test-model',
        usage: { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 },
      };
    });

    const result = await executeSupportTurn({
      tenant,
      userContext: customerCtx,
      input: {
        tenantKey: tenant.publicKey,
        requestId: 'cited-1',
        messages: [{ role: 'user', content: 'Refunds business days?' }],
      },
      generate,
    });

    expect(generate).toHaveBeenCalledTimes(1);

    expect(result.reply).toBe('Refunds take 7 business days [1].');
    expect(result.modelUsed).toBe('test-model');
    expect(result.runtime.replySource).toBe('model');
    expect(result.runtime.evidence?.status).toBe('cited');
    expect(result.runtime.evidence?.citations).toHaveLength(1);
    expect(result.runtime.evidence?.citations[0].sourceId).toBe(source.id);
    expect(result.runtime.evidence?.citations[0].ordinal).toBe(1);

    const conv = getSupportConversationForUser(String(tenant.id), result.runtime.conversationId!, {
      userId: customerCtx.userId,
      role: customerCtx.role,
    });
    expect(conv.messages).toHaveLength(2);
    expect(conv.messages[1].senderType).toBe('ai_assistant');
    expect(conv.messages[1].evidence?.citations).toHaveLength(1);

    // Provenance survives 24h runtime-turn TTL cleanup
    getDb().prepare('DELETE FROM x_support_runtime_turns').run();
    const durable = getSupportMessageEvidence(tenant.id, conv.id, conv.messages[1].id);
    expect(durable).not.toBeNull();
    const convAfterTtl = getSupportConversationForUser(String(tenant.id), conv.id, {
      userId: customerCtx.userId,
      role: customerCtx.role,
    });
    expect(convAfterTtl.messages[1].evidence?.status).toBe('cited');
  });

  it('withholds forged citations and tool markup completely from all returned/persisted aliases while charging actual usage', async () => {
    await publishTextSource({
      name: 'Shipping Guide',
      title: 'Shipping Policy',
      content: 'Standard shipping takes 3 to 5 business days.',
      allowedRoles: ['customer'],
    });
    enableRequiredMode();

    const secretLeak = 'FORGED_MODEL_TEXT_SHOULD_NEVER_LEAK';
    const generate = vi.fn(async () => ({
      reply: `${secretLeak} [cite:cit_forged_999] <support_tool_call>{"name":"evil"}</support_tool_call>`,
      userContext: customerCtx,
      allowedTools: [{ id: 1, kind: 'webhook' as const, functionName: 'evil', displayName: 'Evil', description: '', parameters: {} }],
      toolTrace: [],
      modelUsed: 'test-model',
      usage: { prompt_tokens: 25, completion_tokens: 15, total_tokens: 40 },
    }));

    const result = await executeSupportTurn({
      tenant,
      userContext: customerCtx,
      input: {
        tenantKey: tenant.publicKey,
        requestId: 'forged-1',
        messages: [{ role: 'user', content: 'How long is shipping?' }],
      },
      generate,
    });

    expect(generate).toHaveBeenCalledTimes(1); // No repair call
    expect(result.runtime.replySource).toBe('knowledge_abstention');
    expect(result.runtime.evidence?.status).toBe('abstained');
    expect(result.runtime.evidence?.reason).toBe('invalid_citations');
    expect(result.reply).not.toContain(secretLeak);
    expect(JSON.stringify(result)).not.toContain(secretLeak);

    const quota = getSupportUserQuotaStatus(String(tenant.id), {
      userId: customerCtx.userId,
      userRole: customerCtx.role,
    });
    expect(quota.requestsUsed).toBe(1);
    expect(quota.tokensUsed).toBe(40);

    const conv = getSupportConversationForUser(String(tenant.id), result.runtime.conversationId!, {
      userId: customerCtx.userId,
      role: customerCtx.role,
    });
    expect(conv.messages).toHaveLength(1);
    expect(conv.messages[0].responseNotice).toEqual({
      requestId: 'forged-1',
      reason: 'invalid_citations',
    });
  });

  it('produces sources_changed abstention when source ACL changes during generation and charges incurred cost', async () => {
    const { source } = await publishTextSource({
      name: 'Warranty Guide',
      title: 'Warranty Policy',
      content: 'Warranty covers 12 months from purchase date.',
      allowedRoles: ['customer'],
    });
    const policy = enableRequiredMode();

    const generate = vi.fn(async (ctx) => {
      const match = /\[cite:(cit_[A-Za-z0-9_-]+)\]/.exec(ctx.trustedContext);
      // Revoke customer access mid-generation
      updateSupportEvidenceSource(tenant.id, source.id, { allowedRoles: ['admin'] }, source.version);
      return {
        reply: `Warranty is 12 months [cite:${match![1]}].`,
        userContext: customerCtx,
        allowedTools: [],
        toolTrace: [],
        modelUsed: 'test-model',
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      };
    });

    const result = await executeSupportTurn({
      tenant,
      userContext: customerCtx,
      input: {
        tenantKey: tenant.publicKey,
        requestId: 'inflight-change-1',
        messages: [{ role: 'user', content: 'What is the warranty?' }],
      },
      generate,
    });

    expect(result.runtime.replySource).toBe('knowledge_abstention');
    expect(result.runtime.evidence?.status).toBe('abstained');
    expect(result.runtime.evidence?.reason).toBe('sources_changed');
    expect(result.runtime.evidence?.snapshotId).toBe(
      getSupportEvidenceSnapshotId({ tenantId: tenant.id, role: 'customer', policy }),
    );
    expect(result.reply).not.toContain('Warranty is 12 months');
  });

  it('replays 20 times without extra model/charge, then returns 409 knowledge_context_changed after source change', async () => {
    const { source } = await publishTextSource({
      name: 'SLA Guide',
      title: 'SLA Policy',
      content: 'Support SLA response time is 4 hours.',
      allowedRoles: ['customer'],
    });
    enableRequiredMode();

    const generate = vi.fn(async (ctx) => {
      const match = /\[cite:(cit_[A-Za-z0-9_-]+)\]/.exec(ctx.trustedContext);
      return {
        reply: `SLA response time is 4 hours [cite:${match![1]}].`,
        userContext: customerCtx,
        allowedTools: [],
        toolTrace: [],
        modelUsed: 'test-model',
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      };
    });

    const input = {
      tenantKey: tenant.publicKey,
      requestId: 'replay-20-1',
      messages: [{ role: 'user' as const, content: 'What is the SLA response time?' }],
    };

    const first = await executeSupportTurn({ tenant, userContext: customerCtx, input, generate });
    expect(first.runtime.replayed).toBe(false);

    const replays = await Promise.all(
      Array.from({ length: 20 }, () =>
        executeSupportTurn({ tenant, userContext: customerCtx, input, generate }),
      ),
    );
    for (const r of replays) {
      expect(r.runtime.replayed).toBe(true);
      expect(r.reply).toBe(first.reply);
    }
    expect(generate).toHaveBeenCalledTimes(1);
    const quota = getSupportUserQuotaStatus(String(tenant.id), {
      userId: customerCtx.userId,
      userRole: customerCtx.role,
    });
    expect(quota.requestsUsed).toBe(1);
    expect(quota.tokensUsed).toBe(30);

    // Archive source -> replay must fail with 409 knowledge_context_changed without calling model
    updateSupportEvidenceSource(tenant.id, source.id, { status: 'archived' }, source.version);
    await expect(
      executeSupportTurn({ tenant, userContext: customerCtx, input, generate }),
    ).rejects.toMatchObject({ status: 409, code: 'knowledge_context_changed' });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('redacts invalidated 018 history on GET without mutating stored history and omits unprovenanced legacy AI from required context', async () => {
    const { source } = await publishTextSource({
      name: 'Billing Guide',
      title: 'Billing Cycle',
      content: 'Invoices are issued on the 1st of every month.',
      allowedRoles: ['customer', 'staff'],
    });
    enableRequiredMode();

    const generate = vi.fn(async (ctx) => {
      const match = /\[cite:(cit_[A-Za-z0-9_-]+)\]/.exec(ctx.trustedContext);
      return {
        reply: `Invoices are issued on the 1st [cite:${match![1]}].`,
        userContext: customerCtx,
        allowedTools: [],
        toolTrace: [],
        modelUsed: 'test-model',
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      };
    });

    const first = await executeSupportTurn({
      tenant,
      userContext: customerCtx,
      input: {
        tenantKey: tenant.publicKey,
        requestId: 'history-1',
        messages: [{ role: 'user', content: 'When are invoices issued?' }],
      },
      generate,
    });

    // Also add an unprovenanced legacy AI message to test provider context omission
    createOrAppendSupportConversation(String(tenant.id), {
      conversationId: first.runtime.conversationId!,
      userId: customerCtx.userId,
      userRole: customerCtx.role,
      message: {
        senderType: 'ai_assistant',
        senderId: 'ai',
        content: 'UNPROVENANCED_LEGACY_AI_CLAIM',
      },
    });

    // Restrict source to staff only -> customer snapshot is now invalid for BOTH customer and staff reads
    updateSupportEvidenceSource(tenant.id, source.id, { allowedRoles: ['staff'] }, source.version);

    const customerConv = getSupportConversationForUser(
      String(tenant.id),
      first.runtime.conversationId!,
      { userId: customerCtx.userId, role: 'customer' },
    );
    expect(customerConv.messages[1].evidence?.status).toBe('redacted');
    expect(customerConv.messages[1].evidence?.reason).toBe('source_revoked');
    expect(customerConv.messages[1].evidence?.citations).toEqual([]);
    expect(customerConv.messages[1].content).not.toContain('Invoices are issued on the 1st');

    const staffConv = getSupportConversationForUser(
      String(tenant.id),
      first.runtime.conversationId!,
      { userId: staffCtx.userId, role: 'staff' },
    );
    expect(staffConv.messages[1].evidence?.status).toBe('redacted');
    expect(staffConv.messages[1].evidence?.citations).toEqual([]);

    // Prove GET did not mutate raw stored history by inspecting the persisted settings row directly
    const rawRow = getDb()
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get('x_gateway_support_conversations_v1') as { value: string };
    const rawStore = JSON.parse(rawRow.value) as Record<
      string,
      Array<{ id: string; messages: Array<{ content: string; evidence?: { status: string } }> }>
    >;
    const rawConv = rawStore[String(tenant.id)].find((c) => c.id === first.runtime.conversationId);
    expect(rawConv?.messages[1].evidence?.status).toBe('cited');
    expect(rawConv?.messages[1].content).toContain('Invoices are issued on the 1st');

    // Console list revalidates using original customer's role (customer), so it redacts for customer
    const listed = listSupportConversations(String(tenant.id), { userId: customerCtx.userId });
    expect(listed[0].messages[1].evidence?.status).toBe('redacted');

    // Publish an authorized matching source so the next turn actually invokes the provider
    await publishTextSource({
      name: 'Account Update Guide',
      title: 'Account Update',
      content: 'Account updates take effect immediately.',
      allowedRoles: ['customer'],
    });

    const historyCheckGenerate = vi.fn(async (ctx) => {
      const serialized = JSON.stringify(ctx.messages);
      expect(serialized).not.toContain('UNPROVENANCED_LEGACY_AI_CLAIM');
      expect(serialized).not.toContain('Invoices are issued on the 1st');
      const match = /\[cite:(cit_[A-Za-z0-9_-]+)\]/.exec(ctx.trustedContext);
      expect(match).not.toBeNull();
      return {
        reply: `Account updates take effect immediately [cite:${match![1]}].`,
        userContext: customerCtx,
        allowedTools: [],
        toolTrace: [],
        modelUsed: 'test-model',
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      };
    });

    const nextResult = await executeSupportTurn({
      tenant,
      userContext: customerCtx,
      input: {
        tenantKey: tenant.publicKey,
        conversationId: first.runtime.conversationId!,
        requestId: 'history-2',
        messages: [{ role: 'user', content: 'Account update?' }],
      },
      generate: historyCheckGenerate,
    });
    expect(historyCheckGenerate).toHaveBeenCalledTimes(1);
    expect(nextResult.runtime.replySource).toBe('model');
    expect(nextResult.runtime.evidence?.status).toBe('cited');
  });

  it('keeps provider failures as 503 and unsigned guests stateless in required mode', async () => {
    await publishTextSource({
      name: 'Guest FAQ',
      title: 'Pricing',
      content: 'Free tier includes 100 requests per day.',
      allowedRoles: ['guest'],
    });
    enableRequiredMode();

    await expect(
      executeSupportTurn({
        tenant,
        userContext: guestUnsignedCtx,
        input: {
          tenantKey: tenant.publicKey,
          requestId: 'guest-503',
          messages: [{ role: 'user', content: 'What is included in free tier?' }],
        },
        generate: async () => {
          throw new SupportRuntimeError(503, 'model_unavailable', 'Provider down');
        },
      }),
    ).rejects.toMatchObject({ status: 503, code: 'model_unavailable' });

    const guestAbstain = await executeSupportTurn({
      tenant,
      userContext: guestUnsignedCtx,
      input: {
        tenantKey: tenant.publicKey,
        requestId: 'guest-abstain',
        messages: [{ role: 'user', content: 'Unmatched guest question' }],
      },
      generate: vi.fn(),
    });
    expect(guestAbstain.runtime.conversationId).toBeUndefined();
    expect(guestAbstain.modelUsed).toBeNull();
    expect(listSupportConversations(String(tenant.id))).toHaveLength(0);
  });

  it('redacts history when masking policy changes', async () => {
    await publishTextSource({
      name: 'Masking Doc',
      title: 'Contact Info',
      content: 'Reach support at help@company.example.',
      allowedRoles: ['customer'],
    });
    enableRequiredMode();

    const first = await executeSupportTurn({
      tenant,
      userContext: customerCtx,
      input: {
        tenantKey: tenant.publicKey,
        requestId: 'mask-1',
        messages: [{ role: 'user', content: 'How to reach support?' }],
      },
      generate: async (ctx) => {
        const match = /\[cite:(cit_[A-Za-z0-9_-]+)\]/.exec(ctx.trustedContext);
        return {
          reply: `Reach support at help@company.example [cite:${match![1]}].`,
          userContext: customerCtx,
          allowedTools: [],
          toolTrace: [],
          modelUsed: 'test-model',
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        };
      },
    });

    // Update masking policy -> snapshot/masking changes -> stored answer redacted on GET
    updateSupportMaskingPolicy(String(tenant.id), {
      enabled: true,
      customRules: [
        {
          id: 'mask-email',
          name: 'Email Mask',
          pattern: 'help@company\\.example',
          replacement: '[REDACTED]',
          enabled: true,
        },
      ],
    });
    const conv = getSupportConversationForUser(String(tenant.id), first.runtime.conversationId!, {
      userId: customerCtx.userId,
      role: 'customer',
    });
    expect(conv.messages[1].evidence?.status).toBe('redacted');
  });

  it('rejects 018 cached replay with 409 even after policy switches to off, while preserving pre-018 off-mode replay', async () => {
    // 1. Pre-018 off-mode turn caches without 018 evidence
    const offGen = vi.fn(async () => ({
      reply: 'Pre-018 off-mode reply',
      userContext: customerCtx,
      allowedTools: [],
      toolTrace: [],
      modelUsed: 'test-model',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }));
    const offInput = {
      tenantKey: tenant.publicKey,
      requestId: 'pre018-off-1',
      messages: [{ role: 'user' as const, content: 'Hello off mode' }],
    };
    await executeSupportTurn({ tenant, userContext: customerCtx, input: offInput, generate: offGen });
    const offReplay = await executeSupportTurn({ tenant, userContext: customerCtx, input: offInput, generate: offGen });
    expect(offReplay.runtime.replayed).toBe(true);
    expect(offGen).toHaveBeenCalledTimes(1);

    // 2. 018 required-mode turn caches with 018 evidence
    await publishTextSource({
      name: 'Confidential Guide',
      title: 'Secret Policy',
      content: 'CONFIDENTIAL_OLD_ANSWER for customer tier.',
      allowedRoles: ['customer'],
    });
    const reqPolicy = enableRequiredMode();
    const reqGen = vi.fn(async (ctx) => {
      const match = /\[cite:(cit_[A-Za-z0-9_-]+)\]/.exec(ctx.trustedContext);
      return {
        reply: `CONFIDENTIAL_OLD_ANSWER [cite:${match![1]}].`,
        userContext: customerCtx,
        allowedTools: [],
        toolTrace: [],
        modelUsed: 'test-model',
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      };
    });
    const reqInput = {
      tenantKey: tenant.publicKey,
      requestId: 'req018-replay-off-1',
      messages: [{ role: 'user' as const, content: 'What is confidential policy?' }],
    };
    await executeSupportTurn({ tenant, userContext: customerCtx, input: reqInput, generate: reqGen });

    // Switch policy back to off -> replaying 018 cached response MUST fail with 409
    updateSupportEvidencePolicy(tenant.id, { mode: 'off' }, reqPolicy.version);
    await expect(
      executeSupportTurn({ tenant, userContext: customerCtx, input: reqInput, generate: reqGen }),
    ).rejects.toMatchObject({ status: 409, code: 'knowledge_context_changed' });
    expect(reqGen).toHaveBeenCalledTimes(1);
  });

  it('rejects valid citation when policy changes while awaiting deferred provider completion (F04)', async () => {
    await publishTextSource({
      name: 'Deferred Policy Guide',
      title: 'Policy Change',
      content: 'Deferred policy test content for customer.',
      allowedRoles: ['customer'],
    });
    const policyV2 = enableRequiredMode();
    const secretRejected = 'REJECTED_DEFERRED_PROVIDER_TEXT';

    const result = await executeSupportTurn({
      tenant,
      userContext: customerCtx,
      input: {
        tenantKey: tenant.publicKey,
        requestId: 'deferred-policy-1',
        messages: [{ role: 'user', content: 'Deferred policy test?' }],
      },
      generate: async (ctx) => {
        const match = /\[cite:(cit_[A-Za-z0-9_-]+)\]/.exec(ctx.trustedContext);
        // Mutate policy while provider is in flight
        updateSupportEvidencePolicy(tenant.id, { minCoverage: 0.9 }, policyV2.version);
        return {
          reply: `${secretRejected} [cite:${match![1]}].`,
          userContext: customerCtx,
          allowedTools: [],
          toolTrace: [],
          modelUsed: 'test-model',
          usage: { prompt_tokens: 22, completion_tokens: 8, total_tokens: 30 },
        };
      },
    });

    expect(result.runtime.replySource).toBe('knowledge_abstention');
    expect(result.runtime.evidence?.status).toBe('abstained');
    expect(result.runtime.evidence?.reason).toBe('sources_changed');
    expect(result.reply).not.toContain(secretRejected);
    expect(JSON.stringify(result)).not.toContain(secretRejected);

    const conv = getSupportConversationForUser(String(tenant.id), result.runtime.conversationId!, {
      userId: customerCtx.userId,
      role: customerCtx.role,
    });
    expect(conv.messages).toHaveLength(1);
    expect(conv.messages[0].responseNotice?.reason).toBe('sources_changed');
  });
});
