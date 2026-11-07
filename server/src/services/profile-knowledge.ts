import { getDb } from '../db/index.js';
import { KNOWLEDGE_LIMITS, type KnowledgeDoc, type KnowledgeHit, type KnowledgeSettings } from '@freellmapi/shared/knowledge.js';

// A knowledge base per client profile: documents split into passages, and a small BM25 keyword search
// over them, held in memory per profile (rebuilt from the database after any change, and lazily once
// per process). No embeddings: no extra provider call, no extra cost, and it works for any language
// that separates words with spaces or punctuation (Vietnamese included).

const CHUNK_CHARS = 800;
/** Passages scoring under this share of the best one are left out. */
const MIN_RELATIVE_SCORE = 0.25;

/** Split a document into passages of about CHUNK_CHARS, on paragraph and then sentence boundaries. */
export function chunkText(content: string): string[] {
  const paragraphs = content.replace(/\r\n?/g, '\n').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  const pieces: string[] = [];
  for (const p of paragraphs) {
    if (p.length <= CHUNK_CHARS) { pieces.push(p); continue; }
    let current = '';
    for (const sentence of p.split(/(?<=[.!?。])\s+|\n/)) {
      if (current && current.length + sentence.length + 1 > CHUNK_CHARS) { pieces.push(current); current = ''; }
      if (sentence.length > CHUNK_CHARS) {
        for (let i = 0; i < sentence.length; i += CHUNK_CHARS) pieces.push(sentence.slice(i, i + CHUNK_CHARS));
      } else current = current ? `${current} ${sentence}` : sentence;
    }
    if (current) pieces.push(current);
  }
  // Pack short neighbours together so a passage carries enough context.
  const chunks: string[] = [];
  for (const piece of pieces) {
    const last = chunks[chunks.length - 1];
    if (last !== undefined && last.length + piece.length + 2 <= CHUNK_CHARS) chunks[chunks.length - 1] = `${last}\n\n${piece}`;
    else chunks.push(piece);
  }
  return chunks;
}

export function tokenize(text: string): string[] {
  return (text.normalize('NFC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(t => t.length >= 2);
}

interface IndexedChunk { docId: number; title: string; text: string; terms: Map<string, number>; length: number }
interface ProfileIndex { chunks: IndexedChunk[]; df: Map<string, number>; avgLength: number }
const indexes = new Map<number, ProfileIndex>();

/** Tests only. */
export function resetKnowledgeIndexes(): void { indexes.clear(); }

function indexOf(profileId: number): ProfileIndex {
  const hit = indexes.get(profileId);
  if (hit) return hit;
  const rows = getDb().prepare(`
    SELECT c.doc_id AS docId, d.title AS title, c.text AS text
    FROM custom_knowledge_chunks c JOIN custom_knowledge_docs d ON d.id = c.doc_id
    WHERE c.profile_id = ? ORDER BY c.doc_id, c.ord
  `).all(profileId) as Array<{ docId: number; title: string; text: string }>;
  const df = new Map<string, number>();
  const chunks = rows.map(r => {
    const terms = new Map<string, number>();
    const tokens = tokenize(`${r.title} ${r.text}`);
    for (const t of tokens) terms.set(t, (terms.get(t) ?? 0) + 1);
    for (const t of terms.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    return { docId: r.docId, title: r.title, text: r.text, terms, length: tokens.length };
  });
  const index = { chunks, df, avgLength: chunks.length ? chunks.reduce((n, c) => n + c.length, 0) / chunks.length : 1 };
  indexes.set(profileId, index);
  return index;
}

/** The passages that best answer `query`, best first, within `maxChars` of passage text. */
export function searchKnowledge(profileId: number, query: string, maxChars: number): KnowledgeHit[] {
  const index = indexOf(profileId);
  const q = [...new Set(tokenize(query))];
  if (q.length === 0 || index.chunks.length === 0) return [];
  const n = index.chunks.length;
  const k1 = 1.2;
  const b = 0.75;
  const scored = index.chunks.map(c => {
    let score = 0;
    for (const t of q) {
      const tf = c.terms.get(t);
      if (!tf) continue;
      const df = index.df.get(t) ?? 0;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (c.length / index.avgLength)));
    }
    return { c, score };
  }).filter(x => x.score > 0).sort((a, b2) => b2.score - a.score);
  // A passage that shares only a common word with the question is noise next to a strong match.
  const best = scored[0]?.score ?? 0;
  const relevant = scored.filter(x => x.score >= best * MIN_RELATIVE_SCORE);
  const hits: KnowledgeHit[] = [];
  let used = 0;
  for (const { c, score } of relevant) {
    if (used + c.text.length > maxChars) { if (hits.length === 0) hits.push({ docId: c.docId, title: c.title, text: c.text.slice(0, maxChars), score }); break; }
    hits.push({ docId: c.docId, title: c.title, text: c.text, score: Math.round(score * 1000) / 1000 });
    used += c.text.length;
  }
  return hits;
}

/** The reference block added to a request, or null when nothing matched. */
export function knowledgeBlock(hits: KnowledgeHit[]): string | null {
  if (hits.length === 0) return null;
  return [
    'Reference material from this website. Use it when it answers the question; if it does not, answer normally. Do not mention that you were given it.',
    ...hits.map(h => `### ${h.title}\n${h.text}`),
  ].join('\n\n');
}

// ── documents and settings ────────────────────────────────────────────────

export function getKnowledgeSettings(profileId: number): KnowledgeSettings | null {
  const row = getDb().prepare('SELECT kb_enabled AS enabled, kb_max_chars AS maxChars FROM client_profiles WHERE id = ?')
    .get(profileId) as { enabled: number; maxChars: number | null } | undefined;
  return row ? { enabled: row.enabled === 1, maxChars: row.maxChars ?? KNOWLEDGE_LIMITS.defaultMaxChars } : null;
}

export function setKnowledgeSettings(profileId: number, next: KnowledgeSettings): void {
  getDb().prepare('UPDATE client_profiles SET kb_enabled = ?, kb_max_chars = ? WHERE id = ?').run(next.enabled ? 1 : 0, next.maxChars, profileId);
}

export function listDocs(profileId: number): KnowledgeDoc[] {
  return getDb().prepare(`
    SELECT d.id, d.title, d.content, LENGTH(d.content) AS size, d.updated_at AS updatedAt,
           (SELECT COUNT(*) FROM custom_knowledge_chunks c WHERE c.doc_id = d.id) AS chunks
    FROM custom_knowledge_docs d WHERE d.profile_id = ? ORDER BY d.id
  `).all(profileId) as KnowledgeDoc[];
}

export function docCount(profileId: number): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM custom_knowledge_docs WHERE profile_id = ?').get(profileId) as { n: number }).n;
}

function writeChunks(profileId: number, docId: number, content: string): void {
  const db = getDb();
  db.prepare('DELETE FROM custom_knowledge_chunks WHERE doc_id = ?').run(docId);
  const chunks = chunkText(content);
  const insert = db.prepare('INSERT INTO custom_knowledge_chunks (doc_id, profile_id, ord, text) VALUES (?, ?, ?, ?)');
  chunks.forEach((text, i) => insert.run(docId, profileId, i, text));
}

export function addDoc(profileId: number, title: string, content: string): number {
  const db = getDb();
  let id = 0;
  db.transaction(() => {
    id = Number(db.prepare('INSERT INTO custom_knowledge_docs (profile_id, title, content) VALUES (?, ?, ?)').run(profileId, title, content).lastInsertRowid);
    writeChunks(profileId, id, content);
  })();
  indexes.delete(profileId);
  return id;
}

export function updateDoc(profileId: number, docId: number, title: string, content: string): boolean {
  const db = getDb();
  let changed = false;
  db.transaction(() => {
    changed = db.prepare("UPDATE custom_knowledge_docs SET title = ?, content = ?, updated_at = datetime('now') WHERE id = ? AND profile_id = ?")
      .run(title, content, docId, profileId).changes > 0;
    if (changed) writeChunks(profileId, docId, content);
  })();
  indexes.delete(profileId);
  return changed;
}

export function deleteDoc(profileId: number, docId: number): boolean {
  const db = getDb();
  let changed = false;
  db.transaction(() => {
    changed = db.prepare('DELETE FROM custom_knowledge_docs WHERE id = ? AND profile_id = ?').run(docId, profileId).changes > 0;
    if (changed) db.prepare('DELETE FROM custom_knowledge_chunks WHERE doc_id = ?').run(docId);
  })();
  indexes.delete(profileId);
  return changed;
}
