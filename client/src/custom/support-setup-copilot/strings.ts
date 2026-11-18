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
  panelSubtitle: 'Your friendly onboarding specialist — nothing changes without your approval',
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
  starterAutoSetup: 'Draft a tailored setup for me',
  starterAutoSetupDesc: 'Tell me a bit about your business and preview a complete draft',
  starterAutoSetupPrompt: 'Set up a complete AI Support assistant for me',
  starterCompleteCurrent: 'Finish setting up this tenant',
  starterCompleteCurrentDesc: 'Stage smart defaults for unconfigured areas so you can review',
  starterCompleteCurrentPrompt: 'Auto-complete current tenant with standard defaults',
  starterGuide: 'Walk me through the 7 steps',
  starterGuideDesc: 'Plain-English overview of FAQs, privacy masking, widget & website embed',
  starterGuidePrompt: 'How do I set up a complete AI Support assistant step by step?',
  inputPlaceholder: 'Tell me about your site (e.g. boardgame shop, cafe, SaaS…) or ask anything…',
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
  starterAutoSetup: 'Nhờ mình lên bản mẫu trọn gói',
  starterAutoSetupDesc: 'Trò chuyện vài câu tự nhiên, mình soạn sẵn từ A–Z để bạn xem trước',
  starterAutoSetupPrompt: 'Mình muốn nhờ bạn tư vấn và thiết lập giúp một trợ lý AI Support',
  starterCompleteCurrent: 'Hoàn thiện giúp tenant đang mở',
  starterCompleteCurrentDesc: 'Điền sẵn cấu hình chuẩn cho các mục còn thiếu để bạn duyệt',
  starterCompleteCurrentPrompt: 'Hoàn thiện cấu hình tiêu chuẩn cho tenant hiện tại',
  starterGuide: 'Hướng dẫn dễ hiểu 7 bước setup',
  starterGuideDesc: 'Giải thích gọn gàng cách nạp FAQ, che SĐT khách & gắn chat lên web',
  starterGuidePrompt: 'Hướng dẫn tôi chi tiết từng bước để có 1 con AI Support hoàn chỉnh',
  inputPlaceholder: 'Kể nhẹ về web/shop của bạn (VD: web boardgame, quán cafe…) hoặc hỏi mình nhé…',
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
