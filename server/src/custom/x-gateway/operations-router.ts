import { Router } from 'express';
import { z } from 'zod';
import { getUsableXGatewayKeys } from '../provider-accounts/store.js';
import { getConfigSnapshot } from './config.js';
import { validateXGatewayClientKey } from './client-keys.js';
import { probeTool, TOOL_PROTOCOLS } from './tool-probe.js';
import { gatewayDiagnostics, recordToolProbe, sessionEvidenceId } from './diagnostics.js';

export const xOperationsRouter = Router();
const testToolSchema = z.object({
  toolId: z.string().refine(id => Object.hasOwn(TOOL_PROTOCOLS, id)),
  key: z.string().trim().min(1).max(512).regex(/^[\x21-\x7e]+$/),
  model: z.string().trim().min(1).max(200).refine(value => [...value].every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)),
  keyId: z.number().int().positive().optional(),
}).strict();
const running = new Set<string>();

xOperationsRouter.get('/', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    enabled: getConfigSnapshot().enabled, usableAccounts: getUsableXGatewayKeys().length,
    tools: Object.entries(TOOL_PROTOCOLS).map(([id, protocol]) => ({ id, name: id, protocol })),
  });
});

xOperationsRouter.get('/diagnostics', (req, res) => {
  const token = (req as typeof req & { sessionToken?: string }).sessionToken;
  if (!token) { res.status(401).json({ error: 'Authentication required.' }); return; }
  res.setHeader('Cache-Control', 'no-store');
  res.json(gatewayDiagnostics(sessionEvidenceId(token)));
});

xOperationsRouter.post('/test', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const parsed = testToolSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: 'Select a supported tool, full API key and model.' });
    return;
  }
  const session = req as typeof req & { sessionToken?: string; user?: { userId: number } };
  if (!session.sessionToken) { res.status(401).json({ ok: false, error: 'Authentication required.' }); return; }
  const input = parsed.data;
  if (input.keyId !== undefined) {
    const key = validateXGatewayClientKey(input.key);
    if (!key || key.keyId !== input.keyId || key.userId !== session.user?.userId) {
      res.status(400).json({ ok: false, error: 'The full API key does not match the selected key.' });
      return;
    }
  }
  const sessionId = sessionEvidenceId(session.sessionToken);
  if (running.has(sessionId) || running.size >= 8) {
    res.status(429).json({ ok: false, error: 'An inference test is already running. Retry later.' });
    return;
  }
  const controller = new AbortController();
  const onClose = () => { if (!res.writableEnded) controller.abort(); };
  res.once('close', onClose);
  running.add(sessionId);
  try {
    const result = await probeTool(req.socket.localPort ?? 0, input, controller.signal);
    recordToolProbe(sessionId, result);
    if (!controller.signal.aborted) res.json(result);
  } finally {
    running.delete(sessionId);
    res.off('close', onClose);
  }
});
