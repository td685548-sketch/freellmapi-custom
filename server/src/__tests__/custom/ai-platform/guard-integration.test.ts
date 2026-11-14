import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import {
  DEFAULT_GUARD_DETECTORS,
  DEFAULT_GUARD_POLICY_BASE,
  type GuardPolicyInput,
} from '@freellmapi/shared/ai-platform-output-guard.js';
import { getDb, initDb } from '../../../db/index.js';
import {
  createSupportTenant,
  ensureSupportTables,
} from '../../../custom/x-gateway/support-store.js';
import { resetFlagsCacheForTests, setFlags } from '../../../custom/ai-platform/flags.js';
import { installOutputGuardIfNeeded } from '../../../custom/ai-platform/pipeline.js';
import { setPolicy } from '../../../custom/ai-platform/output-guard/policy.js';
import { resetGuardEventRateLimitForTests } from '../../../custom/ai-platform/output-guard/events.js';
import {
  buildSupportGuardContext,
  guardSupportReply,
} from '../../../custom/ai-platform/output-guard/support-adapter.js';
import type { GateProfile } from '../../../services/profile-usage.js';

function seedProfile(id: number, name = `profile-${id}`): void {
  getDb()
    .prepare(
      'INSERT INTO client_profiles (id, name, token_hash, encrypted_key, iv, auth_tag) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(id, name, `th-${id}`, `ek-${id}`, `iv-${id}`, `tag-${id}`);
}

function makePolicyInput(overrides?: Partial<GuardPolicyInput>): GuardPolicyInput {
  return {
    mode: DEFAULT_GUARD_POLICY_BASE.mode,
    detectors: structuredClone(DEFAULT_GUARD_DETECTORS),
    replacementText: DEFAULT_GUARD_POLICY_BASE.replacementText,
    failMode: DEFAULT_GUARD_POLICY_BASE.failMode,
    bypassRoles: [],
    holdChars: DEFAULT_GUARD_POLICY_BASE.holdChars,
    maxDelayMs: DEFAULT_GUARD_POLICY_BASE.maxDelayMs,
    revision: 0,
    ...overrides,
  };
}

function makeMockRes() {
  const emitter = new EventEmitter();
  const headers: Record<string, string> = {};
  const written: string[] = [];
  const jsonOut: unknown[] = [];
  const res = Object.assign(emitter, {
    statusCode: 200,
    headersSent: false,
    writableFinished: false,
    setHeader(name: string, val: string | string[]) {
      headers[name.toLowerCase()] = Array.isArray(val) ? val.join(', ') : String(val);
      return res;
    },
    getHeader(name: string) {
      return headers[name.toLowerCase()];
    },
    removeHeader(name: string) {
      delete headers[name.toLowerCase()];
    },
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    write(chunk: string | Uint8Array) {
      res.headersSent = true;
      written.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      return true;
    },
    end(chunk?: string | Uint8Array | (() => void)) {
      res.headersSent = true;
      if (chunk !== undefined && typeof chunk !== 'function') {
        written.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      }
      res.writableFinished = true;
      emitter.emit('finish');
      return res;
    },
    json(body: unknown) {
      res.headersSent = true;
      jsonOut.push(body);
      res.writableFinished = true;
      return res;
    },
  });
  return { res: res as unknown as Response, headers, written, jsonOut };
}

const dummyProfile: GateProfile = {
  id: 42,
  rpmLimit: null,
  allowedModels: [],
  maxTokens: null,
  endUserQuota: { dailyRequests: null, dailyTokens: null, monthlyRequests: null, monthlyTokens: null },
  knowledge: { enabled: false, maxChars: 4000 },
  conversations: { enabled: false, maxMessages: 20, ttlHours: 24 },
  contentFilter: { enabled: false, mode: 'off', keywords: [], blockedMessage: '' },
  quickAnswers: { enabled: false, minSimilarity: 0.8 },
};

describe('output-guard integration with real policy.ts (T066/T067)', () => {
  beforeEach(() => {
    initDb(':memory:');
    resetFlagsCacheForTests();
    resetGuardEventRateLimitForTests();
    seedProfile(42);
    setFlags({ outputGuard: true });
  });

  afterEach(() => {
    resetFlagsCacheForTests();
    try {
      getDb().close();
    } catch {
      /* already closed */
    }
  });

  it('installs real policy outputFilterFor idempotently and blocks early non-stream response', async () => {
    await setPolicy(
      { kind: 'profile', id: '42' },
      makePolicyInput({
        mode: 'block',
        replacementText: '[GUARDED_BY_POLICY]',
        detectors: {
          ...structuredClone(DEFAULT_GUARD_DETECTORS),
          keywords: { enabled: true, terms: ['SECRET_LEAK'] },
        },
      }),
      null,
    );

    const { res, headers, jsonOut } = makeMockRes();
    const req = {
      method: 'POST',
      originalUrl: '/v1/chat/completions',
      url: '/v1/chat/completions',
      headers: {
        // Forged internal header from non-loopback must NOT bypass guard
        'x-ai-platform-internal': 'v1.9999999999.forged.deadbeef',
      },
      socket: { remoteAddress: '203.0.113.5' },
      body: {
        model: 'gpt-4o',
        stream: false,
        messages: [{ role: 'user', content: 'hi' }],
      },
    } as unknown as Request;

    // Called twice (outer profile-gate + pipeline): must be idempotent
    installOutputGuardIfNeeded(req, res, dummyProfile, 'eu-1');
    installOutputGuardIfNeeded(req, res, dummyProfile, 'eu-1');

    res.json({
      id: 'chatcmpl-qa',
      object: 'chat.completion',
      model: 'quick-answer',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Here is SECRET_LEAK' }, finish_reason: 'stop' }],
    });

    await new Promise((r) => setTimeout(r, 25));
    expect(headers['x-freellm-guard']).toBe('blocked;reason=keywords');
    expect(jsonOut[0]).toMatchObject({
      choices: [{ index: 0, message: { content: '[GUARDED_BY_POLICY]' }, finish_reason: 'content_filter' }],
    });
  });

  it('support-adapter evaluates real policy.ts for support_tenant without mock evaluator', async () => {
    ensureSupportTables();
    const { tenant } = createSupportTenant({
      name: 'Acme',
      allowGuest: true,
      defaultModel: 'auto',
      systemPrompt: 'Tenant system prompt.',
    });

    await setPolicy(
      { kind: 'support_tenant', id: String(tenant.id) },
      makePolicyInput({
        mode: 'block',
        replacementText: '[SUPPORT_POLICY_BLOCKED]',
        detectors: {
          ...structuredClone(DEFAULT_GUARD_DETECTORS),
          keywords: { enabled: true, terms: ['FORBIDDEN_TERM'] },
        },
      }),
      null,
    );

    const ctx = buildSupportGuardContext({
      tenantId: tenant.id,
      verified: false,
      role: 'admin', // unverified must downgrade to guest
      userId: 'u-1',
      systemPrompt: 'Tenant system prompt.',
      trustedContext:
        'Reference material from this website. Use it when it answers the question.\n\n### Doc\nSecret KB',
      hasInferenceCapability: false,
    });

    expect(ctx.role).toBe('guest');
    expect(ctx.hasInferenceCapability).toBe(false);
    expect(ctx.systemPrompt).toBe('Tenant system prompt.');
    expect(ctx.systemPrompt).not.toContain('Secret KB');

    const res = await guardSupportReply({
      text: 'This reply contains FORBIDDEN_TERM inside it.',
      context: ctx,
    });
    expect(res).toMatchObject({
      action: 'blocked',
      text: '[SUPPORT_POLICY_BLOCKED]',
      reason: 'keywords',
    });
  });

  it('preserves full original text in non-stream mode: log without blanking content', async () => {
    await setPolicy(
      { kind: 'profile', id: '42' },
      makePolicyInput({
        mode: 'log',
        detectors: {
          ...structuredClone(DEFAULT_GUARD_DETECTORS),
          keywords: { enabled: true, terms: ['forbidden-secret'] },
        },
      }),
      null,
    );

    const { res, headers, jsonOut } = makeMockRes();
    const req = {
      method: 'POST',
      originalUrl: '/v1/chat/completions',
      url: '/v1/chat/completions',
      headers: {},
      socket: { remoteAddress: '203.0.113.5' },
      body: {
        model: 'gpt-4o',
        stream: false,
        messages: [{ role: 'user', content: 'hi' }],
      },
    } as unknown as Request;

    installOutputGuardIfNeeded(req, res, dummyProfile, 'eu-1');

    res.json({
      id: 'chatcmpl-log',
      object: 'chat.completion',
      model: 'gpt-4o',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'This has forbidden-secret inside' },
          finish_reason: 'stop',
        },
      ],
    });

    await new Promise((r) => setTimeout(r, 25));
    expect(headers['x-freellm-guard']).toBe('logged');
    expect(jsonOut[0]).toMatchObject({
      choices: [
        {
          index: 0,
          message: { content: 'This has forbidden-secret inside' },
          finish_reason: 'stop',
        },
      ],
    });
  });

  it('blocks Gemini JSON-array stream (:streamGenerateContent without ?alt=sse) with SAFETY finishReason', async () => {
    await setPolicy(
      { kind: 'profile', id: '42' },
      makePolicyInput({
        mode: 'block',
        replacementText: '[GEMINI_STREAM_BLOCKED]',
        detectors: {
          ...structuredClone(DEFAULT_GUARD_DETECTORS),
          keywords: { enabled: true, terms: ['forbidden-secret'] },
        },
      }),
      null,
    );

    const { res, headers, written } = makeMockRes();
    const req = {
      method: 'POST',
      originalUrl: '/v1beta/models/gemini-2.0-flash:streamGenerateContent',
      url: '/v1beta/models/gemini-2.0-flash:streamGenerateContent',
      query: {},
      headers: {},
      socket: { remoteAddress: '203.0.113.5' },
      body: {
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      },
    } as unknown as Request;

    installOutputGuardIfNeeded(req, res, dummyProfile, 'eu-1');

    res.setHeader('Content-Type', 'application/json');
    res.write('[');
    res.write(
      `\n${JSON.stringify({
        candidates: [{ content: { role: 'model', parts: [{ text: 'Here is forbidden-secret' }] }, index: 0 }],
      })}`,
    );
    res.write(
      `,\n${JSON.stringify({
        candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP', index: 0 }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
      })}`,
    );
    res.write('\n]');
    res.end();

    await new Promise((r) => setTimeout(r, 25));
    expect(headers['x-freellm-guard']).toBe('active');
    const parsed = JSON.parse(written.join('')) as Array<{
      candidates: Array<{ content: { parts: Array<{ text: string }> }; finishReason?: string }>;
    }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.candidates[0]!.content.parts[0]!.text).toBe('[GEMINI_STREAM_BLOCKED]');
    expect(parsed[0]!.candidates[0]!.finishReason).toBe('SAFETY');
  });

  it('blocks Gemini multi-candidate non-stream (:generateContent) when candidate[1] matches', async () => {
    await setPolicy(
      { kind: 'profile', id: '42' },
      makePolicyInput({
        mode: 'block',
        replacementText: '[GEMINI_MULTI_BLOCKED]',
        detectors: {
          ...structuredClone(DEFAULT_GUARD_DETECTORS),
          keywords: { enabled: true, terms: ['forbidden-secret'] },
        },
      }),
      null,
    );

    const { res, headers, jsonOut } = makeMockRes();
    const req = {
      method: 'POST',
      originalUrl: '/v1beta/models/gemini-2.0-flash:generateContent',
      url: '/v1beta/models/gemini-2.0-flash:generateContent',
      query: {},
      headers: {},
      socket: { remoteAddress: '203.0.113.5' },
      body: {
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      },
    } as unknown as Request;

    installOutputGuardIfNeeded(req, res, dummyProfile, 'eu-1');

    res.json({
      candidates: [
        { index: 0, content: { role: 'model', parts: [{ text: 'Safe candidate 0' }] }, finishReason: 'STOP' },
        { index: 1, content: { role: 'model', parts: [{ text: 'Unsafe forbidden-secret' }] }, finishReason: 'STOP' },
      ],
    });

    await new Promise((r) => setTimeout(r, 25));
    expect(headers['x-freellm-guard']).toBe('blocked;reason=keywords');
    expect(jsonOut[0]).toMatchObject({
      candidates: [
        { index: 0, content: { parts: [{ text: '[GEMINI_MULTI_BLOCKED]' }] }, finishReason: 'SAFETY' },
        { index: 1, content: { parts: [{ text: '[GEMINI_MULTI_BLOCKED]' }] }, finishReason: 'SAFETY' },
      ],
    });
  });
});
