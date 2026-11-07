import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import type { QuickAnswerSettings } from '@freellmapi/shared/quick-answers.js';
import { findQuickAnswer, noteHit } from '../services/quick-answers.js';
import { latestUserText } from './content-filter-gate.js';

// Answers a client-key chat request with one of the key's ready answers when the visitor's latest
// message matches, in the format the caller asked for (chat completions or Messages, streamed or not),
// without calling a provider. The response says so in X-Quick-Answer and model "quick-answer".

const MODEL = 'quick-answer';

function wireOf(req: Request): 'chat' | 'anthropic' | null {
  if (req.method !== 'POST') return null;
  const path = req.originalUrl.split('?')[0]!.replace(/\/+$/, '');
  return path === '/v1/chat/completions' ? 'chat' : path === '/v1/messages' ? 'anthropic' : null;
}

function sendChat(res: Response, text: string, stream: boolean): void {
  const id = `chatcmpl-qa${randomBytes(9).toString('hex')}`;
  const created = Math.floor(Date.now() / 1000);
  if (!stream) {
    res.json({
      id, object: 'chat.completion', created, model: MODEL,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
    return;
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  const frame = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  frame({ id, object: 'chat.completion.chunk', created, model: MODEL, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] });
  frame({ id, object: 'chat.completion.chunk', created, model: MODEL, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  res.write('data: [DONE]\n\n');
  res.end();
}

function sendAnthropic(res: Response, text: string, stream: boolean): void {
  const id = `msg_qa${randomBytes(9).toString('hex')}`;
  const usage = { input_tokens: 0, output_tokens: 0 };
  if (!stream) {
    res.json({ id, type: 'message', role: 'assistant', model: MODEL, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage });
    return;
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  const event = (name: string, data: unknown) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  event('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage } });
  event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
  event('content_block_stop', { type: 'content_block_stop', index: 0 });
  event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } });
  event('message_stop', { type: 'message_stop' });
  res.end();
}

/** True after answering the request itself with a ready answer. */
export function answerQuickly(req: Request, res: Response, profileId: number, s: QuickAnswerSettings): boolean {
  if (!s.enabled) return false;
  const wire = wireOf(req);
  if (!wire) return false;
  const text = latestUserText(req);
  if (!text) return false;
  const hit = findQuickAnswer(profileId, text, s.minSimilarity);
  if (!hit) return false;
  try { noteHit(hit.id); } catch { /* the count is only a statistic */ }
  res.setHeader('X-Quick-Answer', String(hit.id));
  const stream = (req.body as { stream?: unknown } | undefined)?.stream === true;
  if (wire === 'chat') sendChat(res, hit.answer, stream);
  else sendAnthropic(res, hit.answer, stream);
  return true;
}
