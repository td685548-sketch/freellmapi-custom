import type { Request, Response } from 'express';
import type { ContentFilterSettings } from '@freellmapi/shared/content-filter.js';
import { checkMessage, recordEvent } from '../services/content-filter.js';

// Applies a client key's content rules to the latest user message of a chat request, before the
// request uses a rate-limit slot, an allowance or a provider. Other requests pass untouched.

const GEMINI_GENERATE = /^\/v1beta\/models\/.+?:(?:stream)?generatecontent$/i;

type Part = { type?: unknown; text?: unknown };
const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p: Part) => (typeof p?.text === 'string' ? p.text : '')).filter(Boolean).join('\n');
  return '';
};
function lastUser(items: unknown, contentKey: 'content' | 'parts' = 'content'): string | null {
  if (!Array.isArray(items)) return null;
  for (let i = items.length - 1; i >= 0; i--) {
    const m = items[i] as Record<string, unknown> | null;
    if (m && m.role === 'user') return textOf(m[contentKey]);
  }
  return null;
}

/** The latest user message of a chat request, or null when the request is not one. */
export function latestUserText(req: Request): string | null {
  if (req.method !== 'POST' || !req.body || typeof req.body !== 'object') return null;
  const path = req.originalUrl.split('?')[0]!.replace(/\/+$/, '');
  const body = req.body as Record<string, unknown>;
  if (path === '/v1/chat/completions' || path === '/v1/messages') return lastUser(body.messages);
  if (path === '/v1/responses') return typeof body.input === 'string' ? body.input : lastUser(body.input);
  if (path === '/v1/completions') return typeof body.prompt === 'string' ? body.prompt : Array.isArray(body.prompt) ? body.prompt.filter(p => typeof p === 'string').join('\n') : null;
  if (GEMINI_GENERATE.test(path)) return lastUser(body.contents, 'parts');
  return null;
}

const MESSAGES: Record<string, string> = {
  too_long: 'This message is longer than this service accepts.',
  keyword: 'This message contains content this service does not accept.',
  prompt_injection: 'This message tries to change how the assistant works, which this service does not accept.',
  repeated: 'The same message was sent too many times in a short while. Please wait a few minutes.',
};

/** False after answering the request itself (a blocked message); true otherwise. */
export function screenContent(req: Request, res: Response, profileId: number, endUser: string | null, s: ContentFilterSettings): boolean {
  if (s.mode === 'off') return true;
  const text = latestUserText(req);
  if (!text) return true;
  const flag = checkMessage(profileId, endUser, text, s);
  if (!flag) return true;
  try { recordEvent(profileId, endUser, flag, s.mode === 'block' ? 'blocked' : 'logged', text); } catch (err) {
    console.warn('[content-filter] could not record an event:', err instanceof Error ? err.message : err);
  }
  if (s.mode !== 'block') return true;
  res.status(flag.reason === 'repeated' ? 429 : 400).json({
    error: { message: MESSAGES[flag.reason], type: 'invalid_request_error', code: 'content_blocked', reason: flag.reason },
  });
  return false;
}
