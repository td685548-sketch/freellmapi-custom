// @vitest-environment jsdom
/**
 * T113 — AI Platform Versioned Prompts UI tests (native createRoot/act, no @testing-library/react).
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Permission } from '../../../../shared/user-access';
import { VI } from '../i18n/vi';
import { AiPlatformApp } from './AiPlatformApp';
import { Prompts } from './pages/Prompts';
import * as promptsApi from './prompts-api';
import * as promptsStrings from './prompts-strings';

const actor = vi.hoisted(() => ({
  perms: new Set<string>(),
  isPrimary: false,
  userId: 1,
}));

vi.mock('../use-administrative-access', () => ({
  useAdministrativeAccess: () => ({
    can: (p: string) => actor.isPrimary || actor.perms.has(p),
    isPending: false,
    isPrimary: actor.isPrimary,
    isAdmin: false,
    isMember: true,
    identity: `test:${actor.userId}:${actor.isPrimary}:${[...actor.perms].sort().join(',')}`,
    hasPermission: (p: Permission) => actor.isPrimary || actor.perms.has(p),
    group: (parent: string) => actor.isPrimary || actor.perms.has(parent),
  }),
}));

vi.mock('../use-session', () => ({
  useUserSession: () => ({
    session: {
      userId: actor.userId,
      permissions: [...actor.perms] as Permission[],
      role: 'member' as const,
      isPrimary: actor.isPrimary,
    },
    hasPermission: (p: Permission) => actor.isPrimary || actor.perms.has(p),
    isPrimary: actor.isPrimary,
    isAdmin: false,
    isMember: true,
    permissions: [...actor.perms] as Permission[],
  }),
}));

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  getToken: () => 'test-token',
  clearToken: vi.fn(),
  UNAUTHORIZED_EVENT: 'freellmapi:unauthorized',
}));

vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api');
  return {
    ...actual,
    fetchOverview: vi.fn().mockResolvedValue({
      flags: {
        prompts: true,
        retrieval: false,
        promptCache: false,
        mcpClient: false,
        outputGuard: false,
        orchestrator: false,
      },
      retention: { runsDays: 30, toolCallsDays: 30, guardExcerptsDays: 7 },
      pillars: {
        prompts: { enabled: true, ready: true, summary: 'Ready' },
        retrieval: { enabled: false, ready: false, summary: '' },
        promptCache: { enabled: false, ready: false, summary: '' },
        mcpClient: { enabled: false, ready: false, summary: '' },
        outputGuard: { enabled: false, ready: false, summary: '' },
        orchestrator: { enabled: false, ready: false, summary: '' },
      },
      warnings: [],
    }),
  };
});

vi.mock('./prompts-api', async () => {
  const actual = await vi.importActual<typeof import('./prompts-api')>('./prompts-api');
  return {
    ...actual,
    fetchSystemPromptVariables: vi.fn(),
    fetchPromptScopeState: vi.fn(),
    fetchPromptVersion: vi.fn(),
    fetchPromptDiff: vi.fn(),
    savePromptDraft: vi.fn(),
    discardPromptDraft: vi.fn(),
    publishPrompt: vi.fn(),
    restorePromptVersion: vi.fn(),
    previewPrompt: vi.fn(),
    tryPrompt: vi.fn(),
    fetchPromptProfileOptions: vi.fn(),
    fetchPromptSupportTenantOptions: vi.fn(),
  };
});

let container: HTMLDivElement;
let root: Root;
let qc: QueryClient;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

function renderEl(el: React.ReactElement) {
  act(() => {
    root.render(<QueryClientProvider client={qc}>{el}</QueryClientProvider>);
  });
}

function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function setSelectValue(el: HTMLSelectElement, value: string) {
  el.value = value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function makeScopeState(
  overrides: Partial<promptsApi.PromptScopeStateResponse> = {},
): promptsApi.PromptScopeStateResponse {
  const published: promptsApi.PromptVersion = {
    id: 1,
    scopeKind: 'profile',
    scopeId: '1',
    version: 1,
    body: 'You are a helpful assistant for {{profile_name}}.',
    variables: [],
    note: 'Initial backfill',
    status: 'published',
    restoredFrom: null,
    authorId: null,
    createdAt: '2026-11-15 09:00:00',
  };
  const draft: promptsApi.PromptVersion = {
    id: 2,
    scopeKind: 'profile',
    scopeId: '1',
    version: 2,
    body: 'You are a concise assistant for {{profile_name}}.',
    variables: [{ name: 'tone', source: 'custom', default: 'concise', description: 'Tone' }],
    note: 'Make replies concise',
    status: 'draft',
    restoredFrom: null,
    authorId: 7,
    createdAt: '2026-11-16 10:00:00',
  };
  return {
    scope: { kind: 'profile', id: '1' },
    head: {
      scopeKind: 'profile',
      scopeId: '1',
      publishedVersion: 1,
      draftVersion: 2,
      revision: 3,
    },
    published,
    draft,
    versions: [
      {
        id: 2,
        scopeKind: 'profile',
        scopeId: '1',
        version: 2,
        variables: draft.variables,
        note: draft.note,
        status: 'draft',
        restoredFrom: null,
        authorId: 7,
        createdAt: draft.createdAt,
      },
      {
        id: 1,
        scopeKind: 'profile',
        scopeId: '1',
        version: 1,
        variables: [],
        note: 'Initial backfill',
        status: 'published',
        restoredFrom: null,
        authorId: null,
        createdAt: published.createdAt,
      },
    ],
    prunedCount: 0,
    ...overrides,
  };
}

const SAMPLE_DIFF: promptsApi.PromptDiffResponse = {
  from: {
    id: 1,
    scopeKind: 'profile',
    scopeId: '1',
    version: 1,
    variables: [],
    note: 'Initial backfill',
    status: 'published',
    restoredFrom: null,
    authorId: null,
    createdAt: '2026-11-15 09:00:00',
  },
  to: {
    id: 2,
    scopeKind: 'profile',
    scopeId: '1',
    version: 2,
    variables: [],
    note: 'Make replies concise',
    status: 'draft',
    restoredFrom: null,
    authorId: 7,
    createdAt: '2026-11-16 10:00:00',
  },
  hunks: [
    { type: 'same', text: 'System rules:', oldLineNumber: 1, newLineNumber: 1 },
    { type: 'remove', text: 'You are a helpful assistant.', oldLineNumber: 2, newLineNumber: null },
    { type: 'add', text: 'You are a concise assistant.', oldLineNumber: null, newLineNumber: 2 },
  ],
  stats: { added: 1, removed: 1, unchanged: 1 },
};

beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  actor.perms.clear();
  actor.isPrimary = false;
  actor.userId = 1;

  vi.mocked(promptsApi.fetchSystemPromptVariables).mockResolvedValue({
    variables: [...promptsApi.SYSTEM_PROMPT_VARIABLES],
  });
  vi.mocked(promptsApi.fetchPromptProfileOptions).mockResolvedValue([
    { id: 1, name: 'Default Profile' },
    { id: 2, name: 'Support Key' },
  ]);
  vi.mocked(promptsApi.fetchPromptSupportTenantOptions).mockResolvedValue([
    { id: '10', name: 'Acme Support' },
  ]);
  vi.mocked(promptsApi.fetchPromptScopeState).mockResolvedValue(makeScopeState());
  vi.mocked(promptsApi.fetchPromptVersion).mockResolvedValue({
    version: {
      id: 1,
      scopeKind: 'profile',
      scopeId: '1',
      version: 1,
      body: 'You are a helpful assistant for {{profile_name}}.',
      variables: [],
      note: 'Initial backfill',
      status: 'published',
      restoredFrom: null,
      authorId: null,
      createdAt: '2026-11-15 09:00:00',
    },
  });
  vi.mocked(promptsApi.fetchPromptDiff).mockResolvedValue(SAMPLE_DIFF);
  vi.mocked(promptsApi.savePromptDraft).mockResolvedValue({
    version: makeScopeState().draft!,
    head: { scopeKind: 'profile', scopeId: '1', publishedVersion: 1, draftVersion: 2, revision: 4 },
  });
  vi.mocked(promptsApi.discardPromptDraft).mockResolvedValue({
    head: { scopeKind: 'profile', scopeId: '1', publishedVersion: 1, draftVersion: null, revision: 4 },
  });
  vi.mocked(promptsApi.publishPrompt).mockResolvedValue({
    head: { scopeKind: 'profile', scopeId: '1', publishedVersion: 2, draftVersion: null, revision: 4 },
  });
  vi.mocked(promptsApi.restorePromptVersion).mockResolvedValue({
    head: { scopeKind: 'profile', scopeId: '1', publishedVersion: 3, draftVersion: null, revision: 4 },
  });
  vi.mocked(promptsApi.previewPrompt).mockResolvedValue({
    rendered: 'You are a concise assistant for Default Profile.',
    missing: [],
  });
  vi.mocked(promptsApi.tryPrompt).mockResolvedValue({
    reply: 'Hello! How can I help?',
    rendered: 'You are a concise assistant for Default Profile.',
    missing: [],
    model: 'gpt-4o-mini',
    usage: { prompt_tokens: 18, completion_tokens: 6, total_tokens: 24 },
  });

  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  qc.clear();
  container.remove();
  vi.clearAllMocks();
});

describe('Prompts i18n strings', () => {
  it('provides Vietnamese translations with matching placeholders for every prompts-strings constant', () => {
    const missing: string[] = [];
    for (const [name, value] of Object.entries(promptsStrings)) {
      if (typeof value !== 'string') continue;
      expect(value.trim().length, `${name} must not be empty`).toBeGreaterThan(0);
      if (!(value in VI)) {
        missing.push(`${name}: "${value}"`);
      } else {
        const known = new Set([...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
        for (const m of VI[value].matchAll(/\{(\w+)\}/g)) {
          expect(known.has(m[1]), `Unknown placeholder {${m[1]}} in VI["${value}"]`).toBe(true);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('Prompts RBAC & AiPlatformApp routing', () => {
  it('shows no-permission notice and fires zero requests when user has no prompt permissions', async () => {
    renderEl(<Prompts />);
    await flush();

    expect(container.querySelector('[data-testid="prompts-no-permission"]')).not.toBeNull();
    expect(promptsApi.fetchPromptScopeState).not.toHaveBeenCalled();
    expect(promptsApi.fetchSystemPromptVariables).not.toHaveBeenCalled();
    expect(promptsApi.fetchPromptProfileOptions).not.toHaveBeenCalled();
    expect(promptsApi.fetchPromptSupportTenantOptions).not.toHaveBeenCalled();
  });

  it('does NOT grant prompts access to manage_ai_platform alone', async () => {
    actor.perms.add('manage_ai_platform');
    renderEl(
      <MemoryRouter initialEntries={['/ai-platform/prompts']}>
        <Routes><Route path="/ai-platform/*" element={<AiPlatformApp />} /></Routes>
      </MemoryRouter>,
    );
    await flush();

    expect(container.querySelector('[data-testid="prompts-page"]')).toBeNull();
    expect(promptsApi.fetchPromptScopeState).not.toHaveBeenCalled();
  });

  it('locks edit, preview, try, publish, and restore controls for view_prompts-only user', async () => {
    actor.perms.add('view_prompts');
    renderEl(
      <MemoryRouter initialEntries={['/ai-platform/prompts']}>
        <Routes><Route path="/ai-platform/*" element={<AiPlatformApp />} /></Routes>
      </MemoryRouter>,
    );
    await flush();

    expect(container.querySelector('[data-testid="prompts-page"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="prompts-view-only-notice"]')).not.toBeNull();
    expect(promptsApi.fetchPromptScopeState).toHaveBeenCalledWith(
      { kind: 'profile', id: '1' },
      expect.any(AbortSignal),
    );

    const bodyInput = container.querySelector('[data-testid="prompts-body-input"]') as HTMLTextAreaElement;
    const saveBtn = container.querySelector('[data-testid="prompts-save-draft-btn"]') as HTMLButtonElement;
    const discardBtn = container.querySelector('[data-testid="prompts-discard-draft-btn"]') as HTMLButtonElement;
    const publishBtn = container.querySelector('[data-testid="prompts-publish-btn"]') as HTMLButtonElement;
    const previewBtn = container.querySelector('[data-testid="prompts-preview-btn"]') as HTMLButtonElement;
    const tryBtn = container.querySelector('[data-testid="prompts-try-btn"]') as HTMLButtonElement;
    const restoreBtn = container.querySelector('[data-testid="prompts-restore-version-1"]') as HTMLButtonElement;

    expect(bodyInput.disabled).toBe(true);
    expect(saveBtn.disabled).toBe(true);
    expect(discardBtn.disabled).toBe(true);
    expect(publishBtn.disabled).toBe(true);
    expect(previewBtn.disabled).toBe(true);
    expect(tryBtn.disabled).toBe(true);
    expect(restoreBtn.disabled).toBe(true);
  });

  it('fires zero GET requests for edit_prompts-only user and disables publish', async () => {
    actor.perms.add('edit_prompts');
    renderEl(
      <MemoryRouter initialEntries={['/ai-platform']}>
        <Routes><Route path="/ai-platform/*" element={<AiPlatformApp />} /></Routes>
      </MemoryRouter>,
    );
    await flush();

    expect(container.querySelector('[data-testid="prompts-page"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="prompts-editor-only-notice"]')).not.toBeNull();
    expect(promptsApi.fetchPromptScopeState).not.toHaveBeenCalled();
    expect(promptsApi.fetchSystemPromptVariables).not.toHaveBeenCalled();
    expect(promptsApi.fetchPromptDiff).not.toHaveBeenCalled();
    expect(promptsApi.fetchPromptProfileOptions).not.toHaveBeenCalled();

    const saveBtn = container.querySelector('[data-testid="prompts-save-draft-btn"]') as HTMLButtonElement;
    const publishBtn = container.querySelector('[data-testid="prompts-publish-btn"]') as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(false);
    expect(publishBtn.disabled).toBe(true);
  });

  it('hides/disables publish & restore when user has view_prompts + edit_prompts without publish_prompts', async () => {
    actor.perms.add('view_prompts');
    actor.perms.add('edit_prompts');
    renderEl(<Prompts />);
    await flush();

    expect(container.querySelector('[data-testid="prompts-no-publish-notice"]')).not.toBeNull();
    const saveBtn = container.querySelector('[data-testid="prompts-save-draft-btn"]') as HTMLButtonElement;
    const publishBtn = container.querySelector('[data-testid="prompts-publish-btn"]') as HTMLButtonElement;
    const restoreBtn = container.querySelector('[data-testid="prompts-restore-version-1"]') as HTMLButtonElement;

    expect(saveBtn.disabled).toBe(false);
    expect(publishBtn.disabled).toBe(true);
    expect(restoreBtn.disabled).toBe(true);
  });
});

describe('Scope switching, Draft workflow, 422, 409, and pruned notice', () => {
  it('switches between profile and support_tenant scopes', async () => {
    actor.perms.add('view_prompts');
    actor.perms.add('edit_prompts');
    renderEl(<Prompts />);
    await flush();

    const kindSelect = container.querySelector('[data-testid="prompts-scope-kind-select"]') as HTMLSelectElement;
    act(() => {
      setSelectValue(kindSelect, 'support_tenant');
    });
    await flush();

    expect(promptsApi.fetchPromptScopeState).toHaveBeenLastCalledWith(
      { kind: 'support_tenant', id: '10' },
      expect.any(AbortSignal),
    );
  });

  it('displays pruned-history notice when prunedCount > 0', async () => {
    actor.perms.add('view_prompts');
    vi.mocked(promptsApi.fetchPromptScopeState).mockResolvedValueOnce(
      makeScopeState({ prunedCount: 4 }),
    );
    renderEl(<Prompts />);
    await flush();

    const notice = container.querySelector('[data-testid="prompts-pruned-notice"]');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain('4');
  });

  it('saves draft, displays 422 line/column error, handles 409 conflict banner + reload, discards & publishes', async () => {
    actor.perms.add('view_prompts');
    actor.perms.add('edit_prompts');
    actor.perms.add('publish_prompts');
    renderEl(<Prompts />);
    await flush();

    const bodyInput = container.querySelector('[data-testid="prompts-body-input"]') as HTMLTextAreaElement;
    const noteInput = container.querySelector('[data-testid="prompts-note-input"]') as HTMLInputElement;
    const saveBtn = container.querySelector('[data-testid="prompts-save-draft-btn"]') as HTMLButtonElement;

    // 422 validation error with line & column
    vi.mocked(promptsApi.savePromptDraft).mockRejectedValueOnce(
      new promptsApi.PromptsApiError('Invalid template', {
        status: 422,
        code: 'invalid_template',
        line: 3,
        column: 14,
        reason: 'Undeclared variable {{unknown_var}}',
      }),
    );

    act(() => {
      setInputValue(bodyInput, 'Line 1\nLine 2\nHello {{unknown_var}}');
      setInputValue(noteInput, 'Test note');
    });
    act(() => {
      saveBtn.click();
    });
    await flush();

    const valErr = container.querySelector('[data-testid="prompts-validation-error"]');
    expect(valErr).not.toBeNull();
    expect(valErr?.textContent).toContain('3');
    expect(valErr?.textContent).toContain('14');
    expect(valErr?.textContent).toContain('Undeclared variable {{unknown_var}}');

    // 409 revision_conflict banner + reload
    vi.mocked(promptsApi.savePromptDraft).mockRejectedValueOnce(
      new promptsApi.PromptsApiError('Revision conflict', {
        status: 409,
        code: 'revision_conflict',
      }),
    );
    act(() => {
      saveBtn.click();
    });
    await flush();

    expect(container.querySelector('[data-testid="prompts-conflict-banner"]')).not.toBeNull();
    const reloadBtn = container.querySelector('[data-testid="prompts-conflict-reload-btn"]') as HTMLButtonElement;
    const callsBeforeReload = vi.mocked(promptsApi.fetchPromptScopeState).mock.calls.length;
    act(() => {
      reloadBtn.click();
    });
    await flush();
    expect(vi.mocked(promptsApi.fetchPromptScopeState).mock.calls.length).toBeGreaterThan(callsBeforeReload);
    expect(container.querySelector('[data-testid="prompts-conflict-banner"]')).toBeNull();

    // Save draft success
    act(() => {
      setInputValue(bodyInput, 'Updated prompt for {{profile_name}}');
      setInputValue(noteInput, 'Updated note');
    });
    act(() => {
      saveBtn.click();
    });
    await flush();

    expect(promptsApi.savePromptDraft).toHaveBeenLastCalledWith(
      { kind: 'profile', id: '1' },
      expect.objectContaining({
        body: 'Updated prompt for {{profile_name}}',
        note: 'Updated note',
        revision: 3,
      }),
      expect.any(AbortSignal),
    );
    expect(container.querySelector('[data-testid="prompts-action-success"]')).not.toBeNull();

    // Publish
    const publishBtn = container.querySelector('[data-testid="prompts-publish-btn"]') as HTMLButtonElement;
    act(() => {
      publishBtn.click();
    });
    await flush();
    expect(promptsApi.publishPrompt).toHaveBeenCalledWith(
      { kind: 'profile', id: '1' },
      { revision: 3 },
      expect.any(AbortSignal),
    );

    // Discard draft
    const discardBtn = container.querySelector('[data-testid="prompts-discard-draft-btn"]') as HTMLButtonElement;
    act(() => {
      discardBtn.click();
    });
    await flush();
    expect(promptsApi.discardPromptDraft).toHaveBeenCalledWith(
      { kind: 'profile', id: '1' },
      3,
      expect.any(AbortSignal),
    );
  });
});

describe('VariableEditor & cache-prefix stability warning (T113)', () => {
  it('shows read-only system catalog, enforces var regex, and toggles cache-prefix warning on dynamic vars', async () => {
    actor.perms.add('view_prompts');
    actor.perms.add('edit_prompts');
    vi.mocked(promptsApi.fetchPromptScopeState).mockResolvedValueOnce(
      makeScopeState({
        draft: null,
        published: {
          id: 1,
          scopeKind: 'profile',
          scopeId: '1',
          version: 1,
          body: 'Static prompt for {{profile_name}}',
          variables: [],
          note: 'Init',
          status: 'published',
          restoredFrom: null,
          authorId: null,
          createdAt: '2026-11-15 09:00:00',
        },
        head: {
          scopeKind: 'profile',
          scopeId: '1',
          publishedVersion: 1,
          draftVersion: null,
          revision: 1,
        },
      }),
    );

    renderEl(<Prompts />);
    await flush();

    // Read-only system catalog includes all 5 system variables
    const sysTable = container.querySelector('[data-testid="prompt-system-variables"]');
    expect(sysTable?.textContent).toContain('{{date}}');
    expect(sysTable?.textContent).toContain('{{profile_name}}');
    expect(sysTable?.textContent).toContain('{{end_user_id}}');
    expect(sysTable?.textContent).toContain('{{end_user_name}}');
    expect(sysTable?.textContent).toContain('{{language}}');

    // Static {{profile_name}} alone MUST NOT trigger cache-prefix warning
    expect(container.querySelector('[data-testid="prompt-cache-prefix-warning"]')).toBeNull();

    // Adding {{date}} triggers cache-prefix stability warning
    const bodyInput = container.querySelector('[data-testid="prompts-body-input"]') as HTMLTextAreaElement;
    act(() => {
      setInputValue(bodyInput, 'Today is {{date}}');
    });
    const warnWithDate = container.querySelector('[data-testid="prompt-cache-prefix-warning"]');
    expect(warnWithDate).not.toBeNull();
    expect(warnWithDate?.textContent).toContain('{{date}}');

    // Removing {{date}} clears warning
    act(() => {
      setInputValue(bodyInput, 'Hello {{tenant_brand}}');
    });
    expect(container.querySelector('[data-testid="prompt-cache-prefix-warning"]')).toBeNull();

    // Regex validation on variable name
    const nameInput = container.querySelector('[data-testid="prompt-var-name-input"]') as HTMLInputElement;
    const sourceSelect = container.querySelector('[data-testid="prompt-var-source-select"]') as HTMLSelectElement;
    const defaultInput = container.querySelector('[data-testid="prompt-var-default-input"]') as HTMLInputElement;
    const addBtn = container.querySelector('[data-testid="prompt-var-add-btn"]') as HTMLButtonElement;

    act(() => {
      setInputValue(nameInput, 'Bad-Name!');
    });
    act(() => {
      addBtn.click();
    });
    expect(container.querySelector('[data-testid="prompt-var-error"]')).not.toBeNull();

    // System variable name cannot be overridden
    act(() => {
      setInputValue(nameInput, 'date');
    });
    act(() => {
      addBtn.click();
    });
    expect(container.querySelector('[data-testid="prompt-var-error"]')?.textContent).toContain('date');

    // Add valid caller variable -> triggers cache-prefix warning because {{tenant_brand}} is in body
    act(() => {
      setInputValue(nameInput, 'tenant_brand');
      setSelectValue(sourceSelect, 'caller');
      setInputValue(defaultInput, 'Acme');
    });
    act(() => {
      addBtn.click();
    });

    expect(container.querySelector('[data-testid="prompt-declared-var-tenant_brand"]')).not.toBeNull();
    const warnWithCaller = container.querySelector('[data-testid="prompt-cache-prefix-warning"]');
    expect(warnWithCaller).not.toBeNull();
    expect(warnWithCaller?.textContent).toContain('{{tenant_brand}}');

    // Switch that variable source to custom -> warning disappears (custom defaults are static)
    const rowSourceSelect = container.querySelector('[data-testid="prompt-var-source-tenant_brand"]') as HTMLSelectElement;
    act(() => {
      setSelectValue(rowSourceSelect, 'custom');
    });
    expect(container.querySelector('[data-testid="prompt-cache-prefix-warning"]')).toBeNull();
  });
});

describe('Version history, DiffView, Preview & Try Draft', () => {
  it('renders version history with restoredFrom badge, views full version, compares in DiffView, and restores', async () => {
    actor.perms.add('view_prompts');
    actor.perms.add('edit_prompts');
    actor.perms.add('publish_prompts');

    vi.mocked(promptsApi.fetchPromptScopeState).mockResolvedValue(
      makeScopeState({
        versions: [
          {
            id: 3,
            scopeKind: 'profile',
            scopeId: '1',
            version: 3,
            variables: [],
            note: 'Restored earlier prompt',
            status: 'published',
            restoredFrom: 1,
            authorId: 5,
            createdAt: '2026-11-16 11:00:00',
          },
          {
            id: 2,
            scopeKind: 'profile',
            scopeId: '1',
            version: 2,
            variables: [],
            note: 'Old experiment',
            status: 'archived',
            restoredFrom: null,
            authorId: 7,
            createdAt: '2026-11-16 10:00:00',
          },
          {
            id: 1,
            scopeKind: 'profile',
            scopeId: '1',
            version: 1,
            variables: [],
            note: 'Initial backfill',
            status: 'archived',
            restoredFrom: null,
            authorId: null,
            createdAt: '2026-11-15 09:00:00',
          },
        ],
        head: {
          scopeKind: 'profile',
          scopeId: '1',
          publishedVersion: 3,
          draftVersion: null,
          revision: 4,
        },
      }),
    );

    renderEl(<Prompts />);
    await flush();

    // restoredFrom badge
    expect(container.querySelector('[data-testid="prompts-restored-from-3"]')?.textContent).toContain('v1');

    // DiffView renders stats, metadata, and +/- lines
    expect(container.querySelector('[data-testid="prompt-diff-stats"]')?.textContent).toContain('+1');
    expect(container.querySelector('[data-testid="prompt-diff-stats"]')?.textContent).toContain('-1');
    const diffLines = container.querySelector('[data-testid="prompt-diff-lines"]');
    expect(diffLines?.textContent).toContain('You are a helpful assistant.');
    expect(diffLines?.textContent).toContain('You are a concise assistant.');

    // View full version
    const viewBtn = container.querySelector('[data-testid="prompts-view-version-1"]') as HTMLButtonElement;
    act(() => {
      viewBtn.click();
    });
    await flush();
    expect(promptsApi.fetchPromptVersion).toHaveBeenCalledWith(
      { kind: 'profile', id: '1' },
      1,
      expect.any(AbortSignal),
    );
    expect(container.querySelector('[data-testid="prompts-version-detail"]')?.textContent).toContain(
      'You are a helpful assistant for {{profile_name}}.',
    );

    // Compare button updates diff from/to
    const compareBtn = container.querySelector('[data-testid="prompts-compare-version-2"]') as HTMLButtonElement;
    act(() => {
      compareBtn.click();
    });
    await flush();
    expect(promptsApi.fetchPromptDiff).toHaveBeenLastCalledWith(
      { kind: 'profile', id: '1' },
      2,
      3,
      expect.any(AbortSignal),
    );

    // Restore archived version v1 with confirmation
    const restoreBtn = container.querySelector('[data-testid="prompts-restore-version-1"]') as HTMLButtonElement;
    act(() => {
      restoreBtn.click();
    });
    const confirmBtn = container.querySelector('[data-testid="prompts-restore-confirm-btn"]') as HTMLButtonElement;
    expect(confirmBtn).not.toBeNull();
    act(() => {
      confirmBtn.click();
    });
    await flush();
    expect(promptsApi.restorePromptVersion).toHaveBeenCalledWith(
      { kind: 'profile', id: '1' },
      { version: 1, revision: 4 },
      expect.any(AbortSignal),
    );
  });

  it('previews with sample values + missing highlights and handles Try Draft + 409 pillar_disabled', async () => {
    actor.perms.add('view_prompts');
    actor.perms.add('edit_prompts');
    renderEl(<Prompts />);
    await flush();

    vi.mocked(promptsApi.previewPrompt).mockResolvedValueOnce({
      rendered: 'Hello Default Profile, missing !',
      missing: ['customer_tier'],
    });

    const sampleInput = container.querySelector('[data-testid="prompts-sample-val-profile_name"]') as HTMLInputElement;
    act(() => {
      setInputValue(sampleInput, 'Default Profile');
    });
    const previewBtn = container.querySelector('[data-testid="prompts-preview-btn"]') as HTMLButtonElement;
    act(() => {
      previewBtn.click();
    });
    await flush();

    expect(container.querySelector('[data-testid="prompts-preview-rendered"]')?.textContent).toContain(
      'Hello Default Profile',
    );
    expect(container.querySelector('[data-testid="prompts-preview-missing"]')?.textContent).toContain(
      '{{customer_tier}}',
    );

    // Quota note visible
    expect(container.querySelector('[data-testid="prompts-try-quota-note"]')?.textContent).toMatch(
      /do not charge client key quotas/i,
    );

    // Try Draft 409 pillar_disabled
    vi.mocked(promptsApi.tryPrompt).mockRejectedValueOnce(
      new promptsApi.PromptsApiError('Pillar disabled', {
        status: 409,
        code: 'pillar_disabled',
      }),
    );

    const tryMsgInput = container.querySelector('[data-testid="prompts-try-message-input"]') as HTMLTextAreaElement;
    const tryModelInput = container.querySelector('[data-testid="prompts-try-model-input"]') as HTMLInputElement;
    const tryBtn = container.querySelector('[data-testid="prompts-try-btn"]') as HTMLButtonElement;

    act(() => {
      setInputValue(tryMsgInput, 'Hi there');
      setInputValue(tryModelInput, 'gpt-4o-mini');
    });
    act(() => {
      tryBtn.click();
    });
    await flush();

    expect(container.querySelector('[data-testid="prompts-try-error"]')?.textContent).toContain('409');

    // Try Draft success
    act(() => {
      tryBtn.click();
    });
    await flush();

    expect(promptsApi.tryPrompt).toHaveBeenLastCalledWith(
      { kind: 'profile', id: '1' },
      expect.objectContaining({
        message: 'Hi there',
        model: 'gpt-4o-mini',
      }),
      expect.any(AbortSignal),
    );
    expect(container.querySelector('[data-testid="prompts-try-reply"]')?.textContent).toContain(
      'Hello! How can I help?',
    );
    expect(container.querySelector('[data-testid="prompts-try-usage"]')?.textContent).toContain('24');
  });
});

describe('Prompts abort & session isolation', () => {
  it('aborts in-flight requests on unmount and ignores stale resolves after session change', async () => {
    actor.perms.add('view_prompts');
    actor.perms.add('edit_prompts');

    let resolveLate!: (val: promptsApi.PromptScopeStateResponse) => void;
    vi.mocked(promptsApi.fetchPromptScopeState).mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveLate = resolve;
      }),
    );

    renderEl(<Prompts />);
    await flush();

    const firstSignal = vi.mocked(promptsApi.fetchPromptScopeState).mock.calls[0][1]!;
    expect(firstSignal.aborted).toBe(false);

    // Session switch aborts first request and loads second session cleanly
    actor.userId = 2;
    vi.mocked(promptsApi.fetchPromptScopeState).mockResolvedValueOnce(
      makeScopeState({
        draft: {
          id: 9,
          scopeKind: 'profile',
          scopeId: '1',
          version: 9,
          body: 'Session 2 prompt',
          variables: [],
          note: 'S2',
          status: 'draft',
          restoredFrom: null,
          authorId: 2,
          createdAt: '2026-11-16 12:00:00',
        },
      }),
    );
    renderEl(<Prompts />);
    await flush();

    expect(firstSignal.aborted).toBe(true);
    const bodyInput = container.querySelector('[data-testid="prompts-body-input"]') as HTMLTextAreaElement;
    expect(bodyInput.value).toBe('Session 2 prompt');

    // Late resolution from session 1 must NOT overwrite session 2
    await act(async () => {
      resolveLate(
        makeScopeState({
          draft: {
            id: 5,
            scopeKind: 'profile',
            scopeId: '1',
            version: 5,
            body: 'Stale Session 1 prompt',
            variables: [],
            note: 'S1',
            status: 'draft',
            restoredFrom: null,
            authorId: 1,
            createdAt: '2026-11-16 08:00:00',
          },
        }),
      );
    });
    await flush();
    expect(bodyInput.value).toBe('Session 2 prompt');

    // Unmount aborts in-flight mutation
    let pendingSaveSignal: AbortSignal | undefined;
    vi.mocked(promptsApi.savePromptDraft).mockImplementationOnce((_scope, _input, signal) => {
      pendingSaveSignal = signal;
      return new Promise(() => {});
    });
    const saveBtn = container.querySelector('[data-testid="prompts-save-draft-btn"]') as HTMLButtonElement;
    act(() => {
      saveBtn.click();
    });
    expect(pendingSaveSignal?.aborted).toBe(false);

    act(() => {
      root.unmount();
    });
    expect(pendingSaveSignal?.aborted).toBe(true);
    root = createRoot(container);
  });
});
