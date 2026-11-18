import { useI18n } from '@/i18n';
import type { SupportSetupStepId } from '../../../../shared/support-setup-copilot';

export interface SupportSetupCopilotStrings {
  launcherTitle: string;
  launcherNew: string;
  launcherPending: string;
  panelTitle: string;
  panelSubtitle: string;
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
  welcomeTitle: string;
  welcomeDescription: string;
  starterAutoSetup: string;
  starterAutoSetupPrompt: string;
  starterCompleteCurrent: string;
  starterCompleteCurrentPrompt: string;
  starterGuide: string;
  starterGuidePrompt: string;
  inputPlaceholder: string;
  send: string;
  thinking: string;
  consentBanner: string;
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
  stepTitles: Record<SupportSetupStepId, string>;
  toneOptions: { friendly: string; professional: string; empathetic: string; technical: string };
  languageOptions: { vi: string; en: string; bilingual: string };
}

const en: SupportSetupCopilotStrings = {
  launcherTitle: 'AI Setup Copilot',
  launcherNew: 'Setup',
  launcherPending: 'Approval',
  panelTitle: 'AI Support Setup Copilot',
  panelSubtitle: 'Step-by-step coach & consent-gated auto-deployer',
  tenantLabel: 'Target',
  newTenantOption: '+ Create new AI Support tenant',
  expandPanel: 'Expand panel',
  compactPanel: 'Compact panel',
  clearChat: 'Reset conversation',
  closePanel: 'Minimize',
  roadmapHeading: '7-Step Setup Checklist',
  roadmapProgress: '{done}/{total} ready',
  roadmapToggleShow: 'Show steps',
  roadmapToggleHide: 'Hide steps',
  stepOpen: 'Open',
  stepComplete: 'Ready',
  stepPartial: 'Partial',
  stepMissing: 'Missing',
  stepRestricted: 'Restricted',
  readOnlyBadge: 'Read-only access',
  briefToggle: 'Quick Business Brief',
  briefHeading: 'Share quick details so AI can build your setup plan',
  briefBrandLabel: 'Brand / Service Name',
  briefBrandPlaceholder: 'e.g. GlowSkin Shop',
  briefIndustryLabel: 'Industry',
  briefIndustryPlaceholder: 'e.g. Cosmetics & E-commerce',
  briefWebsiteLabel: 'Website URL (CORS)',
  briefWebsitePlaceholder: 'e.g. https://glowskin.vn',
  briefToneLabel: 'Tone',
  briefLanguageLabel: 'Language',
  briefColorLabel: 'Brand Color',
  briefPoliciesLabel: 'Core Policies / FAQs',
  briefPoliciesPlaceholder: 'e.g. 7-day returns, free shipping over 300k, support 8am–10pm',
  briefIntakeLabel: 'Require customer name & email before chat',
  briefSubmit: 'Generate Setup Plan',
  welcomeTitle: 'Need help setting up AI Support?',
  welcomeDescription:
    'I know all 7 Support Studios. Ask me how anything works, or let me interview you briefly, design the full setup, and deploy everything after your approval.',
  starterAutoSetup: 'Set up everything for me',
  starterAutoSetupPrompt: 'Set up a complete AI Support assistant for me',
  starterCompleteCurrent: 'Finish missing steps on current tenant',
  starterCompleteCurrentPrompt: 'Auto-complete current tenant with standard defaults',
  starterGuide: 'Explain the 7 setup steps',
  starterGuidePrompt: 'How do I set up a complete AI Support assistant step by step?',
  inputPlaceholder: 'Ask how to configure a step, or describe your business to auto-setup…',
  send: 'Send',
  thinking: 'Designing your setup…',
  consentBanner: 'Consent required — nothing has been changed yet',
  consentTargetCreate: 'New tenant: {name} ({slug})',
  consentTargetUpdate: 'Update tenant: {name} ({slug})',
  consentNoPermission: 'Read-only (no edit permission)',
  approveAndDeploy: 'Approve & Auto-Deploy',
  deploying: 'Deploying…',
  requestRevision: 'Adjust plan',
  revisionHint: 'Tell me what to change (e.g. color, tone, policies, or blocked terms): ',
  declinePlan: 'Decline',
  declinedBadge: 'Declined',
  appliedBadge: 'Deployed',
  expiredBadge: 'Expired',
  deploySuccessTitle: 'AI Support deployed successfully',
  embedLabel: 'Website Embed Snippet',
  copySnippet: 'Copy snippet',
  copiedSnippet: 'Copied!',
  openLiveTest: 'Open Live Test',
  openIntegration: 'Open Integration Studio',
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
  panelTitle: 'Trợ lý Setup AI Support',
  panelSubtitle: 'Hướng dẫn 7 bước & tự động triển khai theo sự đồng ý của bạn',
  tenantLabel: 'Mục tiêu',
  newTenantOption: '+ Tạo Tenant AI Support mới',
  expandPanel: 'Mở rộng khung',
  compactPanel: 'Thu gọn chiều rộng',
  clearChat: 'Làm mới hội thoại',
  closePanel: 'Thu nhỏ',
  roadmapHeading: 'Lộ trình 7 bước hoàn chỉnh',
  roadmapProgress: '{done}/{total} bước đạt',
  roadmapToggleShow: 'Xem 7 bước',
  roadmapToggleHide: 'Ẩn 7 bước',
  stepOpen: 'Mở trang',
  stepComplete: 'Hoàn tất',
  stepPartial: 'Cơ bản',
  stepMissing: 'Chưa bật',
  stepRestricted: 'Giới hạn quyền',
  readOnlyBadge: 'Chế độ Chỉ xem',
  briefToggle: 'Phiếu thông tin nhanh',
  briefHeading: 'Điền nhanh thông tin để AI thiết kế kế hoạch setup cho bạn',
  briefBrandLabel: 'Tên thương hiệu / Dịch vụ',
  briefBrandPlaceholder: 'VD: Mỹ phẩm GlowSkin',
  briefIndustryLabel: 'Lĩnh vực',
  briefIndustryPlaceholder: 'VD: Mỹ phẩm & Bán lẻ',
  briefWebsiteLabel: 'Website (mở CORS)',
  briefWebsitePlaceholder: 'VD: https://glowskin.vn',
  briefToneLabel: 'Giọng điệu AI',
  briefLanguageLabel: 'Ngôn ngữ trả lời',
  briefColorLabel: 'Màu thương hiệu',
  briefPoliciesLabel: 'Chính sách & FAQ cốt lõi',
  briefPoliciesPlaceholder: 'VD: Đổi trả trong 7 ngày, freeship đơn 300k, hỗ trợ 8h–22h',
  briefIntakeLabel: 'Yêu cầu khách nhập Tên & Email trước khi chat',
  briefSubmit: 'Tạo kế hoạch Setup',
  welcomeTitle: 'Bạn thấy phần AI Support hơi phức tạp?',
  welcomeDescription:
    'Tôi đã được huấn luyện toàn bộ 7 Studio thiết lập AI Support. Hãy hỏi tôi cách dùng từng bước, hoặc để tôi hỏi bạn vài thông tin hợp lý rồi tự cấu hình & triển khai trọn bộ khi bạn bấm đồng ý.',
  starterAutoSetup: 'Setup trọn gói thay cho tôi',
  starterAutoSetupPrompt: 'Hãy thiết lập tự động trọn gói một con AI Support giúp tôi',
  starterCompleteCurrent: 'Hoàn thiện tenant hiện tại giúp tôi',
  starterCompleteCurrentPrompt: 'Hoàn thiện cấu hình tiêu chuẩn cho tenant hiện tại',
  starterGuide: 'Hướng dẫn chi tiết 7 bước setup',
  starterGuidePrompt: 'Hướng dẫn tôi chi tiết từng bước để có 1 con AI Support hoàn chỉnh',
  inputPlaceholder: 'Hỏi cách setup từng bước, hoặc mô tả shop/dịch vụ để AI tự cấu hình…',
  send: 'Gửi',
  thinking: 'Đang phân tích & thiết kế cấu hình…',
  consentBanner: 'Chờ khách hàng xác nhận — chưa thay đổi dữ liệu hệ thống',
  consentTargetCreate: 'Tạo tenant mới: {name} ({slug})',
  consentTargetUpdate: 'Cập nhật tenant: {name} ({slug})',
  consentNoPermission: 'Chỉ xem (tài khoản chưa có quyền sửa bước này)',
  approveAndDeploy: 'Đồng ý & Tự động triển khai',
  deploying: 'Đang triển khai…',
  requestRevision: 'Chỉnh sửa thêm',
  revisionHint: 'Tôi muốn điều chỉnh: ',
  declinePlan: 'Từ chối',
  declinedBadge: 'Đã từ chối',
  appliedBadge: 'Đã triển khai',
  expiredBadge: 'Đã hết hạn',
  deploySuccessTitle: 'Triển khai AI Support hoàn tất',
  embedLabel: 'Mã nhúng Widget lên Website',
  copySnippet: 'Sao chép mã',
  copiedSnippet: 'Đã chép!',
  openLiveTest: 'Mở Live Test ngay',
  openIntegration: 'Mở Integration Studio',
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
