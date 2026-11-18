import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Activity,
  AlertCircle,
  ArrowUp,
  ArrowUpRight,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Circle,
  ClipboardList,
  Copy,
  KeyRound,
  Lock,
  Maximize2,
  Minimize2,
  RotateCcw,
  ShieldCheck,
  Sliders,
  Sparkles,
  Stethoscope,
  Wand2,
  X,
} from 'lucide-react';
import { useI18n } from '@/i18n';
import { copyText } from '@/lib/clipboard';
import { toast } from '@/lib/toast';
import { useUserSession } from '../use-session';
import type {
  CopilotActionProposal,
  CopilotActionRoutingMode,
  CopilotCreateKeyActionParams,
  CopilotExecuteActionRequest,
  CopilotExecuteActionResponse,
  CopilotOnboardingChecklist,
  CopilotOpenOnboardingActionParams,
  CopilotSwitchRoutingModeActionParams,
  CopilotUserDiagnosticReport,
  SupportSetupApplyResponse,
  SupportSetupLanguage,
  SupportSetupProposal,
  SupportSetupRequirements,
  SupportSetupStepDiagnostic,
  SupportSetupStepId,
  SupportSetupTone,
  SupportSystemSettingId,
} from '../../../../shared/support-setup-copilot';
import {
  fetchCopilotUserDiagnostics,
  fetchSupportSetupStatus,
  isMemberPersonalCopilotRoute,
  isSupportSetupCopilotRoute,
  postCopilotExecuteAction,
  postSupportSetupApply,
  postSupportSetupChat,
  postSupportSetupDecline,
} from './api';
import {
  formatSetupString,
  getSupportSetupCopilotStrings,
} from './strings';
import './support-setup-copilot.css';

const CLIENT_VI_MARKER_RE =
  /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]|\b(?:tieng\s+viet|xin\s+chao|chao\s+ban|toi\s+(?:dang|muon|can|co|chua|khong)|minh\s+(?:dang|muon|can|co|chua|khong|moi)|ben\s+(?:minh|toi|em)|va\s+muon|(?:muon|can)\s+(?:setup|thiet\s+lap|cai\s+dat|tu\s+van|lam)|ban\s+co\s+the|ban\s+lam\s+duoc|lam\s+gi\s+ma|la\s+(?:cai\s+)?gi|lam\s+gi|de\s+lam\s+gi|dung\s+de|dung\s+sao|dung\s+the\s+nao|day\s+la\s+(?:trang|web|website|he\s+thong|ung\s+dung|nen\s+tang|muc|man\s+hinh|cho|tab|cong\s+cu)|hoat\s+dong\s+(?:sao|ra\s+sao|kieu\s+gi|the\s+nao|nhu\s+the\s+nao)|ra\s+sao|kieu\s+gi|cho\s+nay|web\s+nay|trang\s+(?:web\s+)?nay|he\s+thong\s+nay|ung\s+dung\s+nay|nen\s+tang\s+nay|muc\s+nay|man\s+hinh\s+nay|gioi\s+thieu|lay\s+api\s*keys?|ket\s+noi|cau\s+hinh|khac\s+nhau|khac\s+gi|co\s+the\s+(?:lam|noi|giup)|giup\s+toi|giup\s+minh|lam\s+sao|thiet\s+lap|cai\s+dat|huong\s+dan|chua\s+co|khong\s+co|sao\s+(?:tra\s+loi|cung\s+nhac|hoi|goi\s+api|bi\s+loi)|bi\s+loi|gap\s+loi|kiem\s+tra\s+(?:tai\s+khoan|loi|key)|chan\s+doan|tao\s+(?:personal\s*)?(?:api\s*)?key|chuyen\s+key|nguoi\s+moi|thanh\s+vien\s+moi|tu\s+van|len\s+ke\s+hoach|len\s+ban\s+mau)\b/i;

type IdeSnippetTab = 'cursor' | 'claudeCode' | 'openCode';

interface ChatTurn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  quickReplies?: string[];
  proposal?: SupportSetupProposal | null;
  applyResult?: SupportSetupApplyResponse | null;
  modelUsed?: string;
  userDiagnostic?: CopilotUserDiagnosticReport | null;
  actionProposal?: CopilotActionProposal | null;
  actionResult?: CopilotExecuteActionResponse | null;
}

interface BriefDraft {
  brandName: string;
  industry: string;
  websiteOrigin: string;
  tone: SupportSetupTone;
  language: SupportSetupLanguage;
  primaryColor: string;
  faqSummaryOrPolicies: string;
  requireContactIntake: boolean;
}

function defaultBrief(locale: 'vi' | 'en'): BriefDraft {
  return {
    brandName: '',
    industry: '',
    websiteOrigin: '',
    tone: 'friendly',
    language: locale,
    primaryColor: '#2563eb',
    faqSummaryOrPolicies: '',
    requireContactIntake: false,
  };
}

function makeTurnId(): string {
  return `turn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function formatQuickReplyLabel(raw: string): string {
  const clean = raw.trim();
  if (clean.length <= 54) return clean;
  const firstClause = clean.split(/,\s*/)[0]?.trim() ?? '';
  if (firstClause.length >= 14 && firstClause.length <= 48) {
    return `${firstClause}…`;
  }
  return `${clean.slice(0, 50).trimEnd()}…`;
}

function buildActionRequestPayload(proposal: CopilotActionProposal): CopilotExecuteActionRequest {
  if (proposal.actionType === 'create_personal_key') {
    const p = proposal.params as CopilotCreateKeyActionParams;
    return {
      actionType: 'create_personal_key',
      confirmed: true,
      params: {
        name: p.name,
        ...(p.routingMode ? { routingMode: p.routingMode as CopilotActionRoutingMode } : {}),
        ...(p.assistantId !== undefined ? { assistantId: p.assistantId } : {}),
      },
    };
  }
  if (proposal.actionType === 'switch_key_routing_mode') {
    const p = proposal.params as CopilotSwitchRoutingModeActionParams;
    return {
      actionType: 'switch_key_routing_mode',
      confirmed: true,
      params: {
        keyId: p.keyId,
        routingMode: p.routingMode,
      },
    };
  }
  const p = proposal.params as CopilotOpenOnboardingActionParams;
  return {
    actionType: 'open_onboarding_guide',
    confirmed: true,
    params: {
      ...(p.focusStep ? { focusStep: p.focusStep } : {}),
    },
  };
}

export function SupportSetupCopilot() {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { locale } = useI18n();
  const [langOverride, setLangOverride] = useState<'vi' | 'en' | null>(null);
  const uiLocale: 'vi' | 'en' = langOverride ?? (locale === 'vi' ? 'vi' : 'en');
  const s = getSupportSetupCopilotStrings(uiLocale);
  const session = useUserSession();

  const onEligibleRoute = isSupportSetupCopilotRoute(location.pathname);
  const onMemberPersonalRoute = isMemberPersonalCopilotRoute(location.pathname);
  const canQueryStatus =
    onEligibleRoute && !session.isPending && !session.isError && Boolean(session.session);

  const [open, setOpen] = useState(false);
  const [wide, setWide] = useState(false);
  const [roadmapOpen, setRoadmapOpen] = useState(false);
  const [briefOpen, setBriefOpen] = useState(false);
  const [targetSelection, setTargetSelection] = useState<'auto' | 'new' | number>('auto');
  const [input, setInput] = useState('');
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [brief, setBrief] = useState<BriefDraft>(() => defaultBrief(uiLocale));
  const [selectedStepsMap, setSelectedStepsMap] = useState<Record<string, SupportSetupStepId[]>>({});
  const [selectedSystemActionsMap, setSelectedSystemActionsMap] = useState<Record<string, SupportSystemSettingId[]>>({});
  const [proposalOverrides, setProposalOverrides] = useState<Record<string, SupportSetupProposal>>({});
  const [actionStatusMap, setActionStatusMap] = useState<
    Record<string, 'pending' | 'executed' | 'cancelled'>
  >({});
  const [ideTabMap, setIdeTabMap] = useState<Record<string, IdeSnippetTab>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);

  const statusQueryArg =
    targetSelection === 'new'
      ? null
      : typeof targetSelection === 'number'
        ? targetSelection
        : undefined;

  const statusQuery = useQuery({
    queryKey: ['support-setup-copilot-status', statusQueryArg ?? 'auto'],
    queryFn: () => fetchSupportSetupStatus(statusQueryArg),
    enabled: canQueryStatus,
    staleTime: 20_000,
  });

  const statusData = statusQuery.data;
  const isTenantSetupVisible = Boolean(statusData?.visible);
  const isMemberOnlyMode =
    !isTenantSetupVisible && onMemberPersonalRoute && Boolean(statusData?.memberCopilotVisible);
  const isCopilotVisible = isTenantSetupVisible || isMemberOnlyMode;

  const tenants = statusData?.tenants ?? [];
  const activeTenantDiag = statusData?.activeTenant ?? null;
  const canCreateTenant = Boolean(statusData?.canCreateTenant);
  const canEditAnyStep =
    canCreateTenant || Boolean(activeTenantDiag?.steps.some((st) => st.canEdit));

  const resolvedTargetMode: 'create_tenant' | 'update_tenant' =
    canCreateTenant && (targetSelection === 'new' || !activeTenantDiag)
      ? 'create_tenant'
      : 'update_tenant';
  const resolvedTenantId =
    resolvedTargetMode === 'update_tenant' && activeTenantDiag ? activeTenantDiag.tenant.id : null;

  const lastProposalId = (() => {
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      const prop = turns[i]?.proposal;
      if (prop) return prop.id;
    }
    return undefined;
  })();

  const chatMutation = useMutation({
    mutationFn: (payload: {
      nextTurns: ChatTurn[];
      requirementsHint?: Partial<SupportSetupRequirements>;
      effectiveLocale?: 'vi' | 'en';
    }) =>
      postSupportSetupChat({
        ...(isTenantSetupVisible
          ? { tenantId: resolvedTenantId, targetMode: resolvedTargetMode }
          : {}),
        locale: payload.effectiveLocale ?? uiLocale,
        currentPath: location.pathname,
        messages: payload.nextTurns.slice(-20).map((t) => ({ role: t.role, content: t.content })),
        requirementsHint: payload.requirementsHint,
        baseProposalId: lastProposalId,
      }),
    onSuccess: (res) => {
      if (res.replyLocale === 'vi' || res.replyLocale === 'en') {
        setLangOverride(res.replyLocale);
      }
      setTurns((prev) => [
        ...prev,
        {
          id: makeTurnId(),
          role: 'assistant',
          content: res.reply,
          quickReplies: res.suggestedQuickReplies,
          proposal: res.proposal,
          modelUsed: !res.usedFallback && res.modelUsed ? res.modelUsed : undefined,
          userDiagnostic: res.userDiagnostic ?? null,
          actionProposal: res.actionProposal ?? null,
        },
      ]);
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  const diagnosticsMutation = useMutation({
    mutationFn: () => fetchCopilotUserDiagnostics(72),
    onSuccess: (res) => {
      const diag = res.diagnostic;
      const headline = uiLocale === 'vi' ? diag.headlineVi : diag.headlineEn;
      setTurns((prev) => [
        ...prev,
        {
          id: makeTurnId(),
          role: 'assistant',
          content: headline,
          userDiagnostic: diag,
          actionProposal: diag.recommendedAction,
        },
      ]);
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  const executeActionMutation = useMutation({
    mutationFn: (args: { proposal: CopilotActionProposal }) =>
      postCopilotExecuteAction(buildActionRequestPayload(args.proposal)),
    onSuccess: (res, vars) => {
      setActionStatusMap((prev) => ({ ...prev, [vars.proposal.id]: 'executed' }));
      setTurns((prev) => [
        ...prev,
        {
          id: makeTurnId(),
          role: 'assistant',
          content: uiLocale === 'vi' ? res.messageVi : res.messageEn,
          actionResult: res,
        },
      ]);
      void queryClient.invalidateQueries({ queryKey: ['user-api-keys'] });
      void queryClient.invalidateQueries({ queryKey: ['support-setup-copilot-status'] });
      void queryClient.invalidateQueries({ queryKey: ['copilot-user-diagnostics'] });
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  const applyMutation = useMutation({
    mutationFn: (args: {
      proposalId: string;
      selectedSteps?: SupportSetupStepId[];
      selectedSystemActions?: SupportSystemSettingId[];
    }) =>
      postSupportSetupApply(args.proposalId, {
        approved: true,
        selectedSteps: args.selectedSteps,
        selectedSystemActions: args.selectedSystemActions,
      }),
    onSuccess: (res) => {
      setProposalOverrides((prev) => ({ ...prev, [res.proposal.id]: res.proposal }));
      if (res.tenant) {
        setTargetSelection(res.tenant.id);
      }
      const isSystemSettings = res.proposal.targetMode === 'system_settings';
      const replyContent = isSystemSettings
        ? s.systemSettingsSuccessReply
        : res.tenant && res.diagnostic
          ? uiLocale === 'vi'
            ? `Tuyệt vời! 🎉 Mình đã triển khai xong cấu hình cho **${res.tenant.name}** (${res.diagnostic.completedSteps}/${res.diagnostic.totalSteps} bước sẵn sàng). Bạn có thể bấm **Mở Live Test ngay** để chat thử hoặc sao chép mã nhúng widget bên dưới nhé!`
            : `All set! 🎉 Deployment is complete for **${res.tenant.name}** (${res.diagnostic.completedSteps}/${res.diagnostic.totalSteps} steps ready). Open Live Test to try it out or copy the website embed snippet below!`
          : uiLocale === 'vi'
            ? 'Triển khai hoàn tất thành công!'
            : 'Deployment completed successfully!';

      setTurns((prev) => [
        ...prev,
        {
          id: makeTurnId(),
          role: 'assistant',
          content: replyContent,
          applyResult: res,
        },
      ]);
      void queryClient.invalidateQueries({ queryKey: ['support-setup-copilot-status'] });
      if (isSystemSettings) {
        void queryClient.invalidateQueries({ queryKey: ['settings'] });
        void queryClient.invalidateQueries({ queryKey: ['cache'] });
        void queryClient.invalidateQueries({ queryKey: ['thruline'] });
      }
      void queryClient.invalidateQueries({
        predicate: (q) => {
          const head = q.queryKey[0];
          return (
            typeof head === 'string' &&
            (head.startsWith('x-support') ||
              head.startsWith('tenant-portal') ||
              (isSystemSettings &&
                (head.startsWith('settings') || head.startsWith('cache') || head.startsWith('thruline'))))
          );
        },
      });
      toast.success(isSystemSettings ? s.systemSettingsSuccessTitle : s.deploySuccessTitle);
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  const declineMutation = useMutation({
    mutationFn: (proposalId: string) => postSupportSetupDecline(proposalId),
    onSuccess: (res) => {
      setProposalOverrides((prev) => ({ ...prev, [res.proposal.id]: res.proposal }));
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  // Auto-scroll conversation smoothly whenever messages or typing indicator change
  useEffect(() => {
    if (!open || !messagesRef.current) return;
    const el = messagesRef.current;
    el.scrollTop = el.scrollHeight;
  }, [
    open,
    turns.length,
    chatMutation.isPending,
    applyMutation.isPending,
    executeActionMutation.isPending,
    diagnosticsMutation.isPending,
  ]);

  // Auto-resize composer textarea cleanly without ugly native scrollbars
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const nextHeight = Math.min(el.scrollHeight || 22, 108);
    el.style.height = `${Math.max(22, nextHeight)}px`;
    el.style.overflowY = (el.scrollHeight || 0) > 108 ? 'auto' : 'hidden';
  }, [input, open]);

  if (!canQueryStatus || !isCopilotVisible || !statusData) {
    return null;
  }

  const sendMessage = (
    text: string,
    requirementsHint?: Partial<SupportSetupRequirements>,
  ) => {
    const trimmed = text.trim();
    if (!trimmed || chatMutation.isPending) return;
    let detectedLocale: 'vi' | 'en' = uiLocale;
    if (CLIENT_VI_MARKER_RE.test(trimmed)) {
      detectedLocale = 'vi';
      setLangOverride('vi');
    }
    const userTurn: ChatTurn = { id: makeTurnId(), role: 'user', content: trimmed };
    const nextTurns = [...turns, userTurn];
    setTurns(nextTurns);
    setInput('');
    chatMutation.mutate({ nextTurns, requirementsHint, effectiveLocale: detectedLocale });
  };

  const handleBriefSubmit = () => {
    if (!brief.brandName.trim() && !activeTenantDiag) {
      toast.error(
        uiLocale === 'vi'
          ? 'Vui lòng nhập tên thương hiệu hoặc dịch vụ trước.'
          : 'Please enter a brand or service name first.',
      );
      return;
    }
    const hint: Partial<SupportSetupRequirements> = {
      ...(brief.brandName.trim() ? { brandName: brief.brandName.trim() } : {}),
      ...(brief.industry.trim() ? { industry: brief.industry.trim() } : {}),
      ...(brief.websiteOrigin.trim() ? { websiteOrigin: brief.websiteOrigin.trim() } : {}),
      tone: brief.tone,
      language: brief.language,
      primaryColor: brief.primaryColor,
      ...(brief.faqSummaryOrPolicies.trim()
        ? { faqSummaryOrPolicies: brief.faqSummaryOrPolicies.trim() }
        : {}),
      requireContactIntake: brief.requireContactIntake,
    };
    const summaryText =
      uiLocale === 'vi'
        ? `Thiết lập cho ${brief.brandName.trim() || activeTenantDiag?.tenant.name || 'doanh nghiệp của tôi'}${brief.industry.trim() ? ` (${brief.industry.trim()})` : ''}${brief.websiteOrigin.trim() ? `, website ${brief.websiteOrigin.trim()}` : ''}${brief.faqSummaryOrPolicies.trim() ? `, chính sách: ${brief.faqSummaryOrPolicies.trim()}` : ''}`
        : `Set up for ${brief.brandName.trim() || activeTenantDiag?.tenant.name || 'my business'}${brief.industry.trim() ? ` (${brief.industry.trim()})` : ''}${brief.websiteOrigin.trim() ? `, website ${brief.websiteOrigin.trim()}` : ''}${brief.faqSummaryOrPolicies.trim() ? `, policies: ${brief.faqSummaryOrPolicies.trim()}` : ''}`;
    setBriefOpen(false);
    sendMessage(summaryText, hint);
  };

  const getSelectedSteps = (proposal: SupportSetupProposal): SupportSetupStepId[] =>
    selectedStepsMap[proposal.id] ??
    proposal.steps.filter((st) => st.canApply && st.enabledByDefault).map((st) => st.stepId);

  const toggleProposalStep = (proposal: SupportSetupProposal, stepId: SupportSetupStepId) => {
    const current = new Set(getSelectedSteps(proposal));
    if (current.has(stepId)) {
      current.delete(stepId);
    } else {
      current.add(stepId);
    }
    setSelectedStepsMap((prev) => ({
      ...prev,
      [proposal.id]: proposal.steps
        .map((st) => st.stepId)
        .filter((id) => current.has(id)),
    }));
  };

  const getSelectedSystemActions = (proposal: SupportSetupProposal): SupportSystemSettingId[] =>
    selectedSystemActionsMap[proposal.id] ??
    (proposal.systemActions ?? [])
      .filter((a) => a.canApply && a.enabledByDefault)
      .map((a) => a.settingId);

  const toggleProposalSystemAction = (
    proposal: SupportSetupProposal,
    settingId: SupportSystemSettingId,
  ) => {
    const current = new Set(getSelectedSystemActions(proposal));
    if (current.has(settingId)) {
      current.delete(settingId);
    } else {
      current.add(settingId);
    }
    setSelectedSystemActionsMap((prev) => ({
      ...prev,
      [proposal.id]: (proposal.systemActions ?? [])
        .map((a) => a.settingId)
        .filter((id) => current.has(id)),
    }));
  };

  const openStepRoute = (step: SupportSetupStepDiagnostic) => {
    if (location.pathname.startsWith('/tenant-portal')) {
      navigate('/tenant-portal');
      return;
    }
    navigate(step.thrulinePath);
  };

  const pendingProposalsInTurns = turns.some((t) => {
    const effective = t.proposal ? (proposalOverrides[t.proposal.id] ?? t.proposal) : null;
    const actionPending =
      t.actionProposal && (actionStatusMap[t.actionProposal.id] ?? 'pending') === 'pending';
    return effective?.status === 'pending_consent' || Boolean(actionPending);
  });
  const serverPendingProposals = (statusData.pendingProposals ?? []).filter(
    (p) => (proposalOverrides[p.id] ?? p).status === 'pending_consent',
  );
  const hasPendingApproval = pendingProposalsInTurns || serverPendingProposals.length > 0;

  const onboardingDone = statusData.onboarding?.completedCount ?? 0;
  const progressBadge = isTenantSetupVisible
    ? activeTenantDiag
      ? `${activeTenantDiag.completedSteps}/${activeTenantDiag.totalSteps}`
      : s.launcherNew
    : `${onboardingDone}/3`;

  const visiblePendingFromServer =
    isTenantSetupVisible && turns.length === 0
      ? serverPendingProposals.filter((p) => !turns.some((t) => t.proposal?.id === p.id))
      : [];

  const renderOnboardingChecklist = (checklist: CopilotOnboardingChecklist, cardKey: string) => (
    <div
      className="ssc-onboarding-card"
      data-testid="copilot-onboarding-checklist"
      key={`onb_${cardKey}`}
    >
      <div className="ssc-onboarding-head">
        <span className="ssc-onboarding-title">
          <Sparkles size={13} />
          <span>{s.onboardingCardTitle}</span>
        </span>
        <span className="ssc-status-pill ssc-status-pill--complete">
          {formatSetupString(s.onboardingProgressLabel, {
            done: checklist.completedCount,
            total: checklist.totalCount,
          })}
        </span>
      </div>
      <div className="ssc-onboarding-body">
        {checklist.steps.map((st) => {
          const title = uiLocale === 'vi' ? st.titleVi : st.titleEn;
          const desc = uiLocale === 'vi' ? st.descriptionVi : st.descriptionEn;
          const cta = uiLocale === 'vi' ? st.ctaLabelVi : st.ctaLabelEn;
          return (
            <div
              key={st.id}
              data-testid={`copilot-onboarding-step-${st.id}`}
              className={`ssc-onboarding-step ${st.completed ? 'ssc-onboarding-step--done' : ''}`}
            >
              <div className="ssc-roadmap-main">
                <div className="ssc-roadmap-title">
                  {st.completed ? (
                    <CheckCircle2 size={13} style={{ color: 'var(--ssc-green)' }} />
                  ) : (
                    <Circle size={13} />
                  )}
                  <span>{title}</span>
                  <span
                    className={`ssc-status-pill ${
                      st.completed ? 'ssc-status-pill--complete' : 'ssc-status-pill--partial'
                    }`}
                  >
                    {st.completed ? s.onboardingStepDone : s.onboardingStepPending}
                  </span>
                </div>
                <p className="ssc-roadmap-summary">{desc}</p>
              </div>
              <button
                type="button"
                className="ssc-link-btn"
                onClick={() => {
                  if (st.id === 'mint_personal_key' && !st.completed) {
                    sendMessage(s.starterMintKeyPrompt);
                    return;
                  }
                  navigate(st.targetPath);
                }}
              >
                <span>{cta}</span>
                <ArrowUpRight size={12} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );

  const renderUserDiagnosticCard = (diag: CopilotUserDiagnosticReport, turnId: string) => {
    const healthLabel =
      diag.overallHealth === 'critical'
        ? s.doctorHealthCritical
        : diag.overallHealth === 'degraded'
          ? s.doctorHealthDegraded
          : s.doctorHealthHealthy;
    const healthClass =
      diag.overallHealth === 'critical'
        ? 'ssc-status-pill--missing'
        : diag.overallHealth === 'degraded'
          ? 'ssc-status-pill--partial'
          : 'ssc-status-pill--complete';

    const quotaDisplay =
      diag.quota.tracked && diag.quota.highestUsagePct !== null
        ? `${diag.quota.highestUsagePct}%`
        : s.doctorUnlimitedQuota;

    return (
      <div
        className="ssc-diag-card"
        data-testid="copilot-diagnostic-card"
        key={`diag_${turnId}`}
      >
        <div className="ssc-diag-head">
          <span className="ssc-diag-title">
            <Stethoscope size={13} />
            <span>{s.doctorCardTitle}</span>
          </span>
          <span className={`ssc-status-pill ${healthClass}`}>{healthLabel}</span>
        </div>
        <div className="ssc-diag-body">
          <div className="ssc-diag-metrics">
            <div className="ssc-diag-metric">
              <span className="ssc-diag-metric-label">
                {formatSetupString(s.doctorMetricRequests, { hours: diag.windowHours })}
              </span>
              <span className="ssc-diag-metric-val">{diag.recentRequests.total}</span>
            </div>
            <div className="ssc-diag-metric">
              <span className="ssc-diag-metric-label">{s.doctorMetricErrors}</span>
              <span className="ssc-diag-metric-val">{diag.recentRequests.failed}</span>
            </div>
            <div className="ssc-diag-metric">
              <span className="ssc-diag-metric-label">{s.doctorMetricLatency}</span>
              <span className="ssc-diag-metric-val">{diag.recentRequests.avgLatencyMs}ms</span>
            </div>
            <div className="ssc-diag-metric">
              <span className="ssc-diag-metric-label">{s.doctorMetricQuota}</span>
              <span className="ssc-diag-metric-val">{quotaDisplay}</span>
            </div>
          </div>

          {diag.issues.length === 0 ? (
            <div className="ssc-diag-issue">
              <div className="ssc-diag-issue-desc">{s.doctorNoIssues}</div>
            </div>
          ) : (
            diag.issues.map((issue) => (
              <div
                key={`${issue.category}_${issue.titleEn}`}
                className={`ssc-diag-issue ${
                  issue.severity === 'critical'
                    ? 'ssc-diag-issue--critical'
                    : issue.severity === 'warning'
                      ? 'ssc-diag-issue--warning'
                      : ''
                }`}
              >
                <div className="ssc-diag-issue-title">
                  <span>{uiLocale === 'vi' ? issue.titleVi : issue.titleEn}</span>
                  {issue.category !== 'quota_pressure' && (
                    <span className="ssc-proposal-count">{issue.count}x</span>
                  )}
                </div>
                <div className="ssc-diag-issue-desc">
                  {uiLocale === 'vi' ? issue.rootCauseVi : issue.rootCauseEn}
                </div>
                {issue.sampleError && (
                  <div className="ssc-diag-sample">{issue.sampleError}</div>
                )}
              </div>
            ))
          )}

          <div>
            <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--ssc-muted)', marginBottom: 4 }}>
              {s.doctorActiveKeysLabel} ({diag.activeKeys.length})
            </div>
            {diag.activeKeys.length === 0 ? (
              <span style={{ color: 'var(--ssc-muted)', fontSize: 11 }}>{s.doctorNoActiveKeys}</span>
            ) : (
              <div className="ssc-diag-keys">
                {diag.activeKeys.map((k) => (
                  <span className="ssc-key-pill" key={k.id}>
                    <KeyRound size={11} />
                    <span>
                      {k.name} · {k.keyPrefix} · {k.routingMode.toUpperCase()}
                    </span>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  const renderActionProposalCard = (actionProposal: CopilotActionProposal) => {
    const state = actionStatusMap[actionProposal.id] ?? 'pending';
    const isPending = state === 'pending';
    const title = uiLocale === 'vi' ? actionProposal.titleVi : actionProposal.titleEn;
    const summary = uiLocale === 'vi' ? actionProposal.summaryVi : actionProposal.summaryEn;

    return (
      <div
        className="ssc-action-card"
        data-testid="copilot-action-proposal-card"
        key={actionProposal.id}
      >
        <div className="ssc-action-head">
          <span className="ssc-proposal-tag">
            <ShieldCheck size={13} />
            <span>{s.actionConsentBanner}</span>
          </span>
          {state === 'executed' && (
            <span className="ssc-status-pill ssc-status-pill--complete">
              {s.actionExecutedBadge}
            </span>
          )}
          {state === 'cancelled' && (
            <span className="ssc-status-pill ssc-status-pill--restricted">
              {s.actionCancelledBadge}
            </span>
          )}
        </div>

        <div className="ssc-action-body">
          <div className="ssc-proposal-target">{title}</div>
          <div className="ssc-proposal-step-summary">{summary}</div>
          {actionProposal.onboardingPreview &&
            renderOnboardingChecklist(actionProposal.onboardingPreview, actionProposal.id)}
        </div>

        {isPending && (
          <div className="ssc-proposal-actions">
            <button
              type="button"
              className="ssc-btn ssc-btn--primary"
              data-testid="copilot-action-confirm-btn"
              disabled={executeActionMutation.isPending}
              onClick={() => executeActionMutation.mutate({ proposal: actionProposal })}
            >
              <Check size={13} />
              <span>
                {executeActionMutation.isPending ? s.actionRunning : s.actionConfirmAndRun}
              </span>
            </button>
            <button
              type="button"
              className="ssc-btn ssc-btn--ghost"
              data-testid="copilot-action-cancel-btn"
              disabled={executeActionMutation.isPending}
              onClick={() =>
                setActionStatusMap((prev) => ({ ...prev, [actionProposal.id]: 'cancelled' }))
              }
            >
              <span>{s.actionCancel}</span>
            </button>
          </div>
        )}
      </div>
    );
  };

  const renderActionResultCard = (res: CopilotExecuteActionResponse, turnId: string) => {
    const activeIdeTab: IdeSnippetTab = ideTabMap[turnId] ?? 'cursor';

    if (res.createdKey) {
      const { createdKey } = res;
      const activeSnippet = createdKey.snippets[activeIdeTab];
      const rawKeyCopyId = `raw_${turnId}`;
      const ideCopyId = `ide_${turnId}_${activeIdeTab}`;

      return (
        <div
          className="ssc-result-card"
          data-testid="copilot-action-result-card"
          key={`actres_${turnId}`}
        >
          <div className="ssc-result-title">
            <CheckCircle2 size={15} />
            <span>
              {createdKey.name} ({createdKey.routingMode.toUpperCase()})
            </span>
          </div>

          <div style={{ fontSize: 11 }}>{s.rawKeyOneTimeNotice}</div>
          <div className="ssc-raw-key-box">
            <code className="ssc-raw-key-code" data-testid="copilot-minted-raw-key">
              {createdKey.rawKey}
            </code>
            <button
              type="button"
              className="ssc-btn"
              data-testid="copilot-copy-raw-key"
              onClick={() => {
                void copyText(createdKey.rawKey).then((ok) => {
                  if (ok) {
                    setCopiedId(rawKeyCopyId);
                    setTimeout(() => setCopiedId(null), 1800);
                  }
                });
              }}
            >
              <Copy size={12} />
              <span>{copiedId === rawKeyCopyId ? s.copiedRawKey : s.copyRawKey}</span>
            </button>
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: 6,
            }}
          >
            <strong>{s.ideSnippetsHeading}:</strong>
            <div className="ssc-ide-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={activeIdeTab === 'cursor'}
                data-testid="copilot-ide-tab-cursor"
                className={`ssc-ide-tab ${activeIdeTab === 'cursor' ? 'ssc-ide-tab--active' : ''}`}
                onClick={() => setIdeTabMap((prev) => ({ ...prev, [turnId]: 'cursor' }))}
              >
                Cursor
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeIdeTab === 'claudeCode'}
                data-testid="copilot-ide-tab-claude"
                className={`ssc-ide-tab ${activeIdeTab === 'claudeCode' ? 'ssc-ide-tab--active' : ''}`}
                onClick={() => setIdeTabMap((prev) => ({ ...prev, [turnId]: 'claudeCode' }))}
              >
                Claude Code
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeIdeTab === 'openCode'}
                data-testid="copilot-ide-tab-opencode"
                className={`ssc-ide-tab ${activeIdeTab === 'openCode' ? 'ssc-ide-tab--active' : ''}`}
                onClick={() => setIdeTabMap((prev) => ({ ...prev, [turnId]: 'openCode' }))}
              >
                OpenCode
              </button>
            </div>
          </div>

          <pre className="ssc-snippet" data-testid="copilot-ide-snippet">
            {activeSnippet}
          </pre>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            <button
              type="button"
              className="ssc-btn ssc-btn--primary"
              data-testid="copilot-copy-ide-snippet"
              onClick={() => {
                void copyText(activeSnippet).then((ok) => {
                  if (ok) {
                    setCopiedId(ideCopyId);
                    setTimeout(() => setCopiedId(null), 1800);
                  }
                });
              }}
            >
              <Copy size={12} />
              <span>{copiedId === ideCopyId ? s.copiedIdeConfig : s.copyIdeConfig}</span>
            </button>
          </div>
        </div>
      );
    }

    if (res.updatedKey) {
      return (
        <div
          className="ssc-result-card"
          data-testid="copilot-action-result-card"
          key={`actres_${turnId}`}
        >
          <div className="ssc-result-title">
            <CheckCircle2 size={15} />
            <span>
              {res.updatedKey.name} ({res.updatedKey.keyPrefix}) →{' '}
              {res.updatedKey.routingMode.toUpperCase()}
            </span>
          </div>
        </div>
      );
    }

    if (res.onboarding) {
      return (
        <div data-testid="copilot-action-result-card" key={`actres_${turnId}`} style={{ width: '100%' }}>
          {renderOnboardingChecklist(res.onboarding, turnId)}
        </div>
      );
    }

    return null;
  };

  const renderProposalCard = (rawProposal: SupportSetupProposal) => {
    const proposal = proposalOverrides[rawProposal.id] ?? rawProposal;
    const isSystemSettings = proposal.targetMode === 'system_settings';
    const isPending = proposal.status === 'pending_consent';

    const selectedSteps = new Set(getSelectedSteps(proposal));
    const selectedSystemActions = new Set(getSelectedSystemActions(proposal));

    const hasEditableItem = isSystemSettings
      ? (proposal.systemActions ?? []).some((a) => a.canApply)
      : proposal.steps.some((st) => st.canApply);

    const hasSelected = isSystemSettings ? selectedSystemActions.size > 0 : selectedSteps.size > 0;

    const targetText = isSystemSettings
      ? s.systemSettingsTarget
      : formatSetupString(
          proposal.targetMode === 'create_tenant' ? s.consentTargetCreate : s.consentTargetUpdate,
          { name: proposal.tenantName, slug: proposal.tenantSlug },
        );

    const countText = isSystemSettings
      ? formatSetupString(s.systemSettingsApplyCount, {
          selected: selectedSystemActions.size,
          total: (proposal.systemActions ?? []).length,
        })
      : formatSetupString(s.selectedStepsCount, {
          selected: selectedSteps.size,
          total: proposal.steps.length,
        });

    const statusBadge =
      proposal.status === 'applied'
        ? s.appliedBadge
        : proposal.status === 'declined'
          ? s.declinedBadge
          : proposal.status === 'expired'
            ? s.expiredBadge
            : null;

    return (
      <div
        className="ssc-proposal"
        data-testid="support-setup-proposal-card"
        key={proposal.id}
      >
        <div className="ssc-proposal-head">
          <div className="ssc-proposal-badge-row">
            <span className="ssc-proposal-tag">
              <ShieldCheck size={13} />
              <span>{s.consentBanner}</span>
            </span>
            {proposal.isSurgical && !isSystemSettings && (
              <span className="ssc-status-pill ssc-status-pill--surgical" data-testid="support-setup-surgical-badge">
                <Sliders size={11} />
                <span>{s.surgicalBadge}</span>
              </span>
            )}
            {statusBadge ? (
              <span className="ssc-status-pill ssc-status-pill--complete">{statusBadge}</span>
            ) : (
              <span className="ssc-proposal-count">{countText}</span>
            )}
          </div>
          <div className="ssc-proposal-target">{targetText}</div>
        </div>

        {isSystemSettings ? (
          <div className="ssc-proposal-steps" data-testid="support-setup-system-actions">
            {(proposal.systemActions ?? []).map((action) => {
              const checked = selectedSystemActions.has(action.settingId);
              const title = uiLocale === 'vi' ? action.titleVi : action.titleEn;
              const summary = uiLocale === 'vi' ? action.summaryVi : action.summaryEn;
              const curVal = uiLocale === 'vi' ? action.currentValueVi : action.currentValueEn;
              const propVal = uiLocale === 'vi' ? action.proposedValueVi : action.proposedValueEn;
              const disabled = !isPending || !action.canApply;
              return (
                <label className="ssc-proposal-step ssc-proposal-system-action" key={action.settingId}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled}
                    onChange={() => toggleProposalSystemAction(proposal, action.settingId)}
                  />
                  <div style={{ flex: 1 }}>
                    <div
                      className="ssc-proposal-step-title"
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}
                    >
                      <span>{title}</span>
                      {!action.canApply && (
                        <span className="ssc-status-pill ssc-status-pill--restricted">
                          <Lock size={10} style={{ marginRight: 3, verticalAlign: 'middle' }} />
                          {action.requiredPermission}
                        </span>
                      )}
                    </div>
                    <div className="ssc-proposal-step-summary">{summary}</div>
                    <div className="ssc-action-diff-preview">
                      <span className="ssc-action-diff-old">{curVal}</span>
                      <span className="ssc-action-diff-arrow">➔</span>
                      <span className="ssc-action-diff-new">{propVal}</span>
                    </div>
                  </div>
                </label>
              );
            })}
          </div>
        ) : (
          <div className="ssc-proposal-steps">
            {proposal.steps.map((step) => {
              const checked = selectedSteps.has(step.stepId);
              const title = uiLocale === 'vi' ? step.titleVi : step.titleEn;
              const summary = uiLocale === 'vi' ? step.summaryVi : step.summaryEn;
              const disabled = !isPending || !step.canApply;
              return (
                <label className="ssc-proposal-step" key={step.stepId}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled}
                    onChange={() => toggleProposalStep(proposal, step.stepId)}
                  />
                  <div>
                    <div className="ssc-proposal-step-title">{title}</div>
                    <div className="ssc-proposal-step-summary">
                      {step.canApply ? summary : `${summary} · ${s.consentNoPermission}`}
                    </div>
                  </div>
                </label>
              );
            })}
          </div>
        )}

        {isPending && (
          <div className="ssc-proposal-actions">
            <button
              type="button"
              className="ssc-btn ssc-btn--primary"
              data-testid="support-setup-approve-btn"
              disabled={
                !hasEditableItem ||
                !hasSelected ||
                applyMutation.isPending ||
                declineMutation.isPending
              }
              onClick={() => {
                if (isSystemSettings) {
                  applyMutation.mutate({
                    proposalId: proposal.id,
                    selectedSystemActions: [...selectedSystemActions],
                  });
                } else {
                  applyMutation.mutate({
                    proposalId: proposal.id,
                    selectedSteps: [...selectedSteps],
                  });
                }
              }}
            >
              <Check size={13} />
              <span>{applyMutation.isPending ? s.deploying : s.approveAndDeploy}</span>
            </button>

            <button
              type="button"
              className="ssc-btn"
              onClick={() => {
                setInput(s.revisionHint);
                inputRef.current?.focus();
              }}
            >
              <span>{s.requestRevision}</span>
            </button>

            <button
              type="button"
              className="ssc-btn ssc-btn--ghost"
              data-testid="support-setup-decline-btn"
              disabled={applyMutation.isPending || declineMutation.isPending}
              onClick={() => declineMutation.mutate(proposal.id)}
            >
              <span>{s.declinePlan}</span>
            </button>
          </div>
        )}
      </div>
    );
  };

  const panelTitleText = isTenantSetupVisible ? s.panelTitle : s.memberPanelTitle;
  const panelSubtitleText = isTenantSetupVisible ? s.panelSubtitle : s.memberPanelSubtitle;

  return (
    <div className="ssc-root">
      {!open ? (
        <button
          type="button"
          className="ssc-launcher"
          data-testid="support-setup-copilot-launcher"
          aria-label={s.launcherTitle}
          onClick={() => setOpen(true)}
        >
          <span className="ssc-launcher-orb" aria-hidden="true">
            <Sparkles size={15} />
          </span>
          <span>{s.launcherTitle}</span>
          <span className="ssc-launcher-badge">
            {hasPendingApproval && <span className="ssc-launcher-dot" aria-hidden="true" />}
            <span>{hasPendingApproval ? s.launcherPending : progressBadge}</span>
          </span>
        </button>
      ) : (
        <section
          role="dialog"
          aria-label={panelTitleText}
          data-testid="support-setup-copilot-panel"
          className={`ssc-panel ${wide ? 'ssc-panel--wide' : ''}`}
        >
          <header className="ssc-header">
            <div className="ssc-header-title">
              <div className="ssc-header-icon-wrap">
                <div className="ssc-header-icon">
                  <Bot size={17} />
                </div>
                <span className="ssc-online-dot" aria-hidden="true" />
              </div>
              <div className="ssc-header-text">
                <h2>{panelTitleText}</h2>
                <p>{panelSubtitleText}</p>
              </div>
            </div>
            <div className="ssc-header-actions">
              <button
                type="button"
                className="ssc-lang-btn"
                data-testid="support-setup-lang-toggle"
                title={uiLocale === 'vi' ? 'Switch Copilot to English' : 'Chuyển sang Tiếng Việt'}
                onClick={() => setLangOverride(uiLocale === 'vi' ? 'en' : 'vi')}
              >
                {uiLocale === 'vi' ? 'VI' : 'EN'}
              </button>
              <button
                type="button"
                className="ssc-icon-btn"
                aria-label={wide ? s.compactPanel : s.expandPanel}
                title={wide ? s.compactPanel : s.expandPanel}
                onClick={() => setWide((v) => !v)}
              >
                {wide ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              </button>
              {turns.length > 0 && (
                <button
                  type="button"
                  className="ssc-icon-btn"
                  aria-label={s.clearChat}
                  title={s.clearChat}
                  onClick={() => setTurns([])}
                >
                  <RotateCcw size={14} />
                </button>
              )}
              <button
                type="button"
                className="ssc-icon-btn"
                aria-label={s.closePanel}
                title={s.closePanel}
                onClick={() => setOpen(false)}
              >
                <X size={15} />
              </button>
            </div>
          </header>

          <div className="ssc-toolbar">
            {isTenantSetupVisible ? (
              <>
                <div className="ssc-toolbar-row">
                  <div className="ssc-tenant-select-wrap">
                    <label htmlFor="ssc-tenant-select">{s.tenantLabel}</label>
                    <select
                      id="ssc-tenant-select"
                      className="ssc-select"
                      value={
                        targetSelection === 'new'
                          ? 'new'
                          : resolvedTenantId !== null
                            ? String(resolvedTenantId)
                            : 'new'
                      }
                      onChange={(e) => {
                        const val = e.target.value;
                        setTargetSelection(val === 'new' ? 'new' : Number(val));
                      }}
                    >
                      {tenants.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name} ({t.slug})
                        </option>
                      ))}
                      {canCreateTenant && <option value="new">{s.newTenantOption}</option>}
                    </select>
                  </div>

                  <button
                    type="button"
                    className="ssc-pill-toggle"
                    data-testid="copilot-error-doctor-pill"
                    disabled={diagnosticsMutation.isPending}
                    onClick={() => diagnosticsMutation.mutate()}
                  >
                    <Activity size={13} />
                    <span>{s.doctorPillLabel}</span>
                  </button>

                  {canEditAnyStep ? (
                    <button
                      type="button"
                      className={`ssc-pill-toggle ${briefOpen ? 'ssc-pill-toggle--active' : ''}`}
                      onClick={() => setBriefOpen((v) => !v)}
                    >
                      <ClipboardList size={13} />
                      <span>{s.briefToggle}</span>
                    </button>
                  ) : (
                    <span
                      className="ssc-status-pill ssc-status-pill--restricted"
                      data-testid="support-setup-readonly-badge"
                    >
                      {s.readOnlyBadge}
                    </span>
                  )}
                </div>

                {activeTenantDiag && (
                  <div className="ssc-progress-row">
                    <span className="ssc-progress-label">
                      {formatSetupString(s.roadmapProgress, {
                        done: activeTenantDiag.completedSteps,
                        total: activeTenantDiag.totalSteps,
                      })}
                    </span>
                    <div className="ssc-seg-bar" aria-hidden="true">
                      {activeTenantDiag.steps.map((st) => (
                        <span
                          key={st.stepId}
                          className={`ssc-seg ssc-seg--${st.status}`}
                        />
                      ))}
                    </div>
                    <button
                      type="button"
                      className="ssc-link-btn"
                      data-testid="support-setup-roadmap-toggle"
                      onClick={() => setRoadmapOpen((v) => !v)}
                    >
                      <span>{roadmapOpen ? s.roadmapToggleHide : s.roadmapToggleShow}</span>
                      {roadmapOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                    </button>
                  </div>
                )}
              </>
            ) : (
              <div className="ssc-toolbar-row">
                <button
                  type="button"
                  className="ssc-pill-toggle"
                  data-testid="copilot-error-doctor-pill"
                  disabled={diagnosticsMutation.isPending}
                  onClick={() => diagnosticsMutation.mutate()}
                >
                  <Stethoscope size={13} />
                  <span>{s.doctorPillLabel}</span>
                </button>
                <button
                  type="button"
                  className="ssc-pill-toggle"
                  data-testid="copilot-onboarding-pill"
                  disabled={chatMutation.isPending}
                  onClick={() => sendMessage(s.starterOnboardingPrompt)}
                >
                  <Sparkles size={13} />
                  <span>
                    {formatSetupString(s.onboardingPillLabel, { done: onboardingDone })}
                  </span>
                </button>
              </div>
            )}
          </div>

          {roadmapOpen && isTenantSetupVisible && activeTenantDiag && (
            <div className="ssc-roadmap" data-testid="support-setup-roadmap">
              {activeTenantDiag.steps.map((step) => {
                const statusLabel =
                  step.status === 'complete'
                    ? s.stepComplete
                    : step.status === 'partial'
                      ? s.stepPartial
                      : step.status === 'restricted'
                        ? s.stepRestricted
                        : s.stepMissing;
                const Icon =
                  step.status === 'complete'
                    ? CheckCircle2
                    : step.status === 'partial'
                      ? AlertCircle
                      : step.status === 'restricted'
                        ? Lock
                        : Circle;
                return (
                  <div className="ssc-roadmap-item" key={step.stepId}>
                    <div className="ssc-roadmap-main">
                      <div className="ssc-roadmap-title">
                        <Icon size={13} />
                        <span>{s.stepTitles[step.stepId]}</span>
                        <span className={`ssc-status-pill ssc-status-pill--${step.status}`}>
                          {statusLabel}
                        </span>
                      </div>
                      <p className="ssc-roadmap-summary">
                        {uiLocale === 'vi' ? step.summaryVi : step.summaryEn}
                      </p>
                    </div>
                    {step.canView !== false && step.status !== 'restricted' && (
                      <button
                        type="button"
                        className="ssc-link-btn"
                        onClick={() => openStepRoute(step)}
                      >
                        <span>{s.stepOpen}</span>
                        <ArrowUpRight size={12} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {briefOpen && isTenantSetupVisible && canEditAnyStep && (
            <div className="ssc-brief" data-testid="support-setup-brief">
              <div style={{ fontSize: 11.5, fontWeight: 600 }}>{s.briefHeading}</div>
              <div className="ssc-brief-grid">
                <div className="ssc-field">
                  <label htmlFor="ssc-brand">{s.briefBrandLabel}</label>
                  <input
                    id="ssc-brand"
                    className="ssc-input"
                    value={brief.brandName}
                    placeholder={s.briefBrandPlaceholder}
                    onChange={(e) => setBrief((b) => ({ ...b, brandName: e.target.value }))}
                  />
                </div>
                <div className="ssc-field">
                  <label htmlFor="ssc-industry">{s.briefIndustryLabel}</label>
                  <input
                    id="ssc-industry"
                    className="ssc-input"
                    value={brief.industry}
                    placeholder={s.briefIndustryPlaceholder}
                    onChange={(e) => setBrief((b) => ({ ...b, industry: e.target.value }))}
                  />
                </div>
                <div className="ssc-field">
                  <label htmlFor="ssc-website">{s.briefWebsiteLabel}</label>
                  <input
                    id="ssc-website"
                    className="ssc-input"
                    value={brief.websiteOrigin}
                    placeholder={s.briefWebsitePlaceholder}
                    onChange={(e) => setBrief((b) => ({ ...b, websiteOrigin: e.target.value }))}
                  />
                </div>
                <div className="ssc-field">
                  <label htmlFor="ssc-tone">{s.briefToneLabel}</label>
                  <select
                    id="ssc-tone"
                    className="ssc-select"
                    value={brief.tone}
                    onChange={(e) =>
                      setBrief((b) => ({ ...b, tone: e.target.value as SupportSetupTone }))
                    }
                  >
                    <option value="friendly">{s.toneOptions.friendly}</option>
                    <option value="professional">{s.toneOptions.professional}</option>
                    <option value="empathetic">{s.toneOptions.empathetic}</option>
                    <option value="technical">{s.toneOptions.technical}</option>
                  </select>
                </div>
                <div className="ssc-field">
                  <label htmlFor="ssc-language">{s.briefLanguageLabel}</label>
                  <select
                    id="ssc-language"
                    className="ssc-select"
                    value={brief.language}
                    onChange={(e) =>
                      setBrief((b) => ({
                        ...b,
                        language: e.target.value as SupportSetupLanguage,
                      }))
                    }
                  >
                    <option value="vi">{s.languageOptions.vi}</option>
                    <option value="en">{s.languageOptions.en}</option>
                    <option value="bilingual">{s.languageOptions.bilingual}</option>
                  </select>
                </div>
                <div className="ssc-field">
                  <label htmlFor="ssc-color">{s.briefColorLabel}</label>
                  <div className="ssc-color-row">
                    <input
                      id="ssc-color"
                      type="color"
                      className="ssc-color-picker"
                      value={brief.primaryColor}
                      onChange={(e) => setBrief((b) => ({ ...b, primaryColor: e.target.value }))}
                    />
                    <input
                      aria-label={s.briefColorLabel}
                      className="ssc-input"
                      value={brief.primaryColor}
                      onChange={(e) => setBrief((b) => ({ ...b, primaryColor: e.target.value }))}
                    />
                  </div>
                </div>
              </div>
              <div className="ssc-field">
                <label htmlFor="ssc-policies">{s.briefPoliciesLabel}</label>
                <textarea
                  id="ssc-policies"
                  rows={2}
                  className="ssc-textarea"
                  value={brief.faqSummaryOrPolicies}
                  placeholder={s.briefPoliciesPlaceholder}
                  onChange={(e) =>
                    setBrief((b) => ({ ...b, faqSummaryOrPolicies: e.target.value }))
                  }
                />
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5 }}>
                <input
                  type="checkbox"
                  checked={brief.requireContactIntake}
                  onChange={(e) =>
                    setBrief((b) => ({ ...b, requireContactIntake: e.target.checked }))
                  }
                />
                <span>{s.briefIntakeLabel}</span>
              </label>
              <div>
                <button
                  type="button"
                  className="ssc-btn ssc-btn--primary"
                  onClick={handleBriefSubmit}
                >
                  <Wand2 size={13} />
                  <span>{s.briefSubmit}</span>
                </button>
              </div>
            </div>
          )}

          <div className="ssc-messages" ref={messagesRef}>
            {turns.length === 0 && (
              <div className="ssc-welcome">
                <span className="ssc-welcome-badge">
                  <Sparkles size={11} />
                  <span>{isTenantSetupVisible ? s.welcomeBadge : s.memberWelcomeBadge}</span>
                </span>
                <h3>{isTenantSetupVisible ? s.welcomeTitle : s.memberWelcomeTitle}</h3>
                <p>{isTenantSetupVisible ? s.welcomeDescription : s.memberWelcomeDescription}</p>
                <div className="ssc-starters">
                  {isTenantSetupVisible ? (
                    <>
                      {canEditAnyStep && (
                        <button
                          type="button"
                          className="ssc-starter-btn"
                          onClick={() => sendMessage(s.starterAutoSetupPrompt)}
                        >
                          <span className="ssc-starter-icon" aria-hidden="true">
                            <Wand2 size={15} />
                          </span>
                          <span className="ssc-starter-copy">
                            <span className="ssc-starter-title">{s.starterAutoSetup}</span>
                            <span className="ssc-starter-desc">{s.starterAutoSetupDesc}</span>
                          </span>
                          <ChevronRight size={14} className="ssc-starter-arrow" aria-hidden="true" />
                        </button>
                      )}
                      {activeTenantDiag && canEditAnyStep && (
                        <button
                          type="button"
                          className="ssc-starter-btn"
                          onClick={() => sendMessage(s.starterCompleteCurrentPrompt)}
                        >
                          <span className="ssc-starter-icon" aria-hidden="true">
                            <CheckCircle2 size={15} />
                          </span>
                          <span className="ssc-starter-copy">
                            <span className="ssc-starter-title">{s.starterCompleteCurrent}</span>
                            <span className="ssc-starter-desc">{s.starterCompleteCurrentDesc}</span>
                          </span>
                          <ChevronRight size={14} className="ssc-starter-arrow" aria-hidden="true" />
                        </button>
                      )}
                      <button
                        type="button"
                        className="ssc-starter-btn"
                        onClick={() => sendMessage(s.starterGuidePrompt)}
                      >
                        <span className="ssc-starter-icon" aria-hidden="true">
                          <Sparkles size={15} />
                        </span>
                        <span className="ssc-starter-copy">
                          <span className="ssc-starter-title">{s.starterGuide}</span>
                          <span className="ssc-starter-desc">{s.starterGuideDesc}</span>
                        </span>
                        <ChevronRight size={14} className="ssc-starter-arrow" aria-hidden="true" />
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="ssc-starter-btn"
                        data-testid="copilot-starter-doctor"
                        onClick={() => sendMessage(s.starterDoctorPrompt)}
                      >
                        <span className="ssc-starter-icon" aria-hidden="true">
                          <Stethoscope size={15} />
                        </span>
                        <span className="ssc-starter-copy">
                          <span className="ssc-starter-title">{s.starterDoctor}</span>
                          <span className="ssc-starter-desc">{s.starterDoctorDesc}</span>
                        </span>
                        <ChevronRight size={14} className="ssc-starter-arrow" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="ssc-starter-btn"
                        data-testid="copilot-starter-mint-key"
                        onClick={() => sendMessage(s.starterMintKeyPrompt)}
                      >
                        <span className="ssc-starter-icon" aria-hidden="true">
                          <KeyRound size={15} />
                        </span>
                        <span className="ssc-starter-copy">
                          <span className="ssc-starter-title">{s.starterMintKey}</span>
                          <span className="ssc-starter-desc">{s.starterMintKeyDesc}</span>
                        </span>
                        <ChevronRight size={14} className="ssc-starter-arrow" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="ssc-starter-btn"
                        data-testid="copilot-starter-onboarding"
                        onClick={() => sendMessage(s.starterOnboardingPrompt)}
                      >
                        <span className="ssc-starter-icon" aria-hidden="true">
                          <CheckCircle2 size={15} />
                        </span>
                        <span className="ssc-starter-copy">
                          <span className="ssc-starter-title">{s.starterOnboarding}</span>
                          <span className="ssc-starter-desc">{s.starterOnboardingDesc}</span>
                        </span>
                        <ChevronRight size={14} className="ssc-starter-arrow" aria-hidden="true" />
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}

            {visiblePendingFromServer.map((p) => renderProposalCard(p))}

            {turns.map((turn) => (
              <div className={`ssc-msg-row ssc-msg-row--${turn.role}`} key={turn.id}>
                {turn.role === 'assistant' && (
                  <div className="ssc-msg-meta">
                    <span className="ssc-msg-avatar" aria-hidden="true">
                      <Sparkles size={11} />
                    </span>
                    <span>{s.assistantName}</span>
                    {turn.modelUsed && (
                      <span className="ssc-model-badge" title={`Model: ${turn.modelUsed}`}>
                        ⚡ {turn.modelUsed}
                      </span>
                    )}
                  </div>
                )}

                <div className={`ssc-bubble ssc-bubble--${turn.role}`}>
                  {turn.role === 'assistant' ? (
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{turn.content}</ReactMarkdown>
                  ) : (
                    turn.content
                  )}
                </div>

                {turn.userDiagnostic && renderUserDiagnosticCard(turn.userDiagnostic, turn.id)}

                {turn.actionProposal && renderActionProposalCard(turn.actionProposal)}

                {turn.actionResult && renderActionResultCard(turn.actionResult, turn.id)}

                {turn.quickReplies && turn.quickReplies.length > 0 && (
                  <div className="ssc-quick-replies">
                    {turn.quickReplies.map((qr) => (
                      <button
                        key={qr}
                        type="button"
                        className="ssc-chip-btn"
                        title={qr}
                        disabled={chatMutation.isPending}
                        onClick={() => sendMessage(qr)}
                      >
                        <Sparkles size={11} aria-hidden="true" />
                        <span className="ssc-chip-label">{formatQuickReplyLabel(qr)}</span>
                      </button>
                    ))}
                  </div>
                )}

                {turn.proposal && renderProposalCard(turn.proposal)}

                {turn.applyResult && (
                  <div className="ssc-result-card" data-testid="support-setup-applied-card">
                    <div className="ssc-result-title">
                      <CheckCircle2 size={15} />
                      <span>
                        {turn.applyResult.proposal.targetMode === 'system_settings'
                          ? s.systemSettingsSuccessTitle
                          : s.deploySuccessTitle}
                      </span>
                    </div>

                    {turn.applyResult.systemResults && turn.applyResult.systemResults.length > 0 && (
                      <div className="ssc-system-results" data-testid="support-setup-system-results">
                        {turn.applyResult.systemResults.map((r) => (
                          <div className="ssc-system-result-row" key={r.settingId}>
                            <span
                              className={`ssc-status-pill ssc-status-pill--${r.status === 'applied' ? 'complete' : 'restricted'}`}
                            >
                              {r.status === 'applied'
                                ? uiLocale === 'vi'
                                  ? 'Đã áp dụng'
                                  : 'Applied'
                                : uiLocale === 'vi'
                                  ? 'Bỏ qua'
                                  : 'Skipped'}
                            </span>
                            <span className="ssc-system-result-detail">
                              {uiLocale === 'vi' ? r.detailVi : r.detailEn}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}

                    {turn.applyResult.diagnostic?.embedSnippet && (
                      <>
                        <div>
                          <strong>{s.embedLabel}:</strong>
                        </div>
                        <pre className="ssc-snippet">{turn.applyResult.diagnostic.embedSnippet}</pre>
                      </>
                    )}
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {turn.applyResult.diagnostic?.embedSnippet && (
                        <button
                          type="button"
                          className="ssc-btn"
                          onClick={() => {
                            void copyText(turn.applyResult!.diagnostic!.embedSnippet).then((ok) => {
                              if (ok) {
                                setCopiedId(turn.applyResult!.proposalId);
                                setTimeout(() => setCopiedId(null), 1800);
                              }
                            });
                          }}
                        >
                          <Copy size={12} />
                          <span>
                            {copiedId === turn.applyResult.proposalId
                              ? s.copiedSnippet
                              : s.copySnippet}
                          </span>
                        </button>
                      )}
                      {turn.applyResult.tenant && (
                        <button
                          type="button"
                          className="ssc-btn ssc-btn--primary"
                          onClick={() =>
                            navigate(
                              session.hasPermission('use_x_gateway')
                                ? '/thruline/support-desk'
                                : '/tenant-portal',
                            )
                          }
                        >
                          <span>{s.openLiveTest}</span>
                          <ArrowUpRight size={12} />
                        </button>
                      )}
                      {turn.applyResult.tenant && (
                        <button
                          type="button"
                          className="ssc-btn"
                          onClick={() =>
                            navigate(
                              session.hasPermission('use_x_gateway')
                                ? '/thruline/support-integration'
                                : '/tenant-portal',
                            )
                          }
                        >
                          <span>{s.openIntegration}</span>
                          <ArrowUpRight size={12} />
                        </button>
                      )}
                      {turn.applyResult.proposal.targetMode === 'system_settings' && (
                        <button
                          type="button"
                          className="ssc-btn ssc-btn--primary"
                          onClick={() => navigate('/settings')}
                        >
                          <span>{s.openSettings}</span>
                          <ArrowUpRight size={12} />
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}

            {(chatMutation.isPending || diagnosticsMutation.isPending) && (
              <div className="ssc-msg-row ssc-msg-row--assistant">
                <div className="ssc-msg-meta">
                  <span className="ssc-msg-avatar" aria-hidden="true">
                    <Sparkles size={11} />
                  </span>
                  <span>{s.assistantName}</span>
                </div>
                <div className="ssc-typing" role="status">
                  <span className="ssc-typing-dots" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                  </span>
                  <span>{s.thinking}</span>
                </div>
              </div>
            )}
          </div>

          <div className="ssc-composer">
            <div className="ssc-composer-box">
              <textarea
                ref={inputRef}
                rows={1}
                value={input}
                placeholder={s.inputPlaceholder}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendMessage(input);
                  }
                }}
              />
              <div className="ssc-composer-footer">
                <span className="ssc-composer-hint">{s.composerHint}</span>
                <button
                  type="button"
                  className="ssc-send-btn"
                  data-testid="support-setup-send-btn"
                  aria-label={s.send}
                  disabled={!input.trim() || chatMutation.isPending}
                  onClick={() => sendMessage(input)}
                >
                  <span>{s.send}</span>
                  <ArrowUp size={13} />
                </button>
              </div>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

export default SupportSetupCopilot;
