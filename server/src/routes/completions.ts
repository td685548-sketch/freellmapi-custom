import { Router } from 'express';
import { isAutoModel, requireInferenceAuth, getRequestGroupId, quotaContextForRoute, traceRouteEvent, providerSafeStop, streamReasoningText, completionReasoningText, stopSchema, MAX_RETRIES, resolveChatRoute } from './chat-route.js';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { ChatMessage } from '@freellmapi/shared/types.js';
import { type RouteResult, type ResolvedChain, routeRequest, resolveRoutingChain, resolveModelGroupCandidates, routingReserveTokens, failureAttributionFor } from '../services/router.js';
import { noteRequestTokens } from '../lib/client-context.js';
import { prependSystemPrompt } from '../lib/system-prompt.js';
import { applyOutputSavers } from '../custom/output-savers/apply.js';
import { contentToString } from '../lib/content.js';
import { routeOutputBudget } from '../lib/output-cap.js';
import { sanitizeProviderErrorMessage } from '../lib/error-redaction.js';
import { isClientAbortError, newClientAbortError, newHedgeAbortError, isUpstreamClassificationOutput } from '../lib/error-classify.js';
import { logRequest } from '../lib/request-log.js';
import { runFallbackLoop, newFallbackState, fallbackRoutingTokens, recordUpstreamSuccess, setFallbackHeaders, exhaustionErrorPayload, setExhaustionHeaders, type AttemptRecord } from '../lib/fallback-loop.js';
import { routedViaValue } from '../lib/header-value.js';
import { applyTokenBudget, tokenBudgetMessage } from '../lib/guardrails.js';
import { resolveListedClaudeAlias } from '../services/anthropic-map.js';
import { startStreamKeepalive, streamKeepaliveMs } from '../lib/stream-keepalive.js';

// Pull the incremental text out of a streaming chunk for token counting.
// Must tolerate chunks that carry no `choices` array at all: some providers
// (e.g. Groq) emit usage/keepalive frames shaped like `{usage:{...}}` with no
// `choices`. Indexing `chunk.choices[0]` on those throws "Cannot read
// properties of undefined (reading '0')", which — once the SSE stream has
// started — aborts the response mid-flight with no chance to fall back.
export function streamChunkText(chunk: any): string {
  return chunk?.choices?.[0]?.delta?.content ?? '';
}

const CompletionBody = z.object({
  model: z.string().optional(),
  prompt: z.string(),
  suffix: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().optional(),
  top_p: z.number().min(0).max(1).optional(),
  stop: stopSchema.optional(),
  stream: z.boolean().optional(),
});

function completionPromptToMessages(prompt: string, suffix?: string): ChatMessage[] {
  const hasSuffix = suffix !== undefined && suffix.length > 0;
  return [
    {
      role: 'system',
      content: [
        'You are a code autocomplete engine.',
        'Complete at the cursor and return only the text to insert.',
        'Do not include markdown fences, explanations, or repeat surrounding code.',
      ].join(' '),
    },
    {
      role: 'user',
      content: hasSuffix
        ? `Prefix before cursor:\n${prompt}\n\nSuffix after cursor:\n${suffix}\n\nCompletion to insert:`
        : `Prefix before cursor:\n${prompt}\n\nCompletion to insert:`,
    },
  ];
}

function completionTextFromChat(result: any): string {
  return contentToString(result?.choices?.[0]?.message?.content ?? '');
}

function completionIdFromChat(id: string | undefined): string {
  if (!id) return `cmpl-${Date.now()}`;
  return id.startsWith('cmpl-') ? id : `cmpl-${id}`;
}

function legacyCompletionChunk(route: RouteResult, chunk: any, text: string) {
  return {
    id: completionIdFromChat(chunk?.id),
    object: 'text_completion',
    created: chunk?.created ?? Math.floor(Date.now() / 1000),
    model: route.modelId,
    choices: [{
      text,
      index: chunk?.choices?.[0]?.index ?? 0,
      logprobs: null,
      finish_reason: chunk?.choices?.[0]?.finish_reason ?? null,
    }],
  };
}

// OpenAI-compatible legacy completions endpoint. Editor ghost-text clients
// (notably Continue autocomplete) still send prompt/suffix requests here; route
// those through chat models while preserving the legacy text_completion shape.
export async function handleLegacyCompletions(req: Request, res: Response): Promise<void> {
  const start = Date.now();
  const requestGroupId = getRequestGroupId(req);
  res.setHeader('X-Request-ID', requestGroupId);

  const auth = requireInferenceAuth(req, res);
  if (!auth) return;

  const parsed = CompletionBody.safeParse(req.body);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map(e => (e.path.length ? `${e.path.join('.')}: ${e.message}` : e.message))
      .slice(0, 5)
      .join(', ');
    res.status(400).json({
      error: { message: `Invalid request: ${detail}`, type: 'invalid_request_error' },
      execution_id: requestGroupId,
    });
    return;
  }

  const { model: clientModel, prompt, suffix, temperature, top_p, stream } = parsed.data;
  const requestedModelLabel = clientModel ?? 'auto';
  // Claude alias from GET /v1/models → the Claude family map, as on /v1/chat/completions.
  const claudeAlias = resolveListedClaudeAlias(clientModel);
  const requestedModel = claudeAlias?.kind === 'model' ? claudeAlias.modelId : claudeAlias ? 'auto' : clientModel;
  const aliasTierChain = claudeAlias?.kind === 'tier' ? resolveModelGroupCandidates(claudeAlias.dbIds) : [];
  const max_tokens = parsed.data.max_tokens != null && parsed.data.max_tokens > 0
    ? parsed.data.max_tokens : 128;
  const stop = providerSafeStop(parsed.data.stop);
  // A profile's enforced prompt goes ahead of the autocomplete system message.
  const messages = prependSystemPrompt(
    applyOutputSavers(completionPromptToMessages(prompt, suffix), req.headers['x-freellm-saver']),
    auth.systemPrompt,
  );
  const estimatedInputTokens = messages.reduce((sum, m) => sum + Math.ceil(contentToString(m.content).length / 4), 0);
  // Cap the reserved output so a huge client-set max_tokens doesn't falsely
  // exclude the whole model pool (#470); input is still counted in full. The
  // reserve is passed to the router separately: it is an exact count and must
  // not be inflated by the context-window safety margin (#956 review).
  const outputReserve = routingReserveTokens(max_tokens);
  const estimatedTotal = estimatedInputTokens + outputReserve;

  // Guardrail: per-request token budget (request_max_tokens_budget, default
  // off). max_tokens always has a value on this surface (default 128), so a
  // violation can only reject — no capping branch.
  const budgetCheck = applyTokenBudget(estimatedInputTokens, max_tokens);
  if (budgetCheck.rejection) {
    res.status(413).json({
      error: { message: tokenBudgetMessage(budgetCheck.rejection), type: 'invalid_request_error', code: 'request_token_budget' },
      execution_id: requestGroupId,
    });
    return;
  }

  let resolvedChain: ResolvedChain | undefined;
  if (isAutoModel(requestedModel)) {
    resolvedChain = resolveRoutingChain(requestedModel);
  }

  // Shared route resolution (routes/chat-route.ts): alias-tier / auto /
  // unified-group / single-row pin. The legacy surface passes no sticky
  // lookup, so its pins stay exactly as before. The 404/503 replies are
  // rendered here so both chat surfaces answer identically.
  const chatRoute = resolveChatRoute({
    requestedModel,
    aliasTierChain,
    resolvedChain,
  });
  if ('error' in chatRoute) {
    res.status(chatRoute.error.status).json({
      error: chatRoute.error.error,
      execution_id: requestGroupId,
    });
    return;
  }
  const { groupChain, preferredModel } = chatRoute.route;

  const pinnedModelId = requestedModel && !isAutoModel(requestedModel) ? requestedModel : null;
  const state = newFallbackState();
  state.estimatedTotalTokens = estimatedTotal;
  const attemptLog: AttemptRecord[] = [];
  // Client-disconnect fan-out: the flag stops the loop before the NEXT
  // attempt; the AbortController (threaded to the provider as
  // CompletionOptions.signal) additionally cancels the IN-FLIGHT upstream
  // fetch and any body/stream read, so tokens stop burning and the in-flight
  // lease frees immediately. 'close' also fires on normal completion —
  // writableEnded distinguishes a real disconnect.
  let clientGone = false;
  const clientAbort = new AbortController();
  // Fallback-v2 hedging: the loop aborts this controller (via abortInFlight)
  // when the wall-clock retry budget expires mid-attempt, canceling the
  // in-flight upstream instead of waiting for a stalled attempt to time out.
  const hedgeAbort = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) {
      clientGone = true;
      clientAbort.abort(newClientAbortError());
    }
  });

  // Legacy /completions is a thin adapter over the shared fallback loop
  // (lib/fallback-loop.ts): the cooldown/skip/penalty/exhaustion machinery is
  // shared; only the text_completion request/stream translation lives here.
  await runFallbackLoop({
    maxRetries: MAX_RETRIES,
    state,
    attemptLog,
    logIdentity: { surface: 'legacy completions', requestId: requestGroupId, requestedModel: requestedModelLabel },
    clientGone: () => clientGone,
    abortInFlight: () => hedgeAbort.abort(newHedgeAbortError()),
    route: () => {
      // #507: see inbound-chat.ts — inflate the routing estimate from any
      // provider-reported REQUESTED size latched onto state so the existing
      // size gates in router.ts skip low-TPM / small-context models on retry.
      const routingTotal = fallbackRoutingTokens(state, estimatedTotal, outputReserve);
      return routeRequest(
        routingTotal,
        state.skipKeys.size > 0 ? state.skipKeys : undefined,
        preferredModel,
        false,
        false,
        state.skipModels.size > 0 ? state.skipModels : undefined,
        groupChain ?? resolvedChain?.chain,
        false,
        state.skipPlatforms.size > 0 ? state.skipPlatforms : undefined,
        outputReserve,
        undefined,
        resolvedChain?.strategyOverride,
      );
    },
    dispatch: async (route, attempt, ctx) => {
      const contextBudget = routeOutputBudget(route, estimatedInputTokens);
      traceRouteEvent('Proxy', {
        event: attempt === 0 ? 'start' : 'next',
        requestId: requestGroupId,
        attempt,
        platform: route.platform,
        model: route.modelId,
        requestedModel: attempt === 0 ? requestedModelLabel : undefined,
      });

      if (stream) {
        let totalOutputTokens = 0;
        let headerSent = false;
        let ttfbMs: number | null = null;
        let sawText = false;
        let upstreamFinish: string | null = null;
        const buffered: unknown[] = [];
        // True once this attempt is over (success, committed error, or thrown)
        // — the keep-alive interval polls it and stops itself.
        let streamSettled = false;

        // Send the SSE headers once. Split out of flushHeaders so the
        // #1642 keep-alive can commit the response with a content-free ping
        // while the hold window is still open, without dumping the buffered
        // (possibly reasoning-bearing) frames early.
        let headersSentEarly = false;
        const sendSseHeaders = () => {
          if (headersSentEarly) return;
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('X-Routed-Via', routedViaValue(route.platform, route.modelId));
          setFallbackHeaders(res, attempt, attemptLog);
          headersSentEarly = true;
        };

        const flushHeaders = () => {
          if (headerSent) return;
          // #764: ttfb is recorded on the first token of ANY kind (content or
          // reasoning) in the pump loop below; this call only backfills streams
          // that reached the commit point without one.
          if (ttfbMs === null) ttfbMs = Date.now() - start;
          sendSseHeaders();
          headerSent = true;
          // Committed: the answer is on its way, so the retry budget must no
          // longer cancel this attempt (it could not fail over now anyway).
          ctx.disarmHedge();
          for (const frame of buffered) res.write(`data: ${JSON.stringify(frame)}\n\n`);
          buffered.length = 0;
        };

        // #1642: optional heartbeat for the silent reasoning window. A bare
        // SSE comment resets client idle watchdogs without committing content.
        // Gated on the first token (ttfbMs): a hop that has produced nothing
        // yet may be dead, and pinging it would commit the response and lose
        // invisible failover — so ticks wait until the hop proves itself alive.
        const keepaliveStop = startStreamKeepalive(streamKeepaliveMs(),
          () => streamSettled,
          () => {
            sendSseHeaders();
            // Bytes on the wire = the response can no longer fail over
            // invisibly; stop the retry budget from cancelling it.
            ctx.disarmHedge();
            res.write(': keepalive\n\n');
          },
          () => ttfbMs !== null);

        try {
          const gen = route.provider.streamChatCompletion(
            route.apiKey,
            messages,
            route.modelId,
            { temperature, max_tokens, top_p, stop, contextBudget, signal: AbortSignal.any([clientAbort.signal, hedgeAbort.signal]) },
            quotaContextForRoute(route, 'chat/completions'),
          );

          for await (const chunk of gen) {
            if (clientGone) break; // client hung up: stop pulling; reader.cancel() aborts upstream
            const text = streamChunkText(chunk);
            if (text.length > 0) sawText = true;
            // #764: reasoning models stream thinking before any visible text.
            // ttfb must count the first token of ANY kind — otherwise the speed
            // shown is the thinking tail, or NULL when headers never flush.
            const reasoning = streamReasoningText(chunk);
            if (ttfbMs === null && (text.length > 0 || reasoning.length > 0)) {
              ttfbMs = Date.now() - start;
            }
            const finish = (chunk as any)?.choices?.[0]?.finish_reason;
            if (finish) upstreamFinish = finish;
            // #764: reasoning tokens are real output consumption — count them
            // so analytics and the rate-limit ledger aren't undercounted.
            totalOutputTokens += Math.ceil((text.length + reasoning.length) / 4);
            const frame = legacyCompletionChunk(route, chunk, text);
            // Commit point: hold headers until the first real text, so a stream
            // that dies before producing any fails over invisibly.
            if (!headerSent && !sawText) {
              buffered.push(frame);
              continue;
            }
            flushHeaders();
            res.write(`data: ${JSON.stringify(frame)}\n\n`);
          }

          // Disconnect before the commit point: the break above fired with no
          // text seen, which is indistinguishable from an empty completion
          // below — but it is CLIENT behavior, not a provider failure. Without
          // this check every Ctrl-C during a reasoning model's TTFB window
          // benched the healthy model+key for 90s and logged a provider error.
          if (clientGone && !headerSent && !sawText) {
            if (headersSentEarly) noteRequestTokens(estimatedInputTokens + totalOutputTokens);
            console.log(`[Proxy] client disconnected before first token from ${route.displayName} — dropping attempt without benching`);
            return 'committed';
          }

          if (!sawText) {
            // finish_reason 'length' means the model spent the whole output
            // budget before any visible text (hidden reasoning) — fail over,
            // but skip the cooldown/penalty: not a provider-health signal.
            throw Object.assign(
              new Error(`empty completion from ${route.displayName} (legacy stream produced no text)`),
              upstreamFinish === 'length' ? { skipBench: true } : {},
            );
          }

          flushHeaders();
          res.write('data: [DONE]\n\n');
          res.end();

          recordUpstreamSuccess(route, estimatedInputTokens + totalOutputTokens);
          traceRouteEvent('Proxy', {
            event: 'ok',
            requestId: requestGroupId,
            attempt,
            platform: route.platform,
            model: route.modelId,
            latencyMs: Date.now() - start,
            inputTokens: estimatedInputTokens,
            outputTokens: totalOutputTokens,
          });
          logRequest(route.platform, route.modelId, route.keyId, 'success', estimatedInputTokens, totalOutputTokens, Date.now() - start, null, ttfbMs, pinnedModelId, null, 'http');
          return 'done';
        } catch (streamErr: any) {
          if (isClientAbortError(streamErr)) {
            if (headerSent || headersSentEarly) {
              noteRequestTokens(estimatedInputTokens + totalOutputTokens);
            }
            throw streamErr;
          }
          // headerSent = real content went out. headersSentEarly also counts:
          // a #1642 keep-alive ping flushed the SSE headers, so the response
          // is on the wire and this attempt can no longer fail over invisibly.
          if (headerSent || headersSentEarly) {
            console.error(`[Proxy] Mid-stream legacy completion error from ${route.displayName}:`, streamErr.message);
            const payload = { error: { message: `Provider error (${route.displayName}): stream interrupted`, type: 'stream_error' } };
            try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch { /* socket gone */ }
            try { res.write('data: [DONE]\n\n'); res.end(); } catch { /* socket gone */ }
            traceRouteEvent('Proxy', {
              event: 'fail',
              requestId: requestGroupId,
              attempt,
              platform: route.platform,
              model: route.modelId,
              latencyMs: Date.now() - start,
              error: sanitizeProviderErrorMessage(streamErr.message),
            });
            logRequest(route.platform, route.modelId, route.keyId, 'error', estimatedInputTokens, totalOutputTokens, Date.now() - start, sanitizeProviderErrorMessage(streamErr.message), ttfbMs, pinnedModelId, null, 'http', failureAttributionFor(streamErr));
            return 'committed';
          }
          throw streamErr;
        } finally {
          // #1642: this attempt is over whichever path it left by — the
          // keep-alive interval must not outlive it.
          streamSettled = true;
          keepaliveStop();
        }
      }

      const result = await route.provider.chatCompletion(
        route.apiKey,
        messages,
        route.modelId,
        { temperature, max_tokens, top_p, stop, contextBudget, signal: AbortSignal.any([clientAbort.signal, hedgeAbort.signal]) },
        quotaContextForRoute(route, 'chat/completions'),
      );

      const text = completionTextFromChat(result);
      if (!text) {
        // finish_reason 'length' = output budget consumed by hidden reasoning
        // before any visible text: fail over without a cooldown/penalty.
        throw Object.assign(
          new Error(`empty completion from ${route.displayName}`),
          result.choices?.[0]?.finish_reason === 'length' ? { skipBench: true } : {},
        );
      }
      // #809: a bare "safe"/"unsafe" classification word from a relay is an
      // upstream filter, not the requested model — fail over like an empty
      // completion.
      if (isUpstreamClassificationOutput(text, route.platform)) {
        throw Object.assign(
          new Error(`empty completion from ${route.displayName} (upstream classification output)`),
          result.choices?.[0]?.finish_reason === 'length' ? { skipBench: true } : {},
        );
      }

      // Usage fallback: providers that omit `usage` used to be logged as 0
      // tokens, silently undercounting analytics and the rate-limit ledger.
      // Fall back to the same chars/4 estimate the streaming path uses,
      // including reasoning tokens (thinking models). (#764)
      const promptTokens = result.usage?.prompt_tokens ?? estimatedInputTokens;
      const completionTokens = result.usage?.completion_tokens
        ?? Math.ceil((text.length + completionReasoningText(result).length) / 4);
      const totalTokens = result.usage?.total_tokens ?? (promptTokens + completionTokens);
      recordUpstreamSuccess(route, totalTokens);

      res.setHeader('X-Routed-Via', routedViaValue(route.platform, route.modelId));
      setFallbackHeaders(res, attempt, attemptLog);
      res.json({
        id: completionIdFromChat(result.id),
        object: 'text_completion',
        created: result.created ?? Math.floor(Date.now() / 1000),
        model: route.modelId,
        choices: [{
          text,
          index: result.choices?.[0]?.index ?? 0,
          logprobs: null,
          finish_reason: result.choices?.[0]?.finish_reason ?? 'stop',
        }],
        // `usage` is required by the OpenAI completions spec. The fallback
        // counts computed just above (chars/4 when the provider omits usage,
        // #764) existed but were dropped here — clients like editor
        // ghost-text plugins read usage to throttle and saw `undefined`.
        usage: result.usage ?? {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: totalTokens,
          estimated: true,
        },
        execution_id: requestGroupId,
      });

      traceRouteEvent('Proxy', {
        event: 'ok',
        requestId: requestGroupId,
        attempt,
        platform: route.platform,
        model: route.modelId,
        latencyMs: Date.now() - start,
        inputTokens: promptTokens,
        outputTokens: completionTokens,
      });
      logRequest(route.platform, route.modelId, route.keyId, 'success', promptTokens, completionTokens, Date.now() - start, null, null, pinnedModelId, null, 'http');
      return 'done';
    },
    logFailure: (route, err, attempt) => {
      const latency = Date.now() - start;
      const safeError = sanitizeProviderErrorMessage(err.message);
      traceRouteEvent('Proxy', {
        event: 'fail',
        requestId: requestGroupId,
        attempt,
        platform: route.platform,
        model: route.modelId,
        latencyMs: latency,
        error: safeError,
      });
      logRequest(route.platform, route.modelId, route.keyId, 'error', estimatedInputTokens, 0, latency, safeError, null, pinnedModelId, null, 'http', failureAttributionFor(err));
    },
    onFatal: (route, err, attempt) => {
      setFallbackHeaders(res, attempt, attemptLog);
      res.status(502).json({
        error: {
          message: `Provider error (${route.displayName}): ${sanitizeProviderErrorMessage(err.message)}`,
          type: 'provider_error',
        },
        execution_id: requestGroupId,
      });
    },
    onRoutingExhausted: (lastError, routeErr, exhaustion, info) => {
      setFallbackHeaders(res, info.attempts.length, info.attempts);
      setExhaustionHeaders(res, exhaustion);
      res.status(exhaustion.status).json({ error: exhaustionErrorPayload(exhaustion), execution_id: requestGroupId });
    },
    onExhausted: (exhaustion, info) => {
      setFallbackHeaders(res, info.attempts.length, info.attempts);
      setExhaustionHeaders(res, exhaustion);
      res.status(exhaustion.status).json({ error: exhaustionErrorPayload(exhaustion), execution_id: requestGroupId });
    },
  });
}


export const completionsRouter = Router();
completionsRouter.post('/completions', handleLegacyCompletions);
