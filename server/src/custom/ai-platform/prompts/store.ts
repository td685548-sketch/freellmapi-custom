import crypto from 'node:crypto';
import {
  PROMPT_LIMITS,
  PROMPT_VAR_NAME_REGEX,
  type PromptDiffLine,
  type PromptDiffResponse,
  type PromptDiffStats,
  type PromptDraftInput,
  type PromptHead,
  type PromptScopeStateResponse,
  type PromptVariable,
  type PromptVersion,
  type PromptVersionStatus,
  type PromptVersionSummary,
} from '@freellmapi/shared/ai-platform-prompts.js';
import { getDb, type Db } from '../../../db/index.js';
import { normalizeScope, type Scope, type ScopeKind } from '../scope.js';
import { validateTemplate } from './template.js';

export class PromptStoreError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'PromptStoreError';
    this.code = code;
    this.status = status;
  }
}

export class RevisionConflictError extends PromptStoreError {
  readonly current: PromptScopeStateResponse;

  constructor(
    current: PromptScopeStateResponse,
    message = 'Prompt has been modified concurrently; reload the latest state.',
  ) {
    super(message, 'revision_conflict', 409);
    this.name = 'RevisionConflictError';
    this.current = current;
  }
}

export class PromptValidationError extends PromptStoreError {
  readonly line: number;
  readonly column: number;
  readonly reason: string;

  constructor(
    reason: string,
    line = 1,
    column = 1,
    message = `Invalid prompt template at line ${line}, column ${column}: ${reason}`,
  ) {
    super(message, 'invalid_template', 422);
    this.name = 'PromptValidationError';
    this.line = line;
    this.column = column;
    this.reason = reason;
  }
}

export class PromptNotFoundError extends PromptStoreError {
  constructor(message = 'Prompt version not found.') {
    super(message, 'not_found', 404);
    this.name = 'PromptNotFoundError';
  }
}

interface PromptVersionRow {
  id: number;
  scope_kind: ScopeKind;
  scope_id: string;
  version: number;
  body: string;
  variables_json: string;
  note: string;
  status: PromptVersionStatus;
  restored_from: number | null;
  author_id: number | null;
  created_at: string;
}

interface PromptHeadRow {
  scope_kind: ScopeKind;
  scope_id: string;
  published_version: number | null;
  draft_version: number | null;
  revision: number;
  ab_draft_weight_pct?: number;
}

const MAX_LCS_CELLS = 2_000_000;

function hasTable(db: Db, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
  );
}

function hasColumn(db: Db, table: string, column: string): boolean {
  if (!hasTable(db, table)) return false;
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(
    (c) => c.name === column,
  );
}

function normalizeAbWeight(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(100, Math.trunc(raw)));
}

function tryNormalizeScope(scope: Scope): Scope {
  try {
    return normalizeScope(scope);
  } catch (err) {
    throw new PromptStoreError(
      err instanceof Error ? err.message : 'Invalid scope.',
      'invalid_scope',
      400,
    );
  }
}

function parseVariablesJson(raw: string): PromptVariable[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: PromptVariable[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      if (typeof rec.name !== 'string') continue;
      if (rec.source !== 'system' && rec.source !== 'caller' && rec.source !== 'custom') continue;
      const variable: PromptVariable = { name: rec.name, source: rec.source };
      if (typeof rec.default === 'string') variable.default = rec.default;
      if (typeof rec.description === 'string') variable.description = rec.description;
      out.push(variable);
    }
    return out;
  } catch {
    return [];
  }
}

function toSummary(row: PromptVersionRow): PromptVersionSummary {
  return {
    id: row.id,
    scopeKind: row.scope_kind,
    scopeId: row.scope_id,
    version: row.version,
    variables: parseVariablesJson(row.variables_json),
    note: row.note,
    status: row.status,
    restoredFrom: row.restored_from,
    authorId: row.author_id,
    createdAt: row.created_at,
  };
}

function toVersion(row: PromptVersionRow): PromptVersion {
  return {
    ...toSummary(row),
    body: row.body,
  };
}

function ensureScopeInitialized(db: Db, norm: Scope): void {
  const hasHead = db
    .prepare('SELECT 1 FROM custom_ai_prompt_heads WHERE scope_kind = ? AND scope_id = ?')
    .get(norm.kind, norm.id);
  if (hasHead) return;

  const hasVersion = db
    .prepare(
      'SELECT 1 FROM custom_ai_prompt_versions WHERE scope_kind = ? AND scope_id = ? LIMIT 1',
    )
    .get(norm.kind, norm.id);
  if (hasVersion) return;

  let legacyRow: { system_prompt: string | null; created_at?: string; updated_at?: string } | undefined;
  if (norm.kind === 'profile' && hasTable(db, 'client_profiles')) {
    legacyRow = db
      .prepare('SELECT system_prompt, created_at, updated_at FROM client_profiles WHERE id = ?')
      .get(Number(norm.id)) as typeof legacyRow;
  } else if (norm.kind === 'support_tenant' && hasTable(db, 'x_support_tenants')) {
    legacyRow = db
      .prepare('SELECT system_prompt, created_at, updated_at FROM x_support_tenants WHERE id = ?')
      .get(Number(norm.id)) as typeof legacyRow;
  }

  if (!legacyRow || legacyRow.system_prompt === null || legacyRow.system_prompt.trim() === '') {
    return;
  }

  const body = legacyRow.system_prompt;
  const createdAt =
    legacyRow.updated_at?.trim() || legacyRow.created_at?.trim() || '2026-11-13 00:00:00';

  db.transaction(() => {
    db.prepare(
      `INSERT OR IGNORE INTO custom_ai_prompt_versions
         (scope_kind, scope_id, version, body, variables_json, note, status, restored_from, author_id, created_at)
       VALUES (?, ?, 1, ?, '[]', '', 'published', NULL, NULL, ?)`,
    ).run(norm.kind, norm.id, body, createdAt);

    db.prepare(
      `INSERT OR IGNORE INTO custom_ai_prompt_heads
         (scope_kind, scope_id, published_version, draft_version, revision)
       VALUES (?, ?, 1, NULL, 1)`,
    ).run(norm.kind, norm.id);
  })();
}

function readHeadRow(db: Db, norm: Scope): PromptHeadRow | undefined {
  const hasAb = hasColumn(db, 'custom_ai_prompt_heads', 'ab_draft_weight_pct');
  const cols = hasAb
    ? 'scope_kind, scope_id, published_version, draft_version, revision, ab_draft_weight_pct'
    : 'scope_kind, scope_id, published_version, draft_version, revision';
  return db
    .prepare(`SELECT ${cols} FROM custom_ai_prompt_heads WHERE scope_kind = ? AND scope_id = ?`)
    .get(norm.kind, norm.id) as PromptHeadRow | undefined;
}

function buildScopeState(db: Db, norm: Scope): PromptScopeStateResponse {
  const headRow = readHeadRow(db, norm);
  const rows = db
    .prepare(
      'SELECT * FROM custom_ai_prompt_versions WHERE scope_kind = ? AND scope_id = ? ORDER BY version DESC',
    )
    .all(norm.kind, norm.id) as PromptVersionRow[];

  const publishedRow =
    headRow?.published_version != null
      ? rows.find((r) => r.version === headRow.published_version)
      : rows.find((r) => r.status === 'published');
  const draftRow =
    headRow?.draft_version != null
      ? rows.find((r) => r.version === headRow.draft_version)
      : rows.find((r) => r.status === 'draft');

  const draftVersion = headRow?.draft_version ?? draftRow?.version ?? null;
  const head: PromptHead = {
    scopeKind: norm.kind,
    scopeId: norm.id,
    publishedVersion: headRow?.published_version ?? publishedRow?.version ?? null,
    draftVersion,
    revision: headRow?.revision ?? 1,
    abDraftWeightPct: draftVersion !== null ? normalizeAbWeight(headRow?.ab_draft_weight_pct) : 0,
  };

  // Version numbers are strictly monotonic per scope and pruning only deletes
  // the oldest archived rows (never the newest), so maxVersion - rows.length
  // yields the exact count of pruned versions without an extra DB column.
  const maxVersion = Math.max(
    rows[0]?.version ?? 0,
    head.publishedVersion ?? 0,
    head.draftVersion ?? 0,
  );
  const prunedCount = Math.max(0, maxVersion - rows.length);

  return {
    scope: norm,
    head,
    published: publishedRow ? toVersion(publishedRow) : null,
    draft: draftRow ? toVersion(draftRow) : null,
    versions: rows.map(toSummary),
    prunedCount,
  };
}

function syncUnderlyingSystemPrompt(db: Db, norm: Scope, body: string): void {
  if (norm.kind === 'profile' && hasTable(db, 'client_profiles')) {
    db.prepare(
      "UPDATE client_profiles SET system_prompt = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(body, Number(norm.id));
  } else if (norm.kind === 'support_tenant' && hasTable(db, 'x_support_tenants')) {
    db.prepare('UPDATE x_support_tenants SET system_prompt = ?, updated_at = ? WHERE id = ?').run(
      body,
      new Date().toISOString(),
      Number(norm.id),
    );
  }
}

function pruneOldVersions(db: Db, norm: Scope): void {
  const countRow = db
    .prepare(
      'SELECT COUNT(*) AS cnt FROM custom_ai_prompt_versions WHERE scope_kind = ? AND scope_id = ?',
    )
    .get(norm.kind, norm.id) as { cnt: number };

  const excess = countRow.cnt - PROMPT_LIMITS.maxRetainedVersions;
  if (excess <= 0) return;

  db.prepare(
    `DELETE FROM custom_ai_prompt_versions
      WHERE id IN (
        SELECT id
          FROM custom_ai_prompt_versions
         WHERE scope_kind = ? AND scope_id = ? AND status = 'archived'
         ORDER BY version ASC
         LIMIT ?
      )`,
  ).run(norm.kind, norm.id, excess);
}

function assertRevisionMatches(db: Db, norm: Scope, expectedRevision: number, actualRevision: number): void {
  if (expectedRevision !== actualRevision) {
    throw new RevisionConflictError(buildScopeState(db, norm));
  }
}

function validateVariablesInput(raw: unknown): PromptVariable[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new PromptValidationError('Variables must be an array.', 1, 1);
  }
  const seen = new Set<string>();
  const out: PromptVariable[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      throw new PromptValidationError('Each variable declaration must be an object.', 1, 1);
    }
    const rec = item as Record<string, unknown>;
    if (typeof rec.name !== 'string' || !PROMPT_VAR_NAME_REGEX.test(rec.name)) {
      throw new PromptValidationError(
        `Invalid variable name '${String(rec.name ?? '')}'. Must match ${PROMPT_VAR_NAME_REGEX.source}.`,
        1,
        1,
      );
    }
    if (seen.has(rec.name)) {
      throw new PromptValidationError(`Duplicate variable declaration '${rec.name}'.`, 1, 1);
    }
    seen.add(rec.name);
    if (rec.source !== 'system' && rec.source !== 'caller' && rec.source !== 'custom') {
      throw new PromptValidationError(
        `Invalid variable source '${String(rec.source ?? '')}' for '${rec.name}'.`,
        1,
        1,
      );
    }
    if (rec.default !== undefined && typeof rec.default !== 'string') {
      throw new PromptValidationError(`Variable '${rec.name}' default must be a string.`, 1, 1);
    }
    if (rec.description !== undefined && typeof rec.description !== 'string') {
      throw new PromptValidationError(
        `Variable '${rec.name}' description must be a string.`,
        1,
        1,
      );
    }
    const variable: PromptVariable = { name: rec.name, source: rec.source };
    if (rec.default !== undefined) variable.default = rec.default;
    if (rec.description !== undefined) variable.description = rec.description;
    out.push(variable);
  }
  return out;
}

function validateDraftInput(input: PromptDraftInput): {
  body: string;
  variables: PromptVariable[];
  note: string;
  revision: number;
} {
  if (!input || typeof input !== 'object') {
    throw new PromptValidationError('Draft payload is required.', 1, 1);
  }
  if (typeof input.body !== 'string') {
    throw new PromptValidationError('Prompt body must be a string.', 1, 1);
  }
  if (input.body.length > PROMPT_LIMITS.maxBodyChars) {
    throw new PromptValidationError(
      `Prompt body exceeds ${PROMPT_LIMITS.maxBodyChars} characters.`,
      1,
      1,
    );
  }
  const note = input.note ?? '';
  if (typeof note !== 'string') {
    throw new PromptValidationError('Note must be a string.', 1, 1);
  }
  if (note.length > PROMPT_LIMITS.maxNoteChars) {
    throw new PromptValidationError(
      `Note exceeds ${PROMPT_LIMITS.maxNoteChars} characters.`,
      1,
      1,
    );
  }
  if (typeof input.revision !== 'number' || !Number.isInteger(input.revision)) {
    throw new PromptStoreError('Revision must be an integer.', 'invalid_revision', 400);
  }
  const variables = validateVariablesInput(input.variables);

  const check = validateTemplate(input.body, variables);
  if (!check.ok) {
    throw new PromptValidationError(check.reason, check.line, check.column);
  }

  return { body: input.body, variables, note, revision: input.revision };
}

function splitLines(body: string): string[] {
  if (body === '') return [];
  return body.replace(/\r\n/g, '\n').split('\n');
}

function computeLineDiff(oldBody: string, newBody: string): { hunks: PromptDiffLine[]; stats: PromptDiffStats } {
  const oldLines = splitLines(oldBody);
  const newLines = splitLines(newBody);

  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix++;
  }

  let oldEnd = oldLines.length - 1;
  let newEnd = newLines.length - 1;
  while (oldEnd >= prefix && newEnd >= prefix && oldLines[oldEnd] === newLines[newEnd]) {
    oldEnd--;
    newEnd--;
  }

  const hunks: PromptDiffLine[] = [];
  for (let i = 0; i < prefix; i++) {
    hunks.push({
      type: 'same',
      text: oldLines[i]!,
      oldLineNumber: i + 1,
      newLineNumber: i + 1,
    });
  }

  const a = oldLines.slice(prefix, oldEnd + 1);
  const b = newLines.slice(prefix, newEnd + 1);
  const m = a.length;
  const n = b.length;

  if (m === 0 && n === 0) {
    // Identical bodies
  } else if (m * n > MAX_LCS_CELLS) {
    for (let i = 0; i < m; i++) {
      hunks.push({
        type: 'remove',
        text: a[i]!,
        oldLineNumber: prefix + i + 1,
        newLineNumber: null,
      });
    }
    for (let j = 0; j < n; j++) {
      hunks.push({
        type: 'add',
        text: b[j]!,
        oldLineNumber: null,
        newLineNumber: prefix + j + 1,
      });
    }
  } else {
    const cols = n + 1;
    const dp = new Int32Array((m + 1) * cols);
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        if (a[i] === b[j]) {
          dp[i * cols + j] = dp[(i + 1) * cols + (j + 1)]! + 1;
        } else {
          const down = dp[(i + 1) * cols + j]!;
          const right = dp[i * cols + (j + 1)]!;
          dp[i * cols + j] = down >= right ? down : right;
        }
      }
    }

    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (a[i] === b[j]) {
        hunks.push({
          type: 'same',
          text: a[i]!,
          oldLineNumber: prefix + i + 1,
          newLineNumber: prefix + j + 1,
        });
        i++;
        j++;
      } else if (dp[(i + 1) * cols + j]! >= dp[i * cols + (j + 1)]!) {
        hunks.push({
          type: 'remove',
          text: a[i]!,
          oldLineNumber: prefix + i + 1,
          newLineNumber: null,
        });
        i++;
      } else {
        hunks.push({
          type: 'add',
          text: b[j]!,
          oldLineNumber: null,
          newLineNumber: prefix + j + 1,
        });
        j++;
      }
    }
    while (i < m) {
      hunks.push({
        type: 'remove',
        text: a[i]!,
        oldLineNumber: prefix + i + 1,
        newLineNumber: null,
      });
      i++;
    }
    while (j < n) {
      hunks.push({
        type: 'add',
        text: b[j]!,
        oldLineNumber: null,
        newLineNumber: prefix + j + 1,
      });
      j++;
    }
  }

  const suffixCount = oldLines.length - 1 - oldEnd;
  for (let s = 0; s < suffixCount; s++) {
    const oldIdx = oldEnd + 1 + s;
    const newIdx = newEnd + 1 + s;
    hunks.push({
      type: 'same',
      text: oldLines[oldIdx]!,
      oldLineNumber: oldIdx + 1,
      newLineNumber: newIdx + 1,
    });
  }

  let added = 0;
  let removed = 0;
  let unchanged = 0;
  for (const line of hunks) {
    if (line.type === 'add') added++;
    else if (line.type === 'remove') removed++;
    else unchanged++;
  }

  return { hunks, stats: { added, removed, unchanged } };
}

export function getPromptScopeState(scope: Scope): PromptScopeStateResponse {
  const norm = tryNormalizeScope(scope);
  const db = getDb();
  ensureScopeInitialized(db, norm);
  return buildScopeState(db, norm);
}

export function getPromptVersion(scope: Scope, version: number): PromptVersion {
  const norm = tryNormalizeScope(scope);
  if (!Number.isInteger(version) || version < 1) {
    throw new PromptNotFoundError(`Prompt version ${version} not found.`);
  }
  const db = getDb();
  ensureScopeInitialized(db, norm);
  const row = db
    .prepare(
      'SELECT * FROM custom_ai_prompt_versions WHERE scope_kind = ? AND scope_id = ? AND version = ?',
    )
    .get(norm.kind, norm.id, version) as PromptVersionRow | undefined;
  if (!row) {
    throw new PromptNotFoundError(`Prompt version ${version} not found.`);
  }
  return toVersion(row);
}

export function getPublishedPrompt(
  scope: Scope,
): { version: number; body: string; variables: PromptVariable[] } | null {
  const norm = tryNormalizeScope(scope);
  const db = getDb();
  if (!hasTable(db, 'custom_ai_prompt_versions')) return null;
  ensureScopeInitialized(db, norm);

  const row = db
    .prepare(
      `SELECT version, body, variables_json
         FROM custom_ai_prompt_versions
        WHERE scope_kind = ? AND scope_id = ? AND status = 'published'
        LIMIT 1`,
    )
    .get(norm.kind, norm.id) as { version: number; body: string; variables_json: string } | undefined;

  if (!row) return null;
  return {
    version: row.version,
    body: row.body,
    variables: parseVariablesJson(row.variables_json),
  };
}

export function saveDraft(
  scope: Scope,
  input: PromptDraftInput,
  actorId: number | null,
): PromptVersion {
  const norm = tryNormalizeScope(scope);
  const validated = validateDraftInput(input);
  const db = getDb();

  return db.transaction(() => {
    ensureScopeInitialized(db, norm);
    const headRow = readHeadRow(db, norm);
    const currentRevision = headRow?.revision ?? 1;
    assertRevisionMatches(db, norm, validated.revision, currentRevision);

    const maxRow = db
      .prepare(
        'SELECT COALESCE(MAX(version), 0) AS max_ver FROM custom_ai_prompt_versions WHERE scope_kind = ? AND scope_id = ?',
      )
      .get(norm.kind, norm.id) as { max_ver: number };
    const nextVersion =
      Math.max(maxRow.max_ver, headRow?.published_version ?? 0, headRow?.draft_version ?? 0) + 1;

    db.prepare(
      `UPDATE custom_ai_prompt_versions
          SET status = 'archived'
        WHERE scope_kind = ? AND scope_id = ? AND status = 'draft'`,
    ).run(norm.kind, norm.id);

    const variablesJson = JSON.stringify(validated.variables);
    const info = db
      .prepare(
        `INSERT INTO custom_ai_prompt_versions
           (scope_kind, scope_id, version, body, variables_json, note, status, restored_from, author_id)
         VALUES (?, ?, ?, ?, ?, ?, 'draft', NULL, ?)`,
      )
      .run(norm.kind, norm.id, nextVersion, validated.body, variablesJson, validated.note, actorId);

    db.prepare(
      `INSERT INTO custom_ai_prompt_heads
         (scope_kind, scope_id, published_version, draft_version, revision)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(scope_kind, scope_id) DO UPDATE SET
         draft_version = excluded.draft_version,
         revision = excluded.revision`,
    ).run(norm.kind, norm.id, headRow?.published_version ?? null, nextVersion, currentRevision + 1);

    pruneOldVersions(db, norm);

    const created = db
      .prepare('SELECT * FROM custom_ai_prompt_versions WHERE id = ?')
      .get(Number(info.lastInsertRowid)) as PromptVersionRow;
    return toVersion(created);
  })();
}

export function discardDraft(scope: Scope, revision?: number): PromptHead {
  const norm = tryNormalizeScope(scope);
  if (revision !== undefined && (typeof revision !== 'number' || !Number.isInteger(revision))) {
    throw new PromptStoreError('Revision must be an integer.', 'invalid_revision', 400);
  }
  const db = getDb();

  return db.transaction(() => {
    ensureScopeInitialized(db, norm);
    const headRow = readHeadRow(db, norm);
    const currentRevision = headRow?.revision ?? 1;
    if (revision !== undefined) {
      assertRevisionMatches(db, norm, revision, currentRevision);
    }

    const updated = db
      .prepare(
        `UPDATE custom_ai_prompt_versions
            SET status = 'archived'
          WHERE scope_kind = ? AND scope_id = ? AND status = 'draft'`,
      )
      .run(norm.kind, norm.id);

    const hasAb = hasColumn(db, 'custom_ai_prompt_heads', 'ab_draft_weight_pct');
    const hasDraft = (headRow?.draft_version ?? null) !== null || updated.changes > 0;
    const hasActiveAb = normalizeAbWeight(headRow?.ab_draft_weight_pct) > 0;
    if (!hasDraft && !hasActiveAb) {
      return {
        scopeKind: norm.kind,
        scopeId: norm.id,
        publishedVersion: headRow?.published_version ?? null,
        draftVersion: null,
        revision: currentRevision,
        abDraftWeightPct: 0,
      };
    }

    const nextRevision = currentRevision + 1;
    if (hasAb) {
      db.prepare(
        `INSERT INTO custom_ai_prompt_heads
           (scope_kind, scope_id, published_version, draft_version, revision, ab_draft_weight_pct)
         VALUES (?, ?, ?, NULL, ?, 0)
         ON CONFLICT(scope_kind, scope_id) DO UPDATE SET
           draft_version = NULL,
           revision = excluded.revision,
           ab_draft_weight_pct = 0`,
      ).run(norm.kind, norm.id, headRow?.published_version ?? null, nextRevision);
    } else {
      db.prepare(
        `INSERT INTO custom_ai_prompt_heads
           (scope_kind, scope_id, published_version, draft_version, revision)
         VALUES (?, ?, ?, NULL, ?)
         ON CONFLICT(scope_kind, scope_id) DO UPDATE SET
           draft_version = NULL,
           revision = excluded.revision`,
      ).run(norm.kind, norm.id, headRow?.published_version ?? null, nextRevision);
    }

    return {
      scopeKind: norm.kind,
      scopeId: norm.id,
      publishedVersion: headRow?.published_version ?? null,
      draftVersion: null,
      revision: nextRevision,
      abDraftWeightPct: 0,
    };
  })();
}

export function publish(scope: Scope, revision: number, _actorId: number | null): PromptHead {
  const norm = tryNormalizeScope(scope);
  if (typeof revision !== 'number' || !Number.isInteger(revision)) {
    throw new PromptStoreError('Revision must be an integer.', 'invalid_revision', 400);
  }
  const db = getDb();

  return db.transaction(() => {
    ensureScopeInitialized(db, norm);
    const headRow = readHeadRow(db, norm);
    const currentRevision = headRow?.revision ?? 1;
    assertRevisionMatches(db, norm, revision, currentRevision);

    const draftRow = db
      .prepare(
        `SELECT * FROM custom_ai_prompt_versions
          WHERE scope_kind = ? AND scope_id = ? AND status = 'draft'
          ORDER BY version DESC
          LIMIT 1`,
      )
      .get(norm.kind, norm.id) as PromptVersionRow | undefined;

    if (!draftRow) {
      throw new PromptStoreError('No draft version exists to publish.', 'no_draft', 409);
    }

    db.prepare(
      `UPDATE custom_ai_prompt_versions
          SET status = 'archived'
        WHERE scope_kind = ? AND scope_id = ? AND status = 'published'`,
    ).run(norm.kind, norm.id);

    db.prepare("UPDATE custom_ai_prompt_versions SET status = 'published' WHERE id = ?").run(
      draftRow.id,
    );

    const nextRevision = currentRevision + 1;
    const hasAb = hasColumn(db, 'custom_ai_prompt_heads', 'ab_draft_weight_pct');
    if (hasAb) {
      db.prepare(
        `INSERT INTO custom_ai_prompt_heads
           (scope_kind, scope_id, published_version, draft_version, revision, ab_draft_weight_pct)
         VALUES (?, ?, ?, NULL, ?, 0)
         ON CONFLICT(scope_kind, scope_id) DO UPDATE SET
           published_version = excluded.published_version,
           draft_version = NULL,
           revision = excluded.revision,
           ab_draft_weight_pct = 0`,
      ).run(norm.kind, norm.id, draftRow.version, nextRevision);
    } else {
      db.prepare(
        `INSERT INTO custom_ai_prompt_heads
           (scope_kind, scope_id, published_version, draft_version, revision)
         VALUES (?, ?, ?, NULL, ?)
         ON CONFLICT(scope_kind, scope_id) DO UPDATE SET
           published_version = excluded.published_version,
           draft_version = NULL,
           revision = excluded.revision`,
      ).run(norm.kind, norm.id, draftRow.version, nextRevision);
    }

    syncUnderlyingSystemPrompt(db, norm, draftRow.body);
    pruneOldVersions(db, norm);

    return {
      scopeKind: norm.kind,
      scopeId: norm.id,
      publishedVersion: draftRow.version,
      draftVersion: null,
      revision: nextRevision,
      abDraftWeightPct: 0,
    };
  })();
}

export function restore(
  scope: Scope,
  version: number,
  revision: number,
  actorId: number | null,
): PromptHead {
  const norm = tryNormalizeScope(scope);
  if (typeof revision !== 'number' || !Number.isInteger(revision)) {
    throw new PromptStoreError('Revision must be an integer.', 'invalid_revision', 400);
  }
  if (!Number.isInteger(version) || version < 1) {
    throw new PromptNotFoundError(`Prompt version ${version} not found.`);
  }
  const db = getDb();

  return db.transaction(() => {
    ensureScopeInitialized(db, norm);
    const headRow = readHeadRow(db, norm);
    const currentRevision = headRow?.revision ?? 1;
    assertRevisionMatches(db, norm, revision, currentRevision);

    const targetRow = db
      .prepare(
        'SELECT * FROM custom_ai_prompt_versions WHERE scope_kind = ? AND scope_id = ? AND version = ?',
      )
      .get(norm.kind, norm.id, version) as PromptVersionRow | undefined;

    if (!targetRow) {
      throw new PromptNotFoundError(`Prompt version ${version} not found.`);
    }

    const maxRow = db
      .prepare(
        'SELECT COALESCE(MAX(version), 0) AS max_ver FROM custom_ai_prompt_versions WHERE scope_kind = ? AND scope_id = ?',
      )
      .get(norm.kind, norm.id) as { max_ver: number };
    const nextVersion =
      Math.max(maxRow.max_ver, headRow?.published_version ?? 0, headRow?.draft_version ?? 0) + 1;

    db.prepare(
      `UPDATE custom_ai_prompt_versions
          SET status = 'archived'
        WHERE scope_kind = ? AND scope_id = ? AND status = 'published'`,
    ).run(norm.kind, norm.id);

    db.prepare(
      `INSERT INTO custom_ai_prompt_versions
         (scope_kind, scope_id, version, body, variables_json, note, status, restored_from, author_id)
       VALUES (?, ?, ?, ?, ?, ?, 'published', ?, ?)`,
    ).run(
      norm.kind,
      norm.id,
      nextVersion,
      targetRow.body,
      targetRow.variables_json,
      targetRow.note,
      version,
      actorId,
    );

    const nextRevision = currentRevision + 1;
    const draftVersion = headRow?.draft_version ?? null;
    db.prepare(
      `INSERT INTO custom_ai_prompt_heads
         (scope_kind, scope_id, published_version, draft_version, revision)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(scope_kind, scope_id) DO UPDATE SET
         published_version = excluded.published_version,
         revision = excluded.revision`,
    ).run(norm.kind, norm.id, nextVersion, draftVersion, nextRevision);

    syncUnderlyingSystemPrompt(db, norm, targetRow.body);
    pruneOldVersions(db, norm);

    return {
      scopeKind: norm.kind,
      scopeId: norm.id,
      publishedVersion: nextVersion,
      draftVersion,
      revision: nextRevision,
      abDraftWeightPct:
        draftVersion !== null ? normalizeAbWeight(headRow?.ab_draft_weight_pct) : 0,
    };
  })();
}

export function diffPromptVersions(
  scope: Scope,
  fromVersion: number,
  toVersion: number,
): PromptDiffResponse {
  const norm = tryNormalizeScope(scope);
  if (!Number.isInteger(fromVersion) || fromVersion < 1) {
    throw new PromptNotFoundError(`Prompt version ${fromVersion} not found.`);
  }
  if (!Number.isInteger(toVersion) || toVersion < 1) {
    throw new PromptNotFoundError(`Prompt version ${toVersion} not found.`);
  }
  const db = getDb();
  ensureScopeInitialized(db, norm);

  const fromRow = db
    .prepare(
      'SELECT * FROM custom_ai_prompt_versions WHERE scope_kind = ? AND scope_id = ? AND version = ?',
    )
    .get(norm.kind, norm.id, fromVersion) as PromptVersionRow | undefined;
  if (!fromRow) {
    throw new PromptNotFoundError(`Prompt version ${fromVersion} not found.`);
  }

  const toRow = db
    .prepare(
      'SELECT * FROM custom_ai_prompt_versions WHERE scope_kind = ? AND scope_id = ? AND version = ?',
    )
    .get(norm.kind, norm.id, toVersion) as PromptVersionRow | undefined;
  if (!toRow) {
    throw new PromptNotFoundError(`Prompt version ${toVersion} not found.`);
  }

  const { hunks, stats } = computeLineDiff(fromRow.body, toRow.body);
  return {
    from: toSummary(fromRow),
    to: toSummary(toRow),
    hunks,
    stats,
  };
}

export interface ActivePromptVariant {
  variant: 'published' | 'draft';
  version: number;
  body: string;
  variables: PromptVariable[];
  abDraftWeightPct: number;
}

export function getDraftPrompt(
  scope: Scope,
): { version: number; body: string; variables: PromptVariable[] } | null {
  const norm = tryNormalizeScope(scope);
  const db = getDb();
  if (!hasTable(db, 'custom_ai_prompt_versions')) return null;
  ensureScopeInitialized(db, norm);

  const row = db
    .prepare(
      `SELECT version, body, variables_json
         FROM custom_ai_prompt_versions
        WHERE scope_kind = ? AND scope_id = ? AND status = 'draft'
        ORDER BY version DESC
        LIMIT 1`,
    )
    .get(norm.kind, norm.id) as { version: number; body: string; variables_json: string } | undefined;

  if (!row) return null;
  return {
    version: row.version,
    body: row.body,
    variables: parseVariablesJson(row.variables_json),
  };
}

export function setPromptAbSplit(
  scope: Scope,
  abDraftWeightPct: number,
  revision: number,
): PromptHead {
  const norm = tryNormalizeScope(scope);
  if (typeof revision !== 'number' || !Number.isInteger(revision)) {
    throw new PromptStoreError('Revision must be an integer.', 'invalid_revision', 400);
  }
  if (
    typeof abDraftWeightPct !== 'number' ||
    !Number.isInteger(abDraftWeightPct) ||
    abDraftWeightPct < 0 ||
    abDraftWeightPct > 100
  ) {
    throw new PromptStoreError(
      'Draft traffic percentage must be an integer between 0 and 100.',
      'invalid_ab_weight',
      400,
    );
  }

  const db = getDb();
  if (!hasColumn(db, 'custom_ai_prompt_heads', 'ab_draft_weight_pct')) {
    throw new PromptStoreError(
      'Prompt A/B rollout requires database migration 20261118_100000.',
      'migration_required',
      500,
    );
  }

  return db.transaction(() => {
    ensureScopeInitialized(db, norm);
    const headRow = readHeadRow(db, norm);
    const currentRevision = headRow?.revision ?? 1;
    assertRevisionMatches(db, norm, revision, currentRevision);

    const draftRow = db
      .prepare(
        `SELECT version FROM custom_ai_prompt_versions
          WHERE scope_kind = ? AND scope_id = ? AND status = 'draft'
          ORDER BY version DESC
          LIMIT 1`,
      )
      .get(norm.kind, norm.id) as { version: number } | undefined;

    if (abDraftWeightPct > 0 && !draftRow) {
      throw new PromptStoreError(
        'Save a draft version before routing A/B traffic to it.',
        'no_draft',
        409,
      );
    }

    const nextRevision = currentRevision + 1;
    const draftVersion = draftRow?.version ?? headRow?.draft_version ?? null;
    const publishedVersion = headRow?.published_version ?? null;

    db.prepare(
      `INSERT INTO custom_ai_prompt_heads
         (scope_kind, scope_id, published_version, draft_version, revision, ab_draft_weight_pct)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope_kind, scope_id) DO UPDATE SET
         ab_draft_weight_pct = excluded.ab_draft_weight_pct,
         revision = excluded.revision`,
    ).run(norm.kind, norm.id, publishedVersion, draftVersion, nextRevision, abDraftWeightPct);

    return {
      scopeKind: norm.kind,
      scopeId: norm.id,
      publishedVersion,
      draftVersion,
      revision: nextRevision,
      abDraftWeightPct,
    };
  })();
}

function pickAbBucket(norm: Scope, stickySeed?: string | null): number {
  const trimmed = stickySeed?.trim();
  if (trimmed) {
    const digest = crypto
      .createHash('sha256')
      .update(`${norm.kind}:${norm.id}:${trimmed}`)
      .digest();
    return digest.readUInt32BE(0) % 100;
  }
  return crypto.randomInt(0, 100);
}

export function resolveActivePromptVariant(
  scope: Scope,
  stickySeed?: string | null,
): ActivePromptVariant | null {
  const norm = tryNormalizeScope(scope);
  const db = getDb();
  if (!hasTable(db, 'custom_ai_prompt_versions')) return null;
  ensureScopeInitialized(db, norm);

  const headRow = readHeadRow(db, norm);
  const abWeight = normalizeAbWeight(headRow?.ab_draft_weight_pct);

  if (abWeight > 0) {
    const draftRow = db
      .prepare(
        `SELECT version, body, variables_json
           FROM custom_ai_prompt_versions
          WHERE scope_kind = ? AND scope_id = ? AND status = 'draft'
          ORDER BY version DESC
          LIMIT 1`,
      )
      .get(norm.kind, norm.id) as
      | { version: number; body: string; variables_json: string }
      | undefined;

    if (draftRow && (abWeight === 100 || pickAbBucket(norm, stickySeed) < abWeight)) {
      return {
        variant: 'draft',
        version: draftRow.version,
        body: draftRow.body,
        variables: parseVariablesJson(draftRow.variables_json),
        abDraftWeightPct: abWeight,
      };
    }
  }

  const publishedRow = db
    .prepare(
      `SELECT version, body, variables_json
         FROM custom_ai_prompt_versions
        WHERE scope_kind = ? AND scope_id = ? AND status = 'published'
        LIMIT 1`,
    )
    .get(norm.kind, norm.id) as
    | { version: number; body: string; variables_json: string }
    | undefined;

  if (!publishedRow) return null;
  return {
    variant: 'published',
    version: publishedRow.version,
    body: publishedRow.body,
    variables: parseVariablesJson(publishedRow.variables_json),
    abDraftWeightPct: abWeight,
  };
}
