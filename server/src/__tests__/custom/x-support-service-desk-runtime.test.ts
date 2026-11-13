import { describe, it, expect, beforeEach, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { createSupportTenant, type SupportTenant, type SupportUserContext } from '../../custom/x-gateway/support-store.js';
import { executeSupportTurn } from '../../custom/x-gateway/support-runtime.js';
import {
  getSupportDeskWidgetConfig,
  readSupportDeskBoundIntake,
  readSupportDeskIntake,
  saveSupportDeskIntake,
  updateSupportDeskWidgetConfig,
} from '../../custom/x-gateway/support-service-desk-store.js';
import { computeSupportDeskIntakeSchemaHash } from '../../custom/x-gateway/support-widget-profile.js';
import {
  getSupportConversationForUser,
  listSupportConversations,
} from '../../custom/x-gateway/support-workflows.js';
import { updateSupportEvidencePolicy } from '../../custom/x-gateway/support-evidence-store.js';
import { updateSupportMaskingPolicy } from '../../custom/x-gateway/support-knowledge.js';
import { updateSupportGuardrailPolicy, getSupportUserQuotaStatus } from '../../custom/x-gateway/support-guardrails.js';

describe('Support Service Desk Runtime & Intake Gate (Spec 019)', () => {
  let tenant: SupportTenant;
  let otherTenant: SupportTenant;
  let customerCtx: SupportUserContext;
  let guestUnsignedCtx: SupportUserContext;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    tenant = createSupportTenant({ name: 'Runtime Intake Tenant', defaultModel: 'test-model', allowGuest: true }).tenant;
    otherTenant = createSupportTenant({ name: 'Other Tenant', defaultModel: 'test-model' }).tenant;
    customerCtx = {
      tenantId: tenant.id,
      userId: 'cust_1',
      role: 'customer',
      name: 'Alice',
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

  function enableRequiredIntake(fields = [
    { key: 'topic', label: 'Topic', type: 'text' as const, required: true },
    { key: 'contact_email', label: 'Email', type: 'email' as const, required: true },
  ]) {
    const cur = getSupportDeskWidgetConfig(tenant.id);
    return updateSupportDeskWidgetConfig(
      tenant.id,
      {
        enabled: true,
        intake: { required: true, fields },
      },
      cur.version,
    );
  }

  function mintReceipt(
    userId = customerCtx.userId,
    role: 'customer' | 'guest' | 'staff' | 'admin' = 'customer',
    reqId = 'intake_req_1',
    values: Record<string, string | number> = { topic: 'Billing', contact_email: 'alice@example.com' },
    targetTenantId = tenant.id,
  ) {
    const cfg = getSupportDeskWidgetConfig(targetTenantId);
    const schemaHash = computeSupportDeskIntakeSchemaHash(cfg);
    return saveSupportDeskIntake({
      tenantId: targetTenantId,
      userId,
      role,
      input: { requestId: reqId, configVersion: cfg.version, values },
      schemaHash,
      validatedValues: values,
    });
  }

  const okGenerate = async (reply = 'Hello!', prompt = 20, completion = 10) => ({
    reply,
    userContext: customerCtx,
    allowedTools: [],
    toolTrace: [],
    modelUsed: 'test-model',
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
  });

  it('1. preserves 017 off-mode unsigned guest chat and rejects unexpected intakeReceiptId when disabled', async () => {
    const offRes = await executeSupportTurn({
      tenant,
      userContext: guestUnsignedCtx,
      input: { tenantKey: tenant.publicKey, requestId: 'off_1', messages: [{ role: 'user', content: 'Hi' }] },
      generate: () => okGenerate('Off-mode reply'),
    });
    expect(offRes.reply).toBe('Off-mode reply');
    expect(offRes.runtime.intake).toBeUndefined();

    await expect(
      executeSupportTurn({
        tenant,
        userContext: customerCtx,
        input: {
          tenantKey: tenant.publicKey,
          requestId: 'off_2',
          intakeReceiptId: 'some_receipt',
          messages: [{ role: 'user', content: 'Hi' }],
        },
        generate: () => okGenerate(),
      }),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_input' });
  });

  it('2. rejects unsigned guest with 401 signed_session_required when intake is required', async () => {
    enableRequiredIntake();
    await expect(
      executeSupportTurn({
        tenant,
        userContext: guestUnsignedCtx,
        input: { tenantKey: tenant.publicKey, requestId: 'guest_req', messages: [{ role: 'user', content: 'Hi' }] },
        generate: () => okGenerate(),
      }),
    ).rejects.toMatchObject({ status: 401, code: 'signed_session_required' });
  });

  it('3. rejects absent intakeReceiptId with 428 intake_required on new conversation', async () => {
    enableRequiredIntake();
    await expect(
      executeSupportTurn({
        tenant,
        userContext: customerCtx,
        input: { tenantKey: tenant.publicKey, requestId: 'no_rcpt', messages: [{ role: 'user', content: 'Hi' }] },
        generate: () => okGenerate(),
      }),
    ).rejects.toMatchObject({ status: 428, code: 'intake_required' });
  });

  it('4. rejects wrong user, wrong tenant, or wrong role receipt with 404 intake_not_found', async () => {
    enableRequiredIntake();
    const receipt = mintReceipt('cust_1', 'customer', 'r_owner');

    await expect(
      executeSupportTurn({
        tenant,
        userContext: { ...customerCtx, userId: 'cust_2' },
        input: {
          tenantKey: tenant.publicKey,
          requestId: 'wrong_user',
          intakeReceiptId: receipt.intakeReceiptId,
          messages: [{ role: 'user', content: 'Hi' }],
        },
        generate: () => okGenerate(),
      }),
    ).rejects.toMatchObject({ status: 404, code: 'intake_not_found' });

    await expect(
      executeSupportTurn({
        tenant,
        userContext: { ...customerCtx, role: 'staff' },
        input: {
          tenantKey: tenant.publicKey,
          requestId: 'wrong_role',
          intakeReceiptId: receipt.intakeReceiptId,
          messages: [{ role: 'user', content: 'Hi' }],
        },
        generate: () => okGenerate(),
      }),
    ).rejects.toMatchObject({ status: 404, code: 'intake_not_found' });

    // Other tenant
    const otherCfg = getSupportDeskWidgetConfig(otherTenant.id);
    updateSupportDeskWidgetConfig(
      otherTenant.id,
      { enabled: true, intake: { required: true, fields: [{ key: 'topic', label: 'Topic', type: 'text', required: true }] } },
      otherCfg.version,
    );
    await expect(
      executeSupportTurn({
        tenant: otherTenant,
        userContext: { ...customerCtx, tenantId: otherTenant.id },
        input: {
          tenantKey: otherTenant.publicKey,
          requestId: 'wrong_tenant',
          intakeReceiptId: receipt.intakeReceiptId,
          messages: [{ role: 'user', content: 'Hi' }],
        },
        generate: () => okGenerate(),
      }),
    ).rejects.toMatchObject({ status: 404, code: 'intake_not_found' });
  });

  it('5. rejects expired receipt with 410 intake_expired', async () => {
    enableRequiredIntake();
    const receipt = mintReceipt('cust_1', 'customer', 'r_exp');
    getDb()
      .prepare('UPDATE x_support_desk_intakes SET expires_at = ? WHERE tenant_id = ?')
      .run('2020-01-01T00:00:00.000Z', tenant.id);

    await expect(
      executeSupportTurn({
        tenant,
        userContext: customerCtx,
        input: {
          tenantKey: tenant.publicKey,
          requestId: 'exp_turn',
          intakeReceiptId: receipt.intakeReceiptId,
          messages: [{ role: 'user', content: 'Hi' }],
        },
        generate: () => okGenerate(),
      }),
    ).rejects.toMatchObject({ status: 410, code: 'intake_expired' });
  });

  it('6. rejects stale schema receipt with 409 intake_schema_changed, but preserves receipt across appearance-only edits', async () => {
    const cfg1 = enableRequiredIntake();
    const receipt = mintReceipt('cust_1', 'customer', 'r_schema');

    // Appearance-only edit does NOT change schemaHash
    const cfg2 = updateSupportDeskWidgetConfig(
      tenant.id,
      { appearance: { ...cfg1.appearance, title: 'New Brand Title' } },
      cfg1.version,
    );
    const res1 = await executeSupportTurn({
      tenant,
      userContext: customerCtx,
      input: {
        tenantKey: tenant.publicKey,
        requestId: 'appearance_ok',
        intakeReceiptId: receipt.intakeReceiptId,
        messages: [{ role: 'user', content: 'Hello' }],
      },
      generate: () => okGenerate(),
    });
    expect(res1.runtime.intake?.schemaHash).toBe(receipt.schemaHash);

    // Schema field edit invalidates old receipt
    updateSupportDeskWidgetConfig(
      tenant.id,
      { intake: { required: true, fields: [{ key: 'order_id', label: 'Order', type: 'text', required: true }] } },
      cfg2.version,
    );
    const receipt2 = mintReceipt('cust_1', 'customer', 'r_schema_2', { order_id: 'ORD-1' });
    // Now change schema again before using receipt2
    const cfg3 = getSupportDeskWidgetConfig(tenant.id);
    updateSupportDeskWidgetConfig(
      tenant.id,
      { intake: { required: true, fields: [{ key: 'account_id', label: 'Account', type: 'text', required: true }] } },
      cfg3.version,
    );

    await expect(
      executeSupportTurn({
        tenant,
        userContext: customerCtx,
        input: {
          tenantKey: tenant.publicKey,
          requestId: 'stale_schema_turn',
          intakeReceiptId: receipt2.intakeReceiptId,
          messages: [{ role: 'user', content: 'Hello' }],
        },
        generate: () => okGenerate(),
      }),
    ).rejects.toMatchObject({ status: 409, code: 'intake_schema_changed' });
  });

  it('7. atomically binds receipt in zero-model evidence abstention branch without storing raw values in settings', async () => {
    enableRequiredIntake();
    updateSupportEvidencePolicy(tenant.id, { mode: 'required' }, 1);
    const receipt = mintReceipt('cust_1', 'customer', 'r_zero');

    const res = await executeSupportTurn({
      tenant,
      userContext: customerCtx,
      input: {
        tenantKey: tenant.publicKey,
        requestId: 'zero_model_turn',
        intakeReceiptId: receipt.intakeReceiptId,
        messages: [{ role: 'user', content: 'Unknown policy question' }],
      },
      generate: async () => {
        throw new Error('Provider should not be called on zero-model abstention');
      },
    });

    expect(res.runtime.replySource).toBe('knowledge_abstention');
    expect(res.runtime.intake).toEqual({
      schemaHash: receipt.schemaHash,
      submittedAt: expect.any(String),
    });

    // Settings must NOT contain raw submitted values or receiptHash in public projection
    const rawSettings = getDb()
      .prepare("SELECT value FROM settings WHERE key = 'x_gateway_support_conversations_v1'")
      .get() as { value: string };
    expect(rawSettings.value).not.toContain('alice@example.com');
    expect(rawSettings.value).not.toContain('Billing');

    const bound = readSupportDeskBoundIntake({
      tenantId: tenant.id,
      conversationId: res.runtime.conversationId!,
      userId: 'cust_1',
    });
    expect(bound?.values).toEqual({ topic: 'Billing', contact_email: 'alice@example.com' });
  });

  it('8. does not consume receipt on provider failure or quota exceeded and allows retry', async () => {
    enableRequiredIntake();
    const receipt = mintReceipt('cust_1', 'customer', 'r_retry');

    // Provider fallback failure
    await expect(
      executeSupportTurn({
        tenant,
        userContext: customerCtx,
        input: {
          tenantKey: tenant.publicKey,
          requestId: 'fail_turn_1',
          intakeReceiptId: receipt.intakeReceiptId,
          messages: [{ role: 'user', content: 'Hi' }],
        },
        generate: async () => ({
          reply: 'fallback',
          userContext: customerCtx,
          allowedTools: [],
          toolTrace: [],
          modelUsed: 'test-model',
          usedFallback: true,
        }),
      }),
    ).rejects.toMatchObject({ status: 503, code: 'model_unavailable' });

    const storedAfterFail = readSupportDeskIntake({
      tenantId: tenant.id,
      userId: 'cust_1',
      role: 'customer',
      receiptId: receipt.intakeReceiptId,
    });
    expect(storedAfterFail.conversationId).toBeNull();

    // Quota exceeded failure (1 request was already used by the fallback attempt above)
    updateSupportGuardrailPolicy(String(tenant.id), {
      enabled: true,
      roleQuotas: { customer: { maxRequestsPerWindow: 1, maxTokensPerWindow: 100, windowSeconds: 3600 } },
    });
    await expect(
      executeSupportTurn({
        tenant,
        userContext: customerCtx,
        input: {
          tenantKey: tenant.publicKey,
          requestId: 'fail_turn_quota',
          intakeReceiptId: receipt.intakeReceiptId,
          messages: [{ role: 'user', content: 'Hi' }],
        },
        generate: () => okGenerate(),
      }),
    ).rejects.toMatchObject({ status: 429, code: 'quota_exceeded' });

    // Restore quota and retry with fresh requestId -> succeeds
    updateSupportGuardrailPolicy(String(tenant.id), {
      enabled: true,
      roleQuotas: { customer: { maxRequestsPerWindow: 50, maxTokensPerWindow: 50000, windowSeconds: 3600 } },
    });
    const success = await executeSupportTurn({
      tenant,
      userContext: customerCtx,
      input: {
        tenantKey: tenant.publicKey,
        requestId: 'retry_ok',
        intakeReceiptId: receipt.intakeReceiptId,
        messages: [{ role: 'user', content: 'Hi' }],
      },
      generate: () => okGenerate(),
    });
    expect(success.runtime.conversationId).toMatch(/^conv_/);
    expect(success.runtime.intake?.schemaHash).toBe(receipt.schemaHash);
  });

  it('9. discards model result and reconciles incurred tokens if schema changes mid-provider', async () => {
    const cfg = enableRequiredIntake();
    const receipt = mintReceipt('cust_1', 'customer', 'r_mid');

    await expect(
      executeSupportTurn({
        tenant,
        userContext: customerCtx,
        input: {
          tenantKey: tenant.publicKey,
          requestId: 'mid_schema_turn',
          intakeReceiptId: receipt.intakeReceiptId,
          messages: [{ role: 'user', content: 'Hi' }],
        },
        generate: async (ctx) => {
          ctx.beforeModelCall([{ role: 'user', content: 'Hi' }]);
          // Mutate schema mid-flight
          updateSupportDeskWidgetConfig(
            tenant.id,
            { intake: { required: true, fields: [{ key: 'new_field', label: 'New', type: 'text', required: true }] } },
            cfg.version,
          );
          ctx.recordModelUsage({ prompt_tokens: 40, completion_tokens: 15, total_tokens: 55 });
          return okGenerate('Should be discarded', 40, 15);
        },
      }),
    ).rejects.toMatchObject({ status: 409, code: 'intake_schema_changed' });

    // Conversation was not created, receipt was not bound, and 55 tokens were reconciled
    expect(listSupportConversations(String(tenant.id))).toHaveLength(0);
    expect(
      readSupportDeskIntake({
        tenantId: tenant.id,
        userId: 'cust_1',
        role: 'customer',
        receiptId: receipt.intakeReceiptId,
      }).conversationId,
    ).toBeNull();
    expect(getSupportUserQuotaStatus(String(tenant.id), { userId: 'cust_1', userRole: 'customer' }).tokensUsed).toBe(55);
  });

  it('10. prevents binding one receipt to two different conversations and allows continuation on same conversation', async () => {
    enableRequiredIntake();
    const receipt = mintReceipt('cust_1', 'customer', 'r_bind_once');

    const first = await executeSupportTurn({
      tenant,
      userContext: customerCtx,
      input: {
        tenantKey: tenant.publicKey,
        requestId: 'conv_first_1',
        intakeReceiptId: receipt.intakeReceiptId,
        messages: [{ role: 'user', content: 'First msg' }],
      },
      generate: () => okGenerate('Reply 1'),
    });
    const convId = first.runtime.conversationId!;

    // Continue same conversation WITHOUT repeating intakeReceiptId
    const second = await executeSupportTurn({
      tenant,
      userContext: customerCtx,
      input: {
        tenantKey: tenant.publicKey,
        requestId: 'conv_first_2',
        conversationId: convId,
        messages: [{ role: 'user', content: 'Follow up' }],
      },
      generate: () => okGenerate('Reply 2'),
    });
    expect(second.runtime.conversationId).toBe(convId);
    expect(second.runtime.intake?.schemaHash).toBe(receipt.schemaHash);

    // Attempt to bind same receipt to a DIFFERENT new conversation -> 409 intake_already_bound
    await expect(
      executeSupportTurn({
        tenant,
        userContext: customerCtx,
        input: {
          tenantKey: tenant.publicKey,
          requestId: 'conv_second_1',
          intakeReceiptId: receipt.intakeReceiptId,
          messages: [{ role: 'user', content: 'Different conv' }],
        },
        generate: () => okGenerate(),
      }),
    ).rejects.toMatchObject({ status: 409, code: 'intake_already_bound' });
  });

  it('11. replays accepted turn without second charge and rejects receipt change under same requestId', async () => {
    enableRequiredIntake();
    const r1 = mintReceipt('cust_1', 'customer', 'r_rep_1');
    const r2 = mintReceipt('cust_1', 'customer', 'r_rep_2');

    let calls = 0;
    const first = await executeSupportTurn({
      tenant,
      userContext: customerCtx,
      input: {
        tenantKey: tenant.publicKey,
        requestId: 'replay_id_1',
        intakeReceiptId: r1.intakeReceiptId,
        messages: [{ role: 'user', content: 'Hi' }],
      },
      generate: async () => {
        calls++;
        return okGenerate('Once', 12, 8);
      },
    });
    expect(first.runtime.replayed).toBe(false);

    const replayed = await executeSupportTurn({
      tenant,
      userContext: customerCtx,
      input: {
        tenantKey: tenant.publicKey,
        requestId: 'replay_id_1',
        intakeReceiptId: r1.intakeReceiptId,
        messages: [{ role: 'user', content: 'Hi' }],
      },
      generate: async () => {
        calls++;
        return okGenerate('Twice', 12, 8);
      },
    });
    expect(replayed.runtime.replayed).toBe(true);
    expect(calls).toBe(1);

    await expect(
      executeSupportTurn({
        tenant,
        userContext: customerCtx,
        input: {
          tenantKey: tenant.publicKey,
          requestId: 'replay_id_1',
          intakeReceiptId: r2.intakeReceiptId,
          messages: [{ role: 'user', content: 'Hi' }],
        },
        generate: () => okGenerate(),
      }),
    ).rejects.toMatchObject({ status: 409, code: 'request_conflict' });
  });

  it('12. hydrates masked intake values on canonical reads without exposing internal receiptHash', async () => {
    enableRequiredIntake();
    updateSupportMaskingPolicy(String(tenant.id), { maskEmail: true, exemptRoles: ['admin'] });
    const receipt = mintReceipt('cust_1', 'customer', 'r_hydrate');

    const res = await executeSupportTurn({
      tenant,
      userContext: customerCtx,
      input: {
        tenantKey: tenant.publicKey,
        requestId: 'hydrate_turn',
        intakeReceiptId: receipt.intakeReceiptId,
        messages: [{ role: 'user', content: 'Hello' }],
      },
      generate: () => okGenerate(),
    });

    const convAsCustomer = getSupportConversationForUser(String(tenant.id), res.runtime.conversationId!, {
      userId: 'cust_1',
      role: 'customer',
    });
    expect(convAsCustomer.intake?.schemaHash).toBe(receipt.schemaHash);
    expect(convAsCustomer.intake?.values?.topic).toBe('Billing');
    expect(String(convAsCustomer.intake?.values?.contact_email)).not.toContain('alice@example.com');
    expect((convAsCustomer.intake as Record<string, unknown>)?.receiptHash).toBeUndefined();

    const convAsAdmin = getSupportConversationForUser(String(tenant.id), res.runtime.conversationId!, {
      userId: 'admin_1',
      role: 'admin',
    });
    expect(convAsAdmin.intake?.values?.contact_email).toBe('alice@example.com');
  });

  it('rejects a turn if required intake is enabled while its provider is running', async () => {
    await expect(executeSupportTurn({tenant,userContext:customerCtx,
      input:{tenantKey:tenant.publicKey,requestId:'enable_mid_turn',messages:[{role:'user',content:'Help'}]},
      generate:async()=>{enableRequiredIntake();return okGenerate('discard this output');},
    })).rejects.toMatchObject({status:409,code:'intake_schema_changed'});
    expect(listSupportConversations(String(tenant.id))).toHaveLength(0);
  });
});
