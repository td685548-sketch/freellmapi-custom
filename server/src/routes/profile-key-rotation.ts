import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { decrypt, encrypt, maskKey } from '../lib/crypto.js';
import { hashClientProfileKey, mintClientProfileKey } from '../lib/system-prompt.js';
import { MAX_GRACE_HOURS, keepPreviousKey, listPreviousKeys, revokePreviousKeys } from '../services/profile-previous-keys.js';

// Key rotation without downtime for client profiles. Mounted in custom/register.ts at
// /api/client-profiles behind the profile permissions (view_client_profiles to list,
// edit_client_profiles to rotate or end a grace period). Upstream's immediate
// POST /:id/rotate is untouched and still kills the key it replaces at once.

export const profileKeyRotationRouter = Router();

const rotateSchema = z.object({ graceHours: z.number().int().min(1).max(MAX_GRACE_HOURS) }).strict();

interface Row { id: number; name: string; token_hash: string; encrypted_key: string; iv: string; auth_tag: string }

function parseId(req: Request, res: Response): number | null {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: { message: 'Invalid profile id' } }); return null; }
  return id;
}

function profile(id: number): Row | undefined {
  return getDb().prepare('SELECT id, name, token_hash, encrypted_key, iv, auth_tag FROM client_profiles WHERE id = ?').get(id) as Row | undefined;
}

// POST /api/client-profiles/:id/rotate-with-grace  { graceHours: 1..168 }
profileKeyRotationRouter.post('/:id/rotate-with-grace', (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  const parsed = rotateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { message: `graceHours must be a whole number of hours from 1 to ${MAX_GRACE_HOURS}` } });
    return;
  }
  const row = profile(id);
  if (!row) { res.status(404).json({ error: { message: 'Client profile not found' } }); return; }

  let hint = 'previous key';
  try { hint = maskKey(decrypt(row.encrypted_key, row.iv, row.auth_tag)); } catch { /* the hint is cosmetic */ }

  const key = mintClientProfileKey();
  const { encrypted, iv, authTag } = encrypt(key);
  const db = getDb();
  let expiresAt!: Date;
  // The old key is parked first, so there is no moment in which neither key works.
  db.transaction(() => {
    expiresAt = keepPreviousKey(id, row.token_hash, hint, parsed.data.graceHours);
    db.prepare(`
      UPDATE client_profiles SET token_hash = ?, encrypted_key = ?, iv = ?, auth_tag = ?, updated_at = datetime('now') WHERE id = ?
    `).run(hashClientProfileKey(key), encrypted, iv, authTag, id);
  })();

  // The only time this key leaves the server.
  res.json({ id, name: row.name, key, maskedKey: maskKey(key), previousKeyExpiresAt: expiresAt.toISOString() });
});

// GET /api/client-profiles/:id/previous-keys
profileKeyRotationRouter.get('/:id/previous-keys', (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  if (!profile(id)) { res.status(404).json({ error: { message: 'Client profile not found' } }); return; }
  res.json({ previousKeys: listPreviousKeys(id) });
});

// DELETE /api/client-profiles/:id/previous-keys - end every grace period now
profileKeyRotationRouter.delete('/:id/previous-keys', (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  if (!profile(id)) { res.status(404).json({ error: { message: 'Client profile not found' } }); return; }
  res.json({ revoked: revokePreviousKeys(id) });
});
