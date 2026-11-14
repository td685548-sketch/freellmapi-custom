import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { defaultDbFactory, initDb } from '../../../db/index.js';
import { wrapTursoDatabase } from '../../../db/turso.js';
import { resetFlagsCacheForTests, setFlags } from '../../../custom/ai-platform/flags.js';
import { runPreRequest } from '../../../custom/ai-platform/pipeline.js';
import * as loopback from '../../../custom/ai-platform/loopback.js';
import type { GateProfile } from '../../../services/profile-usage.js';

function makeReq(body: unknown = { model: 'gpt-4', messages: [] }): Request {
  return {
    body,
    headers: {},
    socket: { remoteAddress: '203.0.113.10' },
  } as unknown as Request;
}

function makeRes(): Response {
  const write = vi.fn();
  const end = vi.fn();
  const json = vi.fn();
  const setHeader = vi.fn();
  return { write, end, json, setHeader } as unknown as Response;
}

function makeProfile(): GateProfile {
  return {
    id: 1,
    rpmLimit: null,
    allowedModels: [],
    maxTokens: null,
    endUserQuota: { dailyRequests: null, dailyTokens: null, monthlyRequests: null, monthlyTokens: null },
    knowledge: { enabled: false, maxChars: 4000 },
    conversations: { enabled: false, maxTurns: 20, pruning: 'sliding', ttlSeconds: null },
    contentFilter: { enabled: false, blockOnError: false, rules: [] },
    quickAnswers: { enabled: false, answers: [] },
  } as unknown as GateProfile;
}

describe('runPreRequest — pipeline composition boundary (T021 / T029)', () => {
  beforeAll(() => {
    initDb(':memory:', { factory: () => wrapTursoDatabase(defaultDbFactory()(':memory:'), true) });
  });

  beforeEach(() => {
    resetFlagsCacheForTests();
    setFlags({
      prompts: false,
      retrieval: false,
      promptCache: false,
      mcpClient: false,
      outputGuard: false,
      orchestrator: false,
    });
    vi.restoreAllMocks();
  });

  it('returns "continue" when all flags are false', async () => {
    const result = await runPreRequest(makeReq(), makeRes(), makeProfile(), null);
    expect(result).toBe('continue');
  });

  it('returns "continue" with a non-null endUser', async () => {
    const result = await runPreRequest(makeReq(), makeRes(), makeProfile(), 'user-42');
    expect(result).toBe('continue');
  });

  it('preserves exact req.body and res/method references when all flags are false', async () => {
    const body = { model: 'gpt-4', messages: [{ role: 'user', content: 'hello' }] };
    const req = makeReq(body);
    const res = makeRes();
    const origWrite = res.write;
    const origEnd = res.end;
    const origJson = res.json;

    const result = await runPreRequest(req, res, makeProfile(), null);

    expect(result).toBe('continue');
    expect(req.body).toBe(body);
    expect(res.write).toBe(origWrite);
    expect(res.end).toBe(origEnd);
    expect(res.json).toBe(origJson);
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it('skips pipeline steps on valid internal loopback calls even when flags are enabled', async () => {
    setFlags({ prompts: true, orchestrator: true });
    vi.spyOn(loopback, 'isInternalCall').mockReturnValue({ depth: 1, runId: 'run-1' });

    const body = { model: 'gpt-4', messages: [{ role: 'user', content: 'subcall' }] };
    const req = makeReq(body);
    const res = makeRes();

    const result = await runPreRequest(req, res, makeProfile(), null);

    expect(result).toBe('continue');
    expect(req.body).toBe(body);
    expect(res.setHeader).not.toHaveBeenCalled();
  });
});
