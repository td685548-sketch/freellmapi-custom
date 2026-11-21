import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import { clearAccountCooldown, getAccountCooldown } from '../../custom/provider-accounts/auto-ping.js';
import { CodexProvider } from '../../custom/provider-accounts/codex.js';
import { classifyRouteError, filterCandidatesByCooldown, recordCandidateFailure } from '../../custom/x-gateway/route-cooldown.js';

/**
 * A Codex 400 for a dead model must carry the upstream reason ("The model `gpt-6-sol`
 * does not exist") so the failure is classified as a dead route — not a malformed
 * request — and the route cools down instead of being retried on every turn.
 */
describe('Codex provider: a 400 for a dead model cools the route down', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'c'.repeat(64);
    initDb(':memory:');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    clearAccountCooldown(151, 'gpt-6-sol[1m]');
  });

  const codexCredential = JSON.stringify({
    v: 1,
    kind: 'codex',
    accessToken: 'test-access-token',
    refreshToken: 'test-refresh-token',
    expiresAt: Date.now() + 3600_000,
  });

  it('surfaces the upstream "model does not exist" detail, and that failure cools the route', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(
        JSON.stringify({ error: { message: 'The model `gpt-6-sol` does not exist', code: 'model_not_found' } }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const provider = new CodexProvider();
    let thrown: unknown;
    try {
      await provider.chatCompletion(codexCredential, [{ role: 'user', content: 'hi' }], 'gpt-6-sol[1m]', {
        temperature: 0.45,
        max_tokens: 1000,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as { status?: unknown }).status).toBe(400);
    expect((thrown as Error).message).toContain('The model `gpt-6-sol` does not exist');

    expect(classifyRouteError(thrown)).toMatchObject({ requestScoped: false, reason: 'model_unavailable' });
    recordCandidateFailure(151, 'gpt-6-sol[1m]', thrown);
    expect(getAccountCooldown(151, 'gpt-6-sol[1m]').inCooldown).toBe(true);
    const candidates = [
      { account: { id: 151 }, modelId: 'gpt-6-sol[1m]' },
      { account: { id: 151 }, modelId: 'claude-sonnet-4.5' },
    ];
    expect(filterCandidatesByCooldown(candidates).available).toEqual(candidates.slice(1));
  });

  it('falls back to the status text when the upstream body says nothing', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('Bad Request', { status: 400 }));
    const provider = new CodexProvider();
    await expect(
      provider.chatCompletion(codexCredential, [{ role: 'user', content: 'hi' }], 'gpt-6-sol[1m]', {}),
    ).rejects.toThrow('Codex request failed (HTTP 400): Bad Request');
    expect(getDb()).toBeTruthy();
  });
});
