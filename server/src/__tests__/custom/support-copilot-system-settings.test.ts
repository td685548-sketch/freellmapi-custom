import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  applySystemSettingsActions,
  buildSystemSettingsPromptSection,
  detectSystemSettingsIntent,
  evaluateSystemSettingsProposal,
  hasAnySystemSettingPermission,
  reprojectSystemActionsForUser,
  SYSTEM_SETTING_IDS,
} from '../../custom/support-setup-copilot/system-settings.js';
import { SupportSetupCopilotError } from '../../custom/support-setup-copilot/store.js';
import {
  getConfigSnapshot,
  getRouteHealthTtlMinutes,
  invalidateConfigCache,
  setDefaultSavers,
  setEnabled,
  setRouteHealthTtlMinutes,
} from '../../custom/x-gateway/config.js';
import { listSupportAuditLogs } from '../../custom/x-gateway/support-enterprise-router.js';
import { getDb, getSetting, initDb, setSetting } from '../../db/index.js';
import { isMcpServerEnabled, MCP_ENABLED_SETTING } from '../../routes/mcp.js';
import { getOllamaEmulationMode } from '../../routes/ollama.js';
import { isAutoUpdateCheckEnabled, UPDATE_CHECK_SETTING } from '../../routes/update.js';
import { createUser, type SessionUser } from '../../services/auth.js';
import { CACHE_ENABLED_SETTING, isCacheEnabled } from '../../services/cache.js';
import { getCompressionConfig, setCompressionConfig } from '../../services/compression/config.js';
import { setUnifyEnabled, UNIFY_ENABLED_KEY } from '../../services/model-groups.js';
import { setUserPermissions } from '../../services/users.js';

describe('Support Copilot Platform & Thruline System Settings Engine', () => {
  let primaryAdmin: SessionUser;
  let cacheOnlyMember: SessionUser;
  let multiPermMember: SessionUser;
  let readOnlyMember: SessionUser;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = 'c'.repeat(64);
    initDb(':memory:');

    primaryAdmin = createUser('sys-primary-admin@example.com', 'AdminPass123!', 'admin');
    cacheOnlyMember = createUser('sys-cache-member@example.com', 'UserPass123!', 'member');
    multiPermMember = createUser('sys-multi-member@example.com', 'UserPass123!', 'member');
    readOnlyMember = createUser('sys-readonly-member@example.com', 'UserPass123!', 'member');
  });

  beforeEach(() => {
    // Reset permissions cleanly in DB and in-memory SessionUser objects
    setUserPermissions(cacheOnlyMember.userId, ['edit_cache'], primaryAdmin.userId);
    cacheOnlyMember = { ...cacheOnlyMember, permissions: ['edit_cache'] };

    setUserPermissions(
      multiPermMember.userId,
      ['edit_x_settings', 'edit_cache', 'manage_compression', 'edit_settings'],
      primaryAdmin.userId,
    );
    multiPermMember = {
      ...multiPermMember,
      permissions: ['edit_x_settings', 'edit_cache', 'manage_compression', 'edit_settings'],
    };

    setUserPermissions(
      readOnlyMember.userId,
      ['view_cache', 'view_settings', 'use_x_gateway', 'view_users'],
      primaryAdmin.userId,
    );
    readOnlyMember = {
      ...readOnlyMember,
      permissions: ['view_cache', 'view_settings', 'use_x_gateway', 'view_users'],
    };

    // Reset all 9 system settings to deterministic baseline values
    setEnabled(false, primaryAdmin.userId);
    setDefaultSavers({ caveman: false, ponytail: 'off', input: 'off' }, primaryAdmin.userId);
    setRouteHealthTtlMinutes(5, primaryAdmin.userId);
    invalidateConfigCache();

    setSetting(CACHE_ENABLED_SETTING, '0');
    setCompressionConfig({ mode: 'off' });
    setUnifyEnabled(true);
    setSetting(MCP_ENABLED_SETTING, '0');
    setSetting(UPDATE_CHECK_SETTING, '0');
    setSetting('ollama_emulation', 'off');
  });

  describe('hasAnySystemSettingPermission', () => {
    it('returns true only for users holding at least one system-setting edit permission or parent grant', () => {
      expect(hasAnySystemSettingPermission(undefined)).toBe(false);
      expect(hasAnySystemSettingPermission(readOnlyMember)).toBe(false);
      expect(
        hasAnySystemSettingPermission({
          userId: 999,
          email: 'none@example.com',
          role: 'member',
          permissions: [],
        }),
      ).toBe(false);

      expect(hasAnySystemSettingPermission(primaryAdmin)).toBe(true);
      expect(hasAnySystemSettingPermission(cacheOnlyMember)).toBe(true);
      expect(
        hasAnySystemSettingPermission({
          userId: 998,
          email: 'parent-x@example.com',
          role: 'member',
          permissions: ['manage_x_gateway'],
        }),
      ).toBe(true);
      expect(
        hasAnySystemSettingPermission({
          userId: 997,
          email: 'parent-s@example.com',
          role: 'member',
          permissions: ['manage_settings'],
        }),
      ).toBe(true);
    });
  });

  describe('detectSystemSettingsIntent', () => {
    it('returns kind="none" for pure informational/how-to questions so platform-guide handles them', () => {
      const informationalPrompts = [
        'cache là gì?',
        'response cache la gi?',
        'what is response cache?',
        'thruline là gì?',
        'token saver hoạt động ra sao?',
        'how do token savers work?',
        'cách bật cache ở đâu?',
        'cach bat mcp server o dau?',
        'where do I enable response cache?',
        'is response cache enabled?',
        'response cache đang bật hay tắt?',
        'thêm API key ở đâu?',
        'backup là gì?',
      ];

      for (const content of informationalPrompts) {
        const res = detectSystemSettingsIntent([{ role: 'user', content }], 'vi');
        expect(res, `Expected "none" for prompt: ${content}`).toEqual({ kind: 'none' });
      }
    });

    it('returns kind="none" for all 7 Tenant Support settings so tenant setup flows stay untouched', () => {
      const tenantPrompts = [
        'bật widget',
        'đổi màu nút chat sang màu hồng',
        'bật SLA phản hồi 5 phút',
        'bật che PII và số điện thoại',
        'bật tường lửa prompt chống prompt injection',
        'đổi model mặc định của tenant sang gpt-4o-mini',
        'thêm domain https://boardgame.vn vào CORS',
        'bat khach vang lai va cap nhat FAQ doi tra',
      ];

      for (const content of tenantPrompts) {
        const res = detectSystemSettingsIntent([{ role: 'user', content }], 'vi');
        expect(res, `Expected "none" for tenant prompt: ${content}`).toEqual({ kind: 'none' });
      }
    });

    it('strictly refuses sensitive credential, password, user role, invite, and backup mutations with screen pointers', () => {
      const cases: Array<{ prompt: string; expectedPath: string }> = [
        { prompt: 'đổi mật khẩu admin giúp mình', expectedPath: '/users' },
        { prompt: 'doi mat khau admin thanh 123456', expectedPath: '/users' },
        { prompt: 'xóa user member@example.com', expectedPath: '/users' },
        { prompt: 'change user role to admin', expectedPath: '/users' },
        { prompt: 'xóa API key giúp mình', expectedPath: '/keys' },
        { prompt: 'rotate gateway master key', expectedPath: '/keys' },
        { prompt: 'cho mình xem gateway master key', expectedPath: '/keys' },
        { prompt: 'tạo mã invite mới cho team', expectedPath: '/invites' },
        { prompt: 'revoke invite code', expectedPath: '/invites' },
        { prompt: 'restore backup mới nhất', expectedPath: '/backups' },
        { prompt: 'khoi phuc du lieu tu backup', expectedPath: '/backups' },
      ];

      for (const { prompt, expectedPath } of cases) {
        const res = detectSystemSettingsIntent([{ role: 'user', content: prompt }], 'vi');
        expect(res.kind, `Expected unsupported_sensitive for: ${prompt}`).toBe(
          'unsupported_sensitive',
        );
        if (res.kind === 'unsupported_sensitive') {
          expect(res.replyVi).toContain(expectedPath);
          expect(res.replyEn).toContain(expectedPath);
        }
      }
    });

    it('detects all 9 safe system settings across accented VI, unaccented VI, and English', () => {
      expect(
        detectSystemSettingsIntent([{ role: 'user', content: 'bật cổng thruline giúp mình' }]),
      ).toEqual({
        kind: 'change_request',
        requests: [{ settingId: 'thruline_gateway_enabled', payload: { enabled: true } }],
      });

      expect(
        detectSystemSettingsIntent([
          { role: 'user', content: 'chỉnh ponytail sang ultra trên thruline' },
        ]),
      ).toEqual({
        kind: 'change_request',
        requests: [{ settingId: 'thruline_token_savers', payload: { ponytail: 'ultra' } }],
      });

      expect(
        detectSystemSettingsIntent([
          { role: 'user', content: 'set thruline route health ttl to 2000 minutes' },
        ]),
      ).toEqual({
        kind: 'change_request',
        requests: [{ settingId: 'thruline_route_health_ttl', payload: { minutes: 1440 } }],
      });

      expect(
        detectSystemSettingsIntent([{ role: 'user', content: 'dat route health ttl -15 phut' }]),
      ).toEqual({
        kind: 'change_request',
        requests: [{ settingId: 'thruline_route_health_ttl', payload: { minutes: 0 } }],
      });

      expect(
        detectSystemSettingsIntent([{ role: 'user', content: 'bat response cache giup minh' }]),
      ).toEqual({
        kind: 'change_request',
        requests: [{ settingId: 'response_cache', payload: { enabled: true } }],
      });

      expect(
        detectSystemSettingsIntent([
          { role: 'user', content: 'bat nen prompt che do lossless' },
        ]),
      ).toEqual({
        kind: 'change_request',
        requests: [
          { settingId: 'prompt_compression', payload: { enabled: true, mode: 'lossless' } },
        ],
      });

      expect(
        detectSystemSettingsIntent([{ role: 'user', content: 'tắt gộp model' }]),
      ).toEqual({
        kind: 'change_request',
        requests: [{ settingId: 'model_unification', payload: { enabled: false } }],
      });

      expect(
        detectSystemSettingsIntent([{ role: 'user', content: 'tắt hợp nhất mô hình' }]),
      ).toEqual({
        kind: 'change_request',
        requests: [{ settingId: 'model_unification', payload: { enabled: false } }],
      });

      expect(
        detectSystemSettingsIntent([{ role: 'user', content: 'enable mcp server' }]),
      ).toEqual({
        kind: 'change_request',
        requests: [{ settingId: 'mcp_server', payload: { enabled: true } }],
      });

      expect(
        detectSystemSettingsIntent([
          { role: 'user', content: 'bật kiểm tra cập nhật tự động' },
        ]),
      ).toEqual({
        kind: 'change_request',
        requests: [{ settingId: 'auto_update_check', payload: { enabled: true } }],
      });

      expect(
        detectSystemSettingsIntent([
          { role: 'user', content: 'tat kiem tra cap nhat tu dong' },
        ]),
      ).toEqual({
        kind: 'change_request',
        requests: [{ settingId: 'auto_update_check', payload: { enabled: false } }],
      });

      expect(
        detectSystemSettingsIntent([
          { role: 'user', content: 'bật giả lập ollama với chế độ open-loopback' },
        ]),
      ).toEqual({
        kind: 'change_request',
        requests: [{ settingId: 'ollama_emulation', payload: { mode: 'open-loopback' } }],
      });

      // Ensure 'key-required' mode on Ollama emulation is NOT misclassified as an API key mutation
      expect(
        detectSystemSettingsIntent([
          { role: 'user', content: 'chuyển ollama emulation sang key-required' },
        ]),
      ).toEqual({
        kind: 'change_request',
        requests: [{ settingId: 'ollama_emulation', payload: { mode: 'key-required' } }],
      });
    });

    it('supports multi-setting requests in a single turn (both shared verb and mixed polarity)', () => {
      const sharedVerb = detectSystemSettingsIntent([
        { role: 'user', content: 'bật response cache và nén prompt giúp mình' },
      ]);
      expect(sharedVerb).toEqual({
        kind: 'change_request',
        requests: [
          { settingId: 'response_cache', payload: { enabled: true } },
          { settingId: 'prompt_compression', payload: { enabled: true, mode: 'standard' } },
        ],
      });

      const mixedPolarity = detectSystemSettingsIntent([
        { role: 'user', content: 'turn on response cache and disable mcp server' },
      ]);
      expect(mixedPolarity).toEqual({
        kind: 'change_request',
        requests: [
          { settingId: 'response_cache', payload: { enabled: true } },
          { settingId: 'mcp_server', payload: { enabled: false } },
        ],
      });
    });
  });

  describe('evaluateSystemSettingsProposal & reprojectSystemActionsForUser', () => {
    it('returns permission_denied with exact missing permission names and zero executable actions when unauthorized', () => {
      const evalRes = evaluateSystemSettingsProposal({
        user: readOnlyMember,
        locale: 'vi',
        messages: [{ role: 'user', content: 'bật response cache và bật cổng thruline giúp mình' }],
      });

      expect(evalRes.outcome).toBe('permission_denied');
      if (evalRes.outcome === 'permission_denied') {
        expect(evalRes.missingPermissions).toEqual(['edit_cache', 'edit_x_settings']);
        expect(evalRes.replyVi).toContain('edit_cache');
        expect(evalRes.replyVi).toContain('edit_x_settings');
        expect(evalRes.replyEn).toContain('edit_cache');
        expect(evalRes.replyEn).toContain('edit_x_settings');
      }
      // Verify DB stayed completely untouched
      expect(isCacheEnabled()).toBe(false);
      expect(getConfigSnapshot().enabled).toBe(false);
    });

    it('marks permitted actions canApply=true and unpermitted actions canApply=false in partial multi-setting turns', () => {
      const evalRes = evaluateSystemSettingsProposal({
        user: cacheOnlyMember,
        locale: 'vi',
        messages: [{ role: 'user', content: 'bật response cache và bật mcp server giúp mình' }],
      });

      expect(evalRes.outcome).toBe('proposed');
      if (evalRes.outcome === 'proposed') {
        expect(evalRes.actions).toHaveLength(2);
        const cacheAction = evalRes.actions.find((a) => a.settingId === 'response_cache')!;
        const mcpAction = evalRes.actions.find((a) => a.settingId === 'mcp_server')!;

        expect(cacheAction.canApply).toBe(true);
        expect(cacheAction.enabledByDefault).toBe(true);
        expect(cacheAction.requiredPermission).toBe('edit_cache');

        expect(mcpAction.canApply).toBe(false);
        expect(mcpAction.enabledByDefault).toBe(false);
        expect(mcpAction.requiredPermission).toBe('edit_settings');

        expect(evalRes.missingPermissions).toEqual(['edit_settings']);
        expect(evalRes.replyVi).toContain('edit_settings');
        expect(evalRes.replyVi).toContain('chưa tự ý thay đổi');
        expect(evalRes.replyEn).toContain('edit_settings');
        expect(evalRes.replyEn).toContain('Nothing has been modified yet');

        // Reproject after revoking edit_cache -> both become canApply=false, enabledByDefault=false
        const afterRevoke = reprojectSystemActionsForUser(evalRes.actions, readOnlyMember);
        expect(afterRevoke.every((a) => !a.canApply && !a.enabledByDefault)).toBe(true);
      }
    });

    it('blocks hallucinated llmSuggestedActions on pure informational or sensitive turns', () => {
      const infoRes = evaluateSystemSettingsProposal({
        user: primaryAdmin,
        locale: 'en',
        messages: [{ role: 'user', content: 'What is response cache?' }],
        llmSuggestedActions: [{ settingId: 'response_cache', payload: { enabled: true } }],
      });
      expect(infoRes.outcome).toBe('none');

      const sensitiveRes = evaluateSystemSettingsProposal({
        user: primaryAdmin,
        locale: 'en',
        messages: [{ role: 'user', content: 'Rotate gateway master key right now' }],
        llmSuggestedActions: [{ settingId: 'mcp_server', payload: { enabled: true } }],
      });
      expect(sensitiveRes.outcome).toBe('unsupported_sensitive');
    });
  });

  describe('applySystemSettingsActions (All 9 Settings, Partial Savers, Audit & Live TOCTOU Protection)', () => {
    it('applies all 9 system settings accurately, preserves untouched token saver fields, and records audit logs', () => {
      // Seed existing Thruline token savers to verify untouched fields are preserved!
      setDefaultSavers({ caveman: true, ponytail: 'full', input: 'off' }, primaryAdmin.userId);
      invalidateConfigCache();

      const proposal = evaluateSystemSettingsProposal({
        user: multiPermMember,
        locale: 'en',
        messages: [
          {
            role: 'user',
            content:
              'enable thruline gateway, set thruline input saver to standard, set route health ttl to 45 minutes, enable response cache, enable prompt compression lossless, disable model unification, enable mcp server, enable auto update check, and set ollama emulation to key-required',
          },
        ],
      });

      expect(proposal.outcome).toBe('proposed');
      if (proposal.outcome !== 'proposed') return;
      expect(proposal.actions.map((a) => a.settingId)).toEqual(
        expect.arrayContaining([...SYSTEM_SETTING_IDS]),
      );

      // Nothing changed before explicit apply!
      expect(getConfigSnapshot().enabled).toBe(false);
      expect(isCacheEnabled()).toBe(false);

      const results = applySystemSettingsActions({
        user: multiPermMember,
        actions: proposal.actions,
      });

      expect(results).toHaveLength(9);
      expect(results.every((r) => r.status === 'applied')).toBe(true);

      // Verify all 9 persisted states
      invalidateConfigCache();
      const snap = getConfigSnapshot();
      expect(snap.enabled).toBe(true);
      // Untouched caveman=true and ponytail='full' MUST be preserved while input='standard' is updated!
      expect(snap.savers).toEqual({
        caveman: true,
        ponytail: 'full',
        input: 'standard',
      });
      expect(getRouteHealthTtlMinutes()).toBe(45);
      expect(isCacheEnabled()).toBe(true);
      expect(getCompressionConfig().mode).toBe('lossless');
      expect(getSetting(UNIFY_ENABLED_KEY)).toBe('0');
      expect(isMcpServerEnabled()).toBe(true);
      expect(isAutoUpdateCheckEnabled()).toBe(true);
      expect(getOllamaEmulationMode()).toBe('key-required');

      // Verify audit log recorded under tenantId='system'
      const audits = listSupportAuditLogs('system');
      const latestAudit = audits.find(
        (a) =>
          a.action === 'support.setup_copilot.system_settings_apply' &&
          a.userId === String(multiPermMember.userId),
      );
      expect(latestAudit).toBeDefined();
      expect((latestAudit?.details as { appliedIds?: string[] })?.appliedIds).toHaveLength(9);
    });

    it('applies only selectedIds and marks unselected actions as skipped', () => {
      const proposal = evaluateSystemSettingsProposal({
        user: multiPermMember,
        locale: 'vi',
        messages: [{ role: 'user', content: 'bật response cache và bật mcp server' }],
      });
      expect(proposal.outcome).toBe('proposed');
      if (proposal.outcome !== 'proposed') return;

      const results = applySystemSettingsActions({
        user: multiPermMember,
        actions: proposal.actions,
        selectedIds: ['response_cache'],
      });

      expect(results).toEqual([
        expect.objectContaining({ settingId: 'response_cache', status: 'applied' }),
        expect.objectContaining({ settingId: 'mcp_server', status: 'skipped' }),
      ]);
      expect(isCacheEnabled()).toBe(true);
      expect(isMcpServerEnabled()).toBe(false);
    });

    it('enforces live DB TOCTOU permission check if permission is revoked between proposal and apply', () => {
      // 1. User holds both edit_cache and edit_settings when proposal is created
      const proposal = evaluateSystemSettingsProposal({
        user: multiPermMember,
        locale: 'en',
        messages: [{ role: 'user', content: 'enable response cache and enable mcp server' }],
      });
      expect(proposal.outcome).toBe('proposed');
      if (proposal.outcome !== 'proposed') return;

      // 2. Admin revokes edit_settings in SQLite BEFORE apply, while stale `multiPermMember` session object still lists edit_settings!
      setUserPermissions(multiPermMember.userId, ['edit_cache'], primaryAdmin.userId);
      expect(multiPermMember.permissions).toContain('edit_settings');

      // 3. Apply MUST fail closed with 403 forbidden AND leave BOTH settings unchanged (atomic pre-flight)
      expect(() =>
        applySystemSettingsActions({
          user: multiPermMember,
          actions: proposal.actions,
          selectedIds: ['response_cache', 'mcp_server'],
        }),
      ).toThrowError(SupportSetupCopilotError);

      try {
        applySystemSettingsActions({
          user: multiPermMember,
          actions: proposal.actions,
          selectedIds: ['response_cache', 'mcp_server'],
        });
      } catch (err) {
        expect(err).toBeInstanceOf(SupportSetupCopilotError);
        expect((err as SupportSetupCopilotError).status).toBe(403);
        expect((err as SupportSetupCopilotError).code).toBe('forbidden');
      }

      expect(isCacheEnabled()).toBe(false);
      expect(isMcpServerEnabled()).toBe(false);

      // 4. Applying ONLY the still-permitted 'response_cache' succeeds!
      const partialRes = applySystemSettingsActions({
        user: multiPermMember,
        actions: proposal.actions,
        selectedIds: ['response_cache'],
      });
      expect(partialRes.find((r) => r.settingId === 'response_cache')?.status).toBe('applied');
      expect(isCacheEnabled()).toBe(true);
    });

    it('rejects apply with 403 forbidden if the user account was deleted from the DB after proposal creation', () => {
      const tempUser = createUser('ephemeral-operator@example.com', 'TempPass123!', 'member');
      setUserPermissions(tempUser.userId, ['edit_cache'], primaryAdmin.userId);
      const sessionSnapshot: SessionUser = { ...tempUser, permissions: ['edit_cache'] };

      const proposal = evaluateSystemSettingsProposal({
        user: sessionSnapshot,
        locale: 'en',
        messages: [{ role: 'user', content: 'enable response cache' }],
      });
      expect(proposal.outcome).toBe('proposed');
      if (proposal.outcome !== 'proposed') return;

      // Delete user row from SQLite
      getDb().prepare('DELETE FROM users WHERE id = ?').run(tempUser.userId);

      expect(() =>
        applySystemSettingsActions({
          user: sessionSnapshot,
          actions: proposal.actions,
        }),
      ).toThrowError(SupportSetupCopilotError);

      expect(isCacheEnabled()).toBe(false);
    });

    it('enforces granular permissions for secondary admins (non-primary) in live TOCTOU DB lookup', () => {
      const secondaryAdmin = createUser('secondary-sys-admin@example.com', 'AdminPass123!', 'admin');
      setUserPermissions(secondaryAdmin.userId, ['edit_cache'], primaryAdmin.userId);
      const staleFullAdminSession: SessionUser = {
        ...secondaryAdmin,
        isPrimary: false,
        permissions: ['*'],
      };

      const proposal = evaluateSystemSettingsProposal({
        user: staleFullAdminSession,
        locale: 'en',
        messages: [{ role: 'user', content: 'enable thruline gateway and enable response cache' }],
      });
      expect(proposal.outcome).toBe('proposed');
      if (proposal.outcome !== 'proposed') return;

      // Live DB says secondaryAdmin only holds ['edit_cache'], NOT 'edit_x_settings'
      expect(() =>
        applySystemSettingsActions({
          user: staleFullAdminSession,
          actions: proposal.actions,
        }),
      ).toThrowError(SupportSetupCopilotError);
      expect(getConfigSnapshot().enabled).toBe(false);
      expect(isCacheEnabled()).toBe(false);

      // Selecting only 'response_cache' succeeds under live DB ['edit_cache']
      const allowedOnly = applySystemSettingsActions({
        user: staleFullAdminSession,
        actions: proposal.actions,
        selectedIds: ['response_cache'],
      });
      expect(allowedOnly.find((r) => r.settingId === 'response_cache')?.status).toBe('applied');
      expect(isCacheEnabled()).toBe(true);
    });
  });

  describe('buildSystemSettingsPromptSection', () => {
    it('renders concise RBAC-scoped prompt guidance in Vietnamese and English', () => {
      const viPrompt = buildSystemSettingsPromptSection(cacheOnlyMember, 'vi');
      expect(viPrompt).toContain('response_cache (edit_cache)');
      expect(viPrompt).toContain('mcp_server [requires edit_settings]');
      expect(viPrompt).toContain('/keys');
      expect(viPrompt).toContain('/users');

      const enPrompt = buildSystemSettingsPromptSection(readOnlyMember, 'en');
      expect(enPrompt).toContain('NONE (guidance-only)');
      expect(enPrompt).toContain('thruline_gateway_enabled [requires edit_x_settings]');
      expect(enPrompt).toContain('Approve & Apply');
    });
  });
});
