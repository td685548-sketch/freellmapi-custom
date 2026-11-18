import { useI18n } from '@/i18n';
import type { SupportSetupStepId } from '../../../../shared/support-setup-copilot';

export interface SupportSetupCopilotStrings {
  launcherTitle: string;
  launcherNew: string;
  launcherPending: string;
  assistantName: string;
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
  welcomeBadge: string;
  welcomeTitle: string;
  welcomeDescription: string;
  starterAutoSetup: string;
  starterAutoSetupDesc: string;
  starterAutoSetupPrompt: string;
  starterCompleteCurrent: string;
  starterCompleteCurrentDesc: string;
  starterCompleteCurrentPrompt: string;
  starterGuide: string;
  starterGuideDesc: string;
  starterGuidePrompt: string;
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
  panelSubtitle: 'Guided coach & consent-gated deployer',
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
  welcomeBadge: '7-Studio Specialist',
  welcomeTitle: 'Set up a production-ready AI Support bot in minutes',
  welcomeDescription:
    'Ask how any step works, or describe your business naturally — I will prepare a complete configuration plan and deploy only after your approval.',
  starterAutoSetup: 'Set up everything for me',
  starterAutoSetupDesc: 'Answer 2–3 quick questions and review a full plan',
  starterAutoSetupPrompt: 'Set up a complete AI Support assistant for me',
  starterCompleteCurrent: 'Complete missing steps on this tenant',
  starterCompleteCurrentDesc: 'Fill standard defaults for unconfigured studios',
  starterCompleteCurrentPrompt: 'Auto-complete current tenant with standard defaults',
  starterGuide: 'Explain the 7 setup steps',
  starterGuideDesc: 'Walk through RAG, guardrails, widget, SLA & CORS',
  starterGuidePrompt: 'How do I set up a complete AI Support assistant step by step?',
  inputPlaceholder: 'Ask a question or describe your business…',
  composerHint: 'Enter to send · Shift+Enter for new line',
  send: 'Send',
  thinking: 'Analyzing & crafting response…',
  consentBanner: 'Consent required — no changes applied yet',
  selectedStepsCount: '{selected}/{total} selected',
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
  openIntegration: 'Integration Studio',
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
  panelSubtitle: 'Hướng dẫn thông minh & tự triển khai khi bạn đồng ý',
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
  welcomeBadge: 'Trợ lý chuyên trách 7 Studio',
  welcomeTitle: 'Thiết lập AI Support hoàn chỉnh chỉ trong vài phút',
  welcomeDescription:
    'Hỏi mình bất kỳ bước nào bạn thấy khó hiểu, hoặc mô tả ngắn về doanh nghiệp để mình lên phương án trọn gói và tự triển khai khi bạn bấm duyệt.',
  starterAutoSetup: 'Setup trọn gói thay cho tôi',
  starterAutoSetupDesc: 'Hỏi nhanh vài ý cơ bản rồi lên bản kế hoạch 7 bước',
  starterAutoSetupPrompt: 'Hãy thiết lập tự động trọn gói một con AI Support giúp tôi',
  starterCompleteCurrent: 'Hoàn thiện nhanh tenant hiện tại',
  starterCompleteCurrentDesc: 'Tự điền cấu hình tiêu chuẩn cho các bước còn thiếu',
  starterCompleteCurrentPrompt: 'Hoàn thiện cấu hình tiêu chuẩn cho tenant hiện tại',
  starterGuide: 'Hướng dẫn chi tiết 7 bước setup',
  starterGuideDesc: 'Giải thích rõ RAG, tường lửa, Widget, SLA & nhúng web',
  starterGuidePrompt: 'Hướng dẫn tôi chi tiết từng bước để có 1 con AI Support hoàn chỉnh',
  inputPlaceholder: 'Nhập câu hỏi hoặc mô tả shop để AI tự setup…',
  composerHint: 'Enter để gửi · Shift+Enter xuống dòng',
  send: 'Gửi',
  thinking: 'Đang suy nghĩ & chuẩn bị phản hồi…',
  consentBanner: 'Chờ xác nhận — chưa thay đổi dữ liệu hệ thống',
  selectedStepsCount: 'Đã chọn {selected}/{total} bước',
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
  openIntegration: 'Integration Studio',
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
