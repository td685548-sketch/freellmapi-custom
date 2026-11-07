import type { Db } from '../types.js';

/**
 * Custom migration: adds per-API-key model and combo access control to x_gateway_client_keys.
 * access_restricted: 0 = unrestricted (can access all models/combos), 1 = restricted to allowed_models
 * allowed_models: JSON array of allowed model or combo strings (e.g. '["gemini-2.0-flash", "combo:fast-coding"]')
 */
export function up(db: Db): void {
  const tableInfo = db.prepare("PRAGMA table_info('x_gateway_client_keys')").all() as Array<{ name: string }>;
  const columns = new Set(tableInfo.map(c => c.name));

  if (!columns.has('access_restricted')) {
    db.prepare("ALTER TABLE x_gateway_client_keys ADD COLUMN access_restricted INTEGER NOT NULL DEFAULT 0").run();
  }
  if (!columns.has('allowed_models')) {
    db.prepare("ALTER TABLE x_gateway_client_keys ADD COLUMN allowed_models TEXT NOT NULL DEFAULT '[]'").run();
  }
}

export function down(db: Db): void {
  // SQLite 3.35.0+ supports DROP COLUMN; retain table integrity
  try {
    db.prepare("ALTER TABLE x_gateway_client_keys DROP COLUMN access_restricted").run();
  } catch {
    // noop
  }
  try {
    db.prepare("ALTER TABLE x_gateway_client_keys DROP COLUMN allowed_models").run();
  } catch {
    // noop
  }
}
