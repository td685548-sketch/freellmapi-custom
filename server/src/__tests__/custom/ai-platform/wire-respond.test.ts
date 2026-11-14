import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Response } from 'express';
import { sendText } from '../../../custom/ai-platform/wire/respond.js';

interface MockRes {
  res: Response;
  statusCode: number;
  headers: Record<string, string>;
  chunks: string[];
  jsonBody: unknown;
  ended: boolean;
}

function createMockRes(queryAlt?: string): MockRes {
  const emitter = new EventEmitter();
  const state: MockRes = {
    res: null as unknown as Response,
    statusCode: 200,
    headers: {},
    chunks: [],
    jsonBody: undefined,
    ended: false,
  };
  const resObj = Object.assign(emitter, {
    status(code: number) {
      state.statusCode = code;
      return resObj;
    },
    setHeader(name: string, value: string | string[]) {
      state.headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
      return resObj;
    },
    getHeader(name: string) {
      return state.headers[name.toLowerCase()];
    },
    json(body: unknown) {
      state.jsonBody = body;
      state.ended = true;
      return resObj;
    },
    write(chunk: string | Buffer) {
      state.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk);
      return true;
    },
    end(chunk?: string | Buffer) {
      if (chunk !== undefined) {
        state.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk);
      }
      state.ended = true;
      return resObj;
    },
    ...(queryAlt !== undefined ? { req: { query: { alt: queryAlt } } } : {}),
  });
  state.res = resObj as unknown as Response;
  return state;
}

function parseSseFrames(raw: string): Array<{ event?: string; data: string }> {
  const frames: Array<{ event?: string; data: string }> = [];
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    let event: string | undefined;
    const dataLines: string[] = [];
    for (const line of trimmed.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length > 0) frames.push({ event, data: dataLines.join('\n') });
  }
  return frames;
}

const sampleUsage = { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 };

describe('wire/respond sendText', () => {
  it('sends non-stream responses with stop and content_filter across all 4 wires', () => {
    const oai = createMockRes();
    sendText(oai.res, 'openai-chat', false, 'Blocked', {
      model: 'gpt-4o',
      finish: 'content_filter',
      usage: sampleUsage,
    });
    expect(oai.statusCode).toBe(200);
    expect(oai.jsonBody).toMatchObject({
      object: 'chat.completion',
      model: 'gpt-4o',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Blocked' }, finish_reason: 'content_filter' }],
      usage: sampleUsage,
    });

    const ant = createMockRes();
    sendText(ant.res, 'anthropic', false, 'Refused', {
      model: 'claude-3-5-sonnet-20241022',
      finish: 'content_filter',
      usage: sampleUsage,
    });
    expect(ant.jsonBody).toMatchObject({
      type: 'message',
      role: 'assistant',
      model: 'claude-3-5-sonnet-20241022',
      content: [{ type: 'text', text: 'Refused' }],
      stop_reason: 'refusal',
      usage: { input_tokens: 12, output_tokens: 8 },
    });

    const resp = createMockRes();
    sendText(resp.res, 'responses', false, 'Filtered', {
      model: 'gpt-4o',
      finish: 'content_filter',
      usage: sampleUsage,
    });
    expect(resp.jsonBody).toMatchObject({
      object: 'response',
      status: 'incomplete',
      incomplete_details: { reason: 'content_filter' },
      model: 'gpt-4o',
      output_text: 'Filtered',
      usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
    });

    const gem = createMockRes();
    sendText(gem.res, 'gemini', false, 'Safe', {
      model: 'gemini-2.5-flash',
      finish: 'stop',
      usage: sampleUsage,
    });
    expect(gem.jsonBody).toMatchObject({
      candidates: [{ content: { role: 'model', parts: [{ text: 'Safe' }] }, finishReason: 'STOP', index: 0 }],
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8, totalTokenCount: 20 },
      modelVersion: 'gemini-2.5-flash',
    });
  });

  it('sends valid SSE streams across all 4 wires', () => {
    const oai = createMockRes();
    sendText(oai.res, 'openai-chat', true, 'Hello', { model: 'gpt-4o', finish: 'stop', usage: sampleUsage });
    expect(oai.ended).toBe(true);
    expect(oai.headers['content-type']).toBe('text/event-stream');
    const oaiFrames = parseSseFrames(oai.chunks.join(''));
    expect(oaiFrames.at(-1)?.data).toBe('[DONE]');
    expect(JSON.parse(oaiFrames[1]!.data).choices[0].delta.content).toBe('Hello');

    const ant = createMockRes();
    sendText(ant.res, 'anthropic', true, 'Blocked', {
      model: 'claude-3-5-sonnet',
      finish: 'content_filter',
      usage: sampleUsage,
    });
    const antFrames = parseSseFrames(ant.chunks.join(''));
    expect(antFrames.map((f) => f.event)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    expect(JSON.parse(antFrames[4]!.data).delta.stop_reason).toBe('refusal');

    const resp = createMockRes();
    sendText(resp.res, 'responses', true, 'Filtered', {
      model: 'gpt-4o',
      finish: 'content_filter',
      usage: sampleUsage,
    });
    const respFrames = parseSseFrames(resp.chunks.join(''));
    expect(respFrames.some((f) => f.event === 'response.output_text.delta')).toBe(true);
    expect(respFrames.at(-1)?.event).toBe('response.incomplete');

    const gemSse = createMockRes('sse');
    sendText(gemSse.res, 'gemini', true, 'Blocked', {
      model: 'gemini-2.5-flash',
      finish: 'content_filter',
      usage: sampleUsage,
    });
    const gemFrames = parseSseFrames(gemSse.chunks.join(''));
    expect(JSON.parse(gemFrames[0]!.data).candidates[0].content.parts[0].text).toBe('Blocked');
    expect(JSON.parse(gemFrames[1]!.data).candidates[0].finishReason).toBe('SAFETY');
  });
});
