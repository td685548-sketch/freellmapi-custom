import { useI18n } from '@/i18n';

export interface WorkspaceStrings {
  // Custom Assistants Hub section
  myAssistantsTitle: string;
  myAssistantsSubtitle: string;
  myAssistantsCount: string;
  createMyAssistant: string;
  editAssistant: string;
  deleteAssistant: string;
  confirmDeleteAssistant: string;
  noCustomAssistants: string;
  customBadge: string;
  knowledgeBadge: string;
  boundKeyLabel: string;
  openWorkspace: string;
  assistantCreatedToast: string;
  assistantUpdatedToast: string;
  assistantDeletedToast: string;

  // CustomAgentModal
  modalCreateTitle: string;
  modalEditTitle: string;
  modalSubtitle: string;
  fieldName: string;
  fieldNamePlaceholder: string;
  fieldSlug: string;
  fieldSlugPlaceholder: string;
  fieldCategory: string;
  fieldRoutingMode: string;
  fieldDescription: string;
  fieldDescriptionPlaceholder: string;
  fieldSystemPrompt: string;
  fieldSystemPromptPlaceholder: string;
  fieldKnowledge: string;
  fieldKnowledgeHint: string;
  fieldKnowledgePlaceholder: string;
  importMarkdownFile: string;
  knowledgeByteUsage: string;
  knowledgeTooLargeError: string;
  cancel: string;
  saveAssistant: string;
  creatingAssistant: string;

  // Wide Agent Workspace Drawer & Threads
  savedThreads: string;
  newThread: string;
  noSavedThreads: string;
  renameThread: string;
  deleteThread: string;
  forkThread: string;
  forkedBadge: string;
  threadForkedToast: string;
  threadDeletedToast: string;
  threadRenamedToast: string;
  streamingReply: string;
  stopGenerating: string;
  toggleThreadsSidebar: string;
  PersonalKnowledgeActive: string;

  // Live Artifacts Preview Panel
  previewArtifact: string;
  artifactsDetected: string;
  artifactPanelTitle: string;
  tabVisualPreview: string;
  tabRawSource: string;
  copyArtifact: string;
  copiedArtifact: string;
  downloadArtifact: string;
  closePreview: string;
  cspSafeBadge: string;
  jsonValidBadge: string;
  jsonInvalidBadge: string;
  mermaidFlowSummary: string;
  codeExportsSummary: string;
}

const en: WorkspaceStrings = {
  myAssistantsTitle: 'My Custom AI Assistants',
  myAssistantsSubtitle:
    'Build private AI agents with your own system persona and Markdown knowledge docs — chat in Workspace or bind directly to your Personal API Keys (sk-flm-…).',
  myAssistantsCount: '{count}/{max} agents',
  createMyAssistant: 'Create My Assistant',
  editAssistant: 'Edit',
  deleteAssistant: 'Delete',
  confirmDeleteAssistant: 'Delete custom assistant "{name}"? Bound personal keys will revert to standard routing.',
  noCustomAssistants:
    'You have not created any custom assistants yet. Click "Create My Assistant" to build a tailored coding, SQL, or writing agent.',
  customBadge: 'My Agent',
  knowledgeBadge: '{kb} KB docs',
  boundKeyLabel: 'Bound: {name}',
  openWorkspace: 'Open Workspace',
  assistantCreatedToast: 'Custom assistant created',
  assistantUpdatedToast: 'Custom assistant updated',
  assistantDeletedToast: 'Custom assistant deleted',

  modalCreateTitle: 'Create My Custom Assistant',
  modalEditTitle: 'Edit Custom Assistant',
  modalSubtitle:
    'Private to your account. When bound to a Personal API Key, external /v1 calls automatically inherit its persona, knowledge context, and routing tier.',
  fieldName: 'Assistant Name',
  fieldNamePlaceholder: 'e.g. Rust Microservice Architect, Team SQL Reviewer',
  fieldSlug: 'Custom Slug (optional)',
  fieldSlugPlaceholder: 'auto-generated-from-name',
  fieldCategory: 'Category',
  fieldRoutingMode: 'Recommended Routing Mode',
  fieldDescription: 'Short Description',
  fieldDescriptionPlaceholder: 'What does this assistant specialize in?',
  fieldSystemPrompt: 'System Persona & Instructions',
  fieldSystemPromptPlaceholder:
    'You are a principal TypeScript & SQLite architect. Enforce zero-conflict modular design, strict input validation, and concise code diffs…',
  fieldKnowledge: 'Personal Knowledge Context (Markdown, max 32 KB)',
  fieldKnowledgeHint:
    'Paste architecture conventions, API schemas, coding rules, or glossary notes. Automatically compacted and injected into chats & bound API keys.',
  fieldKnowledgePlaceholder: '## Project Conventions\n- Always use parameterized SQL queries\n- Prefer Vitest for integration tests…',
  importMarkdownFile: 'Import .md / .txt',
  knowledgeByteUsage: '{used} / {max} KB',
  knowledgeTooLargeError: 'Knowledge Markdown exceeds the 32 KB limit.',
  cancel: 'Cancel',
  saveAssistant: 'Save Assistant',
  creatingAssistant: 'Saving…',

  savedThreads: 'Saved Threads',
  newThread: 'New Thread',
  noSavedThreads: 'No saved threads yet. Send a message to start a persistent thread.',
  renameThread: 'Rename thread',
  deleteThread: 'Delete thread',
  forkThread: 'Fork Thread',
  forkedBadge: 'Fork #{index}',
  threadForkedToast: 'Branched conversation from turn #{index}',
  threadDeletedToast: 'Thread deleted',
  threadRenamedToast: 'Thread renamed',
  streamingReply: 'Streaming response…',
  stopGenerating: 'Stop',
  toggleThreadsSidebar: 'Threads',
  PersonalKnowledgeActive: 'Personal knowledge context active',

  previewArtifact: 'Preview Artifact',
  artifactsDetected: '{count} artifact(s)',
  artifactPanelTitle: 'Live Artifact Preview',
  tabVisualPreview: 'Preview',
  tabRawSource: 'Code',
  copyArtifact: 'Copy',
  copiedArtifact: 'Copied!',
  downloadArtifact: 'Download',
  closePreview: 'Close preview',
  cspSafeBadge: 'CSP Sanitized',
  jsonValidBadge: 'Valid JSON',
  jsonInvalidBadge: 'Invalid JSON syntax',
  mermaidFlowSummary: 'Rendered {nodes} node(s) · {edges} connection(s)',
  codeExportsSummary: 'Detected symbols: {symbols}',
};

const vi: WorkspaceStrings = {
  myAssistantsTitle: 'Trợ lý AI Cá nhân của tôi',
  myAssistantsSubtitle:
    'Tạo Agent riêng với System Prompt và tài liệu tri thức Markdown cá nhân — trò chuyện trực tiếp trong Workspace hoặc gắn vào Personal API Key (sk-flm-…).',
  myAssistantsCount: '{count}/{max} trợ lý',
  createMyAssistant: 'Tạo Trợ lý của tôi',
  editAssistant: 'Sửa',
  deleteAssistant: 'Xóa',
  confirmDeleteAssistant: 'Xóa trợ lý cá nhân "{name}"? Các khóa API đang gắn sẽ quay về định tuyến mặc định.',
  noCustomAssistants:
    'Bạn chưa tạo trợ lý AI cá nhân nào. Nhấn "Tạo Trợ lý của tôi" để thiết lập chuyên gia lập trình, SQL hoặc biên tập riêng.',
  customBadge: 'Agent Cá nhân',
  knowledgeBadge: '{kb} KB tri thức',
  boundKeyLabel: 'Đang gắn: {name}',
  openWorkspace: 'Mở Workspace',
  assistantCreatedToast: 'Đã tạo trợ lý AI cá nhân',
  assistantUpdatedToast: 'Đã cập nhật trợ lý AI cá nhân',
  assistantDeletedToast: 'Đã xóa trợ lý AI cá nhân',

  modalCreateTitle: 'Tạo Trợ lý AI Cá nhân',
  modalEditTitle: 'Chỉnh sửa Trợ lý AI Cá nhân',
  modalSubtitle:
    'Riêng tư cho tài khoản của bạn. Khi gắn vào Personal API Key, mọi lệnh gọi /v1 từ IDE sẽ tự động kế thừa nhân cách, tri thức và chế độ định tuyến.',
  fieldName: 'Tên Trợ lý',
  fieldNamePlaceholder: 'VD: Kiến trúc sư Rust, Chuyên gia tối ưu SQLite',
  fieldSlug: 'Định danh Slug (tùy chọn)',
  fieldSlugPlaceholder: 'tu-dong-tao-tu-ten',
  fieldCategory: 'Danh mục',
  fieldRoutingMode: 'Chế độ định tuyến khuyên dùng',
  fieldDescription: 'Mô tả ngắn',
  fieldDescriptionPlaceholder: 'Trợ lý này chuyên giải quyết tác vụ gì?',
  fieldSystemPrompt: 'System Prompt (Nhân cách & Quy tắc)',
  fieldSystemPromptPlaceholder:
    'Bạn là kỹ sư trưởng TypeScript & SQLite. Luôn ưu tiên thiết kế module tách biệt, kiểm tra đầu vào chặt chẽ và trả lời ngắn gọn kèm code mẫu…',
  fieldKnowledge: 'Tri thức Cá nhân (Markdown, tối đa 32 KB)',
  fieldKnowledgeHint:
    'Dán quy chuẩn kiến trúc, schema DB, quy tắc code hoặc thuật ngữ dự án. Hệ thống tự động nén gọn và đưa vào ngữ cảnh chat & API key.',
  fieldKnowledgePlaceholder: '## Quy chuẩn dự án\n- Luôn dùng truy vấn SQL tham số hóa\n- Viết kiểm thử tích hợp với Vitest…',
  importMarkdownFile: 'Nhập file .md / .txt',
  knowledgeByteUsage: '{used} / {max} KB',
  knowledgeTooLargeError: 'Nội dung tri thức Markdown vượt quá giới hạn 32 KB.',
  cancel: 'Hủy',
  saveAssistant: 'Lưu Trợ lý',
  creatingAssistant: 'Đang lưu…',

  savedThreads: 'Hội thoại đã lưu',
  newThread: 'Hội thoại mới',
  noSavedThreads: 'Chưa có hội thoại nào. Gửi tin nhắn đầu tiên để lưu luồng trao đổi.',
  renameThread: 'Đổi tên hội thoại',
  deleteThread: 'Xóa hội thoại',
  forkThread: 'Tách nhánh (Fork)',
  forkedBadge: 'Nhánh #{index}',
  threadForkedToast: 'Đã tách nhánh hội thoại từ lượt #{index}',
  threadDeletedToast: 'Đã xóa hội thoại',
  threadRenamedToast: 'Đã đổi tên hội thoại',
  streamingReply: 'Đang truyền phản hồi…',
  stopGenerating: 'Dừng',
  toggleThreadsSidebar: 'Luồng chat',
  PersonalKnowledgeActive: 'Đã nạp tri thức cá nhân',

  previewArtifact: 'Xem Artifact',
  artifactsDetected: '{count} artifact',
  artifactPanelTitle: 'Xem trước Artifact trực tiếp',
  tabVisualPreview: 'Xem trước',
  tabRawSource: 'Mã nguồn',
  copyArtifact: 'Sao chép',
  copiedArtifact: 'Đã chép!',
  downloadArtifact: 'Tải file',
  closePreview: 'Đóng khung xem',
  cspSafeBadge: 'Đã lọc an toàn CSP',
  jsonValidBadge: 'JSON hợp lệ',
  jsonInvalidBadge: 'Lỗi cú pháp JSON',
  mermaidFlowSummary: 'Đã dựng {nodes} nút · {edges} liên kết',
  codeExportsSummary: 'Thành phần phát hiện: {symbols}',
};

export function getWorkspaceStrings(locale: string): WorkspaceStrings {
  return locale === 'vi' ? vi : en;
}

export function useWorkspaceStrings(): WorkspaceStrings {
  const { locale } = useI18n();
  return getWorkspaceStrings(locale);
}

export function formatWorkspaceString(
  template: string,
  vars: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    vars[key] === undefined ? match : String(vars[key]),
  );
}
