import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { getDb, initDb } from '../../../db/index.js';
import { DEFAULT_MIGRATIONS } from '../../../db/migrate/defaults.js';
import { runMigrationsSync } from '../../../db/migrate/runner.js';
import { getFlags, resetFlagsCacheForTests } from '../../../custom/ai-platform/flags.js';
import { createBackup, listTables, restoreBackup } from '../../../services/backups.js';
import { encrypt } from '../../../lib/crypto.js';
import { addDoc, resetKnowledgeIndexes } from '../../../services/profile-knowledge.js';
import {
  enqueueMissingEmbeddingJobs,
  enqueueReindexJob,
  getScopeIndexSnapshot,
  runPendingIndexJobsUntilIdle,
  setEmbeddingsRunnerForTests,
  startIndexWorker,
  stopIndexWorker,
} from '../../../custom/ai-platform/retrieval/indexer.js';
import { invalidateVectorCache } from '../../../custom/ai-platform/retrieval/vector-store.js';
import { createFakeEmbeddingsRunner } from '../../helpers/fake-embeddings.js';

type Db = ReturnType<typeof getDb>;
type ColumnInfo = { name: string; type: string; notnull: number; dflt_value: string | null; pk: number };

const MCP_SECRET = 'mcp-plaintext-secret-7f3a91';

function customAiTables(db: Db): string[] {
  return listTables(db).filter((t) => t.startsWith('custom_ai_'));
}

/** Inserts one row with every NOT NULL column filled, honouring `col IN (...)` CHECKs. */
function seedOneRow(db: Db, table: string): void {
  const createSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string }).sql;
  const columns = db.prepare(`PRAGMA table_info("${table}")`).all() as ColumnInfo[];
  const singleIntegerPk = columns.filter((c) => c.pk > 0).length === 1;
  const values: Record<string, unknown> = {};
  for (const column of columns) {
    if (column.pk > 0 && singleIntegerPk && /INTEGER/i.test(column.type)) continue;
    if (!column.notnull || column.dflt_value !== null) continue;
    const check = new RegExp(`\\b${column.name}\\b[^,]*?CHECK\\s*\\(\\s*${column.name}\\s+IN\\s*\\(\\s*'([^']+)'`, 'i').exec(createSql);
    values[column.name] = check ? check[1] : /INT|REAL|NUM/i.test(column.type) ? 1 : `${table}:${column.name}`;
  }
  const names = Object.keys(values);
  if (names.length === 0) {
    db.prepare(`INSERT INTO "${table}" DEFAULT VALUES`).run();
    return;
  }
  db.prepare(`INSERT INTO "${table}" (${names.map((n) => `"${n}"`).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`)
    .run(...names.map((n) => values[n]));
}

function snapshotAiState(db: Db): Record<string, unknown[]> {
  const state: Record<string, unknown[]> = {};
  for (const table of customAiTables(db)) {
    state[table] = db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();
  }
  state.settings = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'ai\\_platform\\_%' ESCAPE '\\' ORDER BY key").all();
  return state;
}

function readyChunks(scope: { kind: 'profile'; id: string }): number {
  return getScopeIndexSnapshot(scope).status.readyChunks;
}

describe('ai-platform backup and restore of pillar data (T133)', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    stopIndexWorker();
    setEmbeddingsRunnerForTests(null);
    invalidateVectorCache();
    resetKnowledgeIndexes();
    try {
      getDb().close();
    } catch { /* ignore */ }
    resetFlagsCacheForTests();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function openTempDb(): Db {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-platform-backup-'));
    tempDirs.push(tmpDir);
    initDb(path.join(tmpDir, 'app.db'));
    resetKnowledgeIndexes();
    invalidateVectorCache();
    return getDb();
  }

  it('backs up and restores every custom_ai_* table and keeps MCP secrets encrypted', () => {
    const db = openTempDb();
    const tables = customAiTables(db);
    expect(tables.length).toBeGreaterThanOrEqual(20);

    // Parents first so foreign keys resolve to id 1.
    const ordered = ['custom_ai_mcp_servers', 'custom_ai_mcp_tools', ...tables.filter((t) => t !== 'custom_ai_mcp_servers' && t !== 'custom_ai_mcp_tools')];
    for (const table of ordered) seedOneRow(db, table);

    const secret = encrypt(MCP_SECRET);
    db.prepare("UPDATE custom_ai_mcp_servers SET auth_kind = 'bearer', auth_ciphertext = ?, auth_iv = ?, auth_tag = ? WHERE id = 1")
      .run(secret.encrypted, secret.iv, secret.authTag);
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('ai_platform_flags_v1', ?)")
      .run(JSON.stringify({ prompts: true, retrieval: true, promptCache: true, mcpClient: true, outputGuard: true, orchestrator: true }));

    const before = snapshotAiState(db);
    // Migrations seed some tables (e.g. built-in cache capabilities), so require at least one row.
    for (const table of tables) expect(before[table].length, table).toBeGreaterThan(0);

    const backup = createBackup(db);
    for (const table of tables) expect(backup.tables, table).toContain(table);
    const dump = fs.readFileSync(path.join(path.dirname(db.name), 'backups', backup.filename), 'utf8');
    expect(dump).not.toContain(MCP_SECRET);
    expect(dump).toContain(secret.encrypted);

    db.pragma('foreign_keys = OFF');
    for (const table of [...ordered].reverse()) db.prepare(`DELETE FROM "${table}"`).run();
    db.prepare("DELETE FROM settings WHERE key LIKE 'ai\\_platform\\_%' ESCAPE '\\'").run();
    db.pragma('foreign_keys = ON');
    expect(snapshotAiState(db).custom_ai_mcp_servers).toHaveLength(0);

    restoreBackup(db, backup.id);
    resetFlagsCacheForTests();

    expect(snapshotAiState(db)).toEqual(before);
    expect(getFlags().mcpClient).toBe(true);
  });

  it('rebuilds the semantic index after restoring a backup taken without custom_ai_chunk_embeddings', async () => {
    const db = openTempDb();
    db.prepare(
      "INSERT INTO client_profiles (id, name, token_hash, encrypted_key, iv, auth_tag) VALUES (1, 'shop', 'hash-shop', 'e', 'i', 't')",
    ).run();
    const scope = { kind: 'profile' as const, id: '1' };
    addDoc(1, 'Returns', 'Items can be returned within 30 days with a receipt.');
    addDoc(1, 'Shipping', 'Standard shipping takes three to five business days.');
    addDoc(1, 'Warranty', 'Electronics carry a one year limited warranty.');
    setEmbeddingsRunnerForTests(createFakeEmbeddingsRunner({ dims: 768, modelId: 'text-embedding-3-small' }));

    enqueueReindexJob(scope, 'reindex');
    await runPendingIndexJobsUntilIdle();
    expect(readyChunks(scope)).toBe(3);
    expect(enqueueMissingEmbeddingJobs()).toBe(0);

    const backup = createBackup(db, { tables: listTables(db).filter((t) => t !== 'custom_ai_chunk_embeddings') });
    expect(backup.tables).not.toContain('custom_ai_chunk_embeddings');

    // The target database has lost its vectors; the partial dump does not bring them back.
    db.prepare('DELETE FROM custom_ai_chunk_embeddings').run();
    invalidateVectorCache();
    restoreBackup(db, backup.id);
    resetKnowledgeIndexes();
    expect(readyChunks(scope)).toBe(0);

    // The background worker notices the missing vectors and reindexes on its own.
    startIndexWorker(25);
    const deadline = Date.now() + 5_000;
    while (readyChunks(scope) < 3 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(readyChunks(scope)).toBe(3);
    expect(enqueueMissingEmbeddingJobs()).toBe(0);
  });

  it('does not requeue a scope whose latest index job failed recently', async () => {
    const db = openTempDb();
    db.prepare(
      "INSERT INTO client_profiles (id, name, token_hash, encrypted_key, iv, auth_tag) VALUES (1, 'shop', 'hash-shop', 'e', 'i', 't')",
    ).run();
    addDoc(1, 'Returns', 'Items can be returned within 30 days with a receipt.');
    setEmbeddingsRunnerForTests(createFakeEmbeddingsRunner({ dims: 768, modelId: 'text-embedding-3-small' }));
    const job = enqueueReindexJob({ kind: 'profile', id: '1' }, 'reindex');

    const now = Date.now();
    db.prepare("UPDATE custom_ai_index_jobs SET status = 'failed', updated_at = ? WHERE id = ?")
      .run(new Date(now - 60_000).toISOString(), job.id);
    expect(enqueueMissingEmbeddingJobs(now)).toBe(0);

    db.prepare('UPDATE custom_ai_index_jobs SET updated_at = ? WHERE id = ?')
      .run(new Date(now - 2 * 60 * 60_000).toISOString(), job.id);
    expect(enqueueMissingEmbeddingJobs(now)).toBe(1);
    expect(enqueueMissingEmbeddingJobs(now)).toBe(0);
  });
});

describe('ai-platform pre-upgrade backup restore (T033)', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    try {
      getDb().close();
    } catch { /* ignore */ }
    resetFlagsCacheForTests();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('restores a pre-upgrade backup cleanly, migrates forward, and keeps all 6 pillars disabled', async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-platform-backup-'));
    tempDirs.push(tmpDir);
    const backupFile = path.join(tmpDir, 'pre-upgrade-backup.db');
    const restoredFile = path.join(tmpDir, 'restored.db');

    // 1. Create a pre-upgrade database snapshot (all migrations prior to 20261113_100000_custom_ai_platform_base).
    const preDb = new Database(backupFile);
    const preUpgradeMigrations = DEFAULT_MIGRATIONS.filter(
      m => !m.filename.includes('custom_ai_platform_base'),
    );
    runMigrationsSync(preDb, 'up', { migrations: preUpgradeMigrations });
    preDb.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('custom_pre_upgrade_key', 'preserved-value')").run();
    preDb.prepare(
      "INSERT INTO client_profiles (name, token_hash, encrypted_key, iv, auth_tag, system_prompt, enabled) VALUES ('pre-upgrade-shop', 'hash_pre_1', 'e', 'i', 't', 'Be helpful.', 1)",
    ).run();
    await preDb.backup(restoredFile);
    preDb.close();

    // 2. Boot the upgraded app DB engine against the restored pre-upgrade snapshot.
    initDb(restoredFile);
    resetFlagsCacheForTests();

    // 3. Pre-upgrade settings & client profiles are preserved intact.
    const db = getDb();
    const setting = db.prepare("SELECT value FROM settings WHERE key = 'custom_pre_upgrade_key'").get() as { value: string } | undefined;
    expect(setting?.value).toBe('preserved-value');

    const profile = db.prepare("SELECT id, name, system_prompt FROM client_profiles WHERE name = 'pre-upgrade-shop'").get() as
      | { id: number; name: string; system_prompt: string }
      | undefined;
    expect(profile?.name).toBe('pre-upgrade-shop');
    expect(profile?.system_prompt).toBe('Be helpful.');

    // 4. All 6 pillars default to false after restoring pre-upgrade backup.
    expect(getFlags()).toEqual({
      prompts: false,
      retrieval: false,
      promptCache: false,
      mcpClient: false,
      outputGuard: false,
      orchestrator: false,
    });

    // 5. Retention default was seeded without creating ai_platform_flags_v1.
    const flagsRow = db.prepare("SELECT value FROM settings WHERE key = 'ai_platform_flags_v1'").get();
    expect(flagsRow).toBeUndefined();

    // 6. Deleting the restored client profile succeeds with the new AFTER DELETE trigger.
    expect(() => db.prepare('DELETE FROM client_profiles WHERE id = ?').run(profile!.id)).not.toThrow();
  });
});
