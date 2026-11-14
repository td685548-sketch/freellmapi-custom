import crypto from 'node:crypto';
import type { Request } from 'express';
import type { Scope } from '@freellmapi/shared/ai-platform.js';
import {
  MCP_LIMITS,
  type BoundTool,
  type ChatMessage,
  type ChatToolCall,
  type ChatToolDefinition,
  type McpLoopResult,
  type TokenUsage,
  type ToolContext,
  type ToolExecutionResult,
} from '@freellmapi/shared/ai-platform-mcp.js';
import { getDb } from '../../../db/index.js';
import { hasEnabledToolsModel, resolveRoutingChain } from '../../../services/router.js';
import { callGateway, type LoopbackRequest } from '../loopback.js';
import { toolsForScope } from './bindings.js';
import type { LoopSafeParams } from './messages.js';

export interface RunToolLoopInput {
  scope: Scope;
  messages: ChatMessage[];
  model: string;
  callerTools: ChatToolDefinition[];
  maxRounds: number;
  signal: AbortSignal;
  runId?: string;
  turnId?: string;
  endUser?: string | null;
  role?: string;
  params?: LoopSafeParams;
}

export interface RunToolLoopOutput extends McpLoopResult {
  toolsSkippedReason?: 'unsupported_model';
  servedModel?: string;
}

export interface ToolLoopDeps {
  toolsForScope?: (scope: Scope, callerTools?: ChatToolDefinition[]) => BoundTool[];
  callGateway?: (
    req: Request,
    body: LoopbackRequest,
  ) => Promise<{ message: ChatMessage; finishReason: string; usage: TokenUsage; servedModel: string }>;
  executeTool?: (ctx: ToolContext, tool: BoundTool, args: unknown) => Promise<ToolExecutionResult>;
  isModelToolCapable?: (model: string) => boolean;
}

function defaultIsModelToolCapable(model: string): boolean {
  try {
    const trimmed = model.trim();
    if (!trimmed || trimmed === 'auto' || trimmed === 'fusion') {
      return hasEnabledToolsModel();
    }
    const db = getDb();
    try {
      const { chain } = resolveRoutingChain(trimmed);
      const matching = chain.filter(
        (entry) =>
          entry.enabled === 1 &&
          (entry.model_id === trimmed || `${entry.platform}/${entry.model_id}` === trimmed),
      );
      if (matching.length > 0) {
        return matching.some((entry) => entry.supports_tools === 1);
      }
    } catch {
      // Fallback to direct models table query when routing chain is unavailable.
    }
    const rows = db
      .prepare('SELECT supports_tools FROM models WHERE enabled = 1 AND model_id = ?')
      .all(trimmed) as Array<{ supports_tools: number }>;
    if (rows.length > 0) {
      return rows.some((r) => r.supports_tools === 1);
    }
    return hasEnabledToolsModel();
  } catch {
    return true;
  }
}

async function resolveExecuteTool(
  injected?: ToolLoopDeps['executeTool'],
): Promise<NonNullable<ToolLoopDeps['executeTool']>> {
  if (injected) return injected;
  try {
    const toolsModule = './tools.js';
    const mod = (await import(toolsModule)) as { executeTool?: ToolLoopDeps['executeTool'] };
    if (typeof mod.executeTool === 'function') {
      return mod.executeTool;
    }
  } catch {
    // Module not yet available until Agent 2 X0 lands.
  }
  throw new Error('MCP tool executor facade (tools.ts) is not available.');
}

function boundToolToDefinition(tool: BoundTool): ChatToolDefinition {
  return {
    type: 'function',
    function: {
      name: tool.exposedName,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.inputSchema,
    },
  };
}

function addUsage(acc: TokenUsage, delta: TokenUsage | undefined): TokenUsage {
  if (!delta) return acc;
  const prompt = (acc.prompt_tokens ?? 0) + (delta.prompt_tokens ?? 0);
  const completion = (acc.completion_tokens ?? 0) + (delta.completion_tokens ?? 0);
  const total = (acc.total_tokens ?? 0) + (delta.total_tokens ?? (delta.prompt_tokens ?? 0) + (delta.completion_tokens ?? 0));
  const cached =
    (acc.prompt_tokens_details?.cached_tokens ?? 0) +
    (delta.prompt_tokens_details?.cached_tokens ?? 0);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
    ...(cached > 0 ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
  };
}

function parseToolArgs(raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  if (!raw || raw.trim() === '') return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, error: 'Invalid JSON tool arguments.' };
  }
}

async function runBounded<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const concurrency = Math.max(1, limit);
  let nextIdx = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIdx < items.length) {
      const idx = nextIdx++;
      await fn(items[idx]!, idx);
    }
  });
  await Promise.all(workers);
}

/**
 * Executes the server-side MCP tool loop for up to `maxRounds` (default 8).
 * - Preserves caller tools with priority on name collisions.
 * - Inspects each batch before MCP dispatch so caller-owned tool calls stop the loop cleanly.
 * - Strips only MCP tools (never caller tools) when the target model lacks tool-calling support.
 */
export async function runToolLoop(
  req: Request,
  input: RunToolLoopInput,
  deps?: ToolLoopDeps,
): Promise<RunToolLoopOutput> {
  const resolveBindings = deps?.toolsForScope ?? toolsForScope;
  const gateway = deps?.callGateway ?? callGateway;
  const checkCapable = deps?.isModelToolCapable ?? defaultIsModelToolCapable;

  const maxRounds = Math.max(
    MCP_LIMITS.minRounds,
    Math.min(MCP_LIMITS.maxRounds, Math.trunc(input.maxRounds || MCP_LIMITS.defaultMaxRounds)),
  );
  const turnId = input.turnId ?? crypto.randomUUID();
  const callerToolNames = new Set(input.callerTools.map((t) => t.function.name));

  // Resolve bound MCP tools (already filters collisions with callerTools, but re-guard here).
  const boundTools = resolveBindings(input.scope, input.callerTools).filter(
    (t) => !callerToolNames.has(t.exposedName),
  );

  let toolsSkippedReason: 'unsupported_model' | undefined;
  let effectiveMcpTools = boundTools;
  if (boundTools.length > 0 && !checkCapable(input.model)) {
    effectiveMcpTools = [];
    toolsSkippedReason = 'unsupported_model';
  }

  const mcpByExposedName = new Map<string, BoundTool>(
    effectiveMcpTools.map((t) => [t.exposedName, t]),
  );
  const combinedTools: ChatToolDefinition[] = [
    ...input.callerTools,
    ...effectiveMcpTools.map(boundToolToDefinition),
  ];

  const conversation: ChatMessage[] = [...input.messages];
  let totalUsage: TokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let rounds = 0;
  let stepSeq = 0;
  let lastMessage: ChatMessage = { role: 'assistant', content: '' };
  let lastFinish = 'stop';
  let servedModel = input.model;

  while (rounds < maxRounds) {
    if (input.signal.aborted) {
      throw new Error('Aborted');
    }
    rounds += 1;

    const gwRes = await gateway(req, {
      messages: conversation,
      model: input.model,
      ...(combinedTools.length > 0 ? { tools: combinedTools } : {}),
      ...(input.params?.maxTokens !== undefined ? { maxTokens: input.params.maxTokens } : {}),
      ...(input.params ? { safeParams: input.params } : {}),
      ...(input.endUser !== undefined ? { endUser: input.endUser } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      skipEnrichment: true,
      depth: 0,
      signal: input.signal,
    });

    totalUsage = addUsage(totalUsage, gwRes.usage);
    lastMessage = gwRes.message;
    lastFinish = gwRes.finishReason;
    servedModel = gwRes.servedModel;

    const toolCalls = gwRes.message.tool_calls ?? [];
    if (toolCalls.length === 0) {
      return {
        message: lastMessage,
        finishReason: lastFinish,
        usage: totalUsage,
        rounds,
        ...(toolsSkippedReason ? { toolsSkippedReason } : {}),
        servedModel,
      };
    }

    // Check the entire batch BEFORE any MCP dispatch: if any call belongs to the caller,
    // stop immediately and return the batch to the caller without MCP side effects.
    const hasCallerToolCall = toolCalls.some((tc) => callerToolNames.has(tc.function.name));
    if (hasCallerToolCall) {
      return {
        message: lastMessage,
        finishReason: 'tool_calls',
        usage: totalUsage,
        rounds,
        callerToolCalls: toolCalls,
        ...(toolsSkippedReason ? { toolsSkippedReason } : {}),
        servedModel,
      };
    }

    if (input.signal.aborted) {
      throw new Error('Aborted');
    }

    conversation.push(gwRes.message);

    // Execute MCP tool calls with bounded fan-out, preserving order of tool results.
    const execTool = await resolveExecuteTool(deps?.executeTool);
    const results: Array<{ call: ChatToolCall; text: string; pendingApprovalId?: number }> = new Array(
      toolCalls.length,
    );

    const fanoutLimit = Math.min(
      MCP_LIMITS.defaultMaxConcurrency,
      ...effectiveMcpTools.map((t) => t.maxConcurrency),
    );

    await runBounded(toolCalls, fanoutLimit, async (tc, idx) => {
      if (input.signal.aborted) {
        results[idx] = {
          call: tc,
          text: JSON.stringify({ error: { type: 'transport_error', message: 'Request aborted.' } }),
        };
        return;
      }

      const bound = mcpByExposedName.get(tc.function.name);
      if (!bound) {
        results[idx] = {
          call: tc,
          text: JSON.stringify({
            error: { type: 'blocked', message: `Unknown tool: ${tc.function.name}` },
          }),
        };
        return;
      }

      const parsedArgs = parseToolArgs(tc.function.arguments);
      if (!parsedArgs.ok) {
        results[idx] = {
          call: tc,
          text: JSON.stringify({ error: { type: 'tool_error', message: parsedArgs.error } }),
        };
        return;
      }

      const seq = ++stepSeq;
      const outcome = await execTool(
        {
          scope: input.scope,
          endUser: input.endUser ?? null,
          ...(input.role ? { role: input.role } : {}),
          ...(input.runId ? { runId: input.runId } : {}),
          turnId,
          stepSeq: seq,
          signal: input.signal,
        },
        bound,
        parsedArgs.value,
      );

      if (outcome.kind === 'awaiting_approval') {
        results[idx] = {
          call: tc,
          text: JSON.stringify({ status: 'awaiting_approval', approval_id: outcome.approvalId }),
          pendingApprovalId: outcome.approvalId,
        };
        return;
      }

      results[idx] = { call: tc, text: outcome.text };
    });

    const pending = results.find((r) => r.pendingApprovalId !== undefined);
    if (pending) {
      return {
        message: {
          role: 'assistant',
          content: `Tool execution requires administrator approval (approval_id: ${pending.pendingApprovalId}).`,
        },
        finishReason: 'stop',
        usage: totalUsage,
        rounds,
        pendingApprovalId: pending.pendingApprovalId,
        ...(toolsSkippedReason ? { toolsSkippedReason } : {}),
        servedModel,
      };
    }

    for (const item of results) {
      conversation.push({
        role: 'tool',
        tool_call_id: item.call.id,
        content: item.text,
      });
    }
  }

  return {
    message: lastMessage,
    finishReason: lastFinish,
    usage: totalUsage,
    rounds,
    ...(toolsSkippedReason ? { toolsSkippedReason } : {}),
    servedModel,
  };
}
