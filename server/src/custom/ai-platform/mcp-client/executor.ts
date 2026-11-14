import crypto from 'node:crypto';
import type { Scope } from '@freellmapi/shared/ai-platform.js';
import {
  type BoundTool,
  type McpToolCallStatus,
  type ToolContext,
  type ToolExecutionErrorType,
  type ToolExecutionResult,
} from '@freellmapi/shared/ai-platform-mcp.js';
import { getDb } from '../../../db/index.js';
import { maskData, maskText } from '../masking.js';
import { normalizeScope } from '../scope.js';
import { validateScope } from './bindings.js';
import { recordToolCall } from './calls.js';
import { assertToolExecutable, recordServerOutcome } from './registry.js';
import { canonicalJson, type McpTransportConfig } from './store.js';
import {
  McpTransportError,
  mcpCallTool,
  mcpInitialize,
} from './transport.js';

const SENSITIVE_KEY_RE =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-goog-api-key|secret|token|password|apiKey|api_key|accessToken|access_token)$/i;

function scrubSecretEcho(text: string, secret: string | null | undefined): string {
  let out = String(text ?? '');
  if (secret && secret.length > 0) {
    out = out.split(secret).join('[redacted]');
  }
  out = out.replace(/\bBearer\s+[A-Za-z0-9._-]{6,}\b/gi, 'Bearer [redacted]');
  return out;
}

function scrubSensitiveKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubSensitiveKeys);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY_RE.test(k) ? '[redacted]' : scrubSensitiveKeys(v);
    }
    return out;
  }
  return value;
}

export function maskArgsForLog(
  scope: Scope,
  args: unknown,
  secret: string | null | undefined,
  role?: string,
): string {
  const scrubbed = scrubSensitiveKeys(args ?? {});
  const maskedObj = maskData(scope, scrubbed, role);
  const raw = JSON.stringify(maskedObj);
  return scrubSecretEcho(maskText(scope, raw, role), secret);
}

function maskTextForOutput(
  scope: Scope,
  text: string,
  secret: string | null | undefined,
  role?: string,
): string {
  return scrubSecretEcho(maskText(scope, text, role), secret);
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
  callStatus: McpToolCallStatus;
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
    const checked = assertToolExecutable(tool.toolId, tool.schemaHash);
    verifiedTool = checked.tool;
    config = checked.config;
    if (verifiedTool.effect !== 'read') {
      throw new Error('Tool effect changed to write.');
    }
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const msg = maskText(normScope, err instanceof Error ? err.message : 'Tool blocked.', ctx.role);
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
    const session = await mcpInitialize(config, ctx.signal);
    const res = await mcpCallTool(
      config,
      session,
      verifiedTool.name,
      schemaCheck.normalized,
      ctx.signal,
      { retryOn404: true },
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
    const transportErr =
      err instanceof McpTransportError
        ? err
        : new McpTransportError('http', err instanceof Error ? err.message : 'Transport failure');
    const maskedErr = maskTextForOutput(normScope, transportErr.message, config.secret, ctx.role);
    recordServerOutcome(config.serverId, { ok: false, error: maskedErr });

    const { callStatus, errorType } = mapTransportErrorToStatus(transportErr);
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
      `SELECT id, status, tool_id, execution_key, scope_kind, scope_id
         FROM custom_ai_approvals
        WHERE id = ? AND execution_key = ? AND tool_id = ? AND scope_kind = ? AND scope_id = ?`,
    )
    .get(
      ctx.approvalId,
      ctx.executionKey,
      ctx.toolId,
      normScope.kind,
      normScope.id,
    ) as { id: number; status: string } | undefined;

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
  try {
    validateScope(normScope);
    if (!isToolBoundToScope(ctx.toolId, normScope)) {
      throw new Error('Tool is no longer bound to scope.');
    }
    const checked = assertToolExecutable(ctx.toolId);
    verifiedTool = checked.tool;
    config = checked.config;
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const msg = maskText(normScope, err instanceof Error ? err.message : 'Tool blocked.', ctx.role);
    recordToolCall({
      runId: ctx.runId ?? null,
      executionKey: ctx.executionKey,
      scope: normScope,
      endUser: ctx.endUser,
      role: ctx.role,
      serverId: 0,
      toolName: `tool#${ctx.toolId}`,
      argsMasked: maskArgsForLog(normScope, ctx.args, null, ctx.role),
      resultMasked: msg,
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
    recordToolCall({
      runId: ctx.runId ?? null,
      executionKey: ctx.executionKey,
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
      ok: false,
      status: 'failed',
      resultMasked: schemaCheck.reason,
      error: schemaCheck.reason,
      durationMs,
      resultBytes: 0,
    };
  }

  try {
    const session = await mcpInitialize(config, ctx.signal);
    const res = await mcpCallTool(
      config,
      session,
      verifiedTool.name,
      schemaCheck.normalized,
      ctx.signal,
      { retryOn404: false },
    );
    const durationMs = Date.now() - startedAt;
    recordServerOutcome(config.serverId, {
      ok: true,
      protocolVersion: session.protocolVersion,
      serverInfo: session.serverInfo ?? undefined,
    });

    const maskedContent = maskTextForOutput(normScope, res.content, config.secret, ctx.role);
    recordToolCall({
      runId: ctx.runId ?? null,
      executionKey: ctx.executionKey,
      scope: normScope,
      endUser: ctx.endUser,
      role: ctx.role,
      serverId: verifiedTool.serverId,
      toolName: verifiedTool.exposedName,
      argsMasked,
      resultMasked: maskedContent,
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
    const transportErr =
      err instanceof McpTransportError
        ? err
        : new McpTransportError('http', err instanceof Error ? err.message : 'Transport failure');
    const maskedErr = maskTextForOutput(normScope, transportErr.message, config.secret, ctx.role);
    recordServerOutcome(config.serverId, { ok: false, error: maskedErr });

    const { callStatus } = mapTransportErrorToStatus(transportErr);
    recordToolCall({
      runId: ctx.runId ?? null,
      executionKey: ctx.executionKey,
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
      ok: false,
      status: transportErr.uncertain ? 'unknown' : 'failed',
      resultMasked: maskedErr,
      error: maskedErr,
      durationMs,
      resultBytes: 0,
    };
  }
}
