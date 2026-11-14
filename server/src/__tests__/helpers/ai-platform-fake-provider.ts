import http from 'node:http';

export type FakeProviderWire = 'openai-chat' | 'anthropic' | 'responses' | 'gemini';

export interface FakeProviderRecordedRequest {
  method: string;
  url: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  rawBody: Buffer;
  bodyText: string;
  bodyJson: unknown;
  aborted: boolean;
  receivedAt: number;
}

export interface FakeProviderUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  cacheCreationTokens?: number;
  reasoningTokens?: number;
}

export interface FakeProviderToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface FakeProviderStreamChunk {
  /** Raw bytes or string written to the HTTP response stream. */
  data: string | Buffer;
  /** Optional delay in ms before writing this chunk. */
  delayMs?: number;
}

export interface FakeProviderRawReply {
  kind: 'raw';
  status?: number;
  headers?: Record<string, string>;
  body?: string | Buffer | Record<string, unknown>;
}

export interface FakeProviderStreamReply {
  kind: 'stream';
  status?: number;
  headers?: Record<string, string>;
  chunks: FakeProviderStreamChunk[];
  /** If set, destroy the socket after emitting this many chunks (simulates mid-stream drop). */
  destroyAfterChunks?: number;
  /** If set, wait this many ms before closing the response (or until client disconnects). */
  hangMs?: number;
}

export interface FakeProviderErrorReply {
  kind: 'error';
  wire?: FakeProviderWire;
  status: number;
  message: string;
  type?: string;
  code?: string;
  headers?: Record<string, string>;
}

export interface FakeProviderScriptedReply {
  kind: 'scripted';
  wire?: FakeProviderWire;
  stream?: boolean;
  /** Gemini :streamGenerateContent uses SSE when ?alt=sse, otherwise JSON array. */
  geminiAltSse?: boolean;
  status?: number;
  headers?: Record<string, string>;
  model?: string;
  text?: string;
  /** Optional text chunks for SSE streaming; if omitted, `text` is sent as a single delta. */
  textChunks?: string[];
  chunkDelayMs?: number;
  toolCalls?: FakeProviderToolCall[];
  finishReason?: 'stop' | 'length' | 'content_filter' | 'tool_calls';
  usage?: FakeProviderUsage;
}

export type FakeProviderReply =
  | FakeProviderRawReply
  | FakeProviderStreamReply
  | FakeProviderErrorReply
  | FakeProviderScriptedReply;

export type FakeProviderHandler = (
  req: FakeProviderRecordedRequest,
) => FakeProviderReply | Promise<FakeProviderReply>;

export interface FakeProviderServer {
  readonly url: string;
  readonly port: number;
  readonly requests: FakeProviderRecordedRequest[];
  enqueue(...replies: FakeProviderReply[]): void;
  setDefaultReply(reply: FakeProviderReply | FakeProviderHandler | null): void;
  clearRequests(): void;
  reset(): void;
  close(): Promise<void>;
}

export function detectFakeProviderWire(path: string): { wire: FakeProviderWire; streamFromPath?: boolean } | null {
  const clean = path.replace(/\/+$/, '');
  if (clean.endsWith('/chat/completions')) return { wire: 'openai-chat' };
  if (clean.endsWith('/messages')) return { wire: 'anthropic' };
  if (clean.endsWith('/responses')) return { wire: 'responses' };
  if (/\/models\/[^/]+:streamGenerateContent$/i.test(clean)) return { wire: 'gemini', streamFromPath: true };
  if (/\/models\/[^/]+:generateContent$/i.test(clean)) return { wire: 'gemini', streamFromPath: false };
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function resolveWireAndStream(
  req: FakeProviderRecordedRequest,
  reply: FakeProviderScriptedReply,
): { wire: FakeProviderWire; stream: boolean; geminiAltSse: boolean } {
  const detected = detectFakeProviderWire(req.path);
  const wire: FakeProviderWire = reply.wire ?? detected?.wire ?? 'openai-chat';
  const body = asRecord(req.bodyJson);
  const bodyStream = body?.stream === true;
  const stream = reply.stream ?? detected?.streamFromPath ?? bodyStream;
  const geminiAltSse = reply.geminiAltSse ?? req.query.alt?.toLowerCase() === 'sse';
  return { wire, stream, geminiAltSse };
}

function buildErrorBody(reply: FakeProviderErrorReply): Record<string, unknown> {
  if (reply.wire === 'anthropic') {
    return {
      type: 'error',
      error: {
        type: reply.type ?? 'api_error',
        message: reply.message,
      },
    };
  }
  if (reply.wire === 'gemini') {
    return {
      error: {
        code: reply.status,
        message: reply.message,
        status: reply.code ?? 'INTERNAL',
      },
    };
  }
  return {
    error: {
      message: reply.message,
      type: reply.type ?? 'api_error',
      ...(reply.code ? { code: reply.code } : {}),
    },
  };
}

function normalizeUsage(usage?: FakeProviderUsage): Required<FakeProviderUsage> {
  const promptTokens = usage?.promptTokens ?? 10;
  const completionTokens = usage?.completionTokens ?? 5;
  const totalTokens = usage?.totalTokens ?? promptTokens + completionTokens;
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cachedTokens: usage?.cachedTokens ?? 0,
    cacheCreationTokens: usage?.cacheCreationTokens ?? 0,
    reasoningTokens: usage?.reasoningTokens ?? 0,
  };
}

function mapAnthropicStopReason(
  finishReason: FakeProviderScriptedReply['finishReason'],
  hasTools: boolean,
): string {
  if (hasTools || finishReason === 'tool_calls') return 'tool_use';
  if (finishReason === 'length') return 'max_tokens';
  if (finishReason === 'content_filter') return 'refusal';
  return 'end_turn';
}

function mapGeminiFinishReason(
  finishReason: FakeProviderScriptedReply['finishReason'],
  hasTools: boolean,
): string {
  if (hasTools || finishReason === 'tool_calls') return 'STOP';
  if (finishReason === 'length') return 'MAX_TOKENS';
  if (finishReason === 'content_filter') return 'SAFETY';
  return 'STOP';
}

function buildOpenAIChatNonStream(reply: FakeProviderScriptedReply): Record<string, unknown> {
  const usage = normalizeUsage(reply.usage);
  const toolCalls = reply.toolCalls ?? [];
  const finishReason = reply.finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop');
  return {
    id: 'chatcmpl-fake-1',
    object: 'chat.completion',
    created: 1_700_000_000,
    model: reply.model ?? 'gpt-4o-mini',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: reply.text ?? (toolCalls.length > 0 ? null : ''),
          ...(toolCalls.length > 0
            ? {
                tool_calls: toolCalls.map((tc) => ({
                  id: tc.id,
                  type: 'function',
                  function: { name: tc.name, arguments: tc.arguments },
                })),
              }
            : {}),
        },
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
      total_tokens: usage.totalTokens,
      ...(usage.cachedTokens > 0 ? { prompt_tokens_details: { cached_tokens: usage.cachedTokens } } : {}),
      ...(usage.reasoningTokens > 0
        ? { completion_tokens_details: { reasoning_tokens: usage.reasoningTokens } }
        : {}),
    },
  };
}

function buildAnthropicNonStream(reply: FakeProviderScriptedReply): Record<string, unknown> {
  const usage = normalizeUsage(reply.usage);
  const toolCalls = reply.toolCalls ?? [];
  const content: Array<Record<string, unknown>> = [];
  if (reply.text) {
    content.push({ type: 'text', text: reply.text });
  }
  for (const tc of toolCalls) {
    let input: unknown = {};
    try {
      input = JSON.parse(tc.arguments);
    } catch {
      input = { raw: tc.arguments };
    }
    content.push({ type: 'tool_use', id: tc.id, name: tc.name, input });
  }
  return {
    id: 'msg_fake_1',
    type: 'message',
    role: 'assistant',
    model: reply.model ?? 'claude-3-5-sonnet-20241022',
    content,
    stop_reason: mapAnthropicStopReason(reply.finishReason, toolCalls.length > 0),
    stop_sequence: null,
    usage: {
      input_tokens: usage.promptTokens,
      output_tokens: usage.completionTokens,
      ...(usage.cachedTokens > 0 ? { cache_read_input_tokens: usage.cachedTokens } : {}),
      ...(usage.cacheCreationTokens > 0 ? { cache_creation_input_tokens: usage.cacheCreationTokens } : {}),
    },
  };
}

function buildResponsesNonStream(reply: FakeProviderScriptedReply): Record<string, unknown> {
  const usage = normalizeUsage(reply.usage);
  const toolCalls = reply.toolCalls ?? [];
  const text = reply.text ?? '';
  const incompleteReason =
    reply.finishReason === 'content_filter'
      ? 'content_filter'
      : reply.finishReason === 'length'
        ? 'max_output_tokens'
        : undefined;
  const output: Array<Record<string, unknown>> = [];
  if (text.length > 0) {
    output.push({
      type: 'message',
      id: 'msg_fake_1',
      status: incompleteReason ? 'incomplete' : 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    });
  }
  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i]!;
    output.push({
      type: 'function_call',
      id: `fc_fake_${i + 1}`,
      call_id: tc.id,
      name: tc.name,
      arguments: tc.arguments,
      status: 'completed',
    });
  }
  return {
    id: 'resp_fake_1',
    object: 'response',
    created_at: 1_700_000_000,
    status: incompleteReason ? 'incomplete' : 'completed',
    ...(incompleteReason ? { incomplete_details: { reason: incompleteReason } } : {}),
    model: reply.model ?? 'gpt-4o-mini',
    output,
    output_text: text,
    usage: {
      input_tokens: usage.promptTokens,
      input_tokens_details: { cached_tokens: usage.cachedTokens },
      output_tokens: usage.completionTokens,
      output_tokens_details: { reasoning_tokens: usage.reasoningTokens },
      total_tokens: usage.totalTokens,
    },
  };
}

function buildGeminiNonStream(reply: FakeProviderScriptedReply): Record<string, unknown> {
  const usage = normalizeUsage(reply.usage);
  const toolCalls = reply.toolCalls ?? [];
  const parts: Array<Record<string, unknown>> = [];
  if (reply.text) {
    parts.push({ text: reply.text });
  }
  for (const tc of toolCalls) {
    let args: unknown = {};
    try {
      args = JSON.parse(tc.arguments);
    } catch {
      args = { value: tc.arguments };
    }
    parts.push({ functionCall: { id: tc.id, name: tc.name, args } });
  }
  return {
    candidates: [
      {
        content: { role: 'model', parts },
        finishReason: mapGeminiFinishReason(reply.finishReason, toolCalls.length > 0),
        index: 0,
      },
    ],
    usageMetadata: {
      promptTokenCount: usage.promptTokens,
      candidatesTokenCount: usage.completionTokens,
      totalTokenCount: usage.totalTokens,
      ...(usage.cachedTokens > 0 ? { cachedContentTokenCount: usage.cachedTokens } : {}),
    },
    modelVersion: reply.model ?? 'gemini-2.5-flash',
  };
}

function buildStreamChunks(
  wire: FakeProviderWire,
  reply: FakeProviderScriptedReply,
  geminiAltSse: boolean,
): FakeProviderStreamChunk[] {
  const delayMs = reply.chunkDelayMs ?? 0;
  const usage = normalizeUsage(reply.usage);
  const toolCalls = reply.toolCalls ?? [];
  const textParts = reply.textChunks ?? (reply.text !== undefined && reply.text !== '' ? [reply.text] : []);
  const chunks: FakeProviderStreamChunk[] = [];
  const push = (data: string) => chunks.push(delayMs > 0 ? { data, delayMs } : { data });

  if (wire === 'openai-chat') {
    const model = reply.model ?? 'gpt-4o-mini';
    const finishReason = reply.finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop');
    push(
      `data: ${JSON.stringify({
        id: 'chatcmpl-fake-1',
        object: 'chat.completion.chunk',
        created: 1_700_000_000,
        model,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      })}\n\n`,
    );
    for (const part of textParts) {
      push(
        `data: ${JSON.stringify({
          id: 'chatcmpl-fake-1',
          object: 'chat.completion.chunk',
          created: 1_700_000_000,
          model,
          choices: [{ index: 0, delta: { content: part }, finish_reason: null }],
        })}\n\n`,
      );
    }
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i]!;
      push(
        `data: ${JSON.stringify({
          id: 'chatcmpl-fake-1',
          object: 'chat.completion.chunk',
          created: 1_700_000_000,
          model,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: i,
                    id: tc.id,
                    type: 'function',
                    function: { name: tc.name, arguments: tc.arguments },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        })}\n\n`,
      );
    }
    push(
      `data: ${JSON.stringify({
        id: 'chatcmpl-fake-1',
        object: 'chat.completion.chunk',
        created: 1_700_000_000,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
        usage: {
          prompt_tokens: usage.promptTokens,
          completion_tokens: usage.completionTokens,
          total_tokens: usage.totalTokens,
          ...(usage.cachedTokens > 0 ? { prompt_tokens_details: { cached_tokens: usage.cachedTokens } } : {}),
        },
      })}\n\n`,
    );
    push('data: [DONE]\n\n');
    return chunks;
  }

  if (wire === 'anthropic') {
    const model = reply.model ?? 'claude-3-5-sonnet-20241022';
    const stopReason = mapAnthropicStopReason(reply.finishReason, toolCalls.length > 0);
    const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    push(
      sse('message_start', {
        type: 'message_start',
        message: {
          id: 'msg_fake_1',
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: usage.promptTokens, output_tokens: 0 },
        },
      }),
    );
    let blockIdx = 0;
    if (textParts.length > 0) {
      const idx = blockIdx++;
      push(sse('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } }));
      for (const part of textParts) {
        push(sse('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: part } }));
      }
      push(sse('content_block_stop', { type: 'content_block_stop', index: idx }));
    }
    for (const tc of toolCalls) {
      const idx = blockIdx++;
      push(
        sse('content_block_start', {
          type: 'content_block_start',
          index: idx,
          content_block: { type: 'tool_use', id: tc.id, name: tc.name, input: {} },
        }),
      );
      push(
        sse('content_block_delta', {
          type: 'content_block_delta',
          index: idx,
          delta: { type: 'input_json_delta', partial_json: tc.arguments },
        }),
      );
      push(sse('content_block_stop', { type: 'content_block_stop', index: idx }));
    }
    push(
      sse('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: {
          input_tokens: usage.promptTokens,
          output_tokens: usage.completionTokens,
          ...(usage.cachedTokens > 0 ? { cache_read_input_tokens: usage.cachedTokens } : {}),
          ...(usage.cacheCreationTokens > 0 ? { cache_creation_input_tokens: usage.cacheCreationTokens } : {}),
        },
      }),
    );
    push(sse('message_stop', { type: 'message_stop' }));
    return chunks;
  }

  if (wire === 'responses') {
    const model = reply.model ?? 'gpt-4o-mini';
    let seq = 0;
    const sse = (event: string, payload: Record<string, unknown>) =>
      `event: ${event}\ndata: ${JSON.stringify({ type: event, sequence_number: seq++, ...payload })}\n\n`;
    const skeleton = {
      id: 'resp_fake_1',
      object: 'response',
      created_at: 1_700_000_000,
      status: 'in_progress',
      model,
      output: [],
      output_text: '',
    };
    push(sse('response.created', { response: skeleton }));
    push(sse('response.in_progress', { response: skeleton }));

    let outIdx = 0;
    if (textParts.length > 0) {
      const textOutIdx = outIdx++;
      push(
        sse('response.output_item.added', {
          output_index: textOutIdx,
          item: { id: 'msg_fake_1', type: 'message', status: 'in_progress', role: 'assistant', content: [] },
        }),
      );
      push(
        sse('response.content_part.added', {
          item_id: 'msg_fake_1',
          output_index: textOutIdx,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        }),
      );
      for (const part of textParts) {
        push(
          sse('response.output_text.delta', {
            item_id: 'msg_fake_1',
            output_index: textOutIdx,
            content_index: 0,
            delta: part,
          }),
        );
      }
      const fullText = textParts.join('');
      push(
        sse('response.output_text.done', {
          item_id: 'msg_fake_1',
          output_index: textOutIdx,
          content_index: 0,
          text: fullText,
        }),
      );
      push(
        sse('response.content_part.done', {
          item_id: 'msg_fake_1',
          output_index: textOutIdx,
          content_index: 0,
          part: { type: 'output_text', text: fullText, annotations: [] },
        }),
      );
      push(
        sse('response.output_item.done', {
          output_index: textOutIdx,
          item: {
            id: 'msg_fake_1',
            type: 'message',
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text: fullText, annotations: [] }],
          },
        }),
      );
    }

    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i]!;
      const fcIdx = outIdx++;
      const itemId = `fc_fake_${i + 1}`;
      push(
        sse('response.output_item.added', {
          output_index: fcIdx,
          item: { id: itemId, type: 'function_call', status: 'in_progress', call_id: tc.id, name: tc.name, arguments: '' },
        }),
      );
      push(sse('response.function_call_arguments.delta', { item_id: itemId, output_index: fcIdx, delta: tc.arguments }));
      push(sse('response.function_call_arguments.done', { item_id: itemId, output_index: fcIdx, arguments: tc.arguments }));
      push(
        sse('response.output_item.done', {
          output_index: fcIdx,
          item: { id: itemId, type: 'function_call', status: 'completed', call_id: tc.id, name: tc.name, arguments: tc.arguments },
        }),
      );
    }

    const finalObj = buildResponsesNonStream({ ...reply, text: textParts.join('') });
    const doneEvent =
      reply.finishReason === 'content_filter' || reply.finishReason === 'length'
        ? 'response.incomplete'
        : 'response.completed';
    push(sse(doneEvent, { response: finalObj }));
    return chunks;
  }

  // Gemini
  const model = reply.model ?? 'gemini-2.5-flash';
  const finishReason = mapGeminiFinishReason(reply.finishReason, toolCalls.length > 0);
  const events: Record<string, unknown>[] = [];
  for (const part of textParts) {
    events.push({ candidates: [{ content: { role: 'model', parts: [{ text: part }] }, index: 0 }] });
  }
  if (toolCalls.length > 0) {
    events.push({
      candidates: [
        {
          content: {
            role: 'model',
            parts: toolCalls.map((tc) => {
              let args: unknown = {};
              try {
                args = JSON.parse(tc.arguments);
              } catch {
                args = { value: tc.arguments };
              }
              return { functionCall: { id: tc.id, name: tc.name, args } };
            }),
          },
          index: 0,
        },
      ],
    });
  }
  events.push({
    candidates: [{ content: { role: 'model', parts: [] }, finishReason, index: 0 }],
    usageMetadata: {
      promptTokenCount: usage.promptTokens,
      candidatesTokenCount: usage.completionTokens,
      totalTokenCount: usage.totalTokens,
      ...(usage.cachedTokens > 0 ? { cachedContentTokenCount: usage.cachedTokens } : {}),
    },
    modelVersion: model,
  });

  if (geminiAltSse) {
    for (const ev of events) {
      push(`data: ${JSON.stringify(ev)}\n\n`);
    }
  } else {
    push('[');
    for (let i = 0; i < events.length; i++) {
      push(`${i === 0 ? '' : ','}\n${JSON.stringify(events[i])}`);
    }
    push('\n]');
  }
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function startFakeProviderServer(
  defaultReply: FakeProviderReply | FakeProviderHandler | null = null,
): Promise<FakeProviderServer> {
  const queue: FakeProviderReply[] = [];
  const requests: FakeProviderRecordedRequest[] = [];
  let fallback: FakeProviderReply | FakeProviderHandler | null = defaultReply;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    const parsedUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    const query: Record<string, string> = {};
    parsedUrl.searchParams.forEach((value, key) => {
      query[key] = value;
    });

    const record: FakeProviderRecordedRequest = {
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      path: parsedUrl.pathname,
      query,
      headers: { ...req.headers },
      rawBody: Buffer.alloc(0),
      bodyText: '',
      bodyJson: undefined,
      aborted: false,
      receivedAt: Date.now(),
    };

    req.on('aborted', () => {
      record.aborted = true;
    });
    res.on('close', () => {
      if (!res.writableFinished) {
        record.aborted = true;
      }
    });

    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    req.on('end', () => {
      void (async () => {
        record.rawBody = Buffer.concat(chunks);
        record.bodyText = record.rawBody.toString('utf8');
        if (record.bodyText.trim().length > 0) {
          try {
            record.bodyJson = JSON.parse(record.bodyText);
          } catch {
            record.bodyJson = undefined;
          }
        }
        requests.push(record);

        let reply: FakeProviderReply;
        if (queue.length > 0) {
          reply = queue.shift()!;
        } else if (typeof fallback === 'function') {
          reply = await fallback(record);
        } else if (fallback) {
          reply = fallback;
        } else {
          reply = { kind: 'scripted', text: 'fake-ok' };
        }

        if (reply.kind === 'raw') {
          const status = reply.status ?? 200;
          const isObj = reply.body !== undefined && typeof reply.body === 'object' && !Buffer.isBuffer(reply.body);
          const headers: Record<string, string> = {
            ...(isObj ? { 'content-type': 'application/json' } : {}),
            ...reply.headers,
          };
          res.writeHead(status, headers);
          if (reply.body === undefined) {
            res.end();
          } else if (Buffer.isBuffer(reply.body) || typeof reply.body === 'string') {
            res.end(reply.body);
          } else {
            res.end(JSON.stringify(reply.body));
          }
          return;
        }

        if (reply.kind === 'error') {
          const detected = detectFakeProviderWire(record.path);
          const errorReply: FakeProviderErrorReply = {
            ...reply,
            wire: reply.wire ?? detected?.wire,
          };
          res.writeHead(reply.status, {
            'content-type': 'application/json',
            ...reply.headers,
          });
          res.end(JSON.stringify(buildErrorBody(errorReply)));
          return;
        }

        if (reply.kind === 'stream') {
          res.writeHead(reply.status ?? 200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
            ...reply.headers,
          });
          for (let i = 0; i < reply.chunks.length; i++) {
            if (record.aborted || res.destroyed) return;
            const chunk = reply.chunks[i]!;
            if (chunk.delayMs && chunk.delayMs > 0) {
              await sleep(chunk.delayMs);
            }
            if (record.aborted || res.destroyed) return;
            res.write(chunk.data);
            if (reply.destroyAfterChunks !== undefined && i + 1 >= reply.destroyAfterChunks) {
              res.destroy();
              return;
            }
          }
          if (reply.hangMs && reply.hangMs > 0) {
            await sleep(reply.hangMs);
          }
          if (!res.destroyed) res.end();
          return;
        }

        // Scripted reply
        const { wire, stream, geminiAltSse } = resolveWireAndStream(record, reply);
        if (!stream) {
          let payload: Record<string, unknown>;
          if (wire === 'openai-chat') payload = buildOpenAIChatNonStream(reply);
          else if (wire === 'anthropic') payload = buildAnthropicNonStream(reply);
          else if (wire === 'responses') payload = buildResponsesNonStream(reply);
          else payload = buildGeminiNonStream(reply);
          res.writeHead(reply.status ?? 200, {
            'content-type': 'application/json',
            ...reply.headers,
          });
          res.end(JSON.stringify(payload));
          return;
        }

        const streamChunks = buildStreamChunks(wire, reply, geminiAltSse);
        const contentType = wire === 'gemini' && !geminiAltSse ? 'application/json' : 'text/event-stream';
        res.writeHead(reply.status ?? 200, {
          'content-type': contentType,
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          ...reply.headers,
        });
        for (const chunk of streamChunks) {
          if (record.aborted || res.destroyed) return;
          if (chunk.delayMs && chunk.delayMs > 0) {
            await sleep(chunk.delayMs);
          }
          if (record.aborted || res.destroyed) return;
          res.write(chunk.data);
        }
        if (!res.destroyed) res.end();
      })().catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
        }
        if (!res.destroyed) {
          res.end(JSON.stringify({ error: { message: err instanceof Error ? err.message : String(err) } }));
        }
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Failed to bind fake provider server');
  }

  return {
    url: `http://127.0.0.1:${addr.port}`,
    port: addr.port,
    requests,
    enqueue(...replies: FakeProviderReply[]) {
      queue.push(...replies);
    },
    setDefaultReply(reply: FakeProviderReply | FakeProviderHandler | null) {
      fallback = reply;
    },
    clearRequests() {
      requests.length = 0;
    },
    reset() {
      queue.length = 0;
      requests.length = 0;
      fallback = defaultReply;
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
