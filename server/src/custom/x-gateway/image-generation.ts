import { getXGatewayProvider } from '../provider-accounts/catalog.js';
import { generateChatGptWebImages } from '../provider-accounts/chatgpt-web-image.js';
import type { AccountRow } from '../provider-accounts/store.js';
import { proxyFetch } from '../../lib/proxy.js';

export interface ImageGenerationInput {
  account: AccountRow;
  baseUrl: string;
  credential: string;
  modelId: string;
  requestedModel: string;
  prompt: string;
  n: number;
  size?: string;
  extraBody?: Record<string, unknown>;
}

export interface ImageGenerationResult {
  created?: number;
  data: Array<{ url?: string; b64_json?: string; revised_prompt?: string }>;
}

export function isUnsupportedWebImageProvider(provider: string): boolean {
  if (provider === 'chatgpt-web') return false;
  const entry = getXGatewayProvider(provider);
  return entry?.category === 'webCookie' || provider.endsWith('-web');
}

export async function parseUpstreamJson(res: Response, provider: string): Promise<Record<string, unknown>> {
  const rawText = await res.text().catch(() => '');
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${rawText.slice(0, 200)}`);
  }
  try {
    const parsed = JSON.parse(rawText) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Response JSON is not an object');
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof Error && err.message === 'Response JSON is not an object') {
      throw new Error(`Upstream ${provider} returned non-object JSON (HTTP ${res.status})`);
    }
    const contentType = res.headers.get('content-type') || 'unknown';
    const snippet = rawText.trim().slice(0, 160);
    throw new Error(
      `Upstream ${provider} returned non-JSON response (HTTP ${res.status}, ${contentType}): ${snippet || '(empty body)'}`,
    );
  }
}

async function generateGeminiImages(input: ImageGenerationInput): Promise<ImageGenerationResult> {
  const { account, baseUrl, credential, modelId, prompt, n } = input;
  const cleanModel = modelId.replace(/^models\//, '');
  const isImagen = /imagen/i.test(cleanModel);
  const endpoint = isImagen
    ? `${baseUrl}/${cleanModel}:predict?key=${encodeURIComponent(credential)}`
    : `${baseUrl}/${cleanModel}:generateContent?key=${encodeURIComponent(credential)}`;

  const payload = isImagen
    ? { instances: [{ prompt }], parameters: { sampleCount: n } }
    : {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
      };

  const upstreamRes = await proxyFetch(
    endpoint,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
    account.platform,
    'image',
    120_000,
  );

  const json = await parseUpstreamJson(upstreamRes, account.provider);
  const created = Math.floor(Date.now() / 1000);

  if (isImagen) {
    const predictions = Array.isArray(json.predictions) ? json.predictions : [];
    const data = predictions
      .filter((p): p is { bytesBase64Encoded: string } => Boolean(p && typeof p === 'object' && typeof (p as Record<string, unknown>).bytesBase64Encoded === 'string'))
      .map(p => ({ b64_json: p.bytesBase64Encoded }));
    if (data.length === 0) {
      throw new Error(`Gemini Imagen (${cleanModel}) returned no image data`);
    }
    return { created, data };
  }

  const candidates = Array.isArray(json.candidates) ? json.candidates : [];
  const firstCandidate = candidates[0] as { content?: { parts?: Array<Record<string, unknown>> }; finishReason?: string } | undefined;
  const parts = Array.isArray(firstCandidate?.content?.parts) ? firstCandidate.content.parts : [];
  const images = parts
    .filter((p): p is { inlineData: { data: string } } => Boolean(p?.inlineData && typeof (p.inlineData as Record<string, unknown>).data === 'string'))
    .map(p => ({ b64_json: p.inlineData.data }));

  if (images.length === 0) {
    const textPart = parts.find(p => typeof p?.text === 'string')?.text as string | undefined;
    const reason = firstCandidate?.finishReason ? ` (${firstCandidate.finishReason})` : '';
    throw new Error(
      textPart
        ? `Gemini (${cleanModel}) returned text instead of an image${reason}: ${textPart.slice(0, 160)}`
        : `Gemini (${cleanModel}) returned no image data${reason}`,
    );
  }

  return { created, data: images };
}

export async function executeImageGeneration(input: ImageGenerationInput): Promise<{
  result: ImageGenerationResult;
  usageUnits: number;
}> {
  const { account, baseUrl, credential, modelId, requestedModel, prompt, n, size, extraBody } = input;

  if (account.provider === 'chatgpt-web') {
    const result = await generateChatGptWebImages({
      credential,
      prompt,
      n,
      size,
      baseUrl,
      platform: account.platform,
    });
    return { result, usageUnits: Math.max(1, n) };
  }

  if (isUnsupportedWebImageProvider(account.provider)) {
    throw new Error(`Provider '${account.provider}' does not support image generation`);
  }

  if (account.provider === 'gemini') {
    const result = await generateGeminiImages(input);
    return { result, usageUnits: Math.max(1, result.data.length) };
  }

  const upstreamRes = await proxyFetch(
    `${baseUrl}/images/generations`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${credential}`,
      },
      body: JSON.stringify({
        ...extraBody,
        prompt,
        model: requestedModel === 'auto' ? modelId : requestedModel,
        size: size || '1024x1024',
        n,
      }),
    },
    account.platform,
    'image',
    120_000,
  );

  const data = await parseUpstreamJson(upstreamRes, account.provider);
  const items = Array.isArray(data.data) ? (data.data as ImageGenerationResult['data']) : [];
  return {
    result: {
      ...(typeof data.created === 'number' ? { created: data.created } : {}),
      data: items,
    },
    usageUnits: 1,
  };
}
