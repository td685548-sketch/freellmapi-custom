import crypto from 'node:crypto';
import { getDb, type Db } from '../../db/index.js';
import { encrypt, decrypt, isEncryptionKeyInitialized, initEncryptionKey } from '../../lib/crypto.js';
import { up as supportEvidenceUp } from '../../db/migrations/20261113_090001_support_evidence.js';
import { ensureSupportTables } from './support-store.js';
import { listSupportKnowledgeDocs } from './support-knowledge.js';
import {
  DEFAULT_EVIDENCE_POLICY,
  EVIDENCE_POLICY_BOUNDS,
  SUPPORT_EVIDENCE_LIMITS,
  SUPPORT_EVIDENCE_ROLES,
  type SupportAnswerEvidence,
  type SupportEvidenceCase,
  type SupportEvidenceChunk,
  type SupportEvidenceFormat,
  type SupportEvidencePolicy,
  type SupportEvidenceRevision,
  type SupportEvidenceRevisionDetail,
  type SupportEvidenceRole,
  type SupportEvidenceRun,
  type SupportEvidenceSource,
  type SupportEvidenceSourceKind,
  type SupportEvidenceSourceStatus,
  type SupportEvidenceSuite,
} from '@freellmapi/shared/support-evidence.js';
import {
  fetchSupportEvidenceExport,
  SupportEvidenceError,
  validateAndNormalizeImportInput,
} from './support-evidence-import.js';

export { SupportEvidenceError };

let evidenceDb: Db | undefined;

/**
 * Ensures 018 evidence tables exist and encryption key is initialized.
 * When no targetDb is supplied, initializes the lazy 014/017 tenant schema first.
 */
export function ensureSupportEvidenceTables(targetDb?: Db): Db {
  const db = targetDb ?? getDb();
  if (evidenceDb === db) return db;

  if (!targetDb) {
    ensureSupportTables();
  } else {
    const hasTenants = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'x_support_tenants'")
      .get();
    if (!hasTenants) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
    }
  }

  supportEvidenceUp(db);
  if (!isEncryptionKeyInitialized()) {
    initEncryptionKey(db);
  }
  evidenceDb = db;
  return db;
}

function assertPositiveTenantId(tenantId: number): void {
  if (!Number.isInteger(tenantId) || tenantId <= 0) {
    throw new SupportEvidenceError(400, 'invalid_input', 'tenantId must be a positive integer.');
  }
}

function assertTenantExists(db: Db, tenantId: number): void {
  assertPositiveTenantId(tenantId);
  const row = db.prepare('SELECT id FROM x_support_tenants WHERE id = ?').get(tenantId) as
    | { id: number }
    | undefined;
  if (!row) {
    throw new SupportEvidenceError(404, 'knowledge_source_not_found', 'Support tenant not found.');
  }
}

function assertExpectedVersion(expectedVersion: unknown): number {
  if (typeof expectedVersion !== 'number' || !Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new SupportEvidenceError(400, 'invalid_input', 'expectedVersion must be a positive integer.');
  }
  return expectedVersion;
}

function assertKnownKeys(obj: unknown, allowedKeys: readonly string[], label: string): Record<string, unknown> {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new SupportEvidenceError(400, 'invalid_input', `${label} must be an object.`);
  }
  const rec = obj as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (!allowedKeys.includes(key)) {
      throw new SupportEvidenceError(400, 'invalid_input', `Unsupported field "${key}" in ${label}.`);
    }
  }
  return rec;
}

function isSupportEvidenceRole(val: unknown): val is SupportEvidenceRole {
  return typeof val === 'string' && (SUPPORT_EVIDENCE_ROLES as readonly string[]).includes(val);
}

function normalizeAllowedRoles(roles: unknown, defaultAdmin = false): SupportEvidenceRole[] {
  if (roles === undefined && defaultAdmin) {
    return ['admin'];
  }
  if (!Array.isArray(roles) || roles.length === 0) {
    throw new SupportEvidenceError(400, 'invalid_input', 'allowedRoles must be a non-empty array of known roles.');
  }
  const unique: SupportEvidenceRole[] = [];
  const seen = new Set<string>();
  for (const r of roles) {
    if (!isSupportEvidenceRole(r)) {
      throw new SupportEvidenceError(400, 'invalid_input', 'allowedRoles contains an unsupported role.');
    }
    if (!seen.has(r)) {
      seen.add(r);
      unique.push(r);
    }
  }
  return unique;
}

function parseJsonSafe<T>(raw: string, errorMessage: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new SupportEvidenceError(503, 'evidence_storage_unavailable', errorMessage);
  }
}

function decryptJsonSafe<T>(encrypted: string, iv: string, authTag: string, errorMessage: string): T {
  try {
    const plain = decrypt(encrypted, iv, authTag);
    return JSON.parse(plain) as T;
  } catch {
    throw new SupportEvidenceError(503, 'evidence_storage_unavailable', errorMessage);
  }
}

// ---------------------------------------------------------------------------
// Evidence Policy CRUD
// ---------------------------------------------------------------------------

function validateStoredPolicy(raw: unknown): SupportEvidencePolicy {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SupportEvidenceError(503, 'evidence_storage_unavailable', 'Stored evidence policy is corrupted.');
  }
  const p = raw as Record<string, unknown>;
  if (p.mode !== 'off' && p.mode !== 'required') {
    throw new SupportEvidenceError(503, 'evidence_storage_unavailable', 'Stored evidence policy mode is corrupted.');
  }
  if (typeof p.includeLegacyDocs !== 'boolean') {
    throw new SupportEvidenceError(503, 'evidence_storage_unavailable', 'Stored evidence policy is corrupted.');
  }
  if (
    typeof p.topK !== 'number' ||
    !Number.isInteger(p.topK) ||
    p.topK < EVIDENCE_POLICY_BOUNDS.topK.min ||
    p.topK > EVIDENCE_POLICY_BOUNDS.topK.max
  ) {
    throw new SupportEvidenceError(503, 'evidence_storage_unavailable', 'Stored evidence policy topK is corrupted.');
  }
  if (
    typeof p.minCoverage !== 'number' ||
    !Number.isFinite(p.minCoverage) ||
    p.minCoverage < EVIDENCE_POLICY_BOUNDS.minCoverage.min ||
    p.minCoverage > EVIDENCE_POLICY_BOUNDS.minCoverage.max
  ) {
    throw new SupportEvidenceError(503, 'evidence_storage_unavailable', 'Stored evidence policy minCoverage is corrupted.');
  }
  if (
    typeof p.maxEvidenceChars !== 'number' ||
    !Number.isInteger(p.maxEvidenceChars) ||
    p.maxEvidenceChars < EVIDENCE_POLICY_BOUNDS.maxEvidenceChars.min ||
    p.maxEvidenceChars > EVIDENCE_POLICY_BOUNDS.maxEvidenceChars.max
  ) {
    throw new SupportEvidenceError(503, 'evidence_storage_unavailable', 'Stored evidence policy maxEvidenceChars is corrupted.');
  }
  if (typeof p.version !== 'number' || !Number.isInteger(p.version) || p.version < 1) {
    throw new SupportEvidenceError(503, 'evidence_storage_unavailable', 'Stored evidence policy version is corrupted.');
  }
  if (typeof p.updatedAt !== 'string' || !p.updatedAt) {
    throw new SupportEvidenceError(503, 'evidence_storage_unavailable', 'Stored evidence policy timestamp is corrupted.');
  }
  return {
    mode: p.mode,
    includeLegacyDocs: p.includeLegacyDocs,
    topK: p.topK,
    minCoverage: p.minCoverage,
    maxEvidenceChars: p.maxEvidenceChars,
    version: p.version,
    updatedAt: p.updatedAt,
  };
}

export function getSupportEvidencePolicy(tenantId: number): SupportEvidencePolicy {
  assertPositiveTenantId(tenantId);
  let db: Db;
  try {
    db = ensureSupportEvidenceTables();
  } catch (err) {
    if (err instanceof SupportEvidenceError) throw err;
    throw new SupportEvidenceError(503, 'evidence_storage_unavailable', 'Evidence policy storage is unavailable.');
  }

  let row: { policy_json: string; version: number; updated_at: string } | undefined;
  try {
    row = db
      .prepare('SELECT policy_json, version, updated_at FROM x_support_evidence_policies WHERE tenant_id = ?')
      .get(tenantId) as { policy_json: string; version: number; updated_at: string } | undefined;
  } catch {
    throw new SupportEvidenceError(503, 'evidence_storage_unavailable', 'Evidence policy storage read failed.');
  }

  if (!row) {
    return { ...DEFAULT_EVIDENCE_POLICY };
  }

  const parsed = parseJsonSafe<unknown>(row.policy_json, 'Stored evidence policy JSON is corrupted.');
  const validated = validateStoredPolicy(parsed);
  if (validated.version !== row.version) {
    throw new SupportEvidenceError(503, 'evidence_storage_unavailable', 'Stored evidence policy version mismatch.');
  }
  return validated;
}

export interface SupportEvidencePolicyPatch {
  mode?: 'off' | 'required';
  includeLegacyDocs?: boolean;
  topK?: number;
  minCoverage?: number;
  maxEvidenceChars?: number;
}

export function updateSupportEvidencePolicy(
  tenantId: number,
  patch: SupportEvidencePolicyPatch,
  expectedVersion: number,
): SupportEvidencePolicy {
  const rec = assertKnownKeys(
    patch,
    ['mode', 'includeLegacyDocs', 'topK', 'minCoverage', 'maxEvidenceChars'],
    'policy patch',
  );
  const expectedVer = assertExpectedVersion(expectedVersion);

  if (rec.mode !== undefined && rec.mode !== 'off' && rec.mode !== 'required') {
    throw new SupportEvidenceError(400, 'invalid_input', 'Policy mode must be off or required.');
  }
  if (rec.includeLegacyDocs !== undefined && typeof rec.includeLegacyDocs !== 'boolean') {
    throw new SupportEvidenceError(400, 'invalid_input', 'includeLegacyDocs must be a boolean.');
  }
  if (
    rec.topK !== undefined &&
    (typeof rec.topK !== 'number' ||
      !Number.isInteger(rec.topK) ||
      rec.topK < EVIDENCE_POLICY_BOUNDS.topK.min ||
      rec.topK > EVIDENCE_POLICY_BOUNDS.topK.max)
  ) {
    throw new SupportEvidenceError(
      400,
      'invalid_input',
      `topK must be an integer ${EVIDENCE_POLICY_BOUNDS.topK.min}..${EVIDENCE_POLICY_BOUNDS.topK.max}.`,
    );
  }
  if (
    rec.minCoverage !== undefined &&
    (typeof rec.minCoverage !== 'number' ||
      !Number.isFinite(rec.minCoverage) ||
      rec.minCoverage < EVIDENCE_POLICY_BOUNDS.minCoverage.min ||
      rec.minCoverage > EVIDENCE_POLICY_BOUNDS.minCoverage.max)
  ) {
    throw new SupportEvidenceError(
      400,
      'invalid_input',
      `minCoverage must be ${EVIDENCE_POLICY_BOUNDS.minCoverage.min}..${EVIDENCE_POLICY_BOUNDS.minCoverage.max}.`,
    );
  }
  if (
    rec.maxEvidenceChars !== undefined &&
    (typeof rec.maxEvidenceChars !== 'number' ||
      !Number.isInteger(rec.maxEvidenceChars) ||
      rec.maxEvidenceChars < EVIDENCE_POLICY_BOUNDS.maxEvidenceChars.min ||
      rec.maxEvidenceChars > EVIDENCE_POLICY_BOUNDS.maxEvidenceChars.max)
  ) {
    throw new SupportEvidenceError(
      400,
      'invalid_input',
      `maxEvidenceChars must be an integer ${EVIDENCE_POLICY_BOUNDS.maxEvidenceChars.min}..${EVIDENCE_POLICY_BOUNDS.maxEvidenceChars.max}.`,
    );
  }

  const db = ensureSupportEvidenceTables();
  const tx = db.transaction((): SupportEvidencePolicy => {
    assertTenantExists(db, tenantId);
    const existingRow = db
      .prepare('SELECT policy_json, version, updated_at FROM x_support_evidence_policies WHERE tenant_id = ?')
      .get(tenantId) as { policy_json: string; version: number; updated_at: string } | undefined;

    const current = existingRow
      ? validateStoredPolicy(parseJsonSafe<unknown>(existingRow.policy_json, 'Stored evidence policy JSON is corrupted.'))
      : { ...DEFAULT_EVIDENCE_POLICY };

    if (current.version !== expectedVer) {
      throw new SupportEvidenceError(409, 'source_conflict', 'Evidence policy version conflict.');
    }

    const now = new Date().toISOString();
    const next: SupportEvidencePolicy = {
      mode: (rec.mode as 'off' | 'required' | undefined) ?? current.mode,
      includeLegacyDocs: (rec.includeLegacyDocs as boolean | undefined) ?? current.includeLegacyDocs,
      topK: (rec.topK as number | undefined) ?? current.topK,
      minCoverage: (rec.minCoverage as number | undefined) ?? current.minCoverage,
      maxEvidenceChars: (rec.maxEvidenceChars as number | undefined) ?? current.maxEvidenceChars,
      version: current.version + 1,
      updatedAt: now,
    };

    db.prepare(
      `INSERT INTO x_support_evidence_policies (tenant_id, policy_json, version, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(tenant_id) DO UPDATE SET
         policy_json = excluded.policy_json,
         version = excluded.version,
         updated_at = excluded.updated_at`,
    ).run(tenantId, JSON.stringify(next), next.version, next.updatedAt);

    return next;
  });

  return tx();
}

// ---------------------------------------------------------------------------
// Source & Revision CRUD
// ---------------------------------------------------------------------------

interface SourceRow {
  id: string;
  tenant_id: number;
  name: string;
  kind: SupportEvidenceSourceKind;
  status: SupportEvidenceSourceStatus;
  allowed_roles_json: string;
  version: number;
  published_revision_id: string | null;
  draft_revision_id: string | null;
  revision_count: number;
  import_url_encrypted: string | null;
  import_url_iv: string | null;
  import_url_auth_tag: string | null;
  created_at: string;
  updated_at: string;
}

function sourceFromRow(row: SourceRow): SupportEvidenceSource {
  const roles = parseJsonSafe<unknown>(row.allowed_roles_json, 'Stored source roles are corrupted.');
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    kind: row.kind,
    status: row.status,
    allowedRoles: normalizeAllowedRoles(roles, false),
    version: row.version,
    publishedRevisionId: row.published_revision_id,
    draftRevisionId: row.draft_revision_id,
    revisionCount: row.revision_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface RevisionRow {
  id: string;
  tenant_id: number;
  source_id: string;
  format: SupportEvidenceFormat;
  content_hash: string;
  chunk_count: number;
  payload_encrypted: string;
  payload_iv: string;
  payload_auth_tag: string;
  created_at: string;
}

interface RevisionPayload {
  title: string;
  category: string;
  tags: string[];
  content: string;
}

function revisionFromRow(row: RevisionRow, includeContent: false): SupportEvidenceRevision;
function revisionFromRow(row: RevisionRow, includeContent: true): SupportEvidenceRevisionDetail;
function revisionFromRow(row: RevisionRow, includeContent: boolean): SupportEvidenceRevision | SupportEvidenceRevisionDetail {
  const payload = decryptJsonSafe<RevisionPayload>(
    row.payload_encrypted,
    row.payload_iv,
    row.payload_auth_tag,
    'Stored revision payload is corrupted or cannot be decrypted.',
  );
  const base: SupportEvidenceRevision = {
    id: row.id,
    tenantId: row.tenant_id,
    sourceId: row.source_id,
    format: row.format,
    title: payload.title,
    category: payload.category,
    tags: payload.tags,
    contentHash: row.content_hash,
    chunkCount: row.chunk_count,
    createdAt: row.created_at,
  };
  if (includeContent) {
    return { ...base, content: payload.content };
  }
  return base;
}

export function listSupportEvidenceSources(tenantId: number): SupportEvidenceSource[] {
  assertPositiveTenantId(tenantId);
  const db = ensureSupportEvidenceTables();
  const rows = db
    .prepare('SELECT * FROM x_support_evidence_sources WHERE tenant_id = ? ORDER BY created_at DESC, id ASC')
    .all(tenantId) as SourceRow[];
  return rows.map(sourceFromRow);
}

export function getSupportEvidenceSource(tenantId: number, sourceId: string): SupportEvidenceSource {
  assertPositiveTenantId(tenantId);
  if (typeof sourceId !== 'string' || !sourceId) {
    throw new SupportEvidenceError(400, 'invalid_input', 'sourceId is required.');
  }
  const db = ensureSupportEvidenceTables();
  const row = db
    .prepare('SELECT * FROM x_support_evidence_sources WHERE tenant_id = ? AND id = ?')
    .get(tenantId, sourceId) as SourceRow | undefined;
  if (!row) {
    throw new SupportEvidenceError(404, 'knowledge_source_not_found', 'Knowledge source not found.');
  }
  return sourceFromRow(row);
}

export function createSupportEvidenceSource(
  tenantId: number,
  input: { name: string; kind: SupportEvidenceSourceKind; allowedRoles?: SupportEvidenceRole[] },
): SupportEvidenceSource {
  const rec = assertKnownKeys(input, ['name', 'kind', 'allowedRoles'], 'source');
  if (typeof rec.name !== 'string') {
    throw new SupportEvidenceError(400, 'invalid_input', 'Source name is required.');
  }
  const name = rec.name.normalize('NFC').trim();
  if (!name || name.length > SUPPORT_EVIDENCE_LIMITS.maxSourceNameChars) {
    throw new SupportEvidenceError(
      400,
      'invalid_input',
      `Source name must be 1..${SUPPORT_EVIDENCE_LIMITS.maxSourceNameChars} characters.`,
    );
  }
  if (rec.kind !== 'text' && rec.kind !== 'markdown' && rec.kind !== 'faq_json' && rec.kind !== 'url') {
    throw new SupportEvidenceError(400, 'invalid_input', 'Source kind must be text, markdown, faq_json, or url.');
  }
  const allowedRoles = normalizeAllowedRoles(rec.allowedRoles, true);

  const db = ensureSupportEvidenceTables();
  const tx = db.transaction((): SupportEvidenceSource => {
    assertTenantExists(db, tenantId);
    const countRow = db
      .prepare('SELECT COUNT(*) AS count FROM x_support_evidence_sources WHERE tenant_id = ?')
      .get(tenantId) as { count: number };
    if (countRow.count >= SUPPORT_EVIDENCE_LIMITS.maxSourcesPerTenant) {
      throw new SupportEvidenceError(
        409,
        'evidence_capacity_exceeded',
        `Tenant has reached the maximum of ${SUPPORT_EVIDENCE_LIMITS.maxSourcesPerTenant} sources.`,
      );
    }

    const id = `src_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO x_support_evidence_sources
        (id, tenant_id, name, kind, status, allowed_roles_json, version, published_revision_id, draft_revision_id, revision_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, 1, NULL, NULL, 0, ?, ?)`,
    ).run(id, tenantId, name, rec.kind, JSON.stringify(allowedRoles), now, now);

    const created = db
      .prepare('SELECT * FROM x_support_evidence_sources WHERE tenant_id = ? AND id = ?')
      .get(tenantId, id) as SourceRow;
    return sourceFromRow(created);
  });

  return tx();
}

function getPublishedChunkCount(db: Db, tenantId: number, excludeSourceId?: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(r.chunk_count), 0) AS total
         FROM x_support_evidence_sources s
         JOIN x_support_evidence_revisions r
           ON r.tenant_id = s.tenant_id AND r.source_id = s.id AND r.id = s.published_revision_id
        WHERE s.tenant_id = ?
          AND s.status = 'active'
          AND s.published_revision_id IS NOT NULL
          ${excludeSourceId ? 'AND s.id <> ?' : ''}`,
    )
    .get(...(excludeSourceId ? [tenantId, excludeSourceId] : [tenantId])) as { total: number };
  return row.total;
}

export function updateSupportEvidenceSource(
  tenantId: number,
  sourceId: string,
  patch: { name?: string; allowedRoles?: SupportEvidenceRole[]; status?: SupportEvidenceSourceStatus },
  expectedVersion: number,
): SupportEvidenceSource {
  assertPositiveTenantId(tenantId);
  if (typeof sourceId !== 'string' || !sourceId) {
    throw new SupportEvidenceError(400, 'invalid_input', 'sourceId is required.');
  }
  const rec = assertKnownKeys(patch, ['name', 'allowedRoles', 'status'], 'source patch');
  const expectedVer = assertExpectedVersion(expectedVersion);

  let nextName: string | undefined;
  if (rec.name !== undefined) {
    if (typeof rec.name !== 'string') {
      throw new SupportEvidenceError(400, 'invalid_input', 'Source name must be a string.');
    }
    nextName = rec.name.normalize('NFC').trim();
    if (!nextName || nextName.length > SUPPORT_EVIDENCE_LIMITS.maxSourceNameChars) {
      throw new SupportEvidenceError(
        400,
        'invalid_input',
        `Source name must be 1..${SUPPORT_EVIDENCE_LIMITS.maxSourceNameChars} characters.`,
      );
    }
  }

  let nextRoles: SupportEvidenceRole[] | undefined;
  if (rec.allowedRoles !== undefined) {
    nextRoles = normalizeAllowedRoles(rec.allowedRoles, false);
  }

  let nextStatus: SupportEvidenceSourceStatus | undefined;
  if (rec.status !== undefined) {
    if (rec.status !== 'active' && rec.status !== 'archived') {
      throw new SupportEvidenceError(400, 'invalid_input', 'Source status must be active or archived.');
    }
    nextStatus = rec.status;
  }

  const db = ensureSupportEvidenceTables();
  const tx = db.transaction((): SupportEvidenceSource => {
    const existing = db
      .prepare('SELECT * FROM x_support_evidence_sources WHERE tenant_id = ? AND id = ?')
      .get(tenantId, sourceId) as SourceRow | undefined;
    if (!existing) {
      throw new SupportEvidenceError(404, 'knowledge_source_not_found', 'Knowledge source not found.');
    }
    if (existing.version !== expectedVer) {
      throw new SupportEvidenceError(409, 'source_conflict', 'Knowledge source version conflict.');
    }

    const finalStatus = nextStatus ?? existing.status;
    if (existing.status === 'archived' && finalStatus === 'active' && existing.published_revision_id) {
      const revRow = db
        .prepare('SELECT chunk_count FROM x_support_evidence_revisions WHERE tenant_id = ? AND source_id = ? AND id = ?')
        .get(tenantId, sourceId, existing.published_revision_id) as { chunk_count: number } | undefined;
      const otherChunks = getPublishedChunkCount(db, tenantId, sourceId);
      const revChunks = revRow?.chunk_count ?? 0;
      if (otherChunks + revChunks > SUPPORT_EVIDENCE_LIMITS.maxPublishedChunksPerTenant) {
        throw new SupportEvidenceError(
          409,
          'evidence_capacity_exceeded',
          `Activating this source would exceed the ${SUPPORT_EVIDENCE_LIMITS.maxPublishedChunksPerTenant} published chunk limit.`,
        );
      }
    }

    const now = new Date().toISOString();
    db.prepare(
      `UPDATE x_support_evidence_sources
          SET name = ?, allowed_roles_json = ?, status = ?, version = version + 1, updated_at = ?
        WHERE tenant_id = ? AND id = ? AND version = ?`,
    ).run(
      nextName ?? existing.name,
      nextRoles ? JSON.stringify(nextRoles) : existing.allowed_roles_json,
      finalStatus,
      now,
      tenantId,
      sourceId,
      expectedVer,
    );

    const updated = db
      .prepare('SELECT * FROM x_support_evidence_sources WHERE tenant_id = ? AND id = ?')
      .get(tenantId, sourceId) as SourceRow;
    return sourceFromRow(updated);
  });

  return tx();
}

export interface ImportSupportEvidenceRevisionOptions {
  tenantId: number;
  sourceId: string;
  expectedVersion: number;
  title: string;
  category?: string;
  tags?: string[];
  format: SupportEvidenceFormat;
  content?: string;
  url?: string;
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
  dnsResolver?: (host: string) => Promise<string[]>;
  deadlineMs?: number;
}

export async function importSupportEvidenceRevision(
  options: ImportSupportEvidenceRevisionOptions,
): Promise<{ source: SupportEvidenceSource; revision: SupportEvidenceRevision; deduplicated: boolean }> {
  assertKnownKeys(
    options,
    ['tenantId', 'sourceId', 'expectedVersion', 'title', 'category', 'tags', 'format', 'content', 'url', 'signal', 'fetchFn', 'dnsResolver', 'deadlineMs'],
    'import options',
  );
  assertPositiveTenantId(options.tenantId);
  if (typeof options.sourceId !== 'string' || !options.sourceId) {
    throw new SupportEvidenceError(400, 'invalid_input', 'sourceId is required.');
  }
  const expectedVer = assertExpectedVersion(options.expectedVersion);

  const hasContent = options.content !== undefined;
  const hasUrl = options.url !== undefined;
  if (hasContent === hasUrl) {
    throw new SupportEvidenceError(400, 'invalid_input', 'Provide exactly one of content or url.');
  }

  const db = ensureSupportEvidenceTables();
  const initialSource = db
    .prepare('SELECT * FROM x_support_evidence_sources WHERE tenant_id = ? AND id = ?')
    .get(options.tenantId, options.sourceId) as SourceRow | undefined;
  if (!initialSource) {
    throw new SupportEvidenceError(404, 'knowledge_source_not_found', 'Knowledge source not found.');
  }
  if (initialSource.version !== expectedVer) {
    throw new SupportEvidenceError(409, 'source_conflict', 'Knowledge source version conflict.');
  }
  if (initialSource.kind === 'url') {
    if (!hasUrl) {
      throw new SupportEvidenceError(400, 'invalid_input', 'URL source requires url and forbids inline content.');
    }
  } else {
    if (!hasContent) {
      throw new SupportEvidenceError(400, 'invalid_input', 'Non-URL source requires inline content and forbids url.');
    }
    if (options.format !== initialSource.kind) {
      throw new SupportEvidenceError(400, 'invalid_input', `Import format must match source kind "${initialSource.kind}".`);
    }
  }

  const startedAt = Date.now();
  const effectiveDeadlineMs = options.deadlineMs ?? SUPPORT_EVIDENCE_LIMITS.importDeadlineMs;

  let rawContent: string;
  if (hasUrl) {
    rawContent = await fetchSupportEvidenceExport({
      url: options.url!,
      format: options.format,
      signal: options.signal,
      fetchFn: options.fetchFn,
      dnsResolver: options.dnsResolver,
      deadlineMs: effectiveDeadlineMs,
    });
  } else {
    rawContent = options.content!;
  }

  const normalized = validateAndNormalizeImportInput({
    title: options.title,
    category: options.category,
    tags: options.tags,
    format: options.format,
    content: rawContent,
  });

  if (options.signal?.aborted || (hasUrl && Date.now() - startedAt > effectiveDeadlineMs)) {
    throw new SupportEvidenceError(504, 'import_timeout', 'Import timed out or was aborted before commit.');
  }

  const tx = db.transaction((): { source: SupportEvidenceSource; revision: SupportEvidenceRevision; deduplicated: boolean } => {
    if (options.signal?.aborted) {
      throw new SupportEvidenceError(504, 'import_timeout', 'Import was aborted before commit.');
    }
    const sourceRow = db
      .prepare('SELECT * FROM x_support_evidence_sources WHERE tenant_id = ? AND id = ?')
      .get(options.tenantId, options.sourceId) as SourceRow | undefined;
    if (!sourceRow) {
      throw new SupportEvidenceError(404, 'knowledge_source_not_found', 'Knowledge source not found.');
    }
    if (sourceRow.version !== expectedVer) {
      throw new SupportEvidenceError(409, 'source_conflict', 'Knowledge source version conflict.');
    }

    const dupRow = db
      .prepare(
        'SELECT * FROM x_support_evidence_revisions WHERE tenant_id = ? AND source_id = ? AND content_hash = ?',
      )
      .get(options.tenantId, options.sourceId, normalized.contentHash) as RevisionRow | undefined;
    if (dupRow) {
      return {
        source: sourceFromRow(sourceRow),
        revision: revisionFromRow(dupRow, false),
        deduplicated: true,
      };
    }

    if (sourceRow.revision_count >= SUPPORT_EVIDENCE_LIMITS.maxRevisionsPerSource) {
      throw new SupportEvidenceError(
        409,
        'evidence_capacity_exceeded',
        `Source has reached the maximum of ${SUPPORT_EVIDENCE_LIMITS.maxRevisionsPerSource} revisions.`,
      );
    }

    const revId = `rev_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const payloadEnc = encrypt(
      JSON.stringify({
        title: normalized.title,
        category: normalized.category,
        tags: normalized.tags,
        content: normalized.content,
      } satisfies RevisionPayload),
    );

    db.prepare(
      `INSERT INTO x_support_evidence_revisions
        (id, tenant_id, source_id, format, content_hash, chunk_count, payload_encrypted, payload_iv, payload_auth_tag, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      revId,
      options.tenantId,
      options.sourceId,
      normalized.format,
      normalized.contentHash,
      normalized.chunks.length,
      payloadEnc.encrypted,
      payloadEnc.iv,
      payloadEnc.authTag,
      now,
    );

    const insertChunk = db.prepare(
      `INSERT INTO x_support_evidence_chunks
        (id, tenant_id, source_id, revision_id, ordinal, start_line, end_line, content_hash, payload_encrypted, payload_iv, payload_auth_tag)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const chunk of normalized.chunks) {
      const chunkId = `chk_${crypto.randomUUID()}`;
      const chunkEnc = encrypt(
        JSON.stringify({
          ...(chunk.heading ? { heading: chunk.heading } : {}),
          text: chunk.text,
        }),
      );
      insertChunk.run(
        chunkId,
        options.tenantId,
        options.sourceId,
        revId,
        chunk.ordinal,
        chunk.startLine,
        chunk.endLine,
        chunk.contentHash,
        chunkEnc.encrypted,
        chunkEnc.iv,
        chunkEnc.authTag,
      );
    }

    const urlEnc = hasUrl ? encrypt(options.url!) : null;
    db.prepare(
      `UPDATE x_support_evidence_sources
          SET draft_revision_id = ?,
              revision_count = revision_count + 1,
              version = version + 1,
              import_url_encrypted = COALESCE(?, import_url_encrypted),
              import_url_iv = COALESCE(?, import_url_iv),
              import_url_auth_tag = COALESCE(?, import_url_auth_tag),
              updated_at = ?
        WHERE tenant_id = ? AND id = ? AND version = ?`,
    ).run(
      revId,
      urlEnc?.encrypted ?? null,
      urlEnc?.iv ?? null,
      urlEnc?.authTag ?? null,
      now,
      options.tenantId,
      options.sourceId,
      expectedVer,
    );

    const updatedSource = db
      .prepare('SELECT * FROM x_support_evidence_sources WHERE tenant_id = ? AND id = ?')
      .get(options.tenantId, options.sourceId) as SourceRow;
    const insertedRev = db
      .prepare('SELECT * FROM x_support_evidence_revisions WHERE tenant_id = ? AND id = ?')
      .get(options.tenantId, revId) as RevisionRow;

    return {
      source: sourceFromRow(updatedSource),
      revision: revisionFromRow(insertedRev, false),
      deduplicated: false,
    };
  });

  return tx();
}

export function listSupportEvidenceRevisions(tenantId: number, sourceId: string): SupportEvidenceRevision[] {
  assertPositiveTenantId(tenantId);
  if (typeof sourceId !== 'string' || !sourceId) {
    throw new SupportEvidenceError(400, 'invalid_input', 'sourceId is required.');
  }
  const db = ensureSupportEvidenceTables();
  const source = db
    .prepare('SELECT id FROM x_support_evidence_sources WHERE tenant_id = ? AND id = ?')
    .get(tenantId, sourceId);
  if (!source) {
    throw new SupportEvidenceError(404, 'knowledge_source_not_found', 'Knowledge source not found.');
  }

  const rows = db
    .prepare(
      'SELECT * FROM x_support_evidence_revisions WHERE tenant_id = ? AND source_id = ? ORDER BY created_at DESC, id ASC',
    )
    .all(tenantId, sourceId) as RevisionRow[];
  return rows.map((r) => revisionFromRow(r, false));
}

export function getSupportEvidenceRevision(
  tenantId: number,
  sourceId: string,
  revisionId: string,
): SupportEvidenceRevisionDetail {
  assertPositiveTenantId(tenantId);
  if (typeof sourceId !== 'string' || !sourceId || typeof revisionId !== 'string' || !revisionId) {
    throw new SupportEvidenceError(400, 'invalid_input', 'sourceId and revisionId are required.');
  }
  const db = ensureSupportEvidenceTables();
  const row = db
    .prepare('SELECT * FROM x_support_evidence_revisions WHERE tenant_id = ? AND source_id = ? AND id = ?')
    .get(tenantId, sourceId, revisionId) as RevisionRow | undefined;
  if (!row) {
    throw new SupportEvidenceError(404, 'knowledge_source_not_found', 'Knowledge revision not found.');
  }
  return revisionFromRow(row, true);
}

export function publishSupportEvidenceRevision(
  tenantId: number,
  sourceId: string,
  revisionId: string,
  expectedVersion: number,
): SupportEvidenceSource {
  assertPositiveTenantId(tenantId);
  if (typeof sourceId !== 'string' || !sourceId || typeof revisionId !== 'string' || !revisionId) {
    throw new SupportEvidenceError(400, 'invalid_input', 'sourceId and revisionId are required.');
  }
  const expectedVer = assertExpectedVersion(expectedVersion);

  const db = ensureSupportEvidenceTables();
  const tx = db.transaction((): SupportEvidenceSource => {
    const sourceRow = db
      .prepare('SELECT * FROM x_support_evidence_sources WHERE tenant_id = ? AND id = ?')
      .get(tenantId, sourceId) as SourceRow | undefined;
    if (!sourceRow) {
      throw new SupportEvidenceError(404, 'knowledge_source_not_found', 'Knowledge source not found.');
    }
    if (sourceRow.version !== expectedVer) {
      throw new SupportEvidenceError(409, 'source_conflict', 'Knowledge source version conflict.');
    }

    const revRow = db
      .prepare('SELECT chunk_count FROM x_support_evidence_revisions WHERE tenant_id = ? AND source_id = ? AND id = ?')
      .get(tenantId, sourceId, revisionId) as { chunk_count: number } | undefined;
    if (!revRow) {
      throw new SupportEvidenceError(404, 'knowledge_source_not_found', 'Knowledge revision not found.');
    }

    if (sourceRow.status === 'active') {
      const otherChunks = getPublishedChunkCount(db, tenantId, sourceId);
      if (otherChunks + revRow.chunk_count > SUPPORT_EVIDENCE_LIMITS.maxPublishedChunksPerTenant) {
        throw new SupportEvidenceError(
          409,
          'evidence_capacity_exceeded',
          `Publishing would exceed the ${SUPPORT_EVIDENCE_LIMITS.maxPublishedChunksPerTenant} live chunk limit.`,
        );
      }
    }

    const now = new Date().toISOString();
    db.prepare(
      `UPDATE x_support_evidence_sources
          SET published_revision_id = ?, version = version + 1, updated_at = ?
        WHERE tenant_id = ? AND id = ? AND version = ?`,
    ).run(revisionId, now, tenantId, sourceId, expectedVer);

    const updated = db
      .prepare('SELECT * FROM x_support_evidence_sources WHERE tenant_id = ? AND id = ?')
      .get(tenantId, sourceId) as SourceRow;
    return sourceFromRow(updated);
  });

  return tx();
}

// ---------------------------------------------------------------------------
// Published Chunks & Catalog (for Retrieval & Snapshots)
// ---------------------------------------------------------------------------

export interface PublishedSupportEvidenceChunkRecord {
  chunk: SupportEvidenceChunk;
  sourceName: string;
  title: string;
  category: string;
  tags: string[];
}

export interface SupportEvidenceCatalogEntry {
  sourceId: string;
  name: string;
  status: SupportEvidenceSourceStatus;
  allowedRoles: SupportEvidenceRole[];
  publishedRevisionId: string;
  contentHash: string;
}

export function getCurrentSupportEvidenceCatalog(
  tenantId: number,
  role: SupportEvidenceRole,
): SupportEvidenceCatalogEntry[] {
  assertPositiveTenantId(tenantId);
  if (!isSupportEvidenceRole(role)) {
    throw new SupportEvidenceError(403, 'unsupported_evidence_role', 'Unsupported support evidence role.');
  }
  const db = ensureSupportEvidenceTables();
  const rows = db
    .prepare(
      `SELECT s.id AS source_id, s.name, s.status, s.allowed_roles_json, s.published_revision_id, r.content_hash
         FROM x_support_evidence_sources s
         JOIN x_support_evidence_revisions r
           ON r.tenant_id = s.tenant_id AND r.source_id = s.id AND r.id = s.published_revision_id
        WHERE s.tenant_id = ?
          AND s.status = 'active'
          AND s.published_revision_id IS NOT NULL
        ORDER BY s.id ASC`,
    )
    .all(tenantId) as Array<{
      source_id: string;
      name: string;
      status: SupportEvidenceSourceStatus;
      allowed_roles_json: string;
      published_revision_id: string;
      content_hash: string;
    }>;

  const catalog: SupportEvidenceCatalogEntry[] = [];
  for (const row of rows) {
    const allowedRoles = normalizeAllowedRoles(
      parseJsonSafe<unknown>(row.allowed_roles_json, 'Stored source roles are corrupted.'),
      false,
    );
    if (!allowedRoles.includes(role)) continue;
    catalog.push({
      sourceId: row.source_id,
      name: row.name,
      status: row.status,
      allowedRoles,
      publishedRevisionId: row.published_revision_id,
      contentHash: row.content_hash,
    });
  }
  return catalog;
}

export function listPublishedSupportEvidenceChunks(
  tenantId: number,
  role: SupportEvidenceRole,
): PublishedSupportEvidenceChunkRecord[] {
  assertPositiveTenantId(tenantId);
  if (!isSupportEvidenceRole(role)) {
    throw new SupportEvidenceError(403, 'unsupported_evidence_role', 'Unsupported support evidence role.');
  }
  const db = ensureSupportEvidenceTables();
  const eligibleSources = db
    .prepare(
      `SELECT s.id AS source_id, s.name, s.allowed_roles_json, s.published_revision_id,
              r.chunk_count, r.payload_encrypted AS rev_enc, r.payload_iv AS rev_iv, r.payload_auth_tag AS rev_tag
         FROM x_support_evidence_sources s
         JOIN x_support_evidence_revisions r
           ON r.tenant_id = s.tenant_id AND r.source_id = s.id AND r.id = s.published_revision_id
        WHERE s.tenant_id = ?
          AND s.status = 'active'
          AND s.published_revision_id IS NOT NULL
        ORDER BY s.id ASC`,
    )
    .all(tenantId) as Array<{
      source_id: string;
      name: string;
      allowed_roles_json: string;
      published_revision_id: string;
      chunk_count: number;
      rev_enc: string;
      rev_iv: string;
      rev_tag: string;
    }>;

  const authorized: typeof eligibleSources = [];
  let totalChunks = 0;
  for (const s of eligibleSources) {
    const allowedRoles = normalizeAllowedRoles(
      parseJsonSafe<unknown>(s.allowed_roles_json, 'Stored source roles are corrupted.'),
      false,
    );
    if (!allowedRoles.includes(role)) continue;
    totalChunks += s.chunk_count;
    if (totalChunks > SUPPORT_EVIDENCE_LIMITS.maxPublishedChunksPerTenant) {
      throw new SupportEvidenceError(
        409,
        'evidence_capacity_exceeded',
        `Authorized published chunks exceed ${SUPPORT_EVIDENCE_LIMITS.maxPublishedChunksPerTenant} limit.`,
      );
    }
    authorized.push(s);
  }

  const results: PublishedSupportEvidenceChunkRecord[] = [];
  const selectChunks = db.prepare(
    `SELECT id, ordinal, start_line, end_line, content_hash, payload_encrypted, payload_iv, payload_auth_tag
       FROM x_support_evidence_chunks
      WHERE tenant_id = ? AND source_id = ? AND revision_id = ?
      ORDER BY ordinal ASC`,
  );

  for (const src of authorized) {
    const revPayload = decryptJsonSafe<RevisionPayload>(
      src.rev_enc,
      src.rev_iv,
      src.rev_tag,
      'Stored revision payload is corrupted.',
    );
    const chunkRows = selectChunks.all(tenantId, src.source_id, src.published_revision_id) as Array<{
      id: string;
      ordinal: number;
      start_line: number;
      end_line: number;
      content_hash: string;
      payload_encrypted: string;
      payload_iv: string;
      payload_auth_tag: string;
    }>;

    for (const c of chunkRows) {
      const chunkPayload = decryptJsonSafe<{ heading?: string; text: string }>(
        c.payload_encrypted,
        c.payload_iv,
        c.payload_auth_tag,
        'Stored chunk payload is corrupted.',
      );
      results.push({
        chunk: {
          id: c.id,
          tenantId,
          sourceId: src.source_id,
          revisionId: src.published_revision_id,
          ordinal: c.ordinal,
          ...(chunkPayload.heading ? { heading: chunkPayload.heading } : {}),
          startLine: c.start_line,
          endLine: c.end_line,
          text: chunkPayload.text,
          contentHash: c.content_hash,
        },
        sourceName: src.name,
        title: revPayload.title,
        category: revPayload.category,
        tags: revPayload.tags,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Evaluation Suites & Runs CRUD
// ---------------------------------------------------------------------------

const CASE_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

function validateEvaluationCases(db: Db, tenantId: number, rawCases: unknown): SupportEvidenceCase[] {
  if (!Array.isArray(rawCases) || rawCases.length < 1 || rawCases.length > SUPPORT_EVIDENCE_LIMITS.maxCasesPerSuite) {
    throw new SupportEvidenceError(
      400,
      'invalid_input',
      `Suite must contain 1..${SUPPORT_EVIDENCE_LIMITS.maxCasesPerSuite} cases.`,
    );
  }

  const tenantSources = new Set(
    (
      db.prepare('SELECT id FROM x_support_evidence_sources WHERE tenant_id = ?').all(tenantId) as Array<{
        id: string;
      }>
    ).map((r) => r.id),
  );
  const legacyDocIds = new Set(
    listSupportKnowledgeDocs(String(tenantId)).map((d) => `legacy:${d.id}`),
  );

  const seenIds = new Set<string>();
  const validated: SupportEvidenceCase[] = [];

  for (let i = 0; i < rawCases.length; i++) {
    const rec = assertKnownKeys(
      rawCases[i],
      ['id', 'query', 'role', 'expectedSourceIds', 'forbiddenSourceIds', 'expectAbstention'],
      `case[${i}]`,
    );
    if (typeof rec.id !== 'string' || !CASE_ID_RE.test(rec.id)) {
      throw new SupportEvidenceError(400, 'invalid_input', `case[${i}].id must match [A-Za-z0-9_-]{1,80}.`);
    }
    if (seenIds.has(rec.id)) {
      throw new SupportEvidenceError(400, 'invalid_input', `Duplicate case id "${rec.id}" in suite.`);
    }
    seenIds.add(rec.id);

    if (typeof rec.query !== 'string') {
      throw new SupportEvidenceError(400, 'invalid_input', `case[${i}].query must be a string.`);
    }
    const query = rec.query.normalize('NFC').trim();
    if (!query || query.length > SUPPORT_EVIDENCE_LIMITS.maxConsoleQueryChars) {
      throw new SupportEvidenceError(
        400,
        'invalid_input',
        `case[${i}].query must be 1..${SUPPORT_EVIDENCE_LIMITS.maxConsoleQueryChars} characters.`,
      );
    }

    if (!isSupportEvidenceRole(rec.role)) {
      throw new SupportEvidenceError(400, 'invalid_input', `case[${i}].role is invalid.`);
    }
    if (typeof rec.expectAbstention !== 'boolean') {
      throw new SupportEvidenceError(400, 'invalid_input', `case[${i}].expectAbstention must be a boolean.`);
    }

    if (
      !Array.isArray(rec.expectedSourceIds) ||
      rec.expectedSourceIds.length > SUPPORT_EVIDENCE_LIMITS.maxExpectedSourceIdsPerCase
    ) {
      throw new SupportEvidenceError(
        400,
        'invalid_input',
        `case[${i}].expectedSourceIds must be an array of at most ${SUPPORT_EVIDENCE_LIMITS.maxExpectedSourceIdsPerCase} items.`,
      );
    }
    if (
      !Array.isArray(rec.forbiddenSourceIds) ||
      rec.forbiddenSourceIds.length > SUPPORT_EVIDENCE_LIMITS.maxForbiddenSourceIdsPerCase
    ) {
      throw new SupportEvidenceError(
        400,
        'invalid_input',
        `case[${i}].forbiddenSourceIds must be an array of at most ${SUPPORT_EVIDENCE_LIMITS.maxForbiddenSourceIdsPerCase} items.`,
      );
    }

    const expectedSourceIds: string[] = [];
    for (const sid of rec.expectedSourceIds) {
      if (typeof sid !== 'string' || (!tenantSources.has(sid) && !legacyDocIds.has(sid))) {
        throw new SupportEvidenceError(
          400,
          'invalid_input',
          `case[${i}].expectedSourceIds contains a source ID not belonging to this tenant.`,
        );
      }
      if (!expectedSourceIds.includes(sid)) expectedSourceIds.push(sid);
    }

    const forbiddenSourceIds: string[] = [];
    for (const sid of rec.forbiddenSourceIds) {
      if (typeof sid !== 'string' || (!tenantSources.has(sid) && !legacyDocIds.has(sid))) {
        throw new SupportEvidenceError(
          400,
          'invalid_input',
          `case[${i}].forbiddenSourceIds contains a source ID not belonging to this tenant.`,
        );
      }
      if (expectedSourceIds.includes(sid)) {
        throw new SupportEvidenceError(
          400,
          'invalid_input',
          `case[${i}] expectedSourceIds and forbiddenSourceIds must be disjoint.`,
        );
      }
      if (!forbiddenSourceIds.includes(sid)) forbiddenSourceIds.push(sid);
    }

    if (expectedSourceIds.length === 0 && !rec.expectAbstention) {
      throw new SupportEvidenceError(
        400,
        'invalid_input',
        `case[${i}] empty expectedSourceIds is allowed only when expectAbstention is true.`,
      );
    }

    validated.push({
      id: rec.id,
      query,
      role: rec.role,
      expectedSourceIds,
      forbiddenSourceIds,
      expectAbstention: rec.expectAbstention,
    });
  }

  return validated;
}

interface SuiteRow {
  id: string;
  tenant_id: number;
  name: string;
  version: number;
  cases_encrypted: string;
  cases_iv: string;
  cases_auth_tag: string;
  created_at: string;
  updated_at: string;
}

function suiteFromRow(row: SuiteRow): SupportEvidenceSuite {
  const cases = decryptJsonSafe<SupportEvidenceCase[]>(
    row.cases_encrypted,
    row.cases_iv,
    row.cases_auth_tag,
    'Stored evaluation suite cases are corrupted.',
  );
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    version: row.version,
    cases,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function saveSupportEvidenceSuite(
  tenantId: number,
  input: { id?: string; name: string; cases: SupportEvidenceCase[] },
  expectedVersion?: number,
): SupportEvidenceSuite {
  const rec = assertKnownKeys(input, ['id', 'name', 'cases'], 'suite');
  assertPositiveTenantId(tenantId);

  if (typeof rec.name !== 'string') {
    throw new SupportEvidenceError(400, 'invalid_input', 'Suite name is required.');
  }
  const name = rec.name.normalize('NFC').trim();
  if (!name || name.length > SUPPORT_EVIDENCE_LIMITS.maxSourceNameChars) {
    throw new SupportEvidenceError(
      400,
      'invalid_input',
      `Suite name must be 1..${SUPPORT_EVIDENCE_LIMITS.maxSourceNameChars} characters.`,
    );
  }

  const isUpdate = rec.id !== undefined;
  if (isUpdate && (typeof rec.id !== 'string' || !rec.id)) {
    throw new SupportEvidenceError(400, 'invalid_input', 'Suite id must be a non-empty string.');
  }
  const expectedVer = isUpdate ? assertExpectedVersion(expectedVersion) : undefined;

  const db = ensureSupportEvidenceTables();
  const tx = db.transaction((): SupportEvidenceSuite => {
    assertTenantExists(db, tenantId);
    const validatedCases = validateEvaluationCases(db, tenantId, rec.cases);
    const enc = encrypt(JSON.stringify(validatedCases));
    const now = new Date().toISOString();

    if (isUpdate) {
      const suiteId = rec.id as string;
      const existing = db
        .prepare('SELECT * FROM x_support_evidence_suites WHERE tenant_id = ? AND id = ?')
        .get(tenantId, suiteId) as SuiteRow | undefined;
      if (!existing) {
        throw new SupportEvidenceError(404, 'knowledge_source_not_found', 'Evaluation suite not found.');
      }
      if (existing.version !== expectedVer) {
        throw new SupportEvidenceError(409, 'source_conflict', 'Evaluation suite version conflict.');
      }
      db.prepare(
        `UPDATE x_support_evidence_suites
            SET name = ?, version = version + 1, cases_encrypted = ?, cases_iv = ?, cases_auth_tag = ?, updated_at = ?
          WHERE tenant_id = ? AND id = ? AND version = ?`,
      ).run(name, enc.encrypted, enc.iv, enc.authTag, now, tenantId, suiteId, expectedVer);

      const updated = db
        .prepare('SELECT * FROM x_support_evidence_suites WHERE tenant_id = ? AND id = ?')
        .get(tenantId, suiteId) as SuiteRow;
      return suiteFromRow(updated);
    }

    const suiteId = `suite_${crypto.randomUUID()}`;
    db.prepare(
      `INSERT INTO x_support_evidence_suites
        (id, tenant_id, name, version, cases_encrypted, cases_iv, cases_auth_tag, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    ).run(suiteId, tenantId, name, enc.encrypted, enc.iv, enc.authTag, now, now);

    const created = db
      .prepare('SELECT * FROM x_support_evidence_suites WHERE tenant_id = ? AND id = ?')
      .get(tenantId, suiteId) as SuiteRow;
    return suiteFromRow(created);
  });

  return tx();
}

export function listSupportEvidenceSuites(tenantId: number): SupportEvidenceSuite[] {
  assertPositiveTenantId(tenantId);
  const db = ensureSupportEvidenceTables();
  const rows = db
    .prepare('SELECT * FROM x_support_evidence_suites WHERE tenant_id = ? ORDER BY updated_at DESC, id ASC')
    .all(tenantId) as SuiteRow[];
  return rows.map(suiteFromRow);
}

export function getSupportEvidenceSuite(tenantId: number, suiteId: string): SupportEvidenceSuite {
  assertPositiveTenantId(tenantId);
  if (typeof suiteId !== 'string' || !suiteId) {
    throw new SupportEvidenceError(400, 'invalid_input', 'suiteId is required.');
  }
  const db = ensureSupportEvidenceTables();
  const row = db
    .prepare('SELECT * FROM x_support_evidence_suites WHERE tenant_id = ? AND id = ?')
    .get(tenantId, suiteId) as SuiteRow | undefined;
  if (!row) {
    throw new SupportEvidenceError(404, 'knowledge_source_not_found', 'Evaluation suite not found.');
  }
  return suiteFromRow(row);
}

interface RunRow {
  id: string;
  tenant_id: number;
  suite_id: string;
  suite_version: number;
  status: 'completed' | 'partial' | 'failed';
  started_at: string;
  completed_at: string;
  report_encrypted: string;
  report_iv: string;
  report_auth_tag: string;
}

type RunReportPayload = Omit<
  SupportEvidenceRun,
  'id' | 'tenantId' | 'suiteId' | 'suiteVersion' | 'status' | 'startedAt' | 'completedAt'
>;

function runFromRow(row: RunRow): SupportEvidenceRun {
  const report = decryptJsonSafe<RunReportPayload>(
    row.report_encrypted,
    row.report_iv,
    row.report_auth_tag,
    'Stored evaluation run report is corrupted.',
  );
  return {
    id: row.id,
    tenantId: row.tenant_id,
    suiteId: row.suite_id,
    suiteVersion: row.suite_version,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    ...report,
  };
}

export function saveSupportEvidenceRun(
  tenantId: number,
  input: Omit<SupportEvidenceRun, 'id' | 'tenantId'>,
): SupportEvidenceRun {
  assertPositiveTenantId(tenantId);
  const db = ensureSupportEvidenceTables();
  const tx = db.transaction((): SupportEvidenceRun => {
    assertTenantExists(db, tenantId);
    const suite = db
      .prepare('SELECT id FROM x_support_evidence_suites WHERE tenant_id = ? AND id = ?')
      .get(tenantId, input.suiteId);
    if (!suite) {
      throw new SupportEvidenceError(404, 'knowledge_source_not_found', 'Evaluation suite not found.');
    }

    const id = `run_${crypto.randomUUID()}`;
    const reportPayload: RunReportPayload = {
      casesChecked: input.casesChecked,
      totalCases: input.totalCases,
      matchedExpectedCases: input.matchedExpectedCases,
      expectedCasesChecked: input.expectedCasesChecked,
      casesWithoutForbiddenHits: input.casesWithoutForbiddenHits,
      correctlyAbstainedCases: input.correctlyAbstainedCases,
      hitAtK: input.hitAtK,
      allPassed: input.allPassed,
      snapshotIds: input.snapshotIds,
      results: input.results,
    };
    const enc = encrypt(JSON.stringify(reportPayload));

    db.prepare(
      `INSERT INTO x_support_evidence_runs
        (id, tenant_id, suite_id, suite_version, status, started_at, completed_at, report_encrypted, report_iv, report_auth_tag)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      tenantId,
      input.suiteId,
      input.suiteVersion,
      input.status,
      input.startedAt,
      input.completedAt,
      enc.encrypted,
      enc.iv,
      enc.authTag,
    );

    const row = db
      .prepare('SELECT * FROM x_support_evidence_runs WHERE tenant_id = ? AND id = ?')
      .get(tenantId, id) as RunRow;
    return runFromRow(row);
  });

  return tx();
}

export function listSupportEvidenceRuns(tenantId: number): SupportEvidenceRun[] {
  assertPositiveTenantId(tenantId);
  const db = ensureSupportEvidenceTables();
  const rows = db
    .prepare(
      `SELECT * FROM x_support_evidence_runs
        WHERE tenant_id = ?
        ORDER BY completed_at DESC, id ASC
        LIMIT ?`,
    )
    .all(tenantId, SUPPORT_EVIDENCE_LIMITS.maxRunsListed) as RunRow[];
  return rows.map(runFromRow);
}

export function getSupportEvidenceRun(tenantId: number, runId: string): SupportEvidenceRun {
  assertPositiveTenantId(tenantId);
  if (typeof runId !== 'string' || !runId) {
    throw new SupportEvidenceError(400, 'invalid_input', 'runId is required.');
  }
  const db = ensureSupportEvidenceTables();
  const row = db
    .prepare('SELECT * FROM x_support_evidence_runs WHERE tenant_id = ? AND id = ?')
    .get(tenantId, runId) as RunRow | undefined;
  if (!row) {
    throw new SupportEvidenceError(404, 'knowledge_source_not_found', 'Evaluation run not found.');
  }
  return runFromRow(row);
}

// ---------------------------------------------------------------------------
// Durable Answer Evidence References (outlives 017 turn-cache TTL)
// ---------------------------------------------------------------------------

export interface SupportAnswerEvidenceRecord {
  id?: string;
  tenantId: number;
  userId: string;
  role: SupportEvidenceRole;
  requestId: string;
  turnId: string;
  conversationId?: string | null;
  customerMessageId?: string | null;
  assistantMessageId?: string | null;
  evidence: SupportAnswerEvidence;
  createdAt?: string;
  updatedAt?: string;
}

interface AnswerRow {
  id: string;
  tenant_id: number;
  user_id: string;
  role: SupportEvidenceRole;
  request_id: string;
  turn_id: string;
  conversation_id: string | null;
  customer_message_id: string | null;
  assistant_message_id: string | null;
  evidence_encrypted: string;
  evidence_iv: string;
  evidence_auth_tag: string;
  created_at: string;
  updated_at: string;
}

function answerFromRow(row: AnswerRow): SupportAnswerEvidenceRecord {
  const evidence = decryptJsonSafe<SupportAnswerEvidence>(
    row.evidence_encrypted,
    row.evidence_iv,
    row.evidence_auth_tag,
    'Stored answer evidence reference is corrupted.',
  );
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    role: row.role,
    requestId: row.request_id,
    turnId: row.turn_id,
    conversationId: row.conversation_id,
    customerMessageId: row.customer_message_id,
    assistantMessageId: row.assistant_message_id,
    evidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function saveSupportAnswerEvidence(record: SupportAnswerEvidenceRecord): SupportAnswerEvidenceRecord {
  assertPositiveTenantId(record.tenantId);
  if (!record.userId || !record.requestId || !record.turnId) {
    throw new SupportEvidenceError(400, 'invalid_input', 'userId, requestId, and turnId are required.');
  }
  if (!isSupportEvidenceRole(record.role)) {
    throw new SupportEvidenceError(403, 'unsupported_evidence_role', 'Unsupported support evidence role.');
  }

  const db = ensureSupportEvidenceTables();
  assertTenantExists(db, record.tenantId);

  const id = record.id ?? `ans_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const enc = encrypt(JSON.stringify(record.evidence));

  db.prepare(
    `INSERT INTO x_support_evidence_answers
      (id, tenant_id, user_id, role, request_id, turn_id, conversation_id, customer_message_id, assistant_message_id, evidence_encrypted, evidence_iv, evidence_auth_tag, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, user_id, turn_id) DO UPDATE SET
       conversation_id = COALESCE(excluded.conversation_id, x_support_evidence_answers.conversation_id),
       customer_message_id = COALESCE(excluded.customer_message_id, x_support_evidence_answers.customer_message_id),
       assistant_message_id = COALESCE(excluded.assistant_message_id, x_support_evidence_answers.assistant_message_id),
       evidence_encrypted = excluded.evidence_encrypted,
       evidence_iv = excluded.evidence_iv,
       evidence_auth_tag = excluded.evidence_auth_tag,
       updated_at = excluded.updated_at`,
  ).run(
    id,
    record.tenantId,
    record.userId,
    record.role,
    record.requestId,
    record.turnId,
    record.conversationId ?? null,
    record.customerMessageId ?? null,
    record.assistantMessageId ?? null,
    enc.encrypted,
    enc.iv,
    enc.authTag,
    record.createdAt ?? now,
    now,
  );

  const row = db
    .prepare('SELECT * FROM x_support_evidence_answers WHERE tenant_id = ? AND user_id = ? AND turn_id = ?')
    .get(record.tenantId, record.userId, record.turnId) as AnswerRow;
  return answerFromRow(row);
}

export function getSupportAnswerEvidence(
  tenantId: number,
  userId: string,
  turnId: string,
): SupportAnswerEvidenceRecord | null {
  assertPositiveTenantId(tenantId);
  if (!userId || !turnId) return null;
  const db = ensureSupportEvidenceTables();
  const row = db
    .prepare('SELECT * FROM x_support_evidence_answers WHERE tenant_id = ? AND user_id = ? AND turn_id = ?')
    .get(tenantId, userId, turnId) as AnswerRow | undefined;
  return row ? answerFromRow(row) : null;
}

export function getSupportMessageEvidence(
  tenantId: number,
  conversationId: string,
  messageId: string,
): SupportAnswerEvidenceRecord | null {
  assertPositiveTenantId(tenantId);
  if (!conversationId || !messageId) return null;
  const db = ensureSupportEvidenceTables();
  const row = db
    .prepare(
      `SELECT * FROM x_support_evidence_answers
        WHERE tenant_id = ? AND conversation_id = ?
          AND (assistant_message_id = ? OR customer_message_id = ?)
        LIMIT 1`,
    )
    .get(tenantId, conversationId, messageId, messageId) as AnswerRow | undefined;
  return row ? answerFromRow(row) : null;
}
