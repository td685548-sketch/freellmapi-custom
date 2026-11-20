import { searchKbLexical } from './retrieval.js';
import { kickoffKbSemanticIndex, searchKbSemantic } from './semantic.js';
import type { KbHit, KbSearchOptions } from './types.js';

export type { KbChunk, KbHit, KbCaller, KbSearchOptions, KbSource } from './types.js';
export { getKbCorpus, getKbChunkById } from './corpus.js';
export { searchKbLexical } from './retrieval.js';
export { formatKbForPrompt, buildKbQueryFromMessages } from './prompt.js';

const RRF_K = 60;
const DEFAULT_LIMIT = 5;

/**
 * Hybrid retrieval: BM25 always; when the semantic layer is ready its ranking
 * is fused in (reciprocal-rank fusion). Safe to call on every chat turn.
 */
export async function searchKb(query: string, options: KbSearchOptions = {}): Promise<KbHit[]> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  kickoffKbSemanticIndex();
  const lexical = searchKbLexical(query, { ...options, limit: limit * 3 });
  const semantic = await searchKbSemantic(query, { caller: options.caller, limit: limit * 3 });
  if (!semantic || semantic.length === 0) return lexical.slice(0, limit);

  const fused = new Map<string, KbHit>();
  const add = (hits: KbHit[], via: 'lexical' | 'semantic'): void => {
    hits.forEach((hit, rank) => {
      const prev = fused.get(hit.chunk.id);
      const gain = 1 / (RRF_K + rank + 1);
      if (prev) {
        prev.score += gain;
        if (!prev.via.includes(via)) prev.via.push(via);
      } else {
        fused.set(hit.chunk.id, { chunk: hit.chunk, score: gain, via: [via] });
      }
    });
  };
  add(lexical, 'lexical');
  add(semantic, 'semantic');
  return [...fused.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
