import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import type {
  ChatContentBlock,
  ChatMessage,
  ChatToolCall,
  ChatToolChoice,
  ChatToolDefinition,
} from '@freellmapi/shared/types.js';
import type { CompletionOptions } from '../../providers/base.js';
import { decrypt } from '../../lib/crypto.js';
import { contentToString, estimateInputTokens } from '../../lib/content.js';
import { proxyFetch, withKeyProxy } from '../../lib/proxy.js';
import { logRequest } from '../../lib/request-log.js';
import {
  getXGatewayProvider,
  resolveXGatewayProvider,
} from '../provider-accounts/catalog.js';
import {
  accountModels,
  recordXGatewayKeyUsage,
  resolveXGatewayAccountProxy,
} from '../provider-accounts/store.js';
import { xGatewayAuth } from './auth.js';
import { getConfigSnapshot } from './config.js';
import { runInGatewayScope } from './context.js';
import {
  applyGatewaySavers,
  resolveCandidateRoutes,
  type CandidateRoute,
} from './router.js';

export const xGatewayProtocolsRouter = Router();

const MAX_AUDIO_UPLOAD_BYTES = 25 * 1024 * 1024;
const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AUDIO_UPLOAD_BYTES, files: 1 },
});

function resolveAnthropicCandidates(requestedModel: string | undefined): {
  candidates: CandidateRoute[];
  notFoundError?: string;
} {
  const raw = (requestedModel ?? 'auto').trim() || 'auto';
  const stripped = raw.startsWith('claude/') ? raw.slice('claude/'.length) : raw;
  const resolved = resolveCandidateRoutes(stripped);
  if (resolved.notFoundError || resolved.candidates.length === 0) {
    return resolved;
  }

  // If the caller sent a generic Claude Code model alias (e.g. claude-sonnet-4-5-20250929)
  // and a candidate account is not an Anthropic provider and does not explicitly list that
  // claude-* model ID, map to the account's primary model so non-Anthropic providers work seamlessly.
  if (stripped.toLowerCase().startsWith('claude-')) {
    return {
      candidates: resolved.candidates.map(c => {
        const models = accountModels(c.account);
        const hasExact = models.some(m => m.id === stripped);
        if (hasExact || c.account.provider === 'claude') {
          return c;
        }
        return {
          account: c.account,
          modelId: models[0]?.id ?? c.modelId,
        };
      }),
    };
  }

  return resolved;
}

function flattenAnthropicSystem(system: unknown): string {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return '';
  return system
    .map(b => (b && typeof b === 'object' && typeof (b as any).text === 'string' ? (b as any).text : ''))
    .filter(Boolean)
    .join('\n');
}

function flattenToolResultContent(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content
    .map(b => {
      if (typeof b === 'string') return b;
      if (b && typeof b === 'object' && typeof (b as any).text === 'string') return (b as any).text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function convertAnthropicMessages(body: Record<string, any>): {
  messages: ChatMessage[];
  tools?: ChatToolDefinition[];
  toolChoice?: ChatToolChoice;
} {
  const messages: ChatMessage[] = [];
  const sys = flattenAnthropicSystem(body.system);
  if (sys) messages.push({ role: 'system', content: sys });

  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  for (const msg of rawMessages) {
    if (!msg || typeof msg !== 'object') continue;
    const role = msg.role;
    if (role === 'system') {
      const text = typeof msg.content === 'string' ? msg.content : flattenAnthropicSystem(msg.content);
      if (text) messages.push({ role: 'system', content: text });
      continue;
    }

    if (typeof msg.content === 'string') {
      messages.push({ role: role === 'assistant' ? 'assistant' : 'user', content: msg.content });
      continue;
    }

    if (!Array.isArray(msg.content)) continue;

    const textParts: string[] = [];
    const imageBlocks: ChatContentBlock[] = [];
    const toolCalls: ChatToolCall[] = [];
    const toolResults: ChatMessage[] = [];

    for (const block of msg.content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string') {
        textParts.push(block.text);
      } else if (block.type === 'image' && block.source) {
        const src = block.source;
        const url =
          src.type === 'base64' && src.media_type && src.data
            ? `data:${src.media_type};base64,${src.data}`
            : typeof src.url === 'string'
              ? src.url
              : null;
        if (url) imageBlocks.push({ type: 'image_url', image_url: { url } } as ChatContentBlock);
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: String(block.id ?? `toolu_${crypto.randomBytes(6).toString('hex')}`),
          type: 'function',
          function: {
            name: String(block.name ?? ''),
            arguments: JSON.stringify(block.input ?? {}),
          },
        });
      } else if (block.type === 'tool_result') {
        toolResults.push({
          role: 'tool',
          tool_call_id: String(block.tool_use_id ?? ''),
          content: flattenToolResultContent(block.content),
        });
      }
    }

    const joinedText = textParts.join('\n');
    if (role === 'assistant') {
      messages.push({
        role: 'assistant',
        content: joinedText.length > 0 ? joinedText : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    } else {
      messages.push(...toolResults);
      if (imageBlocks.length > 0) {
        const contentBlocks: ChatContentBlock[] = [];
        if (joinedText) contentBlocks.push({ type: 'text', text: joinedText });
        contentBlocks.push(...imageBlocks);
        messages.push({ role: 'user', content: contentBlocks });
      } else if (joinedText.length > 0) {
        messages.push({ role: 'user', content: joinedText });
      }
    }
  }

  const tools: ChatToolDefinition[] | undefined = Array.isArray(body.tools)
    ? body.tools
        .filter((t: any) => t && typeof t.name === 'string')
        .map((t: any) => ({
          type: 'function' as const,
          function: {
            name: t.name,
            ...(typeof t.description === 'string' ? { description: t.description } : {}),
            parameters: t.input_schema ?? { type: 'object', properties: {} },
          },
        }))
    : undefined;

  let toolChoice: ChatToolChoice | undefined;
  if (body.tool_choice && typeof body.tool_choice === 'object') {
    const tcType = body.tool_choice.type;
    if (tcType === 'auto') toolChoice = 'auto';
    else if (tcType === 'none') toolChoice = 'none';
    else if (tcType === 'any') toolChoice = 'required';
    else if (tcType === 'tool' && typeof body.tool_choice.name === 'string') {
      toolChoice = { type: 'function', function: { name: body.tool_choice.name } };
    }
  }

  return { messages, tools: tools?.length ? tools : undefined, toolChoice };
}

function writeAnthropicSse(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Anthropic Messages API (/x/v1/messages & /x/v1/messages/count_tokens)
// ─────────────────────────────────────────────────────────────────────────────

xGatewayProtocolsRouter.post('/messages/count_tokens', xGatewayAuth, (req: Request, res: Response) => {
  res.setHeader('X-Gateway', 'x');
  const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, any>) : {};
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    res.status(400).json({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'messages must be a non-empty array' },
    });
    return;
  }
  const { messages, tools } = convertAnthropicMessages(body);
  res.json({ input_tokens: estimateInputTokens(messages, tools) });
});

xGatewayProtocolsRouter.post('/messages', xGatewayAuth, async (req: Request, res: Response) => {
  const startMs = Date.now();
  const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, any>) : {};
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    res.status(400).json({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'messages must be a non-empty array' },
    });
    return;
  }

  const requestedModel = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : 'auto';
  const isStream = body.stream === true;
  const converted = convertAnthropicMessages(body);
  const { messages, appliedSavers } = applyGatewaySavers(req, converted.messages);

  const scope = {
    gateway: 'x' as const,
    outputSavers: appliedSavers,
    inputSaver: getConfigSnapshot().savers.input,
    inputTokensSaved: 0,
  };

  res.setHeader('X-Gateway', 'x');
  res.setHeader('X-Output-Saver-Applied', appliedSavers.join(','));
  res.setHeader('X-Input-Tokens-Saved', '0');

  await runInGatewayScope(scope, async () => {
    const { candidates, notFoundError } = resolveAnthropicCandidates(requestedModel);
    if (notFoundError) {
      res.status(404).json({
        type: 'error',
        error: { type: 'not_found_error', message: notFoundError },
      });
      return;
    }
    if (candidates.length === 0) {
      res.status(503).json({
        type: 'error',
        error: { type: 'overloaded_error', message: 'No enabled X Gateway provider accounts available.' },
      });
      return;
    }

    const options: CompletionOptions = {
      temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
      max_tokens: typeof body.max_tokens === 'number' && body.max_tokens > 0 ? body.max_tokens : 4096,
      top_p: typeof body.top_p === 'number' ? body.top_p : undefined,
      stop: Array.isArray(body.stop_sequences) ? body.stop_sequences : undefined,
      tools: converted.tools,
      tool_choice: converted.toolChoice,
    };

    const estimatedPromptTokens = estimateInputTokens(messages, converted.tools);
    let lastError: unknown = null;

    for (const { account, modelId } of candidates) {
      const provider = resolveXGatewayProvider(account.provider, account.base_url);
      if (!provider) continue;

      let credential: string;
      try {
        credential = decrypt(account.encrypted_key, account.iv, account.auth_tag);
      } catch (err) {
        lastError = err;
        continue;
      }

      const effectiveProxy = resolveXGatewayAccountProxy(account);

      if (!isStream) {
        try {
          const completion = await withKeyProxy(effectiveProxy, () =>
            provider.chatCompletion(credential, messages, modelId, options, {
              platform: account.platform,
              keyId: account.id,
              modelId,
            }),
          );

          const latencyMs = Date.now() - startMs;
          const respMsg = completion.choices?.[0]?.message;
          const text = contentToString(respMsg?.content ?? '');
          const toolCalls = respMsg?.tool_calls ?? [];
          const promptTokens = completion.usage?.prompt_tokens ?? estimatedPromptTokens;
          const completionTokens =
            completion.usage?.completion_tokens ?? Math.max(1, Math.ceil(text.length / 4));

          recordXGatewayKeyUsage(account.id, promptTokens + completionTokens);
          logRequest(
            account.provider,
            modelId,
            null,
            'success',
            promptTokens,
            completionTokens,
            latencyMs,
            null,
            latencyMs,
            requestedModel === 'auto' ? null : requestedModel,
            null,
            'x-gateway',
          );

          const contentBlocks: Array<Record<string, unknown>> = [];
          if (typeof respMsg?.reasoning_content === 'string' && respMsg.reasoning_content) {
            contentBlocks.push({ type: 'thinking', thinking: respMsg.reasoning_content, signature: '' });
          }
          if (text) {
            contentBlocks.push({ type: 'text', text });
          }
          for (const tc of toolCalls) {
            let parsedInput: unknown = {};
            try {
              parsedInput = JSON.parse(tc.function.arguments || '{}');
            } catch {
              parsedInput = {};
            }
            contentBlocks.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.function.name,
              input: parsedInput,
            });
          }

          res.setHeader('X-Routed-Via', `${account.provider}/${modelId}`);
          res.status(200).json({
            id: `msg_${crypto.randomBytes(12).toString('hex')}`,
            type: 'message',
            role: 'assistant',
            model: requestedModel,
            content: contentBlocks,
            stop_reason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
            stop_sequence: null,
            usage: {
              input_tokens: promptTokens,
              output_tokens: completionTokens,
            },
          });
          return;
        } catch (err) {
          lastError = err;
          continue;
        }
      } else {
        try {
          await withKeyProxy(effectiveProxy, async () => {
            const stream = provider.streamChatCompletion(credential, messages, modelId, options, {
              platform: account.platform,
              keyId: account.id,
              modelId,
            });
            const iterator = stream[Symbol.asyncIterator]();
            const first = await iterator.next();

            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Routed-Via', `${account.provider}/${modelId}`);

            const msgId = `msg_${crypto.randomBytes(12).toString('hex')}`;
            const ttfbMs = Date.now() - startMs;
            let promptTokens = estimatedPromptTokens;
            let completionTokens = 0;
            let textChars = 0;

            writeAnthropicSse(res, 'message_start', {
              type: 'message_start',
              message: {
                id: msgId,
                type: 'message',
                role: 'assistant',
                model: requestedModel,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: promptTokens, output_tokens: 0 },
              },
            });

            writeAnthropicSse(res, 'content_block_start', {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: '' },
            });

            const processChunk = (chunk: any) => {
              if (!chunk) return;
              if (chunk.usage?.prompt_tokens) promptTokens = chunk.usage.prompt_tokens;
              if (chunk.usage?.completion_tokens) completionTokens = chunk.usage.completion_tokens;
              const deltaText = chunk.choices?.[0]?.delta?.content;
              if (typeof deltaText === 'string' && deltaText.length > 0) {
                textChars += deltaText.length;
                writeAnthropicSse(res, 'content_block_delta', {
                  type: 'content_block_delta',
                  index: 0,
                  delta: { type: 'text_delta', text: deltaText },
                });
              }
            };

            if (!first.done && first.value) processChunk(first.value);
            while (true) {
              const next = await iterator.next();
              if (next.done) break;
              processChunk(next.value);
            }

            if (!completionTokens) completionTokens = Math.max(1, Math.ceil(textChars / 4));

            writeAnthropicSse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
            writeAnthropicSse(res, 'message_delta', {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn', stop_sequence: null },
              usage: { output_tokens: completionTokens },
            });
            writeAnthropicSse(res, 'message_stop', { type: 'message_stop' });
            res.end();

            const latencyMs = Date.now() - startMs;
            recordXGatewayKeyUsage(account.id, promptTokens + completionTokens);
            logRequest(
              account.provider,
              modelId,
              null,
              'success',
              promptTokens,
              completionTokens,
              latencyMs,
              null,
              ttfbMs,
              requestedModel === 'auto' ? null : requestedModel,
              null,
              'x-gateway',
            );
          });
          return;
        } catch (err) {
          if (res.headersSent) {
            res.end();
            return;
          }
          lastError = err;
          continue;
        }
      }
    }

    const message = lastError instanceof Error ? lastError.message : 'All X Gateway provider accounts failed.';
    res.status(502).json({
      type: 'error',
      error: { type: 'api_error', message },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. OpenAI Responses API (/x/v1/responses) for Codex CLI
// ─────────────────────────────────────────────────────────────────────────────

function convertResponsesInput(body: Record<string, any>): {
  messages: ChatMessage[];
  tools?: ChatToolDefinition[];
  toolChoice?: ChatToolChoice;
} {
  const messages: ChatMessage[] = [];
  if (typeof body.instructions === 'string' && body.instructions.trim()) {
    messages.push({ role: 'system', content: body.instructions.trim() });
  }

  if (typeof body.input === 'string') {
    messages.push({ role: 'user', content: body.input });
  } else if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (!item || typeof item !== 'object') continue;
      if (item.type === 'function_call') {
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: String(item.call_id ?? item.id ?? `call_${crypto.randomBytes(6).toString('hex')}`),
              type: 'function',
              function: {
                name: String(item.name ?? ''),
                arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
              },
            },
          ],
        });
        continue;
      }
      if (item.type === 'function_call_output') {
        const output =
          typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '');
        messages.push({
          role: 'tool',
          tool_call_id: String(item.call_id ?? ''),
          content: output,
        });
        continue;
      }
      const role = item.role === 'developer' ? 'system' : item.role;
      if (role !== 'system' && role !== 'user' && role !== 'assistant') continue;
      let text = '';
      if (typeof item.content === 'string') {
        text = item.content;
      } else if (Array.isArray(item.content)) {
        text = item.content
          .map((p: any) => (typeof p?.text === 'string' ? p.text : ''))
          .filter(Boolean)
          .join('');
      }
      if (text) messages.push({ role, content: text });
    }
  }

  const tools: ChatToolDefinition[] | undefined = Array.isArray(body.tools)
    ? body.tools
        .filter((t: any) => t && t.type === 'function' && typeof t.name === 'string')
        .map((t: any) => ({
          type: 'function' as const,
          function: {
            name: t.name,
            ...(typeof t.description === 'string' ? { description: t.description } : {}),
            ...(t.parameters ? { parameters: t.parameters } : {}),
          },
        }))
    : undefined;

  let toolChoice: ChatToolChoice | undefined;
  if (typeof body.tool_choice === 'string') {
    toolChoice = body.tool_choice as ChatToolChoice;
  } else if (body.tool_choice?.type === 'function' && typeof body.tool_choice.name === 'string') {
    toolChoice = { type: 'function', function: { name: body.tool_choice.name } };
  }

  return { messages, tools: tools?.length ? tools : undefined, toolChoice };
}

function buildResponsesPayload(opts: {
  id: string;
  model: string;
  text: string;
  toolCalls: ChatToolCall[];
  promptTokens: number;
  completionTokens: number;
}) {
  const output: Array<Record<string, unknown>> = [];
  if (opts.text.length > 0 || opts.toolCalls.length === 0) {
    output.push({
      type: 'message',
      id: `msg_${crypto.randomBytes(12).toString('hex')}`,
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: opts.text, annotations: [] }],
    });
  }
  for (const tc of opts.toolCalls) {
    output.push({
      type: 'function_call',
      id: `fc_${crypto.randomBytes(12).toString('hex')}`,
      call_id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
      status: 'completed',
    });
  }
  return {
    id: opts.id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: opts.model,
    output,
    output_text: opts.text,
    usage: {
      input_tokens: opts.promptTokens,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: opts.completionTokens,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: opts.promptTokens + opts.completionTokens,
    },
  };
}

xGatewayProtocolsRouter.post('/responses', xGatewayAuth, async (req: Request, res: Response) => {
  const startMs = Date.now();
  const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, any>) : {};
  const converted = convertResponsesInput(body);
  if (converted.messages.length === 0) {
    res.status(400).json({
      error: { message: 'input is required', type: 'invalid_request_error' },
    });
    return;
  }

  const requestedModel = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : 'auto';
  const isStream = body.stream === true;
  const { messages, appliedSavers } = applyGatewaySavers(req, converted.messages);

  const scope = {
    gateway: 'x' as const,
    outputSavers: appliedSavers,
    inputSaver: getConfigSnapshot().savers.input,
    inputTokensSaved: 0,
  };

  res.setHeader('X-Gateway', 'x');
  res.setHeader('X-Output-Saver-Applied', appliedSavers.join(','));
  res.setHeader('X-Input-Tokens-Saved', '0');

  await runInGatewayScope(scope, async () => {
    const { candidates, notFoundError } = resolveCandidateRoutes(requestedModel);
    if (notFoundError) {
      res.status(404).json({
        error: { message: notFoundError, type: 'invalid_request_error', code: 'model_not_found' },
      });
      return;
    }
    if (candidates.length === 0) {
      res.status(503).json({
        error: {
          message: 'No enabled X Gateway provider accounts available.',
          type: 'service_unavailable',
          code: 'no_available_keys',
        },
      });
      return;
    }

    const options: CompletionOptions = {
      temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
      max_tokens: typeof body.max_output_tokens === 'number' ? body.max_output_tokens : undefined,
      top_p: typeof body.top_p === 'number' ? body.top_p : undefined,
      tools: converted.tools,
      tool_choice: converted.toolChoice,
      parallel_tool_calls: typeof body.parallel_tool_calls === 'boolean' ? body.parallel_tool_calls : undefined,
    };

    const estimatedPromptTokens = estimateInputTokens(messages, converted.tools);
    const responseId = `resp_${crypto.randomBytes(12).toString('hex')}`;
    let lastError: unknown = null;

    for (const { account, modelId } of candidates) {
      const provider = resolveXGatewayProvider(account.provider, account.base_url);
      if (!provider) continue;

      let credential: string;
      try {
        credential = decrypt(account.encrypted_key, account.iv, account.auth_tag);
      } catch (err) {
        lastError = err;
        continue;
      }

      const effectiveProxy = resolveXGatewayAccountProxy(account);

      if (!isStream) {
        try {
          const completion = await withKeyProxy(effectiveProxy, () =>
            provider.chatCompletion(credential, messages, modelId, options, {
              platform: account.platform,
              keyId: account.id,
              modelId,
            }),
          );

          const latencyMs = Date.now() - startMs;
          const respMsg = completion.choices?.[0]?.message;
          const text = contentToString(respMsg?.content ?? '');
          const toolCalls = respMsg?.tool_calls ?? [];
          const promptTokens = completion.usage?.prompt_tokens ?? estimatedPromptTokens;
          const completionTokens =
            completion.usage?.completion_tokens ?? Math.max(1, Math.ceil(text.length / 4));

          recordXGatewayKeyUsage(account.id, promptTokens + completionTokens);
          logRequest(
            account.provider,
            modelId,
            null,
            'success',
            promptTokens,
            completionTokens,
            latencyMs,
            null,
            latencyMs,
            requestedModel === 'auto' ? null : requestedModel,
            null,
            'x-gateway',
          );

          res.setHeader('X-Routed-Via', `${account.provider}/${modelId}`);
          res.status(200).json(
            buildResponsesPayload({
              id: responseId,
              model: modelId,
              text,
              toolCalls,
              promptTokens,
              completionTokens,
            }),
          );
          return;
        } catch (err) {
          lastError = err;
          continue;
        }
      } else {
        try {
          await withKeyProxy(effectiveProxy, async () => {
            const stream = provider.streamChatCompletion(credential, messages, modelId, options, {
              platform: account.platform,
              keyId: account.id,
              modelId,
            });
            const iterator = stream[Symbol.asyncIterator]();
            const first = await iterator.next();

            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Routed-Via', `${account.provider}/${modelId}`);

            const ttfbMs = Date.now() - startMs;
            const msgItemId = `msg_${crypto.randomBytes(12).toString('hex')}`;
            let promptTokens = estimatedPromptTokens;
            let completionTokens = 0;
            let fullText = '';

            const writeEvent = (event: string, data: unknown) => {
              res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            };

            writeEvent('response.created', {
              type: 'response.created',
              response: {
                id: responseId,
                object: 'response',
                created_at: Math.floor(Date.now() / 1000),
                status: 'in_progress',
                model: modelId,
                output: [],
              },
            });

            writeEvent('response.output_item.added', {
              type: 'response.output_item.added',
              output_index: 0,
              item: {
                id: msgItemId,
                type: 'message',
                status: 'in_progress',
                role: 'assistant',
                content: [],
              },
            });

            const processChunk = (chunk: any) => {
              if (!chunk) return;
              if (chunk.usage?.prompt_tokens) promptTokens = chunk.usage.prompt_tokens;
              if (chunk.usage?.completion_tokens) completionTokens = chunk.usage.completion_tokens;
              const delta = chunk.choices?.[0]?.delta?.content;
              if (typeof delta === 'string' && delta.length > 0) {
                fullText += delta;
                writeEvent('response.output_text.delta', {
                  type: 'response.output_text.delta',
                  item_id: msgItemId,
                  output_index: 0,
                  content_index: 0,
                  delta,
                });
              }
            };

            if (!first.done && first.value) processChunk(first.value);
            while (true) {
              const next = await iterator.next();
              if (next.done) break;
              processChunk(next.value);
            }

            if (!completionTokens) completionTokens = Math.max(1, Math.ceil(fullText.length / 4));

            writeEvent('response.output_text.done', {
              type: 'response.output_text.done',
              item_id: msgItemId,
              output_index: 0,
              content_index: 0,
              text: fullText,
            });

            const completed = buildResponsesPayload({
              id: responseId,
              model: modelId,
              text: fullText,
              toolCalls: [],
              promptTokens,
              completionTokens,
            });
            writeEvent('response.completed', { type: 'response.completed', response: completed });
            res.end();

            const latencyMs = Date.now() - startMs;
            recordXGatewayKeyUsage(account.id, promptTokens + completionTokens);
            logRequest(
              account.provider,
              modelId,
              null,
              'success',
              promptTokens,
              completionTokens,
              latencyMs,
              null,
              ttfbMs,
              requestedModel === 'auto' ? null : requestedModel,
              null,
              'x-gateway',
            );
          });
          return;
        } catch (err) {
          if (res.headersSent) {
            res.end();
            return;
          }
          lastError = err;
          continue;
        }
      }
    }

    const message = lastError instanceof Error ? lastError.message : 'All X Gateway provider accounts failed.';
    res.status(502).json({
      error: { message, type: 'upstream_error' },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Legacy OpenAI Completions (/x/v1/completions) for Continue / Autocomplete
// ─────────────────────────────────────────────────────────────────────────────

xGatewayProtocolsRouter.post('/completions', xGatewayAuth, async (req: Request, res: Response) => {
  const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, any>) : {};
  const prompt = typeof body.prompt === 'string' ? body.prompt : Array.isArray(body.prompt) ? body.prompt.join('\n') : '';
  if (!prompt) {
    res.status(400).json({
      error: { message: 'prompt is required', type: 'invalid_request_error' },
    });
    return;
  }

  const suffix = typeof body.suffix === 'string' && body.suffix.length > 0 ? body.suffix : undefined;
  const requestedModel = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : 'auto';
  const isStream = body.stream === true;

  const rawMessages: ChatMessage[] = [
    {
      role: 'system',
      content:
        'You are a code autocomplete engine. Complete at the cursor and return only the text to insert. Do not include markdown fences or explanations.',
    },
    {
      role: 'user',
      content: suffix
        ? `Prefix before cursor:\n${prompt}\n\nSuffix after cursor:\n${suffix}\n\nCompletion to insert:`
        : prompt,
    },
  ];

  res.setHeader('X-Gateway', 'x');
  const { candidates, notFoundError } = resolveCandidateRoutes(requestedModel);
  if (notFoundError) {
    res.status(404).json({
      error: { message: notFoundError, type: 'invalid_request_error', code: 'model_not_found' },
    });
    return;
  }
  if (candidates.length === 0) {
    res.status(503).json({
      error: { message: 'No enabled X Gateway provider accounts available.', type: 'service_unavailable' },
    });
    return;
  }

  const options: CompletionOptions = {
    temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
    max_tokens: typeof body.max_tokens === 'number' && body.max_tokens > 0 ? body.max_tokens : 256,
    top_p: typeof body.top_p === 'number' ? body.top_p : undefined,
    stop: typeof body.stop === 'string' || Array.isArray(body.stop) ? body.stop : undefined,
  };

  let lastError: unknown = null;
  for (const { account, modelId } of candidates) {
    const provider = resolveXGatewayProvider(account.provider, account.base_url);
    if (!provider) continue;
    let credential: string;
    try {
      credential = decrypt(account.encrypted_key, account.iv, account.auth_tag);
    } catch (err) {
      lastError = err;
      continue;
    }

    const effectiveProxy = resolveXGatewayAccountProxy(account);
    if (!isStream) {
      try {
        const completion = await withKeyProxy(effectiveProxy, () =>
          provider.chatCompletion(credential, rawMessages, modelId, options),
        );
        const text = contentToString(completion.choices?.[0]?.message?.content ?? '');
        const promptTokens = completion.usage?.prompt_tokens ?? estimateInputTokens(rawMessages);
        const completionTokens = completion.usage?.completion_tokens ?? Math.max(1, Math.ceil(text.length / 4));
        recordXGatewayKeyUsage(account.id, promptTokens + completionTokens);
        res.setHeader('X-Routed-Via', `${account.provider}/${modelId}`);
        res.json({
          id: `cmpl-${crypto.randomBytes(10).toString('hex')}`,
          object: 'text_completion',
          created: Math.floor(Date.now() / 1000),
          model: modelId,
          choices: [
            {
              text,
              index: 0,
              logprobs: null,
              finish_reason: completion.choices?.[0]?.finish_reason ?? 'stop',
            },
          ],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
          },
        });
        return;
      } catch (err) {
        lastError = err;
        continue;
      }
    } else {
      try {
        await withKeyProxy(effectiveProxy, async () => {
          const stream = provider.streamChatCompletion(credential, rawMessages, modelId, options);
          const iterator = stream[Symbol.asyncIterator]();
          const first = await iterator.next();

          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('X-Routed-Via', `${account.provider}/${modelId}`);

          const cmplId = `cmpl-${crypto.randomBytes(10).toString('hex')}`;
          const created = Math.floor(Date.now() / 1000);
          let chars = 0;

          const emit = (chunk: any) => {
            const deltaText = chunk?.choices?.[0]?.delta?.content ?? '';
            const finish = chunk?.choices?.[0]?.finish_reason ?? null;
            if (!deltaText && !finish) return;
            chars += deltaText.length;
            res.write(
              `data: ${JSON.stringify({
                id: cmplId,
                object: 'text_completion',
                created,
                model: modelId,
                choices: [{ text: deltaText, index: 0, logprobs: null, finish_reason: finish }],
              })}\n\n`,
            );
          };

          if (!first.done && first.value) emit(first.value);
          while (true) {
            const next = await iterator.next();
            if (next.done) break;
            emit(next.value);
          }
          res.write('data: [DONE]\n\n');
          res.end();
          recordXGatewayKeyUsage(account.id, estimateInputTokens(rawMessages) + Math.max(1, Math.ceil(chars / 4)));
        });
        return;
      } catch (err) {
        if (res.headersSent) {
          res.end();
          return;
        }
        lastError = err;
        continue;
      }
    }
  }

  const message = lastError instanceof Error ? lastError.message : 'All X Gateway provider accounts failed.';
  res.status(502).json({ error: { message, type: 'upstream_error' } });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Auxiliary OpenAI Endpoints (/x/v1/embeddings, /x/v1/images/generations,
//    /x/v1/audio/speech, /x/v1/audio/transcriptions)
// ─────────────────────────────────────────────────────────────────────────────

function accountBaseUrl(account: { provider: string; base_url: string | null }): string | null {
  const customUrl = account.base_url?.trim();
  if (customUrl) return customUrl.replace(/\/+$/, '');
  const entry = getXGatewayProvider(account.provider);
  return entry?.baseUrl ? entry.baseUrl.trim().replace(/\/+$/, '') : null;
}

xGatewayProtocolsRouter.post('/embeddings', xGatewayAuth, async (req: Request, res: Response) => {
  res.setHeader('X-Gateway', 'x');
  const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, any>) : {};
  if (body.input === undefined || body.input === null || body.input === '') {
    res.status(400).json({ error: { message: 'input is required', type: 'invalid_request_error' } });
    return;
  }

  const requestedModel = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : 'auto';
  const { candidates, notFoundError } = resolveCandidateRoutes(requestedModel);
  if (notFoundError) {
    res.status(404).json({ error: { message: notFoundError, type: 'invalid_request_error', code: 'model_not_found' } });
    return;
  }
  if (candidates.length === 0) {
    res.status(503).json({ error: { message: 'No enabled X Gateway provider accounts available.', type: 'service_unavailable' } });
    return;
  }

  let lastError: unknown = null;
  for (const { account, modelId } of candidates) {
    const baseUrl = accountBaseUrl(account);
    if (!baseUrl) continue;
    let credential: string;
    try {
      credential = decrypt(account.encrypted_key, account.iv, account.auth_tag);
    } catch (err) {
      lastError = err;
      continue;
    }

    const effectiveProxy = resolveXGatewayAccountProxy(account);
    try {
      const upstreamRes = await withKeyProxy(effectiveProxy, () =>
        proxyFetch(
          `${baseUrl}/embeddings`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${credential}`,
            },
            body: JSON.stringify({
              ...body,
              model: requestedModel === 'auto' ? modelId : body.model,
            }),
          },
          account.platform,
          'embedding',
          60_000,
        ),
      );
      if (!upstreamRes.ok) {
        const text = await upstreamRes.text().catch(() => '');
        throw new Error(`HTTP ${upstreamRes.status}: ${text.slice(0, 200)}`);
      }
      const data = (await upstreamRes.json()) as Record<string, any>;
      const tokens = Number(data.usage?.total_tokens ?? data.usage?.prompt_tokens ?? 10);
      recordXGatewayKeyUsage(account.id, tokens);
      res.setHeader('X-Routed-Via', `${account.provider}/${modelId}`);
      res.status(200).json(data);
      return;
    } catch (err) {
      lastError = err;
      continue;
    }
  }

  const message = lastError instanceof Error ? lastError.message : 'All X Gateway embedding accounts failed.';
  res.status(502).json({ error: { message, type: 'upstream_error' } });
});

xGatewayProtocolsRouter.post('/images/generations', xGatewayAuth, async (req: Request, res: Response) => {
  res.setHeader('X-Gateway', 'x');
  const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, any>) : {};
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) {
    res.status(400).json({ error: { message: 'prompt is required', type: 'invalid_request_error' } });
    return;
  }

  const requestedModel = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : 'auto';
  const { candidates, notFoundError } = resolveCandidateRoutes(requestedModel);
  if (notFoundError) {
    res.status(404).json({ error: { message: notFoundError, type: 'invalid_request_error', code: 'model_not_found' } });
    return;
  }
  if (candidates.length === 0) {
    res.status(503).json({ error: { message: 'No enabled X Gateway provider accounts available.', type: 'service_unavailable' } });
    return;
  }

  let lastError: unknown = null;
  for (const { account, modelId } of candidates) {
    const baseUrl = accountBaseUrl(account);
    if (!baseUrl) continue;
    let credential: string;
    try {
      credential = decrypt(account.encrypted_key, account.iv, account.auth_tag);
    } catch (err) {
      lastError = err;
      continue;
    }

    const effectiveProxy = resolveXGatewayAccountProxy(account);
    try {
      const upstreamRes = await withKeyProxy(effectiveProxy, () =>
        proxyFetch(
          `${baseUrl}/images/generations`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${credential}`,
            },
            body: JSON.stringify({
              ...body,
              model: requestedModel === 'auto' ? modelId : body.model,
            }),
          },
          account.platform,
          'image',
          120_000,
        ),
      );
      if (!upstreamRes.ok) {
        const text = await upstreamRes.text().catch(() => '');
        throw new Error(`HTTP ${upstreamRes.status}: ${text.slice(0, 200)}`);
      }
      const data = await upstreamRes.json();
      recordXGatewayKeyUsage(account.id, 1);
      res.setHeader('X-Routed-Via', `${account.provider}/${modelId}`);
      res.status(200).json(data);
      return;
    } catch (err) {
      lastError = err;
      continue;
    }
  }

  const message = lastError instanceof Error ? lastError.message : 'All X Gateway image generation accounts failed.';
  res.status(502).json({ error: { message, type: 'upstream_error' } });
});

xGatewayProtocolsRouter.post('/audio/speech', xGatewayAuth, async (req: Request, res: Response) => {
  res.setHeader('X-Gateway', 'x');
  const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, any>) : {};
  if (typeof body.input !== 'string' || !body.input.trim()) {
    res.status(400).json({ error: { message: 'input is required', type: 'invalid_request_error' } });
    return;
  }

  const requestedModel = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : 'auto';
  const { candidates, notFoundError } = resolveCandidateRoutes(requestedModel);
  if (notFoundError) {
    res.status(404).json({ error: { message: notFoundError, type: 'invalid_request_error', code: 'model_not_found' } });
    return;
  }
  if (candidates.length === 0) {
    res.status(503).json({ error: { message: 'No enabled X Gateway provider accounts available.', type: 'service_unavailable' } });
    return;
  }

  let lastError: unknown = null;
  for (const { account, modelId } of candidates) {
    const baseUrl = accountBaseUrl(account);
    if (!baseUrl) continue;
    let credential: string;
    try {
      credential = decrypt(account.encrypted_key, account.iv, account.auth_tag);
    } catch (err) {
      lastError = err;
      continue;
    }

    const effectiveProxy = resolveXGatewayAccountProxy(account);
    try {
      const upstreamRes = await withKeyProxy(effectiveProxy, () =>
        proxyFetch(
          `${baseUrl}/audio/speech`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${credential}`,
            },
            body: JSON.stringify({
              ...body,
              model: requestedModel === 'auto' ? modelId : body.model,
            }),
          },
          account.platform,
          'audio',
          120_000,
        ),
      );
      if (!upstreamRes.ok) {
        const text = await upstreamRes.text().catch(() => '');
        throw new Error(`HTTP ${upstreamRes.status}: ${text.slice(0, 200)}`);
      }
      const audioBuffer = Buffer.from(await upstreamRes.arrayBuffer());
      recordXGatewayKeyUsage(account.id, Math.max(1, Math.ceil(body.input.length / 4)));
      res.setHeader('Content-Type', upstreamRes.headers.get('content-type') || 'audio/mpeg');
      res.setHeader('X-Routed-Via', `${account.provider}/${modelId}`);
      res.status(200).send(audioBuffer);
      return;
    } catch (err) {
      lastError = err;
      continue;
    }
  }

  const message = lastError instanceof Error ? lastError.message : 'All X Gateway speech accounts failed.';
  res.status(502).json({ error: { message, type: 'upstream_error' } });
});

xGatewayProtocolsRouter.post(
  '/audio/transcriptions',
  xGatewayAuth,
  (req: Request, res: Response, next) => {
    audioUpload.single('file')(req, res, (err: unknown) => {
      if (err) {
        res.status(400).json({ error: { message: 'Invalid multipart audio upload', type: 'invalid_request_error' } });
        return;
      }
      next();
    });
  },
  async (req: Request, res: Response) => {
    res.setHeader('X-Gateway', 'x');
    const file = req.file;
    if (!file || !file.buffer?.length) {
      res.status(400).json({ error: { message: 'file is required', type: 'invalid_request_error' } });
      return;
    }

    const requestedModel =
      typeof req.body?.model === 'string' && req.body.model.trim() ? req.body.model.trim() : 'auto';
    const { candidates, notFoundError } = resolveCandidateRoutes(requestedModel);
    if (notFoundError) {
      res.status(404).json({ error: { message: notFoundError, type: 'invalid_request_error', code: 'model_not_found' } });
      return;
    }
    if (candidates.length === 0) {
      res.status(503).json({ error: { message: 'No enabled X Gateway provider accounts available.', type: 'service_unavailable' } });
      return;
    }

    let lastError: unknown = null;
    for (const { account, modelId } of candidates) {
      const baseUrl = accountBaseUrl(account);
      if (!baseUrl) continue;
      let credential: string;
      try {
        credential = decrypt(account.encrypted_key, account.iv, account.auth_tag);
      } catch (err) {
        lastError = err;
        continue;
      }

      const effectiveProxy = resolveXGatewayAccountProxy(account);
      try {
        const form = new FormData();
        form.append(
          'file',
          new Blob([new Uint8Array(file.buffer)], { type: file.mimetype || 'audio/mpeg' }),
          file.originalname || 'audio.mp3',
        );
        form.append('model', requestedModel === 'auto' ? modelId : requestedModel);
        if (typeof req.body?.language === 'string' && req.body.language) {
          form.append('language', req.body.language);
        }
        if (typeof req.body?.response_format === 'string' && req.body.response_format) {
          form.append('response_format', req.body.response_format);
        }

        const upstreamRes = await withKeyProxy(effectiveProxy, () =>
          proxyFetch(
            `${baseUrl}/audio/transcriptions`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${credential}`,
              },
              body: form,
            },
            account.platform,
            'transcription',
            120_000,
          ),
        );
        if (!upstreamRes.ok) {
          const text = await upstreamRes.text().catch(() => '');
          throw new Error(`HTTP ${upstreamRes.status}: ${text.slice(0, 200)}`);
        }
        const contentType = upstreamRes.headers.get('content-type') || 'application/json';
        const rawBody = await upstreamRes.text();
        recordXGatewayKeyUsage(account.id, 1);
        res.setHeader('X-Routed-Via', `${account.provider}/${modelId}`);
        res.setHeader('Content-Type', contentType);
        res.status(200).send(rawBody);
        return;
      } catch (err) {
        lastError = err;
        continue;
      }
    }

    const message = lastError instanceof Error ? lastError.message : 'All X Gateway transcription accounts failed.';
    res.status(502).json({ error: { message, type: 'upstream_error' } });
  },
);

