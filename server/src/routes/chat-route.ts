// Shared plumbing for the /v1 chat surfaces (/chat/completions and the legacy
// /completions adapter). Split out of routes/proxy.ts so the two handlers
// can live in their own route files without an import cycle back into the
// proxy router: proxy.ts, chat-completions.ts and completions.ts all import
// from here, and proxy.ts re-exports the names its other importers
// (routes/anthropic.ts, routes/responses.ts, lib/inbound-chat.ts,
// custom/preparse-guard.ts, and the proxy tests) still pull from proxy.js.
import crypto from 'crypto';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { ChatMessage, Platform } from '@freellmapi/shared/types.js';
import type { ChainRow, ResolvedChain, RouteResult } from '../services/router.js';
import { resolveModelGroupCandidates, resolveStickyPreference } from '../services/router.js';
import { getDb } from '../db/index.js';
import { isUnifyEnabled, getModelGroups, resolveRequestedIdForDispatch } from '../services/model-groups.js';
import { inferQuotaPoolKey, type QuotaObservationContext } from '../services/provider-quota.js';
import { resolveAuth, type ResolvedAuth } from '../lib/system-prompt.js';
import { contentToString } from '../lib/content.js';
// Virtual "auto" model. Clients like Hermes require a non-empty `model` field
// on every request, but freellmapi's whole point is to pick the model itself.
// Requesting this id means "let the router decide" — identical to omitting
// `model` entirely.
export const AUTO_MODEL_ID = 'auto';

export function isAutoModel(modelId: string | undefined): boolean {
  if (!modelId) return true;
  const lower = modelId.toLowerCase();
  return lower === AUTO_MODEL_ID || lower.startsWith(`${AUTO_MODEL_ID}:`);
}

// Shared auth gate for the /v1 inference endpoints (#411): accepts the unified
// key (default behavior, no enforced prompt) or an enabled client-profile key
// (which may carry a server-enforced system prompt). Profile keys are ONLY
// valid here — never on the /api dashboard surface. Writes the 401 itself so
// call sites can simply bail on null.
export function requireInferenceAuth(req: Request, res: Response): ResolvedAuth | null {
  const auth = resolveAuth(extractApiToken(req));
  if (!auth) {
    res.status(401).json({ error: { message: 'Invalid API key', type: 'authentication_error' } });
    return null;
  }
  return auth;
}


// Extract the unified API key from an incoming request. Accepts both the
// OpenAI Bearer, Anthropic x-api-key, and Gemini x-goog-api-key headers.
// Query credentials remain scoped to the Gemini router.
export function extractApiToken(req: Request): string | undefined {
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '').trim();
  if (bearer) return bearer;

  const apiKeyHeader = req.headers['x-api-key'];
  const xApiKey = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;
  const trimmed = xApiKey?.trim();
  if (trimmed) return trimmed;
  const googleHeader = req.headers['x-goog-api-key'];
  const googleKey = Array.isArray(googleHeader) ? googleHeader[0] : googleHeader;
  return googleKey?.trim() || undefined;
}


export function quotaContextForRoute(route: RouteResult, endpoint: string): QuotaObservationContext {
  return {
    platform: route.platform as Platform,
    keyId: route.keyId,
    modelId: route.modelId,
    quotaPoolKey: inferQuotaPoolKey(route.platform as Platform, route.modelId),
    endpoint,
    origin: 'proxy',
  };
}

export function getRequestGroupId(req: Request): string {
  const raw = req.headers['x-request-id'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = value?.trim();
  return trimmed || crypto.randomUUID();
}

export function shortRequestId(requestId: string): string {
  return requestId.replace(/-/g, '').slice(0, 6);
}

type TraceEvent = 'start' | 'next' | 'ok' | 'fail';

export function traceRouteEvent(
  scope: 'Proxy' | 'Responses',
  opts: {
    event: TraceEvent;
    requestId: string;
    attempt: number;
    platform: string;
    model: string;
    requestedModel?: string;
    latencyMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    error?: string;
  },
) {
  const parts = [
    `[${scope}]`,
    new Date().toISOString().slice(11, 19),
    opts.event,
    shortRequestId(opts.requestId),
    `a${opts.attempt}`,
    opts.platform,
    '-',
    opts.model,
  ];
  if (opts.requestedModel) parts.push(`req=${opts.requestedModel}`);
  if (opts.latencyMs != null) parts.push(`lat=${opts.latencyMs}ms`);
  if (opts.inputTokens != null) parts.push(`in=${opts.inputTokens}`);
  if (opts.outputTokens != null) parts.push(`out=${opts.outputTokens}`);
  if (opts.error) parts.push(`err=${JSON.stringify(opts.error)}`);
  console.log(parts.join(' '));
}

// Sticky sessions: track which model served each "session"
// Key: hash of first user message → model_db_id
// This prevents model switching mid-conversation which causes hallucination
const stickySessionMap = new Map<string, { modelDbId: number; lastUsed: number }>();
const STICKY_TTL_MS = 30 * 60 * 1000; // 30 min session TTL

// #797: per-session memory of the last assistant turn's thinking trace.
// DeepSeek thinking models on OpenCode Zen 400 on a follow-up turn unless the
// prior `reasoning_content` is replayed; opencode (and other AI-SDK clients)
// strip the field when re-serializing history, so the proxy restores what it
// itself returned last turn. Non-thinking sessions never record an entry.
// The trace is stored WITH the model key that produced it: a remembered trace
// is only ever replayed to that same platform+model, so a session that fails
// over (or auto-routes elsewhere on the next turn) never carries one model's
// thinking into another provider's payload.
const reasoningMemory = new Map<string, { reasoning: string; modelKey: string; lastUsed: number }>();
const REASONING_TTL_MS = 30 * 60 * 1000; // 30 min, matching sticky sessions

// Platforms that reject an assistant turn WITHOUT `reasoning_content` once the
// conversation is in thinking mode, i.e. where the field has to be present on
// every assistant message and older turns need an empty-string filler. Only
// OpenCode Zen is on record for this (the DeepSeek thinking semantics behind
// #255/#797); everywhere else only the turn we actually have a trace for is
// touched, so no other provider's bytes change.
const PLATFORMS_REQUIRING_REASONING_ECHO = new Set(['opencode']);

export function rememberReasoning(sessionKey: string | undefined, modelKey: string, reasoning: string) {
  if (!sessionKey || !reasoning) return;
  reasoningMemory.set(sessionKey, { reasoning, modelKey, lastUsed: Date.now() });
  if (reasoningMemory.size > 500) {
    const now = Date.now();
    for (const [key, entry] of reasoningMemory) {
      if (now - entry.lastUsed > REASONING_TTL_MS) reasoningMemory.delete(key);
    }

    // Hard cap: traces are far bigger than a sticky entry, so an all-fresh map
    // must not grow without bound. Evict oldest by lastUsed, as setStickyModel does.
    if (reasoningMemory.size > 1000) {
      const entries = [...reasoningMemory.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
      const toEvict = reasoningMemory.size - 1000;
      for (let i = 0; i < toEvict; i++) reasoningMemory.delete(entries[i][0]);
    }
  }
}

// The remembered trace for this session, or undefined when there is none, it
// expired, or it came from a different model than the one about to be called.
// An expired entry is dropped on read rather than left for the size sweep.
export function clearReasoningMemory() {
  reasoningMemory.clear();
  stickySessionMap.clear();
}

export function rememberedReasoningFor(sessionKey: string, modelKey: string): string | undefined {
  if (!sessionKey) return undefined;
  const entry = reasoningMemory.get(sessionKey);
  if (!entry) return undefined;
  if (Date.now() - entry.lastUsed > REASONING_TTL_MS) {
    reasoningMemory.delete(sessionKey);
    return undefined;
  }
  return entry.modelKey === modelKey ? entry.reasoning : undefined;
}

// Put the remembered trace back on the newest assistant turn that lost it.
// Returns a NEW array (with new objects for the messages it changes) whenever
// it changes anything — the caller's `messages` are what handoff recording,
// logging, compression and the response cache already saw, and must not move
// under them. Returns the input untouched when there is nothing to restore.
export function restoreSessionReasoning(messages: ChatMessage[], reasoning: string, platform: string): ChatMessage[] {
  // Older assistant turns get "" — DeepSeek requires the field on every
  // assistant message, and an empty string satisfies it (see opencode issue
  // #24104). Only for platforms that actually enforce that; elsewhere just the
  // one turn we have a real trace for is touched.
  const fillOlderTurns = PLATFORMS_REQUIRING_REASONING_ECHO.has(platform);
  let restored: ChatMessage[] | undefined;
  let restoredLatest = false;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    // The client kept the field — nothing was dropped, leave it alone.
    if (typeof m.reasoning_content === 'string' && m.reasoning_content.length > 0) continue;
    restored ??= [...messages];
    restored[i] = { ...m, reasoning_content: restoredLatest ? '' : reasoning };
    if (!restoredLatest && !fillOlderTurns) break;
    restoredLatest = true;
  }
  return restored ?? messages;
}

/**
 * The messages that identify a conversation for sticky routing, context
 * handoff and reasoning replay. Take it BEFORE compression: the aging and
 * budget engines rewrite or drop old user turns, and the session key hashes
 * the first one, so a compressed request would otherwise look like a new
 * conversation (#1889). The first user turn is snapshotted as text so an
 * in-place rewrite of its content cannot change the key either.
 */
export function sessionIdentityMessages(messages: ChatMessage[]): ChatMessage[] {
  const out = messages.slice();
  const firstUserIndex = out.findIndex(message => message.role === 'user');
  if (firstUserIndex !== -1) {
    const firstUser = out[firstUserIndex]!;
    out[firstUserIndex] = { ...firstUser, content: contentToString(firstUser.content ?? '') };
  }
  return out;
}

export function getSessionKey(messages: ChatMessage[], sessionIdHeader?: string, strategyKey?: string): string {
  if (sessionIdHeader) {
    return strategyKey ? `hdr:${sessionIdHeader}::${strategyKey}` : `hdr:${sessionIdHeader}`;
  }

  const firstUser = messages.find(m => m.role === 'user');
  if (!firstUser) return '';
  const text = contentToString(firstUser.content ?? '');
  if (!text) return '';
  const payload = strategyKey ? `${text}::${strategyKey}` : text;
  return crypto.createHash('sha1').update(payload).digest('hex');
}

export function getStickyModel(messages: ChatMessage[], sessionIdHeader?: string, strategyKey?: string): number | undefined {
  const hasAssistant = messages.some(m => m.role === 'assistant');
  if (!hasAssistant) return undefined;

  const key = getSessionKey(messages, sessionIdHeader, strategyKey);
  if (!key) return undefined;

  const entry = stickySessionMap.get(key);
  if (!entry) return undefined;

  if (Date.now() - entry.lastUsed > STICKY_TTL_MS) {
    stickySessionMap.delete(key);
    return undefined;
  }
  return entry.modelDbId;
}

export function setStickyModel(messages: ChatMessage[], modelDbId: number, sessionIdHeader?: string, strategyKey?: string) {
  const key = getSessionKey(messages, sessionIdHeader, strategyKey);
  if (!key) return;
  stickySessionMap.set(key, { modelDbId, lastUsed: Date.now() });

  // Cleanup old entries
  if (stickySessionMap.size > 500) {
    const now = Date.now();
    for (const [k, v] of stickySessionMap) {
      if (now - v.lastUsed > STICKY_TTL_MS) stickySessionMap.delete(k);
    }

    // Hard cap: if still over 1000 after pruning expired entries, evict oldest by lastUsed
    if (stickySessionMap.size > 1000) {
      const entries = [...stickySessionMap.entries()].sort(
        (a, b) => a[1].lastUsed - b[1].lastUsed
      );
      const toEvict = stickySessionMap.size - 1000;
      for (let i = 0; i < toEvict; i++) {
        stickySessionMap.delete(entries[i][0]);
      }
    }
  }
}

export const stopSchema = z.union([z.string(), z.array(z.string()).min(1).max(64)]);

export function providerSafeStop(stop: string | string[] | undefined): string | string[] | undefined {
  if (!Array.isArray(stop)) return stop;
  return stop.slice(0, 4);
}

// Pull the incremental reasoning text out of a streaming chunk. Reasoning
// models stream thinking via `reasoning_content` (Z.ai, DeepSeek-style — the
// <think> extractor in base.ts normalizes inline tags into the same field) or
// `reasoning` (Ollama-style) before the first visible answer token; both
// spellings must count for ttfb and output-token estimates. Same shape
// tolerance as streamChunkText. (#764)
export function streamReasoningText(chunk: any): string {
  const delta = chunk?.choices?.[0]?.delta;
  const r = delta?.reasoning_content ?? delta?.reasoning;
  return typeof r === 'string' ? r : '';
}

// Non-streaming counterpart of streamReasoningText: reasoning models attach
// thinking to the completed message as `reasoning_content` or `reasoning`.
// Included in the chars/4 output estimate so analytics and the rate-limit
// ledger aren't undercounted for thinking models. (#764)
export function completionReasoningText(result: any): string {
  const msg = result?.choices?.[0]?.message;
  const r = msg?.reasoning_content ?? msg?.reasoning;
  return typeof r === 'string' ? r : '';
}

export const MAX_RETRIES = 20;
// ── Shared route resolution ──────────────────────────────────────────────
// The model-routing preamble both chat surfaces ran as duplicated inline
// blocks: Claude-alias tier chain, auto chain, unified-group (model-groups)
// resolution with its honest 404/503 replies, and the legacy single-row
// pin. The /chat/completions surface additionally applies the sticky-session
// preference (pass getStickyModel + sessionMessages); /completions passes
// neither, so its pins stay exactly as before (no stickiness on the legacy
// surface). The auto chain / strategyKey are resolved by the caller BEFORE
// the context-handoff recording (which must still happen before this call
// returns 404/503) and passed in, so call order — and its side effects —
// are unchanged in both handlers.
export type ChatRouteError = {
  status: 404 | 503;
  error: { message: string; type: string; code: string };
};

export type ResolvedChatRoute = {
  resolvedChain?: ResolvedChain;
  strategyKey?: string;
  stickyStrategyKey?: string;
  groupChain?: ChainRow[];
  preferredModel?: number;
};

export function resolveChatRoute(opts: {
  requestedModel: string | undefined;
  aliasTierChain: ChainRow[];
  resolvedChain?: ResolvedChain;
  strategyKey?: string;
  sessionMessages?: ChatMessage[];
  sessionIdHeader?: string;
  getStickyModel?: (messages: ChatMessage[], sessionIdHeader?: string, strategyKey?: string) => number | undefined;
}): { route: ResolvedChatRoute } | { error: ChatRouteError } {
  const { requestedModel, aliasTierChain } = opts;
  // Sticky lookup only when the caller opted into stickiness (chat surface).
  const sticky = (key?: string): number | undefined =>
    opts.getStickyModel && opts.sessionMessages
      ? opts.getStickyModel(opts.sessionMessages, opts.sessionIdHeader, key)
      : undefined;

  let groupChain: ChainRow[] | undefined;
  let preferredModel: number | undefined;
  // Sticky scope: auto requests bucket by routing strategy; a unified group
  // pin buckets by the canonical id the client sent, so the group prefers
  // its last successful provider without leaking stickiness across groups.
  let stickyStrategyKey: string | undefined = opts.strategyKey;

  if (aliasTierChain.length > 0) {
    // A tier-mapped Claude alias routes STRICTLY over its tier's pool. An
    // empty tier falls through to plain auto, as on /v1/messages.
    groupChain = aliasTierChain;
    stickyStrategyKey = `tier:${aliasTierChain[0]!.model_db_id}`;
    const s = sticky(stickyStrategyKey);
    preferredModel = (s != null && groupChain.some(r => r.model_db_id === s)) ? s : undefined;
  } else if (isAutoModel(requestedModel)) {
    preferredModel = resolveStickyPreference(sticky(opts.strategyKey), opts.resolvedChain?.chain);
  } else if (requestedModel) {
    const db = getDb();
    // Unify ON: a requested id (canonical slug OR any provider's model_id)
    // maps to the whole logical-model group, and we route STRICTLY across
    // only its providers — failing over between them, never to a different
    // model (#335).
    const resolved = isUnifyEnabled() ? resolveRequestedIdForDispatch(requestedModel, getModelGroups()) : null;
    const members = resolved?.memberDbIds ?? null;
    if (members && members.length > 0) {
      groupChain = resolveModelGroupCandidates(members, resolved!.demotedDbIds);
      if (groupChain.length === 0) {
        // Distinguish a catalog-disabled model (404 model_not_found, OpenAI
        // semantics) from one whose providers are present but unusable
        // (chain-disabled / no key) — the latter is a server-side
        // configuration gap, so it renders an honest 503.
        const placeholders = members.map(() => '?').join(',');
        const anyEnabled = db.prepare(`SELECT 1 FROM models WHERE id IN (${placeholders}) AND enabled = 1 LIMIT 1`).get(...members);
        if (anyEnabled) {
          return { error: { status: 503, error: {
            message: `Model '${requestedModel}' has no providers with an enabled key. Add a provider API key for it, use 'auto' (or omit the 'model' field) to auto-route, or call /v1/models for the available list.`,
            type: 'service_unavailable',
            code: 'no_providers_configured',
          } } };
        }
        return { error: { status: 404, error: {
          message: `Model '${requestedModel}' is disabled. Use 'auto' (or omit the 'model' field) to auto-route, or call /v1/models for the available list.`,
          type: 'invalid_request_error',
          code: 'model_not_found',
        } } };
      }
      stickyStrategyKey = requestedModel;
      const s = sticky(stickyStrategyKey);
      // Only prefer the sticky member if it's actually IN this group —
      // passing a non-member as preferredModelDbId would make routeRequest
      // inject an off-group model and break strict pinning.
      preferredModel = (s != null && groupChain.some(r => r.model_db_id === s)) ? s : undefined;
    } else {
      // Unify OFF, or an id that isn't in the catalog: legacy single-row pin.
      const enabled = db.prepare('SELECT id FROM models WHERE model_id = ? AND enabled = 1').get(requestedModel) as { id: number } | undefined;
      if (enabled) {
        preferredModel = enabled.id;
      } else {
        const disabled = db.prepare('SELECT id FROM models WHERE model_id = ?').get(requestedModel) as { id: number } | undefined;
        const reason = disabled ? 'is disabled' : 'is not in the catalog';
        return { error: { status: 404, error: {
          message: `Model '${requestedModel}' ${reason}. Use 'auto' (or omit the 'model' field) to auto-route, or call /v1/models for the available list.`,
          type: 'invalid_request_error',
          code: 'model_not_found',
        } } };
      }
    }
  } else {
    preferredModel = resolveStickyPreference(sticky(opts.strategyKey), opts.resolvedChain?.chain);
  }

  return { route: { resolvedChain: opts.resolvedChain, strategyKey: opts.strategyKey, stickyStrategyKey, groupChain, preferredModel } };
}
