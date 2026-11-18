import { useI18n } from '@/i18n';
import type {
  IdePackagerToolId,
  ScenarioId,
  ScenarioRoutingMode,
} from '../../../../shared/scenario-routing';

export interface ScenarioRoutingStrings {
  routerTitle: string;
  routerSubtitle: string;
  enabledBadge: string;
  disabledBadge: string;
  enableToggleLabel: string;
  scopeLabel: string;
  accountDefaultOption: string;
  keyOverrideSuffix: string;
  removeKeyOverride: string;
  smartPresetBtn: string;
  savePolicyBtn: string;
  savingPolicyBtn: string;
  policySavedToast: string;
  policyDeletedToast: string;
  thresholdLabel: string;
  thresholdUnit: string;
  telemetryHits: string;
  telemetryOffloaded: string;
  telemetryTokensSaved: string;
  telemetryBannerDesc: string;
  targetTierLabel: string;
  targetModelLabel: string;
  autoBestInTier: string;
  overrideExplicitLabel: string;
  hitsShort: string;
  savedShort: string;
  previewToggleShow: string;
  previewToggleHide: string;
  previewPromptPlaceholder: string;
  previewRunBtn: string;
  previewDetectedLabel: string;
  previewTokensLabel: string;
  scenarioLabels: Record<ScenarioId, { title: string; desc: string }>;
  modeLabels: Record<ScenarioRoutingMode, string>;

  packagerTitle: string;
  packagerSubtitle: string;
  selectKeyLabel: string;
  noActiveKeysOption: string;
  unifiedGatewayOption: string;
  mintQuickKeyBtn: string;
  mintingQuickKeyBtn: string;
  pasteKeyPlaceholder: string;
  pasteKeyHint: string;
  rawKeyReadyBadge: string;
  endpointLabel: string;
  endpointOriginBtn: string;
  endpointLocalBtn: string;
  shellPowerShell: string;
  shellBash: string;
  copyCommand: string;
  downloadFile: string;
  configFilesLabel: string;
  setupStepsLabel: string;
  verifyBtn: string;
  verifyingBtn: string;
  verifiedGreenBadge: string;
  waitingPingBadge: string;
  notVerifiedBadge: string;
  verifyTerminalHint: string;
  recentCallsCount: string;
  toolLabels: Record<IdePackagerToolId, string>;
}

const en: ScenarioRoutingStrings = {
  routerTitle: 'Scenario-Based Auto-Routing',
  routerSubtitle:
    'Zero-latency (<1ms) intent & wire classifier that offloads background tasks to Eco and boosts deep architecture/thinking turns to Max.',
  enabledBadge: 'Active',
  disabledBadge: 'Off',
  enableToggleLabel: 'Enable Scenario Auto-Routing',
  scopeLabel: 'Policy Scope',
  accountDefaultOption: 'All my Personal API Keys (Account Default)',
  keyOverrideSuffix: '(custom override)',
  removeKeyOverride: 'Reset to account default',
  smartPresetBtn: 'Apply Recommended Preset',
  savePolicyBtn: 'Save Scenario Policy',
  savingPolicyBtn: 'Saving…',
  policySavedToast: 'Scenario routing policy saved',
  policyDeletedToast: 'Reverted key to account default policy',
  thresholdLabel: 'Long-Context Threshold',
  thresholdUnit: 'tokens',
  telemetryHits: 'Scenario Hits',
  telemetryOffloaded: 'Eco Offloads',
  telemetryTokensSaved: 'High-Tier Quota Saved',
  telemetryBannerDesc:
    'Estimated Frontier/Max tokens preserved by offloading background titles, git commits & compactions.',
  targetTierLabel: 'Tier',
  targetModelLabel: 'Model (optional)',
  autoBestInTier: 'Auto (best healthy in tier)',
  overrideExplicitLabel: 'Override pinned IDE model',
  hitsShort: 'hits',
  savedShort: 'saved',
  previewToggleShow: 'Test Scenario Classifier',
  previewToggleHide: 'Hide Classifier Tester',
  previewPromptPlaceholder:
    'e.g. Generate a concise 4-word title for this conversation… or Analyze this race condition step by step…',
  previewRunBtn: 'Classify',
  previewDetectedLabel: 'Detected Scenario:',
  previewTokensLabel: 'Est. tokens:',
  scenarioLabels: {
    background: {
      title: 'Background & Utility',
      desc: 'Chat titles, commit messages, context compaction & tiny probes',
    },
    think: {
      title: 'Deep Thinking & Architecture',
      desc: 'Explicit thinking/reasoning_effort or complex root-cause debugging',
    },
    longContext: {
      title: 'Long Context',
      desc: 'Large repository payloads exceeding token threshold',
    },
    vision: {
      title: 'Multimodal Vision',
      desc: 'Screenshots & inline image blocks in messages',
    },
    webSearch: {
      title: 'Web Search Tools',
      desc: 'Requests declaring web_search or search function tools',
    },
    default: {
      title: 'Standard Coding / Chat',
      desc: 'Everyday coding & interactive turns',
    },
  },
  modeLabels: {
    default: 'Keep Key Default',
    eco: 'Eco (Fast / Save Quota)',
    balanced: 'Balanced',
    max: 'Max Intelligence',
  },

  packagerTitle: '1-Click IDE Config Packager & Connection Verifier',
  packagerSubtitle:
    'Pick your Personal API Key to copy 1-line terminal installers or download ready-to-use configs for Claude Code, Cursor, Cline/Roo, Codex, OpenCode & Continue.',
  selectKeyLabel: 'API Key',
  noActiveKeysOption: 'No active Personal Key yet — mint one now',
  unifiedGatewayOption: 'Unified Gateway Key',
  mintQuickKeyBtn: '+ Mint IDE Key',
  mintingQuickKeyBtn: 'Minting…',
  pasteKeyPlaceholder: 'Optional: paste full sk-flm-… key to embed secret into files',
  pasteKeyHint:
    'Stored keys are hashed; mint a new key here or paste your saved sk-flm-… secret to pre-fill config files.',
  rawKeyReadyBadge: 'Full secret injected into snippets',
  endpointLabel: 'Gateway Endpoint',
  endpointOriginBtn: 'Current URL',
  endpointLocalBtn: 'Localhost',
  shellPowerShell: 'PowerShell (Windows)',
  shellBash: 'Bash (macOS / Linux / WSL)',
  copyCommand: 'Copy 1-Liner',
  downloadFile: 'Download',
  configFilesLabel: 'Generated Config Files',
  setupStepsLabel: 'Quick Steps',
  verifyBtn: 'Verify IDE Connection',
  verifyingBtn: 'Listening for ping…',
  verifiedGreenBadge: 'IDE Connected & Verified',
  waitingPingBadge: 'Listening for IDE ping (60s)…',
  notVerifiedBadge: 'Awaiting connection test',
  verifyTerminalHint:
    'Run the 1-liner above (it includes a live verify ping) or run this standalone check from your terminal:',
  recentCallsCount: '{count} call(s) in last 5m',
  toolLabels: {
    'claude-code': 'Claude Code',
    cursor: 'Cursor',
    'cline-roo': 'Cline / Roo Code',
    codex: 'Codex CLI',
    opencode: 'OpenCode',
    continue: 'Continue',
  },
};

const vi: ScenarioRoutingStrings = {
  routerTitle: 'Định tuyến Tự động theo Ngữ cảnh (Scenario Router)',
  routerSubtitle:
    'Phân loại luồng gọi (<1ms, không tốn thêm LLM) giúp đẩy tác vụ nền sang tầng Eco tiết kiệm quota và dồn model mạnh nhất (Max) cho bài toán kiến trúc/debug khó.',
  enabledBadge: 'Đang bật',
  disabledBadge: 'Đang tắt',
  enableToggleLabel: 'Bật Tự động Định tuyến theo Ngữ cảnh',
  scopeLabel: 'Phạm vi áp dụng',
  accountDefaultOption: 'Tất cả Personal API Key của tôi (Mặc định tài khoản)',
  keyOverrideSuffix: '(cấu hình riêng)',
  removeKeyOverride: 'Khôi phục theo mặc định tài khoản',
  smartPresetBtn: 'Áp dụng Cấu hình Khuyên dùng',
  savePolicyBtn: 'Lưu Chính sách Định tuyến',
  savingPolicyBtn: 'Đang lưu…',
  policySavedToast: 'Đã lưu chính sách định tuyến theo ngữ cảnh',
  policyDeletedToast: 'Đã đưa khóa về chính sách mặc định của tài khoản',
  thresholdLabel: 'Ngưỡng Ngữ cảnh Dài',
  thresholdUnit: 'tokens',
  telemetryHits: 'Lượt khớp Ngữ cảnh',
  telemetryOffloaded: 'Lượt chuyển sang Eco',
  telemetryTokensSaved: 'Quota Cao cấp Tiết kiệm',
  telemetryBannerDesc:
    'Ước tính số token tầng cao (Frontier/Max) đã tiết kiệm nhờ tự động hạ tầng các lệnh đặt tiêu đề, tạo commit & nén hội thoại.',
  targetTierLabel: 'Tầng định tuyến',
  targetModelLabel: 'Model cụ thể (tùy chọn)',
  autoBestInTier: 'Tự động (tốt nhất trong tầng)',
  overrideExplicitLabel: 'Ghi đè cả khi IDE ghim cứng tên model',
  hitsShort: 'lượt',
  savedShort: 'đã tiết kiệm',
  previewToggleShow: 'Thử nghiệm Bộ phân loại Ngữ cảnh',
  previewToggleHide: 'Ẩn khung thử nghiệm',
  previewPromptPlaceholder:
    'VD: Tạo tiêu đề ngắn 4 từ cho cuộc trò chuyện này… hoặc Thiết kế kiến trúc phân tán & phân tích race condition…',
  previewRunBtn: 'Phân loại thử',
  previewDetectedLabel: 'Ngữ cảnh nhận diện:',
  previewTokensLabel: 'Token ước tính:',
  scenarioLabels: {
    background: {
      title: 'Tác vụ Nền & Tiện ích nhẹ',
      desc: 'Đặt tiêu đề chat, viết git commit, tóm tắt/nén ngữ cảnh & probe ngắn',
    },
    think: {
      title: 'Suy luận Sâu & Kiến trúc (Think)',
      desc: 'Bật thinking/reasoning_effort hoặc debug nguyên nhân gốc phức tạp',
    },
    longContext: {
      title: 'Ngữ cảnh Dài (Long Context)',
      desc: 'Payload mã nguồn lớn vượt ngưỡng token cấu hình',
    },
    vision: {
      title: 'Thị giác Đa phương thức (Vision)',
      desc: 'Tin nhắn đính kèm ảnh chụp màn hình / khối image',
    },
    webSearch: {
      title: 'Công cụ Tìm kiếm Web',
      desc: 'Yêu cầu khai báo công cụ web_search hoặc hàm tra cứu web',
    },
    default: {
      title: 'Lập trình & Trò chuyện Chuẩn',
      desc: 'Các lượt hỏi đáp & viết code thường ngày',
    },
  },
  modeLabels: {
    default: 'Giữ mặc định của Key',
    eco: 'Eco (Nhanh / Tiết kiệm Quota)',
    balanced: 'Cân bằng (Balanced)',
    max: 'Trí tuệ Tối đa (Max)',
  },

  packagerTitle: 'Đóng gói Cấu hình IDE 1-Chạm & Kiểm tra Kết nối Sống',
  packagerSubtitle:
    'Chọn Personal API Key để chép lệnh cài đặt 1 dòng (PowerShell/Bash) hoặc tải file cấu hình chuẩn cho Claude Code, Cursor, Cline/Roo, Codex, OpenCode & Continue.',
  selectKeyLabel: 'Khóa API sử dụng',
  noActiveKeysOption: 'Chưa có Personal Key — bấm tạo mới ngay',
  unifiedGatewayOption: 'Khóa Unified Gateway',
  mintQuickKeyBtn: '+ Tạo nhanh Key IDE',
  mintingQuickKeyBtn: 'Đang tạo…',
  pasteKeyPlaceholder: 'Tùy chọn: dán chuỗi khóa sk-flm-… đầy đủ để điền thẳng vào file',
  pasteKeyHint:
    'Khóa cũ được băm bảo mật; hãy tạo khóa mới tại đây hoặc dán khóa sk-flm-… đã lưu để điền tự động vào file cấu hình.',
  rawKeyReadyBadge: 'Đã chèn khóa đầy đủ vào mã cài đặt',
  endpointLabel: 'Địa chỉ Gateway',
  endpointOriginBtn: 'URL hiện tại',
  endpointLocalBtn: 'Localhost',
  shellPowerShell: 'PowerShell (Windows)',
  shellBash: 'Bash (macOS / Linux / WSL)',
  copyCommand: 'Chép lệnh 1 dòng',
  downloadFile: 'Tải file',
  configFilesLabel: 'File Cấu hình Tạo sẵn',
  setupStepsLabel: 'Các bước nhanh',
  verifyBtn: 'Kiểm tra kết nối IDE',
  verifyingBtn: 'Đang chờ tín hiệu…',
  verifiedGreenBadge: 'Đã kết nối & Xác thực thành công',
  waitingPingBadge: 'Đang lắng nghe tín hiệu từ IDE (60s)…',
  notVerifiedBadge: 'Chưa kiểm tra kết nối',
  verifyTerminalHint:
    'Chạy lệnh cài đặt 1 dòng ở trên (đã tích hợp sẵn ping xác thực) hoặc chạy riêng lệnh kiểm tra này trong terminal:',
  recentCallsCount: '{count} lượt gọi trong 5 phút qua',
  toolLabels: {
    'claude-code': 'Claude Code',
    cursor: 'Cursor',
    'cline-roo': 'Cline / Roo Code',
    codex: 'Codex CLI',
    opencode: 'OpenCode',
    continue: 'Continue',
  },
};

export function useScenarioRoutingStrings(): ScenarioRoutingStrings {
  const { locale } = useI18n();
  return locale === 'vi' ? vi : en;
}
