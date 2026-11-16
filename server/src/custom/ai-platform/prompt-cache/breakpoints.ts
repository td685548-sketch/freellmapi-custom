import type { ChatContent, ChatContentBlock, ChatMessage } from '@freellmapi/shared/types.js';
import { isPillarEnabled } from '../flags.js';
import { isVolatileSystemMessage } from '../wire/extract.js';
import { getPromptCacheSettings, resolveCacheCapability } from './capabilities.js';

const EPHEMERAL_CACHE_CONTROL = { type: 'ephemeral' } as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function cloneBlock(block: ChatContentBlock): ChatContentBlock {
  if (!isPlainObject(block)) return block;
  const copy: Record<string, unknown> = { ...block };
  if (isPlainObject(copy.cache_control)) {
    copy.cache_control = { ...copy.cache_control };
  }
  return copy as ChatContentBlock;
}

function cloneMessage<T extends ChatMessage>(msg: T): T {
  const copy: Record<string, unknown> = { ...(msg as unknown as Record<string, unknown>) };
  if (isPlainObject(copy.cache_control)) {
    copy.cache_control = { ...copy.cache_control };
  }
  if (Array.isArray(msg.content)) {
    copy.content = msg.content.map(cloneBlock);
  }
  return copy as unknown as T;
}

function cloneTools(tools: unknown[] | undefined): unknown[] | undefined {
  if (tools === undefined) return undefined;
  return tools.map((tool) => {
    if (!isPlainObject(tool)) return tool;
    const copy: Record<string, unknown> = { ...tool };
    if (isPlainObject(copy.cache_control)) {
      copy.cache_control = { ...copy.cache_control };
    }
    return copy;
  });
}

function stripMessageCacheControl(msg: ChatMessage): void {
  const rec = msg as unknown as Record<string, unknown>;
  delete rec.cache_control;
  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (isPlainObject(block)) {
        delete block.cache_control;
      }
    }
  }
}

function stripToolsCacheControl(tools: unknown[] | undefined): void {
  if (!tools) return;
  for (const tool of tools) {
    if (isPlainObject(tool)) {
      delete tool.cache_control;
    }
  }
}

function capAndCountBreakpoints(
  messages: ChatMessage[],
  tools: unknown[] | undefined,
  maxBreakpoints: number,
): number {
  const limit = Math.max(0, maxBreakpoints);
  let active = 0;

  if (tools) {
    for (const tool of tools) {
      if (!isPlainObject(tool) || tool.cache_control === undefined) continue;
      if (active < limit) {
        active += 1;
      } else {
        delete tool.cache_control;
      }
    }
  }

  for (const msg of messages) {
    const rec = msg as unknown as Record<string, unknown>;
    if (rec.cache_control !== undefined) {
      if (active < limit) {
        active += 1;
      } else {
        delete rec.cache_control;
      }
    }
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (!isPlainObject(block) || block.cache_control === undefined) continue;
        if (active < limit) {
          active += 1;
        } else {
          delete block.cache_control;
        }
      }
    }
  }

  return active;
}

function hasCacheControl(msg: ChatMessage): boolean {
  const rec = msg as unknown as Record<string, unknown>;
  if (rec.cache_control !== undefined) return true;
  if (Array.isArray(msg.content)) {
    return msg.content.some((block) => isPlainObject(block) && block.cache_control !== undefined);
  }
  return false;
}

function anyToolHasCacheControl(tools: unknown[] | undefined): boolean {
  if (!tools) return false;
  return tools.some((tool) => isPlainObject(tool) && tool.cache_control !== undefined);
}

function contentToString(content: ChatContent): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === 'string') {
      parts.push(item);
    } else if (isPlainObject(item) && typeof item.text === 'string') {
      parts.push(item.text);
    }
  }
  return parts.join('\n');
}

function estimateTokensFromChars(chars: number): number {
  return Math.ceil(chars / 4);
}

function attachBreakpointToSystemMessage(msg: ChatMessage): boolean {
  if (typeof msg.content === 'string') {
    msg.content = [
      {
        type: 'text',
        text: msg.content,
        cache_control: { ...EPHEMERAL_CACHE_CONTROL },
      },
    ];
    return true;
  }

  if (Array.isArray(msg.content)) {
    for (let i = msg.content.length - 1; i >= 0; i--) {
      const block = msg.content[i];
      if (isPlainObject(block)) {
        block.cache_control = { ...EPHEMERAL_CACHE_CONTROL };
        return true;
      }
    }
    if (msg.content.length > 0 && typeof msg.content[msg.content.length - 1] === 'string') {
      const text = msg.content[msg.content.length - 1] as string;
      msg.content[msg.content.length - 1] = {
        type: 'text',
        text,
        cache_control: { ...EPHEMERAL_CACHE_CONTROL },
      };
      return true;
    }
  }

  return false;
}

/**
 * Normalizes, forwards, strips, or auto-places `cache_control` breakpoints for the target
 * provider/model without mutating caller inputs. Returns exact input references when `promptCache` is off.
 */
export function applyCacheBreakpoints<T extends ChatMessage[]>(
  messages: T,
  tools: unknown[] | undefined,
  target: { platform: string; modelId: string },
): { messages: T; tools: unknown[] | undefined } {
  if (!isPillarEnabled('promptCache')) {
    return { messages, tools };
  }

  try {
    const settings = getPromptCacheSettings();
    const cap = resolveCacheCapability(target.platform, target.modelId);

    const clonedMessages = messages.map((msg) => cloneMessage(msg)) as T;
    const clonedTools = cloneTools(tools);

    if (cap.mode !== 'explicit' || (!settings.forward && !settings.autoBreakpoints)) {
      for (const msg of clonedMessages) {
        stripMessageCacheControl(msg);
      }
      stripToolsCacheControl(clonedTools);
      return { messages: clonedMessages, tools: clonedTools };
    }

    let activeCount = 0;
    if (!settings.forward) {
      for (const msg of clonedMessages) {
        stripMessageCacheControl(msg);
      }
      stripToolsCacheControl(clonedTools);
    } else {
      activeCount = capAndCountBreakpoints(clonedMessages, clonedTools, cap.maxBreakpoints);
    }

    let remaining = Math.max(0, cap.maxBreakpoints - activeCount);
    if (settings.autoBreakpoints && remaining > 0) {
      // 1. Tools (highest priority)
      if (clonedTools && clonedTools.length > 0 && !anyToolHasCacheControl(clonedTools)) {
        const serialized = JSON.stringify(clonedTools) ?? '';
        if (estimateTokensFromChars(serialized.length) >= cap.minTokens) {
          const lastTool = clonedTools[clonedTools.length - 1];
          if (isPlainObject(lastTool)) {
            lastTool.cache_control = { ...EPHEMERAL_CACHE_CONTROL };
            remaining -= 1;
          }
        }
      }

      // 2 & 3. First non-volatile system prompt, then subsequent non-volatile stable knowledge
      for (let i = 0; i < clonedMessages.length && remaining > 0; i++) {
        const origMsg = messages[i];
        const msg = clonedMessages[i]!;
        if (msg.role !== 'system') continue;
        if (isVolatileSystemMessage(origMsg) || isVolatileSystemMessage(msg)) continue;
        if (hasCacheControl(msg)) continue;
        const text = contentToString(msg.content);
        if (estimateTokensFromChars(text.length) < cap.minTokens) continue;
        if (attachBreakpointToSystemMessage(msg)) {
          remaining -= 1;
        }
      }
    }

    return { messages: clonedMessages, tools: clonedTools };
  } catch (err) {
    console.warn('[prompt-cache] applyCacheBreakpoints failed:', err);
    return { messages, tools };
  }
}
