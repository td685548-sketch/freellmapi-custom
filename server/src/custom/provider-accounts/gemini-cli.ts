/**
 * Gemini CLI / Google Cloud Code Assist executor.
 *
 * Subscription (Google OAuth) traffic goes to the Cloud Code Assist API, not
 * `generativelanguage.googleapis.com`: requests are wrapped as
 * `{ project, model, request }` and authenticated with `Authorization: Bearer`.
 * The response is Gemini's own SSE format (sometimes nested under `response`),
 * which this adapter folds back into Chat Completions chunks.
 */
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatMessage,
  ChatToolCall,
  ChatToolDefinition,
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
import { fetchGeminiProjectId } from './oauth-providers.js';

const CLOUD_CODE_BASE = 'https://cloudcode-pa.googleapis.com/v1internal';
const CLI_USER_AGENT = 'GeminiCLI/0.34.0/{model} (linux; x64; terminal)';
const API_CLIENT = 'google-genai-sdk/1.41.0 gl-node/v22.19.0';

const projectCache = new Map<string, string | null>();

async function resolveProject(credential: string, accessToken: string): Promise<string | null> {
  const parsed = parseOAuthCredential(credential);
  if (parsed?.projectId) return parsed.projectId;
  const cached = projectCache.get(accessToken);
  if (cached !== undefined) return cached;
  const projectId = await fetchGeminiProjectId(accessToken);
  projectCache.set(accessToken, projectId);
  if (projectCache.size > 64) {
    const oldest = projectCache.keys().next().value;
    if (oldest) projectCache.delete(oldest);
  }
  return projectId;
}

function textOf(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '').join('');
}

function toGeminiContents(messages: ChatMessage[]): {
  contents: Array<Record<string, unknown>>;
  systemInstruction?: { parts: Array<{ text: string }> };
} {
  const system: string[] = [];
  const contents: Array<Record<string, unknown>> = [];
  const toolNames = new Map(messages.flatMap(message => (message.tool_calls ?? []).map(call => [call.id, call.function.name] as const)));
  for (const message of messages) {
    if (message.role === 'system') {
      const text = textOf(message.content);
      if (text) system.push(text);
      continue;
    }
    if (message.role === 'tool') {
      contents.push({
        role: 'user',
        parts: [{
          functionResponse: {
            name: message.name || toolNames.get(message.tool_call_id ?? '') || 'tool',
            response: message.is_error === true ? { error: textOf(message.content) } : { content: textOf(message.content) },
          },
        }],
      });
      continue;
    }
    const parts: Array<Record<string, unknown>> = [];
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (typeof part === 'string') {
          if (part) parts.push({ text: part });
          continue;
        }
        if (part?.type === 'image_url') {
          const url = typeof part.image_url === 'string'
            ? part.image_url
            : (part.image_url as { url?: unknown } | undefined)?.url;
          const match = typeof url === 'string' ? /^data:([^;]+);base64,(.+)$/.exec(url) : null;
          if (!match) throw new Error('Gemini CLI requires inline base64 images.');
          if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
          continue;
        }
        if (typeof part?.text === 'string' && part.text) parts.push({ text: part.text });
      }
    } else {
      const text = textOf(message.content);
      if (text) parts.push({ text });
    }
    if (message.role === 'assistant' && message.tool_calls?.length) {
      for (const call of message.tool_calls) {
        let args: unknown = {};
        try {
          args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          args = {};
        }
        parts.push({ functionCall: { name: call.function.name, args } });
      }
    }
    if (parts.length > 0) {
      contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts });
    }
  }
  return {
    contents,
    ...(system.length > 0 ? { systemInstruction: { parts: [{ text: system.join('\n\n') }] } } : {}),
  };
}

function toGeminiTools(tools: CompletionOptions['tools']): Array<Record<string, unknown>> | undefined {
  if (!tools?.length) return undefined;
  const declarations = tools.map((tool: ChatToolDefinition) => ({
    name: tool.function.name,
    ...(tool.function.description ? { description: tool.function.description } : {}),
    ...(tool.function.parameters ? { parameters: tool.function.parameters } : {}),
  }));
  return declarations.length > 0 ? [{ functionDeclarations: declarations }] : undefined;
}

function toFinishReason(reason: string | undefined, sawToolCall: boolean): string {
  if (sawToolCall) return 'tool_calls';
  switch (reason) {
    case 'MAX_TOKENS': return 'length';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT': return 'content_filter';
    default: return 'stop';
  }
}

export class GeminiCliProvider extends BaseProvider {
  readonly platform: Platform = 'google';
  readonly name = 'Gemini CLI';
  private readonly timeoutMs: number;

  constructor(config: { timeoutMs?: number } = {}) {
    super();
    this.timeoutMs = config.timeoutMs ?? 120_000;
  }

  private accessToken(credential: string): string {
    const parsed = parseOAuthCredential(credential);
    if (!parsed || parsed.kind !== 'gemini-cli') {
      throw new Error('Gemini CLI accounts require a Google OAuth connection. Use the Gemini provider for API keys.');
    }
    return parsed.accessToken;
  }

  private async buildRequest(
    credential: string,
    messages: ChatMessage[],
    modelId: string,
    options: CompletionOptions | undefined,
  ): Promise<Record<string, unknown>> {
    const accessToken = this.accessToken(credential);
    const request: Record<string, unknown> = {};
    const { contents, systemInstruction } = toGeminiContents(messages);
    request.contents = contents;
    if (systemInstruction) request.systemInstruction = systemInstruction;
    const tools = toGeminiTools(options?.tools);
    if (tools) request.tools = tools;
    const generationConfig: Record<string, unknown> = {};
    if (options?.temperature !== undefined) generationConfig.temperature = options.temperature;
    if (options?.top_p !== undefined) generationConfig.topP = options.top_p;
    if (options?.max_tokens !== undefined) generationConfig.maxOutputTokens = options.max_tokens;
    const stop = typeof options?.stop === 'string' ? [options.stop] : options?.stop;
    if (Array.isArray(stop) && stop.length > 0) generationConfig.stopSequences = stop;
    if (Object.keys(generationConfig).length > 0) request.generationConfig = generationConfig;
    const project = await resolveProject(credential, accessToken);
    return {
      project: project ?? undefined,
      model: modelId,
      request,
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
        if (existing) existing.function.arguments += call.function.arguments;
        else toolCalls[index] = call;
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
          content: content || (toolCalls.filter(Boolean).length > 0 ? null : ''),
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(toolCalls.filter(Boolean).length > 0 ? { tool_calls: toolCalls.filter(Boolean) } : {}),
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
    const body = await this.buildRequest(apiKey, messages, modelId, options);
    const res = await this.fetchWithTimeout(
      `${CLOUD_CODE_BASE}:streamGenerateContent?alt=sse`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          Authorization: `Bearer ${this.accessToken(apiKey)}`,
          'User-Agent': CLI_USER_AGENT.replace('{model}', modelId),
          'X-Goog-Api-Client': API_CLIENT,
        },
        body: JSON.stringify(body),
      },
      options?.timeoutMs ?? this.timeoutMs,
      { signal: options?.signal },
    );

    if (!res.ok) {
      await res.body?.cancel();
      throw providerHttpError(res, `Gemini CLI request failed (HTTP ${res.status}).`, '');
    }

    const id = this.makeId();
    const created = Math.floor(Date.now() / 1000);
    let finished = false;
    let sawToolCall = false;
    let nextToolIndex = 0;

    const chunk = (delta: Record<string, unknown>, finish: string | null = null, usage?: TokenUsage): ChatCompletionChunk => ({
      id,
      object: 'chat.completion.chunk',
      created,
      model: modelId,
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage ? { usage } : {}),
    });

    for await (const parsed of subscriptionEvents(res, options?.timeoutMs ?? this.timeoutMs)) {
          const payload = parsed.response ?? parsed;
          if (payload.error?.message) throw new Error('Gemini CLI reported an upstream stream failure.');
          const candidate = payload.candidates?.[0];
          for (const part of candidate?.content?.parts ?? []) {
            if (typeof part.text === 'string' && part.text) {
              yield chunk(part.thought ? { reasoning_content: part.text } : { content: part.text });
            }
            if (part.functionCall?.name) {
              const index = nextToolIndex++;
              sawToolCall = true;
              yield chunk({
                tool_calls: [{
                  index,
                  id: `call_${id.slice(-8)}_${index}`,
                  type: 'function',
                  function: {
                    name: part.functionCall.name,
                    arguments: JSON.stringify(part.functionCall.args ?? {}),
                  },
                } as ChatToolCall],
              });
            }
          }
          if (candidate?.finishReason && !finished) {
            finished = true;
            const usage: TokenUsage | undefined = payload.usageMetadata
              ? {
                prompt_tokens: payload.usageMetadata.promptTokenCount ?? 0,
                completion_tokens: payload.usageMetadata.candidatesTokenCount ?? 0,
                total_tokens: payload.usageMetadata.totalTokenCount ?? 0,
              }
              : undefined;
            yield chunk({}, toFinishReason(candidate.finishReason, sawToolCall), usage);
            return;
          }
    }

    if (!finished) {
      throw new Error('Gemini CLI stream ended unexpectedly (no finishReason).');
    }
  }

  override async validateKey(apiKey: string): Promise<KeyValidationResult> {
    const accessToken = this.accessToken(apiKey);
    const body = await this.buildRequest(apiKey, [{ role: 'user', content: 'hi' }], 'gemini-2.5-flash', { max_tokens: 1 });
    const res = await this.fetchWithTimeout(
      `${CLOUD_CODE_BASE}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          'User-Agent': CLI_USER_AGENT.replace('{model}', 'gemini-2.5-flash'),
          'X-Goog-Api-Client': API_CLIENT,
        },
        body: JSON.stringify(body),
      },
      20_000,
      { timeoutBounds: 'request' },
    );
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
