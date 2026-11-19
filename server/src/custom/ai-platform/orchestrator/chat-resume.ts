import type { Request } from 'express';
import type { Scope, ScopeKind, Wire } from '@freellmapi/shared/ai-platform.js';
import type {
  ChatMessage,
  ChatToolCall,
  ChatToolDefinition,
  McpApprovalView,
  TokenUsage,
} from '@freellmapi/shared/ai-platform-mcp.js';
import type {
  ChatApprovalContinuationView,
  ChatContinuationStatus,
} from '@freellmapi/shared/ai-platform-tracing-oauth.js';
import { getDb, getInternalLoopbackToken } from '../../../db/index.js';
import { decrypt, encrypt } from '../../../lib/crypto.js';
import { isPillarEnabled } from '../flags.js';
import { maskText } from '../masking.js';
import type { LoopSafeParams } from '../mcp-client/messages.js';
import { hasTable } from '../mcp-client/store.js';
import { normalizeScope } from '../scope.js';
import type { OrchestratorEngineDeps } from './engine.js';

interface ContinuationBatchItem {
  call: ChatToolCall;
  completedText?: string;
  pendingApprovalId?: number;
}

interface EncryptedChatContinuationPayload {
  version: 1;
  conversation: ChatMessage[];
  batchItems: ContinuationBatchItem[];
  callerTools: ChatToolDefinition[];
  maxRounds: number;
  roundsUsed: number;
  usageSoFar: TokenUsage;
  params?: LoopSafeParams;
  safeHeaders: Record<string, string>;
}

interface ChatContinuationRow {
  approval_id: number;
  scope_kind: ScopeKind;
  scope_id: string;
  end_user: string | null;
  wire: Wire;
  model: string;
  served_model: string | null;
  state_ciphertext: string;
  state_iv: string;
  state_tag: string;
  status: ChatContinuationStatus;
  assistant_message_masked: string | null;
  finish_reason: string | null;
  rounds: number;
  prompt_tokens: number;
  completion_tokens: number;
  next_approval_id: number | null;
  error_text: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface SavePausedChatContinuationInput {
  approvalId: number;
  scope: Scope;
  endUser: string | null;
  wire: Wire;
  model: string;
  servedModel: string | null;
  conversation: ChatMessage[];
  batchItems: ContinuationBatchItem[];
  callerTools: ChatToolDefinition[];
  maxRounds: number;
  roundsUsed: number;
  usageSoFar: TokenUsage;
  params?: LoopSafeParams;
  req?: Request;
}

const SAFE_CONTEXT_HEADERS = ['x-freellm-vars', 'x-end-user-name', 'accept-language'] as const;

function hasContinuationsTable(): boolean {
  try {
    return hasTable(getDb(), 'custom_ai_chat_continuations');
  } catch {
    return false;
  }
}

function captureSafeHeaders(req?: Request): Record<string, string> {
  const out: Record<string, string> = {};
  if (!req?.headers) return out;
  for (const name of SAFE_CONTEXT_HEADERS) {
    const raw = req.headers[name];
    const val = Array.isArray(raw) ? raw[0] : raw;
    if (typeof val === 'string' && val.length > 0 && val.length <= 2048) {
      out[name] = val;
    }
  }
  return out;
}

function extractAssistantText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
        return part.text;
      }
      return '';
    })
    .filter(Boolean)
    .join('');
}

function toContinuationView(row: ChatContinuationRow): ChatApprovalContinuationView {
  const promptTokens = Math.max(0, row.prompt_tokens ?? 0);
  const completionTokens = Math.max(0, row.completion_tokens ?? 0);
  return {
    approvalId: row.approval_id,
    scopeKind: row.scope_kind,
    scopeId: row.scope_id,
    endUser: row.end_user,
    wire: row.wire,
    model: row.model,
    servedModel: row.served_model,
    status: row.status,
    assistantMessageMasked: row.assistant_message_masked,
    finishReason: row.finish_reason,
    rounds: Math.max(0, row.rounds ?? 0),
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    nextApprovalId: row.next_approval_id,
    error: row.error_text,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function formatApprovedToolResult(
  serverSlug: string | null | undefined,
  exposedName: string | null | undefined,
  status: string,
  resultMasked: string | null | undefined,
  errorText: string | null | undefined,
): string {
  if (status === 'succeeded') {
    return `<tool_result server="${serverSlug ?? 'mcp'}" tool="${exposedName ?? 'tool'}" trust="untrusted">\n${resultMasked ?? ''}\n</tool_result>`;
  }
  return JSON.stringify({
    error: {
      type: 'tool_error',
      message: errorText ?? resultMasked ?? 'Approved tool execution did not succeed.',
    },
  });
}

async function buildSyntheticResumeRequest(
  scope: Scope,
  endUser: string | null,
  safeHeaders: Record<string, string>,
  inboundReq?: Request,
): Promise<Request> {
  let token = '';
  if (scope.kind === 'profile') {
    const profileId = Number(scope.id);
    if (Number.isInteger(profileId) && profileId > 0) {
      try {
        const row = getDb()
          .prepare('SELECT encrypted_key, iv, auth_tag FROM client_profiles WHERE id = ?')
          .get(profileId) as { encrypted_key: string; iv: string; auth_tag: string } | undefined;
        if (row?.encrypted_key && row.iv && row.auth_tag) {
          token = decrypt(row.encrypted_key, row.iv, row.auth_tag);
        }
      } catch {
        // Fallback below for test stubs without encrypted key
      }
    }
  }
  if (!token) {
    try {
      token = getInternalLoopbackToken();
    } catch {
      token = '';
    }
  }

  const engineMod = await import('./engine.js');
  const addr = engineMod.getServerSocketAddressForLoopback(inboundReq);

  return {
    headers: {
      ...safeHeaders,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(endUser ? { 'x-end-user': endUser } : {}),
    },
    originalUrl: '/v1/chat/completions',
    url: '/v1/chat/completions',
    path: '/v1/chat/completions',
    query: {},
    body: {},
    socket: {
      localAddress: addr.localAddress,
      localPort: addr.localPort,
    },
  } as unknown as Request;
}

export function savePausedChatContinuation(
  input: SavePausedChatContinuationInput,
): ChatApprovalContinuationView | null {
  if (!hasContinuationsTable()) return null;
  const normScope = normalizeScope(input.scope);

  const payload: EncryptedChatContinuationPayload = {
    version: 1,
    conversation: input.conversation,
    batchItems: input.batchItems,
    callerTools: input.callerTools,
    maxRounds: input.maxRounds,
    roundsUsed: input.roundsUsed,
    usageSoFar: input.usageSoFar,
    ...(input.params ? { params: input.params } : {}),
    safeHeaders: captureSafeHeaders(input.req),
  };

  const enc = encrypt(JSON.stringify(payload));
  const nowIso = new Date().toISOString();
  const promptTokens = Math.max(0, Math.trunc(input.usageSoFar.prompt_tokens ?? 0));
  const completionTokens = Math.max(0, Math.trunc(input.usageSoFar.completion_tokens ?? 0));

  const db = getDb();
  db.prepare(
    `INSERT INTO custom_ai_chat_continuations (
      approval_id, scope_kind, scope_id, end_user, wire, model, served_model,
      state_ciphertext, state_iv, state_tag, status, rounds,
      prompt_tokens, completion_tokens, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_approval', ?, ?, ?, ?, ?)
    ON CONFLICT(approval_id) DO UPDATE SET
      state_ciphertext = excluded.state_ciphertext,
      state_iv = excluded.state_iv,
      state_tag = excluded.state_tag,
      status = 'awaiting_approval',
      updated_at = excluded.updated_at`,
  ).run(
    input.approvalId,
    normScope.kind,
    normScope.id,
    input.endUser ?? null,
    input.wire,
    input.model,
    input.servedModel ?? null,
    enc.encrypted,
    enc.iv,
    enc.authTag,
    Math.max(1, Math.trunc(input.roundsUsed)),
    promptTokens,
    completionTokens,
    nowIso,
    nowIso,
  );

  return getChatApprovalContinuation(input.approvalId);
}

export function getChatApprovalContinuation(
  approvalId: number,
  scope?: Scope,
): ChatApprovalContinuationView | null {
  if (!hasContinuationsTable()) return null;
  const db = getDb();
  let row: ChatContinuationRow | undefined;
  if (scope) {
    const norm = normalizeScope(scope);
    row = db
      .prepare(
        `SELECT * FROM custom_ai_chat_continuations
          WHERE approval_id = ? AND scope_kind = ? AND scope_id = ?`,
      )
      .get(approvalId, norm.kind, norm.id) as ChatContinuationRow | undefined;
  } else {
    row = db
      .prepare('SELECT * FROM custom_ai_chat_continuations WHERE approval_id = ?')
      .get(approvalId) as ChatContinuationRow | undefined;
  }
  return row ? toContinuationView(row) : null;
}

export function expireChatContinuations(now: Date = new Date()): number {
  if (!hasContinuationsTable()) return 0;
  const db = getDb();
  const nowIso = now.toISOString();
  return db
    .prepare(
      `UPDATE custom_ai_chat_continuations
          SET status = 'expired',
              updated_at = ?,
              completed_at = COALESCE(completed_at, ?)
        WHERE status = 'awaiting_approval'
          AND approval_id IN (
            SELECT id FROM custom_ai_approvals WHERE status = 'expired'
          )`,
    )
    .run(nowIso, nowIso).changes;
}

/**
 * Automatically resumes a paused outer-chat MCP tool loop when its write-tool
 * approval is decided (`approveAction` / `rejectAction`), persisting the final
 * masked assistant completion in `custom_ai_chat_continuations`.
 */
export async function resumeChatContinuation(
  approvalId: number,
  decision: {
    approved: boolean;
    approval: McpApprovalView;
    req?: Request;
    deps?: OrchestratorEngineDeps;
  },
): Promise<ChatApprovalContinuationView | null> {
  if (!hasContinuationsTable()) return null;
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM custom_ai_chat_continuations WHERE approval_id = ?')
    .get(approvalId) as ChatContinuationRow | undefined;
  if (!row || row.status !== 'awaiting_approval') {
    return row ? toContinuationView(row) : null;
  }

  const scope: Scope = { kind: row.scope_kind, id: row.scope_id };
  const nowIso = new Date().toISOString();

  if (!decision.approved) {
    const rejectionText = decision.approval.decisionNote?.trim()
      ? `Tool execution was rejected by administrator: ${decision.approval.decisionNote.trim()}`
      : 'Tool execution was rejected by administrator.';
    const maskedRejection = maskText(scope, rejectionText);

    db.prepare(
      `UPDATE custom_ai_chat_continuations
          SET status = 'rejected',
              assistant_message_masked = ?,
              finish_reason = 'stop',
              updated_at = ?,
              completed_at = ?
        WHERE approval_id = ?`,
    ).run(maskedRejection, nowIso, nowIso, approvalId);

    return getChatApprovalContinuation(approvalId);
  }

  const claimed = db
    .prepare(
      `UPDATE custom_ai_chat_continuations
          SET status = 'resuming',
              updated_at = ?
        WHERE approval_id = ? AND status = 'awaiting_approval'`,
    )
    .run(nowIso, approvalId);
  if (claimed.changes === 0) {
    return getChatApprovalContinuation(approvalId);
  }

  let state: EncryptedChatContinuationPayload;
  try {
    const raw = decrypt(row.state_ciphertext, row.state_iv, row.state_tag);
    state = JSON.parse(raw) as EncryptedChatContinuationPayload;
  } catch {
    const errMsg = 'Failed to decrypt paused chat continuation state.';
    db.prepare(
      `UPDATE custom_ai_chat_continuations
          SET status = 'failed',
              error_text = ?,
              updated_at = ?,
              completed_at = ?
        WHERE approval_id = ?`,
    ).run(errMsg, new Date().toISOString(), new Date().toISOString(), approvalId);
    return getChatApprovalContinuation(approvalId);
  }

  const toolMessages: ChatMessage[] = [];
  for (const item of state.batchItems) {
    if (item.pendingApprovalId !== undefined) {
      if (item.pendingApprovalId === approvalId) {
        toolMessages.push({
          role: 'tool',
          tool_call_id: item.call.id,
          content: formatApprovedToolResult(
            decision.approval.serverSlug,
            decision.approval.exposedName ?? item.call.function.name,
            decision.approval.status,
            decision.approval.resultMasked,
            decision.approval.error,
          ),
        });
        continue;
      }

      const siblingRow = db
        .prepare(
          `SELECT a.id, a.status, a.result_masked, a.error_text, t.exposed_name, s.slug AS server_slug
             FROM custom_ai_approvals a
             LEFT JOIN custom_ai_mcp_tools t ON t.id = a.tool_id
             LEFT JOIN custom_ai_mcp_servers s ON s.id = t.server_id
            WHERE a.id = ?`,
        )
        .get(item.pendingApprovalId) as
        | {
            id: number;
            status: string;
            result_masked: string | null;
            error_text: string | null;
            exposed_name: string | null;
            server_slug: string | null;
          }
        | undefined;

      if (siblingRow && siblingRow.status === 'pending') {
        // Another write tool in the same batch is still pending approval; chain continuation to it.
        savePausedChatContinuation({
          approvalId: siblingRow.id,
          scope,
          endUser: row.end_user,
          wire: row.wire,
          model: row.model,
          servedModel: row.served_model,
          conversation: state.conversation,
          batchItems: state.batchItems.map((bi) =>
            bi.pendingApprovalId === approvalId
              ? {
                  call: bi.call,
                  completedText: formatApprovedToolResult(
                    decision.approval.serverSlug,
                    decision.approval.exposedName ?? bi.call.function.name,
                    decision.approval.status,
                    decision.approval.resultMasked,
                    decision.approval.error,
                  ),
                }
              : bi,
          ),
          callerTools: state.callerTools,
          maxRounds: state.maxRounds,
          roundsUsed: state.roundsUsed,
          usageSoFar: state.usageSoFar,
        });

        const doneIso = new Date().toISOString();
        db.prepare(
          `UPDATE custom_ai_chat_continuations
              SET status = 'completed',
                  next_approval_id = ?,
                  finish_reason = 'awaiting_approval',
                  updated_at = ?,
                  completed_at = ?
            WHERE approval_id = ?`,
        ).run(siblingRow.id, doneIso, doneIso, approvalId);
        return getChatApprovalContinuation(approvalId);
      }

      toolMessages.push({
        role: 'tool',
        tool_call_id: item.call.id,
        content: siblingRow
          ? formatApprovedToolResult(
              siblingRow.server_slug,
              siblingRow.exposed_name ?? item.call.function.name,
              siblingRow.status,
              siblingRow.result_masked,
              siblingRow.error_text,
            )
          : JSON.stringify({ error: { type: 'tool_error', message: 'Sibling approval missing.' } }),
      });
    } else {
      toolMessages.push({
        role: 'tool',
        tool_call_id: item.call.id,
        content: item.completedText ?? '',
      });
    }
  }

  const resumedConversation: ChatMessage[] = [...state.conversation, ...toolMessages];
  const remainingRounds = Math.max(1, state.maxRounds - state.roundsUsed);
  const ac = new AbortController();

  try {
    const syntheticReq = await buildSyntheticResumeRequest(
      scope,
      row.end_user,
      state.safeHeaders,
      decision.req,
    );
    const { runToolLoop } = await import('../mcp-client/tool-loop.js');
    const loopRes = await runToolLoop(
      syntheticReq,
      {
        scope,
        messages: resumedConversation,
        model: row.model,
        callerTools: state.callerTools,
        maxRounds: remainingRounds,
        signal: ac.signal,
        endUser: row.end_user,
        wire: row.wire,
        params: state.params,
      },
      {
        ...(decision.deps?.callGateway ? { callGateway: decision.deps.callGateway } : {}),
        ...(decision.deps?.toolsForScope ? { toolsForScope: decision.deps.toolsForScope } : {}),
        ...(decision.deps?.executeTool ? { executeTool: decision.deps.executeTool } : {}),
      },
    );

    const totalPrompt =
      Math.max(0, state.usageSoFar.prompt_tokens ?? 0) +
      Math.max(0, loopRes.usage.prompt_tokens ?? 0);
    const totalCompletion =
      Math.max(0, state.usageSoFar.completion_tokens ?? 0) +
      Math.max(0, loopRes.usage.completion_tokens ?? 0);
    const totalRounds = state.roundsUsed + loopRes.rounds;
    let finalText = extractAssistantText(loopRes.message.content);
    let finishReason = loopRes.finishReason || 'stop';

    if (!loopRes.pendingApprovalId && finalText && isPillarEnabled('outputGuard')) {
      try {
        const evalFn =
          decision.deps?.evaluateOutput ??
          (await import('../output-guard/policy.js')).evaluateOutput;
        const guardRes = await evalFn(scope, finalText, {
          req: syntheticReq,
          signal: ac.signal,
          endUser: row.end_user,
          wire: row.wire,
          stream: false,
          systemPrompt: null,
          canCallGateway: true,
        });
        if (guardRes.action !== 'pass') {
          finalText = guardRes.text;
          if (guardRes.action === 'blocked') {
            finishReason = 'content_filter';
          }
        }
      } catch {
        // Best-effort guard evaluation on async resume
      }
    }

    const maskedText = finalText ? maskText(scope, finalText) : null;
    const doneIso = new Date().toISOString();

    db.prepare(
      `UPDATE custom_ai_chat_continuations
          SET status = 'completed',
              served_model = ?,
              assistant_message_masked = ?,
              finish_reason = ?,
              rounds = ?,
              prompt_tokens = ?,
              completion_tokens = ?,
              next_approval_id = ?,
              error_text = NULL,
              updated_at = ?,
              completed_at = ?
        WHERE approval_id = ?`,
    ).run(
      loopRes.servedModel ?? row.served_model ?? row.model,
      maskedText,
      finishReason,
      totalRounds,
      totalPrompt,
      totalCompletion,
      loopRes.pendingApprovalId ?? null,
      doneIso,
      doneIso,
      approvalId,
    );

    return getChatApprovalContinuation(approvalId);
  } catch (err) {
    const errMsg = maskText(
      scope,
      err instanceof Error ? err.message : 'Chat continuation resume failed.',
    ).slice(0, 400);
    const doneIso = new Date().toISOString();
    db.prepare(
      `UPDATE custom_ai_chat_continuations
          SET status = 'failed',
              error_text = ?,
              updated_at = ?,
              completed_at = ?
        WHERE approval_id = ?`,
    ).run(errMsg, doneIso, doneIso, approvalId);
    return getChatApprovalContinuation(approvalId);
  }
}
