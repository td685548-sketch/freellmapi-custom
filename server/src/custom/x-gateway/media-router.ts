import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
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
import {
  getMediaDefaults,
  setMediaDefaults,
  type XGatewayMediaDefaults,
} from './config.js';
import { accountBaseUrl } from './protocols.js';
import { withQuotaTracking } from './quota/tracking.js';
import { resolveCandidateRoutes } from './router.js';

export const xGatewayMediaRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
});

const mediaConfigSchema = z.object({
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

const KNOWN_KINDS: Record<'image' | 'tts' | 'stt' | 'embedding', {
  label: string;
  endpoint: string;
  defaultProviders: string[];
  matcher: RegExp;
  suggestedModels: string[];
}> = {
  image: {
    label: 'Text to Image',
    endpoint: '/x/v1/images/generations',
    defaultProviders: ['openai', 'azure-openai', 'gemini', 'cloudflare-ai', 'together', 'replicate', 'black-forest-labs', 'deepinfra', 'siliconflow', 'venice', 'fal-ai', 'sdwebui', 'comfyui'],
    matcher: /image|dall-e|flux|sdxl|diffusion|imagen/i,
    suggestedModels: ['dall-e-3', 'dall-e-2', 'imagen-3.0-generate-002', 'gemini-3.1-flash-image-preview', 'black-forest-labs/FLUX.1-schnell', 'stabilityai/stable-diffusion-xl-base-1.0'],
  },
  tts: {
    label: 'Text to Speech',
    endpoint: '/x/v1/audio/speech',
    defaultProviders: ['openai', 'azure-openai', 'gemini', 'edge-tts', 'elevenlabs', 'fish-audio', 'coqui', 'cartesia', 'minimax', 'minimax-cn', 'deepgram', 'aws-polly'],
    matcher: /tts|speech|voice/i,
    suggestedModels: ['tts-1', 'tts-1-hd', 'gemini-3.1-flash-tts-preview', 'edge-tts', 'eleven_multilingual_v2', 'speech-01-hd'],
  },
  stt: {
    label: 'Speech to Text',
    endpoint: '/x/v1/audio/transcriptions',
    defaultProviders: ['openai', 'azure-openai', 'groq', 'assemblyai', 'deepgram', 'gemini', 'cloudflare-ai', 'deepinfra', 'huggingface'],
    matcher: /whisper|stt|transcription/i,
    suggestedModels: ['whisper-1', 'whisper-large-v3', 'whisper-large-v3-turbo', 'distil-whisper-large-v3-en', 'universal-3-pro'],
  },
  embedding: {
    label: 'Embedding',
    endpoint: '/x/v1/embeddings',
    defaultProviders: ['openai', 'azure-openai', 'gemini', 'mistral', 'cohere', 'voyage', 'together', 'jina', 'deepinfra', 'siliconflow', 'nebius', 'fireworks', 'nvidia'],
    matcher: /embed/i,
    suggestedModels: ['text-embedding-3-small', 'text-embedding-3-large', 'gemini-embedding-001', 'text-embedding-004', 'mistral-embed', 'BAAI/bge-m3'],
  },
};

function getProvidersForKind(kindKey: 'image' | 'tts' | 'stt' | 'embedding') {
  const spec = KNOWN_KINDS[kindKey];
  const defaults = new Set(spec.defaultProviders);
  const matched = new Set<string>();

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

xGatewayMediaRouter.get('/media/config', (_req: Request, res: Response) => {
  const defaults = getMediaDefaults();
  const kinds = {
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
  };

  res.json({ defaults, kinds });
});

xGatewayMediaRouter.put('/media/config', (req: Request, res: Response) => {
  const parsed = mediaConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid media configuration', details: parsed.error.issues } });
    return;
  }

  const current = getMediaDefaults();
  const next: XGatewayMediaDefaults = {
    image: { ...current.image, ...parsed.data.image },
    tts: { ...current.tts, ...parsed.data.tts },
    stt: { ...current.stt, ...parsed.data.stt },
    embedding: { ...current.embedding, ...parsed.data.embedding },
  };

  const userId = (req as Request & { user?: { userId?: number } }).user?.userId;
  setMediaDefaults(next, userId);
  res.json({ ok: true, defaults: next });
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
  const { candidates, notFoundError } = resolveCandidateRoutes(requestedModel);

  if (notFoundError) {
    res.status(404).json({ error: { message: notFoundError } });
    return;
  }
  if (candidates.length === 0) {
    res.status(503).json({ error: { message: 'No enabled X Gateway provider accounts available.' } });
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
          `${baseUrl}/images/generations`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${credential}`,
            },
            body: JSON.stringify({
              prompt: parsed.data.prompt,
              model: requestedModel === 'auto' ? modelId : requestedModel,
              size: parsed.data.size || '1024x1024',
              n: parsed.data.n || 1,
            }),
          },
          account.platform,
          'image',
          120_000,
        ),
      );

      if (!upstreamRes.ok) {
        const text = await upstreamRes.text().catch(() => '');
        throw new Error(`HTTP ${upstreamRes.status}: ${text.slice(0, 200)}`);
      }

      const data = (await upstreamRes.json()) as Record<string, unknown>;
      const latencyMs = Date.now() - startMs;
      recordXGatewayKeyUsage(account.id, 1);
      logRequest(
        account.provider, modelId, null, 'success', 1, 1,
        latencyMs, null, latencyMs, requestedModel, null, 'x-gateway',
      );

      res.json({
        ok: true,
        data: data.data || [],
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

  const message = lastError instanceof Error ? lastError.message : 'All X Gateway image generation accounts failed.';
  res.status(502).json({ error: { message } });
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
    res.status(503).json({ error: { message: 'No enabled X Gateway provider accounts available.' } });
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
              model: requestedModel === 'auto' ? modelId : requestedModel,
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

  const message = lastError instanceof Error ? lastError.message : 'All X Gateway speech accounts failed.';
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
      res.status(503).json({ error: { message: 'No enabled X Gateway provider accounts available.' } });
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

    const message = lastError instanceof Error ? lastError.message : 'All X Gateway transcription accounts failed.';
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
    res.status(503).json({ error: { message: 'No enabled X Gateway provider accounts available.' } });
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

      if (!upstreamRes.ok) {
        const text = await upstreamRes.text().catch(() => '');
        throw new Error(`HTTP ${upstreamRes.status}: ${text.slice(0, 200)}`);
      }

      const data = (await upstreamRes.json()) as Record<string, unknown>;
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

  const message = lastError instanceof Error ? lastError.message : 'All X Gateway embedding accounts failed.';
  res.status(502).json({ error: { message } });
});

