import type { ChatCompletionResponse, ChatMessage } from '@freellmapi/shared/types.js';

export const DEFAULT_SYSTEMONE_ROUTER_MODEL = 'oc/jev-1.13-free';
export const DEFAULT_SYSTEMONE_TIMEOUT_MS = 8000;
export const MAX_STATE_CHARS = 2000;
export const MAX_STICKY_SESSIONS = 5000;
export const STICKY_SESSION_TTL_MS = 2 * 60 * 60 * 1000;

export interface SystemOneDecision {
  choice: string;
  confidence: number | null;
  probabilities: Record<string, number> | null;
}

const comboSessionModelStore = new Map<string, { model: string; lastUsed: number }>();

export function resetStickyComboStore(): void {
  comboSessionModelStore.clear();
}

export function clearStickyComboSession(comboName?: string, sessionId?: string | null): void {
  if (!comboName) {
    comboSessionModelStore.clear();
    return;
  }
  if (sessionId) {
    comboSessionModelStore.delete(`${comboName}:${sessionId}`);
    return;
  }
  const prefix = `${comboName}:`;
  for (const k of comboSessionModelStore.keys()) {
    if (k.startsWith(prefix)) comboSessionModelStore.delete(k);
  }
}

function pruneStickyComboSessions(): void {
  if (comboSessionModelStore.size < MAX_STICKY_SESSIONS) return;
  const now = Date.now();
  for (const [k, v] of comboSessionModelStore.entries()) {
    if (now - v.lastUsed > STICKY_SESSION_TTL_MS) comboSessionModelStore.delete(k);
  }
  if (comboSessionModelStore.size >= MAX_STICKY_SESSIONS) {
    const sorted = [...comboSessionModelStore.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    const toDrop = sorted.slice(0, Math.floor(MAX_STICKY_SESSIONS / 4));
    for (const [k] of toDrop) comboSessionModelStore.delete(k);
  }
}

export function getStickyComboModel(comboName: string, sessionId: string | null | undefined, models: string[]): string | null {
  if (!sessionId || !comboName || !Array.isArray(models)) return null;
  const key = `${comboName}:${sessionId}`;
  const entry = comboSessionModelStore.get(key);
  if (!entry) return null;
  if (Date.now() - entry.lastUsed > STICKY_SESSION_TTL_MS) {
    comboSessionModelStore.delete(key);
    return null;
  }
  if (!models.includes(entry.model)) {
    comboSessionModelStore.delete(key);
    return null;
  }
  entry.lastUsed = Date.now();
  return entry.model;
}

export function setStickyComboModel(comboName: string, sessionId: string | null | undefined, model: string): void {
  if (!sessionId || !comboName || !model) return;
  pruneStickyComboSessions();
  comboSessionModelStore.set(`${comboName}:${sessionId}`, { model, lastUsed: Date.now() });
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) => (typeof part === 'string' ? part : part?.type === 'text' && typeof part.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join(' ');
  }
  return '';
}

export function extractPromptState(body: Record<string, any> | null | undefined, maxChars = MAX_STATE_CHARS): string {
  if (!body || typeof body !== 'object') return '';
  const messages = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : null;
  if (messages && messages.length > 0) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === 'user' || msg?.type === 'message' || (!msg?.role && msg?.content)) {
        const text = extractTextFromContent(msg.content ?? msg.text);
        if (text.trim()) return text.trim().slice(0, maxChars);
      }
    }
    const lastMsg = messages[messages.length - 1];
    const fallback = extractTextFromContent(lastMsg?.content ?? lastMsg?.text);
    if (fallback.trim()) return fallback.trim().slice(0, maxChars);
  }
  if (typeof body.prompt === 'string' && body.prompt.trim()) return body.prompt.trim().slice(0, maxChars);
  if (typeof body.input === 'string' && body.input.trim()) return body.input.trim().slice(0, maxChars);
  return '';
}

export function buildChoiceCriteria(models: string[]): Record<string, null> {
  const criteria: Record<string, null> = {};
  if (!Array.isArray(models)) return criteria;
  for (const m of models) {
    if (typeof m === 'string' && m.trim()) criteria[m.trim()] = null;
  }
  return criteria;
}

export function parseSystemOneRouteAnswer(json: unknown): SystemOneDecision | null {
  if (!json || typeof json !== 'object') return null;
  const obj = json as Record<string, any>;

  // Native System One shape: { answers: { route: { choice, confidence, probabilities } } }
  let route: Record<string, any> | null =
    obj.answers?.route && typeof obj.answers.route === 'object' ? obj.answers.route : null;

  // Also tolerate OpenAI Chat Completions JSON whose assistant content encodes JSON decision
  if (!route && Array.isArray(obj.choices) && obj.choices[0]?.message?.content) {
    const raw = String(obj.choices[0].message.content).trim();
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    try {
      const inner = JSON.parse(cleaned);
      if (inner && typeof inner === 'object') {
        route = inner.answers?.route && typeof inner.answers.route === 'object' ? inner.answers.route : inner;
      }
    } catch { /* ignore */ }
  }

  if (!route) return null;
  const rawChoice = typeof route.choice === 'string' ? route.choice.trim() : '';
  if (!rawChoice) return null;

  const confidence = typeof route.confidence === 'number' && Number.isFinite(route.confidence)
    ? route.confidence
    : null;

  let probabilities: Record<string, number> | null = null;
  if (route.probabilities && typeof route.probabilities === 'object' && !Array.isArray(route.probabilities)) {
    probabilities = {};
    for (const [k, v] of Object.entries(route.probabilities)) {
      const num = typeof v === 'number' ? v : Number(v);
      if (Number.isFinite(num)) probabilities[k] = num;
    }
  }

  return { choice: rawChoice, confidence, probabilities };
}

export function orderModelsByChoice<T>(
  items: T[],
  keyOf: (item: T) => string,
  decision: SystemOneDecision | null,
): T[] {
  if (!decision?.choice || items.length <= 1) return items;
  const matchIdx = items.findIndex((item) => keyOf(item) === decision.choice);
  if (matchIdx < 0) return items;

  const primary = items[matchIdx];
  const rest = items.filter((_, i) => i !== matchIdx);
  if (decision.probabilities) {
    rest.sort((a, b) => (decision.probabilities![keyOf(b)] ?? 0) - (decision.probabilities![keyOf(a)] ?? 0));
  }
  return [primary, ...rest];
}

export type ClassifierInvoker = (
  systemOneModel: string,
  messages: ChatMessage[],
  timeoutMs: number,
) => Promise<ChatCompletionResponse | Record<string, any> | null>;

export async function resolveSystemOneComboOrder<T>(opts: {
  items: T[];
  keyOf: (item: T) => string;
  comboName: string;
  systemOneModel?: string | null;
  smartPolicy?: string;
  confidenceThreshold?: number;
  sessionId?: string | null;
  promptState: string;
  invokeClassifier?: ClassifierInvoker;
}): Promise<{ ordered: T[]; activeStickyModel: string | null; decision: SystemOneDecision | null }> {
  const { items, keyOf, comboName, systemOneModel, sessionId, promptState, invokeClassifier } = opts;
  if (!systemOneModel?.trim() || items.length <= 1 || !invokeClassifier || !promptState.trim()) {
    return { ordered: items, activeStickyModel: null, decision: null };
  }

  const keys = items.map(keyOf);
  const policy = (opts.smartPolicy || 'smart').toLowerCase();
  const isPerTurn = policy === 'per-turn';
  const isStrict = policy === 'strict';
  let switchThreshold = 0.8;
  if (policy === 'smart-switch-70') switchThreshold = 0.7;
  else if (policy === 'smart-switch-90') switchThreshold = 0.9;
  else if (typeof opts.confidenceThreshold === 'number' && Number.isFinite(opts.confidenceThreshold)) {
    switchThreshold = opts.confidenceThreshold;
  }

  let sticky = !isPerTurn && sessionId ? getStickyComboModel(comboName, sessionId, keys) : null;

  if (sticky && isStrict) {
    const idx = items.findIndex((item) => keyOf(item) === sticky);
    if (idx >= 0) {
      return {
        ordered: [items[idx], ...items.filter((_, i) => i !== idx)],
        activeStickyModel: sticky,
        decision: { choice: sticky, confidence: 1, probabilities: null },
      };
    }
  }

  const criteria = buildChoiceCriteria(keys);
  const classifyMessages: ChatMessage[] = [
    {
      role: 'system',
      content: 'You are a model routing classifier. Choose the single best model ID from the candidate map for the user prompt and reply with strict JSON: {"choice":"<model_id>","confidence":0.95,"probabilities":{"<model_id>":0.95}}.',
    },
    {
      role: 'user',
      content: JSON.stringify({ candidates: criteria, prompt: promptState }),
    },
  ];

  let decision: SystemOneDecision | null = null;
  try {
    const raw = await invokeClassifier(systemOneModel.trim(), classifyMessages, DEFAULT_SYSTEMONE_TIMEOUT_MS);
    decision = parseSystemOneRouteAnswer(raw);
  } catch {
    decision = null;
  }

  if (sticky) {
    const newChoice = decision?.choice;
    const conf = decision?.confidence;
    if (newChoice && newChoice !== sticky && keys.includes(newChoice) && conf !== null && conf !== undefined && conf >= switchThreshold) {
      if (sessionId) setStickyComboModel(comboName, sessionId, newChoice);
      return { ordered: orderModelsByChoice(items, keyOf, decision), activeStickyModel: newChoice, decision };
    }
    const idx = items.findIndex((item) => keyOf(item) === sticky);
    if (idx >= 0) {
      return { ordered: [items[idx], ...items.filter((_, i) => i !== idx)], activeStickyModel: sticky, decision };
    }
  }

  if (decision?.choice && keys.includes(decision.choice)) {
    if (switchThreshold <= 0 || decision.confidence === null || decision.confidence >= switchThreshold) {
      if (!isPerTurn && sessionId) {
        setStickyComboModel(comboName, sessionId, decision.choice);
        sticky = decision.choice;
      }
      return { ordered: orderModelsByChoice(items, keyOf, decision), activeStickyModel: sticky, decision };
    }
  }

  return { ordered: items, activeStickyModel: sticky, decision };
}
