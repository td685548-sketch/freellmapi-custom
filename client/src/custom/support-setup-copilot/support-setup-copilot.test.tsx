// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n';
import type {
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

    // Only the Guide starter button is rendered (auto-setup starters hidden)
    const starters = container.querySelectorAll('.ssc-starter-btn');
    expect(starters).toHaveLength(1);
    expect(starters[0]?.textContent).toContain('Hướng dẫn');

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
});
