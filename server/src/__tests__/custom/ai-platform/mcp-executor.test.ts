import crypto from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Scope } from '@freellmapi/shared/ai-platform.js';
import { initDb, getDb } from '../../../db/index.js';
import { setFlags } from '../../../custom/ai-platform/flags.js';
import {
  createServer,
  reviewTool,
  setAllowedInternalOrigins,
  syncServerTools,
  updateServer,
} from '../../../custom/ai-platform/mcp-client/registry.js';
import { setBindings, toolsForScope } from '../../../custom/ai-platform/mcp-client/bindings.js';
import { captureApprovalSnapshot } from '../../../custom/ai-platform/mcp-client/approval-safety.js';
import { getToolCallByExecutionKey, listToolCalls, recordToolCall } from '../../../custom/ai-platform/mcp-client/calls.js';
import {
  executeClaimedWrite,
  executeReadTool,
  maskArgsForLog,
} from '../../../custom/ai-platform/mcp-client/executor.js';
import {
  startFakeMcpHttpServer,
  type FakeMcpHttpServer,
} from '../../helpers/ai-platform-fake-mcp-http.js';

describe('MCP Executor (X0)', () => {
  let fakeServer: FakeMcpHttpServer;
  let profileId: number;
  let scope: Scope;

  beforeEach(async () => {
    process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
    initDb(':memory:');
    const db = getDb();
    const res = db
      .prepare("INSERT INTO client_profiles (name, token_hash, encrypted_key, iv, auth_tag) VALUES ('exec-test', 'th1', 'ek1', 'iv1', 'tag1')")
      .run();
    profileId = Number(res.lastInsertRowid);
    scope = { kind: 'profile', id: String(profileId) };

    fakeServer = await startFakeMcpHttpServer();
    setAllowedInternalOrigins([fakeServer.origin]);
    setFlags({ mcpClient: true });
  });

  afterEach(async () => {
    await fakeServer.close();
    try { getDb().close(); } catch { /* already closed */ }
    vi.restoreAllMocks();
  });

  it('blocks a stale read configuration when server credentials rotate during initialization', async () => {
    const srv = await createServer({ slug: 'rotating', name: 'Rotating', url: fakeServer.url,
      authKind: 'bearer', secret: 'old-opaque-credential' }, null);
    await syncServerTools(srv.id, null);
    const row = getDb().prepare("SELECT id FROM custom_ai_mcp_tools WHERE server_id = ? AND name = 'lookup_order'")
      .get(srv.id) as { id: number };
    reviewTool(row.id, { state: 'allowed', effect: 'read' }, null);
    setBindings(scope, { toolIds: [row.id], enabled: true });
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const response = await realFetch(input, init);
      const request = JSON.parse(String(init?.body ?? '{}')) as { method?: string };
      if (request.method === 'initialize') {
        await updateServer(srv.id, { revision: srv.revision, secret: 'new-opaque-credential' }, null);
      }
      return response;
    });
    const result = await executeReadTool({ scope, endUser: null, turnId: 'rotating', stepSeq: 1,
      signal: new AbortController().signal }, toolsForScope(scope)[0]!, { order_id: 'ORD-1' });
    expect(result.kind).toBe('error');
    expect(fakeServer.getDispatchCount('tools/call')).toBe(0);
    expect(getDb().prepare('SELECT fail_count FROM custom_ai_mcp_servers WHERE id = ?').get(srv.id))
      .toEqual({ fail_count: 0 });
    expect(listToolCalls({ scope }).calls[0]?.status).toBe('blocked');
  });

  it('executes allowed bound read tool, masks secret echo/PII, wraps untrusted result, and logs once', async () => {
    fakeServer.setConfig({
      onToolCall: () => ({
        content: [
          {
            type: 'text',
            text: 'Order for alice@example.com secret=super-secret-xyz',
          },
        ],
        isError: false,
      }),
    });

    const srv = await createServer(
      {
        slug: 'orders',
        name: 'Orders',
        url: fakeServer.url,
        authKind: 'bearer',
        secret: 'super-secret-xyz',
      },
      1,
    );
    await syncServerTools(srv.id, 1);
    const db = getDb();
    const lookupRow = db
      .prepare("SELECT id FROM custom_ai_mcp_tools WHERE server_id = ? AND name = 'lookup_order'")
      .get(srv.id) as { id: number };
    reviewTool(lookupRow.id, { state: 'allowed', effect: 'read' }, 1);
    setBindings(scope, { toolIds: [lookupRow.id], enabled: true });

    const [bound] = toolsForScope(scope);
    const result = await executeReadTool(
      {
        scope,
        endUser: 'u1',
        turnId: 'turn-1',
        stepSeq: 1,
        signal: new AbortController().signal,
      },
      bound,
      { order_id: 'ORD-99', customer_email: 'bob@example.com' },
    );

    expect(result.kind).toBe('result');
    if (result.kind === 'result') {
      expect(result.text).toContain('<tool_result server="orders" tool="lookup_order" trust="untrusted">');
      expect(result.text).toContain('</tool_result>');
      expect(result.text).not.toContain('super-secret-xyz');
      expect(result.text).not.toContain('alice@example.com');
    }

    const calls = listToolCalls({ scope }).calls;
    expect(calls).toHaveLength(1);
    expect(calls[0].status).toBe('ok');
    expect(calls[0].argsMasked).not.toContain('bob@example.com');
    expect(calls[0].resultMasked).not.toContain('super-secret-xyz');
  });

  it('rejects invalid args, unbound tools, or write-effect tools on executeReadTool without remote call', async () => {
    const srv = await createServer(
      {
        slug: 'orders',
        name: 'Orders',
        url: fakeServer.url,
        authKind: 'none',
      },
      1,
    );
    await syncServerTools(srv.id, 1);
    const db = getDb();
    const lookupRow = db
      .prepare("SELECT id FROM custom_ai_mcp_tools WHERE server_id = ? AND name = 'lookup_order'")
      .get(srv.id) as { id: number };
    reviewTool(lookupRow.id, { state: 'allowed', effect: 'read' }, 1);
    setBindings(scope, { toolIds: [lookupRow.id], enabled: true });

    const [bound] = toolsForScope(scope);
    const beforeCalls = fakeServer.getDispatchCount('tools/call');

    // Missing required order_id
    const badArgs = await executeReadTool(
      {
        scope,
        endUser: null,
        turnId: 'turn-2',
        stepSeq: 1,
        signal: new AbortController().signal,
      },
      bound,
      {},
    );
    expect(badArgs.kind).toBe('error');
    if (badArgs.kind === 'error') {
      expect(badArgs.errorType).toBe('tool_error');
    }
    expect(fakeServer.getDispatchCount('tools/call')).toBe(beforeCalls);

    // Unbound scope rejected
    const otherProfile = db
      .prepare("INSERT INTO client_profiles (name, token_hash, encrypted_key, iv, auth_tag) VALUES ('other', 'th2', 'ek2', 'iv2', 'tag2')")
      .run();
    const otherScope: Scope = { kind: 'profile', id: String(otherProfile.lastInsertRowid) };
    const unbound = await executeReadTool(
      {
        scope: otherScope,
        endUser: null,
        turnId: 'turn-3',
        stepSeq: 1,
        signal: new AbortController().signal,
      },
      bound,
      { order_id: 'ORD-1' },
    );
    expect(unbound.kind).toBe('error');
    if (unbound.kind === 'error') {
      expect(unbound.errorType).toBe('blocked');
    }
    expect(fakeServer.getDispatchCount('tools/call')).toBe(beforeCalls);
  });

  it('executeClaimedWrite requires executing claim row and returns unknown without retry on disconnect', async () => {
    const srv = await createServer(
      {
        slug: 'orders',
        name: 'Orders',
        url: fakeServer.url,
        authKind: 'none',
      },
      1,
    );
    await syncServerTools(srv.id, 1);
    const db = getDb();
    const refundRow = db
      .prepare("SELECT id FROM custom_ai_mcp_tools WHERE server_id = ? AND name = 'refund_order'")
      .get(srv.id) as { id: number };
    reviewTool(refundRow.id, { state: 'allowed', effect: 'write' }, 1);
    setBindings(scope, { toolIds: [refundRow.id], enabled: true });

    // Without executing approval row -> fails closed before I/O
    const missingClaim = await executeClaimedWrite({
      approvalId: 9999,
      executionKey: 'exec-missing',
      scope,
      endUser: null,
      toolId: refundRow.id,
      args: { order_id: 'ORD-1', amount: 10 },
      signal: new AbortController().signal,
    });
    expect(missingClaim.ok).toBe(false);
    expect(missingClaim.status).toBe('failed');
    expect(fakeServer.getDispatchCount('tools/call')).toBe(0);

    // Insert executing approval row with immutable snapshot
    const snapshot = await captureApprovalSnapshot({
      toolId: refundRow.id,
      scopeKind: 'profile',
      scopeId: String(profileId),
    });
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();
    const ins = db
      .prepare(
        `INSERT INTO custom_ai_approvals (
          execution_key, run_id, step_seq, scope_kind, scope_id, end_user,
          tool_id, args_ciphertext, args_iv, args_tag, args_masked, snapshot_json, status, expires_at
        ) VALUES ('exec-key-1', NULL, 1, 'profile', ?, NULL, ?, 'c', 'i', 't', '{}', ?, 'executing', ?)`,
      )
      .run(String(profileId), refundRow.id, JSON.stringify(snapshot), expiresAt);
    const approvalId = Number(ins.lastInsertRowid);

    // Disconnect mid-write -> returns unknown, dispatched exactly once (no retry)
    fakeServer.setConfig({ disconnectOnMethod: 'tools/call' });
    const uncertain = await executeClaimedWrite({
      approvalId,
      executionKey: 'exec-key-1',
      scope,
      endUser: null,
      toolId: refundRow.id,
      args: { order_id: 'ORD-1', amount: 10 },
      signal: new AbortController().signal,
    });
    expect(uncertain.ok).toBe(false);
    expect(uncertain.status).toBe('unknown');
    expect(fakeServer.getDispatchCount('tools/call')).toBe(1);
  });

  it('F01/F03/F04/F08: enforces snapshot/scope guard before dispatch, scrubs opaque secrets, and transitions awaiting_approval journal rows', async () => {
    const opaqueSecret = 'opaque-executor-secret-9981';

    const srv = await createServer(
      {
        slug: 'orders-fixes',
        name: 'Orders Fixes',
        url: fakeServer.url,
        authKind: 'bearer',
        secret: opaqueSecret,
      },
      1,
    );
    await syncServerTools(srv.id, 1);
    const db = getDb();
    const refundRow = db
      .prepare("SELECT id FROM custom_ai_mcp_tools WHERE server_id = ? AND name = 'refund_order'")
      .get(srv.id) as { id: number };
    reviewTool(refundRow.id, { state: 'allowed', effect: 'write' }, 1);
    setBindings(scope, { toolIds: [refundRow.id], enabled: true });

    // F01: maskArgsForLog scrubs opaque secrets and nested sensitive keys even with admin role
    const masked = maskArgsForLog(
      scope,
      {
        order_id: 'ORD-1',
        nested: { credential: 'nested-secret-val', passwd: 'pw-1', note: `echo:${opaqueSecret}` },
      },
      opaqueSecret,
      'admin',
    );
    expect(masked).not.toContain(opaqueSecret);
    expect(masked).not.toContain('nested-secret-val');
    expect(masked).not.toContain('pw-1');

    const snapshot = await captureApprovalSnapshot({
      toolId: refundRow.id,
      scopeKind: 'profile',
      scopeId: String(profileId),
    });
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();

    // F03: Missing snapshot fails closed before dispatch
    const insMissingSnap = db
      .prepare(
        `INSERT INTO custom_ai_approvals (
          execution_key, run_id, step_seq, scope_kind, scope_id, end_user,
          tool_id, args_ciphertext, args_iv, args_tag, args_masked, status, expires_at
        ) VALUES ('exec-no-snap', NULL, 1, 'profile', ?, NULL, ?, 'c', 'i', 't', '{}', 'executing', ?)`,
      )
      .run(String(profileId), refundRow.id, expiresAt);
    const noSnapRes = await executeClaimedWrite({
      approvalId: Number(insMissingSnap.lastInsertRowid),
      executionKey: 'exec-no-snap',
      scope,
      endUser: null,
      toolId: refundRow.id,
      args: { order_id: 'ORD-1', amount: 10 },
      signal: new AbortController().signal,
    });
    expect(noSnapRes.ok).toBe(false);
    expect(fakeServer.getDispatchCount('tools/call')).toBe(0);

    // F04: Scope binding disabled before dispatch (with valid snapshot) -> blocked, no dispatch
    const insRevoked = db
      .prepare(
        `INSERT INTO custom_ai_approvals (
          execution_key, run_id, step_seq, scope_kind, scope_id, end_user,
          tool_id, args_ciphertext, args_iv, args_tag, args_masked, snapshot_json, status, expires_at
        ) VALUES ('exec-revoked', NULL, 1, 'profile', ?, NULL, ?, 'c', 'i', 't', '{}', ?, 'executing', ?)`,
      )
      .run(String(profileId), refundRow.id, JSON.stringify(snapshot), expiresAt);
    setBindings(scope, { toolIds: [refundRow.id], enabled: false });
    const revokedRes = await executeClaimedWrite({
      approvalId: Number(insRevoked.lastInsertRowid),
      executionKey: 'exec-revoked',
      scope,
      endUser: null,
      toolId: refundRow.id,
      args: { order_id: 'ORD-1', amount: 10 },
      signal: new AbortController().signal,
    });
    expect(revokedRes.ok).toBe(false);
    expect(fakeServer.getDispatchCount('tools/call')).toBe(0);

    // Re-enable binding for F08 test
    setBindings(scope, { toolIds: [refundRow.id], enabled: true });

    // F08: Existing awaiting_approval journal row transitions to terminal 'ok' with masked result
    const execKey = 'exec-f08-ok';
    recordToolCall({
      executionKey: execKey,
      scope,
      endUser: null,
      serverId: srv.id,
      toolName: 'orders-fixes:refund_order',
      argsMasked: '{"order_id":"ORD-8"}',
      resultMasked: JSON.stringify({ status: 'awaiting_approval', approval_id: 1 }),
      status: 'awaiting_approval',
      durationMs: 1,
      resultBytes: 0,
    });
    const insOk = db
      .prepare(
        `INSERT INTO custom_ai_approvals (
          execution_key, run_id, step_seq, scope_kind, scope_id, end_user,
          tool_id, args_ciphertext, args_iv, args_tag, args_masked, snapshot_json, status, expires_at
        ) VALUES (?, NULL, 1, 'profile', ?, NULL, ?, 'c', 'i', 't', '{}', ?, 'executing', ?)`,
      )
      .run(execKey, String(profileId), refundRow.id, JSON.stringify(snapshot), expiresAt);

    fakeServer.setConfig({
      onToolCall: () => ({
        content: [{ type: 'text', text: `Refunded ORD-8 (${opaqueSecret})` }],
        isError: false,
      }),
    });
    const okRes = await executeClaimedWrite({
      approvalId: Number(insOk.lastInsertRowid),
      executionKey: execKey,
      scope,
      endUser: null,
      toolId: refundRow.id,
      args: { order_id: 'ORD-8', amount: 20 },
      signal: new AbortController().signal,
    });
    expect(okRes.ok).toBe(true);
    expect(okRes.status).toBe('succeeded');
    expect(okRes.resultMasked).toContain('Refunded ORD-8');
    expect(okRes.resultMasked).not.toContain(opaqueSecret);
    expect(fakeServer.getDispatchCount('tools/call')).toBe(1);

    const journalRow = getToolCallByExecutionKey(execKey);
    expect(journalRow?.status).toBe('ok');
    expect(journalRow?.resultMasked).toContain('Refunded ORD-8');
    expect(journalRow?.resultMasked).not.toContain(opaqueSecret);
  });
});
