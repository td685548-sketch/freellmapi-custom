import type { ChatMessage } from '@freellmapi/shared/types.js';
import { getDb } from '../../db/index.js';
import { contentToString } from '../../lib/content.js';
import { servableContextWindow } from '../../services/model-listing.js';
import { parseAllowedModels } from '../../services/profile-usage.js';
import { estimateMessagesTokens } from './estimate.js';
import { computeEffectiveBudget } from './fit.js';
import { getContextPolicyDefault, resolveContextPolicy } from './policy.js';

const COMPACT_TOOL_TRIGGER_CHARS = 1_200;
const COMPACT_TOOL_HEAD_CHARS = 700;
const COMPACT_TOOL_TAIL_CHARS = 200;
const FALLBACK_SAFETY_RATIO = 0.92;
const DEFAULT_LOOP_OUTPUT_RESERVE = 2_048;

export interface LoopBudgetGuardInput {
  messages: readonly ChatMessage[];
  model: string;
  profileId?: number;
  tools?: readonly unknown[];
  maxOutputTokens?: number;
}

export interface LoopBudgetGuardResult {
  messages: ChatMessage[];
  compacted: boolean;
  ceilingTokens: number | null;
  estimatedTokens: number;
  truncatedOutputs: number;
  droppedRounds: number;
}

function lookupTargetContextWindow(
  model: string,
  profileId?: number,
): { window: number | null; platform?: string } {
  try {
    const db = getDb();
    const trimmed = model.trim();
    if (trimmed && trimmed.toLowerCase() !== 'auto' && trimmed.toLowerCase() !== 'fusion') {
      const sepMatch = /^([^:/]+)[:/](.+)$/.exec(trimmed);
      if (sepMatch) {
        const platform = sepMatch[1]!.toLowerCase();
        const modelId = sepMatch[2]!.toLowerCase();
        const rows = db
          .prepare(
            `SELECT platform, context_window
             FROM models
             WHERE enabled = 1 AND lower(platform) = ? AND lower(model_id) = ?`,
          )
          .all(platform, modelId) as Array<{ platform: string; context_window: number | null }>;
        if (rows.length > 0) {
          return {
            window: servableContextWindow(rows.map((r) => r.context_window)),
            platform: rows[0]!.platform,
          };
        }
      } else {
        const rows = db
          .prepare(
            `SELECT platform, context_window
             FROM models
             WHERE enabled = 1 AND lower(model_id) = ?`,
          )
          .all(trimmed.toLowerCase()) as Array<{ platform: string; context_window: number | null }>;
        if (rows.length > 0) {
          return {
            window: servableContextWindow(rows.map((r) => r.context_window)),
            platform: rows.length === 1 ? rows[0]!.platform : undefined,
          };
        }
      }
      return { window: null };
    }

    let allowed: Set<string> | null = null;
    if (profileId !== undefined && profileId > 0) {
      const profileRow = db
        .prepare('SELECT allowed_models FROM client_profiles WHERE id = ?')
        .get(profileId) as { allowed_models: string | null } | undefined;
      const list = parseAllowedModels(profileRow?.allowed_models ?? null);
      if (list.length > 0) {
        allowed = new Set(list.map((m) => m.toLowerCase()));
      }
    }

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

    let maxWindow: number | null = null;
    for (const row of rows) {
      if (allowed && !allowed.has(row.model_id.toLowerCase())) continue;
      if (maxWindow === null || row.context_window > maxWindow) {
        maxWindow = row.context_window;
      }
    }
    return { window: maxWindow };
  } catch {
    return { window: null };
  }
}

function compactLongToolText(raw: string): string {
  if (raw.length <= COMPACT_TOOL_TRIGGER_CHARS) return raw;
  const omitted = raw.length - COMPACT_TOOL_HEAD_CHARS - COMPACT_TOOL_TAIL_CHARS;
  return (
    `${raw.slice(0, COMPACT_TOOL_HEAD_CHARS)}\n` +
    `...[tool output compacted: omitted ${omitted} chars of ${raw.length}]...\n` +
    `${raw.slice(-COMPACT_TOOL_TAIL_CHARS)}`
  );
}

function splitTailRoundGroups(tail: readonly ChatMessage[]): ChatMessage[][] {
  const groups: ChatMessage[][] = [];
  for (let i = 0; i < tail.length; ) {
    const msg = tail[i]!;
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      const group: ChatMessage[] = [msg];
      let j = i + 1;
      while (j < tail.length && tail[j]!.role === 'tool') {
        group.push(tail[j]!);
        j += 1;
      }
      groups.push(group);
      i = j;
      continue;
    }
    groups.push([msg]);
    i += 1;
  }
  return groups;
}

function resolveLoopTokenCeiling(
  model: string,
  profileId: number | undefined,
  maxOutputTokens: number | undefined,
): { ceiling: number | null; imageTokens: number; platform?: string } {
  const def = getContextPolicyDefault();
  const target = lookupTargetContextWindow(model, profileId);

  if (profileId !== undefined && profileId > 0) {
    try {
      const policy = resolveContextPolicy(profileId);
      if (policy.enabled) {
        const ceiling = computeEffectiveBudget(
          policy,
          target.window,
          maxOutputTokens ?? policy.outputReserveTokens,
          def.fallbackWindowTokens,
        );
        return {
          ceiling: Math.max(512, ceiling),
          imageTokens: def.imageTokens,
          platform: target.platform,
        };
      }
    } catch {
      // Fallback below when profile policy lookup is unavailable.
    }
  }

  if (target.window !== null && target.window > 0) {
    const reserve = maxOutputTokens ?? DEFAULT_LOOP_OUTPUT_RESERVE;
    const ceiling = Math.max(1024, Math.floor((target.window - reserve) * FALLBACK_SAFETY_RATIO));
    return {
      ceiling,
      imageTokens: def.imageTokens,
      platform: target.platform,
    };
  }

  return {
    ceiling: null,
    imageTokens: def.imageTokens,
    platform: target.platform,
  };
}

/**
 * Protect multi-round MCP tool loops and multi-agent orchestrator runs from context overflow:
 * 1) Truncate oversized older `role: 'tool'` results in prior rounds while preserving the latest round intact.
 * 2) If still over ceiling, atomically drop oldest completed `[assistant(tool_calls), ...tool]` round groups.
 */
export function compactLoopMessagesForBudget(
  input: LoopBudgetGuardInput,
): LoopBudgetGuardResult {
  const { ceiling, imageTokens, platform } = resolveLoopTokenCeiling(
    input.model,
    input.profileId,
    input.maxOutputTokens,
  );
  const estimateOpts = {
    tools: input.tools,
    imageTokens,
    platform,
  };
  const initialTokens = estimateMessagesTokens(input.messages, estimateOpts);

  if (ceiling === null || initialTokens <= ceiling || input.messages.length === 0) {
    return {
      messages: [...input.messages],
      compacted: false,
      ceilingTokens: ceiling,
      estimatedTokens: initialTokens,
      truncatedOutputs: 0,
      droppedRounds: 0,
    };
  }

  let lastUserIdx = -1;
  for (let i = input.messages.length - 1; i >= 0; i--) {
    if (input.messages[i]!.role === 'user') {
      lastUserIdx = i;
      break;
    }
  }

  const prefixEnd = lastUserIdx >= 0 ? lastUserIdx + 1 : 0;
  const prefix = input.messages.slice(0, prefixEnd);
  const groups = splitTailRoundGroups(input.messages.slice(prefixEnd)).map((g) => [...g]);

  if (groups.length <= 1) {
    return {
      messages: [...input.messages],
      compacted: false,
      ceilingTokens: ceiling,
      estimatedTokens: initialTokens,
      truncatedOutputs: 0,
      droppedRounds: 0,
    };
  }

  let truncatedOutputs = 0;
  let currentTokens = initialTokens;

  // Phase A: truncate oversized tool outputs in earlier completed rounds (preserve final round verbatim).
  outer: for (let gIdx = 0; gIdx < groups.length - 1; gIdx++) {
    const group = groups[gIdx]!;
    for (let mIdx = 0; mIdx < group.length; mIdx++) {
      const msg = group[mIdx]!;
      if (msg.role !== 'tool') continue;
      const text = contentToString(msg.content);
      const compacted = compactLongToolText(text);
      if (compacted === text) continue;

      group[mIdx] = { ...msg, content: compacted };
      truncatedOutputs += 1;

      const candidate = [...prefix, ...groups.flat()];
      currentTokens = estimateMessagesTokens(candidate, estimateOpts);
      if (currentTokens <= ceiling) break outer;
    }
  }

  // Phase B: atomically drop oldest round groups while keeping the latest round group intact.
  let droppedRounds = 0;
  while (groups.length > 1 && currentTokens > ceiling) {
    groups.shift();
    droppedRounds += 1;
    const candidate = [...prefix, ...groups.flat()];
    currentTokens = estimateMessagesTokens(candidate, estimateOpts);
  }

  let finalMessages: ChatMessage[];
  if (droppedRounds > 0) {
    const marker: ChatMessage = {
      role: 'system',
      content: `[Context budget: omitted ${droppedRounds} earlier tool round(s) to fit within ~${ceiling} input tokens.]`,
    };
    const withMarker = [...prefix, marker, ...groups.flat()];
    const withMarkerTokens = estimateMessagesTokens(withMarker, estimateOpts);
    if (withMarkerTokens <= ceiling) {
      finalMessages = withMarker;
      currentTokens = withMarkerTokens;
    } else {
      finalMessages = [...prefix, ...groups.flat()];
    }
  } else {
    finalMessages = [...prefix, ...groups.flat()];
  }

  return {
    messages: finalMessages,
    compacted: truncatedOutputs > 0 || droppedRounds > 0,
    ceilingTokens: ceiling,
    estimatedTokens: currentTokens,
    truncatedOutputs,
    droppedRounds,
  };
}
