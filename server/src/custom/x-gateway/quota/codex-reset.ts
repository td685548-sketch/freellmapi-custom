// Codex rate-limit reset credits (ported from 9Router's open-sse/services/usage/codex.js).
import crypto from 'node:crypto';
import { proxyFetch, withKeyProxy } from '../../../lib/proxy.js';
import { parseOAuthCredential } from '../../provider-accounts/oauth-credentials.js';
import { withAccountCredential } from '../../provider-accounts/oauth-lifecycle.js';
import { resolveXGatewayAccountProxy, type AccountRow } from '../../provider-accounts/store.js';

const RESET_CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';
const RESET_CREDITS_CONSUME_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume';

export interface CodexResetCreditItem {
  status: string;
  grantedAt: string | null;
  expiresAt: string | null;
}

export interface CodexResetCreditsInfo {
  availableCount: number;
  credits: CodexResetCreditItem[];
}

export interface CodexResetConsumeResult {
  ok: boolean;
  noCredit: boolean;
  status: number;
  code: string | null;
  windowsReset: number;
  redeemRequestId: string;
  message: string | null;
  credit: unknown;
}

function toIsoDate(value: unknown): string | null {
  if (!value) return null;
  const num = typeof value === 'number' ? value : Number(value);
  const date = Number.isFinite(num) && typeof value === 'number'
    ? new Date(num < 1e12 ? num * 1000 : num)
    : new Date(String(value));
  const time = date.getTime();
  return Number.isFinite(time) ? date.toISOString() : null;
}

function toFiniteNonNegInt(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : 0;
}

function extractErrorMessage(data: Record<string, any> | null, fallback: string): string {
  const raw = data?.message ?? data?.error ?? data?.detail;
  if (!raw) return fallback;
  if (typeof raw === 'string') return raw;
  if (typeof raw?.message === 'string') return raw.message;
  return JSON.stringify(raw);
}

function buildCodexHeaders(credential: string, includeBeta = false): Record<string, string> {
  const structured = parseOAuthCredential(credential);
  const accessToken = structured?.accessToken ?? credential;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
    'User-Agent': 'FreeLLMAPI/0.2.1',
  };
  if (includeBeta) {
    headers['OpenAI-Beta'] = 'codex-1';
    headers.originator = 'codex_cli_rs';
  }
  if (structured?.accountId) {
    headers['ChatGPT-Account-ID'] = structured.accountId;
  }
  return headers;
}

export async function fetchCodexResetCredits(account: AccountRow): Promise<CodexResetCreditsInfo> {
  if (account.provider !== 'codex') {
    throw Object.assign(new Error('Codex reset credits are only available for Codex accounts.'), { status: 400 });
  }

  return withKeyProxy(resolveXGatewayAccountProxy(account), () =>
    withAccountCredential(account, async credential => {
      const response = await proxyFetch(
        RESET_CREDITS_URL,
        {
          method: 'GET',
          headers: buildCodexHeaders(credential, true),
          signal: AbortSignal.timeout(10_000),
          redirect: 'error',
        },
        account.platform,
        'unknown',
      );

      const data = (await response.json().catch(() => null)) as Record<string, any> | null;
      if (!response.ok) {
        const message = extractErrorMessage(data, `Codex reset credits API unavailable (${response.status}).`);
        throw Object.assign(new Error(message), { status: response.status });
      }

      const credits = Array.isArray(data?.credits) ? data.credits : [];
      return {
        availableCount: toFiniteNonNegInt(data?.available_count ?? data?.availableCount),
        credits: credits.map((credit: Record<string, any>) => ({
          status: String(credit?.status || 'unknown'),
          grantedAt: toIsoDate(credit?.granted_at ?? credit?.grantedAt),
          expiresAt: toIsoDate(credit?.expires_at ?? credit?.expiresAt),
        })),
      };
    }),
  );
}

export async function consumeCodexResetCredit(account: AccountRow): Promise<CodexResetConsumeResult> {
  if (account.provider !== 'codex') {
    throw Object.assign(new Error('Codex reset credits are only available for Codex accounts.'), { status: 400 });
  }

  const redeemRequestId = crypto.randomUUID();

  return withKeyProxy(resolveXGatewayAccountProxy(account), () =>
    withAccountCredential(account, async credential => {
      const response = await proxyFetch(
        RESET_CREDITS_CONSUME_URL,
        {
          method: 'POST',
          headers: {
            ...buildCodexHeaders(credential, false),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ redeem_request_id: redeemRequestId }),
          signal: AbortSignal.timeout(10_000),
          redirect: 'error',
        },
        account.platform,
        'unknown',
      );

      const text = await response.text().catch(() => '');
      let data: Record<string, any> | null = null;
      try {
        data = text ? (JSON.parse(text) as Record<string, any>) : null;
      } catch {
        data = null;
      }

      const code = typeof data?.code === 'string' ? data.code : null;
      const windowsReset = toFiniteNonNegInt(data?.windows_reset);
      const ok = response.ok && (code === 'reset' || windowsReset > 0);
      const noCredit = response.ok && code === 'no_credit';

      return {
        ok,
        noCredit,
        status: response.status,
        code,
        windowsReset,
        redeemRequestId,
        message: typeof data?.message === 'string' ? data.message : null,
        credit: data?.credit ?? null,
      };
    }),
  );
}
