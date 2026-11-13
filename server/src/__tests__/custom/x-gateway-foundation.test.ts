import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { up, down } from '../../db/migrations/20261106_120000_custom_x_gateway.js';
import {
  getConfigSnapshot,
  setConfigValue,
  setEnabled,
  setDefaultSavers,
  invalidateConfigCache,
} from '../../custom/x-gateway/config.js';
import {
  validateCombo,
  validateComboName,
  validateComboEntries,
  MAX_COMBOS,
  MAX_ENTRIES,
} from '../../custom/x-gateway/combos.js';
import { PERMISSION_GROUPS } from '@freellmapi/shared/permissions.js';
import { permissionForAction } from '../../custom/permission-actions.js';

describe('X Gateway Foundation (Phase 2)', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    invalidateConfigCache();
  });

  describe('Migration idempotency', () => {
    it('creates and drops the three tables idempotently', () => {
      const db = getDb();

      // up should create the tables without throwing
      up(db);

      const hasTable = (name: string) => {
        const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
        return Boolean(row);
      };

      expect(hasTable('x_gateway_config')).toBe(true);
      expect(hasTable('x_gateway_combos')).toBe(true);
      expect(hasTable('x_gateway_usage_hourly')).toBe(true);

      // Re-running up must be idempotent (no error)
      expect(() => up(db)).not.toThrow();

      // down drops the tables
      down(db);
      expect(hasTable('x_gateway_config')).toBe(false);
      expect(hasTable('x_gateway_combos')).toBe(false);
      expect(hasTable('x_gateway_usage_hourly')).toBe(false);

      // Re-running down must be idempotent
      expect(() => down(db)).not.toThrow();

      // Can migrate up again
      up(db);
      expect(hasTable('x_gateway_config')).toBe(true);
      expect(hasTable('x_gateway_combos')).toBe(true);
      expect(hasTable('x_gateway_usage_hourly')).toBe(true);
    });
  });

  describe('Config snapshot and cache', () => {
    it('defaults to off and default savers when rows are absent', () => {
      const snapshot = getConfigSnapshot();
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.savers).toEqual({
        caveman: false,
        ponytail: 'off',
        input: 'off',
      });
      expect(snapshot.combos).toEqual([]);
    });

    it('reflects a write immediately by invalidating cache', () => {
      expect(getConfigSnapshot().enabled).toBe(false);

      setEnabled(true);
      expect(getConfigSnapshot().enabled).toBe(true);

      setDefaultSavers({
        caveman: true,
        ponytail: 'ultra',
        input: 'standard',
      });
      const snapshot = getConfigSnapshot();
      expect(snapshot.savers.caveman).toBe(true);
      expect(snapshot.savers.ponytail).toBe('ultra');
      expect(snapshot.savers.input).toBe('standard');
    });

    it('falls back on corrupt default_savers value', () => {
      setConfigValue('default_savers', '{ invalid json ...');
      const snapshot = getConfigSnapshot();
      expect(snapshot.savers).toEqual({
        caveman: false,
        ponytail: 'off',
        input: 'off',
      });
    });
  });

  describe('Combo validation rules (T012)', () => {
    it('accepts valid lower-case names 1-48 chars of a-z, 0-9, -, _, .', () => {
      expect(validateComboName('fast-model')).toBeNull();
      expect(validateComboName('gpt_4o.mini')).toBeNull();
      expect(validateComboName('a')).toBeNull();
      expect(validateComboName('a'.repeat(48))).toBeNull();
    });

    it('rejects invalid names, reserved words and reserved prefixes', () => {
      expect(validateComboName('')).not.toBeNull();
      expect(validateComboName('a'.repeat(49))).not.toBeNull();
      expect(validateComboName('model with spaces')).not.toBeNull();
      expect(validateComboName('model/slash')).not.toBeNull();
      expect(validateComboName('auto')).not.toBeNull();
      expect(validateComboName('AUTO')).not.toBeNull();
      expect(validateComboName('auto:smart')).not.toBeNull();
      expect(validateComboName('combo:fallback')).not.toBeNull();
    });

    it('validates combo entries array: 1-20 items, no duplicates', () => {
      expect(validateComboEntries([])).toBe(false);
      expect(validateComboEntries([{ platform: 'groq', modelId: 'llama-3.3-70b' }])).toBe(true);

      // Duplicate entries rejected
      expect(
        validateComboEntries([
          { platform: 'groq', modelId: 'llama-3.3-70b' },
          { platform: 'groq', modelId: 'llama-3.3-70b' },
        ])
      ).toBe(false);

      // Exceeding MAX_ENTRIES (20)
      const tooMany = Array.from({ length: MAX_ENTRIES + 1 }, (_, i) => ({
        platform: 'groq',
        modelId: `m-${i}`,
      }));
      expect(validateComboEntries(tooMany)).toBe(false);
    });

    it('validates combo using validateCombo including model collision and combo count limits', () => {
      const validEntries = [{ platform: 'groq', modelId: 'llama-3.3-70b' }];

      expect(validateCombo('fast-fallback', validEntries).valid).toBe(true);

      // Model id collision
      expect(
        validateCombo('gpt-4o', validEntries, { existingModelIds: ['gpt-4o', 'claude-3-5-sonnet'] }).valid
      ).toBe(false);

      // Max combos cap
      expect(
        validateCombo('another-combo', validEntries, { totalCombos: MAX_COMBOS }).valid
      ).toBe(false);
    });
  });

  describe('Permissions and action mappings', () => {
    it('includes manage_x_gateway in PERMISSION_GROUPS with all required leaves', () => {
      const group = PERMISSION_GROUPS.find(g => g.key === 'manage_x_gateway');
      expect(group).toBeDefined();
      expect(group?.children.map(c => c.key)).toEqual([
        'use_x_gateway',
        'edit_x_combos',
        'edit_x_settings',
        'view_x_usage',
      ]);
    });

    it('maps actions correctly and falls through unlisted paths to parent manage_x_gateway', () => {
      // Writes to enabled and defaults -> edit_x_settings
      expect(permissionForAction('manage_x_gateway', 'PUT', '/api/thruline/enabled')).toBe('edit_x_settings');
      expect(permissionForAction('manage_x_gateway', 'PUT', '/api/thruline/defaults')).toBe('edit_x_settings');

      // Reads to enabled and defaults -> use_x_gateway
      expect(permissionForAction('manage_x_gateway', 'GET', '/api/thruline/enabled')).toBe('use_x_gateway');
      expect(permissionForAction('manage_x_gateway', 'GET', '/api/thruline/defaults')).toBe('use_x_gateway');

      // Combo writes -> edit_x_combos
      expect(permissionForAction('manage_x_gateway', 'POST', '/api/thruline/combos')).toBe('edit_x_combos');
      expect(permissionForAction('manage_x_gateway', 'PUT', '/api/thruline/combos/1')).toBe('edit_x_combos');
      expect(permissionForAction('manage_x_gateway', 'DELETE', '/api/thruline/combos/1')).toBe('edit_x_combos');

      // /api/thruline/models -> edit_x_combos
      expect(permissionForAction('manage_x_gateway', 'GET', '/api/thruline/models')).toBe('edit_x_combos');

      // Usage read -> view_x_usage
      expect(permissionForAction('manage_x_gateway', 'GET', '/api/thruline/usage')).toBe('view_x_usage');

      // Test endpoint -> use_x_gateway
      expect(permissionForAction('manage_x_gateway', 'POST', '/api/thruline/test')).toBe('use_x_gateway');

      // Generic reads -> use_x_gateway
      expect(permissionForAction('manage_x_gateway', 'GET', '/api/thruline/status')).toBe('use_x_gateway');
      expect(permissionForAction('manage_x_gateway', 'GET', '/api/thruline/other')).toBe('use_x_gateway');

      // Unlisted writes -> parent manage_x_gateway
      expect(permissionForAction('manage_x_gateway', 'POST', '/api/thruline/unlisted')).toBe('manage_x_gateway');
    });
  });
});
