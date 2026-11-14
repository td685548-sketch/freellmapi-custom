import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { decrypt } from '../../lib/crypto.js';
import { proxyFetch } from '../../lib/proxy.js';
import { logRequest } from '../../lib/request-log.js';
import { X_GATEWAY_PROVIDERS } from '../provider-accounts/catalog.js';
import {
  accountModels,
  getUsableXGatewayKeys,
  recordXGatewayKeyUsage,
  resolveXGatewayAccountProxy,
} from '../provider-accounts/store.js';
import { chatGptWebImageErrorStatus } from '../provider-accounts/chatgpt-web-image.js';
import { executeImageGeneration, isUnsupportedWebImageProvider, parseUpstreamJson } from './image-generation.js';
import {
  getMediaDefaults,
  setMediaDefaults,
  type XGatewayMediaDefaults,
} from './config.js';
import { accountBaseUrl, handleVideoRequest, handleAudioVoices } from './protocols.js';
import { withQuotaTracking } from './quota/tracking.js';
import { resolveCandidateRoutes } from './router.js';
import {
  getDefaultPricing,
  getMergedPricing,
  getPricingOverrides,
  resetPricingOverrides,
  updatePricingOverrides,
  validatePricingPatch,
} from './pricing.js';

export const xGatewayMediaRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
});

export type MediaProviderKind = 'image' | 'tts' | 'stt' | 'embedding' | 'web' | 'video';

const mediaConfigSchema = z.object({
  video: z.object({ defaultModel: z.string().trim().max(200).optional(), aspectRatio: z.enum(['16:9', '9:16', '1:1']).optional() }).optional(),
  image: z.object({ defaultModel: z.string().trim().max(100).optional() }).optional(),
  tts: z.object({
    defaultModel: z.string().trim().max(100).optional(),
    defaultVoice: z.string().trim().max(50).optional(),
    defaultFormat: z.string().trim().max(20).optional(),
  }).optional(),
  stt: z.object({
    defaultModel: z.string().trim().max(100).optional(),
    defaultLanguage: z.string().trim().max(20).optional(),
  }).optional(),
  embedding: z.object({
    defaultModel: z.string().trim().max(100).optional(),
    defaultDimensions: z.number().int().min(1).max(32_768).nullable().optional(),
  }).optional(),
  web: z.object({
    defaultModel: z.string().trim().max(100).optional(),
  }).optional(),
}).strict();

const imageTestSchema = z.object({
  model: z.string().trim().max(200).optional(),
  prompt: z.string().trim().min(1).max(4000),
  size: z.enum(['256x256', '512x512', '1024x1024', '1792x1024', '1024x1792']).optional(),
  n: z.number().int().min(1).max(4).optional(),
}).strict();

const ttsTestSchema = z.object({
  model: z.string().trim().max(200).optional(),
  input: z.string().trim().min(1).max(4096),
  voice: z.string().trim().max(50).optional(),
  speed: z.number().min(0.25).max(4.0).optional(),
  response_format: z.enum(['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm']).optional(),
}).strict();

const embeddingTestSchema = z.object({
  model: z.string().trim().max(200).optional(),
  input: z.string().trim().min(1).max(50_000),
  dimensions: z.number().int().min(1).max(32_768).optional(),
}).strict();

const webTestSchema = z.object({
  model: z.string().trim().max(200).optional(),
  query: z.string().trim().min(1).max(4000),
  fetchUrl: z.string().trim().url().optional(),
}).strict();

const KNOWN_KINDS: Record<MediaProviderKind, {
  label: string;
  endpoint: string;
  defaultProviders: string[];
  matcher: RegExp;
  suggestedModels: string[];
}> = {
  video: {
    label: 'Text to Video',
    endpoint: '/thruline/v1/videos/generations',
    defaultProviders: ['xai', 'openai', 'gemini', 'replicate', 'fal-ai', 'together', 'siliconflow', 'minimax', 'kling', 'luma'],
    matcher: /video|veo|sora|kling|wan[\d.-]|luma|hunyuan|seedance/i,
    suggestedModels: ['xai/grok-imagine-video', 'openai/sora-2', 'gemini/veo-3.0-generate-preview'],
  },
  image: {
    label: 'Text to Image',
    endpoint: '/thruline/v1/images/generations',
    defaultProviders: ['openai', 'azure-openai', 'gemini', 'cloudflare-ai', 'together', 'replicate', 'black-forest-labs', 'deepinfra', 'siliconflow', 'venice', 'fal-ai', 'sdwebui', 'comfyui'],
    matcher: /image|dall-e|flux|sdxl|diffusion|imagen/i,
    suggestedModels: ['dall-e-3', 'dall-e-2', 'imagen-3.0-generate-002', 'gemini-3.1-flash-image-preview', 'black-forest-labs/FLUX.1-schnell', 'stabilityai/stable-diffusion-xl-base-1.0'],
  },
  tts: {
    label: 'Text to Speech',
    endpoint: '/thruline/v1/audio/speech',
    defaultProviders: ['openai', 'azure-openai', 'gemini', 'edge-tts', 'elevenlabs', 'fish-audio', 'coqui', 'cartesia', 'minimax', 'minimax-cn', 'deepgram', 'aws-polly'],
    matcher: /tts|speech|voice/i,
    suggestedModels: ['tts-1', 'tts-1-hd', 'gemini-3.1-flash-tts-preview', 'edge-tts', 'eleven_multilingual_v2', 'speech-01-hd'],
  },
  stt: {
    label: 'Speech to Text',
    endpoint: '/thruline/v1/audio/transcriptions',
    defaultProviders: ['openai', 'azure-openai', 'groq', 'assemblyai', 'deepgram', 'gemini', 'cloudflare-ai', 'deepinfra', 'huggingface'],
    matcher: /whisper|stt|transcription/i,
    suggestedModels: ['whisper-1', 'whisper-large-v3', 'whisper-large-v3-turbo', 'distil-whisper-large-v3-en', 'universal-3-pro'],
  },
  embedding: {
    label: 'Embedding',
    endpoint: '/thruline/v1/embeddings',
    defaultProviders: ['openai', 'azure-openai', 'gemini', 'mistral', 'cohere', 'voyage', 'together', 'jina', 'deepinfra', 'siliconflow', 'nebius', 'fireworks', 'nvidia'],
    matcher: /embed/i,
    suggestedModels: ['text-embedding-3-small', 'text-embedding-3-large', 'gemini-embedding-001', 'text-embedding-004', 'mistral-embed', 'BAAI/bge-m3'],
  },
  web: {
    label: 'Web Search & Fetch',
    endpoint: '/thruline/v1/chat/completions',
    defaultProviders: ['perplexity', 'tavily', 'exa', 'brave', 'jina', 'firecrawl', 'google', 'openai', 'groq'],
    matcher: /web|search|crawl|reader|fetch|sonar|perplexity|tavily|exa|brave|jina|firecrawl/i,
    suggestedModels: ['sonar-pro', 'sonar', 'tavily-search', 'exa-search', 'jina-reader', 'gpt-4o-search-preview'],
  },
};

function getProvidersForKind(kindKey: MediaProviderKind) {
  const spec = KNOWN_KINDS[kindKey];
  const defaults = new Set(spec.defaultProviders);
  const matched = new Set<string>(kindKey === 'video' ? spec.defaultProviders : []);

  for (const p of X_GATEWAY_PROVIDERS) {
    if (defaults.has(p.id) || defaults.has(p.alias || '')) {
      matched.add(p.id);
      continue;
    }
    const hasMediaModel = (p.models || []).some(m => spec.matcher.test(m.id) || spec.matcher.test(m.name));
    if (hasMediaModel) matched.add(p.id);
  }

  const usableAccounts = getUsableXGatewayKeys();
  const connectedProviders = new Set<string>();
  const accountsByProvider: Record<string, number> = {};
  for (const acc of usableAccounts) {
    connectedProviders.add(acc.provider);
    accountsByProvider[acc.provider] = (accountsByProvider[acc.provider] || 0) + 1;
    const hasKindModel = accountModels(acc).some(m => spec.matcher.test(m.id) || spec.matcher.test(m.name));
    if (hasKindModel) matched.add(acc.provider);
  }

  return Array.from(matched).map(id => {
    const catalog = X_GATEWAY_PROVIDERS.find(p => p.id === id);
    return {
      id,
      name: catalog?.name || id,
      alias: catalog?.alias || id,
      category: catalog?.category,
      connectedAccounts: accountsByProvider[id] || 0,
      isConnected: connectedProviders.has(id),
      models: (catalog?.models || []).map(m => ({ id: m.id, name: m.name })),
    };
  }).sort((a, b) => (b.connectedAccounts - a.connectedAccounts) || a.name.localeCompare(b.name));
}

function getExtendedMediaDefaults(): XGatewayMediaDefaults & { web?: { defaultModel?: string }; video?: { defaultModel?: string; aspectRatio?: string } } {
  const baseDefaults = getMediaDefaults();
  try {
    const db = getDb();
    const mediaRow = db.prepare("SELECT value FROM x_gateway_config WHERE key = 'media_defaults'").get() as { value: string } | undefined;
    if (mediaRow?.value) {
      const parsed = JSON.parse(mediaRow.value);
      if (parsed.web || parsed.video) {
        return {
          ...baseDefaults,
          video: { defaultModel: typeof parsed.video?.defaultModel === 'string' ? parsed.video.defaultModel : 'auto', aspectRatio: parsed.video?.aspectRatio ?? '16:9' },
          web: {
            defaultModel: typeof parsed.web?.defaultModel === 'string' ? parsed.web.defaultModel : 'auto',
          },
        };
      }
    }
  } catch {
    // fallback
  }
  return { ...baseDefaults, web: { defaultModel: 'auto' }, video: { defaultModel: 'auto', aspectRatio: '16:9' } };
}

xGatewayMediaRouter.get('/media/voices', handleAudioVoices);

xGatewayMediaRouter.get('/media/config', (_req: Request, res: Response) => {
  const defaults = getExtendedMediaDefaults();
  const kinds = {
    video: { ...KNOWN_KINDS.video, providers: getProvidersForKind('video'), aspectRatios: ['16:9', '9:16', '1:1'] },
    image: {
      ...KNOWN_KINDS.image,
      providers: getProvidersForKind('image'),
      sizes: ['256x256', '512x512', '1024x1024', '1792x1024', '1024x1792'],
    },
    tts: {
      ...KNOWN_KINDS.tts,
      providers: getProvidersForKind('tts'),
      voices: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'],
      formats: ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'],
    },
    stt: {
      ...KNOWN_KINDS.stt,
      providers: getProvidersForKind('stt'),
      formats: ['json', 'text', 'verbose_json', 'vtt', 'srt'],
    },
    embedding: {
      ...KNOWN_KINDS.embedding,
      providers: getProvidersForKind('embedding'),
      suggestedDimensions: [512, 1024, 1536, 3072],
    },
    web: {
      ...KNOWN_KINDS.web,
      providers: getProvidersForKind('web'),
      suggestedEngines: ['perplexity', 'tavily', 'exa', 'brave', 'jina', 'firecrawl'],
    },
  };

  res.json({ defaults, kinds });
});

xGatewayMediaRouter.put('/media/config', (req: Request, res: Response) => {
  const parsed = mediaConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid media configuration', details: parsed.error.issues } });
    return;
  }

  const current = getExtendedMediaDefaults();
  const next = {
    video: { ...current.video, ...parsed.data.video },
    image: { ...current.image, ...parsed.data.image },
    tts: { ...current.tts, ...parsed.data.tts },
    stt: { ...current.stt, ...parsed.data.stt },
    embedding: { ...current.embedding, ...parsed.data.embedding },
    web: { ...current.web, ...parsed.data.web },
  };

  const userId = (req as Request & { user?: { userId?: number } }).user?.userId;
  setMediaDefaults(next as any, userId);
  res.json({ ok: true, defaults: next });
});

xGatewayMediaRouter.post('/media/test/video', async (req: Request, res: Response) => {
  const parsed = z.object({
    prompt: z.string().trim().min(1).max(4000),
    model: z.string().trim().min(1).max(200).optional(),
    aspect_ratio: z.enum(['16:9', '9:16', '1:1']).optional(),
  }).strict().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: { message: 'Invalid video request', details: parsed.error.issues } }); return; }
  const defaults = getExtendedMediaDefaults().video;
  req.body = { ...parsed.data, model: parsed.data.model && parsed.data.model !== 'auto' ? parsed.data.model : defaults?.defaultModel ?? 'auto', aspect_ratio: parsed.data.aspect_ratio ?? defaults?.aspectRatio ?? '16:9' };
  await handleVideoRequest(req, res);
});

xGatewayMediaRouter.post('/media/test/image', async (req: Request, res: Response) => {
  const parsed = imageTestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid image request', details: parsed.error.issues } });
    return;
  }

  const startMs = Date.now();
  const defaultModel = getMediaDefaults().image?.defaultModel || 'auto';
  const requestedModel = parsed.data.model && parsed.data.model !== 'auto' ? parsed.data.model : defaultModel;
  const { candidates, notFoundError } = resolveCandidateRoutes(requestedModel, 'image');

  if (notFoundError) {
    res.status(404).json({ error: { message: notFoundError } });
    return;
  }
  if (candidates.length === 0) {
    res.status(503).json({ error: { message: 'No enabled Thruline provider accounts available.' } });
    return;
  }

  let lastError: unknown = null;
  for (const { account, modelId } of candidates) {
    const baseUrl = accountBaseUrl(account);
    if (!baseUrl) continue;
    let credential: string;
    try {
      credential = decrypt(account.encrypted_key, account.iv, account.auth_tag);
    } catch (err) {
      lastError = err;
      continue;
    }

    const effectiveProxy = resolveXGatewayAccountProxy(account);
    if (requestedModel === 'auto' && isUnsupportedWebImageProvider(account.provider)) {
      lastError ??= new Error(`Provider '${account.provider}' does not support image generation`);
      continue;
    }

    try {
      const { result, usageUnits } = await withQuotaTracking(account, modelId, effectiveProxy, () =>
        executeImageGeneration({
          account,
          baseUrl,
          credential,
          modelId,
          requestedModel,
          prompt: parsed.data.prompt,
          n: parsed.data.n ?? 1,
          size: parsed.data.size,
        }),
      );
      const latencyMs = Date.now() - startMs;
      recordXGatewayKeyUsage(account.id, usageUnits);
      logRequest(
        account.provider, modelId, null, 'success', 1, 1,
        latencyMs, null, latencyMs, requestedModel, null, 'x-gateway',
      );

      res.json({
        ok: true,
        data: result.data || [],
        provider: account.provider,
        accountLabel: account.label,
        model: modelId,
        latencyMs,
      });
      return;
    } catch (err) {
      lastError = err;
    }
  }

  const message = lastError instanceof Error ? lastError.message : 'All Thruline image generation accounts failed.';
  res.status(chatGptWebImageErrorStatus(lastError) ?? 502).json({ error: { message } });
});

xGatewayMediaRouter.post('/media/test/tts', async (req: Request, res: Response) => {
  const parsed = ttsTestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid TTS request', details: parsed.error.issues } });
    return;
  }

  const startMs = Date.now();
  const defaults = getMediaDefaults().tts;
  const requestedModel = parsed.data.model && parsed.data.model !== 'auto' ? parsed.data.model : (defaults?.defaultModel || 'auto');
  const voice = parsed.data.voice || defaults?.defaultVoice || 'alloy';
  const format = parsed.data.response_format || defaults?.defaultFormat || 'mp3';
  const { candidates, notFoundError } = resolveCandidateRoutes(requestedModel);

  if (notFoundError) {
    res.status(404).json({ error: { message: notFoundError } });
    return;
  }
  if (candidates.length === 0) {
    res.status(503).json({ error: { message: 'No enabled Thruline provider accounts available.' } });
    return;
  }

  let lastError: unknown = null;
  for (const { account, modelId } of candidates) {
    const baseUrl = accountBaseUrl(account);
    if (!baseUrl) continue;
    let credential: string;
    try {
      credential = decrypt(account.encrypted_key, account.iv, account.auth_tag);
    } catch (err) {
      lastError = err;
      continue;
    }

    const effectiveProxy = resolveXGatewayAccountProxy(account);
    try {
      const upstreamRes = await withQuotaTracking(account, modelId, effectiveProxy, () =>
        proxyFetch(
          `${baseUrl}/audio/speech`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${credential}`,
            },
            body: JSON.stringify({
              input: parsed.data.input,
              model: modelId,
              voice,
              speed: parsed.data.speed || 1.0,
              response_format: format,
            }),
          },
          account.platform,
          'audio',
          120_000,
        ),
      );

      if (!upstreamRes.ok) {
        const text = await upstreamRes.text().catch(() => '');
        throw new Error(`HTTP ${upstreamRes.status}: ${text.slice(0, 200)}`);
      }

      const audioBuffer = Buffer.from(await upstreamRes.arrayBuffer());
      const latencyMs = Date.now() - startMs;
      const contentType = upstreamRes.headers.get('content-type') || `audio/${format === 'wav' ? 'wav' : 'mpeg'}`;
      recordXGatewayKeyUsage(account.id, Math.max(1, Math.ceil(parsed.data.input.length / 4)));
      logRequest(
        account.provider, modelId, null, 'success', parsed.data.input.length, audioBuffer.length,
        latencyMs, null, latencyMs, requestedModel, null, 'x-gateway',
      );

      res.json({
        ok: true,
        audioBase64: audioBuffer.toString('base64'),
        contentType,
        provider: account.provider,
        accountLabel: account.label,
        model: modelId,
        latencyMs,
      });
      return;
    } catch (err) {
      lastError = err;
    }
  }

  const message = lastError instanceof Error ? lastError.message : 'All Thruline speech accounts failed.';
  res.status(502).json({ error: { message } });
});

xGatewayMediaRouter.post(
  '/media/test/stt',
  upload.single('file'),
  async (req: Request, res: Response) => {
    const file = req.file;
    if (!file || !file.buffer?.length) {
      res.status(400).json({ error: { message: 'Audio file is required' } });
      return;
    }

    const startMs = Date.now();
    const defaultModel = getMediaDefaults().stt?.defaultModel || 'auto';
    const requestedModel = typeof req.body?.model === 'string' && req.body.model.trim() && req.body.model.trim() !== 'auto'
      ? req.body.model.trim()
      : defaultModel;
    const { candidates, notFoundError } = resolveCandidateRoutes(requestedModel);

    if (notFoundError) {
      res.status(404).json({ error: { message: notFoundError } });
      return;
    }
    if (candidates.length === 0) {
      res.status(503).json({ error: { message: 'No enabled Thruline provider accounts available.' } });
      return;
    }

    let lastError: unknown = null;
    for (const { account, modelId } of candidates) {
      const baseUrl = accountBaseUrl(account);
      if (!baseUrl) continue;
      let credential: string;
      try {
        credential = decrypt(account.encrypted_key, account.iv, account.auth_tag);
      } catch (err) {
        lastError = err;
        continue;
      }

      const effectiveProxy = resolveXGatewayAccountProxy(account);
      try {
        const form = new FormData();
        form.append(
          'file',
          new Blob([new Uint8Array(file.buffer)], { type: file.mimetype || 'audio/mpeg' }),
          file.originalname || 'audio.mp3',
        );
        form.append('model', requestedModel === 'auto' ? modelId : requestedModel);
        if (typeof req.body?.language === 'string' && req.body.language) {
          form.append('language', req.body.language);
        }

        const upstreamRes = await withQuotaTracking(account, modelId, effectiveProxy, () =>
          proxyFetch(
            `${baseUrl}/audio/transcriptions`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${credential}`,
              },
              body: form,
            },
            account.platform,
            'transcription',
            120_000,
          ),
        );

        if (!upstreamRes.ok) {
          const text = await upstreamRes.text().catch(() => '');
          throw new Error(`HTTP ${upstreamRes.status}: ${text.slice(0, 200)}`);
        }

        const raw = await upstreamRes.text();
        let parsedResult: Record<string, unknown> = {};
        try {
          parsedResult = JSON.parse(raw);
        } catch {
          parsedResult = { text: raw };
        }

        const latencyMs = Date.now() - startMs;
        recordXGatewayKeyUsage(account.id, 1);
        logRequest(
          account.provider, modelId, null, 'success', 1, 1,
          latencyMs, null, latencyMs, requestedModel, null, 'x-gateway',
        );

        res.json({
          ok: true,
          text: (parsedResult.text as string) || raw,
          raw: parsedResult,
          provider: account.provider,
          accountLabel: account.label,
          model: modelId,
          latencyMs,
        });
        return;
      } catch (err) {
        lastError = err;
      }
    }

    const message = lastError instanceof Error ? lastError.message : 'All Thruline transcription accounts failed.';
    res.status(502).json({ error: { message } });
  },
);

xGatewayMediaRouter.post('/media/test/embedding', async (req: Request, res: Response) => {
  const parsed = embeddingTestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid embedding request', details: parsed.error.issues } });
    return;
  }

  const startMs = Date.now();
  const defaultModel = getMediaDefaults().embedding?.defaultModel || 'auto';
  const requestedModel = parsed.data.model && parsed.data.model !== 'auto' ? parsed.data.model : defaultModel;
  const { candidates, notFoundError } = resolveCandidateRoutes(requestedModel);

  if (notFoundError) {
    res.status(404).json({ error: { message: notFoundError } });
    return;
  }
  if (candidates.length === 0) {
    res.status(503).json({ error: { message: 'No enabled Thruline provider accounts available.' } });
    return;
  }

  let lastError: unknown = null;
  for (const { account, modelId } of candidates) {
    const baseUrl = accountBaseUrl(account);
    if (!baseUrl) continue;
    let credential: string;
    try {
      credential = decrypt(account.encrypted_key, account.iv, account.auth_tag);
    } catch (err) {
      lastError = err;
      continue;
    }

    const effectiveProxy = resolveXGatewayAccountProxy(account);
    try {
      const payload: Record<string, unknown> = {
        input: parsed.data.input,
        model: requestedModel === 'auto' ? modelId : requestedModel,
      };
      if (parsed.data.dimensions) payload.dimensions = parsed.data.dimensions;

      const upstreamRes = await withQuotaTracking(account, modelId, effectiveProxy, () =>
        proxyFetch(
          `${baseUrl}/embeddings`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${credential}`,
            },
            body: JSON.stringify(payload),
          },
          account.platform,
          'embedding',
          60_000,
        ),
      );

      const data = await parseUpstreamJson(upstreamRes, account.provider);
      const latencyMs = Date.now() - startMs;
      const embeddingList = Array.isArray(data.data) ? (data.data as Array<{ embedding?: number[] }>) : [];
      const firstVector = embeddingList[0]?.embedding || [];

      recordXGatewayKeyUsage(account.id, 10);
      logRequest(
        account.provider, modelId, null, 'success', parsed.data.input.length, firstVector.length,
        latencyMs, null, latencyMs, requestedModel, null, 'x-gateway',
      );

      res.json({
        ok: true,
        dimensions: firstVector.length,
        embeddingSample: firstVector.slice(0, 8),
        usage: data.usage || null,
        provider: account.provider,
        accountLabel: account.label,
        model: modelId,
        latencyMs,
      });
      return;
    } catch (err) {
      lastError = err;
    }
  }

  const message = lastError instanceof Error ? lastError.message : 'All Thruline embedding accounts failed.';
  res.status(502).json({ error: { message } });
});

xGatewayMediaRouter.post('/media/test/web', async (req: Request, res: Response) => {
  const parsed = webTestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid web search request', details: parsed.error.issues } });
    return;
  }

  const startMs = Date.now();
  const extended = getExtendedMediaDefaults();
  const defaultModel = extended.web?.defaultModel || 'auto';
  const requestedModel = parsed.data.model && parsed.data.model !== 'auto' ? parsed.data.model : defaultModel;
  const { candidates, notFoundError } = resolveCandidateRoutes(requestedModel);

  if (notFoundError) {
    res.status(404).json({ error: { message: notFoundError } });
    return;
  }
  if (candidates.length === 0) {
    res.status(503).json({ error: { message: 'No enabled Thruline provider accounts available.' } });
    return;
  }

  let lastError: unknown = null;
  for (const { account, modelId } of candidates) {
    const baseUrl = accountBaseUrl(account);
    if (!baseUrl) continue;
    let credential: string;
    try {
      credential = decrypt(account.encrypted_key, account.iv, account.auth_tag);
    } catch (err) {
      lastError = err;
      continue;
    }

    const effectiveProxy = resolveXGatewayAccountProxy(account);
    try {
      const userPrompt = parsed.data.fetchUrl
        ? `Please fetch, read, and summarize the webpage at ${parsed.data.fetchUrl}. Query context: ${parsed.data.query}`
        : `Search the web and provide detailed, concise, up-to-date findings for: ${parsed.data.query}`;

      const payload = {
        model: requestedModel === 'auto' ? modelId : requestedModel,
        messages: [
          {
            role: 'system',
            content: 'You are a web search and web extraction engine. Return clear, concise findings with citation sources and URLs if found.',
          },
          {
            role: 'user',
            content: userPrompt,
          },
        ],
        max_tokens: 1000,
        temperature: 0.3,
      };

      const upstreamRes = await withQuotaTracking(account, modelId, effectiveProxy, () =>
        proxyFetch(
          `${baseUrl}/chat/completions`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${credential}`,
            },
            body: JSON.stringify(payload),
          },
          account.platform,
          'chat',
          60_000,
        ),
      );

      if (!upstreamRes.ok) {
        const text = await upstreamRes.text().catch(() => '');
        throw new Error(`HTTP ${upstreamRes.status}: ${text.slice(0, 200)}`);
      }

      const data = (await upstreamRes.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const content = data.choices?.[0]?.message?.content || '';
      const latencyMs = Date.now() - startMs;

      recordXGatewayKeyUsage(account.id, 1);
      logRequest(
        account.provider,
        modelId,
        null,
        'success',
        parsed.data.query.length,
        content.length,
        latencyMs,
        null,
        latencyMs,
        requestedModel,
        null,
        'x-gateway',
      );

      res.json({
        ok: true,
        query: parsed.data.query,
        content,
        results: [
          {
            title: `Search: ${parsed.data.query}`,
            content,
            url: parsed.data.fetchUrl || undefined,
          },
        ],
        provider: account.provider,
        accountLabel: account.label,
        model: modelId,
        latencyMs,
      });
      return;
    } catch (err) {
      lastError = err;
    }
  }

  const message = lastError instanceof Error ? lastError.message : 'All Thruline web search accounts failed.';
  res.status(502).json({ error: { message } });
});

// ---------------------------------------------------------------------------
// Model Pricing Configuration Routes (/api/thruline/pricing)
// ---------------------------------------------------------------------------

xGatewayMediaRouter.get('/pricing', (_req: Request, res: Response) => {
  res.json({
    pricing: getMergedPricing(),
    defaults: getDefaultPricing(),
    overrides: getPricingOverrides(),
  });
});

xGatewayMediaRouter.patch('/pricing', (req: Request, res: Response) => {
  const validated = validatePricingPatch(req.body);
  if (!validated.ok) {
    res.status(400).json({ error: { message: validated.error } });
    return;
  }
  const pricing = updatePricingOverrides(validated.patch);
  res.json({
    ok: true,
    pricing,
    defaults: getDefaultPricing(),
    overrides: getPricingOverrides(),
  });
});

xGatewayMediaRouter.delete('/pricing', (req: Request, res: Response) => {
  const provider = typeof req.query.provider === 'string' && req.query.provider.trim()
    ? req.query.provider.trim()
    : undefined;
  const model = typeof req.query.model === 'string' && req.query.model.trim()
    ? req.query.model.trim()
    : undefined;

  const pricing = resetPricingOverrides(provider, model);
  res.json({
    ok: true,
    pricing,
    defaults: getDefaultPricing(),
    overrides: getPricingOverrides(),
  });
});


