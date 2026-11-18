export const MIN_CREDENTIAL_WEIGHT = 0;
export const DEFAULT_CREDENTIAL_WEIGHT = 1;
export const MAX_CREDENTIAL_WEIGHT = 1_000_000;

export const DEFAULT_MAX_CONCURRENCY: number | null = null;
export const MAX_ACCOUNT_CONCURRENCY = 10_000;

export const DEFAULT_MAX_QUEUE_SIZE = 20;
export const MAX_ACCOUNT_QUEUE_SIZE = 1_000;

export interface AccountSemaphoreGateSnapshot {
  running: number;
  queued: number;
  maxConcurrency: number;
  blockedUntil: string | null;
}

export interface AccountSemaphoreSnapshot {
  accountId: number;
  provider: string;
  running: number;
  queued: number;
  maxConcurrency: number | null;
  blockedUntil: string | null;
  modelGates?: Record<string, AccountSemaphoreGateSnapshot>;
}

export interface AccountResiliencePolicy {
  accountId: number;
  weight: number;
  maxConcurrency: number | null;
  maxQueueSize: number;
  failFast: boolean;
  refreshCircuitUntil: string | null;
  refreshFailureCount: number;
  lastRefreshError: string | null;
  updatedAt: string | null;
}

export interface AccountResiliencePatch {
  weight?: number;
  maxConcurrency?: number | null;
  maxQueueSize?: number;
  failFast?: boolean;
}

export interface AccountResilienceListResponse {
  policies: Record<number, AccountResiliencePolicy>;
  semaphores: Record<number, AccountSemaphoreSnapshot>;
  gates?: Record<string, AccountSemaphoreGateSnapshot>;
}

export interface AccountResilienceMutationResponse {
  ok: boolean;
  policy: AccountResiliencePolicy;
  semaphore: AccountSemaphoreSnapshot;
}
