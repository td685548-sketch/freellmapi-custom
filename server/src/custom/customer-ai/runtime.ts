import type { NextFunction, Request, Response } from 'express';
import type { KeyRoutingMode } from '@freellmapi/shared/customer-ai.js';
import { getDb, getUnifiedApiKey } from '../../db/index.js';
import { setRequestKeyRoutingPreset } from '../../lib/client-context.js';
import { resolveAuth } from '../../lib/system-prompt.js';
import { extractInferenceToken } from '../../middleware/user-rate-limit.js';
import { validateSession, type SessionUser } from '../../services/auth.js';
import { checkUserRateLimit, recordUserUsage } from '../../services/user-quotas.js';
import { enforceUsageQuota } from '../quota-gate.js';
import { PLAYGROUND_SESSION_HEADER } from '../playground-attribution.js';
import {
  composeUserKeySystemPrompt,
  CustomerAiError,
  getAssistantForRuntime,
  getUserAiPreferences,
  incrementAssistantPlaygroundRuns,
  normalizeRoutingMode,
  routingModeToPreset,
} from './store.js';

export { composeUserKeySystemPrompt, routingModeToPreset };

export const SESSION_ROUTING_MODE_HEADER = 'x-freellm-routing-mode';
const TIMEOUT_MS = 60_000;

/**
 * Lets authenticated Playground / AI Hub loopback sessions steer routing mode (`eco`/`balanced`/`max`)
 * without exposing the unified key or trusting unauthenticated callers.
 */
export function customerAiSessionRoutingMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const rawMode = req.headers[SESSION_ROUTING_MODE_HEADER];
  const modeStr = Array.isArray(rawMode) ? rawMode[0] : rawMode;
  const rawSession = req.headers[PLAYGROUND_SESSION_HEADER];
  const sessionToken = Array.isArray(rawSession) ? rawSession[0] : rawSession;
  if (modeStr && sessionToken) {
    try {
      const mode = normalizeRoutingMode(modeStr.trim(), 'default');
      const preset = routingModeToPreset(mode);
      if (preset && resolveAuth(extractInferenceToken(req))?.kind === 'unified' && validateSession(sessionToken)) {
        setRequestKeyRoutingPreset(preset);
      }
    } catch {
      // Best-effort routing hint
    }
  }
  next();
}

function selfTarget(req: Request): { host: string; port: number } {
  const address = (req.socket.localAddress ?? '').replace(/^::ffff:/i, '');
  const host = !address || address === '::' || address === '0.0.0.0'
    ? '127.0.0.1'
    : address.includes(':')
      ? `[${address}]`
      : address;
  return { host, port: req.socket.localPort ?? 0 };
}

function callerSessionToken(req: Request): string | undefined {
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '').trim();
  if (bearer) return bearer;
  const dash = req.headers['x-dashboard-token'];
  return (Array.isArray(dash) ? dash[0] : dash)?.trim() || undefined;
}

function effectiveUserRpmLimit(userId: number): number {
  const row = getDb()
    .prepare('SELECT MAX(rpm_limit) AS maxRpm FROM user_api_keys WHERE user_id = ? AND revoked = 0')
    .get(userId) as { maxRpm: number | null } | undefined;
  return row?.maxRpm && row.maxRpm > 0 ? row.maxRpm : 60;
}

export interface AssistantChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface AssistantChatResult {
  reply: string;
  model: string | null;
  routingMode: KeyRoutingMode;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export async function chatWithAssistant(
  req: Request,
  res: Response,
  user: SessionUser,
  slug: string,
  input: {
    messages: AssistantChatTurn[];
    routingMode?: KeyRoutingMode;
    maxTokens?: number;
  },
): Promise<AssistantChatResult | null> {
  const assistant = getAssistantForRuntime(slug, user.role);
  if (!assistant) {
    throw new CustomerAiError(404, 'assistant_not_found', 'Assistant not found or unavailable.');
  }

  const limit = checkUserRateLimit(user.userId, effectiveUserRpmLimit(user.userId));
  res.setHeader('X-RateLimit-Limit-User-RPM', limit.limit.toString());
  res.setHeader('X-RateLimit-Remaining-User-RPM', limit.remaining.toString());
  res.setHeader('X-RateLimit-Reset-User-RPM', limit.resetSeconds.toString());
  if (!limit.allowed) {
    throw new CustomerAiError(
      429,
      'user_rate_limit_exceeded',
      `Rate limit exceeded. Your limit is ${limit.limit} requests per minute. Please retry in ${limit.resetSeconds} seconds.`,
    );
  }

  let settledTokens = 0;
  if (!enforceUsageQuota('user', user.userId, res, () => settledTokens)) {
    return null;
  }

  const prefs = getUserAiPreferences(user.userId);
  const systemPrompt = composeUserKeySystemPrompt(
    assistant.systemPrompt,
    prefs.customInstructions,
    prefs.applyCustomInstructionsToKeys,
  );
  const effectiveMode: KeyRoutingMode = input.routingMode && input.routingMode !== 'default'
    ? input.routingMode
    : assistant.recommendedRoutingMode;

  const sessionToken = callerSessionToken(req);
  const { host, port } = selfTarget(req);
  if (!port) {
    throw new CustomerAiError(502, 'loopback_unavailable', 'Local gateway address is unavailable.');
  }

  const outboundMessages = [
    ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
    ...input.messages.map(m => ({ role: m.role, content: m.content })),
  ];

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${getUnifiedApiKey()}`,
    'user-agent': 'freellm-customer-ai-hub',
    host: `127.0.0.1:${port}`,
  };
  if (sessionToken) headers[PLAYGROUND_SESSION_HEADER] = sessionToken;
  if (effectiveMode !== 'default') headers[SESSION_ROUTING_MODE_HEADER] = effectiveMode;

  const upstream = await fetch(`http://${host}:${port}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: 'auto',
      max_tokens: input.maxTokens ?? 1024,
      messages: outboundMessages,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const payload = await upstream.json().catch(() => null) as {
    choices?: Array<{ message?: { content?: unknown } }>;
    model?: unknown;
    _routed_via?: { model?: string };
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    error?: { message?: string };
  } | null;

  const content = payload?.choices?.[0]?.message?.content;
  const reply = typeof content === 'string' ? content : null;
  if (!upstream.ok || reply === null) {
    const errMsg = payload?.error?.message ?? `Assistant request failed (HTTP ${upstream.status})`;
    throw new CustomerAiError(upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502, 'assistant_chat_failed', errMsg);
  }

  const promptTokens = Number(payload?.usage?.prompt_tokens ?? 0) || 0;
  const completionTokens = Number(payload?.usage?.completion_tokens ?? 0) || 0;
  const totalTokens = Number(payload?.usage?.total_tokens ?? promptTokens + completionTokens) || 0;
  settledTokens = totalTokens;

  recordUserUsage(user.userId, totalTokens);
  incrementAssistantPlaygroundRuns(assistant.id);

  return {
    reply,
    model: payload?._routed_via?.model ?? (typeof payload?.model === 'string' ? payload.model : null),
    routingMode: effectiveMode,
    usage: { promptTokens, completionTokens, totalTokens },
  };
}
