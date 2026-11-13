import { Router } from 'express';
import { z } from 'zod';
import type { PlaygroundCatalog } from '@freellmapi/shared/x-playground.js';
import { accountModels, getUsableXGatewayKeys } from '../provider-accounts/store.js';
import { getXGatewayProvider } from '../provider-accounts/catalog.js';
import { getConfigSnapshot } from './config.js';
import { handleXGatewayChat } from './router.js';

export const xPlaygroundRouter = Router();
const image = z.object({ type: z.literal('image_url'), image_url: z.object({
  url: z.string().max(6_000_000).regex(/^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/i)
    .refine(url => {
      const comma = url.indexOf(',');
      return comma !== -1 && Buffer.byteLength(url.slice(comma + 1), 'base64') <= 4_194_304;
    }),
}).strict() }).strict();
const content = z.union([z.string().max(100_000), z.array(z.union([
  z.object({ type: z.literal('text'), text: z.string().max(100_000) }).strict(), image,
])).min(1).max(12).refine(parts => parts.filter(p => p.type === 'image_url').length <= 4)]);
const schema = z.object({
  model: z.string().trim().min(1).max(200),
  messages: z.array(z.object({ role: z.enum(['system', 'user', 'assistant']), content }).strict()).min(1).max(100),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().min(1).max(32_768).optional(),
}).strict();

// Mounted behind the console's session and use_x_gateway gate. The catalog
// contains no account/credential metadata and does not require view_keys.
xPlaygroundRouter.get('/playground/models', (_req, res) => {
  const snapshot = getConfigSnapshot();
  const models: PlaygroundCatalog['models'] = [{ id: 'auto', name: 'Auto', provider: 'Thruline' }];
  const seen = new Set(['auto']);
  for (const combo of snapshot.combos) models.push({ id: `combo:${combo.name}`, name: combo.name, provider: 'Combos' });
  for (const account of getUsableXGatewayKeys()) {
    if ((account.monthly_request_cap > 0 && account.requests >= account.monthly_request_cap)
      || (account.monthly_token_cap > 0 && account.tokens >= account.monthly_token_cap)) continue;
    const provider = getXGatewayProvider(account.provider);
    const alias = provider?.alias ?? account.provider;
    const providerName = provider?.name ?? account.provider;
    const accountModelList = accountModels(account);
    if (accountModelList.length > 0) {
      const autoId = `${alias}/auto`;
      if (!seen.has(autoId)) {
        seen.add(autoId);
        models.push({ id: autoId, name: 'Auto', provider: providerName });
      }
    }
    for (const model of accountModelList) {
      const id = `${alias}/${model.id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      models.push({ id, name: model.name, provider: providerName });
    }
  }
  res.json({ enabled: snapshot.enabled, models } satisfies PlaygroundCatalog);
});

xPlaygroundRouter.post('/playground/chat', async (req, res) => {
  if (!getConfigSnapshot().enabled) {
    res.status(404).json({ error: { type: 'gateway_disabled', message: 'Enable Thruline before chatting.' } });
    return;
  }
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { type: 'invalid_request_error', message: 'Invalid chat messages, images or settings.' } });
    return;
  }
  req.body = { ...parsed.data, stream: true, stream_options: { include_usage: true } };
  await handleXGatewayChat(req, res);
});
