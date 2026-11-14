import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, initDb } from '../../../db/index.js';
import { resetFlagsCacheForTests, setFlags } from '../../../custom/ai-platform/flags.js';
import {
  listApprovals,
  requestToolApproval,
} from '../../../custom/ai-platform/orchestrator/approvals.js';
import { recordToolCall } from '../../../custom/ai-platform/mcp-client/calls.js';
import {
  createServer,
  listServerTools,
  reviewTool,
  syncServerTools,
} from '../../../custom/ai-platform/mcp-client/registry.js';
import type { McpTransportClient } from '../../../custom/ai-platform/mcp-client/store.js';
import {
  MCP_MAINTENANCE_INTERVAL_MS,
  maybeRunMcpMaintenance,
  resetMcpMaintenanceForTests,
} from '../../../custom/ai-platform/mcp-client/maintenance.js';
import { createOwnerInstanceId } from '../../../custom/ai-platform/mcp-client/owner-instance.js';

function makeFakeTransport(): McpTransportClient {
  return {
    async mcpInitialize(config) {
      return {
        serverId: config.serverId,
        revision: config.revision,
        credentialGeneration: config.credentialGeneration,
        origin: new URL(config.url).origin,
        sessionId: 'sess-maint',
        protocolVersion: '2025-06-18',
        serverInfo: { name: 'maint-mcp' },
      };
    },
    async mcpListTools() {
      return [
        {
          name: 'refund',
          description: 'Refund order',
          inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
        },
      ];
    },
  };
}

describe('MCP Lifecycle Maintenance (L01)', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    resetFlagsCacheForTests();
    resetMcpMaintenanceForTests();
    setFlags({ mcpClient: true });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-14T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetFlagsCacheForTests();
    try {
      getDb().close();
    } catch {
      /* already closed */
    }
  });

  it('reconciles a proven dead local owner and its journal without touching live, remote or legacy owners', async () => {
    const srv = await createServer({ slug: 'owner-test', name: 'Owners', url: 'https://mcp.example.com', authKind: 'none' }, null);
    await syncServerTools(srv.id, null, undefined, makeFakeTransport());
    const tool = listServerTools(srv.id)[0]!;
    const deadPid = process.pid + 1000;
    const livePid = process.pid + 2000;
    vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === deadPid) throw Object.assign(new Error('No process'), { code: 'ESRCH' });
      return true;
    });
    const owners = {
      dead: createOwnerInstanceId(deadPid),
      live: createOwnerInstanceId(livePid),
      remote: `mcp-v2:${Buffer.from('remote-host').toString('base64url')}:${deadPid}:00000000-0000-0000-0000-000000000000`,
      legacy: 'mcp-1234-unknown-host',
      current: createOwnerInstanceId(),
    };
    for (const [key, owner] of Object.entries(owners)) {
      getDb().prepare(`INSERT INTO custom_ai_approvals
        (execution_key, scope_kind, scope_id, tool_id, args_ciphertext, args_iv, args_tag, args_masked, status, expires_at, owner_instance_id)
        VALUES (?, 'profile', '1', ?, 'cipher', 'iv', 'tag', '{}', 'executing', '2099-01-01T00:00:00Z', ?)`
      ).run(key, tool.id, owner);
      recordToolCall({ executionKey: key, scope: { kind: 'profile', id: '1' }, endUser: null,
        serverId: srv.id, toolName: tool.name, argsMasked: '{}', resultMasked: null,
        status: 'awaiting_approval', durationMs: 0, resultBytes: 0 });
    }
    const result = maybeRunMcpMaintenance({ force: true });
    expect(result.reconciledExecuting).toBe(1);
    for (const key of Object.keys(owners)) {
      expect(getDb().prepare('SELECT status FROM custom_ai_approvals WHERE execution_key = ?').get(key))
        .toEqual({ status: key === 'dead' ? 'unknown' : 'executing' });
      expect(getDb().prepare('SELECT status FROM custom_ai_tool_calls WHERE execution_key = ?').get(key))
        .toEqual({ status: key === 'dead' ? 'unknown' : 'awaiting_approval' });
    }
    expect(maybeRunMcpMaintenance({ force: true }).reconciledExecuting).toBe(0);
  });

  it('throttles maintenance frequency and expires stale pending approvals + prunes old tool calls', async () => {
    const srv = await createServer(
      { slug: 'maint-srv', name: 'Maint', url: 'https://mcp.example.com/v1', authKind: 'none' },
      1,
    );
    await syncServerTools(srv.id, 1, undefined, makeFakeTransport());
    const tool = listServerTools(srv.id)[0]!;
    reviewTool(tool.id, { state: 'allowed', effect: 'write' }, 1);

    const bound = {
      toolId: tool.id,
      serverId: srv.id,
      serverSlug: 'maint-srv',
      name: tool.name,
      exposedName: tool.exposedName,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: null,
      schemaHash: tool.schemaHash,
      effect: 'write' as const,
      timeoutMs: 20_000,
      maxResultBytes: 262_144,
      maxConcurrency: 4,
    };

    // Create a pending approval and an old tool call (40 days ago > default 30d retention)
    const { approvalId } = await requestToolApproval(
      { scope: { kind: 'profile', id: '1' }, turnId: 't-maint', stepSeq: 1, signal: new AbortController().signal },
      bound,
      { id: 'ord-1' },
    );

    const oldDate = new Date(Date.now() - 40 * 86_400_000).toISOString();
    recordToolCall({
      executionKey: 'old-call-key-1',
      scope: { kind: 'profile', id: '1' },
      endUser: null,
      serverId: srv.id,
      toolName: tool.name,
      argsMasked: JSON.stringify({ id: 'ord-1' }),
      resultMasked: 'done',
      status: 'ok',
      durationMs: 10,
      resultBytes: 4,
    });
    getDb().prepare(`UPDATE custom_ai_tool_calls SET created_at = ? WHERE execution_key = 'old-call-key-1'`).run(oldDate);

    // First run executes maintenance
    const first = maybeRunMcpMaintenance();
    expect(first.ran).toBe(true);
    expect(first.prunedToolCalls).toBe(1);
    expect(first.expiredApprovals).toBe(0);

    // Advance 25 hours, but call immediately within throttle window -> skipped
    const withinWindow = maybeRunMcpMaintenance({ now: new Date(Date.now() + 10_000) });
    expect(withinWindow.ran).toBe(false);

    // Advance past 24h expiry + throttle window -> expires pending approval without needing approve/reject click
    vi.advanceTimersByTime(24 * 60 * 60 * 1000 + MCP_MAINTENANCE_INTERVAL_MS);
    const second = maybeRunMcpMaintenance();
    expect(second.ran).toBe(true);
    expect(second.expiredApprovals).toBe(1);

    // listApprovals({ status: 'pending' }) must not keep expired approvals
    expect(listApprovals({ status: 'pending' })).toHaveLength(0);
    const expiredList = listApprovals({ status: 'expired' });
    expect(expiredList.some((a) => a.id === approvalId)).toBe(true);
  });
});
