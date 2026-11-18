// Migration: Personal AI Agent Workspace, Custom User Assistants, Key Bindings, and Persistent Threads
// Created: 2026-11-18
//
// DOWN: reversible

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_user_assistants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      description TEXT NOT NULL DEFAULT '',
      system_prompt TEXT NOT NULL,
      knowledge_markdown TEXT NOT NULL DEFAULT '',
      recommended_routing_mode TEXT NOT NULL DEFAULT 'balanced',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_user_assistants_user_slug
      ON custom_user_assistants(user_id, slug);

    CREATE INDEX IF NOT EXISTS idx_custom_user_assistants_user_updated
      ON custom_user_assistants(user_id, updated_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS custom_user_key_assistant_bindings (
      key_id INTEGER PRIMARY KEY REFERENCES user_api_keys(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_assistant_id INTEGER NOT NULL REFERENCES custom_user_assistants(id) ON DELETE CASCADE,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_custom_user_key_bindings_assistant
      ON custom_user_key_assistant_bindings(user_assistant_id);

    CREATE INDEX IF NOT EXISTS idx_custom_user_key_bindings_user
      ON custom_user_key_assistant_bindings(user_id);

    CREATE TABLE IF NOT EXISTS custom_assistant_threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      assistant_ref TEXT NOT NULL,
      assistant_name_snapshot TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      routing_mode TEXT NOT NULL DEFAULT 'balanced',
      forked_from_thread_id INTEGER REFERENCES custom_assistant_threads(id) ON DELETE SET NULL,
      forked_from_message_index INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_custom_assistant_threads_user_updated
      ON custom_assistant_threads(user_id, updated_at DESC, id DESC);

    CREATE INDEX IF NOT EXISTS idx_custom_assistant_threads_user_assistant
      ON custom_assistant_threads(user_id, assistant_ref, updated_at DESC);

    CREATE TABLE IF NOT EXISTS custom_assistant_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id INTEGER NOT NULL REFERENCES custom_assistant_threads(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message_index INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      model TEXT,
      routing_mode TEXT,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_assistant_messages_thread_idx
      ON custom_assistant_messages(thread_id, message_index);

    CREATE INDEX IF NOT EXISTS idx_custom_assistant_messages_user
      ON custom_assistant_messages(user_id, thread_id);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_custom_assistant_messages_user;
    DROP INDEX IF EXISTS idx_custom_assistant_messages_thread_idx;
    DROP TABLE IF EXISTS custom_assistant_messages;

    DROP INDEX IF EXISTS idx_custom_assistant_threads_user_assistant;
    DROP INDEX IF EXISTS idx_custom_assistant_threads_user_updated;
    DROP TABLE IF EXISTS custom_assistant_threads;

    DROP INDEX IF EXISTS idx_custom_user_key_bindings_user;
    DROP INDEX IF EXISTS idx_custom_user_key_bindings_assistant;
    DROP TABLE IF EXISTS custom_user_key_assistant_bindings;

    DROP INDEX IF EXISTS idx_custom_user_assistants_user_updated;
    DROP INDEX IF EXISTS idx_custom_user_assistants_user_slug;
    DROP TABLE IF EXISTS custom_user_assistants;
  `);
}
