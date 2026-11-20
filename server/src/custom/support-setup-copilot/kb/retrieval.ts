import { permissionGranted, type Permission } from '@freellmapi/shared/permissions.js';
import { getKbCorpus } from './corpus.js';
import { expandQueryTerms } from './synonyms.js';
import type { KbCaller, KbChunk, KbHit, KbSearchOptions } from './types.js';

const K1 = 1.4;
const B = 0.75;
const FIELD_BOOST = 3; // title + tags are repeated this many times in the indexed text
const DEFAULT_LIMIT = 5;
const MIN_RELATIVE_SCORE = 0.3;

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'to', 'of', 'and', 'or', 'in', 'on', 'for', 'my', 'me', 'i', 'it', 'this', 'that', 'do', 'does', 'how', 'can', 'what',
  'la', 'va', 'cua', 'cho', 'toi', 'minh', 'ban', 'nay', 'nao', 'gi', 'khong', 'co', 'duoc', 'the', 'thi', 'hay', 'cac', 'nhung', 'mot', 'voi', 'de', 'o',
]);

/** NFD, strip combining marks, lowercase, map Vietnamese đ → d. */
export function normalizeKbText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/đ/gu, 'd');
}

/** Tokens keep snake_case identifiers whole AND their parts (`edit_cache` → edit_cache, edit, cache). */
export function tokenizeKb(text: string): string[] {
  const normalized = normalizeKbText(text);
  const raw = normalized.match(/[\p{L}\p{N}_]+/gu) ?? [];
  const out: string[] = [];
  for (const token of raw) {
    out.push(token);
    if (token.includes('_')) {
      for (const part of token.split('_')) if (part.length > 1) out.push(part);
    }
  }
  return out;
}

interface IndexedChunk {
  chunk: KbChunk;
  tf: Map<string, number>;
  length: number;
}

interface Index {
  docs: IndexedChunk[];
  df: Map<string, number>;
  avgLen: number;
}

let index: Index | null = null;

function buildIndex(): Index {
  const docs: IndexedChunk[] = [];
  const df = new Map<string, number>();
  let totalLen = 0;
  for (const chunk of getKbCorpus()) {
    const head = `${chunk.title} ${chunk.titleVi ?? ''} ${chunk.tags.join(' ')}`;
    const body = `${chunk.text} ${chunk.textVi ?? ''}`;
    const tokens = [
      ...Array.from({ length: FIELD_BOOST }, () => tokenizeKb(head)).flat(),
      ...tokenizeKb(body),
    ];
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    docs.push({ chunk, tf, length: tokens.length });
    totalLen += tokens.length;
  }
  return { docs, df, avgLen: docs.length ? totalLen / docs.length : 1 };
}

function getIndex(): Index {
  if (!index) index = buildIndex();
  return index;
}

export function resetKbIndexForTests(): void {
  index = null;
}

export function canCallerSeeChunk(chunk: KbChunk, caller: KbCaller | undefined): boolean {
  if (!chunk.requiredPermission) return true;
  if (!caller) return false;
  return permissionGranted(caller, chunk.requiredPermission as Permission);
}

export function buildQueryTerms(query: string): { terms: string[]; expanded: string[] } {
  const normalized = normalizeKbText(query);
  const terms = [...new Set(tokenizeKb(query).filter((t) => (t.length > 1 || /^\d$/.test(t)) && !STOPWORDS.has(t)))];
  const expanded = expandQueryTerms(normalized, terms).filter((t) => !STOPWORDS.has(t));
  return { terms, expanded };
}

/** BM25 over the whole corpus, filtered to what the caller may see. */
export function searchKbLexical(query: string, options: KbSearchOptions = {}): KbHit[] {
  const { terms, expanded } = buildQueryTerms(query);
  if (terms.length === 0 && expanded.length === 0) return [];
  const idx = getIndex();
  const n = idx.docs.length;
  const idf = (t: string): number => {
    const d = idx.df.get(t) ?? 0;
    return Math.log(1 + (n - d + 0.5) / (d + 0.5));
  };

  const scored: KbHit[] = [];
  for (const doc of idx.docs) {
    if (!canCallerSeeChunk(doc.chunk, options.caller)) continue;
    let score = 0;
    const part = (t: string, weight: number): void => {
      const f = doc.tf.get(t);
      if (!f) return;
      score += weight * idf(t) * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * doc.length) / idx.avgLen)));
    };
    for (const t of terms) part(t, 1);
    for (const t of expanded) part(t, 0.5);
    if (score <= 0) continue;
    if (options.currentPath && doc.chunk.path && options.currentPath.startsWith(doc.chunk.path)) score *= 1.25;
    scored.push({ chunk: doc.chunk, score, via: ['lexical'] });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0]?.score ?? 0;
  const limit = options.limit ?? DEFAULT_LIMIT;
  return scored.filter((h) => h.score >= top * MIN_RELATIVE_SCORE).slice(0, limit);
}
