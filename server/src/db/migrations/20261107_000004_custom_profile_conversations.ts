// Migration: server-side conversations per client profile
// Created: 2026-11-07
//
// DOWN: reversible
//
// A web app calling with a client key can send only the new message plus an
// X-Conversation-Id header; the server keeps the earlier turns and adds them to
// the request. A turn (the user's message and the model's reply) is stored only
// when the reply completes. Conversations untouched for `conv_ttl_hours` are
// deleted. Off unless `conv_enabled` is set.

import type { Db } from '../types.js';

function hasTable(db: Db, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}
function hasColumn(db: Db, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(c => c.name === column);
}

const PROFILE_COLUMNS: Array<[string, string]> = [
  ['conv_enabled', 'INTEGER NOT NULL DEFAULT 0'],
  ['conv_ttl_hours', 'INTEGER'],
  ['conv_max_messages', 'INTEGER'],
  ['conv_max_chars', 'INTEGER'],
];

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      conv_key TEXT NOT NULL,
      end_user TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      chars INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_conversations_key ON custom_conversations(profile_id, conv_key);
    CREATE INDEX IF NOT EXISTS idx_custom_conversations_updated ON custom_conversations(profile_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_custom_conversations_end_user ON custom_conversations(profile_id, end_user) WHERE end_user IS NOT NULL;
    CREATE TABLE IF NOT EXISTS custom_conversation_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_custom_conversation_messages_conv ON custom_conversation_messages(conversation_id, id);
  `);
  if (hasTable(db, 'client_profiles')) {
    for (const [name, type] of PROFILE_COLUMNS) {
      if (!hasColumn(db, 'client_profiles', name)) db.prepare(`ALTER TABLE client_profiles ADD COLUMN ${name} ${type}`).run();
    }
  }
}

export function down(db: Db): void {
  db.exec('DROP TABLE IF EXISTS custom_conversation_messages; DROP TABLE IF EXISTS custom_conversations;');
  if (hasTable(db, 'client_profiles')) {
    for (const [name] of [...PROFILE_COLUMNS].reverse()) {
      if (hasColumn(db, 'client_profiles', name)) db.prepare(`ALTER TABLE client_profiles DROP COLUMN ${name}`).run();
    }
  }
}
