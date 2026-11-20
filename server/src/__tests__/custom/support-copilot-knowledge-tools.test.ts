import { beforeAll, describe, expect, it } from 'vitest';
import { runCopilotAgentLoop, type CopilotLlmCall } from '../../custom/support-setup-copilot/agent-loop.js';
import { buildCallerIdentity } from '../../custom/support-setup-copilot/identity.js';
import { resolveCopilotUserScope } from '../../custom/support-setup-copilot/diagnostics.js';
import { executeCopilotTool, filterAdmittedTools } from '../../custom/support-setup-copilot/tools.js';
import { createSupportTenant } from '../../custom/x-gateway/support-store.js';
import { initDb } from '../../db/index.js';
import { createUser, type SessionUser } from '../../services/auth.js';
import { setUserPermissions } from '../../services/users.js';

describe('Setup Copilot — read-only knowledge tools (kb.search / settings.read / tenant.diagnose)', () => {
  let admin: SessionUser;
  let outsider: SessionUser;
  let cacheMember: SessionUser;
  let tenantId: number;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = 'f'.repeat(64);
    initDb(':memory:');
    admin = createUser('kt-admin@example.com', 'AdminPass123!', 'admin');
    const o = createUser('kt-outsider@example.com', 'UserPass123!', 'member');
    outsider = { ...o, permissions: [] };
    const c = createUser('kt-cache@example.com', 'UserPass123!', 'member');
    setUserPermissions(c.userId, ['edit_cache'], admin.userId);
    cacheMember = { ...c, permissions: ['edit_cache'] };
    tenantId = createSupportTenant({
      name: 'KT Tenant', slug: 'kt-tenant', defaultModel: 'auto', systemPrompt: 'A system prompt that is long enough to count.', createdBy: admin.userId,
    }).tenant.id;
  });

  const run = (user: SessionUser, toolId: string, input: unknown = {}, withTenant = true) =>
    executeCopilotTool({ user, toolId, input, tenantId: withTenant ? tenantId : null });

  it('kb.search returns grounded entries with a page path and never mutates anything', async () => {
    const res = await run(admin, 'kb.search', { query: 'allowed origins cors runtime limits' });
    expect(res.status).toBe('executed');
    expect(res.detailEn).toContain('read-only');
    const data = res.result as { results: Array<{ id: string; path: string | null }> };
    expect(data.results.some((r) => r.id === 'step:runtime_policy' && r.path === '/thruline/support-integration')).toBe(true);
  });

  it('kb.search hides permission-gated entries from callers who lack the permission', async () => {
    const res = await run(outsider, 'kb.search', { query: 'response cache enable disable', limit: 6 }, false);
    expect(res.status).toBe('executed');
    const ids = (res.result as { results: Array<{ id: string }> }).results.map((r) => r.id);
    expect(ids).not.toContain('setting:response_cache');
  });

  it('settings.read returns live values only for settings the caller may manage', async () => {
    const all = await run(admin, 'settings.read', {}, false);
    expect(all.status).toBe('executed');
    const snap = all.result as { readable: Array<{ settingId: string }>; hidden: string[] };
    expect(snap.readable).toHaveLength(9);
    expect(snap.hidden).toHaveLength(0);

    const some = await run(cacheMember, 'settings.read', {}, false);
    expect(some.status).toBe('executed');
    const partial = some.result as { readable: Array<{ settingId: string }>; hidden: string[] };
    expect(partial.readable.map((r) => r.settingId)).toEqual(['response_cache']);
    expect(partial.hidden).toHaveLength(8);

    const none = await run(outsider, 'settings.read', {}, false);
    expect(none.status).toBe('denied');
    expect(none.reason).toBe('missing_system_setting_permission');
  });

  it('tenant.diagnose needs a tenant and tenant view access, and returns evidence + findings', async () => {
    const noTenant = await run(admin, 'tenant.diagnose', {}, false);
    expect(noTenant.status).toBe('denied');
    expect(noTenant.reason).toBe('tenant_required');

    const denied = await run(outsider, 'tenant.diagnose', {});
    expect(denied.status).toBe('denied');

    const ok = await run(admin, 'tenant.diagnose', {});
    expect(ok.status).toBe('executed');
    const data = ok.result as { tenant: { name: string }; evidence: { turns: { total: number } }; findings: Array<{ id: string; fix: string }> };
    expect(data.tenant.name).toBe('KT Tenant');
    expect(typeof data.evidence.turns.total).toBe('number');
    expect(data.findings.every((f) => typeof f.fix === 'string' && f.fix.length > 0)).toBe(true);
  });

  it('admits each knowledge tool only where it can work', () => {
    const ctx = (u: SessionUser) => buildCallerIdentity(u, resolveCopilotUserScope(u))!;
    const ids = (u: SessionUser, t: number | null) =>
      filterAdmittedTools({ agentContext: ctx(u), user: u, tenantId: t }).filter((x) => x.kind === 'knowledge').map((x) => x.id);
    expect(ids(outsider, null)).toEqual(['kb.search']);
    expect(ids(cacheMember, null)).toEqual(['kb.search', 'settings.read']);
    expect(ids(admin, tenantId)).toEqual(['kb.search', 'settings.read', 'tenant.diagnose']);
  });

  it('the agent loop hands read-only tool data back to the model for the next step', async () => {
    const seen: string[] = [];
    let call = 0;
    const llmCall: CopilotLlmCall = async (input) => {
      seen.push(input.messages.map((m) => m.content).join('\n'));
      call += 1;
      if (call === 1) {
        return {
          output: { intent: 'guide', reply: 'Để mình tra cứu.', toolCalls: [{ id: 'kb.search', input: { query: 'bước 7 runtime policy' } }] },
          modelUsed: 'fake', routeSource: 'main_gateway_loopback',
        };
      }
      return { output: { intent: 'guide', reply: 'Bước 7 khoá domain CORS.' }, modelUsed: 'fake', routeSource: 'main_gateway_loopback' };
    };
    const scope = resolveCopilotUserScope(admin);
    const result = await runCopilotAgentLoop({
      user: admin,
      scope,
      agentContext: buildCallerIdentity(admin, scope),
      messages: [{ role: 'user', content: 'bước 7 là gì' }],
      locale: 'vi',
      targetMode: 'update_tenant',
      tenantId,
      diagnostic: null,
      extracted: {},
      canCreateTenant: true,
      llmCall,
    });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.stepsTaken).toBe(2);
    // Step 2 saw the tool result *with data*, not just a status.
    expect(seen[1]).toContain('TOOL RESULTS');
    expect(seen[1]).toContain('"data"');
    expect(seen[1]).toContain('step:runtime_policy');
    expect(result.output?.reply).toContain('Bước 7');
  });
});
