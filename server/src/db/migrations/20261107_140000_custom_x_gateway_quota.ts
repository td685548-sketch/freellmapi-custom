// DOWN: reversible. Dedicated X account IDs never reference upstream api_keys.
import type { Db } from '../types.js';
export function up(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS x_gateway_quota (
    account_id INTEGER PRIMARY KEY REFERENCES x_gateway_keys(id) ON DELETE CASCADE,
    snapshot_json TEXT NOT NULL DEFAULT '[]', observed_at TEXT, checked_at TEXT, last_error TEXT
  );
  CREATE TABLE IF NOT EXISTS x_gateway_quota_tiers (
    account_id INTEGER PRIMARY KEY REFERENCES x_gateway_keys(id) ON DELETE CASCADE,
    tier TEXT NOT NULL CHECK(tier IN ('subscription','cheap','free'))
  );`);
}
export function down(db: Db): void {
  db.exec('DROP TABLE IF EXISTS x_gateway_quota_tiers; DROP TABLE IF EXISTS x_gateway_quota;');
}
