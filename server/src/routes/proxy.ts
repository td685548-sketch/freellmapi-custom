import { AUTO_MODEL_ID, requireInferenceAuth } from './chat-route.js';
import { chatCompletionsRouter } from './chat-completions.js';
import { completionsRouter } from './completions.js';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { secondsUntilNextMonth, nextMonthResetAt } from '../services/key-budget.js';
import { runEmbeddings, EmbeddingsError } from '../services/embeddings.js';
import { runRerank, RerankError, rerankRetryAfterSec } from '../services/rerank.js';
import { runSearch, SearchError, searchRetryAfterSec, listSearchEngines } from '../services/search.js';
import { runDecision, DecisionError, decisionRetryAfterSec, listDecisionModels, DECISION_QUESTION_TYPES } from '../services/decision.js';
import { retryAfterSeconds } from '../lib/retry-hint.js';
import { runImageGeneration, runVideoGeneration, runSpeech, runTranscription, MediaError, MAX_TRANSCRIPTION_BYTES } from '../services/media.js';
import multer from 'multer';
import { getDb } from '../db/index.js';
import { isUrlTokenAuthenticated } from '../lib/system-prompt.js';
import { FUSION_MODEL_ID } from '../services/fusion.js';
import { isRetryableError, isPaymentRequiredError, isModelNotFoundError, isModelAccessForbiddenError } from '../lib/error-classify.js';
import { logRequest } from '../lib/request-log.js';
import { exhaustedRetryError } from '../lib/fallback-loop.js';
import { safeHeaderValue } from '../lib/header-value.js';
import { supportedParametersForPlatforms } from '../lib/sampling-params.js';
import { buildModelListing, servableContextWindow, type NormalizedModel, onInvalidateModelListing } from '../services/model-listing.js';
import { claudeFamilyDiscoveryEntries } from '../services/anthropic-map.js';

// Chat-route plumbing moved to routes/chat-route.ts (shared by the
// /chat/completions and /completions handlers, now in their own route
// files); re-exported here for existing importers (routes/anthropic.ts,
// routes/responses.ts, lib/inbound-chat.ts, custom/preparse-guard.ts, and
// the proxy tests).
export {
  extractApiToken,
  getRequestGroupId,
  traceRouteEvent,
  clearReasoningMemory,
  getStickyModel,
  setStickyModel,
  sessionIdentityMessages,
  streamReasoningText,
  completionReasoningText,
  providerSafeStop,
} from './chat-route.js';
export { streamChunkText } from './completions.js';

export const proxyRouter = Router();


// timingSafeStringEqual moved to lib/system-prompt.ts (resolveAuth needs it
// and importing it back from this route would be a cycle). Re-exported here
// for existing importers (anthropic, gemini, mcp, ollama, status, url-tokens).
export { timingSafeStringEqual } from '../lib/system-prompt.js';


// exhaustedRetryError moved to lib/fallback-loop.ts (the shared retry loop needs
// it and importing it back from a route would be a cycle). Re-exported here for
// existing importers (routes/responses.ts, proxy-retry.test.ts historically).
export { exhaustedRetryError };

// shows API models which is linked by the user
proxyRouter.get('/models', (req: Request, res: Response) => {
  if (!requireInferenceAuth(req, res)) return;

  // By default we return the WHOLE catalog (one row per model id), each tagged
  // with whether it is currently usable, so a client can see everything and know
  // what's connected vs. disabled/keyless (#242). `?available=true` (aliases
  // `?connected=true`, `?ready=true`) narrows the list to only models that can
  // serve a request right now — the previous default behavior. The `ready`
  // alias is the machine-readable filter a meta-gateway uses (#433) to ask
  // "which models can this instance actually serve now". `available` is computed as
  // "enabled AND an enabled key can serve it"; dedup prefers an available
  // instance of a model id over a disabled/keyless one.
  const q = String(req.query.available ?? req.query.connected ?? req.query.ready ?? '').toLowerCase();
  const onlyAvailable = q === '1' || q === 'true' || q === 'yes';
  const esValues: Record<string, NormalizedModel['executionStatus']> = {
    ready: 'ready', needskey: 'needsKey', exhausted: 'exhausted',
  };
  const es = esValues[String(req.query.execution_status ?? '').toLowerCase()];

  res.json({
    object: 'list',
    data: buildCatalogEntries({ onlyAvailable, executionStatus: es }),
  });
});

// GET /v1/models/:id — OpenAI's `models.retrieve` (single-model lookup).
// Without it, `client.models.retrieve(id)` and every gateway that validates a
// model id before routing (LiteLLM proxy config checks, OpenAI Agents SDK
// model caps, eval harnesses) answers 404 even though chat completions for
// the same id work fine. Served from the SAME builder as the list, so what a
// client lists is byte-for-byte what it retrieves; unknown ids get OpenAI's
// error shape (type: invalid_request_error). The id may itself contain
// slashes (openrouter-style ids): the wildcard capture rejoins them, and a
// URL-encoded %2F arrives decoded through Express's plain :id capture.
const MODEL_RETRIEVE_MAX_ID_LEN = 300;
proxyRouter.get(['/models/:id', '/models/*rest'], (req: Request, res: Response) => {
  if (!requireInferenceAuth(req, res)) return;
  // Express 5 hands a wildcard capture as a string array; a plain :id capture
  // as a string. Rejoin the segments so "vendor/ns/model" round-trips.
  const capture = (req.params as Record<string, unknown>).id
    ?? (req.params as Record<string, unknown>).rest;
  const id = Array.isArray(capture) ? capture.join('/') : String(capture ?? '');
  if (!id || id.length > MODEL_RETRIEVE_MAX_ID_LEN) {
    res.status(404).json({
      error: { message: `Model not found: ${id.slice(0, 80)}`, type: 'invalid_request_error', code: 'model_not_found', param: 'id' },
    });
    return;
  }
  const entry = buildCatalogEntries().find(m => m.id === id);
  if (!entry) {
    res.status(404).json({
      error: { message: `Model not found: ${id}`, type: 'invalid_request_error', code: 'model_not_found', param: 'id' },
    });
    return;
  }
  res.json({ ...entry, object: 'model' });
});

// The whole OpenAI-shaped /v1/models body, as one array of entries: the two
// router entries (`auto`, `fusion`), the Claude-family discovery aliases (#880),
// one entry per named fallback chain (`auto:<name>`), then the catalog rows.
// Shared by GET /v1/models and GET /v1/models/:id so a model a client can LIST
// is a model it can RETRIEVE with the identical shape — the retrieve endpoint
// is OpenAI's `models.retrieve`, which LiteLLM-style gateways and eval
// harnesses (lm-evaluation-harness, OpenAI SDK `.models.retrieve()`) call
// before routing; a 404 there breaks those clients even when chat works.
// The `?available=` / `?execution_status=` filters narrow only the catalog
// rows — `auto`, `fusion` and the named chains are router entries, not models
// with keys of their own.
interface CatalogCacheEntry {
  data: Array<Record<string, unknown>>;
  expiresAt: number;
}
const catalogEntriesCache = new Map<string, CatalogCacheEntry>();
const CATALOG_ENTRIES_CACHE_TTL_MS = 30_000;

onInvalidateModelListing(() => {
  catalogEntriesCache.clear();
});

function buildCatalogEntries(filters: { onlyAvailable?: boolean; executionStatus?: NormalizedModel['executionStatus'] } = {}): Array<Record<string, unknown>> {
  const cacheKey = `${filters.onlyAvailable ? '1' : '0'}:${filters.executionStatus ?? ''}`;
  const now = Date.now();
  const cached = catalogEntriesCache.get(cacheKey);
  if (cached && now < cached.expiresAt) {
    return cached.data;
  }

  const { models: allListed, autoContextWindow } = buildModelListing();
  const listed = filters.onlyAvailable ? allListed.filter(m => m.available === 1) : allListed;

  // Named fallback chains (#960/#895): every user-defined profile is exposed
  // as an `auto:<name>` model so a client can pick a specific fallback chain
  // per request (auto:my-group) instead of only the active one. Available iff
  // at least one model in that profile's chain can serve a request right now.
  const profileRows = getDb().prepare(`
    SELECT p.id, p.name,
           EXISTS (
             SELECT 1
             FROM profile_models pm
             JOIN models m ON m.id = pm.model_db_id AND m.enabled = 1
             WHERE pm.profile_id = p.id AND pm.enabled = 1
               AND EXISTS (
                 SELECT 1 FROM api_keys k
                 WHERE k.platform = m.platform AND k.enabled = 1
                   AND (m.key_id IS NULL OR k.id = m.key_id)
               )
           ) AS usable,
           (SELECT json_group_array(m2.context_window)
            FROM profile_models pm2
            JOIN models m2 ON m2.id = pm2.model_db_id AND m2.enabled = 1
            WHERE pm2.profile_id = p.id AND pm2.enabled = 1) AS ctxs
    FROM profiles p
    WHERE p.type = 'custom'
    ORDER BY p.sort_order, p.id
  `).all() as { id: number; name: string; usable: number; ctxs: string | null }[];

  // Claude-family discovery entries (#880). The Anthropic-shaped GET /v1/models
  // in routes/anthropic.ts already lists one id per Claude family so clients
  // that only accept Claude-looking ids can discover anything at all — but that
  // handler only answers when the caller sends an `anthropic-version` header.
  // Claude Desktop's gateway picker fetches this path WITHOUT that header, so
  // it fell through to the OpenAI-shaped listing below and still saw zero
  // Claude-shaped ids. Emit the same entries here, from the same builder, so
  // both shapes agree on what the gateway will serve. Listed only when
  // something can actually serve them, and never when the id would collide
  // with a real catalog row.
  const listedIds = new Set(listed.map(m => m.id));
  const claudeFamilyEntries = allListed.some(m => m.available === 1)
    ? claudeFamilyDiscoveryEntries()
      .filter(a => !listedIds.has(a.id))
      .map(a => ({
        id: a.id,
        object: 'model' as const,
        created: 0,
        owned_by: 'freellmapi',
        name: a.displayName,
        context_window: autoContextWindow,
        context_length: autoContextWindow,
        available: true,
        unavailable_reason: null,
      }))
    : [];

  // Machine-readable execution filter: `?execution_status=ready` narrows to
  // models a request can actually serve RIGHT NOW (a key that is not scoped
  // away, cooling down or out of window). `ready` implies available;
  // `needsKey`/`exhausted` select the rest. Matched case-insensitively because
  // the value itself is camelCase; an unrecognised value filters nothing, the
  // same way an unrecognised `?available=` does. Like `?available=`, this
  // narrows only the catalog rows: `auto`, `fusion` and the named chains are
  // Machine-readable execution filter: `?execution_status=ready` narrows to
  // models a request can actually serve RIGHT NOW (a key that is not scoped
  // away, cooling down or out of window). `ready` implies available;
  // `needsKey`/`exhausted` select the rest. Matched case-insensitively because
  // the value itself is camelCase; an unrecognised value filters nothing, the
  // same way an unrecognised `?available=` does.
  const esFiltered = filters.executionStatus
    ? listed.filter(m => m.executionStatus === filters.executionStatus)
    : listed;

  const result: Array<Record<string, unknown>> = [
    {
      id: AUTO_MODEL_ID,
      object: 'model',
      created: 0,
      owned_by: 'freellmapi',
      name: 'Auto (router picks the best available model)',
      context_window: autoContextWindow,
      // `context_length` is OpenRouter's field name and the one most
      // OpenAI-compatible clients read; emit both so whichever a client
      // looks for is populated. Additive — clients ignore unknown fields.
      context_length: autoContextWindow,
      available: true,
      unavailable_reason: null,
    },
    {
      id: FUSION_MODEL_ID,
      object: 'model',
      created: 0,
      owned_by: 'freellmapi',
      name: 'Fusion (panel of models answer in parallel, a judge synthesizes one answer)',
      context_window: autoContextWindow,
      context_length: autoContextWindow,
      // Available whenever auto is — fusion needs at least one routable model.
      available: autoContextWindow != null,
      unavailable_reason: autoContextWindow != null ? null : 'no_models',
    },
    ...claudeFamilyEntries,
    ...profileRows.map(p => {
      const ctx = servableContextWindow(JSON.parse(p.ctxs ?? '[]') as (number | null)[]);
      return {
        id: `auto:${p.name.toLowerCase()}`,
        object: 'model',
        created: 0,
        owned_by: 'freellmapi',
        name: `Auto: ${p.name} (named fallback chain)`,
        context_window: ctx,
        context_length: ctx,
        available: p.usable === 1,
        unavailable_reason: p.usable === 1 ? null : 'no_models',
      };
    }),
    ...esFiltered.map(m => ({
      id: m.id,
      object: 'model',
      created: 0,
      owned_by: m.ownedBy,
      name: m.name,
      context_window: m.contextWindow,
      context_length: m.contextWindow,
      // Non-standard but additive: OpenAI clients ignore unknown fields.
      available: m.available === 1,
      unavailable_reason: m.available === 1 ? null : (m.enabled === 1 ? 'no_key' : 'disabled'),
      // Machine-readable dynamic status: 'ready' | 'needsKey' | 'exhausted'
      // (see services/model-listing.ts). Agents can filter with
      // ?execution_status=ready and route around exhausted models.
      execution_status: m.executionStatus,
      // OpenRouter's field name; agents use it to pick knobs per model. For
      // a unify group this is the intersection over member platforms — a
      // param is only advertised when every platform the router might pick
      // honors it.
      supported_parameters: supportedParametersForPlatforms(m.platforms, { tools: m.supportsTools }),
    })),
  ];
  catalogEntriesCache.set(cacheKey, { data: result, expiresAt: now + CATALOG_ENTRIES_CACHE_TTL_MS });
  return result;
}


// GET /v1/usage — self-service consumption for inference clients (#1568).
//
// OpenRouter exposes GET /api/v1/auth/key (usage + limits for the calling key)
// and LiteLLM exposes /key/info; every agent user who wonders "what happened
// to my 120M tokens" currently has to open the dashboard to find out. This
// puts the same answer behind the key that spent the tokens: one month-to-date
// roll-up of successful proxied requests, split by provider platform, plus
// when the window resets.
//
// Reads the durable key_monthly_usage ledger (the per-key monthly-cap source),
// NOT the analytics table, so retention pruning can never make the answer
// disagree with what the caps enforce. Aggregated per PROVIDER key joined to
// api_keys for the platform label; requests whose key was deleted have already
// dropped out of the ledger's join and are reported under "removed".
//
// The ledger is install-wide (requests are not tagged with the client profile
// that sent them), so only the unified key may read it. A client-profile key
// (sk-cp-...) is handed to a downstream client and must not see what every
// other client spent.
proxyRouter.get('/usage', (req: Request, res: Response) => {
  // A URL-token request carries the injected unified key (routes/url-tokens.ts)
  // — which is precisely why it must not pass a unified-key gate. The token is
  // handed to a headerless client (a teammate, a widget, a phone app); the
  // ledger behind this route is every provider key's spend. Same reasoning as
  // the client-profile refusal below. URL tokens are chat-scoped by design:
  // isUrlTokenAuthenticated() is the single check for that scope here.
  if (isUrlTokenAuthenticated(req)) {
    res.status(403).json({ error: { message: 'Usage is only available to the unified API key', type: 'permission_error' } });
    return;
  }
  const auth = requireInferenceAuth(req, res);
  if (!auth) return;
  if (auth.kind !== 'unified') {
    res.status(403).json({ error: { message: 'Usage is only available to the unified API key', type: 'permission_error' } });
    return;
  }

  const month = new Date().toISOString().slice(0, 7);
  const db = getDb();
  const totals = db.prepare(`
    SELECT COALESCE(SUM(requests), 0) AS requests, COALESCE(SUM(tokens), 0) AS tokens
    FROM key_monthly_usage WHERE month = ?
  `).get(month) as { requests: number; tokens: number };
  const byPlatform = db.prepare(`
    SELECT COALESCE(k.platform, 'removed') AS platform,
           SUM(u.requests) AS requests, SUM(u.tokens) AS tokens
    FROM key_monthly_usage u
    LEFT JOIN api_keys k ON k.id = u.key_id
    WHERE u.month = ?
    GROUP BY COALESCE(k.platform, 'removed')
    ORDER BY tokens DESC, requests DESC
  `).all(month) as { platform: string; requests: number; tokens: number }[];

  // Per-provider-key rows (#1568 follow-up): "groq ate 90M" still doesn't say
  // WHICH account did it, or whether that account is about to hit the monthly
  // cap the caller keeps being 429'd on. LiteLLM's /key/info reports limits and
  // spend together for the same reason. Caps echo api_keys (0 = unlimited), so
  // the answer matches checkMonthlyBudget's verdict exactly. Deleted keys keep
  // their ledger rows orphaned; they surface under the platform 'removed' with
  // no caps, same as the platform roll-up above.
  const byKey = db.prepare(`
    SELECT u.key_id AS keyId,
           COALESCE(k.platform, 'removed') AS platform,
           COALESCE(k.label, '') AS label,
           COALESCE(k.enabled, 0) AS enabled,
           u.requests AS requests, u.tokens AS tokens,
           COALESCE(k.monthly_request_cap, 0) AS requestCap,
           COALESCE(k.monthly_token_cap, 0) AS tokenCap
    FROM key_monthly_usage u
    LEFT JOIN api_keys k ON k.id = u.key_id
    WHERE u.month = ? AND (u.requests > 0 OR u.tokens > 0)
    ORDER BY u.tokens DESC, u.requests DESC
  `).all(month) as {
    keyId: number; platform: string; label: string; enabled: number;
    requests: number; tokens: number; requestCap: number; tokenCap: number;
  }[];

  res.json({
    object: 'usage',
    month,
    resetsAt: nextMonthResetAt(),
    requests: totals.requests,
    tokens: totals.tokens,
    byPlatform,
    byKey: byKey.map(k => ({
      keyId: k.keyId,
      platform: k.platform,
      label: k.label,
      enabled: k.enabled === 1,
      requests: k.requests,
      tokens: k.tokens,
      // null = unlimited, matching how the dashboard renders "no cap" and
      // sparing a script from treating 0 as "cap of zero requests".
      requestCap: k.requestCap > 0 ? k.requestCap : null,
      tokenCap: k.tokenCap > 0 ? k.tokenCap : null,
    })),
  });
});


// Upstream-error classifiers live in lib/error-classify.ts so the fusion
// service can share them without an import cycle; imported above for internal
// use and re-exported here for existing importers (routes/responses.ts,
// proxy-retry.test.ts) that pull them from this module.
export { isRetryableError, isPaymentRequiredError, isModelNotFoundError, isModelAccessForbiddenError };


// OpenAI-compatible embeddings endpoint, routed through the embeddings family
// catalog: `model: "auto"` (or omitted) → the configured default family; a
// family name or provider model id → that family's provider chain. Failover
// only happens WITHIN a family (same model on another provider) — never across
// models, since vectors from different models are incompatible.
const EmbeddingsBody = z.object({
  model: z.string().optional(),
  input: z.union([z.string(), z.array(z.string())]),
  // Optional output-dimension override forwarded to providers that support MRL
  // truncation (NVIDIA NeMo NIM, Google Gemini Embedding, OpenAI v3). Validation
  // only — bounds checking happens upstream (the provider rejects out-of-range
  // values with a clear 400).
  dimensions: z.number().int().positive().optional(),
});

proxyRouter.post('/embeddings', async (req: Request, res: Response) => {
  if (!requireInferenceAuth(req, res)) return;
  const parsed = EmbeddingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid request: `input` is required', type: 'invalid_request_error' } });
    return;
  }
  const inputs = Array.isArray(parsed.data.input) ? parsed.data.input : [parsed.data.input];
  try {
    const result = await runEmbeddings(parsed.data.model, inputs, parsed.data.dimensions);
    res.json({
      object: 'list',
      data: result.vectors.map((values, i) => ({ object: 'embedding', index: i, embedding: values })),
      model: result.family,
      provider: result.platform,
      usage: { prompt_tokens: result.inputTokens, total_tokens: result.inputTokens },
    });
  } catch (err: any) {
    const status = err instanceof EmbeddingsError ? err.status : 502;
    const code = err instanceof EmbeddingsError ? inferenceBudgetCode(err, res) : {};
    const type = status === 400 ? 'invalid_request_error' : status === 429 ? 'rate_limit_error' : 'server_error';
    res.status(status).json({ error: { message: `embedding error: ${err?.message ?? 'unknown'}`, type, ...code } });
  }
});

// Cohere/Jina-style rerank over the key pool (#1029). No catalog: a Cohere key
// or a custom OpenAI-compatible endpoint exposing POST {base_url}/rerank is a
// provider; the first success wins, custom endpoints tried first.
const RerankBody = z.object({
  model: z.string().optional(),
  query: z.string().min(1),
  documents: z.array(z.string()).min(1),
  top_n: z.number().int().positive().optional(),
});

proxyRouter.post('/rerank', async (req: Request, res: Response) => {
  if (!requireInferenceAuth(req, res)) return;
  const parsed = RerankBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid request: `query` and `documents` are required', type: 'invalid_request_error' } });
    return;
  }
  try {
    const result = await runRerank(parsed.data.model, parsed.data.query, parsed.data.documents, parsed.data.top_n);
    res.json({
      results: result.results.map(r => ({
        index: r.index,
        relevance_score: r.relevanceScore,
        document: { text: r.document },
      })),
      model: result.modelId,
      provider: result.platform,
    });
  } catch (err: any) {
    const status = err instanceof RerankError ? err.status : 502;
    if (err instanceof RerankError) {
      const retryAfter = rerankRetryAfterSec(err);
      if (retryAfter !== undefined) res.setHeader('Retry-After', String(retryAfter));
    }
    const type = status === 400 ? 'invalid_request_error' : status === 429 ? 'rate_limit_error' : 'server_error';
    res.status(status).json({ error: { message: `rerank error: ${err?.message ?? 'unknown'}`, type } });
  }
});

// Web search over the key pool (#1174). Engines are catalog rows (Tavily,
// Exa, Firecrawl, Linkup, plus custom relays speaking Tavily's wire shape);
// the first engine that returns hits wins. See services/search.ts.
const SearchBody = z.object({
  query: z.string().min(1),
  max_results: z.number().int().positive().optional(),
  topic: z.enum(['general', 'news']).optional(),
  include_answer: z.boolean().optional(),
  engine: z.string().min(1).optional(),
});

proxyRouter.post('/search', async (req: Request, res: Response) => {
  if (!requireInferenceAuth(req, res)) return;
  const parsed = SearchBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid request: `query` is required', type: 'invalid_request_error' } });
    return;
  }
  // A departed client drops the upstream search instead of spending a credit.
  const abort = new AbortController();
  res.on('close', () => { if (!res.writableFinished) abort.abort(); });
  try {
    const result = await runSearch(parsed.data.query, {
      maxResults: parsed.data.max_results,
      topic: parsed.data.topic,
      includeAnswer: parsed.data.include_answer,
      engine: parsed.data.engine,
      signal: abort.signal,
    });
    res.json({
      query: result.query,
      ...(result.answer !== undefined ? { answer: result.answer } : {}),
      results: result.results,
      provider: result.provider,
      engine: result.engine,
    });
  } catch (err: any) {
    if (res.headersSent || abort.signal.aborted) return;
    const status = err instanceof SearchError ? err.status : 502;
    if (err instanceof SearchError) {
      const retryAfter = searchRetryAfterSec(err);
      if (retryAfter !== undefined) res.setHeader('Retry-After', String(retryAfter));
    }
    const type = status === 400 ? 'invalid_request_error' : status === 429 ? 'rate_limit_error' : 'server_error';
    res.status(status).json({
      error: {
        message: `search error: ${err?.message ?? 'unknown'}`,
        type,
        ...(err instanceof SearchError && err.code ? { code: err.code } : {}),
      },
    });
  }
});

// The engines a caller can pin with `engine` on POST /v1/search.
proxyRouter.get('/search/engines', (req: Request, res: Response) => {
  if (!requireInferenceAuth(req, res)) return;
  res.json({
    object: 'list',
    data: listSearchEngines()
      .filter(e => e.enabled)
      .map(e => ({
        id: e.engineId,
        object: 'search_engine',
        provider: e.platform,
        name: e.displayName,
        available: e.healthyKeyCount > 0,
      })),
  });
});

// Decision models over the key pool. A decision model answers typed questions
// about `state` (pick one option, yes/no, or a score) with probabilities
// instead of generated text. Request shape is "System One":
//   { model?, state, questions: { <id>: { type, instructions, criteria? } } }
// Catalog rows only (Cloudflare Clef, OpenRouter Mercury Decide), on the keys
// the user already has for those platforms. Never used by chat routing.
// See services/decision.ts. /v1/systemone is an alias for System One clients.
const DecisionQuestionBody = z.object({
  type: z.enum(DECISION_QUESTION_TYPES),
  instructions: z.unknown().refine(v => v !== undefined && v !== null && v !== '', { message: 'instructions is required' }),
  criteria: z.unknown().optional(),
}).passthrough();

const DecisionBody = z.object({
  model: z.string().min(1).optional(),
  state: z.unknown().refine(v => v !== undefined && v !== null && v !== '', { message: 'state is required' }),
  questions: z.record(z.string().min(1).max(100), DecisionQuestionBody)
    .refine(q => Object.keys(q).length >= 1 && Object.keys(q).length <= 64, { message: 'questions must hold 1 to 64 entries' }).optional(),
  fields: z.record(z.string().min(1).max(100), z.object({
    type: z.enum(['text', 'number']),
    instructions: z.string().max(2000).optional(),
    decimals: z.number().int().min(0).max(10).optional(),
    unit: z.string().max(100).optional(),
  }).strict()).refine(f => Object.keys(f).length >= 1 && Object.keys(f).length <= 64, { message: 'fields must hold 1 to 64 entries' }).optional(),
}).refine(b => (b.questions !== undefined) !== (b.fields !== undefined), { message: 'Send either questions or fields' })
  .refine(b => !b.fields || typeof b.state === 'string', { message: 'Extraction requires text state' });

async function handleDecision(req: Request, res: Response): Promise<void> {
  if (!requireInferenceAuth(req, res)) return;
  const parsed = DecisionBody.safeParse(req.body);
  if (!parsed.success) {
    const detail = parsed.error.issues.map(e => `${e.path.join('.') || 'body'}: ${e.message}`).join('; ');
    res.status(400).json({ error: { message: `Invalid request: ${detail}`, type: 'invalid_request_error' } });
    return;
  }
  const abort = new AbortController();
  res.on('close', () => { if (!res.writableFinished) abort.abort(); });
  try {
    const { model, state, questions, fields } = parsed.data;
    const result = await runDecision(
      fields ? { state: state as string, fields } : { state, questions: questions as NonNullable<Parameters<typeof runDecision>[0]['questions']> },
      { model, signal: abort.signal },
    );
    res.json({
      object: 'decision',
      model: result.model,
      provider: result.provider,
      answers: result.answers,
      usage: result.usage,
      ...(result.modelVersion ? { model_version: result.modelVersion } : {}),
      ...(result.truncated !== undefined ? { truncated: result.truncated } : {}),
    });
  } catch (err: any) {
    if (res.headersSent || abort.signal.aborted) return;
    const status = err instanceof DecisionError ? err.status : 502;
    if (err instanceof DecisionError) {
      const retryAfter = decisionRetryAfterSec(err);
      if (retryAfter !== undefined) res.setHeader('Retry-After', String(retryAfter));
    }
    const type = status === 400 ? 'invalid_request_error' : status === 429 ? 'rate_limit_error' : 'server_error';
    res.status(status).json({
      error: {
        message: `decision error: ${err?.message ?? 'unknown'}`,
        type,
        ...(err instanceof DecisionError && err.code ? { code: err.code } : {}),
      },
    });
  }
}

proxyRouter.post('/decisions', handleDecision);
proxyRouter.post('/systemone', handleDecision);

// The decision models a caller can pin with `model` on POST /v1/decisions.
proxyRouter.get('/decisions/models', (req: Request, res: Response) => {
  if (!requireInferenceAuth(req, res)) return;
  res.json({
    object: 'list',
    data: listDecisionModels()
      .filter(m => m.enabled)
      .map(m => ({
        id: m.modelId,
        object: 'decision_model',
        provider: m.platform,
        name: m.displayName,
        context_window: m.contextWindow,
        available: m.healthyKeyCount > 0,
      })),
  });
});

// OpenAI-compatible image generation. Routed through the media catalog (its own
// table, never the chat router): `model: "auto"` (or omitted) tries every enabled
// image provider in order; a provider model id pins to that one. Failover is
// across providers, never across modalities. See services/media.ts.
const ImageBody = z.object({
  model: z.string().optional(),
  prompt: z.string().min(1),
  n: z.number().int().positive().max(4).optional(),
  size: z.string().optional(),
  response_format: z.enum(['url', 'b64_json']).optional(),
});

function inferenceBudgetCode(error: { code?: string; retryAfterMs?: number }, res: Response): { code?: string } {
  // retryAfterMs is set by the embeddings/media services only when the whole
  // chain was rate limited (soonest stated back-off, budget resets included),
  // so it wins over the month-long budget reset when a sibling returns sooner.
  if (error.retryAfterMs !== undefined) res.setHeader('Retry-After', retryAfterSeconds(error.retryAfterMs));
  else if (error.code === 'quota_exceeded') res.setHeader('Retry-After', secondsUntilNextMonth());
  return error.code ? { code: error.code } : {};
}

function mediaErrorType(status: number): string {
  if (status === 400 || status === 413) return 'invalid_request_error';
  if (status === 401) return 'authentication_error';
  if (status === 429) return 'rate_limit_error';
  return 'server_error';
}

proxyRouter.post('/images/generations', async (req: Request, res: Response) => {
  if (!requireInferenceAuth(req, res)) return;
  const parsed = ImageBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid request: `prompt` is required', type: 'invalid_request_error' } });
    return;
  }
  try {
    const result = await runImageGeneration(parsed.data.model, {
      prompt: parsed.data.prompt, n: parsed.data.n, size: parsed.data.size,
    });
    res.json({
      created: Math.floor(Date.now() / 1000),
      data: result.images,
      model: result.modelId,
      provider: result.platform,
    });
  } catch (err: any) {
    const status = err instanceof MediaError ? err.status : 502;
    const code = err instanceof MediaError ? inferenceBudgetCode(err, res) : {};
    const httpStatus = status >= 400 && status < 600 ? status : 502;
    res.status(httpStatus).json({ error: { message: `image generation error: ${err?.message ?? 'unknown'}`, type: mediaErrorType(status), ...code } });
  }
});

// Text-to-video generation. Providers may use a synchronous binary response
// (Pollinations) or an asynchronous queue internally (Hugging Face/fal.ai), but
// this gateway presents one bounded request and returns the completed MP4.
const VideoBody = z.object({
  model: z.string().optional(),
  prompt: z.string().min(1),
  duration: z.number().int().min(1).max(120).optional(),
  aspect_ratio: z.enum(['16:9', '9:16']).optional(),
  image: z.string().url().optional(),
  seed: z.number().int().min(-1).max(2_147_483_647).optional(),
  audio: z.boolean().optional(),
});

proxyRouter.post('/videos/generations', async (req: Request, res: Response) => {
  if (!requireInferenceAuth(req, res)) return;
  const parsed = VideoBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        message: 'Invalid request: `prompt` is required and video options must use supported values',
        type: 'invalid_request_error',
      },
    });
    return;
  }
  // A video job runs for minutes, so a caller that hangs up must actually stop
  // the work: without this the gateway would keep polling the provider and then
  // fail over to a second one, both charged to the operator, for a response
  // nobody is waiting for. 'close' also fires on normal completion, which
  // writableEnded distinguishes.
  const clientAbort = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) clientAbort.abort();
  });
  try {
    const result = await runVideoGeneration(parsed.data.model, {
      prompt: parsed.data.prompt,
      duration: parsed.data.duration,
      aspectRatio: parsed.data.aspect_ratio,
      image: parsed.data.image,
      seed: parsed.data.seed,
      audio: parsed.data.audio,
    }, clientAbort.signal);
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Provider', safeHeaderValue(result.platform));
    res.setHeader('X-Model', safeHeaderValue(result.modelId));
    res.send(result.video);
  } catch (err: any) {
    // Nothing to report to a socket that is already gone.
    if (clientAbort.signal.aborted || res.writableEnded) return;
    const status = err instanceof MediaError ? err.status : 502;
    const code = err instanceof MediaError ? inferenceBudgetCode(err, res) : {};
    const httpStatus = status >= 400 && status < 600 ? status : 502;
    res.status(httpStatus).json({
      error: { message: `video generation error: ${err?.message ?? 'unknown'}`, type: mediaErrorType(status), ...code },
    });
  }
});

// OpenAI-compatible text-to-speech. Returns raw audio bytes (OpenAI's /audio/speech
// shape). Same media-catalog routing as images.
const SpeechBody = z.object({
  model: z.string().optional(),
  input: z.string().min(1),
  voice: z.string().optional(),
  response_format: z.string().optional(),
});

proxyRouter.post('/audio/speech', async (req: Request, res: Response) => {
  if (!requireInferenceAuth(req, res)) return;
  const parsed = SpeechBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid request: `input` is required', type: 'invalid_request_error' } });
    return;
  }
  try {
    const result = await runSpeech(parsed.data.model, {
      input: parsed.data.input, voice: parsed.data.voice, format: parsed.data.response_format,
    });
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('X-Provider', safeHeaderValue(result.platform));
    res.send(result.audio);
  } catch (err: any) {
    const status = err instanceof MediaError ? err.status : 502;
    const code = err instanceof MediaError ? inferenceBudgetCode(err, res) : {};
    const httpStatus = status >= 400 && status < 600 ? status : 502;
    res.status(httpStatus).json({ error: { message: `speech error: ${err?.message ?? 'unknown'}`, type: mediaErrorType(status), ...code } });
  }
});

// OpenAI-compatible speech-to-text (/v1/audio/transcriptions). Multipart form
// upload, held in memory only (multer memoryStorage — audio bytes never touch
// disk), routed through the STT provider chain in services/media.ts with the
// same key/failover/cooldown machinery as the other media endpoints. The STT
// registry (media_models, modality='transcription') is maintained by the
// published catalog's `transcriptionModels` array via catalog-sync, plus any
// OpenAI-compatible endpoint the operator registered themselves through
// POST /api/media/custom; on an install that has never synced one and has no
// custom row, the endpoint answers 503 with code 'no_transcription_models'.
//
// response_format: 'json' (default, {"text": ...}), 'text' (plain string),
// 'verbose_json' (OpenAI verbose shape when the provider returns segments,
// graceful fallback to the plain json shape otherwise), 'vtt' (only from
// providers that produce it natively — Cloudflare whisper). 'srt' is not
// produced natively by any configured provider and is refused with 400
// unsupported_format rather than synthesized.
const transcriptionUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_TRANSCRIPTION_BYTES, files: 1 },
});

const TRANSCRIPTION_FORMATS = new Set(['json', 'text', 'verbose_json', 'srt', 'vtt']);

function transcriptionBadRequest(res: Response, message: string, code?: string): void {
  res.status(400).json({ error: { message, type: 'invalid_request_error', ...(code ? { code } : {}) } });
}

proxyRouter.post('/audio/transcriptions', (req: Request, res: Response, next) => {
  // Auth before the multipart body is parsed: an unauthenticated caller's
  // upload is never buffered.
  if (!requireInferenceAuth(req, res)) return;
  transcriptionUpload.single('file')(req, res, (err: unknown) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({
          error: {
            message: `Audio file too large: the maximum upload size is ${MAX_TRANSCRIPTION_BYTES / (1024 * 1024)} MB.`,
            type: 'invalid_request_error',
            code: 'file_too_large',
          },
        });
        return;
      }
      transcriptionBadRequest(res, 'Malformed multipart/form-data upload.');
      return;
    }
    next();
  });
}, async (req: Request, res: Response) => {
  const file = req.file;
  if (!file || !file.buffer?.length) {
    transcriptionBadRequest(res, 'Invalid request: `file` is required (multipart/form-data audio upload).');
    return;
  }
  const model = typeof req.body?.model === 'string' ? req.body.model.trim() : '';
  if (!model) {
    transcriptionBadRequest(res, "Invalid request: `model` is required (use 'whisper-1' or 'auto' to let the router decide).");
    return;
  }
  const rawFormat = typeof req.body?.response_format === 'string' ? req.body.response_format.trim() : '';
  const responseFormat = rawFormat || 'json';
  if (!TRANSCRIPTION_FORMATS.has(responseFormat)) {
    transcriptionBadRequest(res, `Invalid response_format '${responseFormat}'. Supported: json, text, verbose_json, vtt.`);
    return;
  }
  if (responseFormat === 'srt') {
    transcriptionBadRequest(
      res,
      "response_format 'srt' is not supported: no configured provider produces srt natively. Use json, text, verbose_json, or vtt.",
      'unsupported_format',
    );
    return;
  }
  let temperature: number | undefined;
  if (req.body?.temperature !== undefined && req.body.temperature !== '') {
    temperature = Number(req.body.temperature);
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 1) {
      transcriptionBadRequest(res, 'Invalid temperature: must be a number between 0 and 1.');
      return;
    }
  }
  const language = typeof req.body?.language === 'string' && req.body.language.trim() ? req.body.language.trim() : undefined;
  const prompt = typeof req.body?.prompt === 'string' && req.body.prompt ? req.body.prompt : undefined;

  try {
    const result = await runTranscription(model, {
      file: file.buffer,
      filename: file.originalname || 'audio',
      mimeType: file.mimetype,
      language,
      prompt,
      temperature,
      responseFormat,
    });
    res.setHeader('X-Provider', safeHeaderValue(result.platform));
    res.setHeader('X-Model', safeHeaderValue(result.modelId));
    if (responseFormat === 'text') {
      res.type('text/plain').send(result.text);
      return;
    }
    if (responseFormat === 'vtt') {
      res.type('text/vtt').send(result.vtt ?? '');
      return;
    }
    if (responseFormat === 'verbose_json' && Array.isArray(result.segments) && result.segments.length > 0) {
      res.json({
        task: 'transcribe',
        language: result.language ?? null,
        duration: result.duration ?? null,
        text: result.text,
        segments: result.segments,
      });
      return;
    }
    res.json({ text: result.text });
  } catch (err: any) {
    const status = err instanceof MediaError ? err.status : 502;
    const code = err instanceof MediaError ? inferenceBudgetCode(err, res) : {};
    const httpStatus = status >= 400 && status < 600 ? status : 502;
    res.status(httpStatus).json({ error: { message: `transcription error: ${err?.message ?? 'unknown'}`, type: mediaErrorType(status), ...code } });
  }
});


// /chat/completions and /completions live in their own route files now
// (routes/chat-completions.ts, routes/completions.ts); mounted here so the
// /v1 paths and registration order are unchanged.
proxyRouter.use(chatCompletionsRouter);
proxyRouter.use(completionsRouter);

// logRequest moved to lib/request-log.ts (shared with the fusion service to
// avoid an import cycle); imported above for internal use and re-exported here
// for routes/responses.ts which imports it from this module.
export { logRequest };

