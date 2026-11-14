import type { Request } from 'express';
import type { ChatToolDefinition } from '@freellmapi/shared/types.js';
import { sanitizeForGemini } from '../../../lib/gemini-wire.js';
import type { Wire } from './detect.js';

export type ToolDefinition = ChatToolDefinition;

const volatileBlocks = new WeakSet<object>();

const GEMINI_MODEL_PATH = /^(\/v1beta\/models\/)([^:?]+)(:(?:stream)?generatecontent)(.*)$/i;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function extractTextFromContent(content: unknown, wire: Wire): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === 'string') {
      parts.push(item);
      continue;
    }
    const block = asRecord(item);
    if (!block) continue;
    if (wire === 'gemini') {
      if (block.thought === true) continue;
      if (typeof block.text === 'string') parts.push(block.text);
      continue;
    }
    const blockType = typeof block.type === 'string' ? block.type : undefined;
    if (wire === 'anthropic') {
      if (blockType === 'text' && typeof block.text === 'string') parts.push(block.text);
      continue;
    }
    if (wire === 'responses') {
      if ((blockType === 'input_text' || blockType === 'text' || !blockType) && typeof block.text === 'string') {
        parts.push(block.text);
      }
      continue;
    }
    if ((!blockType || blockType === 'text' || blockType === 'input_text') && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join(' ').trim();
}

function scanLastUser(items: unknown, wire: Wire): string {
  if (!Array.isArray(items)) return '';
  for (let i = items.length - 1; i >= 0; i--) {
    const msg = asRecord(items[i]);
    if (!msg) continue;
    if (wire === 'responses') {
      const itemType = typeof msg.type === 'string' ? msg.type : 'message';
      if (itemType !== 'message' || msg.role !== 'user') continue;
      return extractTextFromContent(msg.content, wire);
    }
    if (wire === 'gemini') {
      if (msg.role !== 'user') continue;
      return extractTextFromContent(msg.parts, wire);
    }
    if (msg.role === 'user') {
      return extractTextFromContent(msg.content, wire);
    }
  }
  return '';
}

/** Extracts the latest user message text for the given wire protocol. */
export function lastUserText(wire: Wire, body: unknown): string {
  try {
    const obj = asRecord(body);
    if (!obj) return '';
    if (wire === 'openai-chat' || wire === 'anthropic') {
      return scanLastUser(obj.messages, wire);
    }
    if (wire === 'responses') {
      if (typeof obj.input === 'string') return obj.input;
      return scanLastUser(obj.input, wire);
    }
    if (wire === 'gemini') {
      return scanLastUser(obj.contents, wire);
    }
    return '';
  } catch {
    return '';
  }
}

/** Reads the requested model from body or URL (for Gemini). */
export function requestedModel(wire: Wire, req: Request): string {
  try {
    if (wire === 'gemini') {
      const raw = req.originalUrl || req.url || req.path || '';
      const match = GEMINI_MODEL_PATH.exec(raw);
      if (!match) return '';
      return decodeURIComponent(match[2]!).replace(/^models\//, '');
    }
    const body = asRecord(req.body);
    return typeof body?.model === 'string' ? body.model : '';
  } catch {
    return '';
  }
}

/** Updates the requested model in body or URL (for Gemini), preserving action and query string. */
export function setRequestedModel(wire: Wire, req: Request, model: string): void {
  try {
    if (wire === 'gemini') {
      const encoded = encodeURIComponent(model);
      const rewrite = (val: string | undefined): string | undefined => {
        if (!val) return val;
        return val.replace(GEMINI_MODEL_PATH, `$1${encoded}$3$4`);
      };
      if (req.originalUrl) req.originalUrl = rewrite(req.originalUrl) ?? req.originalUrl;
      if (req.url) req.url = rewrite(req.url) ?? req.url;
      return;
    }
    const body = asRecord(req.body);
    if (body) body.model = model;
  } catch {
    // hot-path no-throw
  }
}

/**
 * Inserts a system block into the request body, keeping `stable` blocks before `volatile` blocks.
 */
export function addSystemBlock(
  wire: Wire,
  body: unknown,
  text: string,
  position: 'stable' | 'volatile',
): void {
  try {
    if (!text) return;
    const obj = asRecord(body);
    if (!obj) return;

    if (wire === 'openai-chat') {
      if (!Array.isArray(obj.messages)) obj.messages = [];
      const msgs = obj.messages as unknown[];
      const entry = { role: 'system', content: text };
      if (position === 'volatile') {
        volatileBlocks.add(entry);
        let at = 0;
        while (at < msgs.length && asRecord(msgs[at])?.role === 'system') at++;
        msgs.splice(at, 0, entry);
      } else {
        let at = 0;
        while (
          at < msgs.length &&
          asRecord(msgs[at])?.role === 'system' &&
          !volatileBlocks.has(msgs[at] as object)
        ) {
          at++;
        }
        msgs.splice(at, 0, entry);
      }
      return;
    }

    if (wire === 'anthropic') {
      if (Array.isArray(obj.system)) {
        const arr = obj.system as unknown[];
        const block = { type: 'text', text };
        if (position === 'volatile') {
          volatileBlocks.add(block);
          arr.push(block);
        } else {
          let at = 0;
          while (at < arr.length && typeof arr[at] === 'object' && arr[at] !== null && !volatileBlocks.has(arr[at] as object)) {
            at++;
          }
          arr.splice(at, 0, block);
        }
      } else {
        const existing = typeof obj.system === 'string' ? obj.system : '';
        if (!existing) {
          obj.system = text;
        } else if (position === 'stable') {
          obj.system = `${text}\n\n${existing}`;
        } else {
          obj.system = `${existing}\n\n${text}`;
        }
      }
      return;
    }

    if (wire === 'responses') {
      const existing = typeof obj.instructions === 'string' ? obj.instructions : '';
      if (!existing) {
        obj.instructions = text;
      } else if (position === 'stable') {
        obj.instructions = `${text}\n\n${existing}`;
      } else {
        obj.instructions = `${existing}\n\n${text}`;
      }
      return;
    }

    if (wire === 'gemini') {
      const si = asRecord(obj.systemInstruction) ?? { parts: [] };
      if (!Array.isArray(si.parts)) si.parts = [];
      const parts = si.parts as unknown[];
      const part = { text };
      if (position === 'volatile') {
        volatileBlocks.add(part);
        parts.push(part);
      } else {
        let at = 0;
        while (at < parts.length && typeof parts[at] === 'object' && parts[at] !== null && !volatileBlocks.has(parts[at] as object)) {
          at++;
        }
        parts.splice(at, 0, part);
      }
      obj.systemInstruction = si;
    }
  } catch {
    // hot-path no-throw
  }
}

/** Appends function tool definitions in the native format of the given wire protocol. */
export function addTools(wire: Wire, body: unknown, tools: ToolDefinition[]): void {
  try {
    if (!tools.length) return;
    const obj = asRecord(body);
    if (!obj) return;

    if (wire === 'openai-chat') {
      const existing = Array.isArray(obj.tools) ? obj.tools : [];
      obj.tools = [...existing, ...tools];
      return;
    }

    if (wire === 'anthropic') {
      const converted = tools.map((t) => ({
        name: t.function.name,
        ...(t.function.description !== undefined ? { description: t.function.description } : {}),
        input_schema: t.function.parameters ?? { type: 'object', properties: {} },
      }));
      const existing = Array.isArray(obj.tools) ? obj.tools : [];
      obj.tools = [...existing, ...converted];
      return;
    }

    if (wire === 'responses') {
      const converted = tools.map((t) => ({
        type: 'function',
        name: t.function.name,
        ...(t.function.description !== undefined ? { description: t.function.description } : {}),
        ...(t.function.parameters !== undefined ? { parameters: t.function.parameters } : {}),
        ...(t.function.strict !== undefined ? { strict: t.function.strict } : {}),
      }));
      const existing = Array.isArray(obj.tools) ? obj.tools : [];
      obj.tools = [...existing, ...converted];
      return;
    }

    if (wire === 'gemini') {
      const decls = tools.map((t) => ({
        name: t.function.name,
        ...(t.function.description !== undefined ? { description: t.function.description } : {}),
        ...(t.function.parameters !== undefined
          ? { parameters: sanitizeForGemini(t.function.parameters) as Record<string, unknown> }
          : {}),
      }));
      if (!Array.isArray(obj.tools)) {
        obj.tools = [{ functionDeclarations: decls }];
        return;
      }
      const existing = obj.tools as unknown[];
      const first = asRecord(existing[0]);
      if (first && Array.isArray(first.functionDeclarations)) {
        first.functionDeclarations = [...first.functionDeclarations, ...decls];
      } else {
        existing.push({ functionDeclarations: decls });
      }
    }
  } catch {
    // hot-path no-throw
  }
}
