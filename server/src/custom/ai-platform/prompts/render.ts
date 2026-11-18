import type { Request } from 'express';
import {
  PROMPT_LIMITS,
  PROMPT_VAR_NAME_REGEX,
  SYSTEM_PROMPT_VARIABLE_NAMES,
  type PromptVariable,
} from '@freellmapi/shared/ai-platform-prompts.js';
import { getDb } from '../../../db/index.js';
import { getClientContext } from '../../../lib/client-context.js';
import type { GateProfile } from '../../../services/profile-usage.js';
import { isPillarEnabled } from '../flags.js';
import {
  getPublishedPrompt,
  resolveActivePromptVariant,
  type ActivePromptVariant,
} from './store.js';
import { renderWith, sanitizeVariableValue } from './template.js';

export interface PromptRequestContext {
  profileId: number;
  profileName: string;
  endUser: string | null;
  endUserName: string;
  language: string;
  callerVars: Record<string, string>;
  selectedPrompt: ActivePromptVariant | null;
}

const requestPromptContexts = new WeakMap<object, PromptRequestContext>();

function firstHeaderValue(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

function extractAbStickySeed(req: Request, endUser: string | null): string | null {
  const conv =
    firstHeaderValue(req.headers['x-freellm-conversation-id']) ??
    firstHeaderValue(req.headers['x-conversation-id']) ??
    firstHeaderValue(req.headers['x-session-id']);
  if (typeof conv === 'string' && conv.trim().length > 0) return conv.trim();
  if (typeof endUser === 'string' && endUser.trim().length > 0) return endUser.trim();
  return null;
}

function lookupProfileName(profileId: number): string {
  try {
    const row = getDb()
      .prepare('SELECT name FROM client_profiles WHERE id = ?')
      .get(profileId) as { name?: string } | undefined;
    return typeof row?.name === 'string' ? sanitizeVariableValue(row.name.trim()) : '';
  } catch {
    return '';
  }
}

/**
 * Parses `x-freellm-vars` JSON header safely.
 * Returns `{}` silently if missing, oversized (>2KB), invalid JSON, array, or non-plain object.
 * Filters variable names with `PROMPT_VAR_NAME_REGEX` and sanitizes primitive values.
 */
export function parseCallerVarsHeader(rawHeader: string | string[] | undefined): Record<string, string> {
  const raw = firstHeaderValue(rawHeader);
  if (typeof raw !== 'string' || raw.trim().length === 0) return {};
  if (Buffer.byteLength(raw, 'utf8') > PROMPT_LIMITS.maxCallerVarsHeaderBytes) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const proto = Object.getPrototypeOf(parsed);
  if (proto !== Object.prototype && proto !== null) return {};

  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
    if (!PROMPT_VAR_NAME_REGEX.test(key)) continue;
    if (typeof val !== 'string' && typeof val !== 'number' && typeof val !== 'boolean') continue;
    out[key] = sanitizeVariableValue(String(val));
  }
  return out;
}

/**
 * Extracts caller language from `x-freellm-language` or the primary subtag of `accept-language`.
 */
export function extractCallerLanguage(req: Request): string {
  const customLang = firstHeaderValue(req.headers['x-freellm-language']);
  if (typeof customLang === 'string' && customLang.trim().length > 0) {
    return sanitizeVariableValue(customLang.trim());
  }

  const acceptLang = firstHeaderValue(req.headers['accept-language']);
  if (typeof acceptLang === 'string' && acceptLang.trim().length > 0) {
    const firstEntry = acceptLang.split(',')[0]?.split(';')[0]?.trim() ?? '';
    if (firstEntry && firstEntry !== '*') {
      const primary = firstEntry.split(/[-_]/)[0]?.trim() ?? '';
      if (primary) return sanitizeVariableValue(primary);
    }
  }

  return '';
}

/**
 * Extracts end-user display name from `x-end-user-name` header.
 */
export function extractEndUserName(req: Request): string {
  const raw = firstHeaderValue(req.headers['x-end-user-name']);
  if (typeof raw === 'string' && raw.trim().length > 0) {
    return sanitizeVariableValue(raw.trim());
  }
  return '';
}

/**
 * Captures per-request prompt context onto the active `AsyncLocalStorage` client context.
 * Invoked in Slot 5 of `runPreRequest` when the `prompts` pillar is enabled.
 */
export function capturePromptRequestContext(
  req: Request,
  profile: GateProfile & { name?: string },
  endUser: string | null,
): void {
  const ctx = getClientContext();
  const profileName =
    typeof profile.name === 'string' && profile.name.trim().length > 0
      ? sanitizeVariableValue(profile.name.trim())
      : lookupProfileName(profile.id);
  const resolvedEndUser = endUser ?? ctx.endUser ?? null;

  let selectedPrompt: ActivePromptVariant | null = null;
  try {
    selectedPrompt = resolveActivePromptVariant(
      { kind: 'profile', id: String(profile.id) },
      extractAbStickySeed(req, resolvedEndUser),
    );
  } catch {
    selectedPrompt = null;
  }

  requestPromptContexts.set(ctx, {
    profileId: profile.id,
    profileName,
    endUser: resolvedEndUser ? sanitizeVariableValue(resolvedEndUser) : null,
    endUserName: extractEndUserName(req),
    language: extractCallerLanguage(req),
    callerVars: parseCallerVarsHeader(req.headers['x-freellm-vars']),
    selectedPrompt,
  });
}

/**
 * Returns a concise header descriptor (`v<version>:<variant>`) for the active request's prompt variant.
 */
export function getCapturedPromptHeader(): string | null {
  try {
    const sel = requestPromptContexts.get(getClientContext())?.selectedPrompt;
    if (!sel) return null;
    return `v${sel.version}:${sel.variant}`;
  } catch {
    return null;
  }
}

/**
 * Renders a profile system prompt template for the current request context.
 * Applies A/B draft variant overrides captured in Slot 5 when configured.
 * Returns `template` by exact reference when nullish, without `{{` (and not A/B-overridden), or when `prompts` pillar is off.
 */
export function renderPrompt(template: string | null | undefined): string | null | undefined {
  if (!isPillarEnabled('prompts')) return template;

  try {
    const clientCtx = getClientContext();
    const captured = requestPromptContexts.get(clientCtx);
    const abVariant = captured?.selectedPrompt ?? null;
    const effectiveTemplate = abVariant?.variant === 'draft' ? abVariant.body : template;

    if (effectiveTemplate == null || !effectiveTemplate.includes('{{')) {
      return effectiveTemplate;
    }

    const profileId = captured?.profileId ?? clientCtx.profileId;
    const profileName =
      captured?.profileName ?? (profileId !== undefined ? lookupProfileName(profileId) : '');
    const endUserId =
      captured?.endUser ?? (clientCtx.endUser ? sanitizeVariableValue(clientCtx.endUser) : '');
    const endUserName = captured?.endUserName ?? '';
    const language = captured?.language ?? '';
    const callerVars = captured?.callerVars ?? {};

    let declared: PromptVariable[] = abVariant?.variables ?? [];
    if (!abVariant && profileId !== undefined) {
      try {
        declared = getPublishedPrompt({ kind: 'profile', id: String(profileId) })?.variables ?? [];
      } catch {
        declared = [];
      }
    }

    const values: Record<string, string> = {
      date: new Date().toISOString().slice(0, 10),
    };
    if (profileName) values.profile_name = profileName;
    if (endUserId) values.end_user_id = endUserId;
    if (endUserName) values.end_user_name = endUserName;
    if (language) values.language = language;

    for (const v of declared) {
      if (v.source !== 'caller') continue;
      if (SYSTEM_PROMPT_VARIABLE_NAMES.has(v.name)) continue;
      const callerVal = callerVars[v.name];
      if (typeof callerVal === 'string' && callerVal.length > 0) {
        values[v.name] = callerVal;
      }
    }

    return renderWith(effectiveTemplate, values, declared).rendered;
  } catch (err) {
    console.warn('[prompts] renderPrompt failed:', err instanceof Error ? err.message : err);
    return template;
  }
}

/**
 * Renders a support tenant's system prompt template with tenant and customer context.
 */
export function renderTenantSystemPrompt(
  tenant: { id: number | string; name: string; systemPrompt: string },
  userContext: { userId: string; name?: string; role?: string },
): string {
  const template = tenant.systemPrompt;
  if (!isPillarEnabled('prompts')) return template ?? '';

  try {
    let selected: ActivePromptVariant | null = null;
    try {
      selected = resolveActivePromptVariant(
        { kind: 'support_tenant', id: String(tenant.id) },
        userContext.userId || null,
      );
    } catch {
      selected = null;
    }

    const activeTemplate = selected?.variant === 'draft' ? selected.body : template;
    if (!activeTemplate) return '';
    if (!activeTemplate.includes('{{')) return activeTemplate;

    const declared: PromptVariable[] = selected?.variables ?? [];

    const values: Record<string, string> = {
      date: new Date().toISOString().slice(0, 10),
    };
    const tenantName =
      typeof tenant.name === 'string' ? sanitizeVariableValue(tenant.name.trim()) : '';
    if (tenantName) values.profile_name = tenantName;

    const userId =
      typeof userContext.userId === 'string' ? sanitizeVariableValue(userContext.userId.trim()) : '';
    if (userId) values.end_user_id = userId;

    const userName =
      typeof userContext.name === 'string' ? sanitizeVariableValue(userContext.name.trim()) : '';
    if (userName) values.end_user_name = userName;

    return renderWith(activeTemplate, values, declared).rendered;
  } catch (err) {
    console.warn(
      '[prompts] renderTenantSystemPrompt failed:',
      err instanceof Error ? err.message : err,
    );
    return template ?? '';
  }
}
