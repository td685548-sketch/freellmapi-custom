import type {
  BoundTool,
  ToolContext,
  ToolExecutionResult,
} from '@freellmapi/shared/ai-platform-mcp.js';
import { maskText } from '../masking.js';
import { requestToolApproval } from '../orchestrator/approvals.js';
import { assertScopeEffective } from './approval-safety.js';
import { validateScope } from './bindings.js';
import { recordToolCall } from './calls.js';
import {
  executeReadTool,
  formatToolErrorJson,
  isToolBoundToScope,
  maskArgsForLog,
  validateArgsAgainstSchema,
} from './executor.js';
import { assertToolExecutable } from './registry.js';
import { sanitizeMcpError } from './sanitize.js';

export async function executeTool(
  ctx: ToolContext,
  tool: BoundTool,
  args: unknown,
): Promise<ToolExecutionResult> {
  if (tool.effect === 'read') {
    return executeReadTool(ctx, tool, args);
  }

  const startedAt = Date.now();
  let normScope;
  try {
    normScope = validateScope(ctx.scope);
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const msg = maskText(ctx.scope, err instanceof Error ? err.message : 'Invalid scope.', ctx.role);
    return {
      kind: 'error',
      errorType: 'blocked',
      text: formatToolErrorJson('blocked', msg),
      durationMs,
    };
  }

  const argsMasked = maskArgsForLog(normScope, args, null, ctx.role);

  if (!isToolBoundToScope(tool.toolId, normScope)) {
    const durationMs = Date.now() - startedAt;
    const msg = 'Tool is not bound to the active scope.';
    recordToolCall({
      runId: ctx.runId ?? null,
      scope: normScope,
      endUser: ctx.endUser,
      role: ctx.role,
      serverId: tool.serverId,
      toolName: tool.exposedName,
      argsMasked,
      resultMasked: msg,
      status: 'blocked',
      durationMs,
      resultBytes: 0,
    });
    return {
      kind: 'error',
      errorType: 'blocked',
      text: formatToolErrorJson('blocked', msg),
      durationMs,
    };
  }

  let verifiedTool: BoundTool;
  let serverSecret: string | null = null;
  try {
    await assertScopeEffective(normScope.kind, normScope.id);
    const checked = assertToolExecutable(tool.toolId, tool.schemaHash);
    verifiedTool = checked.tool;
    serverSecret = checked.config.secret;
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const msg = maskText(normScope, sanitizeMcpError(err), ctx.role);
    recordToolCall({
      runId: ctx.runId ?? null,
      scope: normScope,
      endUser: ctx.endUser,
      role: ctx.role,
      serverId: tool.serverId,
      toolName: tool.exposedName,
      argsMasked,
      resultMasked: msg,
      status: 'blocked',
      durationMs,
      resultBytes: 0,
    });
    return {
      kind: 'error',
      errorType: 'blocked',
      text: formatToolErrorJson('blocked', msg),
      durationMs,
    };
  }

  const sanitizedArgsMasked = maskArgsForLog(normScope, args, serverSecret, ctx.role);

  if (verifiedTool.effect === 'read') {
    return executeReadTool(ctx, verifiedTool, args);
  }

  const schemaCheck = validateArgsAgainstSchema(verifiedTool.inputSchema, args);
  if (!schemaCheck.ok) {
    const durationMs = Date.now() - startedAt;
    recordToolCall({
      runId: ctx.runId ?? null,
      scope: normScope,
      endUser: ctx.endUser,
      role: ctx.role,
      serverId: verifiedTool.serverId,
      toolName: verifiedTool.exposedName,
      argsMasked: sanitizedArgsMasked,
      resultMasked: schemaCheck.reason,
      status: 'tool_error',
      durationMs,
      resultBytes: 0,
    });
    return {
      kind: 'error',
      errorType: 'tool_error',
      text: formatToolErrorJson('tool_error', schemaCheck.reason),
      durationMs,
    };
  }

  const { approvalId, executionKey } = await requestToolApproval(
    { ...ctx, scope: normScope },
    verifiedTool,
    schemaCheck.normalized,
  );

  recordToolCall({
    runId: ctx.runId ?? null,
    executionKey,
    scope: normScope,
    endUser: ctx.endUser,
    role: ctx.role,
    serverId: verifiedTool.serverId,
    toolName: verifiedTool.exposedName,
    argsMasked: sanitizedArgsMasked,
    resultMasked: JSON.stringify({ status: 'awaiting_approval', approval_id: approvalId }),
    status: 'awaiting_approval',
    durationMs: Date.now() - startedAt,
    resultBytes: 0,
  });

  return {
    kind: 'awaiting_approval',
    approvalId,
    executionKey,
  };
}
