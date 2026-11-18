import { getDb } from '../../db/index.js';
import {
  ASSISTANT_CATEGORIES,
  MAX_USER_ASSISTANT_KNOWLEDGE_BYTES,
  MAX_USER_ASSISTANT_SYSTEM_PROMPT_CHARS,
  MAX_USER_CUSTOM_ASSISTANTS,
  type AssistantCategory,
  type AssistantThreadDetail,
  type AssistantThreadMessage,
  type AssistantThreadSummary,
  type KeyRoutingMode,
  type UserCustomAssistant,
  type UserCustomAssistantInput,
  type UserKeyCustomBinding,
} from '@freellmapi/shared/customer-ai.js';
import {
  CustomerAiError,
  getAssistantForRuntime,
  normalizeRoutingMode,
  normalizeSlug,
} from './store.js';

const VALID_CATEGORIES = new Set<string>(ASSISTANT_CATEGORIES);
const DEFAULT_RUNTIME_KNOWLEDGE_CHAR_BUDGET = 12_000;

function normalizeCategory(raw: string | null | undefined): AssistantCategory {
  return raw && VALID_CATEGORIES.has(raw) ? (raw as AssistantCategory) : 'general';
}

function stripDiacritics(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

/** Normalizes and bounds personal knowledge markdown for low-latency /v1 prompt injection. */
export function compactKnowledgeMarkdown(
  raw: string | null | undefined,
  maxChars = DEFAULT_RUNTIME_KNOWLEDGE_CHAR_BUDGET,
): string {
  if (!raw) return '';
  const cleaned = raw
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!cleaned) return '';
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars).trimEnd()}\n\n[...knowledge context truncated]`;
}

/** Composes custom assistant persona prompt + compacted knowledge markdown + optional user instructions. */
export function composeCustomAssistantSystemPrompt(
  assistant: { systemPrompt: string; knowledgeMarkdown?: string | null },
  customInstructions: string | null | undefined,
  applyToKeys: boolean,
): string | null {
  const parts: string[] = [];
  const base = assistant.systemPrompt?.trim();
  if (base) parts.push(base);

  const knowledge = compactKnowledgeMarkdown(assistant.knowledgeMarkdown);
  if (knowledge) {
    parts.push(`[Personal Knowledge Context]\n${knowledge}`);
  }

  const custom = applyToKeys ? customInstructions?.trim() : '';
  if (custom) {
    parts.push(`[User Custom Instructions]\n${custom}`);
  }

  return parts.length > 0 ? parts.join('\n\n') : null;
}

export function assertValidKnowledgeMarkdown(raw: string | undefined): string {
  if (raw === undefined) return '';
  const normalized = raw.replace(/\r\n/g, '\n');
  const bytes = Buffer.byteLength(normalized, 'utf8');
  if (bytes > MAX_USER_ASSISTANT_KNOWLEDGE_BYTES) {
    throw new CustomerAiError(
      400,
      'knowledge_too_large',
      `Personal knowledge markdown must not exceed ${MAX_USER_ASSISTANT_KNOWLEDGE_BYTES} bytes (32 KB).`,
    );
  }
  return normalized.trim();
}

function deriveUniqueUserSlug(
  userId: number,
  rawSlug: string | undefined,
  rawName: string,
  excludeId?: number,
): string {
  const db = getDb();
  if (rawSlug !== undefined && rawSlug.trim().length > 0) {
    const explicit = normalizeSlug(stripDiacritics(rawSlug));
    const dup = excludeId !== undefined
      ? db.prepare('SELECT id FROM custom_user_assistants WHERE user_id = ? AND slug = ? AND id <> ?').get(userId, explicit, excludeId)
      : db.prepare('SELECT id FROM custom_user_assistants WHERE user_id = ? AND slug = ?').get(userId, explicit);
    if (dup) {
      throw new CustomerAiError(409, 'duplicate_slug', `You already have a custom assistant with slug '${explicit}'.`);
    }
    return explicit;
  }

  const baseCandidate = stripDiacritics(rawName)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  const base = baseCandidate.length >= 2 ? baseCandidate : 'custom-agent';

  for (let suffix = 1; suffix <= 50; suffix += 1) {
    const candidate = suffix === 1 ? base : `${base.slice(0, 55)}-${suffix}`;
    const dup = excludeId !== undefined
      ? db.prepare('SELECT id FROM custom_user_assistants WHERE user_id = ? AND slug = ? AND id <> ?').get(userId, candidate, excludeId)
      : db.prepare('SELECT id FROM custom_user_assistants WHERE user_id = ? AND slug = ?').get(userId, candidate);
    if (!dup) return candidate;
  }

  return `${base.slice(0, 46)}-${Date.now().toString(36)}`;
}

interface UserAssistantRow {
  id: number;
  user_id: number;
  slug: string;
  name: string;
  category: string;
  description: string;
  system_prompt: string;
  knowledge_markdown: string;
  recommended_routing_mode: string;
  bound_keys_count: number;
  created_at: string;
  updated_at: string;
}

const SELECT_USER_ASSISTANTS = `
  SELECT
    ua.id, ua.user_id, ua.slug, ua.name, ua.category, ua.description,
    ua.system_prompt, ua.knowledge_markdown, ua.recommended_routing_mode,
    ua.created_at, ua.updated_at,
    (
      SELECT COUNT(*)
      FROM custom_user_key_assistant_bindings b
      JOIN user_api_keys k ON k.id = b.key_id AND k.revoked = 0
      WHERE b.user_assistant_id = ua.id AND b.user_id = ua.user_id
    ) AS bound_keys_count
  FROM custom_user_assistants ua
`;

function mapUserAssistantRow(row: UserAssistantRow): UserCustomAssistant {
  return {
    id: row.id,
    userId: row.user_id,
    assistantRef: `user:${row.id}`,
    slug: row.slug,
    name: row.name,
    category: normalizeCategory(row.category),
    description: row.description,
    systemPrompt: row.system_prompt,
    knowledgeMarkdown: row.knowledge_markdown,
    recommendedRoutingMode: normalizeRoutingMode(row.recommended_routing_mode, 'balanced'),
    boundKeysCount: Number(row.bound_keys_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listUserCustomAssistants(userId: number): UserCustomAssistant[] {
  const db = getDb();
  const rows = db.prepare(`
    ${SELECT_USER_ASSISTANTS}
    WHERE ua.user_id = ?
    ORDER BY ua.updated_at DESC, ua.id DESC
  `).all(userId) as UserAssistantRow[];
  return rows.map(mapUserAssistantRow);
}

export function getUserCustomAssistant(userId: number, id: number): UserCustomAssistant {
  const db = getDb();
  const row = db.prepare(`
    ${SELECT_USER_ASSISTANTS}
    WHERE ua.id = ? AND ua.user_id = ?
  `).get(id, userId) as UserAssistantRow | undefined;
  if (!row) {
    throw new CustomerAiError(404, 'assistant_not_found', 'Custom assistant not found.');
  }
  return mapUserAssistantRow(row);
}

export function createUserCustomAssistant(
  userId: number,
  input: UserCustomAssistantInput,
): UserCustomAssistant {
  const db = getDb();
  const countRow = db
    .prepare('SELECT COUNT(*) AS cnt FROM custom_user_assistants WHERE user_id = ?')
    .get(userId) as { cnt: number };
  if (countRow.cnt >= MAX_USER_CUSTOM_ASSISTANTS) {
    throw new CustomerAiError(
      400,
      'custom_assistant_limit_reached',
      `Maximum of ${MAX_USER_CUSTOM_ASSISTANTS} custom assistants per user reached.`,
    );
  }

  const name = input.name.trim();
  if (name.length < 2 || name.length > 100) {
    throw new CustomerAiError(400, 'invalid_name', 'Assistant name must be between 2 and 100 characters.');
  }

  const systemPrompt = input.systemPrompt.trim();
  if (systemPrompt.length < 4 || systemPrompt.length > MAX_USER_ASSISTANT_SYSTEM_PROMPT_CHARS) {
    throw new CustomerAiError(
      400,
      'invalid_system_prompt',
      `System prompt must be between 4 and ${MAX_USER_ASSISTANT_SYSTEM_PROMPT_CHARS} characters.`,
    );
  }

  const knowledgeMarkdown = assertValidKnowledgeMarkdown(input.knowledgeMarkdown);
  const slug = deriveUniqueUserSlug(userId, input.slug, name);
  const category = normalizeCategory(input.category);
  const description = (input.description ?? '').trim().slice(0, 500);
  const recommendedRoutingMode = normalizeRoutingMode(input.recommendedRoutingMode, 'balanced');

  const res = db.prepare(`
    INSERT INTO custom_user_assistants (
      user_id, slug, name, category, description,
      system_prompt, knowledge_markdown, recommended_routing_mode
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId,
    slug,
    name,
    category,
    description,
    systemPrompt,
    knowledgeMarkdown,
    recommendedRoutingMode,
  );

  return getUserCustomAssistant(userId, Number(res.lastInsertRowid));
}

export function updateUserCustomAssistant(
  userId: number,
  id: number,
  patch: Partial<UserCustomAssistantInput>,
): UserCustomAssistant {
  const db = getDb();
  const current = db.prepare(`
    SELECT id, user_id, slug, name, category, description, system_prompt, knowledge_markdown, recommended_routing_mode
    FROM custom_user_assistants
    WHERE id = ? AND user_id = ?
  `).get(id, userId) as {
    id: number;
    user_id: number;
    slug: string;
    name: string;
    category: string;
    description: string;
    system_prompt: string;
    knowledge_markdown: string;
    recommended_routing_mode: string;
  } | undefined;

  if (!current) {
    throw new CustomerAiError(404, 'assistant_not_found', 'Custom assistant not found.');
  }

  const nextName = patch.name !== undefined ? patch.name.trim() : current.name;
  if (nextName.length < 2 || nextName.length > 100) {
    throw new CustomerAiError(400, 'invalid_name', 'Assistant name must be between 2 and 100 characters.');
  }

  const nextPrompt = patch.systemPrompt !== undefined ? patch.systemPrompt.trim() : current.system_prompt;
  if (nextPrompt.length < 4 || nextPrompt.length > MAX_USER_ASSISTANT_SYSTEM_PROMPT_CHARS) {
    throw new CustomerAiError(
      400,
      'invalid_system_prompt',
      `System prompt must be between 4 and ${MAX_USER_ASSISTANT_SYSTEM_PROMPT_CHARS} characters.`,
    );
  }

  const nextKnowledge = patch.knowledgeMarkdown !== undefined
    ? assertValidKnowledgeMarkdown(patch.knowledgeMarkdown)
    : current.knowledge_markdown;

  const nextSlug = patch.slug !== undefined
    ? deriveUniqueUserSlug(userId, patch.slug, nextName, id)
    : current.slug;

  const nextCategory = patch.category !== undefined
    ? normalizeCategory(patch.category)
    : normalizeCategory(current.category);

  const nextDescription = patch.description !== undefined
    ? patch.description.trim().slice(0, 500)
    : current.description;

  const nextRoutingMode = patch.recommendedRoutingMode !== undefined
    ? normalizeRoutingMode(patch.recommendedRoutingMode, 'balanced')
    : normalizeRoutingMode(current.recommended_routing_mode, 'balanced');

  db.prepare(`
    UPDATE custom_user_assistants
    SET slug = ?,
        name = ?,
        category = ?,
        description = ?,
        system_prompt = ?,
        knowledge_markdown = ?,
        recommended_routing_mode = ?,
        updated_at = datetime('now')
    WHERE id = ? AND user_id = ?
  `).run(
    nextSlug,
    nextName,
    nextCategory,
    nextDescription,
    nextPrompt,
    nextKnowledge,
    nextRoutingMode,
    id,
    userId,
  );

  return getUserCustomAssistant(userId, id);
}

export function deleteUserCustomAssistant(userId: number, id: number): boolean {
  const db = getDb();
  return db.transaction(() => {
    db.prepare('DELETE FROM custom_user_key_assistant_bindings WHERE user_assistant_id = ? AND user_id = ?').run(id, userId);
    const res = db.prepare('DELETE FROM custom_user_assistants WHERE id = ? AND user_id = ?').run(id, userId);
    return res.changes > 0;
  })();
}

export interface CustomAssistantRuntimeRecord {
  id: number;
  slug: string;
  name: string;
  systemPrompt: string;
  knowledgeMarkdown: string;
  recommendedRoutingMode: KeyRoutingMode;
}

export function getBoundCustomAssistantForRuntimeKey(
  userId: number,
  keyId: number,
): CustomAssistantRuntimeRecord | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT
      ua.id, ua.slug, ua.name, ua.system_prompt, ua.knowledge_markdown, ua.recommended_routing_mode
    FROM custom_user_key_assistant_bindings b
    JOIN custom_user_assistants ua ON ua.id = b.user_assistant_id AND ua.user_id = b.user_id
    WHERE b.key_id = ? AND b.user_id = ?
  `).get(keyId, userId) as {
    id: number;
    slug: string;
    name: string;
    system_prompt: string;
    knowledge_markdown: string;
    recommended_routing_mode: string;
  } | undefined;

  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    systemPrompt: row.system_prompt,
    knowledgeMarkdown: row.knowledge_markdown,
    recommendedRoutingMode: normalizeRoutingMode(row.recommended_routing_mode, 'balanced'),
  };
}

export function listUserKeyCustomBindings(userId: number): UserKeyCustomBinding[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      b.key_id, b.user_assistant_id, b.updated_at,
      ua.slug, ua.name, ua.recommended_routing_mode
    FROM custom_user_key_assistant_bindings b
    JOIN custom_user_assistants ua ON ua.id = b.user_assistant_id AND ua.user_id = b.user_id
    JOIN user_api_keys k ON k.id = b.key_id AND k.user_id = b.user_id AND k.revoked = 0
    WHERE b.user_id = ?
    ORDER BY b.key_id DESC
  `).all(userId) as Array<{
    key_id: number;
    user_assistant_id: number;
    updated_at: string;
    slug: string;
    name: string;
    recommended_routing_mode: string;
  }>;

  return rows.map(r => ({
    keyId: r.key_id,
    userAssistantId: r.user_assistant_id,
    assistantRef: `user:${r.user_assistant_id}`,
    slug: r.slug,
    name: r.name,
    recommendedRoutingMode: normalizeRoutingMode(r.recommended_routing_mode, 'balanced'),
    updatedAt: r.updated_at,
  }));
}

export function setKeyCustomAssistantBinding(
  userId: number,
  keyId: number,
  userAssistantId: number | null,
): void {
  const db = getDb();
  if (userAssistantId === null) {
    db.prepare('DELETE FROM custom_user_key_assistant_bindings WHERE key_id = ? AND user_id = ?').run(keyId, userId);
    return;
  }
  db.prepare(`
    INSERT INTO custom_user_key_assistant_bindings (key_id, user_id, user_assistant_id, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(key_id) DO UPDATE SET
      user_id = excluded.user_id,
      user_assistant_id = excluded.user_assistant_id,
      updated_at = datetime('now')
  `).run(keyId, userId, userAssistantId);
}

export interface ResolvedWorkspaceAssistant {
  kind: 'catalog' | 'user';
  assistantRef: string;
  catalogId: number | null;
  userAssistantId: number | null;
  slug: string;
  name: string;
  systemPrompt: string;
  knowledgeMarkdown: string;
  recommendedRoutingMode: KeyRoutingMode;
}

export function resolveWorkspaceAssistantForUser(
  user: { userId: number; role: 'admin' | 'member' },
  ref: number | string,
): ResolvedWorkspaceAssistant | null {
  const db = getDb();

  if (typeof ref === 'number') {
    const catalog = getAssistantForRuntime(ref, user.role);
    if (!catalog) return null;
    return {
      kind: 'catalog',
      assistantRef: catalog.slug,
      catalogId: catalog.id,
      userAssistantId: null,
      slug: catalog.slug,
      name: catalog.name,
      systemPrompt: catalog.systemPrompt,
      knowledgeMarkdown: '',
      recommendedRoutingMode: catalog.recommendedRoutingMode,
    };
  }

  const trimmed = ref.trim();
  if (!trimmed) return null;

  if (/^user:/i.test(trimmed)) {
    const token = trimmed.slice(5).trim();
    if (!token) return null;
    const numericId = /^\d+$/.test(token) ? Number.parseInt(token, 10) : null;
    const row = numericId !== null && numericId > 0
      ? db.prepare(`
          SELECT id, slug, name, system_prompt, knowledge_markdown, recommended_routing_mode
          FROM custom_user_assistants
          WHERE id = ? AND user_id = ?
        `).get(numericId, user.userId)
      : db.prepare(`
          SELECT id, slug, name, system_prompt, knowledge_markdown, recommended_routing_mode
          FROM custom_user_assistants
          WHERE slug = ? AND user_id = ?
        `).get(token.toLowerCase(), user.userId);

    const typed = row as {
      id: number;
      slug: string;
      name: string;
      system_prompt: string;
      knowledge_markdown: string;
      recommended_routing_mode: string;
    } | undefined;
    if (!typed) return null;
    return {
      kind: 'user',
      assistantRef: `user:${typed.id}`,
      catalogId: null,
      userAssistantId: typed.id,
      slug: typed.slug,
      name: typed.name,
      systemPrompt: typed.system_prompt,
      knowledgeMarkdown: typed.knowledge_markdown,
      recommendedRoutingMode: normalizeRoutingMode(typed.recommended_routing_mode, 'balanced'),
    };
  }

  // Check user's own custom assistants by slug first, then system catalog
  const ownBySlug = db.prepare(`
    SELECT id, slug, name, system_prompt, knowledge_markdown, recommended_routing_mode
    FROM custom_user_assistants
    WHERE slug = ? AND user_id = ?
  `).get(trimmed.toLowerCase(), user.userId) as {
    id: number;
    slug: string;
    name: string;
    system_prompt: string;
    knowledge_markdown: string;
    recommended_routing_mode: string;
  } | undefined;

  if (ownBySlug) {
    return {
      kind: 'user',
      assistantRef: `user:${ownBySlug.id}`,
      catalogId: null,
      userAssistantId: ownBySlug.id,
      slug: ownBySlug.slug,
      name: ownBySlug.name,
      systemPrompt: ownBySlug.system_prompt,
      knowledgeMarkdown: ownBySlug.knowledge_markdown,
      recommendedRoutingMode: normalizeRoutingMode(ownBySlug.recommended_routing_mode, 'balanced'),
    };
  }

  const catalog = getAssistantForRuntime(trimmed, user.role);
  if (!catalog) return null;
  return {
    kind: 'catalog',
    assistantRef: catalog.slug,
    catalogId: catalog.id,
    userAssistantId: null,
    slug: catalog.slug,
    name: catalog.name,
    systemPrompt: catalog.systemPrompt,
    knowledgeMarkdown: '',
    recommendedRoutingMode: catalog.recommendedRoutingMode,
  };
}

// ─── Persistent Chat Threads & Conversation Branching ─────────────────────────

interface ThreadRow {
  id: number;
  user_id: number;
  assistant_ref: string;
  assistant_name_snapshot: string;
  title: string;
  routing_mode: string;
  forked_from_thread_id: number | null;
  forked_from_message_index: number | null;
  message_count: number;
  created_at: string;
  updated_at: string;
}

interface ThreadMessageRow {
  id: number;
  thread_id: number;
  user_id: number;
  message_index: number;
  role: string;
  content: string;
  model: string | null;
  routing_mode: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  created_at: string;
}

const SELECT_THREADS_WITH_COUNT = `
  SELECT
    t.id, t.user_id, t.assistant_ref, t.assistant_name_snapshot,
    t.title, t.routing_mode, t.forked_from_thread_id, t.forked_from_message_index,
    t.created_at, t.updated_at,
    (SELECT COUNT(*) FROM custom_assistant_messages m WHERE m.thread_id = t.id AND m.user_id = t.user_id) AS message_count
  FROM custom_assistant_threads t
`;

function mapThreadSummary(row: ThreadRow): AssistantThreadSummary {
  return {
    id: row.id,
    userId: row.user_id,
    assistantRef: row.assistant_ref,
    assistantNameSnapshot: row.assistant_name_snapshot,
    title: row.title,
    routingMode: normalizeRoutingMode(row.routing_mode, 'balanced'),
    messageCount: Number(row.message_count ?? 0),
    forkedFromThreadId: row.forked_from_thread_id ?? null,
    forkedFromMessageIndex: row.forked_from_message_index ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapThreadMessage(row: ThreadMessageRow): AssistantThreadMessage {
  return {
    id: row.id,
    threadId: row.thread_id,
    messageIndex: row.message_index,
    role: row.role === 'assistant' ? 'assistant' : 'user',
    content: row.content,
    model: row.model ?? null,
    routingMode: row.routing_mode ? normalizeRoutingMode(row.routing_mode, 'balanced') : null,
    usage: {
      promptTokens: Number(row.prompt_tokens ?? 0),
      completionTokens: Number(row.completion_tokens ?? 0),
      totalTokens: Number(row.total_tokens ?? 0),
    },
    createdAt: row.created_at,
  };
}

export function listAssistantThreads(
  userId: number,
  options?: { assistantRef?: string; limit?: number },
): AssistantThreadSummary[] {
  const db = getDb();
  const limit = Math.min(Math.max(options?.limit ?? 50, 1), 200);
  const assistantRef = options?.assistantRef?.trim();
  const rows = assistantRef
    ? (db.prepare(`
        ${SELECT_THREADS_WITH_COUNT}
        WHERE t.user_id = ? AND t.assistant_ref = ?
        ORDER BY t.updated_at DESC, t.id DESC
        LIMIT ?
      `).all(userId, assistantRef, limit) as ThreadRow[])
    : (db.prepare(`
        ${SELECT_THREADS_WITH_COUNT}
        WHERE t.user_id = ?
        ORDER BY t.updated_at DESC, t.id DESC
        LIMIT ?
      `).all(userId, limit) as ThreadRow[]);

  return rows.map(mapThreadSummary);
}

export function getAssistantThread(userId: number, threadId: number): AssistantThreadDetail {
  const db = getDb();
  const row = db.prepare(`
    ${SELECT_THREADS_WITH_COUNT}
    WHERE t.id = ? AND t.user_id = ?
  `).get(threadId, userId) as ThreadRow | undefined;

  if (!row) {
    throw new CustomerAiError(404, 'thread_not_found', 'Conversation thread not found.');
  }

  const messages = db.prepare(`
    SELECT
      id, thread_id, user_id, message_index, role, content,
      model, routing_mode, prompt_tokens, completion_tokens, total_tokens, created_at
    FROM custom_assistant_messages
    WHERE thread_id = ? AND user_id = ?
    ORDER BY message_index ASC, id ASC
  `).all(threadId, userId) as ThreadMessageRow[];

  return {
    ...mapThreadSummary(row),
    messages: messages.map(mapThreadMessage),
  };
}

export function createAssistantThread(
  user: { userId: number; role: 'admin' | 'member' },
  input: { assistantRef: string; title?: string; routingMode?: KeyRoutingMode },
): AssistantThreadDetail {
  const resolved = resolveWorkspaceAssistantForUser(user, input.assistantRef);
  if (!resolved) {
    throw new CustomerAiError(404, 'assistant_not_found', 'Assistant not found or unavailable.');
  }

  const db = getDb();
  const title = (input.title ?? '').trim().slice(0, 140) || resolved.name;
  const routingMode = input.routingMode
    ? normalizeRoutingMode(input.routingMode, resolved.recommendedRoutingMode)
    : resolved.recommendedRoutingMode;

  const res = db.prepare(`
    INSERT INTO custom_assistant_threads (
      user_id, assistant_ref, assistant_name_snapshot, title, routing_mode
    ) VALUES (?, ?, ?, ?, ?)
  `).run(user.userId, resolved.assistantRef, resolved.name, title, routingMode);

  return getAssistantThread(user.userId, Number(res.lastInsertRowid));
}

export function updateAssistantThread(
  userId: number,
  threadId: number,
  patch: { title?: string; routingMode?: KeyRoutingMode },
): AssistantThreadSummary {
  const db = getDb();
  const existing = db.prepare(`
    ${SELECT_THREADS_WITH_COUNT}
    WHERE t.id = ? AND t.user_id = ?
  `).get(threadId, userId) as ThreadRow | undefined;

  if (!existing) {
    throw new CustomerAiError(404, 'thread_not_found', 'Conversation thread not found.');
  }

  const nextTitle = patch.title !== undefined
    ? patch.title.trim().slice(0, 140)
    : existing.title;
  if (!nextTitle) {
    throw new CustomerAiError(400, 'invalid_title', 'Thread title cannot be empty.');
  }

  const nextMode = patch.routingMode !== undefined
    ? normalizeRoutingMode(patch.routingMode, 'balanced')
    : normalizeRoutingMode(existing.routing_mode, 'balanced');

  db.prepare(`
    UPDATE custom_assistant_threads
    SET title = ?, routing_mode = ?, updated_at = datetime('now')
    WHERE id = ? AND user_id = ?
  `).run(nextTitle, nextMode, threadId, userId);

  const updated = db.prepare(`
    ${SELECT_THREADS_WITH_COUNT}
    WHERE t.id = ? AND t.user_id = ?
  `).get(threadId, userId) as ThreadRow;
  return mapThreadSummary(updated);
}

export function deleteAssistantThread(userId: number, threadId: number): boolean {
  const db = getDb();
  const res = db.prepare('DELETE FROM custom_assistant_threads WHERE id = ? AND user_id = ?').run(threadId, userId);
  return res.changes > 0;
}

function summarizePromptAsTitle(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= 64) return oneLine || 'New Conversation';
  return `${oneLine.slice(0, 61).trimEnd()}…`;
}

export function appendTurnPairToThread(
  userId: number,
  threadId: number,
  turn: {
    userContent: string;
    assistantContent: string;
    model: string | null;
    routingMode: KeyRoutingMode;
    usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  },
): {
  userMessage: AssistantThreadMessage;
  assistantMessage: AssistantThreadMessage;
  thread: AssistantThreadSummary;
} {
  const db = getDb();
  return db.transaction(() => {
    const threadRow = db.prepare(`
      SELECT id, user_id, title, assistant_name_snapshot
      FROM custom_assistant_threads
      WHERE id = ? AND user_id = ?
    `).get(threadId, userId) as {
      id: number;
      user_id: number;
      title: string;
      assistant_name_snapshot: string;
    } | undefined;

    if (!threadRow) {
      throw new CustomerAiError(404, 'thread_not_found', 'Conversation thread not found.');
    }

    const maxRow = db.prepare(`
      SELECT COALESCE(MAX(message_index), -1) AS maxIdx
      FROM custom_assistant_messages
      WHERE thread_id = ? AND user_id = ?
    `).get(threadId, userId) as { maxIdx: number };

    const userIndex = maxRow.maxIdx + 1;
    const assistantIndex = userIndex + 1;

    const userInsert = db.prepare(`
      INSERT INTO custom_assistant_messages (
        thread_id, user_id, message_index, role, content,
        model, routing_mode, prompt_tokens, completion_tokens, total_tokens
      ) VALUES (?, ?, ?, 'user', ?, NULL, ?, 0, 0, 0)
    `).run(threadId, userId, userIndex, turn.userContent, turn.routingMode);

    const assistantInsert = db.prepare(`
      INSERT INTO custom_assistant_messages (
        thread_id, user_id, message_index, role, content,
        model, routing_mode, prompt_tokens, completion_tokens, total_tokens
      ) VALUES (?, ?, ?, 'assistant', ?, ?, ?, ?, ?, ?)
    `).run(
      threadId,
      userId,
      assistantIndex,
      turn.assistantContent,
      turn.model,
      turn.routingMode,
      turn.usage.promptTokens,
      turn.usage.completionTokens,
      turn.usage.totalTokens,
    );

    const shouldAutoTitle =
      userIndex === 0 &&
      (!threadRow.title ||
        threadRow.title === threadRow.assistant_name_snapshot ||
        threadRow.title === 'New Thread' ||
        threadRow.title === 'Cuộc trò chuyện mới');

    const nextTitle = shouldAutoTitle ? summarizePromptAsTitle(turn.userContent) : threadRow.title;

    db.prepare(`
      UPDATE custom_assistant_threads
      SET title = ?, routing_mode = ?, updated_at = datetime('now')
      WHERE id = ? AND user_id = ?
    `).run(nextTitle, turn.routingMode, threadId, userId);

    const userMsgRow = db.prepare('SELECT * FROM custom_assistant_messages WHERE id = ?').get(
      userInsert.lastInsertRowid,
    ) as ThreadMessageRow;
    const assistantMsgRow = db.prepare('SELECT * FROM custom_assistant_messages WHERE id = ?').get(
      assistantInsert.lastInsertRowid,
    ) as ThreadMessageRow;
    const updatedThread = db.prepare(`${SELECT_THREADS_WITH_COUNT} WHERE t.id = ? AND t.user_id = ?`).get(
      threadId,
      userId,
    ) as ThreadRow;

    return {
      userMessage: mapThreadMessage(userMsgRow),
      assistantMessage: mapThreadMessage(assistantMsgRow),
      thread: mapThreadSummary(updatedThread),
    };
  })();
}

export function branchAssistantThread(
  userId: number,
  threadId: number,
  input: { fromMessageIndex?: number; fromMessageId?: number; title?: string },
): AssistantThreadDetail {
  const source = getAssistantThread(userId, threadId);
  let cutoffIndex: number;

  if (input.fromMessageIndex !== undefined) {
    if (
      !Number.isInteger(input.fromMessageIndex) ||
      input.fromMessageIndex < 0 ||
      input.fromMessageIndex >= source.messages.length
    ) {
      throw new CustomerAiError(
        400,
        'invalid_branch_point',
        'Invalid message index for thread branching.',
      );
    }
    cutoffIndex = input.fromMessageIndex;
  } else if (input.fromMessageId !== undefined) {
    const matched = source.messages.find(m => m.id === input.fromMessageId);
    if (!matched) {
      throw new CustomerAiError(
        400,
        'invalid_branch_point',
        'Target message ID was not found in this thread.',
      );
    }
    cutoffIndex = matched.messageIndex;
  } else {
    cutoffIndex = source.messages.length - 1;
  }

  const db = getDb();
  const newThreadId = db.transaction(() => {
    const branchedTitle =
      (input.title ?? '').trim().slice(0, 140) ||
      `${source.title.slice(0, 120)} (Fork)`;

    const threadInsert = db.prepare(`
      INSERT INTO custom_assistant_threads (
        user_id, assistant_ref, assistant_name_snapshot, title, routing_mode,
        forked_from_thread_id, forked_from_message_index
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId,
      source.assistantRef,
      source.assistantNameSnapshot,
      branchedTitle,
      source.routingMode,
      source.id,
      cutoffIndex >= 0 ? cutoffIndex : null,
    );

    const createdId = Number(threadInsert.lastInsertRowid);

    if (cutoffIndex >= 0) {
      const insertMsg = db.prepare(`
        INSERT INTO custom_assistant_messages (
          thread_id, user_id, message_index, role, content,
          model, routing_mode, prompt_tokens, completion_tokens, total_tokens
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const slice = source.messages.filter(m => m.messageIndex <= cutoffIndex);
      slice.forEach((msg, idx) => {
        insertMsg.run(
          createdId,
          userId,
          idx,
          msg.role,
          msg.content,
          msg.model,
          msg.routingMode,
          msg.usage.promptTokens,
          msg.usage.completionTokens,
          msg.usage.totalTokens,
        );
      });
    }

    return createdId;
  })();

  return getAssistantThread(userId, newThreadId);
}
