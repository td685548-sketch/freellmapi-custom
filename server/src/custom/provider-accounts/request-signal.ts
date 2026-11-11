import type { Request, Response } from 'express';

/** Stop native provider streams when a gateway client disconnects. */
export function requestSignal(req: Request, res: Response): AbortSignal {
  const controller = new AbortController();
  const abort = () => { if (!res.writableEnded) controller.abort(); };
  req.once('aborted', abort);
  res.once('close', abort);
  res.once('finish', () => { req.off('aborted', abort); res.off('close', abort); });
  if (req.aborted || res.destroyed) controller.abort();
  return controller.signal;
}
