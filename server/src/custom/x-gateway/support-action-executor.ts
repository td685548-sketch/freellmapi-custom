import Ajv2020 from 'ajv/dist/2020.js';
import { up as upgradeFencing } from '../../db/migrations/20261112_180001_support_runtime_fencing.js';
import { maskSupportSensitiveData } from './support-knowledge.js';
import crypto from 'node:crypto';
import { getDb, type Db } from '../../db/index.js';
import { encrypt, decrypt } from '../../lib/crypto.js';
import { up as bootstrapExecutionOutboxTables } from '../../db/migrations/20261112_170002_support_execution_outbox.js';
import {
  getSupportTool,
  getSupportTenantSigningSecret,
  type SupportWebhookTool,
  type SupportUserContext,
} from './support-store.js';
import {
  proposeSupportPendingAction,
  reviewSupportPendingAction,
  listSupportPendingActions,
  type SupportPendingAction,
} from './support-workflows.js';
import {
  executeSupportWebhookTool,
  isRoleAllowed,
} from './support-connectors.js';
import { enqueueSupportPartnerEvent } from './support-event-outbox.js';

export type SupportActionExecutionStatus = 'pending' | 'executing' | 'succeeded' | 'failed' | 'unknown';

export class SupportActionExecutionError extends Error {
  public statusCode: number;
  constructor(public status: number, message: string) {
    super(message);
    this.statusCode = status;
  }
}

let bootstrappedDb: Db | undefined;
export function ensureExecutionTables(db?: Db): Db {
  const targetDb = db ?? getDb();
  if (bootstrappedDb === targetDb) return targetDb;
  bootstrapExecutionOutboxTables(targetDb);
  upgradeFencing(targetDb);
  bootstrappedDb = targetDb;
  return targetDb;
}

interface ActionExecutionRow {
  id: number;
  tenant_id: number;
  action_id: string;
  tool_id: number;
  requester_encrypted: string;
  requester_iv: string;
  requester_auth_tag: string;
  effective_args_encrypted: string;
  effective_args_iv: string;
  effective_args_auth_tag: string;
  target_hash: string;
  args_hash: string;
  schema_hash: string;
  status: SupportActionExecutionStatus;
  decision: 'approved' | 'rejected' | null;
  claim_token: string | null;
  result_encrypted: string | null;
  result_iv: string | null;
  result_auth_tag: string | null;
  reviewer: string | null;
  review_note: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Resolves tool execution mode ('read' vs 'approval_required').
 * Default: GET is read, POST is approval_required.
 * Only explicit admin toolPolicy config can classify POST as read.
 * Client/customer admin role never bypasses approval.
 */
function resolveToolMode(tenantId: number, tool: SupportWebhookTool): 'read' | 'approval_required' {
  const db = getDb();
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('x_support_runtime_policy_v1') as
      | { value: string }
      | undefined;
    if (row?.value) {
      const store = JSON.parse(row.value) as Record<string, { toolPolicies?: Array<{ toolId: number; mode: 'read' | 'approval_required' }> }>;
      const policy = store[String(tenantId)];
      const match = policy?.toolPolicies?.find((tp) => tp.toolId === tool.id);
      if (match?.mode) return match.mode;
    }
  } catch {
    // fall through to default
  }

  return tool.method === 'GET' ? 'read' : 'approval_required';
}

function computeTargetHash(tool: SupportWebhookTool): string {
  return crypto.createHash('sha256').update(`${tool.method}:${new URL(tool.endpointUrl).toString()}`).digest('hex');
}

function computeSchemaHash(tool: SupportWebhookTool): string {
  return crypto.createHash('sha256').update(JSON.stringify(tool.parametersSchema ?? {})).digest('hex');
}

function computeArgsHash(args: Record<string, unknown>): string {
  return crypto.createHash('sha256').update(JSON.stringify(args)).digest('hex');
}

const argumentValidator = new (Ajv2020 as unknown as typeof import('ajv').default)({ strict: false, validateFormats: false });
function validateArguments(tool: SupportWebhookTool, args: Record<string, unknown>): void {
  let valid: boolean;
  try { valid = Boolean(argumentValidator.compile(tool.parametersSchema ?? {})(args)); }
  catch { throw new SupportActionExecutionError(422, 'Tool argument schema is invalid'); }
  if (!valid) throw new SupportActionExecutionError(422, 'Tool arguments do not satisfy the declared schema');
}

/**
 * Invokes a support webhook tool according to runtime policy and approval requirements.
 * For approval-required tools: creates proposal snapshot and returns status 202.
 */
export async function invokeSupportRuntimeWebhook(options: {
  tenantId: number;
  context: SupportUserContext;
  tool: SupportWebhookTool;
  args: Record<string, unknown>;
  requestId: string;
  conversationId?: string;
}): Promise<{ ok: boolean; status: number; effectiveArgs: Record<string, unknown>; data: unknown }> {
  const { tenantId, context, tool, args, requestId, conversationId } = options;

  if (!tool.enabled) {
    throw new SupportActionExecutionError(422, `Tool "${tool.name}" is disabled or unavailable`);
  }

  if (!isRoleAllowed(tool.allowedRoles, context.role)) {
    throw new SupportActionExecutionError(403, `Role "${context.role}" is not allowed to call tool "${tool.name}"`);
  }

  const mode = resolveToolMode(tenantId, tool);

  // Compute effective arguments and lock userId if configured
  const effectiveArgs: Record<string, unknown> = { ...(args ?? {}) };
  if (tool.lockUserIdParam && !isRoleAllowed(tool.bypassUserLockRoles, context.role)) {
    effectiveArgs[tool.lockUserIdParam] = context.userId;
  }

  validateArguments(tool, effectiveArgs);

  // If tool mode is read, execute immediately
  if (mode === 'read') {
    const signingSecret = getSupportTenantSigningSecret(tenantId);
    const result = await executeSupportWebhookTool({
      tool,
      context,
      args: effectiveArgs,
      signingSecret,
      idempotencyKey: requestId,
    });
    return {
      ok: result.ok,
      status: result.status,
      effectiveArgs: result.effectiveArgs,
      data: result.data,
    };
  }

  // Otherwise, approval is required: NO outbound HTTP call
  ensureExecutionTables();
  const db = getDb();
  const now = new Date().toISOString();

  const targetHash = computeTargetHash(tool);
  const schemaHash = computeSchemaHash(tool);
  const argsHash = computeArgsHash(effectiveArgs);

  const requesterSnapshot = {
    tenantId,
    userId: context.userId,
    name: context.name,
    email: context.email,
    role: context.role,
    permissions: context.permissions ?? [],
    verified: context.verified,
  };

  const reqEnc = encrypt(JSON.stringify(requesterSnapshot));
  const argsEnc = encrypt(JSON.stringify(effectiveArgs));

  const pendingAction = db.transaction(() => {
  const proposal = proposeSupportPendingAction(String(tenantId), {
    conversationId,
    userId: context.userId,
    userName: context.name,
    userRole: context.role,
    toolName: tool.name,
    actionSummary: tool.description || `Execute ${tool.name}`,
    payload: maskSupportSensitiveData(String(tenantId), effectiveArgs, context.role).masked,
  });

  // Store execution snapshot atomically
  db.prepare(`
    INSERT INTO x_support_action_executions (
      tenant_id, action_id, tool_id,
      requester_encrypted, requester_iv, requester_auth_tag,
      effective_args_encrypted, effective_args_iv, effective_args_auth_tag,
      target_hash, args_hash, schema_hash,
      status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    tenantId,
    proposal.id,
    tool.id,
    reqEnc.encrypted,
    reqEnc.iv,
    reqEnc.authTag,
    argsEnc.encrypted,
    argsEnc.iv,
    argsEnc.authTag,
    targetHash,
    argsHash,
    schemaHash,
    'pending',
    now,
    now,
  );
  return proposal;
  })();

  return {
    ok: true,
    status: 202,
    effectiveArgs,
    data: {
      pendingActionId: pendingAction.id,
      executionStatus: 'pending',
    },
  };
}

/**
 * Reviews and executes a pending action atomically.
 * Prevents concurrent duplicate executions, validates snapshot integrity,
 * and preserves original requester scope.
 */
export async function reviewAndExecuteSupportAction(options: {
  tenantId: number;
  actionId: string;
  decision: 'approved' | 'rejected';
  reviewedBy: string;
  reviewNote?: string;
}): Promise<SupportPendingAction & { executionStatus: SupportActionExecutionStatus }> {
  const { tenantId, actionId, decision, reviewedBy, reviewNote } = options;

  ensureExecutionTables();
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare("UPDATE x_support_action_executions SET status = 'unknown', claim_token = NULL, updated_at = ? WHERE status = 'executing' AND updated_at < ?")
    .run(now, new Date(Date.now() - 120_000).toISOString());

  let executionRow: ActionExecutionRow | undefined;
  let toolToExecute: SupportWebhookTool | undefined;
  let requesterContext: SupportUserContext | undefined;
  let effectiveArgsToExecute: Record<string, unknown> | undefined;
  let claimToken: string | undefined;

  // Step 1: Pre-execution validation and atomic claim in a short transaction
  db.transaction(() => {
    executionRow = db.prepare(
      'SELECT * FROM x_support_action_executions WHERE tenant_id = ? AND action_id = ?',
    ).get(tenantId, actionId) as ActionExecutionRow | undefined;

    if (!executionRow) {
      throw new SupportActionExecutionError(
        409,
        'Action proposal does not have an execution snapshot; re-proposal required',
      );
    }

    // Handle terminal and in-progress states
    if (executionRow.status === 'executing') {
      throw new SupportActionExecutionError(409, 'Action is currently executing');
    }

    if (executionRow.status === 'succeeded' || executionRow.status === 'failed') {
      const legacy = listSupportPendingActions(String(tenantId)).find(a => a.id === actionId);
      const priorDecision = executionRow.decision ?? (legacy?.status === 'rejected' ? 'rejected' : 'approved');
      if (priorDecision !== decision) throw new SupportActionExecutionError(409, 'Action already has the opposite decision');
      return;
    }

    if (executionRow.status === 'unknown') {
      throw new SupportActionExecutionError(
        409,
        'Action is in unknown state due to previous dispatch timeout; manual reconciliation required',
      );
    }

    // Process rejection
    if (decision === 'rejected') {
      db.prepare(`
        UPDATE x_support_action_executions
        SET status = 'failed', decision = 'rejected', reviewer = ?, review_note = ?, reviewed_at = ?, updated_at = ?
        WHERE tenant_id = ? AND action_id = ? AND status = 'pending'
      `).run(reviewedBy, reviewNote ?? null, now, now, tenantId, actionId);

      reviewSupportPendingAction(String(tenantId), actionId, {
        decision: 'rejected',
        reviewedBy,
        reviewNote,
      });

      enqueueSupportPartnerEvent({
        tenantId,
        event: 'action.rejected',
        payload: { actionId, reviewedBy, reviewNote },
        dedupKey: `action_rejected_${actionId}`,
      });
      return;
    }

    // Decision is approved: validate target, schema, requester role, args
    let tool: SupportWebhookTool;
    try {
      tool = getSupportTool(tenantId, executionRow.tool_id);
    } catch {
      throw new SupportActionExecutionError(422, 'Tool is unavailable or missing');
    }

    if (!tool.enabled) {
      throw new SupportActionExecutionError(422, 'Tool is disabled or unavailable');
    }

    const currentTargetHash = computeTargetHash(tool);
    if (currentTargetHash !== executionRow.target_hash) {
      throw new SupportActionExecutionError(
        409,
        'Tool target endpoint or method changed since proposal; re-proposal required',
      );
    }

    const currentSchemaHash = computeSchemaHash(tool);
    if (currentSchemaHash !== executionRow.schema_hash) {
      throw new SupportActionExecutionError(
        409,
        'Tool parameters schema changed since proposal; re-proposal required',
      );
    }

    // Decrypt requester identity
    const requesterJson = decrypt(
      executionRow.requester_encrypted,
      executionRow.requester_iv,
      executionRow.requester_auth_tag,
    );
    const requester = JSON.parse(requesterJson) as {
      userId: string;
      name?: string;
      email?: string;
      role: string;
      permissions: string[];
    };

    if (!isRoleAllowed(tool.allowedRoles, requester.role)) {
      throw new SupportActionExecutionError(
        403,
        `Original requester role "${requester.role}" is no longer allowed to invoke tool "${tool.name}"`,
      );
    }

    // Decrypt effective args
    const argsJson = decrypt(
      executionRow.effective_args_encrypted,
      executionRow.effective_args_iv,
      executionRow.effective_args_auth_tag,
    );
    const effectiveArgs = JSON.parse(argsJson) as Record<string, unknown>;

    validateArguments(tool, effectiveArgs);
    if (computeArgsHash(effectiveArgs) !== executionRow.args_hash) throw new SupportActionExecutionError(409, 'Action arguments changed; re-proposal required');

    // Revalidate args lock
    if (tool.lockUserIdParam && !isRoleAllowed(tool.bypassUserLockRoles, requester.role)) {
      if (effectiveArgs[tool.lockUserIdParam] !== requester.userId) {
        throw new SupportActionExecutionError(
          409,
          'Locked user ID parameter altered; re-proposal required',
        );
      }
    }

    // Atomic claim: only one worker/reviewer can claim
    claimToken = crypto.randomUUID();
    const updateResult = db.prepare(`
      UPDATE x_support_action_executions
      SET status = 'executing', decision = 'approved', claim_token = ?, reviewer = ?, review_note = ?, reviewed_at = ?, updated_at = ?
      WHERE tenant_id = ? AND action_id = ? AND status = 'pending'
    `).run(claimToken, reviewedBy, reviewNote ?? null, now, now, tenantId, actionId);

    if (updateResult.changes === 0) {
      throw new SupportActionExecutionError(409, 'Action was already claimed by another reviewer');
    }

    // Update pending action store status to approved
    reviewSupportPendingAction(String(tenantId), actionId, {
      decision: 'approved',
      reviewedBy,
      reviewNote,
    });

    // Enqueue action.approved event atomically inside claim transaction
    enqueueSupportPartnerEvent({
      tenantId,
      event: 'action.approved',
      payload: { actionId, toolId: tool.id, toolName: tool.name, reviewedBy },
      dedupKey: `action_approved_${actionId}`,
    });

    toolToExecute = tool;
    requesterContext = {
      tenantId,
      userId: requester.userId,
      name: requester.name,
      email: requester.email,
      role: requester.role,
      permissions: requester.permissions ?? [],
      verified: true,
    };
    effectiveArgsToExecute = effectiveArgs;
  })();

  // Replay terminal check
  if (executionRow && (executionRow.status === 'succeeded' || executionRow.status === 'failed')) {
    const existing = listSupportPendingActions(String(tenantId)).find((a) => a.id === actionId);
    let executionResult: unknown = existing?.executionResult;
    if (executionRow.result_encrypted) {
      try {
        executionResult = JSON.parse(
          decrypt(executionRow.result_encrypted, executionRow.result_iv!, executionRow.result_auth_tag!),
        );
      } catch {
        // use existing
      }
    }
    return {
      id: actionId,
      tenantId: String(tenantId),
      userId: requesterContext?.userId ?? existing?.userId ?? '',
      userRole: requesterContext?.role ?? existing?.userRole ?? '',
      toolName: toolToExecute?.name ?? existing?.toolName ?? '',
      actionSummary: existing?.actionSummary ?? '',
      payload: existing?.payload ?? {},
      status: executionRow.decision ?? (existing?.status === 'rejected' ? 'rejected' : 'approved'),
      reviewedBy: executionRow.reviewer ?? reviewedBy,
      reviewNote: executionRow.review_note ?? reviewNote,
      executionResult: maskSupportSensitiveData(String(tenantId), executionResult, existing?.userRole ?? 'customer').masked,
      createdAt: executionRow.created_at,
      reviewedAt: executionRow.reviewed_at ?? now,
      executionStatus: executionRow.status,
    };
  }

  // If rejected, return immediately
  if (decision === 'rejected') {
    const existing = listSupportPendingActions(String(tenantId)).find((a) => a.id === actionId);
    return {
      id: actionId,
      tenantId: String(tenantId),
      userId: existing?.userId ?? '',
      userRole: existing?.userRole ?? '',
      toolName: existing?.toolName ?? '',
      actionSummary: existing?.actionSummary ?? '',
      payload: existing?.payload ?? {},
      status: 'rejected',
      reviewedBy,
      reviewNote,
      executionResult: undefined,
      createdAt: executionRow?.created_at ?? now,
      reviewedAt: now,
      executionStatus: 'failed',
    };
  }

  // Step 2: Execute HTTP outside any transaction
  let httpOutcome: { ok: boolean; status: number; data: unknown } | null = null;
  let networkError: Error | null = null;

  try {
    const signingSecret = getSupportTenantSigningSecret(tenantId);
    httpOutcome = await executeSupportWebhookTool({
      tool: toolToExecute!,
      context: requesterContext!,
      args: effectiveArgsToExecute!,
      signingSecret,
      idempotencyKey: actionId,
    });
  } catch (err) {
    networkError = err as Error;
  }

  // Step 3: Record execution outcome in a new short transaction
  const finalTime = new Date().toISOString();
  let finalStatus: SupportActionExecutionStatus;
  let finalResult: unknown;

  if (httpOutcome) {
    if (httpOutcome.ok) {
      finalStatus = 'succeeded';
      finalResult = httpOutcome.data;
    } else {
      finalStatus = 'failed';
      finalResult = httpOutcome.data ?? { error: `HTTP status ${httpOutcome.status}` };
    }
  } else {
    // Response loss or timeout: mark unknown, no auto retry
    finalStatus = 'unknown';
    finalResult = { error: networkError?.message || 'Network timeout or connection lost during dispatch' };
  }

  const resultEnc = encrypt(JSON.stringify(finalResult));

  db.transaction(() => {
    const completed = db.prepare(`
      UPDATE x_support_action_executions
      SET status = ?, result_encrypted = ?, result_iv = ?, result_auth_tag = ?, updated_at = ?
      WHERE tenant_id = ? AND action_id = ? AND claim_token = ? AND status = 'executing'
    `).run(
      finalStatus,
      resultEnc.encrypted,
      resultEnc.iv,
      resultEnc.authTag,
      finalTime,
      tenantId,
      actionId,
      claimToken,
    );
    if (!completed.changes) throw new SupportActionExecutionError(409, 'Execution claim expired; manual reconciliation required');

    reviewSupportPendingAction(String(tenantId), actionId, {
      decision: 'approved',
      reviewedBy,
      reviewNote,
      executionResult: maskSupportSensitiveData(String(tenantId), finalResult, requesterContext!.role).masked,
    });
  })();

  const existing = listSupportPendingActions(String(tenantId)).find((a) => a.id === actionId);
  return {
    id: actionId,
    tenantId: String(tenantId),
    userId: requesterContext!.userId,
    userRole: requesterContext!.role,
    toolName: toolToExecute!.name,
    actionSummary: existing?.actionSummary ?? '',
    payload: maskSupportSensitiveData(String(tenantId), effectiveArgsToExecute!, requesterContext!.role).masked,
    status: 'approved',
    reviewedBy,
    reviewNote,
    executionResult: maskSupportSensitiveData(String(tenantId), finalResult, requesterContext!.role).masked,
    createdAt: executionRow!.created_at,
    reviewedAt: now,
    executionStatus: finalStatus,
  };
}
