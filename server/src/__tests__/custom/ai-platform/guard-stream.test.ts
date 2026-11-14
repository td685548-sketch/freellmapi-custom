import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { installInterceptor, type OutputFilter } from '../../../custom/ai-platform/wire/interceptor.js';
import { createStreamGuard } from '../../../custom/ai-platform/output-guard/stream-guard.js';

interface StreamHarness {
  req: Request;
  res: Response;
  chunks: Array<{ time: number; text: string }>;
  headers: Record<string, string>;
  ended: boolean;
  close: () => void;
}

function makeSseHarness(url = '/v1/chat/completions'): StreamHarness {
  const reqEmitter = new EventEmitter();
  const resEmitter = new EventEmitter();
  const chunks: Array<{ time: number; text: string }> = [];
  const headers: Record<string, string> = {};
  let ended = false;

  const req = Object.assign(reqEmitter, {
    method: 'POST',
    originalUrl: url,
    url,
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
    removeHeader(name: string) {
      delete headers[name.toLowerCase()];
    },
    write(chunk: string | Uint8Array, encOrCb?: BufferEncoding | (() => void), cb?: () => void) {
      resObj.headersSent = true;
      const enc = typeof encOrCb === 'string' ? encOrCb : 'utf8';
      const callback = typeof encOrCb === 'function' ? encOrCb : cb;
      const text = Buffer.isBuffer(chunk)
        ? chunk.toString('utf8')
        : typeof chunk === 'string'
          ? chunk
          : Buffer.from(chunk).toString(enc);
      chunks.push({ time: Date.now(), text });
      callback?.();
      return true;
    },
    end(chunk?: string | Uint8Array | (() => void), encOrCb?: BufferEncoding | (() => void), cb?: () => void) {
      resObj.headersSent = true;
      let actualChunk: string | Uint8Array | undefined;
      let callback: (() => void) | undefined;
      if (typeof chunk === 'function') callback = chunk;
      else {
        actualChunk = chunk;
        callback = typeof encOrCb === 'function' ? encOrCb : cb;
      }
      if (actualChunk !== undefined) {
        const text = Buffer.isBuffer(actualChunk) ? actualChunk.toString('utf8') : String(actualChunk);
        chunks.push({ time: Date.now(), text });
      }
      ended = true;
      resObj.writableFinished = true;
      callback?.();
      resEmitter.emit('finish');
      return resObj;
    },
    json(body: unknown) {
      resObj.headersSent = true;
      chunks.push({ time: Date.now(), text: JSON.stringify(body) });
      ended = true;
      resObj.writableFinished = true;
      return resObj;
    },
  });

  return {
    req,
    res: resObj as unknown as Response,
    chunks,
    headers,
    get ended() {
      return ended;
    },
    close() {
      resObj.destroyed = true;
      resEmitter.emit('close');
    },
  };
}

function sseDelta(content: string): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    model: 'gpt-test',
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  })}\n\n`;
}

describe('output-guard/stream-guard (T056/T062)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('holds up to 200 chars by default and flushes on 300ms timer even without another onDelta', async () => {
    const h = makeSseHarness();
    const guard = createStreamGuard({
      mode: 'block',
      evaluateLocal: (text) => ({ action: 'pass', text }),
    });
    installInterceptor(h.req, h.res, 'openai-chat', [guard]);

    h.res.write(sseDelta('Hello safe prefix'));
    // Held within 200-char window before 300ms
    expect(h.chunks.map((c) => c.text).join('')).not.toContain('Hello safe prefix');

    // Advance 300ms without sending any new chunk from provider
    vi.advanceTimersByTime(300);

    const emitted = h.chunks.map((c) => c.text).join('');
    expect(emitted).toContain('Hello safe prefix');
    expect(h.ended).toBe(false);

    h.res.end('data: [DONE]\n\n');
    await vi.runAllTimersAsync();
    expect(h.ended).toBe(true);
  });

  it('catches forbidden term split across >300ms timer flush without emitting the completing tail', () => {
    const h = makeSseHarness();
    const events: string[] = [];
    const guard = createStreamGuard({
      mode: 'block',
      holdChars: 200,
      maxDelayMs: 300,
      replacementText: '[BLOCKED]',
      evaluateLocal: (scanContext) => {
        if (scanContext.toLowerCase().includes('secret_token')) {
          return { action: 'blocked', text: scanContext, reason: 'keywords', detector: 'keywords' };
        }
        return { action: 'pass', text: scanContext };
      },
      onEvent: (ev) => events.push(`${ev.action}:${ev.detector ?? ''}`),
    });
    installInterceptor(h.req, h.res, 'openai-chat', [guard]);

    h.res.write(sseDelta('Here is secret_'));
    vi.advanceTimersByTime(310);
    // Prefix flushed after 300ms
    expect(h.chunks.map((c) => c.text).join('')).toContain('Here is secret_');

    // Provider sends completing tail after gap > 300ms
    h.res.write(sseDelta('token_value'));
    const allOut = h.chunks.map((c) => c.text).join('');
    expect(allOut).not.toContain('token_value');
    expect(allOut).toContain('[BLOCKED]');
    expect(allOut).toContain('"finish_reason":"content_filter"');
    expect(allOut).toContain('data: [DONE]');
    expect(events).toContain('blocked:keywords');
  });

  it('normalizes NFD combining marks split across chunks so NFC keyword match is caught', () => {
    const h = makeSseHarness();
    const guard = createStreamGuard({
      mode: 'block',
      holdChars: 200,
      maxDelayMs: 300,
      replacementText: '[BLOCKED]',
      evaluateLocal: (scanContext) => {
        const norm = scanContext.normalize('NFC').toLowerCase();
        if (norm.includes('café_secret')) {
          return { action: 'blocked', text: scanContext, reason: 'keywords', detector: 'keywords' };
        }
        return { action: 'pass', text: scanContext };
      },
    });
    installInterceptor(h.req, h.res, 'openai-chat', [guard]);

    // Split 'e' + '\u0301' (combining acute accent) across timer gap
    h.res.write(sseDelta('cafe'));
    vi.advanceTimersByTime(310);
    h.res.write(sseDelta('\u0301_secret'));

    const allOut = h.chunks.map((c) => c.text).join('');
    expect(allOut).not.toContain('_secret');
    expect(allOut).toContain('[BLOCKED]');
    expect(allOut).toContain('content_filter');
  });

  it('preserves original text in log mode without rewriting or stopping', async () => {
    const h = makeSseHarness();
    const events: string[] = [];
    const guard = createStreamGuard({
      mode: 'log',
      evaluateLocal: (text) => {
        if (text.includes('forbidden')) {
          return { action: 'blocked', text, reason: 'keywords', detector: 'keywords' };
        }
        return { action: 'pass', text };
      },
      onEvent: (ev) => events.push(ev.action),
    });
    installInterceptor(h.req, h.res, 'openai-chat', [guard]);

    h.res.write(sseDelta('This has forbidden word'));
    h.res.write('data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"gpt-test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
    h.res.end('data: [DONE]\n\n');
    await vi.runAllTimersAsync();

    const allOut = h.chunks.map((c) => c.text).join('');
    expect(allOut).toContain('This has forbidden word');
    expect(allOut).not.toContain('content_filter');
    expect(events).toContain('logged');
  });

  it('disposes timer on client close without emitting after close', () => {
    const h = makeSseHarness();
    const guard = createStreamGuard({
      mode: 'block',
      maxDelayMs: 300,
      evaluateLocal: (text) => ({ action: 'pass', text }),
    });
    installInterceptor(h.req, h.res, 'openai-chat', [guard]);

    h.res.write(sseDelta('Pending text'));
    const countBeforeClose = h.chunks.length;
    h.close();

    vi.advanceTimersByTime(500);
    expect(h.chunks.length).toBe(countBeforeClose);
  });

  it('clamps holdChars and maxDelayMs to 2000 caps', () => {
    const guard = createStreamGuard({
      mode: 'block',
      holdChars: 9999,
      maxDelayMs: 9999,
      evaluateLocal: (text) => ({ action: 'pass', text }),
    }) as OutputFilter & { config?: { holdChars: number; maxDelayMs: number } };
    expect(guard.config?.holdChars).toBe(2000);
    expect(guard.config?.maxDelayMs).toBe(2000);
  });
});
