import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowUpCircle, Clock, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/lib/toast';
import { submitQuotaTopUpRequest } from './api';
import { formatVoucherText, useQuotaVoucherStrings } from './strings';
import type { QuotaTopUpRequest } from '../../../../shared/quota-vouchers';

interface TopUpRequestModalProps {
  open: boolean;
  onClose: () => void;
  pendingRequest: QuotaTopUpRequest | null;
  recentRequests: QuotaTopUpRequest[];
}

const PRESETS = [
  { id: 'light', requests: 50, tokens: 250_000, labelKey: 'topUpPresetLight' as const },
  { id: 'sprint', requests: 200, tokens: 1_000_000, labelKey: 'topUpPresetSprint' as const },
  { id: 'heavy', requests: 500, tokens: 3_000_000, labelKey: 'topUpPresetHeavy' as const },
];

export function TopUpRequestModal({
  open,
  onClose,
  pendingRequest,
  recentRequests,
}: TopUpRequestModalProps) {
  const s = useQuotaVoucherStrings();
  const queryClient = useQueryClient();
  const [requestsDaily, setRequestsDaily] = useState('200');
  const [tokensDaily, setTokensDaily] = useState('1000000');
  const [reason, setReason] = useState('');

  const submitMutation = useMutation({
    mutationFn: () =>
      submitQuotaTopUpRequest({
        requestedRequestsDaily: Math.max(0, Number.parseInt(requestsDaily || '0', 10) || 0),
        requestedTokensDaily: Math.max(0, Number.parseInt(tokensDaily || '0', 10) || 0),
        reason: reason.trim() || undefined,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['my-topup-requests'] });
      toast.success(s.topUpSubmittedToast);
      setReason('');
      onClose();
    },
    onError: (err: Error) => {
      toast.error(err.message || s.topUpErrorFallback);
    },
  });

  if (!open) return null;

  const parsedRequests = Math.max(0, Number.parseInt(requestsDaily || '0', 10) || 0);
  const parsedTokens = Math.max(0, Number.parseInt(tokensDaily || '0', 10) || 0);
  const canSubmit = !pendingRequest && (parsedRequests > 0 || parsedTokens > 0);

  const statusBadge = (status: QuotaTopUpRequest['status']) => {
    if (status === 'approved') {
      return (
        <span className="rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 px-2 py-0.5 text-[10px] font-medium">
          {s.statusApproved}
        </span>
      );
    }
    if (status === 'rejected') {
      return (
        <span className="rounded-full bg-destructive/10 text-destructive border border-destructive/20 px-2 py-0.5 text-[10px] font-medium">
          {s.statusRejected}
        </span>
      );
    }
    return (
      <span className="rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 px-2 py-0.5 text-[10px] font-medium">
        {s.statusPending}
      </span>
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-label={s.topUpModalTitle}
    >
      <div className="w-full max-w-lg rounded-3xl border bg-card p-6 shadow-xl space-y-4 max-h-[90vh] overflow-y-auto">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <ArrowUpCircle className="size-4 text-primary" />
            <h3 className="text-base font-semibold">{s.topUpModalTitle}</h3>
          </div>
          <p className="text-xs text-muted-foreground">{s.topUpModalSubtitle}</p>
        </div>

        {pendingRequest ? (
          <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 space-y-1.5">
            <div className="flex items-center gap-2 text-xs font-semibold text-amber-700 dark:text-amber-300">
              <Clock className="size-3.5 shrink-0" />
              <span>{s.topUpPendingNoticeTitle}</span>
            </div>
            <p className="text-xs text-muted-foreground">
              {formatVoucherText(s.topUpPendingNoticeDetail, {
                requests: pendingRequest.requestedRequestsDaily.toLocaleString(),
                tokens: pendingRequest.requestedTokensDaily.toLocaleString(),
              })}
            </p>
            {pendingRequest.reason && (
              <p className="text-[11px] text-muted-foreground italic">“{pendingRequest.reason}”</p>
            )}
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (canSubmit) submitMutation.mutate();
            }}
            className="space-y-4"
          >
            <div className="space-y-1.5">
              <Label className="text-xs">{s.topUpPresetHeading}</Label>
              <div className="grid grid-cols-1 gap-1.5">
                {PRESETS.map((preset) => {
                  const selected =
                    parsedRequests === preset.requests && parsedTokens === preset.tokens;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => {
                        setRequestsDaily(String(preset.requests));
                        setTokensDaily(String(preset.tokens));
                      }}
                      className={`flex items-center justify-between rounded-xl border px-3 py-2 text-left text-xs transition-colors ${
                        selected
                          ? 'border-primary bg-primary/10 text-foreground font-medium'
                          : 'bg-muted/20 text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                      }`}
                    >
                      <span className="flex items-center gap-1.5">
                        <Sparkles className="size-3.5 text-primary shrink-0" />
                        {s[preset.labelKey]}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="topup-daily-requests" className="text-xs">
                  {s.topUpDailyRequestsLabel}
                </Label>
                <Input
                  id="topup-daily-requests"
                  type="number"
                  min="0"
                  value={requestsDaily}
                  onChange={(e) => setRequestsDaily(e.target.value)}
                  className="h-9 text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="topup-daily-tokens" className="text-xs">
                  {s.topUpDailyTokensLabel}
                </Label>
                <Input
                  id="topup-daily-tokens"
                  type="number"
                  min="0"
                  step="1000"
                  value={tokensDaily}
                  onChange={(e) => setTokensDaily(e.target.value)}
                  className="h-9 text-xs"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="topup-reason" className="text-xs">
                {s.topUpReasonLabel}
              </Label>
              <Input
                id="topup-reason"
                type="text"
                maxLength={500}
                placeholder={s.topUpReasonPlaceholder}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="h-9 text-xs"
              />
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" onClick={onClose}>
                {s.cancel}
              </Button>
              <Button type="submit" disabled={!canSubmit || submitMutation.isPending}>
                {submitMutation.isPending ? s.topUpSubmitting : s.topUpSubmit}
              </Button>
            </div>
          </form>
        )}

        {recentRequests.length > 0 && (
          <div className="border-t pt-3 space-y-2">
            <h4 className="text-xs font-semibold text-muted-foreground">
              {s.topUpHistoryHeading}
            </h4>
            <div className="space-y-1.5 max-h-36 overflow-y-auto">
              {recentRequests.slice(0, 5).map((r) => (
                <div
                  key={r.id}
                  className="rounded-xl border bg-muted/20 px-3 py-2 flex items-center justify-between gap-2 text-xs"
                >
                  <div className="min-w-0">
                    <div className="font-medium tabular-nums">
                      +{r.requestedRequestsDaily.toLocaleString()} {s.unitReqDay} · +
                      {r.requestedTokensDaily.toLocaleString()} {s.unitTokDay}
                    </div>
                    {r.adminNote && (
                      <div className="text-[11px] text-muted-foreground truncate">
                        {r.adminNote}
                      </div>
                    )}
                  </div>
                  {statusBadge(r.status)}
                </div>
              ))}
            </div>
          </div>
        )}

        {pendingRequest && (
          <div className="flex justify-end">
            <Button type="button" variant="outline" onClick={onClose}>
              {s.redeemClose}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
