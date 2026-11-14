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
} from '../../../custom/ai-platform/mcp-client/registry.js';
import { setBindings, toolsForScope } from '../../../custom/ai-platform/mcp-client/bindings.js';
import { listToolCalls } from '../../../custom/ai-platform/mcp-client/calls.js';
import { executeTool } from '../../../custom/ai-platform/mcp-client/tools.js';
import {
  startFakeMcpHttpServer,
  type FakeMcpHttpServer,
} from '../../helpers/ai-platform-fake-mcp-http.js';

describe('MCP Tools Facade (T038 / T045:tools — RED until Agent 3 requestToolApproval)', () => {
  let fakeServer: FakeMcpHttpServer;
  let scope: Scope;

  beforeEach(async () => {
    process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
    initDb(':memory:');
    const db = getDb();
    const res = db
      .prepare("INSERT INTO client_profiles (name, token_hash, encrypted_key, iv, auth_tag) VALUES ('tools-test', 'th1', 'ek1', 'iv1', 'tag1')")
      .run();
    scope = { kind: 'profile', id: String(res.lastInsertRowid) };

    fakeServer = await startFakeMcpHttpServer();
    setAllowedInternalOrigins([fakeServer.origin]);
    setFlags({ mcpClient: true });
  });

  afterEach(async () => {
    await fakeServer.close();
    try { getDb().close(); } catch { /* already closed */ }
    vi.restoreAllMocks();
  });

  it('routes read tools through executor and write tools through requestToolApproval without remote dispatch', async () => {
    const srv = await createServer(
      { slug: 'orders', name: 'Orders', url: fakeServer.url, authKind: 'none' },
      1,
    );
    await syncServerTools(srv.id, 1);
    const db = getDb();
    const lookupRow = db
      .prepare("SELECT id FROM custom_ai_mcp_tools WHERE server_id = ? AND name = 'lookup_order'")
      .get(srv.id) as { id: number };
    const refundRow = db
      .prepare("SELECT id FROM custom_ai_mcp_tools WHERE server_id = ? AND name = 'refund_order'")
      .get(srv.id) as { id: number };
    reviewTool(lookupRow.id, { state: 'allowed', effect: 'read' }, 1);
    reviewTool(refundRow.id, { state: 'allowed', effect: 'write' }, 1);
    setBindings(scope, { toolIds: [lookupRow.id, refundRow.id], enabled: true });

    const boundTools = toolsForScope(scope);
    const readTool = boundTools.find((t) => t.name === 'lookup_order')!;
    const writeTool = boundTools.find((t) => t.name === 'refund_order')!;

    const readRes = await executeTool(
      { scope, endUser: 'u1', turnId: 'turn-a', stepSeq: 1, signal: new AbortController().signal },
      readTool,
      { order_id: 'ORD-1' },
    );
    expect(readRes.kind).toBe('result');

    const beforeWriteDispatches = fakeServer.getDispatchCount('tools/call');
    const writeRes = await executeTool(
      { scope, endUser: 'u1', turnId: 'turn-a', stepSeq: 2, signal: new AbortController().signal },
      writeTool,
      { order_id: 'ORD-1', amount: 50 },
    );
    expect(writeRes.kind).toBe('awaiting_approval');
    expect(fakeServer.getDispatchCount('tools/call')).toBe(beforeWriteDispatches);

    // Same turn duplicate does not log twice; different turn with same args gets distinct executionKey
    const dupRes = await executeTool(
      { scope, endUser: 'u1', turnId: 'turn-a', stepSeq: 2, signal: new AbortController().signal },
      writeTool,
      { order_id: 'ORD-1', amount: 50 },
    );
    expect(dupRes).toEqual(writeRes);

    const otherTurnRes = await executeTool(
      { scope, endUser: 'u1', turnId: 'turn-b', stepSeq: 2, signal: new AbortController().signal },
      writeTool,
      { order_id: 'ORD-1', amount: 50 },
    );
    expect(otherTurnRes.kind).toBe('awaiting_approval');
    if (writeRes.kind === 'awaiting_approval' && otherTurnRes.kind === 'awaiting_approval') {
      expect(otherTurnRes.executionKey).not.toBe(writeRes.executionKey);
    }

    const calls = listToolCalls({ scope }).calls;
    expect(calls.filter((c) => c.status === 'awaiting_approval')).toHaveLength(2);
  });

  it('F01: executeTool scrubs opaque server secret echo and nested sensitive keys in awaiting_approval journal log', async () => {
    const opaqueSecret = 'opaque-tools-secret-4412';

    const srv = await createServer(
      {
        slug: 'orders-tools-sec',
        name: 'Orders Tools Sec',
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

    const boundWrite = toolsForScope(scope).find((t) => t.name === 'refund_order')!;
    const res = await executeTool(
      {
        scope,
        endUser: null,
        role: 'admin',
        runId: 'run-sec-1',
        stepSeq: 1,
        signal: new AbortController().signal,
      },
      boundWrite,
      {
        order_id: 'ORD-9',
        amount: 15,
        password: 'opaque-password-9',
        note: `echo ${opaqueSecret}`,
      },
    );
    expect(res.kind).toBe('awaiting_approval');
    const calls = listToolCalls({ scope }).calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.argsMasked).not.toContain(opaqueSecret);
    expect(calls[0]!.argsMasked).not.toContain('opaque-password-9');
  });
});
