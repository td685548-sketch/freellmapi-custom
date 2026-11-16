import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import { getDb, initDb } from '../../db/index.js';
import { setEnabled } from '../../custom/x-gateway/config.js';
import { resetFlagsCacheForTests, setFlags } from '../../custom/ai-platform/flags.js';
import { upsertSupportKnowledgeDoc } from '../../custom/x-gateway/support-knowledge.js';
import {
  createSupportTenant,
  type SupportTenant,
  type SupportUserContext,
} from '../../custom/x-gateway/support-store.js';
import {
  executeSupportTurn,
  SupportRuntimeError,
} from '../../custom/x-gateway/support-runtime.js';
import {
  getSupportConversationForUser,
  createOrAppendSupportConversation,
} from '../../custom/x-gateway/support-workflows.js';
import { getSupportUserQuotaStatus } from '../../custom/x-gateway/support-guardrails.js';
import {
  createSupportEvidenceSource,
  importSupportEvidenceRevision,
  publishSupportEvidenceRevision,
  updateSupportEvidencePolicy,
} from '../../custom/x-gateway/support-evidence-store.js';
import {
  getSupportOutputPolicy,
  listSupportOutputEvents,
  saveSupportOutputPolicy,
} from '../../custom/x-gateway/support-output-store.js';
import { CITATIONS_HEADER_NAME, type CitationEntry } from '@freellmapi/shared/ai-platform-retrieval.js';
import { SUPPORT_OUTPUT_BLOCK_NOTICE } from '@freellmapi/shared/support-output.js';

describe('Support Output Runtime Integration (Spec 020)', () => {
  let tenant: SupportTenant;
  let customerCtx: SupportUserContext;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv('ENCRYPTION_KEY', '0'.repeat(64));
    initDb(':memory:');
    setEnabled(true);
    tenant = createSupportTenant({
      name: 'Output Runtime Tenant',
      defaultModel: 'test-model',
      allowGuest: true,
    }).tenant;
    customerCtx = {
      tenantId: tenant.id,
      userId: 'cust-output-1',
      role: 'customer',
      name: 'Customer Output',
      permissions: [],
      verified: true,
    };
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    resetFlagsCacheForTests();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function createMockRes() {
    const headers: Record<string, string> = {};
    const res = {
      headersSent: false,
      req: { headers: {} },
      setHeader(name: string, val: string | string[]) {
        headers[name.toLowerCase()] = Array.isArray(val) ? val.join(', ') : String(val);
        return res;
      },
      getHeader(name: string) {
        return headers[name.toLowerCase()];
      },
    } as unknown as Response;
    return { res, headers };
  }

  function collectCapturedLogs(): string {
    return [
      ...logSpy.mock.calls.flat(),
      ...warnSpy.mock.calls.flat(),
      ...errorSpy.mock.calls.flat(),
    ]
      .map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
      .join('\n');
  }

  it('preserves default off mode compatibility without writing output events', async () => {
    const policy = getSupportOutputPolicy(tenant.id);
    expect(policy.mode).toBe('off');
    expect(policy.version).toBe(0);

    const res = await executeSupportTurn({
      tenant,
      userContext: customerCtx,
      input: {
        tenantKey: tenant.publicKey,
        requestId: 'req-off-1',
        messages: [{ role: 'user', content: 'Hello support' }],
      },
      generate: async () => ({
        reply: 'Hello! Here is your answer.',
        userContext: customerCtx,
        allowedTools: [],
        toolTrace: [],
        modelUsed: 'test-model',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    });

    expect(res.reply).toBe('Hello! Here is your answer.');
    expect(res.runtime.replySource).toBe('model');
    expect(res.runtime.output).toEqual({
      policyVersion: 0,
      action: 'allow',
      reasons: [],
      redactionCount: 0,
    });
    expect(listSupportOutputEvents({ tenantId: tenant.id, limit: 50 }).items).toEqual([]);
  });

  it('strips blocked raw sentinel from all aliases, nested traces, citations, history, cache, audit, and logs', async () => {
    const sentinel = 'SECRET_SENTINEL_XYZ_999';
    saveSupportOutputPolicy({
      tenantId: tenant.id,
      expectedVersion: 0,
      policy: {
        mode: 'enforce',
        blockedTerms: [{ id: 'rule-secret', text: sentinel }],
        maxOutputChars: 16000,
        redactCredentials: true,
      },
    });

    const source = createSupportEvidenceSource(tenant.id, {
      name: 'Refund Guide',
      kind: 'text',
      allowedRoles: ['customer'],
    });
    const rev = await importSupportEvidenceRevision({
      tenantId: tenant.id,
      sourceId: source.id,
      expectedVersion: source.version,
      title: 'Refund Guide',
      format: 'text',
      content: `Refunds take 5 business days. Internal note: ${sentinel}`,
    });
    publishSupportEvidenceRevision(tenant.id, source.id, rev.revision.id, rev.source.version);
    updateSupportEvidencePolicy(tenant.id, {
      mode: 'required',
      includeLegacyDocs: false,
      topK: 3,
      minCoverage: 0.25,
    }, 1);

    const res = await executeSupportTurn({
      tenant,
      userContext: customerCtx,
      input: {
        tenantKey: tenant.publicKey,
        requestId: 'req-block-1',
        messages: [{ role: 'user', content: 'How long do refunds take?' }],
      },
      generate: async (ctx) => {
        const citId = /\[cite:(cit_[A-Za-z0-9_-]+)\]/.exec(ctx.trustedContext)![1];
        return {
          reply: `Refunds take 5 business days [cite:${citId}]. Also ${sentinel}`,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: `Alias choice ${sentinel}` },
              finish_reason: 'stop',
            },
          ],
          userContext: customerCtx,
          allowedTools: [],
          toolTrace: [
            {
              kind: 'webhook',
              name: 'lookup_refund',
              output: { nested: { detail: `Trace ${sentinel}` } },
              result: { nested: { detail: `Result ${sentinel}` } },
            },
          ],
          modelUsed: 'test-model',
          usage: { prompt_tokens: 20, completion_tokens: 15, total_tokens: 35 },
        };
      },
    });

    expect(res.reply).toBe(SUPPORT_OUTPUT_BLOCK_NOTICE);
    expect(res.choices?.[0]?.message?.content).toBe(SUPPORT_OUTPUT_BLOCK_NOTICE);
    expect(res.toolTrace).toEqual([]);
    expect(res.runtime.replySource).toBe('output_policy_notice');
    expect(res.runtime.evidence?.citations).toEqual([]);
    expect(res.runtime.modelUsed ?? res.modelUsed).toBe('test-model');
    expect(res.usage.total_tokens).toBe(35);
    expect(res.runtime.output).toEqual({
      policyVersion: 1,
      action: 'block',
      reasons: ['blocked_term'],
      redactionCount: 0,
    });

    const quota = getSupportUserQuotaStatus(String(tenant.id), {
      userId: customerCtx.userId,
      userRole: customerCtx.role,
    });
    expect(quota.requestsUsed).toBe(1);
    expect(quota.tokensUsed).toBe(35);

    const conv = getSupportConversationForUser(String(tenant.id), res.runtime.conversationId!, {
      userId: customerCtx.userId,
      role: customerCtx.role,
    });
    expect(conv.messages[1].content).toBe(SUPPORT_OUTPUT_BLOCK_NOTICE);

    const events = listSupportOutputEvents({ tenantId: tenant.id, limit: 50 }).items;
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('block');
    expect(events[0].ruleIds).toEqual(['rule-secret']);

    const turnRow = getDb()
      .prepare('SELECT masked_response_encrypted FROM x_support_runtime_turns WHERE tenant_id = ?')
      .get(tenant.id) as { masked_response_encrypted: string };
    expect(turnRow.masked_response_encrypted).not.toContain(sentinel);
    expect(JSON.stringify(res)).not.toContain(sentinel);
    expect(JSON.stringify(conv)).not.toContain(sentinel);
    expect(JSON.stringify(events)).not.toContain(sentinel);
    expect(collectCapturedLogs()).not.toContain(sentinel);
  });

  it('blocks nested toolTrace sentinel even when reply text is clean', async () => {
    const sentinel = 'TRACE_ONLY_SECRET_42';
    saveSupportOutputPolicy({
      tenantId: tenant.id,
      expectedVersion: 0,
      policy: {
        mode: 'enforce',
        blockedTerms: [{ id: 'trace-rule', text: sentinel }],
        maxOutputChars: 16000,
        redactCredentials: false,
      },
    });

    const res = await executeSupportTurn({
      tenant,
      userContext: customerCtx,
      input: {
        tenantKey: tenant.publicKey,
        requestId: 'req-trace-block',
        messages: [{ role: 'user', content: 'Check status' }],
      },
      generate: async () => ({
        reply: 'Your order is on the way.',
        userContext: customerCtx,
        allowedTools: [],
        toolTrace: [
          {
            kind: 'db',
            name: 'orders_db',
            output: [{ row: { internalNote: `leak ${sentinel}` } }],
          },
        ],
        modelUsed: 'test-model',
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }),
    });

    expect(res.reply).toBe(SUPPORT_OUTPUT_BLOCK_NOTICE);
    expect(res.toolTrace).toEqual([]);
    expect(res.runtime.replySource).toBe('output_policy_notice');
    expect(JSON.stringify(res)).not.toContain(sentinel);
  });

  it('redacts credentials and revalidates 018 citations when visible answer changes', async () => {
    saveSupportOutputPolicy({
      tenantId: tenant.id,
      expectedVersion: 0,
      policy: {
        mode: 'enforce',
        blockedTerms: [],
        maxOutputChars: 16000,
        redactCredentials: true,
      },
    });

    // First verify credential redaction in standard mode
    const secretKey = 'sup_ctx_1234567890abcdef';
    const stdRes = await executeSupportTurn({
      tenant,
      userContext: customerCtx,
      input: {
        tenantKey: tenant.publicKey,
        requestId: 'req-redact-std',
        messages: [{ role: 'user', content: 'How do I authenticate?' }],
      },
      generate: async () => ({
        reply: `Use token ${secretKey} for auth.`,
        userContext: customerCtx,
        allowedTools: [],
        toolTrace: [],
        modelUsed: 'test-model',
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }),
    });
    expect(stdRes.reply).not.toContain(secretKey);
    expect(stdRes.reply).toContain('[REDACTED_TOKEN]');
    expect(stdRes.runtime.output?.action).toBe('redact');
    expect(stdRes.runtime.output?.redactionCount).toBe(1);

    // Then verify 018 citation revalidation when 020 redaction alters visible reply in required mode
    const source = createSupportEvidenceSource(tenant.id, {
      name: 'API Guide',
      kind: 'text',
      allowedRoles: ['customer'],
    });
    const rev = await importSupportEvidenceRevision({
      tenantId: tenant.id,
      sourceId: source.id,
      expectedVersion: source.version,
      title: 'API Guide',
      format: 'text',
      content: 'Authenticate requests using standard API headers and token sup_ctx_1234567890abcdef.',
    });
    publishSupportEvidenceRevision(tenant.id, source.id, rev.revision.id, rev.source.version);
    updateSupportEvidencePolicy(tenant.id, {
      mode: 'required',
      includeLegacyDocs: false,
      topK: 3,
      minCoverage: 0.25,
    }, 1);

    const res = await executeSupportTurn({
      tenant,
      userContext: customerCtx,
      input: {
        tenantKey: tenant.publicKey,
        requestId: 'req-redact-1',
        messages: [{ role: 'user', content: 'How do I authenticate API requests?' }],
      },
      generate: async (ctx) => {
        const citId = /\[cite:(cit_[A-Za-z0-9_-]+)\]/.exec(ctx.trustedContext)![1];
        return {
          reply: `Authenticate requests using standard API headers and token ${secretKey} [cite:${citId}].`,
          userContext: customerCtx,
          allowedTools: [],
          toolTrace: [],
          modelUsed: 'test-model',
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        };
      },
    });

    expect(res.reply).not.toContain(secretKey);
    expect(res.runtime.output?.action).toBe('redact');
    expect(res.runtime.output?.redactionCount).toBeGreaterThanOrEqual(1);
    expect(res.runtime.evidence?.status).toBe('cited');
    expect(res.runtime.evidence?.citations).toHaveLength(1);
    expect(res.runtime.replySource).toBe('model');
    expect(JSON.stringify(res)).not.toContain(secretKey);
    expect(collectCapturedLogs()).not.toContain(secretKey);
  });

  it('reloads updated policy synchronously in final DB transaction when policy changes in-flight', async () => {
    const sentinel = 'INFLIGHT_BLOCKED_TERM';
    let resolveProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      resolveProvider = resolve;
    });

    const turnPromise = executeSupportTurn({
      tenant,
      userContext: customerCtx,
      input: {
        tenantKey: tenant.publicKey,
        requestId: 'req-inflight-1',
        messages: [{ role: 'user', content: 'Hello' }],
      },
      generate: async () => {
        await providerGate;
        return {
          reply: `Reply containing ${sentinel}`,
          userContext: customerCtx,
          allowedTools: [],
          toolTrace: [],
          modelUsed: 'test-model',
          usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
        };
      },
    });

    // Update policy while provider call is in-flight
    await new Promise((r) => setTimeout(r, 15));
    saveSupportOutputPolicy({
      tenantId: tenant.id,
      expectedVersion: 0,
      policy: {
        mode: 'enforce',
        blockedTerms: [{ id: 'inflight', text: sentinel }],
        maxOutputChars: 16000,
        redactCredentials: false,
      },
    });
    resolveProvider();

    const res = await turnPromise;
    expect(res.reply).toBe(SUPPORT_OUTPUT_BLOCK_NOTICE);
    expect(res.runtime.replySource).toBe('output_policy_notice');
    expect(res.runtime.output?.policyVersion).toBe(1);
    expect(res.runtime.output?.action).toBe('block');
  });

  it('deduplicates same-request contention to 1 charge and 1 output event, and returns 409 on replay after policy change', async () => {
    saveSupportOutputPolicy({
      tenantId: tenant.id,
      expectedVersion: 0,
      policy: {
        mode: 'log',
        blockedTerms: [{ id: 'warn-term', text: 'FLAGGED_TERM' }],
        maxOutputChars: 16000,
        redactCredentials: false,
      },
    });

    const generate = vi.fn(async () => ({
      reply: 'Response with FLAGGED_TERM',
      userContext: customerCtx,
      allowedTools: [],
      toolTrace: [],
      modelUsed: 'test-model',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }));

    const first = await executeSupportTurn({
      tenant,
      userContext: customerCtx,
      input: {
        tenantKey: tenant.publicKey,
        requestId: 'req-replay-1',
        messages: [{ role: 'user', content: 'Hi' }],
      },
      generate,
    });
    expect(first.runtime.replayed).toBe(false);
    expect(first.runtime.output?.action).toBe('observe');

    const replay = await executeSupportTurn({
      tenant,
      userContext: customerCtx,
      input: {
        tenantKey: tenant.publicKey,
        requestId: 'req-replay-1',
        messages: [{ role: 'user', content: 'Hi' }],
      },
      generate,
    });
    expect(replay.runtime.replayed).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(listSupportOutputEvents({ tenantId: tenant.id, limit: 50 }).items).toHaveLength(1);

    const quota = getSupportUserQuotaStatus(String(tenant.id), {
      userId: customerCtx.userId,
      userRole: customerCtx.role,
    });
    expect(quota.requestsUsed).toBe(1);
    expect(quota.tokensUsed).toBe(15);

    // Change policy version -> replay must return 409 output_policy_changed
    saveSupportOutputPolicy({
      tenantId: tenant.id,
      expectedVersion: 1,
      policy: {
        mode: 'enforce',
        blockedTerms: [{ id: 'warn-term', text: 'FLAGGED_TERM' }],
        maxOutputChars: 16000,
        redactCredentials: false,
      },
    });

    await expect(
      executeSupportTurn({
        tenant,
        userContext: customerCtx,
        input: {
          tenantKey: tenant.publicKey,
          requestId: 'req-replay-1',
          messages: [{ role: 'user', content: 'Hi' }],
        },
        generate,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'output_policy_changed' });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('evaluates legacy pre-020 cached replay read-only under current policy without writing events or mutating cache', async () => {
    const res = await executeSupportTurn({
      tenant,
      userContext: customerCtx,
      input: {
        tenantKey: tenant.publicKey,
        requestId: 'req-legacy-replay',
        messages: [{ role: 'user', content: 'Hi' }],
      },
      generate: async () => ({
        reply: 'Legacy cached answer with SECRET_LEGACY',
        userContext: customerCtx,
        allowedTools: [],
        toolTrace: [],
        modelUsed: 'test-model',
        usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      }),
    });

    // Simulate pre-020 cached payload by stripping runtime.output in encrypted store
    const { encrypt } = await import('../../lib/crypto.js');
    const legacyPayload = { ...res, runtime: { ...res.runtime } };
    delete (legacyPayload.runtime as { output?: unknown }).output;
    const enc = encrypt(JSON.stringify(legacyPayload));
    getDb()
      .prepare(
        'UPDATE x_support_runtime_turns SET masked_response_encrypted = ?, iv = ?, auth_tag = ? WHERE tenant_id = ? AND request_id = ?',
      )
      .run(enc.encrypted, enc.iv, enc.authTag, tenant.id, 'req-legacy-replay');

    saveSupportOutputPolicy({
      tenantId: tenant.id,
      expectedVersion: 0,
      policy: {
        mode: 'enforce',
        blockedTerms: [{ id: 'legacy-rule', text: 'SECRET_LEGACY' }],
        maxOutputChars: 16000,
        redactCredentials: false,
      },
    });

    const replayed = await executeSupportTurn({
      tenant,
      userContext: customerCtx,
      input: {
        tenantKey: tenant.publicKey,
        requestId: 'req-legacy-replay',
        messages: [{ role: 'user', content: 'Hi' }],
      },
      generate: async () => {
        throw new Error('Should not call provider on replay');
      },
    });

    expect(replayed.runtime.replayed).toBe(true);
    expect(replayed.reply).toBe(SUPPORT_OUTPUT_BLOCK_NOTICE);
    expect(replayed.runtime.replySource).toBe('output_policy_notice');
    expect(listSupportOutputEvents({ tenantId: tenant.id, limit: 50 }).items).toEqual([]);
  });

  it('fails closed with 503 on corrupt policy storage and releases conversation lease', async () => {
    const conv = createOrAppendSupportConversation(String(tenant.id), {
      userId: customerCtx.userId,
      userRole: customerCtx.role,
      message: {
        senderType: 'customer',
        senderId: customerCtx.userId,
        senderRole: customerCtx.role,
        content: 'Initial',
      },
    });

    saveSupportOutputPolicy({
      tenantId: tenant.id,
      expectedVersion: 0,
      policy: {
        mode: 'enforce',
        blockedTerms: [],
        maxOutputChars: 16000,
        redactCredentials: false,
      },
    });

    getDb()
      .prepare('UPDATE x_support_output_policies SET payload_encrypted = ? WHERE tenant_id = ?')
      .run('corrupted-ciphertext', tenant.id);

    await expect(
      executeSupportTurn({
        tenant,
        userContext: customerCtx,
        input: {
          tenantKey: tenant.publicKey,
          conversationId: conv.id,
          requestId: 'req-corrupt-1',
          messages: [{ role: 'user', content: 'Hello' }],
        },
        generate: async () => ({
          reply: 'Should not commit',
          userContext: customerCtx,
          allowedTools: [],
          toolTrace: [],
          modelUsed: 'test-model',
          usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
        }),
      }),
    ).rejects.toMatchObject({ status: 503, code: 'output_policy_unavailable' });

    const leases = getDb()
      .prepare('SELECT COUNT(*) AS n FROM x_support_runtime_leases WHERE tenant_id = ? AND conversation_id = ?')
      .get(tenant.id, conv.id) as { n: number };
    expect(leases.n).toBe(0);
  });

  it('returns 503 output_inspection_limit in log/off mode when output exceeds maxLeaves without leaking input', async () => {
    const oversizedTrace = Array.from({ length: 35 }, (_, i) => ({
      kind: 'db' as const,
      name: `tool_${i}`,
      output: `SENSITIVE_OVERSIZED_ITEM_${i}`,
    }));

    let err: unknown;
    try {
      await executeSupportTurn({
        tenant,
        userContext: customerCtx,
        input: {
          tenantKey: tenant.publicKey,
          requestId: 'req-limit-1',
          messages: [{ role: 'user', content: 'Run many tools' }],
        },
        generate: async () => ({
          reply: 'Done',
          userContext: customerCtx,
          allowedTools: [],
          toolTrace: oversizedTrace,
          modelUsed: 'test-model',
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      });
    } catch (caught) {
      err = caught;
    }

    expect(err).toBeInstanceOf(SupportRuntimeError);
    expect((err as SupportRuntimeError).status).toBe(503);
    expect((err as SupportRuntimeError).code).toBe('output_inspection_limit');
    expect((err as SupportRuntimeError).message).not.toContain('SENSITIVE_OVERSIZED_ITEM');
  });
  it('redacts credentials in public trace names', async () => {
    const token = 'sup_ctx_1234567890abcdef';
    saveSupportOutputPolicy({tenantId:tenant.id,expectedVersion:0,policy:{mode:'enforce',blockedTerms:[],maxOutputChars:16000,redactCredentials:true}});
    const res = await executeSupportTurn({tenant,userContext:customerCtx,input:{tenantKey:tenant.publicKey,requestId:'review-trace-name',messages:[{role:'user',content:'Please help'}]},generate:async()=>({reply:'Safe reply',userContext:customerCtx,allowedTools:[],toolTrace:[{kind:'db',name:token,output:'Safe data'}],modelUsed:'test-model',usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}})});
    expect(JSON.stringify(res)).not.toContain(token);
  });
  it('strips public trace text on history blocking', () => {
    const sentinel='HISTORY_FORBIDDEN_SENTINEL';
    const conv=createOrAppendSupportConversation(String(tenant.id),{userId:customerCtx.userId,userRole:'customer',message:{senderType:'ai_assistant',senderId:'ai',content:sentinel,toolTrace:[{toolName:sentinel,status:'success'}]}});
    saveSupportOutputPolicy({tenantId:tenant.id,expectedVersion:0,policy:{mode:'enforce',blockedTerms:[{id:'blocked',text:sentinel}],maxOutputChars:16000,redactCredentials:false}});
    const view=getSupportConversationForUser(String(tenant.id),conv.id,{userId:customerCtx.userId,role:'customer'});
    expect(JSON.stringify(view.messages)).not.toContain(sentinel);
  });

  it('redacts credentials in Stage 4 retrievalCitations across result.citations, runtime.citations, X-FreeLLM-Citations header, and cached replay', async () => {
    const secretToken = 'sup_ctx_retrieval_secret_12345';
    const bearerSecret = 'Bearer secret_retrieval_bearer_999';
    upsertSupportKnowledgeDoc(String(tenant.id), {
      title: `Auth Guide ${secretToken}`,
      category: 'guide',
      allowedRoles: ['customer'],
      tags: ['auth', 'token'],
      content: `Authenticate retrieval requests using ${bearerSecret} and ${secretToken}.`,
    });

    resetFlagsCacheForTests();
    setFlags({ retrieval: true });

    saveSupportOutputPolicy({
      tenantId: tenant.id,
      expectedVersion: 0,
      policy: {
        mode: 'enforce',
        blockedTerms: [],
        maxOutputChars: 16000,
        redactCredentials: true,
      },
    });

    const { res: mockRes, headers } = createMockRes();
    const generate = vi.fn(async () => ({
      reply: 'Please follow the authentication guide.',
      userContext: customerCtx,
      allowedTools: [],
      toolTrace: [],
      modelUsed: 'test-model',
      usage: { prompt_tokens: 15, completion_tokens: 10, total_tokens: 25 },
    }));

    const turnRes = await executeSupportTurn({
      tenant,
      userContext: customerCtx,
      res: mockRes,
      input: {
        tenantKey: tenant.publicKey,
        requestId: 'req-retrieval-redact-1',
        messages: [{ role: 'user', content: 'Authenticate retrieval auth guide token' }],
      },
      generate,
    });

    expect(Array.isArray(turnRes.citations)).toBe(true);
    expect(turnRes.citations!.length).toBeGreaterThan(0);
    expect(turnRes.runtime.citations).toEqual(turnRes.citations);
    expect(JSON.stringify(turnRes)).not.toContain(secretToken);
    expect(JSON.stringify(turnRes)).not.toContain('secret_retrieval_bearer_999');
    expect(turnRes.citations![0].title).toContain('[REDACTED_TOKEN]');
    expect(turnRes.citations![0].snippet).toContain('[REDACTED_TOKEN]');

    const citHeader = headers[CITATIONS_HEADER_NAME.toLowerCase()];
    expect(citHeader).toBeTruthy();
    const decodedHeader = JSON.parse(Buffer.from(citHeader, 'base64url').toString('utf8')) as CitationEntry[];
    expect(decodedHeader.length).toBeGreaterThan(0);
    expect(JSON.stringify(decodedHeader)).not.toContain(secretToken);
    expect(JSON.stringify(decodedHeader)).not.toContain('secret_retrieval_bearer_999');
    expect(decodedHeader[0].title).toContain('[REDACTED_TOKEN]');

    // Cached replay preserves sanitized citations
    const replay = await executeSupportTurn({
      tenant,
      userContext: customerCtx,
      input: {
        tenantKey: tenant.publicKey,
        requestId: 'req-retrieval-redact-1',
        messages: [{ role: 'user', content: 'Authenticate retrieval auth guide token' }],
      },
      generate,
    });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(replay.runtime.replayed).toBe(true);
    expect(replay.citations).toEqual(turnRes.citations);
    expect(replay.runtime.citations).toEqual(turnRes.runtime.citations);
    expect(JSON.stringify(replay)).not.toContain(secretToken);
    expect(JSON.stringify(replay)).not.toContain('secret_retrieval_bearer_999');
  });

  it('blocks Stage 4 retrievalCitations containing blocked terms across result.citations, runtime.citations, X-FreeLLM-Citations header, and replay', async () => {
    const blockedTerm = 'FORBIDDEN_CITATION_SNIPPET_777';
    upsertSupportKnowledgeDoc(String(tenant.id), {
      title: 'Shipping Policy',
      category: 'guide',
      allowedRoles: ['customer'],
      tags: ['shipping'],
      content: `Standard shipping takes 3 days. Internal marker: ${blockedTerm}.`,
    });

    resetFlagsCacheForTests();
    setFlags({ retrieval: true });

    saveSupportOutputPolicy({
      tenantId: tenant.id,
      expectedVersion: 0,
      policy: {
        mode: 'enforce',
        blockedTerms: [{ id: 'ret-block-term', text: blockedTerm }],
        maxOutputChars: 16000,
        redactCredentials: false,
      },
    });

    const { res: mockRes, headers } = createMockRes();
    const generate = vi.fn(async () => ({
      reply: 'Standard shipping takes 3 days.',
      userContext: customerCtx,
      allowedTools: [],
      toolTrace: [],
      modelUsed: 'test-model',
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
    }));

    const turnRes = await executeSupportTurn({
      tenant,
      userContext: customerCtx,
      res: mockRes,
      input: {
        tenantKey: tenant.publicKey,
        requestId: 'req-retrieval-block-1',
        messages: [{ role: 'user', content: 'Standard shipping policy days' }],
      },
      generate,
    });

    expect(turnRes.reply).toBe(SUPPORT_OUTPUT_BLOCK_NOTICE);
    expect(turnRes.runtime.replySource).toBe('output_policy_notice');
    expect(turnRes.runtime.output?.action).toBe('block');
    expect(turnRes.citations).toBeUndefined();
    expect(turnRes.runtime.citations).toBeUndefined();
    expect(headers[CITATIONS_HEADER_NAME.toLowerCase()]).toBeUndefined();
    expect(JSON.stringify(turnRes)).not.toContain(blockedTerm);

    const replay = await executeSupportTurn({
      tenant,
      userContext: customerCtx,
      input: {
        tenantKey: tenant.publicKey,
        requestId: 'req-retrieval-block-1',
        messages: [{ role: 'user', content: 'Standard shipping policy days' }],
      },
      generate,
    });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(replay.runtime.replayed).toBe(true);
    expect(replay.reply).toBe(SUPPORT_OUTPUT_BLOCK_NOTICE);
    expect(replay.citations).toBeUndefined();
    expect(replay.runtime.citations).toBeUndefined();
    expect(JSON.stringify(replay)).not.toContain(blockedTerm);
  });

  it('blocks or redacts legacy pre-020 cached replay citations and runtime.citations under updated 020 policy', async () => {
    const legacyBlocked = 'LEGACY_CITATION_BLOCK_901';
    const legacySecret = 'sup_ctx_legacy_cite_token_999';
    upsertSupportKnowledgeDoc(String(tenant.id), {
      title: 'Legacy Retrieval Guide',
      category: 'guide',
      allowedRoles: ['customer'],
      tags: ['legacy', 'retrieval'],
      content: 'Legacy retrieval guide details for customer support.',
    });

    resetFlagsCacheForTests();
    setFlags({ retrieval: true });

    const blockSeed = await executeSupportTurn({
      tenant,
      userContext: customerCtx,
      input: {
        tenantKey: tenant.publicKey,
        requestId: 'req-legacy-cite-block',
        messages: [{ role: 'user', content: 'Legacy retrieval guide details' }],
      },
      generate: async () => ({
        reply: 'Clean reply text.',
        userContext: customerCtx,
        allowedTools: [],
        toolTrace: [],
        modelUsed: 'test-model',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    });

    const redactSeed = await executeSupportTurn({
      tenant,
      userContext: customerCtx,
      input: {
        tenantKey: tenant.publicKey,
        requestId: 'req-legacy-cite-redact',
        messages: [{ role: 'user', content: 'Legacy retrieval guide details' }],
      },
      generate: async () => ({
        reply: 'Clean reply text.',
        userContext: customerCtx,
        allowedTools: [],
        toolTrace: [],
        modelUsed: 'test-model',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    });

    // Inject pre-020 payloads (no runtime.output) with tainted citations & runtime.citations
    const { encrypt } = await import('../../lib/crypto.js');
    const blockCitations: CitationEntry[] = [
      {
        docId: 'doc-legacy-1',
        chunkId: 1,
        title: `Title ${legacyBlocked}`,
        score: 0.9,
        snippet: 'Normal snippet',
      },
    ];
    const blockPayload = {
      ...blockSeed,
      citations: blockCitations,
      runtime: { ...blockSeed.runtime, citations: blockCitations },
    };
    delete (blockPayload.runtime as { output?: unknown }).output;
    const encBlock = encrypt(JSON.stringify(blockPayload));
    getDb()
      .prepare(
        'UPDATE x_support_runtime_turns SET masked_response_encrypted = ?, iv = ?, auth_tag = ? WHERE tenant_id = ? AND request_id = ?',
      )
      .run(encBlock.encrypted, encBlock.iv, encBlock.authTag, tenant.id, 'req-legacy-cite-block');

    const redactCitations: CitationEntry[] = [
      {
        docId: 'doc-legacy-2',
        chunkId: 1,
        title: `Title ${legacySecret}`,
        score: 0.9,
        snippet: `Use ${legacySecret} here`,
      },
    ];
    const redactPayload = {
      ...redactSeed,
      citations: redactCitations,
      runtime: { ...redactSeed.runtime, citations: redactCitations },
    };
    delete (redactPayload.runtime as { output?: unknown }).output;
    const encRedact = encrypt(JSON.stringify(redactPayload));
    getDb()
      .prepare(
        'UPDATE x_support_runtime_turns SET masked_response_encrypted = ?, iv = ?, auth_tag = ? WHERE tenant_id = ? AND request_id = ?',
      )
      .run(encRedact.encrypted, encRedact.iv, encRedact.authTag, tenant.id, 'req-legacy-cite-redact');

    saveSupportOutputPolicy({
      tenantId: tenant.id,
      expectedVersion: 0,
      policy: {
        mode: 'enforce',
        blockedTerms: [{ id: 'legacy-cite-rule', text: legacyBlocked }],
        maxOutputChars: 16000,
        redactCredentials: true,
      },
    });

    const replayedBlocked = await executeSupportTurn({
      tenant,
      userContext: customerCtx,
      input: {
        tenantKey: tenant.publicKey,
        requestId: 'req-legacy-cite-block',
        messages: [{ role: 'user', content: 'Legacy retrieval guide details' }],
      },
      generate: async () => {
        throw new Error('Should not invoke provider on replay');
      },
    });
    expect(replayedBlocked.runtime.replayed).toBe(true);
    expect(replayedBlocked.reply).toBe(SUPPORT_OUTPUT_BLOCK_NOTICE);
    expect(replayedBlocked.runtime.replySource).toBe('output_policy_notice');
    expect(replayedBlocked.citations).toBeUndefined();
    expect(replayedBlocked.runtime.citations).toBeUndefined();
    expect('citations' in replayedBlocked).toBe(false);
    expect('citations' in replayedBlocked.runtime).toBe(false);
    expect(JSON.stringify(replayedBlocked)).not.toContain(legacyBlocked);

    const replayedRedacted = await executeSupportTurn({
      tenant,
      userContext: customerCtx,
      input: {
        tenantKey: tenant.publicKey,
        requestId: 'req-legacy-cite-redact',
        messages: [{ role: 'user', content: 'Legacy retrieval guide details' }],
      },
      generate: async () => {
        throw new Error('Should not invoke provider on replay');
      },
    });
    expect(replayedRedacted.runtime.replayed).toBe(true);
    expect(replayedRedacted.runtime.output?.action).toBe('redact');
    expect(replayedRedacted.citations).toHaveLength(1);
    expect(replayedRedacted.citations![0].title).toContain('[REDACTED_TOKEN]');
    expect(replayedRedacted.citations![0].snippet).toContain('[REDACTED_TOKEN]');
    expect(replayedRedacted.runtime.citations).toEqual(replayedRedacted.citations);
    expect(JSON.stringify(replayedRedacted)).not.toContain(legacySecret);
  });

  it('masks userContext and runs 020 output evaluation before persistence on zero-model abstention', async () => {
    updateSupportEvidencePolicy(tenant.id, {
      mode: 'required',
      includeLegacyDocs: false,
      topK: 3,
      minCoverage: 0.25,
    }, 1);

    const emailCtx: SupportUserContext = {
      ...customerCtx,
      email: 'alice.private@example.com',
    };

    const res = await executeSupportTurn({
      tenant,
      userContext: emailCtx,
      input: {
        tenantKey: tenant.publicKey,
        requestId: 'req-abstention-mask-1',
        messages: [{ role: 'user', content: 'Unknown question xyz987 my email is bob@example.com' }],
      },
      generate: async () => {
        throw new Error('Should not call provider on zero-model abstention');
      },
    });

    expect(res.runtime.replySource).toBe('knowledge_abstention');
    expect(res.runtime.evidence?.reason).toBe('no_matches');
    expect(res.userContext.email).not.toBe('alice.private@example.com');
    expect(res.runtime.redactionCount).toBe(1);
    expect(res.runtime.output?.action).toBe('allow');
  });
});
