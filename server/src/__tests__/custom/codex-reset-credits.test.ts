import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initDb } from '../../db/index.js';
import { saveAccount, accountRow } from '../../custom/provider-accounts/store.js';
import { parseProviderQuota } from '../../custom/x-gateway/quota/adapters.js';
import { consumeCodexResetCredit, fetchCodexResetCredits } from '../../custom/x-gateway/quota/codex-reset.js';

describe('codex reset credits', () => {
  let accountId: number;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    accountId = saveAccount({
      provider: 'codex',
      label: 'Codex Test',
      subject: null,
      credential: JSON.stringify({
        v: 1,
        kind: 'codex',
        accessToken: 'tok_codex',
        refreshToken: 'ref_codex',
        expiresAt: Date.now() + 3600_000,
        accountId: 'acc_123',
      }),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses rate_limit_reset_credits from Codex /wham/usage as a non-blocking window', () => {
    const windows = parseProviderQuota('codex', {
      rate_limit: {
        primary_window: { used_percent: 25, reset_after_seconds: 1200 },
        secondary_window: { used_percent: 10, reset_after_seconds: 86400 },
      },
      rate_limit_reset_credits: { available_count: 3 },
    });

    const resetWin = windows.find(w => w.id === 'reset_credits');
    expect(resetWin).toBeDefined();
    expect(resetWin?.remaining).toBe(3);
    expect(resetWin?.limit).toBeNull();
    expect(resetWin?.unit).toBe('credits');
    expect(resetWin?.blocking).toBe(false);
  });

  it('fetches and consumes Codex reset credits via chatgpt.com/backend-api/wham/rate-limit-reset-credits', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toBe('Bearer tok_codex');
      expect(headers.get('ChatGPT-Account-ID')).toBe('acc_123');

      if (url.endsWith('/wham/rate-limit-reset-credits')) {
        return new Response(
          JSON.stringify({
            available_count: 2,
            credits: [
              { status: 'available', granted_at: 1700000000, expires_at: 1702592000 },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (url.endsWith('/wham/rate-limit-reset-credits/consume')) {
        const body = JSON.parse(String(init?.body ?? '{}'));
        expect(typeof body.redeem_request_id).toBe('string');
        return new Response(
          JSON.stringify({ code: 'reset', windows_reset: 1, credit: { status: 'used' } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    const row = accountRow(accountId);
    const info = await fetchCodexResetCredits(row);
    expect(info.availableCount).toBe(2);
    expect(info.credits[0]?.status).toBe('available');
    expect(info.credits[0]?.expiresAt).toBeTruthy();

    const consumed = await consumeCodexResetCredit(row);
    expect(consumed.ok).toBe(true);
    expect(consumed.code).toBe('reset');
    expect(consumed.windowsReset).toBe(1);
  });
});
