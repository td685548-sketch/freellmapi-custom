import type { Request } from 'express';
import type {
  ContextPreview,
  ContextPreviewSegment,
} from '@freellmapi/shared/context-budget.js';
import type { ChatMessage } from '@freellmapi/shared/types.js';
import { getDb } from '../../db/index.js';
import { contentToString } from '../../lib/content.js';
import { prependSystemPrompt } from '../../lib/system-prompt.js';
import { servableContextWindow } from '../../services/model-listing.js';
import {
  SETTINGS_COLUMNS,
  settingsFromRow,
} from '../../services/profile-conversations.js';
import { parseAllowedModels } from '../../services/profile-usage.js';
import { estimateMessageTokens } from './estimate.js';
import { computeEffectiveBudget, fitToBudget, type SegmentFitDecision } from './fit.js';
import { historyCandidateLimits } from './gate.js';
import { getContextPolicyDefault, resolveContextPolicy } from './policy.js';
import { createRegistry, registerUnit } from './registry.js';
import { classifySegments, type ContextSegment } from './segments.js';

const HOUR_MS = 3_600_000;
const PREVIEW_MAX_CHARS = 200;
const KNOWLEDGE_NOTE =
  'Tri thức phụ thuộc câu hỏi thật nên không được giả lập trong xem trước.';

export type ContextPreviewErrorCode =
  | 'profile_not_found'
  | 'context_policy_disabled'
  | 'conversation_not_found';

/** Domain error thrown when a context preview cannot be constructed. */
export class ContextPreviewError extends Error {
  readonly code: ContextPreviewErrorCode;
  readonly status: number;

  constructor(code: ContextPreviewErrorCode, message: string, status: number) {
    super(message);
    this.name = 'ContextPreviewError';
    this.code = code;
    this.status = status;
  }
}

export interface ContextPreviewOptions {
  modelKey?: string;
  endUser?: string | null;
}

interface ProfilePreviewRow {
  id: number;
  system_prompt: string | null;
  allowed_models: string | null;
  kb_enabled: number;
  convEnabled: number;
  ttl: number | null;
  maxMessages: number | null;
  maxChars: number | null;
  convSummarize: number | null;
}

interface ConversationPreviewRow {
  id: number;
  end_user: string | null;
  summary: string | null;
  summarized_through: number;
  updated_at: string;
}

interface StoredMsgRow {
  id: number;
  role: 'user' | 'assistant';
  content: string;
}

interface ServableModelRow {
  platform: string;
  model_id: string;
  context_window: number | null;
}

function truncatePreview(text: string): string {
  return text.length > PREVIEW_MAX_CHARS ? text.slice(0, PREVIEW_MAX_CHARS) : text;
}

function selectPreviewModel(
  allowedModels: readonly string[],
  requestedModelKey?: string,
): { key: string; contextWindow: number | null } {
  const db = getDb();
  const allowedSet =
    allowedModels.length > 0 ? new Set(allowedModels.map((m) => m.toLowerCase())) : null;

  if (requestedModelKey && requestedModelKey.trim().length > 0) {
    const trimmed = requestedModelKey.trim();
    const colonIdx = trimmed.indexOf(':');
    let rows: ServableModelRow[];
    if (colonIdx > 0) {
      const platform = trimmed.slice(0, colonIdx).toLowerCase();
      const modelId = trimmed.slice(colonIdx + 1).toLowerCase();
      rows = db
        .prepare(
          `SELECT platform, model_id, context_window
           FROM models
           WHERE lower(platform) = ? AND lower(model_id) = ?
           ORDER BY enabled DESC`,
        )
        .all(platform, modelId) as ServableModelRow[];
      if (rows.length > 0) {
        return {
          key: `${rows[0]!.platform}:${rows[0]!.model_id}`,
          contextWindow: servableContextWindow(rows.map((r) => r.context_window)),
        };
      }
    } else {
      rows = db
        .prepare(
          `SELECT platform, model_id, context_window
           FROM models
           WHERE lower(model_id) = ?
           ORDER BY enabled DESC`,
        )
        .all(trimmed.toLowerCase()) as ServableModelRow[];
      if (rows.length > 0) {
        return {
          key: `${rows[0]!.platform}:${rows[0]!.model_id}`,
          contextWindow: servableContextWindow(rows.map((r) => r.context_window)),
        };
      }
    }
    return { key: trimmed, contextWindow: null };
  }

  const servableRows = db
    .prepare(
      `SELECT m.platform, m.model_id, m.context_window
       FROM models m
       WHERE m.enabled = 1
         AND EXISTS (
           SELECT 1 FROM api_keys k
           WHERE k.platform = m.platform
             AND k.enabled = 1
             AND (m.key_id IS NULL OR k.id = m.key_id)
         )
       ORDER BY m.id ASC`,
    )
    .all() as ServableModelRow[];

  const grouped = new Map<string, { key: string; windows: Array<number | null> }>();
  for (const row of servableRows) {
    if (allowedSet && !allowedSet.has(row.model_id.toLowerCase())) {
      continue;
    }
    const mapKey = `${row.platform.toLowerCase()}:${row.model_id.toLowerCase()}`;
    let group = grouped.get(mapKey);
    if (!group) {
      group = { key: `${row.platform}:${row.model_id}`, windows: [] };
      grouped.set(mapKey, group);
    }
    group.windows.push(row.context_window);
  }

  let best: { key: string; contextWindow: number | null } | null = null;
  for (const group of grouped.values()) {
    const win = servableContextWindow(group.windows);
    if (
      best === null ||
      (win !== null && (best.contextWindow === null || win > best.contextWindow))
    ) {
      best = { key: group.key, contextWindow: win };
    }
  }

  return best ?? { key: 'auto', contextWindow: null };
}

function segmentPreviewText(
  messages: readonly ChatMessage[],
  seg: ContextSegment,
  decision?: SegmentFitDecision,
): string {
  if (decision?.trimmedText !== undefined) {
    return truncatePreview(decision.trimmedText);
  }
  const msg = messages[seg.indexes[0]!]!;
  const full = contentToString(msg.content);
  const raw = seg.charRange ? full.slice(seg.charRange.start, seg.charRange.end) : full;
  return truncatePreview(raw);
}

/**
 * Simulate next-turn context assembly for a stored conversation without invoking
 * any upstream provider or mutating the database.
 */
export function previewConversationContext(
  profileId: number,
  conversationKey: string,
  options: ContextPreviewOptions = {},
): ContextPreview {
  const db = getDb();
  const profileRow = db
    .prepare(
      `SELECT id, system_prompt, allowed_models, kb_enabled, ${SETTINGS_COLUMNS}
       FROM client_profiles
       WHERE id = ?`,
    )
    .get(profileId) as ProfilePreviewRow | undefined;

  if (!profileRow) {
    throw new ContextPreviewError('profile_not_found', 'Client profile not found', 404);
  }

  const policy = resolveContextPolicy(profileId);
  if (!policy.enabled) {
    throw new ContextPreviewError(
      'context_policy_disabled',
      'Context policy is disabled for this client profile',
      409,
    );
  }

  const convSettings = settingsFromRow(profileRow);
  const conv = db
    .prepare(
      `SELECT id, end_user, summary, summarized_through, updated_at
       FROM custom_conversations
       WHERE profile_id = ? AND conv_key = ?`,
    )
    .get(profileId, conversationKey) as ConversationPreviewRow | undefined;

  const cutoffIso = new Date(Date.now() - convSettings.ttlHours * HOUR_MS).toISOString();
  if (!conv || conv.updated_at < cutoffIso) {
    throw new ContextPreviewError('conversation_not_found', 'Conversation not found', 404);
  }
  if (options.endUser && conv.end_user !== null && conv.end_user !== options.endUser) {
    throw new ContextPreviewError('conversation_not_found', 'Conversation not found', 404);
  }

  const def = getContextPolicyDefault();
  const model = selectPreviewModel(parseAllowedModels(profileRow.allowed_models), options.modelKey);
  const limits = historyCandidateLimits(policy, convSettings);

  const allStored = db
    .prepare(
      `SELECT id, role, content
       FROM custom_conversation_messages
       WHERE conversation_id = ?
       ORDER BY id ASC`,
    )
    .all(conv.id) as StoredMsgRow[];

  // Mirror loadHistoryRows windowing (newest up to maxMessages & maxChars) without deleting anything.
  const keptDesc: StoredMsgRow[] = [];
  let chars = 0;
  for (let i = allStored.length - 1; i >= 0 && keptDesc.length < limits.maxMessages; i--) {
    const m = allStored[i]!;
    if (chars + m.content.length > limits.maxChars) break;
    chars += m.content.length;
    keptDesc.push(m);
  }
  const candidates = keptDesc.reverse();
  const oldestCandidateId = candidates.length > 0 ? candidates[0]!.id : Number.MAX_SAFE_INTEGER;

  // Older unsummarized messages excluded by `maxMessages` / `maxChars` appear with reason `max_messages`.
  const excludedByMaxMessages: ContextPreviewSegment[] = [];
  for (const m of allStored) {
    if (m.id < oldestCandidateId && m.id > conv.summarized_through) {
      excludedByMaxMessages.push({
        kind: 'history',
        role: m.role,
        tokens: estimateMessageTokens({ role: m.role, content: m.content }, def.imageTokens),
        messageId: m.id,
        preview: truncatePreview(m.content),
        sent: false,
        reason: 'max_messages',
      });
    }
  }

  const mandatorySystemMessages = prependSystemPrompt([], profileRow.system_prompt);
  const summaryText =
    convSettings.summarize && conv.summary
      ? `Summary of the earlier part of this conversation:\n${conv.summary}`
      : null;

  const syntheticReq = {} as Request;
  const registry = createRegistry(syntheticReq, policy, { imageTokens: def.imageTokens });
  if (summaryText) {
    registerUnit(syntheticReq, {
      kind: 'summary',
      role: 'system',
      text: summaryText,
      seq: 0,
    });
  }
  for (const row of candidates) {
    registerUnit(syntheticReq, {
      kind: 'history',
      role: row.role,
      text: row.content,
      seq: row.id,
      messageId: row.id,
    });
  }

  const simulatedUserIndexOffset =
    mandatorySystemMessages.length + (summaryText ? 1 : 0) + candidates.length;

  const messages: ChatMessage[] = [
    ...mandatorySystemMessages,
    ...(summaryText ? [{ role: 'system' as const, content: summaryText }] : []),
    ...candidates.map((c) => ({ role: c.role, content: c.content })),
    { role: 'user' as const, content: '' },
  ];

  const classified = classifySegments(messages, registry);
  const fit = fitToBudget({
    messages,
    segments: classified,
    policy,
    contextWindow: model.contextWindow,
    outputReserve: policy.outputReserveTokens,
    fallbackWindowTokens: def.fallbackWindowTokens,
  });

  const previewSegments: ContextPreviewSegment[] = [];
  let oldestSentHistoryId: number | null = null;

  if (fit.ok) {
    let insertedMaxMessages = false;
    for (const decision of fit.decisions) {
      const seg = decision.segment;
      const isSimulatedNextUser =
        seg.indexes.length === 1 && seg.indexes[0] === simulatedUserIndexOffset;
      if (isSimulatedNextUser) continue;

      if (!insertedMaxMessages && seg.kind === 'history') {
        previewSegments.push(...excludedByMaxMessages);
        insertedMaxMessages = true;
      }

      if (seg.kind === 'history' && decision.sent && seg.messageId !== undefined) {
        if (oldestSentHistoryId === null || seg.messageId < oldestSentHistoryId) {
          oldestSentHistoryId = seg.messageId;
        }
      }

      const role = messages[seg.indexes[0]!]!.role;
      previewSegments.push({
        kind: seg.kind,
        role,
        tokens: decision.sent ? decision.tokens : seg.tokens,
        ...(seg.messageId !== undefined ? { messageId: seg.messageId } : {}),
        preview: segmentPreviewText(messages, seg, decision),
        sent: decision.sent,
        ...(!decision.sent && decision.reason ? { reason: decision.reason } : {}),
      });
    }
    if (!insertedMaxMessages) {
      previewSegments.push(...excludedByMaxMessages);
    }

    const pendingFoldMessages = allStored.filter(
      (m) =>
        m.id > conv.summarized_through &&
        (oldestSentHistoryId === null || m.id < oldestSentHistoryId),
    ).length;

    return {
      model,
      budget: {
        effective: fit.budget,
        mandatory: fit.tokens.mandatory,
        summaryCap: fit.caps.summary,
        knowledgeCap: profileRow.kb_enabled === 1 ? fit.caps.knowledge : 0,
        historyCap: fit.caps.history,
      },
      segments: previewSegments,
      summary: {
        coversThroughMessageId:
          conv.summarized_through > 0 && conv.summary ? conv.summarized_through : null,
        pendingFoldMessages,
      },
      knowledgeNote: KNOWLEDGE_NOTE,
    };
  }

  // Fallback when even the mandatory prompt exceeds effective budget: mark droppable segments dropped.
  const effective = computeEffectiveBudget(
    policy,
    model.contextWindow,
    policy.outputReserveTokens,
    def.fallbackWindowTokens,
  );
  let insertedMaxMessages = false;
  for (const seg of classified) {
    const isSimulatedNextUser =
      seg.indexes.length === 1 && seg.indexes[0] === simulatedUserIndexOffset;
    if (isSimulatedNextUser) continue;

    if (!insertedMaxMessages && seg.kind === 'history') {
      previewSegments.push(...excludedByMaxMessages);
      insertedMaxMessages = true;
    }

    const sent = !seg.droppable;
    previewSegments.push({
      kind: seg.kind,
      role: messages[seg.indexes[0]!]!.role,
      tokens: seg.tokens,
      ...(seg.messageId !== undefined ? { messageId: seg.messageId } : {}),
      preview: segmentPreviewText(messages, seg),
      sent,
      ...(!sent ? { reason: 'budget' as const } : {}),
    });
  }
  if (!insertedMaxMessages) {
    previewSegments.push(...excludedByMaxMessages);
  }

  const pendingFoldMessages = allStored.filter((m) => m.id > conv.summarized_through).length;
  return {
    model,
    budget: {
      effective,
      mandatory: fit.mandatoryTokens,
      summaryCap: 0,
      knowledgeCap: 0,
      historyCap: 0,
    },
    segments: previewSegments,
    summary: {
      coversThroughMessageId:
        conv.summarized_through > 0 && conv.summary ? conv.summarized_through : null,
      pendingFoldMessages,
    },
    knowledgeNote: KNOWLEDGE_NOTE,
  };
}
