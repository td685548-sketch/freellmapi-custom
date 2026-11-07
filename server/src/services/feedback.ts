import { getDb } from '../db/index.js';
import { FEEDBACK_LIMITS as L, type FeedbackComment, type FeedbackSummary } from '@freellmapi/shared/feedback.js';

// Visitors' thumbs up / down on a client key's replies, reported by the web app's backend. A vote with a
// reference replaces an earlier vote on the same reply. Kept one year, pruned hourly from a write.

const DAY_MS = 86_400_000;
let lastPruneAt = 0;

export interface FeedbackInput {
  rating: 1 | -1
  comment: string | null
  model: string | null
  endUser: string | null
  conversationId: string | null
  reference: string | null
}

export function recordFeedback(profileId: number, f: FeedbackInput, now = Date.now()): number {
  const db = getDb();
  const at = new Date(now).toISOString();
  const params = [profileId, f.rating, f.comment, f.model, f.endUser, f.conversationId, f.reference, at];
  let id: number;
  if (f.reference) {
    db.prepare(`INSERT INTO custom_feedback (profile_id, rating, comment, model, end_user, conversation_key, reference, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(profile_id, reference) WHERE reference IS NOT NULL DO UPDATE SET rating = excluded.rating, comment = excluded.comment, model = COALESCE(excluded.model, model),
        end_user = COALESCE(excluded.end_user, end_user), conversation_key = COALESCE(excluded.conversation_key, conversation_key), created_at = excluded.created_at`).run(...params);
    id = (db.prepare('SELECT id FROM custom_feedback WHERE profile_id = ? AND reference = ?').get(profileId, f.reference) as { id: number }).id;
  } else {
    id = Number(db.prepare('INSERT INTO custom_feedback (profile_id, rating, comment, model, end_user, conversation_key, reference, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(...params).lastInsertRowid);
  }
  if (now - lastPruneAt > 60 * 60 * 1000) {
    lastPruneAt = now;
    db.prepare('DELETE FROM custom_feedback WHERE created_at < ?').run(new Date(now - L.retentionDays * DAY_MS).toISOString());
  }
  return id;
}

export function feedbackSummary(profileId: number, days: number, now = Date.now()): FeedbackSummary {
  const db = getDb();
  const since = new Date(now - days * DAY_MS).toISOString();
  const totals = db.prepare('SELECT COALESCE(SUM(rating = 1), 0) AS up, COALESCE(SUM(rating = -1), 0) AS down FROM custom_feedback WHERE profile_id = ? AND created_at >= ?')
    .get(profileId, since) as { up: number; down: number };
  const byModel = db.prepare(`SELECT model, SUM(rating = 1) AS up, SUM(rating = -1) AS down FROM custom_feedback WHERE profile_id = ? AND created_at >= ?
    GROUP BY model ORDER BY COUNT(*) DESC LIMIT 50`).all(profileId, since) as FeedbackSummary['byModel'];
  const byDay = db.prepare(`SELECT substr(created_at, 1, 10) AS day, SUM(rating = 1) AS up, SUM(rating = -1) AS down FROM custom_feedback WHERE profile_id = ? AND created_at >= ?
    GROUP BY day ORDER BY day`).all(profileId, since) as FeedbackSummary['byDay'];
  return { days, up: totals.up, down: totals.down, byModel, byDay };
}

/** Newest votes that carry a comment. */
export function feedbackComments(profileId: number, rating: 'up' | 'down' | null = null): FeedbackComment[] {
  const rows = getDb().prepare(`SELECT id, rating, comment, model, end_user AS endUser, conversation_key AS conversationId, created_at AS createdAt FROM custom_feedback
    WHERE profile_id = ? AND comment IS NOT NULL AND comment != ''${rating ? ' AND rating = ?' : ''} ORDER BY id DESC LIMIT ?`)
    .all(...(rating ? [profileId, rating === 'up' ? 1 : -1, L.commentListLimit] : [profileId, L.commentListLimit])) as Array<Omit<FeedbackComment, 'rating'> & { rating: number }>;
  return rows.map(r => ({ ...r, rating: r.rating === 1 ? 'up' : 'down' }));
}

/** Tests only. */
export function resetFeedbackPrune(): void { lastPruneAt = 0; }
