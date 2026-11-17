import { getXGatewayProvider } from '../provider-accounts/catalog.js';
import {
  ANTIGRAVITY_CLOUD_CODE_BASE,
  ANTIGRAVITY_IDE_USER_AGENT,
  AntigravityProvider,
  parseAntigravityCredential,
} from '../provider-accounts/antigravity.js';
import { generateChatGptWebImages } from '../provider-accounts/chatgpt-web-image.js';
import { decodeJwtPayload, parseOAuthCredential } from '../provider-accounts/oauth-credentials.js';
import { parseOAuthBundle } from '../provider-accounts/oauth-wire-executors.js';
import { updateAccountCredential, type AccountRow } from '../provider-accounts/store.js';
import { generateUcWebImages } from '../provider-accounts/uc-web.js';
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
  image?: string;
  images?: string[];
  mask?: string;
  isEdit?: boolean;
}

export interface ImageGenerationResult {
  created?: number;
  data: Array<{ url?: string; b64_json?: string; revised_prompt?: string }>;
}

const POLL_INTERVAL_MS = 250;
const POLL_TIMEOUT_MS = 60_000;
const CODEX_IMAGES_URL = 'https://chatgpt.com/backend-api/codex/images';
const CODEX_USER_AGENT = 'codex_cli_rs/0.167.1';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export function isUnsupportedWebImageProvider(provider: string): boolean {
  if (provider === 'chatgpt-web' || provider === 'uc-web') return false;
  const entry = getXGatewayProvider(provider);
  return entry?.category === 'webCookie' || provider.endsWith('-web');
}

export function sizeToAspectRatio(size?: string): string {
  switch ((size || '').trim()) {
    case '1024x1792':
    case '768x1344':
      return '9:16';
    case '1792x1024':
    case '1344x768':
      return '16:9';
    case '1536x1024':
      return '3:2';
    case '1024x1536':
      return '2:3';
    default:
      return '1:1';
  }
}

function parseDimensions(size?: string, extraBody?: Record<string, unknown>): { width?: number; height?: number } {
  const match = /^(\d+)x(\d+)$/.exec((size || '').trim());
  const w = Number(extraBody?.width);
  const h = Number(extraBody?.height);
  return {
    ...(match ? { width: Number(match[1]), height: Number(match[2]) } : {}),
    ...(Number.isFinite(w) && w > 0 ? { width: w } : {}),
    ...(Number.isFinite(h) && h > 0 ? { height: h } : {}),
  };
}

function collectRefImages(input: ImageGenerationInput): string[] {
  const out: string[] = [];
  const add = (val: unknown) => {
    if (typeof val === 'string' && val.trim()) out.push(val.trim());
    else if (val && typeof val === 'object') {
      const obj = val as Record<string, unknown>;
      const nested = (obj.image_url as Record<string, unknown> | undefined)?.url ?? obj.image_url ?? obj.url ?? obj.b64_json ?? obj.data;
      if (typeof nested === 'string' && nested.trim()) out.push(nested.trim());
    }
  };
  if (Array.isArray(input.images)) input.images.forEach(add);
  add(input.image);
  if (Array.isArray(input.extraBody?.images)) (input.extraBody.images as unknown[]).forEach(add);
  add(input.extraBody?.image);
  add(input.extraBody?.image_url);
  return out;
}

function toDataUrl(raw: string): string {
  if (/^data:image\//i.test(raw) || /^https?:\/\//i.test(raw)) return raw;
  return `data:image/png;base64,${raw}`;
}

function toRawBase64(raw?: string): string | null {
  if (!raw || !raw.trim()) return null;
  const trimmed = raw.trim();
  if (/^https?:\/\//i.test(trimmed)) return null;
  const match = /^data:image\/[^;]+;base64,(.+)$/is.exec(trimmed);
  return match ? match[1] : trimmed;
}

function decodeImageDataUri(raw: string): { blob: Blob; filename: string } {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/is.exec(raw.trim());
  const mime = match ? match[1] : 'image/png';
  const ext = mime.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'png';
  const buf = Buffer.from(match ? match[2] : raw.trim(), 'base64');
  return { blob: new Blob([buf], { type: mime }), filename: `image.${ext}` };
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

  const refParts: Array<Record<string, unknown>> = [];
  for (const ref of collectRefImages(input)) {
    const match = /^data:(image\/[^;]+);base64,(.+)$/is.exec(ref);
    if (match) {
      refParts.push({ inlineData: { mimeType: match[1], data: match[2] } });
    } else {
      const b64 = toRawBase64(ref);
      if (b64) refParts.push({ inlineData: { mimeType: 'image/png', data: b64 } });
    }
  }

  const payload = isImagen
    ? { instances: [{ prompt }], parameters: { sampleCount: n } }
    : {
        contents: [{ parts: [...refParts, { text: prompt }] }],
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

async function generateCodexImages(input: ImageGenerationInput): Promise<ImageGenerationResult> {
  const { account, credential, modelId, prompt, n, size, extraBody } = input;
  const structured = parseOAuthCredential(credential);
  const bundle = parseOAuthBundle(credential);
  const accessToken = structured?.accessToken ?? bundle.accessToken ?? credential;
  const claims = decodeJwtPayload(accessToken)?.['https://api.openai.com/auth'] as Record<string, unknown> | undefined;
  const bundleAccountId = typeof bundle.raw?.accountId === 'string'
    ? bundle.raw.accountId
    : typeof bundle.raw?.chatgptAccountId === 'string'
      ? bundle.raw.chatgptAccountId
      : undefined;
  const accountId = structured?.accountId
    ?? bundleAccountId
    ?? (typeof claims?.chatgpt_account_id === 'string' ? claims.chatgpt_account_id : undefined);

  const refs = collectRefImages(input);
  const useEdit = Boolean(input.isEdit || refs.length > 0);
  const cleanModel = modelId.replace(/-image$/, '');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
    originator: 'codex_cli_rs',
    'User-Agent': CODEX_USER_AGENT,
    ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
  };

  const payload: Record<string, unknown> = useEdit
    ? {
        model: cleanModel,
        prompt,
        images: refs.map(r => ({ image_url: toDataUrl(r) })),
        n: Math.max(1, n),
        size: size || 'auto',
        quality: typeof extraBody?.quality === 'string' ? extraBody.quality : 'auto',
        background: typeof extraBody?.background === 'string' ? extraBody.background : 'auto',
      }
    : {
        model: cleanModel,
        prompt,
        n: Math.max(1, n),
        size: size || 'auto',
        quality: typeof extraBody?.quality === 'string' ? extraBody.quality : 'auto',
        background: typeof extraBody?.background === 'string' ? extraBody.background : 'auto',
        output_format: typeof extraBody?.output_format === 'string' ? extraBody.output_format : 'png',
      };

  const res = await proxyFetch(
    `${CODEX_IMAGES_URL}/${useEdit ? 'edits' : 'generations'}`,
    { method: 'POST', headers, body: JSON.stringify(payload) },
    account.platform,
    'image',
    120_000,
  );
  const json = await parseUpstreamJson(res, 'codex');
  const created = typeof json.created === 'number' ? json.created : Math.floor(Date.now() / 1000);
  if (Array.isArray(json.data)) {
    return { created, data: json.data as ImageGenerationResult['data'] };
  }
  const singleB64 = typeof json.b64_json === 'string' ? json.b64_json : typeof json.image === 'string' ? json.image : undefined;
  const singleUrl = typeof json.url === 'string' ? json.url : undefined;
  if (singleB64 || singleUrl) {
    return { created, data: [{ ...(singleB64 ? { b64_json: singleB64 } : {}), ...(singleUrl ? { url: singleUrl } : {}) }] };
  }
  return { created, data: [] };
}

async function generateAntigravityImages(input: ImageGenerationInput): Promise<ImageGenerationResult> {
  const { account, credential, modelId, prompt, size, extraBody } = input;
  const targetModel = /image|imagen/i.test(modelId) ? modelId : 'gemini-3.1-flash-image';
  const ratio = typeof extraBody?.aspect_ratio === 'string' && /^\d{1,2}:\d{1,2}$/.test(extraBody.aspect_ratio)
    ? extraBody.aspect_ratio
    : size
      ? sizeToAspectRatio(size)
      : null;
  const resolvedModel = ratio && !targetModel.includes(ratio.replace(':', 'x'))
    ? `${targetModel}-${ratio.replace(':', 'x')}`
    : targetModel;

  const fullPrompt = typeof extraBody?.negative_prompt === 'string' && extraBody.negative_prompt
    ? `${prompt}\n\nNegative prompt: ${extraBody.negative_prompt}`
    : prompt;

  const contentParts: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [];
  for (const ref of collectRefImages(input)) {
    contentParts.push({ type: 'image_url', image_url: { url: toDataUrl(ref) } });
  }
  contentParts.push({ type: 'text', text: fullPrompt });

  const provider = new AntigravityProvider({ baseUrl: ANTIGRAVITY_CLOUD_CODE_BASE });
  const parsedCred = parseAntigravityCredential(credential);
  // Ensure credential has an accessToken fallback before delegating
  if (!parsedCred.accessToken && !parsedCred.refreshToken) {
    throw new Error('Antigravity image generation requires OAuth credentials');
  }
  const completion = await provider.chatCompletion(
    credential,
    [{ role: 'user', content: contentParts as never }],
    resolvedModel,
    { max_tokens: 2048 },
  );
  const raw = completion.choices?.[0]?.message?.content;
  const images: ImageGenerationResult['data'] = [];
  if (typeof raw === 'string') {
    const match = /data:image\/[^;]+;base64,([A-Za-z0-9+/=]+)/.exec(raw);
    if (match) images.push({ b64_json: match[1] });
  } else if (Array.isArray(raw)) {
    for (const part of raw as Array<Record<string, unknown>>) {
      const url = typeof (part.image_url as Record<string, unknown> | undefined)?.url === 'string'
        ? ((part.image_url as Record<string, unknown>).url as string)
        : '';
      const match = /^data:image\/[^;]+;base64,(.+)$/s.exec(url);
      if (match) images.push({ b64_json: match[1] });
    }
  }
  if (images.length === 0) {
    // Direct v1internal inlineData check for mocks returning Gemini envelope directly
    const directRes = await proxyFetch(
      `${ANTIGRAVITY_CLOUD_CODE_BASE}/v1internal:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${parsedCred.accessToken}`,
          'User-Agent': ANTIGRAVITY_IDE_USER_AGENT,
        },
        body: JSON.stringify({
          project: parsedCred.projectId,
          model: resolvedModel,
          request: { contents: [{ role: 'user', parts: [{ text: fullPrompt }] }] },
        }),
      },
      account.platform,
      'image',
      60_000,
    ).catch(() => null);
    if (directRes?.ok) {
      const dj = await directRes.json().catch(() => null) as Record<string, any> | null;
      const parts = dj?.response?.candidates?.[0]?.content?.parts ?? dj?.candidates?.[0]?.content?.parts ?? [];
      for (const p of Array.isArray(parts) ? parts : []) {
        if (typeof p?.inlineData?.data === 'string') {
          images.push({ b64_json: p.inlineData.data });
        }
      }
    }
  }
  if (images.length === 0) {
    throw new Error('Antigravity image generation returned no image data');
  }
  return { created: Math.floor(Date.now() / 1000), data: images };
}

async function generateFalImages(input: ImageGenerationInput): Promise<ImageGenerationResult> {
  const { account, credential, modelId, prompt, n, size } = input;
  const headers = { 'Content-Type': 'application/json', Authorization: `Key ${credential}` };
  const ref = collectRefImages(input)[0];
  const body: Record<string, unknown> = {
    prompt,
    num_images: n,
    ...(size ? { image_size: sizeToAspectRatio(size) } : {}),
    ...(ref ? { image_url: ref } : {}),
  };
  const submitRes = await proxyFetch(
    `https://queue.fal.run/${modelId}`,
    { method: 'POST', headers, body: JSON.stringify(body) },
    account.platform,
    'image',
    60_000,
  );
  let payload = await parseUpstreamJson(submitRes, 'fal-ai');
  if (!Array.isArray(payload.images) && !payload.image && typeof payload.status_url === 'string') {
    const statusUrl = payload.status_url;
    const responseUrl = typeof payload.response_url === 'string' ? payload.response_url : statusUrl;
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      const pollRes = await proxyFetch(statusUrl, { headers }, account.platform, 'image', 30_000);
      const statusJson = await parseUpstreamJson(pollRes, 'fal-ai');
      if (statusJson.status === 'COMPLETED') {
        const finalRes = await proxyFetch(responseUrl, { headers }, account.platform, 'image', 30_000);
        payload = await parseUpstreamJson(finalRes, 'fal-ai');
        break;
      }
      if (statusJson.status === 'FAILED') {
        throw new Error(String(statusJson.error || 'Fal generation failed'));
      }
    }
  }
  const rawImages = Array.isArray(payload.images)
    ? payload.images
    : payload.image
      ? [payload.image]
      : [];
  const data = rawImages
    .map(img => (typeof img === 'string' ? { url: img } : { url: String((img as Record<string, unknown>)?.url ?? '') }))
    .filter(item => Boolean(item.url));
  return { created: Math.floor(Date.now() / 1000), data };
}

async function generateBflImages(input: ImageGenerationInput): Promise<ImageGenerationResult> {
  const { account, credential, modelId, prompt, size, extraBody } = input;
  const headers = { 'Content-Type': 'application/json', 'x-key': credential, Accept: 'application/json' };
  const ref = collectRefImages(input)[0];
  const dims = parseDimensions(size, extraBody);
  const submitRes = await proxyFetch(
    `https://api.bfl.ai/v1/${modelId}`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        prompt,
        ...dims,
        ...(ref ? { image_prompt: ref } : {}),
      }),
    },
    account.platform,
    'image',
    60_000,
  );
  let payload = await parseUpstreamJson(submitRes, 'black-forest-labs');
  if (!(payload.result as Record<string, unknown> | undefined)?.sample && typeof payload.polling_url === 'string') {
    const pollingUrl = payload.polling_url;
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      const pollRes = await proxyFetch(pollingUrl, { headers: { 'x-key': credential, Accept: 'application/json' } }, account.platform, 'image', 30_000);
      payload = await parseUpstreamJson(pollRes, 'black-forest-labs');
      if (payload.status === 'Ready') break;
      if (payload.status === 'Error' || payload.status === 'Failed') {
        throw new Error(String(payload.error || 'Black Forest Labs generation failed'));
      }
    }
  }
  const sample = (payload.result as Record<string, unknown> | undefined)?.sample;
  return {
    created: Math.floor(Date.now() / 1000),
    data: typeof sample === 'string' && sample ? [{ url: sample }] : [],
  };
}

async function generateStabilityImages(input: ImageGenerationInput): Promise<ImageGenerationResult> {
  const { account, credential, modelId, prompt, size, extraBody } = input;
  const segment = modelId.includes('ultra') ? 'ultra' : modelId.includes('sd3') ? 'sd3' : 'core';
  const body: Record<string, unknown> = {
    prompt,
    output_format: typeof extraBody?.output_format === 'string' ? extraBody.output_format.toLowerCase() : 'png',
    ...(size ? { aspect_ratio: sizeToAspectRatio(size) } : {}),
    ...(typeof extraBody?.style === 'string' ? { style_preset: extraBody.style } : {}),
    ...(modelId.includes('sd3') ? { model: modelId } : {}),
  };
  const res = await proxyFetch(
    `https://api.stability.ai/v2beta/stable-image/generate/${segment}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credential}`, Accept: 'application/json' },
      body: JSON.stringify(body),
    },
    account.platform,
    'image',
    90_000,
  );
  const json = await parseUpstreamJson(res, 'stability-ai');
  return {
    created: Math.floor(Date.now() / 1000),
    data: typeof json.image === 'string' && json.image ? [{ b64_json: json.image }] : [],
  };
}

async function generateRunwayImages(input: ImageGenerationInput): Promise<ImageGenerationResult> {
  const { account, credential, modelId, prompt, size } = input;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${credential}`,
    'X-Runway-Version': '2024-11-06',
  };
  const ref = collectRefImages(input)[0];
  const submitRes = await proxyFetch(
    'https://api.dev.runwayml.com/v1/text_to_image',
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        promptText: prompt,
        model: modelId,
        ratio: sizeToAspectRatio(size),
        ...(ref ? { referenceImages: [{ uri: ref }] } : {}),
      }),
    },
    account.platform,
    'image',
    60_000,
  );
  let payload = await parseUpstreamJson(submitRes, 'runwayml');
  if (!Array.isArray(payload.output) && typeof payload.id === 'string') {
    const taskUrl = `https://api.dev.runwayml.com/v1/tasks/${encodeURIComponent(payload.id)}`;
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      const pollRes = await proxyFetch(taskUrl, { headers }, account.platform, 'image', 30_000);
      payload = await parseUpstreamJson(pollRes, 'runwayml');
      if (payload.status === 'SUCCEEDED') break;
      if (payload.status === 'FAILED' || payload.status === 'CANCELLED') {
        throw new Error(String(payload.failure || 'Runway image task failed'));
      }
    }
  }
  const outputs = Array.isArray(payload.output) ? payload.output : [];
  return {
    created: Math.floor(Date.now() / 1000),
    data: outputs.filter((u): u is string => typeof u === 'string').map(url => ({ url })),
  };
}

async function generateCloudflareImages(input: ImageGenerationInput): Promise<ImageGenerationResult> {
  const { account, baseUrl, credential, modelId, prompt, size, extraBody, mask } = input;
  const dims = parseDimensions(size, extraBody);
  const refB64 = toRawBase64(collectRefImages(input)[0]);
  const maskB64 = toRawBase64(mask ?? (typeof extraBody?.mask === 'string' ? extraBody.mask : undefined));
  const payload: Record<string, unknown> = {
    prompt,
    ...dims,
    ...(refB64 ? { image_b64: refB64 } : {}),
    ...(maskB64 ? { mask_b64: maskB64 } : {}),
  };
  const res = await proxyFetch(
    `${baseUrl.replace(/\/+$/, '')}/${modelId}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credential}` },
      body: JSON.stringify(payload),
    },
    account.platform,
    'image',
    90_000,
  );
  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${raw.slice(0, 200)}`);
  }
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('application/json')) {
    const json = await res.json() as Record<string, any>;
    const img = json?.result?.image ?? json?.data?.[0]?.b64_json;
    return {
      created: Math.floor(Date.now() / 1000),
      data: typeof img === 'string' && img ? [{ b64_json: img }] : [],
    };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return { created: Math.floor(Date.now() / 1000), data: [{ b64_json: buf.toString('base64') }] };
}

async function generateHuggingfaceImages(input: ImageGenerationInput): Promise<ImageGenerationResult> {
  const { account, credential, modelId, prompt } = input;
  if (!modelId || modelId.includes('..') || modelId.includes('//') || /[?#]/.test(modelId)) {
    throw new Error(`HuggingFace: invalid model ID "${modelId}"`);
  }
  const rawCustom = account.base_url?.trim().replace(/\/+$/, '');
  const base = rawCustom && rawCustom !== 'https://router.huggingface.co/v1'
    ? rawCustom
    : 'https://router.huggingface.co/hf-inference/models';
  const refB64 = toRawBase64(collectRefImages(input)[0]);
  const body = refB64 ? { inputs: refB64, parameters: { prompt } } : { inputs: prompt };
  const res = await proxyFetch(
    `${base}/${modelId}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credential}` },
      body: JSON.stringify(body),
    },
    account.platform,
    'image',
    90_000,
  );
  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${raw.slice(0, 200)}`);
  }
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('application/json')) {
    const json = await res.json() as Record<string, any>;
    const items = Array.isArray(json.data) ? json.data : [];
    return { created: Math.floor(Date.now() / 1000), data: items };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return { created: Math.floor(Date.now() / 1000), data: [{ b64_json: buf.toString('base64') }] };
}

export async function executeImageGeneration(input: ImageGenerationInput): Promise<{
  result: ImageGenerationResult;
  usageUnits: number;
}> {
  const { account, baseUrl, credential, modelId, prompt, n, size, extraBody } = input;

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

  if (account.provider === 'uc-web') {
    let expectedCipher = account.encrypted_key;
    const result = await generateUcWebImages({
      credential,
      prompt,
      modelId,
      size,
      resolution: typeof extraBody?.resolution === 'string' ? extraBody.resolution : undefined,
      platform: account.platform,
      onCredentialUpdate: (nextCredential) => {
        if (updateAccountCredential(account.id, nextCredential, expectedCipher)) {
          expectedCipher = '';
        }
      },
    });
    return { result, usageUnits: Math.max(1, result.data.length) };
  }

  if (isUnsupportedWebImageProvider(account.provider)) {
    throw new Error(`Provider '${account.provider}' does not support image generation`);
  }

  const adapterMap: Record<string, (inp: ImageGenerationInput) => Promise<ImageGenerationResult>> = {
    gemini: generateGeminiImages,
    codex: generateCodexImages,
    antigravity: generateAntigravityImages,
    'fal-ai': generateFalImages,
    'black-forest-labs': generateBflImages,
    'stability-ai': generateStabilityImages,
    runwayml: generateRunwayImages,
    'cloudflare-ai': generateCloudflareImages,
    huggingface: generateHuggingfaceImages,
  };

  const adapter = adapterMap[account.provider];
  if (adapter) {
    const result = await adapter(input);
    return { result, usageUnits: Math.max(1, result.data.length) };
  }

  if (input.isEdit) {
    const refs = collectRefImages(input);
    if (refs.length === 0) {
      throw new Error('At least one image is required for image editing.');
    }
    const form = new FormData();
    const first = decodeImageDataUri(refs[0]);
    form.append('image', first.blob, first.filename);
    if (input.mask) {
      const m = decodeImageDataUri(input.mask);
      form.append('mask', m.blob, 'mask.png');
    }
    form.append('prompt', prompt);
    form.append('model', modelId);
    form.append('n', String(n));
    if (size) form.append('size', size);

    const upstreamRes = await proxyFetch(
      `${baseUrl}/images/edits`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${credential}` },
        body: form,
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
      usageUnits: Math.max(1, items.length),
    };
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
        model: modelId,
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
