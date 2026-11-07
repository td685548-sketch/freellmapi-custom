import { Router, type Request, type Response, type NextFunction } from 'express';
import type { ChatMessage } from '@freellmapi/shared/types.js';
import type { CompletionOptions } from '../../providers/base.js';
import { decrypt } from '../../lib/crypto.js';
import { estimateInputTokens } from '../../lib/content.js';
import { withQuotaTracking } from './quota/tracking.js';
import { logRequest } from '../../lib/request-log.js';
import { sanitizeProviderErrorMessage } from '../../lib/error-redaction.js';
import { permissionGranted } from '@freellmapi/shared/permissions.js';
import { validateUserApiKey } from '../../services/user-keys.js';
import {
  resolveXGatewayProvider,
} from '../provider-accounts/catalog.js';
import {
  accountModels,
  getUsableXGatewayKeys,
  recordXGatewayKeyUsage,
  resolveXGatewayAccountProxy,
} from '../provider-accounts/store.js';
import { getConfigSnapshot } from './config.js';
import { runInGatewayScope } from './context.js';
import {
  resolveCandidateRoutes,
  applyGatewaySavers,
} from './router.js';
import {
  validateXGatewayClientKey,
  isModelAllowedForKey,
  type ValidatedXGatewayClientKey,
} from './client-keys.js';
import { augmentCandidatesWithCapacityAdapter } from './capacity-adapter.js';

export const geminiRouter = Router();

// CORS preflight and headers for all /v1beta paths
geminiRouter.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

function extractGeminiApiKey(req: Request): string | undefined {
  const headerKey = req.headers['x-goog-api-key'];
  if (typeof headerKey === 'string' && headerKey.trim()) return headerKey.trim();
  const queryKey = req.query['key'];
  if (typeof queryKey === 'string' && queryKey.trim()) return queryKey.trim();
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return undefined;
}

function parseGeminiRequest(body: Record<string, unknown>, model: string, isStream: boolean) {
  const messages: ChatMessage[] = [];

  // 1. System instruction
  if (body.systemInstruction && typeof body.systemInstruction === 'object') {
    const si = body.systemInstruction as { parts?: Array<{ text?: string }> };
    if (Array.isArray(si.parts)) {
      const systemText = si.parts.map(p => p.text || '').join('\n').trim();
      if (systemText) {
        messages.push({ role: 'system', content: systemText });
      }
    }
  }

  // 2. Contents array
  if (Array.isArray(body.contents)) {
    for (const item of body.contents) {
      if (!item || typeof item !== 'object') continue;
      const c = item as { role?: string; parts?: Array<{ text?: string; inlineData?: { mimeType?: string; data?: string } }> };
      const role: 'user' | 'assistant' = c.role === 'model' ? 'assistant' : 'user';

      if (Array.isArray(c.parts)) {
        const parts: any[] = [];
        for (const part of c.parts) {
          if (part.text) {
            parts.push({ type: 'text', text: part.text });
          } else if (part.inlineData?.data && part.inlineData?.mimeType) {
            parts.push({
              type: 'image_url',
              image_url: {
                url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`,
              },
            });
          }
        }
        if (parts.length === 1 && parts[0].type === 'text') {
          messages.push({ role, content: parts[0].text });
        } else if (parts.length > 0) {
          messages.push({ role, content: parts });
        }
      }
    }
  }

  const genConfig = (body.generationConfig && typeof body.generationConfig === 'object')
    ? body.generationConfig as Record<string, unknown>
    : {};

  return {
    model,
    messages,
    isStream,
    temperature: typeof genConfig.temperature === 'number' ? genConfig.temperature : undefined,
    max_tokens: typeof genConfig.maxOutputTokens === 'number' ? genConfig.maxOutputTokens : undefined,
    top_p: typeof genConfig.topP === 'number' ? genConfig.topP : undefined,
    stop: Array.isArray(genConfig.stopSequences) ? (genConfig.stopSequences as string[]) : undefined,
  };
}

/**
 * GET /v1beta/models
 * Returns model catalog in Google Gemini API format
 */
geminiRouter.get('/models', (req: Request, res: Response, next: NextFunction) => {
  const token = extractGeminiApiKey(req);
  if (!token) return next();
  const user = validateXGatewayClientKey(token) ?? validateUserApiKey(token);
  if (!user || !permissionGranted(user, 'use_x_gateway')) {
    return next();
  }

  const keys = getUsableXGatewayKeys();
  const modelSet = new Set<string>();
  for (const k of keys) {
    for (const m of accountModels(k)) {
      modelSet.add(m.id);
    }
  }

  const models = Array.from(modelSet).map(id => ({
    name: `models/${id}`,
    version: '1.0',
    displayName: id,
    description: `X Gateway routed model ${id}`,
    supportedGenerationMethods: ['generateContent', 'streamGenerateContent', 'countTokens'],
  }));

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({ models });
});

/**
 * POST /v1beta/models/:path*
 * Handles :generateContent and :streamGenerateContent
 */
geminiRouter.post(/^\/models\/(.+)$/, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const token = extractGeminiApiKey(req);
  if (!token) return next();
  const user: ValidatedXGatewayClientKey | null =
    validateXGatewayClientKey(token) ?? (validateUserApiKey(token) as ValidatedXGatewayClientKey | null);

  if (!user || !permissionGranted(user, 'use_x_gateway')) {
    return next();
  }

  const rawPath = String((req.params as Record<string, any>)[0] || (req.params as Record<string, any>).modelPath || '');
  const isStream = rawPath.includes(':streamGenerateContent');
  const modelClean = rawPath
    .replace(':streamGenerateContent', '')
    .replace(':generateContent', '')
    .replace(/^models\//, '')
    .trim();

  const requestedModel = modelClean || 'gemini-2.0-flash';

  // Per-key access control
  if (user.access?.restricted && !isModelAllowedForKey(user.access, requestedModel)) {
    res.status(403).json({
      error: {
        message: `Model or combo '${requestedModel}' is not allowed for this API key.`,
        code: 403,
        status: 'PERMISSION_DENIED',
      },
    });
    return;
  }

  const body = (req.body && typeof req.body === 'object') ? req.body as Record<string, unknown> : {};
  const parsed = parseGeminiRequest(body, requestedModel, isStream);
  const { messages, appliedSavers } = applyGatewaySavers(req, parsed.messages);

  if (messages.length === 0) {
    res.status(400).json({ error: { message: 'contents must be provided', code: 400, status: 'INVALID_ARGUMENT' } });
    return;
  }

  const scope = {
    gateway: 'x' as const,
    outputSavers: appliedSavers,
    inputSaver: getConfigSnapshot().savers.input,
    inputTokensSaved: 0,
  };

  const controller = new AbortController();
  const onClose = () => { if (!res.writableEnded) controller.abort(); };
  res.once('close', onClose);

  try {
    await runInGatewayScope(scope, async () => {
      const { candidates: rawCandidates, notFoundError } = resolveCandidateRoutes(requestedModel);
      if (notFoundError) {
        res.status(404).json({ error: { message: notFoundError, code: 404, status: 'NOT_FOUND' } });
        return;
      }

      const candidates = augmentCandidatesWithCapacityAdapter(rawCandidates, messages);
      if (candidates.length === 0) {
        res.status(503).json({
          error: { message: 'No enabled X Gateway provider accounts available.', code: 503, status: 'UNAVAILABLE' },
        });
        return;
      }

      const options: CompletionOptions = {
        signal: controller.signal,
        temperature: parsed.temperature,
        max_tokens: parsed.max_tokens,
        top_p: parsed.top_p,
        stop: parsed.stop,
      };

      const estimatedPromptTokens = estimateInputTokens(messages);
      let lastError: unknown = null;

      for (const { account, modelId } of candidates) {
        if (controller.signal.aborted) return;
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
            const completion = await withQuotaTracking(account, modelId, effectiveProxy, () =>
              provider.chatCompletion(credential, messages, modelId, options)
            );

            recordXGatewayKeyUsage(account.id, completion.usage?.total_tokens ?? 0);
            logRequest(
              account.provider,
              modelId,
              null,
              'success',
              completion.usage?.prompt_tokens ?? estimatedPromptTokens,
              completion.usage?.completion_tokens ?? 0,
              0,
              null,
              0,
              requestedModel === 'auto' ? null : requestedModel,
              null,
              'x-gateway',
            );

            const responseText = completion.choices?.[0]?.message?.content ?? (completion as any).text ?? '';
            res.json({
              candidates: [
                {
                  content: {
                    role: 'model',
                    parts: [{ text: responseText }],
                  },
                  finishReason: 'STOP',
                  index: 0,
                },
              ],
              usageMetadata: {
                promptTokenCount: completion.usage?.prompt_tokens ?? estimatedPromptTokens,
                candidatesTokenCount: completion.usage?.completion_tokens ?? 0,
                totalTokenCount: completion.usage?.total_tokens ?? estimatedPromptTokens,
              },
              modelVersion: modelId,
            });
            return;
          } catch (err) {
            lastError = err;
            continue;
          }
        } else {
          // Streaming
          try {
            const stream = await withQuotaTracking(account, modelId, effectiveProxy, () =>
              provider.streamChatCompletion(credential, messages, modelId, options)
            );

            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache, no-transform');
            res.setHeader('Connection', 'keep-alive');
            res.flushHeaders?.();

            let outTokens = 0;
            for await (const chunk of stream) {
              if (controller.signal.aborted) break;
              const textDelta = chunk.choices?.[0]?.delta?.content ?? (chunk as any).delta ?? '';
              if (textDelta) {
                outTokens += 1;
                const sseData = JSON.stringify({
                  candidates: [
                    {
                      content: {
                        role: 'model',
                        parts: [{ text: textDelta }],
                      },
                      index: 0,
                    },
                  ],
                });
                res.write(`data: ${sseData}\r\n\r\n`);
              }
            }

            // Final chunk with finishReason and usageMetadata
            const finalChunk = JSON.stringify({
              candidates: [
                {
                  content: {
                    role: 'model',
                    parts: [{ text: '' }],
                  },
                  finishReason: 'STOP',
                  index: 0,
                },
              ],
              usageMetadata: {
                promptTokenCount: estimatedPromptTokens,
                candidatesTokenCount: outTokens,
                totalTokenCount: estimatedPromptTokens + outTokens,
              },
              modelVersion: modelId,
            });
            res.write(`data: ${finalChunk}\r\n\r\n`);
            res.end();

            recordXGatewayKeyUsage(account.id, estimatedPromptTokens + outTokens);
            logRequest(
              account.provider,
              modelId,
              null,
              'success',
              estimatedPromptTokens,
              outTokens,
              0,
              null,
              0,
              requestedModel === 'auto' ? null : requestedModel,
              null,
              'x-gateway',
            );
            return;
          } catch (err) {
            lastError = err;
            if (res.headersSent) {
              res.end();
              return;
            }
            continue;
          }
        }
      }

      const msg = lastError ? sanitizeProviderErrorMessage(lastError) : 'All provider accounts failed.';
      res.status(502).json({ error: { message: msg, code: 502, status: 'BAD_GATEWAY' } });
    });
  } finally {
    res.removeListener('close', onClose);
  }
});

