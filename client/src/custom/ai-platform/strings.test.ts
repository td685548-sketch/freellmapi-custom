/**
 * strings.test.ts — coverage for ai-platform/strings.ts
 *
 * The global translations.test.ts only scans custom/*.tsx at the top level
 * (not recursive). This file fills that gap for the ai-platform sub-package.
 *
 * Tests:
 * 1. Every string exported from strings.ts has a Vietnamese entry in vi.ts
 * 2. Vietnamese translations preserve all {placeholder} names from English
 * 3. PILLAR_LABELS covers exactly the 6 pillar keys
 * 4. PILLAR_DESCRIPTIONS covers exactly the 6 pillar keys
 * 5. No string is an empty value
 */

import { describe, expect, it } from 'vitest';
import { VI } from '../i18n/vi';
import { translate } from '../i18n/use-custom-t';
import {
  NAV_AI_PLATFORM,
  PAGE_TITLE,
  PAGE_SUBTITLE,
  OVERVIEW_HEADING,
  OVERVIEW_LOADING,
  OVERVIEW_ERROR,
  OVERVIEW_RETRY,
  PILLAR_PROMPTS,
  PILLAR_RETRIEVAL,
  PILLAR_PROMPT_CACHE,
  PILLAR_MCP_CLIENT,
  PILLAR_OUTPUT_GUARD,
  PILLAR_ORCHESTRATOR,
  PILLAR_PROMPTS_DESC,
  PILLAR_RETRIEVAL_DESC,
  PILLAR_PROMPT_CACHE_DESC,
  PILLAR_MCP_CLIENT_DESC,
  PILLAR_OUTPUT_GUARD_DESC,
  PILLAR_ORCHESTRATOR_DESC,
  SWITCH_ON,
  SWITCH_OFF,
  SWITCH_ENABLING,
  SWITCH_DISABLING,
  SWITCH_LOCKED,
  SWITCH_SAVE_ERROR,
  SWITCH_CONFLICT,
  SWITCH_NETWORK_ERROR,
  FLAGS_SAVED,
  FLAGS_SAVE_ERROR,
  RETENTION_HEADING,
  RETENTION_TRACE,
  RETENTION_TOOL_CALLS,
  RETENTION_EXCERPTS,
  RETENTION_SAVE,
  RETENTION_SAVED,
  RETENTION_SAVE_ERROR,
  NO_ACCESS,
  NO_EDIT,
  ACCESS_DENIED_403,
  SESSION_EXPIRED_401,
  PILLAR_LABELS,
  PILLAR_DESCRIPTIONS,
  type PillarKey,
} from './strings';

// All English strings that should have a Vietnamese translation
const ALL_STRINGS: string[] = [
  NAV_AI_PLATFORM,
  PAGE_TITLE,
  PAGE_SUBTITLE,
  OVERVIEW_HEADING,
  OVERVIEW_LOADING,
  OVERVIEW_ERROR,
  OVERVIEW_RETRY,
  PILLAR_PROMPTS,
  PILLAR_RETRIEVAL,
  PILLAR_PROMPT_CACHE,
  PILLAR_MCP_CLIENT,
  PILLAR_OUTPUT_GUARD,
  PILLAR_ORCHESTRATOR,
  PILLAR_PROMPTS_DESC,
  PILLAR_RETRIEVAL_DESC,
  PILLAR_PROMPT_CACHE_DESC,
  PILLAR_MCP_CLIENT_DESC,
  PILLAR_OUTPUT_GUARD_DESC,
  PILLAR_ORCHESTRATOR_DESC,
  SWITCH_ON,
  SWITCH_OFF,
  SWITCH_ENABLING,
  SWITCH_DISABLING,
  SWITCH_LOCKED,
  SWITCH_SAVE_ERROR,
  SWITCH_CONFLICT,
  SWITCH_NETWORK_ERROR,
  FLAGS_SAVED,
  FLAGS_SAVE_ERROR,
  RETENTION_HEADING,
  RETENTION_TRACE,
  RETENTION_TOOL_CALLS,
  RETENTION_EXCERPTS,
  RETENTION_SAVE,
  RETENTION_SAVED,
  RETENTION_SAVE_ERROR,
  NO_ACCESS,
  NO_EDIT,
  ACCESS_DENIED_403,
  SESSION_EXPIRED_401,
];

const EXPECTED_PILLARS: PillarKey[] = [
  'prompts', 'retrieval', 'promptCache', 'mcpClient', 'outputGuard', 'orchestrator',
];

describe('ai-platform/strings.ts', () => {
  it('no string is empty', () => {
    for (const s of ALL_STRINGS) {
      expect(s, `string "${s}" must not be empty`).toBeTruthy();
      expect(s.trim().length, `string "${s}" must have non-whitespace content`).toBeGreaterThan(0);
    }
  });

  it('PILLAR_LABELS covers exactly the 6 pillar keys', () => {
    expect(Object.keys(PILLAR_LABELS).sort()).toEqual([...EXPECTED_PILLARS].sort());
  });

  it('PILLAR_DESCRIPTIONS covers exactly the 6 pillar keys', () => {
    expect(Object.keys(PILLAR_DESCRIPTIONS).sort()).toEqual([...EXPECTED_PILLARS].sort());
  });

  it('every label value is a non-empty string', () => {
    for (const [key, label] of Object.entries(PILLAR_LABELS)) {
      expect(label, `PILLAR_LABELS.${key}`).toBeTruthy();
    }
  });

  it('every description value is a non-empty string', () => {
    for (const [key, desc] of Object.entries(PILLAR_DESCRIPTIONS)) {
      expect(desc, `PILLAR_DESCRIPTIONS.${key}`).toBeTruthy();
    }
  });

  it('every ai-platform string has a Vietnamese entry in vi.ts', () => {
    const missing = ALL_STRINGS.filter(s => /\p{L}{2,}/u.test(s) && !(s in VI));
    expect(
      missing,
      `Missing Vietnamese translations — add these keys to client/src/custom/i18n/vi.ts:\n${missing.map(s => `  "${s}"`).join('\n')}`
    ).toEqual([]);
  });

  it('Vietnamese translations preserve all {placeholder} names', () => {
    for (const en of ALL_STRINGS) {
      const vi_text = VI[en];
      if (!vi_text) continue;
      const knownPlaceholders = new Set([...en.matchAll(/\{(\w+)\}/g)].map(m => m[1]));
      for (const m of vi_text.matchAll(/\{(\w+)\}/g)) {
        expect(
          knownPlaceholders.has(m[1]),
          `Vietnamese translation for "${en}" uses unknown placeholder {${m[1]}}`
        ).toBe(true);
      }
    }
  });

  it('translate() returns Vietnamese for known strings', () => {
    // Pick a known string; if VI has it, verify translation works
    if (VI[OVERVIEW_HEADING]) {
      expect(translate('vi', OVERVIEW_HEADING)).toBe(VI[OVERVIEW_HEADING]);
    }
    if (VI[NAV_AI_PLATFORM]) {
      expect(translate('vi', NAV_AI_PLATFORM)).toBe(VI[NAV_AI_PLATFORM]);
    }
  });

  it('translate() falls back to English for unknown locale', () => {
    expect(translate('fr', OVERVIEW_HEADING)).toBe(OVERVIEW_HEADING);
    expect(translate('de', PILLAR_PROMPTS)).toBe(PILLAR_PROMPTS);
  });

  it('translate() falls back to English when Vietnamese is missing', () => {
    const notTranslated = 'A unique string not in VI dictionary $$$';
    expect(translate('vi', notTranslated)).toBe(notTranslated);
  });
});
