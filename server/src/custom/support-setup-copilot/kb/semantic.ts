/**
 * Optional semantic layer for the Setup Copilot KB. Lazily embeds every chunk
 * in the background using the gateway's own embeddings service, then answers
 * queries by cosine similarity. It never blocks and never throws into chat:
 * when no embedding provider is configured (or a call fails) the KB keeps
 * working on BM25 alone, and a failed build is retried after a cool-off.
 */
import { permissionGranted, type Permission } from '@freellmapi/shared/permissions.js';
import { getKbCorpus } from './corpus.js';
import type { KbCaller, KbChunk, KbHit } from './types.js';

export interface KbEmbeddingsResult {
  vectors: number[][];
}
export type KbEmbeddingsRunner = (model: string | undefined, inputs: string[]) => Promise<KbEmbeddingsResult>;

const BATCH = 48;
const INPUT_CHARS = 1500;
const QUERY_TIMEOUT_MS = 4000;
const RETRY_AFTER_MS = 15 * 60_000;

let testRunner: KbEmbeddingsRunner | null = null;
type Status = 'idle' | 'building' | 'ready' | 'failed';
let status: Status = 'idle';
let failedAt = 0;
let vectors = new Map<string, Float32Array>();
let building: Promise<void> | null = null;

export function setKbEmbeddingsRunnerForTests(fn: KbEmbeddingsRunner | null): void {
  testRunner = fn;
  resetKbSemanticForTests();
}

export function resetKbSemanticForTests(): void {
  status = 'idle';
  failedAt = 0;
  vectors = new Map();
  building = null;
}

export function getKbSemanticStatus(): Status {
  return status;
}

function semanticDisabled(): boolean {
  if (process.env.COPILOT_KB_SEMANTIC === '0') return true;
  // Unit tests must not reach for a real embeddings provider unless they inject one.
  return Boolean(process.env.VITEST) && !testRunner;
}

async function getRunner(): Promise<KbEmbeddingsRunner> {
  if (testRunner) return testRunner;
  const { runEmbeddings } = await import('../../../services/embeddings.js');
  return (model, inputs) => runEmbeddings(model, inputs);
}

function unit(vec: number[]): Float32Array {
  const out = new Float32Array(vec.length);
  let norm = 0;
  for (let i = 0; i < vec.length; i += 1) norm += vec[i]! * vec[i]!;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < vec.length; i += 1) out[i] = vec[i]! / norm;
  return out;
}

function chunkInput(c: KbChunk): string {
  return `${c.title}${c.titleVi ? ` / ${c.titleVi}` : ''}\n${c.text}${c.textVi ? `\n${c.textVi}` : ''}`.slice(0, INPUT_CHARS);
}

async function buildIndex(): Promise<void> {
  const run = await getRunner();
  const corpus = getKbCorpus();
  const next = new Map<string, Float32Array>();
  for (let i = 0; i < corpus.length; i += BATCH) {
    const batch = corpus.slice(i, i + BATCH);
    const res = await run(undefined, batch.map(chunkInput));
    if (res.vectors.length !== batch.length) throw new Error('Embeddings returned an unexpected vector count.');
    batch.forEach((c, j) => next.set(c.id, unit(res.vectors[j]!)));
  }
  vectors = next;
  status = 'ready';
}

/** Start the background build once (or again after the cool-off). Never throws. */
export function kickoffKbSemanticIndex(): void {
  if (semanticDisabled() || status === 'building' || status === 'ready') return;
  if (status === 'failed' && Date.now() - failedAt < RETRY_AFTER_MS) return;
  status = 'building';
  building = buildIndex().catch(() => {
    status = 'failed';
    failedAt = Date.now();
  });
}

export async function waitForKbSemanticIndexForTests(): Promise<void> {
  await building;
}

/** Cosine-ranked hits, or null when the semantic layer is not ready / unavailable. */
export async function searchKbSemantic(
  query: string,
  options: { caller?: KbCaller; limit: number },
): Promise<KbHit[] | null> {
  kickoffKbSemanticIndex();
  if (status !== 'ready') return null;
  try {
    const run = await getRunner();
    const res = await Promise.race([
      run(undefined, [query.slice(0, INPUT_CHARS)]),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), QUERY_TIMEOUT_MS)),
    ]);
    const q = unit(res.vectors[0]!);
    const hits: KbHit[] = [];
    for (const chunk of getKbCorpus()) {
      if (chunk.requiredPermission && !(options.caller && permissionGranted(options.caller, chunk.requiredPermission as Permission))) continue;
      const v = vectors.get(chunk.id);
      if (!v || v.length !== q.length) continue;
      let dot = 0;
      for (let i = 0; i < v.length; i += 1) dot += v[i]! * q[i]!;
      hits.push({ chunk, score: dot, via: ['semantic'] });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, options.limit);
  } catch {
    return null;
  }
}
