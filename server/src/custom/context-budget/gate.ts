import type { Request, Response } from 'express';
import type { ContextPolicy } from '@freellmapi/shared/context-budget.js';
import type { ConversationSettings } from '@freellmapi/shared/conversations.js';
import type { ChatContentBlock, ChatMessage, ChatToolCall } from '@freellmapi/shared/types.js';
import { getDb } from '../../db/index.js';
import { getClientContext } from '../../lib/client-context.js';
import { geminiContentsToMessages, geminiToolsToChatTools, type GeminiInboundRequest } from '../../lib/gemini-wire.js';
import { parseAllowedModels } from '../../services/profile-usage.js';
import { renderPrompt } from '../ai-platform/prompts/render.js';
import type { Wire } from '../ai-platform/wire/detect.js';
import { estimateTextTokens } from './estimate.js';
import { computeEffectiveBudget } from './fit.js';
import { getContextPolicyDefault, resolveContextPolicy } from './policy.js';
import { createRegistry, getRegistry, registerUnit, type SegmentRegistry } from './registry.js';
import { classifySegments } from './segments.js';

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

/**
 * Extract the client's requested output token cap across all four supported wire formats
 * (`max_tokens`, `max_completion_tokens`, `max_output_tokens`, `generationConfig.maxOutputTokens`).
 */
function extractClientMaxTokens(body: unknown): number | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const direct =
    positiveInt(b.max_tokens) ??
    positiveInt(b.max_completion_tokens) ??
    positiveInt(b.max_output_tokens);
  if (direct !== null) return direct;

  const genCfg = b.generationConfig;
  if (genCfg && typeof genCfg === 'object' && !Array.isArray(genCfg)) {
    return positiveInt((genCfg as Record<string, unknown>).maxOutputTokens);
  }
  return null;
}

function getProfileAllowedModels(profileId: number): ReadonlySet<string> | undefined {
  const ctx = getClientContext();
  if (ctx.allowedModels && ctx.allowedModels.size > 0) {
    return ctx.allowedModels;
  }
  if (ctx.profileId !== undefined) {
    return undefined;
  }
  try {
    const row = getDb()
      .prepare('SELECT allowed_models FROM client_profiles WHERE id = ?')
      .get(profileId) as { allowed_models: string | null } | undefined;
    if (!row?.allowed_models) return undefined;
    const parsed = parseAllowedModels(row.allowed_models);
    return parsed.length > 0 ? new Set(parsed.map(m => m.toLowerCase())) : undefined;
  } catch {
    return undefined;
  }
}

function largestServableWindow(profileId: number): number | null {
  try {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT m.model_id, m.context_window
         FROM models m
         WHERE m.enabled = 1
           AND m.context_window IS NOT NULL
           AND m.context_window > 0
           AND EXISTS (
             SELECT 1 FROM api_keys k
             WHERE k.platform = m.platform
               AND k.enabled = 1
               AND (m.key_id IS NULL OR k.id = m.key_id)
           )`,
      )
      .all() as Array<{ model_id: string; context_window: number }>;

    const allowed = getProfileAllowedModels(profileId);
    let maxWindow: number | null = null;
    for (const row of rows) {
      if (allowed && allowed.size > 0 && !allowed.has(row.model_id.toLowerCase())) {
        continue;
      }
      if (maxWindow === null || row.context_window > maxWindow) {
        maxWindow = row.context_window;
      }
    }
    return maxWindow;
  } catch {
    return null;
  }
}

function lookupProfileSystemPrompt(profileId: number): string | null {
  try {
    const row = getDb()
      .prepare('SELECT system_prompt FROM client_profiles WHERE id = ?')
      .get(profileId) as { system_prompt: string | null } | undefined;
    if (!row?.system_prompt || row.system_prompt.trim().length === 0) return null;
    const rendered = renderPrompt(row.system_prompt);
    return rendered && rendered.trim().length > 0 ? rendered : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the client profile's context policy and initialize a per-request
 * `SegmentRegistry` when enabled. Returns `undefined` (no-op) when disabled.
 */
export function prepareContextBudget(req: Request, profileId: number): SegmentRegistry | undefined {
  const policy = resolveContextPolicy(profileId);
  if (!policy.enabled) return undefined;

  const def = getContextPolicyDefault();
  const clientMaxTokens = extractClientMaxTokens(req.body);
  const registry = createRegistry(req, policy, {
    imageTokens: def.imageTokens,
    clientMaxTokens,
  });

  const maxWindow = largestServableWindow(profileId);
  const reserve = clientMaxTokens !== null ? clientMaxTokens : policy.outputReserveTokens;
  registry.provisionalBudget = computeEffectiveBudget(
    policy,
    maxWindow,
    reserve,
    def.fallbackWindowTokens,
  );
  return registry;
}

/**
 * Compute candidate history retrieval ceilings for server-side conversations
 * when token-budgeted context assembly is active.
 */
export function historyCandidateLimits(
  policy: ContextPolicy,
  settings: ConversationSettings,
): { maxMessages: number; maxChars: number } {
  return {
    maxMessages: settings.maxMessages,
    maxChars: (policy.maxInputTokens ?? 1_000_000) * 4,
  };
}

/**
 * Register server-stored conversation history rows on the request's `SegmentRegistry`.
 */
export function registerHistory(
  req: Request,
  rows: ReadonlyArray<{ id: number; role: string; content: string }>,
): void {
  for (const row of rows) {
    registerUnit(req, {
      kind: 'history',
      role: row.role,
      text: row.content,
      seq: row.id,
      messageId: row.id,
    });
  }
}

/**
 * Register the injected conversation running summary on the request's `SegmentRegistry`.
 */
export function registerSummary(req: Request, text: string | null | undefined): void {
  if (!text) return;
  registerUnit(req, {
    kind: 'summary',
    role: 'system',
    text,
    seq: 0,
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function extractOpenAiChat(body: Record<string, unknown>): { messages: ChatMessage[]; tools?: readonly unknown[] } {
  const rawMsgs = Array.isArray(body.messages) ? body.messages : [];
  const messages: ChatMessage[] = [];
  for (const item of rawMsgs) {
    const rec = asRecord(item);
    if (!rec || typeof rec.role !== 'string') continue;
    messages.push(rec as unknown as ChatMessage);
  }
  const tools = Array.isArray(body.tools) ? body.tools : undefined;
  return { messages, tools };
}

function anthropicContentToChatBlocks(content: unknown): string | ChatContentBlock[] {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const blocks: ChatContentBlock[] = [];
  for (const item of content) {
    const rec = asRecord(item);
    if (!rec) continue;
    if (rec.type === 'text' && typeof rec.text === 'string') {
      blocks.push({ type: 'text', text: rec.text });
    } else if (rec.type === 'image') {
      blocks.push({ type: 'image_url', image_url: { url: 'image' } });
    } else if (rec.type === 'tool_result') {
      const inner = typeof rec.content === 'string'
        ? rec.content
        : Array.isArray(rec.content)
          ? rec.content.map(c => (asRecord(c)?.text as string) ?? '').join('\n')
          : '';
      if (inner) blocks.push({ type: 'text', text: inner });
    }
  }
  return blocks;
}

function extractAnthropic(body: Record<string, unknown>): { messages: ChatMessage[]; tools?: readonly unknown[] } {
  const messages: ChatMessage[] = [];
  if (typeof body.system === 'string' && body.system) {
    messages.push({ role: 'system', content: body.system });
  } else if (Array.isArray(body.system)) {
    const sysText = body.system
      .map(b => {
        const rec = asRecord(b);
        return typeof rec?.text === 'string' ? rec.text : '';
      })
      .filter(Boolean)
      .join('\n');
    if (sysText) messages.push({ role: 'system', content: sysText });
  }

  const rawMsgs = Array.isArray(body.messages) ? body.messages : [];
  for (const item of rawMsgs) {
    const rec = asRecord(item);
    if (!rec || typeof rec.role !== 'string') continue;
    if (rec.role === 'assistant' && Array.isArray(rec.content)) {
      const toolCalls: ChatToolCall[] = [];
      const textParts: string[] = [];
      for (const blk of rec.content) {
        const b = asRecord(blk);
        if (!b) continue;
        if (b.type === 'text' && typeof b.text === 'string') textParts.push(b.text);
        if (b.type === 'tool_use' && typeof b.name === 'string') {
          toolCalls.push({
            id: typeof b.id === 'string' ? b.id : 'call',
            type: 'function',
            function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
          });
        }
      }
      messages.push({
        role: 'assistant',
        content: textParts.join('\n') || (toolCalls.length > 0 ? null : ''),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    if (rec.role === 'user' && Array.isArray(rec.content)) {
      const toolResults = rec.content.filter(b => asRecord(b)?.type === 'tool_result');
      const otherBlocks = rec.content.filter(b => asRecord(b)?.type !== 'tool_result');
      for (const tr of toolResults) {
        const trRec = asRecord(tr)!;
        messages.push({
          role: 'tool',
          tool_call_id: typeof trRec.tool_use_id === 'string' ? trRec.tool_use_id : 'call',
          content: anthropicContentToChatBlocks([trRec]),
        });
      }
      if (otherBlocks.length > 0 || toolResults.length === 0) {
        messages.push({ role: 'user', content: anthropicContentToChatBlocks(otherBlocks) });
      }
      continue;
    }

    messages.push({
      role: rec.role as ChatMessage['role'],
      content: anthropicContentToChatBlocks(rec.content),
    });
  }

  const tools = Array.isArray(body.tools) ? body.tools : undefined;
  return { messages, tools };
}

function responsesContentToChat(content: unknown): string | ChatContentBlock[] {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const blocks: ChatContentBlock[] = [];
  for (const part of content) {
    const rec = asRecord(part);
    if (!rec) continue;
    if ((rec.type === 'input_text' || rec.type === 'output_text' || rec.type === 'text') && typeof rec.text === 'string') {
      blocks.push({ type: 'text', text: rec.text });
    } else if (rec.type === 'input_image' || rec.type === 'image_url') {
      blocks.push({ type: 'image_url', image_url: { url: 'image' } });
    }
  }
  return blocks;
}

function extractResponses(body: Record<string, unknown>): { messages: ChatMessage[]; tools?: readonly unknown[] } {
  const messages: ChatMessage[] = [];
  if (typeof body.instructions === 'string' && body.instructions) {
    messages.push({ role: 'system', content: body.instructions });
  }
  if (typeof body.input === 'string') {
    messages.push({ role: 'user', content: body.input });
  } else if (Array.isArray(body.input)) {
    for (const item of body.input) {
      const rec = asRecord(item);
      if (!rec) continue;
      if (rec.type === 'function_call') {
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: typeof rec.call_id === 'string' ? rec.call_id : 'call',
            type: 'function',
            function: {
              name: typeof rec.name === 'string' ? rec.name : '',
              arguments: typeof rec.arguments === 'string' ? rec.arguments : '',
            },
          }],
        });
      } else if (rec.type === 'function_call_output') {
        messages.push({
          role: 'tool',
          tool_call_id: typeof rec.call_id === 'string' ? rec.call_id : 'call',
          content: typeof rec.output === 'string' ? rec.output : JSON.stringify(rec.output ?? ''),
        });
      } else if (typeof rec.role === 'string') {
        messages.push({
          role: rec.role as ChatMessage['role'],
          content: responsesContentToChat(rec.content),
        });
      }
    }
  }
  const tools = Array.isArray(body.tools) ? body.tools : undefined;
  return { messages, tools };
}

function extractGemini(body: Record<string, unknown>): { messages: ChatMessage[]; tools?: readonly unknown[] } {
  const messages = Array.isArray(body.contents)
    ? geminiContentsToMessages(body as unknown as GeminiInboundRequest)
    : [];
  const tools = Array.isArray(body.tools)
    ? geminiToolsToChatTools(body.tools as GeminiInboundRequest['tools'])
    : undefined;
  return { messages, tools };
}

function extractMessagesForWire(
  wire: Wire,
  body: unknown,
): { messages: ChatMessage[]; tools?: readonly unknown[] } {
  const rec = asRecord(body);
  if (!rec) return { messages: [] };
  switch (wire) {
    case 'openai-chat': return extractOpenAiChat(rec);
    case 'anthropic': return extractAnthropic(rec);
    case 'responses': return extractResponses(rec);
    case 'gemini': return extractGemini(rec);
  }
}

function sendBudgetExceeded(
  res: Response,
  wire: Wire,
  budget: number,
  mandatoryTokens: number,
): false {
  const message =
    `The required context (system instructions and the new message) is about ${mandatoryTokens} tokens, ` +
    `over this key's context budget of ${budget} tokens.`;
  res.setHeader('X-FreeLLM-Context', `budget=${budget};mandatory=${mandatoryTokens}`);

  if (wire === 'anthropic') {
    res.status(400).json({
      type: 'error',
      error: { type: 'invalid_request_error', message },
    });
    return false;
  }

  if (wire === 'gemini') {
    res.status(400).json({
      error: { code: 400, message, status: 'INVALID_ARGUMENT' },
    });
    return false;
  }

  res.status(400).json({
    error: {
      message,
      type: 'invalid_request_error',
      code: 'context_budget_exceeded',
      param: 'messages',
    },
  });
  return false;
}

/**
 * Estimate mandatory context tokens at the profile gate (system instructions,
 * profile system prompt, final user turn, trailing tool-call chain, and tool schemas).
 * Rejects with HTTP 400 `context_budget_exceeded` when mandatory context exceeds
 * the provisional budget.
 */
export function checkMandatoryBudget(req: Request, res: Response, wire?: Wire | null): boolean {
  const registry = getRegistry(req);
  if (!registry || !registry.policy.enabled || !wire) return true;

  const { messages: wireMessages, tools } = extractMessagesForWire(wire, req.body);
  const profileId = getClientContext().profileId ?? registry.policy.profileId;
  const profilePrompt = profileId !== undefined ? lookupProfileSystemPrompt(profileId) : null;
  const messages = profilePrompt
    ? [{ role: 'system' as const, content: profilePrompt }, ...wireMessages]
    : wireMessages;

  const segments = classifySegments(messages, registry);
  let mandatoryTokens = 0;
  for (const seg of segments) {
    if (seg.kind === 'mandatory') {
      mandatoryTokens += seg.tokens;
    }
  }
  if (tools && tools.length > 0) {
    mandatoryTokens += estimateTextTokens(JSON.stringify(tools));
  }

  registry.mandatoryTokens = mandatoryTokens;

  const budget = registry.provisionalBudget;
  if (budget !== null && mandatoryTokens > budget) {
    return sendBudgetExceeded(res, wire, budget, mandatoryTokens);
  }
  return true;
}
