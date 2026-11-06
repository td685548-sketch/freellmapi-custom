import type { NextFunction, Request, Response } from 'express';
import { setRequestAllowedModels, setRequestProfile } from '../lib/client-context.js';
import { capOutputTokens, checkModel, refuse } from '../custom/profile-restrictions.js';
import { enforceUsageQuota } from '../custom/quota-gate.js';
import { CLIENT_PROFILE_KEY_PREFIX } from '../lib/system-prompt.js';
import { profileForGate } from '../services/profile-usage.js';
import { checkUserRateLimit } from '../services/user-quotas.js';
import { extractInferenceToken } from './user-rate-limit.js';

/**
 * Attributes /v1 and /v1beta traffic made with a client-profile key (`sk-cp-…`) to
 * that profile, and enforces the profile's per-minute cap when it has one.
 *
 * The cap reuses the per-account sliding window. Profile ids live in the same
 * number space as user ids there, so a profile is keyed by its NEGATIVE id.
 *
 * Unknown or disabled keys are not answered here: they continue to the normal
 * authentication, which rejects them exactly as before.
 */
export function profileInferenceGate(req: Request, res: Response, next: NextFunction): void {
  const token = extractInferenceToken(req);
  if (!token || !token.startsWith(CLIENT_PROFILE_KEY_PREFIX)) return next();

  const profile = profileForGate(token);
  if (!profile) return next();

  const context = setRequestProfile(profile.id);

  // Restrictions first: a refused request costs the key neither a rate-limit slot nor an allowance.
  if (profile.allowedModels.length > 0) {
    const allowed = new Set(profile.allowedModels);
    const refusal = checkModel(req, allowed);
    if (refusal) { refuse(res, refusal, allowed); return; }
    setRequestAllowedModels(allowed);
  }
  if (profile.maxTokens !== null) capOutputTokens(req, profile.maxTokens);

  const quota = () => enforceUsageQuota('profile', profile.id, res, () => context?.userTokens ?? 0);
  if (profile.rpmLimit === null) { if (quota()) next(); return; }

  const limit = checkUserRateLimit(-profile.id, profile.rpmLimit);
  res.setHeader('X-RateLimit-Limit-Profile-RPM', limit.limit.toString());
  res.setHeader('X-RateLimit-Remaining-Profile-RPM', limit.remaining.toString());
  res.setHeader('X-RateLimit-Reset-Profile-RPM', limit.resetSeconds.toString());
  if (!limit.allowed) {
    res.status(429).json({
      error: {
        message: `Rate limit exceeded. This key allows ${limit.limit} requests per minute. Please retry in ${limit.resetSeconds} seconds.`,
        type: 'rate_limit_exceeded',
        code: 'profile_rate_limit_exceeded',
      },
    });
    return;
  }
  if (quota()) next();
}
