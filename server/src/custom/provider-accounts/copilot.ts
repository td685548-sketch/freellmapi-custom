import { createHash } from 'node:crypto';
import { z } from 'zod';
import { OpenAICompatProvider } from '../../providers/openai-compat.js';
import type { ProviderFetchOptions, KeyValidationResult } from '../../providers/base.js';
import type { QuotaObservationContext } from '../../services/provider-quota.js';
import {
  AccountError, COPILOT_BASE_URL, COPILOT_PREFIX, COPILOT_TOKEN_URL,
  USER_AGENT, githubHeaders, providerJson, readProviderJson, secretSchema,
} from './http.js';

const tokenSchema = z.object({ token: secretSchema, expires_at: z.number().int().positive() });
const modelSchema = z.object({
  id: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(200).optional(),
  capabilities: z.object({
    type: z.string(),
    supports: z.object({ tool_calls: z.boolean().optional(), vision: z.boolean().optional() }).optional(),
  }),
  policy: z.object({ state: z.string() }).optional(),
  supported_endpoints: z.array(z.string()).max(30),
});
const catalogSchema = z.object({ data: z.array(z.unknown()).max(1000) });
export interface CopilotModel { id: string; name: string; supportsTools: boolean; supportsVision: boolean }

export function eligibleCopilotModels(body: z.infer<typeof catalogSchema>): CopilotModel[] {
  const models = new Map<string, CopilotModel>();
  for (const raw of body.data) {
    const parsed = modelSchema.safeParse(raw);
    if (!parsed.success) continue;
    const m = parsed.data;
    if (m.capabilities.type !== 'chat' || (m.policy && m.policy.state !== 'enabled')) continue;
    if (!m.supported_endpoints.some(path => path === '/chat/completions' || path === 'chat/completions')) continue;
    models.set(m.id, {
      id: m.id, name: m.name ?? m.id,
      supportsTools: m.capabilities.supports?.tool_calls ?? false,
      supportsVision: m.capabilities.supports?.vision ?? false,
    });
  }
  return [...models.values()];
}

interface TokenEntry { token?: string; expiresAt: number; pending?: Promise<string> }
const tokens = new Map<string, TokenEntry>();
const digest = (credential: string) => createHash('sha256').update(credential).digest('hex');
const MAX_TOKENS = 256;

export function clearCopilotToken(credential: string): void { tokens.delete(digest(credential)); }

export async function resolveCopilotToken(credential: string): Promise<string> {
  if (!credential.startsWith(COPILOT_PREFIX)) return credential;
  const key = digest(credential);
  const now = Date.now();
  for (const [id, entry] of tokens) if (!entry.pending && entry.expiresAt <= now) tokens.delete(id);
  const cached = tokens.get(key);
  if (cached?.pending) return cached.pending;
  if (cached?.token && cached.expiresAt > now) return cached.token;
  if (tokens.size >= MAX_TOKENS) {
    const evict = [...tokens].find(([, entry]) => !entry.pending);
    if (!evict) throw new AccountError(503, 'Provider connection is busy.');
    tokens.delete(evict[0]);
  }
  const entry: TokenEntry = { expiresAt: 0 };
  tokens.set(key, entry);
  entry.pending = (async () => {
    try {
      const githubToken = secretSchema.parse(credential.slice(COPILOT_PREFIX.length));
      const result = await providerJson(COPILOT_TOKEN_URL, tokenSchema, {
        headers: { ...githubHeaders(githubToken), Authorization: `token ${githubToken}` },
      });
      const expiresAt = Math.min(result.expires_at * 1000 - 30_000, Date.now() + 5 * 60_000);
      if (expiresAt <= Date.now()) throw new AccountError(502, 'Provider returned an expired credential.');
      entry.token = result.token;
      entry.expiresAt = expiresAt;
      return result.token;
    } catch {
      if (tokens.get(key) === entry) tokens.delete(key);
      throw new AccountError(502, 'Copilot credential exchange failed.');
    } finally {
      entry.pending = undefined;
    }
  })();
  return entry.pending;
}

export class CopilotProvider extends OpenAICompatProvider {
  constructor() {
    super({ platform: 'custom', name: 'GitHub Copilot', baseUrl: COPILOT_BASE_URL, timeoutMs: 120_000 });
  }

  protected override async fetchWithTimeout(
    url: string, init: RequestInit, timeoutMs?: number, fetchOpts?: ProviderFetchOptions,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    const credential = headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    if (!credential.startsWith(COPILOT_PREFIX)) return super.fetchWithTimeout(url, init, timeoutMs, fetchOpts);
    if (url !== `${COPILOT_BASE_URL}/models` && url !== `${COPILOT_BASE_URL}/chat/completions`) {
      throw new AccountError(502, 'Unsupported Copilot endpoint.');
    }
    const started = Date.now();
    const token = await resolveCopilotToken(credential);
    fetchOpts?.signal?.throwIfAborted();
    const remaining = timeoutMs && timeoutMs > 0 ? timeoutMs - (Date.now() - started) : timeoutMs;
    if (remaining !== undefined && remaining <= 0 && timeoutMs !== 0) throw new AccountError(504, 'Copilot request timed out.');
    headers.set('Authorization', `Bearer ${token}`);
    headers.set('User-Agent', USER_AGENT);
    headers.set('Accept', 'application/json');
    const res = await super.fetchWithTimeout(url, { ...init, headers, redirect: 'error' }, remaining, fetchOpts);
    if (res.status === 401) clearCopilotToken(credential);
    if (!res.ok) {
      await res.body?.cancel();
      const safeHeaders = new Headers(res.headers);
      safeHeaders.delete('content-length');
      safeHeaders.delete('content-encoding');
      safeHeaders.set('content-type', 'application/json');
      return new Response(JSON.stringify({ error: { message: 'Copilot request failed.' } }), { status: res.status, headers: safeHeaders });
    }
    return res;
  }

  async discoverModels(credential: string, quotaContext?: QuotaObservationContext): Promise<CopilotModel[]> {
    const response = await this.fetchModelCatalog(credential, quotaContext);
    const models = eligibleCopilotModels(await readProviderJson(response, catalogSchema));
    if (!models.length) throw new AccountError(502, 'No eligible Copilot chat-completions models are available.');
    return models;
  }

  override async validateKey(credential: string, quotaContext?: QuotaObservationContext): Promise<KeyValidationResult> {
    if (!credential.startsWith(COPILOT_PREFIX)) return super.validateKey(credential, quotaContext);
    await this.discoverModels(credential, quotaContext);
    return true;
  }
}
