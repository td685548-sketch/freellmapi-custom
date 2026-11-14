import { describe, it, expect } from 'vitest';
import type { Request } from 'express';
import type { ChatToolDefinition } from '@freellmapi/shared/types.js';
import { detectWire } from '../../../custom/ai-platform/wire/detect.js';
import {
  addSystemBlock,
  addTools,
  lastUserText,
  requestedModel,
  setRequestedModel,
} from '../../../custom/ai-platform/wire/extract.js';

function makeReq(opts: {
  method?: string;
  originalUrl: string;
  body?: unknown;
}): Request {
  const [pathPart] = opts.originalUrl.split('?');
  return {
    method: opts.method ?? 'POST',
    originalUrl: opts.originalUrl,
    url: opts.originalUrl,
    path: pathPart,
    body: opts.body,
  } as unknown as Request;
}

describe('wire/detect', () => {
  it('detects all 4 protocols with stream flags and query strings', () => {
    expect(detectWire(makeReq({ originalUrl: '/v1/chat/completions', body: { stream: false } }))).toEqual({
      wire: 'openai-chat',
      stream: false,
    });
    expect(detectWire(makeReq({ originalUrl: '/v1/chat/completions/', body: { stream: true } }))).toEqual({
      wire: 'openai-chat',
      stream: true,
    });
    expect(detectWire(makeReq({ originalUrl: '/v1/messages', body: { stream: true } }))).toEqual({
      wire: 'anthropic',
      stream: true,
    });
    expect(detectWire(makeReq({ originalUrl: '/v1/responses?foo=1', body: {} }))).toEqual({
      wire: 'responses',
      stream: false,
    });
    expect(
      detectWire(makeReq({ originalUrl: '/v1beta/models/gemini-2.5-flash:generateContent', body: {} })),
    ).toEqual({
      wire: 'gemini',
      stream: false,
    });
    expect(
      detectWire(makeReq({ originalUrl: '/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse', body: {} })),
    ).toEqual({
      wire: 'gemini',
      stream: true,
    });
  });

  it('returns null for non-POST or non-chat paths', () => {
    expect(detectWire(makeReq({ method: 'GET', originalUrl: '/v1/chat/completions' }))).toBeNull();
    expect(detectWire(makeReq({ originalUrl: '/v1/models' }))).toBeNull();
    expect(detectWire(makeReq({ originalUrl: '/thruline/v1/chat/completions' }))).toBeNull();
    expect(detectWire(makeReq({ originalUrl: '/v1beta/models/gemini-2.5-flash:countTokens' }))).toBeNull();
  });
});

describe('wire/extract lastUserText', () => {
  it('extracts last user text across all 4 wires including multimodal blocks', () => {
    expect(
      lastUserText('openai-chat', {
        messages: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'reply' },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'second' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
              { type: 'text', text: 'part' },
            ],
          },
        ],
      }),
    ).toBe('second part');

    expect(
      lastUserText('anthropic', {
        messages: [
          { role: 'user', content: 'early' },
          { role: 'assistant', content: [{ type: 'tool_use', id: '1', name: 'f', input: {} }] },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: '1', content: 'ignored tool output' },
              { type: 'text', text: 'follow up' },
            ],
          },
        ],
      }),
    ).toBe('follow up');

    expect(lastUserText('responses', { input: 'direct string' })).toBe('direct string');
    expect(
      lastUserText('responses', {
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ask' }] },
          { type: 'function_call_output', call_id: 'c1', output: 'ignored' },
        ],
      }),
    ).toBe('ask');

    expect(
      lastUserText('gemini', {
        contents: [
          { role: 'user', parts: [{ text: 'old' }] },
          { role: 'model', parts: [{ text: 'ans' }] },
          { role: 'user', parts: [{ text: 'thought', thought: true }, { text: 'latest' }] },
        ],
      }),
    ).toBe('latest');
  });
});

describe('wire/extract requestedModel & setRequestedModel', () => {
  it('reads and updates model on body-based wires', () => {
    const req = makeReq({ originalUrl: '/v1/chat/completions', body: { model: 'gpt-4o', messages: [] } });
    expect(requestedModel('openai-chat', req)).toBe('gpt-4o');
    setRequestedModel('openai-chat', req, 'flow:triage');
    expect(requestedModel('openai-chat', req)).toBe('flow:triage');
    expect((req.body as Record<string, unknown>).model).toBe('flow:triage');
  });

  it('reads and updates model in URL for Gemini while preserving action and query', () => {
    const req = makeReq({
      originalUrl: '/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse',
      body: { contents: [] },
    });
    expect(requestedModel('gemini', req)).toBe('gemini-2.5-flash');
    setRequestedModel('gemini', req, 'gemini-2.5-pro');
    expect(requestedModel('gemini', req)).toBe('gemini-2.5-pro');
    expect(req.originalUrl).toBe('/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse');
    expect(req.url).toBe('/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse');
  });
});

describe('wire/extract addSystemBlock', () => {
  it('places stable blocks before volatile blocks across all 4 wires', () => {
    const openaiBody: { messages: Array<{ role: string; content: string }>; extra: boolean } = {
      messages: [{ role: 'user', content: 'hi' }],
      extra: true,
    };
    addSystemBlock('openai-chat', openaiBody, 'rag-ctx', 'volatile');
    addSystemBlock('openai-chat', openaiBody, 'sys-prompt', 'stable');
    expect(openaiBody.messages.map((m) => m.content)).toEqual(['sys-prompt', 'rag-ctx', 'hi']);
    expect(openaiBody.extra).toBe(true);

    const anthropicBody: { system: Array<{ type: string; text: string }> } = { system: [] };
    addSystemBlock('anthropic', anthropicBody, 'rag-ctx', 'volatile');
    addSystemBlock('anthropic', anthropicBody, 'sys-prompt', 'stable');
    expect(anthropicBody.system.map((b) => b.text)).toEqual(['sys-prompt', 'rag-ctx']);

    const responsesBody: { instructions?: string } = { instructions: 'caller' };
    addSystemBlock('responses', responsesBody, 'rag-ctx', 'volatile');
    addSystemBlock('responses', responsesBody, 'sys-prompt', 'stable');
    expect(responsesBody.instructions).toBe('sys-prompt\n\ncaller\n\nrag-ctx');

    const geminiBody: { systemInstruction?: { parts: Array<{ text: string }> } } = {};
    addSystemBlock('gemini', geminiBody, 'rag-ctx', 'volatile');
    addSystemBlock('gemini', geminiBody, 'sys-prompt', 'stable');
    expect(geminiBody.systemInstruction?.parts.map((p) => p.text)).toEqual(['sys-prompt', 'rag-ctx']);
  });
});

describe('wire/extract addTools', () => {
  const tools: ChatToolDefinition[] = [
    {
      type: 'function',
      function: {
        name: 'lookup_order',
        description: 'Look up order by id',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      },
    },
  ];

  it('appends tools in each protocol native format', () => {
    const openaiBody: Record<string, unknown> = { messages: [] };
    addTools('openai-chat', openaiBody, tools);
    expect(openaiBody.tools).toEqual(tools);

    const anthropicBody: Record<string, unknown> = { messages: [] };
    addTools('anthropic', anthropicBody, tools);
    expect(anthropicBody.tools).toEqual([
      {
        name: 'lookup_order',
        description: 'Look up order by id',
        input_schema: tools[0]!.function.parameters,
      },
    ]);

    const responsesBody: Record<string, unknown> = { input: 'hi' };
    addTools('responses', responsesBody, tools);
    expect(responsesBody.tools).toEqual([
      {
        type: 'function',
        name: 'lookup_order',
        description: 'Look up order by id',
        parameters: tools[0]!.function.parameters,
      },
    ]);

    const geminiBody: Record<string, unknown> = { contents: [] };
    addTools('gemini', geminiBody, tools);
    expect(geminiBody.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: 'lookup_order',
            description: 'Look up order by id',
            parameters: tools[0]!.function.parameters,
          },
        ],
      },
    ]);
  });
});
