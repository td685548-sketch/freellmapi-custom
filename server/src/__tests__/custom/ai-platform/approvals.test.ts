import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, initDb } from '../../../db/index.js';
import { resetFlagsCacheForTests, setFlags } from '../../../custom/ai-platform/flags.js';
import { setBindings } from '../../../custom/ai-platform/mcp-client/bindings.js';
import {
  createServer,
  listServerTools,
  reviewTool,
  setAllowedInternalOrigins,
  syncServerTools,
  updateServer,
} from '../../../custom/ai-platform/mcp-client/registry.js';
import { startFakeMcpHttpServer } from '../../helpers/ai-platform-fake-mcp-http.js';
import type { McpTransportClient } from '../../../custom/ai-platform/mcp-client/store.js';
import {
  approveAction,
  expireApprovals,
  listApprovals,
  rejectAction,
  requestToolApproval,
  type WriteApprovalExecutor,
} from '../../../custom/ai-platform/orchestrator/approvals.js';

function createProfile(name = 'test-profile'): number {
  const res = getDb()
    .prepare(
      `INSERT INTO client_profiles (name, token_hash, encrypted_key, iv, auth_tag, enabled)
       VALUES (?, ?, 'enc', 'iv', 'tag', 1)`,
    )
    .run(name, `hash_${name}_${Math.random()}`);
  return Number(res.lastInsertRowid);
}

function makeFakeTransport(schemaDescription = 'Refund an order'): McpTransportClient {
  return {
    async mcpInitialize(config) {
      return {
        serverId: config.serverId,
        revision: config.revision,
        credentialGeneration: config.credentialGeneration,
        origin: new URL(config.url).origin,
        sessionId: 'sess-1',
        protocolVersion: '2025-06-18',
        serverInfo: { name: 'fake-mcp' },
      };
    },
    async mcpListTools() {
      return [
        {
          name: 'refund_order',
          description: schemaDescription,
          inputSchema: {
            type: 'object',
            properties: { orderId: { type: 'string' }, email: { type: 'string' } },
            required: ['orderId'],
          },
        },
      ];
    },
  };
}

async function setupBoundWriteTool(profileId: number) {
  const server = await createServer(
    {
      slug: 'billing',
      name: 'Billing MCP',
      url: 'https://mcp.example.com/v1',
      authKind: 'none',
    },
    1,
  );
  await syncServerTools(server.id, 1, undefined, makeFakeTransport());
  const tools = listServerTools(server.id);
  const refundTool = tools[0]!;
  reviewTool(refundTool.id, { state: 'allowed', effect: 'write' }, 1);
  setBindings({ kind: 'profile', id: String(profileId) }, { toolIds: [refundTool.id], enabled: true });

  const boundTool = {
    toolId: refundTool.id,
    serverId: server.id,
    serverSlug: server.slug,
    name: refundTool.name,
    exposedName: refundTool.exposedName,
    description: refundTool.description,
    inputSchema: refundTool.inputSchema,
    outputSchema: refundTool.outputSchema,
    schemaHash: refundTool.schemaHash,
    effect: 'write' as const,
    timeoutMs: server.timeoutMs,
    maxResultBytes: server.maxResultBytes,
    maxConcurrency: server.maxConcurrency,
  };
  return { server, refundTool, boundTool };
}

beforeEach(() => {
  initDb(':memory:');
  resetFlagsCacheForTests();
  setFlags({ mcpClient: true });
});

afterEach(() => {
  vi.useRealTimers();
  resetFlagsCacheForTests();
  try { getDb().close(); } catch { /* already closed */ }
});

describe('MCP Approvals (T039/T047)', () => {
  it('encrypts args at rest, masks public views, and scopes execution_key per turn', async () => {
    const profileId = createProfile();
    const { boundTool } = await setupBoundWriteTool(profileId);
    const ac = new AbortController();

    const first = await requestToolApproval(
      {
        scope: { kind: 'profile', id: String(profileId) },
        endUser: 'eu-1',
        turnId: 'turn-1',
        stepSeq: 1,
        signal: ac.signal,
      },
      boundTool,
      { orderId: 'ORD-100', email: 'alice@example.com' },
    );

    const second = await requestToolApproval(
      {
        scope: { kind: 'profile', id: String(profileId) },
        endUser: 'eu-1',
        turnId: 'turn-2',
        stepSeq: 1,
        signal: ac.signal,
      },
      boundTool,
      { orderId: 'ORD-100', email: 'alice@example.com' },
    );

    expect(first.executionKey).not.toBe(second.executionKey);

    const raw = getDb()
      .prepare('SELECT args_ciphertext, args_iv, args_tag, args_masked FROM custom_ai_approvals WHERE id = ?')
      .get(first.approvalId) as { args_ciphertext: string; args_iv: string; args_tag: string; args_masked: string };
    expect(raw.args_ciphertext).toBeTruthy();
    expect(raw.args_iv).toBeTruthy();
    expect(raw.args_tag).toBeTruthy();
    expect(raw.args_ciphertext).not.toContain('alice@example.com');
    expect(raw.args_masked).not.toContain('alice@example.com');

    const listed = listApprovals({ status: 'pending' });
    expect(listed).toHaveLength(2);
    expect(JSON.stringify(listed)).not.toContain('alice@example.com');
    expect((listed[0] as unknown as Record<string, unknown>).args_ciphertext).toBeUndefined();
    expect((listed[0] as unknown as Record<string, unknown>).argsCiphertext).toBeUndefined();
  });

  it('executes exactly once on concurrent approveAction calls and returns 409 already_decided to the loser', async () => {
    const profileId = createProfile();
    const { boundTool } = await setupBoundWriteTool(profileId);
    const ac = new AbortController();

    const { approvalId } = await requestToolApproval(
      {
        scope: { kind: 'profile', id: String(profileId) },
        endUser: 'eu-1',
        turnId: 'turn-race',
        stepSeq: 1,
        signal: ac.signal,
      },
      boundTool,
      { orderId: 'ORD-200' },
    );

    let dispatches = 0;
    const executor: WriteApprovalExecutor = {
      async executeClaimedWrite(ctx) {
        dispatches += 1;
        expect(ctx.args).toEqual({ orderId: 'ORD-200' });
        await new Promise((r) => setTimeout(r, 20));
        return {
          ok: true,
          status: 'succeeded',
          resultMasked: '{"refunded":true}',
          durationMs: 12,
          resultBytes: 17,
        };
      },
    };

    const [r1, r2] = await Promise.allSettled([
      approveAction(approvalId, 10, { note: 'approved-1' }, executor),
      approveAction(approvalId, 11, { note: 'approved-2' }, executor),
    ]);

    expect(dispatches).toBe(1);
    const fulfilled = [r1, r2].filter((r) => r.status === 'fulfilled');
    const rejected = [r1, r2].filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((fulfilled[0] as PromiseFulfilledResult<{ status: string }>).value.status).toBe('succeeded');
    expect((rejected[0]!.reason as { status?: number; code?: string }).status).toBe(409);
    expect((rejected[0]!.reason as { status?: number; code?: string }).code).toBe('already_decided');
  });

  it('never dispatches rejected or 24h-expired approvals', async () => {
    const profileId = createProfile();
    const { boundTool } = await setupBoundWriteTool(profileId);
    const ac = new AbortController();

    let dispatches = 0;
    const executor: WriteApprovalExecutor = {
      async executeClaimedWrite() {
        dispatches += 1;
        return { ok: true, status: 'succeeded', resultMasked: 'ok', durationMs: 1, resultBytes: 2 };
      },
    };

    const { approvalId: rejId } = await requestToolApproval(
      { scope: { kind: 'profile', id: String(profileId) }, endUser: null, turnId: 't-rej', stepSeq: 1, signal: ac.signal },
      boundTool,
      { orderId: 'ORD-301' },
    );
    const rejected = await rejectAction(rejId, 1, { note: 'no' });
    expect(rejected.status).toBe('rejected');
    await expect(approveAction(rejId, 1, undefined, executor)).rejects.toMatchObject({
      status: 409,
      code: 'already_decided',
    });

    const { approvalId: expId } = await requestToolApproval(
      { scope: { kind: 'profile', id: String(profileId) }, endUser: null, turnId: 't-exp', stepSeq: 1, signal: ac.signal },
      boundTool,
      { orderId: 'ORD-302' },
    );
    const future = new Date(Date.now() + 25 * 60 * 60 * 1000);
    expect(expireApprovals(future)).toBe(1);
    await expect(approveAction(expId, 1, undefined, executor)).rejects.toMatchObject({
      status: 409,
      code: 'already_decided',
    });
    expect(dispatches).toBe(0);
  });

  it('keeps unknown status locked and never re-dispatches executing/unknown', async () => {
    const profileId = createProfile();
    const { boundTool } = await setupBoundWriteTool(profileId);
    const ac = new AbortController();

    const { approvalId } = await requestToolApproval(
      { scope: { kind: 'profile', id: String(profileId) }, endUser: null, turnId: 't-unk', stepSeq: 1, signal: ac.signal },
      boundTool,
      { orderId: 'ORD-400' },
    );

    let dispatches = 0;
    const unknownExecutor: WriteApprovalExecutor = {
      async executeClaimedWrite() {
        dispatches += 1;
        return {
          ok: false,
          status: 'unknown',
          resultMasked: '',
          error: 'connection dropped after write',
          durationMs: 100,
          resultBytes: 0,
        };
      },
    };

    const res = await approveAction(approvalId, 1, undefined, unknownExecutor);
    expect(res.status).toBe('unknown');
    expect(dispatches).toBe(1);

    // Expiry sweep or re-approval must not change unknown or re-dispatch
    expect(expireApprovals(new Date(Date.now() + 48 * 60 * 60 * 1000))).toBe(0);
    await expect(approveAction(approvalId, 1, undefined, unknownExecutor)).rejects.toMatchObject({
      status: 409,
      code: 'already_decided',
    });
    expect(dispatches).toBe(1);
  });

  it('blocks dispatch if tool schema, server state, or scope binding changed before approveAction', async () => {
    const profileId = createProfile();
    const { server, refundTool, boundTool } = await setupBoundWriteTool(profileId);
    const ac = new AbortController();

    const { approvalId } = await requestToolApproval(
      { scope: { kind: 'profile', id: String(profileId) }, endUser: null, turnId: 't-rev', stepSeq: 1, signal: ac.signal },
      boundTool,
      { orderId: 'ORD-500' },
    );

    // Sync changed schema -> tool reverts to pending
    await syncServerTools(server.id, 1, undefined, makeFakeTransport('Changed description'));
    expect(listServerTools(server.id)[0]!.id).toBe(refundTool.id);

    let dispatches = 0;
    const executor: WriteApprovalExecutor = {
      async executeClaimedWrite() {
        dispatches += 1;
        return { ok: true, status: 'succeeded', resultMasked: 'ok', durationMs: 1, resultBytes: 2 };
      },
    };

    await expect(approveAction(approvalId, 1, undefined, executor)).rejects.toMatchObject({
      status: 409,
    });
    expect(dispatches).toBe(0);

    // Also verify server disable / pillar off blocks dispatch
    await updateServer(server.id, { revision: server.revision, enabled: false }, 1);
    setFlags({ mcpClient: false });
    await expect(approveAction(approvalId, 1, undefined, executor)).rejects.toMatchObject({
      status: 409,
      code: 'pillar_disabled',
    });
    expect(dispatches).toBe(0);
  });

  it('dispatches exactly once against real HTTP MCP server and transitions to unknown on disconnect', async () => {
    const fake = await startFakeMcpHttpServer();
    try {
      setAllowedInternalOrigins([fake.origin]);
      const profileId = createProfile('real-http-profile');
      const server = await createServer(
        { slug: 'realhttp', name: 'Real HTTP', url: fake.url, authKind: 'none' },
        1,
      );
      await syncServerTools(server.id, 1);
      const refund = listServerTools(server.id).find((t) => t.name === 'refund_order')!;
      reviewTool(refund.id, { state: 'allowed', effect: 'write' }, 1);
      setBindings({ kind: 'profile', id: String(profileId) }, { toolIds: [refund.id], enabled: true });

      const boundRefund = {
        toolId: refund.id,
        serverId: server.id,
        serverSlug: server.slug,
        name: refund.name,
        exposedName: refund.exposedName,
        description: refund.description,
        inputSchema: refund.inputSchema,
        outputSchema: refund.outputSchema,
        schemaHash: refund.schemaHash,
        effect: 'write' as const,
        timeoutMs: server.timeoutMs,
        maxResultBytes: server.maxResultBytes,
        maxConcurrency: server.maxConcurrency,
      };

      const ac = new AbortController();
      const { approvalId } = await requestToolApproval(
        { scope: { kind: 'profile', id: String(profileId) }, endUser: 'eu-http', turnId: 't-http-1', stepSeq: 1, signal: ac.signal },
        boundRefund,
        { order_id: 'ORD-HTTP-1', amount: 25 },
      );

      const [r1, r2] = await Promise.allSettled([
        approveAction(approvalId, 1, { note: 'ok' }),
        approveAction(approvalId, 2, { note: 'dup' }),
      ]);
      expect(fake.getDispatchCount('tools/call')).toBe(1);
      const okCount = [r1, r2].filter((r) => r.status === 'fulfilled').length;
      const conflictCount = [r1, r2].filter((r) => r.status === 'rejected').length;
      expect(okCount).toBe(1);
      expect(conflictCount).toBe(1);

      // Disconnect mid-write -> unknown, never retried
      fake.setConfig({ disconnectOnMethod: 'tools/call' });
      const { approvalId: unkId } = await requestToolApproval(
        { scope: { kind: 'profile', id: String(profileId) }, endUser: 'eu-http', turnId: 't-http-2', stepSeq: 1, signal: ac.signal },
        boundRefund,
        { order_id: 'ORD-HTTP-2', amount: 15 },
      );
      const unkRes = await approveAction(unkId, 1);
      expect(unkRes.status).toBe('unknown');
      expect(fake.getDispatchCount('tools/call')).toBe(2);
      await expect(approveAction(unkId, 1)).rejects.toMatchObject({ status: 409, code: 'already_decided' });
      expect(fake.getDispatchCount('tools/call')).toBe(2);
    } finally {
      await fake.close();
    }
  });

  it('F01: scrubs opaque server credentials and sensitive keys in argsMasked, decisionNote, and error without role bypass', async () => {
    const profileId = createProfile('f01-profile');
    const secretVal = 'opaque-vault-credential-9988776655';
    const server = await createServer(
      {
        slug: 'f01-srv',
        name: 'F01 Server',
        url: 'https://mcp.example.com/v1',
        authKind: 'bearer',
        secret: secretVal,
      },
      1,
    );
    await syncServerTools(server.id, 1, undefined, makeFakeTransport('Refund order'));
    const refundTool = listServerTools(server.id)[0]!;
    reviewTool(refundTool.id, { state: 'allowed', effect: 'write' }, 1);
    setBindings({ kind: 'profile', id: String(profileId) }, { toolIds: [refundTool.id], enabled: true });

    const boundTool = {
      toolId: refundTool.id,
      serverId: server.id,
      serverSlug: server.slug,
      name: refundTool.name,
      exposedName: refundTool.exposedName,
      description: refundTool.description,
      inputSchema: refundTool.inputSchema,
      outputSchema: refundTool.outputSchema,
      schemaHash: refundTool.schemaHash,
      effect: 'write' as const,
      timeoutMs: server.timeoutMs,
      maxResultBytes: server.maxResultBytes,
      maxConcurrency: server.maxConcurrency,
    };

    const ac = new AbortController();
    const { approvalId } = await requestToolApproval(
      { scope: { kind: 'profile', id: String(profileId) }, endUser: null, turnId: 't-f01', stepSeq: 1, signal: ac.signal },
      boundTool,
      { orderId: 'ORD-F01', password: 'user-pw-123', tokenEcho: secretVal },
    );

    const viewBefore = listApprovals().find((a) => a.id === approvalId)!;
    expect(viewBefore.argsMasked).not.toContain('user-pw-123');
    expect(viewBefore.argsMasked).not.toContain(secretVal);

    const failExecutor: WriteApprovalExecutor = {
      async executeClaimedWrite() {
        return {
          ok: false,
          status: 'failed',
          resultMasked: `leaked ${secretVal}`,
          error: `upstream rejected ${secretVal}`,
          durationMs: 12,
          resultBytes: 25,
        };
      },
    };
    const after = await approveAction(approvalId, 1, { note: `approved with ${secretVal}` }, failExecutor);
    expect(after.decisionNote ?? '').not.toContain(secretVal);
    expect(after.error ?? '').not.toContain(secretVal);
    expect(after.resultMasked ?? '').not.toContain(secretVal);
  });

  it('F03 & F04: blocks dispatch even after re-review when schema/URL changes or scope binding is disabled', async () => {
    const profileId = createProfile('f03-f04-profile');
    const { server, refundTool, boundTool } = await setupBoundWriteTool(profileId);
    const ac = new AbortController();

    const { approvalId: aSchema } = await requestToolApproval(
      { scope: { kind: 'profile', id: String(profileId) }, endUser: null, turnId: 't-f03-1', stepSeq: 1, signal: ac.signal },
      boundTool,
      { orderId: 'ORD-F03-1' },
    );

    // Sync changed description, then RE-REVIEW to allowed: old approval MUST still be blocked!
    await syncServerTools(server.id, 1, undefined, makeFakeTransport('Changed refund semantics'));
    reviewTool(refundTool.id, { state: 'allowed', effect: 'write' }, 1);

    let dispatches = 0;
    const executor: WriteApprovalExecutor = {
      async executeClaimedWrite() {
        dispatches += 1;
        return { ok: true, status: 'succeeded', resultMasked: 'ok', durationMs: 1, resultBytes: 2 };
      },
    };

    await expect(approveAction(aSchema, 1, undefined, executor)).rejects.toMatchObject({ status: 409 });
    expect(dispatches).toBe(0);

    // New approval with current schema, then disable scope binding -> F04 must block!
    const updatedTool = listServerTools(server.id)[0]!;
    const { approvalId: aBind } = await requestToolApproval(
      { scope: { kind: 'profile', id: String(profileId) }, endUser: null, turnId: 't-f04-1', stepSeq: 1, signal: ac.signal },
      { ...boundTool, description: updatedTool.description, schemaHash: updatedTool.schemaHash },
      { orderId: 'ORD-F04-1' },
    );
    setBindings({ kind: 'profile', id: String(profileId) }, { toolIds: [updatedTool.id], enabled: false });

    await expect(approveAction(aBind, 1, undefined, executor)).rejects.toMatchObject({ status: 409 });
    expect(dispatches).toBe(0);
  });

  it('F08: projects resultMasked/error onto McpApprovalView and transitions custom_ai_tool_calls out of awaiting_approval', async () => {
    const profileId = createProfile('f08-profile');
    const { server, refundTool, boundTool } = await setupBoundWriteTool(profileId);
    const ac = new AbortController();

    const executionKey = 'exec-f08-1';
    const { approvalId } = await requestToolApproval(
      { scope: { kind: 'profile', id: String(profileId) }, endUser: null, turnId: 't-f08', stepSeq: 1, signal: ac.signal },
      boundTool,
      { orderId: 'ORD-F08' },
    );
    // Simulate runtime recording awaiting_approval row with matching executionKey
    const { recordToolCall } = await import('../../../custom/ai-platform/mcp-client/calls.js');
    recordToolCall({
      executionKey,
      scope: { kind: 'profile', id: String(profileId) },
      endUser: null,
      serverId: server.id,
      toolName: refundTool.name,
      argsMasked: '{"orderId":"ORD-F08"}',
      resultMasked: null,
      status: 'awaiting_approval',
      durationMs: 0,
      resultBytes: 0,
    });
    // Ensure approval links to the same execution_key if generated internally
    const appRow = getDb().prepare('SELECT execution_key FROM custom_ai_approvals WHERE id = ?').get(approvalId) as {
      execution_key: string;
    };
    getDb()
      .prepare('UPDATE custom_ai_tool_calls SET execution_key = ? WHERE execution_key = ?')
      .run(appRow.execution_key, executionKey);

    const executor: WriteApprovalExecutor = {
      async executeClaimedWrite() {
        return {
          ok: true,
          status: 'succeeded',
          resultMasked: '{"refunded":true}',
          durationMs: 42,
          resultBytes: 17,
        };
      },
    };
    const approved = await approveAction(approvalId, 1, undefined, executor);
    expect(approved.status).toBe('succeeded');
    expect(approved.resultMasked).toBe('{"refunded":true}');
    expect(approved.durationMs).toBe(42);
    expect(approved.resultBytes).toBe(17);
    expect(approved.executedAt).toBeTruthy();

    const callRow = getDb()
      .prepare('SELECT status, result_masked FROM custom_ai_tool_calls WHERE execution_key = ?')
      .get(appRow.execution_key) as { status: string; result_masked: string | null };
    expect(callRow.status).toBe('ok');
    expect(callRow.result_masked).toBe('{"refunded":true}');
  });
});
