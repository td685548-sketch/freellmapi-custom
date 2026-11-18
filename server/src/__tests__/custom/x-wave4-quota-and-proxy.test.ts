import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import { initDb } from '../../db/index.js';
import { createSession, createUser } from '../../services/auth.js';
import { fetchAccountQuota, parseProviderQuota, supportsQuota } from '../../custom/x-gateway/quota/adapters.js';
import { createApiKeyAccount, accountRow, resolveXGatewayAccountProxy } from '../../custom/provider-accounts/store.js';

const REAL_FETCH = globalThis.fetch.bind(globalThis);

function makeAccount(provider: string, rawCred: string, authMethod: 'api_key' | 'oauth_pkce' | 'device_code' | 'cookie' = 'oauth_pkce') {
  const id = createApiKeyAccount({ provider, key: rawCred, label: `Test ${provider}`, authMethod });
  return accountRow(id);
}

describe('Wave 4 Quota Trackers, Claude Free Reset Grant, and Proxy Pool Auto-Rotation', () => {
  let server: Server;
  let baseUrl = '';
  let adminToken = '';

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'd'.repeat(64);
    initDb(':memory:');
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', r));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;

    const owner = createUser(`wave4-admin-${Date.now()}@example.test`, 'TestPass#1234');
    adminToken = createSession(owner.userId);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
  });

  it('supports and parses quota windows for Wave 4 providers and Claude cedar_ember grants', async () => {
    for (const id of [
      'antigravity', 'cline', 'clinepass', 'synthetic', 'cursor',
      'commandcode', 'codebuddy-cn', 'codebuddy', 'grok-cli', 'xiaomi-mimo', 'zed', 'kimi-coding',
    ]) {
      expect(supportsQuota({ provider: id, base_url: null })).toBe(true);
    }

    // Claude limits[] + cedar_ember.grants
    const claudeWin = parseProviderQuota('claude', {
      five_hour: { utilization: 25, resets_at: '2026-12-01T00:00:00Z' },
      limits: [{ kind: 'weekly_scoped', percent: 40, resets_at: '2026-12-02T00:00:00Z', scope: { model: { display_name: 'Opus' } } }],
      cedar_ember: {
        eligible: true,
        next_grant_id: 'g-1',
        weekly_resets_at: '2026-12-07T00:00:00Z',
        grants: [{ id: 'g-1', resets_left: 2, paused: false }],
      },
    });
    expect(claudeWin.find((w) => w.id === 'five_hour')?.remaining).toBe(75);
    expect(claudeWin.find((w) => w.id === 'weekly_opus')?.remaining).toBe(60);
    expect(claudeWin.find((w) => w.id === 'reset_grants')?.remaining).toBe(2);

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes(':retrieveUserQuotaSummary')) {
        return new Response(JSON.stringify({
          groups: [
            { displayName: 'Gemini Models', buckets: [{ window: 'weekly', remainingFraction: 0.7, resetTime: '2026-12-05T00:00:00Z' }] },
            { displayName: 'Claude & GPT', buckets: [{ window: '5h', remainingFraction: 0.5 }] },
          ],
        }), { status: 200 });
      }
      if (url.includes('app.cline.bot')) {
        return new Response(JSON.stringify({ data: { limits: [{ type: 'five_hour', percentUsed: 15, resetsAt: '2026-12-01T05:00:00Z' }] } }), { status: 200 });
      }
      if (url.includes('synthetic.new')) {
        return new Response(JSON.stringify({ subscription: { limit: 1000, requests: 250, renewsAt: '2026-12-02T00:00:00Z' } }), { status: 200 });
      }
      if (url.includes('api2.cursor.sh')) {
        return new Response(JSON.stringify({ planUsage: { limit: 2000, includedSpend: 500, autoPercentUsed: 10 }, billingCycleEnd: '2026-12-10T00:00:00Z' }), { status: 200 });
      }
      if (url.includes('alpha/whoami')) return new Response(JSON.stringify({ org: { id: 'org-9' } }), { status: 200 });
      if (url.includes('alpha/billing/credits')) {
        return new Response(JSON.stringify({ credits: { monthlyCredits: 10, purchasedCredits: 5, freeCredits: 2 }, windowLimits: { fiveHour: { cap: 20, used: 5 } } }), { status: 200 });
      }
      if (url.includes('alpha/billing/subscriptions')) {
        return new Response(JSON.stringify({ data: { currentPeriodEnd: '2026-12-30T00:00:00Z' } }), { status: 200 });
      }
      if (url.includes('copilot.tencent.com')) {
        const nowSec = Math.floor(Date.now() / 1000);
        return new Response(JSON.stringify({
          code: 0,
          data: {
            Response: {
              Data: {
                Accounts: [{ CycleCapacitySize: 500, CycleCapacityUsed: 100, CycleEndTime: nowSec + 86400, DeductionEndTime: nowSec + 30 * 86400 }],
              },
            },
          },
        }), { status: 200 });
      }
      if (url.includes('cli-chat-proxy.grok.com')) {
        return new Response(JSON.stringify({ config: { onDemandCap: { val: 50 }, onDemandUsed: { val: 12 }, billingPeriodEnd: '2026-12-15T00:00:00Z' } }), { status: 200 });
      }
      if (url.includes('xiaomimimo.com')) {
        return new Response(JSON.stringify({ code: 0, data: { percent: 88, resetDate: '2026-12-03' } }), { status: 200 });
      }
      if (url.includes('cloud.zed.dev')) {
        return new Response(JSON.stringify({ plan: { usage: { edit_predictions: { used: 20, limit: { limited: 200 } }, model_requests: { used: 5, limit: { limited: 50 } } } } }), { status: 200 });
      }
      if (url.includes('api.kimi.com')) {
        return new Response(JSON.stringify({ usage: { limit: 100, used: 30, remaining: 70 } }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });

    const ag = await fetchAccountQuota(makeAccount('antigravity', JSON.stringify({ accessToken: 'ag-t', projectId: 'p-1' })));
    expect(ag.find((w) => w.id === 'gemini_weekly')?.remaining).toBe(70);
    expect(ag.find((w) => w.id === 'claude_gpt_session')?.remaining).toBe(50);

    const cl = await fetchAccountQuota(makeAccount('cline', JSON.stringify({ accessToken: 'cline-t' })));
    expect(cl[0]?.remaining).toBe(85);

    const syn = await fetchAccountQuota(makeAccount('synthetic', 'syn_key', 'api_key'));
    expect(syn[0]?.remaining).toBe(750);

    const cur = await fetchAccountQuota(makeAccount('cursor', JSON.stringify({ accessToken: 'cur-t', machineId: 'm-1' })));
    expect(cur.find((w) => w.id === 'Plan (USD)')?.remaining).toBe(15);

    const cc = await fetchAccountQuota(makeAccount('commandcode', 'cc-key', 'api_key'));
    expect(cc.find((w) => w.id === 'Credits')?.remaining).toBe(17);

    const cb = await fetchAccountQuota(makeAccount('codebuddy-cn', JSON.stringify({ accessToken: 'cb-t' })));
    expect(cb[0]?.remaining).toBe(400);

    const gr = await fetchAccountQuota(makeAccount('grok-cli', JSON.stringify({ accessToken: 'gr-t' })));
    expect(gr.find((w) => w.id === 'On-demand')?.remaining).toBe(38);

    const xm = await fetchAccountQuota(makeAccount('xiaomi-mimo', 'xm-key', 'api_key'));
    expect(xm[0]?.remaining).toBe(88);

    const zd = await fetchAccountQuota(makeAccount('zed', JSON.stringify({ accessToken: 'zd-t', userId: 'u-5' })));
    expect(zd.find((w) => w.id === 'Edit Predictions')?.remaining).toBe(180);

    const km = await fetchAccountQuota(makeAccount('kimi', JSON.stringify({ accessToken: 'km-t' })));
    expect(km[0]?.remaining).toBe(70);
    const kmCoding = parseProviderQuota('kimi-coding', { usage: { limit: 100, used: 30, remaining: 70 } });
    expect(kmCoding[0]?.remaining).toBe(70);
  });

  it('fetches and consumes Claude free reset grants via /api/thruline/quota/:id/claude-reset', async () => {
    const accId = createApiKeyAccount({
      provider: 'claude',
      key: JSON.stringify({ accessToken: 'claude-oat-tok', refreshToken: 'claude-ref', expiresAt: Date.now() + 3_600_000 }),
      label: 'My Claude Free',
      authMethod: 'oauth_pkce',
    });

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith(baseUrl)) return REAL_FETCH(input, init);
      if (url.includes('/api/oauth/usage?cedar_ember=1')) {
        return new Response(JSON.stringify({
          cedar_ember: {
            eligible: true,
            next_grant_id: 'ce-123',
            grants: [{ id: 'ce-123', label: 'Promo Reset', resets_left: 1, resets_total: 1, clears: ['five_hour'], usable_now: true }],
          },
        }), { status: 200 });
      }
      if (url.includes('/api/oauth/usage')) {
        return new Response(JSON.stringify({ five_hour: { utilization: 0, resets_at: '2026-12-01T00:00:00Z' } }), { status: 200 });
      }
      if (url.includes('/api/oauth/profile')) {
        return new Response(JSON.stringify({ organization: { uuid: 'org-uuid-1' } }), { status: 200 });
      }
      if (url.includes('/organizations/org-uuid-1/reset_rate_limits')) {
        const body = JSON.parse(String(init?.body || '{}'));
        expect(body.program).toBe('cedar_ember');
        expect(body.grant_id).toBe('ce-123');
        return new Response(JSON.stringify({ result: 'reset', resets_left: 0 }), { status: 200 });
      }
      return REAL_FETCH(input, init);
    });

    const getRes = await REAL_FETCH(`${baseUrl}/api/thruline/quota/${accId}/claude-reset`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(getRes.status).toBe(200);
    const grantsBody = (await getRes.json()) as { eligible: boolean; nextGrantId: string; availableCount: number };
    expect(grantsBody.eligible).toBe(true);
    expect(grantsBody.nextGrantId).toBe('ce-123');
    expect(grantsBody.availableCount).toBe(1);

    const postRes = await REAL_FETCH(`${baseUrl}/api/thruline/quota/${accId}/claude-reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({}),
    });
    expect(postRes.status).toBe(200);
    const postBody = (await postRes.json()) as { ok: boolean; result: string; grantId: string };
    expect(postBody.ok).toBe(true);
    expect(postBody.result).toBe('reset');
    expect(postBody.grantId).toBe('ce-123');
  });

  it('supports proxyPoolId=-1 auto-rotation across enabled pool proxies and autoRotateUnbound config', async () => {
    const p1Res = await REAL_FETCH(`${baseUrl}/api/thruline/proxy-pool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ name: 'Rotate 1', proxyUrl: 'http://198.51.100.101:8080' }),
    });
    const p2Res = await REAL_FETCH(`${baseUrl}/api/thruline/proxy-pool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ name: 'Rotate 2', proxyUrl: 'http://198.51.100.102:8080' }),
    });
    expect(p1Res.status).toBe(201);
    expect(p2Res.status).toBe(201);

    const accId = createApiKeyAccount({
      provider: 'groq',
      key: 'gsk_rotate_test',
      label: 'Rotate Acc',
      proxyPoolId: null,
    });

    const patchRes = await REAL_FETCH(`${baseUrl}/api/thruline-accounts/${accId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ proxyPoolId: -1 }),
    });
    expect(patchRes.status).toBe(200);
    expect(accountRow(accId).proxy_pool_id).toBeNull();

    const listRes = await REAL_FETCH(`${baseUrl}/api/thruline-accounts`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(listRes.status).toBe(200);
    const accList = (await listRes.json()) as { providers: Array<{ id: string; accounts: Array<{ id: number; proxyPoolId?: number }> }> };
    const listed = accList.providers.find((p) => p.id === 'groq')?.accounts.find((a) => a.id === accId);
    expect(listed?.proxyPoolId).toBe(-1);

    const row = accountRow(accId);
    const seen = new Set<string | undefined>([
      resolveXGatewayAccountProxy(row),
      resolveXGatewayAccountProxy(row),
      resolveXGatewayAccountProxy(row),
    ]);
    expect(seen.has('http://198.51.100.101:8080')).toBe(true);
    expect(seen.has('http://198.51.100.102:8080')).toBe(true);

    // Clear explicit -1 and test global autoRotateUnbound
    await REAL_FETCH(`${baseUrl}/api/thruline-accounts/${accId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ proxyPoolId: null }),
    });
    expect(resolveXGatewayAccountProxy(accountRow(accId))).toBeUndefined();

    const cfgRes = await REAL_FETCH(`${baseUrl}/api/thruline/proxy-pool/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ autoRotateUnbound: true }),
    });
    expect(cfgRes.status).toBe(200);
    expect(((await cfgRes.json()) as any).config.autoRotateUnbound).toBe(true);
    const rotated = resolveXGatewayAccountProxy(accountRow(accId));
    expect(['http://198.51.100.101:8080', 'http://198.51.100.102:8080']).toContain(rotated);
  });
});
