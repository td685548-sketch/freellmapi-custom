import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoundTool } from '@freellmapi/shared/ai-platform-mcp.js';
import { resetFlagsCacheForTests, setFlags } from '../../../custom/ai-platform/flags.js';
import { setBindings } from '../../../custom/ai-platform/mcp-client/bindings.js';
import {
  createServer,
  listServerTools,
  reviewTool,
  syncServerTools,
} from '../../../custom/ai-platform/mcp-client/registry.js';
import type { McpTransportClient } from '../../../custom/ai-platform/mcp-client/store.js';
import {
  approveAction,
  expireApprovals,
  listApprovals,
  rejectAction,
  type WriteApprovalExecutor,
} from '../../../custom/ai-platform/orchestrator/approvals.js';
import {
  createAgent,
  createFlow,
  publishFlow,
  setFlowGrants,
} from '../../../custom/ai-platform/orchestrator/definitions.js';
import {
  markInterruptedRuns,
  startRun,
  type OrchestratorEngineDeps,
} from '../../../custom/ai-platform/orchestrator/engine.js';
import {
  appendRunStep,
  createRunRecord,
  getRunDetail,
} from '../../../custom/ai-platform/orchestrator/trace.js';
import { getDb, initDb } from '../../../db/index.js';
import { encrypt } from '../../../lib/crypto.js';
import { hashClientProfileKey } from '../../../lib/system-prompt.js';

function createEncryptedProfile(name: string): { id: number; key: string } {
  const key = `sk-cp-${name}-1234567890abcdef`;
  const enc = encrypt(key);
  const res = getDb()
    .prepare(
      `INSERT INTO client_profiles (name, token_hash, encrypted_key, iv, auth_tag, enabled)
       VALUES (?, ?, ?, ?, ?, 1)`,
    )
    .run(name, hashClientProfileKey(key), enc.encrypted, enc.iv, enc.authTag);
  return { id: Number(res.lastInsertRowid), key };
}

function makeFakeTransport(): McpTransportClient {
  return {
    async mcpInitialize(config) {
      return {
        serverId: config.serverId,
        revision: config.revision,
        credentialGeneration: config.credentialGeneration,
        origin: new URL(config.url).origin,
        sessionId: 'sess-approval',
        protocolVersion: '2025-06-18',
        serverInfo: { name: 'orders-mcp' },
      };
    },
    async mcpListTools() {
      return [
        {
          name: 'lookup_order',
          description: 'Lookup order',
          inputSchema: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] },
        },
        {
          name: 'refund_order',
          description: 'Refund order',
          inputSchema: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] },
        },
      ];
    },
  };
}

describe('Orchestrator approvals & interruption recovery (T119 / T127)', () => {
  let profileId = 0;
  let billingAgentId = 0;

  beforeEach(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    resetFlagsCacheForTests();
    setFlags({ orchestrator: true, mcpClient: true, outputGuard: false });

    profileId = createEncryptedProfile('approval-profile').id;

    const agent = createAgent(
      {
        slug: 'billing',
        name: 'Billing Agent',
        model: 'auto',
        systemPrompt: 'Process billing requests.',
      },
      1,
    );
    billingAgentId = agent.id;

    const srv = await createServer(
      { slug: 'orders', name: 'Orders', url: 'https://orders.example.com/mcp', authKind: 'none' },
      1,
    );
    await syncServerTools(srv.id, 1, undefined, makeFakeTransport());
    const tools = listServerTools(srv.id);
    const lookupTool = tools.find((t) => t.name === 'lookup_order')!;
    const refundTool = tools.find((t) => t.name === 'refund_order')!;
    reviewTool(lookupTool.id, { state: 'allowed', effect: 'read' }, 1);
    reviewTool(refundTool.id, { state: 'allowed', effect: 'write' }, 1);
    setBindings(
      { kind: 'agent', id: String(billingAgentId) },
      { toolIds: [lookupTool.id, refundTool.id], enabled: true },
    );

    // Disable mcpClient after seeding tools to verify orchestrator-only approvals work
    setFlags({ orchestrator: true, mcpClient: false, outputGuard: false });

    const flow = createFlow(
      {
        slug: 'billing-flow',
        name: 'Billing Flow',
        draft: {
          kind: 'single',
          entryAgent: 'billing',
          agents: ['billing'],
          handoffs: { billing: [] },
          limits: { maxSteps: 10, maxToolCalls: 10, maxHandoffs: 1, maxTokens: 50000, maxSeconds: 60 },
          awaitingApprovalText: 'Refund requires administrator approval.',
          approvalTtlHours: 2,
        },
      },
      1,
    );
    const pub = publishFlow(flow.id, flow.revision, 1);
    setFlowGrants(pub.id, [profileId]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetFlagsCacheForTests();
    try {
      getDb().close();
    } catch {
      /* already closed */
    }
  });

  it('pauses on write tool and resumes on approveAction from the exact step without repeating prior calls', async () => {
    let readCount = 0;
    let modelCalls = 0;

    const executeToolMock: NonNullable<OrchestratorEngineDeps['executeTool']> = async (ctx, tool: BoundTool, args) => {
      if (tool.effect === 'read') {
        readCount += 1;
        return { kind: 'ok', text: '{"order_id":"ORD-1","paid":true}', durationMs: 2, resultBytes: 30 };
      }
      const { executeTool } = await import('../../../custom/ai-platform/mcp-client/tools.js');
      return executeTool(ctx, tool, args);
    };

    const callGatewayMock: NonNullable<OrchestratorEngineDeps['callGateway']> = async (_req, body) => {
      modelCalls += 1;
      if (modelCalls === 1) {
        return {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'mcp__orders__lookup_order', arguments: '{"order_id":"ORD-1"}' } },
            ],
          },
          finishReason: 'tool_calls',
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          servedModel: 'auto',
        };
      }
      if (modelCalls === 2) {
        return {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'c2', type: 'function', function: { name: 'mcp__orders__refund_order', arguments: '{"order_id":"ORD-1"}' } },
            ],
          },
          finishReason: 'tool_calls',
          usage: { prompt_tokens: 20, completion_tokens: 6, total_tokens: 26 },
          servedModel: 'auto',
        };
      }
      // Step 3 (resumed): must contain the approved tool_result in conversation
      const lastMsg = body.messages[body.messages.length - 1]!;
      expect(lastMsg.role).toBe('tool');
      expect(String(lastMsg.content)).toContain('refunded_ok');
      return {
        message: { role: 'assistant', content: 'Refund for ORD-1 has been completed.' },
        finishReason: 'stop',
        usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
        servedModel: 'auto',
      };
    };

    const paused = await startRun({
      flowSlug: 'billing-flow',
      profileId,
      endUser: 'eu-1',
      wire: 'openai-chat',
      messages: [{ role: 'user', content: 'Refund ORD-1' }],
      deps: { executeTool: executeToolMock, callGateway: callGatewayMock },
    });

    expect(paused.run.status).toBe('awaiting_approval');
    expect(paused.outputText).toBe('Refund requires administrator approval.');
    expect(readCount).toBe(1);
    expect(modelCalls).toBe(2);

    const pending = listApprovals({ status: 'pending' });
    expect(pending).toHaveLength(1);
    expect(pending[0]!.runId).toBe(paused.run.id);

    let writeDispatches = 0;
    const writeExecutor: WriteApprovalExecutor = {
      async executeClaimedWrite(ctx) {
        writeDispatches += 1;
        expect(ctx.args).toEqual({ order_id: 'ORD-1' });
        return {
          ok: true,
          status: 'succeeded',
          resultMasked: '{"refunded_ok":true}',
          durationMs: 11,
          resultBytes: 20,
        };
      },
    };

    const approvalView = await approveAction(
      pending[0]!.id,
      1,
      { note: 'looks good' },
      writeExecutor,
      { deps: { executeTool: executeToolMock, callGateway: callGatewayMock } },
    );

    expect(approvalView.status).toBe('succeeded');
    expect(writeDispatches).toBe(1);
    // Neither read tool nor prior model calls were repeated on resume
    expect(readCount).toBe(1);
    expect(modelCalls).toBe(3);

    const detail = getRunDetail(paused.run.id)!;
    expect(detail.run.status).toBe('completed');
    expect(detail.run.finalTextMasked).toBe('Refund for ORD-1 has been completed.');
    expect(detail.run.totalTokens).toBe(81);
    expect(detail.steps.map((s) => s.kind)).toEqual(['model', 'tool', 'model', 'approval', 'approval', 'model']);
  });

  it('completes with rejection explanation when rejectAction is called without executing write tool', async () => {
    const paused = await startRun({
      flowSlug: 'billing-flow',
      profileId,
      endUser: null,
      wire: 'openai-chat',
      messages: [{ role: 'user', content: 'Refund ORD-2' }],
      deps: {
        callGateway: async () => ({
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'c-rej', type: 'function', function: { name: 'mcp__orders__refund_order', arguments: '{"order_id":"ORD-2"}' } },
            ],
          },
          finishReason: 'tool_calls',
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          servedModel: 'auto',
        }),
      },
    });

    expect(paused.run.status).toBe('awaiting_approval');
    const pending = listApprovals({ status: 'pending' });
    expect(pending).toHaveLength(1);

    const rejected = await rejectAction(pending[0]!.id, 1, { note: 'Window expired' });
    expect(rejected.status).toBe('rejected');

    const detail = getRunDetail(paused.run.id)!;
    expect(detail.run.status).toBe('completed');
    expect(detail.run.finalTextMasked).toContain('rejected');
    expect(detail.run.finalTextMasked).toContain('Window expired');
  });

  it('transitions awaiting_approval run to stopped(expired) when approval expires', async () => {
    const paused = await startRun({
      flowSlug: 'billing-flow',
      profileId,
      endUser: null,
      wire: 'openai-chat',
      messages: [{ role: 'user', content: 'Refund ORD-3' }],
      deps: {
        callGateway: async () => ({
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'c-exp', type: 'function', function: { name: 'mcp__orders__refund_order', arguments: '{"order_id":"ORD-3"}' } },
            ],
          },
          finishReason: 'tool_calls',
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          servedModel: 'auto',
        }),
      },
    });

    expect(paused.run.status).toBe('awaiting_approval');
    const expiredCount = expireApprovals(new Date(Date.now() + 3 * 3600_000));
    expect(expiredCount).toBe(1);

    const detail = getRunDetail(paused.run.id)!;
    expect(detail.run.status).toBe('stopped');
    expect(detail.run.stopReason).toBe('expired');
  });

  it('marks orphaned running runs as interrupted on markInterruptedRuns without repeating tool calls', () => {
    const flow = getDb().prepare("SELECT id FROM custom_ai_flows WHERE slug = 'billing-flow'").get() as { id: number };
    const run = createRunRecord({
      id: 'run_interrupted_test',
      flowId: flow.id,
      flowSlug: 'billing-flow',
      flowVersion: 1,
      profileId,
      endUser: null,
      wire: 'openai-chat',
    });
    appendRunStep({
      runId: run.id,
      kind: 'tool',
      agentSlug: 'billing',
      toolName: 'mcp__orders__lookup_order',
      scopeForMasking: { kind: 'agent', id: String(billingAgentId) },
      input: { order_id: 'ORD-4' },
      output: { ok: true },
      status: 'ok',
    });

    const changed = markInterruptedRuns();
    expect(changed).toBe(1);

    const detail = getRunDetail(run.id)!;
    expect(detail.run.status).toBe('interrupted');
    expect(detail.run.finishedAt).not.toBeNull();
    expect(detail.steps).toHaveLength(1);
  });
});
