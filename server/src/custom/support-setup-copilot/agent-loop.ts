/**
 * Bounded agent loop for the permission-aware Setup Copilot (Phase 2).
 *
 * deepseek-harness / OpenHands / SWE-agent style — PATTERNS ONLY, no
 * harness dependency and no new dependency at all: a bounded turn/step loop
 * around the LLM with a scoped tool registry (`tools.ts`) and a pre-execute
 * permission gate (`executeCopilotTool`, the single choke point).
 *
 * Bounds: MAX_LOOP_STEPS = 3 LLM steps per turn, MAX_TOOL_CALLS_PER_TURN = 5
 * tool calls per turn, 10s per tool (COPILOT_TOOL_TIMEOUT_MS, enforced in
 * `executeCopilotTool`).
 *
 * The loop NEVER applies anything itself. A tool call only stages a proposal
 * (see tools.ts); the loop's terminal output may carry `propose_setup`, and
 * the actual pending_consent proposal is still created by playbook.ts and
 * applied only after the user's Approve click on the existing Consent Card.
 * There is no yolo / no-confirm mode, no bash/shell tool, no Docker sandbox.
 *
 * Scope filtering: before the loop returns, LLM-proposed `targetSteps` are
 * restricted to the caller's `canEditSteps` and `systemActions` to settings
 * the caller holds the global permission for (`filterLlmOutputByScope`) —
 * so a viewer never sees a proposal they cannot apply.
 */
import type {
  SupportSetupChatMessage,
  SupportSetupRequirements,
  SupportSetupStepId,
  SupportSetupTenantDiagnostic,
} from '@freellmapi/shared/support-setup-copilot.js';
import { hasPermission } from '../../middleware/requirePermission.js';
import type { SessionUser } from '../../services/auth.js';
import type { CopilotUserScope } from './diagnostics.js';
import type { CopilotAgentContext } from './identity.js';
import {
  enforceReplySecurityInvariant,
  runHumanLikeLlmCoach,
  type GatewayLoopbackContext,
  type LlmCoachOutput,
  type LlmCoachTurnInput,
  type LlmCoachTurnResult,
} from './llm-coach.js';
import {
  executeCopilotTool,
  filterAdmittedTools,
  findCopilotTool,
  toolSchemasForPrompt,
  type CopilotToolResult,
} from './tools.js';
import { traceCountToolCall, traceFinish, traceStart } from './trace.js';
import { REQUIRED_PERMISSION_BY_SETTING } from './system-settings.js';

/** Short, secret-free summary of a tool's input for the live step list (keys and short values only). */
function describeToolInput(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const parts = Object.entries(input as Record<string, unknown>)
    .filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v))
    .slice(0, 3)
    .map(([k, v]) => `${k}=${String(v).slice(0, 40)}`);
  return parts.length ? parts.join(', ') : undefined;
}

export const MAX_LOOP_STEPS = 3;
export const MAX_TOOL_CALLS_PER_TURN = 5;
export const COPILOT_TOOL_TIMEOUT_MS = 10_000;

export type CopilotLoopOutcome = 'terminal' | 'budget_exhausted' | 'fallback';

export interface CopilotLoopToolCallRecord {
  toolId: string;
  input: Record<string, unknown>;
  result: CopilotToolResult;
}

export interface CopilotLoopResult {
  outcome: CopilotLoopOutcome;
  /** Final LLM output (scope-filtered, security invariant enforced), or null when no LLM route answered. */
  output: LlmCoachOutput | null;
  modelUsed: string | null;
  stepsTaken: number;
  toolCallsMade: number;
  toolCalls: CopilotLoopToolCallRecord[];
  /** Tool ids the gate denied during this turn (for the reply / audit trail). */
  deniedToolIds: string[];
}

/** Inject a fake LLM turn (unit tests). Defaults to the real `runHumanLikeLlmCoach`. */
export type CopilotLlmCall = (
  input: LlmCoachTurnInput,
) => Promise<LlmCoachTurnResult | null>;

export interface RunCopilotAgentLoopParams {
  user: SessionUser;
  scope: CopilotUserScope;
  /** DB-grounded identity (Phase 0+1). Null for anonymous callers — loop falls back immediately. */
  agentContext: CopilotAgentContext | null;
  messages: SupportSetupChatMessage[];
  locale: 'vi' | 'en';
  targetMode: 'create_tenant' | 'update_tenant';
  tenantId?: number | null;
  currentPath?: string;
  diagnostic: SupportSetupTenantDiagnostic | null;
  extracted: SupportSetupRequirements;
  canCreateTenant?: boolean;
  canEditSteps?: ReadonlySet<SupportSetupStepId>;
  gatewayLoopback?: GatewayLoopbackContext;
  /** Extra trusted instructions for the model (e.g. the System target's scope rules). */
  extraInstructions?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  llmCall?: CopilotLlmCall;
}


/**
 * Scope-filter an LLM output BEFORE it can become a proposal: drop
 * targetSteps the caller cannot edit on this tenant and systemActions whose
 * leaf global permission the caller does not hold. Pure function — also
 * used directly by tests.
 */
export function filterLlmOutputByScope(
  output: LlmCoachOutput,
  params: {
    user: SessionUser | undefined;
    canEditSteps: ReadonlySet<SupportSetupStepId>;
  },
): LlmCoachOutput {
  const { user, canEditSteps } = params;
  const next: LlmCoachOutput = { ...output };
  if (output.targetSteps?.length) {
    const kept = output.targetSteps.filter((s) => canEditSteps.has(s));
    if (kept.length > 0) next.targetSteps = kept;
    else delete next.targetSteps;
  }
  if (output.systemActions?.length) {
    const kept = output.systemActions.filter((a) =>
      hasPermission(user, REQUIRED_PERMISSION_BY_SETTING[a.settingId]),
    );
    if (kept.length > 0) next.systemActions = kept;
    else delete next.systemActions;
  }
  return next;
}

const MAX_TOOL_DATA_CHARS = 6000;

function truncateForPrompt(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? '';
  } catch {
    text = '';
  }
  return text.length > MAX_TOOL_DATA_CHARS ? `${text.slice(0, MAX_TOOL_DATA_CHARS - 1)}…` : text;
}

export async function runCopilotAgentLoop(
  params: RunCopilotAgentLoopParams,
): Promise<CopilotLoopResult> {
  const {
    user,
    agentContext,
    messages,
    locale,
    targetMode,
    tenantId,
    currentPath,
    diagnostic,
    extracted,
    canCreateTenant,
    canEditSteps,
    gatewayLoopback,
    extraInstructions,
    fetchImpl,
    timeoutMs,
    llmCall = runHumanLikeLlmCoach,
  } = params;

  const empty: CopilotLoopResult = {
    outcome: 'fallback',
    output: null,
    modelUsed: null,
    stepsTaken: 0,
    toolCallsMade: 0,
    toolCalls: [],
    deniedToolIds: [],
  };
  if (!agentContext) return empty;

  const effectiveCanEdit: ReadonlySet<SupportSetupStepId> =
    canEditSteps ?? new Set<SupportSetupStepId>();
  const admittedTools = filterAdmittedTools({ agentContext, user, tenantId });
  const toolSchemas = toolSchemasForPrompt(admittedTools);

  // Loop-internal history only: tool results are appended as clearly-labelled
  // system notes (role 'user' is the only non-assistant role the chat
  // contract supports) and never persisted as user messages.
  const loopMessages: SupportSetupChatMessage[] = [...messages];
  const records: CopilotLoopToolCallRecord[] = [];
  const deniedToolIds: string[] = [];
  let toolCallsMade = 0;
  let modelUsed: string | null = null;
  let lastOutput: LlmCoachOutput | null = null;

  for (let step = 0; step < MAX_LOOP_STEPS; step += 1) {
    const turn = await llmCall({
      user,
      messages: loopMessages,
      locale,
      targetMode,
      currentPath,
      diagnostic,
      extracted,
      canCreateTenant,
      canEditSteps: effectiveCanEdit,
      gatewayLoopback,
      agentContext,
      toolSchemas,
      ...(extraInstructions ? { extraInstructions } : {}),
      fetchImpl,
      timeoutMs,
    });
    if (!turn) {
      return {
        outcome: lastOutput ? 'terminal' : 'fallback',
        output: lastOutput,
        modelUsed,
        stepsTaken: step,
        toolCallsMade,
        toolCalls: records,
        deniedToolIds,
      };
    }
    modelUsed = turn.modelUsed;
    lastOutput = turn.output;

    const requestedCalls = turn.output.toolCalls ?? [];
    if (requestedCalls.length === 0) {
      return finishTurn({
        output: lastOutput,
        modelUsed,
        stepsTaken: step + 1,
        toolCallsMade,
        records,
        deniedToolIds,
        user,
        canEditSteps: effectiveCanEdit,
        locale,
        outcome: 'terminal',
      });
    }
    // Terminal intent + tool calls: execute the calls first, then let the
    // next LLM step produce the terminal reply with the results in context.
    // A gather_requirements turn with tool calls likewise continues.
    if (toolCallsMade >= MAX_TOOL_CALLS_PER_TURN) {
      return finishTurn({
        output: lastOutput,
        modelUsed,
        stepsTaken: step + 1,
        toolCallsMade,
        records,
        deniedToolIds,
        user,
        canEditSteps: effectiveCanEdit,
        locale,
        outcome: 'budget_exhausted',
      });
    }

    const budgetLeft = MAX_TOOL_CALLS_PER_TURN - toolCallsMade;
    const callsThisStep = requestedCalls.slice(0, budgetLeft);
    const stepResults: Array<{ toolId: string; status: string; detail?: string; reason?: string; data?: string }> = [];
    for (const call of callsThisStep) {
      const toolStep = traceStart({
        kind: 'tool',
        titleVi: `Gọi công cụ \`${call.id}\``,
        titleEn: `Calling tool \`${call.id}\``,
        detailVi: describeToolInput(call.input),
        detailEn: describeToolInput(call.input),
      });
      traceCountToolCall();
      const result = await executeCopilotTool({
        user,
        toolId: call.id,
        input: call.input,
        tenantId: tenantId ?? null,
        timeoutMs: COPILOT_TOOL_TIMEOUT_MS,
      });
      traceFinish(toolStep, result.status === 'denied' || result.status === 'rejected' ? 'error' : 'done', {
        detailVi: result.detailVi ?? result.reason ?? result.status,
        detailEn: result.detailEn ?? result.reason ?? result.status,
      });
      toolCallsMade += 1;
      records.push({ toolId: call.id, input: call.input, result });
      if (result.status === 'denied') deniedToolIds.push(call.id);
      // Read-only tools (knowledge base, live settings, tenant diagnosis) hand
      // their data back to the model so it can answer from facts.
      const readOnlyData =
        result.status === 'executed' && findCopilotTool(call.id)?.sideEffect === 'none'
          ? truncateForPrompt(result.result)
          : undefined;
      stepResults.push({
        toolId: call.id,
        status: result.status,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.detailEn ? { detail: result.detailEn } : {}),
        ...(readOnlyData !== undefined ? { data: readOnlyData } : {}),
      });
      if (toolCallsMade >= MAX_TOOL_CALLS_PER_TURN) break;
    }

    loopMessages.push({
      role: 'user',
      content:
        '[TOOL RESULTS — system-provided, not a user message. ' +
        'Entries with `data` are read-only facts to answer from; other entries are staged proposals. Never claim anything was applied.] ' +
        JSON.stringify(stepResults),
    });

    // Budget exhausted mid-step: stop instead of calling the LLM again.
    if (toolCallsMade >= MAX_TOOL_CALLS_PER_TURN) {
      return finishTurn({
        output: lastOutput,
        modelUsed,
        stepsTaken: step + 1,
        toolCallsMade,
        records,
        deniedToolIds,
        user,
        canEditSteps: effectiveCanEdit,
        locale,
        outcome: 'budget_exhausted',
      });
    }
  }

  return finishTurn({
    output: lastOutput,
    modelUsed,
    stepsTaken: MAX_LOOP_STEPS,
    toolCallsMade,
    records,
    deniedToolIds,
    user,
    canEditSteps: effectiveCanEdit,
    locale,
    outcome: lastOutput ? 'budget_exhausted' : 'fallback',
  });
}

function finishTurn(params: {
  output: LlmCoachOutput | null;
  modelUsed: string | null;
  stepsTaken: number;
  toolCallsMade: number;
  records: CopilotLoopToolCallRecord[];
  deniedToolIds: string[];
  user: SessionUser | undefined;
  canEditSteps: ReadonlySet<SupportSetupStepId>;
  locale: 'vi' | 'en';
  outcome: CopilotLoopOutcome;
}): CopilotLoopResult {
  const { output, locale, user, canEditSteps } = params;
  if (!output) {
    return {
      outcome: 'fallback',
      output: null,
      modelUsed: params.modelUsed,
      stepsTaken: params.stepsTaken,
      toolCallsMade: params.toolCallsMade,
      toolCalls: params.records,
      deniedToolIds: params.deniedToolIds,
    };
  }
  // Scope-filter first, then enforce the reply security invariant (a fake
  // "already applied" LLM reply gets the disclaimer attached even when the
  // injected/fake LLM path bypassed `validateParsedCoachOutput`).
  const filtered = filterLlmOutputByScope(output, { user, canEditSteps });
  const safeReply = enforceReplySecurityInvariant(filtered.reply, locale);
  return {
    outcome: params.outcome,
    output: { ...filtered, reply: safeReply || filtered.reply },
    modelUsed: params.modelUsed,
    stepsTaken: params.stepsTaken,
    toolCallsMade: params.toolCallsMade,
    toolCalls: params.records,
    deniedToolIds: params.deniedToolIds,
  };
}
