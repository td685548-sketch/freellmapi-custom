import type { UsageQuotaState } from './usage-quota.js';

export type QuotaVoucherStatus = 'active' | 'inactive' | 'expired' | 'exhausted';

export interface QuotaVoucher {
  id: number;
  code: string;
  label: string | null;
  bonusRequestsDaily: number;
  bonusTokensDaily: number;
  bonusRequestsMonthly: number;
  bonusTokensMonthly: number;
  maxRedemptions: number;
  redeemedCount: number;
  expiresAt: string | null;
  active: boolean;
  status: QuotaVoucherStatus;
  createdBy: number | null;
  creatorEmail: string | null;
  createdAt: string;
}

export interface QuotaVoucherRedemption {
  id: number;
  voucherId: number;
  code: string;
  label: string | null;
  userId: number;
  bonusRequestsDaily: number;
  bonusTokensDaily: number;
  bonusRequestsMonthly: number;
  bonusTokensMonthly: number;
  redeemedAt: string;
}

export interface CreateQuotaVoucherInput {
  code?: string;
  label?: string | null;
  bonusRequestsDaily?: number;
  bonusTokensDaily?: number;
  bonusRequestsMonthly?: number;
  bonusTokensMonthly?: number;
  maxRedemptions?: number;
  expiresAt?: string | null;
  expiresInDays?: number | null;
}

export interface RedeemQuotaVoucherResponse {
  redemption: QuotaVoucherRedemption;
  voucher: QuotaVoucher;
  quotaState: UsageQuotaState;
}

export type TopUpRequestStatus = 'pending' | 'approved' | 'rejected';

export interface QuotaTopUpRequest {
  id: number;
  userId: number;
  userEmail?: string;
  requestedTokensDaily: number;
  requestedRequestsDaily: number;
  reason: string;
  status: TopUpRequestStatus;
  adminNote: string | null;
  reviewedBy: number | null;
  reviewerEmail: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export interface CreateTopUpRequestInput {
  requestedTokensDaily?: number;
  requestedRequestsDaily?: number;
  reason?: string;
}

export interface ApproveTopUpRequestInput {
  grantedTokensDaily?: number;
  grantedRequestsDaily?: number;
  grantedTokensMonthly?: number;
  grantedRequestsMonthly?: number;
  adminNote?: string;
}

export interface RejectTopUpRequestInput {
  adminNote?: string;
}

export interface ApproveTopUpRequestResponse {
  request: QuotaTopUpRequest;
  granted: {
    dailyRequests: number;
    dailyTokens: number;
    monthlyRequests: number;
    monthlyTokens: number;
  };
  quotaState: UsageQuotaState;
}
