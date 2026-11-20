import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { SUPPORT_SETUP_STEP_IDS, SYSTEM_SETTING_IDS } from '@freellmapi/shared/support-setup-copilot.js';
import { PERMISSION_GROUPS } from '@freellmapi/shared/permissions.js';
import { getKbCorpus } from '../../custom/support-setup-copilot/kb/corpus.js';
import { searchKb, searchKbLexical } from '../../custom/support-setup-copilot/kb/index.js';
import { buildKbQueryFromMessages, formatKbForPrompt } from '../../custom/support-setup-copilot/kb/prompt.js';
import { DASHBOARD_PAGES } from '../../custom/support-setup-copilot/kb/sources/pages.js';
import {
  resetKbSemanticForTests,
  setKbEmbeddingsRunnerForTests,
  waitForKbSemanticIndexForTests,
} from '../../custom/support-setup-copilot/kb/semantic.js';
import cases from '../fixtures/copilot-kb/eval-cases.json' with { type: 'json' };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const admin = { role: 'admin', isPrimary: true } as const;

describe('Setup Copilot KB — corpus coverage (drift protection)', () => {
  const ids = new Set(getKbCorpus().map((c) => c.id));

  it('documents every permission, system setting and tenant step', () => {
    for (const g of PERMISSION_GROUPS) {
      expect(ids.has(`perm:${g.key}`), g.key).toBe(true);
      for (const c of g.children) expect(ids.has(`perm:${c.key}`), c.key).toBe(true);
    }
    for (const s of SYSTEM_SETTING_IDS) expect(ids.has(`setting:${s}`), s).toBe(true);
    for (const s of SUPPORT_SETUP_STEP_IDS) expect(ids.has(`step:${s}`), s).toBe(true);
  });

  it('documents every dashboard route declared in client/src/App.tsx', () => {
    const app = fs.readFileSync(path.resolve(HERE, '../../../../client/src/App.tsx'), 'utf8');
    const routes = [...app.matchAll(/<Route path="([^"]+)" element=\{(?!<Navigate)/g)].map((m) => m[1]!);
    const covered = (p: string): boolean => {
      const base = p.replace(/\/:\w+.*$/, '').replace(/\/\*$/, '');
      return (
        DASHBOARD_PAGES.some((d) => d.path === base || d.path === p) ||
        [...ids].some((id) => id.startsWith('route:')) && getKbCorpus().some((c) => c.path === base || (c.path && base.startsWith(c.path)))
      );
    };
    const missing = routes.filter((r) => r !== '*' && !covered(r));
    expect(missing).toEqual([]);
  });

  it('keeps ids unique and every chunk non-empty', () => {
    const corpus = getKbCorpus();
    expect(new Set(corpus.map((c) => c.id)).size).toBe(corpus.length);
    for (const c of corpus) expect(c.text.trim().length, c.id).toBeGreaterThan(20);
  });
});

describe('Setup Copilot KB — permission filtering', () => {
  it('hides permission-gated chunks from callers who lack the permission', () => {
    const member = { role: 'member', permissions: ['view_analytics'] } as const;
    const asMember = searchKbLexical('response cache enable disable', { caller: member, limit: 10 });
    expect(asMember.some((h) => h.chunk.id === 'setting:response_cache')).toBe(false);
    const asAdmin = searchKbLexical('response cache enable disable', { caller: admin, limit: 10 });
    expect(asAdmin.some((h) => h.chunk.id === 'setting:response_cache')).toBe(true);
    const withPerm = searchKbLexical('response cache enable disable', { caller: { role: 'member', permissions: ['edit_cache'] }, limit: 10 });
    expect(withPerm.some((h) => h.chunk.id === 'setting:response_cache')).toBe(true);
  });
});

describe('Setup Copilot KB — retrieval quality on the eval set', () => {
  it('finds the expected chunk in the top 3 for ≥ 90% of cases (and reports MRR)', async () => {
    let hit3 = 0;
    let rr = 0;
    const misses: string[] = [];
    for (const c of cases as Array<{ q: string; expect: string[] }>) {
      const hits = await searchKb(c.q, { caller: admin, limit: 5 });
      const rank = hits.findIndex((h) => c.expect.includes(h.chunk.id));
      if (rank >= 0 && rank < 3) hit3 += 1;
      else misses.push(`${c.q} → [${hits.slice(0, 3).map((h) => h.chunk.id).join(', ')}]`);
      rr += rank >= 0 ? 1 / (rank + 1) : 0;
    }
    const total = (cases as unknown[]).length;
    // eslint-disable-next-line no-console
    console.log(`KB eval: recall@3=${(hit3 / total).toFixed(2)} MRR=${(rr / total).toFixed(2)} misses=${JSON.stringify(misses)}`);
    expect(hit3 / total).toBeGreaterThanOrEqual(0.9);
  });
});

describe('Setup Copilot KB — prompt section', () => {
  it('formats hits with page paths in the caller language and refuses to invent when empty', async () => {
    const hits = await searchKb('bước 7 CORS origins', { caller: admin, limit: 3 });
    const vi = formatKbForPrompt(hits, 'vi');
    expect(vi).toContain('RETRIEVED PLATFORM KNOWLEDGE');
    expect(vi).toContain('/thruline/support-integration');
    expect(formatKbForPrompt([], 'en')).toContain('Do NOT invent');
  });

  it('uses earlier turns to resolve a short follow-up', () => {
    const q = buildKbQueryFromMessages([
      { role: 'user', content: 'tenant này hay bị lỗi, vì sao' },
      { role: 'assistant', content: 'Lỗi 429 do giới hạn tốc độ' },
      { role: 'user', content: 'rồi làm sao xử lý' },
    ]);
    expect(q).toContain('tenant');
  });
});

describe('Setup Copilot KB — hybrid semantic layer (optional)', () => {
  beforeEach(() => resetKbSemanticForTests());

  it('fuses a ready semantic index with BM25 and degrades to BM25 when embeddings fail', async () => {
    // Fake embeddings: a bag-of-letters vector, deterministic and provider-free.
    const embed = async (_m: string | undefined, inputs: string[]) => ({
      vectors: inputs.map((t) => {
        const v = new Array(26).fill(0);
        for (const ch of t.toLowerCase()) {
          const i = ch.charCodeAt(0) - 97;
          if (i >= 0 && i < 26) v[i] += 1;
        }
        return v;
      }),
    });
    setKbEmbeddingsRunnerForTests(embed);
    await searchKb('warm up', { caller: admin });
    await waitForKbSemanticIndexForTests();
    const hits = await searchKb('allowed origins cors runtime limits', { caller: admin, limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.via.includes('semantic'))).toBe(true);

    setKbEmbeddingsRunnerForTests(async () => { throw new Error('no provider'); });
    await searchKb('warm up', { caller: admin });
    await waitForKbSemanticIndexForTests();
    const fallback = await searchKb('allowed origins cors runtime limits', { caller: admin, limit: 5 });
    expect(fallback.length).toBeGreaterThan(0);
    expect(fallback.every((h) => !h.via.includes('semantic'))).toBe(true);
    setKbEmbeddingsRunnerForTests(null);
  });
});
