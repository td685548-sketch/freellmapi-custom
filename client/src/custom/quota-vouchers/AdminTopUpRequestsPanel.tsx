import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpCircle, Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/lib/toast';
import {
  approveAdminTopUpRequest,
  fetchAdminTopUpRequests,
  rejectAdminTopUpRequest,
} from './api';
import { formatVoucherText, useQuotaVoucherStrings } from './strings';
import type { QuotaTopUpRequest } from '../../../../shared/quota-vouchers';

interface AdminTopUpRequestsPanelProps {
  canView: boolean;
  canReview: boolean;
}

interface ReviewDraft {
  requestsDaily: string;
  tokensDaily: string;
  adminNote: string;
}

export function AdminTopUpRequestsPanel({
  canView,
  canReview,
}: AdminTopUpRequestsPanelProps) {
  const s = useQuotaVoucherStrings();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<'pending' | 'all'>('pending');
  const [drafts, setDrafts] = useState<Record<number, ReviewDraft>>({});

  const { data, isLoading } = useQuery<{
    requests: QuotaTopUpRequest[];
    pendingCount: number;
  }>({
    queryKey: ['admin-topup-requests', filter],
    queryFn: () => fetchAdminTopUpRequests(filter),
    enabled: canView,
  });

  const requests = canView ? (data?.requests ?? []) : [];
  const pendingCount = data?.pendingCount ?? 0;

  const getDraft = (r: QuotaTopUpRequest): ReviewDraft =>
    drafts[r.id] ?? {
      requestsDaily: String(r.requestedRequestsDaily),
      tokensDaily: String(r.requestedTokensDaily),
      adminNote: '',
    };

  const patchDraft = (r: QuotaTopUpRequest, patch: Partial<ReviewDraft>) => {
    setDrafts((prev) => ({
      ...prev,
      [r.id]: { ...getDraft(r), ...patch },
    }));
  };

  const approveMutation = useMutation({
    mutationFn: ({ reqItem }: { reqItem: QuotaTopUpRequest }) => {
      const d = getDraft(reqItem);
      return approveAdminTopUpRequest(reqItem.id, {
        grantedRequestsDaily: Math.max(0, Number.parseInt(d.requestsDaily || '0', 10) || 0),
        grantedTokensDaily: Math.max(0, Number.parseInt(d.tokensDaily || '0', 10) || 0),
        adminNote: d.adminNote.trim() || undefined,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-topup-requests'] });
      toast.success(s.adminApprovedToast);
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  const rejectMutation = useMutation({
    mutationFn: ({ reqItem }: { reqItem: QuotaTopUpRequest }) => {
      const d = getDraft(reqItem);
      return rejectAdminTopUpRequest(reqItem.id, {
        adminNote: d.adminNote.trim() || undefined,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-topup-requests'] });
      toast.success(s.adminRejectedToast);
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  if (!canView) return null;

  const statusBadge = (status: QuotaTopUpRequest['status']) => {
    if (status === 'approved') {
      return (
        <span className="text-[10px] bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-medium px-2 py-0.5 rounded-full border border-emerald-500/20">
          {s.statusApproved}
        </span>
      );
    }
    if (status === 'rejected') {
      return (
        <span className="text-[10px] bg-destructive/10 text-destructive font-medium px-2 py-0.5 rounded-full border border-destructive/20">
          {s.statusRejected}
        </span>
      );
    }
    return (
      <span className="text-[10px] bg-amber-500/10 text-amber-600 dark:text-amber-400 font-medium px-2 py-0.5 rounded-full border border-amber-500/20">
        {s.statusPending}
      </span>
    );
  };

  return (
    <section className="space-y-4" aria-label={s.adminTopUpsTitle}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold flex items-center gap-2">
            <ArrowUpCircle className="size-4 text-primary" />
            <span>{s.adminTopUpsTitle}</span>
            {pendingCount > 0 && (
              <span className="rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-300 px-2 py-0.5 text-xs font-medium">
                {pendingCount}
              </span>
            )}
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">{s.adminTopUpsDesc}</p>
        </div>

        <div className="inline-flex rounded-lg border bg-muted/40 p-0.5 text-xs">
          <button
            type="button"
            onClick={() => setFilter('pending')}
            className={`px-3 py-1 rounded-md font-medium transition-colors ${
              filter === 'pending'
                ? 'bg-foreground text-background'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {formatVoucherText(s.adminTopUpsFilterPending, { count: pendingCount })}
          </button>
          <button
            type="button"
            onClick={() => setFilter('all')}
            className={`px-3 py-1 rounded-md font-medium transition-colors ${
              filter === 'all'
                ? 'bg-foreground text-background'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {s.adminTopUpsFilterAll}
          </button>
        </div>
      </div>

      <div className="rounded-2xl border bg-card overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            {s.adminTopUpsLoading}
          </div>
        ) : requests.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            {s.adminTopUpsEmpty}
          </div>
        ) : (
          <div className="divide-y">
            {requests.map((r) => {
              const draft = getDraft(r);
              const isPending = r.status === 'pending';

              return (
                <div key={r.id} className="p-4 space-y-3 hover:bg-muted/20 transition-colors">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-foreground">
                        {r.userEmail || `#${r.userId}`}
                      </span>
                      {statusBadge(r.status)}
                      <span className="text-xs text-muted-foreground tabular-nums">
                        +{r.requestedRequestsDaily.toLocaleString()} {s.unitReqDay} · +
                        {r.requestedTokensDaily.toLocaleString()} {s.unitTokDay}
                      </span>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {new Date(r.createdAt).toLocaleString()}
                    </span>
                  </div>

                  {r.reason && (
                    <p className="text-xs text-muted-foreground">
                      <strong>{s.adminReasonPrefix}</strong> {r.reason}
                    </p>
                  )}

                  {isPending && canReview ? (
                    <div className="flex flex-wrap items-end gap-2 pt-1">
                      <div className="space-y-1">
                        <span className="block text-[11px] text-muted-foreground">
                          {s.adminGrantReqDaily}
                        </span>
                        <Input
                          type="number"
                          min="0"
                          value={draft.requestsDaily}
                          onChange={(e) => patchDraft(r, { requestsDaily: e.target.value })}
                          className="h-8 w-28 text-xs"
                        />
                      </div>
                      <div className="space-y-1">
                        <span className="block text-[11px] text-muted-foreground">
                          {s.adminGrantTokDaily}
                        </span>
                        <Input
                          type="number"
                          min="0"
                          step="1000"
                          value={draft.tokensDaily}
                          onChange={(e) => patchDraft(r, { tokensDaily: e.target.value })}
                          className="h-8 w-36 text-xs"
                        />
                      </div>
                      <div className="space-y-1 flex-1 min-w-[180px]">
                        <span className="block text-[11px] text-muted-foreground">Note</span>
                        <Input
                          type="text"
                          placeholder={s.adminNotePlaceholder}
                          value={draft.adminNote}
                          onChange={(e) => patchDraft(r, { adminNote: e.target.value })}
                          className="h-8 text-xs"
                        />
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        disabled={approveMutation.isPending || rejectMutation.isPending}
                        onClick={() => approveMutation.mutate({ reqItem: r })}
                        className="h-8 text-xs"
                      >
                        <Check className="size-3.5 mr-1" />
                        {approveMutation.isPending ? s.adminApproving : s.adminApproveBtn}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={approveMutation.isPending || rejectMutation.isPending}
                        onClick={() => rejectMutation.mutate({ reqItem: r })}
                        className="h-8 text-xs text-destructive hover:text-destructive"
                      >
                        <X className="size-3.5 mr-1" />
                        {rejectMutation.isPending ? s.adminRejecting : s.adminRejectBtn}
                      </Button>
                    </div>
                  ) : (
                    (r.adminNote || r.reviewerEmail) && (
                      <div className="text-xs text-muted-foreground flex flex-wrap gap-3">
                        {r.reviewerEmail && (
                          <span>
                            {s.adminReviewedByPrefix} <strong>{r.reviewerEmail}</strong>
                          </span>
                        )}
                        {r.adminNote && <em>“{r.adminNote}”</em>}
                      </div>
                    )
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
