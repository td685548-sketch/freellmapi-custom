import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { createSession, createUser } from '../../services/auth.js';
import {
  acquireAccountGates,
  buildAccountSemaphoreKey,
  buildGlobalSemaphoreKey,
  buildModelSemaphoreKey,
  buildProviderSemaphoreKey,
  getAccountSemaphoreSnapshot,
  getAccountSemaphoreStats,
  isSemaphoreError,
  markGateBlocked,
  resetAllAccountSemaphores,
  syncAccountGateCap,
  unblockAccountGates,
} from '../../custom/provider-accounts/semaphore.js';
import {
  DEFAULT_CREDENTIAL_WEIGHT,
  MAX_CREDENTIAL_WEIGHT,
  getAccountResiliencePolicy,
  normalizeCredentialWeight,
  orderAccountsByWeightAndLoad,
  resetWeightSchedulerForTests,
  upsertAccountResiliencePolicy,
  validateCredentialWeight,
} from '../../custom/provider-accounts/weights.js';
import {
  clearRefreshCircuit,
  computeRefreshBackoffUntil,
  getRefreshCircuitState,
  isInPersistedRefreshBackoff,
  recordRefreshCircuitFailure,
  sanitizeRefreshCircuitError,
} from '../../custom/provider-accounts/refresh-circuit.js';
import {
  accountRow,
  createApiKeyAccount,
  deleteAccount,
  invalidateXGatewayKeyCache,
} from '../../custom/provider-accounts/store.js';
import {
  clearOAuthRefreshState,
  resolveAccountCredential,
} from '../../custom/provider-accounts/oauth-lifecycle.js';
import { pingAccount, stopAutoPingWorker } from '../../custom/provider-accounts/auto-ping.js';
import { invalidateConfigCache } from '../../custom/x-gateway/config.js';
import { mintXGatewayClientKey } from '../../custom/x-gateway/client-keys.js';
import { resetRouteHealth, resetSessionPins, resolveCandidateRoutes } from '../../custom/x-gateway/router.js';

const REAL_FETCH = globalThis.fetch.bind(globalThis);

describe('Spec 033 — Hierarchical Account Semaphore, Weighted Credentials & Persisted OAuth Refresh Circuit', () => {
  let server: Server;
  let baseUrl = '';
  let adminToken = '';
  let xgwKey = '';
  let adminUserId = 0;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'c'.repeat(64);
    initDb(':memory:');
    stopAutoPingWorker();

    const db = getDb();
    db.prepare(
      `INSERT INTO x_gateway_config (key, value, updated_at) VALUES ('enabled', 'true', ?)
       ON CONFLICT(key) DO UPDATE SET value = 'true', updated_at = excluded.updated_at`,
    ).run(new Date().toISOString());
    invalidateConfigCache();

    const admin = createUser(`oauth-sem-admin-${Date.now()}@example.test`, 'AdminPass#1234');
    adminUserId = admin.userId;
    adminToken = createSession(admin.userId);
    xgwKey = mintXGatewayClientKey(admin.userId, 'Resilience Test Key').key;

    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  beforeEach(() => {
    resetAllAccountSemaphores();
    resetWeightSchedulerForTests();
    clearOAuthRefreshState();
    resetRouteHealth();
    resetSessionPins();
    const db = getDb();
    db.prepare('DELETE FROM custom_x_account_resilience').run();
    db.prepare('DELETE FROM x_gateway_keys').run();
    invalidateXGatewayKeyCache();
  });

  afterEach(() => {
    resetAllAccountSemaphores();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    stopAutoPingWorker();
    await new Promise<void>(resolve => server?.close(() => resolve()));
  });

  describe('Hierarchical Account Concurrency Semaphore', () => {
    it('enforces global, provider, account, and collision-safe account:model gates without parent deadlock', async () => {
      expect(buildGlobalSemaphoreKey()).toBe('global');
      expect(buildProviderSemaphoreKey('OpenAI')).toBe('provider:openai');
      expect(buildAccountSemaphoreKey({ provider: 'OpenAI', accountId: 7 })).toBe('account:openai:7');
      expect(buildModelSemaphoreKey({ provider: 'ollama', accountId: 7, model: 'llama3.3:70b' })).toBe(
        'account:ollama:7:model:llama3.3:70b',
      );

      // Account 1 holds 1/1 on account:1 and 1/2 on global + provider.
      const leaseA1 = await acquireAccountGates({
        provider: 'openai',
        accountId: 1,
        model: 'gpt-4o',
        globalMaxConcurrency: 2,
        providerMaxConcurrency: 2,
        accountMaxConcurrency: 1,
        modelMaxConcurrency: 1,
      });

      // Waiter on saturated Account 1 must NOT consume the remaining slot on global/provider!
      let waiterA1Resolved = false;
      const waiterA1Promise = acquireAccountGates({
        provider: 'openai',
        accountId: 1,
        model: 'gpt-4o',
        globalMaxConcurrency: 2,
        providerMaxConcurrency: 2,
        accountMaxConcurrency: 1,
        modelMaxConcurrency: 1,
      }).then(rel => {
        waiterA1Resolved = true;
        return rel;
      });

      const snapA1Busy = getAccountSemaphoreSnapshot('openai', 1, 1);
      expect(snapA1Busy.running).toBe(1);
      expect(snapA1Busy.queued).toBe(1);
      expect(snapA1Busy.modelGates?.['gpt-4o']?.running).toBe(1);

      // Account 2 can still acquire immediately because global (1/2) and provider (1/2) have room.
      const leaseA2 = await acquireAccountGates({
        provider: 'openai',
        accountId: 2,
        model: 'gpt-4o',
        globalMaxConcurrency: 2,
        providerMaxConcurrency: 2,
        accountMaxConcurrency: 1,
      });
      expect(waiterA1Resolved).toBe(false);

      // Releasing leaseA1 is idempotent, frees both global/provider and account:1, and wakes waiterA1!
      leaseA1();
      leaseA1.release();
      const leaseA1Second = await waiterA1Promise;
      expect(waiterA1Resolved).toBe(true);

      leaseA1Second();
      leaseA2();
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(getAccountSemaphoreStats()).toEqual({});
    });

    it('enforces maxQueueSize, failFast, timeoutMs, AbortSignal cleanup, and live cap raises', async () => {
      const held = await acquireAccountGates({
        provider: 'claude',
        accountId: 10,
        accountMaxConcurrency: 1,
        maxQueueSize: 1,
      });

      // Fail-fast rejects immediately without waiting.
      await expect(
        acquireAccountGates({
          provider: 'claude',
          accountId: 10,
          accountMaxConcurrency: 1,
          failFast: true,
        }),
      ).rejects.toMatchObject({ code: 'SEMAPHORE_QUEUE_FULL' });

      // Queue 1 waiter via AbortController (fills maxQueueSize = 1).
      const abortCtrl = new AbortController();
      const queuedAborted = acquireAccountGates({
        provider: 'claude',
        accountId: 10,
        accountMaxConcurrency: 1,
        maxQueueSize: 1,
        signal: abortCtrl.signal,
      });

      // Second waiter exceeds maxQueueSize = 1 -> SEMAPHORE_QUEUE_FULL.
      let queueFullErr: unknown;
      try {
        await acquireAccountGates({
          provider: 'claude',
          accountId: 10,
          accountMaxConcurrency: 1,
          maxQueueSize: 1,
        });
      } catch (err) {
        queueFullErr = err;
      }
      expect(isSemaphoreError(queueFullErr)).toBe(true);
      expect((queueFullErr as { code: string }).code).toBe('SEMAPHORE_QUEUE_FULL');

      // Aborting the queued waiter frees the queue slot immediately.
      abortCtrl.abort();
      await expect(queuedAborted).rejects.toThrow(/aborted/i);
      expect(getAccountSemaphoreSnapshot('claude', 10, 1).queued).toBe(0);

      // Timeout rejects with SEMAPHORE_TIMEOUT and cleans up the queue.
      await expect(
        acquireAccountGates({
          provider: 'claude',
          accountId: 10,
          accountMaxConcurrency: 1,
          maxQueueSize: 2,
          timeoutMs: 35,
        }),
      ).rejects.toMatchObject({ code: 'SEMAPHORE_TIMEOUT' });
      expect(getAccountSemaphoreSnapshot('claude', 10, 1).queued).toBe(0);

      // Raising maxConcurrency dynamically wakes a waiting caller immediately.
      const wokePromise = acquireAccountGates({
        provider: 'claude',
        accountId: 10,
        accountMaxConcurrency: 1,
        maxQueueSize: 2,
      });
      syncAccountGateCap('claude', 10, 2);
      const wokeLease = await wokePromise;
      expect(getAccountSemaphoreSnapshot('claude', 10, 2).running).toBe(2);

      wokeLease();
      held();

      // Gate blocking & unblocking
      const accKey = buildAccountSemaphoreKey({ provider: 'claude', accountId: 10 });
      markGateBlocked(accKey, 5_000);
      expect(getAccountSemaphoreSnapshot('claude', 10, 2).blockedUntil).not.toBeNull();
      unblockAccountGates('claude', 10);
      expect(getAccountSemaphoreSnapshot('claude', 10, 2).blockedUntil).toBeNull();
    });
  });

  describe('Weighted Credentials & Load-Aware Candidate Ordering', () => {
    it('validates strict integer bounds (0..1_000_000) and soft-drains weight 0 without deleting credentials', () => {
      expect(validateCredentialWeight(0)).toBe(0);
      expect(validateCredentialWeight(DEFAULT_CREDENTIAL_WEIGHT)).toBe(1);
      expect(validateCredentialWeight(MAX_CREDENTIAL_WEIGHT)).toBe(1_000_000);
      expect(() => validateCredentialWeight(-1)).toThrow(/between 0 and 1000000/);
      expect(() => validateCredentialWeight(1_000_001)).toThrow(/between 0 and 1000000/);
      expect(() => validateCredentialWeight(1.5)).toThrow(/integer/);
      expect(() => validateCredentialWeight(Number.NaN)).toThrow(/integer/);

      expect(normalizeCredentialWeight(null)).toBe(1);
      expect(normalizeCredentialWeight(undefined)).toBe(1);
      expect(normalizeCredentialWeight(-5)).toBe(0);

      const id1 = createApiKeyAccount({ provider: 'groq', key: 'gsk_test_key_one_123456', label: 'Groq A' });
      const id2 = createApiKeyAccount({ provider: 'groq', key: 'gsk_test_key_two_123456', label: 'Groq B' });

      // Soft-drain Groq A (weight = 0): credential remains intact in DB, excluded from routing.
      upsertAccountResiliencePolicy(id1, { weight: 0 });
      upsertAccountResiliencePolicy(id2, { weight: 3 });

      expect(accountRow(id1).enabled).toBe(1);
      const resolved = resolveCandidateRoutes('groq/llama-3.3-70b-versatile');
      expect(resolved.candidates.map(c => c.account.id)).toEqual([id2]);
    });

    it('distributes proportionally by Smooth Weighted Round-Robin and steers away from saturated/in-flight accounts', async () => {
      const candidates = [
        { id: 101, provider: 'openai' },
        { id: 102, provider: 'openai' },
      ];
      const policies = {
        101: { weight: 1, maxConcurrency: 2 },
        102: { weight: 3, maxConcurrency: 2 },
      };

      // Across 8 calls with idle load, Smooth Weighted Round-Robin selects 102:101 in exact 3:1 (6:2) ratio,
      // and the very first call deterministically picks the highest-weight account (102).
      const picks: number[] = [];
      for (let i = 0; i < 8; i += 1) {
        const ordered = orderAccountsByWeightAndLoad(candidates, { policies });
        picks.push(ordered[0]!.id);
      }
      expect(picks[0]).toBe(102);
      expect(picks.filter(id => id === 102)).toHaveLength(6);
      expect(picks.filter(id => id === 101)).toHaveLength(2);

      // When Account 102 (weight 3, maxConcurrency 2) becomes saturated (running = 2),
      // ordering steers immediately to idle Account 101 (weight 1, running = 0).
      const lease1 = await acquireAccountGates({ provider: 'openai', accountId: 102, accountMaxConcurrency: 2 });
      const lease2 = await acquireAccountGates({ provider: 'openai', accountId: 102, accountMaxConcurrency: 2 });

      const steered = orderAccountsByWeightAndLoad(candidates, { policies });
      expect(steered.map(c => c.id)).toEqual([101, 102]);

      lease1();
      lease2();
    });
  });

  describe('Persisted OAuth Refresh Backoff Circuit', () => {
    it('persists exponential backoff across in-memory cache clears, skips auto-ping & routing, and never logs secrets', async () => {
      const expiredOAuthJson = JSON.stringify({
        v: 1,
        kind: 'claude',
        accessToken: 'sk-ant-oat01-expired-secret-token-value-123456',
        refreshToken: 'rt_super_secret_refresh_token_value_987654',
        expiresAt: Date.now() - 60_000,
      });

      const oauthId = createApiKeyAccount({
        provider: 'claude',
        key: expiredOAuthJson,
        label: 'Claude Sub',
        authMethod: 'oauth_pkce',
      });
      upsertAccountResiliencePolicy(oauthId, { weight: 4, maxConcurrency: 3 });

      // Check exponential backoff calculation: 1m -> 2m -> 4m
      const baseNow = 1_700_000_000_000;
      const u1 = Date.parse(computeRefreshBackoffUntil(1, { nowMs: baseNow }));
      const u2 = Date.parse(computeRefreshBackoffUntil(2, { nowMs: baseNow }));
      const u3 = Date.parse(computeRefreshBackoffUntil(3, { nowMs: baseNow }));
      expect(u1 - baseNow).toBe(60_000);
      expect(u2 - baseNow).toBe(120_000);
      expect(u3 - baseNow).toBe(240_000);

      // Secret redaction check
      const scrubbed = sanitizeRefreshCircuitError(
        new Error('Refresh failed with refresh_token=rt_super_secret_refresh_token_value_987654 Bearer sk-ant-secret123456'),
      );
      expect(scrubbed).not.toContain('rt_super_secret');
      expect(scrubbed).not.toContain('sk-ant-secret123456');
      expect(scrubbed).toContain('[redacted');

      let tokenEndpointHits = 0;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = String(input);
        if (url === 'https://api.anthropic.com/v1/oauth/token') {
          tokenEndpointHits += 1;
          return new Response(JSON.stringify({ error: 'temporarily_unavailable' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return REAL_FETCH(input, init);
      });

      // First call attempts refresh, fails with 503, and persists refresh_circuit_until in SQLite.
      await expect(resolveAccountCredential(accountRow(oauthId))).rejects.toThrow(/temporarily/i);
      expect(tokenEndpointHits).toBe(1);
      expect(isInPersistedRefreshBackoff(oauthId)).toBe(true);
      const afterFail = getAccountResiliencePolicy(oauthId);
      expect(afterFail.refreshFailureCount).toBe(1);
      expect(afterFail.weight).toBe(4);
      expect(afterFail.maxConcurrency).toBe(3);
      expect(afterFail.lastRefreshError).not.toContain('rt_super_secret');

      // Simulate a process restart by wiping all in-memory refresh state.
      clearOAuthRefreshState();

      // 1. Direct credential resolution still honors persisted SQLite backoff without hitting OAuth endpoint!
      await expect(resolveAccountCredential(accountRow(oauthId))).rejects.toThrow(/backoff/i);
      expect(tokenEndpointHits).toBe(1);

      // 2. Background auto-ping skips the account without hitting OAuth endpoint!
      const pingRes = await pingAccount(oauthId);
      expect(pingRes.ok).toBe(false);
      expect(pingRes.skipped).toBe(true);
      expect(tokenEndpointHits).toBe(1);

      // 3. Candidate routing skips the account in persisted refresh backoff!
      const routesWhileBlocked = resolveCandidateRoutes('claude/claude-sonnet-4-5');
      expect(routesWhileBlocked.candidates).toHaveLength(0);
      expect(routesWhileBlocked.allRateLimited).toBe(true);

      // Record a second failure to verify streak increments exponentially, then clear circuit.
      const secondFailure = recordRefreshCircuitFailure(oauthId, new Error('Upstream 502'));
      expect(secondFailure.refreshFailureCount).toBe(2);
      expect(Date.parse(secondFailure.refreshCircuitUntil!)).toBeGreaterThan(
        Date.parse(afterFail.refreshCircuitUntil!),
      );

      // Manual reset clears backoff while keeping weight & maxConcurrency intact.
      const cleared = clearRefreshCircuit(oauthId);
      expect(cleared.refreshCircuitUntil).toBeNull();
      expect(cleared.refreshFailureCount).toBe(0);
      expect(cleared.lastRefreshError).toBeNull();
      expect(cleared.weight).toBe(4);
      expect(cleared.maxConcurrency).toBe(3);
      expect(getRefreshCircuitState(oauthId).inBackoff).toBe(false);

      // Next refresh succeeds and keeps circuit clean.
      vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
        const url = String(input);
        if (url === 'https://api.anthropic.com/v1/oauth/token') {
          tokenEndpointHits += 1;
          return new Response(
            JSON.stringify({
              access_token: 'sk-ant-oat01-fresh-token-999999',
              refresh_token: 'rt_rotated_token_999999',
              expires_in: 3600,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return REAL_FETCH(input, init);
      });

      const refreshedSerialized = await resolveAccountCredential(accountRow(oauthId));
      expect(tokenEndpointHits).toBe(2);
      expect(refreshedSerialized).toContain('sk-ant-oat01-fresh-token-999999');
      expect(isInPersistedRefreshBackoff(oauthId)).toBe(false);
    });
  });

  describe('REST Endpoints & Live /thruline/v1 Gateway Integration', () => {
    it('serves GET/PUT/reset-circuit REST endpoints, cascades deletes, and enforces semaphore failover on /thruline/v1/chat/completions', async () => {
      const acc1 = createApiKeyAccount({
        provider: 'groq',
        key: 'gsk_live_account_one_123456',
        label: 'Groq Primary',
        baseUrl: 'https://93.184.216.34/v1',
        models: [{ id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B' }],
        userId: adminUserId,
      });
      const acc2 = createApiKeyAccount({
        provider: 'groq',
        key: 'gsk_live_account_two_123456',
        label: 'Groq Backup',
        baseUrl: 'https://93.184.216.34/v1',
        models: [{ id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B' }],
        userId: adminUserId,
      });

      // Configure acc1 with maxConcurrency: 1, failFast: true, weight: 5 via REST PUT
      const putRes1 = await REAL_FETCH(`${baseUrl}/api/thruline-accounts/${acc1}/resilience`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ weight: 5, maxConcurrency: 1, maxQueueSize: 4, failFast: true }),
      });
      expect(putRes1.status).toBe(200);
      const putJson1 = (await putRes1.json()) as {
        ok: boolean;
        policy: { weight: number; maxConcurrency: number | null; failFast: boolean };
      };
      expect(putJson1.ok).toBe(true);
      expect(putJson1.policy).toMatchObject({ weight: 5, maxConcurrency: 1, failFast: true });

      // Reject invalid weight > 1,000,000 with 400
      const badPut = await REAL_FETCH(`${baseUrl}/api/thruline-accounts/${acc1}/resilience`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ weight: 1_000_001 }),
      });
      expect(badPut.status).toBe(400);

      // Seed a refresh failure on acc2, inspect via GET /resilience, then clear via POST /reset-circuit
      recordRefreshCircuitFailure(acc2, new Error('Temporary OAuth 503 with token=secret_abc_123456'));
      const listRes = await REAL_FETCH(`${baseUrl}/api/thruline-accounts/resilience`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(listRes.status).toBe(200);
      const listJson = (await listRes.json()) as {
        policies: Record<string, { weight: number; refreshFailureCount: number; lastRefreshError: string | null }>;
        semaphores: Record<string, { running: number; queued: number }>;
      };
      expect(listJson.policies[String(acc1)]?.weight).toBe(5);
      expect(listJson.policies[String(acc2)]?.refreshFailureCount).toBe(1);
      expect(listJson.policies[String(acc2)]?.lastRefreshError).not.toContain('secret_abc_123456');

      const resetRes = await REAL_FETCH(`${baseUrl}/api/thruline-accounts/${acc2}/resilience/reset-circuit`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      });
      expect(resetRes.status).toBe(200);
      expect(isInPersistedRefreshBackoff(acc2)).toBe(false);

      // Configure acc2 with maxConcurrency: 1, failFast: true, weight: 1
      await REAL_FETCH(`${baseUrl}/api/thruline-accounts/${acc2}/resilience`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ weight: 1, maxConcurrency: 1, failFast: true }),
      });

      // Mock upstream chat completions so acc1 stays in-flight until released, proving
      // concurrent request #2 fails over cleanly to acc2, and concurrent request #3 gets 429!
      let releaseFirstUpstream!: () => void;
      const firstUpstreamEntered = new Promise<void>(resolve => {
        let entered = false;
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
          const url = String(input);
          if (url.startsWith(baseUrl)) {
            return REAL_FETCH(input, init);
          }
          const authHeader =
            init?.headers instanceof Headers
              ? init.headers.get('authorization')
              : (init?.headers as Record<string, string> | undefined)?.Authorization
                ?? (init?.headers as Record<string, string> | undefined)?.authorization
                ?? '';
          const usedAcc1 = String(authHeader).includes('gsk_live_account_one_123456');
          if (usedAcc1 && !entered) {
            entered = true;
            resolve();
            await new Promise<void>(r => {
              releaseFirstUpstream = r;
            });
          }
          return new Response(
            JSON.stringify({
              id: 'chatcmpl-resilience',
              object: 'chat.completion',
              created: Math.floor(Date.now() / 1000),
              model: 'llama-3.3-70b-versatile',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: usedAcc1 ? 'served-by-acc1' : 'served-by-acc2' },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        });
      });

      const chatReq = () =>
        REAL_FETCH(`${baseUrl}/thruline/v1/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${xgwKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'groq/llama-3.3-70b-versatile',
            messages: [{ role: 'user', content: 'ping' }],
          }),
        });

      const req1Promise = chatReq();
      await firstUpstreamEntered;

      // While req1 holds acc1's sole concurrency slot, req2 steers/fails over to acc2!
      const res2 = await chatReq();
      expect(res2.status).toBe(200);
      const body2 = (await res2.json()) as { choices: Array<{ message: { content: string } }> };
      expect(body2.choices[0]?.message.content).toBe('served-by-acc2');

      // Now block acc2's gate too so BOTH acc1 and acc2 reject on semaphore -> 429 semaphore_queue_full!
      markGateBlocked(buildAccountSemaphoreKey({ provider: 'groq', accountId: acc2 }), 5_000);
      const res3 = await chatReq();
      expect(res3.status).toBe(429);
      const body3 = (await res3.json()) as { error: { code: string } };
      expect(body3.error.code).toBe('semaphore_queue_full');
      unblockAccountGates('groq', acc2);

      releaseFirstUpstream();
      const res1 = await req1Promise;
      expect(res1.status).toBe(200);
      const body1 = (await res1.json()) as { choices: Array<{ message: { content: string } }> };
      expect(body1.choices[0]?.message.content).toBe('served-by-acc1');

      // Deleting acc1 cascades its custom_x_account_resilience row cleanly.
      deleteAccount(acc1);
      const remaining = getDb()
        .prepare('SELECT account_id FROM custom_x_account_resilience WHERE account_id = ?')
        .get(acc1);
      expect(remaining).toBeUndefined();
    });

    it('holds semaphore slot across streaming SSE until completion, returns 503 when all accounts are drained (weight 0), and enforces RBAC on resilience endpoints', async () => {
      const streamAcc = createApiKeyAccount({
        provider: 'groq',
        key: 'gsk_stream_account_123456',
        label: 'Groq Streamer',
        baseUrl: 'https://93.184.216.34/v1',
        models: [{ id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B' }],
        userId: adminUserId,
      });

      upsertAccountResiliencePolicy(streamAcc, { weight: 2, maxConcurrency: 1, failFast: true });

      // Non-privileged member without use_x_gateway/edit_keys gets 403 on PUT /:id/resilience
      const member = createUser(`oauth-sem-member-${Date.now()}@example.test`, 'MemberPass#1234');
      const memberToken = createSession(member.userId);
      const forbiddenRes = await REAL_FETCH(`${baseUrl}/api/thruline-accounts/${streamAcc}/resilience`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${memberToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ weight: 5 }),
      });
      expect(forbiddenRes.status).toBe(403);

      // Hold SSE stream open mid-flight and verify semaphore running === 1 until stream closes!
      let finishStream!: () => void;
      const firstChunkSent = new Promise<void>(resolve => {
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
          const url = String(input);
          if (url.startsWith(baseUrl)) {
            return REAL_FETCH(input, init);
          }
          const enc = new TextEncoder();
          const stream = new ReadableStream<Uint8Array>({
            start(ctrl) {
              const firstChunk = JSON.stringify({
                id: 'chatcmpl-sse-1',
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: 'llama-3.3-70b-versatile',
                choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello ' }, finish_reason: null }],
              });
              ctrl.enqueue(enc.encode(`data: ${firstChunk}\n\n`));
              resolve();
              finishStream = () => {
                const lastChunk = JSON.stringify({
                  id: 'chatcmpl-sse-1',
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model: 'llama-3.3-70b-versatile',
                  choices: [{ index: 0, delta: { content: 'world' }, finish_reason: 'stop' }],
                });
                ctrl.enqueue(enc.encode(`data: ${lastChunk}\n\ndata: [DONE]\n\n`));
                ctrl.close();
              };
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          });
        });
      });

      const ssePromise = REAL_FETCH(`${baseUrl}/thruline/v1/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${xgwKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'groq/llama-3.3-70b-versatile',
          stream: true,
          messages: [{ role: 'user', content: 'stream test' }],
        }),
      }).then(async r => ({ status: r.status, text: await r.text() }));

      await firstChunkSent;
      await new Promise(r => setTimeout(r, 25));
      expect(getAccountSemaphoreSnapshot('groq', streamAcc, 1).running).toBe(1);

      finishStream();
      const sseOut = await ssePromise;
      expect(sseOut.status).toBe(200);
      expect(sseOut.text).toContain('Hello ');
      expect(sseOut.text).toContain('[DONE]');
      expect(getAccountSemaphoreSnapshot('groq', streamAcc, 1).running).toBe(0);

      // Soft-drain the sole account (weight = 0) -> 503 no_available_keys without deleting account
      upsertAccountResiliencePolicy(streamAcc, { weight: 0 });
      const drainedRes = await REAL_FETCH(`${baseUrl}/thruline/v1/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${xgwKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'groq/llama-3.3-70b-versatile',
          messages: [{ role: 'user', content: 'after drain' }],
        }),
      });
      expect(drainedRes.status).toBe(503);
      const drainedJson = (await drainedRes.json()) as { error: { code: string } };
      expect(drainedJson.error.code).toBe('no_available_keys');
      expect(accountRow(streamAcc).enabled).toBe(1);
    });
  });
});
