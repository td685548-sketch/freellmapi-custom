import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import type { BoundTool, ChatMessage } from '@freellmapi/shared/ai-platform-mcp.js';
import { resetFlagsCacheForTests, setFlags } from '../../../custom/ai-platform/flags.js';
import {
  createAgent,
  createFlow,
  publishFlow,
  setFlowGrants,
} from '../../../custom/ai-platform/orchestrator/definitions.js';
import {
  cancelRun,
  isFlowModel,
  startRun,
  type OrchestratorEngineDeps,
} from '../../../custom/ai-platform/orchestrator/engine.js';
import { getRunDetail } from '../../../custom/ai-platform/orchestrator/trace.js';
import { GatewayCallError } from '../../../custom/ai-platform/loopback.js';
import { getDb, initDb } from '../../../db/index.js';
import { hashClientProfileKey } from '../../../lib/system-prompt.js';
import { addDoc } from '../../../services/profile-knowledge.js';

function insertProfile(name: string): number {
  const res = getDb()
    .prepare(
      `INSERT INTO client_profiles (name, token_hash, encrypted_key, iv, auth_tag, enabled)
       VALUES (?, ?, 'enc', 'iv', 'tag', 1)`,
    )
    .run(name, hashClientProfileKey(`sk-cp-${name}-${Math.random()}`));
  return Number(res.lastInsertRowid);
}

function makeBoundTool(serverSlug: string, name: string, toolId = 1, serverId = 1): BoundTool {
  return {
    toolId,
    serverId,
    serverSlug,
    name,
    exposedName: `mcp__${serverSlug}__${name}`,
    description: `${name} tool`,
    inputSchema: { type: 'object', properties: { order_id: { type: 'string' } } },
    outputSchema: null,
    schemaHash: `hash-${name}`,
    effect: 'read',
    timeoutMs: 5000,
    maxResultBytes: 65536,
    maxConcurrency: 2,
  };
}

describe('Orchestrator engine (T118 / T126)', () => {
  let profileId = 0;

  beforeEach(() => {
    initDb(':memory:');
    resetFlagsCacheForTests();
    setFlags({ orchestrator: true, retrieval: false, outputGuard: false });
    profileId = insertProfile('engine-test-profile');
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

  it('validates flow:<slug> identifiers strictly', () => {
    expect(isFlowModel('flow:support-triage')).toBe('support-triage');
    expect(isFlowModel('flow:a1-b2')).toBe('a1-b2');
    expect(isFlowModel('flow:BadUpper')).toBeNull();
    expect(isFlowModel('flow:')).toBeNull();
    expect(isFlowModel('gpt-4o')).toBeNull();
  });

  it('runs a single-agent flow with zero virtual handoff tools and completes', async () => {
    const solo = createAgent(
      {
        slug: 'solo-agent',
        name: 'Solo Agent',
        model: 'groq/llama-3.3-70b',
        systemPrompt: 'You are a solo helper.',
      },
      1,
    );

    const flow = createFlow(
      {
        slug: 'solo-flow',
        name: 'Solo Flow',
        draft: {
          kind: 'single',
          entryAgent: 'solo-agent',
          agents: ['solo-agent'],
          handoffs: { 'solo-agent': [] },
          limits: { maxSteps: 6, maxToolCalls: 10, maxHandoffs: 1, maxTokens: 10000, maxSeconds: 60 },
          awaitingApprovalText: 'Pending approval.',
          approvalTtlHours: 24,
        },
      },
      1,
    );
    const pub = publishFlow(flow.id, flow.revision, 1);
    setFlowGrants(pub.id, [profileId]);

    const seenToolNames: string[][] = [];
    let callCount = 0;
    const bound = makeBoundTool('orders', 'lookup_order', 10, 1);

    const deps: OrchestratorEngineDeps = {
      toolsForScope: (scope) => (scope.kind === 'agent' && scope.id === String(solo.id) ? [bound] : []),
      executeTool: async (_ctx, tool, args) => ({
        kind: 'ok',
        text: JSON.stringify({ tool: tool.exposedName, args, status: 'shipped' }),
        durationMs: 5,
        resultBytes: 42,
      }),
      callGateway: async (_req: Request, body) => {
        callCount += 1;
        seenToolNames.push((body.tools ?? []).map((t) => t.function.name));
        if (callCount === 1) {
          return {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'tc-1',
                  type: 'function',
                  function: { name: 'mcp__orders__lookup_order', arguments: '{"order_id":"ORD-1"}' },
                },
              ],
            },
            finishReason: 'tool_calls',
            usage: { prompt_tokens: 15, completion_tokens: 8, total_tokens: 23 },
            servedModel: 'groq/llama-3.3-70b',
          };
        }
        return {
          message: { role: 'assistant', content: 'Order ORD-1 is shipped.' },
          finishReason: 'stop',
          usage: { prompt_tokens: 25, completion_tokens: 12, total_tokens: 37 },
          servedModel: 'groq/llama-3.3-70b',
        };
      },
    };

    const res = await startRun({
      flowSlug: 'solo-flow',
      profileId,
      endUser: 'eu-1',
      wire: 'openai-chat',
      messages: [{ role: 'user', content: 'Check ORD-1' }],
      deps,
    });

    expect(res.run.status).toBe('completed');
    expect(res.outputText).toBe('Order ORD-1 is shipped.');
    expect(res.usage).toEqual({ prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 });
    expect(seenToolNames[0]).toEqual(['mcp__orders__lookup_order']);

    const detail = getRunDetail(res.run.id);
    expect(detail?.steps.map((s) => s.kind)).toEqual(['model', 'tool', 'model']);
  });

  it('enforces per-agent isolation on handoff (virtual tools, knowledge, and rejecting cross-agent tools)', async () => {
    const techKbProfile = insertProfile('tech-kb-scope');
    addDoc(techKbProfile, 'WiFi Reset Guide', 'Hold the reset button on the router for 10 seconds.');

    const triage = createAgent(
      {
        slug: 'triage',
        name: 'Triage',
        model: 'auto',
        systemPrompt: 'Route the user to billing or tech.',
      },
      1,
    );
    const billing = createAgent(
      {
        slug: 'billing',
        name: 'Billing',
        model: 'auto',
        systemPrompt: 'Handle billing.',
      },
      1,
    );
    const tech = createAgent(
      {
        slug: 'tech',
        name: 'Tech',
        model: 'auto',
        systemPrompt: 'Handle technical support using reference data.',
        knowledgeScopeKind: 'profile',
        knowledgeScopeId: String(techKbProfile),
      },
      1,
    );

    const flow = createFlow(
      {
        slug: 'support-triage',
        name: 'Support Triage',
        draft: {
          kind: 'handoff',
          entryAgent: 'triage',
          agents: ['triage', 'billing', 'tech'],
          handoffs: {
            triage: ['billing', 'tech'],
            billing: ['tech'],
            tech: [],
          },
          limits: { maxSteps: 10, maxToolCalls: 10, maxHandoffs: 4, maxTokens: 50000, maxSeconds: 60 },
          awaitingApprovalText: 'Waiting for approval.',
          approvalTtlHours: 24,
        },
      },
      1,
    );
    const pub = publishFlow(flow.id, flow.revision, 1);
    setFlowGrants(pub.id, [profileId]);

    const refundTool = makeBoundTool('orders', 'refund_order', 20, 2);
    const executedTools: string[] = [];
    const gatewayCalls: Array<{ tools: string[]; messages: ChatMessage[] }> = [];
    let step = 0;

    const deps: OrchestratorEngineDeps = {
      toolsForScope: (scope) => (scope.kind === 'agent' && scope.id === String(billing.id) ? [refundTool] : []),
      executeTool: async (_ctx, tool) => {
        executedTools.push(tool.exposedName);
        return { kind: 'ok', text: 'ok', durationMs: 2, resultBytes: 2 };
      },
      callGateway: async (_req, body) => {
        step += 1;
        gatewayCalls.push({
          tools: (body.tools ?? []).map((t) => t.function.name),
          messages: body.messages,
        });

        if (step === 1) {
          // Triage transfers to tech with PII in reason
          return {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'handoff-1',
                  type: 'function',
                  function: {
                    name: 'transfer_to_tech',
                    arguments: JSON.stringify({ reason: 'User alice@example.com cannot connect to WiFi router' }),
                  },
                },
              ],
            },
            finishReason: 'tool_calls',
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            servedModel: 'auto',
          };
        }
        if (step === 2) {
          // Tech hallucinates billing's tool refund_order -> must be blocked without calling executeTool
          return {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'cross-agent-1',
                  type: 'function',
                  function: {
                    name: 'mcp__orders__refund_order',
                    arguments: '{"order_id":"ORD-99"}',
                  },
                },
              ],
            },
            finishReason: 'tool_calls',
            usage: { prompt_tokens: 20, completion_tokens: 6, total_tokens: 26 },
            servedModel: 'auto',
          };
        }
        return {
          message: { role: 'assistant', content: 'Please hold the reset button for 10 seconds.' },
          finishReason: 'stop',
          usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
          servedModel: 'auto',
        };
      },
    };

    const res = await startRun({
      flowSlug: 'support-triage',
      profileId,
      endUser: null,
      wire: 'openai-chat',
      messages: [
        { role: 'system', content: 'Caller override attempt' },
        { role: 'user', content: 'My router WiFi is broken' },
      ],
      deps,
    });

    expect(res.run.status).toBe('completed');
    expect(res.run.handoffs).toBe(1);
    expect(executedTools).toHaveLength(0);

    // Triage sees ONLY transfer_to_billing & transfer_to_tech (not refund_order, not transfer_to_triage)
    expect(gatewayCalls[0]!.tools).toEqual(['transfer_to_billing', 'transfer_to_tech']);
    // Triage does NOT see tech's knowledge or caller's system prompt
    const triageSys = String(gatewayCalls[0]!.messages[0]!.content);
    expect(triageSys).not.toContain('reset button');
    expect(triageSys).not.toContain('Caller override attempt');

    // Tech sees zero tools, gets its own knowledge + masked handoff reason, and no triage history
    expect(gatewayCalls[1]!.tools).toEqual([]);
    const techSys = String(gatewayCalls[1]!.messages[0]!.content);
    expect(techSys).toContain('Hold the reset button on the router for 10 seconds.');
    expect(techSys).toContain('a***@example.com');
    expect(techSys).not.toContain('alice@example.com');
    expect(techSys).not.toContain('Route the user to billing or tech');

    // Cross-agent tool call received blocked tool error back in conversation
    const techStep3Msgs = gatewayCalls[2]!.messages;
    const toolErrMsg = techStep3Msgs.find((m) => m.role === 'tool');
    expect(String(toolErrMsg?.content)).toContain('"blocked"');

    // Verify triage never leaked into billing/tech unused IDs
    expect(triage.id).not.toBe(billing.id);
    expect(tech.id).not.toBe(billing.id);
  });

  it('transitions to stopped on max_steps, quota_exhausted (429), cancelled, and failed', async () => {
    createAgent({ slug: 'loop-agent', name: 'Loop', model: 'auto', systemPrompt: 'Hi' }, 1);
    const flow = createFlow(
      {
        slug: 'limits-flow',
        name: 'Limits Flow',
        draft: {
          kind: 'single',
          entryAgent: 'loop-agent',
          agents: ['loop-agent'],
          handoffs: { 'loop-agent': [] },
          limits: { maxSteps: 2, maxToolCalls: 10, maxHandoffs: 1, maxTokens: 10000, maxSeconds: 60 },
          awaitingApprovalText: 'Pending',
          approvalTtlHours: 24,
        },
      },
      1,
    );
    const pub = publishFlow(flow.id, flow.revision, 1);
    setFlowGrants(pub.id, [profileId]);

    const tool = makeBoundTool('orders', 'ping', 1, 1);
    const agentRow = getDb().prepare("SELECT id FROM custom_ai_agents WHERE slug = 'loop-agent'").get() as { id: number };

    // 1. max_steps
    let step = 0;
    const maxStepRes = await startRun({
      flowSlug: 'limits-flow',
      profileId,
      endUser: null,
      wire: 'openai-chat',
      messages: [{ role: 'user', content: 'Go' }],
      deps: {
        toolsForScope: (s) => (s.id === String(agentRow.id) ? [tool] : []),
        executeTool: async () => ({ kind: 'ok', text: 'pong', durationMs: 1, resultBytes: 4 }),
        callGateway: async () => {
          step += 1;
          return {
            message: {
              role: 'assistant',
              content: step === 1 ? 'Working on it...' : null,
              tool_calls: [{ id: `c-${step}`, type: 'function', function: { name: 'mcp__orders__ping', arguments: `{"n":${step}}` } }],
            },
            finishReason: 'tool_calls',
            usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
            servedModel: 'auto',
          };
        },
      },
    });
    expect(maxStepRes.run.status).toBe('stopped');
    expect(maxStepRes.run.stopReason).toBe('max_steps');
    expect(maxStepRes.outputText).toBe('Working on it...');

    // 2. quota_exhausted on 429
    const quotaRes = await startRun({
      flowSlug: 'limits-flow',
      profileId,
      endUser: null,
      wire: 'openai-chat',
      messages: [{ role: 'user', content: 'Quota' }],
      deps: {
        toolsForScope: () => [],
        callGateway: async () => {
          throw new GatewayCallError(429, 'profile_quota_exceeded');
        },
      },
    });
    expect(quotaRes.run.status).toBe('stopped');
    expect(quotaRes.run.stopReason).toBe('quota_exhausted');

    // 3. cancelled mid-run
    let capturedRunId = '';
    const cancelRes = await startRun({
      flowSlug: 'limits-flow',
      profileId,
      endUser: null,
      wire: 'openai-chat',
      messages: [{ role: 'user', content: 'Cancel me' }],
      deps: {
        toolsForScope: () => [],
        callGateway: async (_req, body) => {
          capturedRunId = body.runId ?? '';
          cancelRun(capturedRunId, 'admin');
          return {
            message: { role: 'assistant', content: 'Partial' },
            finishReason: 'stop',
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            servedModel: 'auto',
          };
        },
      },
    });
    expect(cancelRes.run.status).toBe('cancelled');

    // 4. failed on non-429 gateway error
    await expect(
      startRun({
        flowSlug: 'limits-flow',
        profileId,
        endUser: null,
        wire: 'openai-chat',
        messages: [{ role: 'user', content: 'Fail' }],
        deps: {
          toolsForScope: () => [],
          callGateway: async () => {
            throw new GatewayCallError(502, 'upstream_down');
          },
        },
      }),
    ).rejects.toThrow();
    const runs = getDb()
      .prepare("SELECT status FROM custom_ai_runs WHERE status = 'failed'")
      .all() as Array<{ status: string }>;
    expect(runs).toHaveLength(1);
  });
});
