import { getDb } from '../db/index.js';
import { QUICK_ANSWER_LIMITS as L, type QuickAnswer, type QuickAnswerSettings } from '@freellmapi/shared/quick-answers.js';

// Ready answers of a client key. A visitor's latest message is compared with every question of the key's
// enabled answers by word overlap (Dice coefficient over the sets of words), with case, punctuation and
// Vietnamese accents ignored ("phi ship bao nhieu" matches "Phí ship bao nhiêu?"). The questions are
// held in memory per key and rebuilt after any change, so a check costs no database read.

/** Lowercase words with accents removed (đ becomes d). */
export function foldWords(text: string): string[] {
  const folded = text.normalize('NFD').replace(/\p{M}+/gu, '').replace(/đ/gi, 'd').toLowerCase();
  return folded.match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** 0..1: how much two texts share their words. Identical word sets give 1. */
export function similarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let common = 0;
  for (const w of sa) if (sb.has(w)) common++;
  return (2 * common) / (sa.size + sb.size);
}

interface Entry { id: number; answer: string; questions: string[][] }
const cache = new Map<number, Entry[]>();
const invalidate = (profileId: number) => cache.delete(profileId);

/** Tests only. */
export function resetQuickAnswerCache(): void { cache.clear(); }

function parseQuestions(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((q): q is string => typeof q === 'string') : [];
  } catch { return []; }
}

function entries(profileId: number): Entry[] {
  let list = cache.get(profileId);
  if (!list) {
    const rows = getDb().prepare('SELECT id, questions, answer FROM custom_quick_answers WHERE profile_id = ? AND enabled = 1 ORDER BY id').all(profileId) as Array<{ id: number; questions: string; answer: string }>;
    list = rows.map(r => ({ id: r.id, answer: r.answer, questions: parseQuestions(r.questions).map(foldWords).filter(w => w.length > 0) }));
    cache.set(profileId, list);
  }
  return list;
}

/** The best-matching ready answer at or above the threshold, or null. Ties go to the older answer. */
export function findQuickAnswer(profileId: number, message: string, minSimilarity: number): { id: number; answer: string; score: number } | null {
  const words = foldWords(message);
  if (words.length === 0) return null;
  let best: { id: number; answer: string; score: number } | null = null;
  for (const e of entries(profileId)) {
    for (const q of e.questions) {
      const score = similarity(words, q);
      if (score * 100 >= minSimilarity && (!best || score > best.score)) best = { id: e.id, answer: e.answer, score };
    }
  }
  return best;
}

export function noteHit(id: number): void {
  getDb().prepare('UPDATE custom_quick_answers SET hits = hits + 1, last_hit_at = ? WHERE id = ?').run(new Date().toISOString(), id);
}

// --- Settings and CRUD -----------------------------------------------------------------------------

const clampSimilarity = (v: number | null) => (typeof v === 'number' && Number.isInteger(v) ? Math.max(L.minMinSimilarity, Math.min(L.maxMinSimilarity, v)) : L.defaultMinSimilarity);

export const QUICK_ANSWER_COLUMNS = 'qa_enabled AS qaEnabled, qa_min_similarity AS qaMinSimilarity';
export function quickAnswerSettingsFromRow(row: { qaEnabled: number | null; qaMinSimilarity: number | null }): QuickAnswerSettings {
  return { enabled: row.qaEnabled === 1, minSimilarity: clampSimilarity(row.qaMinSimilarity) };
}

/** Null when the profile does not exist. */
export function getQuickAnswerSettings(profileId: number): QuickAnswerSettings | null {
  const row = getDb().prepare(`SELECT ${QUICK_ANSWER_COLUMNS} FROM client_profiles WHERE id = ?`).get(profileId) as { qaEnabled: number; qaMinSimilarity: number | null } | undefined;
  return row ? quickAnswerSettingsFromRow(row) : null;
}

export function setQuickAnswerSettings(profileId: number, s: QuickAnswerSettings): void {
  getDb().prepare('UPDATE client_profiles SET qa_enabled = ?, qa_min_similarity = ? WHERE id = ?').run(s.enabled ? 1 : 0, clampSimilarity(s.minSimilarity), profileId);
}

type Row = { id: number; questions: string; answer: string; enabled: number; hits: number; lastHitAt: string | null; updatedAt: string };
const toAnswer = (r: Row): QuickAnswer => ({ id: r.id, questions: parseQuestions(r.questions), answer: r.answer, enabled: r.enabled === 1, hits: r.hits, lastHitAt: r.lastHitAt, updatedAt: r.updatedAt });

export function listQuickAnswers(profileId: number): QuickAnswer[] {
  return (getDb().prepare('SELECT id, questions, answer, enabled, hits, last_hit_at AS lastHitAt, updated_at AS updatedAt FROM custom_quick_answers WHERE profile_id = ? ORDER BY id').all(profileId) as Row[]).map(toAnswer);
}

export function countQuickAnswers(profileId: number): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM custom_quick_answers WHERE profile_id = ?').get(profileId) as { n: number }).n;
}

const cleanQuestions = (qs: string[]) => [...new Set(qs.map(q => q.trim()).filter(Boolean))].slice(0, L.maxQuestions);

export function addQuickAnswer(profileId: number, questions: string[], answer: string, enabled = true): number {
  const id = Number(getDb().prepare('INSERT INTO custom_quick_answers (profile_id, questions, answer, enabled, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(profileId, JSON.stringify(cleanQuestions(questions)), answer.trim(), enabled ? 1 : 0, new Date().toISOString()).lastInsertRowid);
  invalidate(profileId);
  return id;
}

export function updateQuickAnswer(profileId: number, id: number, next: { questions?: string[]; answer?: string; enabled?: boolean }): boolean {
  const current = getDb().prepare('SELECT questions, answer, enabled FROM custom_quick_answers WHERE id = ? AND profile_id = ?').get(id, profileId) as { questions: string; answer: string; enabled: number } | undefined;
  if (!current) return false;
  getDb().prepare('UPDATE custom_quick_answers SET questions = ?, answer = ?, enabled = ?, updated_at = ? WHERE id = ?').run(
    next.questions ? JSON.stringify(cleanQuestions(next.questions)) : current.questions,
    next.answer !== undefined ? next.answer.trim() : current.answer,
    next.enabled === undefined ? current.enabled : next.enabled ? 1 : 0,
    new Date().toISOString(), id,
  );
  invalidate(profileId);
  return true;
}

export function deleteQuickAnswer(profileId: number, id: number): boolean {
  const ok = getDb().prepare('DELETE FROM custom_quick_answers WHERE id = ? AND profile_id = ?').run(id, profileId).changes > 0;
  invalidate(profileId);
  return ok;
}
