import express, { type NextFunction, type Request, type Response } from 'express';

export const SUPPORT_OUTPUT_BODY_MAX_BYTES = 256 * 1024;
const parser = express.json({ limit: SUPPORT_OUTPUT_BODY_MAX_BYTES });
const outputWritePath = /^\/api\/thruline\/support\/tenants\/[^/]+\/output-policy(?:\/preview)?\/?$/i;

/** Apply before the application's general JSON parser, including chunked/inflated bodies. */
export function supportOutputBodyLimit(req: Request, res: Response, next: NextFunction): void {
  if ((req.method !== 'PUT' && req.method !== 'POST') || !outputWritePath.test(req.path)) {
    next();
    return;
  }
  parseSupportOutputJson(req, res, next);
}

/** Also supports standalone mounting of the console router in tests/embedders. */
export function parseSupportOutputJson(req: Request, res: Response, next: NextFunction): void {
  const length = Number(req.headers['content-length']);
  if (Number.isFinite(length) && length > SUPPORT_OUTPUT_BODY_MAX_BYTES) {
    res.setHeader('Connection', 'close');
    res.status(413).json({ error: { code: 'payload_too_large', message: 'Request body exceeds the 256 KiB limit.' } });
    return;
  }
  if (req.body !== undefined) { next(); return; }
  parser(req, res, (err: unknown) => {
    if (!err) { next(); return; }
    const tooLarge = (err as { type?: string }).type === 'entity.too.large';
    res.status(tooLarge ? 413 : 400).json({ error: {
      code: tooLarge ? 'payload_too_large' : 'invalid_input',
      message: tooLarge ? 'Request body exceeds the 256 KiB limit.' : 'Invalid JSON request body.',
    } });
  });
}
