import type { ChatImage } from './playground-state';

const DB_NAME = 'x-playground-images';
const DB_VERSION = 1;
const STORE_NAME = 'images';

export const PLAYGROUND_IMAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface StoredImageRecord {
  id: string;
  userId: number;
  name: string;
  url: string;
  expiresAt: number;
}

function openImageDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          store.createIndex('expiresAt', 'expiresAt', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** Save attached images to IndexedDB with a 7-day TTL. */
export async function savePlaygroundImages(
  userId: number,
  images: ChatImage[],
  ttlMs = PLAYGROUND_IMAGE_TTL_MS,
): Promise<void> {
  const toSave = images.filter((img) => Boolean(img.id && img.url));
  if (toSave.length === 0) return;

  const db = await openImageDb();
  if (!db) return;

  const expiresAt = Date.now() + ttlMs;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      for (const img of toSave) {
        const record: StoredImageRecord = {
          id: img.id,
          userId,
          name: img.name,
          url: img.url,
          expiresAt,
        };
        store.put(record);
      }
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
      tx.onabort = () => {
        db.close();
        resolve();
      };
    } catch {
      db.close();
      resolve();
    }
  });
}

/** Load non-expired image URLs for the requested IDs from IndexedDB. */
export async function loadPlaygroundImages(
  userId: number,
  ids: string[],
): Promise<Record<string, string>> {
  if (ids.length === 0) return {};
  const db = await openImageDb();
  if (!db) return {};

  const now = Date.now();
  const result: Record<string, string> = {};

  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      let remaining = ids.length;

      for (const id of ids) {
        const req = store.get(id);
        req.onsuccess = () => {
          const rec = req.result as StoredImageRecord | undefined;
          if (rec && rec.userId === userId && typeof rec.url === 'string' && rec.expiresAt > now) {
            result[id] = rec.url;
          }
          remaining -= 1;
          if (remaining === 0) {
            db.close();
            resolve();
          }
        };
        req.onerror = () => {
          remaining -= 1;
          if (remaining === 0) {
            db.close();
            resolve();
          }
        };
      }
    } catch {
      db.close();
      resolve();
    }
  });

  return result;
}

/** Remove expired images and images no longer referenced by any saved chat for this user. */
export async function prunePlaygroundImages(
  userId: number,
  activeImageIds: Set<string>,
): Promise<void> {
  const db = await openImageDb();
  if (!db) return;

  const now = Date.now();
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const cursorReq = store.openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) return;
        const rec = cursor.value as StoredImageRecord;
        const isExpired = typeof rec.expiresAt !== 'number' || rec.expiresAt <= now;
        const isOrphanedForUser = rec.userId === userId && !activeImageIds.has(rec.id);
        if (isExpired || isOrphanedForUser) {
          cursor.delete();
        }
        cursor.continue();
      };
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
      tx.onabort = () => {
        db.close();
        resolve();
      };
    } catch {
      db.close();
      resolve();
    }
  });
}
