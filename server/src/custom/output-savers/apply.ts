import type { ChatMessage } from '@freellmapi/shared/types.js';
import {
  getOutputSaverLevels,
  parseSaverDirective,
  resolveSaverLevels,
} from './config.js';
import { buildSaverBlock } from './prompts.js';

/**
 * Prepends the saver instructions as one new system message instead of editing
 * an existing one: the caller's system message stays byte-identical, and a
 * constant block at a constant position keeps the provider-side cache prefix
 * stable across requests. The block becomes part of `messages`, so token
 * estimation, routing budgets and the response cache key all see it without a
 * separate fingerprint.
 *
 * Fail-open: any problem leaves the conversation untouched. A saver is a
 * styling nicety and must never be the reason a request breaks.
 */
export function applyOutputSavers(
  messages: ChatMessage[],
  header: string | string[] | undefined,
): ChatMessage[] {
  try {
    if (!Array.isArray(messages) || messages.length === 0) return messages;
    const block = buildSaverBlock(
      resolveSaverLevels(getOutputSaverLevels(), parseSaverDirective(header)),
    );
    if (!block) return messages;
    // These texts are constants only this module writes, so substring presence
    // is a safe idempotency test for a body that is retried or replayed.
    if (messages.some(message => systemContentIncludes(message, block))) return messages;
    return [{ role: 'system', content: block }, ...messages];
  } catch {
    return messages;
  }
}

function systemContentIncludes(message: ChatMessage, block: string): boolean {
  if (!message || message.role !== 'system') return false;
  const content = message.content;
  if (typeof content === 'string') return content.includes(block);
  if (Array.isArray(content)) {
    return content.some(part => typeof part === 'string'
      ? part.includes(block)
      : (part?.text ?? '').includes(block));
  }
  return false;
}
