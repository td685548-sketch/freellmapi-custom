import type { Request } from 'express';
import { knowledgeBlock, searchKnowledge } from '../services/profile-knowledge.js';

// Adds a client key's best-matching knowledge passages to a chat request before it is routed. Works on
// the four chat wires; the question is the latest user turn. Never throws: a failure here only means the
// request goes out without reference material.

const GEMINI_GENERATE = /^\/v1beta\/models\/.+?:(?:stream)?generatecontent$/i;

type Part = { type?: string; text?: unknown };
const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p: Part) => (typeof p?.text === 'string' ? p.text : '')).join(' ');
  return '';
};
function lastUser(items: unknown, roleKey = 'role', user = 'user', contentKey = 'content'): string {
  if (!Array.isArray(items)) return '';
  for (let i = items.length - 1; i >= 0; i--) {
    const m = items[i] as Record<string, unknown>;
    if (m && m[roleKey] === user) return textOf(m[contentKey] ?? (m as { parts?: unknown }).parts);
  }
  return '';
}

/** Returns how many passages were added (0 when none matched or the wire is not a chat wire). */
export function injectKnowledge(req: Request, profileId: number, maxChars: number): number {
  try {
    if (req.method !== 'POST' || !req.body || typeof req.body !== 'object') return 0;
    const path = req.originalUrl.split('?')[0]!.replace(/\/+$/, '');
    const body = req.body as Record<string, any>;
    let question = '';
    let apply: (block: string) => void;

    if (path === '/v1/chat/completions' && Array.isArray(body.messages)) {
      question = lastUser(body.messages);
      apply = (block) => {
        let at = 0;
        while (at < body.messages.length && body.messages[at]?.role === 'system') at++;
        body.messages.splice(at, 0, { role: 'system', content: block });
      };
    } else if (path === '/v1/messages' && Array.isArray(body.messages)) {
      question = lastUser(body.messages);
      apply = (block) => {
        if (Array.isArray(body.system)) body.system.push({ type: 'text', text: block });
        else body.system = typeof body.system === 'string' && body.system ? `${body.system}\n\n${block}` : block;
      };
    } else if (path === '/v1/responses') {
      question = typeof body.input === 'string' ? body.input : lastUser(body.input);
      apply = (block) => { body.instructions = typeof body.instructions === 'string' && body.instructions ? `${body.instructions}\n\n${block}` : block; };
    } else if (GEMINI_GENERATE.test(path) && Array.isArray(body.contents)) {
      question = lastUser(body.contents, 'role', 'user', 'parts');
      apply = (block) => {
        const si = body.systemInstruction && typeof body.systemInstruction === 'object' ? body.systemInstruction : { parts: [] };
        si.parts = Array.isArray(si.parts) ? [...si.parts, { text: block }] : [{ text: block }];
        body.systemInstruction = si;
      };
    } else return 0;

    const hits = searchKnowledge(profileId, question, maxChars);
    const block = knowledgeBlock(hits);
    if (!block) return 0;
    apply(block);
    return hits.length;
  } catch {
    return 0;
  }
}
