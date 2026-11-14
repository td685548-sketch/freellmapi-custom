import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Request } from 'express';
import {
  DEFAULT_GUARD_DETECTORS,
  DEFAULT_GUARD_POLICY_BASE,
  type GuardDetectorsConfig,
  type GuardPolicyView,
} from '@freellmapi/shared/ai-platform-output-guard.js';
import { initDb, getDb } from '../../../db/index.js';
import { encrypt } from '../../../lib/crypto.js';
import { evaluateExternalDetectors } from '../../../custom/ai-platform/output-guard/external.js';
import {
  startFakeGuardHttpServer,
  type FakeGuardHttpServer,
} from '../../helpers/ai-platform-fake-guard-http.js';

function insertOpenAiKey(): void {
  const { encrypted, iv, authTag } = encrypt('sk-super-secret-guard-test-key');
  getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES ('openai', 'guard-test', ?, ?, ?, 'healthy', 1)
  `).run(encrypted, iv, authTag);
}

function makeFakeReq(port: number, token = 'client-key-123'): Request {
  return {
    headers: { authorization: `Bearer ${token}` },
    socket: { localAddress: '127.0.0.1', localPort: port },
    originalUrl: '/v1/chat/completions',
    url: '/v1/chat/completions',
    path: '/v1/chat/completions',
    query: {},
    body: {},
  } as unknown as Request;
}

function makePolicy(detectorsOverride: Partial<GuardDetectorsConfig> = {}): GuardPolicyView {
  return {
    scopeKind: 'profile',
    scopeId: '1',
    mode: 'block',
    replacementText: DEFAULT_GUARD_POLICY_BASE.replacementText,
    failMode: 'allow',
    bypassRoles: [],
    holdChars: 200,
    maxDelayMs: 300,
    revision: 1,
    updatedBy: null,
    updatedAt: null,
    bufferingReason: 'external_detector',
    detectors: {
      ...DEFAULT_GUARD_DETECTORS,
      ...detectorsOverride,
    },
  };
}

describe('output-guard external checks (moderation & judge)', () => {
  let fakeServer: FakeGuardHttpServer;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(async () => {
    getDb().prepare('DELETE FROM api_keys').run();
    fakeServer = await startFakeGuardHttpServer();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fakeServer.close();
  });

  it('routes moderation through runModerations to real HTTP and detects flagged vs clean', async () => {
    insertOpenAiKey();
    const origFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation((url, init) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.startsWith('https://api.openai.com/v1/moderations')) {
        return origFetch(`${fakeServer.url}/v1/moderations`, init);
      }
      return origFetch(url, init);
    });

    fakeServer.setModerationHandler(() => ({
      status: 200,
      body: {
        id: 'modr-1',
        model: 'omni-moderation-latest',
        results: [{ flagged: true, categories: { violence: true } }],
      },
    }));

    const res = await evaluateExternalDetectors(
      makePolicy({ moderation: { enabled: true } }),
      'some violent output',
      { endUser: null },
    );

    expect(res.action).toBe('blocked');
    expect(res.reason).toBe('moderation');
    expect(res.triggered[0]?.match).toContain('violence');
  });

  it('propagates AbortSignal to real moderation HTTP request and returns check_failed', async () => {
    insertOpenAiKey();
    const origFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation((url, init) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.startsWith('https://api.openai.com/v1/moderations')) {
        return origFetch(`${fakeServer.url}/v1/moderations`, init);
      }
      return origFetch(url, init);
    });

    fakeServer.setModerationHandler(() => ({
      status: 200,
      delayMs: 500,
      body: { results: [{ flagged: false }] },
    }));

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);

    const res = await evaluateExternalDetectors(
      makePolicy({ moderation: { enabled: true } }),
      'sensitive user answer that must never leak',
      { endUser: null, signal: ac.signal },
    );

    expect(res.action).toBe('check_failed');
    expect(res.reason).toBe('moderation');
    expect(res.errorCode).toBe('aborted');
    await new Promise((r) => setTimeout(r, 30));
    expect(fakeServer.calls[0]?.aborted).toBe(true);
  });

  it('sanitizes remote moderation error bodies so secrets/raw payloads never appear in errors', async () => {
    insertOpenAiKey();
    const origFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation((url, init) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.startsWith('https://api.openai.com/v1/moderations')) {
        return origFetch(`${fakeServer.url}/v1/moderations`, init);
      }
      return origFetch(url, init);
    });

    fakeServer.setModerationHandler(() => ({
      status: 500,
      rawBody: 'RAW_SECRET_ECHO_sk-super-secret-guard-test-key',
    }));

    const res = await evaluateExternalDetectors(
      makePolicy({ moderation: { enabled: true } }),
      'hello',
      { endUser: null },
    );

    expect(res.action).toBe('check_failed');
    expect(res.reason).toBe('moderation');
    expect(JSON.stringify(res)).not.toContain('RAW_SECRET_ECHO');
    expect(JSON.stringify(res)).not.toContain('sk-super-secret');
  });

  it('returns check_failed when judge lacks authorized gateway Request context', async () => {
    const res = await evaluateExternalDetectors(
      makePolicy({ judge: { enabled: true, model: 'auto', criteria: 'No PII' } }),
      'test output',
      { endUser: null },
    );
    expect(res.action).toBe('check_failed');
    expect(res.reason).toBe('judge');
    expect(res.errorCode).toBe('missing_gateway_context');
  });

  it('evaluates judge via callGateway loopback HTTP with strict JSON and no tools', async () => {
    fakeServer.setJudgeHandler((record) => {
      const body = record.body as Record<string, unknown>;
      expect(body.tools).toBeUndefined();
      return {
        status: 200,
        content: JSON.stringify({ violation: true, reason: 'disclosed internal pricing' }),
      };
    });

    const res = await evaluateExternalDetectors(
      makePolicy({ judge: { enabled: true, model: 'gpt-4o-mini', criteria: 'No internal pricing' } }),
      'Here is our internal pricing formula.',
      { req: makeFakeReq(fakeServer.port), endUser: 'u1' },
    );

    expect(res.action).toBe('blocked');
    expect(res.reason).toBe('judge');
    expect(res.triggered[0]?.match).toContain('disclosed internal pricing');
    expect(fakeServer.calls).toHaveLength(1);
    expect(fakeServer.calls[0].headers['x-ai-platform-internal']).toBeDefined();
  });

  it('treats malformed JSON, wrong field types, refusal, truncation, and 429 from judge as check_failed', async () => {
    const req = makeFakeReq(fakeServer.port);
    const policy = makePolicy({ judge: { enabled: true, model: 'auto', criteria: 'c' } });

    fakeServer.setJudgeHandler(() => ({ status: 200, content: 'not json at all' }));
    expect((await evaluateExternalDetectors(policy, 'hi', { req, endUser: null })).action).toBe('check_failed');

    fakeServer.setJudgeHandler(() => ({ status: 200, content: '{"violation":"false","reason":"ok"}' }));
    expect((await evaluateExternalDetectors(policy, 'hi', { req, endUser: null })).action).toBe('check_failed');

    fakeServer.setJudgeHandler(() => ({ status: 200, content: 'I cannot help.', finishReason: 'content_filter' }));
    expect((await evaluateExternalDetectors(policy, 'hi', { req, endUser: null })).action).toBe('check_failed');

    fakeServer.setJudgeHandler(() => ({ status: 429, rawBody: JSON.stringify({ error: { code: 'rate_limit' } }) }));
    expect((await evaluateExternalDetectors(policy, 'hi', { req, endUser: null })).action).toBe('check_failed');
  });

  it('enforces shared bounded budget across external checks', async () => {
    fakeServer.setJudgeHandler(() => ({
      status: 200,
      delayMs: 300,
      content: '{"violation":false,"reason":"ok"}',
    }));

    const res = await evaluateExternalDetectors(
      makePolicy({ judge: { enabled: true, model: 'auto', criteria: 'c' } }),
      'hi',
      { req: makeFakeReq(fakeServer.port), endUser: null, timeoutMs: 40 },
    );

    expect(res.action).toBe('check_failed');
    expect(res.errorCode).toBe('timeout');
  });
});
