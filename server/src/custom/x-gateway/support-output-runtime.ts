import { retainSupportOutputCitationText } from './support-output-citations.js';
import type { Db } from '../../db/index.js';
import type { SupportAnswerEvidence, SupportEvidenceCitation } from '@freellmapi/shared/support-evidence.js';
import {
  SUPPORT_OUTPUT_BLOCK_NOTICE,
  SUPPORT_OUTPUT_HISTORY_NOTICE,
  type SupportOutputDecision,
  type SupportOutputLeaf,
  type SupportOutputMetadata,
  type SupportOutputPolicy,
  type SupportOutputSurface,
} from '@freellmapi/shared/support-output.js';
import type { SupportRuntimeMetadata } from '@freellmapi/shared/support-runtime.js';
import type { SupportDeskCopilotDraft, SupportDeskCopilotResult } from '@freellmapi/shared/support-service-desk.js';
import {
  evaluateSupportOutput,
  SupportOutputEngineError,
} from './support-output-engine.js';
import {
  appendSupportOutputEvent,
  getSupportOutputPolicy,
  SupportOutputError,
} from './support-output-store.js';
import { SupportRuntimeError } from './support-runtime-store.js';

export interface SupportOutputToolTraceLike {
  kind: 'webhook' | 'db';
  name: string;
  toolName?: string;
  args?: Record<string, unknown>;
  rewrittenSql?: string;
  result?: unknown;
  output?: unknown;
  error?: string;
  durationMs?: number;
}

export interface SupportOutputTurnInput<
  TTrace extends SupportOutputToolTraceLike = SupportOutputToolTraceLike,
> {
  tenantId: number;
  operationId: string;
  reply: string;
  choices?: Array<{ index: number; message: { role: 'assistant'; content: string }; finish_reason: string }>;
  toolTrace: TTrace[];
  evidence?: SupportAnswerEvidence;
  replySource: SupportRuntimeMetadata['replySource'];
  db?: Db;
  /**
   * Optional callback to revalidate 018 citations when visible reply text changes.
   * Must be synchronous when called inside a DB transaction.
   */
  revalidateEvidence?: (nextReply: string) => {
    accepted: boolean;
    canonicalReply: string;
    citations: SupportEvidenceCitation[];
    abstainedEvidence?: SupportAnswerEvidence;
  };
}

export interface SupportOutputTurnResult<
  TTrace extends SupportOutputToolTraceLike = SupportOutputToolTraceLike,
> {
  reply: string;
  choices: Array<{ index: number; message: { role: 'assistant'; content: string }; finish_reason: string }>;
  toolTrace: TTrace[];
  evidence?: SupportAnswerEvidence;
  replySource: SupportRuntimeMetadata['replySource'];
  output: SupportOutputMetadata;
  redactionCount: number;
}

export interface SupportOutputConversationMessageLike {
  id: string;
  senderType: 'customer' | 'ai_assistant' | 'human_agent' | 'system';
  content: string;
  toolTrace?: Array<{ toolName: string; status: string; durationMs?: number }>;
  evidence?: SupportAnswerEvidence;
}

export interface SupportOutputConversationLike {
  id: string;
  userRole: string;
  messages: SupportOutputConversationMessageLike[];
}

export interface SupportOutputCopilotEvalInput {
  tenantId: number;
  operationId: string;
  summary: string;
  summaryCitations: SupportEvidenceCitation[];
  drafts: SupportDeskCopilotDraft[];
  recordEvent: boolean;
  db?: Db;
}

export interface SupportOutputCopilotEvalResult {
  decision: SupportOutputDecision;
  output: SupportOutputMetadata;
  summary: string;
  summaryCitations: SupportEvidenceCitation[];
  drafts: SupportDeskCopilotDraft[];
}

function toRuntimeError(err: unknown): never {
  if (err instanceof SupportRuntimeError) {
    throw err;
  }
  if (err instanceof SupportOutputError || err instanceof SupportOutputEngineError) {
    throw new SupportRuntimeError(err.status, err.code, err.message);
  }
  throw err;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectNestedStringLeaves(
  value: unknown,
  prefix: string,
  leaves: SupportOutputLeaf[],
): void {
  if (typeof value === 'string') {
    leaves.push({ path: prefix, text: value });
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      collectNestedStringLeaves(value[i], `${prefix}.${i}`, leaves);
    }
    return;
  }
  if (isPlainRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      collectNestedStringLeaves(entry, `${prefix}.${key}`, leaves);
    }
  }
}

function applyNestedStringLeaves(
  value: unknown,
  prefix: string,
  leafMap: ReadonlyMap<string, string>,
): unknown {
  if (typeof value === 'string') {
    return leafMap.get(prefix) ?? value;
  }
  if (Array.isArray(value)) {
    return value.map((item, i) => applyNestedStringLeaves(item, `${prefix}.${i}`, leafMap));
  }
  if (isPlainRecord(value)) {
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      next[key] = applyNestedStringLeaves(entry, `${prefix}.${key}`, leafMap);
    }
    return next;
  }
  return value;
}

function buildLeafMap(decision: SupportOutputDecision): Map<string, string> {
  const map = new Map<string, string>();
  for (const leaf of decision.leaves) {
    map.set(leaf.path, leaf.text);
  }
  return map;
}

function buildTurnLeaves<TTrace extends SupportOutputToolTraceLike>(input: {
  reply: string;
  choices?: Array<{ index: number; message: { role: 'assistant'; content: string }; finish_reason: string }>;
  toolTrace: TTrace[];
  evidence?: SupportAnswerEvidence;
}): SupportOutputLeaf[] {
  const leaves: SupportOutputLeaf[] = [{ path: 'reply', text: input.reply }];

  if (Array.isArray(input.choices)) {
    for (let i = 0; i < input.choices.length; i += 1) {
      const content = input.choices[i]?.message?.content;
      if (typeof content === 'string') {
        leaves.push({ path: `choices.${i}.content`, text: content });
      }
    }
  }

  for (let i = 0; i < input.toolTrace.length; i += 1) {
    const tr = input.toolTrace[i];
    leaves.push({ path: `toolTrace.${i}.name`, text: tr.name });
    if (typeof tr.toolName === 'string') {
      leaves.push({ path: `toolTrace.${i}.toolName`, text: tr.toolName });
    }
    if (typeof tr.rewrittenSql === 'string') {
      leaves.push({ path: `toolTrace.${i}.rewrittenSql`, text: tr.rewrittenSql });
    }
    if (typeof tr.error === 'string') {
      leaves.push({ path: `toolTrace.${i}.error`, text: tr.error });
    }
    if (tr.args !== undefined) {
      collectNestedStringLeaves(tr.args, `toolTrace.${i}.args`, leaves);
    }
    if (tr.output !== undefined) {
      collectNestedStringLeaves(tr.output, `toolTrace.${i}.output`, leaves);
    }
    if (tr.result !== undefined) {
      collectNestedStringLeaves(tr.result, `toolTrace.${i}.result`, leaves);
    }
  }

  if (input.evidence && Array.isArray(input.evidence.citations)) {
    for (let i = 0; i < input.evidence.citations.length; i += 1) {
      const c = input.evidence.citations[i];
      leaves.push({ path: `citations.${i}.title`, text: c.title });
      leaves.push({ path: `citations.${i}.excerpt`, text: c.excerpt });
    }
  }

  return leaves;
}

function reconstructTurnFromLeaves<TTrace extends SupportOutputToolTraceLike>(
  input: {
    reply: string;
    choices?: Array<{ index: number; message: { role: 'assistant'; content: string }; finish_reason: string }>;
    toolTrace: TTrace[];
    evidence?: SupportAnswerEvidence;
  },
  leafMap: ReadonlyMap<string, string>,
): {
  reply: string;
  choices: Array<{ index: number; message: { role: 'assistant'; content: string }; finish_reason: string }>;
  toolTrace: TTrace[];
  evidence?: SupportAnswerEvidence;
} {
  const nextReply = leafMap.get('reply') ?? input.reply;
  const nextChoices = Array.isArray(input.choices)
    ? input.choices.map((ch, i) => ({
        ...ch,
        message: {
          ...ch.message,
          content: leafMap.get(`choices.${i}.content`) ?? ch.message.content,
        },
      }))
    : [{ index: 0, message: { role: 'assistant' as const, content: nextReply }, finish_reason: 'stop' }];

  const nextToolTrace = input.toolTrace.map((tr, i) => ({
    ...tr,
    name: leafMap.get(`toolTrace.${i}.name`) ?? tr.name,
    ...(tr.toolName !== undefined ? { toolName: leafMap.get(`toolTrace.${i}.toolName`) ?? tr.toolName } : {}),
    ...(typeof tr.rewrittenSql === 'string'
      ? { rewrittenSql: leafMap.get(`toolTrace.${i}.rewrittenSql`) ?? tr.rewrittenSql }
      : {}),
    ...(typeof tr.error === 'string'
      ? { error: leafMap.get(`toolTrace.${i}.error`) ?? tr.error }
      : {}),
    ...(tr.args !== undefined
      ? { args: applyNestedStringLeaves(tr.args, `toolTrace.${i}.args`, leafMap) as Record<string, unknown> }
      : {}),
    ...(tr.output !== undefined
      ? { output: applyNestedStringLeaves(tr.output, `toolTrace.${i}.output`, leafMap) }
      : {}),
    ...(tr.result !== undefined
      ? { result: applyNestedStringLeaves(tr.result, `toolTrace.${i}.result`, leafMap) }
      : {}),
  }));

  const nextEvidence = input.evidence
    ? {
        ...input.evidence,
        citations: input.evidence.citations.map((c, i) => ({
          ...c,
          title: leafMap.get(`citations.${i}.title`) ?? c.title,
          excerpt: leafMap.get(`citations.${i}.excerpt`) ?? c.excerpt,
        })),
      }
    : undefined;

  return {
    reply: nextReply,
    choices: nextChoices,
    toolTrace: nextToolTrace,
    evidence: nextEvidence,
  };
}

function buildBlockedTurnResult<TTrace extends SupportOutputToolTraceLike>(
  policyVersion: number,
  decision: SupportOutputDecision,
  evidence?: SupportAnswerEvidence,
): SupportOutputTurnResult<TTrace> {
  const safeEvidence = evidence
    ? {
        ...evidence,
        status: 'abstained' as const,
        citations: [],
      }
    : undefined;

  return {
    reply: SUPPORT_OUTPUT_BLOCK_NOTICE,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: SUPPORT_OUTPUT_BLOCK_NOTICE },
        finish_reason: 'stop',
      },
    ],
    toolTrace: [],
    ...(safeEvidence ? { evidence: safeEvidence } : {}),
    replySource: 'output_policy_notice',
    output: {
      policyVersion,
      action: 'block',
      reasons: decision.reasons,
      redactionCount: 0,
    },
    redactionCount: 0,
  };
}

function recordOutputEventIfNeeded(params: {
  tenantId: number;
  operationId: string;
  surface: SupportOutputSurface;
  decision: SupportOutputDecision;
  db?: Db;
}): void {
  const { tenantId, operationId, surface, decision, db } = params;
  if (decision.action === 'allow') {
    return;
  }
  appendSupportOutputEvent(
    {
      tenantId,
      operationId,
      surface,
      policyVersion: decision.policyVersion,
      action: decision.action,
      reasons: decision.reasons,
      ruleIds: decision.ruleIds,
      redactionCount: decision.redactionCount,
    },
    db,
  );
}

function runEvaluator(policy: SupportOutputPolicy, leaves: SupportOutputLeaf[]): SupportOutputDecision {
  try {
    return evaluateSupportOutput({ policy, leaves });
  } catch (err) {
    toRuntimeError(err);
  }
}

function loadPolicy(tenantId: number, db?: Db): SupportOutputPolicy {
  try {
    return getSupportOutputPolicy(tenantId, db);
  } catch (err) {
    toRuntimeError(err);
  }
}

/**
 * Evaluates and applies output policy synchronously inside the final DB commit transaction.
 * Reloads the latest policy from DB, revalidates 018 citations if visible text changed,
 * and records metadata-only audit events in the same transaction.
 */
export function evaluateAndApplySupportOutputToTurn<
  TTrace extends SupportOutputToolTraceLike = SupportOutputToolTraceLike,
>(input: SupportOutputTurnInput<TTrace>): SupportOutputTurnResult<TTrace> {
  const policy = loadPolicy(input.tenantId, input.db);
  const leaves = buildTurnLeaves(input);
  const decision = runEvaluator(policy, leaves);

  if (decision.action === 'block') {
    recordOutputEventIfNeeded({
      tenantId: input.tenantId,
      operationId: input.operationId,
      surface: 'chat',
      decision,
      db: input.db,
    });
    return buildBlockedTurnResult(policy.version, decision, input.evidence);
  }

  if (decision.action === 'redact') {
    const leafMap = buildLeafMap(decision);
    const reconstructed = reconstructTurnFromLeaves(input, leafMap);

    let finalReply = reconstructed.reply;
    let finalChoices = reconstructed.choices;
    let finalEvidence = reconstructed.evidence;
    let finalReplySource = input.replySource;

    if (finalReply !== input.reply && input.revalidateEvidence) {
      const revalidated = input.revalidateEvidence(finalReply);
      if (!revalidated.accepted) {
        finalReply = revalidated.canonicalReply;
        finalChoices = [
          {
            index: 0,
            message: { role: 'assistant', content: finalReply },
            finish_reason: 'stop',
          },
        ];
        finalEvidence = revalidated.abstainedEvidence;
        finalReplySource = 'knowledge_abstention';
      } else {
        finalReply = revalidated.canonicalReply;
        finalChoices = [
          {
            index: 0,
            message: { role: 'assistant', content: finalReply },
            finish_reason: 'stop',
          },
        ];
        if (finalEvidence) {
          finalEvidence = {
            ...finalEvidence,
            citations: retainSupportOutputCitationText(revalidated.citations, reconstructed.evidence?.citations ?? []),
          };
        }
      }
    }

    recordOutputEventIfNeeded({
      tenantId: input.tenantId,
      operationId: input.operationId,
      surface: 'chat',
      decision,
      db: input.db,
    });

    return {
      reply: finalReply,
      choices: finalChoices,
      toolTrace: reconstructed.toolTrace,
      ...(finalEvidence ? { evidence: finalEvidence } : {}),
      replySource: finalReplySource,
      output: {
        policyVersion: policy.version,
        action: 'redact',
        reasons: decision.reasons,
        redactionCount: decision.redactionCount,
      },
      redactionCount: decision.redactionCount,
    };
  }

  if (decision.action === 'observe') {
    recordOutputEventIfNeeded({
      tenantId: input.tenantId,
      operationId: input.operationId,
      surface: 'chat',
      decision,
      db: input.db,
    });
  }

  const defaultChoices = Array.isArray(input.choices)
    ? input.choices
    : [{ index: 0, message: { role: 'assistant' as const, content: input.reply }, finish_reason: 'stop' }];

  return {
    reply: input.reply,
    choices: defaultChoices,
    toolTrace: input.toolTrace,
    ...(input.evidence ? { evidence: input.evidence } : {}),
    replySource: input.replySource,
    output: {
      policyVersion: policy.version,
      action: decision.action,
      reasons: decision.reasons,
      redactionCount: 0,
    },
    redactionCount: 0,
  };
}

/**
 * Validates or sanitizes a cached replay response read-only without writing events, messages, or cache.
 * Throws 409 output_policy_changed when a 020-versioned response has a stale policyVersion.
 */
export function sanitizeSupportReplayResult<
  T extends {
    reply: string;
    choices?: Array<{ index: number; message: { role: 'assistant'; content: string }; finish_reason: string }>;
    toolTrace: SupportOutputToolTraceLike[];
    runtime: SupportRuntimeMetadata;
  },
>(options: {
  tenantId: number;
  cachedResponse: T;
}): T {
  const policy = loadPolicy(options.tenantId);
  const cachedOutput = options.cachedResponse.runtime?.output;

  if (cachedOutput) {
    if (policy.version !== cachedOutput.policyVersion) {
      throw new SupportRuntimeError(
        409,
        'output_policy_changed',
        'Output policy changed since this response was cached. Please send a new request.',
      );
    }
    return options.cachedResponse;
  }

  // Legacy pre-020 cache: evaluate under current policy read-only
  const leaves = buildTurnLeaves({
    reply: options.cachedResponse.reply,
    choices: options.cachedResponse.choices,
    toolTrace: options.cachedResponse.toolTrace,
    evidence: options.cachedResponse.runtime.evidence,
  });
  const decision = runEvaluator(policy, leaves);

  if (decision.action === 'block') {
    const blocked = buildBlockedTurnResult(
      policy.version,
      decision,
      options.cachedResponse.runtime.evidence,
    );
    return {
      ...options.cachedResponse,
      reply: blocked.reply,
      choices: blocked.choices,
      toolTrace: [],
      runtime: {
        ...options.cachedResponse.runtime,
        replySource: 'output_policy_notice',
        ...(blocked.evidence ? { evidence: blocked.evidence } : {}),
        output: blocked.output,
      },
    };
  }

  if (decision.action === 'redact') {
    const leafMap = buildLeafMap(decision);
    const reconstructed = reconstructTurnFromLeaves(
      {
        reply: options.cachedResponse.reply,
        choices: options.cachedResponse.choices,
        toolTrace: options.cachedResponse.toolTrace,
        evidence: options.cachedResponse.runtime.evidence,
      },
      leafMap,
    );
    return {
      ...options.cachedResponse,
      reply: reconstructed.reply,
      choices: reconstructed.choices,
      toolTrace: reconstructed.toolTrace,
      runtime: {
        ...options.cachedResponse.runtime,
        redactionCount: options.cachedResponse.runtime.redactionCount + decision.redactionCount,
        ...(reconstructed.evidence ? { evidence: reconstructed.evidence } : {}),
        output: {
          policyVersion: policy.version,
          action: 'redact',
          reasons: decision.reasons,
          redactionCount: decision.redactionCount,
        },
      },
    };
  }

  return {
    ...options.cachedResponse,
    runtime: {
      ...options.cachedResponse.runtime,
      output: {
        policyVersion: policy.version,
        action: decision.action,
        reasons: decision.reasons,
        redactionCount: 0,
      },
    },
  };
}

/**
 * Applies current output policy read-only to AI assistant messages in canonical conversation reads.
 * Customer and human_agent messages are never rewritten by 020.
 */
export function sanitizeSupportConversationOutput<
  TConv extends SupportOutputConversationLike,
>(options: {
  tenantId: number;
  conversation: TConv;
}): TConv {
  const { tenantId, conversation } = options;
  const hasAiMessages = conversation.messages.some((m) => m.senderType === 'ai_assistant');
  if (!hasAiMessages) {
    return conversation;
  }

  const policy = loadPolicy(tenantId);

  const nextMessages = conversation.messages.map((msg) => {
    if (msg.senderType !== 'ai_assistant') {
      return msg;
    }

    const leaves: SupportOutputLeaf[] = [{ path: 'content', text: msg.content }];
    msg.toolTrace?.forEach((trace, i) => {
      leaves.push({ path: `toolTrace.${i}.toolName`, text: trace.toolName });
      leaves.push({ path: `toolTrace.${i}.status`, text: trace.status });
    });
    if (msg.evidence && Array.isArray(msg.evidence.citations)) {
      for (let i = 0; i < msg.evidence.citations.length; i += 1) {
        const c = msg.evidence.citations[i];
        leaves.push({ path: `citations.${i}.title`, text: c.title });
        leaves.push({ path: `citations.${i}.excerpt`, text: c.excerpt });
      }
    }

    const decision = runEvaluator(policy, leaves);

    if (decision.action === 'block') {
      const nextEvidence = msg.evidence
        ? {
            ...msg.evidence,
            status: 'abstained' as const,
            citations: [],
          }
        : undefined;
      return {
        ...msg,
        content: SUPPORT_OUTPUT_HISTORY_NOTICE,
        ...(msg.toolTrace ? { toolTrace: [] } : {}),        ...(nextEvidence ? { evidence: nextEvidence } : {}),
      };
    }

    if (decision.action === 'redact') {
      const leafMap = buildLeafMap(decision);
      const nextContent = leafMap.get('content') ?? msg.content;
      const nextEvidence = msg.evidence
        ? {
            ...msg.evidence,
            citations: msg.evidence.citations.map((c, i) => ({
              ...c,
              title: leafMap.get(`citations.${i}.title`) ?? c.title,
              excerpt: leafMap.get(`citations.${i}.excerpt`) ?? c.excerpt,
            })),
          }
        : undefined;
      return {
        ...msg,
        content: nextContent,
        ...(msg.toolTrace ? { toolTrace: msg.toolTrace.map((trace, i) => ({
          ...trace,
          toolName: leafMap.get(`toolTrace.${i}.toolName`) ?? trace.toolName,
          status: leafMap.get(`toolTrace.${i}.status`) ?? trace.status,
        })) } : {}),        ...(nextEvidence ? { evidence: nextEvidence } : {}),
      };
    }

    return msg;
  });

  return {
    ...conversation,
    messages: nextMessages,
  };
}

function buildCopilotLeaves(input: {
  summary: string;
  summaryCitations: SupportEvidenceCitation[];
  drafts: SupportDeskCopilotDraft[];
}): SupportOutputLeaf[] {
  const leaves: SupportOutputLeaf[] = [{ path: 'summary', text: input.summary }];
  for (let i = 0; i < input.summaryCitations.length; i += 1) {
    leaves.push({ path: `summaryCitations.${i}.title`, text: input.summaryCitations[i].title });
    leaves.push({ path: `summaryCitations.${i}.excerpt`, text: input.summaryCitations[i].excerpt });
  }
  for (let d = 0; d < input.drafts.length; d += 1) {
    const draft = input.drafts[d];
    leaves.push({ path: `drafts.${d}.text`, text: draft.text });
    for (let c = 0; c < draft.citations.length; c += 1) {
      leaves.push({ path: `drafts.${d}.citations.${c}.title`, text: draft.citations[c].title });
      leaves.push({ path: `drafts.${d}.citations.${c}.excerpt`, text: draft.citations[c].excerpt });
    }
  }
  return leaves;
}

/**
 * Evaluates all Copilot artifacts (summary, citations, all drafts) as a single decision.
 */
export function evaluateSupportCopilotArtifacts(
  input: SupportOutputCopilotEvalInput,
): SupportOutputCopilotEvalResult {
  const policy = loadPolicy(input.tenantId, input.db);
  const leaves = buildCopilotLeaves(input);
  const decision = runEvaluator(policy, leaves);

  if (input.recordEvent && decision.action !== 'allow') {
    recordOutputEventIfNeeded({
      tenantId: input.tenantId,
      operationId: input.operationId,
      surface: 'copilot',
      decision,
      db: input.db,
    });
  }

  if (decision.action === 'block') {
    return {
      decision,
      output: {
        policyVersion: policy.version,
        action: 'block',
        reasons: decision.reasons,
        redactionCount: 0,
      },
      summary: '',
      summaryCitations: [],
      drafts: [],
    };
  }

  if (decision.action === 'redact') {
    const leafMap = buildLeafMap(decision);
    return {
      decision,
      output: {
        policyVersion: policy.version,
        action: 'redact',
        reasons: decision.reasons,
        redactionCount: decision.redactionCount,
      },
      summary: leafMap.get('summary') ?? input.summary,
      summaryCitations: input.summaryCitations.map((c, i) => ({
        ...c,
        title: leafMap.get(`summaryCitations.${i}.title`) ?? c.title,
        excerpt: leafMap.get(`summaryCitations.${i}.excerpt`) ?? c.excerpt,
      })),
      drafts: input.drafts.map((d, di) => ({
        ...d,
        text: leafMap.get(`drafts.${di}.text`) ?? d.text,
        citations: d.citations.map((c, ci) => ({
          ...c,
          title: leafMap.get(`drafts.${di}.citations.${ci}.title`) ?? c.title,
          excerpt: leafMap.get(`drafts.${di}.citations.${ci}.excerpt`) ?? c.excerpt,
        })),
      })),
    };
  }

  return {
    decision,
    output: {
      policyVersion: policy.version,
      action: decision.action,
      reasons: decision.reasons,
      redactionCount: 0,
    },
    summary: input.summary,
    summaryCitations: input.summaryCitations,
    drafts: input.drafts,
  };
}

/**
 * Validates or sanitizes a Copilot job on read/replay without regenerating or mutating storage.
 */
export function validateSupportCopilotJobRead(params: {
  tenantId: number;
  job: SupportDeskCopilotResult;
}): {
  status: 'ok';
  job: SupportDeskCopilotResult;
} | {
  status: 'policy_changed';
} | {
  status: 'blocked';
} {
  const policy = loadPolicy(params.tenantId);
  const existingOutput = params.job.output;

  if (existingOutput) {
    if (policy.version !== existingOutput.policyVersion) {
      return { status: 'policy_changed' };
    }
    return { status: 'ok', job: params.job };
  }

  if (params.job.status === 'abstained') {
    return {
      status: 'ok',
      job: {
        ...params.job,
        output: {
          policyVersion: policy.version,
          action: 'allow',
          reasons: [],
          redactionCount: 0,
        },
      },
    };
  }

  const evalRes = evaluateSupportCopilotArtifacts({
    tenantId: params.tenantId,
    operationId: params.job.jobId,
    summary: params.job.summary,
    summaryCitations: params.job.summaryCitations,
    drafts: params.job.drafts,
    recordEvent: false,
  });

  if (evalRes.decision.action === 'block') {
    return { status: 'blocked' };
  }

  return {
    status: 'ok',
    job: {
      ...params.job,
      summary: evalRes.summary,
      summaryCitations: evalRes.summaryCitations,
      drafts: evalRes.drafts,
      output: evalRes.output,
    },
  };
}
