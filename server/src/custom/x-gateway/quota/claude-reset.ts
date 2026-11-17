// Claude Free limit reset grants ("cedar_ember", ported from 9Router's open-sse/services/usage/claude.js).
import crypto from 'node:crypto';
import { proxyFetch, withKeyProxy } from '../../../lib/proxy.js';
import { parseOAuthCredential } from '../../provider-accounts/oauth-credentials.js';
import { withAccountCredential } from '../../provider-accounts/oauth-lifecycle.js';
import { resolveXGatewayAccountProxy, type AccountRow } from '../../provider-accounts/store.js';

const CLAUDE_USAGE_CEDAR_URL = 'https://api.anthropic.com/api/oauth/usage?cedar_ember=1';
const CLAUDE_PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const CLAUDE_RESET_URL_TEMPLATE = 'https://api.anthropic.com/api/oauth/organizations/{org_id}/reset_rate_limits';
const CLAUDE_CLI_UA = 'claude-cli/2.1.88 (external, cli)';
const CLAUDE_API_VERSION = '2023-06-01';
const CLAUDE_OAUTH_BETA = 'oauth-2025-04-20';

export interface ClaudeResetGrantItem {
  id: string;
  label: string;
  resetsLeft: number;
  resetsTotal: number;
  startsAt: string | null;
  endsAt: string | null;
  clears: string[];
  paused: boolean;
  usableNow: boolean;
  useRequiresLimit: boolean;
}

export interface ClaudeResetGrantsInfo {
  eligible: boolean;
  availableCount: number;
  nextGrantId: string | null;
  expiresAt: string | null;
  clears: string[];
  cooldownUntil: string | null;
  weeklyResetsAt: string | null;
  grants: ClaudeResetGrantItem[];
}

export interface ClaudeResetConsumeResult {
  ok: boolean;
  status: number;
  grantId: string | null;
  result: string | null;
  reason: string | null;
  resetsLeft: number | null;
  message: string | null;
}

function buildClaudeOAuthHeaders(credential: string, json = false): Record<string, string> {
  const structured = parseOAuthCredential(credential);
  const accessToken = structured?.accessToken ?? credential;
  return {
    Authorization: `Bearer ${accessToken}`,
    'anthropic-beta': CLAUDE_OAUTH_BETA,
    'anthropic-version': CLAUDE_API_VERSION,
    'User-Agent': CLAUDE_CLI_UA,
    Accept: 'application/json',
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

export function parseClaudeResetGrants(block: unknown): ClaudeResetGrantsInfo | null {
  if (!block || typeof block !== 'object') return null;
  const b = block as Record<string, any>;
  if (!b.eligible || !Array.isArray(b.grants)) return null;

  const active = b.grants.filter((g: any) => g?.id && !g.paused && Number(g.resets_left) > 0);
  const next = active.find((g: any) => g.id === b.next_grant_id) ?? active[0] ?? null;

  return {
    eligible: true,
    availableCount: active.reduce((sum: number, g: any) => sum + (Number(g.resets_left) || 0), 0),
    nextGrantId: typeof next?.id === 'string' ? next.id : null,
    expiresAt: typeof next?.ends_at === 'string' ? next.ends_at : null,
    clears: Array.isArray(next?.clears) ? next.clears.map(String) : [],
    cooldownUntil: typeof b.cooldown_until === 'string' ? b.cooldown_until : null,
    weeklyResetsAt: typeof b.weekly_resets_at === 'string' ? b.weekly_resets_at : null,
    grants: b.grants
      .filter((g: any) => g && typeof g.id === 'string' && g.id)
      .map((g: any) => ({
        id: String(g.id),
        label: String(g.label || ''),
        resetsLeft: Number(g.resets_left) || 0,
        resetsTotal: Number(g.resets_total) || 0,
        startsAt: typeof g.starts_at === 'string' ? g.starts_at : null,
        endsAt: typeof g.ends_at === 'string' ? g.ends_at : null,
        clears: Array.isArray(g.clears) ? g.clears.map(String) : [],
        paused: g.paused === true,
        usableNow: g.usable_now === true,
        useRequiresLimit: g.use_requires_limit !== false,
      })),
  };
}

async function fetchGrantsWithCredential(account: AccountRow, credential: string): Promise<ClaudeResetGrantsInfo> {
  const response = await proxyFetch(
    CLAUDE_USAGE_CEDAR_URL,
    {
      method: 'GET',
      headers: buildClaudeOAuthHeaders(credential),
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    },
    account.platform,
    'unknown',
  );
  const data = (await response.json().catch(() => null)) as Record<string, any> | null;
  if (!response.ok) {
    const message = typeof data?.error?.message === 'string'
      ? data.error.message
      : `Claude reset grants API unavailable (${response.status}).`;
    throw Object.assign(new Error(message), { status: response.status });
  }
  return parseClaudeResetGrants(data?.cedar_ember) ?? {
    eligible: false,
    availableCount: 0,
    nextGrantId: null,
    expiresAt: null,
    clears: [],
    cooldownUntil: null,
    weeklyResetsAt: null,
    grants: [],
  };
}

export async function fetchClaudeResetGrants(account: AccountRow): Promise<ClaudeResetGrantsInfo> {
  if (account.provider !== 'claude') {
    throw Object.assign(new Error('Claude reset grants are only available for Claude accounts.'), { status: 400 });
  }
  return withKeyProxy(resolveXGatewayAccountProxy(account), () =>
    withAccountCredential(account, credential => fetchGrantsWithCredential(account, credential)),
  );
}

export async function consumeClaudeResetGrant(
  account: AccountRow,
  requestedGrantId?: string,
): Promise<ClaudeResetConsumeResult> {
  if (account.provider !== 'claude') {
    throw Object.assign(new Error('Claude reset grants are only available for Claude accounts.'), { status: 400 });
  }

  return withKeyProxy(resolveXGatewayAccountProxy(account), () =>
    withAccountCredential(account, async credential => {
      let grantId = requestedGrantId?.trim() || '';
      if (!grantId) {
        const grants = await fetchGrantsWithCredential(account, credential);
        grantId = grants.nextGrantId ?? '';
      }
      if (!grantId || !/^[a-z0-9_-]{1,40}$/i.test(grantId)) {
        return {
          ok: false,
          status: 409,
          grantId: null,
          result: null,
          reason: 'no_grant',
          resetsLeft: 0,
          message: 'No eligible Claude free reset grants available.',
        };
      }

      const headers = buildClaudeOAuthHeaders(credential, true);
      const profileRes = await proxyFetch(
        CLAUDE_PROFILE_URL,
        { method: 'GET', headers, signal: AbortSignal.timeout(10_000), redirect: 'error' },
        account.platform,
        'unknown',
      );
      const profile = (await profileRes.json().catch(() => null)) as Record<string, any> | null;
      const orgId = typeof profile?.organization?.uuid === 'string' ? profile.organization.uuid : '';
      if (!profileRes.ok || !orgId) {
        throw Object.assign(new Error(`Cannot resolve Claude organization (${profileRes.status}).`), { status: profileRes.status || 502 });
      }

      const resetRes = await proxyFetch(
        CLAUDE_RESET_URL_TEMPLATE.replace('{org_id}', encodeURIComponent(orgId)),
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ program: 'cedar_ember', grant_id: grantId, request_id: crypto.randomUUID() }),
          signal: AbortSignal.timeout(10_000),
          redirect: 'error',
        },
        account.platform,
        'unknown',
      );
      const data = (await resetRes.json().catch(() => null)) as Record<string, any> | null;
      return {
        ok: resetRes.ok && data?.result === 'reset',
        status: resetRes.status,
        grantId,
        result: typeof data?.result === 'string' ? data.result : null,
        reason: typeof data?.reason === 'string' ? data.reason : null,
        resetsLeft: typeof data?.resets_left === 'number' ? data.resets_left : null,
        message: typeof data?.error?.message === 'string' ? data.error.message : null,
      };
    }),
  );
}
