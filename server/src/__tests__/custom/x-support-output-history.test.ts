import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import { setEnabled } from '../../custom/x-gateway/config.js';
import {
  createSupportTenant,
  type SupportTenant,
  type SupportUserContext,
} from '../../custom/x-gateway/support-store.js';
import { executeSupportTurn } from '../../custom/x-gateway/support-runtime.js';
import {
  addHumanAgentReply,
  createOrAppendSupportConversation,
  getSupportConversationForUser,
  listSupportConversations,
} from '../../custom/x-gateway/support-workflows.js';
import {
  createSupportEvidenceSource,
  importSupportEvidenceRevision,
  publishSupportEvidenceRevision,
  updateSupportEvidencePolicy,
  updateSupportEvidenceSource,
} from '../../custom/x-gateway/support-evidence-store.js';
import { SAFE_EVIDENCE_NOTICES } from '../../custom/x-gateway/support-evidence-runtime.js';
import { updateSupportMaskingPolicy } from '../../custom/x-gateway/support-knowledge.js';
import {
  listSupportOutputEvents,
  saveSupportOutputPolicy,
} from '../../custom/x-gateway/support-output-store.js';
import {
  SUPPORT_OUTPUT_BLOCK_NOTICE,
  SUPPORT_OUTPUT_HISTORY_NOTICE,
} from '@freellmapi/shared/support-output.js';

describe('Support Output History & Canonical Reads (Spec 020)', () => {
  let tenant: SupportTenant;
  let customerCtx: SupportUserContext;

  beforeEach(() => {
    vi.stubEnv('ENCRYPTION_KEY', '0'.repeat(64));
    initDb(':memory:');
    setEnabled(true);
    tenant = createSupportTenant({
      name: 'Output History Tenant',
      defaultModel: 'test-model',
      allowGuest: true,
    }).tenant;
    customerCtx = {
      tenantId: tenant.id,
      userId: 'cust-hist-1',
      role: 'customer',
      name: 'Customer History',
      permissions: [],
      verified: true,
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('applies stricter current policy read-only to legacy AI history, leaves human/customer unchanged, and does not upgrade staff role', async () => {
    const sentinel = 'STRICT_HISTORY_SENTINEL';

    // Create conversation with customer, AI, and human_agent messages while output policy is off
    const conv = createOrAppendSupportConversation(String(tenant.id), {
      userId: customerCtx.userId,
      userRole: customerCtx.role,
      message: {
        senderType: 'customer',
        senderId: customerCtx.userId,
        senderRole: customerCtx.role,
        content: `Customer asked about ${sentinel}`,
      },
    });
    createOrAppendSupportConversation(String(tenant.id), {
      conversationId: conv.id,
      userId: customerCtx.userId,
      userRole: customerCtx.role,
      message: {
        senderType: 'ai_assistant',
        senderId: 'ai',
        senderName: 'AI Support',
        senderRole: 'assistant',
        content: `AI legacy reply with ${sentinel}`,
      },
    });
    addHumanAgentReply(String(tenant.id), conv.id, {
      agentName: 'Agent Alice',
      content: `Human agent reply mentioning ${sentinel}`,
    });

    const rawBefore = getDb()
      .prepare("SELECT value FROM settings WHERE key = 'x_gateway_support_conversations_v1'")
      .get() as { value: string };

    // Enable strict output policy
    saveSupportOutputPolicy({
      tenantId: tenant.id,
      expectedVersion: 0,
      policy: {
        mode: 'enforce',
        blockedTerms: [{ id: 'hist-rule', text: sentinel }],
        maxOutputChars: 16000,
        redactCredentials: false,
      },
    });

    // Customer view
    const custView = getSupportConversationForUser(String(tenant.id), conv.id, {
      userId: customerCtx.userId,
      role: 'customer',
    });
    expect(custView.messages[0].content).toBe(`Customer asked about ${sentinel}`);
    expect(custView.messages[1].content).toBe(SUPPORT_OUTPUT_HISTORY_NOTICE);
    expect(custView.messages[2].content).toBe(`Human agent reply mentioning ${sentinel}`);

    // Staff/admin view must NOT bypass 020 output policy
    const staffView = getSupportConversationForUser(String(tenant.id), conv.id, {
      userId: 'staff-1',
      role: 'staff',
    });
    expect(staffView.messages[1].content).toBe(SUPPORT_OUTPUT_HISTORY_NOTICE);
    expect(staffView.messages[0].content).toBe(`Customer asked about ${sentinel}`);
    expect(staffView.messages[2].content).toBe(`Human agent reply mentioning ${sentinel}`);

    // List view also applies 020 read-only
    const listed = listSupportConversations(String(tenant.id));
    expect(listed[0].messages[1].content).toBe(SUPPORT_OUTPUT_HISTORY_NOTICE);

    // Storage is NOT mutated and no audit events written on read
    const rawAfter = getDb()
      .prepare("SELECT value FROM settings WHERE key = 'x_gateway_support_conversations_v1'")
      .get() as { value: string };
    expect(rawAfter.value).toBe(rawBefore.value);
    expect(listSupportOutputEvents({ tenantId: tenant.id, limit: 50 }).items).toEqual([]);
  });

  it('never recovers raw text that was discarded at block time even if policy is later turned off', async () => {
    const sentinel = 'DISCARDED_FOREVER_TOKEN';
    saveSupportOutputPolicy({
      tenantId: tenant.id,
      expectedVersion: 0,
      policy: {
        mode: 'enforce',
        blockedTerms: [{ id: 'discard-rule', text: sentinel }],
        maxOutputChars: 16000,
        redactCredentials: false,
      },
    });

    const res = await executeSupportTurn({
      tenant,
      userContext: customerCtx,
      input: {
        tenantKey: tenant.publicKey,
        requestId: 'req-discard-1',
        messages: [{ role: 'user', content: 'Tell me secret' }],
      },
      generate: async () => ({
        reply: `Secret is ${sentinel}`,
        userContext: customerCtx,
        allowedTools: [],
        toolTrace: [],
        modelUsed: 'test-model',
        usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      }),
    });
    expect(res.reply).toBe(SUPPORT_OUTPUT_BLOCK_NOTICE);

    // Turn policy off
    saveSupportOutputPolicy({
      tenantId: tenant.id,
      expectedVersion: 1,
      policy: {
        mode: 'off',
        blockedTerms: [],
        maxOutputChars: 16000,
        redactCredentials: false,
      },
    });

    const conv = getSupportConversationForUser(String(tenant.id), res.runtime.conversationId!, {
      userId: customerCtx.userId,
      role: 'admin',
    });
    expect(conv.messages[1].content).toBe(SUPPORT_OUTPUT_BLOCK_NOTICE);
    expect(JSON.stringify(conv)).not.toContain(sentinel);
  });

  it('preserves 018 source revocation and sanitizes provider context history sent to model', async () => {
    // Part A: Provider context history sanitized by 020 when policy tightens
    const offModeTurn1 = await executeSupportTurn({
      tenant,
      userContext: customerCtx,
      input: {
        tenantKey: tenant.publicKey,
        requestId: 'req-ctx-1',
        messages: [{ role: 'user', content: 'What is the return policy?' }],
      },
      generate: async () => ({
        reply: 'Return policy allows returns accepted within 14 days with SENTINEL_IN_HISTORY.',
        userContext: customerCtx,
        allowedTools: [],
        toolTrace: [],
        modelUsed: 'test-model',
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }),
    });

    saveSupportOutputPolicy({
      tenantId: tenant.id,
      expectedVersion: 0,
      policy: {
        mode: 'enforce',
        blockedTerms: [{ id: 'hist-block', text: 'SENTINEL_IN_HISTORY' }],
        maxOutputChars: 16000,
        redactCredentials: false,
      },
    });

    let seenHistory: Array<{ role: string; content: string }> = [];
    await executeSupportTurn({
      tenant,
      userContext: customerCtx,
      input: {
        tenantKey: tenant.publicKey,
        conversationId: offModeTurn1.runtime.conversationId,
        requestId: 'req-ctx-2',
        messages: [{ role: 'user', content: 'Can you repeat the return policy?' }],
      },
      generate: async (ctx) => {
        seenHistory = ctx.messages;
        return {
          reply: 'Returns are accepted within 14 days.',
          userContext: customerCtx,
          allowedTools: [],
          toolTrace: [],
          modelUsed: 'test-model',
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        };
      },
    });

    expect(JSON.stringify(seenHistory)).not.toContain('SENTINEL_IN_HISTORY');
    expect(seenHistory.some((m) => m.role === 'assistant' && m.content === SUPPORT_OUTPUT_HISTORY_NOTICE)).toBe(true);

    // Part B: 018 source revocation remains intact
    const source = createSupportEvidenceSource(tenant.id, {
      name: 'Policy Doc',
      kind: 'text',
      allowedRoles: ['customer'],
    });
    const rev = await importSupportEvidenceRevision({
      tenantId: tenant.id,
      sourceId: source.id,
      expectedVersion: source.version,
      title: 'Policy Doc',
      format: 'text',
      content: 'Return policy allows returns accepted within 14 days for all customers.',
    });
    const published = publishSupportEvidenceRevision(tenant.id, source.id, rev.revision.id, rev.source.version);
    updateSupportEvidencePolicy(tenant.id, {
      mode: 'required',
      includeLegacyDocs: false,
      topK: 3,
      minCoverage: 0.25,
    }, 1);

    const turn1 = await executeSupportTurn({
      tenant,
      userContext: customerCtx,
      input: {
        tenantKey: tenant.publicKey,
        requestId: 'req-rev-1',
        messages: [{ role: 'user', content: 'What is the return policy?' }],
      },
      generate: async (ctx) => {
        const citId = /\[cite:(cit_[A-Za-z0-9_-]+)\]/.exec(ctx.trustedContext)![1];
        return {
          reply: `Return policy allows returns accepted within 14 days [cite:${citId}].`,
          userContext: customerCtx,
          allowedTools: [],
          toolTrace: [],
          modelUsed: 'test-model',
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        };
      },
    });
    expect(turn1.runtime.replySource).toBe('model');

    updateSupportEvidenceSource(
      tenant.id,
      source.id,
      { status: 'archived' },
      published.version,
    );
    const convAfterRevoke = getSupportConversationForUser(String(tenant.id), turn1.runtime.conversationId!, {
      userId: customerCtx.userId,
      role: 'staff',
    });
    expect(convAfterRevoke.messages[1].content).toBe(SAFE_EVIDENCE_NOTICES.source_revoked);
    expect(convAfterRevoke.messages[1].evidence?.citations).toEqual([]);
  });

  it('applies updated 017 masking using original customer role before 020 evaluation on staff and customer reads without mutating storage', () => {
    // Save conversation with 017 masking off so raw PII/custom tokens are stored
    updateSupportMaskingPolicy(String(tenant.id), { enabled: false });

    const conv = createOrAppendSupportConversation(String(tenant.id), {
      userId: customerCtx.userId,
      userRole: customerCtx.role,
      message: {
        senderType: 'customer',
        senderId: customerCtx.userId,
        senderRole: customerCtx.role,
        content: 'My email is alice@example.com and token is SECRET_MASK_TARGET.',
      },
    });
    createOrAppendSupportConversation(String(tenant.id), {
      conversationId: conv.id,
      userId: customerCtx.userId,
      userRole: customerCtx.role,
      message: {
        senderType: 'ai_assistant',
        senderId: 'ai',
        senderName: 'AI Support',
        senderRole: 'assistant',
        content: 'AI saw alice@example.com, SECRET_MASK_TARGET, and sk-testcredential123456.',
        toolTrace: [{ toolName: 'lookup:alice@example.com', status: 'ok', durationMs: 5 }],
      },
    });
    addHumanAgentReply(String(tenant.id), conv.id, {
      agentName: 'Agent Bob',
      content: 'Agent confirmed alice@example.com and SECRET_MASK_TARGET.',
    });

    const rawBefore = getDb()
      .prepare("SELECT value FROM settings WHERE key = 'x_gateway_support_conversations_v1'")
      .get() as { value: string };

    // Enable 017 masking with staff/admin unmasked, plus 020 credential redaction
    updateSupportMaskingPolicy(String(tenant.id), {
      enabled: true,
      builtinDetectors: ['email'],
      unmaskedRoles: ['staff', 'admin'],
      customRules: [
        {
          id: 'mask-secret-target',
          name: 'Mask Secret Target',
          pattern: 'SECRET_MASK_TARGET',
          replacement: '[MASKED_BY_017]',
          enabled: true,
        },
      ],
    });
    const policyV1 = saveSupportOutputPolicy({
      tenantId: tenant.id,
      expectedVersion: 0,
      policy: {
        mode: 'enforce',
        blockedTerms: [],
        maxOutputChars: 16000,
        redactCredentials: true,
      },
    });

    const custView = getSupportConversationForUser(String(tenant.id), conv.id, {
      userId: customerCtx.userId,
      role: 'customer',
    });
    const staffView = getSupportConversationForUser(String(tenant.id), conv.id, {
      userId: 'staff-1',
      role: 'staff',
    });
    const listed = listSupportConversations(String(tenant.id), { userId: customerCtx.userId });

    for (const view of [custView, staffView, listed[0]]) {
      // Customer & human_agent messages remain untouched
      expect(view.messages[0].content).toBe('My email is alice@example.com and token is SECRET_MASK_TARGET.');
      expect(view.messages[2].content).toBe('Agent confirmed alice@example.com and SECRET_MASK_TARGET.');

      // AI message masked under original customer role (never bypassed by staff) and composed with 020
      expect(view.messages[1].content).toBe(
        'AI saw a***@example.com, [MASKED_BY_017], and [REDACTED_KEY].',
      );
      expect(view.messages[1].toolTrace?.[0].toolName).toBe('lookup:a***@example.com');
    }

    // Prove 017 masking runs BEFORE 020 evaluation: blocking the 017 replacement token blocks the AI message
    saveSupportOutputPolicy({
      tenantId: tenant.id,
      expectedVersion: policyV1.version,
      policy: {
        mode: 'enforce',
        blockedTerms: [{ id: 'block-masked-marker', text: '[MASKED_BY_017]' }],
        maxOutputChars: 16000,
        redactCredentials: true,
      },
    });

    const custBlocked = getSupportConversationForUser(String(tenant.id), conv.id, {
      userId: customerCtx.userId,
      role: 'customer',
    });
    const staffBlocked = getSupportConversationForUser(String(tenant.id), conv.id, {
      userId: 'staff-1',
      role: 'staff',
    });
    const listedBlocked = listSupportConversations(String(tenant.id), { userId: customerCtx.userId });

    for (const view of [custBlocked, staffBlocked, listedBlocked[0]]) {
      expect(view.messages[1].content).toBe(SUPPORT_OUTPUT_HISTORY_NOTICE);
      expect(view.messages[1].toolTrace).toEqual([]);
      expect(view.messages[0].content).toBe('My email is alice@example.com and token is SECRET_MASK_TARGET.');
      expect(view.messages[2].content).toBe('Agent confirmed alice@example.com and SECRET_MASK_TARGET.');
    }

    const rawAfter = getDb()
      .prepare("SELECT value FROM settings WHERE key = 'x_gateway_support_conversations_v1'")
      .get() as { value: string };
    expect(rawAfter.value).toBe(rawBefore.value);
    expect(listSupportOutputEvents({ tenantId: tenant.id, limit: 50 }).items).toEqual([]);
  });

  it('preserves valid customer 018 citations when staff reads a customer conversation despite staff-only sources', async () => {
    const custSource = createSupportEvidenceSource(tenant.id, {
      name: 'Customer Return Source',
      kind: 'text',
      allowedRoles: ['customer'],
    });
    const custRev = await importSupportEvidenceRevision({
      tenantId: tenant.id,
      sourceId: custSource.id,
      expectedVersion: custSource.version,
      title: 'Customer Return Guide',
      format: 'text',
      content: 'Eligible items can be returned within 30 days of delivery.',
    });
    publishSupportEvidenceRevision(tenant.id, custSource.id, custRev.revision.id, custRev.source.version);

    const staffSource = createSupportEvidenceSource(tenant.id, {
      name: 'Staff Override Source',
      kind: 'text',
      allowedRoles: ['staff'],
    });
    const staffRev = await importSupportEvidenceRevision({
      tenantId: tenant.id,
      sourceId: staffSource.id,
      expectedVersion: staffSource.version,
      title: 'Staff Internal Guide',
      format: 'text',
      content: 'Staff override limit is 500 USD per order.',
    });
    publishSupportEvidenceRevision(tenant.id, staffSource.id, staffRev.revision.id, staffRev.source.version);

    updateSupportEvidencePolicy(
      tenant.id,
      {
        mode: 'required',
        includeLegacyDocs: false,
        topK: 3,
        minCoverage: 0.25,
      },
      1,
    );

    const turn = await executeSupportTurn({
      tenant,
      userContext: customerCtx,
      input: {
        tenantKey: tenant.publicKey,
        requestId: 'req-staff-read-cust-cite-1',
        messages: [{ role: 'user', content: 'Can eligible items be returned within 30 days?' }],
      },
      generate: async (ctx) => {
        const citId = /\[cite:(cit_[A-Za-z0-9_-]+)\]/.exec(ctx.trustedContext)![1];
        return {
          reply: `Eligible items can be returned within 30 days [cite:${citId}].`,
          userContext: customerCtx,
          allowedTools: [],
          toolTrace: [],
          modelUsed: 'test-model',
          usage: { prompt_tokens: 12, completion_tokens: 10, total_tokens: 22 },
        };
      },
    });
    expect(turn.runtime.replySource).toBe('model');
    expect(turn.runtime.evidence?.status).toBe('cited');

    const staffView = getSupportConversationForUser(String(tenant.id), turn.runtime.conversationId!, {
      userId: 'staff-1',
      role: 'staff',
    });
    expect(staffView.messages[1].content).toBe('Eligible items can be returned within 30 days [1].');
    expect(staffView.messages[1].evidence?.status).toBe('cited');
    expect(staffView.messages[1].evidence?.citations).toHaveLength(1);
    expect(staffView.messages[1].evidence?.citations[0].sourceId).toBe(custSource.id);
    expect(staffView.messages[1].evidence?.citations[0].title).toBe('Customer Return Guide');

    const custView = getSupportConversationForUser(String(tenant.id), turn.runtime.conversationId!, {
      userId: customerCtx.userId,
      role: 'customer',
    });
    expect(custView.messages[1].evidence?.status).toBe('cited');
    expect(custView.messages[1].evidence?.citations).toHaveLength(1);
  });
});
