import type { Request, Response } from 'express';

// What a client profile's restrictions mean for one inference request. Pure request handling; the
// gate (middleware/profile-gate.ts) supplies the profile and answers the refusal.

/** Surfaces whose automatic routing the router narrows to the allowed models (resolveRoutingChain). */
const CHAIN_SURFACE = /^\/v1\/(?:chat\/completions|completions|responses|messages)$/;
/** Requests that call no model, so there is nothing to restrict. */
const MODEL_FREE = /\/messages\/count_tokens$|:countTokens$/;
const GEMINI_GENERATE = /^\/v1beta\/models\/(.+?):(?:stream)?generatecontent$/i;
const AUTO = /^auto(?::.*)?$/i;

export interface Refusal { code: 'model_not_allowed' | 'model_required'; message: string }

function pathOf(req: Request): string {
  return req.originalUrl.split('?')[0]!.replace(/\/+$/, '');
}

function requestedModel(req: Request, path: string): string | undefined {
  const gemini = GEMINI_GENERATE.exec(path);
  if (gemini) {
    try { return decodeURIComponent(gemini[1]!); } catch { return gemini[1]; }
  }
  const body = req.body as { model?: unknown } | undefined;
  return typeof body?.model === 'string' && body.model.trim() ? body.model.trim() : undefined;
}

/**
 * Whether the request may name the model it names. Automatic routing ("auto", "auto:<chain>" or no model)
 * is allowed where the router narrows it to the allowed models; everywhere else the key must name one.
 */
export function checkModel(req: Request, allowed: ReadonlySet<string>): Refusal | null {
  if (req.method !== 'POST') return null;
  const path = pathOf(req);
  if (MODEL_FREE.test(path)) return null;
  const list = [...allowed].join(', ');
  const model = requestedModel(req, path);
  const auto = model === undefined || AUTO.test(model);
  if (auto) {
    if (CHAIN_SURFACE.test(path)) return null;
    return { code: 'model_required', message: `This key may only use specific models on this endpoint; name one of: ${list}.` };
  }
  if (allowed.has(model.toLowerCase())) return null;
  return { code: 'model_not_allowed', message: `This key may not use the model '${model}'. Allowed models: ${list}.` };
}

/**
 * Lower the request's output-token budget to the cap: values above it are replaced, and a request
 * that asks for none gets the cap. Gemini carries it in generationConfig, the Responses API as
 * max_output_tokens, everything else as max_tokens / max_completion_tokens.
 */
export function capOutputTokens(req: Request, cap: number): void {
  if (req.method !== 'POST') return;
  const path = pathOf(req);
  const body = req.body as Record<string, unknown> | undefined;
  if (!body || typeof body !== 'object') return;
  const over = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > cap;
  const set = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v > 0;

  if (GEMINI_GENERATE.test(path)) {
    const config = (body.generationConfig && typeof body.generationConfig === 'object' ? body.generationConfig : {}) as Record<string, unknown>;
    if (!set(config.maxOutputTokens) || over(config.maxOutputTokens)) config.maxOutputTokens = cap;
    body.generationConfig = config;
  } else if (path === '/v1/responses') {
    if (!set(body.max_output_tokens) || over(body.max_output_tokens)) body.max_output_tokens = cap;
  } else if (CHAIN_SURFACE.test(path)) {
    const keys = ['max_tokens', 'max_completion_tokens'] as const;
    if (!keys.some(k => set(body[k]))) body.max_tokens = cap;
    for (const k of keys) if (over(body[k])) body[k] = cap;
  }
}

export function refuse(res: Response, refusal: Refusal, allowed: ReadonlySet<string>): void {
  res.status(403).json({
    error: { message: refusal.message, type: 'permission_error', code: refusal.code, allowed_models: [...allowed] },
  });
}
