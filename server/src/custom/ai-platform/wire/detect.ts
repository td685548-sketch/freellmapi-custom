import type { Request } from 'express';

export type Wire = 'openai-chat' | 'anthropic' | 'responses' | 'gemini';

const GEMINI_GENERATE = /^\/v1beta\/models\/.+?:(?:stream)?generatecontent$/i;
const GEMINI_STREAM = /:streamgeneratecontent$/i;

function requestPath(req: Request): string {
  const raw = req.originalUrl || req.url || req.path || '';
  return raw.split('?')[0]!.replace(/\/+$/, '');
}

/**
 * Detects which of the four chat wire protocols a request targets.
 * Returns null for non-POST requests or unrecognized paths (including /thruline/v1).
 */
export function detectWire(req: Request): { wire: Wire; stream: boolean } | null {
  try {
    if (req.method !== 'POST') return null;
    const path = requestPath(req);
    const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : null;
    const bodyStream = body?.stream === true;

    if (path === '/v1/chat/completions') return { wire: 'openai-chat', stream: bodyStream };
    if (path === '/v1/messages') return { wire: 'anthropic', stream: bodyStream };
    if (path === '/v1/responses') return { wire: 'responses', stream: bodyStream };
    if (GEMINI_GENERATE.test(path)) {
      return { wire: 'gemini', stream: GEMINI_STREAM.test(path) };
    }
    return null;
  } catch {
    return null;
  }
}
