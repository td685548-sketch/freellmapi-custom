import type { Request } from 'express';
import type { ChatToolDefinition } from '@freellmapi/shared/types.js';
import { sanitizeForGemini } from '../../../lib/gemini-wire.js';
import type { Wire } from './detect.js';

export type ToolDefinition = ChatToolDefinition;

const volatileBlocks = new WeakSet<object>();
const volatileTexts = new Set<string>();
const stableTexts = new Set<string>();
const MAX_TRACKED_SYSTEM_TEXTS = 5_000;
const VOLATILE_KNOWLEDGE_PREFIX = 'Reference material from this website.';

interface StringSystemState {
  stable: string[];
  caller: string;
  volatile: string[];
  lastRendered: string;
}

const stringSystemSections = new WeakMap<object, Map<'system' | 'instructions', StringSystemState>>();

const GEMINI_MODEL_PATH = /^(\/v1beta\/models\/)([^:?]+)(:(?:stream)?generatecontent)(.*)$/i;

function normalizeSystemText(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

function addBoundedText(set: Set<string>, text: string): void {
  if (!text) return;
  if (set.has(text)) {
    set.delete(text);
  }
  set.add(text);
  while (set.size > MAX_TRACKED_SYSTEM_TEXTS) {
    const oldest = set.values().next().value as string | undefined;
    if (oldest === undefined) break;
    set.delete(oldest);
  }
}

function extractSystemMessageText(msg: unknown): string {
  if (typeof msg === 'string') return msg;
  const rec = asRecord(msg);
  if (!rec) return '';
  if ('content' in rec) {
    if (typeof rec.content === 'string') return rec.content;
    if (Array.isArray(rec.content)) {
      const parts: string[] = [];
      for (const item of rec.content) {
        if (typeof item === 'string') {
          parts.push(item);
        } else {
          const block = asRecord(item);
          if (block && typeof block.text === 'string') {
            parts.push(block.text);
          }
        }
      }
      return parts.join(' ');
    }
    return '';
  }
  if (typeof rec.text === 'string') return rec.text;
  return '';
}

/** Marks a normalized system text block as volatile (e.g. per-query RAG context). */
export function markVolatileSystemText(text: string): void {
  const norm = normalizeSystemText(text);
  if (!norm) return;
  stableTexts.delete(norm);
  addBoundedText(volatileTexts, norm);
}

/** Marks a normalized system text block as stable across requests. */
export function markStableSystemText(text: string): void {
  const norm = normalizeSystemText(text);
  if (!norm) return;
  volatileTexts.delete(norm);
  addBoundedText(stableTexts, norm);
}

/** Returns true if a system message/block is volatile and must stay after cache breakpoints. */
export function isVolatileSystemMessage(msg: unknown): boolean {
  if (msg && typeof msg === 'object' && volatileBlocks.has(msg)) {
    return true;
  }
  const norm = normalizeSystemText(extractSystemMessageText(msg));
  if (!norm) return false;
  if (stableTexts.has(norm)) return false;
  if (volatileTexts.has(norm)) return true;
  return norm.startsWith(VOLATILE_KNOWLEDGE_PREFIX);
}

function appendToStringSystemField(
  obj: Record<string, unknown>,
  field: 'system' | 'instructions',
  text: string,
  position: 'stable' | 'volatile',
): void {
  const current = typeof obj[field] === 'string' ? (obj[field] as string) : '';
  let byField = stringSystemSections.get(obj);
  if (!byField) {
    byField = new Map();
    stringSystemSections.set(obj, byField);
  }
  let state = byField.get(field);
  if (!state || state.lastRendered !== current) {
    state = {
      stable: [],
      caller: current,
      volatile: [],
      lastRendered: current,
    };
    byField.set(field, state);
  }
  if (position === 'stable') {
    markStableSystemText(text);
    state.stable.push(text);
  } else {
    markVolatileSystemText(text);
    state.volatile.push(text);
  }
  const parts = [...state.stable, ...(state.caller ? [state.caller] : []), ...state.volatile];
  const rendered = parts.join('\n\n');
  state.lastRendered = rendered;
  obj[field] = rendered;
}

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
        markVolatileSystemText(text);
        let at = 0;
        while (at < msgs.length && asRecord(msgs[at])?.role === 'system') at++;
        msgs.splice(at, 0, entry);
      } else {
        markStableSystemText(text);
        let at = 0;
        while (
          at < msgs.length &&
          asRecord(msgs[at])?.role === 'system' &&
          !isVolatileSystemMessage(msgs[at])
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
          markVolatileSystemText(text);
          arr.push(block);
        } else {
          markStableSystemText(text);
          let at = 0;
          while (at < arr.length && typeof arr[at] === 'object' && arr[at] !== null && !isVolatileSystemMessage(arr[at])) {
            at++;
          }
          arr.splice(at, 0, block);
        }
      } else {
        appendToStringSystemField(obj, 'system', text, position);
      }
      return;
    }

    if (wire === 'responses') {
      appendToStringSystemField(obj, 'instructions', text, position);
      return;
    }

    if (wire === 'gemini') {
      const si = asRecord(obj.systemInstruction) ?? { parts: [] };
      if (!Array.isArray(si.parts)) si.parts = [];
      const parts = si.parts as unknown[];
      const part = { text };
      if (position === 'volatile') {
        volatileBlocks.add(part);
        markVolatileSystemText(text);
        parts.push(part);
      } else {
        markStableSystemText(text);
        let at = 0;
        while (at < parts.length && typeof parts[at] === 'object' && parts[at] !== null && !isVolatileSystemMessage(parts[at])) {
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
