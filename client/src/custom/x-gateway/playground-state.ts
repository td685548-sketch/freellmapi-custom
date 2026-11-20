import type { PlaygroundContent, PlaygroundRequest } from '../../../../shared/x-playground';

export type ReasoningEffort = '' | 'low' | 'medium' | 'high';

export interface ChatSamplingSettings {
  temperature: number;
  maxTokens: number;
  reasoningEffort: ReasoningEffort;
}

export interface ChatSettings extends ChatSamplingSettings {
  systemPrompt: string;
}

export const DEFAULT_TEMPERATURE = 0.7;
export const DEFAULT_MAX_TOKENS = 2048;
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = '';
export const MIN_TEMPERATURE = 0;
export const MAX_TEMPERATURE = 2;
export const MIN_MAX_TOKENS = 1;
export const MAX_MAX_TOKENS = 32_768;

export const DEFAULT_CHAT_SAMPLING_SETTINGS: ChatSamplingSettings = {
  temperature: DEFAULT_TEMPERATURE,
  maxTokens: DEFAULT_MAX_TOKENS,
  reasoningEffort: DEFAULT_REASONING_EFFORT,
};

export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  systemPrompt: '',
  ...DEFAULT_CHAT_SAMPLING_SETTINGS,
};

export interface ChatImage { id: string; name: string; url: string }
export interface ChatTurn {
  id: string; role: 'user' | 'assistant'; content: string; reasoning?: string; images?: ChatImage[]; meta?: string;
}
export interface ChatSession {
  id: string;
  title: string;
  model: string;
  messages: ChatTurn[];
  updatedAt: number;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: ReasoningEffort;
}
export const historyKey = (userId: number) => `x-playground.history.${userId}`;
export const activeChatKey = (userId: number) => `x-playground.active-chat.${userId}`;
export const settingsKey = (userId: number) => `x-playground.settings.${userId}`;
export const SETTINGS_OPEN_KEY = 'x_playground_settings_open';
export const CHAT_SAVE_DEBOUNCE_MS = 600;
export const PLAYGROUND_MAX_HISTORY_TURNS = 20;
export const PLAYGROUND_MAX_HISTORY_CHARS = 40_000;
export const PLAYGROUND_PINNED_OPENING_CHARS = 4_000;
export const PLAYGROUND_RECENT_IMAGE_TURNS = 2;

export function sanitizeTemperature(value: unknown, fallback = DEFAULT_TEMPERATURE): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_TEMPERATURE, Math.max(MIN_TEMPERATURE, value));
}

export function sanitizeMaxTokens(value: unknown, fallback = DEFAULT_MAX_TOKENS): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_MAX_TOKENS, Math.max(MIN_MAX_TOKENS, Math.round(value)));
}

export function sanitizeReasoningEffort(
  value: unknown,
  fallback: ReasoningEffort = DEFAULT_REASONING_EFFORT,
): ReasoningEffort {
  if (value === '' || value === 'low' || value === 'medium' || value === 'high') {
    return value;
  }
  return fallback;
}

export function sanitizeSystemPrompt(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function sanitizeChatSamplingSettings(
  raw: unknown,
  fallback: ChatSamplingSettings = DEFAULT_CHAT_SAMPLING_SETTINGS,
): ChatSamplingSettings {
  if (!raw || typeof raw !== 'object') {
    return { ...fallback };
  }
  const obj = raw as Record<string, unknown>;
  return {
    temperature: sanitizeTemperature(obj.temperature, fallback.temperature),
    maxTokens: sanitizeMaxTokens(obj.maxTokens, fallback.maxTokens),
    reasoningEffort: sanitizeReasoningEffort(obj.reasoningEffort, fallback.reasoningEffort),
  };
}

export function sanitizeChatSettings(
  raw: unknown,
  defaults: Partial<ChatSamplingSettings> = DEFAULT_CHAT_SAMPLING_SETTINGS,
): ChatSettings {
  const samplingDefaults = sanitizeChatSamplingSettings(defaults);
  if (!raw || typeof raw !== 'object') {
    return { systemPrompt: '', ...samplingDefaults };
  }
  const obj = raw as Record<string, unknown>;
  return {
    systemPrompt: sanitizeSystemPrompt(obj.systemPrompt, ''),
    ...sanitizeChatSamplingSettings(obj, samplingDefaults),
  };
}

export function getChatSettings(
  chat?: Partial<ChatSession> | null,
  defaults?: Partial<ChatSamplingSettings>,
): ChatSettings {
  return sanitizeChatSettings(chat, defaults);
}

export function newChat(defaults?: Partial<ChatSamplingSettings>): ChatSession {
  const sampling = sanitizeChatSamplingSettings(defaults);
  return {
    id: crypto.randomUUID(),
    title: '',
    model: 'auto',
    messages: [],
    updatedAt: Date.now(),
    systemPrompt: '',
    temperature: sampling.temperature,
    maxTokens: sampling.maxTokens,
    reasoningEffort: sampling.reasoningEffort,
  };
}
function sanitizeImageMeta(images: unknown): ChatImage[] | undefined {
  if (!Array.isArray(images) || images.length === 0) return undefined;
  const cleaned = images
    .filter((img): img is { id: string; name?: unknown; url?: unknown } =>
      Boolean(img && typeof img === 'object' && typeof (img as { id?: unknown }).id === 'string'))
    .map((img) => ({
      id: img.id,
      name: typeof img.name === 'string' ? img.name : 'image',
      url: '',
    }));
  return cleaned.length > 0 ? cleaned : undefined;
}

export function loadChats(userId: number): ChatSession[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(historyKey(userId)) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw.filter((c): c is ChatSession => Boolean(c && typeof c.id === 'string'
      && typeof c.title === 'string' && typeof c.model === 'string' && typeof c.updatedAt === 'number'
      && Array.isArray(c.messages) && c.messages.length <= 100 && c.messages.every((m: ChatTurn) => m
        && typeof m.id === 'string' && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')))
      .slice(0, 20).map(c => ({
        ...c,
        ...sanitizeChatSettings(c),
        messages: c.messages.map(({ id, role, content, reasoning, meta, images }) => ({
          id,
          role,
          content,
          ...(typeof reasoning === 'string' && reasoning.length > 0 ? { reasoning } : {}),
          meta,
          ...(sanitizeImageMeta(images) ? { images: sanitizeImageMeta(images) } : {}),
        })),
      }));
  } catch { return []; }
}
export function saveChats(userId: number, chats: ChatSession[]): boolean {
  try {
    // Store only lightweight image metadata (id, name) in localStorage; actual image data lives in IndexedDB.
    const safe = chats.slice(0, 20).map(c => ({
      ...c,
      ...sanitizeChatSettings(c),
      messages: c.messages.slice(-100).map(({ id, role, content, meta, images }) => ({
        id,
        role,
        content,
        meta,
        ...(sanitizeImageMeta(images) ? { images: sanitizeImageMeta(images) } : {}),
      })),
    }));
    const text = JSON.stringify(safe);
    if (text.length > 500_000) return false;
    localStorage.setItem(historyKey(userId), text);
    return true;
  } catch { return false; }
}

export function loadActiveChatId(userId: number): string {
  if (!userId) return '';
  try {
    return localStorage.getItem(activeChatKey(userId)) ?? '';
  } catch {
    return '';
  }
}

export function saveActiveChatId(userId: number, chatId: string): boolean {
  if (!userId || !chatId) return false;
  try {
    localStorage.setItem(activeChatKey(userId), chatId);
    return true;
  } catch {
    return false;
  }
}

export function resolveActiveChatId(chats: ChatSession[], preferredId: string): string {
  if (preferredId && chats.some((c) => c.id === preferredId)) {
    return preferredId;
  }
  return chats[0]?.id ?? '';
}

export function loadDefaultSettings(userId: number): ChatSamplingSettings {
  if (!userId) return { ...DEFAULT_CHAT_SAMPLING_SETTINGS };
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(settingsKey(userId)) ?? 'null');
    return sanitizeChatSamplingSettings(raw);
  } catch {
    return { ...DEFAULT_CHAT_SAMPLING_SETTINGS };
  }
}

export function saveDefaultSettings(
  userId: number,
  settings: Partial<ChatSamplingSettings>,
): boolean {
  if (!userId) return false;
  try {
    const normalized = sanitizeChatSamplingSettings(settings);
    localStorage.setItem(settingsKey(userId), JSON.stringify(normalized));
    return true;
  } catch {
    return false;
  }
}

export interface DebouncedChatSaver {
  schedule: (userId: number, chats: ChatSession[]) => void;
  flush: () => void;
  cancel: () => void;
}

/** Coalesce frequent chat state updates during streaming before writing to localStorage. */
export function createDebouncedChatSaver(delayMs = CHAT_SAVE_DEBOUNCE_MS): DebouncedChatSaver {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { userId: number; chats: ChatSession[] } | null = null;

  const flush = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (!pending) return;
    const { userId, chats } = pending;
    pending = null;
    saveChats(userId, chats);
  };

  const schedule = (userId: number, chats: ChatSession[]) => {
    pending = { userId, chats };
    if (timer !== null) return;
    timer = setTimeout(flush, delayMs);
  };

  const cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    pending = null;
  };

  return { schedule, flush, cancel };
}

function stripInlineImageDataUrls(text: string): string {
  return text.replace(/!\[([^\]]*)\]\(data:image\/[^)]+\)/gi, (_match, alt: string) =>
    alt.trim() ? `[Image: ${alt.trim()}]` : '[Generated image]',
  );
}

function buildMessageParts(text: string, images: ChatImage[]): PlaygroundContent {
  const parts: PlaygroundContent = [];
  const trimmed = text.trim();
  if (trimmed) {
    parts.push({ type: 'text', text: trimmed });
  }
  for (const img of images) {
    parts.push({ type: 'image_url' as const, image_url: { url: img.url } });
  }
  // Avoid 400 errors on upstream vision models requiring a non-empty text part.
  if (parts.length > 0 && !parts.some((p) => p.type === 'text')) {
    parts.unshift({ type: 'text', text: 'Describe or analyze this image.' });
  }
  return parts;
}

export interface WindowHistoryOptions {
  maxHistoryTurns?: number;
  maxHistoryChars?: number;
  recentImageTurns?: number;
}

/**
 * Assemble bounded gateway messages from chat turns: preserves the system prompt,
 * optional opening exchange when truncated, recent turns within a char budget,
 * and the current user turn, while omitting stale base64 image blobs.
 */
export function buildWindowedPlaygroundMessages(
  turns: ChatTurn[],
  systemPrompt = '',
  options: WindowHistoryOptions = {},
): PlaygroundRequest['messages'] {
  const maxHistoryTurns = options.maxHistoryTurns ?? PLAYGROUND_MAX_HISTORY_TURNS;
  const maxHistoryChars = options.maxHistoryChars ?? PLAYGROUND_MAX_HISTORY_CHARS;
  const recentImageTurns = options.recentImageTurns ?? PLAYGROUND_RECENT_IMAGE_TURNS;

  const requestMessages: PlaygroundRequest['messages'] = [];
  const trimmedSystem = systemPrompt.trim();
  if (trimmedSystem) {
    requestMessages.push({ role: 'system', content: trimmedSystem });
  }

  const usableTurns = turns.filter((turn, idx) => {
    const isLast = idx === turns.length - 1;
    if (isLast) return true;
    const hasContent = turn.content.trim().length > 0;
    const hasValidImages = Boolean(turn.images?.some((img) => Boolean(img.url)));
    return hasContent || hasValidImages;
  });

  if (usableTurns.length === 0) return requestMessages;

  const currentTurn = usableTurns[usableTurns.length - 1]!;
  const priorTurns = usableTurns.slice(0, -1);

  const sanitizedTexts = priorTurns.map((t) => stripInlineImageDataUrls(t.content));
  const selectedRecent: ChatTurn[] = [];
  let charBudget = 0;
  let startIdx = priorTurns.length;

  for (let i = priorTurns.length - 1; i >= 0; i--) {
    if (selectedRecent.length >= maxHistoryTurns) break;
    const turnLen = sanitizedTexts[i]!.length;
    if (selectedRecent.length > 0 && charBudget + turnLen > maxHistoryChars) break;
    selectedRecent.unshift(priorTurns[i]!);
    charBudget += turnLen;
    startIdx = i;
  }

  // Preserve the opening user+assistant pair as pinned context when older turns are windowed out.
  const pinnedOpening: ChatTurn[] = [];
  if (
    startIdx >= 2 &&
    priorTurns[0]?.role === 'user' &&
    priorTurns[1]?.role === 'assistant' &&
    maxHistoryTurns >= 4
  ) {
    const openingChars = sanitizedTexts[0]!.length + sanitizedTexts[1]!.length;
    if (
      openingChars <= PLAYGROUND_PINNED_OPENING_CHARS &&
      charBudget + openingChars <= maxHistoryChars
    ) {
      pinnedOpening.push(priorTurns[0]!, priorTurns[1]!);
      while (pinnedOpening.length + selectedRecent.length > maxHistoryTurns && selectedRecent.length > 2) {
        selectedRecent.shift();
      }
    }
  }

  const windowedTurns = [...pinnedOpening, ...selectedRecent, currentTurn];

  // Keep raw base64 image payloads only for the current turn and most recent follow-up turns.
  const imageTurnIndices = new Set<number>();
  for (let i = windowedTurns.length - 1; i >= 0 && imageTurnIndices.size < recentImageTurns; i--) {
    const turn = windowedTurns[i]!;
    if (i < windowedTurns.length - 4) break;
    if (turn.images?.some((img) => Boolean(img.url))) {
      imageTurnIndices.add(i);
    }
  }

  for (let i = 0; i < windowedTurns.length; i++) {
    const turn = windowedTurns[i]!;
    const isCurrent = i === windowedTurns.length - 1;
    const sanitizedContent = isCurrent ? turn.content : stripInlineImageDataUrls(turn.content);
    const validImages = turn.images?.filter((img) => Boolean(img.url)) ?? [];

    if (validImages.length > 0 && (isCurrent || imageTurnIndices.has(i))) {
      requestMessages.push({
        role: turn.role,
        content: buildMessageParts(sanitizedContent, validImages),
      });
    } else if (turn.images && turn.images.length > 0) {
      const names = turn.images.map((img) => img.name || 'image').join(', ');
      const note = `[Attached image: ${names}]`;
      const content = sanitizedContent.trim() ? `${sanitizedContent.trim()}\n${note}` : note;
      requestMessages.push({ role: turn.role, content });
    } else {
      requestMessages.push({ role: turn.role, content: sanitizedContent });
    }
  }

  return requestMessages;
}
