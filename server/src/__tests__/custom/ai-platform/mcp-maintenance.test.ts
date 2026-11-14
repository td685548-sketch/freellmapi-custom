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
    resetFlagsCacheForTests();
    try {
      getDb().close();
    } catch {
      /* already closed */
    }
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
