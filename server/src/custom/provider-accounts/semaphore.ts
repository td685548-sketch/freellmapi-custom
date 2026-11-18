import type {
  AccountSemaphoreGateSnapshot,
  AccountSemaphoreSnapshot,
} from '@freellmapi/shared/account-resilience.js';
import { DEFAULT_MAX_QUEUE_SIZE } from '@freellmapi/shared/account-resilience.js';

export type SemaphoreErrorCode =
  | 'SEMAPHORE_QUEUE_FULL'
  | 'SEMAPHORE_TIMEOUT'
  | 'SEMAPHORE_RESET';

export class SemaphoreError extends Error {
  readonly code: SemaphoreErrorCode;
  readonly status = 429;

  constructor(code: SemaphoreErrorCode, message: string) {
    super(message);
    this.name = 'SemaphoreError';
    this.code = code;
  }
}

export function isSemaphoreError(error: unknown): error is SemaphoreError {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return (
    code === 'SEMAPHORE_QUEUE_FULL'
    || code === 'SEMAPHORE_TIMEOUT'
    || code === 'SEMAPHORE_RESET'
  );
}

export type SemaphoreRelease = (() => void) & {
  release: () => void;
  keys: readonly string[];
};

export interface SemaphoreRequirement {
  key: string;
  maxConcurrency?: number | null;
}

export interface AcquireSemaphoreOptions {
  maxConcurrency?: number | null;
  timeoutMs?: number;
  signal?: AbortSignal | null;
  maxQueueSize?: number;
  failFast?: boolean;
}

export type AcquireManySemaphoreOptions = Omit<AcquireSemaphoreOptions, 'maxConcurrency'>;

export interface AcquireAccountGatesInput {
  provider: string;
  accountId: number | string;
  model?: string | null;
  globalMaxConcurrency?: number | null;
  providerMaxConcurrency?: number | null;
  accountMaxConcurrency?: number | null;
  modelMaxConcurrency?: number | null;
  maxQueueSize?: number;
  failFast?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal | null;
}

interface AcquireRequest {
  keys: string[];
  resolve: (release: SemaphoreRelease) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  signal: AbortSignal | null;
  abortListener: (() => void) | null;
  settled: boolean;
}

interface QueuedAcquire {
  request: AcquireRequest;
}

interface SemaphoreGate {
  running: number;
  maxConcurrency: number;
  queue: QueuedAcquire[];
  blockedUntil: number | null;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const gates = new Map<string, SemaphoreGate>();
const queuedRequests = new Set<AcquireRequest>();
const inFlightByAccount = new Map<string, number>();

function normalizeProviderSegment(provider: string): string {
  return String(provider ?? '').trim().toLowerCase() || 'unknown';
}

export function buildGlobalSemaphoreKey(): string {
  return 'global';
}

export function buildProviderSemaphoreKey(provider: string): string {
  return `provider:${normalizeProviderSegment(provider)}`;
}

export function buildAccountSemaphoreKey(parts: {
  provider: string;
  accountId: number | string;
}): string {
  return `account:${normalizeProviderSegment(parts.provider)}:${String(parts.accountId)}`;
}

export function buildModelSemaphoreKey(parts: {
  provider: string;
  accountId: number | string;
  model: string;
}): string {
  return `${buildAccountSemaphoreKey(parts)}:model:${String(parts.model ?? '').trim()}`;
}

function isBypassed(maxConcurrency?: number | null): boolean {
  return (
    maxConcurrency === null
    || maxConcurrency === undefined
    || !Number.isFinite(maxConcurrency)
    || maxConcurrency <= 0
  );
}

function parsePositiveEnvInt(envName: string): number | null {
  const raw = process.env[envName];
  if (!raw || !raw.trim()) return null;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function attachReleaseMeta(fn: () => void, keys: readonly string[]): SemaphoreRelease {
  const wrapped = (() => {
    fn();
  }) as SemaphoreRelease;
  wrapped.release = wrapped;
  wrapped.keys = keys;
  return wrapped;
}

function createNoopRelease(onOnce?: () => void): SemaphoreRelease {
  let released = false;
  return attachReleaseMeta(() => {
    if (released) return;
    released = true;
    onOnce?.();
  }, []);
}

function ensureGate(key: string, maxConcurrency: number): SemaphoreGate {
  const existing = gates.get(key);
  if (existing) {
    existing.maxConcurrency = maxConcurrency;
    return existing;
  }
  const created: SemaphoreGate = {
    running: 0,
    maxConcurrency,
    queue: [],
    blockedUntil: null,
    cleanupTimer: null,
  };
  gates.set(key, created);
  return created;
}

function isGateBlocked(gate: SemaphoreGate, nowMs = Date.now()): boolean {
  if (!gate.blockedUntil) return false;
  if (nowMs >= gate.blockedUntil) {
    gate.blockedUntil = null;
    return false;
  }
  return true;
}

function clearCleanupTimer(gate: SemaphoreGate): void {
  if (!gate.cleanupTimer) return;
  clearTimeout(gate.cleanupTimer);
  gate.cleanupTimer = null;
}

function cleanupGateIfIdle(key: string): void {
  const gate = gates.get(key);
  if (!gate || gate.running > 0 || gate.queue.length > 0 || isGateBlocked(gate)) return;
  clearCleanupTimer(gate);
  gates.delete(key);
}

function scheduleGateCleanup(key: string): void {
  const gate = gates.get(key);
  if (!gate) return;
  clearCleanupTimer(gate);
  gate.cleanupTimer = setTimeout(() => {
    gate.cleanupTimer = null;
    cleanupGateIfIdle(key);
  }, 0);
  gate.cleanupTimer.unref?.();
}

function makeAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error(
    typeof signal.reason === 'string' && signal.reason
      ? signal.reason
      : 'The operation was aborted',
  );
  error.name = 'AbortError';
  return error;
}

function removeQueuedRequest(request: AcquireRequest): void {
  queuedRequests.delete(request);
  if (request.timer) {
    clearTimeout(request.timer);
    request.timer = null;
  }
  if (request.abortListener && request.signal) {
    request.signal.removeEventListener('abort', request.abortListener);
    request.abortListener = null;
  }
  for (const key of request.keys) {
    const gate = gates.get(key);
    if (!gate) continue;
    const idx = gate.queue.findIndex(q => q.request === request);
    if (idx >= 0) gate.queue.splice(idx, 1);
    if (gate.running === 0 && gate.queue.length === 0 && !isGateBlocked(gate)) {
      scheduleGateCleanup(key);
    }
  }
}

function canRequestAcquire(request: AcquireRequest, nowMs: number): boolean {
  for (const key of request.keys) {
    const gate = gates.get(key);
    if (!gate || isGateBlocked(gate, nowMs) || gate.running >= gate.maxConcurrency) {
      return false;
    }
  }
  return true;
}

function createCompositeRelease(keys: readonly string[], onOnce?: () => void): SemaphoreRelease {
  let released = false;
  return attachReleaseMeta(() => {
    if (released) return;
    released = true;
    for (const key of keys) {
      const gate = gates.get(key);
      if (gate && gate.running > 0) {
        gate.running -= 1;
      }
    }
    onOnce?.();
    drainQueues();
    for (const key of keys) {
      const gate = gates.get(key);
      if (gate && gate.running === 0 && gate.queue.length === 0 && !isGateBlocked(gate)) {
        scheduleGateCleanup(key);
      }
    }
  }, keys);
}

function drainQueues(): void {
  let progressed = true;
  while (progressed) {
    progressed = false;
    const nowMs = Date.now();
    for (const request of queuedRequests) {
      if (request.settled || !canRequestAcquire(request, nowMs)) continue;
      request.settled = true;
      removeQueuedRequest(request);
      for (const key of request.keys) {
        const gate = gates.get(key);
        if (gate) {
          clearCleanupTimer(gate);
          gate.running += 1;
        }
      }
      request.resolve(createCompositeRelease(request.keys));
      progressed = true;
      break;
    }
  }
}

function findQueueRejection(
  keys: readonly string[],
  maxQueueSize: number,
  failFast: boolean,
  nowMs: number,
): SemaphoreError | null {
  if (failFast) {
    const busyKey =
      keys.find(k => {
        const g = gates.get(k);
        return g != null && (g.running >= g.maxConcurrency || isGateBlocked(g, nowMs));
      }) ?? keys[0] ?? 'account';
    return new SemaphoreError(
      'SEMAPHORE_QUEUE_FULL',
      `Semaphore busy (fail-fast) for ${busyKey}`,
    );
  }
  if (maxQueueSize <= 0) return null;
  for (const key of keys) {
    const gate = gates.get(key);
    if (
      gate
      && (gate.running >= gate.maxConcurrency || isGateBlocked(gate, nowMs))
      && gate.queue.length >= maxQueueSize
    ) {
      return new SemaphoreError(
        'SEMAPHORE_QUEUE_FULL',
        `Semaphore queue full (${maxQueueSize}) for ${key}`,
      );
    }
  }
  return null;
}

export function acquire(
  key: string,
  {
    maxConcurrency = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal = null,
    maxQueueSize = DEFAULT_MAX_QUEUE_SIZE,
    failFast = false,
  }: AcquireSemaphoreOptions = {},
): Promise<SemaphoreRelease> {
  return acquireMany([{ key, maxConcurrency }], {
    timeoutMs,
    signal,
    maxQueueSize,
    failFast,
  });
}

/**
 * Acquire all enabled gate requirements atomically in FIFO arrival order.
 * Waiting never increments parent gates while blocked on a child gate.
 */
export function acquireMany(
  requirements: readonly SemaphoreRequirement[],
  {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal = null,
    maxQueueSize = DEFAULT_MAX_QUEUE_SIZE,
    failFast = false,
  }: AcquireManySemaphoreOptions = {},
): Promise<SemaphoreRelease> {
  if (signal?.aborted) {
    return Promise.reject(makeAbortError(signal));
  }

  const enabled = new Map<string, number>();
  for (const req of requirements) {
    if (!req.key || isBypassed(req.maxConcurrency)) continue;
    const limit = Math.trunc(req.maxConcurrency as number);
    const existing = enabled.get(req.key);
    enabled.set(req.key, existing === undefined ? limit : Math.min(existing, limit));
  }

  if (enabled.size === 0) {
    return Promise.resolve(createNoopRelease());
  }

  const keys = [...enabled.keys()].sort();
  for (const key of keys) {
    const gate = ensureGate(key, enabled.get(key)!);
    clearCleanupTimer(gate);
  }

  const nowMs = Date.now();
  const canTakeNow = keys.every(key => {
    const gate = gates.get(key)!;
    return gate.queue.length === 0 && gate.running < gate.maxConcurrency && !isGateBlocked(gate, nowMs);
  });
  if (canTakeNow) {
    for (const key of keys) {
      gates.get(key)!.running += 1;
    }
    return Promise.resolve(createCompositeRelease(keys));
  }

  // Check if all gates actually have room right now (e.g., an earlier waiter on a parent gate
  // is blocked on a disjoint child gate). If not, enforce failFast / maxQueueSize bounds.
  const allGatesHaveRoomNow = keys.every(key => {
    const gate = gates.get(key)!;
    return gate.running < gate.maxConcurrency && !isGateBlocked(gate, nowMs);
  });
  if (!allGatesHaveRoomNow) {
    const rejection = findQueueRejection(keys, maxQueueSize, failFast, nowMs);
    if (rejection) return Promise.reject(rejection);
  }

  const effectiveTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;

  return new Promise<SemaphoreRelease>((resolve, reject) => {
    const request: AcquireRequest = {
      keys,
      resolve,
      reject,
      timer: null,
      signal,
      abortListener: null,
      settled: false,
    };

    request.timer = setTimeout(() => {
      if (request.settled) return;
      request.settled = true;
      removeQueuedRequest(request);
      reject(
        new SemaphoreError(
          'SEMAPHORE_TIMEOUT',
          `Semaphore timeout after ${effectiveTimeoutMs}ms for ${keys.join(',')}`,
        ),
      );
      drainQueues();
    }, effectiveTimeoutMs);
    request.timer.unref?.();

    if (signal) {
      request.abortListener = () => {
        if (request.settled) return;
        request.settled = true;
        removeQueuedRequest(request);
        reject(makeAbortError(signal));
        drainQueues();
      };
      signal.addEventListener('abort', request.abortListener, { once: true });
    }

    queuedRequests.add(request);
    for (const key of keys) {
      gates.get(key)!.queue.push({ request });
    }
    drainQueues();
  });
}

/**
 * Hierarchical concurrency admission across `global`, `provider`, `account`,
 * and `account:model` gates, plus live per-account in-flight tracking.
 */
export async function acquireAccountGates(
  input: AcquireAccountGatesInput,
): Promise<SemaphoreRelease> {
  const globalCap = input.globalMaxConcurrency ?? parsePositiveEnvInt('X_GATEWAY_GLOBAL_MAX_CONCURRENCY');
  const providerCap = input.providerMaxConcurrency ?? parsePositiveEnvInt('X_GATEWAY_PROVIDER_MAX_CONCURRENCY');
  const accountKey = buildAccountSemaphoreKey({
    provider: input.provider,
    accountId: input.accountId,
  });

  const requirements: SemaphoreRequirement[] = [
    { key: buildGlobalSemaphoreKey(), maxConcurrency: globalCap },
    { key: buildProviderSemaphoreKey(input.provider), maxConcurrency: providerCap },
    { key: accountKey, maxConcurrency: input.accountMaxConcurrency },
  ];

  const modelTrimmed = typeof input.model === 'string' ? input.model.trim() : '';
  if (modelTrimmed) {
    requirements.push({
      key: buildModelSemaphoreKey({
        provider: input.provider,
        accountId: input.accountId,
        model: modelTrimmed,
      }),
      maxConcurrency: input.modelMaxConcurrency,
    });
  }

  // Also honor any active blockedUntil on the account/model gate even when maxConcurrency is null.
  const existingAccountGate = gates.get(accountKey);
  if (existingAccountGate && isGateBlocked(existingAccountGate) && isBypassed(input.accountMaxConcurrency)) {
    requirements.push({ key: accountKey, maxConcurrency: existingAccountGate.maxConcurrency });
  }

  const innerRelease = await acquireMany(requirements, {
    timeoutMs: input.timeoutMs,
    signal: input.signal,
    maxQueueSize: input.maxQueueSize,
    failFast: input.failFast,
  });

  inFlightByAccount.set(accountKey, (inFlightByAccount.get(accountKey) ?? 0) + 1);
  let trackedReleased = false;

  return attachReleaseMeta(() => {
    if (trackedReleased) return;
    trackedReleased = true;
    const prev = inFlightByAccount.get(accountKey) ?? 0;
    if (prev <= 1) {
      inFlightByAccount.delete(accountKey);
    } else {
      inFlightByAccount.set(accountKey, prev - 1);
    }
    innerRelease();
  }, innerRelease.keys);
}

export function markGateBlocked(key: string, until: Date | string | number): void {
  const untilMs =
    until instanceof Date
      ? until.getTime()
      : typeof until === 'number'
        ? Date.now() + Math.max(0, until)
        : new Date(until).getTime();
  if (!Number.isFinite(untilMs) || untilMs <= Date.now()) return;
  const gate = ensureGate(key, gates.get(key)?.maxConcurrency ?? 1);
  clearCleanupTimer(gate);
  gate.blockedUntil = untilMs;
}

export function unblockGate(key: string): void {
  const gate = gates.get(key);
  if (!gate) return;
  gate.blockedUntil = null;
  drainQueues();
  cleanupGateIfIdle(key);
}

export function unblockAccountGates(provider: string, accountId: number | string): void {
  const prefix = buildAccountSemaphoreKey({ provider, accountId });
  for (const key of [...gates.keys()]) {
    if (key === prefix || key.startsWith(`${prefix}:model:`)) {
      unblockGate(key);
    }
  }
}

export function syncAccountGateCap(
  provider: string,
  accountId: number | string,
  maxConcurrency: number | null,
): void {
  const key = buildAccountSemaphoreKey({ provider, accountId });
  const gate = gates.get(key);
  if (!gate) return;
  if (isBypassed(maxConcurrency)) {
    gate.maxConcurrency = Number.MAX_SAFE_INTEGER;
    drainQueues();
    if (gate.running === 0 && gate.queue.length === 0 && !isGateBlocked(gate)) {
      scheduleGateCleanup(key);
    }
    return;
  }
  gate.maxConcurrency = Math.trunc(maxConcurrency as number);
  drainQueues();
}

export function getAccountSemaphoreStats(): Record<string, AccountSemaphoreGateSnapshot> {
  const nowMs = Date.now();
  const stats: Record<string, AccountSemaphoreGateSnapshot> = {};
  for (const [key, gate] of gates.entries()) {
    const blocked = isGateBlocked(gate, nowMs);
    if (!blocked && gate.running === 0 && gate.queue.length === 0) {
      continue;
    }
    stats[key] = {
      running: gate.running,
      queued: gate.queue.length,
      maxConcurrency: gate.maxConcurrency,
      blockedUntil: blocked && gate.blockedUntil ? new Date(gate.blockedUntil).toISOString() : null,
    };
  }
  return stats;
}

export function getAccountLiveLoad(
  provider: string,
  accountId: number,
): { running: number; queued: number; blockedUntil: string | null } {
  const accountKey = buildAccountSemaphoreKey({ provider, accountId });
  const gate = gates.get(accountKey);
  const nowMs = Date.now();
  const blocked = gate ? isGateBlocked(gate, nowMs) : false;
  const trackedRunning = inFlightByAccount.get(accountKey) ?? 0;
  const gateRunning = gate?.running ?? 0;
  return {
    running: Math.max(trackedRunning, gateRunning),
    queued: gate?.queue.length ?? 0,
    blockedUntil: blocked && gate?.blockedUntil ? new Date(gate.blockedUntil).toISOString() : null,
  };
}

export function getAccountSemaphoreSnapshot(
  provider: string,
  accountId: number,
  configuredMaxConcurrency: number | null = null,
): AccountSemaphoreSnapshot {
  const accountKey = buildAccountSemaphoreKey({ provider, accountId });
  const modelPrefix = `${accountKey}:model:`;
  const live = getAccountLiveLoad(provider, accountId);
  const gate = gates.get(accountKey);
  const nowMs = Date.now();

  const modelGates: Record<string, AccountSemaphoreGateSnapshot> = {};
  for (const [key, childGate] of gates.entries()) {
    if (!key.startsWith(modelPrefix)) continue;
    const blocked = isGateBlocked(childGate, nowMs);
    if (!blocked && childGate.running === 0 && childGate.queue.length === 0) continue;
    const modelId = key.slice(modelPrefix.length);
    modelGates[modelId] = {
      running: childGate.running,
      queued: childGate.queue.length,
      maxConcurrency: childGate.maxConcurrency,
      blockedUntil:
        blocked && childGate.blockedUntil ? new Date(childGate.blockedUntil).toISOString() : null,
    };
  }

  const effectiveMax =
    configuredMaxConcurrency !== null && configuredMaxConcurrency !== undefined
      ? configuredMaxConcurrency
      : gate && gate.maxConcurrency < Number.MAX_SAFE_INTEGER
        ? gate.maxConcurrency
        : null;

  return {
    accountId,
    provider: normalizeProviderSegment(provider),
    running: live.running,
    queued: live.queued,
    maxConcurrency: effectiveMax,
    blockedUntil: live.blockedUntil,
    ...(Object.keys(modelGates).length > 0 ? { modelGates } : {}),
  };
}

export function isAccountGateSaturated(
  provider: string,
  accountId: number,
  maxConcurrency?: number | null,
): boolean {
  const accountKey = buildAccountSemaphoreKey({ provider, accountId });
  const gate = gates.get(accountKey);
  const nowMs = Date.now();
  if (gate && isGateBlocked(gate, nowMs)) return true;
  const effectiveCap = maxConcurrency ?? (gate && gate.maxConcurrency < Number.MAX_SAFE_INTEGER ? gate.maxConcurrency : null);
  if (isBypassed(effectiveCap)) return false;
  const running = Math.max(inFlightByAccount.get(accountKey) ?? 0, gate?.running ?? 0);
  return running >= (effectiveCap as number);
}

export function resetGate(key: string): void {
  const gate = gates.get(key);
  if (!gate) return;
  clearCleanupTimer(gate);
  const error = new SemaphoreError('SEMAPHORE_RESET', `Semaphore reset for ${key}`);
  const rejections: AcquireRequest[] = [];
  for (const queued of [...gate.queue]) {
    const request = queued.request;
    if (request.settled) continue;
    request.settled = true;
    removeQueuedRequest(request);
    rejections.push(request);
  }
  gates.delete(key);
  for (const request of rejections) {
    request.reject(error);
  }
  drainQueues();
}

export function resetAccountGates(provider: string, accountId: number | string): void {
  const prefix = buildAccountSemaphoreKey({ provider, accountId });
  inFlightByAccount.delete(prefix);
  for (const key of [...gates.keys()]) {
    if (key === prefix || key.startsWith(`${prefix}:model:`)) {
      resetGate(key);
    }
  }
}

export function resetAllAccountSemaphores(): void {
  const error = new SemaphoreError('SEMAPHORE_RESET', 'Semaphore reset');
  const rejections: AcquireRequest[] = [];
  for (const request of [...queuedRequests]) {
    if (request.settled) continue;
    request.settled = true;
    removeQueuedRequest(request);
    rejections.push(request);
  }
  for (const gate of gates.values()) {
    clearCleanupTimer(gate);
  }
  gates.clear();
  queuedRequests.clear();
  inFlightByAccount.clear();
  for (const request of rejections) {
    request.reject(error);
  }
}
