import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Gift, PauseCircle, PlayCircle, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/copy-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/lib/toast';
import { askConfirm } from '@/custom/x-gateway/shell/confirm';
import {
  createAdminQuotaVoucher,
  fetchAdminQuotaVouchers,
  revokeAdminQuotaVoucher,
  toggleAdminQuotaVoucher,
} from './api';
import { formatVoucherText, useQuotaVoucherStrings } from './strings';
import type { QuotaVoucher } from '../../../../shared/quota-vouchers';

interface AdminVouchersPanelProps {
  canView: boolean;
  canCreate: boolean;
  canManage: boolean;
}

export function AdminVouchersPanel({
  canView,
  canCreate,
  canManage,
}: AdminVouchersPanelProps) {
  const s = useQuotaVoucherStrings();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('');
  const [bonusReqDaily, setBonusReqDaily] = useState('100');
  const [bonusTokDaily, setBonusTokDaily] = useState('500000');
  const [bonusReqMonthly, setBonusReqMonthly] = useState('0');
  const [bonusTokMonthly, setBonusTokMonthly] = useState('1000000');
  const [maxRedemptions, setMaxRedemptions] = useState('10');
  const [expiresInDays, setExpiresInDays] = useState('30');

  const { data, isLoading } = useQuery<{ vouchers: QuotaVoucher[] }>({
    queryKey: ['admin-quota-vouchers'],
    queryFn: fetchAdminQuotaVouchers,
    enabled: canView,
  });

  const vouchers = canView ? (data?.vouchers ?? []) : [];

  const createMutation = useMutation({
    mutationFn: createAdminQuotaVoucher,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-quota-vouchers'] });
      setCreateOpen(false);
      setCode('');
      setLabel('');
      toast.success(s.adminVoucherCreatedToast);
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, active }: { id: number; active: boolean }) =>
      toggleAdminQuotaVoucher(id, active),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-quota-vouchers'] });
      toast.success(s.adminVoucherUpdatedToast);
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (id: number) => revokeAdminQuotaVoucher(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-quota-vouchers'] });
      toast.success(s.adminVoucherRevokedToast);
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  if (!canView) return null;

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    const days = expiresInDays === 'never' ? null : Number.parseInt(expiresInDays, 10);
    createMutation.mutate({
      code: code.trim() || undefined,
      label: label.trim() || undefined,
      bonusRequestsDaily: Math.max(0, Number.parseInt(bonusReqDaily || '0', 10) || 0),
      bonusTokensDaily: Math.max(0, Number.parseInt(bonusTokDaily || '0', 10) || 0),
      bonusRequestsMonthly: Math.max(0, Number.parseInt(bonusReqMonthly || '0', 10) || 0),
      bonusTokensMonthly: Math.max(0, Number.parseInt(bonusTokMonthly || '0', 10) || 0),
      maxRedemptions: Math.max(1, Number.parseInt(maxRedemptions || '1', 10) || 1),
      expiresInDays: days && Number.isFinite(days) && days > 0 ? days : null,
    });
  };

  const handleRevoke = async (v: QuotaVoucher) => {
    if (await askConfirm(formatVoucherText(s.adminRevokeConfirm, { code: v.code }))) {
      revokeMutation.mutate(v.id);
    }
  };

  const renderStatusBadge = (status: QuotaVoucher['status']) => {
    if (status === 'active') {
      return (
        <span className="text-[10px] bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-medium px-2 py-0.5 rounded-full border border-emerald-500/20">
          {s.statusActive}
        </span>
      );
    }
    if (status === 'exhausted') {
      return (
        <span className="text-[10px] bg-amber-500/10 text-amber-600 dark:text-amber-400 font-medium px-2 py-0.5 rounded-full border border-amber-500/20">
          {s.statusExhausted}
        </span>
      );
    }
    if (status === 'expired') {
      return (
        <span className="text-[10px] bg-muted text-muted-foreground font-medium px-2 py-0.5 rounded-full">
          {s.statusExpired}
        </span>
      );
    }
    return (
      <span className="text-[10px] bg-destructive/10 text-destructive font-medium px-2 py-0.5 rounded-full border border-destructive/20">
        {s.statusInactive}
      </span>
    );
  };

  const renderBonuses = (v: QuotaVoucher) => {
    const pills: string[] = [];
    if (v.bonusRequestsDaily > 0) pills.push(`+${v.bonusRequestsDaily.toLocaleString()} ${s.unitReqDay}`);
    if (v.bonusTokensDaily > 0) pills.push(`+${v.bonusTokensDaily.toLocaleString()} ${s.unitTokDay}`);
    if (v.bonusRequestsMonthly > 0) pills.push(`+${v.bonusRequestsMonthly.toLocaleString()} ${s.unitReqMonth}`);
    if (v.bonusTokensMonthly > 0) pills.push(`+${v.bonusTokensMonthly.toLocaleString()} ${s.unitTokMonth}`);
    return pills.join(' · ');
  };

  return (
    <section className="space-y-4" aria-label={s.adminVouchersTitle}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold flex items-center gap-2">
            <Gift className="size-4 text-primary" />
            <span>{s.adminVouchersTitle}</span>
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">{s.adminVouchersDesc}</p>
        </div>
        <Button size="sm" disabled={!canCreate} onClick={() => setCreateOpen(true)}>
          <Plus className="mr-1.5 size-4" />
          {s.adminCreateVoucherBtn}
        </Button>
      </div>

      <div className="rounded-2xl border bg-card overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            {s.adminVoucherLoading}
          </div>
        ) : vouchers.length === 0 ? (
          <div className="p-8 text-center space-y-2">
            <Gift className="size-8 mx-auto text-muted-foreground opacity-50" />
            <p className="text-sm font-medium">{s.adminVouchersEmpty}</p>
            <p className="text-xs text-muted-foreground">{s.adminVouchersEmptyHint}</p>
          </div>
        ) : (
          <div className="divide-y">
            {vouchers.map((v) => (
              <div
                key={v.id}
                className="p-4 flex flex-wrap sm:flex-nowrap items-center justify-between gap-4 hover:bg-muted/30 transition-colors"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-semibold text-foreground tracking-wide">
                      {v.code}
                    </span>
                    <CopyButton
                      text={v.code}
                      label={s.adminCopyCode}
                      className="size-6 p-0 border-none bg-transparent"
                    />
                    {renderStatusBadge(v.status)}
                    <span className="rounded-md bg-primary/10 text-primary px-2 py-0.5 text-[11px] font-medium tabular-nums">
                      {renderBonuses(v)}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
                    <span>
                      {formatVoucherText(s.adminRedemptionsCount, {
                        used: v.redeemedCount,
                        max: v.maxRedemptions,
                      })}
                    </span>
                    <span>
                      {formatVoucherText(s.adminExpiresLabel, {
                        date: v.expiresAt
                          ? new Date(v.expiresAt).toLocaleDateString()
                          : s.adminNeverExpires,
                      })}
                    </span>
                    {v.label && <em>{v.label}</em>}
                  </div>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!canManage || toggleMutation.isPending}
                    onClick={() => toggleMutation.mutate({ id: v.id, active: !v.active })}
                    className="h-8 text-xs"
                  >
                    {v.active ? (
                      <>
                        <PauseCircle className="size-3.5 mr-1" />
                        {s.adminPause}
                      </>
                    ) : (
                      <>
                        <PlayCircle className="size-3.5 mr-1" />
                        {s.adminActivate}
                      </>
                    )}
                  </Button>
                  {v.active && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={!canManage || revokeMutation.isPending}
                      onClick={() => handleRevoke(v)}
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive text-xs h-8"
                    >
                      <Trash2 className="size-3.5 mr-1" />
                      {s.adminRevoke}
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {createOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
          role="dialog"
          aria-modal="true"
          aria-label={s.adminCreateVoucherBtn}
        >
          <div className="w-full max-w-lg rounded-3xl border bg-card p-6 shadow-xl space-y-4">
            <h3 className="text-base font-semibold">{s.adminCreateVoucherBtn}</h3>
            <form onSubmit={handleCreate} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="voucher-code" className="text-xs">
                    {s.adminVoucherCodeLabel}
                  </Label>
                  <Input
                    id="voucher-code"
                    type="text"
                    placeholder={s.adminVoucherCodePlaceholder}
                    value={code}
                    onChange={(e) => setCode(e.target.value.toUpperCase())}
                    className="h-9 font-mono text-xs"
                    autoFocus
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="voucher-label" className="text-xs">
                    {s.adminVoucherLabelLabel}
                  </Label>
                  <Input
                    id="voucher-label"
                    type="text"
                    placeholder={s.adminVoucherLabelPlaceholder}
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    className="h-9 text-xs"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="voucher-req-daily" className="text-xs">
                    {s.adminBonusReqDaily}
                  </Label>
                  <Input
                    id="voucher-req-daily"
                    type="number"
                    min="0"
                    value={bonusReqDaily}
                    onChange={(e) => setBonusReqDaily(e.target.value)}
                    className="h-9 text-xs"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="voucher-tok-daily" className="text-xs">
                    {s.adminBonusTokDaily}
                  </Label>
                  <Input
                    id="voucher-tok-daily"
                    type="number"
                    min="0"
                    step="1000"
                    value={bonusTokDaily}
                    onChange={(e) => setBonusTokDaily(e.target.value)}
                    className="h-9 text-xs"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="voucher-req-monthly" className="text-xs">
                    {s.adminBonusReqMonthly}
                  </Label>
                  <Input
                    id="voucher-req-monthly"
                    type="number"
                    min="0"
                    value={bonusReqMonthly}
                    onChange={(e) => setBonusReqMonthly(e.target.value)}
                    className="h-9 text-xs"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="voucher-tok-monthly" className="text-xs">
                    {s.adminBonusTokMonthly}
                  </Label>
                  <Input
                    id="voucher-tok-monthly"
                    type="number"
                    min="0"
                    step="10000"
                    value={bonusTokMonthly}
                    onChange={(e) => setBonusTokMonthly(e.target.value)}
                    className="h-9 text-xs"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="voucher-max-uses" className="text-xs">
                    {s.adminMaxRedemptions}
                  </Label>
                  <Input
                    id="voucher-max-uses"
                    type="number"
                    min="1"
                    max="100000"
                    value={maxRedemptions}
                    onChange={(e) => setMaxRedemptions(e.target.value)}
                    className="h-9 text-xs"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="voucher-expires" className="text-xs">
                    {s.adminExpiresInDays}
                  </Label>
                  <select
                    id="voucher-expires"
                    value={expiresInDays}
                    onChange={(e) => setExpiresInDays(e.target.value)}
                    className="w-full h-9 rounded-md border border-input bg-transparent px-3 py-1 text-xs shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <option value="1">{formatVoucherText(s.adminDaysOption, { days: 1 })}</option>
                    <option value="7">{formatVoucherText(s.adminDaysOption, { days: 7 })}</option>
                    <option value="30">{formatVoucherText(s.adminDaysOption, { days: 30 })}</option>
                    <option value="90">{formatVoucherText(s.adminDaysOption, { days: 90 })}</option>
                    <option value="never">{s.adminNeverExpires}</option>
                  </select>
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="ghost" onClick={() => setCreateOpen(false)}>
                  {s.cancel}
                </Button>
                <Button type="submit" disabled={createMutation.isPending}>
                  {createMutation.isPending ? s.adminVoucherCreating : s.adminVoucherCreateSubmit}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}
