import {
  RETRIEVAL_LIMITS,
  type IndexJobReason,
  type IndexJobStatus,
  type RetrievalIndexJobView,
  type RetrievalIndexStatus,
  type Scope,
  type ScopeKind,
} from '@freellmapi/shared/ai-platform-retrieval.js';
import { getDb } from '../../../db/index.js';
import { isTursoDatabase } from '../../../db/turso.js';
import type { Db } from '../../../db/types.js';
import { sanitizeProviderErrorMessage } from '../../../lib/error-redaction.js';
import {
  EmbeddingsError,
  embeddingsRetryAfterSec,
  getDefaultFamily,
  runEmbeddings,
  type EmbeddingsResult,
} from '../../../services/embeddings.js';
import { listProfileKnowledgeChunks } from '../../../services/profile-knowledge.js';
import * as supportKnowledge from '../../x-gateway/support-knowledge.js';
import { isPillarEnabled } from '../flags.js';
import { normalizeScope } from '../scope.js';
import {
  getIndexGeneration,
  getRetrievalSettingsInternal,
  recordEmbeddingUsage,
  resolveEffectiveEmbeddingModel,
  RetrievalStoreError,
} from './settings.js';
import {
  computeContentHash,
  deleteDocVectors,
  deleteStaleDocChunks,
  getIndexStatus,
  listScopeEmbeddingMeta,
  markChunkErrorBatch,
  markChunkReadyBatch,
  type EmbeddingMetaRecord,
} from './vector-store.js';

export type EmbeddingsRunner = (
  model: string | undefined,
  inputs: string[],
  dimensions?: number,
) => Promise<EmbeddingsResult>;

export interface SourceChunkRecord {
  docId: string;
  chunkId: number;
  ord: number;
  title: string;
  text: string;
  contentHash: string;
  roles?: string[];
}

interface IndexJobRow {
  id: number;
  scope_kind: ScopeKind;
  scope_id: string;
  reason: IndexJobReason;
  status: IndexJobStatus;
  model: string | null;
  total_chunks: number;
  processed_chunks: number;
  last_error: string | null;
  retry_after: string | null;
  created_at: string;
  updated_at: string;
}

type SupportKnowledgeModuleExt = typeof supportKnowledge & {
  listSupportKnowledgeChunks?: (
    tenantId: string,
    docId?: string,
  ) => Array<{
    docId: string;
    chunkId: number;
    ord: number;
    title: string;
    text: string;
    roles: string[];
  }>;
};

let testEmbeddingsRunner: EmbeddingsRunner | null = null;
let workerRunning = false;
let workerTimer: ReturnType<typeof setInterval> | null = null;
let pendingTickTimer: ReturnType<typeof setTimeout> | null = null;
let activeDrainPromise: Promise<void> | null = null;
const scopesNeedingRescan = new Set<string>();
const idleQueueSkipUntil = new WeakMap<Db, number>();

function clearIdleQueueSkip(db?: Db): void {
  try {
    idleQueueSkipUntil.delete(db ?? getDb());
  } catch {
    // DB may not be initialized yet.
  }
}

export function setEmbeddingsRunnerForTests(fn: EmbeddingsRunner | null): void {
  testEmbeddingsRunner = fn;
}

export function getEmbeddingsRunnerForHybrid(): {
  runner: EmbeddingsRunner;
  isTestOverride: boolean;
} {
  if (testEmbeddingsRunner) {
    return { runner: testEmbeddingsRunner, isTestOverride: true };
  }
  return { runner: runEmbeddings, isTestOverride: false };
}

function scopeKey(norm: Scope): string {
  return `${norm.kind}:${norm.id}`;
}

function mapJobRow(row: IndexJobRow): RetrievalIndexJobView {
  return {
    id: Number(row.id),
    scopeKind: row.scope_kind,
    scopeId: row.scope_id,
    reason: row.reason,
    status: row.status,
    model: row.model ?? null,
    totalChunks: Number(row.total_chunks ?? 0),
    processedChunks: Number(row.processed_chunks ?? 0),
    lastError: row.last_error ?? null,
    retryAfter: row.retry_after ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Loads current source chunks for any supported scope (`profile`, `support_tenant`, `agent`)
 * including `roles` metadata when applicable.
 */
export function loadSourceChunksWithRoles(scope: Scope): SourceChunkRecord[] {
  const norm = normalizeScope(scope);
  if (norm.kind === 'profile') {
    const rows = listProfileKnowledgeChunks(Number(norm.id));
    return rows.map((r) => ({
      docId: String(r.docId),
      chunkId: r.chunkId,
      ord: r.ord,
      title: r.title,
      text: r.text,
      contentHash: computeContentHash(r.title, r.text),
    }));
  }

  if (norm.kind === 'support_tenant') {
    const ext = supportKnowledge as SupportKnowledgeModuleExt;
    if (typeof ext.listSupportKnowledgeChunks === 'function') {
      const rows = ext.listSupportKnowledgeChunks(norm.id);
      return rows.map((r) => ({
        docId: String(r.docId),
        chunkId: r.chunkId,
        ord: r.ord,
        title: r.title,
        text: r.text,
        contentHash: computeContentHash(r.title, r.text),
        roles: Array.isArray(r.roles) ? [...r.roles] : [],
      }));
    }

    const docs = supportKnowledge.listSupportKnowledgeDocs(norm.id);
    const out: SourceChunkRecord[] = [];
    for (const doc of docs) {
      if (doc.enabled === false) continue;
      const chunks = String(doc.content ?? '')
        .split(/\n\s*\n/)
        .map((c) => c.trim())
        .filter(Boolean);
      const roles = Array.isArray(doc.allowedRoles) ? [...doc.allowedRoles] : [];
      chunks.forEach((text, ord) => {
        out.push({
          docId: String(doc.id),
          chunkId: ord,
          ord,
          title: doc.title,
          text,
          contentHash: computeContentHash(doc.title, text),
          roles,
        });
      });
    }
    return out;
  }

  // 'agent' scope currently has no local KB storage; return empty gracefully.
  return [];
}

/**
 * Loads current source chunks for a scope (`{ docId, chunkId, ord, title, text, contentHash }`).
 */
export function loadSourceChunks(
  scope: Scope,
): Array<{
  docId: string;
  chunkId: number;
  ord: number;
  title: string;
  text: string;
  contentHash: string;
}> {
  return loadSourceChunksWithRoles(scope).map((c) => ({
    docId: c.docId,
    chunkId: c.chunkId,
    ord: c.ord,
    title: c.title,
    text: c.text,
    contentHash: c.contentHash,
  }));
}

function resolveJobTarget(norm: Scope): {
  targetModel: string | null;
  targetDims: number;
  hasProviderOrRunner: boolean;
} {
  const { settings } = getRetrievalSettingsInternal(norm);
  const resolved = resolveEffectiveEmbeddingModel(norm);
  const hasTestRunner = testEmbeddingsRunner !== null;
  const targetModel =
    resolved.model ??
    (hasTestRunner
      ? settings.embeddingModel && settings.embeddingModel !== 'auto'
        ? settings.embeddingModel
        : getDefaultFamily()
      : null);

  return {
    targetModel,
    targetDims: resolved.dimensions,
    hasProviderOrRunner: Boolean(targetModel && (resolved.hasConfiguredProvider || hasTestRunner)),
  };
}

/**
 * Returns the live index status, active job (if any), and recent index jobs for a scope.
 */
export function getScopeIndexSnapshot(scope: Scope): {
  status: RetrievalIndexStatus;
  activeJob: RetrievalIndexJobView | null;
  recentJobs: RetrievalIndexJobView[];
} {
  const norm = normalizeScope(scope);
  const sourceChunks = loadSourceChunks(norm);
  const target = resolveJobTarget(norm);
  const status = getIndexStatus(norm, sourceChunks, target.targetModel, target.targetDims);

  const rows = getDb()
    .prepare(
      `SELECT * FROM custom_ai_index_jobs
        WHERE scope_kind = ? AND scope_id = ?
        ORDER BY id DESC
        LIMIT 20`,
    )
    .all(norm.kind, norm.id) as IndexJobRow[];

  const recentJobs = rows.map(mapJobRow);
  const activeJob =
    recentJobs.find((j) => j.status === 'queued' || j.status === 'running') ?? null;

  return { status, activeJob, recentJobs };
}

function getActiveJobRow(norm: Scope): IndexJobRow | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM custom_ai_index_jobs
        WHERE scope_kind = ? AND scope_id = ? AND status IN ('queued', 'running')
        ORDER BY id DESC
        LIMIT 1`,
    )
    .get(norm.kind, norm.id) as IndexJobRow | undefined;
}

function shouldRunBackgroundTick(): boolean {
  return isPillarEnabled('retrieval') || testEmbeddingsRunner !== null;
}

function scheduleTick(delayMs = 25): void {
  clearIdleQueueSkip();
  if (!shouldRunBackgroundTick()) return;
  if (pendingTickTimer) return;
  pendingTickTimer = setTimeout(() => {
    pendingTickTimer = null;
    void drainBackgroundTick();
  }, delayMs);
  pendingTickTimer.unref?.();
}

function backgroundPollTick(): void {
  if (!shouldRunBackgroundTick()) return;
  if (testEmbeddingsRunner === null) {
    try {
      const db = getDb();
      const now = Date.now();
      const skipUntil = idleQueueSkipUntil.get(db) ?? 0;
      if (now < skipUntil) return;
      const row = db
        .prepare(
          `SELECT COUNT(*) AS cnt, MIN(COALESCE(retry_after, '')) AS earliest
             FROM custom_ai_index_jobs
            WHERE status = 'queued'`,
        )
        .get() as { cnt: number; earliest: string | null } | undefined;
      if (Number(row?.cnt ?? 0) === 0) {
        idleQueueSkipUntil.set(db, now + (isTursoDatabase(db) ? 60_000 : 5_000));
        return;
      }
      if (row?.earliest) {
        const retryAt = Date.parse(row.earliest);
        if (Number.isFinite(retryAt) && retryAt > now) {
          idleQueueSkipUntil.set(db, Math.min(retryAt, now + 60_000));
          return;
        }
      }
    } catch {
      return;
    }
  }
  void drainBackgroundTick();
}

async function drainBackgroundTick(): Promise<void> {
  if (!shouldRunBackgroundTick()) return;
  if (activeDrainPromise) {
    return activeDrainPromise;
  }
  activeDrainPromise = (async () => {
    try {
      await runPendingIndexJobsUntilIdle({ respectRetryAfter: true });
    } catch {
      // Never crash background timers (e.g. if in-memory DB closed during test teardown).
    } finally {
      activeDrainPromise = null;
    }
  })();
  return activeDrainPromise;
}

/**
 * Enqueues a background reindex job for `scope`, keeping at most 1 active job per scope.
 */
export function enqueueReindexJob(
  scope: Scope,
  reason: IndexJobReason,
  opts?: { throwOnActive?: boolean },
): RetrievalIndexJobView {
  const norm = normalizeScope(scope);
  const db = getDb();
  clearIdleQueueSkip(db);
  const target = resolveJobTarget(norm);
  const sourceChunks = loadSourceChunks(norm);
  const nowIso = new Date().toISOString();

  const existing = getActiveJobRow(norm);
  if (existing) {
    if (opts?.throwOnActive) {
      throw new RetrievalStoreError(
        'An indexing job is already active for this scope.',
        'job_already_running',
        409,
      );
    }
    if (existing.status === 'queued') {
      const clearBackoff = reason === 'model_change' || reason === 'reindex';
      db.prepare(
        `UPDATE custom_ai_index_jobs
            SET reason = ?,
                model = ?,
                total_chunks = ?,
                last_error = CASE WHEN ? = 1 THEN NULL ELSE last_error END,
                retry_after = CASE WHEN ? = 1 THEN NULL ELSE retry_after END,
                updated_at = ?
          WHERE id = ? AND status = 'queued'`,
      ).run(
        reason,
        target.targetModel,
        sourceChunks.length,
        clearBackoff ? 1 : 0,
        clearBackoff ? 1 : 0,
        nowIso,
        existing.id,
      );
      const updated = db
        .prepare('SELECT * FROM custom_ai_index_jobs WHERE id = ?')
        .get(existing.id) as IndexJobRow | undefined;
      scheduleTick();
      return mapJobRow(updated ?? existing);
    }

    // Active job is currently 'running'; note that source changed so it rescans before completing.
    scopesNeedingRescan.add(scopeKey(norm));
    db.prepare(
      `UPDATE custom_ai_index_jobs
          SET total_chunks = ?, updated_at = ?
        WHERE id = ?`,
    ).run(sourceChunks.length, nowIso, existing.id);
    const updated = db
      .prepare('SELECT * FROM custom_ai_index_jobs WHERE id = ?')
      .get(existing.id) as IndexJobRow | undefined;
    return mapJobRow(updated ?? existing);
  }

  try {
    const info = db
      .prepare(
        `INSERT INTO custom_ai_index_jobs (
          scope_kind, scope_id, reason, status, model,
          total_chunks, processed_chunks, last_error, retry_after, created_at, updated_at
        ) VALUES (?, ?, ?, 'queued', ?, ?, 0, NULL, NULL, ?, ?)`,
      )
      .run(
        norm.kind,
        norm.id,
        reason,
        target.targetModel,
        sourceChunks.length,
        nowIso,
        nowIso,
      );
    const inserted = db
      .prepare('SELECT * FROM custom_ai_index_jobs WHERE id = ?')
      .get(Number(info.lastInsertRowid)) as IndexJobRow;
    scheduleTick();
    return mapJobRow(inserted);
  } catch (err) {
    // Handle concurrent unique index race on idx_ai_index_jobs_active cleanly.
    const raced = getActiveJobRow(norm);
    if (raced) {
      if (opts?.throwOnActive) {
        throw new RetrievalStoreError(
          'An indexing job is already active for this scope.',
          'job_already_running',
          409,
        );
      }
      return mapJobRow(raced);
    }
    throw err;
  }
}

/**
 * Synchronously invalidates stale vectors for `docId` (and bumps index generation)
 * before queuing an asynchronous `'doc_edit'` reindex job.
 */
export async function onDocumentChanged(scope: Scope, docId: string): Promise<void> {
  const norm = normalizeScope(scope);
  deleteDocVectors(norm, String(docId));
  enqueueReindexJob(norm, 'doc_edit', { throwOnActive: false });
}

/**
 * Synchronously deletes vectors for a deleted document and bumps index generation.
 */
export async function onDocumentDeleted(scope: Scope, docId: string): Promise<void> {
  const norm = normalizeScope(scope);
  deleteDocVectors(norm, String(docId));
}

function computeRetryDelayMs(err: unknown): number | undefined {
  if (!(err instanceof EmbeddingsError)) return undefined;
  if (err.retryAfterMs !== undefined && Number.isFinite(err.retryAfterMs)) {
    return Math.max(0, err.retryAfterMs);
  }
  const sec = embeddingsRetryAfterSec(err);
  if (sec !== undefined && Number.isFinite(sec)) {
    return Math.max(0, sec * 1000);
  }
  return undefined;
}

function filterPendingChunks(
  sourceChunks: SourceChunkRecord[],
  meta: EmbeddingMetaRecord[],
  targetModel: string | null,
  targetDims: number,
): { pending: SourceChunkRecord[]; alreadyReadyCount: number } {
  const metaByKey = new Map<string, EmbeddingMetaRecord>();
  for (const row of meta) {
    metaByKey.set(`${row.docId}:${row.chunkId}`, row);
  }

  const pending: SourceChunkRecord[] = [];
  let alreadyReadyCount = 0;

  for (const chunk of sourceChunks) {
    const key = `${chunk.docId}:${chunk.chunkId}`;
    const existing = metaByKey.get(key);
    const isReadyMatch =
      existing !== undefined &&
      existing.status === 'ready' &&
      existing.contentHash === chunk.contentHash &&
      targetModel !== null &&
      existing.model === targetModel &&
      existing.dims === targetDims;
    if (isReadyMatch) {
      alreadyReadyCount++;
    } else {
      pending.push(chunk);
    }
  }

  return { pending, alreadyReadyCount };
}

async function executeClaimedJob(job: IndexJobRow): Promise<'succeeded' | 'requeued' | 'failed'> {
  const db = getDb();
  const norm: Scope = { kind: job.scope_kind, id: job.scope_id };
  const sKey = scopeKey(norm);
  const runner = testEmbeddingsRunner ?? runEmbeddings;
  const maxPasses = 5;

  for (let pass = 0; pass < maxPasses; pass++) {
    scopesNeedingRescan.delete(sKey);
    const genAtPassStart = getIndexGeneration(norm);
    const target = resolveJobTarget(norm);
    const sourceChunks = loadSourceChunksWithRoles(norm);

    const validKeys = new Set(sourceChunks.map((c) => `${c.docId}:${c.chunkId}`));
    deleteStaleDocChunks(norm, validKeys);

    const meta = listScopeEmbeddingMeta(norm);
    const { pending, alreadyReadyCount } = filterPendingChunks(
      sourceChunks,
      meta,
      target.targetModel,
      target.targetDims,
    );

    let processedCount = alreadyReadyCount;
    db.prepare(
      `UPDATE custom_ai_index_jobs
          SET model = ?, total_chunks = ?, processed_chunks = ?, updated_at = ?
        WHERE id = ?`,
    ).run(
      target.targetModel,
      sourceChunks.length,
      processedCount,
      new Date().toISOString(),
      job.id,
    );

    if (pending.length === 0) {
      if (scopesNeedingRescan.has(sKey) || getIndexGeneration(norm) !== genAtPassStart) {
        continue;
      }
      db.prepare(
        `UPDATE custom_ai_index_jobs
            SET status = 'succeeded',
                model = ?,
                total_chunks = ?,
                processed_chunks = ?,
                last_error = NULL,
                retry_after = NULL,
                updated_at = ?
          WHERE id = ?`,
      ).run(
        target.targetModel,
        sourceChunks.length,
        sourceChunks.length,
        new Date().toISOString(),
        job.id,
      );
      return 'succeeded';
    }

    if (!target.targetModel || (!target.hasProviderOrRunner && testEmbeddingsRunner === null)) {
      const msg = 'No embedding provider configured.';
      if (target.targetModel) {
        markChunkErrorBatch(
          norm,
          pending.map((c) => ({
            docId: c.docId,
            chunkId: c.chunkId,
            ord: c.ord,
            contentHash: c.contentHash,
            model: target.targetModel!,
            dims: target.targetDims,
            errorText: msg,
          })),
        );
      }
      db.prepare(
        `UPDATE custom_ai_index_jobs
            SET status = 'failed',
                last_error = ?,
                retry_after = NULL,
                updated_at = ?
          WHERE id = ?`,
      ).run(msg, new Date().toISOString(), job.id);
      return 'failed';
    }

    const effectiveModel = target.targetModel;
    const effectiveDims = target.targetDims;
    const batchSize = RETRIEVAL_LIMITS.indexBatchSize;

    for (let i = 0; i < pending.length; i += batchSize) {
      const batch = pending.slice(i, i + batchSize);
      const inputs = batch.map((c) => `${c.title}\n\n${c.text}`);

      try {
        const res = await runner(effectiveModel, inputs, effectiveDims);
        if (!Array.isArray(res.vectors) || res.vectors.length !== batch.length) {
          throw new EmbeddingsError(
            `Embedding runner returned ${res.vectors?.length ?? 0} vectors for ${batch.length} inputs.`,
            502,
          );
        }

        // Guard against concurrent edits/deletions while awaiting embedding I/O:
        // only persist vectors whose contentHash still matches current source chunks.
        let validChunkHashes: Map<string, string> | null = null;
        if (getIndexGeneration(norm) !== genAtPassStart) {
          const latest = loadSourceChunksWithRoles(norm);
          validChunkHashes = new Map(
            latest.map((c) => [`${c.docId}:${c.chunkId}`, c.contentHash]),
          );
        }

        const readyItems: Array<{
          docId: string;
          chunkId: number;
          ord: number;
          contentHash: string;
          model: string;
          dims: number;
          vector: ArrayLike<number>;
        }> = [];

        for (let j = 0; j < batch.length; j++) {
          const chunk = batch[j]!;
          const vec = res.vectors[j]!;
          if (!vec || vec.length !== effectiveDims) {
            throw new EmbeddingsError(
              `Embedding vector dimension mismatch: expected ${effectiveDims}, got ${vec?.length ?? 0}.`,
              502,
            );
          }
          if (validChunkHashes) {
            const currentHash = validChunkHashes.get(`${chunk.docId}:${chunk.chunkId}`);
            if (currentHash !== chunk.contentHash) {
              continue;
            }
          }
          readyItems.push({
            docId: chunk.docId,
            chunkId: chunk.chunkId,
            ord: chunk.ord,
            contentHash: chunk.contentHash,
            model: effectiveModel,
            dims: effectiveDims,
            vector: vec,
          });
        }

        if (readyItems.length > 0) {
          markChunkReadyBatch(norm, readyItems);
          processedCount += readyItems.length;
        }
        recordEmbeddingUsage(
          norm,
          res.modelId || effectiveModel,
          'index',
          res.inputTokens ?? 0,
        );

        db.prepare(
          `UPDATE custom_ai_index_jobs
              SET processed_chunks = ?, updated_at = ?
            WHERE id = ?`,
        ).run(Math.min(processedCount, sourceChunks.length), new Date().toISOString(), job.id);

        if (i + batchSize < pending.length) {
          await yieldToEventLoop();
        }
      } catch (err) {
        // Provider errors can echo the credential or the request URL; this text is
        // stored on the job and chunks, returned by the admin API and backed up.
        const errMsg = sanitizeProviderErrorMessage(err instanceof Error ? err.message : String(err));
        const retryDelayMs = computeRetryDelayMs(err);

        if (retryDelayMs !== undefined) {
          const retryAfterIso = new Date(Date.now() + retryDelayMs).toISOString();
          db.prepare(
            `UPDATE custom_ai_index_jobs
                SET status = 'queued',
                    last_error = ?,
                    retry_after = ?,
                    updated_at = ?
              WHERE id = ?`,
          ).run(errMsg, retryAfterIso, new Date().toISOString(), job.id);
          return 'requeued';
        }

        markChunkErrorBatch(
          norm,
          batch.map((c) => ({
            docId: c.docId,
            chunkId: c.chunkId,
            ord: c.ord,
            contentHash: c.contentHash,
            model: effectiveModel,
            dims: effectiveDims,
            errorText: errMsg,
          })),
        );
        db.prepare(
          `UPDATE custom_ai_index_jobs
              SET status = 'failed',
                  last_error = ?,
                  retry_after = NULL,
                  updated_at = ?
            WHERE id = ?`,
        ).run(errMsg, new Date().toISOString(), job.id);
        return 'failed';
      }
    }

    if (scopesNeedingRescan.has(sKey) || getIndexGeneration(norm) !== genAtPassStart) {
      continue;
    }

    const latestChunks = loadSourceChunksWithRoles(norm);
    db.prepare(
      `UPDATE custom_ai_index_jobs
          SET status = 'succeeded',
              model = ?,
              total_chunks = ?,
              processed_chunks = ?,
              last_error = NULL,
              retry_after = NULL,
              updated_at = ?
        WHERE id = ?`,
    ).run(
      effectiveModel,
      latestChunks.length,
      latestChunks.length,
      new Date().toISOString(),
      job.id,
    );
    return 'succeeded';
  }

  // Defensive exit if scope was continuously mutated across maxPasses.
  db.prepare(
    `UPDATE custom_ai_index_jobs
        SET status = 'queued', retry_after = NULL, updated_at = ?
      WHERE id = ?`,
  ).run(new Date().toISOString(), job.id);
  return 'requeued';
}

let processingLock: Promise<boolean> | null = null;

/**
 * Claims and executes the oldest eligible `'queued'` index job once.
 * Returns `true` if a job was claimed and processed, `false` otherwise.
 */
export async function processNextIndexJobOnce(opts?: {
  respectRetryAfter?: boolean;
}): Promise<boolean> {
  if (processingLock) {
    return processingLock;
  }

  const run = (async (): Promise<boolean> => {
    const db = getDb();
    const respectRetry = opts?.respectRetryAfter !== false ? 1 : 0;
    const nowIso = new Date().toISOString();

    const candidate = db
      .prepare(
        `SELECT * FROM custom_ai_index_jobs
          WHERE status = 'queued'
            AND (? = 0 OR retry_after IS NULL OR julianday(retry_after) <= julianday(?))
          ORDER BY id ASC
          LIMIT 1`,
      )
      .get(respectRetry, nowIso) as IndexJobRow | undefined;

    if (!candidate) return false;

    const claim = db
      .prepare(
        `UPDATE custom_ai_index_jobs
            SET status = 'running', updated_at = ?
          WHERE id = ? AND status = 'queued'`,
      )
      .run(nowIso, candidate.id);

    if (claim.changes === 0) return false;

    await executeClaimedJob(candidate);
    return true;
  })();

  processingLock = run;
  try {
    return await run;
  } finally {
    if (processingLock === run) {
      processingLock = null;
    }
  }
}

/**
 * Drains eligible queued index jobs until no more eligible work remains.
 * Stops cleanly if a job is re-queued with backoff to avoid spinning.
 */
export async function runPendingIndexJobsUntilIdle(opts?: {
  respectRetryAfter?: boolean;
  maxJobs?: number;
}): Promise<number> {
  const maxJobs = Math.max(1, opts?.maxJobs ?? 100);
  const respectRetry = opts?.respectRetryAfter !== false;
  const seenQueuedIds = new Set<number>();
  let processed = 0;

  for (let i = 0; i < maxJobs; i++) {
    const db = getDb();
    const nowIso = new Date().toISOString();
    const nextCandidate = db
      .prepare(
        `SELECT id FROM custom_ai_index_jobs
          WHERE status = 'queued'
            AND (? = 0 OR retry_after IS NULL OR julianday(retry_after) <= julianday(?))
          ORDER BY id ASC
          LIMIT 1`,
      )
      .get(respectRetry ? 1 : 0, nowIso) as { id: number } | undefined;

    if (!nextCandidate) break;
    if (!respectRetry && seenQueuedIds.has(nextCandidate.id)) {
      // Same job re-queued again during this drain call -> prevent infinite spin.
      break;
    }

    const didWork = await processNextIndexJobOnce({ respectRetryAfter: respectRetry });
    if (!didWork) break;
    processed++;

    const after = db
      .prepare('SELECT status FROM custom_ai_index_jobs WHERE id = ?')
      .get(nextCandidate.id) as { status: IndexJobStatus } | undefined;
    if (after?.status === 'queued') {
      seenQueuedIds.add(nextCandidate.id);
    }
  }

  return processed;
}

const MISSING_EMBEDDINGS_SWEEP_MS = 5 * 60_000;
const TURSO_IDLE_MISSING_EMBEDDINGS_SWEEP_MS = 30 * 60_000;
const FAILED_JOB_COOLDOWN_MS = 30 * 60_000;
let lastMissingEmbeddingsSweepAt = 0;
let lastSweepIdle = false;

/**
 * Queues a reindex for every previously indexed scope that has source chunks
 * with no embedding row at all — for example after a backup was restored
 * without `custom_ai_chunk_embeddings`, which is rebuildable and may be left
 * out of a dump. Chunks that already have a row (ready, error or stale) are
 * handled by the normal job flow. A scope with an active job is skipped, and
 * so is one whose latest job failed less than 30 minutes ago, so an
 * unavailable embeddings provider does not produce a job on every sweep.
 * Returns the number of jobs queued.
 */
export function enqueueMissingEmbeddingJobs(now = Date.now()): number {
  const db = getDb();
  const latestJobs = db
    .prepare(
      `SELECT j.scope_kind, j.scope_id, j.status, j.updated_at
         FROM custom_ai_index_jobs j
         JOIN (SELECT MAX(id) AS id FROM custom_ai_index_jobs GROUP BY scope_kind, scope_id) latest
           ON latest.id = j.id`,
    )
    .all() as Array<{ scope_kind: ScopeKind; scope_id: string; status: IndexJobStatus; updated_at: string }>;

  let queued = 0;
  for (const job of latestJobs) {
    if (job.status === 'queued' || job.status === 'running') continue;
    if (job.status === 'failed' && now - Date.parse(job.updated_at) < FAILED_JOB_COOLDOWN_MS) continue;
    try {
      const norm = normalizeScope({ kind: job.scope_kind, id: job.scope_id });
      const sourceChunks = loadSourceChunks(norm);
      if (sourceChunks.length === 0) continue;
      const indexed = new Set(listScopeEmbeddingMeta(norm).map((row) => `${row.docId}:${row.chunkId}`));
      if (sourceChunks.every((chunk) => indexed.has(`${chunk.docId}:${chunk.chunkId}`))) continue;
      enqueueReindexJob(norm, 'reindex', { throwOnActive: false });
      queued++;
    } catch {
      // A scope whose owner no longer exists, or a transient read error, is skipped this sweep.
    }
  }
  return queued;
}

function maybeSweepMissingEmbeddings(): void {
  if (!shouldRunBackgroundTick()) return;
  const now = Date.now();
  let sweepIntervalMs = MISSING_EMBEDDINGS_SWEEP_MS;
  try {
    if (lastSweepIdle && isTursoDatabase(getDb())) {
      sweepIntervalMs = TURSO_IDLE_MISSING_EMBEDDINGS_SWEEP_MS;
    }
  } catch {
    // Use default sweep cadence when DB is not ready.
  }
  if (now - lastMissingEmbeddingsSweepAt < sweepIntervalMs) return;
  lastMissingEmbeddingsSweepAt = now;
  try {
    lastSweepIdle = enqueueMissingEmbeddingJobs(now) === 0;
  } catch {
    // Never crash the worker timer (e.g. DB closed during test teardown).
  }
}

/**
 * Starts the background index worker loop (idempotent).
 * Resets any interrupted `'running'` jobs back to `'queued'` so indexing resumes after restarts.
 */
export function startIndexWorker(intervalMs = 1_500): void {
  if (workerRunning) return;
  workerRunning = true;

  try {
    getDb()
      .prepare(
        `UPDATE custom_ai_index_jobs
            SET status = 'queued', updated_at = ?
          WHERE status = 'running'`,
      )
      .run(new Date().toISOString());
  } catch {
    // DB may not be initialized if called early; periodic ticks will run once ready.
  }

  lastMissingEmbeddingsSweepAt = 0;
  lastSweepIdle = false;
  workerTimer = setInterval(() => {
    maybeSweepMissingEmbeddings();
    backgroundPollTick();
  }, Math.max(25, intervalMs));
  workerTimer.unref?.();

  scheduleTick(10);
}

/**
 * Stops the background index worker loop and clears any pending scheduled tick.
 */
export function stopIndexWorker(): void {
  workerRunning = false;
  lastSweepIdle = false;
  clearIdleQueueSkip();
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
  if (pendingTickTimer) {
    clearTimeout(pendingTickTimer);
    pendingTickTimer = null;
  }
  scopesNeedingRescan.clear();
}
