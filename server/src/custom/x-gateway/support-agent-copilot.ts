/**
 * Real-model grounded operator Copilot (Spec 019 - US2).
 * Owned by Agent 2 (server/src/custom/x-gateway/support-agent-copilot.ts).
 */

import crypto from 'node:crypto';
import {
  SUPPORT_DESK_LIMITS,
  type SupportDeskCopilotDraft,
  type SupportDeskCopilotInput,
  type SupportDeskCopilotResult,
  type SupportDeskCopilotTone,
} from '@freellmapi/shared/support-service-desk.js';
import {
  SUPPORT_EVIDENCE_ROLES,
  type SupportEvidencePolicy,
  type SupportEvidenceRole,
} from '@freellmapi/shared/support-evidence.js';
import {
  claimSupportDeskCopilot,
  failSupportDeskCopilot,
  finishSupportDeskCopilot,
  getSupportDeskCopilotJob,
  recordSupportDeskCopilotUsage,
  reserveSupportDeskCopilotAttempt,
  SupportDeskError,
} from './support-service-desk-store.js';
import { getSupportEvidencePolicy } from './support-evidence-store.js';
import {
  getSupportEvidenceSnapshotId,
  retrieveSupportEvidence,
  validateSupportEvidenceReply,
} from './support-evidence-retrieval.js';
import {
  maskSupportSensitiveData,
  maskSupportSensitiveText,
} from './support-knowledge.js';
import {
  executeSupportChatPipeline,
} from './support-router.js';
import { getSupportTenant } from './support-store.js';
import {
  getSupportConversationForUser,
  listSupportConversations,
  type SupportConversation,
} from './support-workflows.js';

export { SupportDeskError };

const VALID_COPILOT_TONES: readonly SupportDeskCopilotTone[] = [
  'empathetic',
  'direct',
  'technical',
];

const TOOL_CALL_MARKUP_RE =
  /<support_tool_call[\s\S]*?<\/support_tool_call>|<support_tool_call[\s>]|<\/support_tool_call>|<support_tool_result[\s\S]*?<\/support_tool_result>/i;

function computeConversationSnapshot(conversation: SupportConversation): string {
  const payload = {
    id: conversation.id,
    tenantId: String(conversation.tenantId),
    userId: conversation.userId,
    userRole: conversation.userRole,
    status: conversation.status,
    updatedAt: conversation.updatedAt,
    messages: (conversation.messages || []).map((m) => ({
      id: m.id,
      content: m.content,
      responseNotice: m.responseNotice
        ? crypto.createHash('sha256').update(JSON.stringify(m.responseNotice)).digest('hex')
        : null,
      evidenceStatus: m.evidence?.status ?? null,
      citations: m.evidence?.citations?.map((c) => c.id).sort() ?? null,
    })),
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function computeEvidenceSnapshot(
  tenantId: number,
  role: SupportEvidenceRole,
  policy: SupportEvidencePolicy,
): string {
  return getSupportEvidenceSnapshotId({ tenantId, role, policy });
}

function computeCopilotFingerprint(
  tenantId: number,
  actorId: number,
  requestId: string,
  conversationId: string,
): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ tenantId, actorId, requestId, conversationId }))
    .digest('hex');
}

/**
 * Normalizes [1], [2] ordinal markers to [cite:<citationId>] based on candidate list.
 */
function normalizeCitationMarkers(
  text: string,
  candidates: Array<{ citationId: string }>,
): string {
  return text.replace(/\[([1-9]\d*)\]/g, (match, numStr) => {
    const idx = parseInt(numStr, 10) - 1;
    if (idx >= 0 && idx < candidates.length) {
      return `[cite:${candidates[idx].citationId}]`;
    }
    return match;
  });
}

interface ParsedRawDraft {
  tone: unknown;
  text: unknown;
}

interface ParsedRawOutput {
  summary?: unknown;
  drafts?: unknown;
}

function parseModelOutput(rawText: string): {
  summary: string;
  drafts: Array<{ tone: SupportDeskCopilotTone; text: string }>;
} | null {
  if (typeof rawText !== 'string' || !rawText.trim()) return null;
  if (TOOL_CALL_MARKUP_RE.test(rawText)) return null;

  let cleaned = rawText.trim();
  const mdMatch = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(cleaned);
  if (mdMatch) {
    cleaned = mdMatch[1].trim();
  }

  let parsed: ParsedRawOutput;
  try {
    parsed = JSON.parse(cleaned) as ParsedRawOutput;
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  // Strict keys check: only summary and drafts allowed
  const keys = Object.keys(parsed).sort();
  if (keys.length !== 2 || keys[0] !== 'drafts' || keys[1] !== 'summary') return null;

  if (typeof parsed.summary !== 'string') return null;
  const summary = parsed.summary.trim();
  if (summary.length === 0 || summary.length > 2000) return null;
  if (TOOL_CALL_MARKUP_RE.test(summary)) return null;

  if (!Array.isArray(parsed.drafts) || parsed.drafts.length !== 3) return null;

  const seenTones = new Set<string>();
  const validDrafts: Array<{ tone: SupportDeskCopilotTone; text: string }> = [];

  for (const item of parsed.drafts as ParsedRawDraft[]) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const itemKeys = Object.keys(item).sort();
    if (itemKeys.length !== 2 || itemKeys[0] !== 'text' || itemKeys[1] !== 'tone') return null;

    if (
      typeof item.tone !== 'string' ||
      !VALID_COPILOT_TONES.includes(item.tone as SupportDeskCopilotTone)
    ) {
      return null;
    }
    const tone = item.tone as SupportDeskCopilotTone;
    if (seenTones.has(tone)) return null;
    seenTones.add(tone);

    if (typeof item.text !== 'string') return null;
    const text = item.text.trim();
    if (text.length === 0 || text.length > 2000) return null;
    if (TOOL_CALL_MARKUP_RE.test(text)) return null;

    validDrafts.push({ tone, text });
  }

  if (seenTones.size !== 3) return null;

  return { summary, drafts: validDrafts };
}

/**
 * Generates an operator Copilot summary and 3 distinct drafts.
 * Provider-bound, never canned, strictly validated and cost-accounted.
 */
export async function generateSupportAgentCopilot(params: {
  tenantId: number;
  actorId: number;
  input: SupportDeskCopilotInput;
  signal?: AbortSignal;
}): Promise<SupportDeskCopilotResult> {
  const { tenantId, actorId, input, signal } = params;

  if (typeof tenantId !== 'number' || !Number.isInteger(tenantId) || tenantId <= 0) {
    throw new SupportDeskError(400, 'invalid_input', 'tenantId must be a positive integer.');
  }
  if (typeof actorId !== 'number' || !Number.isInteger(actorId) || actorId <= 0) {
    throw new SupportDeskError(400, 'invalid_input', 'actorId must be a positive integer.');
  }
  if (
    !input ||
    typeof input !== 'object' ||
    typeof input.requestId !== 'string' ||
    !input.requestId.trim() ||
    typeof input.conversationId !== 'string' ||
    !input.conversationId.trim()
  ) {
    throw new SupportDeskError(400, 'invalid_input', 'requestId and conversationId are required.');
  }

  const requestId = input.requestId.trim();
  const conversationId = input.conversationId.trim();

  // 1. Resolve tenant
  const tenant = getSupportTenant(tenantId);
  if (!tenant) {
    throw new SupportDeskError(404, 'tenant_not_found', 'Support tenant not found.');
  }

  // 2. Select conversation and original customer identity
  const tenantConvs = listSupportConversations(String(tenantId));
  const foundSummary = tenantConvs.find((c) => c.id === conversationId);
  if (!foundSummary) {
    throw new SupportDeskError(404, 'conversation_not_found', 'Support conversation not found.');
  }

  const originalUserId = foundSummary.userId;
  const originalRole = foundSummary.userRole;

  if (!SUPPORT_EVIDENCE_ROLES.includes(originalRole as SupportEvidenceRole)) {
    throw new SupportDeskError(
      403,
      'unsupported_evidence_role',
      `Unsupported customer evidence role: "${originalRole}".`,
    );
  }

  const role = originalRole as SupportEvidenceRole;

  // Retrieve sanitized canonical conversation
  const conversation = getSupportConversationForUser(String(tenantId), conversationId, {
    userId: originalUserId,
    role,
  });

  const initialConversationSnapshot = computeConversationSnapshot(conversation);
  const evidencePolicy = getSupportEvidencePolicy(tenantId);
  const initialEvidenceSnapshot = computeEvidenceSnapshot(tenantId, role, evidencePolicy);

  // 3. Claim job / deduplication check
  const fingerprint = computeCopilotFingerprint(tenantId, actorId, requestId, conversationId);
  const claim = claimSupportDeskCopilot({
    tenantId,
    actorId,
    requestId,
    fingerprint,
    conversationId,
  });

  if (claim.status === 'replayed') {
    // Revalidate snapshots before returning cached result
    let currentConv: SupportConversation;
    try {
      currentConv = getSupportConversationForUser(String(tenantId), conversationId, {
        userId: originalUserId,
        role,
      });
    } catch {
      throw new SupportDeskError(409, 'copilot_context_changed', 'Conversation is no longer accessible.');
    }

    const currentConvSnap = computeConversationSnapshot(currentConv);
    const currentEvPolicy = getSupportEvidencePolicy(tenantId);
    const currentEvSnap = computeEvidenceSnapshot(tenantId, role, currentEvPolicy);

    if (
      currentConvSnap !== claim.result.conversationSnapshot ||
      currentEvSnap !== claim.result.evidenceSnapshot
    ) {
      throw new SupportDeskError(
        409,
        'copilot_context_changed',
        'Conversation or knowledge context changed since Copilot draft generation.',
      );
    }

    return { ...claim.result, replayed: true };
  }

  if (claim.status === 'running') {
    throw new SupportDeskError(
      409,
      'copilot_in_progress',
      'Copilot generation is currently in progress.',
      claim.retryAfterSeconds,
    );
  }

  const { jobId, leaseToken } = claim;

  // 4. Extract retrieval query from conversation
  const lastCustomerMessage = [...(conversation.messages || [])]
    .reverse()
    .find((m) => m.senderType === 'customer' || (m as { sender?: string }).sender === 'user');

  let pack = retrieveSupportEvidence({
    tenantId,
    role,
    query: (lastCustomerMessage?.content || '').slice(0, 500),
    policy: evidencePolicy,
    maxContextChars: evidencePolicy.maxEvidenceChars,
  });

  if (
    pack.candidates.length === 0 &&
    conversation.subject &&
    conversation.subject.trim() &&
    conversation.subject.trim() !== 'Support Conversation'
  ) {
    const subjectPack = retrieveSupportEvidence({
      tenantId,
      role,
      query: conversation.subject.trim().slice(0, 500),
      policy: evidencePolicy,
      maxContextChars: evidencePolicy.maxEvidenceChars,
    });
    if (subjectPack.candidates.length > 0) {
      pack = subjectPack;
    }
  }

  // Zero-model abstention if no matching sources
  if (pack.candidates.length === 0) {
    const abstainedResult: SupportDeskCopilotResult = {
      jobId,
      requestId,
      conversationId,
      status: 'abstained',
      reason: 'no_evidence',
      summary: '',
      drafts: [],
      summaryCitations: [],
      conversationSnapshot: initialConversationSnapshot,
      evidenceSnapshot: initialEvidenceSnapshot,
      policyVersion: evidencePolicy.version,
      modelUsed: null,
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        accounting: 'actual',
      },
      replayed: false,
      createdAt: new Date().toISOString(),
    };

    finishSupportDeskCopilot({
      tenantId,
      actorId,
      jobId,
      leaseToken,
      result: abstainedResult,
    });

    return abstainedResult;
  }

  // 5. Assemble bounded history (exclude unprovenanced / redacted AI)
  const historyMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  const boundedSlice = (conversation.messages || []).slice(-10);

  for (const m of boundedSlice) {
    const isAi =
      m.senderType === 'ai_assistant' || (m as { sender?: string }).sender === 'assistant';
    if (isAi) {
      if (!m.evidence || m.evidence.status !== 'cited' || m.responseNotice) continue;
    }
    const roleForMsg =
      m.senderType === 'customer' || (m as { sender?: string }).sender === 'user'
        ? 'user'
        : 'assistant';
    const maskedContent = maskSupportSensitiveText(String(tenantId), m.content, role).masked;
    historyMessages.push({ role: roleForMsg, content: maskedContent });
  }

  const promptInstruction = [
    'You are an AI Support Copilot for an internal human operator.',
    'Based strictly on the reference context and conversation history above, provide:',
    '1. A concise summary of the issue and relevant information.',
    '2. Exactly 3 suggested response drafts in 3 distinct tones: "empathetic", "direct", and "technical".',
    'Rules:',
    '- Completed summary and each draft must independently contain 1 to 5 citations referencing the candidates as [1], [2] or [cite:<id>].',
    '- Do NOT invent information outside the reference context.',
    '- Do NOT include tool calls or HTML markup.',
    '- Respond strictly with a JSON object in this exact schema:',
    '{',
    '  "summary": "...",',
    '  "drafts": [',
    '    { "tone": "empathetic", "text": "..." },',
    '    { "tone": "direct", "text": "..." },',
    '    { "tone": "technical", "text": "..." }',
    '  ]',
    '}',
  ].join('\n');

  const maskedPromptInstruction = maskSupportSensitiveText(String(tenantId), promptInstruction, role).masked;

  const assembledMessages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [
    ...historyMessages,
    { role: 'user', content: maskedPromptInstruction },
  ];

  // 6. Setup 15s deadline and AbortController
  const abortController = new AbortController();
  const deadlineTimer = setTimeout(() => {
    abortController.abort(new SupportDeskError(504, 'copilot_timeout', 'Copilot deadline (15s) exceeded.'));
  }, SUPPORT_DESK_LIMITS.copilotDeadlineMs);

  const forwardAbort = () => abortController.abort(signal?.reason);
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortController.signal.reason instanceof SupportDeskError
      ? abortController.signal.reason
      : new SupportDeskError(504, 'copilot_timeout', 'Copilot request was cancelled.'));
    abortController.signal.addEventListener('abort', onAbort, { once: true });
  });
  if (signal?.aborted) forwardAbort();
  else signal?.addEventListener('abort', forwardAbort, { once: true });

  let currentAttemptId: string | null = null;
  let currentEstimatedTokens = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let hasEstimatedUsage = false;
  let accounting: 'actual' | 'estimated' = 'actual';

  let pipelineResult: { reply: string; modelUsed?: string | null; usedFallback?: boolean };

  try {
    pipelineResult = await Promise.race([executeSupportChatPipeline({
      tenant,
      userContext: {
        tenantId: tenant.id,
        userId: originalUserId,
        role,
        permissions: [],
        verified: true,
        name: foundSummary.userName,
      },
      messages: assembledMessages,
      model: tenant.defaultModel,
      hooks: {
        trustedContext: pack.contextPrompt,
        disableTools: true,
        maxCompletionTokens: SUPPORT_DESK_LIMITS.copilotMaxCompletionTokens,
        maxModelCalls: SUPPORT_DESK_LIMITS.copilotMaxModelCalls,
        signal: abortController.signal,
        maskToolData: (val) => maskSupportSensitiveData(String(tenantId), val, role).masked,
        beforeModelCall: (turnMessages) => {
          const totalChars = turnMessages.reduce(
            (sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0),
            0,
          );
          if (totalChars > SUPPORT_DESK_LIMITS.copilotMaxPromptChars) {
            const boundErr = new SupportDeskError(
              400,
              'invalid_input',
              `Assembled prompt exceeds maximum limit of ${SUPPORT_DESK_LIMITS.copilotMaxPromptChars} characters.`,
            );
            abortController.abort(boundErr);
            throw boundErr;
          }

          const estTokens = Math.max(
            50,
            Math.ceil(Buffer.byteLength(JSON.stringify(turnMessages), 'utf8') / 3) +
              SUPPORT_DESK_LIMITS.copilotMaxCompletionTokens,
          );

          const { attemptId } = reserveSupportDeskCopilotAttempt({
            tenantId,
            actorId,
            jobId,
            leaseToken,
            estimatedTokens: estTokens,
          });
          currentAttemptId = attemptId;
          currentEstimatedTokens = estTokens;
        },
        recordModelUsage: (usage) => {
          if (currentAttemptId) {
            recordSupportDeskCopilotUsage({
              tenantId,
              actorId,
              jobId,
              leaseToken,
              attemptId: currentAttemptId,
              usage: usage
                ? {
                    promptTokens: usage.prompt_tokens,
                    completionTokens: usage.completion_tokens,
                    totalTokens: usage.total_tokens,
                  }
                : undefined,
            });
            if (usage) {
              totalPromptTokens += usage.prompt_tokens ?? 0;
              totalCompletionTokens += usage.completion_tokens ?? 0;
              accounting = hasEstimatedUsage ? 'estimated' : 'actual';
            } else {
              totalPromptTokens += Math.max(0, currentEstimatedTokens - SUPPORT_DESK_LIMITS.copilotMaxCompletionTokens);
              totalCompletionTokens += SUPPORT_DESK_LIMITS.copilotMaxCompletionTokens;
              hasEstimatedUsage = true;
              accounting = 'estimated';
            }
            currentAttemptId = null;
          }
        },
      },
    }), aborted]);
  } catch (err) {
    clearTimeout(deadlineTimer);
    if (abortController.signal.aborted) {
      const reason = abortController.signal.reason;
      if (reason instanceof SupportDeskError) {
        failSupportDeskCopilot({
          tenantId,
          actorId,
          jobId,
          leaseToken,
          code: reason.code,
        });
        throw reason;
      }
      failSupportDeskCopilot({
        tenantId,
        actorId,
        jobId,
        leaseToken,
        code: 'copilot_timeout',
      });
      throw new SupportDeskError(504, 'copilot_timeout', 'Copilot request timed out.');
    }
    if (err instanceof SupportDeskError) {
      failSupportDeskCopilot({
        tenantId,
        actorId,
        jobId,
        leaseToken,
        code: err.code,
      });
      throw err;
    }
    failSupportDeskCopilot({
      tenantId,
      actorId,
      jobId,
      leaseToken,
      code: 'model_unavailable',
    });
    throw new SupportDeskError(503, 'model_unavailable', 'No eligible AI model completed this Copilot request.');
  } finally {
    clearTimeout(deadlineTimer);
    signal?.removeEventListener('abort', forwardAbort);
    abortController.signal.removeEventListener('abort', onAbort);
  }

  if (pipelineResult.usedFallback) {
    failSupportDeskCopilot({
      tenantId,
      actorId,
      jobId,
      leaseToken,
      code: 'model_unavailable',
    });
    throw new SupportDeskError(
      503,
      'model_unavailable',
      'No eligible AI model completed this Copilot request without fallback.',
    );
  }

  // 7. Strictly parse model artifact
  const parsed = parseModelOutput(pipelineResult.reply);
  if (!parsed) {
    const invalidResult: SupportDeskCopilotResult = {
      jobId,
      requestId,
      conversationId,
      status: 'abstained',
      reason: 'invalid_result',
      summary: '',
      drafts: [],
      summaryCitations: [],
      conversationSnapshot: initialConversationSnapshot,
      evidenceSnapshot: initialEvidenceSnapshot,
      policyVersion: evidencePolicy.version,
      modelUsed: pipelineResult.modelUsed || tenant.defaultModel || 'auto',
      usage: {
        promptTokens: totalPromptTokens,
        completionTokens: totalCompletionTokens,
        totalTokens: totalPromptTokens + totalCompletionTokens,
        accounting,
      },
      replayed: false,
      createdAt: new Date().toISOString(),
    };
    finishSupportDeskCopilot({
      tenantId,
      actorId,
      jobId,
      leaseToken,
      result: invalidResult,
    });
    return invalidResult;
  }

  // 8. Independently validate citations for summary and each draft
  const normalizedSummary = normalizeCitationMarkers(parsed.summary, pack.candidates);
  const summaryVal = validateSupportEvidenceReply({
    tenantId,
    role,
    policy: evidencePolicy,
    pack,
    reply: normalizedSummary,
  });

  if (!summaryVal.valid || summaryVal.citations.length < 1 || summaryVal.citations.length > 5) {
    const reason = summaryVal.reason === 'sources_changed' ? 'sources_changed' : 'invalid_result';
    const abstainedResult: SupportDeskCopilotResult = {
      jobId,
      requestId,
      conversationId,
      status: 'abstained',
      reason,
      summary: '',
      drafts: [],
      summaryCitations: [],
      conversationSnapshot: initialConversationSnapshot,
      evidenceSnapshot: initialEvidenceSnapshot,
      policyVersion: evidencePolicy.version,
      modelUsed: pipelineResult.modelUsed || tenant.defaultModel || 'auto',
      usage: {
        promptTokens: totalPromptTokens,
        completionTokens: totalCompletionTokens,
        totalTokens: totalPromptTokens + totalCompletionTokens,
        accounting,
      },
      replayed: false,
      createdAt: new Date().toISOString(),
    };
    finishSupportDeskCopilot({
      tenantId,
      actorId,
      jobId,
      leaseToken,
      result: abstainedResult,
    });
    return abstainedResult;
  }

  const validatedDrafts: SupportDeskCopilotDraft[] = [];

  for (const draft of parsed.drafts) {
    const normalizedDraftText = normalizeCitationMarkers(draft.text, pack.candidates);
    const draftVal = validateSupportEvidenceReply({
      tenantId,
      role,
      policy: evidencePolicy,
      pack,
      reply: normalizedDraftText,
    });

    if (!draftVal.valid || draftVal.citations.length < 1 || draftVal.citations.length > 5) {
      const reason = draftVal.reason === 'sources_changed' ? 'sources_changed' : 'invalid_result';
      const abstainedResult: SupportDeskCopilotResult = {
        jobId,
        requestId,
        conversationId,
        status: 'abstained',
        reason,
        summary: '',
        drafts: [],
        summaryCitations: [],
        conversationSnapshot: initialConversationSnapshot,
        evidenceSnapshot: initialEvidenceSnapshot,
        policyVersion: evidencePolicy.version,
        modelUsed: pipelineResult.modelUsed || tenant.defaultModel || 'auto',
        usage: {
          promptTokens: totalPromptTokens,
          completionTokens: totalCompletionTokens,
          totalTokens: totalPromptTokens + totalCompletionTokens,
          accounting,
        },
        replayed: false,
        createdAt: new Date().toISOString(),
      };
      finishSupportDeskCopilot({
        tenantId,
        actorId,
        jobId,
        leaseToken,
        result: abstainedResult,
      });
      return abstainedResult;
    }

    validatedDrafts.push({
      tone: draft.tone,
      text: maskSupportSensitiveText(String(tenantId), draftVal.canonicalReply, role).masked,
      citations: draftVal.citations,
    });
  }

  // 9. Recheck in-flight conversation and source freshness
  let currentConv: SupportConversation;
  try {
    currentConv = getSupportConversationForUser(String(tenantId), conversationId, {
      userId: originalUserId,
      role,
    });
  } catch {
    failSupportDeskCopilot({
      tenantId,
      actorId,
      jobId,
      leaseToken,
      code: 'copilot_context_changed',
    });
    throw new SupportDeskError(409, 'copilot_context_changed', 'Conversation deleted or inaccessible.');
  }

  const currentConvSnap = computeConversationSnapshot(currentConv);
  let currentEvPolicy: SupportEvidencePolicy;
  let currentEvSnap: string;
  try {
    currentEvPolicy = getSupportEvidencePolicy(tenantId);
    currentEvSnap = computeEvidenceSnapshot(tenantId, role, currentEvPolicy);
  } catch (err) {
    failSupportDeskCopilot({
      tenantId,
      actorId,
      jobId,
      leaseToken,
      code: 'service_desk_storage_unavailable',
    });
    throw err;
  }

  if (
    currentConvSnap !== initialConversationSnapshot ||
    currentEvSnap !== initialEvidenceSnapshot
  ) {
    // In-flight stale -> safe sources_changed abstention with current snapshot
    const staleResult: SupportDeskCopilotResult = {
      jobId,
      requestId,
      conversationId,
      status: 'abstained',
      reason: 'sources_changed',
      summary: '',
      drafts: [],
      summaryCitations: [],
      conversationSnapshot: currentConvSnap,
      evidenceSnapshot: currentEvSnap,
      policyVersion: currentEvPolicy.version,
      modelUsed: pipelineResult.modelUsed || tenant.defaultModel || 'auto',
      usage: {
        promptTokens: totalPromptTokens,
        completionTokens: totalCompletionTokens,
        totalTokens: totalPromptTokens + totalCompletionTokens,
        accounting,
      },
      replayed: false,
      createdAt: new Date().toISOString(),
    };
    finishSupportDeskCopilot({
      tenantId,
      actorId,
      jobId,
      leaseToken,
      result: staleResult,
    });
    return staleResult;
  }

  // 10. Persist completed result
  const completedResult: SupportDeskCopilotResult = {
    jobId,
    requestId,
    conversationId,
    status: 'completed',
    summary: maskSupportSensitiveText(String(tenantId), summaryVal.canonicalReply, role).masked,
    summaryCitations: summaryVal.citations,
    drafts: validatedDrafts,
    conversationSnapshot: initialConversationSnapshot,
    evidenceSnapshot: initialEvidenceSnapshot,
    policyVersion: evidencePolicy.version,
    modelUsed: pipelineResult.modelUsed || tenant.defaultModel || 'auto',
    usage: {
      promptTokens: totalPromptTokens,
      completionTokens: totalCompletionTokens,
      totalTokens: totalPromptTokens + totalCompletionTokens,
      accounting,
    },
    replayed: false,
    createdAt: new Date().toISOString(),
  };

  finishSupportDeskCopilot({
    tenantId,
    actorId,
    jobId,
    leaseToken,
    result: completedResult,
  });

  return completedResult;
}

/**
 * Reads an existing operator Copilot job result after revalidating current context.
 */
export function readSupportAgentCopilotJob(params: {
  tenantId: number;
  actorId: number;
  jobId: string;
}): SupportDeskCopilotResult {
  const { tenantId, actorId, jobId } = params;

  if (typeof tenantId !== 'number' || !Number.isInteger(tenantId) || tenantId <= 0) {
    throw new SupportDeskError(400, 'invalid_input', 'tenantId must be a positive integer.');
  }
  if (typeof actorId !== 'number' || !Number.isInteger(actorId) || actorId <= 0) {
    throw new SupportDeskError(400, 'invalid_input', 'actorId must be a positive integer.');
  }
  if (typeof jobId !== 'string' || !jobId.trim()) {
    throw new SupportDeskError(400, 'invalid_input', 'jobId must be a non-empty string.');
  }

  const job = getSupportDeskCopilotJob({ tenantId, actorId, jobId });

  // Revalidate context before returning
  let conversation: SupportConversation;
  try {
    const convs = listSupportConversations(String(tenantId));
    const found = convs.find((c) => c.id === job.conversationId);
    if (!found) {
      throw new SupportDeskError(409, 'copilot_context_changed', 'Conversation no longer exists.');
    }
    conversation = getSupportConversationForUser(String(tenantId), job.conversationId, {
      userId: found.userId,
      role: found.userRole,
    });
  } catch (err) {
    if (err instanceof SupportDeskError) throw err;
    throw new SupportDeskError(409, 'copilot_context_changed', 'Conversation is no longer accessible.');
  }

  const currentConvSnap = computeConversationSnapshot(conversation);
  if (currentConvSnap !== job.conversationSnapshot) {
    throw new SupportDeskError(
      409,
      'copilot_context_changed',
      'Conversation changed since Copilot draft generation.',
    );
  }

  const currentEvPolicy = getSupportEvidencePolicy(tenantId);
  const currentEvSnap = computeEvidenceSnapshot(
    tenantId,
    conversation.userRole as SupportEvidenceRole,
    currentEvPolicy,
  );
  if (currentEvSnap !== job.evidenceSnapshot) {
    throw new SupportDeskError(
      409,
      'copilot_context_changed',
      'Knowledge sources changed since Copilot draft generation.',
    );
  }

  return {
    ...job,
    replayed: true,
  };
}
