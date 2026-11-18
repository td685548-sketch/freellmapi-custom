import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router, type NextFunction, type Request, type Response } from 'express';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../..');

const MAX_RAW_ICON_BYTES = 32 * 1024;
const SAFE_ICON_FILE_RE = /^[a-z0-9][a-z0-9._-]*\.(?:png|svg)$/i;

interface CachedIconBundle {
  etag: string;
  json: string;
}

let bundlePromise: Promise<CachedIconBundle> | null = null;

function resolveProvidersDir(): string | null {
  const candidates = [
    process.env.CLIENT_DIST ? path.resolve(process.env.CLIENT_DIST, 'providers') : '',
    path.resolve(REPO_ROOT, 'client/dist/providers'),
    path.resolve(REPO_ROOT, 'client/public/providers'),
  ].filter(Boolean);

  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

async function encodeIconFile(filePath: string, ext: string): Promise<string> {
  const raw = await fs.promises.readFile(filePath);
  if (ext === '.svg') {
    return `data:image/svg+xml;base64,${raw.toString('base64')}`;
  }
  if (raw.byteLength > MAX_RAW_ICON_BYTES) {
    try {
      const resized = await sharp(raw)
        .resize(64, 64, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png({ compressionLevel: 9 })
        .toBuffer();
      return `data:image/png;base64,${resized.toString('base64')}`;
    } catch {
      // Fall back to original PNG bytes if sharp cannot decode an unusual file.
    }
  }
  return `data:image/png;base64,${raw.toString('base64')}`;
}

async function buildIconBundle(): Promise<CachedIconBundle> {
  const dir = resolveProvidersDir();
  const icons: Record<string, string> = {};

  if (dir) {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && SAFE_ICON_FILE_RE.test(entry.name))
      .map((entry) => entry.name)
      .sort();

    await Promise.all(
      files.map(async (name) => {
        const ext = path.extname(name).toLowerCase();
        try {
          icons[name.toLowerCase()] = await encodeIconFile(path.join(dir, name), ext);
        } catch {
          // Skip unreadable icon files rather than failing the whole bundle.
        }
      }),
    );
  }

  const json = JSON.stringify({ icons });
  const hash = crypto.createHash('sha256').update(json).digest('hex').slice(0, 16);
  return { etag: `"provider-icons-${hash}"`, json };
}

function getIconBundle(): Promise<CachedIconBundle> {
  if (!bundlePromise) {
    bundlePromise = buildIconBundle().catch((err) => {
      bundlePromise = null;
      throw err;
    });
  }
  return bundlePromise;
}

export const providerIconsRouter = Router();

providerIconsRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const bundle = await getIconBundle();
    res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
    res.setHeader('ETag', bundle.etag);
    if (req.headers['if-none-match'] === bundle.etag) {
      res.status(304).end();
      return;
    }
    res.type('application/json').send(bundle.json);
  } catch (err) {
    next(err);
  }
});

/**
 * Serves `/providers/:file` with a 24h browser cache and returns an immediate 404
 * when a provider logo does not exist (preventing SPA index.html fallthroughs
 * that waste shared-domain per-IP request budgets on PaaS hosts like SnapDeploy).
 */
export function providerStaticIconsMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    next();
    return;
  }
  const rel = req.path.replace(/^\/+/, '');
  if (!rel || rel.includes('/') || !/\.(?:png|svg|webp|jpe?g|ico)$/i.test(rel)) {
    next();
    return;
  }
  if (!SAFE_ICON_FILE_RE.test(rel)) {
    res.status(404).end();
    return;
  }
  const dir = resolveProvidersDir();
  if (!dir) {
    res.status(404).end();
    return;
  }
  const fullPath = path.join(dir, rel);
  if (!fs.existsSync(fullPath)) {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.status(404).end();
    return;
  }
  res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
  res.sendFile(fullPath);
}
