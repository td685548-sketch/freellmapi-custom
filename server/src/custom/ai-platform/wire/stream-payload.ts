/** Rewrite textual snapshots too: Responses repeats output in several lifecycle events. */
export function rewriteResponsesFrame(frame: string, text: string): string {
  const lines = frame.split(/\r?\n/);
  const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
  if (!data || data.trim() === '[DONE]') return frame;
  const value: unknown = JSON.parse(data);
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    if ((obj.type === 'output_text' || obj.type === 'response.output_text.done') && typeof obj.text === 'string' && obj.text.length > 0) obj.text = text;
    if (typeof obj.output_text === 'string' && obj.output_text.length > 0) obj.output_text = text;
    for (const key of ['response', 'output', 'item', 'part', 'content']) visit(obj[key]);
  };
  visit(value);
  return [...lines.filter(line => !line.startsWith('data:')), `data: ${JSON.stringify(value)}`].join('\n');
}

type JsonRecord = Record<string, unknown>;
export function geminiArrayItems(raw: string): JsonRecord[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
    throw new Error('Invalid Gemini JSON stream');
  }
  return parsed as JsonRecord[];
}

function textParts(item: JsonRecord): JsonRecord[] {
  const parts: JsonRecord[] = [];
  if (!Array.isArray(item.candidates)) return parts;
  for (const value of item.candidates) {
    const candidate = value as { content?: { parts?: unknown[] } } | null;
    for (const part of candidate?.content?.parts ?? []) {
      if (part && typeof part === 'object' && typeof (part as JsonRecord).text === 'string' && (part as JsonRecord).thought !== true) {
        parts.push(part as JsonRecord);
      }
    }
  }
  return parts;
}

export function geminiItemText(item: JsonRecord): string {
  return textParts(item).map(part => part.text as string).join('');
}

/** Keep JSON-array framing and non-text payloads, putting filtered text in one slot. */
export function rewriteGeminiArray(items: JsonRecord[], text: string, blocked: boolean): string {
  if (blocked) {
    const usage = [...items].reverse().find(item => item.usageMetadata !== undefined)?.usageMetadata;
    return JSON.stringify([{ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'SAFETY', index: 0 }],
      ...(usage !== undefined ? { usageMetadata: usage } : {}) }]);
  }
  let inserted = false;
  for (const item of items) {
    for (const part of textParts(item)) {
      part.text = inserted ? '' : text;
      inserted = true;
    }
  }
  if (!inserted && text) items.unshift({ candidates: [{ content: { role: 'model', parts: [{ text }] }, index: 0 }] });
  return JSON.stringify(items);
}
