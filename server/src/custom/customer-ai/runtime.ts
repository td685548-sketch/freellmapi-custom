import type { NextFunction, Request, Response } from 'express';
import type {
  AssistantThreadMessage,
  AssistantThreadSummary,
  KeyRoutingMode,
} from '@freellmapi/shared/customer-ai.js';
import { getDb, getInternalLoopbackToken } from '../../db/index.js';
import { setRequestKeyRoutingPreset } from '../../lib/client-context.js';
import { resolveAuth } from '../../lib/system-prompt.js';
import { extractInferenceToken } from '../../middleware/user-rate-limit.js';
import { validateSession, type SessionUser } from '../../services/auth.js';
import { getMemoizedUserKey, type ValidatedUserKey } from '../../services/user-keys.js';
import { checkUserRateLimit, recordUserUsage } from '../../services/user-quotas.js';
import { enforceUsageQuota } from '../quota-gate.js';
import { ensureVerifiedCloudRuntimePack } from '../cloud-entitlement/service.js';
import { PLAYGROUND_SESSION_HEADER } from '../playground-attribution.js';
import {
  composeUserKeySystemPrompt,
  CustomerAiError,
  getUserAiPreferences,
  incrementAssistantPlaygroundRuns,
  normalizeRoutingMode,
  routingModeToPreset,
} from './store.js';
import {
  appendTurnPairToThread,
  composeCustomAssistantSystemPrompt,
  createAssistantThread,
  getAssistantThread,
  getBoundCustomAssistantForRuntimeKey,
  resolveWorkspaceAssistantForUser,
} from './workspace-store.js';

export { composeUserKeySystemPrompt, routingModeToPreset };

export const SESSION_ROUTING_MODE_HEADER = 'x-freellm-routing-mode';
const TIMEOUT_MS = 60_000;
const MAX_THREAD_CONTEXT_MESSAGES = 24;

/**
 * 1) Lets authenticated Playground / AI Hub loopback sessions steer routing mode (`eco`/`balanced`/`max`)
 *    without exposing the unified key or trusting unauthenticated callers.
 * 2) When a Member binds one of their own Custom Assistants (`custom_user_assistants`) to a Personal API Key
 *    (`sk-flm-...`), injects that Custom Assistant's `system_prompt` + compact `knowledge_markdown` context
 *    and applies its recommended routing preset on external `/v1` inference calls.
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

  // Personal API key bound to a user-authored Custom Assistant
  try {
    const userKey = getMemoizedUserKey() ?? (req as Request & { user?: ValidatedUserKey }).user ?? null;
    if (userKey && userKey.keyId && userKey.userId) {
      const boundCustom = getBoundCustomAssistantForRuntimeKey(userKey.userId, userKey.keyId);
      if (boundCustom) {
        const prefs = getUserAiPreferences(userKey.userId);
        userKey.systemPrompt = composeCustomAssistantSystemPrompt(
          boundCustom,
          prefs.customInstructions,
          prefs.applyCustomInstructionsToKeys,
        );

        const effectiveMode: KeyRoutingMode =
          userKey.routingMode && userKey.routingMode !== 'default'
            ? userKey.routingMode
            : boundCustom.recommendedRoutingMode;
        userKey.routingMode = effectiveMode;
        const preset = routingModeToPreset(effectiveMode);
        if (preset) {
          setRequestKeyRoutingPreset(preset);
        }
      }
    }
  } catch {
    // Best-effort custom assistant runtime enrichment
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
  threadId?: number | null;
  thread?: AssistantThreadSummary | null;
  userMessage?: AssistantThreadMessage | null;
  assistantMessage?: AssistantThreadMessage | null;
}

export async function chatWithAssistant(
  req: Request,
  res: Response,
  user: SessionUser,
  slugOrRef: string,
  input: {
    messages: AssistantChatTurn[];
    routingMode?: KeyRoutingMode;
    maxTokens?: number;
    threadId?: number;
  },
): Promise<AssistantChatResult | null> {
  await ensureVerifiedCloudRuntimePack('customer_ai');
  const assistant = resolveWorkspaceAssistantForUser(user, slugOrRef);
  if (!assistant) {
    throw new CustomerAiError(404, 'assistant_not_found', 'Assistant not found or unavailable.');
  }

  const existingThread = input.threadId !== undefined
    ? getAssistantThread(user.userId, input.threadId)
    : null;

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
  const systemPrompt = composeCustomAssistantSystemPrompt(
    { systemPrompt: assistant.systemPrompt, knowledgeMarkdown: assistant.knowledgeMarkdown },
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

  const lastTurn = input.messages[input.messages.length - 1]!;
  const contextTurns: AssistantChatTurn[] = existingThread
    ? [
        ...existingThread.messages
          .slice(-MAX_THREAD_CONTEXT_MESSAGES)
          .map(m => ({ role: m.role, content: m.content })),
        { role: 'user', content: lastTurn.content },
      ]
    : input.messages;

  const outboundMessages = [
    ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
    ...contextTurns.map(m => ({ role: m.role, content: m.content })),
  ];

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${getInternalLoopbackToken()}`,
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
  if (assistant.catalogId !== null) {
    incrementAssistantPlaygroundRuns(assistant.catalogId);
  }

  const resolvedModel = payload?._routed_via?.model ?? (typeof payload?.model === 'string' ? payload.model : null);
  const usage = { promptTokens, completionTokens, totalTokens };

  const persisted = existingThread
    ? appendTurnPairToThread(user.userId, existingThread.id, {
        userContent: lastTurn.content,
        assistantContent: reply,
        model: resolvedModel,
        routingMode: effectiveMode,
        usage,
      })
    : null;

  return {
    reply,
    model: resolvedModel,
    routingMode: effectiveMode,
    usage,
    ...(persisted
      ? {
          threadId: existingThread!.id,
          thread: persisted.thread,
          userMessage: persisted.userMessage,
          assistantMessage: persisted.assistantMessage,
        }
      : {}),
  };
}

export interface StreamAssistantChatInput {
  assistantRef?: string;
  threadId?: number;
  createThread?: boolean;
  threadTitle?: string;
  message?: string;
  messages?: AssistantChatTurn[];
  routingMode?: KeyRoutingMode;
  maxTokens?: number;
  stream?: boolean;
}

function writeSseEvent(res: Response, event: string | null, data: unknown): void {
  if (res.writableEnded) return;
  const serialized = typeof data === 'string' ? data : JSON.stringify(data);
  if (event) {
    res.write(`event: ${event}\ndata: ${serialized}\n\n`);
  } else {
    res.write(`data: ${serialized}\n\n`);
  }
}

export async function streamChatWithAssistant(
  req: Request,
  res: Response,
  user: SessionUser,
  input: StreamAssistantChatInput,
): Promise<void> {
  const existingThread = input.threadId !== undefined
    ? getAssistantThread(user.userId, input.threadId)
    : null;

  const targetRef = input.assistantRef?.trim() || existingThread?.assistantRef || '';
  if (!targetRef) {
    throw new CustomerAiError(400, 'missing_assistant', 'Provide an assistantRef or threadId.');
  }

  const assistant = resolveWorkspaceAssistantForUser(user, targetRef);
  if (!assistant) {
    throw new CustomerAiError(404, 'assistant_not_found', 'Assistant not found or unavailable.');
  }

  let userTurnContent = '';
  if (input.message !== undefined && input.message.trim().length > 0) {
    userTurnContent = input.message.trim();
  } else if (input.messages && input.messages.length > 0) {
    const last = input.messages[input.messages.length - 1]!;
    if (last.role !== 'user' || !last.content.trim()) {
      throw new CustomerAiError(400, 'invalid_request', 'Messages must end with a non-empty user turn.');
    }
    userTurnContent = last.content.trim();
  } else {
    throw new CustomerAiError(400, 'invalid_request', 'Provide a non-empty user message.');
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

  const effectiveMode: KeyRoutingMode = input.routingMode && input.routingMode !== 'default'
    ? input.routingMode
    : (existingThread?.routingMode && existingThread.routingMode !== 'default'
        ? existingThread.routingMode
        : assistant.recommendedRoutingMode);

  const acceptHeader = String(req.headers.accept ?? '').toLowerCase();
  const wantsJsonFallback =
    input.stream === false ||
    (acceptHeader.includes('application/json') && !acceptHeader.includes('text/event-stream'));

  if (wantsJsonFallback) {
    let targetThreadId = existingThread?.id;
    if (!targetThreadId && input.createThread) {
      const created = createAssistantThread(user, {
        assistantRef: assistant.assistantRef,
        title: input.threadTitle,
        routingMode: effectiveMode,
      });
      targetThreadId = created.id;
    }

    const turnsForFallback: AssistantChatTurn[] =
      input.messages && input.messages.length > 0 && !targetThreadId
        ? input.messages
        : [{ role: 'user', content: userTurnContent }];

    const result = await chatWithAssistant(req, res, user, assistant.assistantRef, {
      messages: turnsForFallback,
      routingMode: effectiveMode,
      maxTokens: input.maxTokens,
      threadId: targetThreadId,
    });
    if (!result) return;
    res.json(result);
    return;
  }

  let settledTokens = 0;
  if (!enforceUsageQuota('user', user.userId, res, () => settledTokens)) {
    return;
  }

  const activeThread = existingThread
    ? existingThread
    : input.createThread
      ? createAssistantThread(user, {
          assistantRef: assistant.assistantRef,
          title: input.threadTitle,
          routingMode: effectiveMode,
        })
      : null;

  const prefs = getUserAiPreferences(user.userId);
  const systemPrompt = composeCustomAssistantSystemPrompt(
    { systemPrompt: assistant.systemPrompt, knowledgeMarkdown: assistant.knowledgeMarkdown },
    prefs.customInstructions,
    prefs.applyCustomInstructionsToKeys,
  );

  const contextTurns: AssistantChatTurn[] = existingThread
    ? [
        ...existingThread.messages
          .slice(-MAX_THREAD_CONTEXT_MESSAGES)
          .map(m => ({ role: m.role, content: m.content })),
        { role: 'user', content: userTurnContent },
      ]
    : input.messages && input.messages.length > 0
      ? input.messages.slice(-MAX_THREAD_CONTEXT_MESSAGES)
      : [{ role: 'user', content: userTurnContent }];

  const outboundMessages = [
    ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
    ...contextTurns.map(m => ({ role: m.role, content: m.content })),
  ];

  const sessionToken = callerSessionToken(req);
  const { host, port } = selfTarget(req);
  if (!port) {
    throw new CustomerAiError(502, 'loopback_unavailable', 'Local gateway address is unavailable.');
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    authorization: `Bearer ${getInternalLoopbackToken()}`,
    'user-agent': 'freellm-customer-ai-hub',
    host: `127.0.0.1:${port}`,
  };
  if (sessionToken) headers[PLAYGROUND_SESSION_HEADER] = sessionToken;
  if (effectiveMode !== 'default') headers[SESSION_ROUTING_MODE_HEADER] = effectiveMode;

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), TIMEOUT_MS);
  res.on('close', () => {
    if (!res.writableEnded) {
      abortController.abort();
    }
  });

  try {
    let upstream = await fetch(`http://${host}:${port}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'auto',
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: input.maxTokens ?? 1536,
        messages: outboundMessages,
      }),
      signal: abortController.signal,
    });

    // Graceful JSON fallback if upstream provider fails on streaming transport (`stream: true`)
    if (!upstream.ok && upstream.status >= 500) {
      const jsonHeaders: Record<string, string> = {
        ...headers,
        accept: 'application/json',
      };
      const fallbackRes = await fetch(`http://${host}:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({
          model: 'auto',
          stream: false,
          max_tokens: input.maxTokens ?? 1536,
          messages: outboundMessages,
        }),
        signal: abortController.signal,
      });
      if (fallbackRes.ok) {
        upstream = fallbackRes;
      }
    }

    if (!upstream.ok) {
      const errBody = (await upstream.json().catch(() => null)) as { error?: { message?: string } } | null;
      const errMsg = errBody?.error?.message ?? `Assistant stream failed (HTTP ${upstream.status})`;
      throw new CustomerAiError(
        upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502,
        'assistant_chat_failed',
        errMsg,
      );
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    writeSseEvent(res, 'meta', {
      threadId: activeThread?.id ?? null,
      assistantRef: assistant.assistantRef,
      routingMode: effectiveMode,
    });

    let fullReply = '';
    let resolvedModel: string | null = null;
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let streamError: string | null = null;

    const upstreamCt = (upstream.headers.get('content-type') ?? '').toLowerCase();

    if (upstreamCt.includes('text/event-stream') && upstream.body) {
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const processLine = (rawLine: string) => {
        const line = rawLine.trim();
        if (!line || line.startsWith(':')) return;
        if (!line.startsWith('data:')) return;
        const dataStr = line.slice(5).trim();
        if (!dataStr || dataStr === '[DONE]') return;

        try {
          const parsed = JSON.parse(dataStr) as {
            choices?: Array<{
              delta?: { content?: unknown };
              message?: { content?: unknown };
            }>;
            model?: unknown;
            _routed_via?: { model?: string };
            usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
            error?: { message?: string };
          };

          if (parsed?.error?.message && !fullReply) {
            streamError = parsed.error.message;
          }
          const nextModel = parsed?._routed_via?.model ?? (typeof parsed?.model === 'string' ? parsed.model : null);
          if (nextModel) resolvedModel = nextModel;

          const delta = parsed?.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta.length > 0) {
            fullReply += delta;
            writeSseEvent(res, 'delta', { delta });
          } else {
            const msgContent = parsed?.choices?.[0]?.message?.content;
            if (typeof msgContent === 'string' && msgContent.length > 0 && !fullReply) {
              fullReply += msgContent;
              writeSseEvent(res, 'delta', { delta: msgContent });
            }
          }

          if (parsed?.usage) {
            promptTokens = Number(parsed.usage.prompt_tokens ?? promptTokens) || 0;
            completionTokens = Number(parsed.usage.completion_tokens ?? completionTokens) || 0;
            totalTokens = Number(parsed.usage.total_tokens ?? promptTokens + completionTokens) || 0;
          }
        } catch {
          // Ignore malformed keepalive frames
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          processLine(line);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) {
        for (const line of buffer.split('\n')) {
          processLine(line);
        }
      }
    } else {
      // Graceful fallback when upstream answers with non-streaming JSON
      const payload = (await upstream.json().catch(() => null)) as {
        choices?: Array<{ message?: { content?: unknown } }>;
        model?: unknown;
        _routed_via?: { model?: string };
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
        error?: { message?: string };
      } | null;

      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content === 'string' && content.length > 0) {
        fullReply = content;
        writeSseEvent(res, 'delta', { delta: content });
      } else if (payload?.error?.message) {
        streamError = payload.error.message;
      }
      resolvedModel = payload?._routed_via?.model ?? (typeof payload?.model === 'string' ? payload.model : null);
      promptTokens = Number(payload?.usage?.prompt_tokens ?? 0) || 0;
      completionTokens = Number(payload?.usage?.completion_tokens ?? 0) || 0;
      totalTokens = Number(payload?.usage?.total_tokens ?? promptTokens + completionTokens) || 0;
    }

    if (!fullReply && streamError) {
      writeSseEvent(res, 'error', { message: streamError });
      writeSseEvent(res, null, '[DONE]');
      res.end();
      return;
    }

    if (totalTokens === 0 && (promptTokens > 0 || completionTokens > 0)) {
      totalTokens = promptTokens + completionTokens;
    }
    settledTokens = totalTokens;
    recordUserUsage(user.userId, totalTokens);
    if (assistant.catalogId !== null) {
      incrementAssistantPlaygroundRuns(assistant.catalogId);
    }

    const usage = { promptTokens, completionTokens, totalTokens };
    const persisted = activeThread && fullReply.length > 0
      ? appendTurnPairToThread(user.userId, activeThread.id, {
          userContent: userTurnContent,
          assistantContent: fullReply,
          model: resolvedModel,
          routingMode: effectiveMode,
          usage,
        })
      : null;

    writeSseEvent(res, 'done', {
      reply: fullReply,
      model: resolvedModel,
      routingMode: effectiveMode,
      usage,
      threadId: activeThread?.id ?? null,
      thread: persisted?.thread ?? null,
      userMessage: persisted?.userMessage ?? null,
      assistantMessage: persisted?.assistantMessage ?? null,
    });
    writeSseEvent(res, null, '[DONE]');
    res.end();
  } finally {
    clearTimeout(timeoutId);
  }
}
