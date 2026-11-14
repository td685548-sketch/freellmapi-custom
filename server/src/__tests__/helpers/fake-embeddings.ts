/**
 * fake-embeddings.ts
 *
 * Deterministic, synchronous, in-process fake embeddings for tests.
 * No I/O, no real ML model, no randomness beyond seeded determinism.
 *
 * Algorithm:
 *   1. Hash the input text with djb2 to get a 32-bit seed.
 *   2. Use a xorshift32 PRNG seeded from that hash to fill a Float32Array.
 *   3. Normalize the vector to unit length.
 *
 * The same text always produces the same vector; different texts almost always
 * produce distinct vectors (collision probability is negligible for test sets).
 */

// ---------------------------------------------------------------------------
// djb2 hash → 32-bit unsigned integer seed
// ---------------------------------------------------------------------------

function djb2(text: string): number {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    // hash * 33 XOR charCode
    hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
    hash = hash >>> 0; // keep as uint32
  }
  return hash === 0 ? 1 : hash; // xorshift32 must not start at 0
}

// ---------------------------------------------------------------------------
// xorshift32 PRNG
// ---------------------------------------------------------------------------

function xorshift32(seed: number): () => number {
  let state = seed >>> 0;
  if (state === 0) state = 1;
  return function next(): number {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state = state >>> 0;
    // Map uint32 to [-1, 1)
    return (state / 0x100000000) * 2 - 1;
  };
}

// ---------------------------------------------------------------------------
// Core embedding
// ---------------------------------------------------------------------------

/**
 * Returns a deterministic unit-normalized Float32Array of length `dims`
 * for the given text string.
 *
 * @param text - Input text to embed.
 * @param dims - Embedding dimension (default 768).
 */
export function fakeEmbed(text: string, dims = 768): Float32Array {
  const seed = djb2(text);
  const rand = xorshift32(seed);
  const vec = new Float32Array(dims);

  for (let i = 0; i < dims; i++) {
    vec[i] = rand();
  }

  // L2 normalize
  let norm = 0;
  for (let i = 0; i < dims; i++) {
    norm += vec[i] * vec[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dims; i++) {
      vec[i] /= norm;
    }
  }

  return vec;
}

/**
 * Embed a batch of texts. Each text is embedded independently.
 *
 * @param texts - Array of input texts.
 * @param dims  - Embedding dimension (default 768).
 */
export function fakeEmbedBatch(texts: string[], dims = 768): Float32Array[] {
  return texts.map((t) => fakeEmbed(t, dims));
}

/**
 * Cosine similarity between two unit-normalised vectors.
 * Returns a value in [-1, 1].
 *
 * @param a - First vector (must have same length as b).
 * @param b - Second vector.
 */
export function cosineSim(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new RangeError(
      `cosineSim: vector length mismatch (${a.length} vs ${b.length})`,
    );
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
