import type { Request, Response } from 'express';
import { KNOWLEDGE_LIMITS } from '@freellmapi/shared/knowledge.js';
import type { RetrievalHit } from '@freellmapi/shared/ai-platform-retrieval.js';
import { knowledgeBlock, searchKnowledge } from '../services/profile-knowledge.js';
import { isPillarEnabled } from './ai-platform/flags.js';
import {
  applyCitationsHeader,
  buildCitations,
  citationFilter,
  formatRetrievalHeader,
} from './ai-platform/retrieval/citations.js';
import { retrieve } from './ai-platform/retrieval/hybrid.js';
import { getRetrievalSettingsInternal } from './ai-platform/retrieval/settings.js';
import type { Wire } from './ai-platform/wire/detect.js';
import { markVolatileSystemText } from './ai-platform/wire/extract.js';
import { installInterceptor } from './ai-platform/wire/interceptor.js';

// Adds a client key's best-matching knowledge passages to a chat request before it is routed. Works on
// the four chat wires; the question is the latest user turn. Never throws: a failure here only means the
// request goes out without reference material.

const GEMINI_GENERATE = /^\/v1beta\/models\/.+?:(?:stream)?generatecontent$/i;

interface PendingRetrievalContext {
  profileId: number;
  maxChars: number;
}

const pendingRetrievals = new WeakMap<object, PendingRetrievalContext>();

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

interface WireInjectionPlan {
  wire: Wire;
  question: string;
  apply: (block: string) => void;
}

function resolveWireInjection(req: Request): WireInjectionPlan | null {
  if (req.method !== 'POST' || !req.body || typeof req.body !== 'object') return null;
  const rawUrl = req.originalUrl || req.url || req.path || '';
  const path = rawUrl.split('?')[0]!.replace(/\/+$/, '');
  const body = req.body as Record<string, any>;

  if (path === '/v1/chat/completions' && Array.isArray(body.messages)) {
    return {
      wire: 'openai-chat',
      question: lastUser(body.messages),
      apply: (block) => {
        let at = 0;
        while (at < body.messages.length && body.messages[at]?.role === 'system') at++;
        body.messages.splice(at, 0, { role: 'system', content: block });
      },
    };
  }
  if (path === '/v1/messages' && Array.isArray(body.messages)) {
    return {
      wire: 'anthropic',
      question: lastUser(body.messages),
      apply: (block) => {
        if (Array.isArray(body.system)) body.system.push({ type: 'text', text: block });
        else body.system = typeof body.system === 'string' && body.system ? `${body.system}\n\n${block}` : block;
      },
    };
  }
  if (path === '/v1/responses') {
    return {
      wire: 'responses',
      question: typeof body.input === 'string' ? body.input : lastUser(body.input),
      apply: (block) => {
        body.instructions = typeof body.instructions === 'string' && body.instructions ? `${body.instructions}\n\n${block}` : block;
      },
    };
  }
  if (GEMINI_GENERATE.test(path) && Array.isArray(body.contents)) {
    return {
      wire: 'gemini',
      question: lastUser(body.contents, 'role', 'user', 'parts'),
      apply: (block) => {
        const si = body.systemInstruction && typeof body.systemInstruction === 'object' ? body.systemInstruction : { parts: [] };
        si.parts = Array.isArray(si.parts) ? [...si.parts, { text: block }] : [{ text: block }];
        body.systemInstruction = si;
      },
    };
  }
  return null;
}

function budgetHitsByChars(hits: RetrievalHit[], maxChars: number): RetrievalHit[] {
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : KNOWLEDGE_LIMITS.defaultMaxChars;
  const kept: RetrievalHit[] = [];
  let used = 0;
  for (const hit of hits) {
    if (used + hit.text.length > limit) {
      if (kept.length === 0) {
        kept.push({ ...hit, text: hit.text.slice(0, limit) });
      }
      break;
    }
    kept.push(hit);
    used += hit.text.length;
  }
  return kept;
}

function isCitationsOptOut(req: Request): boolean {
  const raw = req.headers['x-freellm-citations'];
  const val = Array.isArray(raw) ? raw[0] : raw;
  return String(val ?? '').trim().toLowerCase() === 'off';
}

/** Returns how many passages were added (0 when none matched or the wire is not a chat wire). */
export function injectKnowledge(req: Request, profileId: number, maxChars: number): number {
  try {
    if (isPillarEnabled('retrieval')) {
      if (req.method !== 'POST' || !req.body || typeof req.body !== 'object') return 0;
      pendingRetrievals.set(req, { profileId, maxChars });
      return 0;
    }

    const plan = resolveWireInjection(req);
    if (!plan) return 0;

    const hits = searchKnowledge(profileId, plan.question, maxChars);
    const block = knowledgeBlock(hits);
    if (!block) return 0;
    markVolatileSystemText(block);
    plan.apply(block);
    return hits.length;
  } catch {
    return 0;
  }
}

export interface Slot6RetrievalOptions {
  profileId?: number;
  maxChars?: number;
  knowledgeEnabled?: boolean;
}

/**
 * Pipeline Slot 6 async semantic/hybrid RAG injection + citation headers/filter attachment.
 * Returns the number of injected passages (never throws on hot path).
 */
export async function injectRetrievedKnowledgeForSlot6(
  req: Request,
  res: Response,
  profileOrOpts?: number | Slot6RetrievalOptions,
): Promise<number> {
  const pending = pendingRetrievals.get(req);
  if (pending) pendingRetrievals.delete(req);

  const opts = typeof profileOrOpts === 'number' ? { profileId: profileOrOpts } : profileOrOpts;
  if (!pending && opts?.knowledgeEnabled === false) return 0;

  const profileId = pending?.profileId ?? opts?.profileId;
  if (!profileId || !Number.isInteger(profileId) || profileId <= 0) return 0;
  if (!isPillarEnabled('retrieval')) return 0;

  const plan = resolveWireInjection(req);
  if (!plan) return 0;

  const maxChars = pending?.maxChars ?? opts?.maxChars ?? KNOWLEDGE_LIMITS.defaultMaxChars;

  const ac = new AbortController();
  const onClose = () => {
    if (!res.writableFinished) ac.abort();
  };
  res.once('close', onClose);

  try {
    const scope = { kind: 'profile' as const, id: String(profileId) };
    const settings = getRetrievalSettingsInternal(scope).settings;
    const result = await retrieve(scope, plan.question, {
      signal: ac.signal,
      respectPillarFlag: true,
    });

    const budgetedHits = budgetHitsByChars(result.hits, maxChars);
    const block = knowledgeBlock(
      budgetedHits.map((h) => ({
        docId: Number(h.docId),
        title: h.title,
        text: h.text,
        score: h.score,
      })),
    );
    if (block) {
      markVolatileSystemText(block);
      plan.apply(block);
    }

    const citationsActive = settings.citationsEnabled && !isCitationsOptOut(req) && budgetedHits.length > 0;
    const citations =
      budgetedHits.length === result.hits.length ? result.citations : buildCitations(budgetedHits);
    const retrievalHeaderValue = formatRetrievalHeader(result.modeUsed, result.degraded);

    applyCitationsHeader(res, citations, retrievalHeaderValue, {
      citationsEnabled: citationsActive,
    });

    if (citationsActive && citations.length > 0) {
      const filter = citationFilter(plan.wire, budgetedHits);
      if (filter) {
        installInterceptor(req, res, plan.wire, [filter]);
      }
    }

    return budgetedHits.length;
  } catch {
    return 0;
  } finally {
    res.off('close', onClose);
  }
}
