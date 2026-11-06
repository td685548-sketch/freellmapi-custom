import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import type { ChatMessage } from '@freellmapi/shared/types.js';
import { createApp } from '../../app.js';
import { getDb, getUnifiedApiKey, initDb, setSetting } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';
import {
  getOutputSaverLevels,
  invalidateOutputSaverSnapshot,
  parseSaverDirective,
  readOutputSaverSettings,
  resolveSaverLevels,
  setOutputSaverLevels,
  SAVERS_SETTING,
} from '../../custom/output-savers/config.js';
import { applyOutputSavers } from '../../custom/output-savers/apply.js';
import {
  buildSaverBlock,
  CAVEMAN_PROMPTS,
  PONYTAIL_PROMPTS,
} from '../../custom/output-savers/prompts.js';
import { prependSystemPrompt } from '../../lib/system-prompt.js';

const CAVEMAN_FULL = CAVEMAN_PROMPTS.full;
const PONYTAIL_LITE = PONYTAIL_PROMPTS.lite;

function userMessages(): ChatMessage[] {
  return [{ role: 'user', content: 'hello' }];
}

function clearSaverConfig(): void {
  getDb().prepare('DELETE FROM settings WHERE key = ?').run(SAVERS_SETTING);
  delete process.env.FREELLMAPI_CAVEMAN;
  delete process.env.FREELLMAPI_PONYTAIL;
  // These cases write the setting directly, bypassing the service that
  // invalidates its own snapshot.
  invalidateOutputSaverSnapshot();
}

/** Every string anywhere in a forwarded provider body. Comparing against the
 *  whole JSON would miss the saver text, because the prompts contain quotes
 *  that stringification escapes. */
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) collectStrings(child, out);
  }
  return out;
}

function bodyCarriesText(payload: unknown, text: string): boolean {
  return collectStrings(payload).some(value => value.includes(text));
}

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  adminToken = mintDashboardToken();
});

describe('output saver configuration', () => {
  beforeEach(clearSaverConfig);

  it('leaves every saver off when nothing is configured', () => {
    expect(getOutputSaverLevels()).toEqual({ caveman: 'off', ponytail: 'off' });
    expect(readOutputSaverSettings().sources).toEqual({ caveman: 'default', ponytail: 'default' });
  });

  it('takes the stored setting over the environment', () => {
    process.env.FREELLMAPI_CAVEMAN = 'ultra';
    setSetting(SAVERS_SETTING, JSON.stringify({ caveman: 'lite', ponytail: 'full' }));
    expect(getOutputSaverLevels()).toEqual({ caveman: 'lite', ponytail: 'full' });
    expect(readOutputSaverSettings().sources).toEqual({ caveman: 'setting', ponytail: 'setting' });
  });

  it('uses the environment only for a saver with no stored value', () => {
    setSetting(SAVERS_SETTING, JSON.stringify({ ponytail: 'full' }));
    process.env.FREELLMAPI_CAVEMAN = 'lite';
    expect(getOutputSaverLevels()).toEqual({ caveman: 'lite', ponytail: 'full' });
    expect(readOutputSaverSettings().sources).toEqual({ caveman: 'env', ponytail: 'setting' });
  });

  it('ignores an out-of-range environment value and an unreadable setting', () => {
    process.env.FREELLMAPI_CAVEMAN = 'everything';
    expect(getOutputSaverLevels().caveman).toBe('off');
    setSetting(SAVERS_SETTING, 'not json');
    expect(getOutputSaverLevels()).toEqual({ caveman: 'off', ponytail: 'off' });
    setSetting(SAVERS_SETTING, JSON.stringify({ caveman: 'sideways' }));
    expect(getOutputSaverLevels()).toEqual({ caveman: 'off', ponytail: 'off' });
  });

  it('persists a partial update without clobbering the other saver', () => {
    setOutputSaverLevels({ caveman: 'full' });
    setOutputSaverLevels({ ponytail: 'lite' });
    expect(getOutputSaverLevels()).toEqual({ caveman: 'full', ponytail: 'lite' });
  });
});

describe('per-request saver directive', () => {
  it('parses the shapes the header can carry', () => {
    expect(parseSaverDirective(undefined)).toEqual({ kind: 'default' });
    expect(parseSaverDirective('')).toEqual({ kind: 'default' });
    expect(parseSaverDirective('default')).toEqual({ kind: 'default' });
    expect(parseSaverDirective('nonsense')).toEqual({ kind: 'default' });
    expect(parseSaverDirective('off')).toEqual({ kind: 'off' });
    expect(parseSaverDirective(['bypass'])).toEqual({ kind: 'off' });
    expect(parseSaverDirective('FALSE')).toEqual({ kind: 'off' });
    expect(parseSaverDirective('caveman=lite')).toEqual({ kind: 'levels', levels: { caveman: 'lite' } });
    expect(parseSaverDirective('CAVEMAN=Off, Ponytail = full')).toEqual({
      kind: 'levels',
      levels: { caveman: 'off', ponytail: 'full' },
    });
    expect(parseSaverDirective('ultra')).toEqual({
      kind: 'levels',
      levels: { caveman: 'ultra', ponytail: 'ultra' },
    });
    expect(parseSaverDirective('caveman=sideways')).toEqual({ kind: 'default' });
  });

  it('can lower or disable a saver but never raise or enable one', () => {
    const operator = { caveman: 'full', ponytail: 'off' };
    expect(resolveSaverLevels(operator, parseSaverDirective('ultra'))).toEqual(operator);
    expect(resolveSaverLevels(operator, parseSaverDirective('caveman=ultra'))).toEqual(operator);
    expect(resolveSaverLevels(operator, parseSaverDirective('lite'))).toEqual({
      caveman: 'lite',
      ponytail: 'off',
    });
    expect(resolveSaverLevels(operator, parseSaverDirective('ponytail=full'))).toEqual(operator);
    expect(resolveSaverLevels(operator, parseSaverDirective('off'))).toEqual({
      caveman: 'off',
      ponytail: 'off',
    });
    // The operator's off switch is not something a header can negotiate past.
    const everythingOff = { caveman: 'off', ponytail: 'off' };
    for (const header of ['on', 'ultra', 'caveman=ultra', 'default', 'garbage']) {
      expect(resolveSaverLevels(everythingOff, parseSaverDirective(header))).toEqual(everythingOff);
    }
  });
});

describe('saver block injection', () => {
  beforeEach(clearSaverConfig);

  it('returns the same array when nothing is active', () => {
    const messages = userMessages();
    expect(applyOutputSavers(messages, undefined)).toBe(messages);
  });

  it('prepends one system message with the enabled text', () => {
    setSetting(SAVERS_SETTING, JSON.stringify({ caveman: 'full' }));
    const out = applyOutputSavers(userMessages(), undefined);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ role: 'system', content: CAVEMAN_FULL });
    expect(out[1].role).toBe('user');
  });

  it('stacks caveman before ponytail in one message, in a fixed order', () => {
    setSetting(SAVERS_SETTING, JSON.stringify({ caveman: 'full', ponytail: 'lite' }));
    const out = applyOutputSavers(userMessages(), undefined);
    expect(out).toHaveLength(2);
    const content = out[0].content as string;
    expect(content).toBe(buildSaverBlock({ caveman: 'full', ponytail: 'lite' }));
    expect(content.indexOf(CAVEMAN_FULL)).toBe(0);
    expect(content.indexOf(PONYTAIL_LITE)).toBeGreaterThan(content.indexOf(CAVEMAN_FULL));
  });

  it('leaves the caller messages untouched', () => {
    setSetting(SAVERS_SETTING, JSON.stringify({ caveman: 'full' }));
    const callerSystem: ChatMessage = { role: 'system', content: 'be helpful' };
    const messages: ChatMessage[] = [callerSystem, { role: 'user', content: 'hi' }];
    const out = applyOutputSavers(messages, undefined);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toBe(callerSystem);
    expect(callerSystem.content).toBe('be helpful');
    expect(out).toHaveLength(3);
    expect(out[1]).toBe(callerSystem);
  });

  it('is idempotent across a retry of the same body', () => {
    setSetting(SAVERS_SETTING, JSON.stringify({ ponytail: 'lite' }));
    const once = applyOutputSavers(userMessages(), undefined);
    expect(applyOutputSavers(once, undefined)).toBe(once);
  });

  it("keeps a profile's enforced prompt ahead of the saver block", () => {
    setSetting(SAVERS_SETTING, JSON.stringify({ caveman: 'full' }));
    const ordered = prependSystemPrompt(applyOutputSavers(userMessages(), undefined), 'ENFORCED');
    expect(ordered[0]).toEqual({ role: 'system', content: 'ENFORCED' });
    expect(ordered[1].content as string).toBe(CAVEMAN_FULL);
  });

  it('fails open on anything that is not a usable message list', () => {
    setSetting(SAVERS_SETTING, JSON.stringify({ caveman: 'full' }));
    const notMessages = [] as unknown as ChatMessage[];
    expect(applyOutputSavers(undefined as unknown as ChatMessage[], undefined)).toBe(undefined);
    expect(applyOutputSavers(null as unknown as ChatMessage[], undefined)).toBe(null);
    expect(applyOutputSavers(notMessages, undefined)).toBe(notMessages);
    const throwing: ChatMessage[] = [{
      role: 'system',
      get content(): string { throw new Error('unreadable body'); },
    } as unknown as ChatMessage];
    expect(applyOutputSavers(throwing, undefined)).toBe(throwing);
  });
});

let app: Express;
let server: ReturnType<Express['listen']>;
let base = '';
let adminToken = '';
let memberToken = '';

async function startServer(): Promise<void> {
  server = await new Promise<ReturnType<Express['listen']>>((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    listener.once('error', reject);
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function stopServer(): Promise<void> {
  await new Promise<void>(resolve => server.close(() => resolve()));
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await res.text();
  return { status: res.status, body: raw ? JSON.parse(raw) : null };
}

const auth = (token: string = adminToken) => ({ Authorization: `Bearer ${token}` });

describe('GET and PUT /api/savers', () => {
  beforeAll(async () => {
    app = createApp();
    await startServer();
  });

  afterAll(stopServer);

  beforeEach(clearSaverConfig);

  it('reports and changes the effective levels', async () => {
    const before = await call('GET', '/api/savers', undefined, auth());
    expect(before.status).toBe(200);
    expect(before.body).toEqual({
      caveman: 'off',
      ponytail: 'off',
      sources: { caveman: 'default', ponytail: 'default' },
      injectedChars: 0,
    });

    const after = await call('PUT', '/api/savers', { caveman: 'full', ponytail: 'lite' }, auth());
    expect(after.status).toBe(200);
    expect(after.body.caveman).toBe('full');
    expect(after.body.sources).toEqual({ caveman: 'setting', ponytail: 'setting' });
    expect(after.body.injectedChars).toBe(buildSaverBlock({ caveman: 'full', ponytail: 'lite' }).length);
    expect(getOutputSaverLevels()).toEqual({ caveman: 'full', ponytail: 'lite' });
  });

  it('rejects an empty body, a bad level and an unknown key', async () => {
    expect((await call('PUT', '/api/savers', {}, auth())).status).toBe(400);
    expect((await call('PUT', '/api/savers', { caveman: 'sideways' }, auth())).status).toBe(400);
    expect((await call('PUT', '/api/savers', { mode: 'full' }, auth())).status).toBe(400);
    expect(getOutputSaverLevels()).toEqual({ caveman: 'off', ponytail: 'off' });
  });

  it('needs manage_compression to write and stays readable for any session', async () => {
    memberToken = mintDashboardToken('saver-member@example.com');
    getDb().prepare("UPDATE users SET role = 'member' WHERE email = ?").run('saver-member@example.com');
    expect((await call('GET', '/api/savers', undefined, auth(memberToken))).status).toBe(200);
    const denied = await call('PUT', '/api/savers', { caveman: 'full' }, auth(memberToken));
    expect(denied.status).toBe(403);
    expect(denied.body.error.message).toContain('manage_compression');
    expect(getOutputSaverLevels()).toEqual({ caveman: 'off', ponytail: 'off' });
  });

  it('refuses an anonymous write', async () => {
    expect((await call('PUT', '/api/savers', { caveman: 'full' })).status).toBe(401);
  });
});

describe('savers on the chat surfaces', () => {
  const forwarded: Record<string, unknown>[] = [];

  beforeAll(async () => {
    app = createApp();
    await startServer();
  });

  afterAll(stopServer);

  beforeEach(async () => {
    clearSaverConfig();
    forwarded.length = 0;
    getDb().prepare('DELETE FROM api_keys').run();
    const added = await call('POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_savers_test',
      label: 'savers',
    }, auth());
    expect(added.status).toBe(201);
    const originalFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).includes('api.groq.com/openai/v1/chat/completions')) {
        forwarded.push(JSON.parse(String((init as RequestInit).body)));
        return {
          ok: true,
          json: async () => ({
            id: 'savers-test',
            object: 'chat.completion',
            created: 1,
            model: 'openai/gpt-oss-120b',
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
          }),
        } as Response;
      }
      return originalFetch(url, init);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function chat(headers: Record<string, string> = {}) {
    return call('POST', '/v1/chat/completions', {
      model: 'auto',
      messages: [{ role: 'user', content: 'hello' }],
    }, { ...auth(getUnifiedApiKey()), ...headers });
  }

  it('forwards the saver block on every chat wire when the operator enabled it', async () => {
    setSetting(SAVERS_SETTING, JSON.stringify({ caveman: 'full' }));

    expect((await chat()).status).toBe(200);
    expect(bodyCarriesText(forwarded[0], CAVEMAN_FULL)).toBe(true);
    const openAiMessages = forwarded[0].messages as { role: string; content: string }[];
    expect(openAiMessages[0]).toEqual({ role: 'system', content: CAVEMAN_FULL });

    const anthropic = await call('POST', '/v1/messages', {
      model: 'auto',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'hello' }],
    }, {
      'x-api-key': getUnifiedApiKey(),
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    });
    expect(anthropic.status).toBe(200);
    expect(bodyCarriesText(forwarded[1], CAVEMAN_FULL)).toBe(true);

    const responses = await call('POST', '/v1/responses', {
      model: 'auto',
      input: 'hello',
      max_output_tokens: 32,
    }, { ...auth(getUnifiedApiKey()), 'Content-Type': 'application/json' });
    expect(responses.status).toBe(200);
    expect(bodyCarriesText(forwarded[2], CAVEMAN_FULL)).toBe(true);

    const gemini = await call('POST', '/v1beta/models/openai/gpt-oss-120b:generateContent', {
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    }, { ...auth(getUnifiedApiKey()), 'Content-Type': 'application/json' });
    expect(gemini.status).toBe(200);
    expect(bodyCarriesText(forwarded[3], CAVEMAN_FULL)).toBe(true);
  });

  it('adds nothing when the operator kept every saver off', async () => {
    expect((await chat()).status).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(bodyCarriesText(forwarded[0], CAVEMAN_FULL)).toBe(false);
    expect((forwarded[0].messages as unknown[]).length).toBe(1);
  });

  it('honours the per-request bypass and lowering header', async () => {
    setSetting(SAVERS_SETTING, JSON.stringify({ caveman: 'full', ponytail: 'lite' }));

    expect((await chat({ 'x-freellm-saver': 'off' })).status).toBe(200);
    expect(bodyCarriesText(forwarded[0], CAVEMAN_FULL)).toBe(false);
    expect(bodyCarriesText(forwarded[0], PONYTAIL_LITE)).toBe(false);

    expect((await chat({ 'x-freellm-saver': 'caveman=off' })).status).toBe(200);
    const lowered = forwarded[1].messages as { role: string; content: string }[];
    expect(lowered[0]).toEqual({ role: 'system', content: PONYTAIL_LITE });

    // A client cannot raise a saver above what the operator switched on.
    expect((await chat({ 'x-freellm-saver': 'caveman=ultra' })).status).toBe(200);
    const raised = forwarded[2].messages as { role: string; content: string }[];
    expect(raised[0].content).toContain(CAVEMAN_FULL);
    expect(raised[0].content).not.toContain(CAVEMAN_PROMPTS.ultra);
  });
});
