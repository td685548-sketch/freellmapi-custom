import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS x_provider_accounts (
      api_key_id INTEGER PRIMARY KEY REFERENCES api_keys(id) ON DELETE CASCADE,
      provider TEXT NOT NULL CHECK (provider IN ('openrouter', 'github-copilot')),
      subject TEXT,
      auth_method TEXT NOT NULL CHECK (auth_method IN ('oauth_pkce', 'device_code'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_x_provider_accounts_subject
      ON x_provider_accounts(provider, subject) WHERE subject IS NOT NULL;
  `);
}

export function down(db: Db): void {
  db.exec('DROP TABLE IF EXISTS x_provider_accounts');
}
