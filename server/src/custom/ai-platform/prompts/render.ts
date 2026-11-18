import type { Request, Response } from 'express';
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
import { isInternalCall } from '../loopback.js';
import { recordCompletedSpan } from '../tracing/collector.js';
import {
  recordCanaryOutcome,
  selectPromptVariant,
  type SelectedPromptVariant,
} from './canary.js';
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
  conversationId: string | null;
  selectedPrompt: ActivePromptVariant | null;
  variantSelection?: SelectedPromptVariant;
}

const requestPromptContexts = new WeakMap<object, PromptRequestContext>();
const trackedCanaryResponses = new WeakSet<Response>();

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
  res?: Response,
): void {
  const ctx = getClientContext();
  const profileName =
    typeof profile.name === 'string' && profile.name.trim().length > 0
      ? sanitizeVariableValue(profile.name.trim())
      : lookupProfileName(profile.id);
  const resolvedEndUser = endUser ?? ctx.endUser ?? null;
  const sanitizedEndUser = resolvedEndUser ? sanitizeVariableValue(resolvedEndUser) : null;
  const rawConv = firstHeaderValue(req.headers['x-conversation-id']);
  const conversationId =
    typeof rawConv === 'string' && rawConv.trim().length > 0
      ? sanitizeVariableValue(rawConv.trim())
      : null;

  const scope = { kind: 'profile' as const, id: String(profile.id) };
  const selection = selectPromptVariant(scope, {
    conversationId,
    endUser: sanitizedEndUser,
  });

  const targetRes = res ?? (req as Request & { res?: Response }).res;
  if (targetRes && !targetRes.headersSent && (selection.canaryActive || selection.version !== null)) {
    targetRes.setHeader?.('X-FreeLLM-Prompt-Variant', selection.headerValue);
  }
  if (
    targetRes &&
    selection.canaryActive &&
    isInternalCall(req) === null &&
    !trackedCanaryResponses.has(targetRes)
  ) {
    trackedCanaryResponses.add(targetRes);
    const startedAt = Date.now();
    targetRes.once?.('finish', () => {
      recordCanaryOutcome(scope, selection.variant, {
        latencyMs: Date.now() - startedAt,
        error: (targetRes.statusCode ?? 200) >= 400,
      });
    });
  }

  let selectedPrompt: ActivePromptVariant | null = null;
  try {
    selectedPrompt = resolveActivePromptVariant(
      scope,
      extractAbStickySeed(req, resolvedEndUser),
    );
  } catch {
    selectedPrompt = null;
  }

  requestPromptContexts.set(ctx, {
    profileId: profile.id,
    profileName,
    endUser: sanitizedEndUser,
    endUserName: extractEndUserName(req),
    language: extractCallerLanguage(req),
    callerVars: parseCallerVarsHeader(req.headers['x-freellm-vars']),
    conversationId,
    selectedPrompt,
    variantSelection: selection,
  });
}

/**
 * Returns a concise header descriptor (`v<version>:<variant>`) for the active request's prompt variant.
 */
export function getCapturedPromptHeader(): string | null {
  try {
    const captured = requestPromptContexts.get(getClientContext());
    if (!captured) return null;
    if (captured.variantSelection?.canaryActive && captured.variantSelection.version !== null) {
      return `v${captured.variantSelection.version}:${captured.variantSelection.variant}`;
    }
    const sel = captured.selectedPrompt;
    if (!sel) return null;
    return `v${sel.version}:${sel.variant}`;
  } catch {
    return null;
  }
}

/**
 * Renders a profile system prompt template for the current request context.
 * Applies active weighted canary candidate (taking precedence when `canaryActive`) or A/B draft
 * variant overrides captured in Slot 5 when configured.
 */
export function renderPrompt(template: string | null | undefined): string | null | undefined {
  if (!isPillarEnabled('prompts')) return template;

  try {
    const clientCtx = getClientContext();
    const captured = requestPromptContexts.get(clientCtx);
    const profileId = captured?.profileId ?? clientCtx.profileId;

    let selection: SelectedPromptVariant | undefined = captured?.variantSelection;
    if (!selection && profileId !== undefined) {
      const fallbackEndUser =
        captured?.endUser ?? (clientCtx.endUser ? sanitizeVariableValue(clientCtx.endUser) : null);
      selection = selectPromptVariant(
        { kind: 'profile', id: String(profileId) },
        { conversationId: captured?.conversationId ?? null, endUser: fallbackEndUser },
      );
    }

    const canarySelection =
      selection !== undefined && selection.variant === 'canary' && selection.body !== null
        ? selection
        : null;
    const abVariant = !selection?.canaryActive ? (captured?.selectedPrompt ?? null) : null;

    const effectiveTemplate = canarySelection
      ? canarySelection.body
      : abVariant?.variant === 'draft'
        ? abVariant.body
        : template;

    if (effectiveTemplate == null || !effectiveTemplate.includes('{{')) {
      return effectiveTemplate;
    }

    const profileName =
      captured?.profileName ?? (profileId !== undefined ? lookupProfileName(profileId) : '');
    const endUserId =
      captured?.endUser ?? (clientCtx.endUser ? sanitizeVariableValue(clientCtx.endUser) : '');
    const endUserName = captured?.endUserName ?? '';
    const language = captured?.language ?? '';
    const callerVars = captured?.callerVars ?? {};

    let declared: PromptVariable[] = [];
    if (canarySelection) {
      declared = canarySelection.variables;
    } else if (abVariant) {
      declared = abVariant.variables;
    } else if (selection && selection.version !== null) {
      declared = selection.variables;
    } else if (profileId !== undefined) {
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

    const startedAt = Date.now();
    const out = renderWith(effectiveTemplate, values, declared);
    recordCompletedSpan({
      kind: 'prompt_render',
      name: `prompt_render:profile:${profileId ?? 'default'}`,
      durationMs: Date.now() - startedAt,
      status: 'ok',
      attributes: {
        variablesDeclared: declared.length,
        variablesResolved: Object.keys(values).length,
      },
    });
    return out.rendered;
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
  const baseTemplate = tenant.systemPrompt ?? '';
  if (!isPillarEnabled('prompts')) return baseTemplate;

  try {
    const scope = { kind: 'support_tenant' as const, id: String(tenant.id) };
    const userId =
      typeof userContext.userId === 'string' ? sanitizeVariableValue(userContext.userId.trim()) : '';

    const selection = selectPromptVariant(scope, { endUser: userId || null });
    const useCanaryBody = selection.variant === 'canary' && selection.body !== null;

    let abSelected: ActivePromptVariant | null = null;
    if (!selection.canaryActive) {
      try {
        abSelected = resolveActivePromptVariant(scope, userContext.userId || null);
      } catch {
        abSelected = null;
      }
    }

    const activeTemplate = useCanaryBody
      ? selection.body!
      : abSelected?.variant === 'draft'
        ? abSelected.body
        : baseTemplate;

    if (!activeTemplate) return '';
    if (!activeTemplate.includes('{{')) return activeTemplate;

    let declared: PromptVariable[] = [];
    if (useCanaryBody) {
      declared = selection.variables;
    } else if (abSelected) {
      declared = abSelected.variables;
    } else if (selection.version !== null) {
      declared = selection.variables;
    } else {
      try {
        declared = getPublishedPrompt(scope)?.variables ?? [];
      } catch {
        declared = [];
      }
    }

    const values: Record<string, string> = {
      date: new Date().toISOString().slice(0, 10),
    };
    const tenantName =
      typeof tenant.name === 'string' ? sanitizeVariableValue(tenant.name.trim()) : '';
    if (tenantName) values.profile_name = tenantName;
    if (userId) values.end_user_id = userId;

    const userName =
      typeof userContext.name === 'string' ? sanitizeVariableValue(userContext.name.trim()) : '';
    if (userName) values.end_user_name = userName;

    const startedAt = Date.now();
    const out = renderWith(activeTemplate, values, declared);
    recordCompletedSpan({
      kind: 'prompt_render',
      name: `prompt_render:support_tenant:${String(tenant.id)}`,
      durationMs: Date.now() - startedAt,
      status: 'ok',
      attributes: {
        variablesDeclared: declared.length,
        variablesResolved: Object.keys(values).length,
      },
    });
    return out.rendered;
  } catch (err) {
    console.warn(
      '[prompts] renderTenantSystemPrompt failed:',
      err instanceof Error ? err.message : err,
    );
    return baseTemplate;
  }
}
