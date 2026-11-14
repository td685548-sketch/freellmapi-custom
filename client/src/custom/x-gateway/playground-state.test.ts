// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadChats, saveChats, type ChatSession } from './playground-state';
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
