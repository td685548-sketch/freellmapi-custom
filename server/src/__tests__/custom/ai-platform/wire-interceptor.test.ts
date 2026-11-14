import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { installInterceptor, type OutputFilter } from '../../../custom/ai-platform/wire/interceptor.js';

interface Harness {
  req: Request;
  res: Response;
  emitter: EventEmitter;
  written: Buffer[];
  jsonOut: unknown[];
  headers: Record<string, string>;
  ended: boolean;
  origWrite: Response['write'];
  origEnd: Response['end'];
  origJson: Response['json'];
  setWriteReturn: (val: boolean) => void;
  markClosed: () => void;
}

function makeHarness(originalUrl = '/v1/chat/completions'): Harness {
  const reqEmitter = new EventEmitter();
  const resEmitter = new EventEmitter();
  const written: Buffer[] = [];
  const jsonOut: unknown[] = [];
  const headers: Record<string, string> = {};
  let writeReturn = true;
  let ended = false;

  const req = Object.assign(reqEmitter, {
    method: 'POST',
    originalUrl,
    url: originalUrl,
  }) as unknown as Request;

  const resObj = Object.assign(resEmitter, {
    statusCode: 200,
    headersSent: false,
    writableFinished: false,
    destroyed: false,
    setHeader(name: string, val: string | string[]) {
      headers[name.toLowerCase()] = Array.isArray(val) ? val.join(', ') : String(val);
      return resObj;
    },
    getHeader(name: string) {
      return headers[name.toLowerCase()];
    },
    write(chunk: string | Uint8Array, encOrCb?: BufferEncoding | (() => void), cb?: () => void) {
      const encoding = typeof encOrCb === 'string' ? encOrCb : 'utf8';
      const callback = typeof encOrCb === 'function' ? encOrCb : cb;
      const buf = Buffer.isBuffer(chunk)
        ? chunk
        : typeof chunk === 'string'
          ? Buffer.from(chunk, encoding)
          : Buffer.from(chunk);
      written.push(buf);
      callback?.();
      return writeReturn;
    },
    end(chunk?: string | Uint8Array | (() => void), encOrCb?: BufferEncoding | (() => void), cb?: () => void) {
      let actualChunk: string | Uint8Array | undefined;
      let encoding: BufferEncoding = 'utf8';
      let callback: (() => void) | undefined;
      if (typeof chunk === 'function') {
        callback = chunk;
      } else {
        actualChunk = chunk;
        if (typeof encOrCb === 'function') callback = encOrCb;
        else if (typeof encOrCb === 'string') {
          encoding = encOrCb;
          callback = cb;
        }
      }
      if (actualChunk !== undefined) {
        const buf = Buffer.isBuffer(actualChunk)
          ? actualChunk
          : typeof actualChunk === 'string'
            ? Buffer.from(actualChunk, encoding)
            : Buffer.from(actualChunk);
        written.push(buf);
      }
      ended = true;
      resObj.writableFinished = true;
      callback?.();
      resEmitter.emit('finish');
      return resObj;
    },
    json(body: unknown) {
      jsonOut.push(body);
      ended = true;
      resObj.writableFinished = true;
      return resObj;
    },
  });

  return {
    req,
    res: resObj as unknown as Response,
    emitter: resEmitter,
    written,
    jsonOut,
    headers,
    get ended() {
      return ended;
    },
    origWrite: resObj.write,
    origEnd: resObj.end,
    origJson: resObj.json,
    setWriteReturn(val: boolean) {
      writeReturn = val;
    },
    markClosed() {
      resObj.destroyed = true;
      resEmitter.emit('close');
    },
  };
}

describe('wire/interceptor', () => {
  it('does not wrap res when filters array is empty', () => {
    const h = makeHarness();
    installInterceptor(h.req, h.res, 'openai-chat', []);
    expect(h.res.write).toBe(h.origWrite);
    expect(h.res.end).toBe(h.origEnd);
    expect(h.res.json).toBe(h.origJson);

    h.setWriteReturn(false);
    const cb = vi.fn();
    expect(h.res.write('hello', cb)).toBe(false);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('reassembles split UTF-8, CRLF SSE, and multi-event chunks for onDelta and ignores tool args', () => {
    const h = makeHarness();
    const deltas: string[] = [];
    const usages: unknown[] = [];
    const filter: OutputFilter = {
      name: 'collect',
      onDelta(text) {
        deltas.push(text);
        return { emit: text };
      },
      onUsage(u) {
        usages.push(u);
      },
    };
    installInterceptor(h.req, h.res, 'openai-chat', [filter]);

    // Split a 4-byte emoji (😀 = F0 9F 98 80) across two write calls + CRLF + two events in one chunk
    const ev1 = Buffer.from('data: {"choices":[{"index":0,"delta":{"content":"Hi 😀"},"finish_reason":null}]}\r\n\r\n', 'utf8');
    const splitAt = ev1.indexOf(0x9f); // mid-UTF8 byte
    h.res.write(ev1.subarray(0, splitAt));
    h.res.write(ev1.subarray(splitAt));

    const multi = [
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"secret\\":1}"}}]},"finish_reason":null}]}\r\n\r\n',
      'data: {"choices":[{"index":0,"delta":{"content":"!"},"finish_reason":null}]}\r\n\r\n',
      'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\r\n\r\n',
      'data: [DONE]\r\n\r\n',
    ].join('');
    const cb = vi.fn();
    h.res.write(multi, cb);
    h.res.end();

    expect(cb).toHaveBeenCalledTimes(1);
    expect(deltas.join('')).toBe('Hi 😀!');
    expect(usages).toEqual([{ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }]);
    expect(h.ended).toBe(true);
  });

  it('stops stream on onDelta stop without replaying already emitted bytes', () => {
    const h = makeHarness();
    const filter: OutputFilter = {
      name: 'stopper',
      onDelta(text) {
        if (text.includes('BAD')) {
          return { emit: '', stop: { replacement: '[REDACTED]', reason: 'keyword' } };
        }
        return { emit: text };
      },
    };
    installInterceptor(h.req, h.res, 'openai-chat', [filter]);

    h.res.write('data: {"id":"1","model":"gpt-4o","choices":[{"index":0,"delta":{"content":"safe "},"finish_reason":null}]}\n\n');
    h.res.write('data: {"id":"1","model":"gpt-4o","choices":[{"index":0,"delta":{"content":"BAD word"},"finish_reason":null}]}\n\n');
    h.res.write('data: {"id":"1","model":"gpt-4o","choices":[{"index":0,"delta":{"content":"after"},"finish_reason":"stop"}]}\n\n');
    h.res.end();

    const out = Buffer.concat(h.written).toString('utf8');
    expect(out).toContain('safe ');
    expect(out).toContain('[REDACTED]');
    expect(out).toContain('"finish_reason":"content_filter"');
    expect(out).toContain('data: [DONE]');
    expect(out).not.toContain('BAD word');
    expect(out).not.toContain('after');
    // "safe " should appear only once (not replayed)
    expect(out.split('safe ').length - 1).toBe(1);
  });

  it('supports buffering + async onComplete on non-stream JSON and cancels on close', async () => {
    const h = makeHarness('/v1/messages');
    let calls = 0;
    const filter: OutputFilter = {
      name: 'async-mask',
      buffering: true,
      async onComplete(full) {
        calls++;
        await new Promise((r) => setTimeout(r, 10));
        return { replaceWith: full.replace('secret', '***'), reason: 'pii' };
      },
    };
    installInterceptor(h.req, h.res, 'anthropic', [filter]);
    h.res.json({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-3-5-sonnet',
      content: [{ type: 'text', text: 'my secret here' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 3 },
    });

    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toBe(1);
    expect(h.jsonOut[0]).toMatchObject({
      content: [{ type: 'text', text: 'my *** here' }],
    });

    // If res closes before async onComplete resolves, nothing is written
    const h2 = makeHarness('/v1/chat/completions');
    const slowFilter: OutputFilter = {
      name: 'slow',
      buffering: true,
      async onComplete(full) {
        await new Promise((r) => setTimeout(r, 40));
        return { replaceWith: full };
      },
    };
    installInterceptor(h2.req, h2.res, 'openai-chat', [slowFilter]);
    h2.res.write('data: {"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n');
    h2.res.end();
    // req.emit('close') alone must NOT cancel; only res close cancels
    h2.req.emit('close');
    h2.markClosed();
    await new Promise((r) => setTimeout(r, 60));
    expect(h2.written.length).toBe(0);
  });

  it('passes malformed frames through untouched when failOpen, and blocks when failClosed', () => {
    const hOpen = makeHarness();
    installInterceptor(hOpen.req, hOpen.res, 'openai-chat', [
      { name: 'open', onDelta: (t) => ({ emit: t }) },
    ]);
    hOpen.res.write('data: {not-valid-json}\n\n');
    hOpen.res.end();
    expect(Buffer.concat(hOpen.written).toString('utf8')).toBe('data: {not-valid-json}\n\n');

    const hClosed = makeHarness();
    installInterceptor(hClosed.req, hClosed.res, 'openai-chat', [
      { name: 'closed', failClosed: true, onDelta: (t) => ({ emit: t }) },
    ]);
    hClosed.res.write('data: {not-valid-json}\n\n');
    hClosed.res.end();
    const out = Buffer.concat(hClosed.written).toString('utf8');
    expect(out).not.toContain('{not-valid-json}');
    expect(out).toContain('content_filter');
  });

  it('extracts usage across anthropic, responses, and gemini', () => {
    const usages: unknown[] = [];
    const filter: OutputFilter = { name: 'usage', onUsage: (u) => usages.push(u) };

    const ant = makeHarness('/v1/messages');
    installInterceptor(ant.req, ant.res, 'anthropic', [filter]);
    ant.res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":7,"output_tokens":3}}\n\n');
    ant.res.end();

    const resp = makeHarness('/v1/responses');
    installInterceptor(resp.req, resp.res, 'responses', [filter]);
    resp.res.write('event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":9,"output_tokens":4,"total_tokens":13}}}\n\n');
    resp.res.end();

    const gem = makeHarness('/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse');
    installInterceptor(gem.req, gem.res, 'gemini', [filter]);
    gem.res.write('data: {"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2,"totalTokenCount":7}}\n\n');
    gem.res.end();

    expect(usages).toHaveLength(3);
  });
});
