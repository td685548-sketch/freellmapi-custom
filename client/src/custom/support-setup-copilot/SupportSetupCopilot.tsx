import { useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  AlertCircle,
  ArrowUpRight,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Circle,
  ClipboardList,
  Copy,
  Maximize2,
  Minimize2,
  RotateCcw,
  Send,
  ShieldCheck,
  Sparkles,
  Wand2,
  X,
} from 'lucide-react';
import { useI18n } from '@/i18n';
import { copyText } from '@/lib/clipboard';
import { toast } from '@/lib/toast';
import { useUserSession } from '../use-session';
import type {
  SupportSetupApplyResponse,
  SupportSetupLanguage,
  SupportSetupProposal,
  SupportSetupRequirements,
  SupportSetupStepDiagnostic,
  SupportSetupStepId,
  SupportSetupTone,
} from '../../../../shared/support-setup-copilot';
import {
  fetchSupportSetupStatus,
  isSupportSetupCopilotRoute,
  postSupportSetupApply,
  postSupportSetupChat,
  postSupportSetupDecline,
} from './api';
import { formatSetupString, useSupportSetupCopilotStrings } from './strings';
import './support-setup-copilot.css';

interface ChatTurn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  quickReplies?: string[];
  proposal?: SupportSetupProposal | null;
  applyResult?: SupportSetupApplyResponse | null;
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

export function SupportSetupCopilot() {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { locale } = useI18n();
  const uiLocale: 'vi' | 'en' = locale === 'vi' ? 'vi' : 'en';
  const s = useSupportSetupCopilotStrings();
  const session = useUserSession();

  const onEligibleRoute = isSupportSetupCopilotRoute(location.pathname);
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
  const [proposalOverrides, setProposalOverrides] = useState<Record<string, SupportSetupProposal>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

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
  const tenants = statusData?.tenants ?? [];
  const activeTenantDiag = statusData?.activeTenant ?? null;
  const canCreateTenant = Boolean(statusData?.canCreateTenant);

  const resolvedTargetMode: 'create_tenant' | 'update_tenant' =
    targetSelection === 'new' || !activeTenantDiag ? 'create_tenant' : 'update_tenant';
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
    }) =>
      postSupportSetupChat({
        tenantId: resolvedTenantId,
        targetMode: resolvedTargetMode,
        locale: uiLocale,
        messages: payload.nextTurns.slice(-20).map((t) => ({ role: t.role, content: t.content })),
        requirementsHint: payload.requirementsHint,
        baseProposalId: lastProposalId,
      }),
    onSuccess: (res) => {
      setTurns((prev) => [
        ...prev,
        {
          id: makeTurnId(),
          role: 'assistant',
          content: res.reply,
          quickReplies: res.suggestedQuickReplies,
          proposal: res.proposal,
        },
      ]);
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  const applyMutation = useMutation({
    mutationFn: (args: { proposalId: string; selectedSteps: SupportSetupStepId[] }) =>
      postSupportSetupApply(args.proposalId, {
        approved: true,
        selectedSteps: args.selectedSteps,
      }),
    onSuccess: (res) => {
      setProposalOverrides((prev) => ({ ...prev, [res.proposal.id]: res.proposal }));
      setTargetSelection(res.tenant.id);
      setTurns((prev) => [
        ...prev,
        {
          id: makeTurnId(),
          role: 'assistant',
          content:
            uiLocale === 'vi'
              ? `Đã triển khai xong cho **${res.tenant.name}** (${res.diagnostic.completedSteps}/${res.diagnostic.totalSteps} bước đạt). Bạn có thể mở **Live Test** hoặc copy mã nhúng widget ngay bên dưới!`
              : `Deployment complete for **${res.tenant.name}** (${res.diagnostic.completedSteps}/${res.diagnostic.totalSteps} steps ready). Copy the embed snippet below or open Live Test!`,
          applyResult: res,
        },
      ]);
      void queryClient.invalidateQueries({ queryKey: ['support-setup-copilot-status'] });
      void queryClient.invalidateQueries({
        predicate: (q) => {
          const head = q.queryKey[0];
          return (
            typeof head === 'string' &&
            (head.startsWith('x-support') || head.startsWith('tenant-portal'))
          );
        },
      });
      toast.success(s.deploySuccessTitle);
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

  if (!canQueryStatus || !statusData?.visible) {
    return null;
  }

  const sendMessage = (
    text: string,
    requirementsHint?: Partial<SupportSetupRequirements>,
  ) => {
    const trimmed = text.trim();
    if (!trimmed || chatMutation.isPending) return;
    const userTurn: ChatTurn = { id: makeTurnId(), role: 'user', content: trimmed };
    const nextTurns = [...turns, userTurn];
    setTurns(nextTurns);
    setInput('');
    chatMutation.mutate({ nextTurns, requirementsHint });
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

  const openStepRoute = (step: SupportSetupStepDiagnostic) => {
    if (location.pathname.startsWith('/tenant-portal')) {
      navigate('/tenant-portal');
      return;
    }
    navigate(step.thrulinePath);
  };

  const pendingProposalsInTurns = turns.some((t) => {
    const effective = t.proposal ? (proposalOverrides[t.proposal.id] ?? t.proposal) : null;
    return effective?.status === 'pending_consent';
  });
  const serverPendingProposals = (statusData.pendingProposals ?? []).filter(
    (p) => (proposalOverrides[p.id] ?? p).status === 'pending_consent',
  );
  const hasPendingApproval = pendingProposalsInTurns || serverPendingProposals.length > 0;

  const progressBadge = activeTenantDiag
    ? `${activeTenantDiag.completedSteps}/${activeTenantDiag.totalSteps}`
    : s.launcherNew;

  const visiblePendingFromServer =
    turns.length === 0
      ? serverPendingProposals.filter((p) => !turns.some((t) => t.proposal?.id === p.id))
      : [];

  const renderProposalCard = (rawProposal: SupportSetupProposal) => {
    const proposal = proposalOverrides[rawProposal.id] ?? rawProposal;
    const selected = new Set(getSelectedSteps(proposal));
    const isPending = proposal.status === 'pending_consent';
    const hasEditableStep = proposal.steps.some((st) => st.canApply);
    const targetText = formatSetupString(
      proposal.targetMode === 'create_tenant' ? s.consentTargetCreate : s.consentTargetUpdate,
      { name: proposal.tenantName, slug: proposal.tenantSlug },
    );

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
            {statusBadge && <span className="ssc-status-pill ssc-status-pill--complete">{statusBadge}</span>}
          </div>
          <div className="ssc-proposal-target">{targetText}</div>
        </div>

        <div className="ssc-proposal-steps">
          {proposal.steps.map((step) => {
            const checked = selected.has(step.stepId);
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

        {isPending && (
          <div className="ssc-proposal-actions">
            <button
              type="button"
              className="ssc-btn ssc-btn--primary"
              data-testid="support-setup-approve-btn"
              disabled={
                !hasEditableStep ||
                selected.size === 0 ||
                applyMutation.isPending ||
                declineMutation.isPending
              }
              onClick={() =>
                applyMutation.mutate({
                  proposalId: proposal.id,
                  selectedSteps: [...selected],
                })
              }
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
          <Sparkles size={16} />
          <span>{s.launcherTitle}</span>
          <span className="ssc-launcher-badge">
            {hasPendingApproval && <span className="ssc-launcher-dot" aria-hidden="true" />}
            <span>{hasPendingApproval ? s.launcherPending : progressBadge}</span>
          </span>
        </button>
      ) : (
        <section
          role="dialog"
          aria-label={s.panelTitle}
          data-testid="support-setup-copilot-panel"
          className={`ssc-panel ${wide ? 'ssc-panel--wide' : ''}`}
        >
          <header className="ssc-header">
            <div className="ssc-header-title">
              <div className="ssc-header-icon">
                <Bot size={16} />
              </div>
              <div className="ssc-header-text">
                <h2>{s.panelTitle}</h2>
                <p>{s.panelSubtitle}</p>
              </div>
            </div>
            <div className="ssc-header-actions">
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
                className="ssc-link-btn"
                onClick={() => setBriefOpen((v) => !v)}
              >
                <ClipboardList size={13} />
                <span>{s.briefToggle}</span>
              </button>
            </div>

            {activeTenantDiag && (
              <div className="ssc-progress-row">
                <span>
                  {formatSetupString(s.roadmapProgress, {
                    done: activeTenantDiag.completedSteps,
                    total: activeTenantDiag.totalSteps,
                  })}
                </span>
                <div className="ssc-progress-bar" aria-hidden="true">
                  <div
                    className="ssc-progress-fill"
                    style={{
                      width: `${Math.round((activeTenantDiag.completedSteps / activeTenantDiag.totalSteps) * 100)}%`,
                    }}
                  />
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
          </div>

          {roadmapOpen && activeTenantDiag && (
            <div className="ssc-roadmap" data-testid="support-setup-roadmap">
              {activeTenantDiag.steps.map((step) => {
                const statusLabel =
                  step.status === 'complete'
                    ? s.stepComplete
                    : step.status === 'partial'
                      ? s.stepPartial
                      : s.stepMissing;
                const Icon =
                  step.status === 'complete'
                    ? CheckCircle2
                    : step.status === 'partial'
                      ? AlertCircle
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
                    <button
                      type="button"
                      className="ssc-link-btn"
                      onClick={() => openStepRoute(step)}
                    >
                      <span>{s.stepOpen}</span>
                      <ArrowUpRight size={12} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {briefOpen && (
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

          <div className="ssc-messages">
            {turns.length === 0 && (
              <div className="ssc-welcome">
                <h3>{s.welcomeTitle}</h3>
                <p>{s.welcomeDescription}</p>
                <div className="ssc-starters">
                  <button
                    type="button"
                    className="ssc-starter-btn"
                    onClick={() => sendMessage(s.starterAutoSetupPrompt)}
                  >
                    <Wand2 size={14} />
                    <span>{s.starterAutoSetup}</span>
                  </button>
                  {activeTenantDiag && (
                    <button
                      type="button"
                      className="ssc-starter-btn"
                      onClick={() => sendMessage(s.starterCompleteCurrentPrompt)}
                    >
                      <CheckCircle2 size={14} />
                      <span>{s.starterCompleteCurrent}</span>
                    </button>
                  )}
                  <button
                    type="button"
                    className="ssc-starter-btn"
                    onClick={() => sendMessage(s.starterGuidePrompt)}
                  >
                    <Sparkles size={14} />
                    <span>{s.starterGuide}</span>
                  </button>
                </div>
              </div>
            )}

            {visiblePendingFromServer.map((p) => renderProposalCard(p))}

            {turns.map((turn) => (
              <div className={`ssc-msg-row ssc-msg-row--${turn.role}`} key={turn.id}>
                <div className={`ssc-bubble ssc-bubble--${turn.role}`}>
                  {turn.role === 'assistant' ? (
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{turn.content}</ReactMarkdown>
                  ) : (
                    turn.content
                  )}
                </div>

                {turn.quickReplies && turn.quickReplies.length > 0 && (
                  <div className="ssc-quick-replies">
                    {turn.quickReplies.map((qr) => (
                      <button
                        key={qr}
                        type="button"
                        className="ssc-chip-btn"
                        disabled={chatMutation.isPending}
                        onClick={() => sendMessage(qr)}
                      >
                        {qr}
                      </button>
                    ))}
                  </div>
                )}

                {turn.proposal && renderProposalCard(turn.proposal)}

                {turn.applyResult && (
                  <div className="ssc-result-card" data-testid="support-setup-applied-card">
                    <div className="ssc-result-title">
                      <CheckCircle2 size={15} />
                      <span>{s.deploySuccessTitle}</span>
                    </div>
                    <div>
                      <strong>{s.embedLabel}:</strong>
                    </div>
                    <pre className="ssc-snippet">{turn.applyResult.diagnostic.embedSnippet}</pre>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      <button
                        type="button"
                        className="ssc-btn"
                        onClick={() => {
                          void copyText(turn.applyResult!.diagnostic.embedSnippet).then((ok) => {
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
                    </div>
                  </div>
                )}
              </div>
            ))}

            {chatMutation.isPending && (
              <div className="ssc-msg-row ssc-msg-row--assistant">
                <div className="ssc-bubble ssc-bubble--assistant">{s.thinking}</div>
              </div>
            )}
          </div>

          <div className="ssc-composer">
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
            <button
              type="button"
              className="ssc-btn ssc-btn--primary"
              data-testid="support-setup-send-btn"
              aria-label={s.send}
              disabled={!input.trim() || chatMutation.isPending}
              onClick={() => sendMessage(input)}
            >
              <Send size={13} />
              <span>{s.send}</span>
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

export default SupportSetupCopilot;
