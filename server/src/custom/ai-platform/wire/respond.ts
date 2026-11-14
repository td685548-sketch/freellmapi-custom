import crypto from 'node:crypto';
import type { Response } from 'express';
import type { TokenUsage } from '@freellmapi/shared/types.js';
import type { Wire } from './detect.js';

export type Usage = TokenUsage;

function newId(prefix: string): string {
  return `${prefix}${crypto.randomBytes(12).toString('hex')}`;
}

function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

function resolveUsage(usage?: Usage): { promptTokens: number; completionTokens: number; totalTokens: number } {
  const promptTokens = usage?.prompt_tokens ?? 0;
  const completionTokens = usage?.completion_tokens ?? 0;
  const totalTokens = usage?.total_tokens ?? promptTokens + completionTokens;
  return { promptTokens, completionTokens, totalTokens };
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

/**
 * Sends a synthetic text response (non-stream or stream) formatted in the specified wire protocol.
 */
export function sendText(
  res: Response,
  wire: Wire,
  stream: boolean,
  text: string,
  meta: { model: string; finish: 'stop' | 'content_filter'; usage?: Usage },
): void {
  const { promptTokens, completionTokens, totalTokens } = resolveUsage(meta.usage);
  const created = nowUnix();

  if (wire === 'openai-chat') {
    const id = newId('chatcmpl-');
    if (!stream) {
      res.status(200).json({
        id,
        object: 'chat.completion',
        created,
        model: meta.model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: text },
            finish_reason: meta.finish,
          },
        ],
        usage: meta.usage ?? {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: totalTokens,
        },
      });
      return;
    }

    startSse(res);
    res.write(
      `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model: meta.model,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      })}\n\n`,
    );
    if (text.length > 0) {
      res.write(
        `data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model: meta.model,
          choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
        })}\n\n`,
      );
    }
    res.write(
      `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model: meta.model,
        choices: [{ index: 0, delta: {}, finish_reason: meta.finish }],
      })}\n\n`,
    );
    if (meta.usage) {
      res.write(
        `data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model: meta.model,
          choices: [],
          usage: meta.usage,
        })}\n\n`,
      );
    }
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  if (wire === 'anthropic') {
    const id = newId('msg_');
    const stopReason = meta.finish === 'content_filter' ? 'refusal' : 'end_turn';
    if (!stream) {
      res.status(200).json({
        id,
        type: 'message',
        role: 'assistant',
        model: meta.model,
        content: [{ type: 'text', text }],
        stop_reason: stopReason,
        stop_sequence: null,
        usage: {
          input_tokens: promptTokens,
          output_tokens: completionTokens,
          ...(meta.usage?.prompt_tokens_details?.cached_tokens
            ? { cache_read_input_tokens: meta.usage.prompt_tokens_details.cached_tokens }
            : {}),
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
        model: meta.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: promptTokens, output_tokens: 0 },
      },
    });
    sse('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    });
    sse('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    });
    sse('content_block_stop', { type: 'content_block_stop', index: 0 });
    sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { input_tokens: promptTokens, output_tokens: completionTokens },
    });
    sse('message_stop', { type: 'message_stop' });
    res.end();
    return;
  }

  if (wire === 'responses') {
    const respId = newId('resp_');
    const msgId = newId('msg_');
    const isFilter = meta.finish === 'content_filter';
    const status = isFilter ? 'incomplete' : 'completed';
    const item = {
      type: 'message',
      id: msgId,
      status,
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    };
    const finalObj = {
      id: respId,
      object: 'response',
      created_at: created,
      status,
      ...(isFilter ? { incomplete_details: { reason: 'content_filter' } } : {}),
      model: meta.model,
      output: [item],
      output_text: text,
      usage: {
        input_tokens: promptTokens,
        input_tokens_details: { cached_tokens: meta.usage?.prompt_tokens_details?.cached_tokens ?? 0 },
        output_tokens: completionTokens,
        output_tokens_details: { reasoning_tokens: meta.usage?.completion_tokens_details?.reasoning_tokens ?? 0 },
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
      model: meta.model,
      output: [],
      output_text: '',
    };
    sse('response.created', { response: skeleton });
    sse('response.in_progress', { response: skeleton });
    sse('response.output_item.added', {
      output_index: 0,
      item: { id: msgId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
    });
    sse('response.content_part.added', {
      item_id: msgId,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    });
    sse('response.output_text.delta', {
      item_id: msgId,
      output_index: 0,
      content_index: 0,
      delta: text,
    });
    sse('response.output_text.done', {
      item_id: msgId,
      output_index: 0,
      content_index: 0,
      text,
    });
    sse('response.content_part.done', {
      item_id: msgId,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text, annotations: [] },
    });
    sse('response.output_item.done', { output_index: 0, item });
    sse(isFilter ? 'response.incomplete' : 'response.completed', { response: finalObj });
    res.end();
    return;
  }

  // Gemini
  const finishReason = meta.finish === 'content_filter' ? 'SAFETY' : 'STOP';
  const usageMetadata = {
    promptTokenCount: promptTokens,
    candidatesTokenCount: completionTokens,
    totalTokenCount: totalTokens,
  };

  if (!stream) {
    res.status(200).json({
      candidates: [
        {
          content: { role: 'model', parts: [{ text }] },
          finishReason,
          index: 0,
        },
      ],
      usageMetadata,
      modelVersion: meta.model,
    });
    return;
  }

  const events = [
    {
      candidates: [{ content: { role: 'model', parts: [{ text }] }, index: 0 }],
    },
    {
      candidates: [{ content: { role: 'model', parts: [] }, finishReason, index: 0 }],
      usageMetadata,
      modelVersion: meta.model,
    },
  ];

  if (isGeminiJsonArrayStream(res)) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-cache');
    res.write(`[\n${JSON.stringify(events[0])},\n${JSON.stringify(events[1])}\n]`);
    res.end();
    return;
  }

  startSse(res);
  for (const ev of events) {
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  }
  res.end();
}
