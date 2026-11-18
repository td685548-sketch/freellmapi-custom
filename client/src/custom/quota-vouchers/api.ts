import { apiFetch } from '@/lib/api';
import type {
  ApproveTopUpRequestInput,
  ApproveTopUpRequestResponse,
  CreateQuotaVoucherInput,
  CreateTopUpRequestInput,
  QuotaTopUpRequest,
  QuotaVoucher,
  QuotaVoucherRedemption,
  RedeemQuotaVoucherResponse,
  RejectTopUpRequestInput,
  TopUpRequestStatus,
} from '../../../../shared/quota-vouchers';

export function redeemQuotaVoucher(code: string): Promise<RedeemQuotaVoucherResponse> {
  return apiFetch<RedeemQuotaVoucherResponse>('/api/quota-vouchers/redeem', {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
}

export function fetchMyVoucherRedemptions(): Promise<{ redemptions: QuotaVoucherRedemption[] }> {
  return apiFetch<{ redemptions: QuotaVoucherRedemption[] }>(
    '/api/quota-vouchers/redemptions/mine',
  );
}

export function fetchMyTopUpRequests(): Promise<{
  requests: QuotaTopUpRequest[];
  pendingRequest: QuotaTopUpRequest | null;
}> {
  return apiFetch<{
    requests: QuotaTopUpRequest[];
    pendingRequest: QuotaTopUpRequest | null;
  }>('/api/quota-vouchers/topup-requests/mine');
}

export function submitQuotaTopUpRequest(
  input: CreateTopUpRequestInput,
): Promise<{ request: QuotaTopUpRequest }> {
  return apiFetch<{ request: QuotaTopUpRequest }>('/api/quota-vouchers/topup-requests', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function fetchAdminQuotaVouchers(): Promise<{ vouchers: QuotaVoucher[] }> {
  return apiFetch<{ vouchers: QuotaVoucher[] }>('/api/quota-vouchers/vouchers');
}

export function createAdminQuotaVoucher(
  input: CreateQuotaVoucherInput,
): Promise<{ voucher: QuotaVoucher }> {
  return apiFetch<{ voucher: QuotaVoucher }>('/api/quota-vouchers/vouchers', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function toggleAdminQuotaVoucher(
  id: number,
  active: boolean,
): Promise<{ voucher: QuotaVoucher }> {
  return apiFetch<{ voucher: QuotaVoucher }>(`/api/quota-vouchers/vouchers/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ active }),
  });
}

export function revokeAdminQuotaVoucher(
  id: number,
): Promise<{ success: boolean; voucher: QuotaVoucher }> {
  return apiFetch<{ success: boolean; voucher: QuotaVoucher }>(
    `/api/quota-vouchers/vouchers/${id}`,
    { method: 'DELETE' },
  );
}

export function fetchAdminTopUpRequests(
  status: TopUpRequestStatus | 'all' = 'all',
): Promise<{ requests: QuotaTopUpRequest[]; pendingCount: number }> {
  const qs = status !== 'all' ? `?status=${encodeURIComponent(status)}` : '';
  return apiFetch<{ requests: QuotaTopUpRequest[]; pendingCount: number }>(
    `/api/quota-vouchers/topup-requests${qs}`,
  );
}

export function approveAdminTopUpRequest(
  id: number,
  input: ApproveTopUpRequestInput,
): Promise<ApproveTopUpRequestResponse> {
  return apiFetch<ApproveTopUpRequestResponse>(
    `/api/quota-vouchers/topup-requests/${id}/approve`,
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
  );
}

export function rejectAdminTopUpRequest(
  id: number,
  input: RejectTopUpRequestInput = {},
): Promise<{ request: QuotaTopUpRequest }> {
  return apiFetch<{ request: QuotaTopUpRequest }>(
    `/api/quota-vouchers/topup-requests/${id}/reject`,
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
  );
}
