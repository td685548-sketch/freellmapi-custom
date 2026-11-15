import {
  RETRIEVAL_LIMITS,
  type RetrievalDegradedReason,
  type RetrievalHit,
  type RetrievalMode,
  type RetrievalQueryResponse,
} from '@freellmapi/shared/ai-platform-retrieval.js';
import { getDefaultFamily, type EmbeddingsResult } from '../../../services/embeddings.js';
import { searchKnowledgeRanked } from '../../../services/profile-knowledge.js';
import * as supportKnowledge from '../../x-gateway/support-knowledge.js';
import { isPillarEnabled } from '../flags.js';
import { normalizeScope, type Scope } from '../scope.js';
import { buildCitations } from './citations.js';
import {
  getEmbeddingsRunnerForHybrid,
  loadSourceChunksWithRoles,
  type EmbeddingsRunner,
  type SourceChunkRecord,
} from './indexer.js';
import {
  getRetrievalSettingsInternal,
  recordEmbeddingUsage,
  resolveEffectiveEmbeddingModel,
} from './settings.js';
import { getScopeVectors, searchTopVectors } from './vector-store.js';

export interface RetrieveOptions {
  topK?: number;
  minScore?: number;
  mode?: RetrievalMode;
  roles?: string[];
  queryTimeoutMs?: number;
  signal?: AbortSignal;
  respectPillarFlag?: boolean;
}

interface KeywordCandidate {
  key: string;
  docId: string;
  chunkId: number;
  ord: number;
  title: string;
  text: string;
  rawScore: number;
  score: number;
  fromProfileBm25: boolean;
}

let queryEmbeddingsRunnerOverride: EmbeddingsRunner | null = null;

/** Test hook to override query-time embedding execution without touching providers. */
export function setQueryEmbeddingsRunnerForTests(fn: EmbeddingsRunner | null): void {
  queryEmbeddingsRunnerOverride = fn;
}

function makeSnippet(text: string, maxLen = 240): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLen) return collapsed;
  return `${collapsed.slice(0, maxLen - 1).trimEnd()}…`;
}

function roundScore(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * 10_000) / 10_000));
}

function clampTopK(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return RETRIEVAL_LIMITS.defaultTopK;
  }
  return Math.max(1, Math.min(RETRIEVAL_LIMITS.maxTopK, Math.floor(raw)));
}

function clampMinScore(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return RETRIEVAL_LIMITS.defaultMinScore;
  }
  return Math.max(0, Math.min(1, raw));
}

function isSupportChunkVisible(roles: string[] | undefined, allowedRoleSet: Set<string> | null): boolean {
  if (allowedRoleSet === null) return true;
  if (!roles || roles.length === 0) return false;
  return roles.includes('*') || roles.some((r) => allowedRoleSet.has(r));
}

function runKeywordSearch(
  scope: Scope,
  query: string,
  candidateLimit: number,
  roles?: string[],
  allowedDocIds?: Set<string>,
): KeywordCandidate[] {
  if (scope.kind === 'profile') {
    const profileId = Number(scope.id);
    if (!Number.isFinite(profileId) || profileId <= 0) return [];
    const rows = searchKnowledgeRanked(profileId, query, candidateLimit);
    const maxRaw = rows[0]?.score ?? 0;
    return rows.map((row) => {
      const normalized = maxRaw > 0 ? roundScore(row.score / maxRaw) : 0;
      // searchKnowledgeRanked rounds raw BM25 to 3 decimals before returning hits that
      // already cleared best * 0.25; avoid 3-decimal rounding pushing edge hits to 0.2499.
      const score =
        normalized >= 0.245 && normalized < RETRIEVAL_LIMITS.defaultMinScore
          ? RETRIEVAL_LIMITS.defaultMinScore
          : normalized;
      return {
        key: `${String(row.docId)}:${row.chunkId}`,
        docId: String(row.docId),
        chunkId: row.chunkId,
        ord: row.ord,
        title: row.title,
        text: row.text,
        rawScore: row.score,
        score,
        fromProfileBm25: true,
      };
    });
  }

  if (scope.kind === 'support_tenant') {
    const merged = new Map<
      string,
      { docId: string; chunkId: number; ord: number; title: string; text: string; score: number }
    >();

    const collectHits = (roleArg: string | undefined, limit: number): void => {
      const hits = supportKnowledge.searchSupportKnowledgeRanked(scope.id, query, roleArg, {
        topK: limit,
      });
      for (const hit of hits) {
        if (allowedDocIds && !allowedDocIds.has(String(hit.docId))) continue;
        const key = `${String(hit.docId)}:${hit.chunkId}`;
        const prev = merged.get(key);
        if (!prev || hit.score > prev.score) {
          merged.set(key, {
            docId: String(hit.docId),
            chunkId: hit.chunkId,
            ord: hit.ord,
            title: hit.title,
            text: hit.text,
            score: hit.score,
          });
        }
      }
    };

    if (roles === undefined) {
      collectHits(undefined, candidateLimit);
    } else if (roles.length === 0) {
      // Filter down to wildcard ('*') docs via allowedDocIds.
      collectHits(undefined, candidateLimit * 4);
    } else {
      const distinctRoles = Array.from(new Set(roles.map((r) => r.trim()).filter(Boolean)));
      if (distinctRoles.length === 0) {
        collectHits(undefined, candidateLimit * 4);
      } else {
        for (const r of distinctRoles) {
          collectHits(r, candidateLimit);
        }
      }
    }

    const sorted = Array.from(merged.values())
      .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title) || a.ord - b.ord)
      .slice(0, candidateLimit);

    const maxRaw = sorted[0]?.score ?? 0;
    return sorted.map((row) => ({
      key: `${row.docId}:${row.chunkId}`,
      docId: row.docId,
      chunkId: row.chunkId,
      ord: row.ord,
      title: row.title,
      text: row.text,
      rawScore: row.score,
      score: maxRaw > 0 ? roundScore(row.score / maxRaw) : 0,
      fromProfileBm25: false,
    }));
  }

  return [];
}

function buildKeywordHits(
  candidates: KeywordCandidate[],
  topK: number,
  minScore: number,
): RetrievalHit[] {
  const filtered = candidates.filter((cand) => {
    if (cand.fromProfileBm25 && minScore <= RETRIEVAL_LIMITS.defaultMinScore) {
      return true;
    }
    return cand.score >= minScore;
  });

  return filtered.slice(0, topK).map((cand, idx) => ({
    docId: cand.docId,
    chunkId: cand.chunkId,
    ord: cand.ord,
    title: cand.title,
    snippet: makeSnippet(cand.text),
    text: cand.text,
    score: cand.score,
    keywordRank: idx + 1,
    sources: ['keyword'],
  }));
}

async function runQueryEmbeddingWithTimeout(
  embedder: EmbeddingsRunner,
  model: string,
  query: string,
  dims: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ result: EmbeddingsResult } | { reason: 'timeout' | 'embedding_error' }> {
  if (signal?.aborted) {
    return { reason: 'timeout' };
  }

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  const embedPromise = Promise.resolve().then(() => embedder(model, [query], dims));
  // Prevent unhandled rejection warnings if timeout/abort resolves earlier.
  embedPromise.catch(() => undefined);

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`Query embedding timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    if (signal) {
      onAbort = () => {
        timedOut = true;
        reject(new Error('Query embedding aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });

  try {
    const result = await Promise.race([embedPromise, timeoutPromise]);
    return { result };
  } catch {
    return { reason: timedOut ? 'timeout' : 'embedding_error' };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort && signal) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

/**
 * Executes keyword, semantic, or hybrid (RRF k=60) retrieval for a scope with automatic
 * graceful fallback to keyword retrieval whenever semantic search is unavailable.
 */
export async function retrieve(
  scope: Scope,
  query: string,
  opts?: RetrieveOptions,
): Promise<RetrievalQueryResponse> {
  const startedAt = Date.now();
  const norm = normalizeScope(scope);
  const { settings, indexGeneration } = getRetrievalSettingsInternal(norm);

  const modeRequested: RetrievalMode = opts?.mode ?? settings.mode;
  const topK = clampTopK(opts?.topK ?? settings.topK);
  const minScore = clampMinScore(opts?.minScore ?? settings.minScore);
  const timeoutMs = Math.max(
    1,
    Math.floor(
      opts?.queryTimeoutMs !== undefined && Number.isFinite(opts.queryTimeoutMs)
        ? opts.queryTimeoutMs
        : RETRIEVAL_LIMITS.queryTimeoutMs,
    ),
  );
  const cleanQuery = typeof query === 'string' ? query.slice(0, RETRIEVAL_LIMITS.maxQueryChars) : '';
  const candidateLimit = Math.max(topK * 4, 25);

  const makeResponse = (
    modeUsed: RetrievalMode,
    hits: RetrievalHit[],
    degraded: boolean,
    degradedReason?: RetrievalDegradedReason,
  ): RetrievalQueryResponse => ({
    scope: norm,
    query: cleanQuery,
    modeRequested,
    modeUsed,
    degraded,
    ...(degradedReason ? { degradedReason } : {}),
    latencyMs: Math.max(0, Date.now() - startedAt),
    indexGeneration,
    hits,
    citations: buildCitations(hits),
  });

  if (!cleanQuery.trim()) {
    return makeResponse(modeRequested, [], false);
  }

  const sourceChunks = loadSourceChunksWithRoles(norm);
  const chunkByKey = new Map<string, SourceChunkRecord>();
  const contentHashesByChunkKey = new Map<string, string>();
  const allowedRoleSet =
    norm.kind === 'support_tenant' && opts?.roles !== undefined
      ? new Set(opts.roles.map((r) => r.trim()).filter(Boolean))
      : null;
  const allowedDocIds = norm.kind === 'support_tenant' ? new Set<string>() : undefined;

  for (const chunk of sourceChunks) {
    const key = `${chunk.docId}:${chunk.chunkId}`;
    chunkByKey.set(key, chunk);
    contentHashesByChunkKey.set(key, chunk.contentHash);
    if (allowedDocIds && isSupportChunkVisible(chunk.roles, allowedRoleSet)) {
      allowedDocIds.add(chunk.docId);
    }
  }

  if (sourceChunks.length === 0 || (allowedDocIds && allowedDocIds.size === 0)) {
    return makeResponse(modeRequested, [], false);
  }

  const fallbackToKeyword = (reason: RetrievalDegradedReason): RetrievalQueryResponse => {
    const kwCandidates = runKeywordSearch(norm, cleanQuery, candidateLimit, opts?.roles, allowedDocIds);
    const hits = buildKeywordHits(kwCandidates, topK, minScore);
    return makeResponse('keyword', hits, true, reason);
  };

  if (modeRequested === 'keyword') {
    const kwCandidates = runKeywordSearch(
      norm,
      cleanQuery,
      Math.max(topK, candidateLimit),
      opts?.roles,
      allowedDocIds,
    );
    const hits = buildKeywordHits(kwCandidates, topK, minScore);
    return makeResponse('keyword', hits, false);
  }

  if (opts?.respectPillarFlag && !isPillarEnabled('retrieval')) {
    return fallbackToKeyword('pillar_disabled');
  }

  const indexerRunnerInfo = getEmbeddingsRunnerForHybrid();
  const hasTestOverride = queryEmbeddingsRunnerOverride !== null || indexerRunnerInfo.isTestOverride;
  const embedder: EmbeddingsRunner = queryEmbeddingsRunnerOverride ?? indexerRunnerInfo.runner;

  const resolved = resolveEffectiveEmbeddingModel(norm);
  const targetDims = resolved.dimensions;
  const targetModel = resolved.model;

  if (!targetModel || (!resolved.hasConfiguredProvider && !hasTestOverride)) {
    return fallbackToKeyword('no_model');
  }

  const { entries } = getScopeVectors(norm, indexGeneration);
  let readyVectorCount = 0;
  for (const entry of entries) {
    if (entry.model !== targetModel || entry.dims !== targetDims) continue;
    const expectedHash = contentHashesByChunkKey.get(`${entry.docId}:${entry.chunkId}`);
    if (!expectedHash || expectedHash !== entry.contentHash) continue;
    if (allowedDocIds && !allowedDocIds.has(entry.docId)) continue;
    readyVectorCount += 1;
  }

  if (readyVectorCount === 0) {
    return fallbackToKeyword('index_not_ready');
  }

  const kwPromise =
    modeRequested === 'hybrid'
      ? Promise.resolve().then(() =>
          runKeywordSearch(norm, cleanQuery, candidateLimit, opts?.roles, allowedDocIds),
        )
      : Promise.resolve([] as KeywordCandidate[]);

  const embedOutcome = await runQueryEmbeddingWithTimeout(
    embedder,
    targetModel || getDefaultFamily(),
    cleanQuery,
    targetDims,
    timeoutMs,
    opts?.signal,
  );

  if ('reason' in embedOutcome) {
    return fallbackToKeyword(embedOutcome.reason);
  }

  const rawVec = embedOutcome.result?.vectors?.[0];
  if (!rawVec || rawVec.length !== targetDims) {
    return fallbackToKeyword('embedding_error');
  }

  try {
    recordEmbeddingUsage(
      norm,
      embedOutcome.result.modelId || targetModel,
      'query',
      embedOutcome.result.inputTokens ?? 0,
    );
  } catch {
    // Telemetry failure must not break query path.
  }

  let semanticCandidates: ReturnType<typeof searchTopVectors>;
  try {
    semanticCandidates = searchTopVectors(norm, rawVec, {
      expectedGeneration: indexGeneration,
      model: targetModel,
      dims: targetDims,
      topK: modeRequested === 'semantic' ? topK : candidateLimit,
      minScore: modeRequested === 'semantic' ? minScore : -1,
      allowedDocIds,
      contentHashesByChunkKey,
    });
  } catch {
    return fallbackToKeyword('embedding_error');
  }

  if (modeRequested === 'semantic') {
    const hits: RetrievalHit[] = [];
    for (let i = 0; i < semanticCandidates.length; i += 1) {
      const vecHit = semanticCandidates[i]!;
      const key = `${vecHit.docId}:${vecHit.chunkId}`;
      const chunk = chunkByKey.get(key);
      if (!chunk) continue;
      hits.push({
        docId: chunk.docId,
        chunkId: chunk.chunkId,
        ord: chunk.ord,
        title: chunk.title,
        snippet: makeSnippet(chunk.text),
        text: chunk.text,
        score: roundScore(vecHit.score),
        semanticRank: i + 1,
        sources: ['semantic'],
      });
    }
    return makeResponse('semantic', hits, false);
  }

  // Hybrid RRF fusion (k = 60, normalized against ideal rank-1 in both lists = 2 / (k + 1)).
  const kwCandidates = await kwPromise;
  const kwByKey = new Map<string, { candidate: KeywordCandidate; rank: number }>();
  for (let i = 0; i < kwCandidates.length; i += 1) {
    const cand = kwCandidates[i]!;
    kwByKey.set(cand.key, { candidate: cand, rank: i + 1 });
  }

  const semByKey = new Map<string, { score: number; rank: number }>();
  const semanticNoiseFloor = minScore > 0 ? Math.min(minScore * 0.4, 0.1) : 0;
  let positiveSemRank = 0;
  for (const vecHit of semanticCandidates) {
    if (vecHit.score <= semanticNoiseFloor) continue;
    positiveSemRank += 1;
    semByKey.set(`${vecHit.docId}:${vecHit.chunkId}`, {
      score: vecHit.score,
      rank: positiveSemRank,
    });
  }

  const rrfK = RETRIEVAL_LIMITS.rrfK;
  const maxRrfRaw = 2 / (rrfK + 1);
  const allKeys = new Set<string>([...kwByKey.keys(), ...semByKey.keys()]);

  interface FusedEntry {
    chunk: SourceChunkRecord;
    rrfRaw: number;
    score: number;
    kwRank?: number;
    semRank?: number;
    sources: Array<'keyword' | 'semantic'>;
  }

  const fused: FusedEntry[] = [];

  for (const key of allKeys) {
    const chunk = chunkByKey.get(key);
    if (!chunk) continue;
    if (allowedDocIds && !allowedDocIds.has(chunk.docId)) continue;

    const kw = kwByKey.get(key);
    const sem = semByKey.get(key);
    if (!kw && !sem) continue;

    const rrfRaw =
      (kw ? 1 / (rrfK + kw.rank) : 0) + (sem ? 1 / (rrfK + sem.rank) : 0);
    const score = roundScore(rrfRaw / maxRrfRaw);
    if (score < minScore) continue;

    const sources: Array<'keyword' | 'semantic'> = [];
    if (kw) sources.push('keyword');
    if (sem) sources.push('semantic');

    fused.push({
      chunk,
      rrfRaw,
      score,
      ...(kw ? { kwRank: kw.rank } : {}),
      ...(sem ? { semRank: sem.rank } : {}),
      sources,
    });
  }

  fused.sort(
    (a, b) =>
      b.rrfRaw - a.rrfRaw ||
      Math.min(a.semRank ?? Number.POSITIVE_INFINITY, a.kwRank ?? Number.POSITIVE_INFINITY) -
        Math.min(b.semRank ?? Number.POSITIVE_INFINITY, b.kwRank ?? Number.POSITIVE_INFINITY) ||
      a.chunk.docId.localeCompare(b.chunk.docId) ||
      a.chunk.ord - b.chunk.ord ||
      a.chunk.chunkId - b.chunk.chunkId,
  );

  const hits: RetrievalHit[] = fused.slice(0, topK).map((entry) => ({
    docId: entry.chunk.docId,
    chunkId: entry.chunk.chunkId,
    ord: entry.chunk.ord,
    title: entry.chunk.title,
    snippet: makeSnippet(entry.chunk.text),
    text: entry.chunk.text,
    score: entry.score,
    ...(entry.kwRank !== undefined ? { keywordRank: entry.kwRank } : {}),
    ...(entry.semRank !== undefined ? { semanticRank: entry.semRank } : {}),
    sources: entry.sources,
  }));

  return makeResponse('hybrid', hits, false);
}
