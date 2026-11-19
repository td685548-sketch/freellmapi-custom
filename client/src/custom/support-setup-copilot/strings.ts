import { useI18n } from '@/i18n';
import type { SupportSetupStepId } from '../../../../shared/support-setup-copilot';

export interface SupportSetupCopilotStrings {
  launcherTitle: string;
  launcherNew: string;
  launcherPending: string;
  assistantName: string;
  panelTitle: string;
  panelSubtitle: string;
  memberPanelTitle: string;
  memberPanelSubtitle: string;
  tenantLabel: string;
  newTenantOption: string;
  expandPanel: string;
  compactPanel: string;
  clearChat: string;
  closePanel: string;
  roadmapHeading: string;
  roadmapProgress: string;
  roadmapToggleShow: string;
  roadmapToggleHide: string;
  stepOpen: string;
  stepComplete: string;
  stepPartial: string;
  stepMissing: string;
  stepRestricted: string;
  readOnlyBadge: string;
  briefToggle: string;
  briefHeading: string;
  briefBrandLabel: string;
  briefBrandPlaceholder: string;
  briefIndustryLabel: string;
  briefIndustryPlaceholder: string;
  briefWebsiteLabel: string;
  briefWebsitePlaceholder: string;
  briefToneLabel: string;
  briefLanguageLabel: string;
  briefColorLabel: string;
  briefPoliciesLabel: string;
  briefPoliciesPlaceholder: string;
  briefIntakeLabel: string;
  briefSubmit: string;
  welcomeBadge: string;
  welcomeTitle: string;
  welcomeDescription: string;
  memberWelcomeBadge: string;
  memberWelcomeTitle: string;
  memberWelcomeDescription: string;
  starterAutoSetup: string;
  starterAutoSetupDesc: string;
  starterAutoSetupPrompt: string;
  starterCompleteCurrent: string;
  starterCompleteCurrentDesc: string;
  starterCompleteCurrentPrompt: string;
  starterGuide: string;
  starterGuideDesc: string;
  starterGuidePrompt: string;
  starterDoctor: string;
  starterDoctorDesc: string;
  starterDoctorPrompt: string;
  starterMintKey: string;
  starterMintKeyDesc: string;
  starterMintKeyPrompt: string;
  starterOnboarding: string;
  starterOnboardingDesc: string;
  starterOnboardingPrompt: string;
  doctorPillLabel: string;
  onboardingPillLabel: string;
  whoamiPillLabel: string;
  whoamiCardTitle: string;
  whoamiAccountRole: string;
  whoamiRoleAdmin: string;
  whoamiRolePrimaryAdmin: string;
  whoamiRoleMember: string;
  whoamiPlatformOperator: string;
  whoamiNotPlatformOperator: string;
  whoamiCanCreateTenant: string;
  whoamiCannotCreateTenant: string;
  whoamiGlobalPermissions: string;
  whoamiNoGlobalPermissions: string;
  whoamiFullAccess: string;
  whoamiTenants: string;
  whoamiNoTenants: string;
  whoamiCanViewSteps: string;
  whoamiCanEditSteps: string;
  whoamiHide: string;
  starterWhoAmI: string;
  starterWhoAmIDesc: string;
  starterWhoAmIPrompt: string;
  doctorCardTitle: string;
  doctorHealthHealthy: string;
  doctorHealthDegraded: string;
  doctorHealthCritical: string;
  doctorMetricRequests: string;
  doctorMetricErrors: string;
  doctorMetricLatency: string;
  doctorMetricQuota: string;
  doctorUnlimitedQuota: string;
  doctorNoIssues: string;
  doctorActiveKeysLabel: string;
  doctorNoActiveKeys: string;
  actionConsentBanner: string;
  actionConfirmAndRun: string;
  actionRunning: string;
  actionCancel: string;
  actionExecutedBadge: string;
  actionCancelledBadge: string;
  rawKeyOneTimeNotice: string;
  copyRawKey: string;
  copiedRawKey: string;
  ideSnippetsHeading: string;
  copyIdeConfig: string;
  copiedIdeConfig: string;
  onboardingCardTitle: string;
  onboardingProgressLabel: string;
  onboardingStepDone: string;
  onboardingStepPending: string;
  inputPlaceholder: string;
  composerHint: string;
  send: string;
  thinking: string;
  consentBanner: string;
  selectedStepsCount: string;
  consentTargetCreate: string;
  consentTargetUpdate: string;
  consentNoPermission: string;
  approveAndDeploy: string;
  deploying: string;
  requestRevision: string;
  revisionHint: string;
  declinePlan: string;
  declinedBadge: string;
  appliedBadge: string;
  expiredBadge: string;
  deploySuccessTitle: string;
  embedLabel: string;
  copySnippet: string;
  copiedSnippet: string;
  openLiveTest: string;
  openIntegration: string;
  surgicalBadge: string;
  systemSettingsTarget: string;
  systemSettingsSuccessTitle: string;
  systemSettingsSuccessReply: string;
  systemSettingsApplyCount: string;
  openSettings: string;
  stepTitles: Record<SupportSetupStepId, string>;
  toneOptions: { friendly: string; professional: string; empathetic: string; technical: string };
  languageOptions: { vi: string; en: string; bilingual: string };
}

const en: SupportSetupCopilotStrings = {
  launcherTitle: 'AI Setup Copilot',
  launcherNew: 'Setup',
  launcherPending: 'Approval',
  assistantName: 'Setup Copilot',
  panelTitle: 'AI Support Setup Copilot',
  panelSubtitle: 'Your friendly onboarding specialist — nothing changes without your approval',
  memberPanelTitle: 'AI Copilot & Error Doctor',
  memberPanelSubtitle: 'Self-diagnostics, Personal API Keys & IDE setup — always consent-gated',
  tenantLabel: 'Target',
  newTenantOption: '+ Create new AI Support tenant',
  expandPanel: 'Expand panel',
  compactPanel: 'Compact panel',
  clearChat: 'Reset conversation',
  closePanel: 'Minimize',
  roadmapHeading: '7-Step Setup Checklist',
  roadmapProgress: '{done}/{total} ready',
  roadmapToggleShow: 'Checklist',
  roadmapToggleHide: 'Hide steps',
  stepOpen: 'Open',
  stepComplete: 'Ready',
  stepPartial: 'Partial',
  stepMissing: 'Missing',
  stepRestricted: 'Restricted',
  readOnlyBadge: 'Read-only access',
  briefToggle: 'Quick Brief',
  briefHeading: 'Share a few quick notes and I’ll draft a preview plan for you',
  briefBrandLabel: 'Brand / Service Name',
  briefBrandPlaceholder: 'e.g. Meeple House, GlowSkin',
  briefIndustryLabel: 'Industry',
  briefIndustryPlaceholder: 'e.g. Boardgame Shop, Acoustic Cafe, SaaS',
  briefWebsiteLabel: 'Website URL (CORS)',
  briefWebsitePlaceholder: 'e.g. https://glowskin.vn',
  briefToneLabel: 'Tone',
  briefLanguageLabel: 'Language',
  briefColorLabel: 'Brand Color',
  briefPoliciesLabel: 'Core Policies / FAQs',
  briefPoliciesPlaceholder: 'e.g. 7-day returns, free shipping over 300k, support 8am–10pm',
  briefIntakeLabel: 'Require customer name & email before chat',
  briefSubmit: 'Generate Setup Plan',
  welcomeBadge: 'Onboarding Specialist',
  welcomeTitle: 'Let’s set up a great AI support assistant together',
  welcomeDescription:
    'Chat naturally in your own words — tell me what kind of website or shop you run and I’ll put together a ready-to-review setup draft, or ask me anything in plain language.',
  memberWelcomeBadge: 'AI Error Doctor & Onboarding',
  memberWelcomeTitle: 'Diagnose API errors, mint keys & connect your IDE in seconds',
  memberWelcomeDescription:
    'Ask why calls hit 429/400/403/5xx, check your quota usage %, or prepare 1-click Personal API Keys with Cursor, Claude Code & OpenCode configs.',
  starterAutoSetup: 'Draft a tailored setup for me',
  starterAutoSetupDesc: 'Tell me a bit about your business and preview a complete draft',
  starterAutoSetupPrompt: 'Set up a complete AI Support assistant for me',
  starterCompleteCurrent: 'Finish setting up this tenant',
  starterCompleteCurrentDesc: 'Stage smart defaults for unconfigured areas so you can review',
  starterCompleteCurrentPrompt: 'Auto-complete current tenant with standard defaults',
  starterGuide: 'Walk me through the 7 steps',
  starterGuideDesc: 'Plain-English overview of FAQs, privacy masking, widget & website embed',
  starterGuidePrompt: 'How do I set up a complete AI Support assistant step by step?',
  starterDoctor: 'AI Error Doctor — Diagnose my account',
  starterDoctorDesc: 'Inspect recent 429/400/403/5xx errors, active keys & quota %',
  starterDoctorPrompt: 'Diagnose my errors and check my account health',
  starterMintKey: 'Mint Personal API Key + IDE Config',
  starterMintKeyDesc: 'Create a private sk-flm-… key with Cursor, Claude Code & OpenCode snippets',
  starterMintKeyPrompt: 'Create a new Personal API Key in Balanced mode',
  starterOnboarding: '3-Step Member Onboarding Checklist',
  starterOnboardingDesc: '1. Mint Personal Key -> 2. Test in AI Hub -> 3. Connect IDE',
  starterOnboardingPrompt: 'Open 3-step member onboarding checklist',
  doctorPillLabel: 'Error Doctor',
  onboardingPillLabel: 'Onboarding {done}/3',
  whoamiPillLabel: 'My permissions',
  whoamiCardTitle: 'My Role & Permissions',
  whoamiAccountRole: 'Account role',
  whoamiRoleAdmin: 'Admin',
  whoamiRolePrimaryAdmin: 'Primary Admin',
  whoamiRoleMember: 'Member',
  whoamiPlatformOperator: 'Platform operator',
  whoamiNotPlatformOperator: 'Not a platform operator',
  whoamiCanCreateTenant: 'Can create Support Tenants',
  whoamiCannotCreateTenant: 'Cannot create Support Tenants',
  whoamiGlobalPermissions: 'Global permissions',
  whoamiNoGlobalPermissions: 'No global permissions',
  whoamiFullAccess: 'Full access (*)',
  whoamiTenants: 'Assigned tenants',
  whoamiNoTenants: 'No tenant assigned — ask the main ADMIN for access.',
  whoamiCanViewSteps: 'Can view',
  whoamiCanEditSteps: 'Can edit',
  whoamiHide: 'Hide',
  starterWhoAmI: 'What are my permissions?',
  starterWhoAmIDesc: 'See your role, tenant access & what you can edit',
  starterWhoAmIPrompt: 'What are my permissions?',
  doctorCardTitle: 'AI Error Doctor · Account Self-Diagnostics',
  doctorHealthHealthy: 'Healthy',
  doctorHealthDegraded: 'Needs Attention',
  doctorHealthCritical: 'Action Needed',
  doctorMetricRequests: 'Requests ({hours}h)',
  doctorMetricErrors: 'Errors',
  doctorMetricLatency: 'Avg Latency',
  doctorMetricQuota: 'Peak Quota',
  doctorUnlimitedQuota: 'No cap',
  doctorNoIssues: 'Zero recent errors or quota bottlenecks detected on your account.',
  doctorActiveKeysLabel: 'Active Personal Keys',
  doctorNoActiveKeys: 'No active Personal API Key yet.',
  actionConsentBanner: 'Human-in-the-loop confirmation required',
  actionConfirmAndRun: 'Confirm & Run',
  actionRunning: 'Running…',
  actionCancel: 'Cancel',
  actionExecutedBadge: 'Completed',
  actionCancelledBadge: 'Cancelled',
  rawKeyOneTimeNotice: 'Shown only once — copy and store your Personal API Key safely:',
  copyRawKey: 'Copy API Key',
  copiedRawKey: 'Key Copied!',
  ideSnippetsHeading: 'Ready-to-Copy IDE Configuration',
  copyIdeConfig: 'Copy Config',
  copiedIdeConfig: 'Config Copied!',
  onboardingCardTitle: 'Member 3-Step Onboarding Checklist',
  onboardingProgressLabel: '{done}/{total} completed',
  onboardingStepDone: 'Done',
  onboardingStepPending: 'To do',
  inputPlaceholder: 'Ask why API calls fail (429/quota), mint a key, or describe your site…',
  composerHint: 'Enter to send · Shift+Enter for new line',
  send: 'Send',
  thinking: 'Thinking & putting together a helpful reply…',
  consentBanner: 'Consent required — no changes applied yet',
  selectedStepsCount: '{selected}/{total} selected',
  consentTargetCreate: 'New tenant: {name} ({slug})',
  consentTargetUpdate: 'Update tenant: {name} ({slug})',
  consentNoPermission: 'Read-only (no edit permission)',
  approveAndDeploy: 'Approve & Auto-Deploy',
  deploying: 'Deploying…',
  requestRevision: 'Adjust plan',
  revisionHint: 'Could you adjust this part: ',
  declinePlan: 'Decline',
  declinedBadge: 'Declined',
  appliedBadge: 'Deployed',
  expiredBadge: 'Expired',
  deploySuccessTitle: 'AI Support deployed successfully',
  embedLabel: 'Website Embed Snippet',
  copySnippet: 'Copy snippet',
  copiedSnippet: 'Copied!',
  openLiveTest: 'Open Live Test',
  openIntegration: 'Integration Studio',
  surgicalBadge: 'Targeted update · Other steps untouched',
  systemSettingsTarget: 'System Settings (Platform & Thruline)',
  systemSettingsSuccessTitle: 'System settings applied successfully',
  systemSettingsSuccessReply: 'System settings have been successfully applied!',
  systemSettingsApplyCount: '{selected}/{total} settings selected',
  openSettings: 'Open Settings',
  stepTitles: {
    tenant_ai: '1. Tenant & AI Persona',
    knowledge_masking: '2. Knowledge Base & Masking',
    guardrails_quotas: '3. Firewall & Quotas',
    output_controls: '4. Output Safety Controls',
    widget_appearance: '5. Chat Widget & Branding',
    sla_routing: '6. Service Desk SLA & Routing',
    runtime_policy: '7. CORS Origins & Runtime',
  },
  toneOptions: {
    friendly: 'Friendly',
    professional: 'Professional',
    empathetic: 'Empathetic',
    technical: 'Technical',
  },
  languageOptions: {
    vi: 'Vietnamese',
    en: 'English',
    bilingual: 'Bilingual (VI + EN)',
  },
};

const vi: SupportSetupCopilotStrings = {
  launcherTitle: 'Trợ lý Setup AI',
  launcherNew: 'Setup',
  launcherPending: 'Chờ duyệt',
  assistantName: 'Setup Copilot',
  panelTitle: 'Trợ lý Setup AI Support',
  panelSubtitle: 'Người đồng hành tư vấn & thiết lập cùng bạn — chỉ áp dụng khi bạn duyệt',
  memberPanelTitle: 'Trợ lý AI & Bác sĩ Chẩn đoán Lỗi',
  memberPanelSubtitle: 'Tự động bắt bệnh API, tạo Personal Key & cấu hình IDE — luôn chờ bạn xác nhận',
  tenantLabel: 'Mục tiêu',
  newTenantOption: '+ Tạo Tenant AI Support mới',
  expandPanel: 'Mở rộng khung',
  compactPanel: 'Thu gọn khung',
  clearChat: 'Làm mới hội thoại',
  closePanel: 'Thu nhỏ',
  roadmapHeading: 'Lộ trình 7 bước hoàn chỉnh',
  roadmapProgress: '{done}/{total} hoàn tất',
  roadmapToggleShow: 'Xem 7 bước',
  roadmapToggleHide: 'Ẩn 7 bước',
  stepOpen: 'Mở trang',
  stepComplete: 'Hoàn tất',
  stepPartial: 'Cơ bản',
  stepMissing: 'Chưa bật',
  stepRestricted: 'Giới hạn quyền',
  readOnlyBadge: 'Chế độ Chỉ xem',
  briefToggle: 'Phiếu nhanh',
  briefHeading: 'Chia sẻ nhanh vài nét chính — mình sẽ soạn sẵn bản nháp để bạn duyệt',
  briefBrandLabel: 'Tên thương hiệu / Dịch vụ',
  briefBrandPlaceholder: 'VD: Meeple House, Mỹ phẩm GlowSkin',
  briefIndustryLabel: 'Lĩnh vực',
  briefIndustryPlaceholder: 'VD: Web Boardgame, Quán cà phê, Mỹ phẩm',
  briefWebsiteLabel: 'Website (mở CORS)',
  briefWebsitePlaceholder: 'VD: https://glowskin.vn',
  briefToneLabel: 'Giọng điệu AI',
  briefLanguageLabel: 'Ngôn ngữ trả lời',
  briefColorLabel: 'Màu thương hiệu',
  briefPoliciesLabel: 'Chính sách & FAQ cốt lõi',
  briefPoliciesPlaceholder: 'VD: Đổi trả trong 7 ngày, freeship đơn 300k, hỗ trợ 8h–22h',
  briefIntakeLabel: 'Yêu cầu khách nhập Tên & Email trước khi chat',
  briefSubmit: 'Tạo kế hoạch Setup',
  welcomeBadge: 'Chuyên viên đồng hành Setup',
  welcomeTitle: 'Mình cùng dựng trợ lý AI chăm sóc khách hàng cho bạn nhé!',
  welcomeDescription:
    'Bạn cứ trò chuyện tự nhiên như nhắn với đồng nghiệp — kể nhẹ về web/shop của mình để mình phác thảo sẵn bản mẫu trọn gói (chỉ cài đặt khi bạn bấm duyệt), hoặc hỏi bất cứ chỗ nào chưa rõ nhé.',
  memberWelcomeBadge: 'Bác sĩ Lỗi API & Đồng hành',
  memberWelcomeTitle: 'Bắt bệnh lỗi API, tạo khóa cá nhân & kết nối IDE cực nhanh!',
  memberWelcomeDescription:
    'Hỏi mình vì sao gọi API gặp lỗi 429/400/403/lag, kiểm tra % hạn mức Quota, hoặc tạo Personal API Key kèm cấu hình copy ngay cho Cursor, Claude Code & OpenCode.',
  starterAutoSetup: 'Nhờ mình lên bản mẫu trọn gói',
  starterAutoSetupDesc: 'Trò chuyện vài câu tự nhiên, mình soạn sẵn từ A–Z để bạn xem trước',
  starterAutoSetupPrompt: 'Mình muốn nhờ bạn tư vấn và thiết lập giúp một trợ lý AI Support',
  starterCompleteCurrent: 'Hoàn thiện giúp tenant đang mở',
  starterCompleteCurrentDesc: 'Điền sẵn cấu hình chuẩn cho các mục còn thiếu để bạn duyệt',
  starterCompleteCurrentPrompt: 'Hoàn thiện cấu hình tiêu chuẩn cho tenant hiện tại',
  starterGuide: 'Hướng dẫn dễ hiểu 7 bước setup',
  starterGuideDesc: 'Giải thích gọn gàng cách nạp FAQ, che SĐT khách & gắn chat lên web',
  starterGuidePrompt: 'Hướng dẫn tôi chi tiết từng bước để có 1 con AI Support hoàn chỉnh',
  starterDoctor: 'Bác sĩ AI — Kiểm tra tài khoản & lỗi API',
  starterDoctorDesc: 'Soi nhanh lỗi 429/400/403/5xx, khóa cá nhân đang bật & % Quota',
  starterDoctorPrompt: 'Kiểm tra tài khoản giúp mình xem sao gọi API bị lỗi',
  starterMintKey: 'Tạo Personal API Key + Cấu hình IDE',
  starterMintKeyDesc: 'Sinh khóa sk-flm-… riêng kèm snippet cho Cursor, Claude Code & OpenCode',
  starterMintKeyPrompt: 'Tạo giúp mình 1 Personal API Key mới chế độ Balanced',
  starterOnboarding: 'Checklist 3 bước cho Thành viên mới',
  starterOnboardingDesc: '1. Tạo Personal Key -> 2. Thử trên AI Hub -> 3. Kết nối IDE',
  starterOnboardingPrompt: 'Mở hướng dẫn checklist 3 bước cho thành viên mới',
  doctorPillLabel: 'Bác sĩ Lỗi',
  onboardingPillLabel: 'Bắt đầu {done}/3',
  whoamiPillLabel: 'Quyền của tôi',
  whoamiCardTitle: 'Role & Quyền của tôi',
  whoamiAccountRole: 'Vai trò tài khoản',
  whoamiRoleAdmin: 'Quản trị viên',
  whoamiRolePrimaryAdmin: 'Quản trị viên chính',
  whoamiRoleMember: 'Thành viên',
  whoamiPlatformOperator: 'Vận hành nền tảng',
  whoamiNotPlatformOperator: 'Không phải vận hành nền tảng',
  whoamiCanCreateTenant: 'Được tạo Support Tenant mới',
  whoamiCannotCreateTenant: 'Không được tạo Support Tenant mới',
  whoamiGlobalPermissions: 'Quyền toàn cục',
  whoamiNoGlobalPermissions: 'Không có quyền toàn cục',
  whoamiFullAccess: 'Toàn quyền (*)',
  whoamiTenants: 'Tenant được phân quyền',
  whoamiNoTenants: 'Chưa được phân quyền tenant nào — liên hệ ADMIN chính để được cấp quyền.',
  whoamiCanViewSteps: 'Xem được',
  whoamiCanEditSteps: 'Sửa được',
  whoamiHide: 'Ẩn',
  starterWhoAmI: 'Tôi có quyền gì?',
  starterWhoAmIDesc: 'Xem role, tenant được giao & mục nào bạn được sửa',
  starterWhoAmIPrompt: 'Tôi có quyền gì?',
  doctorCardTitle: 'AI Error Doctor · Chẩn đoán Tài khoản',
  doctorHealthHealthy: 'Ổn định',
  doctorHealthDegraded: 'Cần chú ý',
  doctorHealthCritical: 'Cần xử lý',
  doctorMetricRequests: 'Lượt gọi ({hours}h)',
  doctorMetricErrors: 'Lỗi',
  doctorMetricLatency: 'Độ trễ TB',
  doctorMetricQuota: 'Đỉnh Quota',
  doctorUnlimitedQuota: 'Không giới hạn',
  doctorNoIssues: 'Không phát hiện lỗi gọi API hay nghẽn hạn mức nào gần đây trên tài khoản của bạn.',
  doctorActiveKeysLabel: 'Personal Key đang bật',
  doctorNoActiveKeys: 'Chưa có Personal API Key nào đang bật.',
  actionConsentBanner: 'Thao tác cần bạn xác nhận trước khi chạy',
  actionConfirmAndRun: 'Xác nhận & Chạy',
  actionRunning: 'Đang thực thi…',
  actionCancel: 'Hủy',
  actionExecutedBadge: 'Đã thực thi',
  actionCancelledBadge: 'Đã hủy',
  rawKeyOneTimeNotice: 'Chỉ hiển thị duy nhất 1 lần — hãy sao chép & lưu Personal API Key ngay:',
  copyRawKey: 'Sao chép Key',
  copiedRawKey: 'Đã chép Key!',
  ideSnippetsHeading: 'Cấu hình dán ngay cho IDE',
  copyIdeConfig: 'Sao chép cấu hình',
  copiedIdeConfig: 'Đã chép cấu hình!',
  onboardingCardTitle: 'Checklist 3 bước bắt đầu cho Thành viên',
  onboardingProgressLabel: 'Hoàn tất {done}/{total}',
  onboardingStepDone: 'Hoàn tất',
  onboardingStepPending: 'Chưa xong',
  inputPlaceholder: 'Hỏi sao API lỗi 429/lag, tạo Personal Key, hoặc kể về web/shop của bạn…',
  composerHint: 'Enter để gửi · Shift+Enter xuống dòng',
  send: 'Gửi',
  thinking: 'Đang lắng nghe & chuẩn bị câu trả lời cho bạn…',
  consentBanner: 'Chờ xác nhận — chưa thay đổi dữ liệu hệ thống',
  selectedStepsCount: 'Đã chọn {selected}/{total} bước',
  consentTargetCreate: 'Tạo tenant mới: {name} ({slug})',
  consentTargetUpdate: 'Cập nhật tenant: {name} ({slug})',
  consentNoPermission: 'Chỉ xem (tài khoản chưa có quyền sửa bước này)',
  approveAndDeploy: 'Đồng ý & Tự động triển khai',
  deploying: 'Đang triển khai…',
  requestRevision: 'Chỉnh sửa thêm',
  revisionHint: 'Mình muốn chỉnh lại một chút: ',
  declinePlan: 'Từ chối',
  declinedBadge: 'Đã từ chối',
  appliedBadge: 'Đã triển khai',
  expiredBadge: 'Đã hết hạn',
  deploySuccessTitle: 'Triển khai AI Support hoàn tất',
  embedLabel: 'Mã nhúng Widget lên Website',
  copySnippet: 'Sao chép mã',
  copiedSnippet: 'Đã chép!',
  openLiveTest: 'Mở Live Test ngay',
  openIntegration: 'Integration Studio',
  surgicalBadge: 'Chỉnh sửa chọn lọc · Giữ nguyên các mục khác',
  systemSettingsTarget: 'Cấu hình hệ thống (Platform & Thruline)',
  systemSettingsSuccessTitle: 'Đã áp dụng cấu hình hệ thống thành công',
  systemSettingsSuccessReply: 'Đã áp dụng các cấu hình hệ thống thành công!',
  systemSettingsApplyCount: 'Đã chọn {selected}/{total} mục cấu hình',
  openSettings: 'Xem Cài đặt',
  stepTitles: {
    tenant_ai: '1. Tenant & Nhân cách AI',
    knowledge_masking: '2. Tri thức FAQ & Che PII',
    guardrails_quotas: '3. Tường lửa & Hạn mức',
    output_controls: '4. Kiểm soát đầu ra',
    widget_appearance: '5. Widget & Thương hiệu',
    sla_routing: '6. Service Desk SLA & Phân luồng',
    runtime_policy: '7. Tên miền CORS & Runtime',
  },
  toneOptions: {
    friendly: 'Thân thiện',
    professional: 'Chuyên nghiệp',
    empathetic: 'Ân cần, đồng cảm',
    technical: 'Kỹ thuật chuẩn xác',
  },
  languageOptions: {
    vi: 'Tiếng Việt',
    en: 'English',
    bilingual: 'Song ngữ (Việt + Anh)',
  },
};

export function getSupportSetupCopilotStrings(targetLocale: 'vi' | 'en'): SupportSetupCopilotStrings {
  return targetLocale === 'vi' ? vi : en;
}

export function useSupportSetupCopilotStrings(): SupportSetupCopilotStrings {
  const { locale } = useI18n();
  return locale === 'vi' ? vi : en;
}

export function formatSetupString(
  template: string,
  vars: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    vars[key] === undefined ? match : String(vars[key]),
  );
}
