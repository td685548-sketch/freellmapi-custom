export interface ChatImage { id: string; name: string; url: string }
export interface ChatTurn {
  id: string; role: 'user' | 'assistant'; content: string; images?: ChatImage[]; meta?: string;
}
export interface ChatSession {
  id: string; title: string; model: string; messages: ChatTurn[]; updatedAt: number;
}
export const historyKey = (userId: number) => `x-playground.history.${userId}`;
export function newChat(): ChatSession {
  return { id: crypto.randomUUID(), title: '', model: 'auto', messages: [], updatedAt: Date.now() };
}
export function loadChats(userId: number): ChatSession[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(historyKey(userId)) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw.filter((c): c is ChatSession => Boolean(c && typeof c.id === 'string'
      && typeof c.title === 'string' && typeof c.model === 'string' && typeof c.updatedAt === 'number'
      && Array.isArray(c.messages) && c.messages.length <= 100 && c.messages.every((m: ChatTurn) => m
        && typeof m.id === 'string' && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')))
      .slice(0, 20).map(c => ({ ...c, messages: c.messages.map(({ id, role, content, meta }) => ({ id, role, content, meta })) }));
  } catch { return []; }
}
export function saveChats(userId: number, chats: ChatSession[]): boolean {
  try {
    // Attachments stay in memory; never persist large image data or credentials.
    const safe = chats.slice(0, 20).map(c => ({ ...c,
      messages: c.messages.slice(-100).map(({ id, role, content, meta }) => ({ id, role, content, meta })),
    }));
    const text = JSON.stringify(safe);
    if (text.length > 500_000) return false;
    localStorage.setItem(historyKey(userId), text);
    return true;
  } catch { return false; }
}
