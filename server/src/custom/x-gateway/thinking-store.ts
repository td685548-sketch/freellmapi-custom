/**
 * Cross-Turn Reasoning & Thought-Signature Continuity Store (Spec 031).
 *
 * 1. Gemini / Cloud-Code Thought-Signature Store:
 *    - In-memory LRU (max 1,000 entries, 1h TTL) + SQLite write-through
 *      (`custom_x_thought_signatures`, max 2,000 rows, 30d TTL, periodic pruning).
 *    - Scoped by `(namespace/accountScope, modelFamily, toolCallId)` plus fallback
 *      `(name, canonicalArgs)` fingerprint.
 *    - Never replays a `claude`-family signature to `gemini` or vice versa.
 *
 * 2. Claude Signed-Thinking Continuity Store:
 *    - Strictly memory-only (never persisted to SQLite or written to logs).
 *    - Bounded by 1h TTL, 1,000 entries, 2MB per turn, and 32MB total.
 *    - Bound strictly to `(provider, normalizedClaudeModel, connectionId)` and
 *      segmented by the `tool_use.id` each thinking run preceded.
 *
 * Security & Compliance Invariant:
 * - Raw `thinking` text, `redacted_thinking` payloads, and cryptographic signatures
 *   are NEVER logged to stdout/stderr or request/audit logs.
 */

import { createHash } from 'node:crypto';
import {
  DEFAULT_THINKING_CONTINUITY_MODE,
  type ClaudeSignedThinkingBlock,
  type ClaudeThinkingSegment,
  type ThinkingContinuityClearResult,
  type ThinkingContinuityDiagnostics,
  type ThinkingContinuityMode,
  type ThinkingContinuitySnapshot,
  type ThoughtSignatureModelFamily,
} from '@freellmapi/shared/thinking-continuity.js';
import { getDb } from '../../db/index.js';

export const GEMINI_THOUGHT_SIG_MEMORY_MAX = 1_000;
export const GEMINI_THOUGHT_SIG_MEMORY_TTL_MS = 60 * 60 * 1_000;
export const GEMINI_THOUGHT_SIG_PERSISTED_MAX = 2_000;
export const GEMINI_THOUGHT_SIG_PERSISTED_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

export const CLAUDE_THINKING_MEMORY_TTL_MS = 60 * 60 * 1_000;
export const MAX_CLAUDE_THINKING_ENTRIES = 1_000;
export const MAX_CLAUDE_THINKING_TURN_BYTES = 2 * 1024 * 1024;
export const MAX_CLAUDE_THINKING_TOTAL_BYTES = 32 * 1024 * 1024;

const CONFIG_KEY = 'thinking_continuity';
const PERSISTED_PRUNE_INTERVAL = 25;

const SKIP_VALIDATION_SENTINELS = new Set([
  'context_engineering_is_the_way_to_go',
  'skip_thought_signature_validator',
]);

interface GeminiMemoryEntry {
  signature: string;
  modelFamily: ThoughtSignatureModelFamily | null;
  namespace: string;
  expiresAt: number;
}

interface ThoughtSignatureProvenance {
  namespace: string;
  modelFamily: ThoughtSignatureModelFamily | null;
  expiresAt: number;
}

interface ClaudeTurnEntry {
  provider: string;
  model: string;
  connectionId: string;
  segments: ClaudeThinkingSegment[];
  byteSize: number;
  expiresAt: number;
}

export interface ClaudeBlockBinding {
  provider: string;
  model: string;
  connectionId: string;
  expiresAt: number;
}

const geminiMemory = new Map<string, GeminiMemoryEntry>();
const signatureProvenanceByHash = new Map<string, ThoughtSignatureProvenance>();

const claudeMemory = new Map<string, ClaudeTurnEntry>();
const claudeBindingByBlockHash = new Map<string, ClaudeBlockBinding>();
const restoredClaudeBlocks = new WeakSet<object>();
let claudeTotalBytes = 0;

let activeMode: ThinkingContinuityMode = DEFAULT_THINKING_CONTINUITY_MODE;
let lastKnownDb: unknown = null;
let persistedWriteCounter = 0;
let persistedRowEstimate = Number.POSITIVE_INFINITY;

const counters = {
  geminiStored: 0,
  geminiRestored: 0,
  geminiPersistedHits: 0,
  claudeTurnsStored: 0,
  claudeTurnsRestored: 0,
  foreignSignaturesStripped: 0,
};

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function tryGetDb(): ReturnType<typeof getDb> | null {
  try {
    return getDb();
  } catch {
    return null;
  }
}

function syncModeWithActiveDb(): void {
  const db = tryGetDb();
  if (!db || db === lastKnownDb) return;
  lastKnownDb = db;
  persistedRowEstimate = Number.POSITIVE_INFINITY;
  persistedWriteCounter = 0;
  try {
    const row = db
      .prepare('SELECT value FROM x_gateway_config WHERE key = ?')
      .get(CONFIG_KEY) as { value?: string } | undefined;
    if (row?.value) {
      const parsed = JSON.parse(row.value) as { mode?: unknown };
      activeMode = normalizeThinkingContinuityMode(parsed?.mode);
    } else {
      activeMode = DEFAULT_THINKING_CONTINUITY_MODE;
    }
  } catch {
    activeMode = DEFAULT_THINKING_CONTINUITY_MODE;
  }
}

export function normalizeThinkingContinuityMode(value: unknown): ThinkingContinuityMode {
  return value === 'bypass' ? 'bypass' : 'enabled';
}

export function getThinkingContinuityMode(): ThinkingContinuityMode {
  syncModeWithActiveDb();
  return activeMode;
}

export function setThinkingContinuityMode(mode: unknown): ThinkingContinuityMode {
  syncModeWithActiveDb();
  const normalized = normalizeThinkingContinuityMode(mode);
  activeMode = normalized;
  const db = tryGetDb();
  if (db) {
    try {
      db.prepare(
        `INSERT INTO x_gateway_config (key, value, updated_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).run(CONFIG_KEY, JSON.stringify({ mode: normalized }));
    } catch {
      // Ignore if x_gateway_config table is absent in isolated unit tests.
    }
  }
  return normalized;
}

export function normalizeThinkingProvider(provider: unknown): string {
  return typeof provider === 'string' ? provider.trim().toLowerCase() : '';
}

/**
 * Classify model/provider into a signature family (`claude` | `gemini` | `null`).
 * Antigravity / Cloud Code serves both families on one connection, so the model
 * identifier always takes precedence over the provider identifier.
 */
export function getThoughtSignatureModelFamily(
  model: unknown,
  provider?: unknown,
): ThoughtSignatureModelFamily | null {
  if (typeof model === 'string' && model.trim().length > 0) {
    const lowerModel = model.trim().toLowerCase();
    if (lowerModel.includes('claude')) return 'claude';
    if (lowerModel.includes('gemini') || lowerModel.includes('gemma')) return 'gemini';
  }
  if (typeof provider === 'string' && provider.trim().length > 0) {
    const lowerProvider = provider.trim().toLowerCase();
    if (lowerProvider === 'claude' || lowerProvider === 'anthropic') return 'claude';
    if (
      lowerProvider === 'google' ||
      lowerProvider === 'gemini' ||
      lowerProvider === 'gemini-cli'
    ) {
      return 'gemini';
    }
  }
  return null;
}

/**
 * Strip provider prefixes, effort suffixes, and dated snapshot suffixes (`-20250929`, `@20250929`)
 * so `claude-sonnet-4-5-20250929` and `claude-sonnet-4-5` match as the same Claude model.
 */
export function normalizeClaudeThinkingModel(model: unknown): string {
  if (typeof model !== 'string') return '';
  let normalized = model.trim().toLowerCase();
  if (!normalized) return '';
  normalized = normalized.replace(/\((?:low|medium|high|xhigh|max|minimal|none|auto|-?\d+)\)$/i, '').trim();
  const slashIdx = normalized.lastIndexOf('/');
  if (slashIdx >= 0) {
    normalized = normalized.slice(slashIdx + 1);
  }
  return normalized.replace(/[-@]\d{8}$/, '');
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortJsonValue((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

export function canonicalThoughtSigArgs(args: unknown): string {
  if (typeof args === 'string') {
    try {
      return JSON.stringify(sortJsonValue(JSON.parse(args)));
    } catch {
      return args;
    }
  }
  return JSON.stringify(sortJsonValue(args ?? {}));
}

export function buildThoughtSignatureNamespace(input?: {
  namespace?: string | null;
  accountId?: string | number | null;
  keyId?: string | number | null;
  apiKey?: string | null;
}): string {
  if (typeof input?.namespace === 'string' && input.namespace.trim().length > 0) {
    return input.namespace.trim();
  }
  if (input?.accountId !== undefined && input?.accountId !== null && String(input.accountId).trim().length > 0) {
    return `acct:${String(input.accountId).trim()}`;
  }
  if (input?.keyId !== undefined && input?.keyId !== null && String(input.keyId).trim().length > 0) {
    return `acct:${String(input.keyId).trim()}`;
  }
  if (typeof input?.apiKey === 'string' && input.apiKey.trim().length > 0) {
    return `key:${sha256Hex(input.apiKey.trim()).slice(0, 16)}`;
  }
  return 'default';
}

export function buildGeminiThoughtSignatureScopeKey(
  namespace: string,
  modelFamily: ThoughtSignatureModelFamily | null,
  kind: 'id' | 'call',
  identifier: string,
): string {
  const ns = namespace.trim() || 'default';
  const family = modelFamily ?? 'generic';
  return `${ns}|${family}|${kind}:${identifier}`;
}

export function isSkipValidationSentinel(signature: unknown): boolean {
  return typeof signature === 'string' && SKIP_VALIDATION_SENTINELS.has(signature);
}

function pruneGeminiMemory(now = Date.now()): void {
  for (const [key, entry] of geminiMemory.entries()) {
    if (entry.expiresAt <= now) {
      geminiMemory.delete(key);
    }
  }
  while (geminiMemory.size > GEMINI_THOUGHT_SIG_MEMORY_MAX) {
    const lruKey = geminiMemory.keys().next().value;
    if (lruKey === undefined) break;
    geminiMemory.delete(lruKey);
  }

  for (const [hash, prov] of signatureProvenanceByHash.entries()) {
    if (prov.expiresAt <= now) {
      signatureProvenanceByHash.delete(hash);
    }
  }
  while (signatureProvenanceByHash.size > GEMINI_THOUGHT_SIG_MEMORY_MAX * 2) {
    const oldest = signatureProvenanceByHash.keys().next().value;
    if (oldest === undefined) break;
    signatureProvenanceByHash.delete(oldest);
  }
}

function setGeminiLru(key: string, entry: GeminiMemoryEntry, now: number): void {
  if (geminiMemory.has(key)) {
    geminiMemory.delete(key);
  }
  geminiMemory.set(key, entry);
  pruneGeminiMemory(now);
}

export function prunePersistedGeminiThoughtSignatures(now = Date.now()): number {
  const db = tryGetDb();
  if (!db) return 0;
  try {
    const expiredRes = db
      .prepare('DELETE FROM custom_x_thought_signatures WHERE expires_at <= ?')
      .run(now);
    let deleted = Number(expiredRes.changes ?? 0);

    const countRow = db
      .prepare('SELECT COUNT(*) AS cnt FROM custom_x_thought_signatures')
      .get() as { cnt: number } | undefined;
    const total = Number(countRow?.cnt ?? 0);
    if (total > GEMINI_THOUGHT_SIG_PERSISTED_MAX) {
      const excess = total - GEMINI_THOUGHT_SIG_PERSISTED_MAX;
      const trimRes = db
        .prepare(
          `DELETE FROM custom_x_thought_signatures
            WHERE scope_key IN (
              SELECT scope_key
                FROM custom_x_thought_signatures
               ORDER BY created_at ASC, scope_key ASC
               LIMIT ?
            )`,
        )
        .run(excess);
      deleted += Number(trimRes.changes ?? 0);
      persistedRowEstimate = GEMINI_THOUGHT_SIG_PERSISTED_MAX;
    } else {
      persistedRowEstimate = total;
    }
    return deleted;
  } catch {
    return 0;
  }
}

function maybePrunePersistedOnWrite(db: ReturnType<typeof getDb>, now: number): void {
  persistedWriteCounter += 1;
  if (!Number.isFinite(persistedRowEstimate)) {
    const row = db
      .prepare('SELECT COUNT(*) AS cnt FROM custom_x_thought_signatures')
      .get() as { cnt: number } | undefined;
    persistedRowEstimate = Number(row?.cnt ?? 0);
  }
  if (
    persistedWriteCounter % PERSISTED_PRUNE_INTERVAL === 0 ||
    persistedRowEstimate > GEMINI_THOUGHT_SIG_PERSISTED_MAX
  ) {
    prunePersistedGeminiThoughtSignatures(now);
  }
}

export function storeGeminiThoughtSignature(args: {
  namespace?: string | null;
  accountId?: string | number | null;
  keyId?: string | number | null;
  apiKey?: string | null;
  model?: unknown;
  provider?: unknown;
  modelFamily?: ThoughtSignatureModelFamily | null;
  toolCallId?: unknown;
  signature: unknown;
  name?: unknown;
  callArgs?: unknown;
  now?: number;
}): boolean {
  if (getThinkingContinuityMode() === 'bypass') return false;
  if (typeof args.signature !== 'string' || args.signature.length === 0) return false;
  if (isSkipValidationSentinel(args.signature)) return false;

  const now = args.now ?? Date.now();
  const namespace = buildThoughtSignatureNamespace(args);
  const family =
    args.modelFamily !== undefined
      ? args.modelFamily
      : getThoughtSignatureModelFamily(args.model, args.provider);

  const keys: string[] = [];
  if (typeof args.toolCallId === 'string' && args.toolCallId.trim().length > 0) {
    keys.push(buildGeminiThoughtSignatureScopeKey(namespace, family, 'id', args.toolCallId.trim()));
  }
  if (typeof args.name === 'string' && args.name.trim().length > 0) {
    const fingerprint = `${args.name.trim()}:${canonicalThoughtSigArgs(args.callArgs)}`;
    keys.push(buildGeminiThoughtSignatureScopeKey(namespace, family, 'call', fingerprint));
  }
  if (keys.length === 0) return false;

  pruneGeminiMemory(now);
  const primaryExisting = geminiMemory.get(keys[0]!);
  const isDuplicateInMemory =
    primaryExisting !== undefined &&
    primaryExisting.signature === args.signature &&
    primaryExisting.expiresAt > now;

  const memoryExpiresAt = now + GEMINI_THOUGHT_SIG_MEMORY_TTL_MS;
  for (const key of keys) {
    setGeminiLru(
      key,
      {
        signature: args.signature,
        modelFamily: family,
        namespace,
        expiresAt: memoryExpiresAt,
      },
      now,
    );
  }

  const sigHash = sha256Hex(args.signature);
  signatureProvenanceByHash.delete(sigHash);
  signatureProvenanceByHash.set(sigHash, {
    namespace,
    modelFamily: family,
    expiresAt: memoryExpiresAt,
  });

  const db = tryGetDb();
  if (db) {
    try {
      const persistedExpiresAt = now + GEMINI_THOUGHT_SIG_PERSISTED_TTL_MS;
      const upsert = db.prepare(
        `INSERT INTO custom_x_thought_signatures (scope_key, signature, model_family, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(scope_key) DO UPDATE SET
           signature = excluded.signature,
           model_family = excluded.model_family,
           created_at = excluded.created_at,
           expires_at = excluded.expires_at`,
      );
      for (const key of keys) {
        upsert.run(key, args.signature, family, now, persistedExpiresAt);
        if (Number.isFinite(persistedRowEstimate)) {
          persistedRowEstimate += 1;
        }
      }
      maybePrunePersistedOnWrite(db, now);
    } catch {
      // Fall back to in-memory continuity when DB/table is unavailable.
    }
  }

  if (!isDuplicateInMemory) {
    counters.geminiStored += 1;
  }
  return true;
}

function isCompatibleFamily(
  requested: ThoughtSignatureModelFamily | null,
  stored: ThoughtSignatureModelFamily | string | null | undefined,
): boolean {
  if (!requested || !stored) return true;
  return requested === stored;
}

export function recallGeminiThoughtSignature(args: {
  namespace?: string | null;
  accountId?: string | number | null;
  keyId?: string | number | null;
  apiKey?: string | null;
  model?: unknown;
  provider?: unknown;
  modelFamily?: ThoughtSignatureModelFamily | null;
  toolCallId?: unknown;
  name?: unknown;
  callArgs?: unknown;
  now?: number;
}): string | null {
  if (getThinkingContinuityMode() === 'bypass') return null;

  const now = args.now ?? Date.now();
  const namespace = buildThoughtSignatureNamespace(args);
  const requestedFamily =
    args.modelFamily !== undefined
      ? args.modelFamily
      : getThoughtSignatureModelFamily(args.model, args.provider);

  const keys: string[] = [];
  if (typeof args.toolCallId === 'string' && args.toolCallId.trim().length > 0) {
    keys.push(buildGeminiThoughtSignatureScopeKey(namespace, requestedFamily, 'id', args.toolCallId.trim()));
  }
  if (typeof args.name === 'string' && args.name.trim().length > 0) {
    const fingerprint = `${args.name.trim()}:${canonicalThoughtSigArgs(args.callArgs)}`;
    keys.push(buildGeminiThoughtSignatureScopeKey(namespace, requestedFamily, 'call', fingerprint));
  }
  if (keys.length === 0) return null;

  pruneGeminiMemory(now);

  for (const key of keys) {
    const hit = geminiMemory.get(key);
    if (hit && hit.expiresAt > now) {
      if (!isCompatibleFamily(requestedFamily, hit.modelFamily)) {
        continue;
      }
      setGeminiLru(key, hit, now);
      counters.geminiRestored += 1;
      return hit.signature;
    }
  }

  const db = tryGetDb();
  if (db) {
    try {
      const selectStmt = db.prepare(
        `SELECT signature, model_family, expires_at
           FROM custom_x_thought_signatures
          WHERE scope_key = ?`,
      );
      const deleteStmt = db.prepare('DELETE FROM custom_x_thought_signatures WHERE scope_key = ?');

      for (const key of keys) {
        const row = selectStmt.get(key) as
          | { signature: string; model_family: string | null; expires_at: number }
          | undefined;
        if (!row) continue;
        if (row.expires_at <= now || !row.signature) {
          deleteStmt.run(key);
          continue;
        }
        const storedFamily =
          row.model_family === 'gemini' || row.model_family === 'claude'
            ? row.model_family
            : null;
        if (!isCompatibleFamily(requestedFamily, storedFamily)) {
          continue;
        }

        const memoryEntry: GeminiMemoryEntry = {
          signature: row.signature,
          modelFamily: storedFamily,
          namespace,
          expiresAt: Math.min(row.expires_at, now + GEMINI_THOUGHT_SIG_MEMORY_TTL_MS),
        };
        setGeminiLru(key, memoryEntry, now);
        signatureProvenanceByHash.set(sha256Hex(row.signature), {
          namespace,
          modelFamily: storedFamily,
          expiresAt: memoryEntry.expiresAt,
        });

        counters.geminiPersistedHits += 1;
        counters.geminiRestored += 1;
        return row.signature;
      }
    } catch {
      // Ignore DB lookup errors and return miss.
    }
  }

  return null;
}

export function getStoredThoughtSignatureProvenance(
  signature: unknown,
  now = Date.now(),
): { namespace: string; modelFamily: ThoughtSignatureModelFamily | null } | null {
  if (typeof signature !== 'string' || !signature || isSkipValidationSentinel(signature)) {
    return null;
  }
  pruneGeminiMemory(now);
  const hash = sha256Hex(signature);
  const mem = signatureProvenanceByHash.get(hash);
  if (mem && mem.expiresAt > now) {
    return { namespace: mem.namespace, modelFamily: mem.modelFamily };
  }

  const db = tryGetDb();
  if (db) {
    try {
      const row = db
        .prepare(
          `SELECT scope_key, model_family, expires_at
             FROM custom_x_thought_signatures
            WHERE signature = ? AND expires_at > ?
            LIMIT 1`,
        )
        .get(signature, now) as
        | { scope_key: string; model_family: string | null; expires_at: number }
        | undefined;
      if (row) {
        const ns = row.scope_key.split('|')[0] || 'default';
        const fam =
          row.model_family === 'gemini' || row.model_family === 'claude'
            ? row.model_family
            : null;
        return { namespace: ns, modelFamily: fam };
      }
    } catch {
      // Ignore DB unavailable
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Claude Signed-Thinking Continuity Store (Memory-Only)
// ─────────────────────────────────────────────────────────────────────────────

function normalizeClaudeBlock(block: unknown): ClaudeSignedThinkingBlock | null {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return null;
  const record = block as Record<string, unknown>;
  if (record.type === 'thinking') {
    if (typeof record.thinking !== 'string') return null;
    if (typeof record.signature !== 'string' || record.signature.length === 0) return null;
    return {
      type: 'thinking',
      thinking: record.thinking,
      signature: record.signature,
    };
  }
  if (record.type === 'redacted_thinking') {
    if (typeof record.data !== 'string' || record.data.length === 0) return null;
    return {
      type: 'redacted_thinking',
      data: record.data,
    };
  }
  return null;
}

function claudeBlockByteSize(block: ClaudeSignedThinkingBlock): number {
  if (block.type === 'thinking') {
    return Buffer.byteLength(block.thinking, 'utf8') + Buffer.byteLength(block.signature, 'utf8');
  }
  return Buffer.byteLength(block.data, 'utf8');
}

function claudeBlockFingerprintHash(block: ClaudeSignedThinkingBlock): string {
  return block.type === 'thinking'
    ? sha256Hex(`thinking:${block.signature}`)
    : sha256Hex(`redacted:${block.data}`);
}

function cloneSegments(segments: ClaudeThinkingSegment[]): ClaudeThinkingSegment[] {
  return segments.map(segment => ({
    toolUseId: segment.toolUseId,
    blocks: segment.blocks.map(block => ({ ...block })),
  }));
}

function deleteClaudeKey(key: string): void {
  const existing = claudeMemory.get(key);
  if (!existing) return;
  claudeMemory.delete(key);
  claudeTotalBytes = Math.max(0, claudeTotalBytes - existing.byteSize);
}

function pruneClaudeMemory(now = Date.now()): void {
  for (const [key, entry] of claudeMemory.entries()) {
    if (entry.expiresAt <= now) {
      deleteClaudeKey(key);
    }
  }
  while (
    claudeMemory.size > MAX_CLAUDE_THINKING_ENTRIES ||
    claudeTotalBytes > MAX_CLAUDE_THINKING_TOTAL_BYTES
  ) {
    const oldestKey = claudeMemory.keys().next().value;
    if (oldestKey === undefined) break;
    deleteClaudeKey(oldestKey);
  }

  for (const [hash, binding] of claudeBindingByBlockHash.entries()) {
    if (binding.expiresAt <= now) {
      claudeBindingByBlockHash.delete(hash);
    }
  }
  while (claudeBindingByBlockHash.size > MAX_CLAUDE_THINKING_ENTRIES * 4) {
    const oldest = claudeBindingByBlockHash.keys().next().value;
    if (oldest === undefined) break;
    claudeBindingByBlockHash.delete(oldest);
  }
}

function collectClaudeThinkingSegments(
  content: unknown[],
): { segments: ClaudeThinkingSegment[]; byteSize: number } | null {
  const segments: ClaudeThinkingSegment[] = [];
  let pending: ClaudeSignedThinkingBlock[] = [];
  let byteSize = 0;

  for (const item of content) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (record.type === 'thinking' || record.type === 'redacted_thinking') {
      const normalized = normalizeClaudeBlock(item);
      if (!normalized) return null;
      const blockBytes = claudeBlockByteSize(normalized);
      byteSize += blockBytes;
      if (byteSize > MAX_CLAUDE_THINKING_TURN_BYTES) return null;
      pending.push(normalized);
    } else if (record.type === 'tool_use' && typeof record.id === 'string' && record.id.trim().length > 0) {
      segments.push({
        toolUseId: record.id.trim(),
        blocks: pending,
      });
      pending = [];
    }
  }

  if (byteSize === 0 || byteSize > MAX_CLAUDE_THINKING_TURN_BYTES || pending.length > 0 || segments.length === 0) {
    return null;
  }

  return { segments, byteSize };
}

function segmentsEqual(a: ClaudeThinkingSegment[], b: ClaudeThinkingSegment[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const sa = a[i]!;
    const sb = b[i]!;
    if (sa.toolUseId !== sb.toolUseId || sa.blocks.length !== sb.blocks.length) return false;
    for (let j = 0; j < sa.blocks.length; j += 1) {
      const ba = sa.blocks[j]!;
      const bb = sb.blocks[j]!;
      if (ba.type !== bb.type) return false;
      if (ba.type === 'thinking' && bb.type === 'thinking') {
        if (ba.signature !== bb.signature || ba.thinking !== bb.thinking) return false;
      } else if (ba.type === 'redacted_thinking' && bb.type === 'redacted_thinking') {
        if (ba.data !== bb.data) return false;
      }
    }
  }
  return true;
}

export function storeClaudeThinkingBlocks(args: {
  content: unknown;
  provider: unknown;
  model: unknown;
  connectionId?: unknown;
  now?: number;
}): boolean {
  if (getThinkingContinuityMode() === 'bypass') return false;
  const provider = normalizeThinkingProvider(args.provider);
  const model = normalizeClaudeThinkingModel(args.model);
  const connectionId =
    typeof args.connectionId === 'string'
      ? args.connectionId.trim()
      : typeof args.connectionId === 'number' && Number.isFinite(args.connectionId)
        ? String(args.connectionId)
        : '';

  if (!provider || !model || !connectionId || !Array.isArray(args.content)) {
    return false;
  }

  const collected = collectClaudeThinkingSegments(args.content);
  if (!collected) return false;
  const { segments, byteSize } = collected;
  const now = args.now ?? Date.now();
  const expiresAt = now + CLAUDE_THINKING_MEMORY_TTL_MS;

  pruneClaudeMemory(now);

  const firstId = segments[0]!.toolUseId;
  const existingFirst = claudeMemory.get(firstId);
  const alreadyStoredSameTurn =
    existingFirst !== undefined &&
    existingFirst.expiresAt > now &&
    existingFirst.provider === provider &&
    existingFirst.model === model &&
    existingFirst.connectionId === connectionId &&
    segmentsEqual(existingFirst.segments, segments);

  for (const segment of segments) {
    deleteClaudeKey(segment.toolUseId);
    claudeMemory.set(segment.toolUseId, {
      provider,
      model,
      connectionId,
      segments: cloneSegments(segments),
      byteSize,
      expiresAt,
    });
    claudeTotalBytes += byteSize;

    for (const block of segment.blocks) {
      const hash = claudeBlockFingerprintHash(block);
      claudeBindingByBlockHash.delete(hash);
      claudeBindingByBlockHash.set(hash, {
        provider,
        model,
        connectionId,
        expiresAt,
      });
    }
  }

  pruneClaudeMemory(now);

  if (!alreadyStoredSameTurn) {
    counters.claudeTurnsStored += 1;
  }
  return true;
}

export function storeClaudeThinkingFromResponse(
  responseBody: unknown,
  binding: { provider: unknown; model: unknown; connectionId?: unknown; now?: number },
): boolean {
  if (!responseBody || typeof responseBody !== 'object' || Array.isArray(responseBody)) {
    return false;
  }
  const root = responseBody as Record<string, unknown>;
  return storeClaudeThinkingBlocks({
    content: root.content,
    provider: binding.provider,
    model: typeof root.model === 'string' && root.model.trim() ? root.model : binding.model,
    connectionId: binding.connectionId,
    now: binding.now,
  });
}

export function restoreClaudeThinkingBlocks(args: {
  toolUseIds: unknown;
  provider: unknown;
  model: unknown;
  connectionId?: unknown;
  now?: number;
}): ClaudeThinkingSegment[] | null {
  if (getThinkingContinuityMode() === 'bypass') return null;
  const toolUseIds = Array.isArray(args.toolUseIds) ? args.toolUseIds : [];
  const provider = normalizeThinkingProvider(args.provider);
  const model = normalizeClaudeThinkingModel(args.model);
  const connectionId =
    typeof args.connectionId === 'string'
      ? args.connectionId.trim()
      : typeof args.connectionId === 'number' && Number.isFinite(args.connectionId)
        ? String(args.connectionId)
        : '';

  if (toolUseIds.length === 0 || !provider || !model || !connectionId) {
    return null;
  }

  const now = args.now ?? Date.now();
  pruneClaudeMemory(now);

  for (const rawId of toolUseIds) {
    if (typeof rawId !== 'string' || !rawId.trim()) continue;
    const key = rawId.trim();
    const entry = claudeMemory.get(key);
    if (!entry || entry.expiresAt <= now) continue;
    if (
      entry.provider !== provider ||
      entry.model !== model ||
      entry.connectionId !== connectionId
    ) {
      return null;
    }
    // Refresh LRU order on match
    claudeMemory.delete(key);
    claudeMemory.set(key, entry);

    const cloned = cloneSegments(entry.segments);
    for (const seg of cloned) {
      for (const block of seg.blocks) {
        restoredClaudeBlocks.add(block);
      }
    }
    counters.claudeTurnsRestored += 1;
    return cloned;
  }

  return null;
}

export function peekClaudeThinkingBlocks(args: {
  toolUseIds: unknown;
  provider: unknown;
  model: unknown;
  connectionId?: unknown;
  now?: number;
}): ClaudeThinkingSegment[] | null {
  if (getThinkingContinuityMode() === 'bypass') return null;
  const toolUseIds = Array.isArray(args.toolUseIds) ? args.toolUseIds : [];
  const provider = normalizeThinkingProvider(args.provider);
  const model = normalizeClaudeThinkingModel(args.model);
  const connectionId =
    typeof args.connectionId === 'string'
      ? args.connectionId.trim()
      : typeof args.connectionId === 'number' && Number.isFinite(args.connectionId)
        ? String(args.connectionId)
        : '';

  if (toolUseIds.length === 0 || !provider || !model || !connectionId) {
    return null;
  }

  const now = args.now ?? Date.now();
  pruneClaudeMemory(now);

  for (const rawId of toolUseIds) {
    if (typeof rawId !== 'string' || !rawId.trim()) continue;
    const entry = claudeMemory.get(rawId.trim());
    if (!entry || entry.expiresAt <= now) continue;
    if (
      entry.provider !== provider ||
      entry.model !== model ||
      entry.connectionId !== connectionId
    ) {
      return null;
    }
    return cloneSegments(entry.segments);
  }

  return null;
}

export function isRestoredClaudeThinkingBlock(block: object): boolean {
  return restoredClaudeBlocks.has(block);
}

export function getStoredClaudeBlockBinding(
  block: unknown,
  now = Date.now(),
): ClaudeBlockBinding | null {
  const normalized = normalizeClaudeBlock(block);
  if (!normalized) return null;
  pruneClaudeMemory(now);
  const binding = claudeBindingByBlockHash.get(claudeBlockFingerprintHash(normalized));
  return binding && binding.expiresAt > now ? binding : null;
}

export function downgradeRestoredClaudeThinking(content: unknown): unknown[] | null {
  if (!Array.isArray(content) || claudeMemory.size === 0) return null;

  const matchingKeys = new Set<string>();
  const kept: unknown[] = [];
  let droppedAny = false;

  for (const item of content) {
    const normalized = normalizeClaudeBlock(item);
    if (!normalized) {
      kept.push(item);
      continue;
    }
    let matchedStored = isRestoredClaudeThinkingBlock(item as object);
    for (const [key, entry] of claudeMemory.entries()) {
      const hasSame = entry.segments.some(seg =>
        seg.blocks.some(b =>
          b.type === normalized.type &&
          (b.type === 'thinking' && normalized.type === 'thinking'
            ? b.signature === normalized.signature
            : b.type === 'redacted_thinking' &&
              normalized.type === 'redacted_thinking' &&
              b.data === normalized.data),
        ),
      );
      if (hasSame) {
        matchedStored = true;
        matchingKeys.add(key);
      }
    }
    if (matchedStored) {
      droppedAny = true;
    } else {
      kept.push(item);
    }
  }

  if (!droppedAny) return null;
  for (const key of matchingKeys) {
    deleteClaudeKey(key);
  }
  return kept;
}

// ─────────────────────────────────────────────────────────────────────────────
// Diagnostics, Memory Inspection & Clear Operations
// ─────────────────────────────────────────────────────────────────────────────

export function recordForeignSignaturesStripped(count = 1): void {
  if (count > 0 && Number.isFinite(count)) {
    counters.foreignSignaturesStripped += Math.trunc(count);
  }
}

export function getGeminiThoughtSignatureMemoryCount(now = Date.now()): number {
  pruneGeminiMemory(now);
  return geminiMemory.size;
}

export function getClaudeThinkingMemoryCount(now = Date.now()): number {
  pruneClaudeMemory(now);
  return claudeMemory.size;
}

export function getClaudeThinkingTotalBytes(now = Date.now()): number {
  pruneClaudeMemory(now);
  return claudeTotalBytes;
}

export function getPersistedThoughtSignatureCount(now = Date.now()): number {
  const db = tryGetDb();
  if (!db) return 0;
  try {
    const row = db
      .prepare('SELECT COUNT(*) AS cnt FROM custom_x_thought_signatures WHERE expires_at > ?')
      .get(now) as { cnt: number } | undefined;
    return Number(row?.cnt ?? 0);
  } catch {
    return 0;
  }
}

export function getThinkingContinuityDiagnostics(now = Date.now()): ThinkingContinuityDiagnostics {
  const memoryEntries =
    getGeminiThoughtSignatureMemoryCount(now) + getClaudeThinkingMemoryCount(now);
  return {
    geminiStored: counters.geminiStored,
    geminiRestored: counters.geminiRestored,
    geminiPersistedHits: counters.geminiPersistedHits,
    claudeTurnsStored: counters.claudeTurnsStored,
    claudeTurnsRestored: counters.claudeTurnsRestored,
    foreignSignaturesStripped: counters.foreignSignaturesStripped,
    memoryEntries,
  };
}

export function getThinkingContinuitySnapshot(now = Date.now()): ThinkingContinuitySnapshot {
  return {
    mode: getThinkingContinuityMode(),
    diagnostics: getThinkingContinuityDiagnostics(now),
    persistedEntries: getPersistedThoughtSignatureCount(now),
  };
}

/**
 * Clears in-memory LRU caches ONLY (simulating a server restart while preserving SQLite rows).
 */
export function clearThinkingContinuityMemory(): number {
  const cleared = geminiMemory.size + claudeMemory.size;
  geminiMemory.clear();
  signatureProvenanceByHash.clear();
  claudeMemory.clear();
  claudeBindingByBlockHash.clear();
  claudeTotalBytes = 0;
  return cleared;
}

export function clearThinkingContinuityStore(options?: {
  memoryOnly?: boolean;
  resetDiagnostics?: boolean;
}): ThinkingContinuityClearResult {
  const clearedMemoryEntries = clearThinkingContinuityMemory();
  let clearedPersistedEntries = 0;

  if (!options?.memoryOnly) {
    const db = tryGetDb();
    if (db) {
      try {
        const res = db.prepare('DELETE FROM custom_x_thought_signatures').run();
        clearedPersistedEntries = Number(res.changes ?? 0);
        persistedRowEstimate = 0;
        persistedWriteCounter = 0;
      } catch {
        // Ignore if table not present
      }
    }
  }

  if (options?.resetDiagnostics !== false) {
    counters.geminiStored = 0;
    counters.geminiRestored = 0;
    counters.geminiPersistedHits = 0;
    counters.claudeTurnsStored = 0;
    counters.claudeTurnsRestored = 0;
    counters.foreignSignaturesStripped = 0;
  }

  return {
    ok: true,
    clearedMemoryEntries,
    clearedPersistedEntries,
    snapshot: getThinkingContinuitySnapshot(),
  };
}
