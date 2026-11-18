import crypto from 'node:crypto';
import type {
  Scope,
  SemanticCacheBypassReason,
  SemanticCacheConfig,
  Wire,
} from '@freellmapi/shared/ai-platform-semantic-cache.js';
import { getDb } from '../../../db/index.js';
import { normalizeScope } from '../scope.js';
import { extractCallerLanguage, parseCallerVarsHeader } from '../prompts/render.js';
import { getPublishedPrompt } from '../prompts/store.js';
import { isVolatileSystemMessage } from '../wire/extract.js';

export const SEMANTIC_CACHE_CONTRACT_SCHEMA = 1;

export const GENERATION_PARAM_KEYS = [
  'reasoning',
  'reasoning_effort',
  'max_tokens',
  'max_completion_tokens',
  'max_output_tokens',
  'top_p',
  'top_k',
  'seed',
  'stop',
  'stop_sequences',
  'presence_penalty',
  'frequency_penalty',
  'repetition_penalty',
  'logit_bias',
  'effort',
  'thinking',
  'parallel_tool_calls',
  'functions',
  'function_call',
  'n',
  'logprobs',
  'top_logprobs',
  'text',
  'verbosity',
  'output_config',
  'generationConfig',
  'generation_config',
  'prediction',
  'modalities',
  'audio',
  'web_search_options',
  'search_parameters',
  'service_tier',
] as const;

export type GenerationParamKey = (typeof GENERATION_PARAM_KEYS)[number];

export interface SignatureConstraints extends Partial<Record<GenerationParamKey, unknown>> {
  tools?: unknown;
  tool_choice?: unknown;
  toolChoice?: unknown;
  response_format?: unknown;
  responseFormat?: unknown;
  text_format?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Deterministic canonical JSON serializer: sorts object keys recursively and omits
 * `undefined` properties while preserving `null`, `0`, `false`, and `""`.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  const entries = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
  return `{${entries.join(',')}}`;
}

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

function normalizeDefaultableParam(key: GenerationParamKey, value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (key === 'top_p' && value === 1) return undefined;
  if (key === 'n' && value === 1) return undefined;
  if ((key === 'presence_penalty' || key === 'frequency_penalty') && value === 0) {
    return undefined;
  }
  return value;
}

/**
 * Extracts response-shaping and generation controls from a request body.
 * Two requests that agree on conversation text but disagree on output controls
 * (`tools`, `tool_choice`, `response_format`, `text.format`, `reasoning_effort`,
 * `thinking`, `seed`, `max_tokens`, `stop`, `modalities`, etc.) are never interchangeable.
 */
export function outputContractOf(body: unknown): SignatureConstraints | null {
  const record = asRecord(body);
  if (!record) return null;

  const textObj = asRecord(record.text);
  const contract: SignatureConstraints = {};

  if (record.response_format != null) {
    contract.response_format = record.response_format;
    contract.responseFormat = record.response_format;
  }
  if (textObj?.format != null) {
    contract.text_format = textObj.format;
  }
  if (record.tools != null) {
    contract.tools = record.tools;
  }
  if (record.tool_choice != null) {
    contract.tool_choice = record.tool_choice;
    contract.toolChoice = record.tool_choice;
  }

  for (const key of GENERATION_PARAM_KEYS) {
    const normalized = normalizeDefaultableParam(key, record[key]);
    if (normalized !== undefined) {
      contract[key] = normalized;
    }
  }

  return Object.keys(contract).length > 0 ? contract : null;
}

function hasTable(table: string): boolean {
  try {
    return Boolean(
      getDb()
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table),
    );
  } catch {
    return false;
  }
}

/**
 * Computes a deterministic hash of the scope's currently active published prompt
 * (version, body, and declared variables) so publishing or restoring a prompt
 * automatically invalidates stale exact and semantic cache entries.
 */
export function computePromptVersionHash(scope: Scope): string {
  const norm = normalizeScope(scope);
  try {
    const published = getPublishedPrompt(norm);
    if (published) {
      return sha256Hex(
        canonicalJson({
          schema: 1,
          version: published.version,
          body: published.body,
          variables: published.variables,
        }),
      );
    }
  } catch {
    // Fall through to underlying scope tables if prompt versions table is unavailable.
  }

  let fallbackPrompt = '';
  try {
    const db = getDb();
    if (norm.kind === 'profile' && hasTable('client_profiles')) {
      const row = db
        .prepare('SELECT system_prompt FROM client_profiles WHERE id = ?')
        .get(Number(norm.id)) as { system_prompt?: string | null } | undefined;
      fallbackPrompt = row?.system_prompt ?? '';
    } else if (norm.kind === 'support_tenant' && hasTable('x_support_tenants')) {
      const row = db
        .prepare('SELECT system_prompt FROM x_support_tenants WHERE id = ?')
        .get(Number(norm.id)) as { system_prompt?: string | null } | undefined;
      fallbackPrompt = row?.system_prompt ?? '';
    } else if (norm.kind === 'agent' && hasTable('custom_ai_agents')) {
      const row = db
        .prepare('SELECT system_prompt FROM custom_ai_agents WHERE id = ?')
        .get(norm.id) as { system_prompt?: string | null } | undefined;
      fallbackPrompt = row?.system_prompt ?? '';
    }
  } catch {
    fallbackPrompt = '';
  }

  return sha256Hex(
    canonicalJson({
      schema: 1,
      version: 0,
      body: fallbackPrompt,
      variables: [],
    }),
  );
}

function getHeaderString(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  for (const [k, val] of Object.entries(headers)) {
    if (k.toLowerCase() !== target) continue;
    return Array.isArray(val) ? val[0] : val;
  }
  return undefined;
}

export function hasBypassHeaders(
  headers: Record<string, string | string[] | undefined> | undefined,
): SemanticCacheBypassReason | null {
  const cacheControl = (getHeaderString(headers, 'cache-control') ?? '').toLowerCase();
  if (cacheControl.includes('no-store') || cacheControl.includes('no-cache')) {
    return 'cache_control_no_store';
  }

  const cacheHeader = (getHeaderString(headers, 'x-freellm-cache') ?? '').trim().toLowerCase();
  if (
    cacheHeader === 'off' ||
    cacheHeader === 'semantic-off' ||
    cacheHeader === 'no' ||
    cacheHeader === '0' ||
    cacheHeader === 'false' ||
    cacheHeader === 'bypass' ||
    cacheHeader === 'skip'
  ) {
    return 'cache_header_off';
  }

  return null;
}

export function extractRequestTemperature(body: unknown): number | undefined {
  const rec = asRecord(body);
  if (!rec) return undefined;
  if (rec.temperature !== undefined && rec.temperature !== null) {
    return typeof rec.temperature === 'number' ? rec.temperature : Number.NaN;
  }
  const genCfg = asRecord(rec.generationConfig) ?? asRecord(rec.generation_config);
  if (genCfg && genCfg.temperature !== undefined && genCfg.temperature !== null) {
    return typeof genCfg.temperature === 'number' ? genCfg.temperature : Number.NaN;
  }
  return undefined;
}

/**
 * True when the request body contains tool-call turns (`tool_calls`, `function_call`,
 * `role: "tool"|"function"`, Anthropic `tool_use`/`tool_result`, Responses `function_call*`,
 * or Gemini `functionCall`/`functionResponse`).
 */
export function requestCarriesToolCalls(body: unknown): boolean {
  const rec = asRecord(body);
  if (!rec) return false;

  if (rec.function_call != null && rec.function_call !== 'none' && rec.function_call !== 'auto') {
    return true;
  }

  const messages = Array.isArray(rec.messages) ? rec.messages : [];
  for (const item of messages) {
    const msg = asRecord(item);
    if (!msg) continue;
    if (msg.role === 'tool' || msg.role === 'function') return true;
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) return true;
    if (msg.function_call != null) return true;
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        const b = asRecord(block);
        if (b && (b.type === 'tool_use' || b.type === 'tool_result')) return true;
      }
    }
  }

  const inputItems = Array.isArray(rec.input) ? rec.input : [];
  for (const item of inputItems) {
    const it = asRecord(item);
    if (!it) continue;
    if (
      it.type === 'function_call' ||
      it.type === 'function_call_output' ||
      it.type === 'custom_tool_call' ||
      it.type === 'custom_tool_call_output'
    ) {
      return true;
    }
  }

  const contents = Array.isArray(rec.contents) ? rec.contents : [];
  for (const cand of contents) {
    const c = asRecord(cand);
    const parts = c && Array.isArray(c.parts) ? c.parts : [];
    for (const part of parts) {
      const p = asRecord(part);
      if (p && (p.functionCall != null || p.functionResponse != null)) return true;
    }
  }

  return false;
}

/**
 * True when a response carries client-visible tool calls (`tool_calls`, `function_call`,
 * `tool_use`, `function_call`/`custom_tool_call`, or `functionCall`).
 */
export function responseCarriesToolCalls(response: unknown): boolean {
  const rec = asRecord(response);
  if (!rec) return false;

  if (rec.stop_reason === 'tool_use') return true;

  if (Array.isArray(rec.choices)) {
    for (const ch of rec.choices) {
      const choice = asRecord(ch);
      if (!choice) continue;
      if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'function_call') {
        return true;
      }
      const msg = asRecord(choice.message) ?? asRecord(choice.delta);
      if (!msg) continue;
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) return true;
      if (msg.function_call != null) return true;
    }
  }

  if (Array.isArray(rec.content)) {
    for (const block of rec.content) {
      if (asRecord(block)?.type === 'tool_use') return true;
    }
  }

  if (Array.isArray(rec.output)) {
    for (const item of rec.output) {
      const t = asRecord(item)?.type;
      if (t === 'function_call' || t === 'custom_tool_call') return true;
    }
  }

  if (Array.isArray(rec.candidates)) {
    for (const cand of rec.candidates) {
      const content = asRecord(asRecord(cand)?.content);
      const parts = content && Array.isArray(content.parts) ? content.parts : [];
      for (const p of parts) {
        if (asRecord(p)?.functionCall != null) return true;
      }
    }
  }

  return false;
}

const TRUNCATED_REASONS = new Set(['length', 'max_tokens', 'MAX_TOKENS']);

/**
 * True when a completion was cut off by token limits (`length`, `max_tokens`, `incomplete`)
 * so partial answers are never cached and replayed.
 */
export function isTruncatedCompletion(response: unknown): boolean {
  const rec = asRecord(response);
  if (!rec) return false;

  if (rec.status === 'incomplete') return true;
  if (typeof rec.stop_reason === 'string' && TRUNCATED_REASONS.has(rec.stop_reason)) {
    return true;
  }

  if (Array.isArray(rec.choices)) {
    for (const ch of rec.choices) {
      const reason = asRecord(ch)?.finish_reason;
      if (typeof reason === 'string' && TRUNCATED_REASONS.has(reason)) return true;
    }
  }

  if (Array.isArray(rec.candidates)) {
    for (const cand of rec.candidates) {
      const reason = asRecord(cand)?.finishReason;
      if (typeof reason === 'string' && TRUNCATED_REASONS.has(reason)) return true;
    }
  }

  return false;
}

function hasPersonalVarsHeader(rawHeader: string | string[] | undefined): boolean {
  const raw = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  if (typeof raw !== 'string' || raw.trim().length === 0) return false;
  const trimmed = raw.trim();
  if (trimmed === '{}') return false;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.keys(parsed as Record<string, unknown>).length > 0;
    }
    return true;
  } catch {
    return true;
  }
}

interface ExtractedConversation {
  queryText: string;
  normalizedSemanticQuery: string;
  priorTurns: Array<{ role: string; content: string }>;
  callerSystem: string[];
  mediaFingerprint: string | null;
}

function extractContentParts(
  content: unknown,
  wire: Wire,
): { text: string; nonTextItems: unknown[] } {
  if (typeof content === 'string') {
    return { text: content, nonTextItems: [] };
  }
  if (!Array.isArray(content)) {
    return { text: content == null ? '' : canonicalJson(content), nonTextItems: [] };
  }

  const textParts: string[] = [];
  const nonTextItems: unknown[] = [];

  for (const item of content) {
    if (typeof item === 'string') {
      textParts.push(item);
      continue;
    }
    const block = asRecord(item);
    if (!block) {
      nonTextItems.push(item);
      continue;
    }
    if (wire === 'gemini') {
      if (block.thought === true) continue;
      if (typeof block.text === 'string') {
        textParts.push(block.text);
      } else {
        nonTextItems.push(block);
      }
      continue;
    }
    const t = typeof block.type === 'string' ? block.type : undefined;
    if (
      (!t || t === 'text' || t === 'input_text' || t === 'output_text') &&
      typeof block.text === 'string'
    ) {
      textParts.push(block.text);
    } else {
      nonTextItems.push(block);
    }
  }

  return { text: textParts.join('\n'), nonTextItems };
}

function extractConversation(wire: Wire, body: unknown): ExtractedConversation {
  const rec = asRecord(body);
  if (!rec) {
    return {
      queryText: '',
      normalizedSemanticQuery: '',
      priorTurns: [],
      callerSystem: [],
      mediaFingerprint: null,
    };
  }

  const callerSystem: string[] = [];
  const turns: Array<{ role: string; text: string; nonTextItems: unknown[] }> = [];

  if (wire === 'openai-chat') {
    const msgs = Array.isArray(rec.messages) ? rec.messages : [];
    for (const rawMsg of msgs) {
      if (isVolatileSystemMessage(rawMsg)) continue;
      const msg = asRecord(rawMsg);
      if (!msg) continue;
      const role = typeof msg.role === 'string' ? msg.role : 'user';
      const { text, nonTextItems } = extractContentParts(msg.content, wire);
      if (role === 'system' || role === 'developer') {
        if (text.trim()) callerSystem.push(text.trim());
      } else {
        turns.push({ role, text, nonTextItems });
      }
    }
  } else if (wire === 'anthropic') {
    if (typeof rec.system === 'string' && rec.system.trim()) {
      if (!isVolatileSystemMessage(rec.system)) {
        callerSystem.push(rec.system.trim());
      }
    } else if (Array.isArray(rec.system)) {
      for (const blk of rec.system) {
        if (isVolatileSystemMessage(blk)) continue;
        const b = asRecord(blk);
        if (b && typeof b.text === 'string' && b.text.trim()) {
          callerSystem.push(b.text.trim());
        }
      }
    }
    const msgs = Array.isArray(rec.messages) ? rec.messages : [];
    for (const rawMsg of msgs) {
      const msg = asRecord(rawMsg);
      if (!msg) continue;
      const role = typeof msg.role === 'string' ? msg.role : 'user';
      const { text, nonTextItems } = extractContentParts(msg.content, wire);
      turns.push({ role, text, nonTextItems });
    }
  } else if (wire === 'responses') {
    if (typeof rec.instructions === 'string' && rec.instructions.trim()) {
      if (!isVolatileSystemMessage(rec.instructions)) {
        callerSystem.push(rec.instructions.trim());
      }
    }
    if (typeof rec.input === 'string') {
      turns.push({ role: 'user', text: rec.input, nonTextItems: [] });
    } else if (Array.isArray(rec.input)) {
      for (const rawItem of rec.input) {
        const item = asRecord(rawItem);
        if (!item) continue;
        const itemType = typeof item.type === 'string' ? item.type : 'message';
        if (itemType !== 'message') continue;
        const role = typeof item.role === 'string' ? item.role : 'user';
        const { text, nonTextItems } = extractContentParts(item.content, wire);
        if (role === 'system' || role === 'developer') {
          if (!isVolatileSystemMessage(rawItem) && text.trim()) {
            callerSystem.push(text.trim());
          }
        } else {
          turns.push({ role, text, nonTextItems });
        }
      }
    }
  } else if (wire === 'gemini') {
    const sysInst = asRecord(rec.systemInstruction);
    if (sysInst && Array.isArray(sysInst.parts)) {
      for (const part of sysInst.parts) {
        if (isVolatileSystemMessage(part)) continue;
        const p = asRecord(part);
        if (p && typeof p.text === 'string' && p.text.trim()) {
          callerSystem.push(p.text.trim());
        }
      }
    }
    const contents = Array.isArray(rec.contents) ? rec.contents : [];
    for (const rawCand of contents) {
      const cand = asRecord(rawCand);
      if (!cand) continue;
      const role = typeof cand.role === 'string' ? cand.role : 'user';
      const { text, nonTextItems } = extractContentParts(cand.parts, wire);
      turns.push({ role, text, nonTextItems });
    }
  }

  // Locate final user turn
  let lastUserIdx = -1;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i]!.role === 'user') {
      lastUserIdx = i;
      break;
    }
  }

  if (lastUserIdx === -1) {
    return {
      queryText: '',
      normalizedSemanticQuery: '',
      priorTurns: turns.map((t) => ({ role: t.role, content: t.text })),
      callerSystem,
      mediaFingerprint: null,
    };
  }

  const finalTurn = turns[lastUserIdx]!;
  const remainingTurns = turns.filter((_, idx) => idx !== lastUserIdx);
  const allNonText = turns.flatMap((t) => t.nonTextItems);
  const mediaFingerprint = allNonText.length > 0 ? sha256Hex(canonicalJson(allNonText)) : null;

  return {
    queryText: finalTurn.text,
    normalizedSemanticQuery: finalTurn.text.replace(/\s+/g, ' ').trim(),
    priorTurns: remainingTurns.map((t) => ({ role: t.role, content: t.text })),
    callerSystem,
    mediaFingerprint,
  };
}

export function normalizeModelForContract(model: string | undefined): string {
  const trimmed = (model ?? '').trim();
  return !trimmed || trimmed === 'auto' ? 'auto' : trimmed;
}

export function resolveEndUserScope(
  settings: Pick<SemanticCacheConfig, 'isolateByEndUser'>,
  endUser: string | null | undefined,
): string {
  if (!settings.isolateByEndUser) return '';
  const trimmed = (endUser ?? '').trim();
  return trimmed ? `user:${trimmed}` : '__anonymous__';
}

export interface EvaluatedRequestContract {
  bypassed: boolean;
  bypassReason?: SemanticCacheBypassReason;
  scope: Scope;
  endUserScope: string;
  wire: Wire;
  model: string;
  queryText: string;
  semanticQueryText: string;
  contractHash: string;
  promptVersionHash: string;
  exactHash: string;
}

export interface EvaluateContractInput {
  scope: Scope;
  wire: Wire;
  model: string | undefined;
  body: unknown;
  headers?: Record<string, string | string[] | undefined>;
  endUser?: string | null;
  settings: SemanticCacheConfig;
  language?: string;
}

export function evaluateRequestContract(input: EvaluateContractInput): EvaluatedRequestContract {
  const normScope = normalizeScope(input.scope);
  const wire = input.wire;
  const model = normalizeModelForContract(input.model);
  const promptVersionHash = computePromptVersionHash(normScope);
  const endUserTrimmed = (input.endUser ?? '').trim();
  const endUserScope = resolveEndUserScope(input.settings, endUserTrimmed);

  const rawVarsHeader = input.headers
    ? getHeaderString(input.headers, 'x-freellm-vars')
    : undefined;
  const callerVars = parseCallerVarsHeader(rawVarsHeader);
  const conversation = extractConversation(wire, input.body);
  const constraints = outputContractOf(input.body);

  const contractPayload = canonicalJson({
    schema: SEMANTIC_CACHE_CONTRACT_SCHEMA,
    wire,
    model,
    constraints,
    callerSystem: conversation.callerSystem.length > 0 ? conversation.callerSystem : undefined,
    priorTurns: conversation.priorTurns.length > 0 ? conversation.priorTurns : undefined,
    mediaFingerprint: conversation.mediaFingerprint ?? undefined,
    callerVars:
      input.settings.isolateByEndUser && Object.keys(callerVars).length > 0
        ? callerVars
        : undefined,
    language: input.language ? input.language : undefined,
  });
  const contractHash = sha256Hex(contractPayload);

  const exactPayload = canonicalJson({
    schema: SEMANTIC_CACHE_CONTRACT_SCHEMA,
    scopeKind: normScope.kind,
    scopeId: normScope.id,
    endUserScope,
    contractHash,
    promptVersionHash,
    queryText: conversation.queryText,
  });
  const exactHash = sha256Hex(exactPayload);

  const makeBypass = (reason: SemanticCacheBypassReason): EvaluatedRequestContract => ({
    bypassed: true,
    bypassReason: reason,
    scope: normScope,
    endUserScope,
    wire,
    model,
    queryText: conversation.queryText,
    semanticQueryText: conversation.normalizedSemanticQuery,
    contractHash,
    promptVersionHash,
    exactHash,
  });

  if (!input.settings.enabled) {
    return makeBypass('disabled');
  }

  const headerBypass = hasBypassHeaders(input.headers);
  if (headerBypass) {
    return makeBypass(headerBypass);
  }

  const temperature = extractRequestTemperature(input.body);
  if (
    temperature !== undefined &&
    (!Number.isFinite(temperature) || temperature < 0 || temperature > input.settings.maxTemperature)
  ) {
    return makeBypass('temperature_too_high');
  }

  if (requestCarriesToolCalls(input.body)) {
    return makeBypass('request_has_tool_calls');
  }

  if (hasPersonalVarsHeader(rawVarsHeader)) {
    const isolatedByEndUser = input.settings.isolateByEndUser && endUserTrimmed.length > 0;
    if (!isolatedByEndUser) {
      return makeBypass('personal_vars_unisolated');
    }
  }

  if (!conversation.normalizedSemanticQuery) {
    return makeBypass('empty_query');
  }

  return {
    bypassed: false,
    scope: normScope,
    endUserScope,
    wire,
    model,
    queryText: conversation.queryText,
    semanticQueryText: conversation.normalizedSemanticQuery,
    contractHash,
    promptVersionHash,
    exactHash,
  };
}

export function extractLanguageFromExpressHeaders(
  req: { headers: Record<string, string | string[] | undefined> },
): string {
  // Reuse prompts/render language extraction when possible
  try {
    return extractCallerLanguage(req as Parameters<typeof extractCallerLanguage>[0]);
  } catch {
    return '';
  }
}
