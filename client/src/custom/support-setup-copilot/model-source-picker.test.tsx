// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CopilotModelSourceResponse } from '../../../../shared/support-setup-copilot';
import { ModelSourcePicker } from './ModelSourcePicker';
import { getSupportSetupCopilotStrings } from './strings';

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

async function flush() {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

function mount(locale: 'vi' | 'en' = 'vi', enabled = true) {
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <ModelSourcePicker s={getSupportSetupCopilotStrings(locale)} enabled={enabled} />
      </QueryClientProvider>,
    );
  });
}

const state = (over: Partial<CopilotModelSourceResponse> = {}): CopilotModelSourceResponse => ({
  ok: true, source: 'both', canEdit: true, available: { thruline: true, freellmapi: true }, ...over,
});

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const select = () => container.querySelector('#ssc-model-source-select') as HTMLSelectElement;

describe('ModelSourcePicker', () => {
  it('offers the three sources and shows the current one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(state({ source: 'freellmapi' }))));
    mount('vi');
    await flush();
    expect([...select().options].map((o) => o.value)).toEqual(['both', 'thruline', 'freellmapi']);
    expect(select().value).toBe('freellmapi');
    expect(container.textContent).toContain('Chỉ mô hình của FreeLLMAPI');
    expect(container.textContent).toContain('Mô hình');
  });

  it('saves a new choice with PUT and shows what the server answered', async () => {
    const puts: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body));
        puts.push(body);
        return json(state({ source: body.source }));
      }
      return json(state());
    }));
    mount('en');
    await flush();
    const el = select();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
      setter?.call(el, 'thruline');
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    expect(puts).toEqual([{ source: 'thruline' }]);
    expect(select().value).toBe('thruline');
  });

  it('is read-only for an account without edit_settings', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(state({ canEdit: false }))));
    mount('en');
    await flush();
    expect(select().disabled).toBe(true);
    expect(select().title).toContain('edit_settings');
  });

  it('warns when the chosen source has nothing connected, and not otherwise', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(state({ source: 'thruline', available: { thruline: false, freellmapi: true } }))));
    mount('vi');
    await flush();
    expect(container.querySelector('[data-testid="support-setup-model-source-warning"]')?.textContent).toContain('Chưa nối tài khoản nhà cung cấp');

    act(() => root.unmount());
    root = createRoot(container);
    client.clear();
    vi.stubGlobal('fetch', vi.fn(async () => json(state({ source: 'both', available: { thruline: false, freellmapi: true } }))));
    mount('vi');
    await flush();
    expect(container.querySelector('[data-testid="support-setup-model-source-warning"]')).toBeNull(); // one source is enough for "both"
  });

  it('renders nothing while disabled or when the answer is not a model-source payload', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({})));
    mount('vi', true);
    await flush();
    expect(container.querySelector('[data-testid="support-setup-model-source"]')).toBeNull();
    act(() => root.unmount());
    root = createRoot(container);
    mount('vi', false);
    await flush();
    expect(container.querySelector('[data-testid="support-setup-model-source"]')).toBeNull();
  });
});
