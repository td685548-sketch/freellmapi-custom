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
                cursor: 'OpenAI Base URL: https://gw.example.com/v1\nOpenAI API Key: sk-flm-0123456789abcdef0123456789abcdef0123456789abcdef',
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
});
