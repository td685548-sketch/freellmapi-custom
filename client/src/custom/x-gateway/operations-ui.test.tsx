// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/api';
import CLITools from './pages/CLIOperations';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
const sessionState = vi.hoisted(() => ({ revision: 1 }));
vi.mock('@/i18n', () => ({ useI18n: () => ({ locale: 'en' }) }));
vi.mock('../use-session', () => ({
  useUserSession: () => ({
    hasPermission: (_p: string) => true,
    session: { email: 'admin@example.com' },
  }),
}));
vi.mock('../session-state', () => ({ useSessionRevision: () => sessionState.revision }));

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

beforeEach(() => {
  sessionState.revision = 1;
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  vi.mocked(apiFetch).mockImplementation(async (url: string) => {
    if (url === '/api/x-gateway/tools/diagnostics') return {
      checkedAt: new Date().toISOString(), evidenceTtlSeconds: 300,
      capabilities: [{ id: 'providers', state: 'configured', detail: 'Live test required.' }],
      deployment: { database: 'sqlite', persistence: 'operator-verification-required', publicBaseConfigured: false, encryptionKeyConfigured: true },
    };
    if (url === '/api/x-gateway/playground/models') return { models: [{ id: 'auto', name: 'Auto' }] };
    if (url.includes('/api/x-gateway/keys')) {
      return {
        keys: [
          {
            id: 1,
            userId: 1,
            name: 'Primary Key',
            keyPrefix: 'sk-xgw-abc1',
            rpmLimit: 60,
            revoked: false,
            createdAt: '2026-11-07T00:00:00Z',
            lastUsedAt: null,
          },
        ],
      };
    }
    if (url.includes('/api/x-gateway/tools')) {
      return {
        enabled: true,
        usableAccounts: 2,
        tools: [
          { id: 'claude', name: 'Claude Code', protocol: 'anthropic-messages' },
          { id: 'codex', name: 'OpenAI Codex CLI', protocol: 'openai-responses' },
        ],
      };
    }
    return {};
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
});

async function renderView() {
  await act(async () => {
    root.render(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <CLITools />
        </QueryClientProvider>
      </MemoryRouter>
    );
  });
}

describe('CLITools component', () => {
  it('renders title, key selector and tools directory', async () => {
    await renderView();
    expect(container.textContent).toContain('CLI Tools & IDE Setup');
    expect(container.textContent).toContain('Claude Code');
    expect(container.textContent).toContain('OpenAI Codex CLI');
    expect(container.textContent).toContain('Cursor IDE');
  });

  it('generates bash export snippet with active key and url', async () => {
    await renderView();
    expect(container.textContent).toContain('export ANTHROPIC_BASE_URL=');
    expect(container.textContent).toContain('export ANTHROPIC_API_KEY=');
  });

  it('switches shell tabs to PowerShell and updates syntax', async () => {
    await renderView();
    const psBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('PowerShell')
    );
    expect(psBtn).toBeDefined();
    await act(async () => {
      psBtn?.click();
    });
    expect(container.textContent).toContain('$env:ANTHROPIC_BASE_URL =');
    expect(container.textContent).toContain('$env:ANTHROPIC_API_KEY =');
  });

  it('requires a full key and sends the selected key/model to the inference probe', async () => {
    await renderView();
    const test = Array.from(container.querySelectorAll('button')).find(b => /Test Connection/i.test(b.textContent ?? ''))!;
    expect(test.disabled).toBe(true);
    const enter = (input: HTMLInputElement, value: string) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    await act(async () => {
      enter(container.querySelector('[aria-label="Full API key"]')!, 'sk-xgw-real-full-test');
      enter(container.querySelector('[aria-label="Test model"]')!, 'combo:coding');
    });
    await act(async () => test.click());
    const call = vi.mocked(apiFetch).mock.calls.find(([url]) => url === '/api/x-gateway/tools/test');
    expect(call).toBeDefined();
    expect(JSON.parse(call![1]!.body as string)).toEqual({ toolId: 'claude', key: 'sk-xgw-real-full-test', model: 'combo:coding' });
    expect(container.textContent).not.toContain('[full-key]');
  });
  it('clears in-memory credentials when the console session changes', async () => {
    await renderView();
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>('[aria-label="Full API key"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'sk-xgw-prior-session');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    sessionState.revision++;
    await renderView();
    expect(container.querySelector<HTMLInputElement>('[aria-label="Full API key"]')!.value).toBe('');
    expect(container.textContent).not.toContain('sk-xgw-prior-session');
  });
});
