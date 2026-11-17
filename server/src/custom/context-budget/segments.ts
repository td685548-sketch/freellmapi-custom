import {
  CONTEXT_POLICY_DEFAULT,
  type ContextSegmentKind,
} from '@freellmapi/shared/context-budget.js';
import type { ChatMessage } from '@freellmapi/shared/types.js';
import { contentToString } from '../../lib/content.js';
import { estimateMessageTokens, estimateTextTokens } from './estimate.js';
import {
  computeFingerprint,
  type RegisteredUnit,
  type SegmentRegistry,
} from './registry.js';

const MESSAGE_OVERHEAD_TOKENS = 4;

export interface SegmentCharRange {
  start: number;
  end: number;
}

export interface ContextSegment {
  kind: ContextSegmentKind;
  indexes: number[];
  tokens: number;
  seq: number;
  droppable: boolean;
  messageId?: number;
  charRange?: SegmentCharRange;
}

interface UnitBucket {
  list: RegisteredUnit[];
  cursor: number;
}

function isSystemLikeRole(role: string): boolean {
  return role === 'system' || role === 'developer';
}

function sumMessagesTokens(
  messages: readonly ChatMessage[],
  indexes: readonly number[],
  imageTokens: number,
): number {
  let sum = 0;
  for (const idx of indexes) {
    sum += estimateMessageTokens(messages[idx]!, imageTokens);
  }
  return sum;
}

function trimWhitespaceBounds(text: string, start: number, end: number): [number, number] {
  let s = start;
  let e = end;
  while (s < e && /\s/.test(text[s]!)) s++;
  while (e > s && /\s/.test(text[e - 1]!)) e--;
  return [s, e];
}

function splitEmbeddedSystemMessage(
  index: number,
  message: ChatMessage,
  units: readonly RegisteredUnit[],
  consumed: Set<RegisteredUnit>,
): ContextSegment[] | null {
  const sysText = contentToString(message.content);
  if (!sysText) return null;

  const candidates: Array<{ unit: RegisteredUnit; start: number; end: number }> = [];
  for (const unit of units) {
    if (consumed.has(unit)) continue;
    if (unit.kind !== 'summary' && unit.kind !== 'knowledge') continue;
    if (!unit.text) continue;
    const start = sysText.indexOf(unit.text);
    if (start !== -1) {
      candidates.push({ unit, start, end: start + unit.text.length });
    }
  }
  if (candidates.length === 0) return null;

  // Sort earliest start first, then longest span first to resolve overlaps deterministically.
  candidates.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const selected: typeof candidates = [];
  let lastEnd = 0;
  for (const cand of candidates) {
    if (cand.start >= lastEnd) {
      selected.push(cand);
      lastEnd = cand.end;
    }
  }
  if (selected.length === 0) return null;

  const segments: ContextSegment[] = [];
  let cursor = 0;
  let overheadAssigned = false;

  const pushMandatoryGap = (gapStart: number, gapEnd: number) => {
    const [s, e] = trimWhitespaceBounds(sysText, gapStart, gapEnd);
    if (s >= e) return;
    const overhead = overheadAssigned ? 0 : MESSAGE_OVERHEAD_TOKENS;
    overheadAssigned = true;
    segments.push({
      kind: 'mandatory',
      indexes: [index],
      tokens: overhead + estimateTextTokens(sysText.slice(s, e)),
      seq: index,
      droppable: false,
      charRange: { start: s, end: e },
    });
  };

  for (const match of selected) {
    pushMandatoryGap(cursor, match.start);
    consumed.add(match.unit);
    segments.push({
      kind: match.unit.kind,
      indexes: [index],
      tokens: estimateTextTokens(sysText.slice(match.start, match.end)),
      seq: match.unit.seq,
      droppable: true,
      ...(match.unit.messageId !== undefined ? { messageId: match.unit.messageId } : {}),
      charRange: { start: match.start, end: match.end },
    });
    cursor = match.end;
  }
  pushMandatoryGap(cursor, sysText.length);

  // If the entire system message consisted solely of matched substrings with no mandatory gap,
  // attach the 4-token message framing overhead to the first resulting segment.
  if (!overheadAssigned && segments.length > 0) {
    segments[0]!.tokens += MESSAGE_OVERHEAD_TOKENS;
  }

  return segments;
}

/**
 * Classify a ChatMessage[] array into ordered ContextSegments using the
 * request's SegmentRegistry:
 * - Unregistered system/developer messages, the final user message, and any
 *   trailing tool-call chain after it are `mandatory`.
 * - Anthropic-style embedded summary/knowledge blocks inside the first system
 *   message are split into separate segments with `charRange` offsets.
 * - Matched registered units preserve their `kind`, `seq`, and `messageId`.
 * - Assistant `tool_calls` and their immediately following `tool` responses
 *   always share a single segment.
 * - Unmatched non-mandatory turns become `client_history` with `seq = index`.
 */
export function classifySegments(
  messages: readonly ChatMessage[],
  registry?: SegmentRegistry | null,
): ContextSegment[] {
  const imageTokens = registry?.imageTokens ?? CONTEXT_POLICY_DEFAULT.imageTokens;
  const clientDroppable =
    registry !== undefined &&
    registry !== null &&
    registry.policy.clientHistoryMode !== 'passthrough';
  const units = registry?.units ?? [];

  const buckets = new Map<string, UnitBucket>();
  for (const unit of units) {
    const key = `${unit.role}\0${unit.fingerprint}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { list: [], cursor: 0 };
      buckets.set(key, bucket);
    }
    bucket.list.push(unit);
  }
  const consumed = new Set<RegisteredUnit>();

  const consumeExactUnit = (role: string, content: unknown): RegisteredUnit | undefined => {
    if (buckets.size === 0) return undefined;
    const bucket = buckets.get(`${role}\0${computeFingerprint(content)}`);
    if (!bucket) return undefined;
    while (bucket.cursor < bucket.list.length) {
      const candidate = bucket.list[bucket.cursor++]!;
      if (!consumed.has(candidate)) {
        consumed.add(candidate);
        return candidate;
      }
    }
    return undefined;
  };

  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  const mandatoryTailStart = lastUserIdx >= 0 ? lastUserIdx : messages.length;

  const segments: ContextSegment[] = [];
  let seenFirstSystem = false;

  for (let i = 0; i < messages.length; ) {
    const msg = messages[i]!;

    // Trailing mandatory region: last user message and any following assistant/tool-call chain.
    if (i >= mandatoryTailStart) {
      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        const indexes = [i];
        let j = i + 1;
        while (j < messages.length && messages[j]!.role === 'tool') {
          indexes.push(j);
          j++;
        }
        segments.push({
          kind: 'mandatory',
          indexes,
          tokens: sumMessagesTokens(messages, indexes, imageTokens),
          seq: i,
          droppable: false,
        });
        i = j;
        continue;
      }

      segments.push({
        kind: 'mandatory',
        indexes: [i],
        tokens: estimateMessageTokens(msg, imageTokens),
        seq: i,
        droppable: false,
      });
      i++;
      continue;
    }

    // System / developer messages before the final user turn.
    if (isSystemLikeRole(msg.role)) {
      const isFirstSystem = !seenFirstSystem;
      seenFirstSystem = true;

      const matched = consumeExactUnit(msg.role, msg.content);
      if (matched) {
        segments.push({
          kind: matched.kind,
          indexes: [i],
          tokens: estimateMessageTokens(msg, imageTokens),
          seq: matched.seq,
          droppable: true,
          ...(matched.messageId !== undefined ? { messageId: matched.messageId } : {}),
        });
        i++;
        continue;
      }

      if (isFirstSystem && units.length > 0) {
        const split = splitEmbeddedSystemMessage(i, msg, units, consumed);
        if (split) {
          segments.push(...split);
          i++;
          continue;
        }
      }

      segments.push({
        kind: 'mandatory',
        indexes: [i],
        tokens: estimateMessageTokens(msg, imageTokens),
        seq: i,
        droppable: false,
      });
      i++;
      continue;
    }

    // Assistant tool_calls + immediately following tool responses must never be split.
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      const indexes = [i];
      let j = i + 1;
      while (j < mandatoryTailStart && messages[j]!.role === 'tool') {
        indexes.push(j);
        j++;
      }
      const matched = indexes.length === 1 ? consumeExactUnit(msg.role, msg.content) : undefined;
      if (matched) {
        segments.push({
          kind: matched.kind,
          indexes,
          tokens: sumMessagesTokens(messages, indexes, imageTokens),
          seq: matched.seq,
          droppable: true,
          ...(matched.messageId !== undefined ? { messageId: matched.messageId } : {}),
        });
      } else {
        segments.push({
          kind: 'client_history',
          indexes,
          tokens: sumMessagesTokens(messages, indexes, imageTokens),
          seq: i,
          droppable: clientDroppable,
        });
      }
      i = j;
      continue;
    }

    // Regular pre-tail turns: match against registered gateway units or fall back to client_history.
    const matched = consumeExactUnit(msg.role, msg.content);
    if (matched) {
      segments.push({
        kind: matched.kind,
        indexes: [i],
        tokens: estimateMessageTokens(msg, imageTokens),
        seq: matched.seq,
        droppable: true,
        ...(matched.messageId !== undefined ? { messageId: matched.messageId } : {}),
      });
    } else {
      segments.push({
        kind: 'client_history',
        indexes: [i],
        tokens: estimateMessageTokens(msg, imageTokens),
        seq: i,
        droppable: clientDroppable,
      });
    }
    i++;
  }

  return segments;
}
