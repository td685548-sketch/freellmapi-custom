import { useI18n } from '@/i18n';

export interface SkillsStrings {
  skillsTitle: string;
  skillsSubtitle: string;
  skillsNav: string;
  heroPromptLabel: string;
  heroHelp: string;
  copyPrompt: string;
  copied: string;
  copyLink: string;
  previewSkill: string;
  closePreview: string;
  openGitHub: string;
  categoryAll: string;
  categoryEntry: string;
  categoryChat: string;
  categoryMedia: string;
  categoryAudio: string;
  categoryData: string;
  categorySearch: string;
  categoryTools: string;
  categoryCustom: string;
  searchPlaceholder: string;
  badgeStartHere: string;
  badgeCustom: string;
  tokenEstimate: string;
  createCustomSkill: string;
  editSkill: string;
  deleteSkill: string;
  confirmDelete: string;
  newSkillTitle: string;
  editSkillTitle: string;
  fieldId: string;
  fieldIdHelp: string;
  fieldName: string;
  fieldCategory: string;
  fieldDescription: string;
  fieldEndpoint: string;
  fieldContent: string;
  save: string;
  saving: string;
  cancel: string;
  tunnelActiveBadge: string;
  localUrlBadge: string;
  switchToTunnel: string;
  switchToLocal: string;
  emptySearch: string;
  emptySearchDesc: string;
  emptyCustom: string;
  testInConsole: string;
  loading: string;
  errorLoading: string;
  retry: string;
}

const STRINGS: Record<'en' | 'vi', SkillsStrings> = {
  en: {
    skillsTitle: 'Agent Skills & Instructions Hub',
    skillsSubtitle: 'Standard SKILL.md specs for Claude Code, Cursor, Codex, OpenCode, Cline, and Antigravity agents.',
    skillsNav: 'Agent Skills',
    heroPromptLabel: 'Paste this instruction directly into your AI agent prompt:',
    heroHelp: 'The agent will automatically fetch the specification and know how to call all unified gateway endpoints.',
    copyPrompt: 'Copy AI Prompt',
    copied: 'Copied!',
    copyLink: 'Copy Link',
    previewSkill: 'View SKILL.md',
    closePreview: 'Close',
    openGitHub: 'View Source',
    categoryAll: 'All Capabilities',
    categoryEntry: 'Entry & Setup',
    categoryChat: 'Chat & Code',
    categoryMedia: 'Image & Video',
    categoryAudio: 'Voice & Audio',
    categoryData: 'Vectors & Embeddings',
    categorySearch: 'Web & Search',
    categoryTools: 'Translator & Tools',
    categoryCustom: 'Custom Rules',
    searchPlaceholder: 'Search skills by name, keyword, or endpoint...',
    badgeStartHere: 'START HERE',
    badgeCustom: 'CUSTOM',
    tokenEstimate: 'Est. tokens',
    createCustomSkill: 'New Custom Skill',
    editSkill: 'Edit',
    deleteSkill: 'Delete',
    confirmDelete: 'Are you sure you want to delete this custom skill?',
    newSkillTitle: 'Create Custom Agent Skill',
    editSkillTitle: 'Edit Custom Skill',
    fieldId: 'Skill Identifier (ID)',
    fieldIdHelp: 'Alphanumeric and dashes only, e.g. team-coding-standards',
    fieldName: 'Display Name',
    fieldCategory: 'Category',
    fieldDescription: 'Summary Description',
    fieldEndpoint: 'Associated Endpoint (Optional)',
    fieldContent: 'SKILL.md Markdown Content',
    save: 'Save Skill',
    saving: 'Saving...',
    cancel: 'Cancel',
    tunnelActiveBadge: 'Cloudflare Tunnel Active',
    localUrlBadge: 'Local Endpoint',
    switchToTunnel: 'Use Public Tunnel URL',
    switchToLocal: 'Use Local URL',
    emptySearch: 'No skills found matching your search.',
    emptySearchDesc: 'Try adjusting your search query or switching categories.',
    emptyCustom: 'No custom skills configured yet. Click "+ New Custom Skill" to add rules for your agents.',
    testInConsole: 'Test in Console',
    loading: 'Loading skills...',
    errorLoading: 'Failed to load agent skills.',
    retry: 'Retry',
  },
  vi: {
    skillsTitle: 'Trung tâm Agent Skills & Hướng dẫn AI',
    skillsSubtitle: 'Định dạng SKILL.md chuẩn hóa cho Claude Code, Cursor, Codex, OpenCode, Cline và Antigravity.',
    skillsNav: 'Agent Skills',
    heroPromptLabel: 'Dán trực tiếp câu lệnh này vào prompt của AI agent:',
    heroHelp: 'Agent sẽ tự động nạp đặc tả SKILL.md và biết cách gọi mọi endpoint của Thruline.',
    copyPrompt: 'Sao chép lệnh AI',
    copied: 'Đã sao chép!',
    copyLink: 'Chép link',
    previewSkill: 'Xem SKILL.md',
    closePreview: 'Đóng',
    openGitHub: 'Xem nguồn',
    categoryAll: 'Tất cả tính năng',
    categoryEntry: 'Bắt đầu & Thiết lập',
    categoryChat: 'Chat & Viết mã',
    categoryMedia: 'Ảnh & Video',
    categoryAudio: 'Giọng nói & Audio',
    categoryData: 'Vector & Embeddings',
    categorySearch: 'Web & Tìm kiếm',
    categoryTools: 'Translator & Công cụ',
    categoryCustom: 'Quy tắc tùy chỉnh',
    searchPlaceholder: 'Tìm kiếm skill theo tên, từ khóa hoặc endpoint...',
    badgeStartHere: 'BẮT ĐẦU TẠI ĐÂY',
    badgeCustom: 'TÙY CHỈNH',
    tokenEstimate: 'Ước lượng token',
    createCustomSkill: 'Tạo Skill mới',
    editSkill: 'Sửa',
    deleteSkill: 'Xóa',
    confirmDelete: 'Bạn có chắc chắn muốn xóa skill tùy chỉnh này không?',
    newSkillTitle: 'Tạo Agent Skill tùy chỉnh',
    editSkillTitle: 'Chỉnh sửa Agent Skill',
    fieldId: 'Mã định danh (ID)',
    fieldIdHelp: 'Chỉ gồm chữ, số và dấu gạch ngang, ví dụ: quy-chuan-code-nhom',
    fieldName: 'Tên hiển thị',
    fieldCategory: 'Phân loại',
    fieldDescription: 'Mô tả ngắn gọn',
    fieldEndpoint: 'Endpoint liên kết (Không bắt buộc)',
    fieldContent: 'Nội dung Markdown SKILL.md',
    save: 'Lưu Skill',
    saving: 'Đang lưu...',
    cancel: 'Hủy',
    tunnelActiveBadge: 'Tunnel Cloudflare đang bật',
    localUrlBadge: 'Endpoint cục bộ',
    switchToTunnel: 'Dùng link Public Tunnel',
    switchToLocal: 'Dùng link Cục bộ',
    emptySearch: 'Không tìm thấy skill nào phù hợp.',
    emptySearchDesc: 'Hãy thử đổi từ khóa tìm kiếm hoặc chọn danh mục khác.',
    emptyCustom: 'Chưa có skill tùy chỉnh nào. Nhấn "+ Tạo Skill mới" để bổ sung quy tắc cho agent của bạn.',
    testInConsole: 'Thử nghiệm',
    loading: 'Đang tải danh sách skills...',
    errorLoading: 'Không thể tải danh sách skills.',
    retry: 'Thử lại',
  },
};

export function useSkillsStrings(): SkillsStrings {
  const { locale } = useI18n();
  return STRINGS[locale === 'vi' ? 'vi' : 'en'];
}

