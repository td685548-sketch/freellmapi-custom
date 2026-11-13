import { readSubscriptionChunk } from './subscription-http.js';
import { randomUUID } from 'node:crypto';
import type { ChatMessage } from '@freellmapi/shared/types.js';
import type { CompletionOptions } from '../../providers/base.js';

// AWS EventStream framing, matching 9router/open-sse/utils/awsEventStream.js.
const table = Uint32Array.from({ length: 256 }, (_, i) => {
  let value = i;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});
export function crc32(data: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of data) value = table[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
export function decodeKiroFrame(data: Buffer): { headers: Record<string, string>; payload: Record<string, any> } {
  if (data.length < 16 || data.readUInt32BE(0) !== data.length) throw new Error('Invalid Kiro frame length.');
  const headersLength = data.readUInt32BE(4);
  if (data.length > 8_388_608 || headersLength > 65_536 || headersLength > data.length - 16) throw new Error('Invalid Kiro frame bounds.');
  if (data.readUInt32BE(8) !== crc32(data.subarray(0, 8)) || data.readUInt32BE(data.length - 4) !== crc32(data.subarray(0, -4))) throw new Error('Kiro frame integrity check failed.');
  const headers: Record<string, string> = Object.create(null);
  let offset = 12;
  const end = 12 + headersLength;
  const requireBytes = (n: number) => { if (offset + n > end) throw new Error('Invalid Kiro header bounds.'); };
  while (offset < end) {
    requireBytes(1); const length = data[offset++]; requireBytes(length + 1);
    const name = data.toString('utf8', offset, offset + length); offset += length;
    if (Object.hasOwn(headers, name)) throw new Error('Duplicate Kiro event header.');
    const type = data[offset++];
    if (type === 7 || type === 6) {
      requireBytes(2); const count = data.readUInt16BE(offset); offset += 2; requireBytes(count);
      headers[name] = data.toString('utf8', offset, offset + count); offset += count;
    } else {
      const sizes: Record<number, number> = { 0: 0, 1: 0, 2: 1, 3: 2, 4: 4, 5: 8, 8: 8, 9: 16 };
      if (sizes[type] === undefined) throw new Error('Unknown Kiro header type.');
      requireBytes(sizes[type]); offset += sizes[type]; headers[name] = '';
    }
  }
  try {
    const payload = JSON.parse(data.toString('utf8', end, data.length - 4));
    if (!payload || typeof payload !== 'object') throw new Error();
    return { headers, payload };
  } catch { throw new Error('Invalid Kiro event payload.'); }
}
export async function* kiroFrames(response: Response, timeoutMs = 120_000) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Kiro returned an empty stream.');
  let pending = Buffer.alloc(0);
  try {
    while (true) {
      const chunk = await readSubscriptionChunk(reader, timeoutMs);
      if (chunk.done) break;
      if (pending.length + chunk.value.length > 16_777_216) throw new Error('Kiro stream buffer limit exceeded.');
      pending = Buffer.concat([pending, chunk.value]);
      while (pending.length >= 12) {
        const size = pending.readUInt32BE(0);
        if (size < 16 || size > 8_388_608 || pending.readUInt32BE(4) > size - 16) throw new Error('Invalid Kiro stream frame.');
        if (pending.length < size) break;
        yield decodeKiroFrame(pending.subarray(0, size)); pending = pending.subarray(size);
      }
    }
    if (pending.length) throw new Error('Kiro stream ended inside a frame.');
  } finally { await reader.cancel().catch(() => {}); }
}

function messageText(message: ChatMessage): string {
  return typeof message.content === 'string' ? message.content : (message.content ?? []).map(part => typeof part === 'string' ? part : part.text ?? '').join('\n');
}
export function kiroBody(messages: ChatMessage[], model: string, options?: CompletionOptions): Record<string, any> {
  model = model.replace(/(?:-(?:agentic|thinking))+$/, '').replace(/-\d{8}$/, '').replace(/(claude-(?:sonnet|haiku|opus)-\d)-(\d)$/, '$1.$2');
  const history: Array<Record<string, any>> = [];
  const instructions = messages.filter(m => m.role === 'system').map(messageText).filter(Boolean).join('\n\n');
  for (const message of messages.filter(m => m.role !== 'system')) {
    if (message.role === 'assistant') {
      const assistant: Record<string, any> = { content: messageText(message) || '...' };
      if (message.tool_calls?.length) assistant.toolUses = message.tool_calls.map(call => {
        let input: unknown; try { input = JSON.parse(call.function.arguments || '{}'); } catch { throw new Error('Invalid Kiro tool arguments.'); }
        return { toolUseId: call.id, name: call.function.name, input };
      });
      const previous = history.at(-1)?.assistantResponseMessage;
      if (previous) { previous.content += '\n' + assistant.content; previous.toolUses = [...(previous.toolUses ?? []), ...(assistant.toolUses ?? [])]; }
      else { if (!history.length) history.push({ userInputMessage: { content: 'Continue.', modelId: model, origin: 'AI_EDITOR' } }); history.push({ assistantResponseMessage: assistant }); }
      continue;
    }
    const user: Record<string, any> = { content: message.role === 'tool' ? '' : messageText(message), modelId: model, origin: 'AI_EDITOR' };
    if (message.role === 'tool') user.userInputMessageContext = { toolResults: [{ toolUseId: message.tool_call_id, status: message.is_error === true ? 'error' : 'success', content: [{ text: messageText(message) }] }] };
    if (Array.isArray(message.content)) for (const part of message.content) {
      if (typeof part !== 'string' && part.type === 'image_url') {
        const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec((part.image_url as { url?: string } | undefined)?.url ?? '');
        if (!match) throw new Error('Kiro images must be inline base64 image data.');
        (user.images ??= []).push({ format: match[1], source: { bytes: match[2] } });
      }
    }
    const previous = history.at(-1)?.userInputMessage;
    if (previous) {
      previous.content += '\n' + user.content;
      if (user.images) previous.images = [...(previous.images ?? []), ...user.images];
      if (user.userInputMessageContext) (previous.userInputMessageContext ??= {}).toolResults = [...(previous.userInputMessageContext?.toolResults ?? []), ...user.userInputMessageContext.toolResults];
    } else history.push({ userInputMessage: user });
  }
  const currentMessage = history.at(-1)?.userInputMessage ? history.pop()! : { userInputMessage: { content: 'Continue.', modelId: model, origin: 'AI_EDITOR' } };
  const first = history.find(item => item.userInputMessage)?.userInputMessage ?? currentMessage.userInputMessage;
  if (instructions) first.content = `<instructions>\n${instructions}\n</instructions>\n${first.content}`;
  const tools = options?.tools?.map(tool => {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(tool.function.name)) throw new Error('Kiro tool names must contain 1–64 letters, digits, underscores or hyphens.');
    return { toolSpecification: { name: tool.function.name, description: (tool.function.description || tool.function.name).slice(0, 10237), inputSchema: { json: tool.function.parameters ?? { type: 'object', properties: {} } } } };
  });
  if (tools?.length) (currentMessage.userInputMessage.userInputMessageContext ??= {}).tools = tools;
  currentMessage.userInputMessage.content ||= 'Continue.';
  return { conversationState: { chatTriggerType: 'MANUAL', conversationId: randomUUID(), currentMessage, history } };
}
