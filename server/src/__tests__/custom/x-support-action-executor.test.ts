import { ensureExecutionTables } from '../../custom/x-gateway/support-action-executor.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import {
  createSupportTenant,
  createSupportTool,
  updateSupportTool,
  type SupportTenant,
  type SupportWebhookTool,
  type SupportUserContext,
} from '../../custom/x-gateway/support-store.js';
import {
  invokeSupportRuntimeWebhook,
  reviewAndExecuteSupportAction,
  SupportActionExecutionError,
} from '../../custom/x-gateway/support-action-executor.js';
import { listSupportEventOutbox } from '../../custom/x-gateway/support-event-outbox.js';
import { upsertSupportWebhookSubscription } from '../../custom/x-gateway/support-crm-webhooks.js';

describe('Support Action Executor (US3)', () => {
  let tenant: SupportTenant;
  let getTool: SupportWebhookTool;
  let postTool: SupportWebhookTool;

  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');

    const created = createSupportTenant({
      name: 'Alpha Corp',
      slug: 'alpha-corp',
    });
    tenant = created.tenant;

    getTool = createSupportTool(tenant.id, {
      name: 'lookup_user',
      description: 'Look up user',
      method: 'GET',
      endpointUrl: 'https://partner.example.com/api/users',
      allowedRoles: ['customer', 'admin'],
      lockUserIdParam: 'uid',
      bypassUserLockRoles: ['admin'],
    });

    postTool = createSupportTool(tenant.id, {
      name: 'update_subscription',
      description: 'Update user subscription',
      method: 'POST',
      endpointUrl: 'https://partner.example.com/api/subscriptions',
      allowedRoles: ['customer', 'admin'],
      lockUserIdParam: 'userId',
      bypassUserLockRoles: ['admin'],
    });

    upsertSupportWebhookSubscription(String(tenant.id), {
      name: 'Action Events Hook',
      targetUrl: 'https://partner.example.com/events',
      events: ['action.approved', 'action.rejected'],
    });

    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  const makeContext = (role = 'customer', userId = 'cust_101'): SupportUserContext => ({
    tenantId: tenant.id,
    userId,
    name: 'Customer Alice',
    email: 'alice@example.com',
    role,
    permissions: ['orders:read'],
    verified: true,
  });

  describe('Tool classification (read vs approval_required)', () => {
    it('GET tool defaults to read and executes immediately without pending action', async () => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ found: true }), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      const res = await invokeSupportRuntimeWebhook({
        tenantId: tenant.id,
        context: makeContext('customer'),
        tool: getTool,
        args: { uid: 'spoofed_id' },
        requestId: 'req_1',
      });

      expect(res.ok).toBe(true);
      expect(res.status).toBe(200);
      expect(res.effectiveArgs.uid).toBe('cust_101'); // locked parameter enforced
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('POST tool defaults to approval_required: creates proposal snapshot, status 202, zero HTTP calls', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const res = await invokeSupportRuntimeWebhook({
        tenantId: tenant.id,
        context: makeContext('customer'),
        tool: postTool,
        args: { plan: 'pro', userId: 'spoofed_id' },
        requestId: 'req_2',
        conversationId: 'conv_123',
      });

      expect(res.ok).toBe(true);
      expect(res.status).toBe(202);
      expect(res.data).toMatchObject({
        pendingActionId: expect.stringMatching(/^act_/),
        executionStatus: 'pending',
      });
      expect(res.effectiveArgs.userId).toBe('cust_101');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('POST tool requires approval even if caller has admin role', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const res = await invokeSupportRuntimeWebhook({
        tenantId: tenant.id,
        context: makeContext('admin', 'admin_999'),
        tool: postTool,
        args: { plan: 'enterprise' },
        requestId: 'req_3',
      });

      expect(res.status).toBe(202);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('POST tool executes immediately when toolPolicy is explicitly set to read', async () => {
      // Set runtime policy in settings table
      const db = getDb();
      const policyStore = {
        [String(tenant.id)]: {
          toolPolicies: [{ toolId: postTool.id, mode: 'read' }],
        },
      };
      db.prepare(`
        INSERT INTO settings (key, value) VALUES ('x_support_runtime_policy_v1', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(JSON.stringify(policyStore));

      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ updated: true }), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      const res = await invokeSupportRuntimeWebhook({
        tenantId: tenant.id,
        context: makeContext('customer'),
        tool: postTool,
        args: { plan: 'pro' },
        requestId: 'req_4',
      });

      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('rejects disabled tool with 422', async () => {
      updateSupportTool(tenant.id, postTool.id, { enabled: false });
      const updated = { ...postTool, enabled: false };

      await expect(
        invokeSupportRuntimeWebhook({
          tenantId: tenant.id,
          context: makeContext('customer'),
          tool: updated,
          args: {},
          requestId: 'req_5',
        }),
      ).rejects.toMatchObject({ status: 422 });
    });
  });

  describe('Review and Execute state machine', () => {
    it('rejection updates action to failed, enqueues action.rejected, and makes zero HTTP calls', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const invocation = await invokeSupportRuntimeWebhook({
        tenantId: tenant.id,
        context: makeContext('customer'),
        tool: postTool,
        args: { plan: 'vip' },
        requestId: 'req_prop_1',
      });

      const actionId = (invocation.data as { pendingActionId: string }).pendingActionId;

      const reviewed = await reviewAndExecuteSupportAction({
        tenantId: tenant.id,
        actionId,
        decision: 'rejected',
        reviewedBy: 'staff_bob',
        reviewNote: 'Not eligible for upgrade',
      });

      expect(reviewed.status).toBe('rejected');
      expect(reviewed.executionStatus).toBe('failed');
      expect(reviewed.reviewedBy).toBe('staff_bob');
      expect(reviewed.reviewNote).toBe('Not eligible for upgrade');
      expect(fetchMock).not.toHaveBeenCalled();

      // Check event outbox has action.rejected
      const outbox = listSupportEventOutbox(tenant.id);
      expect(outbox.some((item) => item.event === 'action.rejected')).toBe(true);
    });

    it('approval claims atomically, restores original requester scope, passes Idempotency-Key, and succeeds', async () => {
      let capturedHeaders: Record<string, string> = {};
      const fetchMock = vi.fn(async (_url: unknown, init: unknown) => {
        capturedHeaders = (init as RequestInit).headers as Record<string, string>;
        return new Response(JSON.stringify({ success: true, newPlan: 'vip' }), { status: 200 });
      });
      vi.stubGlobal('fetch', fetchMock);

      const invocation = await invokeSupportRuntimeWebhook({
        tenantId: tenant.id,
        context: makeContext('customer', 'cust_101'),
        tool: postTool,
        args: { plan: 'vip' },
        requestId: 'req_prop_2',
      });
      const actionId = (invocation.data as { pendingActionId: string }).pendingActionId;

      const reviewed = await reviewAndExecuteSupportAction({
        tenantId: tenant.id,
        actionId,
        decision: 'approved',
        reviewedBy: 'supervisor_charlie',
        reviewNote: 'Approved manually',
      });

      expect(reviewed.status).toBe('approved');
      expect(reviewed.executionStatus).toBe('succeeded');
      expect(reviewed.executionResult).toEqual({ success: true, newPlan: 'vip' });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Verify original requester context was preserved in HTTP headers, NOT reviewer!
      expect(capturedHeaders['X-Support-User-Id']).toBe('cust_101');
      expect(capturedHeaders['X-Support-User-Role']).toBe('customer');
      expect(capturedHeaders['Idempotency-Key']).toBe(actionId);

      // Check event outbox has action.approved
      const outbox = listSupportEventOutbox(tenant.id);
      expect(outbox.some((item) => item.event === 'action.approved')).toBe(true);
    });

    it('replay terminal: subsequent approved review returns cached result without second HTTP call', async () => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ cached: 'result' }), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      const invocation = await invokeSupportRuntimeWebhook({
        tenantId: tenant.id,
        context: makeContext('customer'),
        tool: postTool,
        args: { plan: 'gold' },
        requestId: 'req_prop_3',
      });
      const actionId = (invocation.data as { pendingActionId: string }).pendingActionId;

      const first = await reviewAndExecuteSupportAction({
        tenantId: tenant.id,
        actionId,
        decision: 'approved',
        reviewedBy: 'admin',
      });
      expect(first.executionStatus).toBe('succeeded');
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Replay
      const second = await reviewAndExecuteSupportAction({
        tenantId: tenant.id,
        actionId,
        decision: 'approved',
        reviewedBy: 'admin',
      });
      expect(second.executionStatus).toBe('succeeded');
      expect(second.executionResult).toEqual({ cached: 'result' });
      expect(fetchMock).toHaveBeenCalledTimes(1); // No second HTTP call!
    });

    it('opposite terminal decision conflict: throws 409', async () => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      const invocation = await invokeSupportRuntimeWebhook({
        tenantId: tenant.id,
        context: makeContext('customer'),
        tool: postTool,
        args: { plan: 'silver' },
        requestId: 'req_prop_4',
      });
      const actionId = (invocation.data as { pendingActionId: string }).pendingActionId;

      await reviewAndExecuteSupportAction({
        tenantId: tenant.id,
        actionId,
        decision: 'approved',
        reviewedBy: 'admin',
      });

      // Attempting to reject an already-approved action throws 409
      await expect(
        reviewAndExecuteSupportAction({
          tenantId: tenant.id,
          actionId,
          decision: 'rejected',
          reviewedBy: 'admin',
        }),
      ).rejects.toMatchObject({ status: 409 });
    });

    it('missing or disabled tool at review time throws 422 with zero HTTP calls', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const invocation = await invokeSupportRuntimeWebhook({
        tenantId: tenant.id,
        context: makeContext('customer'),
        tool: postTool,
        args: { plan: 'bronze' },
        requestId: 'req_prop_5',
      });
      const actionId = (invocation.data as { pendingActionId: string }).pendingActionId;

      // Disable tool before review
      updateSupportTool(tenant.id, postTool.id, { enabled: false });

      await expect(
        reviewAndExecuteSupportAction({
          tenantId: tenant.id,
          actionId,
          decision: 'approved',
          reviewedBy: 'admin',
        }),
      ).rejects.toMatchObject({ status: 422 });

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('altered snapshot: tool target endpoint changed since proposal throws 409', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const invocation = await invokeSupportRuntimeWebhook({
        tenantId: tenant.id,
        context: makeContext('customer'),
        tool: postTool,
        args: { plan: 'gold' },
        requestId: 'req_prop_6',
      });
      const actionId = (invocation.data as { pendingActionId: string }).pendingActionId;

      // Tool URL updated to a different target
      updateSupportTool(tenant.id, postTool.id, {
        endpointUrl: 'https://partner.example.com/api/v2/new-target',
      });

      await expect(
        reviewAndExecuteSupportAction({
          tenantId: tenant.id,
          actionId,
          decision: 'approved',
          reviewedBy: 'admin',
        }),
      ).rejects.toMatchObject({ status: 409 });

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('altered snapshot: tool schema changed since proposal throws 409', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const invocation = await invokeSupportRuntimeWebhook({
        tenantId: tenant.id,
        context: makeContext('customer'),
        tool: postTool,
        args: { plan: 'gold' },
        requestId: 'req_prop_7',
      });
      const actionId = (invocation.data as { pendingActionId: string }).pendingActionId;

      // Tool schema updated
      updateSupportTool(tenant.id, postTool.id, {
        parametersSchema: { type: 'object', properties: { newField: { type: 'string' } }, required: ['newField'] },
      });

      await expect(
        reviewAndExecuteSupportAction({
          tenantId: tenant.id,
          actionId,
          decision: 'approved',
          reviewedBy: 'admin',
        }),
      ).rejects.toMatchObject({ status: 409 });

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('unknown network outcome: network timeout/crash records status=unknown and no auto-retry', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Connection timed out')));

      const invocation = await invokeSupportRuntimeWebhook({
        tenantId: tenant.id,
        context: makeContext('customer'),
        tool: postTool,
        args: { plan: 'vip' },
        requestId: 'req_prop_8',
      });
      const actionId = (invocation.data as { pendingActionId: string }).pendingActionId;

      const reviewed = await reviewAndExecuteSupportAction({
        tenantId: tenant.id,
        actionId,
        decision: 'approved',
        reviewedBy: 'admin',
      });

      expect(reviewed.executionStatus).toBe('unknown');
      expect(reviewed.status).toBe('approved');
      expect(reviewed.executionResult).toMatchObject({
        error: expect.stringContaining('Connection timed out'),
      });

      // Subsequent review of unknown state throws 409 requiring manual reconciliation
      await expect(
        reviewAndExecuteSupportAction({
          tenantId: tenant.id,
          actionId,
          decision: 'approved',
          reviewedBy: 'admin',
        }),
      ).rejects.toMatchObject({ status: 409 });
    });

    it('legacy proposals without execution snapshot throw 409 requiring re-proposal', async () => {
      await expect(
        reviewAndExecuteSupportAction({
          tenantId: tenant.id,
          actionId: 'act_legacy_without_snapshot',
          decision: 'approved',
          reviewedBy: 'admin',
        }),
      ).rejects.toThrow(SupportActionExecutionError);
    });

    it('concurrent approval: two concurrent approve reviews result in only one HTTP call', async () => {
      let callCount = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          callCount++;
          await new Promise((r) => setTimeout(r, 20));
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }),
      );

      const invocation = await invokeSupportRuntimeWebhook({
        tenantId: tenant.id,
        context: makeContext('customer'),
        tool: postTool,
        args: { plan: 'vip' },
        requestId: 'req_prop_conc',
      });
      const actionId = (invocation.data as { pendingActionId: string }).pendingActionId;

      // Two concurrent approve calls
      const p1 = reviewAndExecuteSupportAction({
        tenantId: tenant.id,
        actionId,
        decision: 'approved',
        reviewedBy: 'reviewer_1',
      });

      const p2 = reviewAndExecuteSupportAction({
        tenantId: tenant.id,
        actionId,
        decision: 'approved',
        reviewedBy: 'reviewer_2',
      });

      const results = await Promise.allSettled([p1, p2]);
      // Exactly one succeeds with HTTP dispatch; the second either gets 409 (claimed/executing) or returns the terminal result
      expect(callCount).toBe(1);

      const successes = results.filter((r) => r.status === 'fulfilled');
      expect(successes.length).toBeGreaterThanOrEqual(1);
    });
  });
  it('rejects invalid declared arguments before creating a proposal', async () => {
    ensureExecutionTables();
    const tool = updateSupportTool(tenant.id, postTool.id, { parametersSchema: { type: 'object', required: ['amount'], properties: { amount: { type: 'number', minimum: 1 } } } });
    await expect(invokeSupportRuntimeWebhook({ tenantId: tenant.id, context: makeContext(), tool, args: { amount: -1 }, requestId: 'invalid-args' })).rejects.toMatchObject({ status: 422 });
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM x_support_action_executions').get()).toEqual({ n: 0 });
  });

  it('preserves the approval decision when execution fails and replays without dispatch', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    const proposal = await invokeSupportRuntimeWebhook({ tenantId: tenant.id, context: makeContext(), tool: postTool, args: {}, requestId: 'failed-approval' });
    const actionId = (proposal.data as { pendingActionId: string }).pendingActionId;
    const review = { tenantId: tenant.id, actionId, decision: 'approved' as const, reviewedBy: 'staff' };
    expect(await reviewAndExecuteSupportAction(review)).toMatchObject({ status: 'approved', executionStatus: 'failed' });
    expect(await reviewAndExecuteSupportAction(review)).toMatchObject({ status: 'approved', executionStatus: 'failed' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(reviewAndExecuteSupportAction({ ...review, decision: 'rejected' })).rejects.toMatchObject({ status: 409 });
  });

  it('recovers an abandoned executing action as unknown without another HTTP call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const proposal = await invokeSupportRuntimeWebhook({ tenantId: tenant.id, context: makeContext(), tool: postTool, args: {}, requestId: 'crashed-action' });
    const actionId = (proposal.data as { pendingActionId: string }).pendingActionId;
    getDb().prepare("UPDATE x_support_action_executions SET status = 'executing', decision = 'approved', updated_at = ? WHERE action_id = ?").run(new Date(Date.now() - 180000).toISOString(), actionId);
    await expect(reviewAndExecuteSupportAction({ tenantId: tenant.id, actionId, decision: 'approved', reviewedBy: 'staff' })).rejects.toMatchObject({ status: 409 });
    expect(getDb().prepare('SELECT status FROM x_support_action_executions WHERE action_id = ?').get(actionId)).toEqual({ status: 'unknown' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('detects case-sensitive endpoint changes before approval dispatch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const proposal = await invokeSupportRuntimeWebhook({ tenantId: tenant.id, context: makeContext(), tool: postTool, args: {}, requestId: 'case-target' });
    updateSupportTool(tenant.id, postTool.id, { endpointUrl: 'https://partner.example.com/api/Subscriptions' });
    await expect(reviewAndExecuteSupportAction({ tenantId: tenant.id, actionId: (proposal.data as { pendingActionId: string }).pendingActionId, decision: 'approved', reviewedBy: 'staff' })).rejects.toMatchObject({ status: 409 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps an unknown outcome fenced when an old dispatch returns late', async () => {
    let finish!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    const proposal = await invokeSupportRuntimeWebhook({ tenantId: tenant.id, context: makeContext(), tool: postTool, args: {}, requestId: 'late-action' });
    const actionId = (proposal.data as { pendingActionId: string }).pendingActionId;
    const review = { tenantId: tenant.id, actionId, decision: 'approved' as const, reviewedBy: 'staff' };
    const executing = reviewAndExecuteSupportAction(review);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    getDb().prepare('UPDATE x_support_action_executions SET updated_at = ? WHERE action_id = ?').run(new Date(Date.now() - 180000).toISOString(), actionId);
    await expect(reviewAndExecuteSupportAction(review)).rejects.toMatchObject({ status: 409 });
    finish(new Response('{}', { status: 200 }));
    await expect(executing).rejects.toMatchObject({ status: 409 });
    expect(getDb().prepare('SELECT status FROM x_support_action_executions WHERE action_id = ?').get(actionId)).toEqual({ status: 'unknown' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

});
