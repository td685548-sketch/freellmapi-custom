import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import {
  DEFAULT_GUARD_DETECTORS,
  DEFAULT_GUARD_POLICY_BASE,
  type GuardPolicyInput,
} from '@freellmapi/shared/ai-platform-output-guard.js';
import { getDb, initDb } from '../../../db/index.js';
import { setFlags, resetFlagsCacheForTests } from '../../../custom/ai-platform/flags.js';
import { upsertPolicy } from '../../../custom/ai-platform/output-guard/store.js';
import { outputFilterFor, evaluateOutput } from '../../../custom/ai-platform/output-guard/policy.js';
import { installOutputGuardIfNeeded } from '../../../custom/ai-platform/pipeline.js';
import type { GateProfile } from '../../../services/profile-usage.js';
import * as interceptor from '../../../custom/ai-platform/wire/interceptor.js';
import * as external from '../../../custom/ai-platform/output-guard/external.js';
import * as moderation from '../../../services/moderation.js';

const scope = { kind: 'profile', id: '1' } as const;
const ctx = {
  role: 'end_user', endUser: null, wire: 'openai-chat', stream: true, systemPrompt: null,
} as const;

function policy(): GuardPolicyInput {
  return {
    ...DEFAULT_GUARD_POLICY_BASE,
    mode: 'block',
    revision: 0,
    bypassRoles: [],
    detectors: structuredClone(DEFAULT_GUARD_DETECTORS),
  };
}

beforeEach(() => {
  initDb(':memory:');
  resetFlagsCacheForTests();
  setFlags({ outputGuard: true });
  getDb().prepare(`INSERT INTO client_profiles
    (id, name, token_hash, encrypted_key, iv, auth_tag) VALUES (1, ?, ?, ?, ?, ?)`)
    .run('review', 'th', 'ek', 'iv', 'tag');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetFlagsCacheForTests();
  getDb().close();
});

it('blocks bounded regex in streaming as well as complete output', async () => {
  const p = policy();
  p.detectors.patterns = { enabled: true, rules: [{ id: 'secret', name: 'Secret', pattern: 'SECRET', flags: '' }] };
  upsertPolicy(scope, p, null);
  expect((await evaluateOutput(scope, 'SECRET', { ...ctx, stream: false })).action).toBe('blocked');
  const filter = outputFilterFor(scope, ctx)!;
  expect(filter.buffering).toBe(true);
  expect(filter.onDelta!('SECRET').emit).toBe('');
  expect((await filter.onComplete!('SECRET')).action).toBe('blocked');
  filter.dispose?.();
});

it.each(['plain', 'tagged'])('detects punctuation-normalized prompt leaks in %s streamed output', async (variant) => {
  upsertPolicy(scope, policy(), null);
  const words = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november';
  const text = variant === 'tagged' ? `<knowledge>${words}</knowledge>` : words;
  const context = { ...ctx, systemPrompt: words.split(' ').join(', ') };
  expect((await evaluateOutput(scope, text, { ...context, stream: false })).action).toBe('blocked');
  const filter = outputFilterFor(scope, context)!;
  expect(filter.onDelta!(text).stop?.action).toBe('blocked');
  filter.dispose?.();
});

it.each([
  ['Contact alice@', 'example.com', 'alice@example.com'],
  ['Token sk-abc', 'defghijklmnop', 'sk-abcdefghijklmnop'],
  ['Phone +8491', '2345678', '+84912345678'],
])('redacts PII completing after a pause: %s', async (first, second, sensitive) => {
  vi.useFakeTimers();
  upsertPolicy(scope, policy(), null);
  const filter = outputFilterFor(scope, ctx)!;
  let visible = '';
  filter.attach!({ emitDelta: (text) => { visible += text; }, stop: vi.fn(), fail: vi.fn() });
  visible += filter.onDelta!(first).emit;
  await vi.advanceTimersByTimeAsync(301);
  visible += filter.onDelta!(second).emit;
  visible += filter.onBeforeTerminal!().emit;
  expect(visible).not.toContain(sensitive);
  expect(visible).toContain('[redacted]');
  visible += filter.onDelta!(' Afterwards safe.').emit;
  visible += filter.onBeforeTerminal!().emit;
  expect(visible).toContain('Afterwards safe.');
  filter.dispose?.();
});

it('forwards the authenticated request to judge and aborts checks on client disconnect', async () => {
  const p = policy();
  p.detectors.judge = { enabled: true, model: 'auto', criteria: 'test' };
  upsertPolicy(scope, p, null);
  const capture = vi.spyOn(interceptor, 'installInterceptor').mockImplementation(() => {});
  const ext = vi.spyOn(external, 'evaluateExternalDetectors').mockResolvedValue({ action: 'pass', triggered: [] });
  const req = {
    method: 'POST', originalUrl: '/v1/chat/completions', url: '/v1/chat/completions',
    headers: { authorization: 'Bearer valid-test-key' },
    socket: { remoteAddress: '203.0.113.1' },
    body: { model: 'auto', stream: false, messages: [] },
  } as unknown as Request;
  const res = new EventEmitter();
  installOutputGuardIfNeeded(req, res as Response, { id: 1 } as GateProfile, null);
  const filter = capture.mock.calls[0][3][0];
  await filter.onComplete!('safe');
  const context = ext.mock.calls[0][2];
  expect(context.req).toBe(req);
  expect(context.canCallGateway).toBe(true);
  expect(context.signal?.aborted).toBe(false);
  res.emit('close');
  expect(context.signal?.aborted).toBe(true);
});

it.each([
  { results: [] }, { results: [{}] }, { results: [{ flagged: 'false' }] }, { results: [{ flagged: null }] },
])('treats invalid moderation result $results as check_failed', async ({ results }) => {
  const p = policy();
  p.detectors.moderation = { enabled: true };
  const view = upsertPolicy(scope, p, null);
  vi.spyOn(moderation, 'runModerations').mockResolvedValue({ result: { results } } as never);
  const result = await external.evaluateExternalDetectors(view, 'unsafe', { endUser: null });
  expect(result.action).toBe('check_failed');
  expect(result.errorCode).toBe('invalid_moderation_output');
});

it.each(['allow', 'block'] as const)('honors failMode=%s for malformed moderation and records failure', async (failMode) => {
  const p = policy();
  p.failMode = failMode;
  p.detectors.moderation = { enabled: true };
  upsertPolicy(scope, p, null);
  vi.spyOn(moderation, 'runModerations').mockResolvedValue({ result: { results: [] } } as never);
  const result = await evaluateOutput(scope, 'unsafe', { ...ctx, stream: false });
  expect(result.action).toBe(failMode === 'block' ? 'blocked' : 'pass');
  expect(getDb().prepare("SELECT action FROM custom_ai_guard_events WHERE action = 'check_failed'").all()).toHaveLength(1);
});
