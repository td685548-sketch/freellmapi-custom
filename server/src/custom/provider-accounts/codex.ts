/**
 * OpenAI Codex (ChatGPT subscription) executor.
 *
 * Codex only speaks the Responses API and only streams, so this adapter
 * translates OpenAI Chat Completions traffic into a Responses request and folds
 * the Responses SSE stream back into Chat Completions chunks. Header identity
 * (`originator`, `version`, `session_id`, `ChatGPT-Account-ID`) follows the
 * Codex CLI / 9router reference; the endpoint is the ChatGPT backend, not the
 * public OpenAI API, so an API key cannot be used here.
 */
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatMessage,
  ChatToolCall,
  Platform,
  TokenUsage,
} from '@freellmapi/shared/types.js';
import { estimateInputTokens } from '../../lib/content.js';
import {
  BaseProvider,
  providerHttpError,
  type CompletionOptions,
  type KeyValidationResult,
} from '../../providers/base.js';
import { subscriptionEvents } from './subscription-http.js';
import { parseOAuthCredential } from './oauth-credentials.js';

const RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
const MODELS_URL = 'https://chatgpt.com/backend-api/codex/models';
const CLI_VERSION = '0.159.0';
const DEFAULT_INSTRUCTIONS =
  'You are a helpful assistant. Answer the user directly and completely.';

interface ResponsesTool {
  type: 'function';
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
}

export function codexUpstreamModel(modelId: string): string {
  return modelId.trim().replace(/\[[^\]]*\]$/, '').replace(/-review$/, '');
}

function contentBlocks(message: ChatMessage): Array<Record<string, unknown>> {
  const { content } = message;
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  return content.flatMap((part): Array<Record<string, unknown>> => {
    if (typeof part === 'string') return part ? [{ type: 'text', text: part }] : [];
    if (!part || typeof part !== 'object') return [];
    if (part.type === 'image_url') {
      const url = typeof part.image_url === 'string'
        ? part.image_url
        : (part.image_url as { url?: unknown } | undefined)?.url;
      return typeof url === 'string' && url ? [{ type: 'image_url', url }] : [];
    }
    return typeof part.text === 'string' && part.text ? [{ type: 'text', text: part.text }] : [];
  });
}

/** Chat Completions history -> Responses `input` items. */
export function toResponsesInput(messages: ChatMessage[]): {
  instructions: string;
  input: Array<Record<string, unknown>>;
} {
  const instructions: string[] = [];
  const input: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === 'system') {
      const text = contentBlocks(message).map(block => typeof block.text === 'string' ? block.text : '').join('\n');
      if (text) instructions.push(text);
      continue;
    }
    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.tool_call_id ?? `call_${input.length}`,
        output: contentBlocks(message).map(block => typeof block.text === 'string' ? block.text : '').join('\n'),
      });
      continue;
    }
    if (message.role === 'assistant') {
      const text = contentBlocks(message).map(block => typeof block.text === 'string' ? block.text : '').join('');
      if (text) {
        input.push({
          type: 'message', role: 'assistant',
          content: [{ type: 'output_text', text }],
        });
      }
      for (const call of message.tool_calls ?? []) {
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments || '{}',
        });
      }
      continue;
    }
    const blocks = contentBlocks(message);
    const parts = blocks.flatMap((block): Array<Record<string, unknown>> => {
      if (block.type === 'image_url') return [{ type: 'input_image', image_url: block.url }];
      return typeof block.text === 'string' && block.text ? [{ type: 'input_text', text: block.text }] : [];
    });
    if (parts.length > 0) input.push({ type: 'message', role: 'user', content: parts });
  }
  return { instructions: instructions.join('\n\n') || DEFAULT_INSTRUCTIONS, input };
}

function toResponsesTools(tools: CompletionOptions['tools']): ResponsesTool[] | undefined {
  if (!tools?.length) return undefined;
  const mapped = tools
    .filter(tool => tool?.type === 'function' && tool.function?.name)
    .map(tool => ({
      type: 'function' as const,
      name: tool.function.name.slice(0, 128),
      ...(tool.function.description ? { description: tool.function.description } : {}),
      parameters: tool.function.parameters ?? { type: 'object', properties: {} },
      ...(typeof tool.function.strict === 'boolean' ? { strict: tool.function.strict } : {}),
    }));
  return mapped.length > 0 ? mapped : undefined;
}

function toResponsesToolChoice(choice: CompletionOptions['tool_choice']): unknown {
  if (choice === undefined) return undefined;
  if (choice === 'auto' || choice === 'none' || choice === 'required') return choice;
  return { type: 'function', name: choice.function.name };
}

function promptKey(messages: ChatMessage[], modelId: string): string {
  const first = messages.find(message => message.role === 'user');
  const text = typeof first?.content === 'string'
    ? first.content
    : Array.isArray(first?.content)
      ? first.content.map(part => typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '').join('')
      : '';
  let h1 = 0x811c9dc5;
  const seed = `${modelId}:${text.slice(0, 1024)}`;
  for (let i = 0; i < seed.length; i++) {
    h1 ^= seed.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193) >>> 0;
  }
  return `flc_${h1.toString(16)}`;
}

function codexCredential(credential: string): { accessToken: string; accountId?: string } {
  const parsed = parseOAuthCredential(credential);
  if (!parsed || parsed.kind !== 'codex') {
    throw new Error('Codex accounts require an OAuth connection. Add the account via Connect, not an OpenAI API key.');
  }
  return { accessToken: parsed.accessToken, ...(parsed.accountId ? { accountId: parsed.accountId } : {}) };
}

export class CodexProvider extends BaseProvider {
  readonly platform: Platform = 'custom';
  readonly name = 'OpenAI Codex';
  private readonly timeoutMs: number;

  constructor(config: { timeoutMs?: number } = {}) {
    super();
    this.timeoutMs = config.timeoutMs ?? 120_000;
  }

  private headers(credential: string, sessionId: string, accept: string): Record<string, string> {
    const { accessToken, accountId } = codexCredential(credential);
    return {
      'Content-Type': 'application/json',
      Accept: accept,
      Authorization: `Bearer ${accessToken}`,
      originator: 'codex_cli_rs',
      version: CLI_VERSION,
      'User-Agent': `codex_cli_rs/${CLI_VERSION}`,
      session_id: sessionId,
      ...(accountId ? { 'ChatGPT-Account-ID': accountId } : {}),
    };
  }

  private buildBody(messages: ChatMessage[], modelId: string, options: CompletionOptions | undefined): Record<string, unknown> {
    const { instructions, input } = toResponsesInput(messages);
    const tools = toResponsesTools(options?.tools);
    const toolChoice = toResponsesToolChoice(options?.tool_choice);
    return {
      model: codexUpstreamModel(modelId),
      instructions,
      input: input.length > 0 ? input : [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '...' }] }],
      ...(tools ? { tools } : {}),
      ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
      stream: true,
      store: false,
      prompt_cache_key: promptKey(messages, modelId),
    };
  }

  override async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse> {
    let content = '';
    let reasoning = '';
    let finishReason = 'stop';
    let usage: TokenUsage | undefined;
    const toolCalls: ChatToolCall[] = [];

    for await (const chunk of this.streamChatCompletion(apiKey, messages, modelId, options)) {
      const choice = chunk.choices[0];
      if (chunk.usage) usage = chunk.usage;
      if (!choice) continue;
      if (choice.delta.content) content += choice.delta.content;
      if (choice.delta.reasoning_content) reasoning += choice.delta.reasoning_content;
      for (const call of choice.delta.tool_calls ?? []) {
        const index = (call as ChatToolCall & { index?: number }).index ?? toolCalls.length;
        const existing = toolCalls[index];
        if (existing) {
          existing.function.arguments += call.function.arguments;
          if (call.function.name && !existing.function.name) existing.function.name = call.function.name;
        } else {
          toolCalls[index] = {
            id: call.id,
            type: 'function',
            function: { name: call.function.name, arguments: call.function.arguments },
          };
        }
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }

    const promptTokens = usage?.prompt_tokens ?? estimateInputTokens(messages);
    const completionTokens = usage?.completion_tokens ?? 0;
    return {
      id: this.makeId(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: content || (toolCalls.length > 0 ? null : ''),
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls.filter(Boolean) } : {}),
        },
        finish_reason: toolCalls.filter(Boolean).length > 0 ? 'tool_calls' : finishReason,
      }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: usage?.total_tokens ?? promptTokens + completionTokens,
      },
      _routed_via: { platform: this.platform, model: modelId },
    };
  }

  override async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): AsyncGenerator<ChatCompletionChunk> {
    const sessionId = promptKey(messages, modelId);
    const res = await this.fetchWithTimeout(RESPONSES_URL, {
      method: 'POST',
      headers: this.headers(apiKey, sessionId, 'text/event-stream'),
      body: JSON.stringify(this.buildBody(messages, modelId, options)),
    }, options?.timeoutMs ?? this.timeoutMs, { signal: options?.signal });

    if (!res.ok) {
      await res.body?.cancel();
      throw providerHttpError(res, `Codex request failed (HTTP ${res.status}).`, '');
    }

    const id = this.makeId();
    const created = Math.floor(Date.now() / 1000);
    let finished = false;
    let sawToolCall = false;
    const indexes = new Map<string, number>();
    const names = new Map<string, string>();
    const callIds = new Map<string, string>();
    let nextIndex = 0;

    const chunk = (delta: Record<string, unknown>, finish: string | null = null, usage?: TokenUsage): ChatCompletionChunk => ({
      id,
      object: 'chat.completion.chunk',
      created,
      model: modelId,
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage ? { usage } : {}),
    });

    for await (const event of subscriptionEvents(res, options?.timeoutMs ?? this.timeoutMs)) {
          const type = typeof event.type === 'string' ? event.type : '';
          if (type === 'error' || type === 'response.failed') {
            throw new Error('Codex reported an upstream stream failure.');
          }
          if (type === 'response.output_text.delta' && typeof event.delta === 'string' && event.delta) {
            yield chunk({ content: event.delta });
            continue;
          }
          if (type === 'response.reasoning_summary_text.delta' && typeof event.delta === 'string' && event.delta) {
            yield chunk({ reasoning_content: event.delta });
            continue;
          }
          if (type === 'response.output_item.added' && event.item?.type === 'function_call') {
            const itemId = String(event.item.id ?? event.item.call_id ?? '');
            if (!indexes.has(itemId)) indexes.set(itemId, nextIndex++);
            const index = indexes.get(itemId)!;
            const callId = String(event.item.call_id ?? itemId ?? `call_${index}`);
            callIds.set(itemId, callId);
            names.set(itemId, String(event.item.name ?? ''));
            sawToolCall = true;
            yield chunk({
              tool_calls: [{
                index, id: callId, type: 'function',
                function: { name: String(event.item.name ?? ''), arguments: '' },
              } as ChatToolCall],
            });
            continue;
          }
          if (type === 'response.function_call_arguments.delta' && typeof event.delta === 'string') {
            const itemId = String(event.item_id ?? '');
            if (!indexes.has(itemId)) indexes.set(itemId, nextIndex++);
            const index = indexes.get(itemId)!;
            sawToolCall = true;
            yield chunk({
              tool_calls: [{
                index, id: callIds.get(itemId) ?? itemId, type: 'function',
                function: { name: names.get(itemId) ?? '', arguments: event.delta },
              } as ChatToolCall],
            });
            continue;
          }
          if (type === 'response.completed' || type === 'response.incomplete') {
            const parsedUsage = event.response?.usage;
            const usage: TokenUsage | undefined = parsedUsage
              ? {
                prompt_tokens: Number(parsedUsage.input_tokens ?? 0),
                completion_tokens: Number(parsedUsage.output_tokens ?? 0),
                total_tokens: Number(parsedUsage.total_tokens ?? 0),
              }
              : undefined;
            const reason = type === 'response.incomplete' ? 'length' : sawToolCall ? 'tool_calls' : 'stop';
            if (!finished) {
              finished = true;
              yield chunk({}, reason, usage);
            }
            return;
          }
    }

    if (!finished) {
      throw new Error('Codex stream ended unexpectedly (no response.completed event).');
    }
  }

  override async validateKey(apiKey: string): Promise<KeyValidationResult> {
    const { accessToken, accountId } = codexCredential(apiKey);
    const res = await this.fetchWithTimeout(MODELS_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        originator: 'codex_cli_rs',
        version: CLI_VERSION,
        'User-Agent': `codex_cli_rs/${CLI_VERSION}`,
        ...(accountId ? { 'ChatGPT-Account-ID': accountId } : {}),
      },
    }, 15_000, { timeoutBounds: 'request' });
    if (res.ok) {
      await res.body?.cancel();
      return true;
    }
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel();
      return false;
    }
    await res.body?.cancel();
    throw providerHttpError(res, `Credential check failed (HTTP ${res.status}).`, '');
  }
}
