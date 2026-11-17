// Migration: Customer AI Hub, smart personal-key routing, custom instructions, and seeded assistants
// Created: 2026-11-18
//
// DOWN: reversible (drops added columns on user_api_keys and custom tables)

import type { Db } from '../types.js';

function hasColumn(db: Db, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some(col => col.name === column);
}

const SEED_TS = '2026-11-18 00:00:00';

const SEEDED_ASSISTANTS = [
  {
    slug: 'code-reviewer',
    name: 'Code Reviewer & Bug Hunter',
    description: 'Deep review for correctness, security edge cases, race conditions, and clean refactoring.',
    category: 'coding',
    icon: 'shield-check',
    systemPrompt: [
      'You are an exacting senior software engineer performing a focused code review.',
      'Prioritize real bugs, security flaws, concurrency issues, and resource leaks over style nitpicks.',
      'Structure feedback as: Critical Issues -> Warnings -> Concrete Patch Suggestions with brief code snippets.',
    ].join('\n'),
    recommendedRoutingMode: 'max',
    starterPrompts: [
      'Review this diff for subtle edge cases and potential null-pointer or race conditions.',
      'Audit this API handler for auth bypass, injection, or unhandled error paths.',
      'Refactor this function to reduce nesting without changing behavior.',
    ],
    audience: 'guest_preview',
    sortOrder: 10,
  },
  {
    slug: 'fast-pair-coder',
    name: 'Fast Pair Programmer (Eco)',
    description: 'Low-latency coding assistant tuned for quick IDE completions, regex, shell one-liners, and unit tests.',
    category: 'coding',
    icon: 'zap',
    systemPrompt: [
      'You are a concise, fast pair programmer inside an IDE.',
      'Answer directly with working code first, followed by at most 2-3 short bullet points explaining why.',
      'Avoid long preambles or unnecessary boilerplate.',
    ].join('\n'),
    recommendedRoutingMode: 'eco',
    starterPrompts: [
      'Write a TypeScript Vitest unit test suite covering happy path and error cases for this helper.',
      'Convert this curl command into clean fetch + async/await TypeScript.',
      'Give me a safe PowerShell command to inspect and filter these JSON logs.',
    ],
    audience: 'guest_preview',
    sortOrder: 20,
  },
  {
    slug: 'sql-api-architect',
    name: 'SQL & API Schema Architect',
    description: 'Design normalized schemas, idempotent migrations, OpenAPI/REST contracts, and fast SQL queries.',
    category: 'data',
    icon: 'database',
    systemPrompt: [
      'You are a backend data and API architect specializing in SQLite/PostgreSQL and strict REST/JSON contracts.',
      'Provide migration-safe DDL, explicit indexing rationale, and backwards-compatible payload designs.',
      'Flag any N+1 query risks or locking bottlenecks.',
    ].join('\n'),
    recommendedRoutingMode: 'balanced',
    starterPrompts: [
      'Optimize this SQLite query and tell me which composite index avoids a full table scan.',
      'Design an idempotent webhook ingestion schema with retry tracking.',
      'Turn these TypeScript types into a clean REST API contract with validation rules.',
    ],
    audience: 'all_members',
    sortOrder: 30,
  },
  {
    slug: 'bilingual-tech-writer',
    name: 'Technical Translator & Summarizer',
    description: 'Translate technical docs between Vietnamese and English, or distill long PRs and logs into crisp summaries.',
    category: 'writing',
    icon: 'languages',
    systemPrompt: [
      'You are a bilingual (Vietnamese/English) technical writer and summarizer.',
      'Preserve code identifiers, CLI flags, API paths, and file names verbatim while translating prose naturally.',
      'When summarizing, start with a one-sentence TL;DR followed by bulleted action items.',
    ].join('\n'),
    recommendedRoutingMode: 'eco',
    starterPrompts: [
      'Summarize this error log into root cause, affected module, and next troubleshooting steps.',
      'Translate this technical changelog into clear, natural Vietnamese while keeping code terms intact.',
      'Rewrite this engineering RFC into an executive-friendly 5-bullet summary.',
    ],
    audience: 'guest_preview',
    sortOrder: 40,
  },
] as const;

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_ai_assistants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'general',
      icon TEXT NOT NULL DEFAULT 'sparkles',
      system_prompt TEXT NOT NULL,
      recommended_routing_mode TEXT NOT NULL DEFAULT 'balanced',
      starter_prompts_json TEXT NOT NULL DEFAULT '[]',
      audience TEXT NOT NULL DEFAULT 'all_members',
      enabled INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      playground_runs INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS custom_user_ai_preferences (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      custom_instructions TEXT NOT NULL DEFAULT '',
      apply_to_keys INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  if (!hasColumn(db, 'user_api_keys', 'routing_mode')) {
    db.prepare("ALTER TABLE user_api_keys ADD COLUMN routing_mode TEXT NOT NULL DEFAULT 'default'").run();
  }
  if (!hasColumn(db, 'user_api_keys', 'assistant_id')) {
    db.prepare('ALTER TABLE user_api_keys ADD COLUMN assistant_id INTEGER').run();
  }

  const countRow = db.prepare('SELECT COUNT(*) AS cnt FROM custom_ai_assistants').get() as { cnt: number };
  if (countRow.cnt === 0) {
    const insert = db.prepare(`
      INSERT INTO custom_ai_assistants (
        slug, name, description, category, icon, system_prompt,
        recommended_routing_mode, starter_prompts_json, audience, enabled,
        sort_order, playground_runs, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 0, ?, ?)
    `);
    for (const item of SEEDED_ASSISTANTS) {
      insert.run(
        item.slug,
        item.name,
        item.description,
        item.category,
        item.icon,
        item.systemPrompt,
        item.recommendedRoutingMode,
        JSON.stringify(item.starterPrompts),
        item.audience,
        item.sortOrder,
        SEED_TS,
        SEED_TS,
      );
    }
  }
}

export function down(db: Db): void {
  if (hasColumn(db, 'user_api_keys', 'assistant_id')) {
    db.prepare('ALTER TABLE user_api_keys DROP COLUMN assistant_id').run();
  }
  if (hasColumn(db, 'user_api_keys', 'routing_mode')) {
    db.prepare('ALTER TABLE user_api_keys DROP COLUMN routing_mode').run();
  }
  db.prepare('DROP TABLE IF EXISTS custom_user_ai_preferences').run();
  db.prepare('DROP TABLE IF EXISTS custom_ai_assistants').run();
}
