// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n';
import type {
  CopilotExecuteActionRequest,
  CopilotExecuteActionResponse,
  CopilotWhoAmIResponse,
  SupportSetupApplyResponse,
  SupportSetupChatResponse,
  SupportSetupProposal,
  SupportSetupStatusResponse,
} from '../../../../shared/support-setup-copilot';
import { SupportSetupCopilot } from './SupportSetupCopilot';

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function flush() {
  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="current-path">{location.pathname}</div>;
}

function mount(initialRoute: string, locale: 'en' | 'vi' = 'vi') {
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <I18nProvider initialLocale={locale}>
          <MemoryRouter key={initialRoute} initialEntries={[initialRoute]}>
            <LocationProbe />
            <SupportSetupCopilot />
          </MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
}

function sampleStatus(visible = true): SupportSetupStatusResponse {
  return {
    ok: true,
    visible,
    canCreateTenant: true,
    availableModels: [{ id: 'auto', label: 'Auto (Recommended)' }],
    tenants: [
      {
        id: 1,
        name: 'EXE',
        slug: 'exe',
        publicKey: 'pk_sup_exe',
        enabled: true,
        defaultModel: 'auto',
        canEditSteps: [
          'tenant_ai',
          'knowledge_masking',
          'guardrails_quotas',
          'output_controls',
          'widget_appearance',
          'sla_routing',
          'runtime_policy',
        ],
      },
    ],
    activeTenant: {
      tenant: {
        id: 1,
        name: 'EXE',
        slug: 'exe',
        publicKey: 'pk_sup_exe',
        enabled: true,
        defaultModel: 'auto',
        allowGuest: true,
        allowedOrigins: ['*'],
      },
      completedSteps: 3,
      totalSteps: 7,
      embedSnippet: '<script src="https://example.com/thruline/v1/support/widget.js"></script>',
      steps: [
        {
          stepId: 'tenant_ai',
          status: 'complete',
          canEdit: true,
          summaryEn: 'Tenant ready',
          summaryVi: 'Tenant sẵn sàng',
          thrulinePath: '/thruline/support',
          tenantPortalTab: 'tenant_ai_config',
        },
        {
          stepId: 'knowledge_masking',
          status: 'missing',
          canEdit: true,
          summaryEn: 'No knowledge docs',
          summaryVi: 'Chưa có tài liệu tri thức',
          thrulinePath: '/thruline/support-knowledge',
          tenantPortalTab: 'tenant_knowledge',
        },
        {
          stepId: 'guardrails_quotas',
          status: 'complete',
          canEdit: true,
          summaryEn: 'Guardrails ON',
          summaryVi: 'Tường lửa BẬT',
          thrulinePath: '/thruline/support-guardrails',
          tenantPortalTab: 'tenant_guardrails',
        },
        {
          stepId: 'output_controls',
          status: 'missing',
          canEdit: true,
          summaryEn: 'Output controls off',
          summaryVi: 'Kiểm soát đầu ra đang tắt',
          thrulinePath: '/thruline/support-output',
          tenantPortalTab: 'tenant_guardrails',
        },
        {
          stepId: 'widget_appearance',
          status: 'missing',
          canEdit: true,
          summaryEn: 'Widget disabled',
          summaryVi: 'Widget đang tắt',
          thrulinePath: '/thruline/support-desk',
          tenantPortalTab: 'tenant_desk',
        },
        {
          stepId: 'sla_routing',
          status: 'missing',
          canEdit: true,
          summaryEn: 'SLA disabled',
          summaryVi: 'SLA đang tắt',
          thrulinePath: '/thruline/support-desk',
          tenantPortalTab: 'tenant_desk',
        },
        {
          stepId: 'runtime_policy',
          status: 'complete',
          canEdit: true,
          summaryEn: 'Runtime configured',
          summaryVi: 'Runtime đã cấu hình',
          thrulinePath: '/thruline/support-integration',
          tenantPortalTab: 'tenant_integration',
        },
      ],
    },
    pendingProposals: [],
  };
}

function sampleProposal(): SupportSetupProposal {
  return {
    id: 'prop_demo_1',
    userId: 1,
    targetMode: 'update_tenant',
    tenantId: 1,
    tenantName: 'EXE',
    tenantSlug: 'exe',
    status: 'pending_consent',
    summary: 'Complete EXE setup plan',
    requirements: { brandName: 'EXE', primaryColor: '#2563eb' },
    createdAt: '2026-11-18T08:00:00.000Z',
    expiresAt: '2026-11-18T08:30:00.000Z',
    steps: [
      {
        stepId: 'tenant_ai',
        canApply: true,
        enabledByDefault: true,
        titleEn: 'Update Tenant & AI Persona',
        titleVi: 'Cập nhật Tenant & Nhân cách AI',
        summaryEn: 'Configure system prompt',
        summaryVi: 'Thiết lập System Prompt',
        highlightsEn: ['System prompt'],
        highlightsVi: ['System prompt'],
        payload: {},
      },
      {
        stepId: 'widget_appearance',
        canApply: true,
        enabledByDefault: true,
        titleEn: 'Customer Chat Widget',
        titleVi: 'Giao diện Widget khách hàng',
        summaryEn: 'Enable bottom-right widget',
        summaryVi: 'Bật widget hỗ trợ',
        highlightsEn: ['Enable widget'],
        highlightsVi: ['Bật widget'],
        payload: {},
      },
    ],
  };
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

describe('SupportSetupCopilot widget', () => {
  it('renders on Support/Tenant routes and hides on Playground or non-support routes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/api/user/session')) {
          return json({ userId: 1, email: 'admin@example.com', role: 'admin', isPrimary: true, permissions: ['*'] });
        }
        if (url.includes('/api/support-setup-copilot/status')) {
          return json(sampleStatus(true));
        }
        return json({});
      }),
    );

    mount('/models/chat');
    await flush();
    expect(container.querySelector('[data-testid="support-setup-copilot-launcher"]')).toBeNull();

    mount('/thruline/playground');
    await flush();
    expect(container.querySelector('[data-testid="support-setup-copilot-launcher"]')).toBeNull();

    mount('/thruline/support-guardrails');
    await flush();
    const launcher = container.querySelector('[data-testid="support-setup-copilot-launcher"]');
    expect(launcher).not.toBeNull();
    expect(launcher?.textContent).toContain('3/7');

    mount('/tenant-portal');
    await flush();
    expect(container.querySelector('[data-testid="support-setup-copilot-launcher"]')).not.toBeNull();
  });

  it('shows 7-step diagnostics and navigates between studios while staying mounted', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/api/user/session')) {
          return json({ userId: 1, email: 'admin@example.com', role: 'admin', isPrimary: true, permissions: ['*'] });
        }
        if (url.includes('/api/support-setup-copilot/status')) {
          return json(sampleStatus(true));
        }
        return json({});
      }),
    );

    mount('/thruline/support-guardrails', 'vi');
    await flush();

    const launcher = container.querySelector('[data-testid="support-setup-copilot-launcher"]') as HTMLButtonElement;
    act(() => launcher.click());
    await flush();

    expect(container.querySelector('[data-testid="support-setup-copilot-panel"]')).not.toBeNull();

    const roadmapToggle = container.querySelector('[data-testid="support-setup-roadmap-toggle"]') as HTMLButtonElement;
    act(() => roadmapToggle.click());
    await flush();

    const roadmap = container.querySelector('[data-testid="support-setup-roadmap"]');
    expect(roadmap).not.toBeNull();
    expect(roadmap?.querySelectorAll('.ssc-roadmap-item')).toHaveLength(7);

    // Click Open on step 2 (Knowledge & Evidence)
    const openButtons = roadmap?.querySelectorAll('.ssc-link-btn') as NodeListOf<HTMLButtonElement>;
    act(() => openButtons[1]!.click());
    await flush();

    expect(container.querySelector('[data-testid="current-path"]')?.textContent).toBe('/thruline/support-knowledge');
    expect(container.querySelector('[data-testid="support-setup-copilot-panel"]')).not.toBeNull();
  });

  it('shows the Copilot\'s working steps live, then keeps them collapsed under the answer', async () => {
    const enc = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const sse = (event: string, data: unknown) => enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const step = (id: string, status: 'running' | 'done', extra: Record<string, unknown> = {}) => ({
      id, kind: 'knowledge', status, titleVi: `Tra kho tri thức ${id}`, titleEn: `Searching ${id}`, ...extra,
    });
    let acceptHeader = '';

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/api/user/session')) {
          return json({ userId: 1, email: 'admin@example.com', role: 'admin', isPrimary: true, permissions: ['*'] });
        }
        if (url.includes('/api/support-setup-copilot/status')) return json(sampleStatus(true));
        if (url.endsWith('/api/support-setup-copilot/chat')) {
          acceptHeader = String((init?.headers as Record<string, string>)?.Accept ?? '');
          const body = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } });
          return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        }
        return json({});
      }),
    );

    mount('/thruline/providers', 'vi');
    await flush();
    act(() => (container.querySelector('[data-testid="support-setup-copilot-launcher"]') as HTMLButtonElement).click());
    await flush();

    const textarea = container.querySelector('.ssc-composer textarea') as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    act(() => {
      setter?.call(textarea, 'hỏi gì đó');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    act(() => (container.querySelector('[data-testid="support-setup-send-btn"]') as HTMLButtonElement).click());
    await flush();

    // Live: first step running, then updated to done while a second one starts.
    expect(acceptHeader).toContain('text/event-stream');
    await act(async () => { controller.enqueue(sse('step', step('s1', 'running'))); });
    await flush();
    const live = container.querySelector('[data-testid="support-setup-process-live"]');
    expect(live).not.toBeNull();
    expect(live!.textContent).toContain('Tra kho tri thức s1');
    expect(live!.querySelector('[data-status="running"]')).not.toBeNull();

    await act(async () => {
      controller.enqueue(sse('step', step('s1', 'done', { detailVi: '3 mục liên quan' })));
      controller.enqueue(sse('step', step('s2', 'running', { kind: 'model', titleVi: 'Hỏi mô hình AI' })));
    });
    await flush();
    const rows = container.querySelectorAll('[data-testid="support-setup-process-live"] [data-testid="support-setup-process-step"]');
    expect(rows).toHaveLength(2); // s1 was UPDATED in place, not duplicated
    expect(rows[0]!.getAttribute('data-status')).toBe('done');
    expect(rows[0]!.textContent).toContain('3 mục liên quan');

    // Finish: answer appears, live panel goes away, the steps stay as a collapsed list.
    await act(async () => {
      controller.enqueue(sse('step', step('s2', 'done')));
      controller.enqueue(sse('final', {
        status: 200,
        body: { ok: true, reply: 'Đây là câu trả lời.', intent: 'guide', missingQuestions: [], suggestedQuickReplies: [], proposal: null, modelUsed: null, usedFallback: true },
      }));
      controller.close();
    });
    await flush();
    expect(container.querySelector('[data-testid="support-setup-process-live"]')).toBeNull();
    const done = container.querySelector('[data-testid="support-setup-process-done"]') as HTMLDetailsElement | null;
    expect(done).not.toBeNull();
    expect(done!.open).toBe(false);
    expect(done!.textContent).toContain('Quá trình xử lý');
    expect(done!.textContent).toContain('(2 bước)');
    expect(container.textContent).toContain('Đây là câu trả lời.');
  });

  it('a streamed error shows its message and leaves no live panel behind', async () => {
    const enc = new TextEncoder();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/api/user/session')) {
          return json({ userId: 1, email: 'admin@example.com', role: 'admin', isPrimary: true, permissions: ['*'] });
        }
        if (url.includes('/api/support-setup-copilot/status')) return json(sampleStatus(true));
        if (url.endsWith('/api/support-setup-copilot/chat')) {
          const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
          const text = frame('step', { id: 's1', kind: 'analyze', status: 'running', titleVi: 'Đọc yêu cầu', titleEn: 'Reading' }) +
            frame('final', { status: 429, body: { error: { message: 'Too many requests', type: 'rate_limit_error' } } });
          // Split mid-event on purpose: parsing must not depend on chunk boundaries.
          const cut = Math.floor(text.length / 2);
          const body = new ReadableStream<Uint8Array>({
            start(c) { c.enqueue(enc.encode(text.slice(0, cut))); c.enqueue(enc.encode(text.slice(cut))); c.close(); },
          });
          return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        }
        return json({});
      }),
    );

    mount('/thruline/providers', 'vi');
    await flush();
    act(() => (container.querySelector('[data-testid="support-setup-copilot-launcher"]') as HTMLButtonElement).click());
    await flush();
    const textarea = container.querySelector('.ssc-composer textarea') as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    act(() => {
      setter?.call(textarea, 'xin chào');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    act(() => (container.querySelector('[data-testid="support-setup-send-btn"]') as HTMLButtonElement).click());
    await flush();

    expect(container.querySelector('[data-testid="support-setup-process-live"]')).toBeNull();
    expect(container.querySelector('[data-testid="support-setup-process-done"]')).toBeNull();
    expect(container.textContent).not.toContain('Đây là câu trả lời');
  });

  it('guides requirement discovery, renders consent proposal, and deploys on explicit approval', async () => {
    const applyCalls: Array<{ approved: boolean; selectedSteps?: string[] }> = [];
    let turnIndex = 0;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/api/user/session')) {
          return json({ userId: 1, email: 'admin@example.com', role: 'admin', isPrimary: true, permissions: ['*'] });
        }
        if (url.includes('/api/support-setup-copilot/status')) {
          return json(sampleStatus(true));
        }
        if (url.endsWith('/api/support-setup-copilot/chat')) {
          turnIndex += 1;
          if (turnIndex === 1) {
            const resp: SupportSetupChatResponse = {
              ok: true,
              reply: 'Hãy cho tôi biết thông tin cơ bản của doanh nghiệp.',
              intent: 'gather_requirements',
              missingQuestions: ['Tên thương hiệu & chính sách'],
              suggestedQuickReplies: ['Hoàn thiện cấu hình tiêu chuẩn cho tenant hiện tại'],
              proposal: null,
              modelUsed: null,
              usedFallback: true,
            };
            return json(resp);
          }
          const resp: SupportSetupChatResponse = {
            ok: true,
            reply: 'Đã thiết kế xong kế hoạch, vui lòng duyệt trước khi triển khai.',
            intent: 'propose_setup',
            missingQuestions: [],
            suggestedQuickReplies: [],
            proposal: sampleProposal(),
            modelUsed: null,
            usedFallback: true,
          };
          return json(resp);
        }
        if (url.endsWith('/api/support-setup-copilot/proposals/prop_demo_1/apply')) {
          const parsed = JSON.parse(String(init?.body ?? '{}')) as {
            approved: boolean;
            selectedSteps?: string[];
          };
          applyCalls.push(parsed);
          const applied: SupportSetupApplyResponse = {
            ok: true,
            proposalId: 'prop_demo_1',
            proposal: { ...sampleProposal(), status: 'applied' },
            tenant: { id: 1, name: 'EXE', slug: 'exe', publicKey: 'pk_sup_exe' },
            stepResults: [
              {
                stepId: 'tenant_ai',
                status: 'applied',
                detailEn: 'Updated tenant AI',
                detailVi: 'Đã cập nhật Tenant AI',
              },
              {
                stepId: 'widget_appearance',
                status: 'applied',
                detailEn: 'Enabled widget',
                detailVi: 'Đã bật widget',
              },
            ],
            diagnostic: {
              ...sampleStatus(true).activeTenant!,
              completedSteps: 7,
              embedSnippet: '<script src="https://example.com/thruline/v1/support/widget.js"></script>',
            },
          };
          return json(applied);
        }
        return json({});
      }),
    );

    mount('/thruline/support-guardrails', 'vi');
    await flush();

    const launcher = container.querySelector('[data-testid="support-setup-copilot-launcher"]') as HTMLButtonElement;
    act(() => launcher.click());
    await flush();

    // Click first starter ("Setup trọn gói thay cho tôi")
    const starterBtn = container.querySelector('.ssc-starter-btn') as HTMLButtonElement;
    act(() => starterBtn.click());
    await flush();

    // Copilot asked clarifying questions and offered quick-reply chip
    const chip = container.querySelector('.ssc-chip-btn') as HTMLButtonElement;
    expect(chip).not.toBeNull();
    act(() => chip.click());
    await flush();

    // Proposal consent card is now displayed
    const proposalCard = container.querySelector('[data-testid="support-setup-proposal-card"]');
    expect(proposalCard).not.toBeNull();
    expect(applyCalls).toHaveLength(0);

    // Click Approve & Auto-Deploy
    const approveBtn = container.querySelector('[data-testid="support-setup-approve-btn"]') as HTMLButtonElement;
    act(() => approveBtn.click());
    await flush();

    expect(applyCalls).toHaveLength(1);
    expect(applyCalls[0]?.approved).toBe(true);
    expect(applyCalls[0]?.selectedSteps).toEqual(['tenant_ai', 'widget_appearance']);

    const appliedCard = container.querySelector('[data-testid="support-setup-applied-card"]');
    expect(appliedCard).not.toBeNull();
    expect(appliedCard?.textContent).toContain('/thruline/v1/support/widget.js');
  });

  it('enforces read-only and restricted-step UI boundaries for limited-permission accounts', async () => {
    const base = sampleStatus(true);
    const readOnlyStatus: SupportSetupStatusResponse = {
      ...base,
      canCreateTenant: false,
      tenants: [
        {
          ...base.tenants[0]!,
          canViewSteps: ['tenant_ai'],
          canEditSteps: [],
        },
      ],
      activeTenant: {
        ...base.activeTenant!,
        completedSteps: 1,
        embedSnippet: '',
        steps: base.activeTenant!.steps.map((st) =>
          st.stepId === 'tenant_ai'
            ? { ...st, canView: true, canEdit: false }
            : {
                ...st,
                status: 'restricted',
                canView: false,
                canEdit: false,
                summaryEn: 'Restricted',
                summaryVi: 'Giới hạn quyền — tài khoản của bạn chưa có quyền xem mục này.',
              },
        ),
      },
    };

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/api/user/session')) {
          return json({
            userId: 9,
            email: 'viewer@example.com',
            role: 'member',
            isPrimary: false,
            permissions: [],
          });
        }
        if (url.includes('/api/support-setup-copilot/status')) {
          return json(readOnlyStatus);
        }
        return json({});
      }),
    );

    mount('/tenant-portal', 'vi');
    await flush();

    const launcher = container.querySelector('[data-testid="support-setup-copilot-launcher"]') as HTMLButtonElement;
    expect(launcher).not.toBeNull();
    act(() => launcher.click());
    await flush();

    // Read-only badge shown instead of Quick Business Brief toggle
    expect(container.querySelector('[data-testid="support-setup-readonly-badge"]')).not.toBeNull();

    // Only the Guide starter button is rendered (auto-setup starters hidden);
    // the "Tôi có quyền gì?" starter stays available to read-only accounts.
    const starters = container.querySelectorAll('.ssc-starter-btn');
    expect(starters).toHaveLength(2);
    expect(starters[0]?.textContent).toContain('Hướng dẫn');
    expect(starters[1]?.textContent).toContain('Tôi có quyền gì?');

    // Open roadmap: restricted steps show 'Giới hạn quyền' and omit the 'Mở trang' button
    const roadmapToggle = container.querySelector('[data-testid="support-setup-roadmap-toggle"]') as HTMLButtonElement;
    act(() => roadmapToggle.click());
    await flush();

    const roadmap = container.querySelector('[data-testid="support-setup-roadmap"]');
    expect(roadmap?.textContent).toContain('Giới hạn quyền');
    expect(roadmap?.querySelectorAll('.ssc-link-btn')).toHaveLength(1);
  });

  it('auto-switches Copilot UI to Vietnamese when user types Vietnamese under an English dashboard locale and forwards currentPath', async () => {
    const chatPayloads: Array<{ locale?: string; currentPath?: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/api/user/session')) {
          return json({ userId: 1, email: 'admin@example.com', role: 'admin', isPrimary: true, permissions: ['*'] });
        }
        if (url.includes('/api/support-setup-copilot/status')) {
          return json(sampleStatus(true));
        }
        if (url.endsWith('/api/support-setup-copilot/chat')) {
          chatPayloads.push(
            JSON.parse(String(init?.body ?? '{}')) as { locale?: string; currentPath?: string },
          );
          const resp: SupportSetupChatResponse = {
            ok: true,
            replyLocale: 'vi',
            reply: 'Dạ hoàn toàn được ạ — mình giao tiếp bằng tiếng Việt 100% nhé!',
            intent: 'guide',
            missingQuestions: [],
            suggestedQuickReplies: ['Trang này dùng để làm gì?'],
            proposal: null,
            modelUsed: null,
            usedFallback: true,
          };
          return json(resp);
        }
        return json({});
      }),
    );

    // Global dashboard locale is 'en' (matching "English ▼" in top bar)
    mount('/thruline/providers', 'en');
    await flush();

    const launcher = container.querySelector('[data-testid="support-setup-copilot-launcher"]') as HTMLButtonElement;
    expect(launcher?.textContent).toContain('AI Setup Copilot');
    act(() => launcher.click());
    await flush();

    expect(container.querySelector('h2')?.textContent).toBe('AI Support Setup Copilot');
    expect(container.querySelector('[data-testid="support-setup-lang-toggle"]')?.textContent).toBe('EN');

    const textarea = container.querySelector('.ssc-composer textarea') as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    act(() => {
      setter?.call(textarea, 'web nay dung de lam gi');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    const sendBtn = container.querySelector('[data-testid="support-setup-send-btn"]') as HTMLButtonElement;
    act(() => sendBtn.click());
    await flush();

    expect(chatPayloads[0]?.locale).toBe('vi');
    expect(chatPayloads[0]?.currentPath).toBe('/thruline/providers');
    expect(container.querySelector('h2')?.textContent).toBe('Trợ lý Setup AI Support');
    expect(container.querySelector('[data-testid="support-setup-lang-toggle"]')?.textContent).toBe('VI');
    expect(container.textContent).toContain('giao tiếp bằng tiếng Việt 100%');
  });

  it('renders 7-segment progress bar, unified composer, assistant header, and compact quick-reply labels that send full prompts', async () => {
    const sentMessages: string[] = [];
    const longTemplate =
      'Shop mỹ phẩm GlowSkin, website https://glowskin.vn, đổi trả 7 ngày, freeship đơn 300k, màu hồng #ec4899, giọng thân thiện';

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/api/user/session')) {
          return json({ userId: 1, email: 'admin@example.com', role: 'admin', isPrimary: true, permissions: ['*'] });
        }
        if (url.includes('/api/support-setup-copilot/status')) {
          return json(sampleStatus(true));
        }
        if (url.endsWith('/api/support-setup-copilot/chat')) {
          const parsed = JSON.parse(String(init?.body ?? '{}')) as {
            messages?: Array<{ role: string; content: string }>;
          };
          const latest = parsed.messages?.[parsed.messages.length - 1]?.content ?? '';
          sentMessages.push(latest);
          const resp: SupportSetupChatResponse = {
            ok: true,
            replyLocale: 'vi',
            reply: '1. **Tên thương hiệu**\n2. **Chính sách FAQ**',
            intent: 'gather_requirements',
            missingQuestions: [],
            suggestedQuickReplies: [longTemplate],
            proposal: null,
            modelUsed: null,
            usedFallback: true,
          };
          return json(resp);
        }
        return json({});
      }),
    );

    mount('/thruline/support-guardrails', 'vi');
    await flush();

    const launcher = container.querySelector('[data-testid="support-setup-copilot-launcher"]') as HTMLButtonElement;
    act(() => launcher.click());
    await flush();

    // 7-segment visual progress bar + unified composer with shortcut hint
    expect(container.querySelectorAll('.ssc-seg-bar .ssc-seg')).toHaveLength(7);
    expect(container.querySelector('.ssc-composer-box')).not.toBeNull();
    expect(container.querySelector('.ssc-composer-hint')?.textContent).toContain('Enter');

    // Trigger first turn
    const starterBtn = container.querySelector('.ssc-starter-btn') as HTMLButtonElement;
    act(() => starterBtn.click());
    await flush();

    // Assistant sender header + compact truncated quick-reply chip that still dispatches full prompt on click
    expect(container.querySelector('.ssc-msg-meta')?.textContent).toContain('Setup Copilot');
    const chip = container.querySelector('.ssc-chip-btn') as HTMLButtonElement;
    expect(chip).not.toBeNull();
    expect(chip.getAttribute('title')).toBe(longTemplate);
    expect((chip.textContent ?? '').length).toBeLessThan(60);

    act(() => chip.click());
    await flush();
    expect(sentMessages[1]).toBe(longTemplate);
  });
it('renders surgical proposal badge and defaults only targeted steps to checked', async () => {
    const surgicalProposal: SupportSetupProposal = {
      id: 'prop-surg-1',
      userId: 1,
      tenantId: 1,
      tenantName: 'EXE',
      tenantSlug: 'exe',
      targetMode: 'update_tenant',
      isSurgical: true,
      targetedSteps: ['widget_appearance'],
      status: 'pending_consent',
      summary: 'Đổi màu widget',
      createdAt: '2026-11-18T10:00:00Z',
      expiresAt: '2026-11-18T11:00:00Z',
      steps: [
        {
          stepId: 'tenant_ai',
          canApply: true,
          enabledByDefault: false,
          titleVi: '1. Tenant & Nhân cách AI',
          titleEn: '1. Tenant & AI Persona',
          summaryVi: 'Giữ nguyên nhân cách hiện tại',
          summaryEn: 'Keep current persona',
          highlightsVi: [],
          highlightsEn: [],
          payload: {},
        },
        {
          stepId: 'widget_appearance',
          canApply: true,
          enabledByDefault: true,
          titleVi: '5. Widget & Thương hiệu',
          titleEn: '5. Chat Widget & Branding',
          summaryVi: 'Đổi màu nút chat sang #ec4899',
          summaryEn: 'Change widget color to #ec4899',
          highlightsVi: [],
          highlightsEn: [],
          payload: {},
        },
      ],
      requirements: {},
    };

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/api/user/session')) {
          return json({ userId: 1, email: 'admin@example.com', role: 'admin', isPrimary: true, permissions: ['*'] });
        }
        if (url.includes('/api/support-setup-copilot/status')) {
          const st = sampleStatus(true);
          st.pendingProposals = [surgicalProposal];
          return json(st);
        }
        return json({});
      }),
    );

    mount('/thruline/support-branding', 'vi');
    await flush();

    const launcher = container.querySelector('[data-testid="support-setup-copilot-launcher"]') as HTMLButtonElement;
    act(() => launcher.click());
    await flush();

    const badge = container.querySelector('[data-testid="support-setup-surgical-badge"]');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toContain('Chỉnh sửa chọn lọc');

    const checkboxes = container.querySelectorAll<HTMLInputElement>('.ssc-proposal-step input[type="checkbox"]');
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes[0].checked).toBe(false); // tenant_ai unchecked
    expect(checkboxes[1].checked).toBe(true);  // widget_appearance checked
  });

  it('renders system settings proposal with action diff preview, locks unauthorized actions, and applies selected actions cleanly without crashing on null tenant', async () => {
    let appliedPayload: { approved: boolean; selectedSystemActions?: string[] } | null = null;

    const systemProposal: SupportSetupProposal = {
      id: 'prop-sys-1',
      userId: 1,
      tenantId: null,
      tenantName: 'System Settings',
      tenantSlug: 'system-settings',
      targetMode: 'system_settings',
      status: 'pending_consent',
      summary: 'Bật cache phản hồi',
      createdAt: '2026-11-18T10:00:00Z',
      expiresAt: '2026-11-18T11:00:00Z',
      steps: [],
      systemActions: [
        {
          settingId: 'response_cache',
          requiredPermission: 'edit_cache',
          canApply: true,
          enabledByDefault: true,
          titleVi: 'Response Cache',
          titleEn: 'Response Cache',
          summaryVi: 'Bật cache phản hồi',
          summaryEn: 'Enable response cache',
          currentValueVi: 'Tắt',
          currentValueEn: 'Disabled',
          proposedValueVi: 'Bật',
          proposedValueEn: 'Enabled',
          reasonVi: 'Có 13/33 lượt gọi bị 429 trong 24 giờ qua.',
          reasonEn: '13 of 33 requests were rate-limited in the last 24h.',
          evidence: ['13 rate-limited of 33 requests in 24h (39%).'],
          payload: { enabled: true },
        },
        {
          settingId: 'model_unification',
          requiredPermission: 'edit_settings',
          canApply: false,
          enabledByDefault: false,
          titleVi: 'Hợp nhất Model Groups',
          titleEn: 'Model Group Unification',
          summaryVi: 'Bật hợp nhất tên model',
          summaryEn: 'Enable unified model names',
          currentValueVi: 'Tắt',
          currentValueEn: 'Disabled',
          proposedValueVi: 'Bật',
          proposedValueEn: 'Enabled',
          payload: { enabled: true },
        },
      ],
      requirements: {},
    };

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/api/user/session')) {
          return json({ userId: 1, email: 'admin@example.com', role: 'admin', isPrimary: true, permissions: ['edit_cache'] });
        }
        if (url.includes('/api/support-setup-copilot/status')) {
          const st = sampleStatus(true);
          st.pendingProposals = [systemProposal];
          return json(st);
        }
        if (url.endsWith('/api/support-setup-copilot/proposals/prop-sys-1/apply')) {
          appliedPayload = JSON.parse(String(init?.body ?? '{}')) as {
            approved: boolean;
            selectedSystemActions?: string[];
          };
          const applyRes: SupportSetupApplyResponse = {
            ok: true,
            proposalId: 'prop-sys-1',
            proposal: { ...systemProposal, status: 'applied' },
            tenant: null,
            stepResults: [],
            systemResults: [
              {
                settingId: 'response_cache',
                status: 'applied',
                detailVi: 'Đã bật Response Cache thành công.',
                detailEn: 'Response Cache enabled successfully.',
              },
            ],
            diagnostic: null,
          };
          return json(applyRes);
        }
        return json({});
      }),
    );

    mount('/settings', 'vi');
    await flush();

    const launcher = container.querySelector('[data-testid="support-setup-copilot-launcher"]') as HTMLButtonElement;
    act(() => launcher.click());
    await flush();

    // Check system actions container & diff preview
    const actionsContainer = container.querySelector('[data-testid="support-setup-system-actions"]');
    expect(actionsContainer).not.toBeNull();
    expect(actionsContainer?.textContent).toContain('Response Cache');
    expect(actionsContainer?.textContent).toContain('Tắt');
    expect(actionsContainer?.textContent).toContain('Bật');
    expect(actionsContainer?.textContent).toContain('edit_settings'); // locked permission badge

    // The advisor's reason + evidence are shown for the action that has them, and only for that one
    const reasons = actionsContainer!.querySelectorAll('[data-testid="support-setup-system-action-reason"]');
    expect(reasons).toHaveLength(1);
    expect(reasons[0]!.textContent).toContain('Lý do đề xuất');
    expect(reasons[0]!.textContent).toContain('Có 13/33 lượt gọi bị 429');
    expect(reasons[0]!.textContent).toContain('13 rate-limited of 33 requests in 24h (39%).');

    const checkboxes = actionsContainer!.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes[0].checked).toBe(true);  // response_cache checked
    expect(checkboxes[1].checked).toBe(false); // model_unification unchecked
    expect(checkboxes[1].disabled).toBe(true);  // model_unification disabled

    // Click Approve
    const approveBtn = container.querySelector('[data-testid="support-setup-approve-btn"]') as HTMLButtonElement;
    act(() => approveBtn.click());
    await flush();

    expect(appliedPayload).toEqual({
      approved: true,
      selectedSystemActions: ['response_cache'],
    });

    // Check applied card rendered with null tenant safety
    const appliedCard = container.querySelector('[data-testid="support-setup-applied-card"]');
    expect(appliedCard).not.toBeNull();
    expect(appliedCard?.textContent).toContain('Đã áp dụng cấu hình hệ thống thành công');
    expect(appliedCard?.textContent).toContain('Đã bật Response Cache thành công.');

    // "Mở Cài đặt" opens the Settings DIALOG (there is no /settings route) and leaves the URL alone.
    const opened = vi.fn();
    window.addEventListener('freellmapi:open-settings', opened);
    const openBtns = appliedCard!.querySelectorAll<HTMLButtonElement>('[data-testid="support-setup-open-setting"]');
    expect(openBtns).toHaveLength(1);
    expect(openBtns[0]!.textContent).toContain('Mở Cài đặt');
    const pathBefore = container.querySelector('[data-testid="current-path"]')?.textContent;
    act(() => openBtns[0]!.click());
    window.removeEventListener('freellmapi:open-settings', opened);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="current-path"]')?.textContent).toBe(pathBefore);
  });

  it('renders permission-grant proposal with target/scope/diff and approves with no step selection', async () => {
    let appliedPayload: { approved: boolean; selectedSteps?: unknown; selectedSystemActions?: unknown } | null = null;

    // Phase 3: Consent Card for a staged permission grant/revoke — the user
    // must see exactly what they approve (target, scope, permissions added/
    // removed, current → after diff) before Approve runs anything.
    const grantProposal: SupportSetupProposal = {
      id: 'prop-grant-1',
      userId: 1,
      tenantId: null,
      tenantName: 'System',
      tenantSlug: 'system',
      targetMode: 'permission_grant',
      status: 'pending_consent',
      summary: 'Cấp quyền cho người dùng',
      createdAt: '2026-11-20T10:00:00Z',
      expiresAt: '2026-11-20T11:00:00Z',
      steps: [],
      permissionGrants: [
        {
          scope: 'global',
          tenantId: null,
          targetUserId: 7,
          targetEmail: 'lan@example.com',
          action: 'grant',
          permissions: ['view_users', 'edit_cache'],
          previousPermissions: [],
          newPermissions: ['view_users', 'edit_cache'],
        },
        {
          scope: 'tenant',
          tenantId: 3,
          tenantSlug: 'acme',
          tenantName: 'Acme Corp',
          targetUserId: 9,
          targetEmail: 'nam@example.com',
          action: 'revoke',
          permissions: ['view_tenant_ai'],
          previousPermissions: ['view_tenant_ai', 'view_tenant_members'],
          newPermissions: ['view_tenant_members'],
        },
      ],
      requirements: {},
    };

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/api/user/session')) {
          return json({ userId: 1, email: 'admin@example.com', role: 'admin', isPrimary: true, permissions: ['*'] });
        }
        if (url.includes('/api/support-setup-copilot/status')) {
          const st = sampleStatus(true);
          st.pendingProposals = [grantProposal];
          return json(st);
        }
        if (url.endsWith('/api/support-setup-copilot/proposals/prop-grant-1/apply')) {
          appliedPayload = JSON.parse(String(init?.body ?? '{}')) as { approved: boolean };
          const applyRes: SupportSetupApplyResponse = {
            ok: true,
            proposalId: 'prop-grant-1',
            proposal: { ...grantProposal, status: 'applied' },
            tenant: null,
            stepResults: [],
            systemResults: [],
            diagnostic: null,
          };
          return json(applyRes);
        }
        return json({});
      }),
    );

    mount('/settings', 'vi');
    await flush();

    const launcher = container.querySelector('[data-testid="support-setup-copilot-launcher"]') as HTMLButtonElement;
    act(() => launcher.click());
    await flush();

    const grantsContainer = container.querySelector('[data-testid="support-setup-permission-grants"]');
    expect(grantsContainer).not.toBeNull();
    // Global grant row: target + added permissions + empty → granted diff.
    expect(grantsContainer?.textContent).toContain('lan@example.com');
    expect(grantsContainer?.textContent).toContain('view_users');
    expect(grantsContainer?.textContent).toContain('edit_cache');
    expect(grantsContainer?.textContent).toContain('Cấp');
    // Tenant revoke row: target + removed permission + remaining diff.
    expect(grantsContainer?.textContent).toContain('nam@example.com');
    expect(grantsContainer?.textContent).toContain('view_tenant_ai');
    expect(grantsContainer?.textContent).toContain('Thu hồi');
    expect(grantsContainer?.textContent).toContain('view_tenant_members');
    expect(grantsContainer?.textContent).toContain('Hiện tại');
    expect(grantsContainer?.textContent).toContain('Sau khi duyệt');

    // Approve sends only { approved: true } — no steps, no system actions.
    const approveBtn = container.querySelector('[data-testid="support-setup-approve-btn"]') as HTMLButtonElement;
    act(() => approveBtn.click());
    await flush();

    expect(appliedPayload).toEqual({ approved: true });
  });

  it('renders model badge when modelUsed is returned and not fallback', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/api/user/session')) {
          return json({ userId: 1, email: 'admin@example.com', role: 'admin', isPrimary: true, permissions: ['*'] });
        }
        if (url.includes('/api/support-setup-copilot/status')) {
          return json(sampleStatus(true));
        }
        if (url.endsWith('/api/support-setup-copilot/chat')) {
          const resp: SupportSetupChatResponse = {
            ok: true,
            replyLocale: 'vi',
            reply: 'Chào bạn! Mình có thể tư vấn trực tiếp cho bạn.',
            intent: 'guide',
            missingQuestions: [],
            suggestedQuickReplies: [],
            proposal: null,
            modelUsed: 'claude-3-7-sonnet',
            usedFallback: false,
          };
          return json(resp);
        }
        return json({});
      }),
    );

    mount('/thruline/support-guardrails', 'vi');
    await flush();

    const launcher = container.querySelector('[data-testid="support-setup-copilot-launcher"]') as HTMLButtonElement;
    act(() => launcher.click());
    await flush();

    const starterBtn = container.querySelector('.ssc-starter-btn') as HTMLButtonElement;
    act(() => starterBtn.click());
    await flush();

    const modelBadge = container.querySelector('.ssc-model-badge');
    expect(modelBadge).not.toBeNull();
    expect(modelBadge?.textContent).toContain('⚡ claude-3-7-sonnet');
  });

  it('respects route visibility: shows on /settings and /settings/*, hides on /models/chat and /thruline/playground', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/api/user/session')) {
          return json({ userId: 1, email: 'admin@example.com', role: 'admin', isPrimary: true, permissions: ['*'] });
        }
        if (url.includes('/api/support-setup-copilot/status')) {
          return json(sampleStatus(true));
        }
        return json({});
      }),
    );

    mount('/settings', 'vi');
    await flush();
    expect(container.querySelector('[data-testid="support-setup-copilot-launcher"]')).not.toBeNull();

    mount('/settings/providers', 'vi');
    await flush();
    expect(container.querySelector('[data-testid="support-setup-copilot-launcher"]')).not.toBeNull();

    mount('/models/chat', 'vi');
    await flush();
    expect(container.querySelector('[data-testid="support-setup-copilot-launcher"]')).toBeNull();

    mount('/thruline/playground', 'vi');
    await flush();
    expect(container.querySelector('[data-testid="support-setup-copilot-launcher"]')).toBeNull();
  });

  it('supports Member Error Doctor, [Confirm & Run] / [Cancel] action cards, IDE snippet tabs, and 3-step onboarding checklist', async () => {
    const executedActions: CopilotExecuteActionRequest[] = [];
    let chatCallIdx = 0;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/api/user/session')) {
          return json({
            userId: 42,
            email: 'member@example.com',
            role: 'member',
            isPrimary: false,
            permissions: [],
          });
        }
        if (url.includes('/api/support-setup-copilot/status')) {
          const memberStatus: SupportSetupStatusResponse = {
            ok: true,
            visible: false,
            memberCopilotVisible: true,
            canCreateTenant: false,
            availableModels: [],
            tenants: [],
            activeTenant: null,
            pendingProposals: [],
            onboarding: {
              completedCount: 1,
              totalCount: 3,
              steps: [
                {
                  stepNumber: 1,
                  id: 'mint_personal_key',
                  completed: true,
                  titleEn: '1. Mint Personal API Key',
                  titleVi: '1. Tạo Personal API Key cá nhân',
                  descriptionEn: '1 active key',
                  descriptionVi: 'Đã có 1 khóa',
                  ctaLabelEn: 'Manage Keys',
                  ctaLabelVi: 'Quản lý Key',
                  targetPath: '/agents',
                },
                {
                  stepNumber: 2,
                  id: 'test_in_playground',
                  completed: false,
                  titleEn: '2. Test in Playground / AI Hub',
                  titleVi: '2. Chat thử trên Playground / AI Hub',
                  descriptionEn: 'Send a quick test prompt',
                  descriptionVi: 'Gửi thử 1 tin nhắn',
                  ctaLabelEn: 'Open AI Hub',
                  ctaLabelVi: 'Mở AI Hub',
                  targetPath: '/assistants',
                },
                {
                  stepNumber: 3,
                  id: 'connect_ide',
                  completed: false,
                  titleEn: '3. Connect Your Coding IDE',
                  titleVi: '3. Kết nối IDE lập trình',
                  descriptionEn: 'Paste key into Cursor or Claude Code',
                  descriptionVi: 'Dán key vào Cursor hoặc Claude Code',
                  ctaLabelEn: 'IDE Setup Guides',
                  ctaLabelVi: 'Cấu hình IDE',
                  targetPath: '/agents',
                },
              ],
            },
          };
          return json(memberStatus);
        }
        if (url.endsWith('/api/support-setup-copilot/chat')) {
          chatCallIdx += 1;
          if (chatCallIdx === 1) {
            const diagResp: SupportSetupChatResponse = {
              ok: true,
              replyLocale: 'vi',
              reply: 'Phát hiện 3 lỗi HTTP 429 trên khóa hiện tại của bạn.',
              intent: 'diagnose_errors',
              missingQuestions: [],
              suggestedQuickReplies: [],
              proposal: null,
              userDiagnostic: {
                generatedAt: '2026-11-18T10:00:00.000Z',
                windowHours: 72,
                overallHealth: 'degraded',
                headlineEn: '1 issue spotted',
                headlineVi: 'Phát hiện 1 vấn đề',
                recentRequests: {
                  total: 12,
                  succeeded: 9,
                  failed: 3,
                  errorRatePct: 25,
                  avgLatencyMs: 940,
                  highLatencyCount: 0,
                },
                errorBreakdown: {
                  rate_limit_429: 3,
                  bad_request_400: 0,
                  quota_guardrail_403: 0,
                  upstream_5xx_timeout: 0,
                  other_error: 0,
                },
                issues: [
                  {
                    category: 'rate_limit_429',
                    severity: 'warning',
                    count: 3,
                    latestAt: '2026-11-18T09:58:00.000Z',
                    sampleError: 'HTTP 429 Too Many Requests',
                    titleEn: 'HTTP 429 Rate-Limit',
                    titleVi: 'Lỗi HTTP 429 — Chạm trần tốc độ gọi',
                    rootCauseEn: 'Burst traffic exceeded RPM.',
                    rootCauseVi: 'Gửi request dồn dập vượt ngưỡng RPM.',
                    remediationEn: 'Switch to ECO mode.',
                    remediationVi: 'Chuyển sang chế độ ECO.',
                  },
                ],
                activeKeys: [
                  {
                    id: 7,
                    name: 'Cursor Main',
                    keyPrefix: 'sk-flm-abcd…9999',
                    rpmLimit: 60,
                    routingMode: 'max',
                    assistantId: null,
                    assistantName: null,
                    lastUsedAt: null,
                    createdAt: '2026-11-18T08:00:00.000Z',
                  },
                ],
                quota: {
                  tracked: true,
                  rpmLimit: 60,
                  dailyRequests: { used: 85, limit: 100, pct: 85 },
                  dailyTokens: { used: 40000, limit: 500000, pct: 8 },
                  monthlyRequests: { used: 85, limit: null, pct: null },
                  monthlyTokens: { used: 40000, limit: 3000000, pct: 1 },
                  highestUsagePct: 85,
                  isNearExhaustion: true,
                  isExhausted: false,
                  resetsAt: {
                    day: '2026-11-19T00:00:00.000Z',
                    month: '2026-12-01T00:00:00.000Z',
                  },
                },
                onboarding: {
                  completedCount: 1,
                  totalCount: 3,
                  steps: [],
                },
                recommendedAction: {
                  id: 'act_switch_demo',
                  actionType: 'switch_key_routing_mode',
                  requiresConfirmation: true,
                  titleEn: 'Switch Key "Cursor Main" to ECO Mode',
                  titleVi: 'Chuyển Key "Cursor Main" sang chế độ ECO',
                  summaryEn: 'Updates active key to eco.',
                  summaryVi: 'Cập nhật khóa sang chế độ eco.',
                  confirmLabelEn: 'Confirm & Run',
                  confirmLabelVi: 'Xác nhận & Chạy',
                  params: {
                    keyId: 7,
                    keyName: 'Cursor Main',
                    keyPrefix: 'sk-flm-abcd…9999',
                    fromRoutingMode: 'max',
                    routingMode: 'eco',
                  },
                },
              },
              actionProposal: {
                id: 'act_switch_demo',
                actionType: 'switch_key_routing_mode',
                requiresConfirmation: true,
                titleEn: 'Switch Key "Cursor Main" to ECO Mode',
                titleVi: 'Chuyển Key "Cursor Main" sang chế độ ECO',
                summaryEn: 'Updates active key to eco.',
                summaryVi: 'Cập nhật khóa sang chế độ eco.',
                confirmLabelEn: 'Confirm & Run',
                confirmLabelVi: 'Xác nhận & Chạy',
                params: {
                  keyId: 7,
                  keyName: 'Cursor Main',
                  keyPrefix: 'sk-flm-abcd…9999',
                  fromRoutingMode: 'max',
                  routingMode: 'eco',
                },
              },
              modelUsed: null,
              usedFallback: true,
            };
            return json(diagResp);
          }

          const mintProposalResp: SupportSetupChatResponse = {
            ok: true,
            replyLocale: 'vi',
            reply: 'Bấm Xác nhận & Chạy để tạo khóa cá nhân mới.',
            intent: 'propose_action',
            missingQuestions: [],
            suggestedQuickReplies: [],
            proposal: null,
            actionProposal: {
              id: 'act_mint_demo',
              actionType: 'create_personal_key',
              requiresConfirmation: true,
              titleEn: 'Mint New Personal API Key ("Cursor Dev")',
              titleVi: 'Tạo Personal API Key mới ("Cursor Dev")',
              summaryEn: 'Creates a private key in ECO mode.',
              summaryVi: 'Tạo khóa riêng ở chế độ ECO.',
              confirmLabelEn: 'Confirm & Run',
              confirmLabelVi: 'Xác nhận & Chạy',
              params: {
                name: 'Cursor Dev',
                routingMode: 'eco',
              },
            },
            modelUsed: null,
            usedFallback: true,
          };
          return json(mintProposalResp);
        }
        if (url.endsWith('/api/support-setup-copilot/execute-action')) {
          const parsed = JSON.parse(String(init?.body ?? '{}')) as CopilotExecuteActionRequest;
          executedActions.push(parsed);
          const execRes: CopilotExecuteActionResponse = {
            ok: true,
            actionType: 'create_personal_key',
            messageEn: 'Minted new Personal API Key!',
            messageVi: 'Đã tạo thành công Personal API Key mới!',
            createdKey: {
              id: 99,
              name: 'Cursor Dev',
              rawKey: 'sk-flm-0123456789abcdef0123456789abcdef0123456789abcdef',
              keyPrefix: 'sk-flm-0123…cdef',
              routingMode: 'eco',
              assistantId: null,
              assistantName: null,
              createdAt: '2026-11-18T10:02:00.000Z',
              snippets: {
                gatewayBaseUrl: 'https://gw.example.com',
                openAiBaseUrl: 'https://gw.example.com/v1',
                cursor: 'OpenAI Base URL: https://gw.example.com/v1\\nOpenAI API Key: sk-flm-0123456789abcdef0123456789abcdef0123456789abcdef',
                claudeCode: '{"env":{"ANTHROPIC_AUTH_TOKEN":"sk-flm-0123456789abcdef0123456789abcdef0123456789abcdef"}}',
                openCode: '{"$schema":"https://opencode.ai/config.json"}',
              },
            },
          };
          return json(execRes);
        }
        return json({});
      }),
    );

    mount('/assistants', 'en');
    await flush();

    // Member launcher renders on /assistants with 1/3 onboarding badge
    const launcher = container.querySelector('[data-testid="support-setup-copilot-launcher"]') as HTMLButtonElement;
    expect(launcher).not.toBeNull();
    expect(launcher.textContent).toContain('1/3');
    act(() => launcher.click());
    await flush();

    // Send unaccented Vietnamese Error Doctor prompt -> auto-flips UI to VI and renders diagnostic + action proposal cards
    const textarea = container.querySelector('.ssc-composer textarea') as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    act(() => {
      setter?.call(textarea, 'sao goi api bi loi 429');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    act(() => (container.querySelector('[data-testid="support-setup-send-btn"]') as HTMLButtonElement).click());
    await flush();

    const diagCard = container.querySelector('[data-testid="copilot-diagnostic-card"]');
    expect(diagCard).not.toBeNull();
    expect(diagCard?.textContent).toContain('85%');
    expect(diagCard?.textContent).toContain('Cursor Main');

    // Click Cancel on first action proposal -> zero execute-action network calls!
    const cancelBtn = container.querySelector('[data-testid="copilot-action-cancel-btn"]') as HTMLButtonElement;
    expect(cancelBtn).not.toBeNull();
    act(() => cancelBtn.click());
    await flush();
    expect(executedActions).toHaveLength(0);

    // Ask to mint a Personal API Key -> click Confirm & Run -> verify raw key + IDE tabs!
    act(() => {
      setter?.call(textarea, 'tao personal api key moi');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    act(() => (container.querySelector('[data-testid="support-setup-send-btn"]') as HTMLButtonElement).click());
    await flush();

    const confirmBtn = container.querySelector('[data-testid="copilot-action-confirm-btn"]') as HTMLButtonElement;
    expect(confirmBtn).not.toBeNull();
    act(() => confirmBtn.click());
    await flush();

    expect(executedActions).toHaveLength(1);
    expect(executedActions[0]).toEqual({
      actionType: 'create_personal_key',
      confirmed: true,
      params: { name: 'Cursor Dev', routingMode: 'eco' },
    });

    const rawKeyEl = container.querySelector('[data-testid="copilot-minted-raw-key"]');
    expect(rawKeyEl?.textContent).toBe('sk-flm-0123456789abcdef0123456789abcdef0123456789abcdef');
    expect(container.querySelector('[data-testid="copilot-ide-snippet"]')?.textContent).toContain(
      'OpenAI Base URL: https://gw.example.com/v1',
    );

    // Switch IDE tab to Claude Code and OpenCode
    act(() => (container.querySelector('[data-testid="copilot-ide-tab-claude"]') as HTMLButtonElement).click());
    await flush();
    expect(container.querySelector('[data-testid="copilot-ide-snippet"]')?.textContent).toContain(
      'ANTHROPIC_AUTH_TOKEN',
    );

    act(() => (container.querySelector('[data-testid="copilot-ide-tab-opencode"]') as HTMLButtonElement).click());
    await flush();
    expect(container.querySelector('[data-testid="copilot-ide-snippet"]')?.textContent).toContain(
      'opencode.ai/config.json',
    );
  });

  it('shows "Quyền của tôi" chip/card with the caller’s own role and asks "Tôi có quyền gì?"', async () => {
    const whoami: CopilotWhoAmIResponse = {
      ok: true,
      email: 'tenant-configurator@example.com',
      accountRole: 'member',
      isPrimary: false,
      isPlatformOperator: false,
      canCreateTenant: false,
      globalPermissions: ['use_x_gateway'],
      tenants: [
        {
          id: 1,
          name: 'EXE',
          slug: 'exe',
          rolePreset: 'ai_configurator',
          permissions: ['tenant_ai_config', 'tenant_knowledge'],
          canViewSteps: ['tenant_ai', 'knowledge_masking'],
          canEditSteps: ['tenant_ai', 'knowledge_masking'],
        },
      ],
    };
    let whoamiCalls = 0;
    const chatBodies: Array<{ messages?: Array<{ content: string }> }> = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/api/user/session')) {
          return json({
            userId: 2,
            email: 'tenant-configurator@example.com',
            role: 'member',
            isPrimary: false,
            permissions: ['use_x_gateway'],
          });
        }
        if (url.includes('/api/support-setup-copilot/status')) {
          return json(sampleStatus(true));
        }
        if (url.endsWith('/api/support-setup-copilot/whoami')) {
          whoamiCalls += 1;
          return json(whoami);
        }
        if (url.endsWith('/api/support-setup-copilot/chat')) {
          chatBodies.push(
            JSON.parse(String(init?.body ?? '{}')) as {
              messages?: Array<{ content: string }>;
            },
          );
          const resp: SupportSetupChatResponse = {
            ok: true,
            reply: 'Bạn đang đăng nhập với tenant-configurator@example.com.',
            intent: 'guide',
            missingQuestions: [],
            suggestedQuickReplies: [],
            proposal: null,
            modelUsed: null,
            usedFallback: true,
          };
          return json(resp);
        }
        return json({});
      }),
    );

    mount('/thruline/support-guardrails', 'vi');
    await flush();

    const launcher = container.querySelector(
      '[data-testid="support-setup-copilot-launcher"]',
    ) as HTMLButtonElement;
    act(() => launcher.click());
    await flush();

    // "Quyền của tôi" chip fetches whoami on demand and renders the card.
    const whoamiPill = container.querySelector(
      '[data-testid="copilot-whoami-pill"]',
    ) as HTMLButtonElement;
    expect(whoamiPill).not.toBeNull();
    expect(whoamiPill.textContent).toContain('Quyền của tôi');
    act(() => whoamiPill.click());
    await flush();
    expect(whoamiCalls).toBe(1);

    const card = container.querySelector('[data-testid="copilot-whoami-card"]');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain('tenant-configurator@example.com');
    expect(card?.textContent).toContain('Thành viên');
    expect(card?.textContent).toContain('ai_configurator');
    expect(card?.textContent).toContain('EXE (exe)');

    // "Tôi có quyền gì?" starter sends the identity question to chat.
    const starter = container.querySelector(
      '[data-testid="copilot-starter-whoami"]',
    ) as HTMLButtonElement;
    expect(starter).not.toBeNull();
    act(() => starter.click());
    await flush();
    expect(chatBodies.at(-1)?.messages?.at(-1)?.content).toBe('Tôi có quyền gì?');
  });

  it('offers a System target only to full-admin, sends targetMode "system" with no tenant, and hides tenant-only UI', async () => {
    const chatBodies: Array<{ tenantId?: number | null; targetMode?: string; messages?: Array<{ content: string }> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/api/user/session')) {
          return json({ userId: 1, email: 'admin@example.com', role: 'admin', isPrimary: true, permissions: ['*'] });
        }
        if (url.includes('/api/support-setup-copilot/status')) {
          return json({ ...sampleStatus(true), canUseSystemTarget: true });
        }
        if (url.endsWith('/api/support-setup-copilot/chat')) {
          chatBodies.push(JSON.parse(String(init?.body ?? '{}')));
          const resp: SupportSetupChatResponse = {
            ok: true,
            reply: 'System-wide overview',
            intent: 'guide',
            missingQuestions: [],
            suggestedQuickReplies: [],
            proposal: null,
            modelUsed: null,
            usedFallback: true,
          };
          return json(resp);
        }
        return json({});
      }),
    );

    mount('/thruline/support-guardrails', 'en');
    await flush();
    act(() => (container.querySelector('[data-testid="support-setup-copilot-launcher"]') as HTMLButtonElement).click());
    await flush();

    const select = container.querySelector('#ssc-tenant-select') as HTMLSelectElement;
    const optionValues = Array.from(select.options).map((o) => o.value);
    expect(optionValues).toContain('system');
    // Tenant Target keeps the 7-step progress and Quick Brief.
    expect(container.querySelector('[data-testid="support-setup-roadmap-toggle"]')).not.toBeNull();

    act(() => {
      select.value = 'system';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    expect(container.querySelector('[data-testid="copilot-system-target-hint"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="support-setup-roadmap-toggle"]')).toBeNull();
    // On the System target rights are per setting: a blanket "Read-only access" badge would contradict the hint.
    expect(container.querySelector('[data-testid="support-setup-readonly-badge"]')).toBeNull();
    expect(container.textContent).toContain('Manage the whole platform from here');

    const starter = container.querySelector('[data-testid="copilot-starter-system-settings"]') as HTMLButtonElement;
    act(() => starter.click());
    await flush();
    expect(chatBodies.at(-1)?.targetMode).toBe('system');
    expect(chatBodies.at(-1)?.tenantId).toBeNull();
    expect(chatBodies.at(-1)?.messages?.at(-1)?.content).toBe('What system settings can you help toggle?');
  });

  it('does not offer the System target when the server does not grant it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/api/user/session')) {
          return json({ userId: 2, email: 'ops@example.com', role: 'member', permissions: ['edit_cache'] });
        }
        if (url.includes('/api/support-setup-copilot/status')) {
          return json(sampleStatus(true));
        }
        return json({});
      }),
    );

    mount('/thruline/support-guardrails', 'en');
    await flush();
    act(() => (container.querySelector('[data-testid="support-setup-copilot-launcher"]') as HTMLButtonElement).click());
    await flush();

    const select = container.querySelector('#ssc-tenant-select') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).not.toContain('system');
  });
});
