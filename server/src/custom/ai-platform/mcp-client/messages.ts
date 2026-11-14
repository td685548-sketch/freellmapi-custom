import type { Wire } from '@freellmapi/shared/ai-platform.js';
import type {
  ChatMessage,
  ChatToolCall,
  ChatToolDefinition,
} from '@freellmapi/shared/types.js';

export interface LoopSafeParams {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string | string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function convertOpenAiMessage(item: unknown): ChatMessage | null {
  const msg = asRecord(item);
  if (!msg || typeof msg.role !== 'string') return null;
  const role = msg.role as ChatMessage['role'];
  const out: ChatMessage = {
    role,
    content: msg.content as ChatMessage['content'],
  };
  if (Array.isArray(msg.tool_calls)) {
    out.tool_calls = msg.tool_calls as ChatToolCall[];
  }
  if (typeof msg.tool_call_id === 'string') {
    out.tool_call_id = msg.tool_call_id;
  }
  if (typeof msg.name === 'string') {
    out.name = msg.name;
  }
  return out;
}

function convertAnthropicSystem(system: unknown): ChatMessage | null {
  if (typeof system === 'string') {
    return system.length > 0 ? { role: 'system', content: system } : null;
  }
  if (Array.isArray(system)) {
    const parts = system
      .map((b) => asRecord(b))
      .filter((b): b is Record<string, unknown> => Boolean(b && b.type === 'text' && typeof b.text === 'string'))
      .map((b) => ({
        type: 'text' as const,
        text: b.text as string,
        ...(b.cache_control !== undefined ? { cache_control: b.cache_control } : {}),
      }));
    return parts.length > 0 ? { role: 'system', content: parts as ChatMessage['content'] } : null;
  }
  return null;
}

function convertAnthropicPart(block: Record<string, unknown>): Record<string, unknown> | null {
  if (block.type === 'text' && typeof block.text === 'string') {
    return {
      type: 'text',
      text: block.text,
      ...(block.cache_control !== undefined ? { cache_control: block.cache_control } : {}),
    };
  }
  if (block.type === 'image') {
    const src = asRecord(block.source);
    if (src?.type === 'base64' && typeof src.media_type === 'string' && typeof src.data === 'string') {
      return {
        type: 'image_url',
        image_url: { url: `data:${src.media_type};base64,${src.data}` },
      };
    }
    if (src?.type === 'url' && typeof src.url === 'string') {
      return { type: 'image_url', image_url: { url: src.url } };
    }
  }
  return null;
}

function convertAnthropicMessages(body: Record<string, unknown>): ChatMessage[] | null {
  if (!Array.isArray(body.messages)) return null;
  const out: ChatMessage[] = [];
  const sys = convertAnthropicSystem(body.system);
  if (sys) out.push(sys);

  for (const raw of body.messages) {
    const msg = asRecord(raw);
    if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) return null;

    if (typeof msg.content === 'string') {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }
    if (!Array.isArray(msg.content)) return null;

    if (msg.role === 'assistant') {
      const textParts: Record<string, unknown>[] = [];
      const toolCalls: ChatToolCall[] = [];
      for (const item of msg.content) {
        const block = asRecord(item);
        if (!block) return null;
        if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input ?? {}),
            },
          });
        } else {
          const converted = convertAnthropicPart(block);
          if (converted) textParts.push(converted);
        }
      }
      const content =
        textParts.length === 0
          ? null
          : textParts.length === 1 && textParts[0]!.cache_control === undefined
            ? (textParts[0]!.text as string)
            : (textParts as unknown as ChatMessage['content']);
      out.push({
        role: 'assistant',
        content,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    // user role: may contain tool_result blocks and/or content blocks
    const userParts: Record<string, unknown>[] = [];
    for (const item of msg.content) {
      const block = asRecord(item);
      if (!block) return null;
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        const resultText =
          typeof block.content === 'string'
            ? block.content
            : Array.isArray(block.content)
              ? block.content
                  .map((c) => (asRecord(c)?.text as string | undefined) ?? '')
                  .filter(Boolean)
                  .join('\n')
              : JSON.stringify(block.content ?? '');
        out.push({
          role: 'tool',
          tool_call_id: block.tool_use_id,
          content: resultText,
        });
      } else {
        const converted = convertAnthropicPart(block);
        if (!converted) return null;
        userParts.push(converted);
      }
    }
    if (userParts.length > 0) {
      const content =
        userParts.length === 1 && userParts[0]!.type === 'text' && userParts[0]!.cache_control === undefined
          ? (userParts[0]!.text as string)
          : (userParts as unknown as ChatMessage['content']);
      out.push({ role: 'user', content });
    }
  }

  return out.length > 0 ? out : null;
}

function convertResponsesMessages(body: Record<string, unknown>): ChatMessage[] | null {
  const out: ChatMessage[] = [];
  if (typeof body.instructions === 'string' && body.instructions.length > 0) {
    out.push({ role: 'system', content: body.instructions });
  }
  if (typeof body.input === 'string') {
    out.push({ role: 'user', content: body.input });
    return out;
  }
  if (!Array.isArray(body.input)) return null;

  for (const raw of body.input) {
    const item = asRecord(raw);
    if (!item) return null;
    const itemType = typeof item.type === 'string' ? item.type : 'message';

    if (itemType === 'function_call' && typeof item.name === 'string') {
      const callId = typeof item.call_id === 'string' ? item.call_id : `fc_${out.length}`;
      const args = typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {});
      out.push({
        role: 'assistant',
        content: null,
        tool_calls: [{ id: callId, type: 'function', function: { name: item.name, arguments: args } }],
      });
      continue;
    }

    if (itemType === 'function_call_output' && typeof item.call_id === 'string') {
      const output = typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '');
      out.push({ role: 'tool', tool_call_id: item.call_id, content: output });
      continue;
    }

    if (itemType === 'message' && typeof item.role === 'string') {
      const role = (item.role === 'developer' ? 'system' : item.role) as ChatMessage['role'];
      if (typeof item.content === 'string') {
        out.push({ role, content: item.content });
        continue;
      }
      if (!Array.isArray(item.content)) return null;
      const parts: Record<string, unknown>[] = [];
      for (const c of item.content) {
        const block = asRecord(c);
        if (!block) return null;
        if ((block.type === 'input_text' || block.type === 'output_text' || block.type === 'text') && typeof block.text === 'string') {
          parts.push({ type: 'text', text: block.text });
        } else if (block.type === 'input_image' && typeof block.image_url === 'string') {
          parts.push({ type: 'image_url', image_url: { url: block.image_url } });
        } else if (block.type === 'input_image' && asRecord(block.image_url)?.url) {
          parts.push({ type: 'image_url', image_url: block.image_url });
        } else {
          return null;
        }
      }
      const content =
        parts.length === 1 && parts[0]!.type === 'text'
          ? (parts[0]!.text as string)
          : (parts as unknown as ChatMessage['content']);
      out.push({ role, content });
      continue;
    }

    return null;
  }

  return out.length > 0 ? out : null;
}

function convertGeminiMessages(body: Record<string, unknown>): ChatMessage[] | null {
  if (!Array.isArray(body.contents)) return null;
  const out: ChatMessage[] = [];

  const sysInst = asRecord(body.systemInstruction);
  if (sysInst && Array.isArray(sysInst.parts)) {
    const sysText = sysInst.parts
      .map((p) => (asRecord(p)?.text as string | undefined) ?? '')
      .filter(Boolean)
      .join('\n');
    if (sysText) out.push({ role: 'system', content: sysText });
  }

  let seq = 0;
  const pendingCallIds = new Map<string, string[]>();

  for (const raw of body.contents) {
    const entry = asRecord(raw);
    if (!entry || !Array.isArray(entry.parts)) return null;
    const role = entry.role === 'model' ? 'assistant' : 'user';

    const parts: Record<string, unknown>[] = [];
    const toolCalls: ChatToolCall[] = [];
    const toolResponses: ChatMessage[] = [];

    for (const rawPart of entry.parts) {
      const part = asRecord(rawPart);
      if (!part) return null;
      if (typeof part.text === 'string') {
        parts.push({ type: 'text', text: part.text });
      } else if (asRecord(part.inlineData)) {
        const inline = asRecord(part.inlineData)!;
        if (typeof inline.mimeType === 'string' && typeof inline.data === 'string') {
          parts.push({
            type: 'image_url',
            image_url: { url: `data:${inline.mimeType};base64,${inline.data}` },
          });
        }
      } else if (asRecord(part.functionCall)) {
        const fc = asRecord(part.functionCall)!;
        if (typeof fc.name !== 'string') return null;
        const callId = `gem_call_${++seq}`;
        const queue = pendingCallIds.get(fc.name) ?? [];
        queue.push(callId);
        pendingCallIds.set(fc.name, queue);
        toolCalls.push({
          id: callId,
          type: 'function',
          function: {
            name: fc.name,
            arguments: JSON.stringify(fc.args ?? {}),
          },
        });
      } else if (asRecord(part.functionResponse)) {
        const fr = asRecord(part.functionResponse)!;
        const fnName = typeof fr.name === 'string' ? fr.name : 'tool';
        const queue = pendingCallIds.get(fnName);
        const callId = queue?.shift() ?? `gem_call_${++seq}`;
        toolResponses.push({
          role: 'tool',
          tool_call_id: callId,
          content: JSON.stringify(fr.response ?? {}),
        });
      } else {
        return null;
      }
    }

    if (toolResponses.length > 0) {
      out.push(...toolResponses);
    }
    if (parts.length > 0 || toolCalls.length > 0) {
      const content =
        parts.length === 0
          ? null
          : parts.length === 1 && parts[0]!.type === 'text'
            ? (parts[0]!.text as string)
            : (parts as unknown as ChatMessage['content']);
      out.push({
        role,
        content,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    }
  }

  return out.length > 0 ? out : null;
}

/**
 * Converts an incoming request body from any of the 4 supported wire protocols
 * into canonical loopback `ChatMessage[]`, preserving system prompts, history,
 * multimodal blocks, tool calls/results, and cache_control.
 * Returns `null` if the payload cannot be safely converted.
 */
export function toLoopbackMessages(wire: Wire, body: unknown): ChatMessage[] | null {
  const obj = asRecord(body);
  if (!obj) return null;

  if (wire === 'openai-chat') {
    if (!Array.isArray(obj.messages) || obj.messages.length === 0) return null;
    const out: ChatMessage[] = [];
    for (const raw of obj.messages) {
      const msg = convertOpenAiMessage(raw);
      if (!msg) return null;
      out.push(msg);
    }
    return out;
  }

  if (wire === 'anthropic') return convertAnthropicMessages(obj);
  if (wire === 'responses') return convertResponsesMessages(obj);
  if (wire === 'gemini') return convertGeminiMessages(obj);
  return null;
}

/** Extracts caller-declared tool definitions in canonical OpenAI Chat format. */
export function extractCallerTools(wire: Wire, body: unknown): ChatToolDefinition[] {
  const obj = asRecord(body);
  if (!obj || !Array.isArray(obj.tools)) return [];
  const out: ChatToolDefinition[] = [];

  if (wire === 'openai-chat') {
    for (const item of obj.tools) {
      const t = asRecord(item);
      const fn = asRecord(t?.function);
      if (t?.type === 'function' && fn && typeof fn.name === 'string') {
        out.push({
          type: 'function',
          function: {
            name: fn.name,
            ...(typeof fn.description === 'string' ? { description: fn.description } : {}),
            ...(asRecord(fn.parameters) ? { parameters: fn.parameters as Record<string, unknown> } : {}),
          },
        });
      }
    }
    return out;
  }

  if (wire === 'anthropic') {
    for (const item of obj.tools) {
      const t = asRecord(item);
      if (t && typeof t.name === 'string') {
        out.push({
          type: 'function',
          function: {
            name: t.name,
            ...(typeof t.description === 'string' ? { description: t.description } : {}),
            ...(asRecord(t.input_schema) ? { parameters: t.input_schema as Record<string, unknown> } : {}),
          },
        });
      }
    }
    return out;
  }

  if (wire === 'responses') {
    for (const item of obj.tools) {
      const t = asRecord(item);
      if (t?.type === 'function' && typeof t.name === 'string') {
        out.push({
          type: 'function',
          function: {
            name: t.name,
            ...(typeof t.description === 'string' ? { description: t.description } : {}),
            ...(asRecord(t.parameters) ? { parameters: t.parameters as Record<string, unknown> } : {}),
          },
        });
      }
    }
    return out;
  }

  if (wire === 'gemini') {
    for (const item of obj.tools) {
      const group = asRecord(item);
      if (!group || !Array.isArray(group.functionDeclarations)) continue;
      for (const declRaw of group.functionDeclarations) {
        const decl = asRecord(declRaw);
        if (decl && typeof decl.name === 'string') {
          out.push({
            type: 'function',
            function: {
              name: decl.name,
              ...(typeof decl.description === 'string' ? { description: decl.description } : {}),
              ...(asRecord(decl.parameters) ? { parameters: decl.parameters as Record<string, unknown> } : {}),
            },
          });
        }
      }
    }
  }

  return out;
}

/** Extracts supported generation parameters safely across the 4 wire protocols. */
export function extractLoopParams(wire: Wire, body: unknown): LoopSafeParams {
  const obj = asRecord(body);
  if (!obj) return {};

  if (wire === 'gemini') {
    const gen = asRecord(obj.generationConfig) ?? {};
    return {
      ...(typeof gen.maxOutputTokens === 'number' ? { maxTokens: gen.maxOutputTokens } : {}),
      ...(typeof gen.temperature === 'number' ? { temperature: gen.temperature } : {}),
      ...(typeof gen.topP === 'number' ? { topP: gen.topP } : {}),
      ...(Array.isArray(gen.stopSequences) ? { stop: gen.stopSequences as string[] } : {}),
    };
  }

  const maxTokens =
    typeof obj.max_tokens === 'number'
      ? obj.max_tokens
      : typeof obj.max_output_tokens === 'number'
        ? obj.max_output_tokens
        : undefined;
  const stop =
    typeof obj.stop === 'string' || Array.isArray(obj.stop)
      ? (obj.stop as string | string[])
      : Array.isArray(obj.stop_sequences)
        ? (obj.stop_sequences as string[])
        : undefined;

  return {
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(typeof obj.temperature === 'number' ? { temperature: obj.temperature } : {}),
    ...(typeof obj.top_p === 'number' ? { topP: obj.top_p } : {}),
    ...(stop !== undefined ? { stop } : {}),
  };
}
