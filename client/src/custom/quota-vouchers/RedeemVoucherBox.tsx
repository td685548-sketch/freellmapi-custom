import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Gift, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/lib/toast';
import { redeemQuotaVoucher } from './api';
import { formatVoucherText, useQuotaVoucherStrings } from './strings';
import type { QuotaVoucherRedemption } from '../../../../shared/quota-vouchers';

export function RedeemVoucherBox({ onClose }: { onClose?: () => void }) {
  const s = useQuotaVoucherStrings();
  const queryClient = useQueryClient();
  const [code, setCode] = useState('');
  const [lastRedeemed, setLastRedeemed] = useState<QuotaVoucherRedemption | null>(null);

  const redeemMutation = useMutation({
    mutationFn: (rawCode: string) => redeemQuotaVoucher(rawCode),
    onSuccess: (res) => {
      setLastRedeemed(res.redemption);
      setCode('');
      queryClient.setQueryData(['user-quota'], res.quotaState);
      void queryClient.invalidateQueries({ queryKey: ['user-quota'] });
      void queryClient.invalidateQueries({ queryKey: ['customer-ai-coach'] });
      void queryClient.invalidateQueries({ queryKey: ['my-voucher-redemptions'] });
      toast.success(formatVoucherText(s.redeemSuccessToast, { code: res.voucher.code }));
    },
    onError: (err: Error) => {
      toast.error(err.message || s.redeemErrorFallback);
    },
  });

  const formatSummary = (r: QuotaVoucherRedemption) => {
    const parts: string[] = [];
    if (r.bonusRequestsDaily > 0) parts.push(`+${r.bonusRequestsDaily.toLocaleString()} ${s.unitReqDay}`);
    if (r.bonusTokensDaily > 0) parts.push(`+${r.bonusTokensDaily.toLocaleString()} ${s.unitTokDay}`);
    if (r.bonusRequestsMonthly > 0) parts.push(`+${r.bonusRequestsMonthly.toLocaleString()} ${s.unitReqMonth}`);
    if (r.bonusTokensMonthly > 0) parts.push(`+${r.bonusTokensMonthly.toLocaleString()} ${s.unitTokMonth}`);
    return parts.join(' · ');
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = code.trim();
    if (!trimmed) return;
    redeemMutation.mutate(trimmed);
  };

  return (
    <div className="rounded-xl border bg-muted/25 p-3.5 space-y-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="space-y-0.5">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
            <Gift className="size-3.5 text-primary" />
            <span>{s.redeemTitle}</span>
          </div>
          <p className="text-[11px] text-muted-foreground">{s.redeemSubtitle}</p>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label={s.redeemClose}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
        <Input
          type="text"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder={s.redeemPlaceholder}
          aria-label={s.redeemTitle}
          className="h-8 font-mono text-xs flex-1"
          autoFocus
        />
        <Button
          type="submit"
          size="sm"
          disabled={!code.trim() || redeemMutation.isPending}
          className="h-8 text-xs shrink-0"
        >
          {redeemMutation.isPending ? s.redeeming : s.redeemAction}
        </Button>
      </form>

      {lastRedeemed && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 flex items-center gap-2 text-xs text-emerald-700 dark:text-emerald-300">
          <CheckCircle2 className="size-3.5 shrink-0" />
          <span>
            {formatVoucherText(s.redeemSuccessBanner, {
              code: lastRedeemed.code,
              summary: formatSummary(lastRedeemed),
            })}
          </span>
        </div>
      )}
    </div>
  );
}
