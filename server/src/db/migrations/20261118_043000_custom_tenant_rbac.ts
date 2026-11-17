import type { Db } from '../types.js';

/**
 * Migration 20261118_043000_custom_tenant_rbac
 * Stores per-Support-Tenant user memberships, role presets, and granular RBAC permissions.
 *
 * NOTE: Deliberately avoids a DDL `REFERENCES x_support_tenants(id)` clause because
 * `x_support_tenants` is initialized lazily by `ensureSupportTables()` rather than baseline migrations.
 */

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_tenant_memberships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      role_preset TEXT NOT NULL DEFAULT 'custom',
      permissions_json TEXT NOT NULL DEFAULT '[]',
      assigned_by INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(tenant_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_custom_tenant_memberships_user
      ON custom_tenant_memberships (user_id, tenant_id);

    CREATE INDEX IF NOT EXISTS idx_custom_tenant_memberships_tenant
      ON custom_tenant_memberships (tenant_id, user_id);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_custom_tenant_memberships_tenant;
    DROP INDEX IF EXISTS idx_custom_tenant_memberships_user;
    DROP TABLE IF EXISTS custom_tenant_memberships;
  `);
}
