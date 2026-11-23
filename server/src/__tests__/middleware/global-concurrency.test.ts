import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import {
  CONCURRENCY_RETRY_AFTER_SECONDS,
  createGlobalConcurrencyLimiter,
  inFlightRequests,
  resetGlobalConcurrencyState,
} from '../../middleware/globalConcurrency.js';

function mockReq(method = 'POST'): Request {
  return { method, url: '/v1/chat/completions', headers: {} } as unknown as Request;
}

interface CapturedRes {
  res: Response;
  headers: Record<string, string>;
  state: { statusCode: number | null; body: unknown };
  emit: (event: 'finish' | 'close') => void;
}

function mockRes(): CapturedRes {
  const emitter = new EventEmitter();
  const headers: Record<string, string> = {};
  const state: { statusCode: number | null; body: unknown } = { statusCode: null, body: null };
  const res = {
    setHeader: (k: string, v: string) => { headers[k] = v; },
    status: (code: number) => ({
      json: (b: unknown) => { state.statusCode = code; state.body = b; },
    }),
    on: (event: string, listener: (...args: unknown[]) => void) => {
      emitter.on(event, listener);
      return res;
    },
  } as unknown as Response;
  return { res, headers, state, emit: (event) => { emitter.emit(event); } };
}

function call(limiter: (req: Request, res: Response, next: NextFunction) => void, req: Request) {
  const captured = mockRes();
  const next = vi.fn();
  limiter(req, captured.res, next);
  return { next, headers: captured.headers, state: captured.state, emit: captured.emit };
}

afterEach(() => {
  resetGlobalConcurrencyState();
  vi.restoreAllMocks();
});

describe('global /v1 concurrency limiter', () => {
  it('admits requests under the cap and counts them', () => {
    const limiter = createGlobalConcurrencyLimiter(2);
    expect(call(limiter, mockReq()).next).toHaveBeenCalled();
    expect(call(limiter, mockReq()).next).toHaveBeenCalled();
    expect(inFlightRequests()).toBe(2);
  });

  it('rejects the (cap+1)th concurrent request with 429 + Retry-After', () => {
    const limiter = createGlobalConcurrencyLimiter(2);
    call(limiter, mockReq());
    call(limiter, mockReq());
    const third = call(limiter, mockReq());
    expect(third.next).not.toHaveBeenCalled();
    expect(third.state.statusCode).toBe(429);
    expect(third.headers['Retry-After']).toBe(String(CONCURRENCY_RETRY_AFTER_SECONDS));
    const body = third.state.body as { error: { message: string; type: string } };
    expect(body.error.type).toBe('rate_limit_error');
    // Server capacity, not the caller's key: the message must not blame a
    // credential, and the count must not move — a refused request holds no slot.
    expect(body.error.message).toMatch(/at capacity/i);
    expect(body.error.message).not.toMatch(/key|credential/i);
    expect(inFlightRequests()).toBe(2);
  });

  it('frees the slot when the response finishes, without double-releasing on close', () => {
    const limiter = createGlobalConcurrencyLimiter(1);
    const first = call(limiter, mockReq());
    expect(inFlightRequests()).toBe(1);
    expect(call(limiter, mockReq()).state.statusCode).toBe(429);

    first.emit('finish');
    expect(inFlightRequests()).toBe(0);
    // 'close' also fires after a normal finish: the release must be
    // idempotent, so the count must not go negative or free a later slot.
    first.emit('close');
    expect(inFlightRequests()).toBe(0);
    expect(call(limiter, mockReq()).next).toHaveBeenCalled();
    expect(inFlightRequests()).toBe(1);
  });

  it('frees the slot when the client aborts (close without finish)', () => {
    const limiter = createGlobalConcurrencyLimiter(1);
    const first = call(limiter, mockReq());
    expect(inFlightRequests()).toBe(1);
    first.emit('close');
    expect(inFlightRequests()).toBe(0);
    expect(call(limiter, mockReq()).next).toHaveBeenCalled();
  });

  it('never counts or caps safe methods', () => {
    const limiter = createGlobalConcurrencyLimiter(1);
    call(limiter, mockReq('POST'));
    expect(inFlightRequests()).toBe(1);
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      const result = call(limiter, mockReq(method));
      expect(result.next).toHaveBeenCalled();
      expect(result.state.statusCode).toBeNull();
    }
    expect(inFlightRequests()).toBe(1);
  });

  it('is disabled when the limit is null, undefined or 0', () => {
    for (const limit of [null, undefined, 0]) {
      resetGlobalConcurrencyState();
      const limiter = createGlobalConcurrencyLimiter(limit);
      for (let i = 0; i < 10; i++) {
        expect(call(limiter, mockReq()).next).toHaveBeenCalled();
      }
      // Disabled means pass-through without counting: nothing is tracked.
      expect(inFlightRequests()).toBe(0);
    }
  });

  it('shares one counter across separately created limiter instances', () => {
    const first = createGlobalConcurrencyLimiter(1);
    const second = createGlobalConcurrencyLimiter(1);
    expect(call(first, mockReq()).next).toHaveBeenCalled();
    const viaSecond = call(second, mockReq());
    expect(viaSecond.next).not.toHaveBeenCalled();
    expect(viaSecond.state.statusCode).toBe(429);
  });

  it('floors a fractional limit', () => {
    const limiter = createGlobalConcurrencyLimiter(2.9);
    expect(call(limiter, mockReq()).next).toHaveBeenCalled();
    expect(call(limiter, mockReq()).next).toHaveBeenCalled();
    expect(call(limiter, mockReq()).state.statusCode).toBe(429);
  });
});
