import type { Request, Response } from 'express';
import {
  CITATIONS_HEADER_NAME,
  RETRIEVAL_HEADER_NAME,
  RETRIEVAL_LIMITS,
  type CitationEntry,
  type RetrievalHit,
  type RetrievalMode,
  type Wire,
} from '@freellmapi/shared/ai-platform-retrieval.js';
import { getRegistry } from '../../context-budget/registry.js';
import type { OutputFilter, OutputFilterContext } from '../wire/interceptor.js';

export type CitationOutputFilter = OutputFilter & {
  onResponseObject: (
    body: Record<string, unknown>,
    ctx?: OutputFilterContext,
  ) => Record<string, unknown> | void;
};

function makeSnippet(text: string, maxLen = 240): string {
  const normalized = String(text ?? '').trim().replace(/\s+/g, ' ');
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, maxLen - 1).trimEnd()}…`;
}

function roundScore(score: number): number {
  return Number.isFinite(score) ? Number(score.toFixed(4)) : 0;
}

/**
 * Formats the `x-freellm-retrieval` response header value (`<mode>[;degraded]`).
 */
export function formatRetrievalHeader(modeUsed: RetrievalMode, degraded: boolean): string {
  return degraded ? `${modeUsed};degraded` : modeUsed;
}

/**
 * Projects retrieval hits into compact citation entries suitable for headers and response JSON.
 */
export function buildCitations(hits: RetrievalHit[]): CitationEntry[] {
  return hits.map((hit) => ({
    docId: String(hit.docId),
    chunkId: Number(hit.chunkId),
    title: String(hit.title ?? ''),
    score: roundScore(hit.score),
    snippet: hit.snippet ? String(hit.snippet) : makeSnippet(hit.text),
  }));
}

function encodeBase64Url(items: CitationEntry[]): string {
  const compact = items.map((c) => ({
    docId: c.docId,
    chunkId: c.chunkId,
    title: c.title,
    score: roundScore(c.score),
    snippet: c.snippet,
  }));
  return Buffer.from(JSON.stringify(compact), 'utf8').toString('base64url');
}

function fitTextField(
  original: string,
  testFit: (candidateText: string) => boolean,
): string | null {
  if (testFit(original)) return original;
  const pts = Array.from(original);
  let lo = 0;
  let hi = pts.length;
  let best: string | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const candidate = mid === 0 ? '' : `${pts.slice(0, mid).join('').trimEnd()}…`;
    if (testFit(candidate)) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

function fitSingleCitation(entry: CitationEntry, maxBytes: number): CitationEntry | null {
  if (Buffer.byteLength(encodeBase64Url([entry]), 'utf8') <= maxBytes) {
    return entry;
  }
  const fittedSnippet = fitTextField(entry.snippet, (candidate) => {
    const encoded = encodeBase64Url([{ ...entry, snippet: candidate }]);
    return Buffer.byteLength(encoded, 'utf8') <= maxBytes;
  });
  if (fittedSnippet !== null) {
    return { ...entry, snippet: fittedSnippet };
  }

  const baseEntry: CitationEntry = { ...entry, snippet: '' };
  const fittedTitle = fitTextField(baseEntry.title, (candidate) => {
    const encoded = encodeBase64Url([{ ...baseEntry, title: candidate }]);
    return Buffer.byteLength(encoded, 'utf8') <= maxBytes;
  });
  if (fittedTitle !== null) {
    return { ...baseEntry, title: fittedTitle };
  }
  return null;
}

/**
 * Encodes citations as UTF-8 `base64url` JSON within `maxBytes` (default 4 KB),
 * trimming trailing entries first and truncating fields only if a single entry exceeds `maxBytes`.
 */
export function encodeCitationsHeader(
  citations: CitationEntry[],
  maxBytes: number = RETRIEVAL_LIMITS.citationsHeaderMaxBytes,
): string {
  if (maxBytes <= 0) return '';
  const list = citations.map((c) => ({ ...c }));
  while (list.length > 1 && Buffer.byteLength(encodeBase64Url(list), 'utf8') > maxBytes) {
    list.pop();
  }
  if (list.length === 1) {
    const encoded = encodeBase64Url(list);
    if (Buffer.byteLength(encoded, 'utf8') > maxBytes) {
      const fitted = fitSingleCitation(list[0]!, maxBytes);
      if (fitted) {
        list[0] = fitted;
      } else {
        list.pop();
      }
    }
  }
  const finalEncoded = encodeBase64Url(list);
  return Buffer.byteLength(finalEncoded, 'utf8') <= maxBytes ? finalEncoded : '';
}

/**
 * Applies `x-freellm-retrieval` and (when enabled and non-empty) `x-freellm-citations` headers.
 */
export function applyCitationsHeader(
  res: Response,
  citations: CitationEntry[],
  retrievalHeaderValue: string,
  opts?: { citationsEnabled?: boolean },
): void {
  if (res.headersSent) return;
  if (retrievalHeaderValue) {
    res.setHeader(RETRIEVAL_HEADER_NAME, retrievalHeaderValue);
  }
  if (opts?.citationsEnabled !== false && citations.length > 0) {
    const encoded = encodeCitationsHeader(citations);
    if (encoded) {
      res.setHeader(CITATIONS_HEADER_NAME, encoded);
    }
  }
}

/**
 * Builds an OutputFilter that attaches top-level `citations` to non-streaming JSON responses
 * for `'openai-chat'` and `'responses'` wires while leaving text and `'anthropic'`/`'gemini'` untouched.
 */
export function citationFilter(
  wire: Wire,
  hits: RetrievalHit[],
  opts?: { disabled?: boolean; allowedDocIds?: Set<string>; req?: Request },
): CitationOutputFilter | null {
  if (opts?.disabled) return null;
  const filteredHits = opts?.allowedDocIds
    ? hits.filter((hit) => opts.allowedDocIds!.has(String(hit.docId)))
    : hits;
  if (filteredHits.length === 0) return null;

  const citations = buildCitations(filteredHits);

  const filter: CitationOutputFilter = {
    name: 'citations',
    async onComplete(buf: string) {
      const result = { action: 'pass' as const, text: buf };
      return result;
    },
    onResponseObject(obj: Record<string, unknown>, ctx?: OutputFilterContext) {
      if (ctx?.blocked) {
        return undefined;
      }
      if (opts?.req && getRegistry(opts.req)?.knowledgeDropped) {
        return undefined;
      }
      if (wire !== 'openai-chat' && wire !== 'responses') {
        return undefined;
      }
      return {
        ...obj,
        citations,
      };
    },
  };
  return filter;
}
