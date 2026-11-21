import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildSystemTargetOverviewReply,
  canUseSystemTarget,
  handleSystemTargetChatTurn,
} from '../../custom/support-setup-copilot/system-target.js';
import { SupportSetupCopilotError } from '../../custom/support-setup-copilot/store.js';
import { initDb } from '../../db/index.js';
import { createUser, type SessionUser } from '../../services/auth.js';
import { setUserPermissions } from '../../services/users.js';

describe('Setup Copilot — System (platform-wide) target', () => {
  let admin: SessionUser;
  let wildcardMember: SessionUser;
  let cacheMember: SessionUser;
  let viewerMember: SessionUser;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = 'd'.repeat(64);
    initDb(':memory:');
    admin = createUser('system-target-admin@example.com', 'AdminPass123!', 'admin');
    const wc = createUser('system-target-wildcard@example.com', 'UserPass123!', 'member');
    setUserPermissions(wc.userId, ['*'], admin.userId);
    wildcardMember = { ...wc, permissions: ['*'] };
    const cm = createUser('system-target-cache@example.com', 'UserPass123!', 'member');
    setUserPermissions(cm.userId, ['edit_cache'], admin.userId);
    cacheMember = { ...cm, permissions: ['edit_cache'] };
    const vm = createUser('system-target-viewer@example.com', 'UserPass123!', 'member');
    setUserPermissions(vm.userId, ['view_cache', 'view_settings'], admin.userId);
    viewerMember = { ...vm, permissions: ['view_cache', 'view_settings'] };
  });

  const turn = (user: SessionUser, content: string, locale: 'vi' | 'en' = 'en') =>
    handleSystemTargetChatTurn({ user, messages: [{ role: 'user', content }], locale });

  it('is offered to whoever could change at least one system setting, and only to them', () => {
    expect(canUseSystemTarget(admin)).toBe(true);
    expect(canUseSystemTarget(wildcardMember)).toBe(true);
    expect(canUseSystemTarget(cacheMember)).toBe(true); // delegated: holds edit_cache
    expect(canUseSystemTarget(viewerMember)).toBe(false); // view-only permissions
    expect(canUseSystemTarget(undefined)).toBe(false);
  });

  it('refuses an account with no system-setting permission with 403 and stages nothing', () => {
    let caught: unknown;
    try {
      turn(viewerMember, 'Turn on the response cache');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SupportSetupCopilotError);
    expect((caught as SupportSetupCopilotError).status).toBe(403);
  });

  it('a delegated account gets exactly its own authority: cache yes, anything else denied with the missing permission', () => {
    const ok = turn(cacheMember, 'Turn on the response cache');
    expect(ok.intent).toBe('propose_setup');
    expect(ok.proposal?.systemActions?.[0]).toMatchObject({ settingId: 'response_cache', canApply: true });

    const denied = turn(cacheMember, 'Turn on the MCP server');
    expect(denied.intent).toBe('guide');
    expect(denied.proposal).toBeNull();
    expect(denied.reply).toContain('edit_settings');
  });

  it('answers an open question with the platform-wide overview, never a tenant proposal', () => {
    const res = turn(admin, 'hello there');
    expect(res.intent).toBe('guide');
    expect(res.proposal).toBeNull();
    expect(res.reply).toBe(buildSystemTargetOverviewReply('en'));
    expect(res.reply).toContain('System-wide');
    expect(res.suggestedQuickReplies.length).toBeGreaterThan(0);

    const vi = turn(admin, 'xin chào', 'vi');
    expect(vi.reply).toContain('Toàn hệ thống');
  });

  it('turns a system-setting request into a consent-gated system_settings proposal', () => {
    const res = turn(admin, 'Turn on the response cache');
    expect(res.intent).toBe('propose_setup');
    expect(res.proposal?.targetMode).toBe('system_settings');
    expect(res.proposal?.status).toBe('pending_consent');
    expect(res.proposal?.tenantId).toBeNull();
    expect(res.proposal?.systemActions?.some((a) => a.settingId === 'response_cache')).toBe(true);
  });
});
