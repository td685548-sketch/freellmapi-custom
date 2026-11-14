import crypto from 'node:crypto';
import type { Response } from 'express';
import type { Wire } from '@freellmapi/shared/ai-platform.js';
import type { McpLoopResult } from '@freellmapi/shared/ai-platform-mcp.js';
import type { ChatToolCall, TokenUsage } from '@freellmapi/shared/types.js';
import { sendText } from '../wire/respond.js';

function newId(prefix: string): string {
  return `${prefix}${crypto.randomBytes(12).toString('hex')}`;
}

function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

function isGeminiJsonArrayStream(res: Response): boolean {
  const req = (res as { req?: { query?: Record<string, unknown>; originalUrl?: string } }).req;
  if (!req) return false;
  const alt = typeof req.query?.alt === 'string' ? req.query.alt.toLowerCase() : '';
  if (alt === 'sse') return false;
  if (typeof req.originalUrl === 'string' && /[?&]alt=sse(?:&|$)/i.test(req.originalUrl)) return false;
  return true;
}

function startSse(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function extractAssistantText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
        return (part as { text: string }).text;
      }
      return '';
    })
    .filter(Boolean)
    .join('');
}

function sendCallerToolCalls(
  res: Response,
  wire: Wire,
  stream: boolean,
  toolCalls: ChatToolCall[],
  text: string,
  usage: TokenUsage,
  model: string,
): void {
  const promptTokens = usage.prompt_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? 0;
  const totalTokens = usage.total_tokens ?? promptTokens + completionTokens;
  const created = nowUnix();

  if (wire === 'openai-chat') {
    const id = newId('chatcmpl-');
    if (!stream) {
      res.status(200).json({
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: text || null,
              tool_calls: toolCalls,
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage,
      });
      return;
    }

    startSse(res);
    res.write(
      `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: { role: 'assistant', content: text || null }, finish_reason: null }],
      })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: toolCalls.map((tc, index) => ({ index, ...tc })),
            },
            finish_reason: null,
          },
        ],
      })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [],
        usage,
      })}\n\n`,
    );
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  if (wire === 'anthropic') {
    const id = newId('msg_');
    const contentBlocks: Array<Record<string, unknown>> = [];
    if (text) contentBlocks.push({ type: 'text', text });
    for (const tc of toolCalls) {
      contentBlocks.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: parseJsonObject(tc.function.arguments),
      });
    }

    if (!stream) {
      res.status(200).json({
        id,
        type: 'message',
        role: 'assistant',
        model,
        content: contentBlocks,
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: {
          input_tokens: promptTokens,
          output_tokens: completionTokens,
        },
      });
      return;
    }

    startSse(res);
    const sse = (event: string, data: unknown) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    sse('message_start', {
      type: 'message_start',
      message: {
        id,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: promptTokens, output_tokens: 0 },
      },
    });
    let idx = 0;
    if (text) {
      sse('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } });
      sse('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text } });
      sse('content_block_stop', { type: 'content_block_stop', index: idx });
      idx += 1;
    }
    for (const tc of toolCalls) {
      sse('content_block_start', {
        type: 'content_block_start',
        index: idx,
        content_block: { type: 'tool_use', id: tc.id, name: tc.function.name, input: {} },
      });
      sse('content_block_delta', {
        type: 'content_block_delta',
        index: idx,
        delta: { type: 'input_json_delta', partial_json: tc.function.arguments || '{}' },
      });
      sse('content_block_stop', { type: 'content_block_stop', index: idx });
      idx += 1;
    }
    sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { input_tokens: promptTokens, output_tokens: completionTokens },
    });
    sse('message_stop', { type: 'message_stop' });
    res.end();
    return;
  }

  if (wire === 'responses') {
    const respId = newId('resp_');
    const outputItems: Array<Record<string, unknown>> = [];
    if (text) {
      outputItems.push({
        type: 'message',
        id: newId('msg_'),
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }],
      });
    }
    for (const tc of toolCalls) {
      outputItems.push({
        type: 'function_call',
        id: newId('fc_'),
        call_id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments || '{}',
        status: 'completed',
      });
    }

    const finalObj = {
      id: respId,
      object: 'response',
      created_at: created,
      status: 'completed',
      model,
      output: outputItems,
      output_text: text,
      usage: {
        input_tokens: promptTokens,
        input_tokens_details: { cached_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0 },
        output_tokens: completionTokens,
        output_tokens_details: { reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens ?? 0 },
        total_tokens: totalTokens,
      },
    };

    if (!stream) {
      res.status(200).json(finalObj);
      return;
    }

    startSse(res);
    let seq = 0;
    const sse = (event: string, payload: Record<string, unknown>) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify({ type: event, sequence_number: seq++, ...payload })}\n\n`);
    };
    const skeleton = {
      id: respId,
      object: 'response',
      created_at: created,
      status: 'in_progress',
      model,
      output: [],
      output_text: '',
    };
    sse('response.created', { response: skeleton });
    sse('response.in_progress', { response: skeleton });
    outputItems.forEach((item, outputIndex) => {
      sse('response.output_item.added', { output_index: outputIndex, item });
      sse('response.output_item.done', { output_index: outputIndex, item });
    });
    sse('response.completed', { response: finalObj });
    res.end();
    return;
  }

  // Gemini
  const parts: Array<Record<string, unknown>> = [];
  if (text) parts.push({ text });
  for (const tc of toolCalls) {
    parts.push({
      functionCall: {
        name: tc.function.name,
        args: parseJsonObject(tc.function.arguments),
      },
    });
  }
  const usageMetadata = {
    promptTokenCount: promptTokens,
    candidatesTokenCount: completionTokens,
    totalTokenCount: totalTokens,
  };

  if (!stream) {
    res.status(200).json({
      candidates: [
        {
          content: { role: 'model', parts },
          finishReason: 'STOP',
          index: 0,
        },
      ],
      usageMetadata,
      modelVersion: model,
    });
    return;
  }

  const events = [
    {
      candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP', index: 0 }],
      usageMetadata,
      modelVersion: model,
    },
  ];

  if (isGeminiJsonArrayStream(res)) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-cache');
    res.write(`[\n${JSON.stringify(events[0])}\n]`);
    res.end();
    return;
  }

  startSse(res);
  res.write(`data: ${JSON.stringify(events[0])}\n\n`);
  res.end();
}

/**
 * Serializes the final `McpLoopResult` onto the HTTP response in the caller's wire protocol,
 * handling both caller-owned tool calls (`tool_calls`/`tool_use`/`functionCall`) and text replies.
 */
export function sendMcpLoopResult(
  res: Response,
  wire: Wire,
  stream: boolean,
  result: McpLoopResult,
  model: string,
): void {
  const text = extractAssistantText(result.message.content);
  if (result.callerToolCalls && result.callerToolCalls.length > 0) {
    sendCallerToolCalls(res, wire, stream, result.callerToolCalls, text, result.usage, model);
    return;
  }

  const outText =
    text ||
    (result.pendingApprovalId != null
      ? `Tool execution requires administrator approval (approval_id: ${result.pendingApprovalId}).`
      : '');
  const finish = result.finishReason === 'content_filter' ? 'content_filter' : 'stop';
  sendText(res, wire, stream, outText, {
    model,
    finish,
    usage: result.usage,
  });
}
