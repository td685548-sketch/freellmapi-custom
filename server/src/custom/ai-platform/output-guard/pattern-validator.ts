import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import {
  GUARD_ALLOWED_PATTERN_FLAGS,
  OUTPUT_GUARD_LIMITS,
  type GuardPatternRule,
  type GuardPatternsConfig,
} from '@freellmapi/shared/ai-platform-output-guard.js';
import type {
  PatternWorkerPayload,
  PatternWorkerRequest,
  PatternWorkerResponse,
  WorkerPatternMatch,
  WorkerPatternRule,
} from './pattern-worker.js';

export type PatternMatch = WorkerPatternMatch;

export type PatternValidationResult =
  | { ok: true; evalMs?: number }
  | { ok: false; reason: string; code: 'validation_error' | 'unsafe_pattern' };

export class PatternTimeoutError extends Error {
  constructor(
    public readonly code: 'pattern_timeout' | 'pattern_queue_full' | 'pattern_worker_error',
    message: string,
  ) {
    super(message);
    this.name = 'PatternTimeoutError';
  }
}

const ALLOWED_FLAGS = new Set<string>(GUARD_ALLOWED_PATTERN_FLAGS);
const MAX_CONCURRENT_WORKERS = 4;
const MAX_QUEUE_SIZE = 32;
const WORKER_STARTUP_TIMEOUT_MS = 5_000;
const IPC_GRACE_MS = 40;

let nextJobId = 1;
let activeWorkers = 0;
const activeWorkerSet = new Set<Worker>();
const waitQueue: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];

function resolveWorkerTarget(): { spec: string | URL; evalMode: boolean } {
  const jsUrl = new URL('./pattern-worker.js', import.meta.url);
  if (existsSync(fileURLToPath(jsUrl))) {
    return { spec: jsUrl, evalMode: false };
  }
  const tsUrl = new URL('./pattern-worker.ts', import.meta.url);
  if (existsSync(fileURLToPath(tsUrl))) {
    const bootstrap = `import('tsx/esm/api').then(m => { m.register(); return import(${JSON.stringify(tsUrl.href)}); });`;
    return { spec: bootstrap, evalMode: true };
  }
  return { spec: jsUrl, evalMode: false };
}

async function acquireSlot(): Promise<void> {
  if (activeWorkers < MAX_CONCURRENT_WORKERS) {
    activeWorkers += 1;
    return;
  }
  if (waitQueue.length >= MAX_QUEUE_SIZE) {
    throw new PatternTimeoutError('pattern_queue_full', 'Pattern evaluation queue is full.');
  }
  await new Promise<void>((resolve, reject) => {
    waitQueue.push({ resolve, reject });
  });
}

function releaseSlot(): void {
  const next = waitQueue.shift();
  if (next) {
    next.resolve();
    return;
  }
  activeWorkers = Math.max(0, activeWorkers - 1);
}

export async function disposePatternWorkerPool(): Promise<void> {
  while (waitQueue.length > 0) {
    const waiter = waitQueue.shift();
    waiter?.reject(new PatternTimeoutError('pattern_worker_error', 'Pattern worker pool disposed.'));
  }
  const workers = [...activeWorkerSet];
  activeWorkerSet.clear();
  activeWorkers = 0;
  await Promise.all(workers.map((w) => w.terminate().catch(() => 0)));
}

function normalizeRule(
  rule: GuardPatternRule,
): { ok: true; rule: WorkerPatternRule } | { ok: false; reason: string; code: 'validation_error' } {
  if (!rule || typeof rule.pattern !== 'string' || rule.pattern.length === 0) {
    return { ok: false, reason: `Pattern '${rule?.name ?? ''}' must be non-empty.`, code: 'validation_error' };
  }
  if (rule.pattern.length > OUTPUT_GUARD_LIMITS.patternMaxChars) {
    return {
      ok: false,
      reason: `Pattern '${rule.name}' exceeds ${OUTPUT_GUARD_LIMITS.patternMaxChars} characters.`,
      code: 'validation_error',
    };
  }
  const rawFlags = typeof rule.flags === 'string' ? rule.flags : '';
  const deduped: string[] = [];
  for (const ch of rawFlags) {
    if (!ALLOWED_FLAGS.has(ch)) {
      return { ok: false, reason: `Unsupported regex flag '${ch}' in rule '${rule.name}'.`, code: 'validation_error' };
    }
    if (!deduped.includes(ch)) deduped.push(ch);
  }
  const flags = deduped.join('');
  try {
    new RegExp(rule.pattern, flags);
  } catch (err) {
    return {
      ok: false,
      reason: `Invalid regex in '${rule.name}': ${err instanceof Error ? err.message : 'syntax error'}`,
      code: 'validation_error',
    };
  }
  return {
    ok: true,
    rule: {
      id: rule.id,
      name: rule.name,
      pattern: rule.pattern,
      flags,
    },
  };
}

async function runInIsolatedWorker(
  req: PatternWorkerPayload,
  hardEvalBudgetMs: number,
): Promise<Extract<PatternWorkerResponse, { ok: true }>> {
  await acquireSlot();
  const jobId = nextJobId++;
  const target = resolveWorkerTarget();
  let worker: Worker | null = null;
  let startupTimer: NodeJS.Timeout | null = null;
  let evalTimer: NodeJS.Timeout | null = null;
  let settled = false;

  try {
    return await new Promise<Extract<PatternWorkerResponse, { ok: true }>>((resolve, reject) => {
      const cleanup = () => {
        if (startupTimer) {
          clearTimeout(startupTimer);
          startupTimer = null;
        }
        if (evalTimer) {
          clearTimeout(evalTimer);
          evalTimer = null;
        }
        if (worker) {
          activeWorkerSet.delete(worker);
          const w = worker;
          worker = null;
          void w.terminate().catch(() => 0);
        }
      };

      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      worker = new Worker(target.spec, target.evalMode ? { eval: true } : { execArgv: [] });
      worker.unref();
      activeWorkerSet.add(worker);

      startupTimer = setTimeout(() => {
        fail(new PatternTimeoutError('pattern_timeout', 'Pattern worker startup timed out.'));
      }, WORKER_STARTUP_TIMEOUT_MS);

      worker.on('message', (msg: PatternWorkerResponse | { type: 'ready' }) => {
        if (settled) return;
        if ('type' in msg && msg.type === 'ready') {
          if (startupTimer) {
            clearTimeout(startupTimer);
            startupTimer = null;
          }
          evalTimer = setTimeout(() => {
            fail(new PatternTimeoutError('pattern_timeout', `Pattern execution exceeded ${hardEvalBudgetMs}ms.`));
          }, hardEvalBudgetMs + IPC_GRACE_MS);
          worker?.postMessage({ ...req, jobId } as PatternWorkerRequest);
          return;
        }
        if (!('jobId' in msg) || msg.jobId !== jobId) return;
        settled = true;
        cleanup();
        if (!msg.ok) {
          reject(new PatternTimeoutError('pattern_worker_error', msg.message));
          return;
        }
        resolve(msg);
      });

      worker.once('error', (err) => {
        fail(new PatternTimeoutError('pattern_worker_error', err.message));
      });

      worker.once('exit', (code) => {
        if (!settled) {
          fail(new PatternTimeoutError('pattern_worker_error', `Pattern worker exited with code ${code}.`));
        }
      });
    });
  } finally {
    releaseSlot();
  }
}

function buildValidationSamples(): string[] {
  const n = OUTPUT_GUARD_LIMITS.patternEvalSampleChars;
  return [
    'a'.repeat(n - 1) + '!',
    'x'.repeat(n - 1) + '!',
    ' '.repeat(n - 1) + '!',
    '0123456789'.repeat(n / 10),
  ];
}

export async function validatePatternRule(rule: GuardPatternRule): Promise<PatternValidationResult> {
  const norm = normalizeRule(rule);
  if (!norm.ok) return norm;

  const budgetMs = OUTPUT_GUARD_LIMITS.patternEvalBudgetMs;
  const samples = buildValidationSamples();
  try {
    const res = await runInIsolatedWorker(
      { mode: 'validate', rules: [norm.rule], samples },
      budgetMs,
    );
    if (res.evalMs > budgetMs) {
      return {
        ok: false,
        code: 'unsafe_pattern',
        reason: `Pattern '${rule.name}' took ${res.evalMs.toFixed(2)}ms (limit ${budgetMs}ms).`,
      };
    }
    return { ok: true, evalMs: res.evalMs };
  } catch (err) {
    if (err instanceof PatternTimeoutError && err.code === 'pattern_timeout') {
      return {
        ok: false,
        code: 'unsafe_pattern',
        reason: `Pattern '${rule.name}' exceeded ${budgetMs}ms on ${OUTPUT_GUARD_LIMITS.patternEvalSampleChars}-char sample.`,
      };
    }
    return {
      ok: false,
      code: 'validation_error',
      reason: err instanceof Error ? err.message : 'Pattern validation failed.',
    };
  }
}

export async function validatePatternsConfig(config: GuardPatternsConfig): Promise<PatternValidationResult> {
  if (config.rules.length > OUTPUT_GUARD_LIMITS.maxPatterns) {
    return {
      ok: false,
      code: 'validation_error',
      reason: `At most ${OUTPUT_GUARD_LIMITS.maxPatterns} custom patterns are allowed.`,
    };
  }
  let maxEvalMs = 0;
  for (const rule of config.rules) {
    const res = await validatePatternRule(rule);
    if (!res.ok) return res;
    if (res.evalMs !== undefined && res.evalMs > maxEvalMs) maxEvalMs = res.evalMs;
  }
  return { ok: true, evalMs: maxEvalMs };
}

export async function evaluatePatternInWorker(
  rule: GuardPatternRule,
  text: string,
  budgetMs = OUTPUT_GUARD_LIMITS.patternRuntimeBudgetMs,
): Promise<{ matched: boolean; match?: string; index?: number; timedOut?: boolean }> {
  if (!text) return { matched: false };
  const norm = normalizeRule(rule);
  if (!norm.ok) return { matched: false };

  try {
    const res = await runInIsolatedWorker(
      { mode: 'eval', rules: [norm.rule], text, maxMatches: 1 },
      budgetMs,
    );
    const first = res.matches?.[0];
    if (!first) return { matched: false };
    return { matched: true, match: first.match, index: first.start };
  } catch (err) {
    if (err instanceof PatternTimeoutError && err.code === 'pattern_timeout') {
      return { matched: false, timedOut: true };
    }
    return { matched: false, timedOut: true };
  }
}

export async function evaluatePatternsSafe(
  rules: readonly GuardPatternRule[],
  text: string,
  opts?: { timeoutMs?: number; maxMatches?: number },
): Promise<PatternMatch[]> {
  if (rules.length === 0 || text.length === 0) return [];
  if (rules.length > OUTPUT_GUARD_LIMITS.maxPatterns) {
    throw new PatternTimeoutError(
      'pattern_worker_error',
      `At most ${OUTPUT_GUARD_LIMITS.maxPatterns} custom patterns are allowed.`,
    );
  }
  const normalized: WorkerPatternRule[] = [];
  for (const rule of rules) {
    const norm = normalizeRule(rule);
    if (!norm.ok) {
      throw new PatternTimeoutError('pattern_worker_error', norm.reason);
    }
    normalized.push(norm.rule);
  }
  const timeoutMs = opts?.timeoutMs ?? OUTPUT_GUARD_LIMITS.patternRuntimeBudgetMs;
  const res = await runInIsolatedWorker(
    { mode: 'eval', rules: normalized, text, maxMatches: opts?.maxMatches },
    timeoutMs,
  );
  return res.matches ?? [];
}

/**
 * Conservative static check: returns true only when the pattern has a provably
 * finite maximum match length <= maxHoldChars. Any unbounded quantifier (*, +, {n,}),
 * lookaround, or backreference returns false so streaming requires full buffering.
 */
export function isPatternBounded(pattern: string, _flags: string, maxHoldChars: number): boolean {
  if (!pattern || maxHoldChars <= 0) return false;
  let inClass = false;
  let escaped = false;
  let estMaxLen = 0;

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (escaped) {
      escaped = false;
      estMaxLen += 1;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      const next = pattern[i + 1];
      if (next && next >= '1' && next <= '9') return false;
      continue;
    }
    if (inClass) {
      if (ch === ']') {
        inClass = false;
        estMaxLen += 1;
      }
      continue;
    }
    if (ch === '[') {
      inClass = true;
      continue;
    }
    if (ch === '(' && pattern[i + 1] === '?') {
      return false;
    }
    if (ch === '*' || ch === '+') {
      return false;
    }
    if (ch === '{') {
      const close = pattern.indexOf('}', i + 1);
      if (close === -1) return false;
      const inner = pattern.slice(i + 1, close);
      const m = /^(\d+)(?:,(\d*))?$/.exec(inner);
      if (!m) return false;
      if (m[2] === undefined) {
        estMaxLen += Math.max(0, Number(m[1]) - 1);
      } else if (m[2] === '') {
        return false;
      } else {
        estMaxLen += Math.max(0, Number(m[2]) - 1);
      }
      i = close;
      continue;
    }
    if (ch === '?' || ch === '^' || ch === '$' || ch === '|' || ch === '(' || ch === ')') {
      continue;
    }
    estMaxLen += 1;
  }

  return estMaxLen <= maxHoldChars;
}
