import type { Request, Response } from 'express';
import { CITATIONS_HEADER_NAME } from '@freellmapi/shared/ai-platform-retrieval.js';
import type { ContextAssemblySummary } from '@freellmapi/shared/context-budget.js';
import type { ChatMessage } from '@freellmapi/shared/types.js';
import { contentToString } from '../../lib/content.js';
import type { RouteResult } from '../../services/router.js';
import { heuristicTokens } from './estimate.js';
import { fitToBudget } from './fit.js';
import { getContextPolicyDefault } from './policy.js';
import { getRegistry } from './registry.js';
import {
  beginReport,
  formatContextHeader,
  persistReportOnFinish,
  pruneContextReports,
} from './report.js';
import { classifySegments, type ContextSegment } from './segments.js';

function messageHeuristicChars(message: ChatMessage): number {
  const textChars = contentToString(message.content).length;
  let callChars = 0;
  if (message.tool_calls && message.tool_calls.length > 0) {
    for (const call of message.tool_calls) {
      callChars += (call.function?.name?.length ?? 0) + (call.function?.arguments?.length ?? 0);
    }
  }
  return textChars + callChars;
}

function segmentHeuristicTokens(
  messages: readonly ChatMessage[],
  segment: ContextSegment,
): number {
  if (segment.charRange !== undefined) {
    return Math.floor((segment.charRange.end - segment.charRange.start) / 4);
  }
  let sum = 0;
  for (const idx of segment.indexes) {
    sum += Math.ceil(messageHeuristicChars(messages[idx]!) / 4);
  }
  return sum;
}

/**
 * Adjust the router's chars/4 token estimate by subtracting droppable segments
 * so smaller candidate models are not prematurely excluded before dispatch fitting.
 * Returns `routingTotal` unchanged when the policy is disabled or absent.
 */
export function contextRoutingTokens(
  req: Request,
  routingTotal: number,
  messages: readonly ChatMessage[],
): number {
  const registry = getRegistry(req);
  if (!registry || !registry.policy.enabled) {
    return routingTotal;
  }

  const sourceMessages =
    registry.base !== null && messages === registry.lastOutput
      ? registry.base
      : messages;
  const segments = classifySegments(sourceMessages, registry);

  let droppable = 0;
  for (const seg of segments) {
    if (seg.droppable) {
      droppable += segmentHeuristicTokens(sourceMessages, seg);
    }
  }

  return Math.max(0, routingTotal - droppable);
}

/**
 * Fit the outbound message array to the selected route's context window and
 * the client profile's token budget at dispatch time. Always fits from the
 * original `base` messages across fallback retries, and returns the exact input
 * reference unchanged when the policy is disabled or absent.
 */
export function fitContextForRoute(
  req: Request,
  res: Response,
  messages: ChatMessage[],
  route: Pick<RouteResult, 'contextWindow'> & Partial<Pick<RouteResult, 'platform' | 'modelId'>>,
  outputReserve: number,
): ChatMessage[] {
  const registry = getRegistry(req);
  if (!registry || !registry.policy.enabled) {
    return messages;
  }

  const sourceMessages =
    registry.base !== null && messages === registry.lastOutput
      ? registry.base
      : messages;
  if (sourceMessages !== registry.base) {
    registry.base = [...sourceMessages];
  }

  const segments = classifySegments(sourceMessages, registry);
  const { fallbackWindowTokens } = getContextPolicyDefault();
  const effectiveReserve =
    registry.clientMaxTokens !== null ? outputReserve : registry.policy.outputReserveTokens;

  const result = fitToBudget({
    messages: sourceMessages,
    segments,
    policy: registry.policy,
    contextWindow: route.contextWindow,
    outputReserve: effectiveReserve,
    fallbackWindowTokens,
  });

  if (!result.ok) {
    throw Object.assign(new Error("Required context exceeds this model's context window"), {
      providerRejection: 'request' as const,
    });
  }

  const isFirstFit = !registry.fitted;
  if (isFirstFit) {
    beginReport(req);
  } else {
    registry.refits += 1;
  }
  registry.fitted = true;
  registry.windowStartMessageId = result.windowStartMessageId;
  registry.lastOutput = result.messages;
  registry.knowledgeDropped = result.knowledgeDropped;

  const modelKey =
    route.platform && route.modelId
      ? `${route.platform}:${route.modelId}`
      : (route.modelId ?? route.platform ?? 'unknown');
  const summary: ContextAssemblySummary = {
    budget: result.budget,
    window: route.contextWindow ?? null,
    mandatory: result.tokens.mandatory,
    summary: result.tokens.summary,
    knowledge: result.tokens.knowledge,
    history: result.tokens.history,
    histSent: result.counts.historySent,
    histDropped: result.counts.historyDropped,
    kbSent: result.counts.knowledgeSent,
    kbDropped: result.counts.knowledgeDropped,
    clientDropped: result.counts.clientHistoryDropped,
    refits: registry.refits,
    estimatedTokens: result.tokens.total,
    heuristicTokens: heuristicTokens(result.messages),
    modelKey,
    createdAt: new Date().toISOString(),
  };
  registry.report = summary;

  if (!res.headersSent) {
    res.setHeader('X-FreeLLM-Context', formatContextHeader(summary));
    if (registry.conversation) {
      res.setHeader('X-Conversation-History', String(result.counts.historySent));
    }
    if (result.knowledgeDropped) {
      res.removeHeader(CITATIONS_HEADER_NAME);
    }
  }

  if (isFirstFit) {
    persistReportOnFinish(req, res);
    setImmediate(() => {
      pruneContextReports();
    });
  }

  return result.messages;
}
