import type { Request, Response, NextFunction } from 'express';
import { validateUserApiKey, withUserKeyMemo } from '../services/user-keys.js';
import { checkUserRateLimit, recordUserUsage } from '../services/user-quotas.js';

/**
 * Every credential spelling the inference routes accept: OpenAI Bearer, Anthropic
 * x-api-key, Gemini x-goog-api-key, and (Gemini only) ?key=. This mirrors
 * routes/proxy.ts extractApiToken on purpose: a gate that reads fewer headers
 * than the auth layer lets a personal key skip its limit by changing header.
 */
function extractUserKey(req: Request): string | undefined {
  const first = (v: string | string[] | undefined): string | undefined => {
    const x = (Array.isArray(v) ? v[0] : v)?.trim();
    return x || undefined;
  };
  let token = req.headers.authorization?.replace(/^Bearer\s+/i, '').trim()
    || first(req.headers['x-api-key'])
    || first(req.headers['x-goog-api-key']);
  if (!token && req.originalUrl.startsWith('/v1beta') && typeof req.query.key === 'string') {
    token = req.query.key.trim() || undefined;
  }
  return token && token.startsWith('sk-flm-') ? token : undefined;
}

/**
 * Intercepts /v1 and /v1beta inference calls using user API keys (`sk-flm-...`).
 * Enforces per-user sliding window RPM limit and records monthly usage.
 * Non-user keys (Unified key, client profiles) pass through seamlessly to upstream.
 */
export function userInferenceGate(req: Request, res: Response, next: NextFunction): void {
  const token = extractUserKey(req);
  if (!token) {
    return next();
  }

  withUserKeyMemo(() => gate(token, req, res, next));
}

function gate(token: string, req: Request, res: Response, next: NextFunction): void {
  const userKey = validateUserApiKey(token);
  if (!userKey) {
    // If a user key was provided but is revoked or invalid, reject with 401
    res.status(401).json({
      error: {
        message: 'Incorrect or revoked API key provided.',
        type: 'invalid_request_error',
        code: 'invalid_api_key',
      },
    });
    return;
  }

  // Check RPM limit
  const limit = checkUserRateLimit(userKey.userId, userKey.rpmLimit);
  res.setHeader('X-RateLimit-Limit-User-RPM', limit.limit.toString());
  res.setHeader('X-RateLimit-Remaining-User-RPM', limit.remaining.toString());
  res.setHeader('X-RateLimit-Reset-User-RPM', limit.resetSeconds.toString());

  if (!limit.allowed) {
    res.status(429).json({
      error: {
        message: `Rate limit exceeded. Your plan limit is ${limit.limit} requests per minute. Please retry in ${limit.resetSeconds} seconds.`,
        type: 'rate_limit_exceeded',
        code: 'user_rate_limit_exceeded',
      },
    });
    return;
  }

  // Record usage when response completes
  res.on('finish', () => {
    if (res.statusCode < 400) {
      recordUserUsage(userKey.userId, 0);
    }
  });

  next();
}
