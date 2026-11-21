/**
 * Live "how I am working on this" steps for the Setup Copilot.
 *
 * A chat turn can run inside `runWithTrace(sink, fn)`; any code it calls may then report a step
 * with `traceStart` / `traceFinish` / `traceDone` without threading a parameter through every
 * function. Outside a trace (tests, non-streaming calls) every function here is a no-op, so
 * instrumented code behaves exactly as before.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { SupportSetupTraceStep } from '@freellmapi/shared/support-setup-copilot.js';

type Sink = (step: SupportSetupTraceStep) => void;
interface TraceContext {
  sink: Sink;
  seq: number;
  open: Map<string, SupportSetupTraceStep>;
  modelCalls: number;
  toolCalls: number;
  source?: 'thruline' | 'freellmapi';
}

const als = new AsyncLocalStorage<TraceContext>();

export function runWithTrace<T>(sink: Sink, fn: () => T): T {
  return als.run({ sink, seq: 0, open: new Map(), modelCalls: 0, toolCalls: 0 }, fn);
}

export function isTracing(): boolean {
  return als.getStore() !== undefined;
}

function emit(ctx: TraceContext, step: SupportSetupTraceStep): void {
  ctx.open.set(step.id, step);
  try {
    ctx.sink(step);
  } catch {
    // A closed connection must never break the chat turn.
  }
}

type StepText = Pick<SupportSetupTraceStep, 'kind' | 'titleVi' | 'titleEn' | 'detailVi' | 'detailEn'>;

/** Starts a step (shown with a spinner). Returns its id, or '' outside a trace. */
export function traceStart(step: StepText): string {
  const ctx = als.getStore();
  if (!ctx) return '';
  ctx.seq += 1;
  const id = `s${ctx.seq}`;
  emit(ctx, { ...step, id, status: 'running' });
  return id;
}

/** Finishes a step started with `traceStart`, optionally replacing its detail. */
export function traceFinish(
  id: string,
  status: 'done' | 'error' = 'done',
  detail?: Pick<SupportSetupTraceStep, 'detailVi' | 'detailEn'>,
): void {
  const ctx = als.getStore();
  const prev = id ? ctx?.open.get(id) : undefined;
  if (!ctx || !prev) return;
  emit(ctx, { ...prev, ...(detail ?? {}), status });
}

/** A step that is already finished when it is reported. */
export function traceDone(step: StepText, status: 'done' | 'error' = 'done'): void {
  const id = traceStart(step);
  traceFinish(id, status);
}

/** Runs `fn` as one step: spinner while it runs, then a tick (or a cross if it throws). */
export async function traceStep<T>(
  step: StepText,
  fn: () => Promise<T> | T,
  detailOf?: (result: T) => Pick<SupportSetupTraceStep, 'detailVi' | 'detailEn'> | undefined,
): Promise<T> {
  const id = traceStart(step);
  try {
    const result = await fn();
    traceFinish(id, 'done', detailOf?.(result));
    return result;
  } catch (err) {
    traceFinish(id, 'error');
    throw err;
  }
}

/** Counts one real upstream model request (a retry or a failover attempt counts again). No-op outside a trace. */
export function traceCountModelCall(): void {
  const ctx = als.getStore();
  if (ctx) ctx.modelCalls += 1;
}

/** Counts one tool call made while answering. No-op outside a trace. */
export function traceCountToolCall(): void {
  const ctx = als.getStore();
  if (ctx) ctx.toolCalls += 1;
}

/** Records which model source answered (the last one wins). No-op outside a trace. */
export function traceNoteSource(source: 'thruline' | 'freellmapi'): void {
  const ctx = als.getStore();
  if (ctx) ctx.source = source;
}

/** What the current traced turn has cost so far, or null outside a trace. */
export function traceUsage(): { modelCalls: number; toolCalls: number; source?: 'thruline' | 'freellmapi' } | null {
  const ctx = als.getStore();
  if (!ctx) return null;
  return { modelCalls: ctx.modelCalls, toolCalls: ctx.toolCalls, ...(ctx.source ? { source: ctx.source } : {}) };
}
