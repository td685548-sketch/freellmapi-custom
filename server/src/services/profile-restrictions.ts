import { getDb } from '../db/index.js';
import type { ProfileRestrictions } from '@freellmapi/shared/profile-restrictions.js';
import { MAX_ALLOWED_MODELS } from '@freellmapi/shared/profile-restrictions.js';
import { parseAllowedModels } from './profile-usage.js';

/** Trim, lowercase and de-duplicate a list of model ids, keeping the first occurrence's order. */
export function normalizeModelList(models: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const m of models) {
    const id = m.trim().toLowerCase();
    if (id) seen.add(id);
  }
  return [...seen].slice(0, MAX_ALLOWED_MODELS);
}

export function getProfileRestrictions(profileId: number): ProfileRestrictions | null {
  const row = getDb()
    .prepare('SELECT allowed_models AS allowedModels, max_tokens_cap AS maxTokens FROM client_profiles WHERE id = ?')
    .get(profileId) as { allowedModels: string | null; maxTokens: number | null } | undefined;
  return row ? { allowedModels: parseAllowedModels(row.allowedModels), maxTokens: row.maxTokens } : null;
}

/** Replace a profile's restrictions. False when the profile does not exist. */
export function setProfileRestrictions(profileId: number, restrictions: ProfileRestrictions): boolean {
  const models = normalizeModelList(restrictions.allowedModels);
  return getDb()
    .prepare('UPDATE client_profiles SET allowed_models = ?, max_tokens_cap = ? WHERE id = ?')
    .run(models.length ? JSON.stringify(models) : null, restrictions.maxTokens, profileId).changes > 0;
}
