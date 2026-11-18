import { beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb, initDb } from '../../db/index.js';
import { createApp } from '../../app.js';
import { createSession, createUser } from '../../services/auth.js';
import { createApiKeyAccount, deleteAccount, invalidateXGatewayKeyCache } from '../../custom/provider-accounts/store.js';
import { setEnabled } from '../../custom/x-gateway/config.js';
import { clearAccountCooldown, getAccountCooldown } from '../../custom/provider-accounts/auto-ping.js';
import { classifyRouteError, filterCandidatesByCooldown, recordCandidateFailure } from '../../custom/x-gateway/route-cooldown.js';
import { listUnavailableOpenCodeModels } from '../../custom/x-gateway/opencode-unavailable.js';

describe('OpenCode unavailable model fallback', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'c'.repeat(64);
    initDb(':memory:');
  });

  it('remembers a model per account, skips it and lets the operator clear it', () => {
    const unavailable = Object.assign(new Error('OpenCode Free API error 400: Upstream request failed: Model is unavailable.'), { status: 400 });
    expect(recordCandidateFailure(41, 'old-free', unavailable)).toMatchObject({ shouldFallback: true, requestScoped: false, reason: 'model_unavailable' });
    expect(listUnavailableOpenCodeModels()).toContainEqual({ accountId: 41, modelId: 'old-free' });
    expect(getAccountCooldown(41, 'old-free').inCooldown).toBe(true);
    const candidates = [{ account: { id: 41 }, modelId: 'old-free' }, { account: { id: 41 }, modelId: 'new-free' }, { account: { id: 42 }, modelId: 'old-free' }];
    expect(filterCandidatesByCooldown(candidates).available).toEqual(candidates.slice(1));
    // The record is stored in the database, not just the transient cooldown map.
    expect((getDb().prepare("SELECT COUNT(*) AS n FROM settings WHERE key GLOB 'x_opencode_unavailable_*'").get() as { n: number }).n).toBe(1);
    clearAccountCooldown(41, 'old-free');
    expect(getAccountCooldown(41, 'old-free').inCooldown).toBe(false);
    expect(listUnavailableOpenCodeModels()).toEqual([]);
  });

  it('does not quarantine unrelated request errors or other providers', () => {
    for (const message of ['OpenCode Free API error 400: Invalid message', 'Other API error 400: Model is unavailable.']) {
      const err = Object.assign(new Error(message), { status: 400 });
      expect(classifyRouteError(err)).toMatchObject({ requestScoped: true, reason: 'request_scoped' });
      recordCandidateFailure(41, 'test-free', err);
    }
    expect(listUnavailableOpenCodeModels()).toEqual([]);
  });

  it('falls back during a Playground request and skips the unavailable model on the next request', async () => {
    const user = createUser('opencode-fallback@example.test', 'AdminPass#1234');
    const session = createSession(user.userId);
    setEnabled(true, user.userId);
    const account = createApiKeyAccount({ provider: 'opencode', key: 'no-auth', label: 'Free', userId: user.userId,
      models: [{ id: 'old-free', name: 'Old' }, { id: 'new-free', name: 'New' }] });
    invalidateXGatewayKeyCache();
    const server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const port = (server.address() as { port: number }).port;
    const realFetch = globalThis.fetch.bind(globalThis);
    const attempted: string[] = [];
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const model = (JSON.parse(String(init?.body)) as { model: string }).model;
      attempted.push(model);
      if (model === 'old-free') return Response.json({ error: { message: 'Upstream request failed: Model is unavailable.' } }, { status: 400 });
      const chunk = { id: 'test', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }] };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
    });
    try {
      const send = () => realFetch(`http://127.0.0.1:${port}/api/thruline/playground/chat`, {
        method: 'POST', headers: { Authorization: `Bearer ${session}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'oc/auto', messages: [{ role: 'user', content: 'hello' }] }),
      });
      const first = await send();
      expect(first.status).toBe(200);
      expect(await first.text()).toContain('hello');
      expect(attempted).toEqual(['old-free', 'new-free']);
      expect(getAccountCooldown(account, 'old-free').inCooldown).toBe(true);
      attempted.length = 0;
      const second = await send();
      expect(await second.text()).toContain('hello');
      expect(attempted).toEqual(['new-free']);
      deleteAccount(account);
      expect(listUnavailableOpenCodeModels()).toEqual([]);
    } finally {
      spy.mockRestore();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('retains unavailable models after reconnecting to the database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-fallback-test-'));
    const path = join(dir, 'test.db');
    try {
      getDb().close?.();
      initDb(path);
      recordCandidateFailure(91, 'retired-free', Object.assign(new Error('OpenCode Free API error 400: Model is unavailable.'), { status: 400 }));
      getDb().close?.();
      initDb(path);
      expect(getAccountCooldown(91, 'retired-free').inCooldown).toBe(true);
      clearAccountCooldown(91, 'retired-free');
      expect(getAccountCooldown(91, 'retired-free').inCooldown).toBe(false);
    } finally {
      getDb().close?.();
      for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
      rmdirSync(dir);
    }
  });
});
