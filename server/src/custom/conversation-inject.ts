import type { Request, Response } from 'express';
import type { ConversationSettings } from '@freellmapi/shared/conversations.js';
import { appendTurn, loadHistory, normalizeConversationId } from '../services/profile-conversations.js';
import { scheduleSummary } from './conversation-summary.js';

// Server-side conversations for client keys. The web app sends `X-Conversation-Id` with only the new
// message(s); the stored earlier turns are put in front of them, and once the reply has completed the
// turn is stored. Plain user/assistant text only, on /v1/chat/completions and /v1/messages.

type Wire = 'chat' | 'anthropic';
type Turn = { role: 'user' | 'assistant'; content: string };

/** Largest response body read back for the stored reply; a longer one is simply not stored. */
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;

function wireOf(req: Request): Wire | null {
  if (req.method !== 'POST') return null;
  const path = req.originalUrl.split('?')[0]!.replace(/\/+$/, '');
  if (path === '/v1/chat/completions') return 'chat';
  if (path === '/v1/messages') return 'anthropic';
  return null;
}

/** Text of a message content (string, or the text parts of an array); null when it is not plain text. */
function textOf(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const p of content as Array<Record<string, unknown>>) {
    if (!p || typeof p !== 'object') return null;
    if (p.type === 'text' && typeof p.text === 'string') parts.push(p.text);
    else if (p.type === 'image_url' || p.type === 'image' || p.type === 'input_image') continue; // sent, not stored
    else return null;
  }
  return parts.join('\n');
}

function fail(res: Response, status: number, code: string, message: string): false {
  res.status(status).json({ error: { message, type: 'invalid_request_error', code } });
  return false;
}

function headerValue(req: Request, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Applies a stored conversation to a client-key request. Returns false after answering the request
 * itself (bad id, feature off, wrong end user, unsupported messages); true otherwise, including when
 * the request carries no X-Conversation-Id.
 */
export function applyConversation(req: Request, res: Response, profileId: number, endUser: string | null, settings: ConversationSettings): boolean {
  const raw = headerValue(req, 'x-conversation-id');
  if (raw === undefined) return true;
  const wire = wireOf(req);
  if (!wire) return fail(res, 400, 'conversation_unsupported_endpoint', 'X-Conversation-Id works with POST /v1/chat/completions and /v1/messages.');
  if (!settings.enabled) return fail(res, 400, 'conversation_storage_disabled', 'Stored conversations are switched off for this key. Turn them on in the dashboard, or send the whole history without X-Conversation-Id.');
  const key = normalizeConversationId(raw);
  if (!key) return fail(res, 400, 'invalid_conversation_id', 'X-Conversation-Id must be 1-128 characters of A-Z, a-z, 0-9, ".", "_", ":" or "-".');

  const body = req.body as Record<string, unknown> | undefined;
  const messages = body && Array.isArray(body.messages) ? body.messages as Array<Record<string, unknown>> : null;
  if (!messages) return fail(res, 400, 'conversation_unsupported_message', 'The request needs a messages array.');

  // Leading system/developer messages are the web app's instructions: sent every time, never stored.
  let lead = 0;
  if (wire === 'chat') while (lead < messages.length && (messages[lead]?.role === 'system' || messages[lead]?.role === 'developer')) lead++;
  const fresh = messages.slice(lead);
  const turn: Turn[] = [];
  for (const m of fresh) {
    const text = (m?.role === 'user' || m?.role === 'assistant') && !m.tool_calls ? textOf(m.content) : null;
    if (text === null) return fail(res, 400, 'conversation_unsupported_message', 'With X-Conversation-Id, send only new user/assistant text messages after the system message. For tool calls, send the whole history yourself.');
    turn.push({ role: m.role as Turn['role'], content: text });
  }
  if (turn.length === 0 || turn[turn.length - 1]!.role !== 'user') return fail(res, 400, 'conversation_unsupported_message', 'With X-Conversation-Id, the last message must be the new user message.');

  const loaded = loadHistory(profileId, key, endUser, settings);
  if (!loaded.ok) return fail(res, 403, 'conversation_end_user_mismatch', 'This conversation belongs to another end user.');

  // The running summary of turns that no longer fit goes after the web app's own instructions.
  const summaryText = loaded.summary ? `Summary of the earlier part of this conversation:\n${loaded.summary}` : null;
  const summaryMessages = summaryText && wire === 'chat' ? [{ role: 'system', content: summaryText }] : [];
  if (summaryText && wire === 'anthropic') {
    if (Array.isArray(body!.system)) (body!.system as unknown[]).push({ type: 'text', text: summaryText });
    else body!.system = typeof body!.system === 'string' && body!.system ? `${body!.system}\n\n${summaryText}` : summaryText;
  }
  body!.messages = [...messages.slice(0, lead), ...summaryMessages, ...loaded.history, ...fresh];
  res.setHeader('X-Conversation-Id', key);
  res.setHeader('X-Conversation-History', String(loaded.history.length));
  if (loaded.summary) res.setHeader('X-Conversation-Summary', '1');

  captureReply(res, wire, (reply) => {
    const id = appendTurn(profileId, key, endUser, loaded.conversationId, turn, reply, settings);
    scheduleSummary(req, profileId, id, settings);
  });
  return true;
}

/** The reply text of a finished response, or null when it did not complete (error, cut off, no text). */
export function replyText(wire: Wire, body: string, sse: boolean): string | null {
  if (!sse) {
    let parsed: Record<string, any>;
    try { parsed = JSON.parse(body) as Record<string, any>; } catch { return null; }
    if (!parsed || typeof parsed !== 'object' || parsed.error) return null;
    if (wire === 'chat') {
      const content = parsed.choices?.[0]?.message?.content;
      const text = typeof content === 'string' ? content : textOf(content);
      return text ? text : null;
    }
    if (parsed.type !== 'message' || !Array.isArray(parsed.content)) return null;
    const text = parsed.content.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('');
    return text || null;
  }

  let text = '';
  let finished = false;
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    let frame: Record<string, any>;
    try { frame = JSON.parse(data) as Record<string, any>; } catch { continue; }
    if (!frame || typeof frame !== 'object') continue;
    if (frame.error || frame.type === 'error') return null;
    if (wire === 'chat') {
      const choice = Array.isArray(frame.choices) ? frame.choices.find((c: any) => (c?.index ?? 0) === 0) : undefined;
      if (typeof choice?.delta?.content === 'string') text += choice.delta.content;
      if (choice?.finish_reason) finished = true;
    } else {
      if (frame.type === 'content_block_delta' && frame.delta?.type === 'text_delta' && typeof frame.delta.text === 'string') text += frame.delta.text;
      if (frame.type === 'message_stop') finished = true;
    }
  }
  return finished && text ? text : null;
}

// Reads back what the route writes (it is never compressed on /v1) and hands the reply over once the
// response has finished with 200. A client that hangs up first ('close' before 'finish') stores nothing.
function captureReply(res: Response, wire: Wire, onReply: (reply: string) => void): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let overflow = false;
  const keep = (chunk: unknown, encoding?: unknown) => {
    if (overflow || chunk === undefined || chunk === null || typeof chunk === 'function') return;
    const buf = Buffer.isBuffer(chunk) ? chunk
      : chunk instanceof Uint8Array ? Buffer.from(chunk)
        : Buffer.from(String(chunk), typeof encoding === 'string' ? encoding as BufferEncoding : 'utf8');
    size += buf.length;
    if (size > MAX_CAPTURE_BYTES) { overflow = true; chunks.length = 0; return; }
    chunks.push(buf);
  };
  const write = res.write.bind(res) as (...args: unknown[]) => boolean;
  const end = res.end.bind(res) as (...args: unknown[]) => Response;
  (res as unknown as { write: (...args: unknown[]) => boolean }).write = (...args: unknown[]) => { keep(args[0], args[1]); return write(...args); };
  (res as unknown as { end: (...args: unknown[]) => Response }).end = (...args: unknown[]) => { keep(args[0], args[1]); return end(...args); };

  res.once('finish', () => {
    if (overflow || res.statusCode !== 200) return;
    try {
      const type = String(res.getHeader('content-type') ?? '');
      const reply = replyText(wire, Buffer.concat(chunks).toString('utf8'), type.includes('text/event-stream'));
      if (reply) onReply(reply);
    } catch (err) {
      console.warn('[conversations] could not store a turn:', err instanceof Error ? err.message : err);
    }
  });
}
