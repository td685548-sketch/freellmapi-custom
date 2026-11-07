import { Router } from 'express';
import type { Request, Response } from 'express';
import type { ChatMessage } from '@freellmapi/shared/types.js';
import type { CompletionOptions } from '../../providers/base.js';
import { decrypt } from '../../lib/crypto.js';
import { estimateInputTokens } from '../../lib/content.js';
import { withKeyProxy } from '../../lib/proxy.js';
import { logRequest } from '../../lib/request-log.js';
import { applyOutputSavers } from '../output-savers/apply.js';
import { buildSaverBlock } from '../output-savers/prompts.js';
import {
  getXGatewayProvider,
  normalizeXGatewayProviderId,
  resolveXGatewayProvider,
} from '../provider-accounts/catalog.js';
import {
  accountModels,
  getUsableXGatewayKeys,
  recordXGatewayKeyUsage,
  resolveXGatewayAccountProxy,
  type AccountRow,
} from '../provider-accounts/store.js';
import { xGatewayAuth } from './auth.js';
import { getConfigSnapshot } from './config.js';
import { runInGatewayScope } from './context.js';
import { xGatewayProtocolsRouter } from './protocols.js';

export const xGatewayRouter = Router();

export interface CandidateRoute {
  account: AccountRow & { requests: number; tokens: number };
  modelId: string;
}

function isWithinAccountCaps(account: AccountRow & { requests: number; tokens: number }): boolean {
  if (account.monthly_request_cap > 0 && account.requests >= account.monthly_request_cap) return false;
  if (account.monthly_token_cap > 0 && account.tokens >= account.monthly_token_cap) return false;
  return true;
}

export function resolveCandidateRoutes(requestedModel: string | undefined): {
  candidates: CandidateRoute[];
  notFoundError?: string;
} {
  const usable = getUsableXGatewayKeys().filter(isWithinAccountCaps);
  const rawModel = (requestedModel ?? 'auto').trim() || 'auto';
  const lower = rawModel.toLowerCase();

  if (lower === 'auto' || lower.startsWith('auto:')) {
    const candidates: CandidateRoute[] = [];
    for (const account of usable) {
      const models = accountModels(account);
      const modelId = models[0]?.id ?? 'default';
      candidates.push({ account, modelId });
    }
    return { candidates };
  }

  if (lower.startsWith('combo:')) {
    const comboName = rawModel.slice(6).trim().toLowerCase();
    const combo = getConfigSnapshot().combos.find(c => c.name.toLowerCase() === comboName);
    if (!combo) {
      return { candidates: [], notFoundError: `Combo '${rawModel}' not found` };
    }
    const candidates: CandidateRoute[] = [];
    for (const step of combo.entries) {
      const targetProvider = normalizeXGatewayProviderId(step.platform) ?? step.platform.toLowerCase();
      for (const account of usable) {
        if (account.provider === targetProvider) {
          candidates.push({ account, modelId: step.modelId });
        }
      }
    }
    return { candidates };
  }

  const slashIdx = rawModel.indexOf('/');
  if (slashIdx > 0) {
    const prefix = rawModel.slice(0, slashIdx);
    const suffix = rawModel.slice(slashIdx + 1);
    const matchedProvider = normalizeXGatewayProviderId(prefix);
    if (matchedProvider && suffix) {
      const providerAccounts = usable.filter(a => a.provider === matchedProvider);
      if (providerAccounts.length > 0) {
        return {
          candidates: providerAccounts.map(account => ({ account, modelId: suffix })),
        };
      }
    }
  }

  const exactMatches: CandidateRoute[] = [];
  for (const account of usable) {
    const models = accountModels(account);
    if (models.some(m => m.id === rawModel)) {
      exactMatches.push({ account, modelId: rawModel });
    }
  }
  if (exactMatches.length > 0) {
    return { candidates: exactMatches };
  }

  return {
    candidates: usable.map(account => ({ account, modelId: rawModel })),
  };
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
xGatewayRouter.post('/chat/completions', xGatewayAuth, async (req: Request, res: Response) => {
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

  await runInGatewayScope(scope, async () => {
    const { candidates, notFoundError } = resolveCandidateRoutes(requestedModel);
    if (notFoundError) {
      res.status(404).json({
        error: { message: notFoundError, type: 'invalid_request_error', code: 'model_not_found' },
      });
      return;
    }
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

    for (const { account, modelId } of candidates) {
      const provider = resolveXGatewayProvider(account.provider, account.base_url);
      if (!provider) continue;

      let credential: string;
      try {
        credential = decrypt(account.encrypted_key, account.iv, account.auth_tag);
      } catch (err) {
        lastError = err;
        continue;
      }

      const effectiveProxy = resolveXGatewayAccountProxy(account);

      if (!isStream) {
        try {
          const completion = await withKeyProxy(effectiveProxy, () =>
            provider.chatCompletion(
              credential,
              messages,
              modelId,
              options,
              { platform: account.platform, keyId: account.id, modelId },
            ),
          );
          const latencyMs = Date.now() - startMs;
          const promptTokens = completion.usage?.prompt_tokens ?? estimatedPromptTokens;
          const completionTokens = completion.usage?.completion_tokens ?? 0;

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
          res.status(200).json(completion);
          return;
        } catch (err) {
          lastError = err;
          continue;
        }
      } else {
        try {
          await withKeyProxy(effectiveProxy, async () => {
            const stream = provider.streamChatCompletion(
              credential,
              messages,
              modelId,
              options,
              { platform: account.platform, keyId: account.id, modelId },
            );
            const iterator = stream[Symbol.asyncIterator]();
            const first = await iterator.next();

            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Routed-Via', `${account.provider}/${modelId}`);

            const ttfbMs = Date.now() - startMs;
            let promptTokens = estimatedPromptTokens;
            let completionTokens = 0;

            if (!first.done && first.value) {
              if (first.value.usage?.prompt_tokens) promptTokens = first.value.usage.prompt_tokens;
              if (first.value.usage?.completion_tokens) completionTokens = first.value.usage.completion_tokens;
              res.write(`data: ${JSON.stringify(first.value)}\n\n`);
            }

            while (true) {
              const next = await iterator.next();
              if (next.done) break;
              if (next.value.usage?.prompt_tokens) promptTokens = next.value.usage.prompt_tokens;
              if (next.value.usage?.completion_tokens) completionTokens = next.value.usage.completion_tokens;
              res.write(`data: ${JSON.stringify(next.value)}\n\n`);
            }

            res.write('data: [DONE]\n\n');
            res.end();

            const latencyMs = Date.now() - startMs;
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
          if (res.headersSent) {
            res.end();
            return;
          }
          lastError = err;
          continue;
        }
      }
    }

    const message = lastError instanceof Error ? lastError.message : 'All X Gateway provider accounts failed.';
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
});

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
