import { Suspense, lazy, useState, type FormEvent, type ReactNode } from 'react';
import {
  CheckCircle2,
  Clock,
  KeyRound,
  Lock,
  RefreshCw,
  Send,
  ShieldAlert,
  Sparkles,
} from 'lucide-react';
import { toast } from '@/lib/toast';
import { useI18n } from '@/i18n';
import { Button } from '@/components/ui/button';
import { RouteFallback } from '../route-splitting/RouteFallback';
import {
  useActivateAiTokenMutation,
  useAiEntitlementStatus,
  useCheckAiActivationApprovalMutation,
  useSubmitAiActivationRequestMutation,
} from './api';

const SupportSetupCopilotLazy = lazy(
  () => import('../support-setup-copilot/SupportSetupCopilot'),
);

export function GatedSupportSetupCopilot() {
  const { data } = useAiEntitlementStatus();
  if (!data?.active) return null;
  return (
    <Suspense fallback={null}>
      <SupportSetupCopilotLazy />
    </Suspense>
  );
}

interface AiActivationGateProps {
  children: ReactNode;
  variant?: 'default' | 'thruline';
}

export function AiActivationGate({
  children,
  variant = 'default',
}: AiActivationGateProps) {
  const { locale } = useI18n();
  const isVi = locale === 'vi';
  const entitlement = useAiEntitlementStatus();
  const activateMutation = useActivateAiTokenMutation();
  const submitRequestMutation = useSubmitAiActivationRequestMutation();
  const checkApprovalMutation = useCheckAiActivationApprovalMutation();

  const [tab, setTab] = useState<'request' | 'token'>('request');
  const [orgName, setOrgName] = useState('');
  const [contactInfo, setContactInfo] = useState('');
  const [note, setNote] = useState('');
  const [tokenInput, setTokenInput] = useState('');
  const [inlineError, setInlineError] = useState<string | null>(null);

  if (entitlement.isPending) {
    return <RouteFallback />;
  }

  if (entitlement.data?.active) {
    return <>{children}</>;
  }

  const status = entitlement.data;
  const canManage = Boolean(status?.canManage);
  const pendingReq = status?.pendingRequest ?? null;
  const state = status?.state ?? 'unactivated';

  const handleActivateSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setInlineError(null);
    const trimmed = tokenInput.trim();
    if (!trimmed) return;
    try {
      await activateMutation.mutateAsync(trimmed);
      setTokenInput('');
      toast.success(
        isVi
          ? 'Kích hoạt mô-đun AI & Support thành công!'
          : 'AI & Support modules activated successfully!',
      );
    } catch (err) {
      setInlineError(
        err instanceof Error
          ? err.message
          : isVi
            ? 'Mã kích hoạt không hợp lệ hoặc đã bị thu hồi.'
            : 'Activation token is invalid or revoked.',
      );
    }
  };

  const handleRequestSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setInlineError(null);
    if (!orgName.trim() || !contactInfo.trim()) return;
    try {
      await submitRequestMutation.mutateAsync({
        orgName: orgName.trim(),
        contactInfo: contactInfo.trim(),
        serverOrigin: typeof window !== 'undefined' ? window.location.origin : '',
        note: note.trim(),
      });
      toast.success(
        isVi
          ? 'Đã gửi yêu cầu cấp phép tới tác giả repository!'
          : 'Activation request sent to the repository owner!',
      );
    } catch (err) {
      setInlineError(
        err instanceof Error
          ? err.message
          : isVi
            ? 'Không thể gửi yêu cầu lúc này. Vui lòng thử lại.'
            : 'Could not submit request right now. Please retry.',
      );
    }
  };

  const handleCheckApproval = async () => {
    setInlineError(null);
    try {
      const res = await checkApprovalMutation.mutateAsync();
      if (res.activated) {
        toast.success(
          isVi
            ? 'Tác giả đã phê duyệt! Hệ thống đã tự động nhận mã và mở khóa.'
            : 'Approved by owner! Activation token claimed and unlocked automatically.',
        );
      } else if (res.request.status === 'rejected') {
        setInlineError(
          isVi
            ? `Yêu cầu đã bị từ chối${res.request.decisionNote ? `: ${res.request.decisionNote}` : '.'}`
            : `Request was declined${res.request.decisionNote ? `: ${res.request.decisionNote}` : '.'}`,
        );
      } else {
        toast.info(
          isVi
            ? 'Yêu cầu của bạn vẫn đang chờ tác giả phê duyệt.'
            : 'Your request is still awaiting owner approval.',
        );
      }
    } catch (err) {
      setInlineError(
        err instanceof Error
          ? err.message
          : isVi
            ? 'Không thể kiểm tra trạng thái phê duyệt.'
            : 'Failed to check approval status.',
      );
    }
  };

  const containerStyle =
    variant === 'thruline'
      ? 'mx-auto my-8 max-w-2xl rounded-3xl border border-white/10 bg-black/30 p-7 text-foreground shadow-xl backdrop-blur'
      : 'mx-auto my-6 max-w-2xl rounded-3xl border bg-card p-7 text-card-foreground shadow-sm';

  return (
    <div className={containerStyle} data-testid="ai-activation-gate">
      <div className="flex items-start gap-4">
        <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Lock className="size-6" />
        </div>
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold">
              {isVi
                ? 'Yêu cầu cấp phép mô-đun Chat AI & AI Support'
                : 'Chat AI & AI Support Activation Required'}
            </h2>
            <span className="inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
              <Sparkles className="size-3" />
              {state === 'revoked'
                ? isVi
                  ? 'Đã thu hồi'
                  : 'Revoked'
                : state === 'expired'
                  ? isVi
                    ? 'Hết hạn'
                    : 'Expired'
                  : isVi
                    ? 'Chưa kích hoạt'
                    : 'Locked'}
            </span>
          </div>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {isVi
              ? 'Các tính năng Proxy LLM cơ bản (/v1/*, quản lý Key, Models) vẫn mở hoàn toàn. Riêng bộ công cụ Chat AI, AI Platform, Trợ lý Setup Copilot và AI Support Service Desk cần sự đồng ý cấp phép từ tác giả repository để vận hành.'
              : 'Core LLM Proxy features (/v1/*, Keys, Models) remain open. The Chat AI Hub, AI Platform, Setup Copilot, and AI Support Service Desk require owner approval and a signed cloud runtime lease.'}
          </p>
        </div>
      </div>

      {status?.lastError && (
        <div className="mt-5 flex items-start gap-2.5 rounded-2xl border border-destructive/30 bg-destructive/10 p-3.5 text-xs text-destructive">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" />
          <span>{status.lastError}</span>
        </div>
      )}

      {inlineError && (
        <div className="mt-4 flex items-start gap-2.5 rounded-2xl border border-destructive/30 bg-destructive/10 p-3.5 text-xs text-destructive">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" />
          <span>{inlineError}</span>
        </div>
      )}

      {!canManage ? (
        <div className="mt-6 rounded-2xl border bg-muted/40 p-4 text-sm text-muted-foreground">
          {isVi
            ? 'Vui lòng liên hệ Quản trị viên (Admin) của máy chủ này để gửi yêu cầu xin cấp phép hoặc nhập mã kích hoạt.'
            : 'Please ask your server administrator to request activation approval or enter an activation token.'}
        </div>
      ) : (
        <div className="mt-6 space-y-5">
          <div className="inline-flex rounded-xl border bg-muted/40 p-1 text-xs font-medium">
            <button
              type="button"
              onClick={() => {
                setTab('request');
                setInlineError(null);
              }}
              className={`rounded-lg px-3.5 py-1.5 transition-colors ${
                tab === 'request'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {isVi ? '1. Gửi yêu cầu xin cấp phép' : '1. Request Owner Approval'}
            </button>
            <button
              type="button"
              onClick={() => {
                setTab('token');
                setInlineError(null);
              }}
              className={`rounded-lg px-3.5 py-1.5 transition-colors ${
                tab === 'token'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {isVi ? '2. Nhập mã kích hoạt' : '2. Enter Activation Token'}
            </button>
          </div>

          {tab === 'request' ? (
            <div className="space-y-4">
              {pendingReq && pendingReq.status === 'pending' && (
                <div className="rounded-2xl border border-primary/30 bg-primary/5 p-4 space-y-3">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div className="flex items-center gap-2 text-sm font-medium text-primary">
                      <Clock className="size-4" />
                      <span>
                        {isVi
                          ? 'Đã gửi yêu cầu — Đang chờ tác giả phê duyệt'
                          : 'Request submitted — Awaiting owner approval'}
                      </span>
                    </div>
                    <span className="font-mono text-[11px] text-muted-foreground">
                      ID: {pendingReq.requestId.slice(0, 8)}…
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {isVi
                      ? `Dự án: ${pendingReq.orgName} (${pendingReq.contactInfo}). Ngay sau khi tác giả bấm Duyệt trên bảng điều khiển, bạn bấm nút bên dưới để hệ thống tự động nhận khóa và mở tính năng.`
                      : `Project: ${pendingReq.orgName} (${pendingReq.contactInfo}). Once the repository owner clicks Approve, press the button below to automatically claim your token and unlock.`}
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    disabled={checkApprovalMutation.isPending}
                    onClick={() => void handleCheckApproval()}
                  >
                    <RefreshCw
                      className={`mr-1.5 size-3.5 ${
                        checkApprovalMutation.isPending ? 'animate-spin' : ''
                      }`}
                    />
                    {isVi
                      ? 'Kiểm tra phê duyệt & Tự động kích hoạt'
                      : 'Check Approval & Auto-Activate'}
                  </Button>
                </div>
              )}

              <form onSubmit={(e) => void handleRequestSubmit(e)} className="space-y-3.5">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium">
                      {isVi ? 'Tên dự án / Tổ chức *' : 'Project / Organization Name *'}
                    </label>
                    <input
                      required
                      maxLength={120}
                      value={orgName}
                      onChange={(e) => setOrgName(e.target.value)}
                      placeholder={isVi ? 'VD: Đồ án nhóm / Công ty ABC' : 'e.g. Acme Team'}
                      className="w-full rounded-xl border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium">
                      {isVi ? 'Email / Telegram liên hệ *' : 'Contact Email or Telegram *'}
                    </label>
                    <input
                      required
                      maxLength={160}
                      value={contactInfo}
                      onChange={(e) => setContactInfo(e.target.value)}
                      placeholder={isVi ? 'email@domain.com hoặc @telegram' : 'you@example.com or @handle'}
                      className="w-full rounded-xl border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30"
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium">
                    {isVi ? 'Mục đích sử dụng (tùy chọn)' : 'Intended Use / Note (optional)'}
                  </label>
                  <textarea
                    rows={2}
                    maxLength={1000}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder={
                      isVi
                        ? 'Chia sẻ ngắn gọn mục đích triển khai để tác giả xét duyệt nhanh hơn...'
                        : 'Briefly describe how you plan to use the AI Chat & Support modules...'
                    }
                    className="w-full rounded-xl border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30"
                  />
                </div>
                <Button
                  type="submit"
                  disabled={submitRequestMutation.isPending || !orgName.trim() || !contactInfo.trim()}
                >
                  <Send className="mr-1.5 size-4" />
                  {pendingReq?.status === 'pending'
                    ? isVi
                      ? 'Gửi lại yêu cầu mới'
                      : 'Submit Updated Request'
                    : isVi
                      ? 'Gửi yêu cầu xin cấp phép'
                      : 'Request Activation Approval'}
                </Button>
              </form>
            </div>
          ) : (
            <form onSubmit={(e) => void handleActivateSubmit(e)} className="space-y-3.5">
              <div className="space-y-1.5">
                <label className="text-xs font-medium">
                  {isVi
                    ? 'Mã kích hoạt được tác giả cấp (Activation Token)'
                    : 'Owner-Issued Activation Token'}
                </label>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <input
                    required
                    type="password"
                    value={tokenInput}
                    onChange={(e) => setTokenInput(e.target.value)}
                    placeholder="flm_act_..."
                    className="flex-1 rounded-xl border bg-background px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-primary/30"
                  />
                  <Button
                    type="submit"
                    disabled={activateMutation.isPending || !tokenInput.trim()}
                  >
                    <KeyRound className="mr-1.5 size-4" />
                    {isVi ? 'Kích hoạt ngay' : 'Activate Now'}
                  </Button>
                </div>
              </div>
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <CheckCircle2 className="size-3.5 shrink-0 text-primary" />
                {isVi
                  ? 'Mã sẽ được mã hóa AES-256 trong cơ sở dữ liệu, hoặc bạn có thể đặt biến FREEAPI_AI_ACTIVATION_TOKEN trong file .env.'
                  : 'Stored encrypted with AES-256 in your database, or set FREEAPI_AI_ACTIVATION_TOKEN in .env for headless deployments.'}
              </p>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
