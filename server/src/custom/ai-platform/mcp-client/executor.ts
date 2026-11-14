import crypto from 'node:crypto';
import type { Scope } from '@freellmapi/shared/ai-platform.js';
import {
  type BoundTool,
  type McpJournalOutcomeStatus,
  type McpToolCallStatus,
  type ToolContext,
  type ToolExecutionErrorType,
  type ToolExecutionResult,
} from '@freellmapi/shared/ai-platform-mcp.js';
import { getDb } from '../../../db/index.js';
import { maskData, maskText } from '../masking.js';
import { normalizeScope } from '../scope.js';
import {
  assertApprovalExecutable,
  assertScopeEffective,
} from './approval-safety.js';
import { validateScope } from './bindings.js';
import {
  getToolCallByExecutionKey,
  recordToolCall,
  transitionToolCallOutcome,
} from './calls.js';
import { assertToolExecutable, recordServerOutcome } from './registry.js';
import {
  sanitizeMcpError,
  sanitizeMcpText,
  scrubSensitiveKeys,
} from './sanitize.js';
import { canonicalJson, McpConflictError, McpServiceError, type McpTransportConfig } from './store.js';
import {
  McpTransportError,
  computeOperationDeadlineMs,
  mcpCallTool,
  mcpInitialize,
} from './transport.js';

export function maskArgsForLog(
  scope: Scope,
  args: unknown,
  secret: string | null | undefined,
  role?: string,
): string {
  const scrubbed = scrubSensitiveKeys(args ?? {}, [secret]);
  const maskedObj = maskData(scope, scrubbed, role);
  const raw = JSON.stringify(maskedObj);
  return sanitizeMcpText(maskText(scope, raw, role), [secret]);
}

function maskTextForOutput(
  scope: Scope,
  text: string,
  secret: string | null | undefined,
  role?: string,
): string {
  return sanitizeMcpText(maskText(scope, text, role), [secret]);
}

class PreDispatchBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreDispatchBlockedError';
  }
}

function isPreDispatchBlock(err: unknown): boolean {
  return (
    err instanceof PreDispatchBlockedError ||
    err instanceof McpConflictError ||
    err instanceof McpServiceError
  );
}

function persistClaimedWriteOutcome(params: {
  runId: string | null;
  executionKey: string;
  scope: Scope;
  endUser: string | null;
  role?: string;
  serverId: number;
  toolName: string;
  argsMasked: string;
  resultMasked: string;
  errorText?: string | null;
  status: McpJournalOutcomeStatus;
  durationMs: number;
  resultBytes: number;
}): void {
  if (getToolCallByExecutionKey(params.executionKey)) {
    transitionToolCallOutcome(params.executionKey, {
      status: params.status,
      resultMasked: params.resultMasked,
      errorText: params.errorText ?? null,
      durationMs: params.durationMs,
      resultBytes: params.resultBytes,
    });
    return;
  }
  recordToolCall({
    runId: params.runId,
    executionKey: params.executionKey,
    scope: params.scope,
    endUser: params.endUser,
    role: params.role,
    serverId: params.serverId,
    toolName: params.toolName,
    argsMasked: params.argsMasked,
    resultMasked: params.resultMasked,
    status: params.status,
    durationMs: params.durationMs,
    resultBytes: params.resultBytes,
  });
}

function wrapUntrustedToolResult(serverSlug: string, toolName: string, content: string): string {
  return `<tool_result server="${serverSlug}" tool="${toolName}" trust="untrusted">\n${content}\n</tool_result>`;
}

export function formatToolErrorJson(type: ToolExecutionErrorType, message: string): string {
  return JSON.stringify({ error: { type, message } });
}

export function validateArgsAgainstSchema(
  schema: Record<string, unknown>,
  args: unknown,
): { ok: true; normalized: Record<string, unknown> } | { ok: false; reason: string } {
  const normalized =
    args === undefined || args === null
      ? {}
      : typeof args === 'object' && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : null;

  if (!normalized) {
    return { ok: false, reason: 'Tool arguments must be a JSON object.' };
  }

  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (typeof key === 'string' && !(key in normalized)) {
      return { ok: false, reason: `Missing required argument '${key}'.` };
    }
  }

  const props =
    schema.properties && typeof schema.properties === 'object'
      ? (schema.properties as Record<string, { type?: unknown }>)
      : {};

  for (const [key, propSchema] of Object.entries(props)) {
    if (!(key in normalized) || normalized[key] === undefined) continue;
    const expectedType = propSchema?.type;
    const val = normalized[key];
    if (expectedType === 'string' && typeof val !== 'string') {
      return { ok: false, reason: `Argument '${key}' must be a string.` };
    }
    if (expectedType === 'number' && (typeof val !== 'number' || !Number.isFinite(val))) {
      return { ok: false, reason: `Argument '${key}' must be a number.` };
    }
    if (expectedType === 'integer' && (typeof val !== 'number' || !Number.isInteger(val))) {
      return { ok: false, reason: `Argument '${key}' must be an integer.` };
    }
    if (expectedType === 'boolean' && typeof val !== 'boolean') {
      return { ok: false, reason: `Argument '${key}' must be a boolean.` };
    }
    if (expectedType === 'array' && !Array.isArray(val)) {
      return { ok: false, reason: `Argument '${key}' must be an array.` };
    }
    if (expectedType === 'object' && (!val || typeof val !== 'object' || Array.isArray(val))) {
      return { ok: false, reason: `Argument '${key}' must be an object.` };
    }
  }

  return { ok: true, normalized };
}

export function isToolBoundToScope(toolId: number, scope: Scope): boolean {
  const row = getDb()
    .prepare(
      'SELECT 1 FROM custom_ai_tool_bindings WHERE tool_id = ? AND scope_kind = ? AND scope_id = ?',
    )
    .get(toolId, scope.kind, scope.id);
  return Boolean(row);
}

function mapTransportErrorToStatus(err: McpTransportError): {
  callStatus: McpJournalOutcomeStatus;
  errorType: ToolExecutionErrorType;
} {
  if (err.code === 'timeout') {
    return { callStatus: 'timeout', errorType: 'timeout' };
  }
  if (err.code === 'too_large') {
    return { callStatus: 'too_large', errorType: 'too_large' };
  }
  return { callStatus: 'transport_error', errorType: 'transport_error' };
}

function buildReadExecutionKey(ctx: ToolContext, tool: BoundTool, args: unknown): string {
  return crypto
    .createHash('sha256')
    .update(
      canonicalJson({
        kind: 'read',
        turnId: ctx.turnId,
        stepSeq: ctx.stepSeq,
        toolId: tool.toolId,
        exposedName: tool.exposedName,
        args: args ?? {},
      }),
      'utf8',
    )
    .digest('hex');
}

export async function executeReadTool(
  ctx: ToolContext,
  tool: BoundTool,
  args: unknown,
): Promise<ToolExecutionResult> {
  const startedAt = Date.now();
  let normScope: Scope;
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

  const executionKey = buildReadExecutionKey(ctx, tool, args);
  const argsMaskedFallback = maskArgsForLog(normScope, args, null, ctx.role);

  if (tool.effect !== 'read' || !isToolBoundToScope(tool.toolId, normScope)) {
    const durationMs = Date.now() - startedAt;
    const msg =
      tool.effect !== 'read'
        ? 'Write tools cannot be executed via executeReadTool.'
        : 'Tool is not bound to the active scope.';
    recordToolCall({
      runId: ctx.runId ?? null,
      executionKey,
      scope: normScope,
      endUser: ctx.endUser,
      role: ctx.role,
      serverId: tool.serverId,
      toolName: tool.exposedName,
      argsMasked: argsMaskedFallback,
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
  let config: McpTransportConfig;
  try {
    await assertScopeEffective(normScope.kind, normScope.id);
    const checked = assertToolExecutable(tool.toolId, tool.schemaHash);
    verifiedTool = checked.tool;
    config = checked.config;
    if (verifiedTool.effect !== 'read') {
      throw new Error('Tool effect changed to write.');
    }
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const msg = maskText(normScope, sanitizeMcpError(err), ctx.role);
    recordToolCall({
      runId: ctx.runId ?? null,
      executionKey,
      scope: normScope,
      endUser: ctx.endUser,
      role: ctx.role,
      serverId: tool.serverId,
      toolName: tool.exposedName,
      argsMasked: argsMaskedFallback,
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

  const argsMasked = maskArgsForLog(normScope, args, config.secret, ctx.role);
  const schemaCheck = validateArgsAgainstSchema(verifiedTool.inputSchema, args);
  if (!schemaCheck.ok) {
    const durationMs = Date.now() - startedAt;
    recordToolCall({
      runId: ctx.runId ?? null,
      executionKey,
      scope: normScope,
      endUser: ctx.endUser,
      role: ctx.role,
      serverId: verifiedTool.serverId,
      toolName: verifiedTool.exposedName,
      argsMasked,
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

  try {
    const readGuard = async () => {
      await assertScopeEffective(normScope.kind, normScope.id);
      if (!isToolBoundToScope(verifiedTool.toolId, normScope)) {
        throw new PreDispatchBlockedError('Tool is no longer bound to the active scope.');
      }
      const latest = assertToolExecutable(verifiedTool.toolId, verifiedTool.schemaHash);
      if (latest.tool.effect !== 'read') {
        throw new PreDispatchBlockedError('Tool effect changed to write.');
      }
      if (latest.config.revision !== config.revision ||
          latest.config.url !== config.url ||
          latest.config.credentialGeneration !== config.credentialGeneration) {
        throw new PreDispatchBlockedError('MCP server configuration changed before dispatch.');
      }
    };
    const deadlineAtMs = computeOperationDeadlineMs(config.timeoutMs);
    const session = await mcpInitialize(config, ctx.signal, {
      deadlineAtMs,
      preDispatchGuard: readGuard,
    });
    const res = await mcpCallTool(
      config,
      session,
      verifiedTool.name,
      schemaCheck.normalized,
      ctx.signal,
      { retryOn404: true, deadlineAtMs, preDispatchGuard: readGuard },
    );
    const durationMs = Date.now() - startedAt;
    recordServerOutcome(config.serverId, {
      ok: true,
      protocolVersion: session.protocolVersion,
      serverInfo: session.serverInfo ?? undefined,
    });

    const maskedContent = maskTextForOutput(normScope, res.content, config.secret, ctx.role);
    const status: McpToolCallStatus = res.isError ? 'tool_error' : 'ok';

    recordToolCall({
      runId: ctx.runId ?? null,
      executionKey,
      scope: normScope,
      endUser: ctx.endUser,
      role: ctx.role,
      serverId: verifiedTool.serverId,
      toolName: verifiedTool.exposedName,
      argsMasked,
      resultMasked: maskedContent,
      status,
      durationMs,
      resultBytes: res.bytes,
    });

    if (res.isError) {
      return {
        kind: 'error',
        errorType: 'tool_error',
        text: formatToolErrorJson('tool_error', maskedContent),
        durationMs,
      };
    }

    return {
      kind: 'result',
      text: wrapUntrustedToolResult(verifiedTool.serverSlug, verifiedTool.name, maskedContent),
      bytes: res.bytes,
      truncated: res.truncated,
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const blocked = isPreDispatchBlock(err);
    const transportErr =
      err instanceof McpTransportError
        ? err
        : new McpTransportError('http', err instanceof Error ? err.message : 'Transport failure');
    const maskedErr = maskTextForOutput(normScope, transportErr.message, config.secret, ctx.role);
    if (!blocked) recordServerOutcome(config.serverId, { ok: false, error: maskedErr });

    const { callStatus, errorType } = blocked
      ? { callStatus: 'blocked' as const, errorType: 'blocked' as const }
      : mapTransportErrorToStatus(transportErr);
    recordToolCall({
      runId: ctx.runId ?? null,
      executionKey,
      scope: normScope,
      endUser: ctx.endUser,
      role: ctx.role,
      serverId: verifiedTool.serverId,
      toolName: verifiedTool.exposedName,
      argsMasked,
      resultMasked: maskedErr,
      status: callStatus,
      durationMs,
      resultBytes: 0,
    });

    return {
      kind: 'error',
      errorType,
      text: formatToolErrorJson(errorType, maskedErr),
      durationMs,
    };
  }
}

export async function executeClaimedWrite(ctx: {
  approvalId: number;
  executionKey: string;
  scope: Scope;
  endUser: string | null;
  role?: string;
  runId?: string | null;
  toolId: number;
  args: unknown;
  signal: AbortSignal;
}): Promise<{
  ok: boolean;
  status: 'succeeded' | 'failed' | 'unknown';
  resultMasked: string;
  error?: string;
  durationMs: number;
  resultBytes: number;
}> {
  const startedAt = Date.now();
  const normScope = normalizeScope(ctx.scope);

  const claimRow = getDb()
    .prepare(
      `SELECT id, status, tool_id, execution_key, scope_kind, scope_id, snapshot_json
         FROM custom_ai_approvals
        WHERE id = ? AND execution_key = ? AND tool_id = ? AND scope_kind = ? AND scope_id = ?`,
    )
    .get(
      ctx.approvalId,
      ctx.executionKey,
      ctx.toolId,
      normScope.kind,
      normScope.id,
    ) as { id: number; status: string; snapshot_json: string | null } | undefined;

  if (!claimRow || claimRow.status !== 'executing') {
    const msg = 'Approval claim is missing or not in executing state.';
    return {
      ok: false,
      status: 'failed',
      resultMasked: msg,
      error: msg,
      durationMs: Date.now() - startedAt,
      resultBytes: 0,
    };
  }

  let verifiedTool: BoundTool;
  let config: McpTransportConfig;
  let snapshotSchemaHash: string;
  let snapshotServerUrl: string;
  let snapshotCredGen: number;
  try {
    validateScope(normScope);
    const snapshot = await assertApprovalExecutable(claimRow.snapshot_json);
    if (
      snapshot.toolId !== ctx.toolId ||
      snapshot.scopeKind !== normScope.kind ||
      snapshot.scopeId !== normScope.id
    ) {
      throw new PreDispatchBlockedError('Approval snapshot does not match execution claim.');
    }
    const checked = assertToolExecutable(ctx.toolId, snapshot.schemaHash);
    verifiedTool = checked.tool;
    config = checked.config;
    if (
      config.url !== snapshot.serverUrl ||
      config.credentialGeneration !== snapshot.credentialGeneration
    ) {
      throw new PreDispatchBlockedError('MCP server identity or credentials changed after approval.');
    }
    snapshotSchemaHash = snapshot.schemaHash;
    snapshotServerUrl = snapshot.serverUrl;
    snapshotCredGen = snapshot.credentialGeneration;
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const msg = maskText(normScope, sanitizeMcpError(err), ctx.role);
    persistClaimedWriteOutcome({
      runId: ctx.runId ?? null,
      executionKey: ctx.executionKey,
      scope: normScope,
      endUser: ctx.endUser,
      role: ctx.role,
      serverId: 0,
      toolName: `tool#${ctx.toolId}`,
      argsMasked: maskArgsForLog(normScope, ctx.args, null, ctx.role),
      resultMasked: msg,
      errorText: msg,
      status: 'blocked',
      durationMs,
      resultBytes: 0,
    });
    return {
      ok: false,
      status: 'failed',
      resultMasked: msg,
      error: msg,
      durationMs,
      resultBytes: 0,
    };
  }

  const argsMasked = maskArgsForLog(normScope, ctx.args, config.secret, ctx.role);
  const schemaCheck = validateArgsAgainstSchema(verifiedTool.inputSchema, ctx.args);
  if (!schemaCheck.ok) {
    const durationMs = Date.now() - startedAt;
    persistClaimedWriteOutcome({
      runId: ctx.runId ?? null,
      executionKey: ctx.executionKey,
      scope: normScope,
      endUser: ctx.endUser,
      role: ctx.role,
      serverId: verifiedTool.serverId,
      toolName: verifiedTool.exposedName,
      argsMasked,
      resultMasked: schemaCheck.reason,
      errorText: schemaCheck.reason,
      status: 'tool_error',
      durationMs,
      resultBytes: 0,
    });
    return {
      ok: false,
      status: 'failed',
      resultMasked: schemaCheck.reason,
      error: schemaCheck.reason,
      durationMs,
      resultBytes: 0,
    };
  }

  try {
    const writeGuard = async () => {
      const latestClaim = getDb()
        .prepare(
          `SELECT status, snapshot_json
             FROM custom_ai_approvals
            WHERE id = ? AND execution_key = ? AND tool_id = ? AND scope_kind = ? AND scope_id = ?`,
        )
        .get(
          ctx.approvalId,
          ctx.executionKey,
          ctx.toolId,
          normScope.kind,
          normScope.id,
        ) as { status: string; snapshot_json: string | null } | undefined;
      if (!latestClaim || latestClaim.status !== 'executing') {
        throw new PreDispatchBlockedError('Approval claim is no longer in executing state.');
      }
      const latestSnap = await assertApprovalExecutable(latestClaim.snapshot_json);
      if (
        latestSnap.schemaHash !== snapshotSchemaHash ||
        latestSnap.serverUrl !== snapshotServerUrl ||
        latestSnap.credentialGeneration !== snapshotCredGen
      ) {
        throw new PreDispatchBlockedError('Approval snapshot changed before dispatch.');
      }
      const latestChecked = assertToolExecutable(ctx.toolId, snapshotSchemaHash);
      if (
        latestChecked.config.url !== snapshotServerUrl ||
        latestChecked.config.credentialGeneration !== snapshotCredGen
      ) {
        throw new PreDispatchBlockedError('MCP server identity changed before dispatch.');
      }
    };

    const deadlineAtMs = computeOperationDeadlineMs(config.timeoutMs);
    const session = await mcpInitialize(config, ctx.signal, {
      deadlineAtMs,
      preDispatchGuard: writeGuard,
    });
    const res = await mcpCallTool(
      config,
      session,
      verifiedTool.name,
      schemaCheck.normalized,
      ctx.signal,
      { retryOn404: false, deadlineAtMs, preDispatchGuard: writeGuard },
    );
    const durationMs = Date.now() - startedAt;
    recordServerOutcome(config.serverId, {
      ok: true,
      protocolVersion: session.protocolVersion,
      serverInfo: session.serverInfo ?? undefined,
    });

    const maskedContent = maskTextForOutput(normScope, res.content, config.secret, ctx.role);
    persistClaimedWriteOutcome({
      runId: ctx.runId ?? null,
      executionKey: ctx.executionKey,
      scope: normScope,
      endUser: ctx.endUser,
      role: ctx.role,
      serverId: verifiedTool.serverId,
      toolName: verifiedTool.exposedName,
      argsMasked,
      resultMasked: maskedContent,
      errorText: res.isError ? maskedContent : null,
      status: res.isError ? 'tool_error' : 'ok',
      durationMs,
      resultBytes: res.bytes,
    });

    if (res.isError) {
      return {
        ok: false,
        status: 'failed',
        resultMasked: maskedContent,
        error: maskedContent,
        durationMs,
        resultBytes: res.bytes,
      };
    }

    return {
      ok: true,
      status: 'succeeded',
      resultMasked: maskedContent,
      durationMs,
      resultBytes: res.bytes,
    };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    if (isPreDispatchBlock(err)) {
      const maskedBlock = maskTextForOutput(
        normScope,
        sanitizeMcpError(err, [config.secret]),
        config.secret,
        ctx.role,
      );
      persistClaimedWriteOutcome({
        runId: ctx.runId ?? null,
        executionKey: ctx.executionKey,
        scope: normScope,
        endUser: ctx.endUser,
        role: ctx.role,
        serverId: verifiedTool.serverId,
        toolName: verifiedTool.exposedName,
        argsMasked,
        resultMasked: maskedBlock,
        errorText: maskedBlock,
        status: 'blocked',
        durationMs,
        resultBytes: 0,
      });
      return {
        ok: false,
        status: 'failed',
        resultMasked: maskedBlock,
        error: maskedBlock,
        durationMs,
        resultBytes: 0,
      };
    }

    const transportErr =
      err instanceof McpTransportError
        ? err
        : new McpTransportError('http', sanitizeMcpError(err, [config.secret]));
    const maskedErr = maskTextForOutput(normScope, transportErr.message, config.secret, ctx.role);
    recordServerOutcome(config.serverId, { ok: false, error: maskedErr });

    const { callStatus } = mapTransportErrorToStatus(transportErr);
    persistClaimedWriteOutcome({
      runId: ctx.runId ?? null,
      executionKey: ctx.executionKey,
      scope: normScope,
      endUser: ctx.endUser,
      role: ctx.role,
      serverId: verifiedTool.serverId,
      toolName: verifiedTool.exposedName,
      argsMasked,
      resultMasked: maskedErr,
      errorText: maskedErr,
      status: callStatus,
      durationMs,
      resultBytes: 0,
    });

    return {
      ok: false,
      status: transportErr.uncertain ? 'unknown' : 'failed',
      resultMasked: maskedErr,
      error: maskedErr,
      durationMs,
      resultBytes: 0,
    };
  }
}
