import { Router } from 'express';
import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import type { ChatMessage } from '@freellmapi/shared/types.js';
import type { CompletionOptions } from '../../providers/base.js';
import { decrypt } from '../../lib/crypto.js';
import { estimateInputTokens } from '../../lib/content.js';
import { assessProviderUrl } from '../../lib/url-guard.js';
import { withQuotaTracking } from './quota/tracking.js';
import { applyQuotaRouting } from './quota/store.js';
import { logRequest } from '../../lib/request-log.js';
import { sanitizeProviderErrorMessage } from '../../lib/error-redaction.js';
import { applyOutputSavers } from '../output-savers/apply.js';
import { buildSaverBlock } from '../output-savers/prompts.js';
import {
  getXGatewayProvider,
  normalizeXGatewayProviderId,
  resolveXGatewayProvider,
} from '../provider-accounts/catalog.js';
import {
  accountModels,
  getProviderModelConfig,
  getUsableXGatewayKeys,
  recordXGatewayKeyUsage,
  resolveProviderModelAlias,
  resolveXGatewayAccountProxy,
  type AccountRow,
} from '../provider-accounts/store.js';
import { xGatewayAuth } from './auth.js';
import { isModelAllowedForKey, type ValidatedXGatewayClientKey } from './client-keys.js';
import { augmentCandidatesWithCapacityAdapter } from './capacity-adapter.js';
import {
  DEFAULT_COMBO_STRATEGY,
  resolveComboPolicy,
  rotateComboEntries,
  type ComboPolicyInput,
  type ComboSmartPolicy,
  type ComboStrategy,
} from './combos.js';
import { getConfigSnapshot } from './config.js';
import { runInGatewayScope } from './context.js';
import { xGatewayProtocolsRouter } from './protocols.js';

export const xGatewayRouter = Router();

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

export type CandidateModality = 'chat' | 'image';

const IMAGE_MODEL_RE =
  /(?:^|[^a-z])(image|imagen|dall-?e|flux|diffusion|sdxl|seedream|ideogram|recraft|midjourney|qwen-image|wanx)(?:[^a-z]|$)/i;

/**
 * `auto` normally means "first model of the account", which is a chat model.
 * Image routes need the account's image model instead, or the chat model gets
 * forwarded to `/images/generations` and rejected upstream.
 */
function pickCandidateModel(models: { id: string; name?: string }[], modality: CandidateModality): string {
  if (modality === 'image') {
    const image = models.find(m => IMAGE_MODEL_RE.test(m.id) || IMAGE_MODEL_RE.test(m.name ?? ''));
    if (image) return image.id;
    const generic = models.find(m => m.id.toLowerCase() === 'default' || m.id.toLowerCase() === 'auto');
    if (generic) return generic.id;
  }
  return models[0]?.id ?? 'default';
}

export interface ComboRouteInfo {
  name: string;
  strategy: ComboStrategy;
  smartPolicy: ComboSmartPolicy;
  sessionSticky: boolean;
  confidenceThreshold: number;
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

export function resolveCandidateRoutes(
  requestedModel: string | undefined,
  modality: CandidateModality = 'chat',
): {
  candidates: CandidateRoute[];
  notFoundError?: string;
  combo?: ComboRouteInfo;
} {
  const rawModel = (requestedModel ?? 'auto').trim() || 'auto';
  const lower = rawModel.toLowerCase();
  const usable = applyQuotaRouting(getUsableXGatewayKeys().filter(isWithinAccountCaps), lower === 'auto' || lower.startsWith('auto:'));

  if (lower === 'auto' || lower.startsWith('auto:')) {
    const candidates: CandidateRoute[] = [];
    for (const account of usable) {
      const models = accountModels(account);
      candidates.push({ account, modelId: pickCandidateModel(models, modality) });
    }
    return { candidates };
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
    const steps = strategy === 'round-robin' ? rotateComboEntries(combo.name, combo.entries) : combo.entries;
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
    return {
      candidates: strategy === 'smart' ? sortCandidatesByHealth(candidates) : candidates,
      combo: { name: combo.name, strategy, ...resolveComboPolicy(combo) },
    };
  }

  const slashIdx = rawModel.indexOf('/');
  if (slashIdx > 0) {
    const prefix = rawModel.slice(0, slashIdx);
    const suffix = rawModel.slice(slashIdx + 1);
    const matchedProvider = normalizeXGatewayProviderId(prefix);
    if (matchedProvider && suffix) {
      const route = resolveRouteModel(matchedProvider, suffix);
      if (route.disabled) {
        return {
          candidates: [],
          notFoundError: `Model '${suffix}' is disabled for provider '${matchedProvider}'`,
        };
      }
      const providerAccounts = usable.filter(a => a.provider === matchedProvider);
      return {
        candidates: providerAccounts.map(account => ({ account, modelId: route.modelId })),
      };
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
    return { candidates: exactMatches };
  }

  return {
    candidates: usable.map(account => ({ account, modelId: rawModel })),
  };
}

/*
 * Smart routing keeps a small in-memory health record per (account, model).
 * Latency is an exponential moving average so a single fast/slow request does
 * not reorder the whole combo, and consecutive failures carry a decayed penalty
 * that disappears once the route succeeds again. Unknown routes sit in the
 * middle, which makes a cold process behave like plain `fallback`.
 */
const ROUTE_HEALTH_TTL_MS = 5 * 60_000;
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
}

function routeScore(health: RouteHealth | undefined): number {
  if (!health) return UNKNOWN_LATENCY_MS;
  const failing = health.consecutiveErrors > 0
    && Date.now() - health.lastFailureAt < ROUTE_HEALTH_TTL_MS;
  return health.latencyMs + (failing ? health.consecutiveErrors * FAILURE_PENALTY_MS : 0);
}

/** Stable sort: healthier routes first, original step order on ties. */
export function sortCandidatesByHealth<T extends Pick<CandidateRoute, 'account' | 'modelId'>>(candidates: T[]): T[] {
  return [...candidates].sort((a, b) => routeScore(routeHealth.get(healthKey(a))) - routeScore(routeHealth.get(healthKey(b))));
}

/**
 * Fusion fans a request out to the first two distinct combo steps. Candidates
 * for the same step (several accounts of one provider) collapse to the first.
 */
export function pickFusionCandidates<T extends { step?: number }>(candidates: T[]): T[] {
  const picked: T[] = [];
  const seenSteps = new Set<number>();
  for (const candidate of candidates) {
    if (candidate.step !== undefined) {
      if (seenSteps.has(candidate.step)) continue;
      seenSteps.add(candidate.step);
    }
    picked.push(candidate);
    if (picked.length >= 2) break;
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
  if (pinnedHealth) {
    const failing = pinnedHealth.consecutiveErrors > 0
      && Date.now() - pinnedHealth.lastFailureAt < ROUTE_HEALTH_TTL_MS;
    if (failing) return true;
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
  if (!combo || combo.strategy !== 'smart' || candidates.length === 0) return candidates;
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

// POST /x/v1/chat/completions — dispatch exclusively over x_gateway_keys
export async function handleXGatewayChat(req: Request, res: Response): Promise<void> {
  const startMs = Date.now();
  const body = (req.body && typeof req.body === 'object') ? req.body as Record<string, unknown> : {};
  const rawMessages = Array.isArray(body.messages) ? (body.messages as ChatMessage[]) : [];
  if (rawMessages.length === 0) {
    res.status(400).json({
      error: { message: 'messages must be a non-empty array', type: 'invalid_request_error' },
    });
    return;
  }

  const requestedModel = typeof body.model === 'string' ? body.model : 'auto';
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
  const { messages, appliedSavers } = applyGatewaySavers(req, rawMessages);

  const scope = {
    gateway: 'x' as const,
    outputSavers: appliedSavers,
    inputSaver: getConfigSnapshot().savers.input,
    inputTokensSaved: 0,
  };

  res.setHeader('X-Gateway', 'x');
  res.setHeader('X-Output-Saver-Applied', appliedSavers.join(','));
  res.setHeader('X-Input-Tokens-Saved', '0');

  const controller = new AbortController();
  const onClose = () => { if (!res.writableEnded) controller.abort(); };
  res.once('close', onClose);
  try {
  await runInGatewayScope(scope, async () => {
    const { candidates: rawCandidates, notFoundError, combo } = resolveCandidateRoutes(requestedModel);
    if (notFoundError) {
      res.status(404).json({
        error: { message: notFoundError, type: 'invalid_request_error', code: 'model_not_found' },
      });
      return;
    }
    const strategy = combo?.strategy ?? DEFAULT_COMBO_STRATEGY;
    if (combo) {
      res.setHeader('X-Combo-Strategy', strategy);
      if (strategy === 'smart') res.setHeader('X-Combo-Policy', combo.smartPolicy);
    }
    // The adapter only ever returns account/model pairs, so it can keep the
    // combo step metadata that `resolveCandidateRoutes` attached.
    const augmented = augmentCandidatesWithCapacityAdapter(rawCandidates, messages) as CandidateRoute[];
    // Smart combos keep a conversation on the same route to protect the
    // provider's warm prompt cache; other strategies keep their own ordering.
    const candidates = applySessionStickiness(augmented, combo, messages);
    if (candidates.length === 0) {
      res.status(503).json({
        error: {
          message: 'No enabled X Gateway provider accounts available.',
          type: 'service_unavailable',
          code: 'no_available_keys',
        },
      });
      return;
    }

    const options: CompletionOptions = {
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

    /** One non-streaming attempt, isolated so fusion can run two in parallel. */
    const attemptNonStream = async (candidate: CandidateRoute, signal: AbortSignal) => {
      const { account, modelId } = candidate;
      const provider = resolveXGatewayProvider(account.provider, account.base_url);
      if (!provider) throw new Error(`Provider '${account.provider}' is not available.`);
      const credential = decrypt(account.encrypted_key, account.iv, account.auth_tag);
      const effectiveProxy = resolveXGatewayAccountProxy(account);
      const startedAt = Date.now();
      const completion = await withQuotaTracking(account, modelId, effectiveProxy, () =>
        provider.chatCompletion(
          credential,
          messages,
          modelId,
          { ...options, signal },
          { platform: account.platform, keyId: account.id, modelId },
        ),
      );
      return { candidate, completion, latencyMs: Date.now() - startedAt };
    };

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

    if (!isStream && strategy === 'fusion') {
      // Fusion races the first two distinct combo steps; the first success wins
      // and the slower attempt is aborted. One step (or a single account) simply
      // behaves like fallback.
      const fusionCandidates = pickFusionCandidates(candidates);
      if (fusionCandidates.length > 1) {
        const children = fusionCandidates.map(() => new AbortController());
        const abortChildren = () => { for (const child of children) child.abort(); };
        const onAbort = () => abortChildren();
        controller.signal.addEventListener('abort', onAbort);
        try {
          const winner = await raceFirstSuccess(fusionCandidates.map((candidate, index) =>
            attemptNonStream(candidate, children[index].signal)));
          if (controller.signal.aborted) return;
          recordRouteOutcome(healthKey(winner.candidate), { latencyMs: winner.latencyMs });
          succeedNonStream(winner);
          return;
        } catch (err) {
          if (controller.signal.aborted) return;
          lastError = err;
          for (const candidate of fusionCandidates) {
            recordRouteOutcome(healthKey(candidate), { error: true });
          }
          // Fall through to the sequential loop, which retries every step in order.
        } finally {
          controller.signal.removeEventListener('abort', onAbort);
          abortChildren();
        }
      }
    }

    for (const candidate of candidates) {
      if (controller.signal.aborted) return;
      const { account, modelId } = candidate;

      if (!isStream) {
        try {
          const result = await attemptNonStream(candidate, controller.signal);
          recordRouteOutcome(healthKey(candidate), { latencyMs: result.latencyMs });
          succeedNonStream(result);
          return;
        } catch (err) {
          recordRouteOutcome(healthKey(candidate), { error: true });
          lastError = err;
          continue;
        }
      }

      const provider = resolveXGatewayProvider(account.provider, account.base_url);
      if (!provider) {
        lastError = new Error(`Provider '${account.provider}' is not available.`);
        recordRouteOutcome(healthKey(candidate), { error: true });
        continue;
      }

      let credential: string;
      try {
        credential = decrypt(account.encrypted_key, account.iv, account.auth_tag);
      } catch (err) {
        lastError = err;
        recordRouteOutcome(healthKey(candidate), { error: true });
        continue;
      }

      const effectiveProxy = resolveXGatewayAccountProxy(account);
      const streamStartedAt = Date.now();

      try {
        await withQuotaTracking(account, modelId, effectiveProxy, async () => {
          const stream = provider.streamChatCompletion(
            credential,
            messages,
            modelId,
            options,
            { platform: account.platform, keyId: account.id, modelId },
          );
          let ttfbMs = 0;
          let promptTokens = estimatedPromptTokens;
          let completionTokens = 0;
          for await (const chunk of stream) {
            if (controller.signal.aborted) return;
            if (!res.headersSent) {
              res.setHeader('Content-Type', 'text/event-stream');
              res.setHeader('Cache-Control', 'no-cache');
              res.setHeader('X-Accel-Buffering', 'no');
              res.setHeader('X-Routed-Via', `${account.provider}/${modelId}`);
              ttfbMs = Date.now() - startMs;
            }
            if (chunk.usage?.prompt_tokens != null) promptTokens = chunk.usage.prompt_tokens;
            if (chunk.usage?.completion_tokens != null) completionTokens = chunk.usage.completion_tokens;
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          }
          if (controller.signal.aborted) return;
          if (!res.headersSent) throw new Error('Provider returned an empty stream.');
          res.write('data: [DONE]\n\n');
          res.end();

          const latencyMs = Date.now() - startMs;
          recordRouteOutcome(healthKey(candidate), { latencyMs: Date.now() - streamStartedAt });
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
        return;
      } catch (err) {
        if (controller.signal.aborted) return;
        recordRouteOutcome(healthKey(candidate), { error: true });
        if (res.headersSent) {
          res.write(`data: ${JSON.stringify({ error: { message: sanitizeProviderErrorMessage(err instanceof Error ? err.message : 'Stream interrupted') } })}\n\n`);
          res.end();
          return;
        }
        lastError = err;
        continue;
      }
    }

    const message = sanitizeProviderErrorMessage(lastError instanceof Error ? lastError.message : 'All X Gateway provider accounts failed.');
    const firstCandidate = candidates[0];
    if (firstCandidate) {
      logRequest(
        firstCandidate.account.provider,
        firstCandidate.modelId,
        null,
        'error',
        estimatedPromptTokens,
        0,
        Date.now() - startMs,
        message,
        null,
        requestedModel === 'auto' ? null : requestedModel,
        null,
        'x-gateway',
      );
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
 * Web search  (POST /x/v1/search)
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

const NATIVE_SEARCH_PROVIDERS = new Set(['tavily', 'serper', 'brave-search', 'exa', 'searxng']);
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
    const base = (accountBaseUrl ?? '').trim();
    if (!base) throw new Error('SearXNG search requires a base_url on the account.');
    const endpoint = new URL('search', base.endsWith('/') ? base : `${base}/`);
    endpoint.searchParams.set('q', query);
    endpoint.searchParams.set('format', 'json');
    endpoint.searchParams.set('language', 'all');
    const response = await fetch(endpoint.toString(), {
      headers: { accept: 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      signal,
    });
    const data = await readSearchJson(response, providerId);
    items = Array.isArray(data.results) ? data.results : [];
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
  const provider = resolveXGatewayProvider(account.provider, account.base_url);
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

// POST /x/v1/search — search the web through a native adapter or the chat model
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
  }
  if (searchCandidates.length === 0) {
    res.status(503).json({
      error: {
        message: 'No enabled X Gateway provider accounts available for search.',
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
        recordRouteOutcome(healthKey(candidate), { error: true });
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
 * Web fetch  (POST /x/v1/fetch)
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
    const response = await fetch(current.toString(), {
      redirect: 'manual',
      signal,
      headers: {
        accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.8,*/*;q=0.5',
        'user-agent': 'FreeLLMAPI-X-Gateway/1.0',
      },
    });
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

// POST /x/v1/fetch — SSRF-guarded page fetch with HTML → text/markdown
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

// GET /x/v1/models — list models from enabled X Gateway accounts and combos
xGatewayRouter.get('/models', xGatewayAuth, (req: Request, res: Response) => {
  res.setHeader('X-Gateway', 'x');
  const snapshot = getConfigSnapshot();
  const seen = new Set<string>();
  const data: Array<{ id: string; object: 'model'; created: number; owned_by: string }> = [];

  for (const combo of snapshot.combos) {
    const id = `combo:${combo.name}`;
    if (!seen.has(id)) {
      seen.add(id);
      data.push({ id, object: 'model', created: 0, owned_by: 'x-gateway' });
    }
  }

  for (const account of getUsableXGatewayKeys()) {
    const providerEntry = getXGatewayProvider(account.provider);
    const alias = providerEntry?.alias ?? account.provider;
    for (const model of accountModels(account)) {
      const prefixed = `${alias}/${model.id}`;
      if (!seen.has(prefixed)) {
        seen.add(prefixed);
        data.push({ id: prefixed, object: 'model', created: 0, owned_by: account.provider });
      }
      if (!seen.has(model.id)) {
        seen.add(model.id);
        data.push({ id: model.id, object: 'model', created: 0, owned_by: account.provider });
      }
    }
  }

  // Content-negotiation for Anthropic SDK / Claude Code (`anthropic-version` header)
  if (req.headers['anthropic-version']) {
    const createdAt = '2026-01-01T00:00:00Z';
    const anthropicModels = [
      { type: 'model' as const, id: 'auto', display_name: 'X Gateway Auto', created_at: createdAt },
      { type: 'model' as const, id: 'claude-sonnet-4-5-20250929', display_name: 'Claude Sonnet 4.5 (X Gateway)', created_at: createdAt },
      { type: 'model' as const, id: 'claude-opus-4-6', display_name: 'Claude Opus 4.6 (X Gateway)', created_at: createdAt },
      { type: 'model' as const, id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5 (X Gateway)', created_at: createdAt },
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

// Catch-all: any other path under /x/v1 returns JSON 404
xGatewayRouter.use((_req: Request, res: Response) => {
  res.status(404).json({ error: { message: 'Not found', type: 'not_found' } });
});
