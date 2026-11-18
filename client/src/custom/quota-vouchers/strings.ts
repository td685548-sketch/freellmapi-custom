import { useI18n } from '@/i18n';

export interface QuotaVoucherStrings {
  redeemButton: string;
  requestTopUpButton: string;
  pendingTopUpBadge: string;
  redeemTitle: string;
  redeemSubtitle: string;
  redeemPlaceholder: string;
  redeemAction: string;
  redeeming: string;
  redeemClose: string;
  redeemSuccessToast: string;
  redeemSuccessBanner: string;
  redeemErrorFallback: string;
  topUpModalTitle: string;
  topUpModalSubtitle: string;
  topUpPresetHeading: string;
  topUpPresetLight: string;
  topUpPresetSprint: string;
  topUpPresetHeavy: string;
  topUpDailyRequestsLabel: string;
  topUpDailyTokensLabel: string;
  topUpReasonLabel: string;
  topUpReasonPlaceholder: string;
  topUpPendingNoticeTitle: string;
  topUpPendingNoticeDetail: string;
  topUpHistoryHeading: string;
  topUpSubmit: string;
  topUpSubmitting: string;
  cancel: string;
  topUpSubmittedToast: string;
  topUpErrorFallback: string;
  statusPending: string;
  statusApproved: string;
  statusRejected: string;
  statusActive: string;
  statusInactive: string;
  statusExpired: string;
  statusExhausted: string;
  adminVouchersTitle: string;
  adminVouchersDesc: string;
  adminCreateVoucherBtn: string;
  adminVouchersEmpty: string;
  adminVouchersEmptyHint: string;
  adminVoucherLoading: string;
  adminVoucherCodeLabel: string;
  adminVoucherCodePlaceholder: string;
  adminVoucherLabelLabel: string;
  adminVoucherLabelPlaceholder: string;
  adminBonusReqDaily: string;
  adminBonusTokDaily: string;
  adminBonusReqMonthly: string;
  adminBonusTokMonthly: string;
  adminMaxRedemptions: string;
  adminExpiresInDays: string;
  adminNeverExpires: string;
  adminDaysOption: string;
  adminVoucherCreateSubmit: string;
  adminVoucherCreating: string;
  adminVoucherCreatedToast: string;
  adminVoucherUpdatedToast: string;
  adminVoucherRevokedToast: string;
  adminCopyCode: string;
  adminRedemptionsCount: string;
  adminExpiresLabel: string;
  adminPause: string;
  adminActivate: string;
  adminRevoke: string;
  adminRevokeConfirm: string;
  adminTopUpsTitle: string;
  adminTopUpsDesc: string;
  adminTopUpsFilterPending: string;
  adminTopUpsFilterAll: string;
  adminTopUpsEmpty: string;
  adminTopUpsLoading: string;
  adminGrantReqDaily: string;
  adminGrantTokDaily: string;
  adminNotePlaceholder: string;
  adminApproveBtn: string;
  adminApproving: string;
  adminRejectBtn: string;
  adminRejecting: string;
  adminApprovedToast: string;
  adminRejectedToast: string;
  adminReasonPrefix: string;
  adminReviewedByPrefix: string;
  unitReqDay: string;
  unitTokDay: string;
  unitReqMonth: string;
  unitTokMonth: string;
}

const en: QuotaVoucherStrings = {
  redeemButton: 'Redeem Code',
  requestTopUpButton: 'Request Top-Up',
  pendingTopUpBadge: 'Pending Top-Up: +{tokens} tok/d · +{requests} req/d',
  redeemTitle: 'Redeem Quota Gift Code',
  redeemSubtitle: 'Enter a voucher code to instantly stack bonus daily or monthly quota onto your account.',
  redeemPlaceholder: 'e.g. GIFT-8F3A-19C2',
  redeemAction: 'Redeem',
  redeeming: 'Redeeming…',
  redeemClose: 'Close',
  redeemSuccessToast: 'Voucher {code} redeemed successfully!',
  redeemSuccessBanner: 'Applied {code}: {summary}',
  redeemErrorFallback: 'Unable to redeem voucher code.',
  topUpModalTitle: '1-Click Quota Top-Up Request',
  topUpModalSubtitle: 'Pick a preset boost or enter custom daily allowances for administrator 1-click approval.',
  topUpPresetHeading: 'Quick Presets',
  topUpPresetLight: 'Light Boost (+50 req/d · +250K tok/d)',
  topUpPresetSprint: 'Coding Sprint (+200 req/d · +1M tok/d)',
  topUpPresetHeavy: 'Agentic Heavy (+500 req/d · +3M tok/d)',
  topUpDailyRequestsLabel: 'Extra Daily Requests',
  topUpDailyTokensLabel: 'Extra Daily Tokens',
  topUpReasonLabel: 'Reason / Project Context (optional)',
  topUpReasonPlaceholder: 'e.g. Running benchmark suite / hackathon sprint today',
  topUpPendingNoticeTitle: 'You have a pending top-up request',
  topUpPendingNoticeDetail: 'Requested +{requests} req/day & +{tokens} tokens/day — awaiting admin review.',
  topUpHistoryHeading: 'Recent Requests',
  topUpSubmit: 'Submit Request',
  topUpSubmitting: 'Submitting…',
  cancel: 'Cancel',
  topUpSubmittedToast: 'Quota top-up request submitted!',
  topUpErrorFallback: 'Failed to submit top-up request.',
  statusPending: 'Pending',
  statusApproved: 'Approved',
  statusRejected: 'Declined',
  statusActive: 'Active',
  statusInactive: 'Paused',
  statusExpired: 'Expired',
  statusExhausted: 'Exhausted',
  adminVouchersTitle: 'Quota Redeem Vouchers',
  adminVouchersDesc: 'Issue gift codes that members can self-redeem to stack bonus daily or monthly quota.',
  adminCreateVoucherBtn: 'Create Gift Voucher',
  adminVouchersEmpty: 'No quota vouchers created yet',
  adminVouchersEmptyHint: 'Create a voucher code for hackathons, team sprints, or promotional boosts.',
  adminVoucherLoading: 'Loading quota vouchers…',
  adminVoucherCodeLabel: 'Voucher Code (optional)',
  adminVoucherCodePlaceholder: 'e.g. HACKATHON-2026 (blank to auto-generate)',
  adminVoucherLabelLabel: 'Label / Campaign Note (optional)',
  adminVoucherLabelPlaceholder: 'e.g. Weekend Coding Sprint Bonus',
  adminBonusReqDaily: 'Bonus Daily Requests',
  adminBonusTokDaily: 'Bonus Daily Tokens',
  adminBonusReqMonthly: 'Bonus Monthly Requests',
  adminBonusTokMonthly: 'Bonus Monthly Tokens',
  adminMaxRedemptions: 'Max Redemptions',
  adminExpiresInDays: 'Expires In',
  adminNeverExpires: 'Never',
  adminDaysOption: '{days} Days',
  adminVoucherCreateSubmit: 'Create Voucher',
  adminVoucherCreating: 'Creating…',
  adminVoucherCreatedToast: 'Quota voucher created!',
  adminVoucherUpdatedToast: 'Voucher status updated.',
  adminVoucherRevokedToast: 'Voucher deactivated.',
  adminCopyCode: 'Copy code',
  adminRedemptionsCount: 'Redeemed: {used} / {max}',
  adminExpiresLabel: 'Expires: {date}',
  adminPause: 'Pause',
  adminActivate: 'Activate',
  adminRevoke: 'Revoke',
  adminRevokeConfirm: 'Deactivate voucher "{code}" so no additional members can redeem it?',
  adminTopUpsTitle: 'Member Quota Top-Up Requests',
  adminTopUpsDesc: 'Review member top-up requests and grant allowances in 1 click.',
  adminTopUpsFilterPending: 'Pending ({count})',
  adminTopUpsFilterAll: 'All Recent',
  adminTopUpsEmpty: 'No quota top-up requests in this view.',
  adminTopUpsLoading: 'Loading top-up requests…',
  adminGrantReqDaily: 'Grant Req/Day',
  adminGrantTokDaily: 'Grant Tokens/Day',
  adminNotePlaceholder: 'Optional note to member…',
  adminApproveBtn: 'Approve & Grant',
  adminApproving: 'Approving…',
  adminRejectBtn: 'Reject',
  adminRejecting: 'Rejecting…',
  adminApprovedToast: 'Top-up approved and quota stacked!',
  adminRejectedToast: 'Top-up request declined.',
  adminReasonPrefix: 'Reason:',
  adminReviewedByPrefix: 'Reviewed by',
  unitReqDay: 'req/d',
  unitTokDay: 'tok/d',
  unitReqMonth: 'req/mo',
  unitTokMonth: 'tok/mo',
};

const vi: QuotaVoucherStrings = {
  redeemButton: 'Nhập mã quà',
  requestTopUpButton: 'Xin cấp thêm Quota',
  pendingTopUpBadge: 'Đang chờ duyệt: +{tokens} tok/ngày · +{requests} req/ngày',
  redeemTitle: 'Nhập mã Voucher cộng Quota',
  redeemSubtitle: 'Nhập mã quà tặng để cộng dồn ngay hạn mức request / token vào tài khoản của bạn.',
  redeemPlaceholder: 'VD: GIFT-8F3A-19C2',
  redeemAction: 'Đổi mã',
  redeeming: 'Đang đổi…',
  redeemClose: 'Đóng',
  redeemSuccessToast: 'Đã đổi mã {code} thành công!',
  redeemSuccessBanner: 'Đã cộng từ mã {code}: {summary}',
  redeemErrorFallback: 'Không thể đổi mã voucher.',
  topUpModalTitle: 'Yêu cầu cấp thêm Quota nhanh (1-Click)',
  topUpModalSubtitle: 'Chọn gói tăng nhanh hoặc nhập hạn mức ngày bạn cần để quản trị viên duyệt chỉ với 1 cú nhấp.',
  topUpPresetHeading: 'Gói gợi ý nhanh',
  topUpPresetLight: 'Tăng nhẹ (+50 req/ngày · +250K tok/ngày)',
  topUpPresetSprint: 'Chạy nước rút Code (+200 req/ngày · +1M tok/ngày)',
  topUpPresetHeavy: 'Agent chuyên sâu (+500 req/ngày · +3M tok/ngày)',
  topUpDailyRequestsLabel: 'Cộng thêm Request / ngày',
  topUpDailyTokensLabel: 'Cộng thêm Token / ngày',
  topUpReasonLabel: 'Lý do / Ghi chú dự án (tuỳ chọn)',
  topUpReasonPlaceholder: 'VD: Đang chạy benchmark / sprint hoàn thiện tính năng hôm nay',
  topUpPendingNoticeTitle: 'Bạn đang có 1 yêu cầu chờ duyệt',
  topUpPendingNoticeDetail: 'Đã xin +{requests} req/ngày & +{tokens} token/ngày — đang chờ quản trị viên duyệt.',
  topUpHistoryHeading: 'Lịch sử yêu cầu gần đây',
  topUpSubmit: 'Gửi yêu cầu',
  topUpSubmitting: 'Đang gửi…',
  cancel: 'Huỷ',
  topUpSubmittedToast: 'Đã gửi yêu cầu xin thêm quota!',
  topUpErrorFallback: 'Không thể gửi yêu cầu cấp thêm quota.',
  statusPending: 'Chờ duyệt',
  statusApproved: 'Đã duyệt',
  statusRejected: 'Từ chối',
  statusActive: 'Đang mở',
  statusInactive: 'Tạm dừng',
  statusExpired: 'Hết hạn',
  statusExhausted: 'Hết lượt',
  adminVouchersTitle: 'Mã quà tặng Quota (Redeem Vouchers)',
  adminVouchersDesc: 'Tạo mã quà tặng để thành viên tự nhập và cộng dồn hạn mức ngày/tháng.',
  adminCreateVoucherBtn: 'Tạo mã Voucher',
  adminVouchersEmpty: 'Chưa có mã voucher quota nào',
  adminVouchersEmptyHint: 'Tạo mã quà tặng cho hackathon, đợt sprint nhóm hoặc thưởng thành viên.',
  adminVoucherLoading: 'Đang tải danh sách voucher…',
  adminVoucherCodeLabel: 'Mã Voucher (tuỳ chọn)',
  adminVoucherCodePlaceholder: 'VD: HACKATHON-2026 (để trống để tự sinh)',
  adminVoucherLabelLabel: 'Nhãn / Ghi chú chiến dịch (tuỳ chọn)',
  adminVoucherLabelPlaceholder: 'VD: Thưởng Sprint cuối tuần',
  adminBonusReqDaily: 'Cộng Request / ngày',
  adminBonusTokDaily: 'Cộng Token / ngày',
  adminBonusReqMonthly: 'Cộng Request / tháng',
  adminBonusTokMonthly: 'Cộng Token / tháng',
  adminMaxRedemptions: 'Số lượt đổi tối đa',
  adminExpiresInDays: 'Thời hạn',
  adminNeverExpires: 'Không giới hạn',
  adminDaysOption: '{days} ngày',
  adminVoucherCreateSubmit: 'Tạo Voucher',
  adminVoucherCreating: 'Đang tạo…',
  adminVoucherCreatedToast: 'Đã tạo mã voucher quota!',
  adminVoucherUpdatedToast: 'Đã cập nhật trạng thái voucher.',
  adminVoucherRevokedToast: 'Đã vô hiệu hoá voucher.',
  adminCopyCode: 'Sao chép mã',
  adminRedemptionsCount: 'Đã đổi: {used} / {max}',
  adminExpiresLabel: 'Hết hạn: {date}',
  adminPause: 'Tạm dừng',
  adminActivate: 'Kích hoạt',
  adminRevoke: 'Thu hồi',
  adminRevokeConfirm: 'Vô hiệu hoá mã voucher "{code}" để ngừng lượt đổi mới?',
  adminTopUpsTitle: 'Yêu cầu xin thêm Quota từ thành viên',
  adminTopUpsDesc: 'Duyệt nhanh 1 chạm các yêu cầu nâng hạn mức ngày của thành viên.',
  adminTopUpsFilterPending: 'Chờ duyệt ({count})',
  adminTopUpsFilterAll: 'Tất cả gần đây',
  adminTopUpsEmpty: 'Không có yêu cầu xin thêm quota nào trong mục này.',
  adminTopUpsLoading: 'Đang tải danh sách yêu cầu…',
  adminGrantReqDaily: 'Cấp Req/ngày',
  adminGrantTokDaily: 'Cấp Token/ngày',
  adminNotePlaceholder: 'Ghi chú phản hồi cho thành viên (tuỳ chọn)…',
  adminApproveBtn: 'Duyệt & Cộng ngay',
  adminApproving: 'Đang duyệt…',
  adminRejectBtn: 'Từ chối',
  adminRejecting: 'Đang xử lý…',
  adminApprovedToast: 'Đã duyệt và cộng thêm quota cho thành viên!',
  adminRejectedToast: 'Đã từ chối yêu cầu xin thêm quota.',
  adminReasonPrefix: 'Lý do:',
  adminReviewedByPrefix: 'Xử lý bởi',
  unitReqDay: 'req/ngày',
  unitTokDay: 'tok/ngày',
  unitReqMonth: 'req/tháng',
  unitTokMonth: 'tok/tháng',
};

export function useQuotaVoucherStrings(): QuotaVoucherStrings {
  const { locale } = useI18n();
  return locale === 'vi' ? vi : en;
}

export function formatVoucherText(
  template: string,
  vars: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    vars[key] === undefined ? match : String(vars[key]),
  );
}
