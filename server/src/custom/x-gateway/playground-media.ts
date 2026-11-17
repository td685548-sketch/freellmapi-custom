import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { getDb } from '../../db/index.js';
import { assertProviderUrlAllowedWithPin } from '../../lib/url-guard.js';

/**
 * Provider images re-hosted for the Playground.
 *
 * Chat providers that return pictures (Gemini Web today) hand back Google CDN
 * URLs that only resolve with the account's cookies — and the console's CSP
 * (`img-src 'self' data:`) blocks cross-origin images regardless. So the reply
 * stream downloads each picture once with the credential it already holds and
 * rewrites the markdown to a same-origin, unguessable URL served from here.
 */

/** How long a rewritten image URL keeps working. */
export const PLAYGROUND_MEDIA_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Refuse anything past this, so one download cannot fill the database. */
export const PLAYGROUND_MEDIA_MAX_BYTES = 8 * 1024 * 1024;

/** Where the router is mounted; the rewrite below has to agree with it. */
export const PLAYGROUND_MEDIA_PATH = '/playground/media';

const ID_PATTERN = /^[a-f0-9]{32}$/;

const IMAGE_HOSTS = ['googleusercontent.com', 'ggpht.com', 'usercontent.google.com'];

/**
 * True for an image asset Gemini itself handed back. Placeholder paths
 * (`image_generation_content`, `card_content`, `image_collection`) are links
 * that never serve a file, so they are not downloadable.
 */
export function isProviderImageUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  if (!IMAGE_HOSTS.some(allowed => host === allowed || host.endsWith(`.${allowed}`))) return false;
  return !/\/(?:image_generation_content|card_content|image_collection|image_retrieval)\//i.test(url.pathname);
}

/** Same-origin URL for a stored image, safe to drop straight into markdown. */
export function playgroundMediaUrl(id: string): string {
  return `/api/thruline${PLAYGROUND_MEDIA_PATH}/${id}`;
}

function pruneExpired(now: number): void {
  getDb().prepare('DELETE FROM playground_media WHERE expires_at_ms <= ?').run(now);
}

// The migration owns this schema. Dev databases that skipped
// `npm run db:migration:up` (initDb does not migrate under NODE_ENV=development)
// would otherwise fail every insert, so create the table on first use too.
// Keyed on the connection, because tests reopen an in-memory database per test.
let tableReadyFor: unknown = null;
function ensureTable(): void {
  const db = getDb();
  if (tableReadyFor === db) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS playground_media (
      id TEXT PRIMARY KEY,
      content_type TEXT NOT NULL,
      bytes BLOB NOT NULL,
      created_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_playground_media_expires ON playground_media(expires_at_ms);
  `);
  tableReadyFor = db;
}

/**
 * Cache image bytes and return their id. Returns null when the database is not
 * open (unit tests that exercise the parser without a DB) or the payload is
 * empty — callers then fall back to the provider's own link.
 */
export function storePlaygroundMedia(bytes: Buffer, contentType: string): string | null {
  if (bytes.length === 0 || bytes.length > PLAYGROUND_MEDIA_MAX_BYTES) return null;
  if (!/^image\//i.test(contentType)) return null;
  const now = Date.now();
  const id = randomBytes(16).toString('hex');
  try {
    ensureTable();
    pruneExpired(now);
    getDb()
      .prepare(`INSERT INTO playground_media (id, content_type, bytes, created_at_ms, expires_at_ms)
        VALUES (?, ?, ?, ?, ?)`)
      .run(id, contentType, bytes, now, now + PLAYGROUND_MEDIA_TTL_MS);
  } catch {
    return null;
  }
  return id;
}

export function readPlaygroundMedia(id: string): { contentType: string; bytes: Buffer } | null {
  if (!ID_PATTERN.test(id)) return null;
  try {
    ensureTable();
    const row = getDb()
      .prepare('SELECT content_type, bytes, expires_at_ms FROM playground_media WHERE id = ?')
      .get(id) as { content_type?: unknown; bytes?: unknown; expires_at_ms?: unknown } | undefined;
    if (!row || typeof row.content_type !== 'string' || !(row.bytes instanceof Uint8Array)) return null;
    if (typeof row.expires_at_ms === 'number' && row.expires_at_ms <= Date.now()) {
      getDb().prepare('DELETE FROM playground_media WHERE id = ?').run(id);
      return null;
    }
    return { contentType: row.content_type, bytes: Buffer.from(row.bytes) };
  } catch {
    return null;
  }
}

/**
 * Download a provider image, preferring the credential that produced it and
 * falling back to an anonymous request (Google publishes some assets). Returns
 * null for a host outside the allowlist, a non-image response, or a failure.
 */
const MAX_MEDIA_REDIRECTS = 3;
const MEDIA_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export async function downloadProviderImage(
  rawUrl: string,
  credential?: string,
  signal?: AbortSignal,
): Promise<{ bytes: Buffer; contentType: string } | null> {
  // Payload URLs sometimes arrive as `http://`; the CDN serves the same asset
  // over TLS, and only https is ever fetched.
  const initialUrl = rawUrl.replace(/^http:\/\//i, 'https://');
  if (!isProviderImageUrl(initialUrl)) return null;
  const initialHost = new URL(initialUrl).hostname.toLowerCase();
  const isMockFetch = typeof (globalThis.fetch as unknown as { mock?: unknown })?.mock === 'object';

  const attempts: Array<Record<string, string>> = credential ? [{ Cookie: credential }, {}] : [{}];
  for (const auth of attempts) {
    try {
      let currentUrl = initialUrl;
      for (let hop = 0; hop <= MAX_MEDIA_REDIRECTS; hop++) {
        if (!isProviderImageUrl(currentUrl)) break;
        const checked = await assertProviderUrlAllowedWithPin(currentUrl, { blockPrivate: true });
        const dispatcher = isMockFetch ? undefined : await checked.createDispatcher();
        const sameOriginHost = new URL(currentUrl).hostname.toLowerCase() === initialHost;
        let res: Response;
        try {
          res = await fetch(currentUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
              Accept: 'image/avif,image/webp,image/png,image/*;q=0.8,*/*;q=0.5',
              Referer: 'https://gemini.google.com/',
              ...(sameOriginHost ? auth : {}),
            },
            signal,
            redirect: 'manual',
            ...(dispatcher ? { dispatcher } : {}),
          } as unknown as RequestInit);
        } finally {
          await dispatcher?.close().catch(() => {});
        }
        if (MEDIA_REDIRECT_STATUSES.has(res.status)) {
          await res.body?.cancel().catch(() => {});
          const location = res.headers.get('location');
          if (!location || hop >= MAX_MEDIA_REDIRECTS) {
            break;
          }
          currentUrl = new URL(location, currentUrl).href;
          continue;
        }
        if (!res.ok) {
          await res.body?.cancel().catch(() => {});
          break;
        }
        const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
        if (!contentType.startsWith('image/')) {
          await res.body?.cancel().catch(() => {});
          break;
        }
        const declared = Number(res.headers.get('content-length') ?? 0);
        if (declared > PLAYGROUND_MEDIA_MAX_BYTES) {
          await res.body?.cancel().catch(() => {});
          return null;
        }
        const bytes = Buffer.from(await res.arrayBuffer());
        if (bytes.length === 0 || bytes.length > PLAYGROUND_MEDIA_MAX_BYTES) return null;
        return { bytes, contentType };
      }
    } catch {
      // Try the next header set; a cancelled/blocked download is not fatal.
    }
  }
  return null;
}

/**
 * Public capability route: an <img> tag cannot send the dashboard session, so
 * the unguessable id in the URL is the authorization. Only image content types
 * are ever stored, and the response never executes as a document.
 */
export const xPlaygroundMediaRouter = Router();

xPlaygroundMediaRouter.get('/:id', (req, res) => {
  const media = readPlaygroundMedia(String(req.params.id));
  if (!media) {
    res.status(404).json({ error: { message: 'Image not found or expired.' } });
    return;
  }
  res.setHeader('Content-Type', media.contentType);
  res.setHeader('Content-Length', String(media.bytes.length));
  res.setHeader('Cache-Control', 'private, max-age=604800, immutable');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.end(media.bytes);
});
