import { getDb } from '../../db/index.js';
import { resetGuestCache } from '../../services/guest-access.js';
import type { PresetStrategy } from '../../services/scoring.js';
import { getActiveVerifiedCloudRuntimePack } from '../cloud-entitlement/service.js';
import {
  ASSISTANT_AUDIENCES,
  ASSISTANT_CATEGORIES,
  KEY_ROUTING_MODES,
  type AdminAiAssistant,
  type AssistantAudience,
  type AssistantCategory,
  type CustomerAiAssistant,
  type KeyRoutingMode,
  type UserAiPreferences,
} from '@freellmapi/shared/customer-ai.js';

/** Maps customer-friendly key routing modes to router bandit presets. */
export function routingModeToPreset(mode: KeyRoutingMode | string | null | undefined): PresetStrategy | undefined {
  switch (mode) {
    case 'eco':
      return 'fastest';
    case 'balanced':
      return 'balanced';
    case 'max':
      return 'smartest';
    default:
      return undefined;
  }
}

/** Composes assistant persona prompt with optional user custom instructions. */
export function composeUserKeySystemPrompt(
  assistantPrompt: string | null | undefined,
  customInstructions: string | null | undefined,
  applyToKeys: boolean,
): string | null {
  const parts: string[] = [];
  const base = assistantPrompt?.trim();
  if (base) parts.push(base);
  const custom = applyToKeys ? customInstructions?.trim() : '';
  if (custom) {
    parts.push(`[User Custom Instructions]\n${custom}`);
  }
  return parts.length > 0 ? parts.join('\n\n') : null;
}

export const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{1,62}$/;

export class CustomerAiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

interface AssistantRow {
  id: number;
  slug: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  system_prompt: string;
  recommended_routing_mode: string;
  starter_prompts_json: string;
  audience: string;
  enabled: number;
  sort_order: number;
  playground_runs: number;
  bound_keys_count: number;
  created_at: string;
  updated_at: string;
}

const VALID_MODES = new Set<string>(KEY_ROUTING_MODES);
const VALID_CATEGORIES = new Set<string>(ASSISTANT_CATEGORIES);
const VALID_AUDIENCES = new Set<string>(ASSISTANT_AUDIENCES);

export function normalizeRoutingMode(raw: string | null | undefined, fallback: KeyRoutingMode = 'default'): KeyRoutingMode {
  return raw && VALID_MODES.has(raw) ? (raw as KeyRoutingMode) : fallback;
}

function normalizeCategory(raw: string | null | undefined): AssistantCategory {
  return raw && VALID_CATEGORIES.has(raw) ? (raw as AssistantCategory) : 'general';
}

function normalizeAudience(raw: string | null | undefined): AssistantAudience {
  return raw && VALID_AUDIENCES.has(raw) ? (raw as AssistantAudience) : 'all_members';
}

function parseStarterPrompts(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((s): s is string => typeof s === 'string')
      .map(s => s.trim())
      .filter(Boolean)
      .slice(0, 6);
  } catch {
    return [];
  }
}

export function normalizeSlug(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  if (!SLUG_REGEX.test(normalized)) {
    throw new CustomerAiError(
      400,
      'invalid_slug',
      'Slug must be 2–63 lowercase alphanumeric characters or hyphens and start with a letter or digit.',
    );
  }
  return normalized;
}

function mapCustomerRow(row: AssistantRow): CustomerAiAssistant {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    category: normalizeCategory(row.category),
    icon: row.icon || 'sparkles',
    recommendedRoutingMode: normalizeRoutingMode(row.recommended_routing_mode, 'balanced'),
    starterPrompts: parseStarterPrompts(row.starter_prompts_json),
    audience: normalizeAudience(row.audience),
    boundKeysCount: Number(row.bound_keys_count ?? 0),
    playgroundRuns: Number(row.playground_runs ?? 0),
  };
}

function mapAdminRow(row: AssistantRow): AdminAiAssistant {
  const cloudPack = getActiveVerifiedCloudRuntimePack();
  const remoteAssistant = cloudPack?.customerAiAssistants?.[row.slug];
  const effectiveSystemPrompt = remoteAssistant?.systemPrompt?.trim() || row.system_prompt;

  return {
    ...mapCustomerRow(row),
    systemPrompt: effectiveSystemPrompt,
    enabled: Boolean(row.enabled),
    sortOrder: Number(row.sort_order ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT_ASSISTANTS_WITH_COUNT = `
  SELECT
    a.id, a.slug, a.name, a.description, a.category, a.icon,
    a.system_prompt, a.recommended_routing_mode, a.starter_prompts_json,
    a.audience, a.enabled, a.sort_order, a.playground_runs,
    a.created_at, a.updated_at,
    (SELECT COUNT(*) FROM user_api_keys k WHERE k.assistant_id = a.id AND k.revoked = 0) AS bound_keys_count
  FROM custom_ai_assistants a
`;

export function listAssistantsForCustomer(options: { isGuest?: boolean; isAdmin?: boolean }): CustomerAiAssistant[] {
  const db = getDb();
  const audienceWhere = options.isGuest
    ? "a.audience = 'guest_preview'"
    : options.isAdmin
      ? '1 = 1'
      : "a.audience IN ('all_members', 'guest_preview')";

  const rows = db.prepare(`
    ${SELECT_ASSISTANTS_WITH_COUNT}
    WHERE a.enabled = 1 AND ${audienceWhere}
    ORDER BY a.sort_order ASC, a.id ASC
  `).all() as AssistantRow[];

  return rows.map(mapCustomerRow);
}

export function listAssistantsForAdmin(): AdminAiAssistant[] {
  const db = getDb();
  const rows = db.prepare(`
    ${SELECT_ASSISTANTS_WITH_COUNT}
    ORDER BY a.sort_order ASC, a.id ASC
  `).all() as AssistantRow[];

  return rows.map(mapAdminRow);
}

export interface AssistantRuntimeRecord {
  id: number;
  slug: string;
  name: string;
  systemPrompt: string;
  recommendedRoutingMode: KeyRoutingMode;
}

export function getAssistantForRuntime(
  idOrSlug: number | string,
  callerRole: 'admin' | 'member',
): AssistantRuntimeRecord | null {
  const db = getDb();
  const isId = typeof idOrSlug === 'number';
  const row = db.prepare(`
    SELECT id, slug, name, system_prompt, recommended_routing_mode, audience, enabled
    FROM custom_ai_assistants
    WHERE ${isId ? 'id = ?' : 'slug = ?'}
  `).get(idOrSlug) as {
    id: number;
    slug: string;
    name: string;
    system_prompt: string;
    recommended_routing_mode: string;
    audience: string;
    enabled: number;
  } | undefined;

  if (!row || !row.enabled) return null;
  if (callerRole !== 'admin' && row.audience === 'admin_only') return null;

  const cloudPack = getActiveVerifiedCloudRuntimePack();
  const remoteAssistant = cloudPack?.customerAiAssistants?.[row.slug];
  const effectiveSystemPrompt = remoteAssistant?.systemPrompt?.trim() || row.system_prompt;

  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    systemPrompt: effectiveSystemPrompt,
    recommendedRoutingMode: normalizeRoutingMode(row.recommended_routing_mode, 'balanced'),
  };
}

export interface CreateAssistantInput {
  slug: string;
  name: string;
  description?: string;
  category?: AssistantCategory;
  icon?: string;
  systemPrompt: string;
  recommendedRoutingMode?: KeyRoutingMode;
  starterPrompts?: string[];
  audience?: AssistantAudience;
  enabled?: boolean;
  sortOrder?: number;
}

export function createAssistant(input: CreateAssistantInput): AdminAiAssistant {
  const db = getDb();
  const slug = normalizeSlug(input.slug);
  const existing = db.prepare('SELECT id FROM custom_ai_assistants WHERE slug = ?').get(slug) as { id: number } | undefined;
  if (existing) {
    throw new CustomerAiError(409, 'duplicate_slug', `An assistant with slug '${slug}' already exists.`);
  }

  const starterPrompts = (input.starterPrompts ?? []).map(s => s.trim()).filter(Boolean).slice(0, 6);
  const result = db.prepare(`
    INSERT INTO custom_ai_assistants (
      slug, name, description, category, icon, system_prompt,
      recommended_routing_mode, starter_prompts_json, audience, enabled, sort_order
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    slug,
    input.name.trim(),
    (input.description ?? '').trim(),
    normalizeCategory(input.category),
    (input.icon ?? 'sparkles').trim() || 'sparkles',
    input.systemPrompt.trim(),
    normalizeRoutingMode(input.recommendedRoutingMode, 'balanced'),
    JSON.stringify(starterPrompts),
    normalizeAudience(input.audience),
    input.enabled === false ? 0 : 1,
    Number.isFinite(input.sortOrder) ? Math.trunc(input.sortOrder!) : 100,
  );

  resetGuestCache();
  const created = db.prepare(`${SELECT_ASSISTANTS_WITH_COUNT} WHERE a.id = ?`).get(result.lastInsertRowid) as AssistantRow;
  return mapAdminRow(created);
}

export interface UpdateAssistantInput {
  slug?: string;
  name?: string;
  description?: string;
  category?: AssistantCategory;
  icon?: string;
  systemPrompt?: string;
  recommendedRoutingMode?: KeyRoutingMode;
  starterPrompts?: string[];
  audience?: AssistantAudience;
  enabled?: boolean;
  sortOrder?: number;
}

export function updateAssistant(id: number, patch: UpdateAssistantInput): AdminAiAssistant {
  const db = getDb();
  const current = db.prepare(`${SELECT_ASSISTANTS_WITH_COUNT} WHERE a.id = ?`).get(id) as AssistantRow | undefined;
  if (!current) {
    throw new CustomerAiError(404, 'assistant_not_found', 'Assistant not found.');
  }

  const nextSlug = patch.slug !== undefined ? normalizeSlug(patch.slug) : current.slug;
  if (nextSlug !== current.slug) {
    const dup = db.prepare('SELECT id FROM custom_ai_assistants WHERE slug = ? AND id <> ?').get(nextSlug, id);
    if (dup) {
      throw new CustomerAiError(409, 'duplicate_slug', `An assistant with slug '${nextSlug}' already exists.`);
    }
  }

  const nextStarters = patch.starterPrompts !== undefined
    ? patch.starterPrompts.map(s => s.trim()).filter(Boolean).slice(0, 6)
    : parseStarterPrompts(current.starter_prompts_json);

  db.prepare(`
    UPDATE custom_ai_assistants
    SET slug = ?,
        name = ?,
        description = ?,
        category = ?,
        icon = ?,
        system_prompt = ?,
        recommended_routing_mode = ?,
        starter_prompts_json = ?,
        audience = ?,
        enabled = ?,
        sort_order = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(
    nextSlug,
    patch.name !== undefined ? patch.name.trim() : current.name,
    patch.description !== undefined ? patch.description.trim() : current.description,
    patch.category !== undefined ? normalizeCategory(patch.category) : normalizeCategory(current.category),
    patch.icon !== undefined ? (patch.icon.trim() || 'sparkles') : current.icon,
    patch.systemPrompt !== undefined ? patch.systemPrompt.trim() : current.system_prompt,
    patch.recommendedRoutingMode !== undefined
      ? normalizeRoutingMode(patch.recommendedRoutingMode, 'balanced')
      : normalizeRoutingMode(current.recommended_routing_mode, 'balanced'),
    JSON.stringify(nextStarters),
    patch.audience !== undefined ? normalizeAudience(patch.audience) : normalizeAudience(current.audience),
    patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : current.enabled,
    patch.sortOrder !== undefined && Number.isFinite(patch.sortOrder) ? Math.trunc(patch.sortOrder) : current.sort_order,
    id,
  );

  resetGuestCache();
  const updated = db.prepare(`${SELECT_ASSISTANTS_WITH_COUNT} WHERE a.id = ?`).get(id) as AssistantRow;
  return mapAdminRow(updated);
}

export function deleteAssistant(id: number): boolean {
  const db = getDb();
  const deleted = db.transaction(() => {
    db.prepare('UPDATE user_api_keys SET assistant_id = NULL WHERE assistant_id = ?').run(id);
    const res = db.prepare('DELETE FROM custom_ai_assistants WHERE id = ?').run(id);
    return res.changes > 0;
  })();
  if (deleted) resetGuestCache();
  return deleted;
}

export function incrementAssistantPlaygroundRuns(id: number): void {
  try {
    getDb().prepare('UPDATE custom_ai_assistants SET playground_runs = playground_runs + 1 WHERE id = ?').run(id);
  } catch {
    // Best effort counter update
  }
}

export function getUserAiPreferences(userId: number): UserAiPreferences {
  const db = getDb();
  const row = db.prepare(`
    SELECT custom_instructions, apply_to_keys, updated_at
    FROM custom_user_ai_preferences
    WHERE user_id = ?
  `).get(userId) as { custom_instructions: string; apply_to_keys: number; updated_at: string } | undefined;

  if (!row) {
    return {
      customInstructions: '',
      applyCustomInstructionsToKeys: true,
      updatedAt: null,
    };
  }

  return {
    customInstructions: row.custom_instructions,
    applyCustomInstructionsToKeys: Boolean(row.apply_to_keys),
    updatedAt: row.updated_at,
  };
}

export function setUserAiPreferences(
  userId: number,
  input: { customInstructions: string; applyCustomInstructionsToKeys: boolean },
): UserAiPreferences {
  const db = getDb();
  const clean = input.customInstructions.trim().slice(0, 2000);
  const apply = input.applyCustomInstructionsToKeys ? 1 : 0;

  db.prepare(`
    INSERT INTO custom_user_ai_preferences (user_id, custom_instructions, apply_to_keys, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      custom_instructions = excluded.custom_instructions,
      apply_to_keys = excluded.apply_to_keys,
      updated_at = datetime('now')
  `).run(userId, clean, apply);

  return getUserAiPreferences(userId);
}

export function assertBindableAssistant(
  assistantId: number | null | undefined,
  callerRole: 'admin' | 'member',
): number | null {
  if (assistantId === null || assistantId === undefined) return null;
  const runtime = getAssistantForRuntime(assistantId, callerRole);
  if (!runtime) {
    throw new CustomerAiError(400, 'invalid_assistant', 'Selected AI assistant is unavailable or restricted.');
  }
  return runtime.id;
}

export function updateUserKeyAiConfig(
  userId: number,
  callerRole: 'admin' | 'member',
  keyId: number,
  patch: {
    routingMode?: KeyRoutingMode;
    assistantId?: number | string | null;
    userAssistantId?: number | null;
    assistantRef?: string | null;
  },
): {
  id: number;
  routingMode: KeyRoutingMode;
  assistantId: number | null;
  userAssistantId: number | null;
  assistantRef: string | null;
  assistantSlug: string | null;
  assistantName: string | null;
} {
  const db = getDb();
  const key = db.prepare(`
    SELECT id, routing_mode, assistant_id, revoked
    FROM user_api_keys
    WHERE id = ? AND user_id = ?
  `).get(keyId, userId) as { id: number; routing_mode: string; assistant_id: number | null; revoked: number } | undefined;

  if (!key || key.revoked) {
    throw new CustomerAiError(404, 'key_not_found', 'Active personal API key not found.');
  }

  const nextMode = patch.routingMode !== undefined
    ? normalizeRoutingMode(patch.routingMode, 'default')
    : normalizeRoutingMode(key.routing_mode, 'default');

  const hasCustomBindingTable = Boolean(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'custom_user_key_assistant_bindings'").get(),
  );

  const existingCustomRow = hasCustomBindingTable
    ? (db.prepare(`
        SELECT ua.id, ua.slug, ua.name
        FROM custom_user_key_assistant_bindings b
        JOIN custom_user_assistants ua ON ua.id = b.user_assistant_id AND ua.user_id = b.user_id
        WHERE b.key_id = ? AND b.user_id = ?
      `).get(keyId, userId) as { id: number; slug: string; name: string } | undefined)
    : undefined;

  const hasAssistantMutation =
    patch.assistantId !== undefined ||
    patch.userAssistantId !== undefined ||
    patch.assistantRef !== undefined;

  let nextCatalogId: number | null = key.assistant_id;
  let nextUserAssistantId: number | null = existingCustomRow?.id ?? null;

  if (hasAssistantMutation) {
    const rawTarget: number | string | null =
      patch.userAssistantId !== undefined
        ? (patch.userAssistantId === null ? null : `user:${patch.userAssistantId}`)
        : patch.assistantRef !== undefined
          ? patch.assistantRef
          : (patch.assistantId ?? null);

    if (rawTarget === null || (typeof rawTarget === 'string' && rawTarget.trim() === '')) {
      nextCatalogId = null;
      nextUserAssistantId = null;
    } else if (typeof rawTarget === 'number') {
      nextCatalogId = assertBindableAssistant(rawTarget, callerRole);
      nextUserAssistantId = null;
    } else {
      const trimmed = rawTarget.trim();
      if (/^user:/i.test(trimmed)) {
        const token = trimmed.slice(5).trim();
        const parsedId = /^\d+$/.test(token) ? Number.parseInt(token, 10) : null;
        const customRow = parsedId !== null && parsedId > 0
          ? (db.prepare('SELECT id FROM custom_user_assistants WHERE id = ? AND user_id = ?').get(parsedId, userId) as { id: number } | undefined)
          : (db.prepare('SELECT id FROM custom_user_assistants WHERE slug = ? AND user_id = ?').get(token.toLowerCase(), userId) as { id: number } | undefined);
        if (!customRow) {
          throw new CustomerAiError(404, 'assistant_not_found', 'Custom assistant not found.');
        }
        nextCatalogId = null;
        nextUserAssistantId = customRow.id;
      } else {
        const ownCustom = hasCustomBindingTable
          ? (db.prepare('SELECT id FROM custom_user_assistants WHERE slug = ? AND user_id = ?').get(trimmed.toLowerCase(), userId) as { id: number } | undefined)
          : undefined;
        if (ownCustom) {
          nextCatalogId = null;
          nextUserAssistantId = ownCustom.id;
        } else {
          const catalog = getAssistantForRuntime(trimmed, callerRole);
          if (!catalog) {
            throw new CustomerAiError(400, 'invalid_assistant', 'Selected AI assistant is unavailable or restricted.');
          }
          nextCatalogId = catalog.id;
          nextUserAssistantId = null;
        }
      }
    }
  }

  db.transaction(() => {
    db.prepare(`
      UPDATE user_api_keys
      SET routing_mode = ?, assistant_id = ?
      WHERE id = ? AND user_id = ?
    `).run(nextMode, nextCatalogId, keyId, userId);

    if (hasCustomBindingTable && hasAssistantMutation) {
      if (nextUserAssistantId === null) {
        db.prepare('DELETE FROM custom_user_key_assistant_bindings WHERE key_id = ? AND user_id = ?').run(keyId, userId);
      } else {
        db.prepare(`
          INSERT INTO custom_user_key_assistant_bindings (key_id, user_id, user_assistant_id, updated_at)
          VALUES (?, ?, ?, datetime('now'))
          ON CONFLICT(key_id) DO UPDATE SET
            user_id = excluded.user_id,
            user_assistant_id = excluded.user_assistant_id,
            updated_at = datetime('now')
        `).run(keyId, userId, nextUserAssistantId);
      }
    }
  })();

  let assistantSlug: string | null = null;
  let assistantName: string | null = null;
  let assistantRef: string | null = null;

  if (nextUserAssistantId !== null && hasCustomBindingTable) {
    const ua = db
      .prepare('SELECT id, slug, name FROM custom_user_assistants WHERE id = ? AND user_id = ?')
      .get(nextUserAssistantId, userId) as { id: number; slug: string; name: string } | undefined;
    assistantSlug = ua?.slug ?? null;
    assistantName = ua?.name ?? null;
    assistantRef = ua ? `user:${ua.id}` : null;
  } else if (nextCatalogId !== null) {
    const a = db.prepare('SELECT slug, name FROM custom_ai_assistants WHERE id = ?').get(nextCatalogId) as
      | { slug: string; name: string }
      | undefined;
    assistantSlug = a?.slug ?? null;
    assistantName = a?.name ?? null;
    assistantRef = assistantSlug;
  }

  return {
    id: keyId,
    routingMode: nextMode,
    assistantId: nextCatalogId,
    userAssistantId: nextUserAssistantId,
    assistantRef,
    assistantSlug,
    assistantName,
  };
}

export function applyEcoModeToUserKeys(userId: number, keyId?: number): { updatedCount: number } {
  const db = getDb();
  const result = keyId !== undefined
    ? db.prepare(`
        UPDATE user_api_keys
        SET routing_mode = 'eco'
        WHERE user_id = ? AND id = ? AND revoked = 0 AND routing_mode <> 'eco'
      `).run(userId, keyId)
    : db.prepare(`
        UPDATE user_api_keys
        SET routing_mode = 'eco'
        WHERE user_id = ? AND revoked = 0 AND routing_mode <> 'eco'
      `).run(userId);
  return { updatedCount: result.changes };
}
