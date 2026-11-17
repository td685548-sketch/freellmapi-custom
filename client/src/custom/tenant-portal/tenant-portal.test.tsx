// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n';
import { VI } from '../i18n/vi';
import {
  TENANT_PERMISSION_GROUPS,
  TENANT_ROLE_PRESET_META,
  type TenantPermission,
} from '../../../../shared/tenant-rbac';
import { TenantMembersTab } from './TenantMembersTab';
import { TenantPortalApp } from './TenantPortalApp';

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

async function flush() {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function mount(node: React.ReactNode) {
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <I18nProvider initialLocale="en">
          <MemoryRouter>{node}</MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
}

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
});

afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Tenant Admin Portal UI & Translations', () => {
  it('translates every tc() string in tenant-portal, TenantAccessDialog, and shared tenant RBAC metadata into Vietnamese', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const files = [
      ...readdirSync(here)
        .filter((f) => f.endsWith('.tsx') && !f.includes('.test.'))
        .map((f) => path.join(here, f)),
      path.resolve(here, '..', 'TenantAccessDialog.tsx'),
    ];
    const literal = /\btc\(\s*'((?:[^'\\]|\\.)*)'/g;
    const unescape = (s: string) => s.replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c));
    const missing: string[] = [];

    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      for (const match of src.matchAll(literal)) {
        const key = unescape(match[1]!);
        if (/\p{L}{2,}/u.test(key) && !(key in VI)) {
          missing.push(key);
        }
      }
    }

    for (const group of TENANT_PERMISSION_GROUPS) {
      if (!(group.title in VI)) missing.push(group.title);
      if (!(group.description in VI)) missing.push(group.description);
      for (const child of group.children) {
        if (!(child.title in VI)) missing.push(child.title);
        if (!(child.description in VI)) missing.push(child.description);
      }
    }

    for (const preset of TENANT_ROLE_PRESET_META) {
      if (!(preset.title in VI)) missing.push(preset.title);
      if (!(preset.description in VI)) missing.push(preset.description);
    }

    const tabLabels = [
      'AI & Prompt',
      'Knowledge & RAG',
      'Tools & Data',
      'Guardrails & Output',
      'Widget & Service Desk',
      'Integration & Keys',
      'Team & Permissions',
      'Analytics & Audit',
    ];
    for (const label of tabLabels) {
      if (!(label in VI)) missing.push(label);
    }

    expect(missing).toEqual([]);
  });

  it('renders only permitted tabs for a Support Operator and locks read-only AI configuration fields', async () => {
    const operatorPerms: TenantPermission[] = [
      'view_tenant_ai',
      'test_tenant_ai',
      'view_tenant_knowledge',
      'tenant_desk',
      'view_tenant_analytics',
    ];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        const u = String(url);
        if (u.endsWith('/api/tenant-portal/tenants')) {
          return json({
            tenants: [
              {
                id: 1,
                name: 'Acme Support',
                slug: 'acme-support',
                publicKey: 'pk_sup_123',
                defaultModel: 'auto',
                enabled: true,
                allowGuest: true,
                rolePreset: 'support_operator',
                permissions: operatorPerms,
                isPlatformOperator: false,
              },
            ],
            availableModels: [{ id: 'auto', label: 'Auto (Recommended)', description: 'Auto routing' }],
          });
        }
        if (u.endsWith('/api/tenant-portal/tenants/1')) {
          return json({
            tenant: {
              id: 1,
              name: 'Acme Support',
              slug: 'acme-support',
              publicKey: 'pk_sup_123',
              signingSecretMasked: 'sk_sup_***123',
              defaultModel: 'auto',
              systemPrompt: 'Help Acme customers.',
              allowedOrigins: [],
              allowGuest: true,
              rolesConfig: [{ role: 'customer', label: 'Customer', permissions: ['products:read'] }],
              enabled: true,
              createdAt: '2026-11-18T00:00:00.000Z',
              updatedAt: '2026-11-18T00:00:00.000Z',
            },
            rolePreset: 'support_operator',
            permissions: operatorPerms,
            isPlatformOperator: false,
            availableModels: [{ id: 'auto', label: 'Auto (Recommended)', description: 'Auto routing' }],
          });
        }
        return json({});
      }),
    );

    mount(<TenantPortalApp />);
    await flush();

    const text = container.textContent ?? '';
    expect(text).toContain('Acme Support');
    expect(text).toContain('AI & Prompt');
    expect(text).toContain('Knowledge & RAG');
    expect(text).toContain('Widget & Service Desk');
    expect(text).toContain('Analytics & Audit');

    // Unpermitted tabs are hidden
    expect(text).not.toContain('Tools & Data');
    expect(text).not.toContain('Guardrails & Output');
    expect(text).not.toContain('Integration & Keys');
    expect(text).not.toContain('Team & Permissions');

    // Support Operator has view_tenant_ai + test_tenant_ai, NOT edit_tenant_ai
    const nameInput = container.querySelector('#tenant-ai-name') as HTMLInputElement | null;
    expect(nameInput?.disabled).toBe(true);
    expect(text).not.toContain('Save AI Configuration');
    expect(text).toContain('Run Sandbox Test');
  });

  it('disables out-of-scope permission checkboxes when a delegated admin adds a tenant member', async () => {
    const delegatedPerms: TenantPermission[] = ['tenant_ai_config', 'tenant_members'];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        if (String(url).endsWith('/api/tenant-portal/tenants/1/members')) {
          return json({
            ok: true,
            members: [
              {
                id: 1,
                tenantId: 1,
                userId: 10,
                email: 'subadmin@example.com',
                accountRole: 'member',
                isPrimary: false,
                rolePreset: 'custom',
                permissions: delegatedPerms,
                assignedBy: 1,
                createdAt: '2026-11-18T00:00:00.000Z',
                updatedAt: '2026-11-18T00:00:00.000Z',
                isSelf: true,
              },
            ],
          });
        }
        return json({});
      }),
    );

    mount(<TenantMembersTab tenantId={1} myPermissions={delegatedPerms} />);
    await flush();

    const addBtn = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Add Team Member'),
    );
    expect(addBtn).toBeDefined();
    act(() => addBtn!.click());
    await flush();

    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();

    const checkboxes = [...(dialog?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]') ?? [])];
    const findCheckboxForLabel = (labelSubstring: string) =>
      checkboxes.find((cb) => cb.closest('label')?.textContent?.includes(labelSubstring));

    const wildcardBox = findCheckboxForLabel('Full Tenant Owner access');
    const viewAiBox = findCheckboxForLabel('View AI configuration');
    const rotateSecretBox = findCheckboxForLabel('Rotate signing secret');

    expect(wildcardBox?.disabled).toBe(true);
    expect(rotateSecretBox?.disabled).toBe(true);
    expect(viewAiBox?.disabled).toBe(false);
  });
});
