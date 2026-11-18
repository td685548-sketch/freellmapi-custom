#!/usr/bin/env node
/**
 * rotate-encryption-key — re-encrypt every stored secret under a new
 * ENCRYPTION_KEY without losing a single value.
 *
 * Why this exists: AES-256-GCM is authenticated, so a DB carried over to a
 * different ENCRYPTION_KEY fails loudly on the first decrypt — every stored
 * API key, proxy override, client-profile credential and the Fetch Relay
 * token becomes unreadable at once, and there is no recovery path short of
 * re-entering secrets by hand.
 * Rotating keys (compromise, policy expiry, onboarding) therefore has to walk
 * the ciphertext, decrypt each value with the OLD key and re-encrypt it with
 * the NEW one, atomically, before the new key ever becomes active.
 *
 * The cipher parameters deliberately mirror server/src/lib/crypto.ts
 * (aes-256-gcm, 32-byte key hex, 16-byte IV, 16-byte GCM tag) so a value
 * written here decrypts under the running server exactly like one written by
 * `encrypt()`. The script does NOT touch the module-level key cache — it
 * performs every decrypt with `--old-key` and every encrypt with `--new-key`
 * explicitly, so it is safe to run while the server is stopped (recommended)
 * or even live (a writer that fires mid-run sees only already-migrated rows
 * because both keys are valid until the process restarts with the new key).
 *
 * Usage:
 *   tsx src/scripts/rotate-encryption-key.ts --old-key <64hex> --new-key <64hex> [--db <path>] [--dry-run]
 *
 *   --old-key  the current key (hex, 64 chars). Falls back to ENCRYPTION_KEY.
 *   --new-key  the key to rotate to (hex, 64 chars). Required.
 *   --db       SQLite path (default: the server's data/freeapi.db).
 *   --dry-run  decrypt + print every affected row WITHOUT writing anything.
 *
 * Exits 0 on success (or a clean dry run), 1 on any decrypt/validation error.
 * Nothing is written unless EVERY row decrypts — a partial rotate would leave
 * the DB in a mixed-key state that is exactly the failure this script exists
 * to prevent.
 */
import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ALGORITHM = 'aes-256-gcm';
const KEY_HEX_LEN = 64;
const AUTH_TAG_BYTES = 16;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB = path.resolve(__dirname, '../../data/freeapi.db');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function parseHexKey(value: string, source: string): Buffer {
  if (value.length !== KEY_HEX_LEN || !/^[0-9a-fA-F]+$/.test(value)) {
    throw new Error(
      `Invalid key (${source}): expected ${KEY_HEX_LEN} hex chars (32 bytes), got ${value.length} chars. ` +
      `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
    );
  }
  return Buffer.from(value, 'hex');
}

export function encryptWith(key: Buffer, text: string): { encrypted: string; iv: string; authTag: string } {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return { encrypted, iv: iv.toString('hex'), authTag: cipher.getAuthTag().toString('hex') };
}

export function decryptWith(key: Buffer, encrypted: string, iv: string, authTag: string): string {
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'hex'), { authTagLength: AUTH_TAG_BYTES });
  decipher.setAuthTag(Buffer.from(authTag, 'hex'));
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

/**
 * Ciphertext stored in dedicated columns: the IV and tag live next to their
 * ciphertext in sibling columns, all TEXT.
 */
interface ColumnGroup {
  kind: 'columns';
  table: string;
  idColumn: string;
  encrypted: string;
  iv: string;
  authTag: string;
  label: string;
}

/**
 * Ciphertext stored as a JSON blob in a single `settings` value, in the shape
 * `JSON.stringify(encrypt(plaintext))` — i.e. `{"encrypted","iv","authTag"}`.
 * The Fetch Relay bearer token is written this way by
 * `encodeFetchRelayToken()` (server/src/lib/proxy.ts) and read back by
 * `decodeFetchRelayToken()`, which degrades to '' with a warning when the
 * value will not decrypt. Miss it here and a rotate silently drops the relay
 * credential on the next restart.
 */
interface SettingGroup {
  kind: 'setting';
  table: 'settings' | 'x_gateway_config';
  settingKey: string;
  nestedField?: string;
  label: string;
}

type EncryptionGroup = ColumnGroup | SettingGroup;

// Every place a secret is persisted across core, X-Gateway, AI Platform, and Support.
const ENCRYPTION_GROUPS: EncryptionGroup[] = [
  { kind: 'columns', table: 'api_keys', idColumn: 'id', encrypted: 'encrypted_key', iv: 'iv', authTag: 'auth_tag', label: 'api key' },
  { kind: 'columns', table: 'api_keys', idColumn: 'id', encrypted: 'proxy_encrypted', iv: 'proxy_iv', authTag: 'proxy_auth_tag', label: 'per-key proxy override' },
  { kind: 'columns', table: 'client_profiles', idColumn: 'id', encrypted: 'encrypted_key', iv: 'iv', authTag: 'auth_tag', label: 'client-profile credential' },
  { kind: 'setting', table: 'settings', settingKey: 'fetch_relay_token', label: 'fetch relay token' },
  { kind: 'setting', table: 'settings', settingKey: 'thruline_sso_config', nestedField: 'oidcClientSecretEnc', label: 'thruline SSO OIDC client secret' },
  { kind: 'columns', table: 'x_gateway_keys', idColumn: 'id', encrypted: 'encrypted_key', iv: 'iv', authTag: 'auth_tag', label: 'x-gateway credential' },
  { kind: 'columns', table: 'x_gateway_keys', idColumn: 'id', encrypted: 'proxy_encrypted', iv: 'proxy_iv', authTag: 'proxy_auth_tag', label: 'x-gateway key proxy override' },
  { kind: 'columns', table: 'x_gateway_proxy_pool', idColumn: 'id', encrypted: 'proxy_encrypted', iv: 'proxy_iv', authTag: 'proxy_auth_tag', label: 'x-gateway proxy pool entry' },
  { kind: 'setting', table: 'x_gateway_config', settingKey: 'outbound_proxy', label: 'x-gateway outbound proxy' },
  { kind: 'columns', table: 'custom_ai_mcp_servers', idColumn: 'id', encrypted: 'auth_ciphertext', iv: 'auth_iv', authTag: 'auth_tag', label: 'ai-platform MCP server auth' },
  { kind: 'columns', table: 'custom_ai_approvals', idColumn: 'id', encrypted: 'args_ciphertext', iv: 'args_iv', authTag: 'args_tag', label: 'ai-platform approval args' },
  { kind: 'columns', table: 'custom_ai_guard_events', idColumn: 'id', encrypted: 'excerpt_ciphertext', iv: 'excerpt_iv', authTag: 'excerpt_tag', label: 'ai-platform guard excerpt' },
  { kind: 'columns', table: 'x_support_tenants', idColumn: 'id', encrypted: 'secret_encrypted', iv: 'secret_iv', authTag: 'secret_auth_tag', label: 'support tenant signing secret' },
  { kind: 'columns', table: 'x_support_db_sources', idColumn: 'id', encrypted: 'token_encrypted', iv: 'token_iv', authTag: 'token_auth_tag', label: 'support db source token' },
  { kind: 'columns', table: 'x_support_action_executions', idColumn: 'id', encrypted: 'requester_encrypted', iv: 'requester_iv', authTag: 'requester_auth_tag', label: 'support action requester' },
  { kind: 'columns', table: 'x_support_action_executions', idColumn: 'id', encrypted: 'effective_args_encrypted', iv: 'effective_args_iv', authTag: 'effective_args_auth_tag', label: 'support action effective args' },
  { kind: 'columns', table: 'x_support_action_executions', idColumn: 'id', encrypted: 'result_encrypted', iv: 'result_iv', authTag: 'result_auth_tag', label: 'support action result' },
  { kind: 'columns', table: 'x_support_partner_events', idColumn: 'rowid', encrypted: 'payload_encrypted', iv: 'payload_iv', authTag: 'payload_auth_tag', label: 'support partner event' },
  { kind: 'columns', table: 'x_support_partner_deliveries', idColumn: 'rowid', encrypted: 'target_snapshot_encrypted', iv: 'target_snapshot_iv', authTag: 'target_snapshot_auth_tag', label: 'support partner delivery target' },
  { kind: 'columns', table: 'x_support_evidence_sources', idColumn: 'rowid', encrypted: 'import_url_encrypted', iv: 'import_url_iv', authTag: 'import_url_auth_tag', label: 'support evidence source URL' },
  { kind: 'columns', table: 'x_support_evidence_revisions', idColumn: 'rowid', encrypted: 'payload_encrypted', iv: 'payload_iv', authTag: 'payload_auth_tag', label: 'support evidence revision' },
  { kind: 'columns', table: 'x_support_evidence_chunks', idColumn: 'rowid', encrypted: 'payload_encrypted', iv: 'payload_iv', authTag: 'payload_auth_tag', label: 'support evidence chunk' },
  { kind: 'columns', table: 'x_support_evidence_suites', idColumn: 'rowid', encrypted: 'cases_encrypted', iv: 'cases_iv', authTag: 'cases_auth_tag', label: 'support evidence suite' },
  { kind: 'columns', table: 'x_support_evidence_runs', idColumn: 'rowid', encrypted: 'report_encrypted', iv: 'report_iv', authTag: 'report_auth_tag', label: 'support evidence run' },
  { kind: 'columns', table: 'x_support_evidence_answers', idColumn: 'rowid', encrypted: 'evidence_encrypted', iv: 'evidence_iv', authTag: 'evidence_auth_tag', label: 'support evidence answer' },
  { kind: 'columns', table: 'x_support_output_policies', idColumn: 'rowid', encrypted: 'payload_encrypted', iv: 'payload_iv', authTag: 'payload_auth_tag', label: 'support output policy' },
  { kind: 'columns', table: 'x_support_runtime_turns', idColumn: 'rowid', encrypted: 'masked_response_encrypted', iv: 'iv', authTag: 'auth_tag', label: 'support runtime turn' },
  { kind: 'columns', table: 'x_support_desk_widget_configs', idColumn: 'rowid', encrypted: 'payload_encrypted', iv: 'payload_iv', authTag: 'payload_auth_tag', label: 'support service desk widget config' },
  { kind: 'columns', table: 'x_support_desk_intakes', idColumn: 'rowid', encrypted: 'payload_encrypted', iv: 'payload_iv', authTag: 'payload_auth_tag', label: 'support service desk intake' },
  { kind: 'columns', table: 'x_support_desk_copilot_jobs', idColumn: 'rowid', encrypted: 'payload_encrypted', iv: 'payload_iv', authTag: 'payload_auth_tag', label: 'support service desk copilot job' },
  { kind: 'columns', table: 'x_support_desk_sla_policies', idColumn: 'rowid', encrypted: 'payload_encrypted', iv: 'payload_iv', authTag: 'payload_auth_tag', label: 'support service desk sla policy' },
  { kind: 'columns', table: 'x_support_desk_ticket_state', idColumn: 'rowid', encrypted: 'meta_encrypted', iv: 'meta_iv', authTag: 'meta_auth_tag', label: 'support service desk ticket state' },
];

interface RowToRotate {
  group: EncryptionGroup;
  /** Row id for column groups, the settings key for settings blobs. */
  id: number | string;
  plaintext: string;
  reEncrypted: { encrypted: string; iv: string; authTag: string };
  outerJson?: Record<string, unknown>;
}

/** Result of a rotate attempt: rows re-encrypted, or an error that aborted it. */
export interface RotateResult {
  rows: RowToRotate[];
  error?: string;
}

/** The read surface rotateSecrets needs — better-sqlite3 and the app's Db both satisfy it. */
export interface RotateReadDb {
  prepare(sql: string): { all(...args: unknown[]): unknown[]; get(...args: unknown[]): unknown };
}

/** The write surface applyRotation needs, including better-sqlite3's transaction(). */
export interface RotateWriteDb {
  prepare(sql: string): { run(...args: unknown[]): unknown };
  // Deliberately phrased as "a callable taking the same arguments" rather than
  // "returns F": better-sqlite3 hands back a Transaction<F> (F plus .deferred
  // and friends) while the app's Db type returns F itself, and both satisfy
  // this shape.
  transaction<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => unknown;
}

/**
 * Core rotate routine, exported so tests can drive it against an in-memory
 * DB. Decrypts every stored secret with `oldKey` and re-encrypts with
 * `newKey`. Returns `{ rows }` on success and `{ rows: [], error }` when ANY
 * value fails to decrypt — the caller must treat the error case as "nothing
 * written".
 */
export function rotateSecrets(
  db: RotateReadDb,
  oldKey: Buffer,
  newKey: Buffer,
): RotateResult {
  const rowsToRotate: RowToRotate[] = [];

  for (const group of ENCRYPTION_GROUPS) {
    const cols = db.prepare(`PRAGMA table_info(${group.table})`).all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));

    // Ciphertext held as (encrypted, iv, auth_tag) columns.
    if (group.kind === 'columns') {
      if (!names.has(group.encrypted) || !names.has(group.iv) || !names.has(group.authTag)) {
        continue;
      }

      const rows = db.prepare(
        `SELECT ${group.idColumn} AS id, ${group.encrypted} AS enc, ${group.iv} AS iv, ${group.authTag} AS tag ` +
        `FROM ${group.table} WHERE ${group.encrypted} IS NOT NULL AND length(${group.encrypted}) > 0`,
      ).all() as Array<{ id: number | string; enc: string; iv: string; tag: string }>;

      for (const row of rows) {
        let plaintext: string;
        try {
          plaintext = decryptWith(oldKey, row.enc, row.iv, row.tag);
        } catch (err) {
          return {
            rows: [],
            error: `cannot decrypt ${group.label} #${row.id} with --old-key — wrong key or corrupted ciphertext (${(err as Error).message}). Aborting; nothing was written.`,
          };
        }
        rowsToRotate.push({ group, id: row.id, plaintext, reEncrypted: encryptWith(newKey, plaintext) });
      }
      continue;
    }

    // Ciphertext held as a JSON blob in settings.value or x_gateway_config.value.
    if (!names.has('key') || !names.has('value')) continue;

    const row = db.prepare(`SELECT value FROM ${group.table} WHERE key = ?`).get(group.settingKey) as { value: string } | undefined;
    // An unset or cleared setting stores '' rather than a blob — nothing to do.
    if (!row || !row.value) continue;

    let outerJson: Record<string, unknown> | undefined;
    let payloadStr = row.value;
    if (group.nestedField) {
      let outer: unknown;
      try {
        outer = JSON.parse(row.value);
      } catch {
        return {
          rows: [],
          error: `${group.label} (${group.table}.${group.settingKey}) is not valid JSON — refusing to guess. Aborting; nothing was written.`,
        };
      }
      if (!outer || typeof outer !== 'object' || Array.isArray(outer)) {
        return {
          rows: [],
          error: `${group.label} (${group.table}.${group.settingKey}) is not a JSON object. Aborting; nothing was written.`,
        };
      }
      outerJson = outer as Record<string, unknown>;
      const rawInner = outerJson[group.nestedField];
      if (typeof rawInner !== 'string' || !rawInner) continue;
      payloadStr = rawInner;
    }

    let parsed: { encrypted?: string; iv?: string; authTag?: string };
    try {
      parsed = JSON.parse(payloadStr) as { encrypted?: string; iv?: string; authTag?: string };
    } catch {
      return {
        rows: [],
        error: `${group.label} (${group.table}.${group.settingKey}) is not valid JSON — refusing to guess. Aborting; nothing was written.`,
      };
    }
    if (!parsed.encrypted || !parsed.iv || !parsed.authTag) {
      return {
        rows: [],
        error: `${group.label} (${group.table}.${group.settingKey}) is missing encrypted/iv/authTag. Aborting; nothing was written.`,
      };
    }

    let plaintext: string;
    try {
      plaintext = decryptWith(oldKey, parsed.encrypted, parsed.iv, parsed.authTag);
    } catch (err) {
      return {
        rows: [],
        error: `cannot decrypt ${group.label} (${group.table}.${group.settingKey}) with --old-key — wrong key or corrupted ciphertext (${(err as Error).message}). Aborting; nothing was written.`,
      };
    }
    rowsToRotate.push({ group, id: group.settingKey, plaintext, reEncrypted: encryptWith(newKey, plaintext), outerJson });
  }

  return { rows: rowsToRotate };
}

/**
 * Apply a rotate result: write every re-encrypted value back to its row, in
 * one transaction. Exported so main() and tests share the exact write path.
 */
export function applyRotation(
  db: RotateWriteDb,
  rows: RowToRotate[],
): void {
  const write = db.transaction((items: RowToRotate[]) => {
    for (const r of items) {
      if (r.group.kind === 'setting') {
        const nextValue = r.group.nestedField && r.outerJson
          ? JSON.stringify({ ...r.outerJson, [r.group.nestedField]: JSON.stringify(r.reEncrypted) })
          : JSON.stringify(r.reEncrypted);
        db.prepare(`UPDATE ${r.group.table} SET value = ? WHERE key = ?`)
          .run(nextValue, r.group.settingKey);
        continue;
      }
      db.prepare(
        `UPDATE ${r.group.table} SET ${r.group.encrypted} = ?, ${r.group.iv} = ?, ${r.group.authTag} = ? WHERE ${r.group.idColumn} = ?`,
      ).run(r.reEncrypted.encrypted, r.reEncrypted.iv, r.reEncrypted.authTag, r.id);
    }
  });
  write(rows);
}

function main(): void {
  const oldKeyHex = arg('old-key') ?? process.env.ENCRYPTION_KEY;
  const newKeyHex = arg('new-key');
  const dbPath = arg('db') ?? DEFAULT_DB;
  const dryRun = flag('dry-run');

  if (!oldKeyHex) {
    console.error('error: --old-key is required (or set ENCRYPTION_KEY)');
    process.exit(1);
  }
  if (!newKeyHex) {
    console.error('error: --new-key is required');
    process.exit(1);
  }
  if (!fs.existsSync(dbPath)) {
    console.error(`error: database not found at ${dbPath}`);
    process.exit(1);
  }

  const oldKey = parseHexKey(oldKeyHex, 'old');
  const newKey = parseHexKey(newKeyHex, 'new');
  if (oldKey.equals(newKey)) {
    console.error('error: --old-key and --new-key are identical — nothing to rotate');
    process.exit(1);
  }

  const db = new Database(dbPath, { readonly: dryRun });
  try {
    const result = rotateSecrets(db, oldKey, newKey);
    if (result.error) {
      console.error(`error: ${result.error}`);
      process.exit(1);
    }

    const rowsToRotate = result.rows;
    if (rowsToRotate.length === 0) {
      console.log('No encrypted values found — nothing to rotate.');
      return;
    }

    if (dryRun) {
      console.log(`[dry-run] would rotate ${rowsToRotate.length} value(s):`);
      for (const r of rowsToRotate) {
        const where = r.group.kind === 'setting' ? `settings.${r.group.settingKey}` : `#${r.id}`;
        console.log(`  ${r.group.label} ${where} -> ${r.plaintext.slice(0, 3)}*** (${r.plaintext.length} chars)`);
      }
      return;
    }

    applyRotation(db, rowsToRotate);

    console.log(`Rotated ${rowsToRotate.length} value(s) to the new key.`);
    console.log('Next steps: set ENCRYPTION_KEY to the new key (or overwrite the .encryption-key file next to the DB) and restart the server.');
  } finally {
    db.close();
  }
}

// Only run when invoked directly (`tsx src/scripts/rotate-encryption-key.ts`),
// not when the module is imported by tests for `rotateSecrets`/`encryptWith`.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
