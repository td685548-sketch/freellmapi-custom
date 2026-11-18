/**
 * Cross-Provider Thinking Budget Normalization & Foreign Block Sanitization (Spec 031).
 *
 * - Normalizes `reasoning_effort` <-> `thinking.budget_tokens` across OpenAI, Claude,
 *   and Gemini while strictly enforcing Anthropic's `budget_tokens < max_tokens` invariant.
 * - Strips incompatible `thinking` / `redacted_thinking` blocks and foreign
 *   `thoughtSignature` / `thought_signature` fields when failing over across model
 *   families, providers, or OAuth accounts/connections.
 */

import type {
  CanonicalThinkingEffort,
  ClaudeAdaptiveEffort,
  ClaudeSignedThinkingBlock,
  ClaudeThinkingSegment,
  NormalizedThinkingBudget,
  ThoughtSignatureModelFamily,
} from '@freellmapi/shared/thinking-continuity.js';
import type { ChatMessage, ChatToolCall } from '@freellmapi/shared/types.js';
import type { CompletionOptions } from '../../providers/base.js';
import {
  buildThoughtSignatureNamespace,
  canonicalThoughtSigArgs,
  getStoredClaudeBlockBinding,
  getStoredThoughtSignatureProvenance,
  getThoughtSignatureModelFamily,
  isRestoredClaudeThinkingBlock,
  isSkipValidationSentinel,
  normalizeClaudeThinkingModel,
  normalizeThinkingProvider,
  recallGeminiThoughtSignature,
  recordForeignSignaturesStripped,
  restoreClaudeThinkingBlocks,
  storeGeminiThoughtSignature,
} from './thinking-store.js';

export {
  canonicalThoughtSigArgs,
  getThoughtSignatureModelFamily,
  normalizeClaudeThinkingModel,
  normalizeThinkingProvider,
};

export const LEVEL_TO_BUDGET_TOKENS: Readonly<Record<CanonicalThinkingEffort, number>> = {
  none: 0,
  auto: -1,
  minimal: 512,
  low: 1024,
  medium: 8192,
  high: 24576,
  xhigh: 32768,
  max: 128000,
};

export const CLAUDE_MIN_THINKING_BUDGET_TOKENS = 1024;
export const DEFAULT_THINKING_MAX_BUDGET_TOKENS = 128000;
export const DEFAULT_OUTPUT_HEADROOM_TOKENS = 4096;

export function effortToBudgetTokens(effort: unknown): number | undefined {
  if (typeof effort !== 'string') return undefined;
  const key = effort.trim().toLowerCase() as CanonicalThinkingEffort;
  return Object.prototype.hasOwnProperty.call(LEVEL_TO_BUDGET_TOKENS, key)
    ? LEVEL_TO_BUDGET_TOKENS[key]
    : undefined;
}

export function budgetTokensToEffort(budget: unknown): CanonicalThinkingEffort | undefined {
  if (typeof budget !== 'number' || !Number.isFinite(budget)) return undefined;
  const value = Math.trunc(budget);
  if (value < -1) return undefined;
  if (value === -1) return 'auto';
  if (value === 0) return 'none';
  if (value <= 512) return 'minimal';
  if (value <= 1024) return 'low';
  if (value <= 8192) return 'medium';
  if (value <= 24576) return 'high';
  if (value <= 65536) return 'xhigh';
  return 'max';
}

export function mapEffortToClaudeAdaptive(
  effort: unknown,
  supportsMax = true,
): ClaudeAdaptiveEffort | undefined {
  if (typeof effort !== 'string') return undefined;
  const normalized = effort.trim().toLowerCase();
  switch (normalized) {
    case 'minimal':
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
    case 'auto':
      return 'high';
    case 'xhigh':
    case 'max':
      return supportsMax ? 'max' : 'high';
    default:
      return undefined;
  }
}

export function mapEffortToOpenAIReasoning(
  effort: unknown,
): 'none' | 'minimal' | 'low' | 'medium' | 'high' | undefined {
  if (typeof effort !== 'string') return undefined;
  const normalized = effort.trim().toLowerCase();
  switch (normalized) {
    case 'none':
      return 'none';
    case 'minimal':
      return 'minimal';
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
    case 'xhigh':
    case 'max':
    case 'auto':
      return 'high';
    default:
      return undefined;
  }
}

export interface NormalizeThinkingBudgetInput {
  effort?: unknown;
  budgetTokens?: unknown;
  thinking?: {
    type?: unknown;
    budget_tokens?: unknown;
  } | null;
  maxTokens?: unknown;
  defaultMaxTokens?: number;
  minBudgetTokens?: number;
  maxBudgetTokens?: number;
  targetFamily?: 'claude' | 'gemini' | 'openai' | string | null;
}

export interface ExtendedNormalizedThinkingBudget extends NormalizedThinkingBudget {
  anthropicThinking?: Record<string, unknown>;
  geminiThinkingConfig?: Record<string, unknown>;
  openaiReasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high';
}

/**
 * Normalizes cross-provider thinking configuration (`reasoning_effort` <-> `thinking.budget_tokens`)
 * while strictly guaranteeing `budget_tokens < max_tokens` whenever both are positive.
 */
export function normalizeThinkingBudget(
  input: NormalizeThinkingBudgetInput,
): ExtendedNormalizedThinkingBudget {
  const target = typeof input.targetFamily === 'string' ? input.targetFamily.trim().toLowerCase() : '';
  const isClaudeTarget = target === 'claude' || target === 'anthropic';

  const explicitMax =
    typeof input.maxTokens === 'number' && Number.isFinite(input.maxTokens) && input.maxTokens > 0
      ? Math.trunc(input.maxTokens)
      : undefined;
  const fallbackMax =
    typeof input.defaultMaxTokens === 'number' &&
    Number.isFinite(input.defaultMaxTokens) &&
    input.defaultMaxTokens > 0
      ? Math.trunc(input.defaultMaxTokens)
      : undefined;

  const rawThinkingType =
    typeof input.thinking?.type === 'string' ? input.thinking.type.trim().toLowerCase() : '';
  const rawThinkingBudget =
    typeof input.budgetTokens === 'number' && Number.isFinite(input.budgetTokens)
      ? Math.trunc(input.budgetTokens)
      : typeof input.thinking?.budget_tokens === 'number' && Number.isFinite(input.thinking.budget_tokens)
        ? Math.trunc(input.thinking.budget_tokens)
        : undefined;
  const rawEffort =
    typeof input.effort === 'string' && input.effort.trim().length > 0
      ? input.effort.trim().toLowerCase()
      : undefined;

  // 1. Explicit disable (`none`, `disabled`, or `budget_tokens: 0`)
  if (
    rawThinkingType === 'disabled' ||
    rawThinkingBudget === 0 ||
    (rawThinkingBudget === undefined && rawEffort === 'none')
  ) {
    return {
      mode: 'none',
      effort: 'none',
      budgetTokens: 0,
      maxTokens: explicitMax ?? fallbackMax,
      clampedBudget: false,
      anthropicThinking: { type: 'disabled' },
      geminiThinkingConfig: { thinkingBudget: 0 },
      openaiReasoningEffort: 'none',
    };
  }

  // 2. Adaptive / Auto mode without explicit positive budget
  if (
    rawThinkingType === 'adaptive' ||
    rawThinkingBudget === -1 ||
    (rawThinkingBudget === undefined && rawEffort === 'auto')
  ) {
    return {
      mode: 'auto',
      effort: 'auto',
      budgetTokens: -1,
      maxTokens: explicitMax ?? fallbackMax,
      clampedBudget: false,
      anthropicThinking: { type: 'adaptive' },
      geminiThinkingConfig: { thinkingBudget: -1, includeThoughts: true },
      openaiReasoningEffort: 'high',
    };
  }

  // 3. Resolve positive budget from explicit budget_tokens or canonical effort
  const derivedFromEffort = rawEffort !== undefined ? effortToBudgetTokens(rawEffort) : undefined;
  const candidateBudget =
    rawThinkingBudget !== undefined && rawThinkingBudget > 0
      ? rawThinkingBudget
      : derivedFromEffort !== undefined && derivedFromEffort > 0
        ? derivedFromEffort
        : undefined;

  if (candidateBudget === undefined) {
    return {
      mode: 'none',
      maxTokens: explicitMax ?? fallbackMax,
      clampedBudget: false,
    };
  }

  const minBudget =
    typeof input.minBudgetTokens === 'number' && Number.isFinite(input.minBudgetTokens)
      ? Math.max(1, Math.trunc(input.minBudgetTokens))
      : isClaudeTarget
        ? CLAUDE_MIN_THINKING_BUDGET_TOKENS
        : 1;
  const maxBudget =
    typeof input.maxBudgetTokens === 'number' && Number.isFinite(input.maxBudgetTokens)
      ? Math.max(minBudget, Math.trunc(input.maxBudgetTokens))
      : DEFAULT_THINKING_MAX_BUDGET_TOKENS;

  let budget = candidateBudget;
  let clamped = false;

  if (budget < minBudget) {
    budget = minBudget;
    clamped = true;
  }
  if (budget > maxBudget) {
    budget = maxBudget;
    clamped = true;
  }

  let effectiveMaxTokens = explicitMax ?? fallbackMax;
  if (effectiveMaxTokens !== undefined) {
    if (budget >= effectiveMaxTokens) {
      const squeezed = effectiveMaxTokens - 1;
      if (isClaudeTarget && squeezed < minBudget) {
        // Cannot satisfy both `budget_tokens >= 1024` and `budget_tokens < max_tokens`
        // under the caller's tight max_tokens ceiling: disable manual budget thinking cleanly.
        return {
          mode: 'none',
          effort: 'none',
          budgetTokens: 0,
          maxTokens: effectiveMaxTokens,
          clampedBudget: true,
          anthropicThinking: { type: 'disabled' },
          geminiThinkingConfig: { thinkingBudget: 0 },
          openaiReasoningEffort: 'none',
        };
      }
      budget = Math.max(0, squeezed);
      clamped = true;
    }
  } else {
    effectiveMaxTokens = budget + DEFAULT_OUTPUT_HEADROOM_TOKENS;
  }

  const resolvedEffort =
    (!clamped && rawEffort ? (effortToBudgetTokens(rawEffort) !== undefined ? (rawEffort as CanonicalThinkingEffort) : undefined) : undefined) ??
    budgetTokensToEffort(budget) ??
    'medium';

  if (budget <= 0) {
    return {
      mode: 'none',
      effort: 'none',
      budgetTokens: 0,
      maxTokens: effectiveMaxTokens,
      clampedBudget: clamped,
      anthropicThinking: { type: 'disabled' },
      geminiThinkingConfig: { thinkingBudget: 0 },
      openaiReasoningEffort: 'none',
    };
  }

  return {
    mode: 'budget',
    effort: resolvedEffort,
    budgetTokens: budget,
    maxTokens: effectiveMaxTokens,
    clampedBudget: clamped,
    anthropicThinking: {
      type: 'enabled',
      budget_tokens: budget,
    },
    geminiThinkingConfig: {
      thinkingBudget: budget,
      includeThoughts: true,
    },
    openaiReasoningEffort: mapEffortToOpenAIReasoning(resolvedEffort),
  };
}

export interface SanitizeThinkingOptions {
  provider?: string;
  model?: string;
  connectionId?: string | number | null;
  namespace?: string | null;
  accountId?: string | number | null;
  keyId?: string | number | null;
  apiKey?: string | null;
  isFailover?: boolean;
  recordDiagnostics?: boolean;
  now?: number;
}

export interface SanitizeThinkingResult<T = Record<string, unknown>> {
  messages: T[];
  strippedCount: number;
}

function shouldKeepClaudeBlock(
  block: Record<string, unknown>,
  targetFamily: ThoughtSignatureModelFamily | null,
  targetProvider: string,
  targetNormalizedModel: string,
  targetConnectionId: string,
  isFailover: boolean,
  now: number,
): boolean {
  if (targetFamily !== 'claude') return false;

  if (block.type === 'thinking') {
    if (typeof block.thinking !== 'string') return false;
    if (typeof block.signature !== 'string' || block.signature.length === 0) return false;
  } else if (block.type === 'redacted_thinking') {
    if (typeof block.data !== 'string' || block.data.length === 0) return false;
  } else {
    return false;
  }

  // Explicit source provenance annotations on block (if present)
  if (typeof block.modelFamily === 'string' && block.modelFamily !== 'claude') {
    return false;
  }
  if (
    typeof block.sourceProvider === 'string' &&
    targetProvider &&
    normalizeThinkingProvider(block.sourceProvider) !== targetProvider
  ) {
    return false;
  }
  if (
    typeof block.sourceModel === 'string' &&
    targetNormalizedModel &&
    normalizeClaudeThinkingModel(block.sourceModel) !== targetNormalizedModel
  ) {
    return false;
  }
  if (
    typeof block.sourceConnectionId === 'string' &&
    targetConnectionId &&
    block.sourceConnectionId.trim() !== targetConnectionId
  ) {
    return false;
  }

  if (isRestoredClaudeThinkingBlock(block)) {
    return true;
  }

  const storedBinding = getStoredClaudeBlockBinding(block, now);
  if (storedBinding) {
    if (targetProvider && storedBinding.provider !== targetProvider) return false;
    if (targetNormalizedModel && storedBinding.model !== targetNormalizedModel) return false;
    if (targetConnectionId && storedBinding.connectionId !== targetConnectionId) return false;
    return true;
  }

  // On failover across accounts/models, never forward unverified client-echoed
  // signatures that were minted on a prior failed route.
  if (isFailover) {
    return false;
  }

  return true;
}

function shouldKeepThoughtSignature(
  signature: unknown,
  targetFamily: ThoughtSignatureModelFamily | null,
  targetProvider: string,
  targetNamespace: string,
  isFailover: boolean,
  now: number,
): boolean {
  if (typeof signature !== 'string' || signature.length === 0) return false;

  const acceptsThoughtSig =
    targetFamily === 'gemini' || targetProvider === 'antigravity';
  if (!acceptsThoughtSig) {
    return false;
  }

  if (isSkipValidationSentinel(signature)) {
    return true;
  }

  const provenance = getStoredThoughtSignatureProvenance(signature, now);
  if (provenance) {
    if (targetFamily && provenance.modelFamily && provenance.modelFamily !== targetFamily) {
      return false;
    }
    if (isFailover && targetNamespace && provenance.namespace !== targetNamespace) {
      return false;
    }
    return true;
  }

  if (isFailover) {
    return false;
  }

  return true;
}

function sanitizeToolCallEntry(
  tc: unknown,
  targetFamily: ThoughtSignatureModelFamily | null,
  targetProvider: string,
  targetNamespace: string,
  isFailover: boolean,
  now: number,
): { toolCall: unknown; stripped: number } {
  if (!tc || typeof tc !== 'object' || Array.isArray(tc)) {
    return { toolCall: tc, stripped: 0 };
  }
  const record = tc as Record<string, unknown>;
  let stripped = 0;
  let next: Record<string, unknown> | null = null;

  for (const field of ['thought_signature', 'thoughtSignature'] as const) {
    if (field in record && record[field] !== undefined) {
      const keep = shouldKeepThoughtSignature(
        record[field],
        targetFamily,
        targetProvider,
        targetNamespace,
        isFailover,
        now,
      );
      if (!keep) {
        next ??= { ...record };
        delete next[field];
        stripped += 1;
      }
    }
  }

  return { toolCall: next ?? tc, stripped };
}

/**
 * Strips incompatible Claude `thinking`/`redacted_thinking` blocks and foreign
 * `thoughtSignature`/`thought_signature` fields from OpenAI, Anthropic, or Gemini
 * message histories before dispatching to a target route.
 */
export function sanitizeForeignThinkingBlocks<T>(
  messages: readonly T[],
  options?: SanitizeThinkingOptions,
): SanitizeThinkingResult<T> {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages: [], strippedCount: 0 };
  }

  const now = options?.now ?? Date.now();
  const targetProvider = normalizeThinkingProvider(options?.provider);
  const targetFamily = getThoughtSignatureModelFamily(options?.model, options?.provider);
  const targetNormalizedModel = normalizeClaudeThinkingModel(options?.model);
  const targetConnectionId =
    options?.connectionId !== undefined && options?.connectionId !== null
      ? String(options.connectionId).trim()
      : options?.accountId !== undefined && options?.accountId !== null
        ? String(options.accountId).trim()
        : '';
  const targetNamespace = buildThoughtSignatureNamespace({
    namespace: options?.namespace,
    accountId: options?.accountId ?? options?.connectionId,
    keyId: options?.keyId,
    apiKey: options?.apiKey,
  });
  const isFailover = options?.isFailover === true;

  let strippedCount = 0;
  const out: T[] = [];

  for (const rawMsg of messages) {
    if (!rawMsg || typeof rawMsg !== 'object' || Array.isArray(rawMsg)) {
      out.push(rawMsg);
      continue;
    }

    const msg = rawMsg as Record<string, unknown>;
    let mutated: Record<string, unknown> | null = null;

    // 1. Sanitize `content` block arrays (Anthropic Messages / multimodal Chat)
    if (Array.isArray(msg.content)) {
      const nextContent: unknown[] = [];
      let contentChanged = false;

      for (const part of msg.content) {
        if (!part || typeof part !== 'object' || Array.isArray(part)) {
          nextContent.push(part);
          continue;
        }
        const block = part as Record<string, unknown>;
        if (block.type === 'thinking' || block.type === 'redacted_thinking') {
          const keep = shouldKeepClaudeBlock(
            block,
            targetFamily,
            targetProvider,
            targetNormalizedModel,
            targetConnectionId,
            isFailover,
            now,
          );
          if (!keep) {
            strippedCount += 1;
            contentChanged = true;
            continue;
          }
          nextContent.push(part);
          continue;
        }

        let blockCopy: Record<string, unknown> | null = null;
        for (const sigField of ['thoughtSignature', 'thought_signature'] as const) {
          if (sigField in block && block[sigField] !== undefined) {
            const keepSig = shouldKeepThoughtSignature(
              block[sigField],
              targetFamily,
              targetProvider,
              targetNamespace,
              isFailover,
              now,
            );
            if (!keepSig) {
              blockCopy ??= { ...block };
              delete blockCopy[sigField];
              strippedCount += 1;
              contentChanged = true;
            }
          }
        }
        nextContent.push(blockCopy ?? part);
      }

      if (contentChanged) {
        mutated ??= { ...msg };
        const hasToolCalls =
          (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) ||
          nextContent.some(
            p => p && typeof p === 'object' && (p as Record<string, unknown>).type === 'tool_use',
          );
        if (nextContent.length === 0 && !hasToolCalls) {
          mutated.content = msg.role === 'assistant' ? '' : [{ type: 'text', text: '' }];
        } else {
          mutated.content = nextContent;
        }
      }
    }

    // 2. Sanitize carried `thinking_blocks` metadata on translated ChatMessages
    if (Array.isArray(msg.thinking_blocks)) {
      const keptBlocks: ClaudeSignedThinkingBlock[] = [];
      let tbChanged = false;
      for (const tb of msg.thinking_blocks) {
        if (
          tb &&
          typeof tb === 'object' &&
          !Array.isArray(tb) &&
          shouldKeepClaudeBlock(
            tb as Record<string, unknown>,
            targetFamily,
            targetProvider,
            targetNormalizedModel,
            targetConnectionId,
            isFailover,
            now,
          )
        ) {
          keptBlocks.push(tb as ClaudeSignedThinkingBlock);
        } else {
          strippedCount += 1;
          tbChanged = true;
        }
      }
      if (tbChanged) {
        mutated ??= { ...msg };
        if (keptBlocks.length > 0) {
          mutated.thinking_blocks = keptBlocks;
        } else {
          delete mutated.thinking_blocks;
        }
      }
    }

    // 3. Sanitize OpenAI `tool_calls`
    if (Array.isArray(msg.tool_calls)) {
      let tcChanged = false;
      const nextCalls = msg.tool_calls.map(tc => {
        const res = sanitizeToolCallEntry(
          tc,
          targetFamily,
          targetProvider,
          targetNamespace,
          isFailover,
          now,
        );
        if (res.stripped > 0) {
          strippedCount += res.stripped;
          tcChanged = true;
        }
        return res.toolCall;
      });
      if (tcChanged) {
        mutated ??= { ...msg };
        mutated.tool_calls = nextCalls;
      }
    }

    // 4. Sanitize Gemini `parts`
    if (Array.isArray(msg.parts)) {
      let partsChanged = false;
      const nextParts: unknown[] = [];
      for (const rawPart of msg.parts) {
        if (!rawPart || typeof rawPart !== 'object' || Array.isArray(rawPart)) {
          nextParts.push(rawPart);
          continue;
        }
        const part = rawPart as Record<string, unknown>;
        if (part.thought === true && targetFamily !== 'gemini') {
          strippedCount += 1;
          partsChanged = true;
          continue;
        }
        let partCopy: Record<string, unknown> | null = null;
        for (const sigField of ['thoughtSignature', 'thought_signature'] as const) {
          if (sigField in part && part[sigField] !== undefined) {
            const keepSig = shouldKeepThoughtSignature(
              part[sigField],
              targetFamily,
              targetProvider,
              targetNamespace,
              isFailover,
              now,
            );
            if (!keepSig) {
              partCopy ??= { ...part };
              delete partCopy[sigField];
              strippedCount += 1;
              partsChanged = true;
            }
          }
        }
        nextParts.push(partCopy ?? rawPart);
      }
      if (partsChanged) {
        mutated ??= { ...msg };
        mutated.parts = nextParts.length > 0 ? nextParts : [{ text: '' }];
      }
    }

    out.push((mutated ?? rawMsg) as T);
  }

  if (strippedCount > 0 && options?.recordDiagnostics !== false) {
    recordForeignSignaturesStripped(strippedCount);
  }

  return { messages: out, strippedCount };
}

/**
 * Splices restored `ClaudeThinkingSegment[]` into an Anthropic assistant `content`
 * array directly ahead of each corresponding `tool_use` block.
 */
export function spliceClaudeThinkingSegmentsIntoContent(
  blocks: readonly Record<string, unknown>[],
  segments: readonly ClaudeThinkingSegment[] | null | undefined,
): Record<string, unknown>[] {
  if (!segments || segments.length === 0) return [...blocks];
  const byToolId = new Map<string, ClaudeSignedThinkingBlock[]>();
  for (const seg of segments) {
    if (seg.toolUseId && seg.blocks.length > 0) {
      byToolId.set(seg.toolUseId, seg.blocks);
    }
  }
  if (byToolId.size === 0) return [...blocks];

  const out: Record<string, unknown>[] = [];
  for (const block of blocks) {
    if (block.type === 'tool_use' && typeof block.id === 'string') {
      const preceding = byToolId.get(block.id);
      if (preceding) {
        for (const tb of preceding) {
          out.push({ ...tb });
        }
        byToolId.delete(block.id);
      }
    }
    out.push(block);
  }
  return out;
}

export interface GatewayThinkingCandidateInput {
  messages: ChatMessage[];
  options: CompletionOptions;
  rawThinking?: { type?: unknown; budget_tokens?: unknown } | null;
  provider: string;
  modelId: string;
  accountId: number | string;
  isFailover?: boolean;
}

export interface GatewayThinkingCandidateOutput {
  messages: ChatMessage[];
  options: CompletionOptions & { anthropicThinking?: Record<string, unknown> };
  strippedForeignBlocks: number;
}

export function prepareGatewayThinkingRequest(
  input: GatewayThinkingCandidateInput,
): GatewayThinkingCandidateOutput {
  const sanitized = sanitizeForeignThinkingBlocks(input.messages, {
    provider: input.provider,
    model: input.modelId,
    connectionId: String(input.accountId),
    accountId: input.accountId,
    isFailover: input.isFailover,
  });

  const targetFamily = getThoughtSignatureModelFamily(input.modelId, input.provider);
  const normalizedProvider = normalizeThinkingProvider(input.provider);

  const preparedMessages = sanitized.messages.map(msg => {
    if (msg.role !== 'assistant' || !Array.isArray(msg.tool_calls) || msg.tool_calls.length === 0) {
      return msg;
    }

    if (targetFamily === 'gemini' || normalizedProvider === 'antigravity') {
      let callsChanged = false;
      const nextCalls = msg.tool_calls.map(tc => {
        if (tc.thought_signature) return tc;
        const recalled = recallGeminiThoughtSignature({
          accountId: input.accountId,
          model: input.modelId,
          provider: input.provider,
          toolCallId: tc.id,
          name: tc.function.name,
          callArgs: tc.function.arguments,
        });
        if (!recalled) return tc;
        callsChanged = true;
        return { ...tc, thought_signature: recalled };
      });
      return callsChanged ? { ...msg, tool_calls: nextCalls } : msg;
    }

    if (targetFamily === 'claude') {
      const msgRecord = msg as unknown as Record<string, unknown>;
      if (
        (Array.isArray(msgRecord.thinking_blocks) && msgRecord.thinking_blocks.length > 0) ||
        Array.isArray(msgRecord._restoredClaudeSegments)
      ) {
        return msg;
      }
      const segments = restoreClaudeThinkingBlocks({
        toolUseIds: msg.tool_calls.map(tc => tc.id),
        provider: input.provider,
        model: input.modelId,
        connectionId: String(input.accountId),
      });
      if (!segments) return msg;
      return {
        ...msg,
        _restoredClaudeSegments: segments,
      } as ChatMessage;
    }

    return msg;
  });

  const nextOptions: CompletionOptions & { anthropicThinking?: Record<string, unknown> } = {
    ...input.options,
  };
  if (input.options.reasoning_effort !== undefined || input.rawThinking) {
    const normalized = normalizeThinkingBudget({
      effort: input.options.reasoning_effort,
      thinking: input.rawThinking,
      maxTokens: input.options.max_tokens,
      defaultMaxTokens: targetFamily === 'claude' ? 4096 : undefined,
      targetFamily: targetFamily ?? normalizedProvider,
    });
    if (
      normalized.maxTokens !== undefined &&
      (input.options.max_tokens !== undefined || targetFamily === 'claude')
    ) {
      nextOptions.max_tokens = normalized.maxTokens;
    }
    if (normalized.openaiReasoningEffort !== undefined && input.options.reasoning_effort !== undefined) {
      nextOptions.reasoning_effort = normalized.openaiReasoningEffort;
    }
    if (targetFamily === 'claude' && normalized.anthropicThinking) {
      nextOptions.anthropicThinking = normalized.anthropicThinking;
    }
  }

  return {
    messages: preparedMessages,
    options: nextOptions,
    strippedForeignBlocks: sanitized.strippedCount,
  };
}

export function captureGatewayThinkingResponse(args: {
  toolCalls?: readonly ChatToolCall[] | null;
  provider: string;
  modelId: string;
  accountId: number | string;
}): void {
  if (!args.toolCalls || args.toolCalls.length === 0) return;
  for (const tc of args.toolCalls) {
    if (!tc?.thought_signature) continue;
    storeGeminiThoughtSignature({
      accountId: args.accountId,
      model: args.modelId,
      provider: args.provider,
      toolCallId: tc.id,
      signature: tc.thought_signature,
      name: tc.function?.name,
      callArgs: tc.function?.arguments,
    });
  }
}
