import crypto from 'node:crypto';
import type { ChatMessage } from '@freellmapi/shared/types.js';
import {
  AGENTIC_COMPACTOR_LIMITS,
  AGENTIC_PROSE_MODES,
  AGENTIC_STRATEGY_IDS,
  DEFAULT_AGENTIC_COMPACTOR_CONFIG,
  type AgenticCompactorConfig,
  type AgenticCompactorStats,
  type AgenticPreviewRequest,
  type AgenticPreviewResponse,
  type AgenticProseMode,
  type AgenticStrategyId,
} from '@freellmapi/shared/token-savers-agentic.js';
import { getSetting, setSetting } from '../../db/index.js';
import {
  compressProseText,
  getPrefixTrackerCounts,
  hasExplicitCacheControl,
  observeSystemPrefix,
  resetPrefixFreezeTracker,
} from './prose-compressor.js';

export const AGENTIC_COMPACTOR_CONFIG_KEY = 'x_agentic_compactor_config';
const CONFIG_CACHE_TTL_MS = 5_000;

let cachedConfig: { config: AgenticCompactorConfig; loadedAt: number } | null = null;

function createEmptyStrategyHits(): Record<AgenticStrategyId, number> {
  return {
    source_code: 0,
    grep_search: 0,
    terminal_ansi: 0,
    json_payload: 0,
    stack_trace: 0,
    evidence_digest: 0,
    prose_caveman: 0,
    tools_dedup: 0,
  };
}

const statsState = {
  requestsProcessed: 0,
  requestsCompressed: 0,
  bytesBefore: 0,
  bytesAfter: 0,
  tokensSavedEst: 0,
  strategyHits: createEmptyStrategyHits(),
  frozenPrefixesSkipped: 0,
  fidelityRollbacks: 0,
};

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.round(num)));
}

function normalizeProseMode(value: unknown, fallback: AgenticProseMode): AgenticProseMode {
  return typeof value === 'string' && (AGENTIC_PROSE_MODES as readonly string[]).includes(value)
    ? (value as AgenticProseMode)
    : fallback;
}

function normalizeConfig(
  raw: Partial<AgenticCompactorConfig>,
  source: 'setting' | 'env' | 'default',
): AgenticCompactorConfig {
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_AGENTIC_COMPACTOR_CONFIG.enabled,
    toolCompaction:
      typeof raw.toolCompaction === 'boolean'
        ? raw.toolCompaction
        : DEFAULT_AGENTIC_COMPACTOR_CONFIG.toolCompaction,
    toolResultMaxChars: clampInt(
      raw.toolResultMaxChars,
      DEFAULT_AGENTIC_COMPACTOR_CONFIG.toolResultMaxChars,
      AGENTIC_COMPACTOR_LIMITS.minToolResultMaxChars,
      AGENTIC_COMPACTOR_LIMITS.maxToolResultMaxChars,
    ),
    jsonMinChars: clampInt(
      raw.jsonMinChars,
      DEFAULT_AGENTIC_COMPACTOR_CONFIG.jsonMinChars,
      AGENTIC_COMPACTOR_LIMITS.minJsonMinChars,
      AGENTIC_COMPACTOR_LIMITS.maxJsonMinChars,
    ),
    proseMode: normalizeProseMode(raw.proseMode, DEFAULT_AGENTIC_COMPACTOR_CONFIG.proseMode),
    prefixFreezeEnabled:
      typeof raw.prefixFreezeEnabled === 'boolean'
        ? raw.prefixFreezeEnabled
        : DEFAULT_AGENTIC_COMPACTOR_CONFIG.prefixFreezeEnabled,
    prefixFreezeThreshold: clampInt(
      raw.prefixFreezeThreshold,
      DEFAULT_AGENTIC_COMPACTOR_CONFIG.prefixFreezeThreshold,
      AGENTIC_COMPACTOR_LIMITS.minPrefixFreezeThreshold,
      AGENTIC_COMPACTOR_LIMITS.maxPrefixFreezeThreshold,
    ),
    dedupTools:
      typeof raw.dedupTools === 'boolean'
        ? raw.dedupTools
        : DEFAULT_AGENTIC_COMPACTOR_CONFIG.dedupTools,
    source,
  };
}

export function invalidateAgenticCompactorCache(): void {
  cachedConfig = null;
}

export function getAgenticCompactorConfig(): AgenticCompactorConfig {
  const now = Date.now();
  if (cachedConfig && now - cachedConfig.loadedAt < CONFIG_CACHE_TTL_MS) {
    return { ...cachedConfig.config };
  }

  let stored: Partial<AgenticCompactorConfig> | null = null;
  try {
    const raw = getSetting(AGENTIC_COMPACTOR_CONFIG_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        stored = parsed as Partial<AgenticCompactorConfig>;
      }
    }
  } catch {
    // Fail safe when DB is uninitialized.
  }

  const envRaw = (process.env.X_AGENTIC_COMPACTOR_ENABLED ?? '').trim().toLowerCase();
  const hasEnvToggle = envRaw !== '';
  const envEnabled = envRaw === '1' || envRaw === 'true' || envRaw === 'on' || envRaw === 'yes';

  let config: AgenticCompactorConfig;
  if (stored) {
    const enabled =
      typeof stored.enabled === 'boolean'
        ? stored.enabled
        : hasEnvToggle
          ? envEnabled
          : DEFAULT_AGENTIC_COMPACTOR_CONFIG.enabled;
    config = normalizeConfig({ ...stored, enabled }, 'setting');
  } else if (hasEnvToggle) {
    config = normalizeConfig({ enabled: envEnabled }, 'env');
  } else {
    config = normalizeConfig({}, 'default');
  }

  cachedConfig = { config, loadedAt: now };
  return { ...config };
}

export function setAgenticCompactorConfig(patch: Partial<AgenticCompactorConfig>): AgenticCompactorConfig {
  const current = getAgenticCompactorConfig();
  const next = normalizeConfig(
    {
      ...current,
      ...patch,
    },
    'setting',
  );
  const { source: _ignoredSource, ...persistable } = next;
  try {
    setSetting(AGENTIC_COMPACTOR_CONFIG_KEY, JSON.stringify(persistable));
  } catch {
    // Allow unit tests without writable DB if needed; cache still updates.
  }
  cachedConfig = { config: next, loadedAt: Date.now() };
  return { ...next };
}

export function isAgenticCompactorEnabled(): boolean {
  return getAgenticCompactorConfig().enabled;
}

export function getAgenticCompactorStats(): AgenticCompactorStats {
  const config = getAgenticCompactorConfig();
  const prefixCounts = getPrefixTrackerCounts(config.prefixFreezeThreshold);
  return {
    requestsProcessed: statsState.requestsProcessed,
    requestsCompressed: statsState.requestsCompressed,
    bytesBefore: statsState.bytesBefore,
    bytesAfter: statsState.bytesAfter,
    tokensSavedEst: statsState.tokensSavedEst,
    strategyHits: { ...statsState.strategyHits },
    frozenPrefixesSkipped: statsState.frozenPrefixesSkipped,
    fidelityRollbacks: statsState.fidelityRollbacks,
    trackedPrefixes: prefixCounts.trackedPrefixes,
    frozenPrefixes: prefixCounts.frozenPrefixes,
  };
}

export function resetAgenticCompactorStats(): AgenticCompactorStats {
  statsState.requestsProcessed = 0;
  statsState.requestsCompressed = 0;
  statsState.bytesBefore = 0;
  statsState.bytesAfter = 0;
  statsState.tokensSavedEst = 0;
  statsState.strategyHits = createEmptyStrategyHits();
  statsState.frozenPrefixesSkipped = 0;
  statsState.fidelityRollbacks = 0;
  resetPrefixFreezeTracker();
  return getAgenticCompactorStats();
}

// ── Structural Tool-Result Compressors ──────────────────────────────────────

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;
const GREP_LINE_RE = /^([^\s:]+):(\d+):/;
const STACK_HEADER_RE = /\b([A-Za-z]*Error|[A-Za-z]*Exception|Traceback)\b/i;
const STACK_FRAME_RE = /^\s*(at\s+|File\s+"|Caused by:)/;
const CODE_SIG_RE =
  /^\s*(import\s+|export\s+|function\s+|class\s+|const\s+|let\s+|def\s+|async\s+def\s+|package\s+|pub\s+fn\s+|interface\s+|type\s+)/;

const ALREADY_COMPACTED_MARKERS = [
  '[evidence compacted; sha256=',
  '[COMPRESSED:',
  'lines elided]',
  'frames elided]',
  'more matches]',
  'terminal lines elided]',
] as const;

function alreadyCompacted(text: string): boolean {
  return ALREADY_COMPACTED_MARKERS.some(marker => text.includes(marker));
}

function compressStackTrace(text: string): string | null {
  const lines = text.split('\n');
  if (lines.length < 16 || !STACK_HEADER_RE.test(text)) return null;
  const frameCount = lines.filter(line => STACK_FRAME_RE.test(line)).length;
  if (frameCount < 8) return null;

  const head = lines.slice(0, 11);
  const tail = lines.slice(-3);
  const elided = lines.length - head.length - tail.length;
  if (elided <= 2) return null;
  return [...head, `… [${elided} frames elided] …`, ...tail].join('\n');
}

function summarizeJsonValue(val: unknown): unknown {
  if (typeof val === 'string') {
    return val.length > 300 ? `${val.slice(0, 260)}… [${val.length - 260} chars]` : val;
  }
  if (Array.isArray(val)) {
    if (val.length <= 5) return val.map(summarizeJsonValue);
    return { _compacted: 'array', total: val.length, first3: val.slice(0, 3), last1: val.slice(-1) };
  }
  if (val && typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length <= 5) return obj;
    return { _keys: keys.length, sampleKeys: keys.slice(0, 8) };
  }
  return val;
}

function compressJsonPayload(text: string, minChars: number): string | null {
  if (text.length < minChars) return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  let candidate: string | null = null;
  if (Array.isArray(parsed)) {
    if (parsed.length <= 7) return null;
    candidate = JSON.stringify(
      {
        _compacted: 'array',
        total: parsed.length,
        first5: parsed.slice(0, 5),
        last2: parsed.slice(-2),
      },
      null,
      2,
    );
  } else if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    const keys = Object.keys(obj);
    const summary: Record<string, unknown> = {};
    for (const key of keys.slice(0, 20)) {
      summary[key] = summarizeJsonValue(obj[key]);
    }
    if (keys.length > 20) {
      summary._remainingKeys = keys.length - 20;
    }
    candidate = JSON.stringify(summary, null, 2);
  }

  if (!candidate || candidate.length >= text.length * 0.85) return null;
  return candidate;
}

function compressGrepSearch(text: string): string | null {
  const lines = text.split('\n');
  const grepLines: string[] = [];
  const files = new Set<string>();
  for (const line of lines) {
    const m = GREP_LINE_RE.exec(line);
    if (m) {
      grepLines.push(line);
      files.add(m[1]!);
    }
  }
  if (grepLines.length < 35) return null;
  const top30 = grepLines.slice(0, 30);
  const remaining = grepLines.length - top30.length;
  const fileList = [...files].slice(0, 25).join(', ');
  const filesSuffix = files.size > 25 ? ` (+${files.size - 25} more files)` : '';
  return `${top30.join('\n')}\n… [${remaining} more matches] …\nFiles (${files.size}): ${fileList}${filesSuffix}`;
}

function compressTerminalAnsi(text: string): string | null {
  const hasAnsi = ANSI_ESCAPE_RE.test(text);
  ANSI_ESCAPE_RE.lastIndex = 0;
  const lines = text.split('\n');
  const hasPrompt = lines.some(line => /^(\$\s|>\s)/.test(line));
  if ((!hasAnsi && !hasPrompt) || lines.length < 20) return null;

  const cleanedLines = text.replace(ANSI_ESCAPE_RE, '').split('\n');
  const deduped: string[] = [];
  for (const line of cleanedLines) {
    if (deduped.length === 0 || line !== deduped[deduped.length - 1]) {
      deduped.push(line);
    }
  }

  let output: string;
  if (deduped.length > 60) {
    const head = deduped.slice(0, 10);
    const tail = deduped.slice(-40);
    const elided = deduped.length - head.length - tail.length;
    output = [...head, `… [${elided} terminal lines elided] …`, ...tail].join('\n');
  } else {
    output = deduped.join('\n');
  }
  return output.length < text.length ? output : null;
}

function compressSourceCode(text: string): string | null {
  const lines = text.split('\n');
  if (lines.length < 40) return null;
  let codeLines = 0;
  for (const line of lines) {
    if (CODE_SIG_RE.test(line)) codeLines += 1;
    if (codeLines >= 3) break;
  }
  if (codeLines < 3) return null;

  const head = lines.slice(0, 25);
  const tail = lines.slice(-10);
  const elided = lines.length - head.length - tail.length;
  if (elided <= 2) return null;
  return `${head.join('\n')}\n… [${elided} lines elided] …\n${tail.join('\n')}`;
}

function applyEvidenceDigestCap(text: string, maxChars: number): string | null {
  if (text.length <= maxChars) return null;
  const digest = crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
  const placeholder = `\n...[evidence compacted; sha256=${digest}; omitted=0 chars]...\n`;
  const edge = Math.max(200, Math.floor((maxChars - placeholder.length - 12) / 2));
  if (edge * 2 >= text.length) return null;
  const omitted = text.length - edge * 2;
  const marker = `\n...[evidence compacted; sha256=${digest}; omitted=${omitted} chars]...\n`;
  return `${text.slice(0, edge)}${marker}${text.slice(-edge)}`;
}

export function compressToolPayloadText(
  text: string,
  config: AgenticCompactorConfig,
): { text: string; strategies: AgenticStrategyId[] } {
  if (!text || text.length < 200 || alreadyCompacted(text)) {
    return { text, strategies: [] };
  }

  let current = text;
  const strategies: AgenticStrategyId[] = [];

  const steps: Array<[AgenticStrategyId, (value: string) => string | null]> = [
    ['stack_trace', compressStackTrace],
    ['json_payload', v => compressJsonPayload(v, config.jsonMinChars)],
    ['grep_search', compressGrepSearch],
    ['terminal_ansi', compressTerminalAnsi],
    ['source_code', compressSourceCode],
  ];

  for (const [id, fn] of steps) {
    const next = fn(current);
    if (next && next.length < current.length) {
      current = next;
      strategies.push(id);
      break;
    }
  }

  const capped = applyEvidenceDigestCap(current, config.toolResultMaxChars);
  if (capped && capped.length < current.length) {
    current = capped;
    strategies.push('evidence_digest');
  }

  return { text: current, strategies };
}

// ── Multi-Wire Safe Conversation Compaction ─────────────────────────────────

export interface CompactConversationOptions {
  messages: ChatMessage[];
  rawBody?: Record<string, unknown>;
  configOverride?: Partial<AgenticCompactorConfig>;
  recordStats?: boolean;
  dryRunPrefixCheck?: boolean;
}

export interface CompactConversationResult {
  messages: ChatMessage[];
  applied: boolean;
  bytesBefore: number;
  bytesAfter: number;
  tokensSavedEst: number;
  strategiesApplied: AgenticStrategyId[];
  protectedSpansCount: number;
  prefixFrozen: boolean;
  fidelityRolledBack: boolean;
}

function measureBytes(messages: unknown, rawBody?: Record<string, unknown>): number {
  let bytes = Buffer.byteLength(JSON.stringify(messages), 'utf8');
  if (rawBody) {
    if (Array.isArray(rawBody.tools)) {
      bytes += Buffer.byteLength(JSON.stringify(rawBody.tools), 'utf8');
    }
    if (Array.isArray(rawBody.input)) {
      bytes += Buffer.byteLength(JSON.stringify(rawBody.input), 'utf8');
    }
    if (Array.isArray(rawBody.contents)) {
      bytes += Buffer.byteLength(JSON.stringify(rawBody.contents), 'utf8');
    }
  }
  return bytes;
}

function flattenTextForHash(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(part => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string') {
        return String((part as Record<string, unknown>).text);
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function deduplicateToolsInPlace(tools: unknown[]): boolean {
  const seen = new Set<string>();
  const deduped: unknown[] = [];
  for (const tool of tools) {
    let sig: string;
    try {
      sig = JSON.stringify(tool);
    } catch {
      deduped.push(tool);
      continue;
    }
    if (!seen.has(sig)) {
      seen.add(sig);
      deduped.push(tool);
    }
  }
  if (deduped.length === tools.length) return false;
  tools.splice(0, tools.length, ...deduped);
  return true;
}

function compactRawWireInputs(
  rawBody: Record<string, unknown>,
  config: AgenticCompactorConfig,
  strategySet: Set<AgenticStrategyId>,
): void {
  if (config.dedupTools && Array.isArray(rawBody.tools) && rawBody.tools.length > 1) {
    if (deduplicateToolsInPlace(rawBody.tools)) {
      strategySet.add('tools_dedup');
    }
  }

  if (config.toolCompaction && Array.isArray(rawBody.input)) {
    for (const item of rawBody.input) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      // Preserve structured computer_call_output screenshots verbatim.
      if (rec.type === 'computer_call_output' && typeof rec.output === 'object') continue;
      if (
        (rec.type === 'function_call_output' || rec.type === 'local_shell_call_output') &&
        typeof rec.output === 'string'
      ) {
        const res = compressToolPayloadText(rec.output, config);
        if (res.strategies.length > 0) {
          rec.output = res.text;
          res.strategies.forEach(s => strategySet.add(s));
        }
      }
    }
  }

  if (config.toolCompaction && Array.isArray(rawBody.contents)) {
    for (const entry of rawBody.contents) {
      if (!entry || typeof entry !== 'object') continue;
      const rec = entry as Record<string, unknown>;
      if (!Array.isArray(rec.parts)) continue;
      for (const part of rec.parts) {
        if (!part || typeof part !== 'object') continue;
        const p = part as Record<string, unknown>;
        const fnResp = (p.functionResponse ?? p.function_response) as Record<string, unknown> | undefined;
        if (fnResp && typeof fnResp === 'object' && fnResp.response && typeof fnResp.response === 'object') {
          const inner = fnResp.response as Record<string, unknown>;
          for (const k of ['result', 'output', 'content']) {
            if (typeof inner[k] === 'string') {
              const res = compressToolPayloadText(inner[k] as string, config);
              if (res.strategies.length > 0) {
                inner[k] = res.text;
                res.strategies.forEach(s => strategySet.add(s));
              }
            }
          }
        }
      }
    }
  }
}

export function compactGatewayConversation(options: CompactConversationOptions): CompactConversationResult {
  const baseConfig = getAgenticCompactorConfig();
  const config = options.configOverride
    ? normalizeConfig({ ...baseConfig, ...options.configOverride }, baseConfig.source ?? 'default')
    : baseConfig;

  const bytesBefore = measureBytes(options.messages, options.rawBody);
  const messages = structuredClone(options.messages);
  const strategySet = new Set<AgenticStrategyId>();
  let protectedSpansCount = 0;
  let prefixFrozen = false;
  let fidelityRolledBack = false;

  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i]!;
    const role = String(msg.role);

    if (role === 'system' || role === 'developer') {
      const sysText = flattenTextForHash(msg.content);
      const explicitCache = hasExplicitCacheControl(msg);
      if (config.prefixFreezeEnabled) {
        const obs = sysText
          ? observeSystemPrefix(sysText, config.prefixFreezeThreshold, { dryRun: options.dryRunPrefixCheck })
          : { frozen: false };
        if (explicitCache || obs.frozen) {
          prefixFrozen = true;
        }
        // Never mutate system/developer messages when prefixFreezeEnabled is on so cache hashes stay exact.
        continue;
      }
      if (explicitCache) {
        prefixFrozen = true;
        continue;
      }
      if (typeof msg.content === 'string' && config.proseMode !== 'off') {
        const proseRes = compressProseText(msg.content, config.proseMode);
        protectedSpansCount += proseRes.protectedSpansCount;
        if (proseRes.rolledBack) fidelityRolledBack = true;
        if (proseRes.applied) {
          msg.content = proseRes.text;
          strategySet.add('prose_caveman');
        }
      }
      continue;
    }

    if (role === 'tool') {
      if (!config.toolCompaction) continue;
      if (typeof msg.content === 'string') {
        const res = compressToolPayloadText(msg.content, config);
        if (res.strategies.length > 0) {
          msg.content = res.text;
          res.strategies.forEach(s => strategySet.add(s));
        }
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content as Array<Record<string, unknown>>) {
          if (!block || typeof block !== 'object') continue;
          if (block.type === 'text' && typeof block.text === 'string') {
            const res = compressToolPayloadText(block.text, config);
            if (res.strategies.length > 0) {
              block.text = res.text;
              res.strategies.forEach(s => strategySet.add(s));
            }
          }
        }
      }
      continue;
    }

    // User / Assistant turns
    if (typeof msg.content === 'string') {
      if (config.proseMode !== 'off') {
        const proseRes = compressProseText(msg.content, config.proseMode);
        protectedSpansCount += proseRes.protectedSpansCount;
        if (proseRes.rolledBack) fidelityRolledBack = true;
        if (proseRes.applied) {
          msg.content = proseRes.text;
          strategySet.add('prose_caveman');
        }
      }
      continue;
    }

    if (Array.isArray(msg.content)) {
      for (const block of msg.content as Array<Record<string, unknown>>) {
        if (!block || typeof block !== 'object') continue;
        if (hasExplicitCacheControl(block)) {
          prefixFrozen = true;
          continue;
        }
        if (block.type === 'tool_result' && config.toolCompaction) {
          if (typeof block.content === 'string') {
            const res = compressToolPayloadText(block.content, config);
            if (res.strategies.length > 0) {
              block.content = res.text;
              res.strategies.forEach(s => strategySet.add(s));
            }
          } else if (Array.isArray(block.content)) {
            for (const sub of block.content as Array<Record<string, unknown>>) {
              if (sub && typeof sub === 'object' && sub.type === 'text' && typeof sub.text === 'string') {
                const res = compressToolPayloadText(sub.text, config);
                if (res.strategies.length > 0) {
                  sub.text = res.text;
                  res.strategies.forEach(s => strategySet.add(s));
                }
              }
            }
          }
        } else if (block.type === 'text' && typeof block.text === 'string' && config.proseMode !== 'off') {
          const proseRes = compressProseText(block.text, config.proseMode);
          protectedSpansCount += proseRes.protectedSpansCount;
          if (proseRes.rolledBack) fidelityRolledBack = true;
          if (proseRes.applied) {
            block.text = proseRes.text;
            strategySet.add('prose_caveman');
          }
        }
      }
    }
  }

  if (options.rawBody) {
    compactRawWireInputs(options.rawBody, config, strategySet);
  }

  const bytesAfter = measureBytes(messages, options.rawBody);
  const savedBytes = Math.max(0, bytesBefore - bytesAfter);
  const applied = strategySet.size > 0 && savedBytes > 0;
  const tokensSavedEst = applied ? Math.max(1, Math.round(savedBytes / 4)) : 0;
  const strategiesApplied = AGENTIC_STRATEGY_IDS.filter(id => strategySet.has(id));

  if (options.recordStats !== false) {
    statsState.requestsProcessed += 1;
    if (prefixFrozen) statsState.frozenPrefixesSkipped += 1;
    if (fidelityRolledBack) statsState.fidelityRollbacks += 1;
    if (applied) {
      statsState.requestsCompressed += 1;
      statsState.bytesBefore += bytesBefore;
      statsState.bytesAfter += bytesAfter;
      statsState.tokensSavedEst += tokensSavedEst;
      for (const s of strategiesApplied) {
        statsState.strategyHits[s] += 1;
      }
    }
  }

  return {
    messages: applied ? messages : options.messages,
    applied,
    bytesBefore,
    bytesAfter: applied ? bytesAfter : bytesBefore,
    tokensSavedEst,
    strategiesApplied,
    protectedSpansCount,
    prefixFrozen,
    fidelityRolledBack,
  };
}

function serializePreviewContent(messages: ChatMessage[], tools?: unknown[]): string {
  if (messages.length === 1 && typeof messages[0]?.content === 'string' && !tools?.length) {
    return messages[0].content;
  }
  return JSON.stringify(tools?.length ? { messages, tools } : messages, null, 2);
}

export function previewAgenticCompaction(input: AgenticPreviewRequest): AgenticPreviewResponse {
  const inputMessages: ChatMessage[] = Array.isArray(input.messages) && input.messages.length > 0
    ? (input.messages as ChatMessage[])
    : [
        {
          role: (input.role ?? 'tool') as ChatMessage['role'],
          content: input.text ?? '',
          ...(input.role === 'tool' || !input.role ? { tool_call_id: 'preview_call_1' } : {}),
        },
      ];

  const rawBody = Array.isArray(input.tools) ? { tools: structuredClone(input.tools) } : undefined;
  const originalText = serializePreviewContent(inputMessages, input.tools);

  const result = compactGatewayConversation({
    messages: inputMessages,
    rawBody,
    configOverride: {
      ...(input.configOverride ?? {}),
      enabled: true,
    },
    recordStats: false,
    dryRunPrefixCheck: true,
  });

  const compressedText = serializePreviewContent(
    result.messages,
    rawBody?.tools as unknown[] | undefined,
  );
  const originalChars = originalText.length;
  const compressedChars = compressedText.length;
  const savedChars = Math.max(0, originalChars - compressedChars);
  const tokensBeforeEst = Math.max(0, Math.ceil(originalChars / 4));
  const tokensAfterEst = Math.max(0, Math.ceil(compressedChars / 4));
  const tokensSavedEst = Math.max(0, tokensBeforeEst - tokensAfterEst);
  const savedPct = originalChars > 0 ? Math.round((savedChars / originalChars) * 1000) / 10 : 0;

  return {
    ok: true,
    originalChars,
    compressedChars,
    savedChars,
    tokensBeforeEst,
    tokensAfterEst,
    tokensSavedEst,
    savedPct,
    strategiesApplied: result.strategiesApplied,
    protectedSpansCount: result.protectedSpansCount,
    prefixFrozen: result.prefixFrozen,
    fidelityRolledBack: result.fidelityRolledBack,
    originalPreview: originalText.slice(0, 8_000),
    compressedPreview: compressedText.slice(0, 8_000),
  };
}
