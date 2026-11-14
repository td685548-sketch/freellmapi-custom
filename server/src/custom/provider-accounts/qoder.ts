import crypto from 'node:crypto';
import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
  Platform,
} from '@freellmapi/shared/types.js';
import {
  BaseProvider,
  type CompletionOptions,
  type KeyValidationResult,
  providerHttpError,
} from '../../providers/base.js';
import { contentToString, estimateInputTokens } from '../../lib/content.js';
import type { QuotaObservationContext } from '../../services/provider-quota.js';

// RSA public key for COSY encryption (from Qoder IDE v0.9).
export const QODER_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

const QODER_STD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const QODER_CUSTOM_ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!';

const QODER_S2C = new Int16Array(128).fill(-1);
for (let i = 0; i < 64; i++) {
  QODER_S2C[QODER_STD_ALPHABET.charCodeAt(i)] = QODER_CUSTOM_ALPHABET.charCodeAt(i);
}
QODER_S2C['='.charCodeAt(0)] = '$'.charCodeAt(0);

/**
 * Encode plaintext using Qoder's WAF-bypass scheme.
 */
export function qoderEncodeBody(plaintext: Buffer | string): string {
  const buf = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, 'utf8');
  const std = buf.toString('base64');
  const n = std.length;
  const a = Math.floor(n / 3);
  // [tail][mid][head]
  const rearranged = std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a);
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    const c = rearranged.charCodeAt(i);
    out[i] = (c < 128 && QODER_S2C[c] >= 0) ? QODER_S2C[c] : c;
  }
  return out.toString('latin1');
}

function pkcs7Pad(data: Buffer, blockSize: number): Buffer {
  const padding = blockSize - (data.length % blockSize);
  const padded = Buffer.alloc(data.length + padding, padding);
  data.copy(padded, 0);
  return padded;
}

function aesEncryptCbcBase64(plaintext: string, keyStr: string): string {
  const keyBytes = Buffer.from(keyStr, 'utf8');
  if (keyBytes.length !== 16) throw new Error(`aes key must be 16 bytes, got ${keyBytes.length}`);
  const iv = keyBytes.subarray(0, 16);
  const cipher = crypto.createCipheriv('aes-128-cbc', keyBytes, iv);
  cipher.setAutoPadding(false);
  const padded = pkcs7Pad(Buffer.from(plaintext, 'utf8'), 16);
  const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);
  return encrypted.toString('base64');
}

function rsaEncryptBase64(data: string): string {
  const encrypted = crypto.publicEncrypt(
    { key: QODER_RSA_PUBLIC_KEY, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(data, 'utf8'),
  );
  return encrypted.toString('base64');
}

function encryptUserInfo(userInfo: Record<string, unknown>) {
  const aesKey = crypto.randomUUID().slice(0, 16);
  const plaintext = JSON.stringify(userInfo);
  const infoB64 = aesEncryptCbcBase64(plaintext, aesKey);
  const cosyKeyB64 = rsaEncryptBase64(aesKey);
  return { cosyKey: cosyKeyB64, info: infoB64 };
}

function md5Hex(input: Buffer | string): string {
  return crypto.createHash('md5').update(input).digest('hex');
}

function computeSigPath(requestUrl: string): string {
  try {
    const pathname = new URL(requestUrl).pathname || '';
    if (pathname.startsWith('/algo')) return pathname.slice('/algo'.length);
    return pathname;
  } catch {
    return '';
  }
}

export function deriveMachineId(seed?: string): string {
  if (!seed) return crypto.randomUUID();
  const h = crypto.createHash('sha256').update(`qoder-machine\0${seed}`).digest('hex');
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `5${h.slice(13, 16)}`,
    `a${h.slice(17, 20)}`,
    h.slice(20, 32),
  ].join('-');
}

export function buildCosyHeaders(
  body: Buffer | string,
  requestUrl: string,
  creds: { userId: string; authToken: string; machineId?: string; name?: string; email?: string },
): Record<string, string> {
  if (!creds?.userId) throw new Error('cosy: user id is empty');
  if (!creds?.authToken) throw new Error('cosy: auth token is empty');

  const bodyBuf = Buffer.isBuffer(body)
    ? body
    : typeof body === 'string'
      ? Buffer.from(body, 'latin1')
      : Buffer.from(body || []);

  const { cosyKey, info } = encryptUserInfo({
    uid: creds.userId,
    security_oauth_token: creds.authToken,
    name: creds.name || '',
    aid: '',
    email: creds.email || '',
  });

  const timestamp = String(Math.floor(Date.now() / 1000));
  const requestId = crypto.randomUUID();
  const payloadJson = JSON.stringify({
    version: 'v1',
    requestId,
    info,
    cosyVersion: '1.0.0',
    ideVersion: '',
  });
  const payloadB64 = Buffer.from(payloadJson, 'utf8').toString('base64');
  const sigPath = computeSigPath(requestUrl);
  const sigInput = `${payloadB64}\n${cosyKey}\n${timestamp}\n${bodyBuf.toString('latin1')}\n${sigPath}`;
  const sig = md5Hex(Buffer.from(sigInput, 'latin1'));

  const machineId = creds.machineId || deriveMachineId(creds.userId);
  const bodyHash = md5Hex(bodyBuf);
  const bodyLength = String(bodyBuf.length);

  return {
    Authorization: `Bearer COSY.${payloadB64}.${sig}`,
    'Cosy-Key': cosyKey,
    'Cosy-User': creds.userId,
    'Cosy-Date': timestamp,
    'Cosy-Version': '1.0.0',
    'Cosy-Machineid': machineId,
    'Cosy-Machinetoken': machineId,
    'Cosy-Machinetype': '5',
    'Cosy-Machineos': 'x86_64_windows',
    'Cosy-Clienttype': '5',
    'Cosy-Clientip': '127.0.0.1',
    'Cosy-Bodyhash': bodyHash,
    'Cosy-Bodylength': bodyLength,
    'Cosy-Sigpath': sigPath,
    'Cosy-Data-Policy': 'disagree',
    'Cosy-Organization-Id': '',
    'Cosy-Organization-Tags': '',
    'Login-Version': 'v2',
    'X-Request-Id': crypto.randomUUID(),
  };
}

interface CachedQoderCredential {
  authToken: string;
  userId: string;
  expiresAt: number;
}

const credentialCache = new Map<string, CachedQoderCredential>();
const modelConfigCache = new Map<string, { fetchedAt: number; configs: Map<string, Record<string, unknown>> }>();

function defaultModelConfig(key: string): Record<string, unknown> {
  const isReasoning = key === 'dfmodel' || key === 'smodel' || key === 'cmodel' || key.includes('reasoning') || key.includes('r1');
  const isVl = key === 'qfmodel' || key === 'smodel' || key === 'cmodel' || key.includes('flash') || key.includes('vl');
  return {
    key,
    model: '',
    format: 'openai',
    source: 'system',
    url: '',
    is_reasoning: isReasoning,
    is_vl: isVl,
    max_input_tokens: 180000,
    max_output_tokens: 32768,
  };
}

export class QoderProvider extends BaseProvider {
  readonly platform: Platform = 'custom';
  readonly name: string;
  readonly region: 'intl' | 'cn';
  readonly openApiBase: string;
  readonly chatBase: string;
  readonly chatBaseAlt: string;

  constructor(providerId = 'qoder') {
    super();
    this.region = providerId === 'qoder-cn' ? 'cn' : 'intl';
    this.name = providerId === 'qoder-cn' ? 'Qoder CN' : 'Qoder';
    if (this.region === 'cn') {
      this.openApiBase = 'https://openapi.qoder.com.cn';
      this.chatBase = 'https://gateway.qoder.com.cn';
      this.chatBaseAlt = 'https://gateway.qoder.com.cn';
    } else {
      this.openApiBase = 'https://openapi.qoder.sh';
      this.chatBase = 'https://api3.qoder.sh';
      this.chatBaseAlt = 'https://api2.qoder.sh';
    }
  }

  async resolveCredentials(apiKey: string, signal?: AbortSignal): Promise<{ authToken: string; userId: string }> {
    const trimmed = apiKey.trim();
    const cacheKey = `${this.region}:${trimmed}`;
    const cached = credentialCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() + 60_000) {
      return cached;
    }

    if (trimmed.startsWith('pt-')) {
      // PAT Exchange
      const exchangeUrl = `${this.openApiBase}/api/v1/jobToken/exchange`;
      const res = await this.fetchWithTimeout(
        exchangeUrl,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'User-Agent': 'qodercli/1.0.0',
            'Cosy-Version': '1.0.0',
            'Cosy-ClientType': '5',
          },
          body: JSON.stringify({ personal_token: trimmed }),
        },
        15_000,
        { signal, timeoutBounds: 'request' },
      );

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw providerHttpError(res, `Qoder PAT exchange failed (HTTP ${res.status}): ${errText.slice(0, 160)}`, errText);
      }

      const data = await res.json() as { token?: string; expires_in?: number; expires_at?: string };
      if (!data?.token) throw new Error('Qoder PAT exchange returned no token');

      const jobToken = data.token;
      let expiresAt = Date.now() + 24 * 60 * 60 * 1000;
      if (typeof data.expires_in === 'number' && data.expires_in > 0) {
        expiresAt = Date.now() + data.expires_in * 1000;
      } else if (data.expires_at) {
        const parsedTime = Date.parse(data.expires_at);
        if (!Number.isNaN(parsedTime)) expiresAt = parsedTime;
      }

      // Fetch userinfo to get userId
      const userRes = await this.fetchWithTimeout(
        `${this.openApiBase}/api/v1/userinfo`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${jobToken}`,
            Accept: 'application/json',
            'User-Agent': 'qodercli/1.0.0',
          },
        },
        15_000,
        { signal, timeoutBounds: 'request' },
      );

      let userId = 'qoder-user';
      if (userRes.ok) {
        const u = await userRes.json().catch(() => ({})) as Record<string, unknown>;
        userId = String(u.id ?? u.userId ?? u.user_id ?? 'qoder-user');
      }

      const result: CachedQoderCredential = { authToken: jobToken, userId, expiresAt };
      credentialCache.set(cacheKey, result);
      return result;
    }

    // Direct token (dt-... or jt-...)
    const userRes = await this.fetchWithTimeout(
      `${this.openApiBase}/api/v1/userinfo`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${trimmed}`,
          Accept: 'application/json',
          'User-Agent': 'qodercli/1.0.0',
        },
      },
      15_000,
      { signal, timeoutBounds: 'request' },
    );

    let userId = 'qoder-user';
    if (userRes.ok) {
      const u = await userRes.json().catch(() => ({})) as Record<string, unknown>;
      userId = String(u.id ?? u.userId ?? u.user_id ?? 'qoder-user');
    }

    const result: CachedQoderCredential = {
      authToken: trimmed,
      userId,
      expiresAt: Date.now() + 60 * 60 * 1000,
    };
    credentialCache.set(cacheKey, result);
    return result;
  }

  override async validateKey(apiKey: string): Promise<KeyValidationResult> {
    try {
      const creds = await this.resolveCredentials(apiKey);
      const url = `${this.openApiBase}/api/v1/userinfo`;
      const res = await this.fetchWithTimeout(
        url,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${creds.authToken}`,
            Accept: 'application/json',
            'User-Agent': 'qodercli/1.0.0',
          },
        },
        15_000,
        { timeoutBounds: 'request' },
      );

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        return { valid: false, error: `Qoder userinfo failed (${res.status}): ${errText.slice(0, 100)}` };
      }
      return true;
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async getModelConfig(
    creds: { authToken: string; userId: string },
    qoderKey: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const cacheKey = `${this.region}:${creds.userId}`;
    const cached = modelConfigCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < 60 * 60 * 1000) {
      const cfg = cached.configs.get(qoderKey);
      if (cfg) return cfg;
    }

    try {
      const inferenceBase = this.region === 'cn'
        ? this.chatBase
        : (creds.authToken.startsWith('jt-') ? this.chatBaseAlt : this.chatBase);
      const modelListUrl = `${inferenceBase}/algo/api/v2/model/list`;
      const cosyHeaders = buildCosyHeaders(Buffer.alloc(0), modelListUrl, creds);

      const res = await this.fetchWithTimeout(
        modelListUrl,
        {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            'User-Agent': 'qodercli/1.0.0',
            ...cosyHeaders,
          },
        },
        10_000,
        { signal, timeoutBounds: 'request' },
      );

      if (res.ok) {
        const body = await res.json().catch(() => null) as { chat?: Array<Record<string, unknown>> } | null;
        if (body && Array.isArray(body.chat)) {
          const map = new Map<string, Record<string, unknown>>();
          for (const entry of body.chat) {
            if (entry && typeof entry.key === 'string') {
              map.set(entry.key, entry);
            }
          }
          modelConfigCache.set(cacheKey, { fetchedAt: Date.now(), configs: map });
          const found = map.get(qoderKey);
          if (found) return found;
        }
      }
    } catch {
      // Fall through to default config
    }

    return defaultModelConfig(qoderKey);
  }

  override async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
    quotaContext?: QuotaObservationContext,
  ): Promise<ChatCompletionResponse> {
    let content = '';
    let reasoning = '';
    let finishReason = 'stop';
    let usage: ChatCompletionResponse['usage'] | undefined = undefined;
    const id = this.makeId();

    for await (const chunk of this.streamChatCompletion(apiKey, messages, modelId, options, quotaContext)) {
      const choice = chunk.choices?.[0];
      if (choice?.delta?.content) content += choice.delta.content;
      if (choice?.delta?.reasoning_content) reasoning += choice.delta.reasoning_content;
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (chunk.usage) usage = chunk.usage;
    }

    const promptTokens = estimateInputTokens(messages);
    const completionTokens = Math.max(1, Math.ceil(content.length / 4));

    return {
      id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content,
            ...(reasoning ? { reasoning_content: reasoning } : {}),
          },
          finish_reason: finishReason,
        },
      ],
      usage: usage ?? {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    };
  }

  override async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
    _quotaContext?: QuotaObservationContext,
  ): AsyncGenerator<ChatCompletionChunk> {
    const creds = await this.resolveCredentials(apiKey, options?.signal);
    const qoderKey = modelId.replace(/^(?:qoder|qoder-cn|qd)\//, '');
    const modelConfig = await this.getModelConfig(creds, qoderKey, options?.signal);
    const inferenceBase = this.region === 'cn'
      ? this.chatBase
      : (creds.authToken.startsWith('jt-') ? this.chatBaseAlt : this.chatBase);

    const uploadQoderImage = async (dataUrl: string): Promise<string> => {
      const match = /^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl);
      if (!match) return dataUrl;
      const ext = match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase();
      const mime = `image/${match[1].toLowerCase() === 'jpg' ? 'jpeg' : match[1].toLowerCase()}`;
      const imageBuf = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
      const boundary = `----freellmapiQoder${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
      const head = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="image.${ext}"\r\nContent-Type: ${mime}\r\n\r\n`,
      );
      const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
      const body = Buffer.concat([head, imageBuf, tail]);
      const uploadUrl = `${inferenceBase}/algo/api/v2/image/upload?request_id=${crypto.randomUUID()}`;
      const uploadCosy = buildCosyHeaders(body, uploadUrl, {
        userId: creds.userId,
        authToken: creds.authToken,
        machineId: deriveMachineId(creds.userId),
      });
      try {
        const res = await this.fetchWithTimeout(
          uploadUrl,
          {
            method: 'PUT',
            headers: {
              ...uploadCosy,
              Accept: 'application/json',
              'Content-Type': `multipart/form-data; boundary=${boundary}`,
              'Content-Length': String(body.length),
              'AI-CLIENT-TIMESTAMP': String(Math.floor(Date.now() / 1000)),
              'Accept-Encoding': 'identity',
            },
            body,
          },
          30_000,
          { signal: options?.signal },
        );
        if (res.ok) {
          const json = (await res.json().catch(() => null)) as Record<string, any> | null;
          const result = (json?.result && typeof json.result === 'object' ? json.result : json) as Record<string, any> | null;
          const uploaded = result?.imageUrls?.[0] ?? result?.image_urls?.[0]
            ?? result?.imageUrl ?? result?.image_url ?? result?.url ?? result?.ossUrl ?? result?.oss_url;
          if (typeof uploaded === 'string' && uploaded) return uploaded;
        }
      } catch {
        // Fall through to inline fallback for small images
      }
      if (imageBuf.length <= 128 * 1024) return dataUrl;
      throw new Error('Qoder image upload failed.');
    };

    const normalizeQoderContent = async (content: ChatMessage['content']): Promise<unknown> => {
      if (typeof content === 'string') return content;
      if (!Array.isArray(content)) return contentToString(content);
      const blocks: Array<Record<string, unknown>> = [];
      const textParts: string[] = [];
      let hasImage = false;
      for (const item of content) {
        if (!item || typeof item !== 'object') continue;
        const p = item as unknown as Record<string, unknown>;
        let imageUrl: string | null = null;
        if (p.type === 'image_url') {
          imageUrl = typeof p.image_url === 'string'
            ? p.image_url
            : ((p.image_url as { url?: unknown } | undefined)?.url as string | undefined) ?? null;
        } else if (p.type === 'image' && p.source && typeof p.source === 'object') {
          const src = p.source as Record<string, unknown>;
          if (src.type === 'base64' && typeof src.data === 'string') {
            imageUrl = `data:${typeof src.media_type === 'string' ? src.media_type : 'image/png'};base64,${src.data}`;
          } else if (typeof src.url === 'string') {
            imageUrl = src.url;
          }
        }
        if (imageUrl) {
          const resolvedUrl = imageUrl.startsWith('data:image/') ? await uploadQoderImage(imageUrl) : imageUrl;
          blocks.push({ type: 'image_url', image_url: { url: resolvedUrl } });
          hasImage = true;
        } else if (typeof p.text === 'string' && p.text) {
          if (hasImage || blocks.length) blocks.push({ type: 'text', text: p.text });
          else textParts.push(p.text);
        }
      }
      if (!hasImage) return textParts.join('\n');
      if (textParts.length) blocks.unshift({ type: 'text', text: textParts.join('\n') });
      return blocks;
    };

    let systemText = '';
    const filteredMessages: Array<{ role: string; content: unknown }> = [];
    let lastUserText = '';

    for (const m of messages) {
      if (m.role === 'system') {
        systemText = (systemText ? systemText + '\n\n' : '') + contentToString(m.content);
      } else {
        const normalizedContent = await normalizeQoderContent(m.content);
        const text = contentToString(m.content) || (Array.isArray(normalizedContent) ? 'Describe or analyze this image.' : '');
        if (m.role === 'user') lastUserText = text;
        filteredMessages.push({
          role: m.role,
          content: normalizedContent,
        });
      }
    }

    const sessionId = crypto.createHash('sha256').update(`qoder-session:${creds.userId}:${qoderKey}`).digest('hex');
    const recordId = crypto.createHash('sha256').update(`qoder-record:${qoderKey}:${Date.now()}:${Math.random()}`).digest('hex');
    const maxTokens = typeof options?.max_tokens === 'number' && options.max_tokens > 0 ? options.max_tokens : 4096;

    const payload = {
      request_id: crypto.randomUUID(),
      request_set_id: recordId,
      chat_record_id: recordId,
      session_id: sessionId,
      stream: true,
      chat_task: 'FREE_INPUT',
      is_reply: true,
      is_retry: false,
      source: 1,
      version: '3',
      session_type: 'qodercli',
      agent_id: 'agent_common',
      task_id: 'common',
      code_language: '',
      chat_prompt: '',
      image_urls: null,
      aliyun_user_type: '',
      system: systemText,
      messages: filteredMessages,
      tools: options?.tools ?? [],
      parameters: { max_tokens: maxTokens },
      chat_context: {
        chatPrompt: '',
        imageUrls: null,
        extra: {
          context: [],
          modelConfig: { key: qoderKey, is_reasoning: Boolean(modelConfig.is_reasoning) },
          originalContent: lastUserText,
        },
        features: [],
        text: lastUserText,
      },
      model_config: modelConfig,
      business: {
        product: 'cli',
        version: '1.0.0',
        type: 'agent',
        stage: 'start',
        id: crypto.randomUUID(),
        name: lastUserText.slice(0, 30),
        begin_at: Date.now(),
      },
    };

    const rawJson = JSON.stringify(payload);
    const encodedBody = qoderEncodeBody(rawJson);

    const requestUrl = `${inferenceBase}/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`;
    const cosyHeaders = buildCosyHeaders(encodedBody, requestUrl, {
      userId: creds.userId,
      authToken: creds.authToken,
      machineId: deriveMachineId(creds.userId),
    });

    const res = await this.fetchWithTimeout(
      requestUrl,
      {
        method: 'POST',
        headers: {
          ...cosyHeaders,
          'Content-Type': 'text/plain;charset=UTF-8',
          Accept: 'text/event-stream',
          'User-Agent': 'qodercli/1.0.0',
        },
        body: encodedBody,
      },
      options?.timeoutMs ?? 120_000,
      { signal: options?.signal },
    );

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw providerHttpError(res, `${this.name} API error ${res.status}: ${errText.slice(0, 300) || res.statusText}`, errText);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error(`${this.name}: empty response body`);

    const decoder = new TextDecoder();
    const chunkId = this.makeId();
    const created = Math.floor(Date.now() / 1000);
    let buffer = '';
    let emittedAny = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const rawLine of lines) {
          const trimmed = rawLine.trim();
          if (!trimmed || trimmed.startsWith('event:') || trimmed.startsWith(':')) continue;
          if (!trimmed.startsWith('data:')) continue;

          const dataPayload = trimmed.slice(5).trim();
          if (dataPayload === '[DONE]') break;

          let envelope: { statusCodeValue?: number; body?: unknown };
          try {
            envelope = JSON.parse(dataPayload) as { statusCodeValue?: number; body?: unknown };
          } catch {
            continue;
          }

          const statusVal = Number(envelope?.statusCodeValue);
          if (!Number.isNaN(statusVal) && statusVal !== 200) {
            const errBody = typeof envelope.body === 'string' ? envelope.body : JSON.stringify(envelope.body);
            throw new Error(`${this.name} upstream status ${statusVal}: ${errBody.slice(0, 300)}`);
          }

          const innerBody = envelope.body;
          if (!innerBody) continue;

          let parsedInner: Record<string, unknown> | null = null;
          if (typeof innerBody === 'string') {
            if (innerBody.trim() === '[DONE]') break;
            try {
              parsedInner = JSON.parse(innerBody) as Record<string, unknown>;
            } catch {
              continue;
            }
          } else if (typeof innerBody === 'object') {
            parsedInner = innerBody as Record<string, unknown>;
          }

          if (!parsedInner) continue;

          const choices = parsedInner.choices as Array<{
            index?: number;
            delta?: { role?: string; content?: string; reasoning_content?: string };
            finish_reason?: string | null;
          }> | undefined;

          const delta = choices?.[0]?.delta;
          const finishReason = choices?.[0]?.finish_reason || (delta as Record<string, unknown> | undefined)?.finish_reason || null;
          const usage = parsedInner.usage as ChatCompletionChunk['usage'] | undefined;

          if (delta?.content || delta?.reasoning_content || finishReason || usage) {
            emittedAny = true;
            yield {
              id: String(parsedInner.id ?? chunkId),
              object: 'chat.completion.chunk',
              created: Number(parsedInner.created ?? created),
              model: modelId,
              choices: [
                {
                  index: 0,
                  delta: {
                    ...(delta?.role ? { role: delta.role as 'assistant' } : {}),
                    ...(delta?.content ? { content: delta.content } : {}),
                    ...(delta?.reasoning_content ? { reasoning_content: delta.reasoning_content } : {}),
                  },
                  finish_reason: finishReason as 'stop' | 'length' | null,
                },
              ],
              ...(usage ? { usage } : {}),
            };
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }

    if (!emittedAny) {
      // Yield an empty completion if nothing emitted
      yield {
        id: chunkId,
        object: 'chat.completion.chunk',
        created,
        model: modelId,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      };
    }
  }
}
