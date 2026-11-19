import type { ChatMessage } from '@freellmapi/shared/types.js';

// OpenAI-spec message content can be one of:
//   - string                        (plain text)
//   - null                          (assistant with tool_calls only)
//   - Array<ContentBlock>           (multimodal envelope; we extract text only)
//
// freellmapi accepts the array envelope so clients like opencode and
// continue.dev (which always serialize as arrays) don't 400. Non-text blocks
// are dropped silently — vision/audio aren't supported (see README).
export type ContentTextBlock = { type: 'text'; text: string };
export type ContentBlock = ContentTextBlock | { type: string; [key: string]: unknown };

export function contentToString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === 'string') return b;
        const block = b as { type?: string; text?: unknown };
        // OpenAI blocks carry type:'text'; Gemini-lineage agents (Qwen Code,
        // AionUI) send part-style `{ text }` with no type at all — accept any
        // block whose `text` is a string and whose type doesn't say it's
        // something else. (#200)
        if (typeof block?.text === 'string' && (block.type === 'text' || block.type === undefined)) {
          return block.text;
        }
        return '';
      })
      .join('');
  }
  return '';
}

// Flat per-image token cost shared by routing (routes/proxy.ts), the
// scenario classifier, and the context-budget estimator. It must stay equal
// to CONTEXT_POLICY_DEFAULT.imageTokens in @freellmapi/shared/context-budget
// (pinned by server/src/__tests__/lib/content.test.ts); the old routing
// constant was 1000 while the budget default was 765, so the same image
// cost 1000 tokens at routing time and 765 at budget time.
export const IMAGE_TOKENS_PER_IMAGE = 765;

export function estimateImageTokens(imageCount: number): number {
  if (!Number.isFinite(imageCount) || imageCount <= 0) return 0;
  return Math.floor(imageCount) * IMAGE_TOKENS_PER_IMAGE;
}

// Count image blocks ({ type: 'image_url' } / { type: 'image' }) in a
// message content envelope.
export function countImageBlocks(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let count = 0;
  for (const block of content) {
    const type = (block as { type?: string } | null | undefined)?.type;
    if (type === 'image_url' || type === 'image') count += 1;
  }
  return count;
}

function isAccentedLatin(cp: number): boolean {
  return (
    (cp >= 0x00c0 && cp <= 0x024f) ||
    (cp >= 0x1e00 && cp <= 0x1eff) ||
    (cp >= 0x0300 && cp <= 0x036f)
  );
}

function isCjkOrKanaOrHangul(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x11ff) ||
    (cp >= 0x3000 && cp <= 0x30ff) ||
    (cp >= 0x3130 && cp <= 0x318f) ||
    (cp >= 0x31f0 && cp <= 0x31ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xff00 && cp <= 0xffef) ||
    (cp >= 0x20000 && cp <= 0x2fa1f)
  );
}

/**
 * Estimate token count for plain text using script-weighted character ratios:
 * ASCII / 4, accented Latin / 2.5, CJK/Kana/Hangul / 1, other scripts / 3.
 *
 * Single source of truth for the heuristic: the old chars/4 rule undercounted
 * Vietnamese (diacritics ≈ 1 token / 2.5 chars) by ~40% and CJK (≈ 1 token /
 * 1 char) by ~4x, so those requests routed to models whose context/TPM budget
 * they could never fit. Previously this lived in custom/context-budget and
 * only ran when the context budget was enabled; it now backs the always-on
 * routing estimate, compression stats, and the budget estimator alike.
 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  // Accumulate scaled integers (LCM of 4, 2.5, 1, 3 is 60) to avoid float drift.
  let weightedSum = 0;
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    i += cp > 0xffff ? 2 : 1;
    if (cp <= 0x7f) {
      weightedSum += 15;
    } else if (isAccentedLatin(cp)) {
      weightedSum += 24;
    } else if (isCjkOrKanaOrHangul(cp)) {
      weightedSum += 60;
    } else {
      weightedSum += 20;
    }
  }
  return weightedSum === 0 ? 0 : Math.floor((weightedSum + 59) / 60);
}

// Rough input-token count used for routing and budget checks: message text,
// assistant tool-call arguments, and the tool schemas the request carries.
// Text is counted with the script-weighted estimateTextTokens() above (not
// chars/4); image blocks are NOT counted here — callers that can see them
// add estimateImageTokens(countImageBlocks(...)) themselves (routes/proxy.ts
// does; custom/context-budget's estimateMessagesTokens() does), so the two
// must never be summed twice for the same request.
export function estimateInputTokens(messages: ChatMessage[], tools?: readonly unknown[]): number {
  const messageTokens = messages.reduce((sum, m) => {
    const calls = (m.tool_calls ?? [])
      .reduce((n, call) => n + estimateTextTokens(call.function.name + call.function.arguments), 0);
    return sum + estimateTextTokens(contentToString(m.content)) + calls;
  }, 0);
  const toolTokens = tools && tools.length > 0 ? estimateTextTokens(JSON.stringify(tools)) : 0;
  return messageTokens + toolTokens;
}

export function flattenMessageContent(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => ({
    ...m,
    content: contentToString(m.content),
  }));
}

// True if the content array carries an image block. OpenAI's multimodal
// envelope uses `{ type: 'image_url', image_url: { url } }`; some clients send
// a bare `{ type: 'image', ... }`.
export function contentHasImage(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    const type = (block as { type?: string })?.type;
    return type === 'image_url' || type === 'image';
  });
}

// True if any message carries an image content block. Used to route image
// requests only to vision-capable models (#118, #125).
export function messageHasImage(messages: ChatMessage[]): boolean {
  return messages.some((m) => contentHasImage(m.content));
}

// Drop image blocks from every message so a text-only model (e.g. the fusion
// judge, which synthesizes from panel text answers) never receives pixels.
export function stripImagesFromMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    if (!Array.isArray(m.content)) return m;
    const kept = m.content.filter((block) => {
      const type = (block as { type?: string })?.type;
      return type !== 'image_url' && type !== 'image';
    });
    if (kept.length === m.content.length) return m;
    return { ...m, content: kept.length > 0 ? kept : '' };
  });
}

// Harden the OUTBOUND envelope so strict OpenAI clients don't choke on the
// shape variations free-tier providers emit. Complements normalizeOutboundContent
// (which fixes array content) by fixing the *frame* fields, not the content:
//   - `model` coerced to a string (some providers send null/number).
//   - `choices[].finish_reason` defaulted to null when absent — the field must
//     exist per spec; Rust agents (the #200 class of compat bugs) branch on it.
//   - a literal `tool_calls: null` on a message/delta is DELETED — OpenAI omits
//     the field entirely when there are no calls, and `null` breaks clients that
//     test for its presence (this is the response-side mirror of the #200 fix).
// Content, real tool_calls arrays, reasoning_content, and every other field are
// left untouched. Mutates and returns the same object (frames are parsed fresh
// per SSE line, so in-place mutation is safe), matching normalizeOutboundContent.
export function sanitizeResponse<T>(payload: T): T {
  const p = payload as { model?: unknown; choices?: unknown };
  if (!p || typeof p !== 'object') return payload;
  if (p.model != null && typeof p.model !== 'string') p.model = String(p.model);
  if (Array.isArray(p.choices)) {
    for (const choice of p.choices) {
      if (!choice || typeof choice !== 'object') continue;
      const c = choice as { finish_reason?: unknown; message?: { tool_calls?: unknown }; delta?: { tool_calls?: unknown } };
      if (c.finish_reason === undefined) c.finish_reason = null;
      if (c.message && typeof c.message === 'object' && c.message.tool_calls === null) delete c.message.tool_calls;
      if (c.delta && typeof c.delta === 'object' && c.delta.tool_calls === null) delete c.delta.tool_calls;
    }
  }
  return payload;
}

// Normalize the OUTBOUND (provider → client) shape so we honor the OpenAI
// contract on the response path the same way `contentToString` does on the
// request path. Per spec, `choices[].delta.content` (streaming) and
// `choices[].message.content` (non-stream) are strings; some providers
// (e.g. Mistral magistral) return an array of content blocks. Forwarding the
// array verbatim breaks string-consuming clients ("expected str, got list")
// and, mid-stream, drops the turn's tool calls. We coerce array content to a
// string while leaving `tool_calls` and every other field untouched. Mutates
// and returns the same object (chunks are parsed fresh from JSON per frame, so
// in-place mutation is safe). Non-array content passes through unchanged. (#166)
export function normalizeOutboundContent<T>(payload: T): T {
  const choices = (payload as { choices?: unknown })?.choices;
  if (!Array.isArray(choices)) return payload;
  for (const choice of choices) {
    const delta = (choice as { delta?: { content?: unknown } })?.delta;
    if (delta && Array.isArray(delta.content)) {
      delta.content = contentToString(delta.content);
    }
    const message = (choice as { message?: { content?: unknown } })?.message;
    if (message && Array.isArray(message.content)) {
      message.content = contentToString(message.content);
    }
  }
  return payload;
}
