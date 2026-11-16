// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildWindowedPlaygroundMessages,
  createDebouncedChatSaver,
  historyKey,
  loadChats,
  saveChats,
  type ChatSession,
  type ChatTurn,
} from './playground-state';
import {
  PLAYGROUND_IMAGE_TTL_MS,
  loadPlaygroundImages,
  prunePlaygroundImages,
  savePlaygroundImages,
} from './playground-image-store';

describe('playground-state image metadata persistence', () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('persists lightweight image metadata in localStorage without storing base64 url', () => {
    const chats: ChatSession[] = [
      {
        id: 'chat-1',
        title: 'Image chat',
        model: 'auto',
        updatedAt: Date.now(),
        messages: [
          {
            id: 'msg-1',
            role: 'user',
            content: 'Describe this',
            images: [{ id: 'img-1', name: 'photo.jpg', url: 'data:image/jpeg;base64,AAAA' }],
          },
        ],
      },
    ];

    expect(saveChats(42, chats)).toBe(true);
    const loaded = loadChats(42);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.messages[0]!.images).toEqual([{ id: 'img-1', name: 'photo.jpg', url: '' }]);
  });

  it('no-ops gracefully when indexedDB is unavailable', async () => {
    await expect(
      savePlaygroundImages(42, [{ id: 'img-1', name: 'a.png', url: 'data:image/png;base64,AA==' }]),
    ).resolves.toBeUndefined();
    await expect(loadPlaygroundImages(42, ['img-1'])).resolves.toEqual({});
    await expect(prunePlaygroundImages(42, new Set(['img-1']))).resolves.toBeUndefined();
    expect(PLAYGROUND_IMAGE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe('createDebouncedChatSaver', () => {
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('coalesces rapid updates and writes latest state once after delay', () => {
    vi.useFakeTimers();
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    const saver = createDebouncedChatSaver(600);
    const makeChat = (content: string): ChatSession[] => [
      {
        id: 'chat-1',
        title: 'Test',
        model: 'auto',
        updatedAt: 1,
        messages: [{ id: 'm1', role: 'assistant', content }],
      },
    ];

    saver.schedule(7, makeChat('H'));
    saver.schedule(7, makeChat('He'));
    saver.schedule(7, makeChat('Hello'));

    expect(setItemSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(599);
    expect(setItemSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(setItemSpy).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(historyKey(7))).toContain('"Hello"');
  });

  it('flushes immediately without double-writing when the timer expires', () => {
    vi.useFakeTimers();
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    const saver = createDebouncedChatSaver(600);
    const chats: ChatSession[] = [
      { id: 'c1', title: 'T', model: 'auto', updatedAt: 1, messages: [{ id: 'm1', role: 'user', content: 'Hi' }] },
    ];

    saver.schedule(9, chats);
    saver.flush();
    expect(setItemSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    expect(setItemSpy).toHaveBeenCalledTimes(1);
  });

  it('cancels pending writes when cancel() is called', () => {
    vi.useFakeTimers();
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    const saver = createDebouncedChatSaver(600);
    saver.schedule(9, [
      { id: 'c1', title: 'T', model: 'auto', updatedAt: 1, messages: [] },
    ]);
    saver.cancel();
    vi.advanceTimersByTime(1000);
    expect(setItemSpy).not.toHaveBeenCalled();
  });
});

describe('buildWindowedPlaygroundMessages', () => {
  it('preserves system prompt, pinned opening pair, recent turns, and current turn', () => {
    const turns: ChatTurn[] = [];
    for (let i = 0; i < 30; i++) {
      turns.push({ id: `u-${i}`, role: 'user', content: `question ${i}` });
      turns.push({ id: `a-${i}`, role: 'assistant', content: `answer ${i}` });
    }
    turns.push({ id: 'u-final', role: 'user', content: 'latest question' });

    const messages = buildWindowedPlaygroundMessages(turns, 'Be concise.', {
      maxHistoryTurns: 8,
      maxHistoryChars: 5000,
    });

    expect(messages[0]).toEqual({ role: 'system', content: 'Be concise.' });
    // Pinned opening user+assistant pair
    expect(messages[1]).toEqual({ role: 'user', content: 'question 0' });
    expect(messages[2]).toEqual({ role: 'assistant', content: 'answer 0' });
    // Current turn at the end
    expect(messages[messages.length - 1]).toEqual({ role: 'user', content: 'latest question' });
    // Total non-system messages = 8 prior turns + 1 current = 9
    expect(messages).toHaveLength(10);
    expect(messages.some((m) => m.content === 'question 29')).toBe(true);
    expect(messages.some((m) => m.content === 'question 5')).toBe(false);
  });

  it('keeps base64 images on recent turns and replaces stale historical images with text notes', () => {
    const turns: ChatTurn[] = [
      {
        id: 'u-0',
        role: 'user',
        content: 'First pic',
        images: [{ id: 'img-0', name: 'old.png', url: 'data:image/png;base64,OLD' }],
      },
      { id: 'a-0', role: 'assistant', content: 'Nice old pic' },
      { id: 'u-1', role: 'user', content: 'Turn 1' },
      { id: 'a-1', role: 'assistant', content: 'Reply 1' },
      { id: 'u-2', role: 'user', content: 'Turn 2' },
      { id: 'a-2', role: 'assistant', content: 'Reply 2' },
      {
        id: 'u-3',
        role: 'user',
        content: 'New pic',
        images: [{ id: 'img-3', name: 'new.png', url: 'data:image/png;base64,NEW' }],
      },
    ];

    const messages = buildWindowedPlaygroundMessages(turns, '');
    expect(messages[0]).toEqual({ role: 'user', content: 'First pic\n[Attached image: old.png]' });
    expect(messages[messages.length - 1]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'New pic' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,NEW' } },
      ],
    });
  });

  it('drops empty historical assistant turns and unhydrated image URLs', () => {
    const turns: ChatTurn[] = [
      { id: 'u-0', role: 'user', content: 'Hello' },
      { id: 'a-0', role: 'assistant', content: '' },
      {
        id: 'u-1',
        role: 'user',
        content: 'Follow up',
        images: [{ id: 'img-missing', name: 'expired.png', url: '' }],
      },
    ];

    const messages = buildWindowedPlaygroundMessages(turns, '');
    expect(messages).toEqual([
      { role: 'user', content: 'Hello' },
      { role: 'user', content: 'Follow up\n[Attached image: expired.png]' },
    ]);
  });
});
