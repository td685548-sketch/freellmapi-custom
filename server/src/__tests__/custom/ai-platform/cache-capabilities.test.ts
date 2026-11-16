import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb, initDb } from '../../../db/index.js';
import type { SessionUser } from '../../../services/auth.js';
import {
  deleteCacheCapabilityOverride,
  getPromptCacheSettings,
  listCacheCapabilities,
  resolveCacheCapability,
  setPromptCacheSettings,
  upsertCacheCapabilityOverride,
} from '../../../custom/ai-platform/prompt-cache/capabilities.js';
import { promptCacheAdminRouter } from '../../../custom/ai-platform/prompt-cache/router.js';

describe('prompt-cache/capabilities', () => {
  beforeEach(() => {
    initDb(':memory:');
  });

  afterEach(() => {
    try {
      getDb().close();
    } catch {
      /* already closed */
    }
  });

  it('returns default prompt cache settings and updates partial patches', () => {
    expect(getPromptCacheSettings()).toEqual({
      forward: true,
      autoBreakpoints: false,
      preferStickyRoute: false,
    });

    const updated = setPromptCacheSettings({ autoBreakpoints: true });
    expect(updated).toEqual({
      forward: true,
      autoBreakpoints: true,
      preferStickyRoute: false,
    });
    expect(getPromptCacheSettings()).toEqual(updated);

    const updated2 = setPromptCacheSettings({ forward: false, preferStickyRoute: true });
    expect(updated2).toEqual({
      forward: false,
      autoBreakpoints: true,
      preferStickyRoute: true,
    });
  });

  it('resolves builtin capabilities with wildcard matching, longest pattern, and none fallback', () => {
    const haiku = resolveCacheCapability('Anthropic', 'claude-3-5-haiku-20241022');
    expect(haiku).toMatchObject({
      platform: 'anthropic',
      modelPattern: 'claude-3-5-haiku*',
      mode: 'explicit',
      maxBreakpoints: 4,
      minTokens: 2048,
      ttlSeconds: 300,
      source: 'builtin',
    });

    const sonnet = resolveCacheCapability('anthropic', 'CLAUDE-SONNET-4-6');
    expect(sonnet).toMatchObject({
      platform: 'anthropic',
      modelPattern: 'claude-*',
      mode: 'explicit',
      maxBreakpoints: 4,
      minTokens: 1024,
      ttlSeconds: 300,
      source: 'builtin',
    });

    const deepseek = resolveCacheCapability('deepseek', 'deepseek-chat');
    expect(deepseek).toMatchObject({
      platform: 'deepseek',
      modelPattern: 'deepseek-*',
      mode: 'implicit',
      maxBreakpoints: 0,
      minTokens: 64,
      ttlSeconds: 3600,
      source: 'builtin',
    });

    const groq = resolveCacheCapability('groq', 'llama-3.3-70b-versatile');
    expect(groq).toMatchObject({
      platform: 'groq',
      modelPattern: '*',
      mode: 'none',
      maxBreakpoints: 0,
      minTokens: 0,
      ttlSeconds: 0,
      source: 'builtin',
    });

    const unknown = resolveCacheCapability('unknown-vendor', 'foo-1');
    expect(unknown).toEqual({
      platform: 'unknown-vendor',
      modelPattern: '*',
      mode: 'none',
      maxBreakpoints: 0,
      minTokens: 0,
      ttlSeconds: 0,
      source: 'builtin',
      updatedAt: '',
    });
  });

  it('prefers override over builtin and resolves tie-breaks by pattern length then non-wildcard chars', () => {
    // Same pattern length (4): 'gpt*' has 3 non-* chars, 'g**t' has 2, 'g***' has 1
    upsertCacheCapabilityOverride({
      platform: 'openai',
      modelPattern: 'g***',
      mode: 'none',
      maxBreakpoints: 0,
      minTokens: 0,
      ttlSeconds: 0,
    });
    upsertCacheCapabilityOverride({
      platform: 'openai',
      modelPattern: 'gpt*',
      mode: 'explicit',
      maxBreakpoints: 2,
      minTokens: 512,
      ttlSeconds: 600,
    });

    const matched = resolveCacheCapability('openai', 'gpt-4o');
    expect(matched).toMatchObject({
      platform: 'openai',
      modelPattern: 'gpt*',
      mode: 'explicit',
      maxBreakpoints: 2,
      minTokens: 512,
      ttlSeconds: 600,
      source: 'override',
    });

    // Wildcard platform override still beats platform-specific builtin
    upsertCacheCapabilityOverride({
      platform: '*',
      modelPattern: 'claude-sonnet-*',
      mode: 'implicit',
      maxBreakpoints: 0,
      minTokens: 256,
      ttlSeconds: 120,
    });
    expect(resolveCacheCapability('anthropic', 'claude-sonnet-4-6')).toMatchObject({
      platform: '*',
      modelPattern: 'claude-sonnet-*',
      mode: 'implicit',
      source: 'override',
    });

    // Deleting override restores builtin; deleting non-existent returns false
    expect(deleteCacheCapabilityOverride('*', 'claude-sonnet-*')).toBe(true);
    expect(deleteCacheCapabilityOverride('*', 'claude-sonnet-*')).toBe(false);
    expect(resolveCacheCapability('anthropic', 'claude-sonnet-4-6').source).toBe('builtin');

    // Builtin seeds remain intact in listCacheCapabilities
    const all = listCacheCapabilities();
    expect(all.filter((c) => c.source === 'builtin')).toHaveLength(28);
  });

  it('handles missing tables gracefully on resolveCacheCapability and getPromptCacheSettings', () => {
    getDb().exec('DROP TABLE custom_ai_cache_capabilities; DROP TABLE settings;');
    expect(getPromptCacheSettings()).toEqual({
      forward: true,
      autoBreakpoints: false,
      preferStickyRoute: false,
    });
    expect(resolveCacheCapability('anthropic', 'claude-sonnet-4-6')).toEqual({
      platform: 'anthropic',
      modelPattern: '*',
      mode: 'none',
      maxBreakpoints: 0,
      minTokens: 0,
      ttlSeconds: 0,
      source: 'builtin',
      updatedAt: '',
    });
  });

  describe('promptCacheAdminRouter settings & capabilities endpoints', () => {
    let server: http.Server | null = null;
    let baseUrl = '';
    let activeUser: SessionUser | undefined;

    beforeEach(async () => {
      activeUser = { userId: 1, email: 'admin@example.com', role: 'admin', isPrimary: true, permissions: ['*'] };
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        (req as express.Request & { user?: SessionUser }).user = activeUser;
        next();
      });
      app.use('/api/ai-platform', promptCacheAdminRouter);
      server = app.listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => server!.once('listening', () => resolve()));
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterEach(async () => {
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        server = null;
      }
    });

    async function call(method: string, path: string, body?: unknown) {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: body !== undefined ? { 'content-type': 'application/json' } : {},
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    }

    it('enforces view_prompt_cache and edit_prompt_cache permissions and validates inputs', async () => {
      activeUser = { userId: 2, email: 'viewer@example.com', role: 'member', isPrimary: false, permissions: ['view_prompt_cache'] };
      expect((await call('GET', '/api/ai-platform/prompt-cache/settings')).status).toBe(200);
      expect((await call('GET', '/api/ai-platform/prompt-cache/capabilities')).status).toBe(200);

      const deniedPut = await call('PUT', '/api/ai-platform/prompt-cache/settings', { autoBreakpoints: true });
      expect(deniedPut.status).toBe(403);
      expect((deniedPut.json.error as { code: string }).code).toBe('missing_permission');

      const deniedCap = await call('PUT', '/api/ai-platform/prompt-cache/capabilities', {
        platform: 'openai',
        modelPattern: 'gpt-*',
        mode: 'none',
      });
      expect(deniedCap.status).toBe(403);

      activeUser = { userId: 3, email: 'editor@example.com', role: 'member', isPrimary: false, permissions: ['edit_prompt_cache'] };
      const badSettings = await call('PUT', '/api/ai-platform/prompt-cache/settings', { forward: 'yes' });
      expect(badSettings.status).toBe(400);

      const goodSettings = await call('PUT', '/api/ai-platform/prompt-cache/settings', { autoBreakpoints: true });
      expect(goodSettings.status).toBe(200);
      expect(goodSettings.json).toEqual({
        settings: { forward: true, autoBreakpoints: true, preferStickyRoute: false },
      });

      const badCap = await call('PUT', '/api/ai-platform/prompt-cache/capabilities', {
        platform: '',
        modelPattern: '*',
        mode: 'explicit',
      });
      expect(badCap.status).toBe(400);

      const goodCap = await call('PUT', '/api/ai-platform/prompt-cache/capabilities', {
        platform: 'OpenRouter',
        modelPattern: 'anthropic/claude-*',
        mode: 'explicit',
        maxBreakpoints: 3,
        minTokens: 2048,
        ttlSeconds: 600,
      });
      expect(goodCap.status).toBe(200);
      expect(goodCap.json.capability).toMatchObject({
        platform: 'openrouter',
        modelPattern: 'anthropic/claude-*',
        mode: 'explicit',
        maxBreakpoints: 3,
        minTokens: 2048,
        ttlSeconds: 600,
        source: 'override',
      });

      const delCap = await call('DELETE', '/api/ai-platform/prompt-cache/capabilities', {
        platform: 'openrouter',
        modelPattern: 'anthropic/claude-*',
      });
      expect(delCap.status).toBe(200);
      expect(delCap.json).toEqual({ deleted: true });
    });
  });
});
