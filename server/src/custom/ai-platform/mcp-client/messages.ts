import type { Wire } from '@freellmapi/shared/ai-platform.js';
import type {
  ChatMessage,
  ChatToolCall,
  ChatToolDefinition,
} from '@freellmapi/shared/types.js';

export interface LoopSafeParams {
  maxTokens?: number;
  maxCompletionTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string | string[];
  toolChoice?: unknown;
  responseFormat?: unknown;
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

function convertAnthropicSystem(system: unknown): { ok: true; msg: ChatMessage | null } | { ok: false } {
  if (system === undefined || system === null) return { ok: true, msg: null };
  if (typeof system === 'string') {
    return { ok: true, msg: system.length > 0 ? { role: 'system', content: system } : null };
  }
  if (Array.isArray(system)) {
    const parts: Array<{ type: 'text'; text: string; cache_control?: unknown }> = [];
    for (const raw of system) {
      const b = asRecord(raw);
      if (!b || b.type !== 'text' || typeof b.text !== 'string') {
        return { ok: false };
      }
      parts.push({
        type: 'text',
        text: b.text,
        ...(b.cache_control !== undefined ? { cache_control: b.cache_control } : {}),
      });
    }
    return { ok: true, msg: parts.length > 0 ? { role: 'system', content: parts as ChatMessage['content'] } : null };
  }
  return { ok: false };
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
  if (!sys.ok) return null;
  if (sys.msg) out.push(sys.msg);

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
          if (!converted) return null;
          textParts.push(converted);
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
        let resultText = '';
        if (typeof block.content === 'string') {
          resultText = block.content;
        } else if (Array.isArray(block.content)) {
          const textChunks: string[] = [];
          for (const c of block.content) {
            const cRec = asRecord(c);
            if (!cRec || cRec.type !== 'text' || typeof cRec.text !== 'string') {
              return null;
            }
            textChunks.push(cRec.text);
          }
          resultText = textChunks.join('\n');
        } else if (block.content !== undefined && block.content !== null) {
          resultText = JSON.stringify(block.content);
        }
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

/**
 * Extracts caller-declared tool definitions in canonical OpenAI Chat format.
 * Returns `null` if `tools` contains an unsupported tool type (forcing normal-gateway fallback).
 */
export function extractCallerToolsOrNull(wire: Wire, body: unknown): ChatToolDefinition[] | null {
  const obj = asRecord(body);
  if (!obj || obj.tools === undefined || obj.tools === null) return [];
  if (!Array.isArray(obj.tools)) return null;
  const out: ChatToolDefinition[] = [];

  if (wire === 'openai-chat') {
    for (const item of obj.tools) {
      const t = asRecord(item);
      const fn = asRecord(t?.function);
      if (!t || t.type !== 'function' || !fn || typeof fn.name !== 'string') {
        return null;
      }
      out.push({
        type: 'function',
        function: {
          name: fn.name,
          ...(typeof fn.description === 'string' ? { description: fn.description } : {}),
          ...(asRecord(fn.parameters) ? { parameters: fn.parameters as Record<string, unknown> } : {}),
        },
      });
    }
    return out;
  }

  if (wire === 'anthropic') {
    for (const item of obj.tools) {
      const t = asRecord(item);
      if (!t || typeof t.name !== 'string') return null;
      if (t.type !== undefined && t.type !== 'custom') return null;
      out.push({
        type: 'function',
        function: {
          name: t.name,
          ...(typeof t.description === 'string' ? { description: t.description } : {}),
          ...(asRecord(t.input_schema) ? { parameters: t.input_schema as Record<string, unknown> } : {}),
        },
      });
    }
    return out;
  }

  if (wire === 'responses') {
    for (const item of obj.tools) {
      const t = asRecord(item);
      if (!t || t.type !== 'function' || typeof t.name !== 'string') {
        return null;
      }
      out.push({
        type: 'function',
        function: {
          name: t.name,
          ...(typeof t.description === 'string' ? { description: t.description } : {}),
          ...(asRecord(t.parameters) ? { parameters: t.parameters as Record<string, unknown> } : {}),
        },
      });
    }
    return out;
  }

  if (wire === 'gemini') {
    for (const item of obj.tools) {
      const group = asRecord(item);
      if (!group) return null;
      const keys = Object.keys(group);
      if (keys.some((k) => k !== 'functionDeclarations') || !Array.isArray(group.functionDeclarations)) {
        return null;
      }
      for (const declRaw of group.functionDeclarations) {
        const decl = asRecord(declRaw);
        if (!decl || typeof decl.name !== 'string') return null;
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
    return out;
  }

  return out;
}

/** Extracts caller-declared tool definitions in canonical OpenAI Chat format. */
export function extractCallerTools(wire: Wire, body: unknown): ChatToolDefinition[] {
  return extractCallerToolsOrNull(wire, body) ?? [];
}

function normalizeOpenAiToolChoice(raw: unknown): { ok: true; value?: unknown } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true };
  if (raw === 'auto' || raw === 'none' || raw === 'required') return { ok: true, value: raw };
  const rec = asRecord(raw);
  const fn = asRecord(rec?.function);
  if (rec?.type === 'function' && fn && typeof fn.name === 'string') {
    return { ok: true, value: { type: 'function', function: { name: fn.name } } };
  }
  return { ok: false };
}

function normalizeOpenAiResponseFormat(raw: unknown): { ok: true; value?: unknown } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true };
  const rec = asRecord(raw);
  if (!rec || typeof rec.type !== 'string') return { ok: false };
  if (rec.type === 'text' || rec.type === 'json_object' || rec.type === 'json_schema') {
    return { ok: true, value: raw };
  }
  return { ok: false };
}

function hasAnyDefined(obj: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((k) => obj[k] !== undefined && obj[k] !== null);
}

/**
 * Extracts supported generation parameters safely across the 4 wire protocols.
 * Returns `null` when the request carries parameters or structured options that
 * cannot be faithfully forwarded through the canonical OpenAI Chat loopback.
 */
export function extractLoopParamsOrNull(wire: Wire, body: unknown): LoopSafeParams | null {
  const obj = asRecord(body);
  if (!obj) return null;

  if (wire === 'openai-chat') {
    if (
      hasAnyDefined(obj, [
        'functions',
        'function_call',
        'parallel_tool_calls',
        'modalities',
        'audio',
        'prediction',
        'reasoning_effort',
        'logprobs',
        'top_logprobs',
        'logit_bias',
        'seed',
        'service_tier',
        'store',
      ])
    ) {
      return null;
    }
    if (obj.n !== undefined && obj.n !== null && obj.n !== 1) return null;
    const tc = normalizeOpenAiToolChoice(obj.tool_choice);
    if (!tc.ok) return null;
    const rf = normalizeOpenAiResponseFormat(obj.response_format);
    if (!rf.ok) return null;
    const stop =
      typeof obj.stop === 'string' || Array.isArray(obj.stop)
        ? (obj.stop as string | string[])
        : undefined;
    return {
      ...(typeof obj.max_tokens === 'number' ? { maxTokens: obj.max_tokens } : {}),
      ...(typeof obj.max_completion_tokens === 'number'
        ? { maxCompletionTokens: obj.max_completion_tokens }
        : {}),
      ...(typeof obj.temperature === 'number' ? { temperature: obj.temperature } : {}),
      ...(typeof obj.top_p === 'number' ? { topP: obj.top_p } : {}),
      ...(stop !== undefined ? { stop } : {}),
      ...(tc.value !== undefined ? { toolChoice: tc.value } : {}),
      ...(rf.value !== undefined ? { responseFormat: rf.value } : {}),
    };
  }

  if (wire === 'anthropic') {
    if (
      hasAnyDefined(obj, [
        'thinking',
        'metadata',
        'container',
        'mcp_servers',
        'context_management',
        'output_config',
        'output_format',
      ])
    ) {
      return null;
    }
    let toolChoice: unknown;
    if (obj.tool_choice !== undefined && obj.tool_choice !== null) {
      const tc = asRecord(obj.tool_choice);
      if (!tc || typeof tc.type !== 'string') return null;
      if (tc.type === 'auto') toolChoice = 'auto';
      else if (tc.type === 'any') toolChoice = 'required';
      else if (tc.type === 'none') toolChoice = 'none';
      else if (tc.type === 'tool' && typeof tc.name === 'string') {
        toolChoice = { type: 'function', function: { name: tc.name } };
      } else {
        return null;
      }
    }
    const stop = Array.isArray(obj.stop_sequences) ? (obj.stop_sequences as string[]) : undefined;
    return {
      ...(typeof obj.max_tokens === 'number' ? { maxTokens: obj.max_tokens } : {}),
      ...(typeof obj.temperature === 'number' ? { temperature: obj.temperature } : {}),
      ...(typeof obj.top_p === 'number' ? { topP: obj.top_p } : {}),
      ...(stop !== undefined ? { stop } : {}),
      ...(toolChoice !== undefined ? { toolChoice } : {}),
    };
  }

  if (wire === 'responses') {
    if (
      hasAnyDefined(obj, [
        'previous_response_id',
        'conversation',
        'reasoning',
        'truncation',
        'include',
        'background',
        'parallel_tool_calls',
      ])
    ) {
      return null;
    }
    let toolChoice: unknown;
    if (obj.tool_choice !== undefined && obj.tool_choice !== null) {
      if (obj.tool_choice === 'auto' || obj.tool_choice === 'none' || obj.tool_choice === 'required') {
        toolChoice = obj.tool_choice;
      } else {
        const tc = asRecord(obj.tool_choice);
        if (tc?.type === 'function' && typeof tc.name === 'string') {
          toolChoice = { type: 'function', function: { name: tc.name } };
        } else {
          return null;
        }
      }
    }
    let responseFormat: unknown;
    if (obj.text !== undefined && obj.text !== null) {
      const textObj = asRecord(obj.text);
      const fmt = asRecord(textObj?.format);
      if (!fmt || typeof fmt.type !== 'string') return null;
      if (fmt.type === 'text' || fmt.type === 'json_object') {
        responseFormat = { type: fmt.type };
      } else if (fmt.type === 'json_schema' && typeof fmt.name === 'string' && asRecord(fmt.schema)) {
        responseFormat = {
          type: 'json_schema',
          json_schema: {
            name: fmt.name,
            schema: fmt.schema,
            ...(typeof fmt.strict === 'boolean' ? { strict: fmt.strict } : {}),
          },
        };
      } else {
        return null;
      }
    }
    return {
      ...(typeof obj.max_output_tokens === 'number' ? { maxTokens: obj.max_output_tokens } : {}),
      ...(typeof obj.temperature === 'number' ? { temperature: obj.temperature } : {}),
      ...(typeof obj.top_p === 'number' ? { topP: obj.top_p } : {}),
      ...(toolChoice !== undefined ? { toolChoice } : {}),
      ...(responseFormat !== undefined ? { responseFormat } : {}),
    };
  }

  if (wire === 'gemini') {
    if (hasAnyDefined(obj, ['cachedContent', 'safetySettings'])) {
      return null;
    }
    let toolChoice: unknown;
    if (obj.toolConfig !== undefined && obj.toolConfig !== null) {
      const tc = asRecord(obj.toolConfig);
      const fcc = asRecord(tc?.functionCallingConfig);
      if (!fcc || typeof fcc.mode !== 'string') return null;
      const allowedNames = Array.isArray(fcc.allowedFunctionNames) ? fcc.allowedFunctionNames : undefined;
      if (fcc.mode === 'AUTO' && !allowedNames) toolChoice = 'auto';
      else if (fcc.mode === 'NONE') toolChoice = 'none';
      else if (fcc.mode === 'ANY' && !allowedNames) toolChoice = 'required';
      else if (fcc.mode === 'ANY' && allowedNames?.length === 1 && typeof allowedNames[0] === 'string') {
        toolChoice = { type: 'function', function: { name: allowedNames[0] } };
      } else {
        return null;
      }
    }
    const gen = asRecord(obj.generationConfig) ?? {};
    let responseFormat: unknown;
    if (gen.responseSchema !== undefined && gen.responseSchema !== null) {
      return null;
    }
    if (gen.responseMimeType !== undefined && gen.responseMimeType !== null) {
      if (gen.responseMimeType === 'application/json') {
        responseFormat = { type: 'json_object' };
      } else if (gen.responseMimeType !== 'text/plain') {
        return null;
      }
    }
    return {
      ...(typeof gen.maxOutputTokens === 'number' ? { maxTokens: gen.maxOutputTokens } : {}),
      ...(typeof gen.temperature === 'number' ? { temperature: gen.temperature } : {}),
      ...(typeof gen.topP === 'number' ? { topP: gen.topP } : {}),
      ...(Array.isArray(gen.stopSequences) ? { stop: gen.stopSequences as string[] } : {}),
      ...(toolChoice !== undefined ? { toolChoice } : {}),
      ...(responseFormat !== undefined ? { responseFormat } : {}),
    };
  }

  return {};
}

/** Extracts supported generation parameters safely across the 4 wire protocols. */
export function extractLoopParams(wire: Wire, body: unknown): LoopSafeParams {
  return extractLoopParamsOrNull(wire, body) ?? {};
}
