import { createHash, randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
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
import { proxyFetch } from '../../lib/proxy.js';
import { assertSafeHttpBaseUrlSync } from '../../lib/url-guard.js';
import { recordQuotaObservationsFromResponse, type QuotaObservationContext } from '../../services/provider-quota.js';
import {
  DEFAULT_STREAM_STALL_MS,
  aggregateStreamToCompletion,
  chatToAnthropicRequest,
  chatToResponsesRequest,
  createAnthropicStreamState,
  createResponsesStreamState,
  parseAnthropicSseEvent,
  parseResponsesSseEvent,
  readFramedSseLines,
} from './wire-helpers.js';

export type OpenCodeVariant = 'opencode' | 'opencode-zen' | 'opencode-go' | 'mimo-free';

export interface OpenCodeProviderOptions {
  providerId: OpenCodeVariant;
  name?: string;
  baseUrl?: string;
  bootstrapUrl?: string;
  timeoutMs?: number;
  extraHeaders?: Record<string, string>;
}

const OPENCODE_UA = 'opencode/latest/2.0.26/cli';
const OPENCODE_CLIENT = 'cli';
const BASE62_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const SESSION_PREFIX_MASK = (1n << 48n) - 1n;
export const OPENCODE_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

const OPENCODE_OVERLOAD_ATTEMPTS = 8;
const OPENCODE_OVERLOAD_BASE_MS = 800;
const OPENCODE_OVERLOAD_MAX_MS = 4000;
const OPENCODE_OVERLOAD_RE = /overloaded/i;

const RESPONSES_FREE_MODELS = new Set([
  'muse-spark-1.2-contributor-free',
  'muse-spark-1.3-contributor-free',
]);
const MESSAGES_FREE_MODELS = new Set(['union-alpha']);
const GO_RESPONSES_MODELS = new Set(['grok-4.6', 'gpt-5.6-luna']);

export const MIMO_SYSTEM_MARKER =
  'You are MiMoCode, an interactive CLI tool that helps users with software engineering tasks.';
const MIMO_BOOTSTRAP_URL = 'https://api.xiaomimimo.com/api/free-ai/bootstrap';
const MIMO_USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
];

const FINGERPRINT_TOOLS: Record<'read' | 'shell', { description: string; parameters: Record<string, unknown> }> = {
  read: {
    description:
      'Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File or directory to read' },
        offset: { type: 'integer', minimum: 0, description: 'The line or directory entry to start reading from (1-based)' },
        limit: { type: 'integer', minimum: 0, description: 'The maximum number of lines or directory entries to read (defaults to and capped at 2000)' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  shell: {
    description:
      'Execute a shell command and return its output. Commands run on Linux using bash. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command string to execute' },
        workdir: { type: 'string', description: 'Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead.' },
        timeout: { type: 'integer', minimum: 0, description: 'Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default.' },
        background: { type: 'boolean', description: 'Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use \'&\' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
};

const ENV_PROMPT_MARKER = [
  'Here is some useful information about the environment you are running in:',
  '<env>',
  `  Working directory: ${process.cwd()}`,
  `  Workspace root folder: ${process.cwd()}`,
  '  Is directory a git repo: no',
  `  Platform: ${process.platform}`,
  `  Prefer ${path.join(os.tmpdir(), 'opencode')} over generic system temporary directories such as /tmp; it is pre-created and approved for external access.`,
  '</env>',
].join('\n');

let lastTimestamp = 0;
let sessionCounter = 0;
const stableSessions = new Map<string, { sessionId: string; lastUsed: number }>();

interface CachedJwt {
  jwt: string;
  expiresAt: number;
}
const mimoJwtCache = new Map<string, CachedJwt>();

export function _resetOpenCodeStateForTests(): void {
  stableSessions.clear();
  mimoJwtCache.clear();
}

function unstableRandom(): string {
  const bytes = randomBytes(14);
  let out = '';
  for (let i = 0; i < 14; i++) out += BASE62_CHARS[bytes[i] % 62];
  return out;
}

function descendingTimeHex(timestampMs: number, counterVal: number): string {
  return (~(BigInt(timestampMs) * 0x1000n + BigInt(counterVal)) & SESSION_PREFIX_MASK)
    .toString(16)
    .padStart(12, '0');
}

export function generateOpenCodeSessionId(timestamp = Date.now()): string {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp;
    sessionCounter = 0;
  }
  sessionCounter += 1;
  return `ses_${descendingTimeHex(timestamp, sessionCounter)}${unstableRandom()}`;
}

function getOrCreateStableSession(identity: string): string {
  const existing = stableSessions.get(identity);
  if (existing && Date.now() - existing.lastUsed < 60 * 60_000) {
    existing.lastUsed = Date.now();
    return existing.sessionId;
  }
  const sessionId = generateOpenCodeSessionId();
  if (stableSessions.size >= 1000) {
    const oldest = stableSessions.keys().next().value;
    if (oldest) stableSessions.delete(oldest);
  }
  stableSessions.set(identity, { sessionId, lastUsed: Date.now() });
  return sessionId;
}

export function forgetOpenCodeSession(sessionId: string): boolean {
  let removed = false;
  for (const [k, v] of stableSessions) {
    if (v.sessionId === sessionId) {
      stableSessions.delete(k);
      removed = true;
    }
  }
  return removed;
}

function baseModelId(model: string): string {
  return model.replace(/\([^()]+\)\s*$/, '').trim();
}

function isMuseSpark(model: string): boolean {
  return /^muse-spark/i.test(baseModelId(model));
}

function isOpenCodeResponsesModel(model: string): boolean {
  const base = baseModelId(model);
  return RESPONSES_FREE_MODELS.has(base) || isMuseSpark(base);
}

function isOpenCodeMessagesModel(model: string): boolean {
  return MESSAGES_FREE_MODELS.has(baseModelId(model));
}

function isOpenCodeGoResponsesModel(model: string): boolean {
  const base = baseModelId(model);
  return GO_RESPONSES_MODELS.has(base) || isMuseSpark(base);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('Aborted'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function readToolName(tool: Record<string, any>): string {
  if (typeof tool.name === 'string' && tool.name.trim()) return tool.name.trim();
  if (typeof tool.function?.name === 'string' && tool.function.name.trim()) return tool.function.name.trim();
  return '';
}

function withToolName(tool: Record<string, any>, nextName: string): Record<string, any> {
  if (tool.function && typeof tool.function === 'object') {
    return { ...tool, function: { ...tool.function, name: nextName } };
  }
  return { ...tool, name: nextName };
}

function applyFingerprintToolsToBody(
  body: Record<string, any>,
  shape: 'responses' | 'chat' | 'claude',
): Map<string, string> {
  const renameMap = new Map<string, string>();
  const flat = shape === 'responses';
  const rawTools = Array.isArray(body.tools) ? body.tools : [];
  const taken = new Set(rawTools.map((t: Record<string, any>) => readToolName(t)).filter(Boolean));
  const seenFingerprint = new Set<string>();
  const outTools: Array<Record<string, any>> = [];

  for (const tool of rawTools) {
    if (!tool || typeof tool !== 'object') continue;
    const name = readToolName(tool);
    if (/terminal/i.test(name)) {
      let alias = 'run_command';
      for (let i = 2; taken.has(alias); i++) alias = `run_command${i}`;
      taken.add(alias);
      renameMap.set(alias, name);
      outTools.push(withToolName(tool, alias));
      continue;
    }
    if (name === 'read' || name === 'shell') {
      if (seenFingerprint.has(name)) continue;
      seenFingerprint.add(name);
      const spec = FINGERPRINT_TOOLS[name];
      const def = tool.function && typeof tool.function === 'object' ? tool.function : tool;
      if (def.description === spec.description && JSON.stringify(def.parameters) === JSON.stringify(spec.parameters)) {
        outTools.push(tool);
      } else {
        let alias = `${name}_client`;
        for (let i = 2; taken.has(alias); i++) alias = `${name}_client${i}`;
        taken.add(alias);
        renameMap.set(alias, name);
        outTools.push(withToolName(tool, alias));
      }
      continue;
    }
    outTools.push(tool);
  }

  for (const fp of ['read', 'shell'] as const) {
    if (outTools.some((t) => readToolName(t) === fp)) continue;
    const spec = FINGERPRINT_TOOLS[fp];
    outTools.push(
      flat
        ? { type: 'function', name: fp, description: spec.description, parameters: spec.parameters, strict: false }
        : shape === 'claude'
          ? { name: fp, description: spec.description, input_schema: spec.parameters }
          : { type: 'function', function: { name: fp, description: spec.description, parameters: spec.parameters } },
    );
  }
  body.tools = outTools;

  if (shape === 'responses') {
    const existing = typeof body.instructions === 'string' ? body.instructions : '';
    if (!existing.includes('<env>')) {
      body.instructions = existing.trim() ? `${existing}\n\n${ENV_PROMPT_MARKER}` : ENV_PROMPT_MARKER;
    }
    if (!body.tool_choice || body.tool_choice === 'none') body.tool_choice = 'auto';
  } else if (shape === 'claude') {
    const existing = typeof body.system === 'string' ? body.system : '';
    if (!existing.includes('<env>')) {
      body.system = existing.trim() ? `${existing}\n\n${ENV_PROMPT_MARKER}` : ENV_PROMPT_MARKER;
    }
  } else if (Array.isArray(body.messages)) {
    const hasEnv = body.messages.some(
      (m: any) => m?.role === 'system' && typeof m.content === 'string' && m.content.includes('<env>'),
    );
    if (!hasEnv) {
      const idx = body.messages.findIndex((m: any) => m?.role === 'system' && typeof m.content === 'string');
      if (idx >= 0) {
        body.messages[idx] = {
          ...body.messages[idx],
          content: `${body.messages[idx].content}\n\n${ENV_PROMPT_MARKER}`,
        };
      } else {
        body.messages = [{ role: 'system', content: ENV_PROMPT_MARKER }, ...body.messages];
      }
    }
  }

  return renameMap;
}

function restoreChunkToolNames(chunk: ChatCompletionChunk, renameMap: Map<string, string>): ChatCompletionChunk {
  if (renameMap.size === 0) return chunk;
  const choice = chunk.choices?.[0];
  const calls = choice?.delta?.tool_calls as Array<Record<string, any>> | undefined;
  if (!Array.isArray(calls) || calls.length === 0) return chunk;
  let changed = false;
  const nextCalls = calls.map((c) => {
    const name = c?.function?.name;
    if (typeof name === 'string' && renameMap.has(name)) {
      changed = true;
      return { ...c, function: { ...c.function, name: renameMap.get(name)! } };
    }
    return c;
  });
  if (!changed) return chunk;
  return {
    ...chunk,
    choices: [{
      ...choice,
      delta: { ...choice.delta, tool_calls: nextCalls as ChatCompletionChunk['choices'][0]['delta']['tool_calls'] },
    }],
  };
}

function mimoFingerprint(): string {
  let username = 'unknown-user';
  try { username = os.userInfo().username; } catch { /* ignore */ }
  const cpu = (os.cpus()[0]?.model || 'unknown-cpu').trim();
  const seed = `${os.hostname()}|${os.platform()}|${os.arch()}|${cpu}|${username}`;
  return createHash('sha256').update(seed).digest('hex');
}

function parseJwtExpMs(jwt: string): number {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8'));
    if (typeof payload.exp === 'number') return payload.exp * 1000;
  } catch { /* fallback below */ }
  return Date.now() + 3000 * 1000;
}

function injectMimoMarker(messages: ChatMessage[]): ChatMessage[] {
  const hasMarker = messages.some(
    (m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes(MIMO_SYSTEM_MARKER),
  );
  if (hasMarker) return messages;
  return [{ role: 'system', content: MIMO_SYSTEM_MARKER }, ...messages];
}

export async function fetchOpenCodeFreeModels(baseUrl = 'https://opencode.ai/zen/v1'): Promise<Array<{ id: string; name: string }>> {
  const clean = baseUrl.replace(/\/+$/, '');
  const modelsUrl = clean.endsWith('/models') ? clean : `${clean}/models`;
  try {
    assertSafeHttpBaseUrlSync(modelsUrl);
    const res = await proxyFetch(modelsUrl, { redirect: 'error', signal: AbortSignal.timeout(8000) }, 'opencode', 'unknown');
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: Array<{ id?: string; name?: string }> };
    if (!Array.isArray(data?.data)) return [];
    return data.data
      .filter((m) => typeof m?.id === 'string' && m.id.trim())
      .map((m) => ({ id: m.id!.trim(), name: (m.name ?? m.id!).trim() }));
  } catch {
    return [];
  }
}

export class OpenCodeProvider extends BaseProvider {
  readonly platform: Platform;
  readonly name: string;
  readonly variant: OpenCodeVariant;
  private readonly baseUrl: string;
  private readonly originUrl: string;
  private readonly bootstrapUrl: string;
  private readonly timeoutMs: number;
  private readonly extraHeaders: Record<string, string>;

  constructor(opts: OpenCodeProviderOptions) {
    super();
    this.variant = opts.providerId;
    this.platform = opts.providerId as Platform;
    this.keyless = opts.providerId === 'opencode' || opts.providerId === 'mimo-free';
    this.name =
      opts.name ??
      (opts.providerId === 'opencode'
        ? 'OpenCode Free'
        : opts.providerId === 'opencode-go'
          ? 'OpenCode Go'
          : opts.providerId === 'mimo-free'
            ? 'Xiaomi MiMo Free'
            : 'OpenCode Zen');
    const defaultBase =
      opts.providerId === 'opencode-go'
        ? 'https://opencode.ai/zen/go/v1'
        : opts.providerId === 'mimo-free'
          ? 'https://api.xiaomimimo.com/api/free-ai/openai/chat'
          : 'https://opencode.ai/zen/v1';
    this.baseUrl = (opts.baseUrl || defaultBase).replace(/\/+$/, '');
    this.originUrl = this.deriveOrigin(this.baseUrl);
    this.bootstrapUrl = opts.bootstrapUrl ?? (opts.baseUrl ? `${this.originUrl}/api/free-ai/bootstrap` : MIMO_BOOTSTRAP_URL);
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.extraHeaders = { ...opts.extraHeaders };
  }

  private deriveOrigin(raw: string): string {
    try {
      const u = new URL(raw);
      return u.origin;
    } catch {
      return raw.replace(/\/+(zen\/v1|inference\/v1|zen\/go\/v1|api\/free-ai\/openai\/chat)$/i, '');
    }
  }

  private resolveUrl(modelId: string): { url: string; lane: 'openai' | 'responses' | 'messages' } {
    if (this.variant === 'mimo-free') {
      return { url: this.baseUrl, lane: 'openai' };
    }
    if (this.variant === 'opencode') {
      if (isOpenCodeResponsesModel(modelId)) {
        return { url: `${this.originUrl}/inference/v1/responses`, lane: 'responses' };
      }
      if (isOpenCodeMessagesModel(modelId)) {
        return { url: `${this.originUrl}/inference/v1/messages`, lane: 'messages' };
      }
      return { url: `${this.originUrl}/inference/v1/chat/completions`, lane: 'openai' };
    }
    if (this.variant === 'opencode-go') {
      if (isOpenCodeGoResponsesModel(modelId)) {
        return { url: `${this.originUrl}/inference/go/openai/v1/responses`, lane: 'responses' };
      }
      return { url: `${this.baseUrl}/chat/completions`, lane: 'openai' };
    }
    // opencode-zen
    if (isMuseSpark(modelId)) {
      return { url: `${this.baseUrl}/responses`, lane: 'responses' };
    }
    return { url: `${this.baseUrl}/chat/completions`, lane: 'openai' };
  }

  private async getMimoJwt(forceRefresh = false): Promise<string> {
    const cached = mimoJwtCache.get(this.bootstrapUrl);
    if (!forceRefresh && cached && Date.now() < cached.expiresAt - 300_000) {
      return cached.jwt;
    }
    const ua = MIMO_USER_AGENTS[Math.floor(Math.random() * MIMO_USER_AGENTS.length)];
    const res = await this.fetchWithTimeout(
      this.bootstrapUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': ua },
        body: JSON.stringify({ client: mimoFingerprint() }),
      },
      15_000,
      { timeoutBounds: 'request' },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw providerHttpError(res, `MiMo Free bootstrap failed (${res.status}): ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as { jwt?: string };
    if (!data?.jwt) throw new Error('MiMo Free bootstrap returned no JWT');
    mimoJwtCache.set(this.bootstrapUrl, { jwt: data.jwt, expiresAt: parseJwtExpMs(data.jwt) });
    return data.jwt;
  }

  private async executeMimoFree(
    messages: ChatMessage[],
    modelId: string,
    options: CompletionOptions | undefined,
    stream: boolean,
  ): Promise<Response> {
    const sessionId = `ses_${randomBytes(12).toString('hex')}`;
    const body = JSON.stringify({
      model: modelId,
      messages: injectMimoMarker(messages),
      temperature: options?.temperature,
      max_tokens: options?.max_tokens,
      top_p: options?.top_p,
      stop: options?.stop,
      tools: options?.tools,
      tool_choice: options?.tool_choice,
      stream,
    });

    for (let attempt = 0; attempt < 2; attempt++) {
      const jwt = await this.getMimoJwt(attempt > 0);
      const ua = MIMO_USER_AGENTS[Math.floor(Math.random() * MIMO_USER_AGENTS.length)];
      const res = await this.fetchWithTimeout(
        this.baseUrl,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Mimo-Source': 'mimocode-cli-free',
            'User-Agent': ua,
            'x-session-affinity': sessionId,
            Accept: stream ? 'text/event-stream' : 'application/json',
            Authorization: `Bearer ${jwt}`,
            ...this.extraHeaders,
          },
          body,
        },
        options?.timeoutMs ?? this.timeoutMs,
        { signal: options?.signal, timeoutBounds: stream ? 'headers' : 'request' },
      );
      if ((res.status === 401 || res.status === 403) && attempt === 0) {
        res.body?.cancel?.().catch(() => {});
        mimoJwtCache.delete(this.bootstrapUrl);
        continue;
      }
      return res;
    }
    throw new Error('MiMo Free request failed');
  }

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
    quotaContext?: QuotaObservationContext,
  ): Promise<ChatCompletionResponse> {
    if (this.variant === 'mimo-free') {
      const res = await this.executeMimoFree(messages, modelId, options, false);
      recordQuotaObservationsFromResponse(res, {
        platform: this.platform,
        keyId: quotaContext?.keyId,
        providerAccountId: quotaContext?.providerAccountId,
        modelId,
        endpoint: 'chat/completions',
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as Record<string, any>;
        throw providerHttpError(res, `${this.name} API error ${res.status}: ${err?.error?.message ?? res.statusText}`, err);
      }
      const data = (await res.json()) as ChatCompletionResponse;
      data._routed_via = { platform: this.platform, model: modelId };
      return data;
    }

    const out = await aggregateStreamToCompletion(
      this.streamChatCompletion(apiKey, messages, modelId, options, quotaContext),
      modelId,
    );
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
    if (this.variant === 'mimo-free') {
      const res = await this.executeMimoFree(messages, modelId, options, true);
      recordQuotaObservationsFromResponse(res, {
        platform: this.platform,
        keyId: quotaContext?.keyId,
        providerAccountId: quotaContext?.providerAccountId,
        modelId,
        endpoint: 'chat/completions',
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as Record<string, any>;
        throw providerHttpError(res, `${this.name} API error ${res.status}: ${err?.error?.message ?? res.statusText}`, err);
      }
      yield* this.readSseStream(res, { firstByteTimeoutMs: options?.timeoutMs ?? this.timeoutMs });
      return;
    }

    const { url, lane } = this.resolveUrl(modelId);
    const identity = `${this.variant}:${quotaContext?.keyId ?? apiKey ?? 'anon'}`;
    let sessionId = getOrCreateStableSession(identity);

    let body: Record<string, any>;
    if (lane === 'responses') {
      body = chatToResponsesRequest(modelId, messages, options);
    } else if (lane === 'messages') {
      body = chatToAnthropicRequest(modelId, messages, options, { includeModel: true, includeStream: true });
    } else {
      body = {
        model: modelId,
        messages,
        temperature: options?.temperature,
        max_tokens: options?.max_tokens,
        top_p: options?.top_p,
        stop: options?.stop,
        tools: options?.tools,
        tool_choice: options?.tool_choice,
        stream: true,
      };
      if (options?.reasoning_effort && String(options.reasoning_effort) !== 'auto') {
        body.reasoning_effort = options.reasoning_effort;
      }
    }

    const renameMap =
      this.variant === 'opencode'
        ? applyFingerprintToolsToBody(body, lane === 'responses' ? 'responses' : lane === 'messages' ? 'claude' : 'chat')
        : new Map<string, string>();

    const authValue = this.variant === 'opencode' ? 'Bearer public' : `Bearer ${apiKey}`;
    const maxAttempts = this.variant === 'opencode' ? OPENCODE_OVERLOAD_ATTEMPTS : 1;

    let res!: Response;
    for (let attempt = 1; ; attempt++) {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: authValue,
        'x-opencode-session': sessionId,
        Accept: 'text/event-stream',
        ...this.extraHeaders,
      };
      if (this.variant === 'opencode') {
        headers['User-Agent'] = OPENCODE_UA;
        headers['x-opencode-client'] = OPENCODE_CLIENT;
        headers['x-opencode-session-id'] = sessionId;
        headers['x-session-affinity'] = sessionId;
        headers['x-session-id'] = sessionId;
        headers['x-opencode-project'] = 'global';
      }
      if (lane === 'messages') headers['anthropic-version'] = '2023-06-01';

      res = await this.fetchWithTimeout(
        url,
        { method: 'POST', headers, body: JSON.stringify(body) },
        options?.timeoutMs ?? this.timeoutMs,
        { signal: options?.signal },
      );

      if (this.variant === 'opencode' && (res.status === 429 || res.status === 403)) {
        const text = await res.clone().text().catch(() => '');
        if (res.status === 429 && OPENCODE_OVERLOAD_RE.test(text) && attempt < maxAttempts) {
          res.body?.cancel?.().catch(() => {});
          const backoff = Math.min(OPENCODE_OVERLOAD_BASE_MS * attempt, OPENCODE_OVERLOAD_MAX_MS);
          await sleep(backoff + Math.random() * 250, options?.signal);
          sessionId = getOrCreateStableSession(identity);
          continue;
        }
        forgetOpenCodeSession(sessionId);
      }
      break;
    }

    recordQuotaObservationsFromResponse(res, {
      platform: this.platform,
      keyId: quotaContext?.keyId,
      providerAccountId: quotaContext?.providerAccountId,
      modelId,
      endpoint: lane,
    });

    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as Record<string, any>;
      throw providerHttpError(
        res,
        `${this.name} API error ${res.status}: ${err?.error?.message ?? err?.message ?? res.statusText}`,
        err,
      );
    }

    if (lane === 'openai') {
      for await (const chunk of this.readSseStream(res, { firstByteTimeoutMs: options?.timeoutMs ?? this.timeoutMs })) {
        yield restoreChunkToolNames(chunk, renameMap);
      }
      return;
    }

    const stallMs = DEFAULT_STREAM_STALL_MS;
    const firstByteMs = this.firstByteBudgetMs(options?.timeoutMs ?? this.timeoutMs, stallMs);
    const lines = readFramedSseLines(
      res,
      (read, ms, msg) => this.readWithStallTimeout(read, ms, msg),
      firstByteMs,
      stallMs,
      this.firstByteTimeoutMessage(firstByteMs),
    );

    if (lane === 'responses') {
      const state = createResponsesStreamState(modelId);
      for await (const { data } of lines) {
        if (!data || data === '[DONE]') break;
        let parsed: Record<string, any>;
        try { parsed = JSON.parse(data); } catch { continue; }
        for (const chunk of parseResponsesSseEvent(parsed, state)) {
          yield restoreChunkToolNames(chunk, renameMap);
        }
      }
      return;
    }

    const state = createAnthropicStreamState(modelId);
    for await (const { data } of lines) {
      if (!data || data === '[DONE]') break;
      let parsed: Record<string, any>;
      try { parsed = JSON.parse(data); } catch { continue; }
      for (const chunk of parseAnthropicSseEvent(parsed, state)) {
        yield restoreChunkToolNames(chunk, renameMap);
      }
    }
  }

  async validateKey(
    apiKey: string,
    _quotaContext?: QuotaObservationContext,
    _options?: KeyValidationOptions,
  ): Promise<KeyValidationResult> {
    if (this.variant === 'mimo-free') {
      try {
        await this.getMimoJwt(true);
        return true;
      } catch (err: any) {
        return { valid: false, error: err?.message ?? 'MiMo Free bootstrap validation failed' };
      }
    }

    const modelsUrl = `${this.baseUrl}/models`;
    const headers: Record<string, string> = {};
    if (this.variant !== 'opencode') headers.Authorization = `Bearer ${apiKey}`;
    const res = await this.fetchWithTimeout(modelsUrl, { method: 'GET', headers }, 10_000, { timeoutBounds: 'request' });
    if (res.ok) return true;
    return this.validationResult(res);
  }
}
