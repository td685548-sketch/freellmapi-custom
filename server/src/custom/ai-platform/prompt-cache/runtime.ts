import type { Request, Response } from 'express';
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatContentBlock,
  ChatMessage,
  ChatToolDefinition,
} from '@freellmapi/shared/types.js';
import type { BaseProvider, CompletionOptions } from '../../../providers/base.js';
import type { QuotaObservationContext } from '../../../services/provider-quota.js';
import type { RouteResult } from '../../../services/router.js';
import { contentToString } from '../../../lib/content.js';
import { getClientContext } from '../../../lib/client-context.js';
import { isPillarEnabled } from '../flags.js';
import { applyCacheBreakpoints } from './breakpoints.js';
import { recordCacheUsage, type ExtractedCacheUsage } from './stats.js';

interface CapturedToolHint {
  index: number;
  name?: string;
  cacheControl: unknown;
}

interface CapturedBlockHint {
  type?: string;
  text: string;
  cacheControl?: unknown;
}

interface CapturedMessageHint {
  role: string;
  blocks: CapturedBlockHint[];
  fullText: string;
  joinedNewline: string;
  joinedDirect: string;
  messageCacheControl?: unknown;
}

interface CapturedCallerHints {
  tools: CapturedToolHint[];
  systemBlocks: CapturedBlockHint[] | null;
  systemJoiner: string;
  messages: CapturedMessageHint[];
}

export interface CacheTarget {
  platform: string;
  modelId: string;
}

interface PromptCacheRequestState {
  hints: CapturedCallerHints | null;
  target: CacheTarget | null;
  usage: ExtractedCacheUsage | null;
  hasInterceptor: boolean;
  recordedDirect: boolean;
}

const contextStates = new WeakMap<object, PromptCacheRequestState>();
const responseStates = new WeakMap<Response, PromptCacheRequestState>();

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonNegInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

function cloneCacheControl(value: unknown): unknown {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

function hasAnyCacheControlInBlocks(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((item) => {
    const rec = asRecord(item);
    return rec !== null && rec.cache_control !== undefined;
  });
}

function getStateForContext(): PromptCacheRequestState | null {
  const ctx = getClientContext();
  return contextStates.get(ctx) ?? null;
}

function getOrCreateStateForContext(): PromptCacheRequestState {
  const ctx = getClientContext();
  let state = contextStates.get(ctx);
  if (!state) {
    state = {
      hints: null,
      target: null,
      usage: null,
      hasInterceptor: false,
      recordedDirect: false,
    };
    contextStates.set(ctx, state);
  }
  return state;
}

function extractBlocksFromArray(items: unknown[]): CapturedBlockHint[] {
  const blocks: CapturedBlockHint[] = [];
  for (const item of items) {
    if (typeof item === 'string') {
      blocks.push({ type: 'text', text: item });
      continue;
    }
    const rec = asRecord(item);
    if (!rec) continue;
    const type = typeof rec.type === 'string' ? rec.type : undefined;
    const text = typeof rec.text === 'string' ? rec.text : '';
    const cacheControl = rec.cache_control;
    blocks.push({
      ...(type ? { type } : {}),
      text,
      ...(cacheControl !== undefined ? { cacheControl: cloneCacheControl(cacheControl) } : {}),
    });
  }
  return blocks;
}

function captureMessageListHints(items: unknown[], geminiMode = false): CapturedMessageHint[] {
  const hints: CapturedMessageHint[] = [];
  for (const rawItem of items) {
    const item = asRecord(rawItem);
    if (!item) continue;

    const rawRole = typeof item.role === 'string' ? item.role : undefined;
    if (!rawRole) continue;
    const role =
      rawRole === 'developer'
        ? 'system'
        : geminiMode && rawRole === 'model'
          ? 'assistant'
          : rawRole;

    const contentSource = geminiMode ? item.parts : item.content;
    const msgCc = item.cache_control;
    const hasBlockCc = hasAnyCacheControlInBlocks(contentSource);
    if (msgCc === undefined && !hasBlockCc) continue;

    const blocks = Array.isArray(contentSource) ? extractBlocksFromArray(contentSource) : [];
    const textValues = blocks.map((b) => b.text);
    const nonEmptyTexts = textValues.filter((t) => t.length > 0);
    const fullText =
      typeof contentSource === 'string'
        ? contentSource
        : contentToString(contentSource);

    hints.push({
      role,
      blocks,
      fullText,
      joinedNewline: nonEmptyTexts.join('\n'),
      joinedDirect: textValues.join(''),
      ...(msgCc !== undefined ? { messageCacheControl: cloneCacheControl(msgCc) } : {}),
    });
  }
  return hints;
}

/**
 * Captures caller `cache_control` hints from the raw inbound `req.body` into request-scoped
 * state so route adapters that flatten or strip extra fields (Anthropic, Responses, Zod tools)
 * do not lose caller breakpoints before `withPromptCacheRoute` invokes `applyCacheBreakpoints`.
 */
export function captureCallerCacheControl(req: Request): void {
  if (!isPillarEnabled('promptCache')) return;
  const body = asRecord(req.body);
  if (!body) return;

  const toolHints: CapturedToolHint[] = [];
  if (Array.isArray(body.tools)) {
    for (let i = 0; i < body.tools.length; i++) {
      const tool = asRecord(body.tools[i]);
      if (!tool) continue;
      const fn = asRecord(tool.function);
      const cc = tool.cache_control !== undefined ? tool.cache_control : fn?.cache_control;
      if (cc === undefined) continue;
      const name =
        typeof fn?.name === 'string'
          ? fn.name
          : typeof tool.name === 'string'
            ? tool.name
            : undefined;
      toolHints.push({
        index: i,
        ...(name ? { name } : {}),
        cacheControl: cloneCacheControl(cc),
      });
    }
  }

  let systemBlocks: CapturedBlockHint[] | null = null;
  let systemJoiner = '\n';
  if (Array.isArray(body.system) && hasAnyCacheControlInBlocks(body.system)) {
    systemBlocks = extractBlocksFromArray(body.system);
    systemJoiner = '\n';
  } else {
    const sysInst = asRecord(body.systemInstruction);
    if (sysInst && Array.isArray(sysInst.parts) && hasAnyCacheControlInBlocks(sysInst.parts)) {
      systemBlocks = extractBlocksFromArray(sysInst.parts);
      systemJoiner = '\n\n';
    }
  }

  let messageHints: CapturedMessageHint[] = [];
  if (Array.isArray(body.messages)) {
    messageHints = captureMessageListHints(body.messages, false);
  } else if (Array.isArray(body.input)) {
    messageHints = captureMessageListHints(body.input, false);
  } else if (Array.isArray(body.contents)) {
    messageHints = captureMessageListHints(body.contents, true);
  }

  const state = getOrCreateStateForContext();
  if (toolHints.length === 0 && !systemBlocks && messageHints.length === 0) {
    state.hints = null;
    return;
  }

  state.hints = {
    tools: toolHints,
    systemBlocks,
    systemJoiner,
    messages: messageHints,
  };
}

function buildRestoredBlocks(blocks: CapturedBlockHint[]): ChatContentBlock[] {
  return blocks
    .filter((b) => b.text.length > 0 || b.cacheControl !== undefined)
    .map((b) => ({
      type: 'text',
      text: b.text,
      ...(b.cacheControl !== undefined ? { cache_control: cloneCacheControl(b.cacheControl) } : {}),
    })) as ChatContentBlock[];
}

function restoreSystemBlocksIntoMessage(
  msg: ChatMessage,
  systemBlocks: CapturedBlockHint[],
  joiner: string,
): ChatMessage | null {
  if (msg.role !== 'system' || typeof msg.content !== 'string') return null;
  const nonEmpty = systemBlocks.filter((b) => b.text.length > 0);
  if (nonEmpty.length === 0) return null;

  const expected = nonEmpty.map((b) => b.text).join(joiner);
  if (msg.content === expected) {
    return {
      ...msg,
      content: buildRestoredBlocks(nonEmpty),
    };
  }

  // Handle single cached block that had extra system/knowledge text appended later
  if (nonEmpty.length === 1 && nonEmpty[0]!.cacheControl !== undefined && msg.content.startsWith(nonEmpty[0]!.text)) {
    const rest = msg.content.slice(nonEmpty[0]!.text.length).replace(/^\n+/, '');
    const restored: ChatContentBlock[] = [
      {
        type: 'text',
        text: nonEmpty[0]!.text,
        cache_control: cloneCacheControl(nonEmpty[0]!.cacheControl),
      } as ChatContentBlock,
    ];
    if (rest.length > 0) {
      restored.push({ type: 'text', text: rest });
    }
    return {
      ...msg,
      content: restored,
    };
  }

  return null;
}

function restoreHintIntoMessage(msg: ChatMessage, hint: CapturedMessageHint): ChatMessage | null {
  if (hasAnyCacheControlInBlocks(msg.content)) return null;

  if (typeof msg.content === 'string') {
    if (
      hint.blocks.length > 0 &&
      (msg.content === hint.joinedNewline || msg.content === hint.joinedDirect)
    ) {
      return {
        ...msg,
        content: buildRestoredBlocks(hint.blocks),
      };
    }
    if (hint.messageCacheControl !== undefined && msg.content === hint.fullText) {
      return {
        ...msg,
        content: [
          {
            type: 'text',
            text: msg.content,
            cache_control: cloneCacheControl(hint.messageCacheControl),
          } as ChatContentBlock,
        ],
      };
    }
    return null;
  }

  if (Array.isArray(msg.content)) {
    const msgText = contentToString(msg.content);
    if (msgText !== hint.joinedNewline && msgText !== hint.joinedDirect && msgText !== hint.fullText) {
      return null;
    }

    const clonedBlocks = msg.content.map((b) => (b && typeof b === 'object' ? { ...b } : b));
    let matchedAny = false;
    for (const blockHint of hint.blocks) {
      if (blockHint.cacheControl === undefined) continue;
      for (const blk of clonedBlocks) {
        const rec = asRecord(blk);
        if (!rec || rec.cache_control !== undefined) continue;
        if (typeof rec.text === 'string' && rec.text === blockHint.text) {
          rec.cache_control = cloneCacheControl(blockHint.cacheControl);
          matchedAny = true;
          break;
        }
      }
    }

    if (!matchedAny && hint.messageCacheControl !== undefined) {
      for (let i = clonedBlocks.length - 1; i >= 0; i--) {
        const rec = asRecord(clonedBlocks[i]);
        if (rec) {
          rec.cache_control = cloneCacheControl(hint.messageCacheControl);
          matchedAny = true;
          break;
        }
      }
    }

    return matchedAny ? { ...msg, content: clonedBlocks as ChatContentBlock[] } : null;
  }

  return null;
}

function restoreCallerCacheControl(
  messages: ChatMessage[],
  tools: ChatToolDefinition[] | undefined,
  hints: CapturedCallerHints | null,
): { messages: ChatMessage[]; tools: ChatToolDefinition[] | undefined } {
  if (!hints) {
    return { messages, tools };
  }

  let nextMessages = messages;
  let messagesCloned = false;
  const ensureMessagesCloned = () => {
    if (!messagesCloned) {
      nextMessages = [...messages];
      messagesCloned = true;
    }
  };

  if (hints.systemBlocks) {
    for (let i = 0; i < nextMessages.length; i++) {
      const msg = nextMessages[i];
      if (!msg || msg.role !== 'system') continue;
      if (hasAnyCacheControlInBlocks(msg.content)) break;
      const updated = restoreSystemBlocksIntoMessage(msg, hints.systemBlocks, hints.systemJoiner);
      if (updated) {
        ensureMessagesCloned();
        nextMessages[i] = updated;
        break;
      }
    }
  }

  if (hints.messages.length > 0) {
    const consumedHints = new Set<number>();
    for (let i = 0; i < nextMessages.length; i++) {
      const msg = nextMessages[i];
      if (!msg) continue;
      for (let hIdx = 0; hIdx < hints.messages.length; hIdx++) {
        if (consumedHints.has(hIdx)) continue;
        const hint = hints.messages[hIdx]!;
        if (hint.role !== msg.role) continue;
        const updated = restoreHintIntoMessage(msg, hint);
        if (updated) {
          ensureMessagesCloned();
          nextMessages[i] = updated;
          consumedHints.add(hIdx);
          break;
        }
      }
    }
  }

  let nextTools = tools;
  if (Array.isArray(tools) && tools.length > 0 && hints.tools.length > 0) {
    let toolsCloned = false;
    const ensureToolsCloned = () => {
      if (!toolsCloned) {
        nextTools = [...tools];
        toolsCloned = true;
      }
    };

    for (const hint of hints.tools) {
      let targetIdx = -1;
      if (hint.name) {
        targetIdx = tools.findIndex((t, idx) => {
          const rec = asRecord(t);
          const fn = asRecord(rec?.function);
          const tName = typeof fn?.name === 'string' ? fn.name : typeof rec?.name === 'string' ? rec.name : undefined;
          return tName === hint.name && idx >= 0;
        });
      }
      if (targetIdx < 0 && hint.index >= 0 && hint.index < tools.length) {
        targetIdx = hint.index;
      }
      if (targetIdx < 0) continue;

      const currentTool = nextTools![targetIdx];
      const rec = asRecord(currentTool);
      if (!rec || rec.cache_control !== undefined) continue;
      ensureToolsCloned();
      nextTools![targetIdx] = {
        ...rec,
        cache_control: cloneCacheControl(hint.cacheControl),
      } as unknown as ChatToolDefinition;
    }
  }

  return { messages: nextMessages, tools: nextTools };
}

function prepareOutboundInputs(
  messages: ChatMessage[],
  options: CompletionOptions | undefined,
  target: CacheTarget,
  hints: CapturedCallerHints | null,
): { messages: ChatMessage[]; options: CompletionOptions | undefined } {
  try {
    const restored = restoreCallerCacheControl(messages, options?.tools, hints);
    const applied = applyCacheBreakpoints(restored.messages, restored.tools, target);
    let nextOptions = options;
    if (applied.tools !== options?.tools) {
      nextOptions = {
        ...options,
        tools: applied.tools as ChatToolDefinition[] | undefined,
      };
    }
    return { messages: applied.messages, options: nextOptions };
  } catch {
    return { messages, options };
  }
}

/**
 * Extracts token and cache read/write counts from a provider's ChatCompletionResponse
 * or ChatCompletionChunk `usage` object across OpenAI, Anthropic, Responses, and Gemini shapes.
 */
export function extractProviderCacheUsage(usage: unknown): ExtractedCacheUsage | null {
  const u = asRecord(usage);
  if (!u) return null;

  const promptTokens = nonNegInt(u.prompt_tokens);
  const inputTokensField = nonNegInt(u.input_tokens);
  const promptTokenCount = nonNegInt(u.promptTokenCount);

  const promptDetails = asRecord(u.prompt_tokens_details);
  const inputDetails = asRecord(u.input_tokens_details);
  const cachedTokens =
    nonNegInt(promptDetails?.cached_tokens) ?? nonNegInt(inputDetails?.cached_tokens);
  const cacheReadInputTokens = nonNegInt(u.cache_read_input_tokens);
  const cacheCreationInputTokens = nonNegInt(u.cache_creation_input_tokens);
  const cachedContentTokenCount = nonNegInt(u.cachedContentTokenCount);

  if (
    promptTokens === undefined &&
    inputTokensField === undefined &&
    promptTokenCount === undefined &&
    cachedTokens === undefined &&
    cacheReadInputTokens === undefined &&
    cacheCreationInputTokens === undefined &&
    cachedContentTokenCount === undefined
  ) {
    return null;
  }

  const cacheReadTokens =
    cacheReadInputTokens ?? cachedTokens ?? cachedContentTokenCount ?? 0;
  const cacheWriteTokens = cacheCreationInputTokens ?? 0;

  let inputTokens: number;
  if (cacheReadInputTokens !== undefined || cacheCreationInputTokens !== undefined) {
    if (inputTokensField !== undefined) {
      inputTokens = inputTokensField + cacheReadTokens + cacheWriteTokens;
    } else if (promptTokens !== undefined) {
      inputTokens = Math.max(promptTokens, cacheReadTokens + cacheWriteTokens);
    } else {
      inputTokens = cacheReadTokens + cacheWriteTokens;
    }
  } else if (promptTokens !== undefined) {
    inputTokens = Math.max(promptTokens, cacheReadTokens + cacheWriteTokens);
  } else if (inputTokensField !== undefined) {
    inputTokens = Math.max(inputTokensField, cacheReadTokens + cacheWriteTokens);
  } else if (promptTokenCount !== undefined) {
    inputTokens = Math.max(promptTokenCount, cacheReadTokens + cacheWriteTokens);
  } else {
    inputTokens = cacheReadTokens + cacheWriteTokens;
  }

  return {
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  };
}

function recordDirectUsageIfUnintercepted(
  state: PromptCacheRequestState,
  target: CacheTarget,
  extracted: ExtractedCacheUsage,
): void {
  if (state.hasInterceptor || state.recordedDirect) return;
  state.recordedDirect = true;
  const ctx = getClientContext();
  try {
    recordCacheUsage({
      profileId: ctx.profileId ?? 0,
      platform: target.platform,
      model: target.modelId,
      inputTokens: extracted.inputTokens,
      cacheReadTokens: extracted.cacheReadTokens,
      cacheWriteTokens: extracted.cacheWriteTokens,
    });
  } catch {
    // Telemetry writes must never break an inference response.
  }
}

/**
 * Links `res` to the current request's prompt-cache state and marks that the
 * interceptor-based `cacheUsageFilter` is active so direct recording is skipped.
 */
export function markPromptCacheInterceptorInstalled(res: Response): void {
  if (!isPillarEnabled('promptCache')) return;
  const state = getOrCreateStateForContext();
  state.hasInterceptor = true;
  responseStates.set(res, state);
}

/**
 * Returns the active `{ platform, modelId }` for the current request (or `res`),
 * updated on every fallback attempt.
 */
export function getActiveCacheTargetForRequest(res?: Response): CacheTarget | null {
  const state = (res ? responseStates.get(res) : undefined) ?? getStateForContext();
  return state?.target ?? null;
}

/**
 * Returns the upstream cache token usage captured from the active provider attempt
 * (preserving cache read/write fields even if a route adapter strips them from the client payload).
 */
export function getCapturedCacheUsageForRequest(res?: Response): ExtractedCacheUsage | null {
  const state = (res ? responseStates.get(res) : undefined) ?? getStateForContext();
  return state?.usage ?? null;
}

/**
 * Wraps a `RouteResult` per attempt in `fallback-loop.ts` to normalize `cache_control`
 * breakpoints for the destination provider/model and capture upstream cache usage.
 * Returns `route` with exact identity when the `promptCache` pillar is disabled.
 */
export function withPromptCacheRoute(route: RouteResult): RouteResult {
  if (!isPillarEnabled('promptCache')) {
    return route;
  }

  const baseProvider = route.provider;
  const wrappedProvider = Object.create(baseProvider) as BaseProvider;

  wrappedProvider.chatCompletion = async (
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
    quotaContext?: QuotaObservationContext,
  ): Promise<ChatCompletionResponse> => {
    const target: CacheTarget = {
      platform: route.platform,
      modelId: modelId || route.modelId,
    };
    const state = getOrCreateStateForContext();
    state.target = target;

    const { messages: nextMessages, options: nextOptions } = prepareOutboundInputs(
      messages,
      options,
      target,
      state.hints,
    );

    const response = await baseProvider.chatCompletion(
      apiKey,
      nextMessages,
      modelId,
      nextOptions,
      quotaContext,
    );

    const extracted = extractProviderCacheUsage(response?.usage);
    if (extracted) {
      state.usage = extracted;
      recordDirectUsageIfUnintercepted(state, target, extracted);
    }

    return response;
  };

  wrappedProvider.streamChatCompletion = async function* (
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
    quotaContext?: QuotaObservationContext,
  ): AsyncGenerator<ChatCompletionChunk> {
    const target: CacheTarget = {
      platform: route.platform,
      modelId: modelId || route.modelId,
    };
    const state = getOrCreateStateForContext();
    state.target = target;

    const { messages: nextMessages, options: nextOptions } = prepareOutboundInputs(
      messages,
      options,
      target,
      state.hints,
    );

    let lastUsage: ExtractedCacheUsage | null = null;
    try {
      for await (const chunk of baseProvider.streamChatCompletion(
        apiKey,
        nextMessages,
        modelId,
        nextOptions,
        quotaContext,
      )) {
        const extracted = extractProviderCacheUsage((chunk as { usage?: unknown })?.usage);
        if (extracted) {
          lastUsage = extracted;
          state.usage = extracted;
        }
        yield chunk;
      }
    } finally {
      if (lastUsage) {
        recordDirectUsageIfUnintercepted(state, target, lastUsage);
      }
    }
  };

  return {
    ...route,
    provider: wrappedProvider,
  };
}
