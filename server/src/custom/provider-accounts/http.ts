import { z } from 'zod';
import { proxyFetch } from '../../lib/proxy.js';

export const COPILOT_BASE_URL = 'https://api.githubcopilot.com';
export const COPILOT_PREFIX = 'x-copilot:';
export const GITHUB_CLIENT_ID = 'Iv1.b507a08c87ecfe98';
export const DEVICE_URL = 'https://github.com/login/device/code';
export const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
export const GITHUB_USER_URL = 'https://api.github.com/user';
export const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';
export const OPENROUTER_KEY_URL = 'https://openrouter.ai/api/v1/auth/keys';
export const USER_AGENT = 'FreeLLMAPI/0.2.1 (provider-accounts)';
const URLS = new Set([DEVICE_URL, GITHUB_TOKEN_URL, GITHUB_USER_URL, COPILOT_TOKEN_URL, OPENROUTER_KEY_URL, `${COPILOT_BASE_URL}/models`]);

export class AccountError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export const secretSchema = z.string().min(1).max(16384).regex(/^\S+$/);

export async function readProviderJson<T>(response: Response, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T> {
  try {
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error();
    }
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) throw new Error();
    return parsed.data;
  } catch {
    throw new AccountError(502, 'Provider returned an invalid or unsuccessful response.');
  }
}

export async function providerJson<T>(url: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, init: RequestInit = {}): Promise<T> {
  if (!URLS.has(url)) throw new AccountError(502, 'Unsupported provider endpoint.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  timer.unref?.();
  try {
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    headers.set('User-Agent', USER_AGENT);
    const response = await proxyFetch(url, {
      ...init, headers, redirect: 'error',
      signal: init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal,
    }, undefined, 'unknown');
    return await readProviderJson(response, schema);
  } catch {
    throw new AccountError(502, 'Provider request failed. Please start a new connection attempt.');
  } finally {
    clearTimeout(timer);
  }
}

export function jsonPost(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export function githubHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' };
}
