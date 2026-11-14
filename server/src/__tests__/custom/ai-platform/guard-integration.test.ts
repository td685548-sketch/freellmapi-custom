import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { resetFlagsCacheForTests } from '../../../custom/ai-platform/flags.js';
import {
  installOutputGuardIfNeeded,
  registerOutputFilterProvider,
} from '../../../custom/ai-platform/pipeline.js';
import { createStreamGuard } from '../../../custom/ai-platform/output-guard/stream-guard.js';
import {
  buildSupportGuardContext,
  guardSupportReply,
  registerSupportOutputGuardEvaluator,
} from '../../../custom/ai-platform/output-guard/support-adapter.js';
import type { GateProfile } from '../../../services/profile-usage.js';

vi.mock('../../../custom/ai-platform/flags.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../custom/ai-platform/flags.js')>();
  return {
    ...mod,
    getFlags: () => ({
      prompts: false,
      retrieval: false,
      promptCache: false,
      mcpClient: false,
      outputGuard: true,
      orchestrator: false,
    }),
  };
});

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

describe('output-guard integration (T066/T067)', () => {
  beforeEach(() => {
    resetFlagsCacheForTests();
  });

  afterEach(() => {
    registerOutputFilterProvider(null);
    registerSupportOutputGuardEvaluator(null);
  });

  it('installs output guard idempotently and blocks early non-stream response', async () => {
    registerOutputFilterProvider((_ctx) =>
      createStreamGuard({
        mode: 'block',
        replacementText: '[GUARDED]',
        evaluateLocal: (text) =>
          text.includes('SECRET_LEAK')
            ? { action: 'blocked', text, reason: 'keywords', detector: 'keywords' }
            : { action: 'pass', text },
      }),
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

    await new Promise((r) => setTimeout(r, 15));
    expect(headers['x-freellm-guard']).toBe('blocked;reason=keywords');
    expect(jsonOut[0]).toMatchObject({
      choices: [{ index: 0, message: { content: '[GUARDED]' }, finish_reason: 'content_filter' }],
    });
  });

  it('support-adapter builds restricted guest role for unverified context and strips KB reference blocks', async () => {
    const ctx = buildSupportGuardContext({
      tenantId: 7,
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
      text: 'Normal reply',
      context: ctx,
      evaluator: (_scope, text) => ({ action: 'masked', text: `${text} [checked]`, reason: 'pii' }),
    });
    expect(res).toEqual({ action: 'masked', text: 'Normal reply [checked]', reason: 'pii' });
  });
});
