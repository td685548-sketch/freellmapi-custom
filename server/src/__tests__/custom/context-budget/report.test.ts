import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONTEXT_PRESETS,
  type ContextAssemblySummary,
  type ContextPolicy,
} from '@freellmapi/shared/context-budget.js';
import { connectDb } from '../../../db/index.js';
import { runMigrations } from '../../../db/migrate/runner.js';
import { newRequestTrace, runWithRequestTrace } from '../../../lib/attempt-trace.js';
import { getCalibrationFactor, resetCalibration } from '../../../custom/context-budget/estimate.js';
import { fitContextForRoute } from '../../../custom/context-budget/hooks.js';
import { clearContextPolicyCache, saveContextPolicy } from '../../../custom/context-budget/policy.js';
import { createRegistry, registerUnit } from '../../../custom/context-budget/registry.js';
import {
  beginReport,
  formatContextHeader,
  getReportForRequest,
  persistReportOnFinish,
  pruneContextReports,
  resetReportPruneState,
} from '../../../custom/context-budget/report.js';

type TestDb = ReturnType<typeof connectDb>;

function insertProfile(db: TestDb, id: number, name = `profile-${id}`): void {
  db.prepare(
    `INSERT INTO client_profiles (id, name, token_hash, encrypted_key, iv, auth_tag)
     VALUES (?, ?, ?, 'e', 'i', 't')`,
  ).run(id, name, `hash-${id}`);
}

function insertRequestRow(
  db: TestDb,
  opts: { id?: number; platform?: string; modelId?: string; inputTokens?: number } = {},
): number {
  const res = db
    .prepare(
      `INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms)
       VALUES (?, ?, 'success', ?, 20, 50)`,
    )
    .run(opts.platform ?? 'groq', opts.modelId ?? 'llama-3.3-70b', opts.inputTokens ?? 0);
  return Number(res.lastInsertRowid);
}

function makePolicy(overrides: Partial<ContextPolicy> = {}): ContextPolicy {
  return {
    profileId: 1,
    enabled: true,
    inherited: false,
    preset: 'balanced',
    ...CONTEXT_PRESETS.balanced,
    updatedAt: '2026-11-17T00:00:00.000Z',
    ...overrides,
  };
}

function makeSummary(overrides: Partial<ContextAssemblySummary> = {}): ContextAssemblySummary {
  return {
    budget: 14400,
    window: 32768,
    mandatory: 310,
    summary: 402,
    knowledge: 1180,
    history: 8840,
    histSent: 18,
    histDropped: 24,
    kbSent: 3,
    kbDropped: 0,
    clientDropped: 0,
    refits: 1,
    estimatedTokens: 10732,
    heuristicTokens: 10000,
    modelKey: 'groq:llama-3.3-70b',
    createdAt: '2026-11-17T10:00:00.000Z',
    ...overrides,
  };
}

function makeEventRes(headersSent = false) {
  const emitter = new EventEmitter();
  const headers = new Map<string, string>();
  const res = Object.assign(emitter, {
    headersSent,
    setHeader: vi.fn((name: string, value: string) => {
      headers.set(name.toLowerCase(), String(value));
    }),
    getHeader: vi.fn((name: string) => headers.get(name.toLowerCase())),
    removeHeader: vi.fn((name: string) => {
      headers.delete(name.toLowerCase());
    }),
  });
  return { res: res as unknown as Response & EventEmitter, headers, setHeader: res.setHeader };
}

async function flushImmediate(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('context-budget report & header formatting (T031)', () => {
  let db: TestDb;

  beforeEach(async () => {
    clearContextPolicyCache();
    resetCalibration();
    resetReportPruneState();
    db = connectDb(':memory:');
    await runMigrations(db, 'up');
    insertProfile(db, 1);
    insertProfile(db, 2);
  });

  afterEach(() => {
    clearContextPolicyCache();
    resetCalibration();
    resetReportPruneState();
    db.close();
  });

  it('formats X-FreeLLM-Context header with exact key order and window=unknown when null', () => {
    const formatted = formatContextHeader(makeSummary());
    expect(formatted).toBe(
      'budget=14400;mandatory=310;summary=402;knowledge=1180;history=8840;hist_sent=18;hist_dropped=24;kb_sent=3;kb_dropped=0;client_dropped=0;refits=1;window=32768',
    );

    const unknownWindow = formatContextHeader(makeSummary({ window: null }));
    expect(unknownWindow).toBe(
      'budget=14400;mandatory=310;summary=402;knowledge=1180;history=8840;hist_sent=18;hist_dropped=24;kb_sent=3;kb_dropped=0;client_dropped=0;refits=1;window=unknown',
    );
  });

  it('persists report keyed to trace.lastRequestRowId after finish without storing any message text', async () => {
    const req = {} as Request;
    const reg = createRegistry(req, makePolicy({ profileId: 1, enabled: true }));
    reg.conversation = { id: 10, key: 'conv-secret-key', endUser: 'user-42' };
    reg.fitted = true;
    reg.report = makeSummary({
      modelKey: 'groq:llama-3.3-70b',
      estimatedTokens: 500,
      heuristicTokens: 500,
    });

    const { res } = makeEventRes();
    const trace = newRequestTrace();
    const requestRowId = insertRequestRow(db, { platform: 'groq', modelId: 'llama-3.3-70b', inputTokens: 500 });

    runWithRequestTrace(trace, () => {
      beginReport(req);
      persistReportOnFinish(req, res);
    });
    // Simulate logRequest updating lastRequestRowId during dispatch/completion
    trace.lastRequestRowId = requestRowId;

    // Not written before finish event
    expect(getReportForRequest(1, requestRowId)).toBeNull();

    res.emit('finish');
    await flushImmediate();

    const stored = getReportForRequest(1, requestRowId);
    expect(stored).toEqual({
      budget: 14400,
      window: 32768,
      mandatory: 310,
      summary: 402,
      knowledge: 1180,
      history: 8840,
      histSent: 18,
      histDropped: 24,
      kbSent: 3,
      kbDropped: 0,
      clientDropped: 0,
      refits: 1,
      estimatedTokens: 500,
      heuristicTokens: 500,
      modelKey: 'groq:llama-3.3-70b',
      createdAt: '2026-11-17T10:00:00.000Z',
    });

    // Wrong profileId cannot read another profile's report
    expect(getReportForRequest(2, requestRowId)).toBeNull();

    // Verify table schema & row have no message content columns
    const cols = (db.prepare('PRAGMA table_info(custom_context_reports)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).not.toContain('content');
    expect(cols).not.toContain('messages');
    expect(cols).not.toContain('preview');
  });

  it('does not persist report when trace is absent, lastRequestRowId is null, or policy is disabled', async () => {
    // 1. No trace
    const reqNoTrace = {} as Request;
    const reg1 = createRegistry(reqNoTrace, makePolicy({ enabled: true }));
    reg1.fitted = true;
    reg1.report = makeSummary();
    const { res: res1 } = makeEventRes();
    persistReportOnFinish(reqNoTrace, res1);
    res1.emit('finish');
    await flushImmediate();

    // 2. Trace with null lastRequestRowId
    const reqNullRow = {} as Request;
    const reg2 = createRegistry(reqNullRow, makePolicy({ enabled: true }));
    reg2.fitted = true;
    reg2.report = makeSummary();
    const { res: res2 } = makeEventRes();
    runWithRequestTrace(newRequestTrace(), () => {
      persistReportOnFinish(reqNullRow, res2);
    });
    res2.emit('finish');
    await flushImmediate();

    // 3. Disabled policy
    const reqDisabled = {} as Request;
    createRegistry(reqDisabled, makePolicy({ enabled: false }));
    const { res: res3 } = makeEventRes();
    const trace3 = newRequestTrace();
    trace3.lastRequestRowId = insertRequestRow(db, { inputTokens: 100 });
    runWithRequestTrace(trace3, () => {
      beginReport(reqDisabled);
      persistReportOnFinish(reqDisabled, res3);
    });
    res3.emit('finish');
    await flushImmediate();

    const count = (db.prepare('SELECT COUNT(*) AS cnt FROM custom_context_reports').get() as { cnt: number }).cnt;
    expect(count).toBe(0);
  });

  it('calls recordCalibrationSample only when requests.input_tokens differs from heuristic_tokens', async () => {
    // Case A: requests.input_tokens === heuristic_tokens -> no calibration update
    const reqSame = {} as Request;
    const regSame = createRegistry(reqSame, makePolicy({ enabled: true }));
    regSame.fitted = true;
    regSame.report = makeSummary({
      modelKey: 'groq:llama-3.3-70b',
      estimatedTokens: 1000,
      heuristicTokens: 900,
    });
    const traceSame = newRequestTrace();
    const reqIdSame = insertRequestRow(db, { platform: 'groq', inputTokens: 900 });
    const { res: resSame } = makeEventRes();
    runWithRequestTrace(traceSame, () => {
      persistReportOnFinish(reqSame, resSame);
    });
    traceSame.lastRequestRowId = reqIdSame;
    resSame.emit('finish');
    await flushImmediate();
    expect(getCalibrationFactor('groq')).toBe(1.0);

    // Case B: requests.input_tokens !== heuristic_tokens -> calibration updated
    const reqDiff = {} as Request;
    const regDiff = createRegistry(reqDiff, makePolicy({ enabled: true }));
    regDiff.fitted = true;
    regDiff.report = makeSummary({
      modelKey: 'groq:llama-3.3-70b',
      estimatedTokens: 1000,
      heuristicTokens: 900,
    });
    const traceDiff = newRequestTrace();
    const reqIdDiff = insertRequestRow(db, { platform: 'groq', inputTokens: 1300 });
    const { res: resDiff } = makeEventRes();
    runWithRequestTrace(traceDiff, () => {
      persistReportOnFinish(reqDiff, resDiff);
    });
    traceDiff.lastRequestRowId = reqIdDiff;
    resDiff.emit('finish');
    await flushImmediate();

    // EMA alpha=0.1: 1.0 * 0.9 + (1300/1000) * 0.1 = 1.03
    expect(getCalibrationFactor('groq')).toBeCloseTo(1.03, 4);
  });

  it('prunes orphan reports and deleted profile policies at most once per hour', () => {
    const validReqId = insertRequestRow(db);
    const orphanReqId = insertRequestRow(db);
    saveContextPolicy(2, { enabled: true, preset: 'balanced' });
    saveContextPolicy(999, { enabled: true, preset: 'balanced' }); // orphan profile policy

    const insertReport = db.prepare(
      `INSERT INTO custom_context_reports (
        request_id, profile_id, end_user, conversation_key, model_key, context_window,
        budget_tokens, mandatory_tokens, summary_tokens, knowledge_tokens, history_tokens,
        estimated_tokens, heuristic_tokens, history_sent, history_dropped,
        knowledge_sent, knowledge_dropped, summary_used, client_history_dropped, refits, created_at
      ) VALUES (?, ?, NULL, NULL, 'groq:m1', 8192, 7000, 100, 0, 0, 500, 600, 580, 2, 0, 0, 0, 0, 0, 0, '2026-11-17T10:00:00.000Z')`,
    );
    insertReport.run(validReqId, 1);
    insertReport.run(orphanReqId, 1);
    insertReport.run(999999, 2); // missing request row

    // Delete request row for orphanReqId and delete profile 2
    db.prepare('DELETE FROM requests WHERE id = ?').run(orphanReqId);
    db.prepare('DELETE FROM client_profiles WHERE id = 2').run();

    const t0 = 1_700_000_000_000;
    const prunedFirst = pruneContextReports(t0);
    expect(prunedFirst).toBe(2);
    expect(getReportForRequest(1, validReqId)).not.toBeNull();
    expect(getReportForRequest(1, orphanReqId)).toBeNull();
    expect(getReportForRequest(2, 999999)).toBeNull();

    // Orphan policies for deleted profile 2 & 999 were also pruned
    const orphanPolicyCount = (
      db.prepare('SELECT COUNT(*) AS cnt FROM custom_context_policies WHERE profile_id IN (2, 999)').get() as {
        cnt: number;
      }
    ).cnt;
    expect(orphanPolicyCount).toBe(0);

    // Create another orphan within the same hour -> throttled (no-op)
    const lateOrphanReqId = insertRequestRow(db);
    insertReport.run(lateOrphanReqId, 1);
    db.prepare('DELETE FROM requests WHERE id = ?').run(lateOrphanReqId);

    expect(pruneContextReports(t0 + 30 * 60 * 1000)).toBe(0);
    expect(getReportForRequest(1, lateOrphanReqId)).not.toBeNull();

    // After 1 hour -> prunes again
    expect(pruneContextReports(t0 + 60 * 60 * 1000)).toBe(1);
    expect(getReportForRequest(1, lateOrphanReqId)).toBeNull();
  });

  it('wires X-FreeLLM-Context header, registry.report, and finish persistence through fitContextForRoute (T035)', async () => {
    const req = {} as Request;
    const secretUserText = 'SUPER_SECRET_USER_TEXT_DO_NOT_LOG';
    const reg = createRegistry(req, makePolicy({ profileId: 1, enabled: true, maxInputTokens: 16000 }));
    reg.conversation = { id: 55, key: 'conv-hook', endUser: 'end-u1' };
    registerUnit(req, { kind: 'history', role: 'user', text: 'Earlier question', seq: 1, messageId: 1 });
    registerUnit(req, { kind: 'history', role: 'assistant', text: 'Earlier answer', seq: 2, messageId: 2 });

    const { res, headers } = makeEventRes(false);
    const trace = newRequestTrace();
    const requestRowId = insertRequestRow(db, { platform: 'groq', modelId: 'llama-3.3-70b', inputTokens: 150 });

    runWithRequestTrace(trace, () => {
      fitContextForRoute(
        req,
        res,
        [
          { role: 'system', content: 'System prompt.' },
          { role: 'user', content: 'Earlier question' },
          { role: 'assistant', content: 'Earlier answer' },
          { role: 'user', content: secretUserText },
        ],
        { contextWindow: 32768, platform: 'groq', modelId: 'llama-3.3-70b' },
        1024,
      );
    });
    trace.lastRequestRowId = requestRowId;

    expect(reg.report).not.toBeNull();
    expect(reg.report!.modelKey).toBe('groq:llama-3.3-70b');
    expect(reg.report!.window).toBe(32768);
    expect(headers.get('x-freellm-context')).toBe(formatContextHeader(reg.report!));

    res.emit('finish');
    await flushImmediate();

    const stored = getReportForRequest(1, requestRowId);
    expect(stored).toEqual(reg.report);
    const rawRow = db.prepare('SELECT * FROM custom_context_reports WHERE request_id = ?').get(requestRowId);
    expect(JSON.stringify(rawRow)).not.toContain(secretUserText);
  });
});
