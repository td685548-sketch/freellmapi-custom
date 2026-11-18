import { resolveAccountProvider } from '../provider-accounts/execution.js';
import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { getDb } from '../../db/index.js';
import type { ChatCompletionChunk, ChatCompletionResponse, ChatMessage } from '@freellmapi/shared/types.js';
import type { CompletionOptions } from '../../providers/base.js';
import { decrypt } from '../../lib/crypto.js';
import { estimateInputTokens } from '../../lib/content.js';
import { assessProviderUrl } from '../../lib/url-guard.js';
import { proxyFetch } from '../../lib/proxy.js';
import { withQuotaTracking } from './quota/tracking.js';
import { applyQuotaRouting, isWebCookieProvider } from './quota/store.js';
import { resolveSystemOneComboOrder } from './systemone-router.js';
import { executeJudgeFusion } from './combo-fusion.js';
import { getAccountCooldown } from '../provider-accounts/auto-ping.js';
import {
  clearAutoSessionRoute,
  getAutoSessionRoute,
  resetAutoSessionCache,
  setAutoSessionRoute,
} from './auto-session-cache.js';
import {
  getAutoStreamPeekTimeoutMs,
  peekStreamForContent,
  reconstructStream,
} from './stream-peek.js';
import { logRequest } from '../../lib/request-log.js';
import { getClientContext } from '../../lib/client-context.js';
import { sanitizeProviderErrorMessage } from '../../lib/error-redaction.js';
import { beginUsageRequest, cancelUsageRequest, endUsageRequest } from './usage-stream.js';
import { applyOutputSavers } from '../output-savers/apply.js';
import { buildSaverBlock } from '../output-savers/prompts.js';
import {
  getXGatewayProvider,
  X_GATEWAY_PROVIDERS,
  normalizeXGatewayProviderId,
} from '../provider-accounts/catalog.js';
import {
  accountModels,
  getProviderModelConfig,
  getUsableXGatewayKeys,
  recordXGatewayKeyUsage,
  resolveProviderModelAlias,
  resolveXGatewayAccountProxy,
  resolveXGatewayModelAlias,
  type AccountRow,
} from '../provider-accounts/store.js';
import { xGatewayAuth as authenticateXGateway } from './auth.js';
import { isModelAllowedForKey, type ValidatedXGatewayClientKey } from './client-keys.js';
import { augmentCandidatesWithCapacityAdapter, looksLikeVisionModel } from './capacity-adapter.js';
import {
  DEFAULT_COMBO_STRATEGY,
  resolveComboPolicy,
  rotateComboEntries,
  type ComboKind,
  type ComboPolicyInput,
  type ComboSmartPolicy,
  type ComboStrategy,
} from './combos.js';
import { effectiveProviderPolicy, getRoutingDefaults, shouldRotateCombo } from './routing-defaults.js';
import { getConfigSnapshot, getRouteHealthTtlMinutes } from './config.js';
import {
  filterCandidatesByCooldown,
  recordCandidateFailure,
  recordCandidateSuccess,
  resetRouteBackoff,
} from './route-cooldown.js';
import { runInGatewayScope } from './context.js';
import { xGatewayProtocolsRouter } from './protocols.js';
import { preprocessGatewayMessages } from './token-savers-pipeline.js';
import {
  captureGatewayThinkingResponse,
  prepareGatewayThinkingRequest,
} from './thinking-normalize.js';
import { xSupportPublicRouter } from './support-router.js';
import { xSupportEnterprisePublicRouter } from './support-enterprise-router.js';
import { xSupportGovernancePublicRouter } from './support-governance-router.js';
import { xSupportServiceDeskPublicRouter } from './support-service-desk-router.js';

export const xGatewayRouter = Router();

export type ThinkingEffort = 'low' | 'medium' | 'high' | 'max' | 'minimal' | 'none';

export function parseModelThinkingSuffix(rawModel: string | undefined): {
  cleanModel: string;
  thinkingEffort?: ThinkingEffort;
} {
  const model = rawModel?.trim() || 'auto';
  const match = /^(.*\S)\((low|medium|high|max|minimal|none)\)$/i.exec(model);
  return match
    ? { cleanModel: match[1].trim(), thinkingEffort: match[2].toLowerCase() as ThinkingEffort }
    : { cleanModel: model };
}

/** Authorize the underlying model, so adding an effort suffix cannot change a
 * key's allowlist decision. Keep the original spelling for the handler. */
export function xGatewayAuth(req: Request, res: Response, next: NextFunction): void {
  const body = req.body;
  if (!body || typeof body.model !== 'string') { authenticateXGateway(req, res, next); return; }
  const originalModel = body.model;
  body.model = parseModelThinkingSuffix(originalModel).cleanModel;
  try {
    authenticateXGateway(req, res, () => { body.model = originalModel; next(); });
  } finally { body.model = originalModel; }
}

// Provider policies live in x_gateway_config.provider_settings, keyed by provider
// ID or alias. Keep cursors scoped to the current database and account set.
const providerCursors = new Map<string, { signature: string; calls: number }>();
let providerCursorDb: unknown;
const PROVIDER_SETTINGS_CACHE_TTL_MS = 5_000;
let providerSettingsCache: {
  db: unknown;
  snapshot: unknown;
  expiresAt: number;
  settings: Record<string, { strategy?: string; stickyLimit?: number }>;
} | null = null;

function readProviderSettings(db: ReturnType<typeof getDb>): Record<string, { strategy?: string; stickyLimit?: number }> {
  const now = Date.now();
  const snapshot = getConfigSnapshot();
  if (
    providerSettingsCache
    && providerSettingsCache.db === db
    && providerSettingsCache.snapshot === snapshot
    && now < providerSettingsCache.expiresAt
  ) {
    return providerSettingsCache.settings;
  }
  let settings: Record<string, { strategy?: string; stickyLimit?: number }> = {};
  try {
    const row = db.prepare("SELECT value FROM x_gateway_config WHERE key = 'provider_settings'").get() as { value: string } | undefined;
    settings = row ? JSON.parse(row.value) : {};
  } catch { /* An absent or malformed policy retains fallback order. */ }
  providerSettingsCache = { db, snapshot, expiresAt: now + PROVIDER_SETTINGS_CACHE_TTL_MS, settings };
  return settings;
}

function rotateProviderAccounts<T extends AccountRow>(accounts: T[]): T[] {
  const db = getDb();
  if (providerCursorDb !== db) {
    providerCursors.clear();
    providerCursorDb = db;
  }
  if (accounts.length < 2) {
    for (const account of accounts) providerCursors.delete(account.provider);
    return accounts;
  }
  const groups = new Map<string, T[]>();
  let hasRotatableGroup = false;
  for (const account of accounts) {
    const group = groups.get(account.provider);
    if (group) {
      group.push(account);
      hasRotatableGroup = true;
    } else {
      groups.set(account.provider, [account]);
    }
  }
  if (!hasRotatableGroup) {
    for (const provider of groups.keys()) providerCursors.delete(provider);
    return accounts;
  }
  const settings = readProviderSettings(db);
  for (const [provider, group] of groups) {
    const alias = getXGatewayProvider(provider)?.alias ?? provider;
    const modelCfg = getProviderModelConfig(provider);
    const policy = settings?.[provider] ?? settings?.[alias] ?? effectiveProviderPolicy(provider, modelCfg);
    if (policy?.strategy !== 'round-robin' || group.length < 2) { providerCursors.delete(provider); continue; }
    const limit = Number.isFinite(policy.stickyLimit) ? Math.max(1, Math.floor(policy.stickyLimit!)) : 1;
    const signature = `${limit}:${group.map(a => a.id).join(',')}`;
    const previous = providerCursors.get(provider);
    const calls = previous?.signature === signature ? previous.calls : 0;
    const offset = Math.floor(calls / limit) % group.length;
    groups.set(provider, [...group.slice(offset), ...group.slice(0, offset)]);
    providerCursors.set(provider, { signature, calls: (calls + 1) % (limit * group.length) });
  }
  // Preserve provider priority and interleaving, rotating only its own slots.
  return accounts.map(account => groups.get(account.provider)!.shift()!);
}

function rotateCandidateAccounts(candidates: CandidateRoute[]): CandidateRoute[] {
  const unique = [...new Map(candidates.map(c => [c.account.id, c.account])).values()];
  const rank = new Map(rotateProviderAccounts(unique).map((a, i) => [a.id, i]));
  const groups = new Map<string, CandidateRoute[]>();
  const key = (c: CandidateRoute) => `${c.step ?? ''}:${c.account.provider}`;
  for (const candidate of candidates) groups.set(key(candidate), [...(groups.get(key(candidate)) ?? []), candidate]);
  for (const group of groups.values()) group.sort((a, b) => rank.get(a.account.id)! - rank.get(b.account.id)!);
  return candidates.map(c => groups.get(key(c))!.shift()!);
}

export interface CandidateRoute {
  account: AccountRow & { requests: number; tokens: number };
  modelId: string;
  /** Combo step this candidate came from (0-based, after round-robin rotation). */
  step?: number;
}

function isWithinAccountCaps(account: AccountRow & { requests: number; tokens: number }): boolean {
  if (account.monthly_request_cap > 0 && account.requests >= account.monthly_request_cap) return false;
  if (account.monthly_token_cap > 0 && account.tokens >= account.monthly_token_cap) return false;
  return true;
}

export type CandidateModality = 'chat' | 'image' | 'vision';

const IMAGE_MODEL_RE =
  /(?:^|[^a-z])(image|imagen|dall-?e|flux|diffusion|sdxl|seedream|ideogram|recraft|midjourney|qwen-image|wanx)(?:[^a-z]|$)/i;
const VIDEO_MODEL_RE =
  /(?:^|[^a-z])(video|veo|sora|kling|luma|hunyuan-video|seedance)(?:[^a-z]|$)|wan[\d.-]|grok-imagine-video/i;
const TTS_MODEL_RE =
  /(?:^|[^a-z])(tts|speech|voice|sonic)(?:[^a-z]|$)|eleven_|aura-/i;
const STT_MODEL_RE =
  /(?:^|[^a-z])(stt|whisper|transcription|transcribe)(?:[^a-z]|$)|nova-.*general/i;
const EMBEDDING_MODEL_RE = /embed/i;
const NON_CHAT_ONLY_PROVIDERS = new Set([
  'tavily', 'serper', 'brave-search', 'exa', 'searxng',
  'edge-tts', 'elevenlabs', 'cartesia', 'fish-audio', 'aws-polly',
  'deepgram', 'assemblyai',
  'black-forest-labs', 'fal-ai', 'sdwebui', 'comfyui', 'kling', 'luma',
]);

function isNonChatModel(model: { id: string; name?: string }): boolean {
  const target = `${model.id} ${model.name ?? ''}`;
  return (
    IMAGE_MODEL_RE.test(target)
    || VIDEO_MODEL_RE.test(target)
    || TTS_MODEL_RE.test(target)
    || STT_MODEL_RE.test(target)
    || EMBEDDING_MODEL_RE.test(target)
  );
}

/**
 * `auto` normally means "first model of the account", which is a chat model.
 * Image routes need the account's image model instead, or the chat model gets
 * forwarded to `/images/generations` and rejected upstream.
 * Chat and vision routes filter out image, TTS, STT, embedding, and video
 * models so `gemini-image` and media-only models are never chosen for text chat.
 */
function orderModelsForModality<T extends { id: string; name?: string }>(
  models: T[],
  modality: CandidateModality,
): T[] {
  const isImage = (m: T) => IMAGE_MODEL_RE.test(m.id) || IMAGE_MODEL_RE.test(m.name ?? '');
  if (modality === 'image') {
    return [...models.filter(isImage), ...models.filter(m => !isImage(m))];
  }
  const chatModels = models.filter(m => !isNonChatModel(m));
  if (modality === 'vision') {
    return [
      ...chatModels.filter(m => looksLikeVisionModel(m.id)),
      ...chatModels.filter(m => !looksLikeVisionModel(m.id)),
    ];
  }
  return chatModels;
}

function pickCandidateModel(models: { id: string; name?: string }[], modality: CandidateModality): string | null {
  if (modality === 'image') {
    const image = models.find(m => IMAGE_MODEL_RE.test(m.id) || IMAGE_MODEL_RE.test(m.name ?? ''));
    if (image) return image.id;
    const generic = models.find(m => m.id.toLowerCase() === 'default' || m.id.toLowerCase() === 'auto');
    if (generic) return generic.id;
    return models[0]?.id ?? 'default';
  }
  const ordered = orderModelsForModality(models, modality);
  if (ordered.length > 0) return ordered[0].id;
  return models.length === 0 ? 'default' : null;
}

export interface ComboRouteInfo {
  name: string;
  strategy: ComboStrategy;
  kind?: ComboKind;
  smartPolicy: ComboSmartPolicy;
  sessionSticky: boolean;
  confidenceThreshold: number;
  systemOneModel?: string;
  judgeModel?: string;
}

/**
 * Resolve a `provider/model` request through the operator's model aliases and
 * report whether the effective model was disabled for that provider. Using the
 * account store (rather than the raw request string) means a combo or client
 * asking for `provider/alias` hits the real model, and disabled models are
 * skipped instead of being forwarded upstream.
 */
function resolveRouteModel(provider: string, requested: string): { modelId: string; disabled: boolean } {
  const config = getProviderModelConfig(provider);
  const modelId = resolveProviderModelAlias(provider, requested);
  const requestedLower = requested.trim().toLowerCase();
  const resolvedLower = modelId.trim().toLowerCase();
  const disabled = config.disabledModels.some(candidate => {
    const normalized = candidate.trim().toLowerCase();
    return normalized === requestedLower || normalized === resolvedLower;
  });
  return { modelId, disabled };
}

function finalizeCandidateRoutes(
  candidates: CandidateRoute[],
  extra?: { combo?: ComboRouteInfo },
): {
  candidates: CandidateRoute[];
  combo?: ComboRouteInfo;
  allRateLimited?: boolean;
  retryAfterMs?: number;
} {
  const filtered = filterCandidatesByCooldown(candidates);
  return {
    candidates: filtered.available,
    ...extra,
    ...(filtered.allRateLimited ? { allRateLimited: true, retryAfterMs: filtered.retryAfterMs } : {}),
  };
}

function sortAutoCandidates(candidates: CandidateRoute[]): CandidateRoute[] {
  const healthSorted = sortCandidatesByHealth(candidates);
  // Keep healthy API-key/OAuth/free providers ahead of slow webCookie scrapers,
  // while still demoting actively failing routes behind healthy ones.
  return [...healthSorted].sort((a, b) => {
    const aHealth = routeHealth.get(healthKey(a));
    const bHealth = routeHealth.get(healthKey(b));
    const aFailing = aHealth && isRouteHealthFailing(aHealth) ? 1 : 0;
    const bFailing = bHealth && isRouteHealthFailing(bHealth) ? 1 : 0;
    if (aFailing !== bFailing) return aFailing - bFailing;
    const aWeb = isWebCookieProvider(a.account.provider) ? 1 : 0;
    const bWeb = isWebCookieProvider(b.account.provider) ? 1 : 0;
    if (aWeb !== bWeb) return aWeb - bWeb;
    return 0;
  });
}

export function resolveCandidateRoutes(
  requestedModel: string | undefined,
  modality?: CandidateModality,
): {
  candidates: CandidateRoute[];
  notFoundError?: string;
  combo?: ComboRouteInfo;
  allRateLimited?: boolean;
  retryAfterMs?: number;
} {
  const effectiveModality: CandidateModality = modality ?? 'chat';
  const strictChatModality = modality === 'chat' || modality === 'vision';
  const rawModel = resolveXGatewayModelAlias(parseModelThinkingSuffix(requestedModel).cleanModel);
  const lower = rawModel.toLowerCase();
  const isAuto = lower === 'auto' || lower.startsWith('auto:');
  const usable = applyQuotaRouting(getUsableXGatewayKeys().filter(isWithinAccountCaps), isAuto);

  if (isAuto) {
    const candidates: CandidateRoute[] = [];
    for (const account of usable) {
      if (strictChatModality && NON_CHAT_ONLY_PROVIDERS.has(account.provider)) {
        continue;
      }
      const models = accountModels(account);
      if (models.length === 0) {
        candidates.push({ account, modelId: 'default' });
        continue;
      }
      if (effectiveModality === 'image') {
        const picked = pickCandidateModel(models, effectiveModality);
        if (picked) {
          candidates.push({ account, modelId: picked });
        }
        continue;
      }
      const orderedAll = orderModelsForModality(models, effectiveModality);
      const eligibleAll = orderedAll.length > 0
        ? orderedAll
        : (!strictChatModality ? models : []);
      if (eligibleAll.length === 0) continue;
      // Prefer a non-cooled-down chat/vision model for this account, falling back
      // to the full eligible pool so finalizeCandidateRoutes can report allRateLimited
      // if every matching model is currently cooling down.
      const healthyEligible = eligibleAll.filter(m => !getAccountCooldown(account.id, m.id).inCooldown);
      const pool = healthyEligible.length > 0 ? healthyEligible : eligibleAll;
      const best = sortCandidatesByHealth(pool.map(m => ({ account, modelId: m.id })))[0];
      candidates.push(best);
    }
    const ordered = sortAutoCandidates(rotateCandidateAccounts(candidates));
    if (effectiveModality === 'vision') {
      ordered.sort((a, b) => {
        const aVision = looksLikeVisionModel(a.modelId) ? 1 : 0;
        const bVision = looksLikeVisionModel(b.modelId) ? 1 : 0;
        return bVision - aVision;
      });
    }
    return finalizeCandidateRoutes(ordered);
  }

  if (lower.startsWith('combo:')) {
    const comboName = rawModel.slice(6).trim().toLowerCase();
    const combo = getConfigSnapshot().combos.find(c => c.name.toLowerCase() === comboName);
    if (!combo) {
      return { candidates: [], notFoundError: `Combo '${rawModel}' not found` };
    }
    const strategy = combo.strategy ?? DEFAULT_COMBO_STRATEGY;
    // Round-robin rotates the starting step; the remaining order is untouched,
    // so a failed step still falls through to the ones behind it.
    const routingDefaults = getRoutingDefaults();
    const steps = shouldRotateCombo(strategy, routingDefaults)
      ? rotateComboEntries(combo.name, combo.entries, routingDefaults.comboStickyLimit)
      : combo.entries;
    const candidates: CandidateRoute[] = [];
    steps.forEach((step, stepIndex) => {
      const targetProvider = normalizeXGatewayProviderId(step.platform) ?? step.platform.toLowerCase();
      const route = resolveRouteModel(targetProvider, step.modelId);
      // A disabled model must not be silently sent upstream; the step is simply
      // not routable and the next one serves the request.
      if (route.disabled) return;
      for (const account of usable) {
        if (account.provider === targetProvider) {
          candidates.push({ account, modelId: route.modelId, step: stepIndex });
        }
      }
    });
    return finalizeCandidateRoutes(
      strategy === 'smart' ? sortCandidatesByHealth(rotateCandidateAccounts(candidates)) : rotateCandidateAccounts(candidates),
      {
        combo: {
          name: combo.name,
          strategy,
          ...resolveComboPolicy(combo),
          ...(combo.kind ? { kind: combo.kind } : {}),
          ...(combo.systemOneModel ? { systemOneModel: combo.systemOneModel } : {}),
          ...(combo.judgeModel ? { judgeModel: combo.judgeModel } : {}),
        },
      },
    );
  }

  const slashIdx = rawModel.indexOf('/');
  if (slashIdx > 0) {
    const prefix = rawModel.slice(0, slashIdx);
    const suffix = rawModel.slice(slashIdx + 1);
    const matchedProvider = normalizeXGatewayProviderId(prefix) ?? (usable.some(a => a.provider === prefix) ? prefix : null);
    if (matchedProvider && suffix) {
      const suffixLower = suffix.toLowerCase();
      if (suffixLower === 'auto' || suffixLower.startsWith('auto:')) {
        const providerAccounts = rotateProviderAccounts(usable.filter(a => a.provider === matchedProvider));
        const perAccountModels = providerAccounts.map(account => {
          const rawModels = accountModels(account);
          const enabled = rawModels.filter(m => !resolveRouteModel(matchedProvider, m.id).disabled);
          const ordered = orderModelsForModality(enabled, effectiveModality);
          const modelsForAccount = ordered.length > 0
            ? ordered
            : (!strictChatModality && enabled.length > 0
              ? enabled
              : (rawModels.length === 0 ? [{ id: 'default' }] : []));
          return {
            account,
            models: modelsForAccount,
          };
        });
        const maxModels = perAccountModels.reduce((max, entry) => Math.max(max, entry.models.length), 0);
        if (providerAccounts.length > 0 && maxModels === 0) {
          return {
            candidates: [],
            notFoundError: `All models are disabled for provider '${matchedProvider}'`,
          };
        }
        const candidates: CandidateRoute[] = [];
        for (let i = 0; i < maxModels; i++) {
          for (const entry of perAccountModels) {
            const model = entry.models[i];
            if (model) candidates.push({ account: entry.account, modelId: model.id });
          }
        }
        return finalizeCandidateRoutes(sortCandidatesByHealth(candidates));
      }
      const route = resolveRouteModel(matchedProvider, suffix);
      if (route.disabled) {
        return {
          candidates: [],
          notFoundError: `Model '${suffix}' is disabled for provider '${matchedProvider}'`,
        };
      }
      const providerAccounts = usable.filter(a => a.provider === matchedProvider);
      return finalizeCandidateRoutes(
        rotateProviderAccounts(providerAccounts).map(account => ({ account, modelId: route.modelId })),
      );
    }
  }

  const exactMatches: CandidateRoute[] = [];
  for (const account of usable) {
    const models = accountModels(account);
    const direct = models.find(m => m.id === rawModel);
    if (direct) {
      exactMatches.push({ account, modelId: direct.id });
      continue;
    }
    // A bare alias (no `provider/` prefix) resolves against the account's own
    // provider, so `fast` can mean a different real model per provider.
    const aliased = resolveProviderModelAlias(account.provider, rawModel);
    const aliasedModel = aliased !== rawModel ? models.find(m => m.id === aliased) : undefined;
    if (aliasedModel) {
      exactMatches.push({ account, modelId: aliasedModel.id });
    }
  }
  if (exactMatches.length > 0) {
    return finalizeCandidateRoutes(rotateCandidateAccounts(exactMatches));
  }

  return finalizeCandidateRoutes(
    rotateProviderAccounts(usable).map(account => ({ account, modelId: rawModel })),
  );
}

/*
 * Smart routing keeps a small in-memory health record per (account, model).
 * Latency is an exponential moving average so a single fast/slow request does
 * not reorder the whole combo, and consecutive failures carry a decayed penalty
 * that disappears once the route succeeds again. Unknown routes sit in the
 * middle, which makes a cold process behave like plain `fallback`.
 */
const FAILURE_PENALTY_MS = 2_500;
const UNKNOWN_LATENCY_MS = 1_200;

interface RouteHealth {
  samples: number;
  latencyMs: number;
  consecutiveErrors: number;
  lastFailureAt: number;
}

const routeHealth = new Map<string, RouteHealth>();

function healthKey(candidate: Pick<CandidateRoute, 'account' | 'modelId'>): string {
  return `${candidate.account.id}:${candidate.modelId}`;
}

export function recordRouteOutcome(key: string, outcome: { latencyMs?: number; error?: boolean }): void {
  const existing = routeHealth.get(key);
  if (outcome.error) {
    routeHealth.set(key, {
      samples: existing?.samples ?? 0,
      latencyMs: existing?.latencyMs ?? UNKNOWN_LATENCY_MS,
      consecutiveErrors: (existing?.consecutiveErrors ?? 0) + 1,
      lastFailureAt: Date.now(),
    });
    return;
  }
  if (outcome.latencyMs === undefined) return;
  const samples = (existing?.samples ?? 0) + 1;
  const latencyMs = existing && existing.samples > 0
    ? existing.latencyMs * 0.7 + outcome.latencyMs * 0.3
    : outcome.latencyMs;
  routeHealth.set(key, {
    samples,
    latencyMs,
    consecutiveErrors: 0,
    lastFailureAt: existing?.lastFailureAt ?? 0,
  });
}

export function resetRouteHealth(): void {
  routeHealth.clear();
  resetRouteBackoff();
}

function isRouteHealthFailing(health: RouteHealth): boolean {
  if (health.consecutiveErrors <= 0) return false;
  const ttlMinutes = getRouteHealthTtlMinutes();
  return ttlMinutes === 0 || Date.now() - health.lastFailureAt < ttlMinutes * 60_000;
}

function routeScore(health: RouteHealth | undefined): number {
  if (!health) return UNKNOWN_LATENCY_MS;
  return health.latencyMs + (isRouteHealthFailing(health) ? health.consecutiveErrors * FAILURE_PENALTY_MS : 0);
}

/** Stable sort: healthier routes first, original step order on ties. */
export function sortCandidatesByHealth<T extends Pick<CandidateRoute, 'account' | 'modelId'>>(candidates: T[]): T[] {
  return [...candidates].sort((a, b) => routeScore(routeHealth.get(healthKey(a))) - routeScore(routeHealth.get(healthKey(b))));
}

/**
 * Fusion fans a request out to the first two distinct combo steps. Candidates
 * for the same step (several accounts of one provider) collapse to the first.
 */
export function pickFusionCandidates<T extends { step?: number }>(candidates: T[], maxCount = 2): T[] {
  const picked: T[] = [];
  const seenSteps = new Set<number>();
  for (const candidate of candidates) {
    if (candidate.step !== undefined) {
      if (seenSteps.has(candidate.step)) continue;
      seenSteps.add(candidate.step);
    }
    picked.push(candidate);
    if (picked.length >= maxCount) break;
  }
  return picked;
}

/**
 * Session stickiness for `smart` combos.
 *
 * A conversation (system prompt + first user message) is hashed into a stable
 * key. The first turn pins the route that served it, and later turns reorder
 * candidates to put that route first, which keeps the provider's prompt cache
 * warm. Pins are per-process and expire after half an hour of inactivity.
 */
const SESSION_PIN_TTL_MS = 30 * 60_000;
const MAX_SESSION_PINS = 2_000;

interface SessionPin {
  combo: string;
  fingerprint: string;
  accountId: number;
  modelId: string;
  /** Sorted candidate identity; a combo edit invalidates the pin. */
  signature: string;
  pinnedAt: number;
  lastUsedAt: number;
}

const sessionPins = new Map<string, SessionPin>();

export function resetSessionPins(): void {
  sessionPins.clear();
  resetAutoSessionCache();
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => {
    if (typeof part === 'string') return part;
    if (part && typeof part === 'object') {
      const text = (part as { text?: unknown }).text;
      if (typeof text === 'string') return text;
    }
    return '';
  }).join(' ');
}

/** Stable conversation key from the system prompt and first user message. */
export function conversationFingerprint(messages: ChatMessage[]): string | null {
  const system = messages
    .filter(message => message.role === 'system')
    .map(message => messageText(message.content).trim())
    .filter(Boolean)
    .join('\n');
  const firstUser = messages.find(message => message.role === 'user');
  const user = firstUser ? messageText(firstUser.content).trim() : '';
  if (!system && !user) return null;
  return createHash('sha1').update(`${system}\u0000${user}`).digest('hex').slice(0, 24);
}

function candidatesSignature(candidates: CandidateRoute[]): string {
  return candidates.map(candidate => `${candidate.account.id}:${candidate.modelId}`).sort().join('|');
}

function pruneSessionPins(now: number): void {
  for (const [key, pin] of sessionPins) {
    if (now - pin.lastUsedAt > SESSION_PIN_TTL_MS) sessionPins.delete(key);
  }
  if (sessionPins.size <= MAX_SESSION_PINS) return;
  const oldest = [...sessionPins.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
  for (let index = 0; index < oldest.length - MAX_SESSION_PINS; index += 1) {
    sessionPins.delete(oldest[index][0]);
  }
}

/**
 * Should the pinned route be released? A recent consecutive error always
 * releases it; otherwise the best alternative must be better by at least the
 * operator's confidence threshold (80% by default), i.e. the pinned route's
 * score has to degrade five-fold before we give up its warm cache.
 */
function shouldReleasePin(pinned: CandidateRoute, candidates: CandidateRoute[], threshold: number): boolean {
  const pinnedHealth = routeHealth.get(healthKey(pinned));
  if (pinnedHealth && isRouteHealthFailing(pinnedHealth)) {
    return true;
  }

  const pinnedScore = routeScore(pinnedHealth);
  if (pinnedScore <= 0) return false;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    if (candidate === pinned) continue;
    bestScore = Math.min(bestScore, routeScore(routeHealth.get(healthKey(candidate))));
  }
  if (!Number.isFinite(bestScore)) return false;
  const confidence = 1 - bestScore / pinnedScore;
  return confidence >= threshold;
}

export interface SessionStickyCombo extends ComboPolicyInput {
  name: string;
  strategy?: ComboStrategy;
  systemOneModel?: string;
}

/**
 * Return candidates with the conversation's pinned route first. `strict` never
 * releases a live pin; `smart`/`custom` release it on failure or when its health
 * confidence drops below the threshold; `per-turn` (or `sessionSticky: false`)
 * leaves the list untouched.
 */
export function applySessionStickiness(
  candidates: CandidateRoute[],
  combo: SessionStickyCombo | undefined,
  messages: ChatMessage[],
): CandidateRoute[] {
  if (!combo || combo.strategy !== 'smart' || combo.systemOneModel?.trim() || candidates.length === 0) return candidates;
  const policy = resolveComboPolicy(combo);
  if (!policy.sessionSticky || policy.smartPolicy === 'per-turn') return candidates;

  const fingerprint = conversationFingerprint(messages);
  if (!fingerprint) return candidates;

  const now = Date.now();
  pruneSessionPins(now);
  const key = `${combo.name}:${fingerprint}`;
  const signature = candidatesSignature(candidates);
  const stored = sessionPins.get(key);
  let pinned = stored && stored.signature === signature && now - stored.lastUsedAt <= SESSION_PIN_TTL_MS
    ? candidates.find(candidate => candidate.account.id === stored.accountId && candidate.modelId === stored.modelId)
    : undefined;
  if (!pinned && stored) sessionPins.delete(key);

  if (pinned && policy.smartPolicy !== 'strict' && shouldReleasePin(pinned, candidates, policy.confidenceThreshold)) {
    pinned = undefined;
    sessionPins.delete(key);
  }

  if (!pinned) {
    pinned = candidates[0];
    sessionPins.set(key, {
      combo: combo.name,
      fingerprint,
      accountId: pinned.account.id,
      modelId: pinned.modelId,
      signature,
      pinnedAt: stored?.pinnedAt ?? now,
      lastUsedAt: now,
    });
  } else if (stored) {
    stored.lastUsedAt = now;
  }

  if (candidates[0] === pinned) return candidates;
  return [pinned, ...candidates.filter(candidate => candidate !== pinned)];
}

/** Resolve with the first fulfilled promise; reject only when all of them fail. */
function raceFirstSuccess<T>(tasks: Array<Promise<T>>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let failures = 0;
    let lastError: unknown;
    for (const task of tasks) {
      task.then(value => {
        if (settled) return;
        settled = true;
        resolve(value);
      }).catch(err => {
        lastError = err;
        failures += 1;
        if (!settled && failures === tasks.length) {
          settled = true;
          reject(lastError);
        }
      });
    }
  });
}

function resolveCandidateByTarget(target: string, fallbackList: CandidateRoute[]): CandidateRoute | undefined {
  const trimmed = target.trim();
  if (trimmed) {
    const resolved = resolveCandidateRoutes(trimmed, 'chat');
    if (resolved.candidates.length > 0) return resolved.candidates[0];
    const direct = fallbackList.find(c => `${c.account.provider}/${c.modelId}` === trimmed || c.modelId === trimmed);
    if (direct) return direct;
  }
  return fallbackList[0];
}

async function executeRouteChatCompletion(
  candidate: CandidateRoute,
  msgs: ChatMessage[],
  opts: CompletionOptions,
  isFailover = false,
): Promise<{ candidate: CandidateRoute; completion: ChatCompletionResponse; latencyMs: number }> {
  const { account, modelId } = candidate;
  const provider = resolveAccountProvider(account);
  if (!provider) throw new Error(`Provider '${account.provider}' is not available.`);
  const credential = decrypt(account.encrypted_key, account.iv, account.auth_tag);
  const effectiveProxy = resolveXGatewayAccountProxy(account);
  const prepared = prepareGatewayThinkingRequest({
    messages: msgs,
    options: opts,
    provider: account.provider,
    modelId,
    accountId: account.id,
    isFailover,
  });
  const startedAt = Date.now();
  const completion = await withQuotaTracking(account, modelId, effectiveProxy, () =>
    provider.chatCompletion(
      credential,
      prepared.messages,
      modelId,
      prepared.options,
      { platform: account.platform, keyId: account.id, modelId },
    ),
  );
  captureGatewayThinkingResponse({
    toolCalls: completion.choices?.[0]?.message?.tool_calls,
    provider: account.provider,
    modelId: completion.model || modelId,
    accountId: account.id,
  });
  return { candidate, completion, latencyMs: Date.now() - startedAt };
}

export function applyGatewaySavers(req: Request, messages: ChatMessage[]): {
  messages: ChatMessage[];
  appliedSavers: string[];
} {
  const header = req.headers['x-freellm-saver'];
  const afterHeader = applyOutputSavers(messages, header);
  const appliedSavers: string[] = [];
  if (afterHeader !== messages) {
    appliedSavers.push('header');
    return { messages: afterHeader, appliedSavers };
  }

  const defaults = getConfigSnapshot().savers;
  const levels = {
    caveman: defaults.caveman ? ('full' as const) : ('off' as const),
    ponytail: defaults.ponytail,
  };
  if (levels.caveman === 'off' && levels.ponytail === 'off') {
    return { messages, appliedSavers };
  }
  const block = buildSaverBlock(levels);
  if (!block) return { messages, appliedSavers };
  if (levels.caveman !== 'off') appliedSavers.push('caveman');
  if (levels.ponytail !== 'off') appliedSavers.push(`ponytail:${levels.ponytail}`);
  return {
    messages: [{ role: 'system', content: block }, ...messages],
    appliedSavers,
  };
}

// POST /thruline/v1/chat/completions — dispatch exclusively over x_gateway_keys
export async function handleXGatewayChat(req: Request, res: Response): Promise<void> {
  const startMs = Date.now();
  const fromPlayground = Boolean(res.locals?.fromPlayground || req.headers['x-thruline-playground'] === '1');
  if (fromPlayground) {
    const clientCtx = getClientContext();
    clientCtx.agent = 'playground' as typeof clientCtx.agent;
  }
  const body = (req.body && typeof req.body === 'object') ? req.body as Record<string, unknown> : {};
  const rawMessages = Array.isArray(body.messages) ? (body.messages as ChatMessage[]) : [];
  if (rawMessages.length === 0) {
    res.status(400).json({
      error: { message: 'messages must be a non-empty array', type: 'invalid_request_error' },
    });
    return;
  }

  const { cleanModel: requestedModel, thinkingEffort } = parseModelThinkingSuffix(typeof body.model === 'string' ? body.model : 'auto');
  const authUser = (req as Request & { user?: ValidatedXGatewayClientKey }).user;
  if (authUser?.access?.restricted && !isModelAllowedForKey(authUser.access, requestedModel)) {
    res.status(403).json({
      error: {
        message: `Model or combo '${requestedModel}' is not allowed for this API key.`,
        type: 'permission_error',
        code: 'model_not_allowed',
      },
    });
    return;
  }
  const isStream = body.stream === true;

  const controller = new AbortController();
  const onClose = () => { if (!res.writableEnded) controller.abort(); };
  res.once('close', onClose);

  const pipelineResult = await preprocessGatewayMessages(req, res, {
    messages: rawMessages,
    rawBody: body,
    requestedModel,
    format: 'openai',
    signal: controller.signal,
  });
  const messages = pipelineResult.messages;
  const appliedSavers = pipelineResult.appliedSavers;

  const scope = {
    gateway: 'x' as const,
    outputSavers: appliedSavers,
    inputSaver: getConfigSnapshot().savers.input,
    inputTokensSaved: pipelineResult.tokensSavedEst,
  };

  res.setHeader('X-Gateway', 'x');
  if (!res.getHeader('X-Output-Saver-Applied')) {
    res.setHeader('X-Output-Saver-Applied', appliedSavers.join(','));
  }
  if (!res.getHeader('X-Input-Tokens-Saved')) {
    res.setHeader('X-Input-Tokens-Saved', String(pipelineResult.tokensSavedEst));
  }
  try {
  await runInGatewayScope(scope, async () => {
    const hasImage = messages.some(m => {
      if (Array.isArray(m.content)) {
        return m.content.some((p: any) => p?.type === 'image_url' || p?.type === 'image' || p?.image_url);
      }
      return false;
    });
    const modality: CandidateModality = hasImage ? 'vision' : 'chat';
    const resolvedAliasLower = resolveXGatewayModelAlias(requestedModel).toLowerCase();
    const isAutoModel = resolvedAliasLower === 'auto' || resolvedAliasLower.startsWith('auto:');
    const rawHeaderSession = req.headers['x-session-id'];
    const headerSession = typeof rawHeaderSession === 'string'
      ? rawHeaderSession.trim()
      : Array.isArray(rawHeaderSession) && typeof rawHeaderSession[0] === 'string'
        ? rawHeaderSession[0].trim()
        : '';
    const bodySession = typeof body.sessionId === 'string'
      ? body.sessionId.trim()
      : typeof body.session_id === 'string'
        ? body.session_id.trim()
        : '';
    const localsSession = typeof res.locals?.sessionId === 'string' ? res.locals.sessionId.trim() : '';
    const explicitSessionId = (headerSession || bodySession || localsSession).slice(0, 128);
    const autoSessionId = isAutoModel
      ? (explicitSessionId || (fromPlayground ? (() => {
          const fp = conversationFingerprint(messages);
          return fp ? `pg:${fp}` : '';
        })() : ''))
      : '';
    const dbRef = getDb();

    let candidates: CandidateRoute[] = [];
    let combo: ComboRouteInfo | undefined;
    let allRateLimited: boolean | undefined;
    let retryAfterMs: number | undefined;
    let usingAutoSticky = false;
    let stickyExpanded = false;
    let stickyAttempted: { accountId: number; modelId: string } | null = null;

    if (autoSessionId) {
      const pinned = getAutoSessionRoute(autoSessionId, modality, dbRef);
      if (pinned) {
        const usableAccount = getUsableXGatewayKeys().find(
          a => a.id === pinned.accountId && a.provider === pinned.providerId && isWithinAccountCaps(a),
        );
        const inCooldown = getAccountCooldown(pinned.accountId, pinned.modelId).inCooldown;
        const modelDisabled = resolveRouteModel(pinned.providerId, pinned.modelId).disabled;
        const modalityOk = !isNonChatModel({ id: pinned.modelId });
        if (usableAccount && !inCooldown && !modelDisabled && modalityOk) {
          candidates = [{ account: usableAccount, modelId: pinned.modelId }];
          usingAutoSticky = true;
          stickyAttempted = { accountId: pinned.accountId, modelId: pinned.modelId };
        } else {
          clearAutoSessionRoute(autoSessionId, modality);
        }
      }
    }

    const resolveNormalCandidates = (): {
      resolved: CandidateRoute[];
      notFoundError?: string;
      combo?: ComboRouteInfo;
      allRateLimited?: boolean;
      retryAfterMs?: number;
    } => {
      const {
        candidates: rawCandidates,
        notFoundError,
        combo: resolvedCombo,
        allRateLimited: resolvedAllRateLimited,
        retryAfterMs: resolvedRetryAfterMs,
      } = resolveCandidateRoutes(requestedModel, modality);
      if (notFoundError) {
        return { resolved: [], notFoundError, combo: resolvedCombo };
      }
      // The adapter only ever returns account/model pairs, so it can keep the
      // combo step metadata that `resolveCandidateRoutes` attached.
      const tools = Array.isArray(body.tools) ? (body.tools as Array<Record<string, any>>) : undefined;
      const augmented = augmentCandidatesWithCapacityAdapter(rawCandidates, messages, tools) as CandidateRoute[];
      // Smart combos keep a conversation on the same route to protect the
      // provider's warm prompt cache; other strategies keep their own ordering.
      return {
        resolved: applySessionStickiness(augmented, resolvedCombo, messages),
        combo: resolvedCombo,
        allRateLimited: resolvedAllRateLimited,
        retryAfterMs: resolvedRetryAfterMs,
      };
    };

    const expandStickyFallbacks = () => {
      if (!usingAutoSticky || stickyExpanded) return;
      stickyExpanded = true;
      if (autoSessionId) clearAutoSessionRoute(autoSessionId, modality);
      const { resolved } = resolveNormalCandidates();
      for (const candidate of resolved) {
        if (
          stickyAttempted
          && candidate.account.id === stickyAttempted.accountId
          && candidate.modelId === stickyAttempted.modelId
        ) {
          continue;
        }
        candidates.push(candidate);
      }
    };

    if (!usingAutoSticky) {
      const normal = resolveNormalCandidates();
      if (normal.notFoundError) {
        res.status(404).json({
          error: { message: normal.notFoundError, type: 'invalid_request_error', code: 'model_not_found' },
        });
        return;
      }
      candidates = normal.resolved;
      combo = normal.combo;
      allRateLimited = normal.allRateLimited;
      retryAfterMs = normal.retryAfterMs;
    }

    const strategy = combo?.strategy ?? DEFAULT_COMBO_STRATEGY;
    if (combo) {
      res.setHeader('X-Combo-Strategy', strategy);
      if (strategy === 'smart') res.setHeader('X-Combo-Policy', combo.smartPolicy);
    }
    if (candidates.length === 0) {
      if (allRateLimited) {
        const retryAfterSeconds = Math.max(1, Math.ceil((retryAfterMs ?? 0) / 1000));
        res.setHeader('Retry-After', String(retryAfterSeconds));
        res.status(503).json({
          error: {
            message: `All matching Thruline provider accounts are temporarily cooling down. Retry after ${retryAfterSeconds}s.`,
            type: 'service_unavailable',
            code: 'all_rate_limited',
            retry_after_ms: retryAfterMs ?? 0,
          },
        });
        return;
      }
      res.status(503).json({
        error: {
          message: 'No enabled Thruline provider accounts available.',
          type: 'service_unavailable',
          code: 'no_available_keys',
        },
      });
      return;
    }

    const options: CompletionOptions = {
      reasoning_effort: (thinkingEffort ?? body.reasoning_effort) as CompletionOptions['reasoning_effort'],
      signal: controller.signal,
      temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
      max_tokens: typeof body.max_tokens === 'number' ? body.max_tokens : undefined,
      top_p: typeof body.top_p === 'number' ? body.top_p : undefined,
      stop: (typeof body.stop === 'string' || Array.isArray(body.stop)) ? (body.stop as string | string[]) : undefined,
      tools: Array.isArray(body.tools) ? (body.tools as CompletionOptions['tools']) : undefined,
      tool_choice: body.tool_choice as CompletionOptions['tool_choice'],
      parallel_tool_calls: typeof body.parallel_tool_calls === 'boolean' ? body.parallel_tool_calls : undefined,
      stream_options: (body.stream_options && typeof body.stream_options === 'object')
        ? (body.stream_options as CompletionOptions['stream_options'])
        : undefined,
    };

    const estimatedPromptTokens = estimateInputTokens(messages);
    let lastError: unknown = null;

    if (combo && strategy === 'smart' && combo.systemOneModel?.trim() && candidates.length > 1) {
      const sessionHdr = req.headers['x-session-id'];
      const sessionId = typeof sessionHdr === 'string' && sessionHdr.trim()
        ? sessionHdr.trim()
        : (typeof body.user === 'string' && body.user.trim() ? body.user.trim() : conversationFingerprint(messages));
      const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
      const promptState = lastUserMsg ? messageText(lastUserMsg.content) : '';
      const sysOne = await resolveSystemOneComboOrder({
        items: candidates,
        keyOf: c => `${c.account.provider}/${c.modelId}`,
        comboName: combo.name,
        systemOneModel: combo.systemOneModel,
        smartPolicy: combo.smartPolicy,
        confidenceThreshold: combo.confidenceThreshold,
        sessionId,
        promptState,
        invokeClassifier: async (targetModel, classifyMsgs, timeoutMs) => {
          const classifierCandidate = resolveCandidateByTarget(targetModel, candidates);
          if (!classifierCandidate) return null;
          const r = await executeRouteChatCompletion(classifierCandidate, classifyMsgs, {
            temperature: 0,
            max_tokens: 256,
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]),
          });
          return r.completion;
        },
      });
      candidates = sysOne.ordered;
      if (sysOne.decision?.choice) {
        res.setHeader('X-SystemOne-Choice', sysOne.decision.choice);
      }
    }

    /** One non-streaming attempt, isolated so fusion can run in parallel. */
    const attemptNonStream = (candidate: CandidateRoute, signal: AbortSignal, isFailover = false) =>
      executeRouteChatCompletion(candidate, messages, { ...options, signal }, isFailover);

    const succeedNonStream = (result: Awaited<ReturnType<typeof attemptNonStream>>) => {
      const { account, modelId } = result.candidate;
      const latencyMs = Date.now() - startMs;
      const promptTokens = result.completion.usage?.prompt_tokens ?? estimatedPromptTokens;
      const completionTokens = result.completion.usage?.completion_tokens ?? 0;

      recordXGatewayKeyUsage(account.id, promptTokens + completionTokens);
      logRequest(
        account.provider,
        modelId,
        null,
        'success',
        promptTokens,
        completionTokens,
        latencyMs,
        null,
        latencyMs,
        requestedModel === 'auto' ? null : requestedModel,
        null,
        'x-gateway',
      );

      res.setHeader('X-Routed-Via', `${account.provider}/${modelId}`);
      res.status(200).json(result.completion);
    };

    if (strategy === 'fusion' && combo?.judgeModel?.trim()) {
      const panelCandidates = pickFusionCandidates(candidates, 4);
      if (panelCandidates.length > 1) {
        const panelMap = new Map<string, CandidateRoute>(panelCandidates.map(c => [`${c.account.provider}/${c.modelId}`, c]));
        let judgeUsed = resolveCandidateByTarget(combo.judgeModel, candidates) ?? candidates[0];
        const fusionToken = beginUsageRequest(judgeUsed.account.provider, judgeUsed.modelId, fromPlayground);
        try {
          const fusionOut = await executeJudgeFusion({
            panelTargets: [...panelMap.keys()],
            judgeModel: combo.judgeModel,
            messages,
            stream: isStream,
            runPanelTarget: async (target, panelMessages) => {
              const candidate = panelMap.get(target);
              if (!candidate) throw new Error(`Panel target '${target}' unavailable`);
              const r = await executeRouteChatCompletion(candidate, panelMessages, { ...options, signal: controller.signal });
              return r.completion;
            },
            runJudgeNonStream: async (judgeTarget, judgeMessages) => {
              judgeUsed = resolveCandidateByTarget(judgeTarget, candidates) ?? candidates[0];
              const r = await executeRouteChatCompletion(judgeUsed, judgeMessages, { ...options, signal: controller.signal });
              return r.completion;
            },
            runJudgeStream: async function* (judgeTarget, judgeMessages) {
              judgeUsed = resolveCandidateByTarget(judgeTarget, candidates) ?? candidates[0];
              const provider = resolveAccountProvider(judgeUsed.account);
              if (!provider) throw new Error(`Provider '${judgeUsed.account.provider}' is not available.`);
              const credential = decrypt(judgeUsed.account.encrypted_key, judgeUsed.account.iv, judgeUsed.account.auth_tag);
              const stream = provider.streamChatCompletion(
                credential,
                judgeMessages,
                judgeUsed.modelId,
                { ...options, signal: controller.signal },
                { platform: judgeUsed.account.platform, keyId: judgeUsed.account.id, modelId: judgeUsed.modelId },
              );
              for await (const chunk of stream) {
                yield chunk;
              }
            },
          });
          if (controller.signal.aborted) {
            cancelUsageRequest(fusionToken);
            return;
          }
          if (fusionOut?.type === 'response') {
            recordRouteOutcome(healthKey(judgeUsed), { latencyMs: Date.now() - startMs });
            recordCandidateSuccess(judgeUsed.account.id, judgeUsed.modelId);
            res.setHeader('X-Fusion-Judge', combo.judgeModel.trim());
            succeedNonStream({ candidate: judgeUsed, completion: fusionOut.response, latencyMs: Date.now() - startMs });
            endUsageRequest(fusionToken, { status: 'success', provider: judgeUsed.account.provider, model: judgeUsed.modelId });
            return;
          }
          if (fusionOut?.type === 'stream') {
            const iter = fusionOut.stream[Symbol.asyncIterator]();
            const first = await iter.next();
            if (!first.done) {
              res.setHeader('Content-Type', 'text/event-stream');
              res.setHeader('Cache-Control', 'no-cache');
              res.setHeader('X-Accel-Buffering', 'no');
              res.setHeader('X-Routed-Via', `${judgeUsed.account.provider}/${judgeUsed.modelId}`);
              res.setHeader('X-Fusion-Judge', combo.judgeModel.trim());
              const ttfbMs = Date.now() - startMs;
              let promptTokens = estimatedPromptTokens;
              let completionTokens = 0;
              const emitChunk = (chunk: ChatCompletionChunk) => {
                if (chunk.usage?.prompt_tokens != null) promptTokens = chunk.usage.prompt_tokens;
                if (chunk.usage?.completion_tokens != null) completionTokens = chunk.usage.completion_tokens;
                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
              };
              emitChunk(first.value);
              while (true) {
                const next = await iter.next();
                if (next.done || controller.signal.aborted) break;
                emitChunk(next.value);
              }
              if (controller.signal.aborted) {
                cancelUsageRequest(fusionToken);
                return;
              }
              res.write('data: [DONE]\n\n');
              res.end();
              recordRouteOutcome(healthKey(judgeUsed), { latencyMs: Date.now() - startMs });
              recordCandidateSuccess(judgeUsed.account.id, judgeUsed.modelId);
              recordXGatewayKeyUsage(judgeUsed.account.id, promptTokens + completionTokens);
              logRequest(
                judgeUsed.account.provider,
                judgeUsed.modelId,
                null,
                'success',
                promptTokens,
                completionTokens,
                Date.now() - startMs,
                null,
                ttfbMs,
                requestedModel === 'auto' ? null : requestedModel,
                null,
                'x-gateway',
              );
              endUsageRequest(fusionToken, { status: 'success', provider: judgeUsed.account.provider, model: judgeUsed.modelId });
              return;
            }
          }
          cancelUsageRequest(fusionToken);
        } catch (err) {
          if (controller.signal.aborted) {
            cancelUsageRequest(fusionToken);
            return;
          }
          lastError = err;
          endUsageRequest(fusionToken, {
            status: 'error',
            provider: judgeUsed.account.provider,
            model: judgeUsed.modelId,
            errorMessage: sanitizeProviderErrorMessage(err instanceof Error ? err.message : 'Judge fusion failed'),
          });
          if (res.headersSent) {
            const errMsg = sanitizeProviderErrorMessage(err instanceof Error ? err.message : 'Judge fusion stream interrupted');
            res.write(`data: ${JSON.stringify({ error: { message: errMsg } })}\n\n`);
            res.end();
            return;
          }
        }
      }
    } else if (!isStream && strategy === 'fusion') {
      // Fusion races the first two distinct combo steps; the first success wins
      // and the slower attempt is aborted. One step (or a single account) simply
      // behaves like fallback.
      const fusionCandidates = pickFusionCandidates(candidates);
      if (fusionCandidates.length > 1) {
        const children = fusionCandidates.map(() => new AbortController());
        const abortChildren = () => { for (const child of children) child.abort(); };
        const onAbort = () => abortChildren();
        controller.signal.addEventListener('abort', onAbort);
        const fusionTokens = fusionCandidates.map(c => beginUsageRequest(c.account.provider, c.modelId, fromPlayground));
        try {
          const winner = await raceFirstSuccess(fusionCandidates.map((candidate, index) =>
            attemptNonStream(candidate, children[index].signal)));
          if (controller.signal.aborted) {
            for (const token of fusionTokens) cancelUsageRequest(token);
            return;
          }
          recordRouteOutcome(healthKey(winner.candidate), { latencyMs: winner.latencyMs });
          recordCandidateSuccess(winner.candidate.account.id, winner.candidate.modelId);
          succeedNonStream(winner);
          for (let i = 0; i < fusionCandidates.length; i += 1) {
            const c = fusionCandidates[i];
            if (c === winner.candidate) {
              endUsageRequest(fusionTokens[i], { status: 'success', provider: c.account.provider, model: c.modelId });
            } else {
              cancelUsageRequest(fusionTokens[i]);
            }
          }
          return;
        } catch (err) {
          if (controller.signal.aborted) {
            for (const token of fusionTokens) cancelUsageRequest(token);
            return;
          }
          lastError = err;
          const errMsg = sanitizeProviderErrorMessage(err instanceof Error ? err.message : 'Fusion attempt failed');
          for (let i = 0; i < fusionCandidates.length; i += 1) {
            const candidate = fusionCandidates[i];
            const classification = recordCandidateFailure(candidate.account.id, candidate.modelId, err);
            if (!classification.requestScoped) {
              recordRouteOutcome(healthKey(candidate), { error: true });
            }
            endUsageRequest(fusionTokens[i], {
              status: 'error',
              provider: candidate.account.provider,
              model: candidate.modelId,
              errorMessage: errMsg,
            });
          }
          // Fall through to the sequential loop, which retries every step in order.
        } finally {
          controller.signal.removeEventListener('abort', onAbort);
          abortChildren();
        }
      }
    }

    const skippedProviders = new Set<string>();
    for (let candidateIdx = 0; candidateIdx < candidates.length; candidateIdx += 1) {
      const candidate = candidates[candidateIdx];
      if (controller.signal.aborted) return;
      const { account, modelId } = candidate;
      if (skippedProviders.has(account.provider)) continue;

      if (!isStream) {
        const activeToken = beginUsageRequest(account.provider, modelId, fromPlayground);
        try {
          const result = await attemptNonStream(candidate, controller.signal, candidateIdx > 0);
          recordRouteOutcome(healthKey(candidate), { latencyMs: result.latencyMs });
          recordCandidateSuccess(account.id, modelId);
          if (isAutoModel && autoSessionId) {
            setAutoSessionRoute(autoSessionId, modality, {
              providerId: account.provider,
              accountId: account.id,
              modelId,
            }, dbRef);
          }
          succeedNonStream(result);
          endUsageRequest(activeToken, { status: 'success', provider: account.provider, model: modelId });
          return;
        } catch (err) {
          if (controller.signal.aborted) {
            cancelUsageRequest(activeToken);
            return;
          }
          const classification = recordCandidateFailure(account.id, modelId, err);
          if (classification.requestScoped) {
            skippedProviders.add(account.provider);
          } else {
            recordRouteOutcome(healthKey(candidate), { error: true });
          }
          if (isAutoModel && autoSessionId) clearAutoSessionRoute(autoSessionId, modality);
          if (usingAutoSticky && candidateIdx === 0) expandStickyFallbacks();
          const errMsg = sanitizeProviderErrorMessage(err instanceof Error ? err.message : 'Provider error');
          endUsageRequest(activeToken, {
            status: 'error',
            provider: account.provider,
            model: modelId,
            errorMessage: errMsg,
          });
          lastError = err;
          continue;
        }
      }

      const provider = resolveAccountProvider(account);
      if (!provider) {
        lastError = new Error(`Provider '${account.provider}' is not available.`);
        recordRouteOutcome(healthKey(candidate), { error: true });
        if (isAutoModel && autoSessionId) clearAutoSessionRoute(autoSessionId, modality);
        if (usingAutoSticky && candidateIdx === 0) expandStickyFallbacks();
        continue;
      }

      let credential: string;
      try {
        credential = decrypt(account.encrypted_key, account.iv, account.auth_tag);
      } catch (err) {
        lastError = err;
        recordRouteOutcome(healthKey(candidate), { error: true });
        if (isAutoModel && autoSessionId) clearAutoSessionRoute(autoSessionId, modality);
        if (usingAutoSticky && candidateIdx === 0) expandStickyFallbacks();
        continue;
      }

      const effectiveProxy = resolveXGatewayAccountProxy(account);
      const streamStartedAt = Date.now();
      const activeToken = beginUsageRequest(account.provider, modelId, fromPlayground);
      const hasFallback = candidateIdx < candidates.length - 1 || (
        usingAutoSticky
        && candidateIdx === 0
        && !stickyExpanded
        && (
          getUsableXGatewayKeys().some(a => a.id !== account.id && isWithinAccountCaps(a))
          || orderModelsForModality(accountModels(account), modality).length > 1
        )
      );
      const peekTimeoutMs = (isAutoModel && hasFallback) ? getAutoStreamPeekTimeoutMs() : 0;
      const attemptController = new AbortController();
      const attemptSignal = AbortSignal.any([controller.signal, attemptController.signal]);

      try {
        await withQuotaTracking(account, modelId, effectiveProxy, async () => {
          const preparedStream = prepareGatewayThinkingRequest({
            messages,
            options: { ...options, signal: attemptSignal },
            provider: account.provider,
            modelId,
            accountId: account.id,
            isFailover: candidateIdx > 0,
          });
          const stream = provider.streamChatCompletion(
            credential,
            preparedStream.messages,
            modelId,
            preparedStream.options,
            { platform: account.platform, keyId: account.id, modelId },
          );
          const peek = await peekStreamForContent(stream, {
            signal: controller.signal,
            timeoutMs: peekTimeoutMs,
            allowReasoningOnlyOnClose: !hasFallback,
            onTimeout: () => attemptController.abort(new Error('Stream first-content peek timeout')),
          });
          if (controller.signal.aborted) return;

          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('X-Accel-Buffering', 'no');
          res.setHeader('X-Routed-Via', `${account.provider}/${modelId}`);
          const ttfbMs = Date.now() - startMs;
          if (isAutoModel && autoSessionId) {
            setAutoSessionRoute(autoSessionId, modality, {
              providerId: account.provider,
              accountId: account.id,
              modelId,
            }, dbRef);
          }

          let promptTokens = estimatedPromptTokens;
          let completionTokens = 0;
          for await (const chunk of reconstructStream(peek)) {
            if (controller.signal.aborted) return;
            if (chunk.usage?.prompt_tokens != null) promptTokens = chunk.usage.prompt_tokens;
            if (chunk.usage?.completion_tokens != null) completionTokens = chunk.usage.completion_tokens;
            const deltaToolCalls = chunk.choices?.[0]?.delta?.tool_calls;
            if (Array.isArray(deltaToolCalls) && deltaToolCalls.some(tc => tc?.thought_signature)) {
              captureGatewayThinkingResponse({
                toolCalls: deltaToolCalls,
                provider: account.provider,
                modelId: chunk.model || modelId,
                accountId: account.id,
              });
            }
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          }
          if (controller.signal.aborted) return;
          res.write('data: [DONE]\n\n');
          res.end();

          const latencyMs = Date.now() - startMs;
          recordRouteOutcome(healthKey(candidate), { latencyMs: Date.now() - streamStartedAt });
          recordCandidateSuccess(account.id, modelId);
          recordXGatewayKeyUsage(account.id, promptTokens + completionTokens);
          logRequest(
            account.provider,
            modelId,
            null,
            'success',
            promptTokens,
            completionTokens,
            latencyMs,
            null,
            ttfbMs,
            requestedModel === 'auto' ? null : requestedModel,
            null,
            'x-gateway',
          );
        });
        if (controller.signal.aborted) {
          cancelUsageRequest(activeToken);
        } else {
          endUsageRequest(activeToken, { status: 'success', provider: account.provider, model: modelId });
        }
        return;
      } catch (err) {
        if (controller.signal.aborted) {
          cancelUsageRequest(activeToken);
          return;
        }
        const classification = recordCandidateFailure(account.id, modelId, err);
        if (classification.requestScoped) {
          skippedProviders.add(account.provider);
        } else {
          recordRouteOutcome(healthKey(candidate), { error: true });
        }
        if (isAutoModel && autoSessionId) clearAutoSessionRoute(autoSessionId, modality);
        const errMsg = sanitizeProviderErrorMessage(err instanceof Error ? err.message : 'Stream interrupted');
        if (res.headersSent) {
          logRequest(
            account.provider,
            modelId,
            null,
            'error',
            0,
            0,
            Date.now() - startMs,
            errMsg,
            null,
            requestedModel === 'auto' ? null : requestedModel,
            null,
            'x-gateway',
          );
          endUsageRequest(activeToken, {
            status: 'error',
            provider: account.provider,
            model: modelId,
            errorMessage: errMsg,
          });
          res.write(`data: ${JSON.stringify({ error: { message: errMsg } })}\n\n`);
          res.end();
          return;
        }
        if (usingAutoSticky && candidateIdx === 0) expandStickyFallbacks();
        endUsageRequest(activeToken, {
          status: 'error',
          provider: account.provider,
          model: modelId,
          errorMessage: errMsg,
        });
        lastError = err;
        continue;
      }
    }

    const message = sanitizeProviderErrorMessage(lastError instanceof Error ? lastError.message : 'All Thruline provider accounts failed.');
    const firstCandidate = candidates[0];
    if (firstCandidate) {
      logRequest(
        firstCandidate.account.provider,
        firstCandidate.modelId,
        null,
        'error',
        0,
        0,
        Date.now() - startMs,
        message,
        null,
        requestedModel === 'auto' ? null : requestedModel,
        null,
        'x-gateway',
      );
      endUsageRequest(null, {
        status: 'error',
        provider: firstCandidate.account.provider,
        model: firstCandidate.modelId,
        errorMessage: message,
      });
    }
    res.status(502).json({
      error: { message, type: 'upstream_error' },
    });
  });
  } finally {
    res.off('close', onClose);
  }
}

/* ------------------------------------------------------------------ *
 * Web search  (POST /thruline/v1/search)
 * ------------------------------------------------------------------ */

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface WebSearchOutcome {
  results: WebSearchResult[];
  content: string;
}

type RoutableAccount = CandidateRoute['account'];
type FetchResponse = Awaited<ReturnType<typeof fetch>>;
type FetchFormat = 'markdown' | 'text' | 'html';

const NATIVE_SEARCH_PROVIDERS = new Set([
  'tavily',
  'serper',
  'brave-search',
  'exa',
  'searxng',
  'tinyfish',
  'xquik',
  'ollama-search',
  'glm',
]);
const CREDENTIAL_FALLBACK_ORDER = [
  'tavily',
  'brave-search',
  'exa',
  'serper',
  'tinyfish',
  'xquik',
  'ollama-search',
  'searxng',
  'glm',
] as const;
const MAX_SEARCH_QUERY_LENGTH = 2_000;
const MAX_SEARCH_RESULTS = 20;
const SEARCH_TIMEOUT_MS = 30_000;
const SEARCH_CONTENT_LIMIT = 20_000;

const FETCH_TIMEOUT_MS = 15_000;
const FETCH_MAX_REDIRECTS = 5;
const FETCH_MAX_BYTES = 5 * 1024 * 1024;
const FETCH_DEFAULT_MAX_CHARACTERS = 20_000;
const FETCH_MAX_CHARACTERS_LIMIT = 200_000;

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(numeric)));
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeSearchResults(items: readonly unknown[], maxResults: number): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const url = asString(record.url) || asString(record.link);
    if (!url) continue;
    const title = asString(record.title) || asString(record.name) || url;
    const snippet = asString(record.snippet)
      || asString(record.description)
      || asString(record.content)
      || asString(record.text);
    results.push({ title, url, snippet });
    if (results.length >= maxResults) break;
  }
  return results;
}

function formatSearchContent(results: readonly WebSearchResult[]): string {
  return results
    .map((result, index) => `${index + 1}. ${result.title}\n${result.url}${result.snippet ? `\n${result.snippet}` : ''}`)
    .join('\n\n')
    .slice(0, SEARCH_CONTENT_LIMIT);
}

async function readSearchJson(response: FetchResponse, providerId: string): Promise<Record<string, unknown>> {
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`${providerId} search failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }
  try {
    const parsed = await response.json();
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    throw new Error(`${providerId} returned an invalid JSON response.`);
  }
}

/**
 * Dedicated search APIs. The catalog's `baseUrl` for these providers is only a
 * placeholder copied from the OpenAI-compatible default, so every endpoint is
 * spelled out here (SearXNG is self-hosted and uses the account's base_url).
 */
async function nativeSearch(
  providerId: string,
  apiKey: string,
  accountBaseUrl: string | null,
  query: string,
  maxResults: number,
  signal: AbortSignal,
): Promise<WebSearchOutcome> {
  let items: unknown[] = [];

  if (providerId === 'tavily') {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ query, max_results: maxResults, search_depth: 'basic', include_answer: false }),
      signal,
    });
    const data = await readSearchJson(response, providerId);
    items = Array.isArray(data.results) ? data.results : [];
  } else if (providerId === 'serper') {
    const response = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ q: query, num: maxResults }),
      signal,
    });
    const data = await readSearchJson(response, providerId);
    items = Array.isArray(data.organic) ? data.organic : [];
  } else if (providerId === 'brave-search') {
    const endpoint = new URL('https://api.search.brave.com/res/v1/web/search');
    endpoint.searchParams.set('q', query);
    endpoint.searchParams.set('count', String(maxResults));
    const response = await fetch(endpoint.toString(), {
      headers: { accept: 'application/json', 'x-subscription-token': apiKey },
      signal,
    });
    const data = await readSearchJson(response, providerId);
    const web = data.web && typeof data.web === 'object' ? data.web as Record<string, unknown> : {};
    items = Array.isArray(web.results) ? web.results : [];
  } else if (providerId === 'exa') {
    const response = await fetch('https://api.exa.ai/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({
        query,
        numResults: maxResults,
        contents: { text: { maxCharacters: 1_000 } },
      }),
      signal,
    });
    const data = await readSearchJson(response, providerId);
    items = Array.isArray(data.results) ? data.results : [];
  } else if (providerId === 'searxng') {
    const base = (accountBaseUrl ?? '').trim().replace(/\/+$/, '');
    if (!base || base === 'https://api.openai.com/v1') throw new Error('SearXNG search requires a base_url on the account.');
    const endpoint = new URL('search', base.endsWith('/') ? base : `${base}/`);
    endpoint.searchParams.set('q', query);
    endpoint.searchParams.set('format', 'json');
    endpoint.searchParams.set('language', 'all');
    const headers: Record<string, string> = { accept: 'application/json' };
    if (apiKey && apiKey !== 'no-auth') headers.authorization = `Bearer ${apiKey}`;
    const response = await proxyFetch(
      endpoint.toString(),
      {
        headers,
        signal,
      },
      'custom',
      'unknown',
    );
    const data = await readSearchJson(response, providerId);
    items = Array.isArray(data.results) ? data.results : [];
  } else if (providerId === 'tinyfish') {
    const endpoint = new URL('https://api.tinyfish.ai/v1/search');
    endpoint.searchParams.set('query', query);
    const response = await proxyFetch(
      endpoint.toString(),
      {
        headers: { accept: 'application/json', 'X-API-Key': apiKey },
        redirect: 'error',
        signal,
      },
      providerId,
      'unknown',
    );
    const data = await readSearchJson(response, providerId);
    items = Array.isArray(data.results) ? data.results : Array.isArray(data.data) ? data.data : [];
  } else if (providerId === 'xquik') {
    if (!apiKey || apiKey === 'no-auth') throw new Error('Xquik requires an API key.');
    const endpoint = new URL('https://api.xquik.com/api/v1/x/tweets/search');
    endpoint.searchParams.set('q', query);
    endpoint.searchParams.set('limit', String(maxResults));
    const response = await proxyFetch(
      endpoint.toString(),
      {
        headers: { accept: 'application/json', 'x-api-key': apiKey },
        redirect: 'error',
        signal,
      },
      providerId,
      'unknown',
    );
    const data = await readSearchJson(response, providerId);
    const rawTweets = Array.isArray(data.tweets)
      ? data.tweets
      : Array.isArray(data.results)
        ? data.results
        : Array.isArray(data.data)
          ? data.data
          : [];
    items = rawTweets.map(entry => {
      if (!entry || typeof entry !== 'object') return entry;
      const rec = entry as Record<string, any>;
      const tweetUrl = asString(rec.url) || (rec.id ? `https://x.com/i/web/status/${String(rec.id)}` : '');
      const username = asString(rec.author?.username);
      return {
        ...rec,
        title: asString(rec.title) || (username ? `@${username}` : tweetUrl),
        url: tweetUrl,
        snippet: asString(rec.snippet) || asString(rec.text),
      };
    });
  } else if (providerId === 'ollama-search') {
    const rawBase = (accountBaseUrl ?? '').trim().replace(/\/+$/, '');
    const hasCustomBase = Boolean(rawBase && rawBase !== 'https://api.openai.com/v1');
    const endpoint = hasCustomBase
      ? rawBase
      : 'https://ollama.com/api/web_search';
    const response = await proxyFetch(
      endpoint,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey && apiKey !== 'no-auth' ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ query, max_results: maxResults }),
        signal,
      },
      hasCustomBase ? 'custom' : 'ollama-search',
      'unknown',
    );
    const data = await readSearchJson(response, providerId);
    items = Array.isArray(data.results) ? data.results : [];
  } else if (providerId === 'glm') {
    const endpoint = 'https://api.z.ai/api/mcp/web_search_prime/mcp';
    const response = await proxyFetch(
      endpoint,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'thruline-search',
          method: 'tools/call',
          params: {
            name: 'web_search_prime',
            arguments: { search_query: query, count: maxResults },
          },
        }),
        redirect: 'error',
        signal,
      },
      providerId,
      'unknown',
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`glm search failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    }
    let rpcPayload: Record<string, any> = {};
    const ct = (response.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('text/event-stream')) {
      const text = await response.text();
      for (const line of text.split(/\r?\n/)) {
        const trimmedLine = line.trim();
        if (!trimmedLine.startsWith('data:')) continue;
        try {
          rpcPayload = JSON.parse(trimmedLine.slice(5).trim()) as Record<string, any>;
          break;
        } catch { /* next line */ }
      }
    } else {
      rpcPayload = await response.json().catch(() => ({})) as Record<string, any>;
    }
    const rawContentText = rpcPayload?.result?.content?.[0]?.text;
    let parsedList: unknown = rpcPayload?.result?.results ?? rpcPayload?.results;
    if (typeof rawContentText === 'string' && rawContentText.trim()) {
      try {
        const inner = JSON.parse(rawContentText) as any;
        parsedList = Array.isArray(inner) ? inner : (inner?.search_result ?? inner?.results ?? parsedList);
      } catch {
        // ignore parse failure
      }
    }
    items = Array.isArray(parsedList) ? parsedList : [];
  } else {
    throw new Error(`Provider '${providerId}' has no native search adapter.`);
  }

  const results = normalizeSearchResults(items, maxResults);
  return { results, content: formatSearchContent(results) };
}

function parseChatSearchPayload(text: string, maxResults: number): { results: WebSearchResult[]; content?: string } | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const source = fenced ? fenced[1] : text;
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(source.slice(start, end + 1)) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      results: Array.isArray(parsed.results) ? normalizeSearchResults(parsed.results, maxResults) : [],
      content: typeof parsed.content === 'string' ? parsed.content : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Generic fallback for providers without a dedicated search API: ask the model
 * for structured results and parse them. A non-JSON answer is still useful, so
 * it is returned as `content` with an empty result list.
 */
async function searchViaChat(
  account: RoutableAccount,
  modelId: string,
  query: string,
  maxResults: number,
  signal: AbortSignal,
): Promise<WebSearchOutcome> {
  const provider = resolveAccountProvider(account);
  if (!provider) throw new Error(`Provider '${account.provider}' is not available.`);
  const credential = decrypt(account.encrypted_key, account.iv, account.auth_tag);
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `You are a web search assistant. Search the web for the user's query and reply with JSON only, no markdown or prose: {"results":[{"title":"...","url":"https://...","snippet":"..."}],"content":"a concise answer"}. Return at most ${maxResults} results and use real, public URLs.`,
    },
    { role: 'user', content: query },
  ];
  const completion = await provider.chatCompletion(
    credential,
    messages,
    modelId,
    { signal, temperature: 0, max_tokens: 1_200 },
    { platform: account.platform, keyId: account.id, modelId },
  );
  const rawContent = completion.choices?.[0]?.message?.content;
  const text = (typeof rawContent === 'string' ? rawContent : messageText(rawContent)).trim();
  const parsed = parseChatSearchPayload(text, maxResults);
  if (!parsed) return { results: [], content: text };
  return {
    results: parsed.results,
    content: (parsed.content ?? text).trim(),
  };
}

// POST /thruline/v1/search — search the web through a native adapter or the chat model
export async function handleXGatewaySearch(req: Request, res: Response): Promise<void> {
  const body = (req.body && typeof req.body === 'object') ? req.body as Record<string, unknown> : {};
  const query = typeof body.query === 'string' ? body.query.trim() : '';
  if (!query) {
    res.status(400).json({ error: { message: 'query must be a non-empty string', type: 'invalid_request_error' } });
    return;
  }
  if (query.length > MAX_SEARCH_QUERY_LENGTH) {
    res.status(400).json({ error: { message: `query must be at most ${MAX_SEARCH_QUERY_LENGTH} characters`, type: 'invalid_request_error' } });
    return;
  }

  const maxResults = clampInteger(body.max_results, 5, 1, MAX_SEARCH_RESULTS);
  const modelInput = typeof body.model === 'string' ? body.model.trim() : '';
  const providerInput = typeof body.provider === 'string' ? body.provider.trim() : '';
  const target = modelInput || (providerInput ? `${providerInput}/default` : 'auto');

  const authUser = (req as Request & { user?: ValidatedXGatewayClientKey }).user;
  if (authUser?.access?.restricted && !isModelAllowedForKey(authUser.access, target)) {
    res.status(403).json({
      error: {
        message: `Model or combo '${target}' is not allowed for this API key.`,
        type: 'permission_error',
        code: 'model_not_allowed',
      },
    });
    return;
  }

  const { candidates, notFoundError, combo } = resolveCandidateRoutes(target);
  if (notFoundError) {
    res.status(404).json({
      error: { message: notFoundError, type: 'invalid_request_error', code: 'model_not_found' },
    });
    return;
  }
  let searchCandidates = candidates;
  if (providerInput) {
    const normalizedProvider = normalizeXGatewayProviderId(providerInput) ?? providerInput.toLowerCase();
    searchCandidates = candidates.filter(candidate => candidate.account.provider === normalizedProvider);
  } else {
    const rawPrefix = target.includes('/') ? target.split('/')[0] : '';
    const normPrefix = rawPrefix ? (normalizeXGatewayProviderId(rawPrefix) ?? rawPrefix.toLowerCase()) : '';
    const isAutoOrNativeTarget = target === 'auto' || NATIVE_SEARCH_PROVIDERS.has(normPrefix);
    if (isAutoOrNativeTarget) {
      const rank = new Map<string, number>(CREDENTIAL_FALLBACK_ORDER.map((id, idx) => [id, idx]));
      const usableNative = getUsableXGatewayKeys()
        .map(account => ({ account, modelId: 'default' }))
        .filter(c => NATIVE_SEARCH_PROVIDERS.has(normalizeXGatewayProviderId(c.account.provider) ?? c.account.provider.toLowerCase()))
        .sort((a, b) => {
          const pa = normalizeXGatewayProviderId(a.account.provider) ?? a.account.provider.toLowerCase();
          const pb = normalizeXGatewayProviderId(b.account.provider) ?? b.account.provider.toLowerCase();
          return (rank.get(pa) ?? 99) - (rank.get(pb) ?? 99);
        });
      if (target === 'auto') {
        const seenAcc = new Set<number>(usableNative.map(c => c.account.id));
        const nonNative = searchCandidates.filter(c => !seenAcc.has(c.account.id));
        searchCandidates = [...usableNative, ...nonNative];
      } else {
        const seenAcc = new Set<number>(searchCandidates.map(c => c.account.id));
        searchCandidates = [...searchCandidates, ...usableNative.filter(c => !seenAcc.has(c.account.id))];
      }
    }
  }
  if (searchCandidates.length === 0) {
    res.status(503).json({
      error: {
        message: 'No enabled Thruline provider accounts available for search.',
        type: 'service_unavailable',
        code: 'no_available_keys',
      },
    });
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  let clientGone = false;
  const onClose = () => {
    if (!res.writableEnded) {
      clientGone = true;
      controller.abort();
    }
  };
  res.once('close', onClose);
  res.setHeader('X-Gateway', 'x');
  if (combo) res.setHeader('X-Combo-Strategy', combo.strategy);

  try {
    let lastError: unknown = null;
    for (const candidate of searchCandidates) {
      const startedAt = Date.now();
      try {
        const providerId = normalizeXGatewayProviderId(candidate.account.provider) ?? candidate.account.provider.toLowerCase();
        const credential = decrypt(candidate.account.encrypted_key, candidate.account.iv, candidate.account.auth_tag);
        const outcome = NATIVE_SEARCH_PROVIDERS.has(providerId)
          ? await nativeSearch(providerId, credential, candidate.account.base_url, query, maxResults, controller.signal)
          : await searchViaChat(candidate.account, candidate.modelId, query, maxResults, controller.signal);
        if (outcome.results.length === 0 && !outcome.content) {
          throw new Error('Search returned no results.');
        }
        recordRouteOutcome(healthKey(candidate), { latencyMs: Date.now() - startedAt });
        recordCandidateSuccess(candidate.account.id, candidate.modelId);
        res.status(200).json({
          query,
          model: candidate.modelId,
          provider: candidate.account.provider,
          results: outcome.results,
          content: outcome.content,
        });
        return;
      } catch (err) {
        if (clientGone) return;
        const classification = recordCandidateFailure(candidate.account.id, candidate.modelId, err);
        if (!classification.requestScoped) {
          recordRouteOutcome(healthKey(candidate), { error: true });
        }
        lastError = err;
      }
    }

    if (clientGone) return;
    if (controller.signal.aborted) {
      res.status(504).json({ error: { message: 'Search timed out.', type: 'timeout_error' } });
      return;
    }
    res.status(502).json({
      error: {
        message: sanitizeProviderErrorMessage(lastError instanceof Error ? lastError.message : 'All search providers failed.'),
        type: 'upstream_error',
      },
    });
  } finally {
    clearTimeout(timeout);
    res.off('close', onClose);
  }
}

/* ------------------------------------------------------------------ *
 * Web fetch  (POST /thruline/v1/fetch)
 * ------------------------------------------------------------------ */

class BlockedFetchUrlError extends Error {}

const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  copy: '©',
  reg: '®',
  trade: '™',
};

function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]+);/gi, (match, name: string) => {
    if (name.startsWith('#')) {
      const hex = name[1] === 'x' || name[1] === 'X';
      const code = Number.parseInt(hex ? name.slice(2) : name.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return HTML_ENTITIES[name.toLowerCase()] ?? match;
  });
}

function stripInlineHtml(input: string): string {
  return decodeHtmlEntities(input.replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ').trim();
}

function extractHtmlTitle(html: string): string | undefined {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = match ? stripInlineHtml(match[1]) : '';
  return title || undefined;
}

/** Readable plain text: tags become newlines, entities are decoded. */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|head)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|section|article|header|footer|main|aside|nav|ul|ol|li|table|thead|tbody|tr|td|th|blockquote|pre|figcaption|h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeHtmlEntities(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Small dependency-free HTML → markdown converter for fetched pages. */
export function htmlToMarkdown(html: string): string {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|head)\b[^>]*>[\s\S]*?<\/\1>/gi, '');

  text = text.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_match, body: string) => `\n\n\`\`\`\n${stripInlineHtml(body)}\n\`\`\`\n\n`);
  text = text.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_match, body: string) => `\`${stripInlineHtml(body)}\``);
  text = text.replace(
    /<a\b[^>]*href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_match, href: string, label: string) => {
      const cleanLabel = stripInlineHtml(label);
      const cleanHref = decodeHtmlEntities(href).trim();
      return cleanLabel ? `[${cleanLabel}](${cleanHref})` : cleanHref;
    },
  );
  text = text.replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, (_match, label: string) => stripInlineHtml(label));
  text = text.replace(/<img\b[^>]*>/gi, tag => {
    const alt = /alt\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? '';
    return alt ? `![${decodeHtmlEntities(alt)}]` : '';
  });
  text = text.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_match, _tag: string, body: string) => `**${stripInlineHtml(body)}**`);
  text = text.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_match, _tag: string, body: string) => `*${stripInlineHtml(body)}*`);
  text = text.replace(
    /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
    (_match, level: string, body: string) => `\n\n${'#'.repeat(Number(level))} ${stripInlineHtml(body)}\n\n`,
  );
  text = text.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_match, body: string) => `\n- ${stripInlineHtml(body)}`);
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(
    /<\/?(p|div|section|article|header|footer|main|aside|nav|ul|ol|table|thead|tbody|tr|td|th|blockquote|figure|figcaption)\b[^>]*>/gi,
    '\n',
  );
  text = text.replace(/<[^>]+>/g, ' ');
  return decodeHtmlEntities(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Validate a fetch target synchronously (shape) and against the SSRF policy. */
async function assertFetchTarget(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BlockedFetchUrlError('Invalid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedFetchUrlError('Only http and https URLs are supported.');
  }
  if (url.username || url.password) {
    throw new BlockedFetchUrlError('URLs with embedded credentials are not allowed.');
  }
  const verdict = await assessProviderUrl(url.toString(), { blockPrivate: true });
  if (!verdict.allowed) {
    throw new BlockedFetchUrlError(`Blocked URL: ${verdict.reason ?? 'destination is not public'}.`);
  }
  return url;
}

/** Follow redirects manually so every hop is re-checked by the SSRF policy. */
async function fetchWithRedirects(
  initial: URL,
  signal: AbortSignal,
): Promise<{ response: FetchResponse; finalUrl: string }> {
  let current = initial;
  for (let hop = 0; hop <= FETCH_MAX_REDIRECTS; hop += 1) {
    const response = await proxyFetch(
      current.toString(),
      {
        redirect: 'manual',
        signal,
        headers: {
          accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.8,*/*;q=0.5',
          'user-agent': 'FreeLLMAPI-X-Gateway/1.0',
        },
      },
      'custom',
      'unknown',
      undefined,
      { blockPrivate: true, allowManualRedirectResponse: true },
    );
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return { response, finalUrl: current.toString() };
      if (hop === FETCH_MAX_REDIRECTS) throw new Error('Too many redirects.');
      void response.body?.cancel().catch(() => {});
      current = await assertFetchTarget(new URL(location, current).toString());
      continue;
    }
    return { response, finalUrl: current.toString() };
  }
  throw new Error('Too many redirects.');
}

async function readBodyText(response: FetchResponse): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return response.text();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      bytes += value.byteLength;
      if (bytes > FETCH_MAX_BYTES) {
        await reader.cancel();
        break;
      }
      text += decoder.decode(value, { stream: true });
    }
  }
  return text + decoder.decode();
}

const MAX_FETCH_URL_LENGTH = 4_096;

// POST /thruline/v1/fetch — SSRF-guarded page fetch with HTML → text/markdown
export async function handleXGatewayFetch(req: Request, res: Response): Promise<void> {
  const body = (req.body && typeof req.body === 'object') ? req.body as Record<string, unknown> : {};
  const rawUrl = typeof body.url === 'string' ? body.url.trim() : '';
  if (!rawUrl) {
    res.status(400).json({ error: { message: 'url must be a non-empty string', type: 'invalid_request_error' } });
    return;
  }
  if (rawUrl.length > MAX_FETCH_URL_LENGTH) {
    res.status(400).json({ error: { message: `url must be at most ${MAX_FETCH_URL_LENGTH} characters`, type: 'invalid_request_error' } });
    return;
  }
  const format: FetchFormat = body.format === 'text' || body.format === 'html' || body.format === 'markdown'
    ? body.format
    : 'markdown';
  const maxCharacters = clampInteger(
    body.max_characters,
    FETCH_DEFAULT_MAX_CHARACTERS,
    1,
    FETCH_MAX_CHARACTERS_LIMIT,
  );

  let target: URL;
  try {
    target = await assertFetchTarget(rawUrl);
  } catch (err) {
    res.status(400).json({
      error: {
        message: err instanceof Error ? err.message : 'Invalid URL.',
        type: 'invalid_request_error',
        code: 'url_blocked',
      },
    });
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let clientGone = false;
  const onClose = () => {
    if (!res.writableEnded) {
      clientGone = true;
      controller.abort();
    }
  };
  res.once('close', onClose);
  res.setHeader('X-Gateway', 'x');

  try {
    const { response, finalUrl } = await fetchWithRedirects(target, controller.signal);
    if (!response.ok) {
      res.status(502).json({
        error: { message: `Upstream returned HTTP ${response.status}.`, type: 'upstream_error' },
      });
      return;
    }

    const raw = await readBodyText(response);
    const contentType = response.headers.get('content-type') ?? '';
    const looksHtml = /html|xml/i.test(contentType) || /^\s*(<!doctype html|<html)/i.test(raw);
    const title = looksHtml ? extractHtmlTitle(raw) : undefined;
    let content = raw;
    if (looksHtml && format !== 'html') {
      content = format === 'text' ? htmlToText(raw) : htmlToMarkdown(raw);
    }
    const truncated = content.length > maxCharacters;
    content = content.slice(0, maxCharacters);

    res.status(200).json({ url: rawUrl, finalUrl, format, title, truncated, content });
  } catch (err) {
    if (clientGone) return;
    if (err instanceof BlockedFetchUrlError) {
      res.status(400).json({
        error: { message: err.message, type: 'invalid_request_error', code: 'url_blocked' },
      });
      return;
    }
    if (controller.signal.aborted) {
      res.status(504).json({ error: { message: 'Fetch timed out.', type: 'timeout_error' } });
      return;
    }
    res.status(502).json({
      error: {
        message: sanitizeProviderErrorMessage(err instanceof Error ? err.message : 'Fetch failed.'),
        type: 'upstream_error',
      },
    });
  } finally {
    clearTimeout(timeout);
    res.off('close', onClose);
  }
}

xGatewayRouter.post('/chat/completions', xGatewayAuth, handleXGatewayChat);
xGatewayRouter.post('/search', xGatewayAuth, handleXGatewaySearch);
xGatewayRouter.post('/fetch', xGatewayAuth, handleXGatewayFetch);
xGatewayRouter.post('/web/fetch', xGatewayAuth, handleXGatewayFetch);

const MODEL_ENDPOINTS: Record<string, string> = {
  llm: '/thruline/v1/chat/completions', imageToText: '/thruline/v1/chat/completions',
  image: '/thruline/v1/images/generations', tts: '/thruline/v1/audio/speech',
  stt: '/thruline/v1/audio/transcriptions', embedding: '/thruline/v1/embeddings',
  video: '/thruline/v1/videos/generations', webSearch: '/thruline/v1/search', webFetch: '/thruline/v1/fetch',
};

function handleModelInfo(req: Request, res: Response): void {
  const id = typeof req.query.id === 'string' ? req.query.id : req.params.model;
  if (typeof id !== 'string' || !id) {
    res.status(400).json({ error: { message: 'id is required', type: 'invalid_request_error' } });
    return;
  }
  const slash = id.indexOf('/');
  const prefix = slash > 0 ? id.slice(0, slash) : '';
  const providerId = normalizeXGatewayProviderId(prefix) ?? prefix;
  const provider = X_GATEWAY_PROVIDERS.find(p => p.id === providerId);
  const modelId = slash > 0 ? id.slice(slash + 1) : id;
  const requestedKind = typeof req.query.kind === 'string' ? req.query.kind : undefined;
  const sources = getUsableXGatewayKeys().filter(a => !prefix || a.provider === providerId);
  const model = sources.flatMap(a => accountModels(a)).find(m => m.id === modelId)
    ?? provider?.models.find(m => m.id === modelId);
  if (!model || (requestedKind && !MODEL_ENDPOINTS[requestedKind])) {
    res.status(404).json({ error: { message: `Model not found: ${id}`, type: 'not_found' } });
    return;
  }
  const inferred = /video|veo|sora|kling|wan[\d.-]|luma|grok-imagine-video/i.test(modelId) ? 'video'
    : IMAGE_MODEL_RE.test(modelId) ? 'image'
    : /tts|speech|voice|sonic|eleven_|aura-/i.test(modelId) || ['edge-tts', 'elevenlabs', 'cartesia', 'fish-audio'].includes(providerId) ? 'tts'
    : /whisper|transcri|nova-.*general/i.test(modelId) || (providerId === 'deepgram' && /^nova-/i.test(modelId)) ? 'stt'
    : /embed/i.test(modelId) ? 'embedding'
    : /search|sonar/i.test(modelId) ? 'webSearch'
    : /fetch|reader/i.test(modelId) ? 'webFetch' : 'llm';
  // Some providers reuse a model for several media tasks (notably Gemini).
  if (requestedKind && requestedKind !== inferred && !(providerId === 'gemini' && ['tts', 'stt', 'imageToText'].includes(requestedKind))) {
    res.status(404).json({ error: { message: `Model not found for kind: ${requestedKind}`, type: 'not_found' } });
    return;
  }
  const matchedAccount = sources.find(a => accountModels(a).some(m => m.id === modelId));
  const owner = provider ?? getXGatewayProvider(matchedAccount?.provider ?? '');
  const alias = owner?.alias ?? (prefix || matchedAccount?.provider || 'x-gateway');
  const kind = requestedKind ?? inferred;
  res.setHeader('X-Gateway', 'x');
  res.json({ id: `${alias}/${modelId}`, name: model.name, kind, owned_by: alias,
    endpoint: MODEL_ENDPOINTS[kind],
    ...(kind === 'tts' ? { voicesUrl: `/thruline/v1/audio/voices?provider=${encodeURIComponent(owner?.id ?? prefix)}` } : {}),
  });
}

xGatewayRouter.get('/models/info', xGatewayAuth, handleModelInfo);
// Express 5 uses named wildcards; a regexp preserves slashes in model IDs.
xGatewayRouter.get(/^\/models\/(.+)$/, xGatewayAuth, (req: Request, res: Response) => {
  req.params.model = req.params[0];
  handleModelInfo(req, res);
});

function inferModelMetadata(modelId: string, kind?: string): {
  capabilities: string[];
  thinking_levels?: string[];
} {
  const lower = modelId.toLowerCase();
  const capabilities: string[] = [];
  if (kind && ['image', 'video', 'tts', 'stt', 'embedding'].includes(kind)) {
    capabilities.push(kind);
  } else {
    capabilities.push('chat');
  }

  const isReasoning =
    /thinking|reason|deepthink|\bo[134](?:-|$)|\br1\b|gpt-5|gpt-6|claude-(?:sonnet|opus|haiku)-4|claude-.*-(?:4\.5|4\.6|5)|gemini-2\.5|gemini-3|qwen3|qwq|glm-5|glm-4\.[5-9]/i.test(lower);
  let thinkingLevels: string[] | undefined;
  if (isReasoning && capabilities[0] === 'chat') {
    capabilities.push('thinking');
    thinkingLevels = /gpt-6|gpt-5\.6/i.test(lower)
      ? ['low', 'medium', 'high', 'xhigh', 'max']
      : ['low', 'medium', 'high'];
  }

  if (capabilities[0] === 'chat' && /vl|vision|gpt-4o|gpt-5|gpt-6|claude-|gemini|grok|pixtral|llava/i.test(lower)) {
    capabilities.push('vision');
  }
  if (capabilities[0] === 'chat' && !/\bo1-mini\b/i.test(lower)) {
    capabilities.push('tools');
  }
  return {
    capabilities,
    ...(thinkingLevels ? { thinking_levels: thinkingLevels } : {}),
  };
}

// GET /thruline/v1/models — list models from enabled X Gateway accounts and combos
xGatewayRouter.get('/models', xGatewayAuth, (req: Request, res: Response) => {
  res.setHeader('X-Gateway', 'x');
  const snapshot = getConfigSnapshot();
  const seen = new Set<string>();
  const data: Array<{
    id: string;
    object: 'model';
    created: number;
    owned_by: string;
    capabilities?: string[];
    thinking_levels?: string[];
  }> = [];

  for (const combo of snapshot.combos) {
    const id = `combo:${combo.name}`;
    if (!seen.has(id)) {
      seen.add(id);
      const comboKind = combo.kind && combo.kind !== 'chat' ? combo.kind : 'chat';
      data.push({
        id,
        object: 'model',
        created: 0,
        owned_by: 'x-gateway',
        capabilities: comboKind === 'chat' ? ['chat', 'tools'] : [comboKind],
      });
    }
  }

  for (const account of getUsableXGatewayKeys()) {
    const providerEntry = getXGatewayProvider(account.provider);
    const alias = providerEntry?.alias ?? account.provider;
    const modelsForAccount = accountModels(account);
    const catalogKinds = new Map<string, string>();
    for (const cm of providerEntry?.models ?? []) {
      const k = (cm as { kind?: string }).kind;
      if (typeof k === 'string' && k) catalogKinds.set(cm.id, k);
    }
    if (modelsForAccount.length > 0) {
      const autoId = `${alias}/auto`;
      if (!seen.has(autoId)) {
        seen.add(autoId);
        data.push({ id: autoId, object: 'model', created: 0, owned_by: account.provider, capabilities: ['chat'] });
      }
    }
    for (const model of modelsForAccount) {
      const meta = inferModelMetadata(model.id, catalogKinds.get(model.id));
      const prefixed = `${alias}/${model.id}`;
      if (!seen.has(prefixed)) {
        seen.add(prefixed);
        data.push({ id: prefixed, object: 'model', created: 0, owned_by: account.provider, ...meta });
      }
      if (!seen.has(model.id)) {
        seen.add(model.id);
        data.push({ id: model.id, object: 'model', created: 0, owned_by: account.provider, ...meta });
      }
    }
  }

  // Content-negotiation for Anthropic SDK / Claude Code (`anthropic-version` header)
  if (req.headers['anthropic-version']) {
    const createdAt = '2026-01-01T00:00:00Z';
    const anthropicModels = [
      { type: 'model' as const, id: 'auto', display_name: 'Thruline Auto', created_at: createdAt },
      { type: 'model' as const, id: 'claude-sonnet-4-5-20250929', display_name: 'Claude Sonnet 4.5 (Thruline)', created_at: createdAt },
      { type: 'model' as const, id: 'claude-opus-4-6', display_name: 'Claude Opus 4.6 (Thruline)', created_at: createdAt },
      { type: 'model' as const, id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5 (Thruline)', created_at: createdAt },
      ...data.map(m => ({
        type: 'model' as const,
        id: m.id,
        display_name: m.id,
        created_at: createdAt,
      })),
    ];
    res.json({
      data: anthropicModels,
      has_more: false,
      first_id: anthropicModels[0]?.id ?? null,
      last_id: anthropicModels[anthropicModels.length - 1]?.id ?? null,
    });
    return;
  }

  res.json({ object: 'list', data });
});

// Mount Anthropic Messages, OpenAI Responses, Legacy Completions, Embeddings, Image & Audio routes
xGatewayRouter.use(xGatewayProtocolsRouter);

// AI Support Partner Gateway (/thruline/v1/support/*)
xGatewayRouter.use('/support', xSupportPublicRouter);
xGatewayRouter.use('/support', xSupportEnterprisePublicRouter);
xGatewayRouter.use('/support', xSupportGovernancePublicRouter);
xGatewayRouter.use('/support', xSupportServiceDeskPublicRouter);

// Catch-all: any other path under /thruline/v1 returns JSON 404
xGatewayRouter.use((_req: Request, res: Response) => {
  res.status(404).json({ error: { message: 'Not found', type: 'not_found' } });
});
