import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROMPT_LIMITS } from '@freellmapi/shared/ai-platform-prompts.js';
import { getDb, initDb } from '../../../db/index.js';
import { ensureSupportTables } from '../../../custom/x-gateway/support-store.js';
import {
  diffPromptVersions,
  discardDraft,
  getPromptScopeState,
  getPromptVersion,
  getPublishedPrompt,
  PromptNotFoundError,
  PromptStoreError,
  PromptValidationError,
  publish,
  restore,
  RevisionConflictError,
  saveDraft,
} from '../../../custom/ai-platform/prompts/store.js';

function seedProfile(id: number, systemPrompt: string | null = null): void {
  getDb()
    .prepare(
      'INSERT INTO client_profiles (id, name, token_hash, encrypted_key, iv, auth_tag, system_prompt) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(id, `profile-${id}`, `th-${id}`, `ek-${id}`, `iv-${id}`, `tag-${id}`, systemPrompt);
}

function seedSupportTenant(id: number, systemPrompt = ''): void {
  ensureSupportTables();
  getDb()
    .prepare(
      `INSERT INTO x_support_tenants
         (id, name, slug, public_key, secret_encrypted, secret_iv, secret_auth_tag, system_prompt, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'se', 'si', 'st', ?, '2026-11-12T00:00:00.000Z', '2026-11-12T00:00:00.000Z')`,
    )
    .run(id, `tenant-${id}`, `tenant-${id}`, `pk-${id}`, systemPrompt);
}

describe('prompts/store', () => {
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

  it('returns virtual initial revision 1 when empty and lazily backfills legacy profile/tenant system_prompt', () => {
    seedProfile(1, null);
    const emptyState = getPromptScopeState({ kind: 'profile', id: '1' });
    expect(emptyState.head).toEqual({
      scopeKind: 'profile',
      scopeId: '1',
      publishedVersion: null,
      draftVersion: null,
      revision: 1,
    });
    expect(emptyState.published).toBeNull();
    expect(emptyState.draft).toBeNull();
    expect(emptyState.versions).toEqual([]);
    expect(emptyState.prunedCount).toBe(0);
    expect(getPublishedPrompt({ kind: 'profile', id: '1' })).toBeNull();

    seedProfile(2, 'Legacy profile prompt');
    const profileState = getPromptScopeState({ kind: 'profile', id: '2' });
    expect(profileState.head).toEqual({
      scopeKind: 'profile',
      scopeId: '2',
      publishedVersion: 1,
      draftVersion: null,
      revision: 1,
    });
    expect(profileState.published?.body).toBe('Legacy profile prompt');
    expect(profileState.published?.status).toBe('published');
    expect(getPublishedPrompt({ kind: 'profile', id: '2' })).toEqual({
      version: 1,
      body: 'Legacy profile prompt',
      variables: [],
    });

    seedSupportTenant(5, 'Legacy tenant prompt');
    const tenantState = getPromptScopeState({ kind: 'support_tenant', id: '5' });
    expect(tenantState.head.publishedVersion).toBe(1);
    expect(tenantState.published?.body).toBe('Legacy tenant prompt');
  });

  it('enforces immutable versions, single draft/published invariant, and transactional sync to client_profiles and x_support_tenants', () => {
    seedProfile(1, null);
    const scope = { kind: 'profile' as const, id: '1' };

    const d1 = saveDraft(
      scope,
      {
        body: 'Hello {{brand}}',
        variables: [{ name: 'brand', source: 'custom', default: 'Acme' }],
        note: 'initial draft',
        revision: 1,
      },
      10,
    );
    expect(d1.version).toBe(1);
    expect(d1.status).toBe('draft');
    expect(d1.authorId).toBe(10);

    // Saving a second draft archives v1 without mutating v1's body/note
    const d2 = saveDraft(
      scope,
      {
        body: 'Hello {{brand}} v2',
        variables: [{ name: 'brand', source: 'custom', default: 'Acme' }],
        note: 'second draft',
        revision: 2,
      },
      11,
    );
    expect(d2.version).toBe(2);
    expect(d2.status).toBe('draft');

    const v1After = getPromptVersion(scope, 1);
    expect(v1After.status).toBe('archived');
    expect(v1After.body).toBe('Hello {{brand}}');
    expect(v1After.note).toBe('initial draft');

    // Publish v2 -> updates client_profiles.system_prompt in same transaction
    const headAfterPublish = publish(scope, 3, 12);
    expect(headAfterPublish).toEqual({
      scopeKind: 'profile',
      scopeId: '1',
      publishedVersion: 2,
      draftVersion: null,
      revision: 4,
    });
    const profileRow = getDb()
      .prepare('SELECT system_prompt FROM client_profiles WHERE id = 1')
      .get() as { system_prompt: string };
    expect(profileRow.system_prompt).toBe('Hello {{brand}} v2');

    // Publish again without a draft -> 409
    expect(() => publish(scope, 4, 12)).toThrowError(PromptStoreError);

    // Save v3 draft and discard it
    const d3 = saveDraft(scope, { body: 'Throwaway', note: 'temp', revision: 4 }, 10);
    expect(d3.version).toBe(3);
    const headAfterDiscard = discardDraft(scope, 5);
    expect(headAfterDiscard).toEqual({
      scopeKind: 'profile',
      scopeId: '1',
      publishedVersion: 2,
      draftVersion: null,
      revision: 6,
    });
    expect(getPromptVersion(scope, 3).status).toBe('archived');

    // Idempotent discard when no draft exists
    expect(discardDraft(scope, 6)).toEqual(headAfterDiscard);

    // Support tenant transactional sync
    seedSupportTenant(7, '');
    const tScope = { kind: 'support_tenant' as const, id: '7' };
    saveDraft(tScope, { body: 'Tenant v1 {{end_user_name}}', revision: 1 }, 1);
    publish(tScope, 2, 1);
    const tenantRow = getDb()
      .prepare('SELECT system_prompt FROM x_support_tenants WHERE id = 7')
      .get() as { system_prompt: string };
    expect(tenantRow.system_prompt).toBe('Tenant v1 {{end_user_name}}');

    // Agent scope works without legacy table
    const aScope = { kind: 'agent' as const, id: 'triage' };
    saveDraft(aScope, { body: 'Agent triage prompt', revision: 1 }, 1);
    const aHead = publish(aScope, 2, 1);
    expect(aHead.publishedVersion).toBe(1);
    expect(getPublishedPrompt(aScope)?.body).toBe('Agent triage prompt');
  });

  it('restore creates a new published version with restoredFrom, archives prior published, preserves draft, and syncs underlying table', () => {
    seedProfile(1, 'Initial v1');
    const scope = { kind: 'profile' as const, id: '1' };

    saveDraft(scope, { body: 'Updated v2', note: 'v2 note', revision: 1 }, 1);
    publish(scope, 2, 1);
    // Keep an active draft v3 while restoring v1
    saveDraft(scope, { body: 'Draft v3', note: 'wip', revision: 3 }, 1);

    const restoredHead = restore(scope, 1, 4, 99);
    expect(restoredHead).toEqual({
      scopeKind: 'profile',
      scopeId: '1',
      publishedVersion: 4,
      draftVersion: 3,
      revision: 5,
    });

    const v4 = getPromptVersion(scope, 4);
    expect(v4.status).toBe('published');
    expect(v4.body).toBe('Initial v1');
    expect(v4.restoredFrom).toBe(1);
    expect(v4.authorId).toBe(99);
    expect(getPromptVersion(scope, 2).status).toBe('archived');
    expect(getPromptVersion(scope, 3).status).toBe('draft');

    const profileRow = getDb()
      .prepare('SELECT system_prompt FROM client_profiles WHERE id = 1')
      .get() as { system_prompt: string };
    expect(profileRow.system_prompt).toBe('Initial v1');

    expect(() => restore(scope, 999, 5, 1)).toThrowError(PromptNotFoundError);
  });

  it('throws 409 RevisionConflictError with latest PromptScopeStateResponse on stale revision', () => {
    seedProfile(1, null);
    const scope = { kind: 'profile' as const, id: '1' };

    saveDraft(scope, { body: 'v1', revision: 1 }, 1);

    let caught: unknown;
    try {
      saveDraft(scope, { body: 'stale', revision: 1 }, 2);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RevisionConflictError);
    const conflict = caught as RevisionConflictError;
    expect(conflict.status).toBe(409);
    expect(conflict.code).toBe('revision_conflict');
    expect(conflict.current.head.revision).toBe(2);
    expect(conflict.current.draft?.body).toBe('v1');

    expect(() => publish(scope, 1, 2)).toThrowError(RevisionConflictError);
    expect(() => discardDraft(scope, 1)).toThrowError(RevisionConflictError);
    expect(() => restore(scope, 1, 1, 2)).toThrowError(RevisionConflictError);
  });

  it('throws 422 PromptValidationError with 1-based line/column before mutating DB and enforces limits', () => {
    seedProfile(1, null);
    const scope = { kind: 'profile' as const, id: '1' };

    let caught: unknown;
    try {
      saveDraft(
        scope,
        {
          body: 'Line one ok\nSee {{missing_var}} here',
          variables: [],
          revision: 1,
        },
        1,
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PromptValidationError);
    const valErr = caught as PromptValidationError;
    expect(valErr.status).toBe(422);
    expect(valErr.code).toBe('invalid_template');
    expect(valErr.line).toBe(2);
    expect(valErr.column).toBe(5);
    expect(valErr.reason).toContain('missing_var');

    // DB must remain untouched
    const state = getPromptScopeState(scope);
    expect(state.head.revision).toBe(1);
    expect(state.versions).toEqual([]);

    // Length limits
    expect(() =>
      saveDraft(scope, { body: 'x'.repeat(PROMPT_LIMITS.maxBodyChars + 1), revision: 1 }, 1),
    ).toThrowError(PromptValidationError);
    expect(() =>
      saveDraft(
        scope,
        { body: 'ok', note: 'n'.repeat(PROMPT_LIMITS.maxNoteChars + 1), revision: 1 },
        1,
      ),
    ).toThrowError(PromptValidationError);
  });

  it('prunes archived versions beyond 50 while never deleting published or draft (even if published is v1)', () => {
    seedProfile(1, null);
    const scope = { kind: 'profile' as const, id: '1' };

    saveDraft(scope, { body: 'Published v1', revision: 1 }, 1);
    publish(scope, 2, 1);

    let rev = 3;
    for (let i = 2; i <= 61; i++) {
      saveDraft(scope, { body: `Draft ${i}`, revision: rev }, 1);
      rev++;
    }

    const state = getPromptScopeState(scope);
    expect(state.versions).toHaveLength(PROMPT_LIMITS.maxRetainedVersions);
    expect(state.published?.version).toBe(1);
    expect(state.published?.body).toBe('Published v1');
    expect(state.draft?.version).toBe(61);
    expect(state.prunedCount).toBe(11);

    // v1 (published), v13..v60 (48 archived), v61 (draft) should remain; v2..v12 pruned
    expect(() => getPromptVersion(scope, 2)).toThrowError(PromptNotFoundError);
    expect(() => getPromptVersion(scope, 12)).toThrowError(PromptNotFoundError);
    expect(getPromptVersion(scope, 1).status).toBe('published');
    expect(getPromptVersion(scope, 13).status).toBe('archived');
    expect(getPromptVersion(scope, 61).status).toBe('draft');
  });

  it('computes line-by-line LCS diff with line numbers, stats, and PromptVersionSummary metadata', () => {
    seedProfile(1, null);
    const scope = { kind: 'profile' as const, id: '1' };

    saveDraft(scope, { body: 'alpha\nbeta\ngamma\ndelta', note: 'first', revision: 1 }, 1);
    publish(scope, 2, 1);
    saveDraft(scope, { body: 'alpha\nbeta-edited\ngamma\nepsilon', note: 'second', revision: 3 }, 1);

    const diff = diffPromptVersions(scope, 1, 2);
    expect(diff.from.version).toBe(1);
    expect(diff.from.note).toBe('first');
    expect('body' in diff.from).toBe(false);
    expect(diff.to.version).toBe(2);
    expect(diff.to.note).toBe('second');
    expect('body' in diff.to).toBe(false);

    expect(diff.stats).toEqual({
      added: 2,
      removed: 2,
      unchanged: 2,
    });
    expect(diff.hunks).toEqual([
      { type: 'same', text: 'alpha', oldLineNumber: 1, newLineNumber: 1 },
      { type: 'remove', text: 'beta', oldLineNumber: 2, newLineNumber: null },
      { type: 'add', text: 'beta-edited', oldLineNumber: null, newLineNumber: 2 },
      { type: 'same', text: 'gamma', oldLineNumber: 3, newLineNumber: 3 },
      { type: 'remove', text: 'delta', oldLineNumber: 4, newLineNumber: null },
      { type: 'add', text: 'epsilon', oldLineNumber: null, newLineNumber: 4 },
    ]);

    expect(() => diffPromptVersions(scope, 1, 999)).toThrowError(PromptNotFoundError);
  });
});
