import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FLOW_LIMITS } from '@freellmapi/shared/ai-platform-orchestrator.js';
import { getDb, initDb } from '../../../db/index.js';
import {
  FlowRunLimiter,
  normalizeFlowLimits,
} from '../../../custom/ai-platform/orchestrator/limits.js';
import {
  appendRunStep,
  createRunRecord,
  finishRunRecord,
  getRunDetail,
  getRunRecord,
  listRuns,
  markRunRunning,
  maskAndTruncateTrace,
  pauseRunForApproval,
  pruneExpiredRuns,
  updateRunProgress,
} from '../../../custom/ai-platform/orchestrator/trace.js';

describe('Orchestrator limits (T117, T124)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('normalizeFlowLimits applies defaults and clamps strictly to 1..hardCeiling', () => {
    expect(normalizeFlowLimits()).toEqual({
      maxSteps: 12,
      maxToolCalls: 20,
      maxHandoffs: 4,
      maxTokens: 60_000,
      maxSeconds: 120,
    });

    expect(
      normalizeFlowLimits({
        maxSteps: 0,
        maxToolCalls: -5,
        maxHandoffs: 0.4,
        maxTokens: Number.NaN,
        maxSeconds: 9999,
      }),
    ).toEqual({
      maxSteps: 1,
      maxToolCalls: 1,
      maxHandoffs: 1,
      maxTokens: 60_000,
      maxSeconds: 600,
    });

    expect(
      normalizeFlowLimits({
        maxSteps: 999,
        maxToolCalls: 999,
        maxHandoffs: 999,
        maxTokens: 9_999_999,
        maxSeconds: 999,
      }),
    ).toEqual({
      maxSteps: 50,
      maxToolCalls: 100,
      maxHandoffs: 10,
      maxTokens: 500_000,
      maxSeconds: 600,
    });
  });

  it('enforces max_steps, max_tool_calls, max_handoffs, and max_seconds', () => {
    let nowMs = 1_000;
    const limiter = new FlowRunLimiter(
      'triage',
      { maxSteps: 2, maxToolCalls: 2, maxHandoffs: 2, maxTokens: 1_000, maxSeconds: 10 },
      nowMs,
      () => nowMs,
    );

    // max_steps
    expect(limiter.checkBeforeModelStep()).toEqual({ allowed: true });
    limiter.recordModelStep(10, 10);
    expect(limiter.checkBeforeModelStep()).toEqual({ allowed: true });
    limiter.recordModelStep(10, 10);
    expect(limiter.checkBeforeModelStep()).toEqual({ allowed: false, stopReason: 'max_steps' });

    // max_tool_calls (distinct args so loop detector does not trigger)
    expect(limiter.checkBeforeToolCall('lookup', { id: 1 })).toEqual({ allowed: true });
    limiter.recordToolCall('lookup', { id: 1 });
    expect(limiter.checkBeforeToolCall('lookup', { id: 2 })).toEqual({ allowed: true });
    limiter.recordToolCall('lookup', { id: 2 });
    expect(limiter.checkBeforeToolCall('lookup', { id: 3 })).toEqual({
      allowed: false,
      stopReason: 'max_tool_calls',
    });

    // max_handoffs (non-oscillating chain: triage -> billing -> tech)
    expect(limiter.checkBeforeHandoff('triage', 'billing')).toEqual({ allowed: true });
    limiter.recordHandoff('billing');
    expect(limiter.checkBeforeHandoff('billing', 'tech')).toEqual({ allowed: true });
    limiter.recordHandoff('tech');
    expect(limiter.checkBeforeHandoff('tech', 'escalation')).toEqual({
      allowed: false,
      stopReason: 'max_handoffs',
    });

    // max_seconds
    nowMs = 10_999;
    expect(limiter.checkTime()).toBeNull();
    nowMs = 11_000;
    expect(limiter.checkTime()).toBe('max_seconds');

    const timeLimiter = new FlowRunLimiter('triage', { maxSeconds: 5 }, 0, () => nowMs);
    nowMs = 5_000;
    expect(timeLimiter.checkBeforeModelStep()).toEqual({
      allowed: false,
      stopReason: 'max_seconds',
    });
    expect(timeLimiter.checkBeforeToolCall('lookup', {})).toEqual({
      allowed: false,
      stopReason: 'max_seconds',
    });
    expect(timeLimiter.checkBeforeHandoff('triage', 'billing')).toEqual({
      allowed: false,
      stopReason: 'max_seconds',
    });
  });

  it('stops right after the model step that crosses maxTokens (at most 1 step over)', () => {
    const limiter = new FlowRunLimiter('triage', { maxSteps: 10, maxTokens: 100 });

    expect(limiter.checkBeforeModelStep()).toEqual({ allowed: true });
    const step1 = limiter.recordModelStep(40, 20);
    expect(step1.exceededTokenLimit).toBe(false);
    expect(step1.counters.totalTokens).toBe(60);

    expect(limiter.checkBeforeModelStep()).toEqual({ allowed: true });
    const step2 = limiter.recordModelStep(30, 25);
    expect(step2.exceededTokenLimit).toBe(true);
    expect(step2.counters.totalTokens).toBe(115);
    expect(step2.counters.steps).toBe(2);

    expect(limiter.checkBeforeModelStep()).toEqual({
      allowed: false,
      stopReason: 'max_tokens',
    });
  });

  it('allows identical (toolName, args) twice and stops 3rd attempt with loop_detected regardless of key order', () => {
    const limiter = new FlowRunLimiter('triage', { maxToolCalls: 20 });

    expect(
      limiter.checkBeforeToolCall('search', { a: 1, b: 2, nested: { x: true, y: 'k' } }),
    ).toEqual({ allowed: true });
    limiter.recordToolCall('search', { a: 1, b: 2, nested: { x: true, y: 'k' } });

    // Second attempt with reordered keys succeeds
    expect(
      limiter.checkBeforeToolCall('search', { nested: { y: 'k', x: true }, b: 2, a: 1 }),
    ).toEqual({ allowed: true });
    limiter.recordToolCall('search', { nested: { y: 'k', x: true }, b: 2, a: 1 });

    // Third identical attempt is stopped
    expect(
      limiter.checkBeforeToolCall('search', { b: 2, nested: { y: 'k', x: true }, a: 1 }),
    ).toEqual({ allowed: false, stopReason: 'loop_detected' });

    // Different args or different tool name are NOT stopped
    expect(
      limiter.checkBeforeToolCall('search', { a: 1, b: 3, nested: { x: true, y: 'k' } }),
    ).toEqual({ allowed: true });
    expect(
      limiter.checkBeforeToolCall('other_tool', { a: 1, b: 2, nested: { x: true, y: 'k' } }),
    ).toEqual({ allowed: true });
  });

  it('detects A -> B -> A -> B ping-pong handoffs on the 3rd handoff', () => {
    const limiter = new FlowRunLimiter('A', { maxHandoffs: 10 });

    // 1st handoff: A -> B
    expect(limiter.checkBeforeHandoff('A', 'B')).toEqual({ allowed: true });
    limiter.recordHandoff('B');

    // 2nd handoff: B -> A
    expect(limiter.checkBeforeHandoff('B', 'A')).toEqual({ allowed: true });
    limiter.recordHandoff('A');

    // 3rd handoff: A -> B would complete A -> B -> A -> B
    expect(limiter.checkBeforeHandoff('A', 'B')).toEqual({
      allowed: false,
      stopReason: 'loop_detected',
    });

    // Handing off to a 3rd agent C is still allowed
    expect(limiter.checkBeforeHandoff('A', 'C')).toEqual({ allowed: true });

    // Also catches oscillation after an entry prefix: entry -> A -> B -> A -> B
    const prefixed = new FlowRunLimiter('entry', { maxHandoffs: 10 });
    expect(prefixed.checkBeforeHandoff('entry', 'A')).toEqual({ allowed: true });
    prefixed.recordHandoff('A');
    expect(prefixed.checkBeforeHandoff('A', 'B')).toEqual({ allowed: true });
    prefixed.recordHandoff('B');
    expect(prefixed.checkBeforeHandoff('B', 'A')).toEqual({ allowed: true });
    prefixed.recordHandoff('A');
    expect(prefixed.checkBeforeHandoff('A', 'B')).toEqual({
      allowed: false,
      stopReason: 'loop_detected',
    });
  });

  it('roundtrips LimiterSnapshot across pause and resume without losing counts or active elapsed time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-16T00:00:00.000Z'));

    const limiter = new FlowRunLimiter('A', {
      maxSteps: 5,
      maxToolCalls: 10,
      maxHandoffs: 6,
      maxTokens: 500,
      maxSeconds: 60,
    });

    limiter.recordModelStep(40, 20);
    limiter.recordToolCall('refund', { orderId: 'ORD-1', amount: 10 });
    limiter.recordToolCall('refund', { amount: 10, orderId: 'ORD-1' });
    limiter.recordHandoff('B');
    limiter.recordHandoff('A');

    // 25 seconds of active run time before awaiting approval
    vi.advanceTimersByTime(25_000);
    const snapshotJson = JSON.stringify(limiter.toSnapshot());

    // 5 hours spent waiting for administrator approval
    vi.advanceTimersByTime(5 * 3_600_000);

    const resumed = FlowRunLimiter.fromSnapshot(JSON.parse(snapshotJson));
    expect(resumed.getCounters()).toEqual({
      steps: 1,
      toolCalls: 2,
      handoffs: 2,
      promptTokens: 40,
      completionTokens: 20,
      totalTokens: 60,
    });

    // Prior tool repeat counts and agent ping-pong history are preserved
    expect(resumed.checkBeforeToolCall('refund', { orderId: 'ORD-1', amount: 10 })).toEqual({
      allowed: false,
      stopReason: 'loop_detected',
    });
    expect(resumed.checkBeforeHandoff('A', 'B')).toEqual({
      allowed: false,
      stopReason: 'loop_detected',
    });

    // Active time excludes the 5-hour approval wait (25s used, 35s left of 60s)
    expect(resumed.checkTime()).toBeNull();
    vi.advanceTimersByTime(34_999);
    expect(resumed.checkTime()).toBeNull();
    vi.advanceTimersByTime(1);
    expect(resumed.checkTime()).toBe('max_seconds');
  });
});

describe('Orchestrator trace persistence & masking (T125)', () => {
  beforeEach(() => {
    initDb(':memory:');
  });

  afterEach(() => {
    vi.useRealTimers();
    try {
      getDb().close();
    } catch {
      /* already closed */
    }
  });

  it('masks PII/tokens and truncates UTF-8 safely to 8 KB without lone replacement chars', () => {
    const scope = { kind: 'profile' as const, id: '1' };
    // Fill with 4-byte emoji characters right past 8,192 bytes
    const raw = `alice@example.com +1 415 555 0199 sk-secret1234567890 ${'😀'.repeat(2_500)}`;
    const masked = maskAndTruncateTrace(scope, raw);

    expect(masked).not.toContain('alice@example.com');
    expect(masked).not.toContain('555 0199');
    expect(masked).not.toContain('sk-secret1234567890');
    expect(masked).toContain('[redacted-token]');
    expect(masked).not.toContain('\uFFFD');
    expect(masked).toContain('...[truncated]');
    expect(Buffer.byteLength(masked, 'utf8')).toBeLessThanOrEqual(FLOW_LIMITS.stepLogMaxBytes);

    const objMasked = maskAndTruncateTrace(scope, {
      email: 'bob@example.com',
      token: 'Bearer abcdef1234567890',
    });
    expect(objMasked).not.toContain('bob@example.com');
    expect(objMasked).not.toContain('abcdef1234567890');
  });

  it('writes steps immediately, supports ?after=<seq>, pause/resume/finish, and preserves cancel race', () => {
    const scope = { kind: 'profile' as const, id: '7' };
    const run = createRunRecord({
      flowId: 1,
      flowSlug: 'support-flow',
      flowVersion: 2,
      profileId: 7,
      endUser: 'user-7',
      wire: 'openai-chat',
    });
    expect(run.id).toMatch(/^run_/);
    expect(run.status).toBe('running');

    const step1 = appendRunStep({
      runId: run.id,
      kind: 'model',
      agentSlug: 'triage',
      model: 'gpt-4o-mini',
      scopeForMasking: scope,
      input: { prompt: 'Contact carol@example.com' },
      output: { reply: 'Token sk-secret1234567890' },
      promptTokens: 25,
      completionTokens: 15,
      durationMs: 120,
      status: 'ok',
    });
    expect(step1.seq).toBe(1);
    expect(step1.inputMasked).not.toContain('carol@example.com');
    expect(step1.outputMasked).not.toContain('sk-secret1234567890');

    // Immediately visible while run is still running
    const liveDetail = getRunDetail(run.id)!;
    expect(liveDetail.run.status).toBe('running');
    expect(liveDetail.steps).toHaveLength(1);

    const step2 = appendRunStep({
      runId: run.id,
      kind: 'tool',
      agentSlug: 'triage',
      toolName: 'mcp__crm__refund',
      scopeForMasking: scope,
      input: { phone: '+1 415 555 0188' },
      output: { status: 'awaiting_approval' },
      durationMs: 10,
      status: 'ok',
    });
    expect(step2.seq).toBe(2);

    const delta = getRunDetail(run.id, 1)!;
    expect(delta.steps.map((s) => s.seq)).toEqual([2]);

    pauseRunForApproval(
      run.id,
      { steps: 1, toolCalls: 1, handoffs: 0, promptTokens: 25, completionTokens: 15 },
      JSON.stringify({ pending: true }),
    );
    const paused = getRunRecord(run.id)!;
    expect(paused.run.status).toBe('awaiting_approval');
    expect(paused.stateJson).toBe(JSON.stringify({ pending: true }));

    markRunRunning(run.id);
    expect(getRunRecord(run.id)!.run.status).toBe('running');
    expect(getRunRecord(run.id)!.stateJson).toBeNull();

    updateRunProgress(run.id, {
      steps: 2,
      toolCalls: 1,
      handoffs: 0,
      promptTokens: 50,
      completionTokens: 30,
    });
    const afterProgress = getRunRecord(run.id)!.run;
    expect(afterProgress.totalTokens).toBe(80);

    const finished = finishRunRecord(run.id, {
      status: 'completed',
      finalText: 'Done for dave@example.com',
      scopeForMasking: scope,
      counters: {
        steps: 2,
        toolCalls: 1,
        handoffs: 0,
        promptTokens: 50,
        completionTokens: 30,
      },
    });
    expect(finished.status).toBe('completed');
    expect(finished.finishedAt).toBeTruthy();
    expect(finished.finalTextMasked).not.toContain('dave@example.com');

    // Cancel race guard: an already cancelled run is not overwritten by a late completed finish
    const racedRun = createRunRecord({
      flowId: 1,
      flowSlug: 'support-flow',
      flowVersion: 2,
      profileId: 7,
      endUser: null,
      wire: 'anthropic',
    });
    finishRunRecord(racedRun.id, {
      status: 'cancelled',
      scopeForMasking: scope,
    });
    const afterRace = finishRunRecord(racedRun.id, {
      status: 'completed',
      finalText: 'Late completion',
      scopeForMasking: scope,
    });
    expect(afterRace.status).toBe('cancelled');
  });

  it('supports listRuns filters/pagination and pruneExpiredRuns retention cleanup', () => {
    const scope = { kind: 'profile' as const, id: '1' };
    const r1 = createRunRecord({
      flowId: 10,
      flowSlug: 'flow-a',
      flowVersion: 1,
      profileId: 1,
      endUser: null,
      wire: 'openai-chat',
    });
    const r2 = createRunRecord({
      flowId: 10,
      flowSlug: 'flow-a',
      flowVersion: 1,
      profileId: 1,
      endUser: null,
      wire: 'openai-chat',
    });
    const r3 = createRunRecord({
      flowId: 20,
      flowSlug: 'flow-b',
      flowVersion: 1,
      profileId: 2,
      endUser: null,
      wire: 'responses',
    });

    appendRunStep({
      runId: r1.id,
      kind: 'model',
      agentSlug: 'a',
      scopeForMasking: scope,
      input: 'old',
      output: 'old',
      status: 'ok',
    });
    appendRunStep({
      runId: r2.id,
      kind: 'model',
      agentSlug: 'a',
      scopeForMasking: scope,
      input: 'new',
      output: 'new',
      status: 'ok',
    });

    expect(listRuns({ flowId: 10 }).map((r) => r.id)).toEqual([r2.id, r1.id]);
    expect(listRuns({ profileId: 2 }).map((r) => r.id)).toEqual([r3.id]);
    expect(listRuns({ flowId: 10, before: r2.id }).map((r) => r.id)).toEqual([r1.id]);

    // Configure 7-day retention in settings and backdate r1 by 10 days
    getDb()
      .prepare(
        `INSERT INTO settings (key, value)
         VALUES ('ai_platform_retention_v1', '{"runsDays":7,"toolCallsDays":30,"guardExcerptsDays":7}')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run();

    const now = new Date('2026-12-20T00:00:00.000Z');
    getDb()
      .prepare("UPDATE custom_ai_runs SET started_at = '2026-12-09 00:00:00' WHERE id = ?")
      .run(r1.id);
    getDb()
      .prepare("UPDATE custom_ai_runs SET started_at = '2026-12-18 00:00:00' WHERE id IN (?, ?)")
      .run(r2.id, r3.id);

    const deleted = pruneExpiredRuns(undefined, now);
    expect(deleted).toBe(1);
    expect(getRunRecord(r1.id)).toBeNull();
    expect(getRunDetail(r1.id)).toBeNull();
    const orphanSteps = getDb()
      .prepare('SELECT COUNT(*) AS cnt FROM custom_ai_run_steps WHERE run_id = ?')
      .get(r1.id) as { cnt: number };
    expect(orphanSteps.cnt).toBe(0);
    expect(getRunRecord(r2.id)).not.toBeNull();
    expect(getRunRecord(r3.id)).not.toBeNull();
  });
});
