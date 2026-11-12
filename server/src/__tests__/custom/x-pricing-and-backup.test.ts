import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { getDb, initDb, setSetting } from '../../db/index.js';
import { createUser, createSession } from '../../services/auth.js';
import { permissionForAction } from '../../custom/permission-actions.js';
import {
  getConfigSnapshot,
  invalidateConfigCache,
  listCombos,
  createCombo,
  setDefaultSavers,
} from '../../custom/x-gateway/config.js';
import {
  getCapacityAdapterSettings,
  setCapacityAdapterSettings,
} from '../../custom/x-gateway/capacity-adapter.js';
import {
  getPricingOverrides,
  resetPricingOverrides,
} from '../../custom/x-gateway/pricing.js';

describe('X-Gateway Custom Pricing & Config Backup / Restore', () => {
  let server: Server;
  let base: string;
  let adminUserId: number;
  let adminToken: string;
  let readonlyUserId: number;
  let readonlyToken: string;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');

    adminUserId = createUser('admin-pricing@test.dev', 'Password123!').userId;
    // Grant full permissions
    getDb()
      .prepare('UPDATE users SET role = ?, permissions = ? WHERE id = ?')
      .run('admin', JSON.stringify(['use_x_gateway', 'edit_x_settings', 'manage_x_gateway']), adminUserId);
    adminToken = createSession(adminUserId);

    readonlyUserId = createUser('readonly-pricing@test.dev', 'Password123!', 'member').userId;
    // Grant only read (use_x_gateway)
    getDb()
      .prepare('UPDATE users SET permissions = ? WHERE id = ?')
      .run(JSON.stringify(['use_x_gateway']), readonlyUserId);
    readonlyToken = createSession(readonlyUserId);

    await new Promise<void>(resolve => {
      server = createApp().listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          base = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  beforeEach(() => {
    resetPricingOverrides();
    invalidateConfigCache();
    getDb().prepare('DELETE FROM x_gateway_combos').run();
  });

  function api(path: string, options: { method?: string; body?: unknown; token?: string } = {}) {
    const { method = 'GET', body, token = adminToken } = options;
    return fetch(`${base}/api/x-gateway${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  describe('Permission resolution in permission-actions.ts', () => {
    it('maps GET /pricing and GET /config-backup to use_x_gateway', () => {
      expect(permissionForAction('manage_x_gateway', 'GET', '/api/x-gateway/pricing')).toBe('use_x_gateway');
      expect(permissionForAction('manage_x_gateway', 'HEAD', '/api/x-gateway/pricing')).toBe('use_x_gateway');
      expect(permissionForAction('manage_x_gateway', 'GET', '/api/x-gateway/config-backup')).toBe('use_x_gateway');
    });

    it('maps write methods on /pricing and /config-backup to edit_x_settings', () => {
      expect(permissionForAction('manage_x_gateway', 'PATCH', '/api/x-gateway/pricing')).toBe('edit_x_settings');
      expect(permissionForAction('manage_x_gateway', 'DELETE', '/api/x-gateway/pricing')).toBe('edit_x_settings');
      expect(permissionForAction('manage_x_gateway', 'POST', '/api/x-gateway/config-backup')).toBe('edit_x_settings');
    });

    it('enforces read-only sessions cannot modify pricing or restore backup via HTTP', async () => {
      const patchRes = await api('/pricing', {
        method: 'PATCH',
        token: readonlyToken,
        body: { openai: { 'gpt-4o': { input: 1.0 } } },
      });
      expect(patchRes.status).toBe(403);

      const delRes = await api('/pricing', {
        method: 'DELETE',
        token: readonlyToken,
      });
      expect(delRes.status).toBe(403);

      const restoreRes = await api('/config-backup', {
        method: 'POST',
        token: readonlyToken,
        body: { version: 1 },
      });
      expect(restoreRes.status).toBe(403);

      // But read-only user can read pricing and backup
      const getPricingRes = await api('/pricing', { token: readonlyToken });
      expect(getPricingRes.status).toBe(200);

      const getBackupRes = await api('/config-backup', { token: readonlyToken });
      expect(getBackupRes.status).toBe(200);
    });
  });

  describe('Custom Pricing Endpoints (/pricing)', () => {
    it('GET /pricing returns pricing, overrides, and defaults', async () => {
      const res = await api('/pricing');
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data).toHaveProperty('pricing');
      expect(data).toHaveProperty('overrides');
      expect(data).toHaveProperty('defaults');

      expect(data.defaults.openai['gpt-4o']).toEqual({
        input: 2.5,
        output: 10.0,
        cached: 1.25,
        reasoning: 15.0,
        cache_creation: 2.5,
      });
      expect(data.overrides).toEqual({});
      expect(data.pricing.openai['gpt-4o'].input).toBe(2.5);
    });

    it('PATCH /pricing validates inputs and rejects invalid formats or negative numbers', async () => {
      // Empty body
      const resEmpty = await api('/pricing', { method: 'PATCH', body: {} });
      expect(resEmpty.status).toBe(400);

      // Negative price
      const resNeg = await api('/pricing', {
        method: 'PATCH',
        body: { openai: { 'gpt-4o': { input: -0.5 } } },
      });
      expect(resNeg.status).toBe(400);
      const negJson = await resNeg.json();
      expect(negJson.error.message).toContain('non-negative number');

      // Invalid field
      const resInvalidField = await api('/pricing', {
        method: 'PATCH',
        body: { openai: { 'gpt-4o': { random_field: 10 } } },
      });
      expect(resInvalidField.status).toBe(400);
      const fieldJson = await resInvalidField.json();
      expect(fieldJson.error.message).toContain('Invalid pricing field');
    });

    it('PATCH /pricing updates overrides and merges with defaults', async () => {
      const patchRes = await api('/pricing', {
        method: 'PATCH',
        body: {
          openai: {
            'gpt-4o': { input: 1.8, output: 7.2 },
            'custom-agent-model': { input: 0.5, output: 2.0 },
          },
          anthropic: {
            'claude-sonnet-4-6': { input: 2.0 },
          },
        },
      });
      expect(patchRes.status).toBe(200);
      const data = await patchRes.json();

      expect(data.overrides.openai['gpt-4o'].input).toBe(1.8);
      expect(data.overrides.openai['gpt-4o'].output).toBe(7.2);
      expect(data.overrides.openai['custom-agent-model']).toEqual({ input: 0.5, output: 2.0 });
      expect(data.overrides.anthropic['claude-sonnet-4-6'].input).toBe(2.0);

      // Verify merged pricing preserves default cached & reasoning where not overridden
      expect(data.pricing.openai['gpt-4o'].input).toBe(1.8);
      expect(data.pricing.openai['gpt-4o'].cached).toBe(1.25);
      expect(data.pricing.anthropic['claude-sonnet-4-6'].input).toBe(2.0);
      expect(data.pricing.anthropic['claude-sonnet-4-6'].output).toBe(15.0);

      // Verify GET reflects the changes
      const getRes = await api('/pricing');
      const getData = await getRes.json();
      expect(getData.overrides.openai['gpt-4o'].input).toBe(1.8);
    });

    it('DELETE /pricing resets specific model, provider, or all overrides', async () => {
      // 1. Seed multiple overrides
      await api('/pricing', {
        method: 'PATCH',
        body: {
          openai: {
            'gpt-4o': { input: 1.5 },
            'gpt-4o-mini': { input: 0.05 },
          },
          deepseek: {
            'deepseek-chat': { input: 0.1 },
          },
        },
      });

      // 2. Reset single model gpt-4o under openai
      const delModelRes = await api('/pricing?provider=openai&model=gpt-4o', { method: 'DELETE' });
      expect(delModelRes.status).toBe(200);
      const modelData = await delModelRes.json();
      expect(modelData.overrides.openai['gpt-4o']).toBeUndefined();
      expect(modelData.overrides.openai['gpt-4o-mini'].input).toBe(0.05);
      expect(modelData.pricing.openai['gpt-4o'].input).toBe(2.5); // Back to default

      // 3. Reset provider openai
      const delProvRes = await api('/pricing?provider=openai', { method: 'DELETE' });
      expect(delProvRes.status).toBe(200);
      const provData = await delProvRes.json();
      expect(provData.overrides.openai).toBeUndefined();
      expect(provData.overrides.deepseek['deepseek-chat'].input).toBe(0.1);

      // 4. Reset all overrides
      const delAllRes = await api('/pricing', { method: 'DELETE' });
      expect(delAllRes.status).toBe(200);
      const allData = await delAllRes.json();
      expect(allData.overrides).toEqual({});
      expect(allData.pricing.deepseek['deepseek-chat'].input).toBe(0.14); // Back to default
    });
  });

  describe('Config Backup and Restore Endpoints (/config-backup)', () => {
    it('GET /config-backup exports safe JSON snapshot without any secret credentials', async () => {
      // Seed some configuration
      setDefaultSavers({ caveman: true, ponytail: 'full', input: 'lossless' }, adminUserId);
      setCapacityAdapterSettings({
        vision: { enabled: true, roundRobin: false, models: ['gpt-4o'] },
        audioInput: { enabled: false, roundRobin: true, models: [] },
      }, adminUserId);
      createCombo('research-combo', [{ target: 'openai/gpt-4o' }], adminUserId, { description: 'Research combo' });
      setSetting('x_gateway_custom_provider_nodes', JSON.stringify([
        { id: 'node-1', name: 'Local Ollama', baseUrl: 'http://localhost:11434', prefix: 'ollama', type: 'openai-compatible' },
      ]));
      setSetting('x_gateway_provider_models', JSON.stringify({
        openai: { strategy: 'round-robin', stickyLimit: 5 },
      }));

      const res = await api('/config-backup');
      expect(res.status).toBe(200);
      const backup = await res.json();

      expect(backup.version).toBe(1);
      expect(typeof backup.exportedAt).toBe('string');
      expect(backup.defaults).toEqual({ caveman: true, ponytail: 'full', input: 'lossless' });
      expect(backup.capacityAdapter.vision.enabled).toBe(true);
      expect(backup.capacityAdapter.vision.models).toEqual(['gpt-4o']);
      expect(backup.combos).toHaveLength(1);
      expect(backup.combos[0].name).toBe('research-combo');
      expect(backup.customProviderNodes).toEqual([
        { id: 'node-1', name: 'Local Ollama', baseUrl: 'http://localhost:11434', prefix: 'ollama', type: 'openai-compatible' },
      ]);
      expect(backup.providerModelConfigs.openai.strategy).toBe('round-robin');

      // Crucial security invariant: No secrets, encrypted keys, or raw tokens anywhere in exported payload
      const jsonStr = JSON.stringify(backup);
      expect(jsonStr).not.toContain('encrypted_key');
      expect(jsonStr).not.toContain('auth_tag');
      expect(jsonStr).not.toContain('iv');
      expect(jsonStr).not.toContain('password');
      expect(jsonStr).not.toContain('sk-');
    });

    it('POST /config-backup rejects invalid payloads', async () => {
      const resNull = await api('/config-backup', { method: 'POST', body: null });
      expect(resNull.status).toBe(400);

      const resArray = await api('/config-backup', { method: 'POST', body: [1, 2, 3] });
      expect(resArray.status).toBe(400);
    });

    it('POST /config-backup performs full round-trip restore of combos, pricing, savers, capacity, and nodes', async () => {
      const backupPayload = {
        version: 1,
        exportedAt: new Date().toISOString(),
        defaults: {
          caveman: false,
          ponytail: 'ultra',
          input: 'standard',
        },
        capacityAdapter: {
          vision: { enabled: true, roundRobin: true, models: ['claude-sonnet-4-6', 'gpt-4o'] },
          audioInput: { enabled: true, roundRobin: false, models: ['gemini-2.5-flash'] },
        },
        pricingOverrides: {
          gemini: {
            'gemini-2.5-pro': { input: 1.5, output: 9.0 },
          },
        },
        combos: [
          {
            name: 'imported-combo-1',
            entries: [{ target: 'anthropic/claude-sonnet-4-6' }],
            strategy: 'fallback',
            description: 'Combo 1',
          },
          {
            name: 'imported-combo-2',
            entries: [{ target: 'gemini/gemini-2.5-flash' }],
            strategy: 'round-robin',
            description: 'Combo 2',
          },
        ],
        customProviderNodes: [
          { id: 'imported-node-1', name: 'Imported Node', baseUrl: 'https://api.together.xyz/v1', prefix: 'together' },
        ],
        providerModelConfigs: {
          gemini: { strategy: 'round-robin', stickyLimit: 10 },
        },
      };

      const restoreRes = await api('/config-backup', {
        method: 'POST',
        body: backupPayload,
      });

      expect(restoreRes.status).toBe(200);
      const restoreResult = await restoreRes.json();
      expect(restoreResult).toEqual({
        ok: true,
        restored: {
          combosCount: 2,
          pricingProvidersCount: 1,
          customNodesCount: 1,
        },
      });

      // Verify savers restored
      const savers = getConfigSnapshot().savers;
      expect(savers).toEqual({ caveman: false, ponytail: 'ultra', input: 'standard' });

      // Verify capacity adapter restored
      const capacity = getCapacityAdapterSettings();
      expect(capacity.vision.enabled).toBe(true);
      expect(capacity.vision.roundRobin).toBe(true);
      expect(capacity.vision.models).toEqual(['claude-sonnet-4-6', 'gpt-4o']);

      // Verify pricing overrides restored
      const pricing = getPricingOverrides();
      expect(pricing.gemini['gemini-2.5-pro']).toMatchObject({ input: 1.5, output: 9.0 });

      // Verify combos restored
      const combos = listCombos();
      expect(combos.map(c => c.name).sort()).toEqual(['imported-combo-1', 'imported-combo-2']);

      // Re-importing same combo updates instead of throwing error
      const updatePayload = {
        combos: [
          {
            name: 'imported-combo-1',
            entries: [{ target: 'openai/gpt-5' }],
            description: 'Updated Combo 1',
          },
        ],
      };
      const updateRes = await api('/config-backup', {
        method: 'POST',
        body: updatePayload,
      });
      expect(updateRes.status).toBe(200);
      const combosAfterUpdate = listCombos();
      const updatedCombo1 = combosAfterUpdate.find(c => c.name === 'imported-combo-1');
      expect(updatedCombo1?.description).toBe('Updated Combo 1');
      expect(updatedCombo1?.entries).toEqual([{ target: 'openai/gpt-5' }]);
    });
  });
});
