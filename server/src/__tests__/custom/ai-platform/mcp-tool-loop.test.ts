import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { getDb, initDb } from '../../../db/index.js';
import { resetFlagsCacheForTests, setFlags } from '../../../custom/ai-platform/flags.js';
import { toLoopbackMessages, extractLoopParams } from '../../../custom/ai-platform/mcp-client/messages.js';
import { sendMcpLoopResult } from '../../../custom/ai-platform/mcp-client/respond.js';
import { runToolLoop, type ToolLoopDeps } from '../../../custom/ai-platform/mcp-client/tool-loop.js';
import type { BoundTool, McpLoopResult } from '@freellmapi/shared/ai-platform-mcp.js';

function makeBoundTool(overrides: Partial<BoundTool> = {}): BoundTool {
  return {
    toolId: 1,
    serverId: 1,
    serverSlug: 'orders',
    name: 'lookup_order',
    exposedName: 'orders__lookup_order',
    description: 'Look up an order',
    inputSchema: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'] },
    outputSchema: null,
    schemaHash: 'hash-1',
    effect: 'read',
    timeoutMs: 20_000,
    maxResultBytes: 262_144,
    maxConcurrency: 4,
    ...overrides,
  };
}

function makeMockReq(headers: Record<string, string> = {}): Request {
  return {
    headers,
    originalUrl: '/v1/chat/completions',
    url: '/v1/chat/completions',
    path: '/v1/chat/completions',
    query: {},
    socket: { localAddress: '127.0.0.1', localPort: 3000 },
  } as unknown as Request;
}

function makeMockRes(reqMeta: { query?: Record<string, unknown>; originalUrl?: string } = {}) {
  const headers: Record<string, string> = {};
  const chunks: string[] = [];
  let statusCode = 200;
  let jsonBody: unknown = undefined;
  let ended = false;
  const res = {
    req: reqMeta,
    status(code: number) {
      statusCode = code;
      return this;
    },
    setHeader(name: string, val: string) {
      headers[name.toLowerCase()] = val;
      return this;
    },
    json(body: unknown) {
      jsonBody = body;
      ended = true;
      return this;
    },
    write(chunk: string | Buffer) {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      return true;
    },
    end() {
      ended = true;
      return this;
    },
  } as unknown as Response;

  return {
    res,
    getStatus: () => statusCode,
    getHeaders: () => headers,
    getJson: () => jsonBody,
    getText: () => chunks.join(''),
    isEnded: () => ended,
  };
}

beforeEach(() => {
  initDb(':memory:');
  resetFlagsCacheForTests();
  setFlags({ mcpClient: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  resetFlagsCacheForTests();
  try { getDb().close(); } catch { /* already closed */ }
});

describe('MCP messages.ts 4-wire conversion (T040/T048)', () => {
  it('preserves system, history, multimodal, cache_control, and tool results for OpenAI Chat', () => {
    const msgs = toLoopbackMessages('openai-chat', {
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'Be concise', cache_control: { type: 'ephemeral' } }] },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Check this' },
            { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
          ],
        },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'lookup', arguments: '{"id":"1"}' } }],
        },
        { role: 'tool', tool_call_id: 'tc1', content: '{"ok":true}' },
      ],
    });
    expect(msgs).not.toBeNull();
    expect(msgs).toHaveLength(4);
    expect(msgs![0]!.role).toBe('system');
    expect(Array.isArray(msgs![1]!.content)).toBe(true);
    expect(msgs![2]!.tool_calls?.[0]?.id).toBe('tc1');
    expect(msgs![3]!.tool_call_id).toBe('tc1');

    const params = extractLoopParams('openai-chat', { temperature: 0.2, top_p: 0.9, max_tokens: 512, stop: ['END'] });
    expect(params).toMatchObject({ temperature: 0.2, topP: 0.9, maxTokens: 512, stop: ['END'] });
  });

  it('converts Anthropic system, tool_use, tool_result, and multimodal blocks', () => {
    const msgs = toLoopbackMessages('anthropic', {
      model: 'claude-3-5-sonnet',
      system: [{ type: 'text', text: 'Sys prompt', cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Hi' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          ],
        },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu_1', name: 'my_tool', input: { q: 'x' } }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'done' }],
        },
      ],
    });
    expect(msgs).not.toBeNull();
    expect(msgs![0]!.role).toBe('system');
    expect(msgs![2]!.tool_calls?.[0]).toMatchObject({
      id: 'tu_1',
      function: { name: 'my_tool', arguments: '{"q":"x"}' },
    });
    expect(msgs![3]!).toMatchObject({ role: 'tool', tool_call_id: 'tu_1', content: 'done' });
  });

  it('converts Responses input items and Gemini contents/systemInstruction', () => {
    const respMsgs = toLoopbackMessages('responses', {
      instructions: 'Follow rules',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello' }] },
        { type: 'function_call', call_id: 'fc_1', name: 'calc', arguments: '{"a":1}' },
        { type: 'function_call_output', call_id: 'fc_1', output: '2' },
      ],
    });
    expect(respMsgs).not.toBeNull();
    expect(respMsgs!.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);

    const gemMsgs = toLoopbackMessages('gemini', {
      systemInstruction: { parts: [{ text: 'Gem sys' }] },
      contents: [
        { role: 'user', parts: [{ text: 'Find order' }] },
        { role: 'model', parts: [{ functionCall: { name: 'orders__lookup_order', args: { orderId: '1' } } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'orders__lookup_order', response: { ok: true } } }] },
      ],
    });
    expect(gemMsgs).not.toBeNull();
    expect(gemMsgs!.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
  });
});

describe('MCP runToolLoop (T040/T048)', () => {
  it('runs tool rounds, sums usage across rounds, and stops when no tool calls remain', async () => {
    const tool = makeBoundTool();
    let round = 0;
    const deps: ToolLoopDeps = {
      toolsForScope: () => [tool],
      isModelToolCapable: () => true,
      callGateway: async () => {
        round += 1;
        if (round === 1) {
          return {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: tool.exposedName, arguments: '{"orderId":"ORD-1"}' },
                },
              ],
            },
            finishReason: 'tool_calls',
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            servedModel: 'gpt-4o',
          };
        }
        return {
          message: { role: 'assistant', content: 'Order ORD-1 is shipped.' },
          finishReason: 'stop',
          usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
          servedModel: 'gpt-4o',
        };
      },
      executeTool: async () => ({
        kind: 'result',
        text: '<tool_result server="orders" tool="lookup_order" trust="untrusted">shipped</tool_result>',
        bytes: 7,
        truncated: false,
        durationMs: 5,
      }),
    };

    const ac = new AbortController();
    const res = await runToolLoop(
      makeMockReq(),
      {
        scope: { kind: 'profile', id: '1' },
        messages: [{ role: 'user', content: 'Where is ORD-1?' }],
        model: 'gpt-4o',
        callerTools: [],
        maxRounds: 8,
        signal: ac.signal,
      },
      deps,
    );

    expect(res.rounds).toBe(2);
    expect(res.message.content).toBe('Order ORD-1 is shipped.');
    expect(res.usage).toEqual({ prompt_tokens: 30, completion_tokens: 13, total_tokens: 43 });
  });

  it('caps at maxRounds (8) and stops cleanly', async () => {
    const tool = makeBoundTool();
    let calls = 0;
    const deps: ToolLoopDeps = {
      toolsForScope: () => [tool],
      isModelToolCapable: () => true,
      callGateway: async () => {
        calls += 1;
        return {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: `c_${calls}`, type: 'function', function: { name: tool.exposedName, arguments: '{"orderId":"1"}' } }],
          },
          finishReason: 'tool_calls',
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          servedModel: 'gpt-4o',
        };
      },
      executeTool: async () => ({ kind: 'result', text: 'ok', bytes: 2, truncated: false, durationMs: 1 }),
    };

    const ac = new AbortController();
    const res = await runToolLoop(
      makeMockReq(),
      {
        scope: { kind: 'profile', id: '1' },
        messages: [{ role: 'user', content: 'loop' }],
        model: 'gpt-4o',
        callerTools: [],
        maxRounds: 8,
        signal: ac.signal,
      },
      deps,
    );

    expect(res.rounds).toBe(8);
    expect(calls).toBe(8);
  });

  it('checks entire batch before MCP dispatch and returns callerToolCalls without MCP side effects', async () => {
    const tool = makeBoundTool();
    let mcpDispatches = 0;
    const callerTool = {
      type: 'function' as const,
      function: { name: 'client_confirm', description: 'Client tool', parameters: { type: 'object' } },
    };

    const deps: ToolLoopDeps = {
      toolsForScope: () => [tool],
      isModelToolCapable: () => true,
      callGateway: async (_req, body) => {
        // Caller tool + MCP tool both sent
        expect(body.tools?.map((t) => t.function.name)).toContain('client_confirm');
        expect(body.tools?.map((t) => t.function.name)).toContain(tool.exposedName);
        return {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'tc_mcp', type: 'function', function: { name: tool.exposedName, arguments: '{"orderId":"1"}' } },
              { id: 'tc_cli', type: 'function', function: { name: 'client_confirm', arguments: '{"ok":true}' } },
            ],
          },
          finishReason: 'tool_calls',
          usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
          servedModel: 'gpt-4o',
        };
      },
      executeTool: async () => {
        mcpDispatches += 1;
        return { kind: 'result', text: 'ok', bytes: 2, truncated: false, durationMs: 1 };
      },
    };

    const ac = new AbortController();
    const res = await runToolLoop(
      makeMockReq(),
      {
        scope: { kind: 'profile', id: '1' },
        messages: [{ role: 'user', content: 'run both' }],
        model: 'gpt-4o',
        callerTools: [callerTool],
        maxRounds: 8,
        signal: ac.signal,
      },
      deps,
    );

    expect(mcpDispatches).toBe(0);
    expect(res.callerToolCalls).toHaveLength(2);
    expect(res.finishReason).toBe('tool_calls');
  });

  it('strips MCP tools (keeping caller tools) when model does not support tools', async () => {
    const tool = makeBoundTool();
    const callerTool = {
      type: 'function' as const,
      function: { name: 'client_fn', description: 'Client fn', parameters: { type: 'object' } },
    };

    let seenTools: string[] = [];
    const deps: ToolLoopDeps = {
      toolsForScope: () => [tool],
      isModelToolCapable: () => false,
      callGateway: async (_req, body) => {
        seenTools = (body.tools ?? []).map((t) => t.function.name);
        return {
          message: { role: 'assistant', content: 'Answer without MCP tools' },
          finishReason: 'stop',
          usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
          servedModel: 'basic-model',
        };
      },
    };

    const ac = new AbortController();
    const res = await runToolLoop(
      makeMockReq(),
      {
        scope: { kind: 'profile', id: '1' },
        messages: [{ role: 'user', content: 'hello' }],
        model: 'basic-model',
        callerTools: [callerTool],
        maxRounds: 8,
        signal: ac.signal,
      },
      deps,
    );

    expect(seenTools).toEqual(['client_fn']);
    expect(res.toolsSkippedReason).toBe('unsupported_model');
  });

  it('returns structured tool error for unknown tool names without dispatching remote', async () => {
    const tool = makeBoundTool();
    let mcpDispatches = 0;
    let round = 0;
    let secondRoundMessages: unknown[] = [];

    const deps: ToolLoopDeps = {
      toolsForScope: () => [tool],
      isModelToolCapable: () => true,
      callGateway: async (_req, body) => {
        round += 1;
        if (round === 1) {
          return {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'tc_unk', type: 'function', function: { name: 'evil__unknown', arguments: '{}' } }],
            },
            finishReason: 'tool_calls',
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
            servedModel: 'gpt-4o',
          };
        }
        secondRoundMessages = body.messages;
        return {
          message: { role: 'assistant', content: 'Recovered.' },
          finishReason: 'stop',
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
          servedModel: 'gpt-4o',
        };
      },
      executeTool: async () => {
        mcpDispatches += 1;
        return { kind: 'result', text: 'nope', bytes: 4, truncated: false, durationMs: 1 };
      },
    };

    const ac = new AbortController();
    const res = await runToolLoop(
      makeMockReq(),
      {
        scope: { kind: 'profile', id: '1' },
        messages: [{ role: 'user', content: 'test unknown' }],
        model: 'gpt-4o',
        callerTools: [],
        maxRounds: 8,
        signal: ac.signal,
      },
      deps,
    );

    expect(mcpDispatches).toBe(0);
    expect(res.message.content).toBe('Recovered.');
    const toolMsg = secondRoundMessages.find((m) => (m as { role?: string }).role === 'tool') as { content?: string };
    expect(toolMsg?.content).toContain('"error"');
  });
});

describe('MCP respond.ts 4-wire callerToolCalls serialization (T040/T048)', () => {
  const sampleResult: McpLoopResult = {
    message: { role: 'assistant', content: '' },
    finishReason: 'tool_calls',
    usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
    rounds: 1,
    callerToolCalls: [
      { id: 'call_abc', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Hanoi"}' } },
    ],
  };

  it('serializes callerToolCalls for openai-chat, anthropic, responses, and gemini (stream & non-stream)', () => {
    // OpenAI Chat non-stream
    const oai = makeMockRes();
    sendMcpLoopResult(oai.res, 'openai-chat', false, sampleResult, 'gpt-4o');
    expect((oai.getJson() as { choices: Array<{ finish_reason: string; message: { tool_calls: unknown[] } }> }).choices[0]!.finish_reason).toBe('tool_calls');
    expect((oai.getJson() as { choices: Array<{ message: { tool_calls: unknown[] } }> }).choices[0]!.message.tool_calls).toHaveLength(1);

    // Anthropic non-stream
    const ant = makeMockRes();
    sendMcpLoopResult(ant.res, 'anthropic', false, sampleResult, 'claude-3-5-sonnet');
    expect((ant.getJson() as { stop_reason: string; content: Array<{ type: string; id: string }> }).stop_reason).toBe('tool_use');
    expect((ant.getJson() as { content: Array<{ type: string; id: string }> }).content[0]!).toMatchObject({ type: 'tool_use', id: 'call_abc' });

    // Responses non-stream
    const rsp = makeMockRes();
    sendMcpLoopResult(rsp.res, 'responses', false, sampleResult, 'gpt-4o');
    expect((rsp.getJson() as { output: Array<{ type: string; call_id: string }> }).output[0]!).toMatchObject({ type: 'function_call', call_id: 'call_abc' });

    // Gemini JSON-array stream vs SSE stream
    const gemJsonArr = makeMockRes({ originalUrl: '/v1beta/models/gemini-2.5-flash:streamGenerateContent' });
    sendMcpLoopResult(gemJsonArr.res, 'gemini', true, sampleResult, 'gemini-2.5-flash');
    expect(gemJsonArr.getHeaders()['content-type']).toBe('application/json');
    const parsedArr = JSON.parse(gemJsonArr.getText()) as Array<{ candidates: Array<{ content: { parts: Array<{ functionCall?: { name: string } }> } }> }>;
    expect(parsedArr[0]!.candidates[0]!.content.parts[0]!.functionCall?.name).toBe('get_weather');

    const gemSse = makeMockRes({ originalUrl: '/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse' });
    sendMcpLoopResult(gemSse.res, 'gemini', true, sampleResult, 'gemini-2.5-flash');
    expect(gemSse.getHeaders()['content-type']).toBe('text/event-stream');
    expect(gemSse.getText()).toContain('data: ');
    expect(gemSse.getText()).toContain('get_weather');
  });
});

describe('MCP Compatibility & Fallback Audit (F05 / F09)', () => {
  it('F09: returns null instead of silently dropping Anthropic thinking, redacted_thinking, or image tool_result blocks', () => {
    expect(
      toLoopbackMessages('anthropic', {
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'internal', signature: 'sig-1' },
              { type: 'text', text: 'Answer' },
            ],
          },
          { role: 'user', content: 'Follow up' },
        ],
      }),
    ).toBeNull();

    expect(
      toLoopbackMessages('anthropic', {
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'redacted_thinking', data: 'opaque' },
              { type: 'text', text: 'Answer' },
            ],
          },
          { role: 'user', content: 'Follow up' },
        ],
      }),
    ).toBeNull();

    expect(
      toLoopbackMessages('anthropic', {
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu_1',
                content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }],
              },
            ],
          },
        ],
      }),
    ).toBeNull();
  });

  it('F05: extracts tool_choice, response_format, and max_completion_tokens when supported', () => {
    const params = extractLoopParams('openai-chat', {
      messages: [{ role: 'user', content: 'hi' }],
      tool_choice: 'none',
      response_format: { type: 'json_object' },
      max_completion_tokens: 256,
    }) as Record<string, unknown>;
    expect(params.toolChoice).toBe('none');
    expect(params.responseFormat).toEqual({ type: 'json_object' });
    expect(params.maxCompletionTokens).toBe(256);
  });
});
