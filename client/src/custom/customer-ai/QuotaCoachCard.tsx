import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Info, Leaf, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from '@/lib/toast';
import { useCustomT } from '../i18n/use-custom-t';
import { fetchCustomerQuotaCoach, postApplyEcoToKeys } from './api';
import type { CustomerQuotaCoachReport, QuotaCoachTip } from '../../../../shared/customer-ai';

export function QuotaCoachCard() {
  const tc = useCustomT();
  const queryClient = useQueryClient();

  const { data } = useQuery<{ report?: CustomerQuotaCoachReport }>({
    queryKey: ['customer-ai-coach'],
    queryFn: () => fetchCustomerQuotaCoach(14),
    staleTime: 30_000,
  });

  const applyEco = useMutation({
    mutationFn: (keyId?: number) => postApplyEcoToKeys(keyId),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ['user-api-keys'] });
      void queryClient.invalidateQueries({ queryKey: ['customer-ai-coach'] });
      toast.success(
        res.updatedCount > 0
          ? tc('Switched {count} key(s) to Eco mode', { count: res.updatedCount })
          : tc('Your active keys are already in Eco mode'),
      );
    },
    onError: (err: Error) => {
      toast.error(err.message || tc('Failed to switch keys to Eco mode'));
    },
  });

  const report = data?.report;
  if (!report || !Array.isArray(report.tips) || !report.routingBreakdown) {
    return null;
  }

  const tipIcon = (severity: QuotaCoachTip['severity']) => {
    if (severity === 'saving') return <Leaf className="size-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />;
    if (severity === 'warning') return <AlertTriangle className="size-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />;
    return <Info className="size-4 text-muted-foreground shrink-0 mt-0.5" />;
  };

  return (
    <div className="rounded-2xl border bg-card p-5 space-y-4 shadow-sm" aria-label="AI Quota Coach">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" />
            <h3 className="text-sm font-semibold">{tc('AI Quota & Routing Coach')}</h3>
            {report.potentialSavingsPct > 0 && (
              <span className="rounded-full bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 px-2 py-0.5 text-[11px] font-medium">
                {tc('Est. ~{pct}% savings', { pct: report.potentialSavingsPct })}
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground">{report.headline}</p>
        </div>

        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span>{tc('{count} reqs / {days}d', { count: report.totalRequests, days: report.windowDays })}</span>
          <span>{tc('{tokens} tokens', { tokens: report.totalTokens.toLocaleString() })}</span>
          <span>{tc('Avg {tokens}/req', { tokens: report.avgTokensPerRequest.toLocaleString() })}</span>
        </div>
      </div>

      <div className="space-y-2.5">
        {report.tips.map((tip) => (
          <div
            key={tip.id}
            className="rounded-xl border bg-muted/30 p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
          >
            <div className="flex items-start gap-2.5 min-w-0">
              {tipIcon(tip.severity)}
              <div className="space-y-0.5 min-w-0">
                <p className="text-xs font-medium text-foreground">{tip.title}</p>
                <p className="text-xs text-muted-foreground">{tip.detail}</p>
              </div>
            </div>
            {tip.recommendedMode === 'eco' && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={applyEco.isPending}
                onClick={() => applyEco.mutate(tip.targetKeyId)}
                className="shrink-0 text-xs"
              >
                <Leaf className="size-3.5 mr-1" />
                {applyEco.isPending
                  ? tc('Applying…')
                  : tip.targetKeyName
                    ? tc('Switch key to Eco')
                    : tc('Switch all keys to Eco')}
              </Button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
