import type { Request } from 'express';
import type { ConversationSettings } from '@freellmapi/shared/conversations.js';
import { getDb } from '../db/index.js';
import { decrypt } from '../lib/crypto.js';
import { foldableTurns, saveSummary } from '../services/profile-conversations.js';

// Running summaries of long stored conversations. After a turn is stored, the turns that no longer fit
// the key's history window are folded into the conversation's summary by one model call made with the
// key itself over the loopback (like "Send test"), so it obeys and counts against the key's limits and
// shows in its numbers. Runs in the background after the response; one at a time per conversation.

export const SUMMARY_USER_AGENT = 'freellm-conversation-summary';
const TIMEOUT_MS = 60_000;
const inFlight = new Set<number>();

/** The address this server's connection arrived on, as a host the loopback call can dial. */
function selfHost(req: Request): { host: string; port: number } {
  const address = (req.socket.localAddress ?? '').replace(/^::ffff:/i, '');
  const host = !address || address === '::' || address === '0.0.0.0' ? '127.0.0.1' : address.includes(':') ? `[${address}]` : address;
  return { host, port: req.socket.localPort ?? 0 };
}

export function summaryPrompt(previous: string | null, turns: Array<{ role: string; content: string }>): Array<{ role: string; content: string }> {
  const transcript = turns.map(t => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`).join('\n\n');
  return [
    {
      role: 'system',
      content: 'You keep a running summary of a chat between a website visitor and its assistant. Write it in the language of the chat, '
        + 'at most 200 words, as plain notes: who the visitor is, facts and preferences they gave, what was asked and answered, and anything still open. '
        + 'Keep names, numbers, order ids and dates exactly. Output only the summary.',
    },
    { role: 'user', content: `${previous ? `Summary so far:\n${previous}\n\n` : ''}Newer part of the chat:\n${transcript}\n\nWrite the updated summary.` },
  ];
}

/** Fold what no longer fits into the summary; resolves when done (never rejects). */
export async function summarizeConversation(profileId: number, conversationId: number, s: ConversationSettings, target: { host: string; port: number }): Promise<boolean> {
  if (inFlight.has(conversationId)) return false;
  inFlight.add(conversationId);
  try {
    const fold = foldableTurns(conversationId, s);
    if (!fold) return false;
    const row = getDb().prepare('SELECT encrypted_key, iv, auth_tag FROM client_profiles WHERE id = ? AND enabled = 1').get(profileId) as { encrypted_key: string; iv: string; auth_tag: string } | undefined;
    if (!row) return false;
    const key = decrypt(row.encrypted_key, row.iv, row.auth_tag);
    const res = await fetch(`http://${target.host}:${target.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'user-agent': SUMMARY_USER_AGENT, host: `127.0.0.1:${target.port}` },
      body: JSON.stringify({ model: 'auto', max_tokens: 500, messages: summaryPrompt(fold.summary, fold.turns) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const body = await res.json().catch(() => null) as { choices?: Array<{ message?: { content?: unknown } }> } | null;
    const text = body?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) return false;
    saveSummary(conversationId, text.trim(), fold.turns[fold.turns.length - 1]!.id);
    return true;
  } catch (err) {
    console.warn('[conversations] summary failed:', err instanceof Error ? err.message : err);
    return false;
  } finally {
    inFlight.delete(conversationId);
  }
}

/** Start a background summary after this request's turn was stored. */
export function scheduleSummary(req: Request, profileId: number, conversationId: number, s: ConversationSettings): void {
  if (!s.summarize) return;
  const target = selfHost(req);
  setImmediate(() => { void summarizeConversation(profileId, conversationId, s, target); });
}
