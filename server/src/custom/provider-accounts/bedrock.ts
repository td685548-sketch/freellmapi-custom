import { createHash, createHmac } from 'node:crypto';
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatMessage,
  Platform,
} from '@freellmapi/shared/types.js';
import {
  BaseProvider,
  type CompletionOptions,
  type KeyValidationOptions,
  type KeyValidationResult,
  providerHttpError,
} from '../../providers/base.js';
import { recordQuotaObservationsFromResponse, type QuotaObservationContext } from '../../services/provider-quota.js';
import {
  DEFAULT_STREAM_STALL_MS,
  anthropicJsonToOpenAIResponse,
  chatToAnthropicRequest,
  createAnthropicStreamState,
  parseAnthropicSseEvent,
} from './wire-helpers.js';

export type BedrockVariant = 'bedrock' | 'bedrock-xai';

export interface BedrockProviderOptions {
  providerId?: BedrockVariant;
  name?: string;
  baseUrl?: string;
  controlPlaneBaseUrl?: string;
  timeoutMs?: number;
  extraHeaders?: Record<string, string>;
}

export interface AwsStaticCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  sessionToken?: string;
}

const AWS_REGION_PATTERN = /^[a-z0-9-]+$/;
const BEDROCK_DEFAULT_REGION = 'us-east-1';
const BEDROCK_ANTHROPIC_VERSION = 'bedrock-2023-05-31';
const MAX_MESSAGE_BYTES = 24 * 1024 * 1024;
const MAX_HEADERS_BYTES = 128 * 1024;
const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) {
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return value >>> 0;
});

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function escapeUri(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function sha256Hex(payload: string): string {
  return createHash('sha256').update(payload ?? '', 'utf8').digest('hex');
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

export function signAwsRequest(opts: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  region: string;
  service: string;
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  doubleEncodePath?: boolean;
  date?: Date;
}): Record<string, string> {
  const {
    method,
    url,
    headers = {},
    body = '',
    region,
    service,
    credentials,
    doubleEncodePath = true,
    date = new Date(),
  } = opts;
  if (!credentials?.accessKeyId || !credentials?.secretAccessKey) {
    throw new Error('AWS SigV4 requires both accessKeyId and secretAccessKey');
  }

  const parsed = new URL(url);
  if (parsed.search) {
    throw new Error(`AWS SigV4 signing does not support query strings (got ${parsed.search})`);
  }

  const amzDate = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body);

  const headersToSign: Record<string, string> = {
    ...headers,
    host: parsed.host,
    'x-amz-date': amzDate,
    ...(credentials.sessionToken ? { 'x-amz-security-token': credentials.sessionToken } : {}),
  };

  const normalized = Object.entries(headersToSign)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([name, value]) => [name.toLowerCase(), String(value).trim().replace(/\s+/g, ' ')] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const canonicalHeaders = normalized.map(([k, v]) => `${k}:${v}\n`).join('');
  const signedHeaders = normalized.map(([k]) => k).join(';');
  const canonicalUri = doubleEncodePath
    ? ((parsed.pathname || '/').split('/').map((seg) => escapeUri(seg)).join('/') || '/')
    : (parsed.pathname || '/');

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = [dateStamp, region, service, 'aws4_request'].reduce<Buffer | string>(
    (key, part) => hmacSha256(key, part),
    `AWS4${credentials.secretAccessKey}`,
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  return {
    ...headersToSign,
    Authorization:
      `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, `
      + `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export function parseEventFrame(data: Uint8Array): { headers: Record<string, any>; payload: Record<string, any> | null } {
  if (!(data instanceof Uint8Array) || data.byteLength < 16) {
    throw new Error('AWS EventStream frame is shorter than 16 bytes');
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const totalLength = view.getUint32(0, false);
  const headersLength = view.getUint32(4, false);
  if (totalLength !== data.byteLength) {
    throw new Error('AWS EventStream frame length does not match its prelude');
  }
  if (totalLength > MAX_MESSAGE_BYTES || headersLength > MAX_HEADERS_BYTES || headersLength > totalLength - 16) {
    throw new Error('AWS EventStream frame bounds are invalid');
  }
  if (view.getUint32(8, false) !== crc32(data.subarray(0, 8))) {
    throw new Error('AWS EventStream prelude CRC mismatch');
  }
  if (view.getUint32(totalLength - 4, false) !== crc32(data.subarray(0, totalLength - 4))) {
    throw new Error('AWS EventStream message CRC mismatch');
  }

  const headers: Record<string, any> = Object.create(null);
  const seen = new Set<string>();
  let offset = 12;
  const headerEnd = offset + headersLength;
  const requireBytes = (count: number) => {
    if (offset + count > headerEnd) throw new Error('AWS EventStream header exceeds bounds');
  };

  while (offset < headerEnd) {
    requireBytes(1);
    const nameLen = data[offset++];
    requireBytes(nameLen + 1);
    const name = textDecoder.decode(data.subarray(offset, offset + nameLen));
    offset += nameLen;
    if (seen.has(name)) throw new Error(`AWS EventStream duplicate header: ${name}`);
    seen.add(name);
    const type = data[offset++];

    if (type === 0 || type === 1) {
      headers[name] = type === 0;
    } else if (type === 2) {
      requireBytes(1);
      headers[name] = view.getInt8(offset);
      offset += 1;
    } else if (type === 3) {
      requireBytes(2);
      headers[name] = view.getInt16(offset, false);
      offset += 2;
    } else if (type === 4) {
      requireBytes(4);
      headers[name] = view.getInt32(offset, false);
      offset += 4;
    } else if (type === 5 || type === 8) {
      requireBytes(8);
      offset += 8;
    } else if (type === 6 || type === 7) {
      requireBytes(2);
      const valueLen = view.getUint16(offset, false);
      offset += 2;
      requireBytes(valueLen);
      const slice = data.subarray(offset, offset + valueLen);
      headers[name] = type === 7 ? textDecoder.decode(slice) : slice;
      offset += valueLen;
    } else if (type === 9) {
      requireBytes(16);
      offset += 16;
    } else {
      throw new Error(`AWS EventStream header ${name} has unknown type ${type}`);
    }
  }

  const payloadBytes = data.subarray(headerEnd, totalLength - 4);
  if (payloadBytes.byteLength === 0) return { headers, payload: null };
  const payloadText = textDecoder.decode(payloadBytes).trim();
  if (!payloadText) return { headers, payload: null };
  return { headers, payload: JSON.parse(payloadText) as Record<string, any> };
}

export function encodeEventFrame(headers: Record<string, string> = {}, payload: Record<string, any> | null = null): Uint8Array {
  const headerChunks = Object.entries(headers).map(([name, value]) => {
    const nameBytes = textEncoder.encode(name);
    const valueBytes = textEncoder.encode(String(value));
    const buf = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
    const dv = new DataView(buf.buffer);
    let cursor = 0;
    buf[cursor++] = nameBytes.length;
    buf.set(nameBytes, cursor);
    cursor += nameBytes.length;
    buf[cursor++] = 7;
    dv.setUint16(cursor, valueBytes.length, false);
    cursor += 2;
    buf.set(valueBytes, cursor);
    return buf;
  });

  const headersLength = headerChunks.reduce((sum, c) => sum + c.length, 0);
  const payloadBytes = payload === null ? new Uint8Array(0) : textEncoder.encode(JSON.stringify(payload));
  const totalLength = 16 + headersLength + payloadBytes.length;
  const frame = new Uint8Array(totalLength);
  const view = new DataView(frame.buffer);
  view.setUint32(0, totalLength, false);
  view.setUint32(4, headersLength, false);
  view.setUint32(8, crc32(frame.subarray(0, 8)), false);

  let offset = 12;
  for (const chunk of headerChunks) {
    frame.set(chunk, offset);
    offset += chunk.length;
  }
  frame.set(payloadBytes, offset);
  view.setUint32(totalLength - 4, crc32(frame.subarray(0, totalLength - 4)), false);
  return frame;
}

export function parseBedrockCredentials(raw: string): AwsStaticCredentials {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Bedrock credentials are required (JSON or accessKeyId:secretAccessKey[:region[:sessionToken]]).');
  }

  let accessKeyId = '';
  let secretAccessKey = '';
  let rawRegion: string | undefined;
  let sessionToken: string | undefined;

  if (trimmed.startsWith('{')) {
    let parsed: Record<string, any>;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error('Bedrock JSON credential is malformed.');
    }
    accessKeyId = String(parsed.accessKeyId ?? parsed.access_key_id ?? '').trim();
    secretAccessKey = String(parsed.secretAccessKey ?? parsed.secret_access_key ?? '').trim();
    rawRegion = typeof parsed.region === 'string' ? parsed.region : undefined;
    sessionToken = typeof parsed.sessionToken === 'string'
      ? parsed.sessionToken.trim() || undefined
      : typeof parsed.session_token === 'string'
        ? parsed.session_token.trim() || undefined
        : undefined;
  } else {
    const parts = trimmed.split(':');
    accessKeyId = (parts[0] ?? '').trim();
    secretAccessKey = (parts[1] ?? '').trim();
    rawRegion = parts[2]?.trim() || undefined;
    sessionToken = parts.length > 3 ? parts.slice(3).join(':').trim() || undefined : undefined;
  }

  if (!accessKeyId || !secretAccessKey) {
    throw new Error('Bedrock credentials require accessKeyId and secretAccessKey.');
  }
  if (accessKeyId.startsWith('ASIA') && !sessionToken) {
    throw new Error('Temporary AWS credentials (ASIA...) require sessionToken.');
  }

  const region = (rawRegion || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || BEDROCK_DEFAULT_REGION).trim();
  if (!AWS_REGION_PATTERN.test(region)) {
    throw new Error(`Invalid AWS region ${JSON.stringify(region)}. Expected format like "us-east-1".`);
  }

  return { accessKeyId, secretAccessKey, region, sessionToken };
}

export class BedrockProvider extends BaseProvider {
  readonly platform: Platform;
  readonly name: string;
  readonly variant: BedrockVariant;
  private readonly baseUrlOverride?: string;
  private readonly controlPlaneOverride?: string;
  private readonly timeoutMs: number;
  private readonly extraHeaders: Record<string, string>;

  constructor(opts: BedrockProviderOptions = {}) {
    super();
    this.variant = opts.providerId ?? 'bedrock';
    this.platform = this.variant as Platform;
    this.name = opts.name ?? (this.variant === 'bedrock-xai' ? 'AWS Bedrock (xAI)' : 'AWS Bedrock');
    this.baseUrlOverride = opts.baseUrl ? opts.baseUrl.replace(/\/+$/, '') : undefined;
    this.controlPlaneOverride = opts.controlPlaneBaseUrl ? opts.controlPlaneBaseUrl.replace(/\/+$/, '') : undefined;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.extraHeaders = { ...opts.extraHeaders };
  }

  private resolveInvokeUrl(modelId: string, region: string, stream: boolean): string {
    const base = this.baseUrlOverride && !this.baseUrlOverride.includes('{region}')
      ? this.baseUrlOverride
      : `https://bedrock-runtime.${region}.amazonaws.com`;
    const action = stream ? 'invoke-with-response-stream' : 'invoke';
    return `${base}/model/${escapeUri(modelId)}/${action}`;
  }

  private resolveControlUrl(region: string): string {
    if (this.controlPlaneOverride) return `${this.controlPlaneOverride}/foundation-models`;
    if (this.baseUrlOverride && !this.baseUrlOverride.includes('{region}') && !this.baseUrlOverride.includes('amazonaws.com')) {
      return `${this.baseUrlOverride}/foundation-models`;
    }
    return `https://bedrock.${region}.amazonaws.com/foundation-models`;
  }

  private buildBody(messages: ChatMessage[], options: CompletionOptions | undefined): string {
    if (this.variant === 'bedrock') {
      return JSON.stringify(chatToAnthropicRequest('', messages, options, {
        includeModel: false,
        includeStream: false,
        anthropicVersion: BEDROCK_ANTHROPIC_VERSION,
      }));
    }
    const body: Record<string, unknown> = { messages };
    if (options?.temperature !== undefined) body.temperature = options.temperature;
    if (options?.max_tokens !== undefined) body.max_tokens = options.max_tokens;
    if (options?.top_p !== undefined) body.top_p = options.top_p;
    if (options?.stop !== undefined) body.stop = options.stop;
    if (options?.tools !== undefined) body.tools = options.tools;
    if (options?.tool_choice !== undefined) body.tool_choice = options.tool_choice;
    return JSON.stringify(body);
  }

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
    quotaContext?: QuotaObservationContext,
  ): Promise<ChatCompletionResponse> {
    const creds = parseBedrockCredentials(apiKey);
    const url = this.resolveInvokeUrl(modelId, creds.region, false);
    const payload = this.buildBody(messages, options);
    const headers = signAwsRequest({
      method: 'POST',
      url,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...this.extraHeaders,
      },
      body: payload,
      region: creds.region,
      service: 'bedrock',
      credentials: creds,
    });

    const res = await this.fetchWithTimeout(
      url,
      { method: 'POST', headers, body: payload, redirect: 'error' },
      options?.timeoutMs ?? this.timeoutMs,
      { signal: options?.signal, timeoutBounds: 'request' },
    );

    recordQuotaObservationsFromResponse(res, {
      platform: this.platform,
      keyId: quotaContext?.keyId,
      providerAccountId: quotaContext?.providerAccountId,
      modelId,
      endpoint: 'invoke',
    });

    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as Record<string, any>;
      const msg = err?.message ?? err?.Message ?? res.statusText;
      throw providerHttpError(res, `${this.name} API error ${res.status}: ${msg}`, err);
    }

    const json = (await res.json()) as Record<string, any>;
    const out = this.variant === 'bedrock'
      ? anthropicJsonToOpenAIResponse(json, modelId)
      : (json as ChatCompletionResponse);
    out._routed_via = { platform: this.platform, model: modelId };
    return out;
  }

  async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
    quotaContext?: QuotaObservationContext,
  ): AsyncGenerator<ChatCompletionChunk> {
    const creds = parseBedrockCredentials(apiKey);
    const url = this.resolveInvokeUrl(modelId, creds.region, true);
    const payload = this.buildBody(messages, options);
    const headers = signAwsRequest({
      method: 'POST',
      url,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/vnd.amazon.eventstream',
        ...this.extraHeaders,
      },
      body: payload,
      region: creds.region,
      service: 'bedrock',
      credentials: creds,
    });

    const res = await this.fetchWithTimeout(
      url,
      { method: 'POST', headers, body: payload, redirect: 'error' },
      options?.timeoutMs ?? this.timeoutMs,
      { signal: options?.signal },
    );

    recordQuotaObservationsFromResponse(res, {
      platform: this.platform,
      keyId: quotaContext?.keyId,
      providerAccountId: quotaContext?.providerAccountId,
      modelId,
      endpoint: 'invoke-with-response-stream',
    });

    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as Record<string, any>;
      const msg = err?.message ?? err?.Message ?? res.statusText;
      throw providerHttpError(res, `${this.name} API error ${res.status}: ${msg}`, err);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No Bedrock response body');

    const stallMs = DEFAULT_STREAM_STALL_MS;
    const firstByteMs = this.firstByteBudgetMs(options?.timeoutMs ?? this.timeoutMs, stallMs);
    let awaitingFirst = true;
    let buffer: Uint8Array = new Uint8Array(0);
    const claudeState = createAnthropicStreamState(modelId);

    try {
      while (true) {
        const { done, value } = awaitingFirst
          ? await this.readWithStallTimeout(() => reader.read(), firstByteMs, this.firstByteTimeoutMessage(firstByteMs))
          : await this.readWithStallTimeout(() => reader.read(), stallMs);
        awaitingFirst = false;

        if (value && value.byteLength > 0) {
          const next = new Uint8Array(buffer.byteLength + value.byteLength);
          next.set(buffer, 0);
          next.set(value, buffer.byteLength);
          buffer = next;
        }

        while (buffer.byteLength >= 12) {
          const dv = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
          const totalLength = dv.getUint32(0, false);
          if (totalLength < 16 || totalLength > MAX_MESSAGE_BYTES) {
            throw new Error('Bedrock EventStream frame bounds are invalid');
          }
          if (buffer.byteLength < totalLength) break;

          const frameBytes = buffer.slice(0, totalLength);
          buffer = buffer.slice(totalLength);

          const frame = parseEventFrame(frameBytes);
          const msgType = frame.headers[':message-type'];
          if (msgType === 'exception' || msgType === 'error') {
            const code = frame.headers[':exception-type'] || frame.headers[':error-code'] || 'api_error';
            const message =
              frame.payload?.message
              || frame.payload?.Message
              || frame.headers[':error-message']
              || `Bedrock returned EventStream ${msgType}`;
            throw new Error(`${this.name} ${code}: ${message}`);
          }

          if (frame.headers[':event-type'] === 'chunk' && typeof frame.payload?.bytes === 'string') {
            const inner = JSON.parse(Buffer.from(frame.payload.bytes, 'base64').toString('utf8')) as Record<string, any>;
            if (this.variant === 'bedrock') {
              for (const chunk of parseAnthropicSseEvent(inner, claudeState)) yield chunk;
            } else if (inner && typeof inner === 'object') {
              yield inner as ChatCompletionChunk;
            }
          }
        }

        if (done) break;
      }
    } finally {
      reader.cancel().catch(() => {});
    }
  }

  async validateKey(
    apiKey: string,
    _quotaContext?: QuotaObservationContext,
    _options?: KeyValidationOptions,
  ): Promise<KeyValidationResult> {
    let creds: AwsStaticCredentials;
    try {
      creds = parseBedrockCredentials(apiKey);
    } catch (err: any) {
      return { valid: false, error: err?.message ?? 'Invalid AWS Bedrock credential format' };
    }

    const url = this.resolveControlUrl(creds.region);
    const headers = signAwsRequest({
      method: 'GET',
      url,
      headers: { Accept: 'application/json' },
      body: '',
      region: creds.region,
      service: 'bedrock',
      credentials: creds,
    });
    const res = await this.fetchWithTimeout(url, { method: 'GET', headers, redirect: 'error' }, 10_000, {
      timeoutBounds: 'request',
    });
    if (res.ok) return true;
    return this.validationResult(res);
  }
}
