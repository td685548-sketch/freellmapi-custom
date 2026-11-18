import type { Request } from 'express';
import type { Scope, ScopeKind } from '@freellmapi/shared/ai-platform.js';
import type {
  ChatMessage,
  ChatToolDefinition,
  McpApprovalStatus,
  McpContinuationStatus,
  PublicMcpApprovalResponse,
} from '@freellmapi/shared/ai-platform-mcp.js';
import { getDb, getUnifiedApiKey, type Db } from '../../../db/index.js';
import { contentToString } from '../../../lib/content.js';
import { decrypt, encrypt } from '../../../lib/crypto.js';
import { maskText } from '../masking.js';
import { getRecordedServerAddress } from '../orchestrator/engine.js';
import type { LoopSafeParams } from './messages.js';
import { sanitizeMcpError, sanitizeMcpText } from './sanitize.js';
import type { ToolLoopDeps } from './tool-loop.js';

export interface ChatContinuationBatchItem {
  toolCallId: string;
  toolName: string;
  text: string;
  pendingApprovalId: number | null;
}

export interface ChatContinuationState {
  version: 1;
  scope: Scope;
  endUser: string | null;
  model: string;
  callerTools: ChatToolDefinition[];
  maxRounds: number;
  roundsUsed: number;
  params?: LoopSafeParams;
  conversationWithAssistantCall: ChatMessage[];
  batchResults: ChatContinuationBatchItem[];
}

interface ApprovalContinuationRow {
  id: number;
  run_id: string | null;
  scope_kind: ScopeKind;
  scope_id: string;
  end_user: string | null;
  status: McpApprovalStatus;
  decision_note: string | null;
  result_masked: string | null;
  error_text: string | null;
  executed_at: string | null;
  expires_at: string;
  created_at: string;
  continuation_ciphertext: string | null;
  continuation_iv: string | null;
  continuation_tag: string | null;
  continuation_status: McpContinuationStatus | null;
  continuation_reply_masked: string | null;
  continuation_next_approval_id: number | null;
  continuation_model: string | null;
  continuation_error: string | null;
  continuation_finished_at: string | null;
  tool_name?: string | null;
  exposed_name?: string | null;
  server_id?: number | null;
}

function collectScopeSecrets(serverId?: number | null): string[] {
  const db = getDb();
  const rows = (
    serverId != null
      ? db
          .prepare(
            `SELECT auth_ciphertext, auth_iv, auth_tag
               FROM custom_ai_mcp_servers
              WHERE id = ? AND auth_ciphertext IS NOT NULL`,
          )
          .all(serverId)
      : db
          .prepare(
            `SELECT auth_ciphertext, auth_iv, auth_tag
               FROM custom_ai_mcp_servers
              WHERE auth_ciphertext IS NOT NULL`,
          )
          .all()
  ) as Array<{ auth_ciphertext: string; auth_iv: string | null; auth_tag: string | null }>;

  const secrets: string[] = [];
  for (const row of rows) {
    if (!row.auth_ciphertext || !row.auth_iv || !row.auth_tag) continue;
    try {
      const val = decrypt(row.auth_ciphertext, row.auth_iv, row.auth_tag);
      if (val.length > 0) secrets.push(val);
    } catch {
      // Skip undecryptable credentials when building redaction list.
    }
  }
  return secrets;
}

function buildContinuationLoopbackReq(
  scope: Scope,
  endUser: string | null,
  inboundReq?: Request,
): Request {
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
        // Fallback below if key cannot be decrypted.
      }
    }
  }
  if (!token) {
    token = getUnifiedApiKey();
  }

  const addr = getRecordedServerAddress(inboundReq);
  return {
    headers: {
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

/**
 * Persist an encrypted non-Flow chat continuation snapshot on `custom_ai_approvals`
 * so approving or rejecting the tool call can resume the assistant response turn.
 */
export function saveChatApprovalContinuation(
  approvalId: number,
  state: ChatContinuationState,
): void {
  const db = getDb();
  const encrypted = encrypt(JSON.stringify(state));
  db.prepare(
    `UPDATE custom_ai_approvals
        SET continuation_ciphertext = ?,
            continuation_iv = ?,
            continuation_tag = ?,
            continuation_status = 'pending'
      WHERE id = ? AND run_id IS NULL`,
  ).run(encrypted.encrypted, encrypted.iv, encrypted.authTag, approvalId);
}

/**
 * Mark pending chat continuations as `'expired'` once their parent approval expires.
 */
export function expireChatContinuations(db: Db): void {
  try {
    db.prepare(
      `UPDATE custom_ai_approvals
          SET continuation_status = 'expired',
              continuation_finished_at = COALESCE(continuation_finished_at, datetime('now'))
        WHERE status = 'expired' AND continuation_status = 'pending'`,
    ).run();
  } catch {
    // Non-fatal if continuation columns are not yet present in synthetic unit DBs.
  }
}

/**
 * Synchronously update the continuation status to `'running'` (when approved) or `'rejected'`,
 * and return an async continuation worker promise when approved so callers can either await
 * briefly or let it complete in the background.
 */
export function resumeChatContinuation(
  approvalId: number,
  decision: { approved: boolean; toolOutputText: string; note?: string | null },
  opts?: { req?: Request; toolLoopDeps?: ToolLoopDeps },
): Promise<void> {
  const db = getDb();
  let row: ApprovalContinuationRow | undefined;
  try {
    row = db
      .prepare(
        `SELECT a.*, t.name AS tool_name, t.exposed_name AS exposed_name, t.server_id AS server_id
           FROM custom_ai_approvals a
           LEFT JOIN custom_ai_mcp_tools t ON t.id = a.tool_id
          WHERE a.id = ?`,
      )
      .get(approvalId) as ApprovalContinuationRow | undefined;
  } catch {
    return Promise.resolve();
  }

  if (
    !row ||
    row.run_id !== null ||
    !row.continuation_ciphertext ||
    !row.continuation_iv ||
    !row.continuation_tag
  ) {
    return Promise.resolve();
  }

  const nowIso = new Date().toISOString();
  if (!decision.approved) {
    const errText = decision.note?.trim()
      ? `Tool execution rejected: ${decision.note.trim()}`
      : 'Tool execution was rejected by an administrator.';
    db.prepare(
      `UPDATE custom_ai_approvals
          SET continuation_status = 'rejected',
              continuation_error = ?,
              continuation_finished_at = ?
        WHERE id = ?`,
    ).run(errText, nowIso, approvalId);
    return Promise.resolve();
  }

  let state: ChatContinuationState;
  try {
    const rawJson = decrypt(
      row.continuation_ciphertext,
      row.continuation_iv,
      row.continuation_tag,
    );
    state = JSON.parse(rawJson) as ChatContinuationState;
  } catch {
    db.prepare(
      `UPDATE custom_ai_approvals
          SET continuation_status = 'failed',
              continuation_error = ?,
              continuation_finished_at = ?
        WHERE id = ?`,
    ).run('Failed to decrypt chat continuation state.', nowIso, approvalId);
    return Promise.resolve();
  }

  db.prepare(
    `UPDATE custom_ai_approvals
        SET continuation_status = 'running',
            continuation_error = NULL
      WHERE id = ?`,
  ).run(approvalId);

  const toolMessages: ChatMessage[] = state.batchResults.map((item) => ({
    role: 'tool',
    tool_call_id: item.toolCallId,
    content: item.pendingApprovalId === approvalId ? decision.toolOutputText : item.text,
  }));

  const resumedConversation: ChatMessage[] = [
    ...state.conversationWithAssistantCall,
    ...toolMessages,
  ];
  const remainingRounds = Math.max(1, state.maxRounds - state.roundsUsed);
  const loopbackReq = buildContinuationLoopbackReq(state.scope, state.endUser, opts?.req);
  const secrets = collectScopeSecrets(row.server_id);

  return (async () => {
    try {
      const { runToolLoop } = await import('./tool-loop.js');
      const loopRes = await runToolLoop(
        loopbackReq,
        {
          scope: state.scope,
          messages: resumedConversation,
          model: state.model,
          callerTools: state.callerTools,
          maxRounds: remainingRounds,
          signal: AbortSignal.timeout(45_000),
          endUser: state.endUser,
          params: state.params,
        },
        opts?.toolLoopDeps,
      );

      const finishedAt = new Date().toISOString();
      if (loopRes.pendingApprovalId !== undefined) {
        db.prepare(
          `UPDATE custom_ai_approvals
              SET continuation_status = 'awaiting_approval',
                  continuation_next_approval_id = ?,
                  continuation_model = ?,
                  continuation_finished_at = ?
            WHERE id = ?`,
        ).run(
          loopRes.pendingApprovalId,
          loopRes.servedModel ?? state.model,
          finishedAt,
          approvalId,
        );
        return;
      }

      const rawReply = contentToString(loopRes.message.content ?? '');
      const maskedReply = rawReply
        ? maskText(state.scope, sanitizeMcpText(rawReply, secrets))
        : '';

      db.prepare(
        `UPDATE custom_ai_approvals
            SET continuation_status = 'completed',
                continuation_reply_masked = ?,
                continuation_model = ?,
                continuation_finished_at = ?
          WHERE id = ?`,
      ).run(maskedReply, loopRes.servedModel ?? state.model, finishedAt, approvalId);
    } catch (err) {
      const safeErr = sanitizeMcpError(err, secrets);
      db.prepare(
        `UPDATE custom_ai_approvals
            SET continuation_status = 'failed',
                continuation_error = ?,
                continuation_finished_at = ?
          WHERE id = ?`,
      ).run(safeErr, new Date().toISOString(), approvalId);
    }
  })();
}

/**
 * Look up a single MCP approval and its async chat continuation outcome scoped
 * strictly to `profileId` (and matching `endUser` when present).
 */
export function getPublicMcpApprovalForProfile(
  approvalId: number,
  profileId: number,
  endUser: string | null,
): PublicMcpApprovalResponse | null {
  const row = getDb()
    .prepare(
      `SELECT a.*, t.name AS tool_name, t.exposed_name AS exposed_name
         FROM custom_ai_approvals a
         LEFT JOIN custom_ai_mcp_tools t ON t.id = a.tool_id
        WHERE a.id = ?`,
    )
    .get(approvalId) as ApprovalContinuationRow | undefined;

  if (!row) return null;
  if (row.scope_kind !== 'profile' || Number(row.scope_id) !== profileId) {
    return null;
  }
  if (endUser !== null && row.end_user !== endUser) {
    return null;
  }

  return {
    id: row.id,
    status: row.status,
    tool_name: row.exposed_name ?? row.tool_name ?? null,
    decision_note: row.decision_note,
    tool_result: row.result_masked ?? null,
    error: row.error_text ?? null,
    continuation: row.continuation_status
      ? {
          status: row.continuation_status,
          output_text: row.continuation_reply_masked ?? null,
          model: row.continuation_model ?? null,
          next_approval_id: row.continuation_next_approval_id ?? null,
          error: row.continuation_error ?? null,
          finished_at: row.continuation_finished_at ?? null,
        }
      : null,
    created_at: row.created_at,
    expires_at: row.expires_at,
    executed_at: row.executed_at ?? null,
  };
}
