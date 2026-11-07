import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { KNOWLEDGE_LIMITS } from '@freellmapi/shared/knowledge.js';
import {
  addDoc, deleteDoc, docCount, getKnowledgeSettings, knowledgeBlock, listDocs, searchKnowledge, setKnowledgeSettings, updateDoc,
} from '../services/profile-knowledge.js';

// A client key's knowledge base. Mounted in custom/register.ts at /api/client-profiles behind the profile
// permissions: reads (list, search) need view_client_profiles, changes need edit_client_profiles.

export const profileKnowledgeRouter = Router();

const L = KNOWLEDGE_LIMITS;
const docSchema = z.object({
  title: z.string().trim().min(1).max(L.maxTitle),
  content: z.string().trim().min(1).max(L.maxDocChars),
}).strict();
const settingsSchema = z.object({
  enabled: z.boolean().optional(),
  maxChars: z.number().int().min(L.minMaxChars).max(L.maxMaxChars).optional(),
}).strict();

const int = (raw: unknown): number | null => { const n = Number(Array.isArray(raw) ? raw[0] : raw); return Number.isInteger(n) && n > 0 ? n : null; };
function profileId(req: Request, res: Response): number | null {
  const id = int(req.params.id);
  if (id === null) { res.status(400).json({ error: { message: 'Invalid profile id' } }); return null; }
  if (!getKnowledgeSettings(id)) { res.status(404).json({ error: { message: 'Client profile not found' } }); return null; }
  return id;
}
const bad = (res: Response, message: string) => res.status(400).json({ error: { message } });

profileKnowledgeRouter.get('/:id/knowledge', (req, res) => {
  const id = profileId(req, res);
  if (id === null) return;
  res.json({ settings: getKnowledgeSettings(id), docs: listDocs(id), limits: L });
});

profileKnowledgeRouter.put('/:id/knowledge-settings', (req, res) => {
  const id = profileId(req, res);
  if (id === null) return;
  const parsed = settingsSchema.safeParse(req.body ?? {});
  if (!parsed.success) { bad(res, `enabled is true/false; maxChars is a whole number from ${L.minMaxChars} to ${L.maxMaxChars}`); return; }
  const current = getKnowledgeSettings(id)!;
  setKnowledgeSettings(id, { enabled: parsed.data.enabled ?? current.enabled, maxChars: parsed.data.maxChars ?? current.maxChars });
  res.json({ settings: getKnowledgeSettings(id) });
});

profileKnowledgeRouter.post('/:id/knowledge', (req, res) => {
  const id = profileId(req, res);
  if (id === null) return;
  const parsed = docSchema.safeParse(req.body ?? {});
  if (!parsed.success) { bad(res, `A document needs a title (up to ${L.maxTitle} characters) and content (up to ${L.maxDocChars.toLocaleString('en-US')})`); return; }
  if (docCount(id) >= L.maxDocs) { bad(res, `A key can hold at most ${L.maxDocs} documents`); return; }
  const docId = addDoc(id, parsed.data.title, parsed.data.content);
  res.status(201).json({ doc: listDocs(id).find(d => d.id === docId) });
});

profileKnowledgeRouter.put('/:id/knowledge/:docId', (req, res) => {
  const id = profileId(req, res);
  if (id === null) return;
  const docId = int(req.params.docId);
  if (docId === null) { bad(res, 'Invalid document id'); return; }
  const parsed = docSchema.safeParse(req.body ?? {});
  if (!parsed.success) { bad(res, `A document needs a title (up to ${L.maxTitle} characters) and content (up to ${L.maxDocChars.toLocaleString('en-US')})`); return; }
  if (!updateDoc(id, docId, parsed.data.title, parsed.data.content)) { res.status(404).json({ error: { message: 'Document not found' } }); return; }
  res.json({ doc: listDocs(id).find(d => d.id === docId) });
});

profileKnowledgeRouter.delete('/:id/knowledge/:docId', (req, res) => {
  const id = profileId(req, res);
  if (id === null) return;
  const docId = int(req.params.docId);
  if (docId === null) { bad(res, 'Invalid document id'); return; }
  if (!deleteDoc(id, docId)) { res.status(404).json({ error: { message: 'Document not found' } }); return; }
  res.json({ success: true });
});

// GET /api/client-profiles/:id/knowledge/search?q= - what a question would get, for checking the setup
profileKnowledgeRouter.get('/:id/knowledge/search', (req: Request, res: Response) => {
  const id = profileId(req, res);
  if (id === null) return;
  const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 2_000) : '';
  const hits = searchKnowledge(id, q, getKnowledgeSettings(id)!.maxChars);
  res.json({ hits, block: knowledgeBlock(hits) });
});
