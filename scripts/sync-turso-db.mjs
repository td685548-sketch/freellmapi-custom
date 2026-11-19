#!/usr/bin/env node

/**
 * FreeLLMAPI - Bidirectional Database Synchronization (Local SQLite <-> Turso libSQL)
 *
 * Capabilities:
 * - Topological dependency sorting to respect Foreign Key constraints during sync.
 * - Automated pre-sync safety snapshot backup.
 * - Chunked multi-row batch execution for fast remote Turso updates.
 * - Conflict resolution favoring newer records (via timestamps) or local configurations.
 * - sqlite_sequence synchronization to prevent ID collisions.
 * - --check-missed mode: startup guard that checks if today's sync was missed,
 *   waiting for the server (:3001/readyz) to stabilize before proceeding.
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, '..');
const LOCAL_LOG_DIR = path.join(PROJECT_ROOT, 'scripts/local/logs');
const LAST_SYNC_FILE = path.join(LOCAL_LOG_DIR, 'last-sync.json');
const LOG_FILE = path.join(LOCAL_LOG_DIR, 'db-sync.log');

export function log(msg, level = 'INFO') {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${msg}`;
  console.log(line);
  try {
    if (!fs.existsSync(LOCAL_LOG_DIR)) fs.mkdirSync(LOCAL_LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch {}
}

export function getTursoConfig(env = process.env, rootDir = PROJECT_ROOT) {
  let url = env.TURSO_DATABASE_URL?.trim() || '';
  let token = env.TURSO_AUTH_TOKEN?.trim() || '';

  if (!url || !token) {
    const envPath = path.join(rootDir, '.env');
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      if (!url) {
        const mUrl = content.match(/^TURSO_DATABASE_URL=(.+)$/m);
        if (mUrl && mUrl[1].trim()) url = mUrl[1].trim();
      }
      if (!token) {
        const mToken = content.match(/^TURSO_AUTH_TOKEN=(.+)$/m);
        if (mToken && mToken[1].trim()) token = mToken[1].trim();
      }
    }
  }

  // Fallback to default known production URL and turso.exe CLI if available
  if (!url) {
    url = 'libsql://freellmapi-singapore-dothanh.aws-ap-southeast-1.turso.io';
  }
  if (!token) {
    try {
      const tursoBin = process.platform === 'win32'
        ? (fs.existsSync('C:\\Users\\dotha\\.turso\\bin\\turso.exe') ? 'C:\\Users\\dotha\\.turso\\bin\\turso.exe' : 'turso')
        : 'turso';
      const raw = execSync(`"${tursoBin}" db tokens create freellmapi-singapore`, { encoding: 'utf8' });
      token = raw.trim();
    } catch {}
  }

  return { url, token };
}

export function sqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
    return `X'${Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('hex')}'`;
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function topologicalSortTables(localDb, tables) {
  const tableNames = new Set(tables.map(t => (typeof t === 'string' ? t : t.name)));
  const graph = new Map();
  const inDegree = new Map();

  for (const name of tableNames) {
    graph.set(name, new Set());
    inDegree.set(name, 0);
  }

  for (const name of tableNames) {
    let fks = [];
    try {
      fks = localDb.prepare(`PRAGMA foreign_key_list("${name}")`).all();
    } catch {}
    for (const fk of fks) {
      const parent = fk.table;
      if (parent && tableNames.has(parent) && parent !== name) {
        if (!graph.get(parent).has(name)) {
          graph.get(parent).add(name);
          inDegree.set(name, (inDegree.get(name) || 0) + 1);
        }
      }
    }
  }

  const queue = [];
  for (const [name, deg] of inDegree.entries()) {
    if (deg === 0) queue.push(name);
  }

  const sorted = [];
  while (queue.length > 0) {
    const curr = queue.shift();
    sorted.push(curr);
    for (const dep of graph.get(curr)) {
      inDegree.set(dep, inDegree.get(dep) - 1);
      if (inDegree.get(dep) === 0) queue.push(dep);
    }
  }

  for (const name of tableNames) {
    if (!sorted.includes(name)) sorted.push(name);
  }

  return sorted;
}

export async function waitForServerReady(port = 3001, maxWaitSec = 90) {
  log(`Waiting for local server on port ${port} to stabilize (max ${maxWaitSec}s)...`);
  const start = Date.now();
  while ((Date.now() - start) < maxWaitSec * 1000) {
    const ok = await new Promise(resolve => {
      const req = http.get(`http://127.0.0.1:${port}/readyz`, { timeout: 2000 }, (res) => {
        resolve(res.statusCode === 200);
      });
      req.on('error', () => {
        http.get(`http://127.0.0.1:${port}/api/ping`, { timeout: 2000 }, (res2) => {
          resolve(res2.statusCode === 200);
        }).on('error', () => resolve(false));
      });
    });
    if (ok) {
      log('Local server is stable and healthy (readyz/ping 200 OK).');
      await new Promise(r => setTimeout(r, 5000));
      return true;
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  log('Local server did not respond ready within timeout, proceeding with direct DB sync.', 'WARN');
  return false;
}

export async function performSync(options = {}) {
  const rootDir = options.rootDir || PROJECT_ROOT;
  const dbPath = options.dbPath || process.env.FREEAPI_DB_PATH || path.join(rootDir, 'server/data/freeapi.db');
  const { url, token } = options.turso || getTursoConfig(process.env, rootDir);

  if (!token) {
    throw new Error('TURSO_AUTH_TOKEN is required for database sync.');
  }

  log('================ STARTING TURSO BIDIRECTIONAL DB SYNC ================');
  const t0 = Date.now();

  const require = createRequire(path.join(rootDir, 'package.json'));
  const Database = require('better-sqlite3');
  const Libsql = require('libsql');

  const localDb = new Database(dbPath);
  const remoteDb = new Libsql(url, { authToken: token });

  // 1. Safety Backup Snapshot
  const snapDir = path.join(rootDir, 'backups/snapshots');
  if (!fs.existsSync(snapDir)) fs.mkdirSync(snapDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const snapPath = path.join(snapDir, `freeapi_pre_sync_${ts}.db`);
  await localDb.backup(snapPath);
  log(`Created pre-sync safety snapshot: ${snapPath}`);

  localDb.pragma('foreign_keys = OFF');
  try { remoteDb.exec('PRAGMA foreign_keys = OFF;'); } catch {}

  const rawTables = localDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'migrations'").all();
  const sortedTableNames = topologicalSortTables(localDb, rawTables);

  const report = [];
  let totalInsertedLocal = 0;
  let totalInsertedRemote = 0;
  let totalUpdatedLocal = 0;
  let totalUpdatedRemote = 0;

  for (const table of sortedTableNames) {
    try {
      const colInfo = localDb.prepare(`PRAGMA table_info("${table}")`).all();
      const colNames = colInfo.map(c => c.name);
      let pkCols = colInfo.filter(c => c.pk > 0).map(c => c.name);
      if (pkCols.length === 0) pkCols = colNames;

      const getRowKey = (row) => pkCols.map(k => String(row[k])).join(':::');

      const localRows = localDb.prepare(`SELECT * FROM "${table}"`).all();
      let remoteRows;
      try {
        remoteRows = remoteDb.prepare(`SELECT * FROM "${table}"`).all();
      } catch (err) {
        log(`Remote table ${table} not queryable: ${err.message}`, 'WARN');
        continue;
      }

      const localMap = new Map();
      for (const r of localRows) localMap.set(getRowKey(r), r);

      const remoteMap = new Map();
      for (const r of remoteRows) {
        delete r._metadata;
        remoteMap.set(getRowKey(r), r);
      }

      const missingInLocal = [];
      const missingInRemote = [];
      const conflicted = [];

      for (const [key, rRow] of remoteMap.entries()) {
        if (!localMap.has(key)) {
          missingInLocal.push(rRow);
        } else {
          const lRow = localMap.get(key);
          if (JSON.stringify(lRow) !== JSON.stringify(rRow)) {
            conflicted.push({ lRow, rRow });
          }
        }
      }

      for (const [key, lRow] of localMap.entries()) {
        if (!remoteMap.has(key)) {
          missingInRemote.push(lRow);
        }
      }

      let insLocal = 0;
      let insRemote = 0;
      let updLocal = 0;
      let updRemote = 0;

      // Insert missing into local (using transaction)
      if (missingInLocal.length > 0) {
        const placeholders = colNames.map(() => '?').join(', ');
        const insertSql = `INSERT OR REPLACE INTO "${table}" (${colNames.map(c => `"${c}"`).join(', ')}) VALUES (${placeholders})`;
        const stmt = localDb.prepare(insertSql);
        const insertBatch = localDb.transaction((rows) => {
          for (const row of rows) {
            const vals = colNames.map(c => row[c] === undefined ? null : row[c]);
            stmt.run(...vals);
          }
        });
        insertBatch(missingInLocal);
        insLocal = missingInLocal.length;
        totalInsertedLocal += insLocal;
      }

      // Insert missing into remote (using multi-row chunks)
      if (missingInRemote.length > 0) {
        const CHUNK_SIZE = 50;
        for (let i = 0; i < missingInRemote.length; i += CHUNK_SIZE) {
          const chunk = missingInRemote.slice(i, i + CHUNK_SIZE);
          const rowValues = chunk.map(row => '(' + colNames.map(c => sqlLiteral(row[c])).join(', ') + ')');
          const sql = `INSERT OR REPLACE INTO "${table}" (${colNames.map(c => `"${c}"`).join(', ')}) VALUES \n${rowValues.join(',\n')};`;
          remoteDb.exec(sql);
        }
        insRemote = missingInRemote.length;
        totalInsertedRemote += insRemote;
      }

      // Resolve content conflicts
      if (conflicted.length > 0) {
        const tsCol = colNames.find(c => ['updated_at', 'created_at_ms', 'created_at', 'applied_at'].includes(c));
        for (const { lRow, rRow } of conflicted) {
          let remoteNewer = false;
          if (tsCol && rRow[tsCol] && lRow[tsCol]) {
            remoteNewer = rRow[tsCol] > lRow[tsCol];
          }
          if (remoteNewer) {
            const placeholders = colNames.map(() => '?').join(', ');
            const sql = `INSERT OR REPLACE INTO "${table}" (${colNames.map(c => `"${c}"`).join(', ')}) VALUES (${placeholders})`;
            localDb.prepare(sql).run(...colNames.map(c => rRow[c] === undefined ? null : rRow[c]));
            updLocal++;
            totalUpdatedLocal++;
          } else {
            const rowVal = '(' + colNames.map(c => sqlLiteral(lRow[c])).join(', ') + ')';
            const sql = `INSERT OR REPLACE INTO "${table}" (${colNames.map(c => `"${c}"`).join(', ')}) VALUES ${rowVal};`;
            remoteDb.exec(sql);
            updRemote++;
            totalUpdatedRemote++;
          }
        }
      }

      // Update sqlite_sequence if table has an auto-increment id
      if (colNames.includes('id') && pkCols.includes('id')) {
        try {
          const maxLocal = localDb.prepare(`SELECT MAX(id) as m FROM "${table}"`).get()?.m;
          if (maxLocal !== null && maxLocal !== undefined) {
            localDb.prepare(`INSERT OR REPLACE INTO sqlite_sequence (name, seq) VALUES (?, ?)`).run(table, maxLocal);
            remoteDb.exec(`INSERT OR REPLACE INTO sqlite_sequence (name, seq) VALUES ('${table}', ${maxLocal});`);
          }
        } catch {}
      }

      if (insLocal > 0 || insRemote > 0 || updLocal > 0 || updRemote > 0) {
        report.push({
          table,
          insLocal,
          insRemote,
          updLocal,
          updRemote
        });
      }
    } catch (tblErr) {
      log(`Error syncing table ${table}: ${tblErr.message}`, 'ERROR');
    }
  }

  localDb.pragma('foreign_keys = ON');
  try { remoteDb.exec('PRAGMA foreign_keys = ON;'); } catch {}

  const durationSec = ((Date.now() - t0) / 1000).toFixed(2);
  log(`Sync finished in ${durationSec}s. Tables updated: ${report.length}. Local +${totalInsertedLocal}, Remote +${totalInsertedRemote}, Local ~${totalUpdatedLocal}, Remote ~${totalUpdatedRemote}`);
  if (report.length > 0) {
    console.table(report);
  }

  const now = new Date();
  const todayStr = now.toLocaleDateString('en-CA');
  const state = {
    lastSyncTime: now.toISOString(),
    lastSyncDate: todayStr,
    durationSec,
    status: 'success',
    totalInsertedLocal,
    totalInsertedRemote,
    totalUpdatedLocal,
    totalUpdatedRemote,
    tablesChanged: report.map(r => r.table)
  };

  try {
    if (!fs.existsSync(LOCAL_LOG_DIR)) fs.mkdirSync(LOCAL_LOG_DIR, { recursive: true });
    fs.writeFileSync(LAST_SYNC_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch {}

  remoteDb.close();
  localDb.close();
  log('================ TURSO DB SYNC COMPLETED SUCCESSFULLY ================');
  return state;
}

export async function main() {
  const args = process.argv.slice(2);
  const isCheckMissed = args.includes('--check-missed');

  if (isCheckMissed) {
    log('Running in --check-missed mode (Startup catch-up check)...');
    const todayStr = new Date().toLocaleDateString('en-CA');
    if (fs.existsSync(LAST_SYNC_FILE)) {
      try {
        const state = JSON.parse(fs.readFileSync(LAST_SYNC_FILE, 'utf8'));
        if (state.lastSyncDate === todayStr && state.status === 'success') {
          log(`Database already synchronized today (${todayStr} at ${state.lastSyncTime}). Startup sync not needed.`);
          process.exit(0);
        }
      } catch {}
    }
    log(`Database has NOT been synchronized today (${todayStr}). Waiting for server stabilization before syncing...`);
    await waitForServerReady(3001, 90);
  }

  try {
    await performSync();
    process.exit(0);
  } catch (err) {
    log(`Sync failed with error: ${err.message}`, 'ERROR');
    console.error(err);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
