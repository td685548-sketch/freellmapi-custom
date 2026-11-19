import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { createProxyRateLimiter, resetProxyRateLimitState } from '../../middleware/rateLimit.js';
import { getDb, initDb } from '../../db/index.js';
import { createUser } from '../../services/auth.js';
import { mintUserApiKey } from '../../services/user-keys.js';

function mockReq(over: Partial<Request> & { ip?: string; headers?: Record<string, string>; params?: Record<string, string> } = {}): Request {
  return {
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
    headers: {},
    params: {},
    query: {},
    url: '/v1/chat/completions',
    originalUrl: '/v1/chat/completions',
    baseUrl: '',
    ...over,
  } as unknown as Request;
}

interface CapturedRes {
  res: Response;
  headers: Record<string, string>;
  state: { statusCode: number | null; body: unknown };
}

function mockRes(): CapturedRes {
  const headers: Record<string, string> = {};
  const state: { statusCode: number | null; body: unknown } = { statusCode: null, body: null };
  const res = {
    setHeader: (k: string, v: string) => { headers[k] = v; },
    status: (code: number) => ({
      json: (b: unknown) => { state.statusCode = code; state.body = b; },
    }),
  } as unknown as Response;
  return { res, headers, state };
}

function call(limiter: (req: Request, res: Response, next: NextFunction) => void, req: Request) {
  const captured = mockRes();
  const next = vi.fn();
  limiter(req, captured.res, next);
  return { next, headers: captured.headers, state: captured.state };
}

describe('proxy rate limiter: shared key-hash buckets', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  afterEach(() => {
    resetProxyRateLimitState();
    vi.restoreAllMocks();
  });

  it('shares one budget for the same credential across IPs', () => {
    const limiter = createProxyRateLimiter(3);
    const token = 'Bearer some-unified-key';
    for (const ip of ['10.0.0.1', '10.0.0.2', '10.0.0.3']) {
      const result = call(limiter, mockReq({ ip, headers: { authorization: token } }));
      expect(result.next).toHaveBeenCalled();
      expect(result.headers['X-RateLimit-Limit']).toBe('3');
    }
    // Fourth request, from yet another IP but the same key: 429.
    const fourth = call(limiter, mockReq({ ip: '10.0.0.9', headers: { authorization: token } }));
    expect(fourth.next).not.toHaveBeenCalled();
    expect(fourth.state.statusCode).toBe(429);
  });

  it('gives different credentials separate budgets from the same IP', () => {
    const limiter = createProxyRateLimiter(2);
    const withKey = (token: string) =>
      call(limiter, mockReq({ headers: { authorization: `Bearer ${token}` } }));
    expect(withKey('key-A').next).toHaveBeenCalled();
    expect(withKey('key-A').next).toHaveBeenCalled();
    expect(withKey('key-A').next).not.toHaveBeenCalled();
    // key-B still has its own full budget from the same IP.
    expect(withKey('key-B').next).toHaveBeenCalled();
    expect(withKey('key-B').next).toHaveBeenCalled();
  });

  it('falls back to a per-IP bucket with no credential', () => {
    const limiter = createProxyRateLimiter(1);
    const fromIp = (ip: string) => call(limiter, mockReq({ ip }));
    expect(fromIp('10.0.0.1').next).toHaveBeenCalled();
    expect(fromIp('10.0.0.1').next).not.toHaveBeenCalled();
    expect(fromIp('10.0.0.2').next).toHaveBeenCalled();
  });

  it('shares one store across separately created limiter instances', () => {
    const first = createProxyRateLimiter(3);
    const second = createProxyRateLimiter(3);
    const token = 'Bearer shared-store-key';
    const withLimiter = (limiter: ReturnType<typeof createProxyRateLimiter>) =>
      call(limiter, mockReq({ headers: { authorization: token } }));
    expect(withLimiter(first).next).toHaveBeenCalled();
    expect(withLimiter(first).next).toHaveBeenCalled();
    expect(withLimiter(second).next).toHaveBeenCalled();
    expect(withLimiter(second).next).not.toHaveBeenCalled();
  });

  it('buckets /v1/t/:token requests by the URL token hash', () => {
    const limiter = createProxyRateLimiter(1);
    const withToken = (token: string) => call(limiter, mockReq({ params: { token } }));
    expect(withToken('url-token-1').next).toHaveBeenCalled();
    expect(withToken('url-token-1').next).not.toHaveBeenCalled();
    expect(withToken('url-token-2').next).toHaveBeenCalled();
  });
});

describe('proxy rate limiter: per-key rpmLimit', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  afterEach(() => {
    resetProxyRateLimitState();
    vi.restoreAllMocks();
  });

  function mintKeyWithRpm(rpm: number): string {
    const user = createUser(`rl-${rpm}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`, 'MemberPass123!', 'member');
    const minted = mintUserApiKey(user.userId, 'Rate limit key');
    getDb().prepare('UPDATE user_api_keys SET rpm_limit = ? WHERE id = ?').run(rpm, minted.id);
    return minted.key;
  }

  it('enforces a personal key rpmLimit instead of the global limit', () => {
    const key = mintKeyWithRpm(2);
    const limiter = createProxyRateLimiter(120);
    const withKey = () =>
      call(limiter, mockReq({ headers: { authorization: `Bearer ${key}` } }));
    const first = withKey();
    expect(first.next).toHaveBeenCalled();
    expect(first.headers['X-RateLimit-Limit']).toBe('2');
    expect(withKey().next).toHaveBeenCalled();
    const third = withKey();
    expect(third.next).not.toHaveBeenCalled();
    expect(third.state.statusCode).toBe(429);
    expect(third.headers['X-RateLimit-Limit']).toBe('2');
  });

  it('gives two personal keys separate rpmLimit budgets', () => {
    const keyA = mintKeyWithRpm(1);
    const keyB = mintKeyWithRpm(5);
    const limiter = createProxyRateLimiter(120);
    const withKey = (key: string) =>
      call(limiter, mockReq({ headers: { authorization: `Bearer ${key}` } }));
    expect(withKey(keyA).next).toHaveBeenCalled();
    expect(withKey(keyA).next).not.toHaveBeenCalled();
    expect(withKey(keyB).next).toHaveBeenCalled();
    expect(withKey(keyB).next).toHaveBeenCalled();
  });

  it('reuses the user gate answer from req.user without re-validating', () => {
    const limiter = createProxyRateLimiter(120);
    // Not a real key in the DB: if the limiter validated it, the lookup would
    // fail and the global 120 limit would apply. req.user (set by
    // userInferenceGate) says rpmLimit 2, and that must win.
    const fakeKey = 'sk-flm-000000000000000000000000000000000000000000000000';
    const req = mockReq({ headers: { authorization: `Bearer ${fakeKey}` } }) as Request & { user?: unknown };
    req.user = { userId: 999, email: 'x@example.com', role: 'member', rpmLimit: 2, isPrimary: false, permissions: [] };
    const first = call(limiter, req);
    expect(first.next).toHaveBeenCalled();
    expect(first.headers['X-RateLimit-Limit']).toBe('2');
    expect(call(limiter, req).next).toHaveBeenCalled();
    const third = call(limiter, req);
    expect(third.next).not.toHaveBeenCalled();
    expect(third.headers['X-RateLimit-Limit']).toBe('2');
  });
});
