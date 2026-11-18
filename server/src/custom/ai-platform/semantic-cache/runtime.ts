import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import {
  SEMANTIC_CACHE_HEADER_NAME,
  SEMANTIC_CACHE_LIMITS,
  SEMANTIC_CACHE_SCORE_HEADER_NAME,
  type Scope,
  type SemanticCacheLookupPreviewRequest,
  type SemanticCacheLookupPreviewResponse,
  type Wire,
} from '@freellmapi/shared/ai-platform-semantic-cache.js';
import { isInternalCall } from '../loopback.js';
import { detectWire } from '../wire/detect.js';
import { requestedModel } from '../wire/extract.js';
import { installInterceptor, type OutputFilter, type OutputFilterContext } from '../wire/interceptor.js';
import { sendText, type Usage } from '../wire/respond.js';
import {
  evaluateRequestContract,
  extractLanguageFromExpressHeaders,
  isTruncatedCompletion,
  responseCarriesToolCalls,
} from './contract.js';
import {
  assertSemanticCacheScopeExists,
  getSemanticCacheSettingsInternal,
  lookupSemanticCache,
  storeSemanticCacheEntry,
} from './store.js';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonNegInt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

export function extractAssistantTextFromResponse(
  wire: Wire,
  body: Record<string, unknown>,
): string {
  if (wire === 'openai-chat') {
    const choices = Array.isArray(body.choices) ? body.choices : [];
    const parts: string[] = [];
    for (const c of choices) {
      const msg = asRecord(asRecord(c)?.message);
      if (msg && typeof msg.content === 'string') {
        parts.push(msg.content);
      }
    }
    return parts.join('');
  }

  if (wire === 'anthropic') {
    const content = Array.isArray(body.content) ? body.content : [];
    const parts: string[] = [];
    for (const blk of content) {
      const b = asRecord(blk);
      if (b?.type === 'text' && typeof b.text === 'string') {
        parts.push(b.text);
      }
    }
    return parts.join('');
  }

  if (wire === 'responses') {
    if (typeof body.output_text === 'string' && body.output_text.length > 0) {
      return body.output_text;
    }
    const output = Array.isArray(body.output) ? body.output : [];
    const parts: string[] = [];
    for (const item of output) {
      const it = asRecord(item);
      if (it?.type === 'message' && Array.isArray(it.content)) {
        for (const c of it.content) {
          const part = asRecord(c);
          if (
            part &&
            (part.type === 'output_text' || part.type === 'text') &&
            typeof part.text === 'string'
          ) {
            parts.push(part.text);
          }
        }
      }
    }
    return parts.join('');
  }

  // gemini
  const candidates = Array.isArray(body.candidates) ? body.candidates : [];
  const parts: string[] = [];
  for (const cand of candidates) {
    const content = asRecord(asRecord(cand)?.content);
    const candParts = content && Array.isArray(content.parts) ? content.parts : [];
    for (const p of candParts) {
      const part = asRecord(p);
      if (part && part.thought !== true && typeof part.text === 'string') {
        parts.push(part.text);
      }
    }
  }
  return parts.join('');
}

export function extractUsageFromResponseBody(
  wire: Wire,
  body: Record<string, unknown>,
): Usage | undefined {
  if (wire === 'openai-chat') {
    const u = asRecord(body.usage);
    if (!u) return undefined;
    const promptTokens = nonNegInt(u.prompt_tokens);
    const completionTokens = nonNegInt(u.completion_tokens);
    const totalTokens = nonNegInt(u.total_tokens) || promptTokens + completionTokens;
    return {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
    };
  }

  if (wire === 'anthropic') {
    const u = asRecord(body.usage) ?? asRecord(asRecord(body.message)?.usage);
    if (!u) return undefined;
    const promptTokens = nonNegInt(u.input_tokens);
    const completionTokens = nonNegInt(u.output_tokens);
    return {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    };
  }

  if (wire === 'responses') {
    const u = asRecord(body.usage) ?? asRecord(asRecord(body.response)?.usage);
    if (!u) return undefined;
    const promptTokens = nonNegInt(u.input_tokens);
    const completionTokens = nonNegInt(u.output_tokens);
    const totalTokens = nonNegInt(u.total_tokens) || promptTokens + completionTokens;
    return {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
    };
  }

  // gemini
  const u = asRecord(body.usageMetadata);
  if (!u) return undefined;
  const promptTokens = nonNegInt(u.promptTokenCount);
  const completionTokens = nonNegInt(u.candidatesTokenCount);
  const totalTokens = nonNegInt(u.totalTokenCount) || promptTokens + completionTokens;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
  };
}

function extractUsageObject(wire: Wire, rawUsage: unknown): Usage | undefined {
  const u = asRecord(rawUsage);
  if (!u) return undefined;
  if (wire === 'openai-chat') {
    return extractUsageFromResponseBody(wire, { usage: u });
  }
  if (wire === 'anthropic') {
    return extractUsageFromResponseBody(wire, { usage: u });
  }
  if (wire === 'responses') {
    return extractUsageFromResponseBody(wire, { usage: u });
  }
  return extractUsageFromResponseBody(wire, { usageMetadata: u });
}

function estimateTotalTokens(
  queryChars: number,
  outputChars: number,
  usage?: Usage,
): number {
  if (usage && (usage.total_tokens ?? 0) > 0) {
    return usage.total_tokens!;
  }
  const promptEst = usage?.prompt_tokens || Math.max(1, Math.ceil(queryChars / 4));
  const compEst = usage?.completion_tokens || Math.max(1, Math.ceil(outputChars / 4));
  return promptEst + compEst;
}

function buildCanonicalWireResponse(
  wire: Wire,
  text: string,
  model: string,
  usage?: Usage,
): Record<string, unknown> {
  const promptTokens = usage?.prompt_tokens ?? 0;
  const completionTokens = usage?.completion_tokens ?? Math.max(1, Math.ceil(text.length / 4));
  const totalTokens = usage?.total_tokens ?? promptTokens + completionTokens;
  const created = Math.floor(Date.now() / 1000);
  const suffix = crypto.randomBytes(10).toString('hex');

  if (wire === 'openai-chat') {
    return {
      id: `chatcmpl-semcache-${suffix}`,
      object: 'chat.completion',
      created,
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: text },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
      },
    };
  }

  if (wire === 'anthropic') {
    return {
      id: `msg_semcache_${suffix}`,
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: promptTokens,
        output_tokens: completionTokens,
      },
    };
  }

  if (wire === 'responses') {
    const msgId = `msg_semcache_${suffix}`;
    return {
      id: `resp_semcache_${suffix}`,
      object: 'response',
      created_at: created,
      status: 'completed',
      model,
      output: [
        {
          type: 'message',
          id: msgId,
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text, annotations: [] }],
        },
      ],
      output_text: text,
      usage: {
        input_tokens: promptTokens,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: completionTokens,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: totalTokens,
      },
    };
  }

  return {
    candidates: [
      {
        content: { role: 'model', parts: [{ text }] },
        finishReason: 'STOP',
        index: 0,
      },
    ],
    usageMetadata: {
      promptTokenCount: promptTokens,
      candidatesTokenCount: completionTokens,
      totalTokenCount: totalTokens,
    },
    modelVersion: model,
  };
}

function extractModelFromResponse(
  wire: Wire,
  body: Record<string, unknown>,
  fallbackModel: string,
): string {
  if (wire === 'gemini') {
    return typeof body.modelVersion === 'string' && body.modelVersion
      ? body.modelVersion
      : fallbackModel;
  }
  return typeof body.model === 'string' && body.model ? body.model : fallbackModel;
}

function replayCachedResponse(
  res: Response,
  wire: Wire,
  stream: boolean,
  cachedBody: Record<string, unknown>,
  fallbackModel: string,
): void {
  if (!stream) {
    res.status(200).json(structuredClone(cachedBody));
    return;
  }

  const text = extractAssistantTextFromResponse(wire, cachedBody);
  const model = extractModelFromResponse(wire, cachedBody, fallbackModel);
  const usage = extractUsageFromResponseBody(wire, cachedBody);
  sendText(res, wire, true, text, {
    model,
    finish: 'stop',
    usage,
  });
}

function attachPassiveStreamInspector(
  res: Response,
  onDisqualify: () => void,
): void {
  const origWrite = res.write.bind(res);
  let tail = '';
  res.write = ((
    chunk: unknown,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean => {
    try {
      const str =
        typeof chunk === 'string'
          ? chunk
          : Buffer.isBuffer(chunk)
            ? chunk.toString('utf8')
            : chunk instanceof Uint8Array
              ? Buffer.from(chunk).toString('utf8')
              : '';
      if (str) {
        const combined = tail + str;
        const lines = combined.split(/\r?\n/);
        tail = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          const parsed = asRecord(JSON.parse(payload));
          if (!parsed) continue;
          if (responseCarriesToolCalls(parsed) || isTruncatedCompletion(parsed)) {
            onDisqualify();
          }
          // Anthropic streaming tool_use block start
          if (
            parsed.type === 'content_block_start' &&
            asRecord(parsed.content_block)?.type === 'tool_use'
          ) {
            onDisqualify();
          }
          // Anthropic message_delta stop_reason
          if (parsed.type === 'message_delta') {
            const stopReason = asRecord(parsed.delta)?.stop_reason;
            if (stopReason === 'tool_use' || stopReason === 'max_tokens') {
              onDisqualify();
            }
          }
          // Responses API streaming function_call item or incomplete event
          if (
            parsed.type === 'response.incomplete' ||
            (parsed.type === 'response.output_item.added' &&
              (asRecord(parsed.item)?.type === 'function_call' ||
                asRecord(parsed.item)?.type === 'custom_tool_call'))
          ) {
            onDisqualify();
          }
        }
      }
    } catch {
      // Passive inspection never interferes with stream writes
    }
    return origWrite(chunk as string, encodingOrCb as BufferEncoding, cb);
  }) as Response['write'];
}

/**
 * Executes pre-request semantic cache lookup and, on MISS, installs post-response
 * capture on `res`. Returns `'handled'` when answered directly from cache.
 */
export async function runSemanticCachePreRequest(
  req: Request,
  res: Response,
  scope: Scope,
  endUser: string | null,
): Promise<'continue' | 'handled'> {
  if (isInternalCall(req) !== null) return 'continue';

  const settings = getSemanticCacheSettingsInternal(scope);
  if (!settings.enabled) return 'continue';

  const detected = detectWire(req);
  if (!detected) return 'continue';

  const model = requestedModel(detected.wire, req);
  const language = extractLanguageFromExpressHeaders(req);
  const contract = evaluateRequestContract({
    scope,
    wire: detected.wire,
    model,
    body: req.body,
    headers: req.headers,
    endUser,
    settings,
    language,
  });

  const ac = new AbortController();
  const cleanupAbort = () => {
    res.off('close', onClose);
    res.off('finish', cleanupAbort);
  };
  const onClose = () => {
    if (!res.writableFinished) ac.abort();
    cleanupAbort();
  };
  res.once('close', onClose);
  res.once('finish', cleanupAbort);

  let outcome: Awaited<ReturnType<typeof lookupSemanticCache>>;
  try {
    outcome = await lookupSemanticCache(contract, settings, {
      recordMetrics: true,
      signal: ac.signal,
    });
  } finally {
    cleanupAbort();
  }

  if (res.headersSent) return 'continue';

  if (outcome.status === 'BYPASSED') {
    res.setHeader(SEMANTIC_CACHE_HEADER_NAME, 'BYPASSED');
    return 'continue';
  }

  if (
    (outcome.status === 'EXACT_HIT' || outcome.status === 'SEMANTIC_HIT') &&
    outcome.response
  ) {
    res.setHeader(SEMANTIC_CACHE_HEADER_NAME, outcome.status);
    if (outcome.status === 'SEMANTIC_HIT' && outcome.score !== null) {
      res.setHeader(SEMANTIC_CACHE_SCORE_HEADER_NAME, outcome.score.toFixed(4));
    }
    replayCachedResponse(res, detected.wire, detected.stream, outcome.response, contract.model);
    return 'handled';
  }

  // MISS: set header and install post-response capture filter
  res.setHeader(SEMANTIC_CACHE_HEADER_NAME, 'MISS');

  let stored = false;
  let streamDisqualified = false;
  let streamedText = '';
  let capturedUsage: Usage | undefined;

  if (detected.stream) {
    attachPassiveStreamInspector(res, () => {
      streamDisqualified = true;
    });
  }

  const captureFilter: OutputFilter = {
    name: 'semantic-cache-capture',
    onUsage(usage: unknown) {
      const extracted = extractUsageObject(detected.wire, usage);
      if (extracted) {
        capturedUsage = {
          prompt_tokens: Math.max(capturedUsage?.prompt_tokens ?? 0, extracted.prompt_tokens ?? 0),
          completion_tokens: Math.max(
            capturedUsage?.completion_tokens ?? 0,
            extracted.completion_tokens ?? 0,
          ),
          total_tokens: Math.max(capturedUsage?.total_tokens ?? 0, extracted.total_tokens ?? 0),
        };
      }
    },
    onDelta(text: string) {
      if (
        !streamDisqualified &&
        Buffer.byteLength(streamedText, 'utf8') + Buffer.byteLength(text, 'utf8') <=
          SEMANTIC_CACHE_LIMITS.maxDbEntryBytes
      ) {
        streamedText += text;
      } else {
        streamDisqualified = true;
      }
      return { emit: text };
    },
    onResponseObject(body: Record<string, unknown>, ctx: OutputFilterContext) {
      if (stored) return;
      if (res.statusCode < 200 || res.statusCode >= 300) return;
      if (ctx.blocked || ctx.action === 'blocked' || ctx.action === 'masked') return;
      if (body.error !== undefined) return;
      if (responseCarriesToolCalls(body) || isTruncatedCompletion(body)) return;

      const assistantText = extractAssistantTextFromResponse(detected.wire, body);
      if (!assistantText) return;

      const usage = extractUsageFromResponseBody(detected.wire, body) ?? capturedUsage;
      const tokensSaved = estimateTotalTokens(
        contract.queryText.length,
        assistantText.length,
        usage,
      );

      stored = true;
      storeSemanticCacheEntry({
        contract,
        settings,
        response: body,
        tokensSaved,
        queryVector: outcome.queryVector,
        embeddingModel: outcome.embeddingModel,
        embeddingDims: outcome.embeddingDims,
      });
    },
    onBeforeTerminal() {
      if (!stored && !streamDisqualified && streamedText.length > 0) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          const assembled = buildCanonicalWireResponse(
            detected.wire,
            streamedText,
            contract.model,
            capturedUsage,
          );
          const tokensSaved = estimateTotalTokens(
            contract.queryText.length,
            streamedText.length,
            capturedUsage,
          );
          stored = true;
          storeSemanticCacheEntry({
            contract,
            settings,
            response: assembled,
            tokensSaved,
            queryVector: outcome.queryVector,
            embeddingModel: outcome.embeddingModel,
            embeddingDims: outcome.embeddingDims,
          });
        }
      }
      return { emit: '' };
    },
  };

  installInterceptor(req, res, detected.wire, [captureFilter]);
  return 'continue';
}

function makePreviewText(text: string, maxChars = 400): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, maxChars - 1).trimEnd()}…`;
}

/**
 * Executes a non-mutating cache lookup preview for the Admin UI / diagnostic endpoint.
 */
export async function runSemanticCacheLookupPreview(
  scope: Scope,
  input: SemanticCacheLookupPreviewRequest,
  signal?: AbortSignal,
): Promise<SemanticCacheLookupPreviewResponse> {
  const startedAt = Date.now();
  const norm = assertSemanticCacheScopeExists(scope);
  const settings = getSemanticCacheSettingsInternal(norm);
  const wire: Wire = input.wire ?? 'openai-chat';
  const model = input.model ?? 'auto';

  const messages =
    input.messages && input.messages.length > 0
      ? input.messages
      : [{ role: 'user', content: input.query ?? '' }];

  const simulatedBody: Record<string, unknown> = {};
  if (wire === 'openai-chat' || wire === 'anthropic') {
    simulatedBody.model = model;
    simulatedBody.messages = messages;
  } else if (wire === 'responses') {
    simulatedBody.model = model;
    simulatedBody.input = messages.map((m) => ({
      type: 'message',
      role: m.role,
      content: m.content,
    }));
  } else {
    simulatedBody.contents = messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : m.role,
      parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
    }));
  }

  if (input.temperature !== undefined) simulatedBody.temperature = input.temperature;
  if (input.tools !== undefined) simulatedBody.tools = input.tools;
  if (input.tool_choice !== undefined) simulatedBody.tool_choice = input.tool_choice;
  if (input.response_format !== undefined) simulatedBody.response_format = input.response_format;
  if (input.reasoning_effort !== undefined) simulatedBody.reasoning_effort = input.reasoning_effort;
  if (input.thinking !== undefined) simulatedBody.thinking = input.thinking;
  if (input.seed !== undefined) simulatedBody.seed = input.seed;
  if (input.max_tokens !== undefined) simulatedBody.max_tokens = input.max_tokens;
  if (input.stop !== undefined) simulatedBody.stop = input.stop;
  if (input.modalities !== undefined) simulatedBody.modalities = input.modalities;

  const headers: Record<string, string> = {};
  if (input.cacheHeader) headers['x-freellm-cache'] = input.cacheHeader;
  if (input.cacheControl) headers['cache-control'] = input.cacheControl;
  if (input.vars && Object.keys(input.vars).length > 0) {
    headers['x-freellm-vars'] = JSON.stringify(input.vars);
  }

  const contract = evaluateRequestContract({
    scope: norm,
    wire,
    model,
    body: simulatedBody,
    headers,
    endUser: input.endUser ?? null,
    settings,
  });

  const outcome = await lookupSemanticCache(contract, settings, {
    recordMetrics: false,
    signal,
  });

  const previewText = outcome.response
    ? makePreviewText(extractAssistantTextFromResponse(wire, outcome.response))
    : null;

  return {
    scope: norm,
    status: outcome.status,
    ...(outcome.bypassReason ? { bypassReason: outcome.bypassReason } : {}),
    score: outcome.score,
    contractHash: contract.contractHash,
    promptVersionHash: contract.promptVersionHash,
    exactHash: contract.exactHash,
    semanticAvailable: outcome.semanticAvailable,
    latencyMs: Math.max(0, Date.now() - startedAt),
    matchedEntry: outcome.matchedEntry,
    cachedResponsePreview: previewText,
  };
}
