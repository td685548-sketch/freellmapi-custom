import { useI18n } from '@/i18n';

export interface CliToolsStrings {
  title: string;
  subtitle: string;
  selectKey: string;
  noKeySelected: string;
  createKeyPrompt: string;
  createKeyBtn: string;
  creatingKey: string;
  serverUrl: string;
  localUrl: string;
  originUrl: string;
  customUrl: string;
  categoryAll: string;
  categoryCli: string;
  categoryIde: string;
  categoryAgent: string;
  searchPlaceholder: string;
  configure: string;
  testConnection: string;
  testingConnection: string;
  testOk: string;
  testFailed: string;
  tabBash: string;
  tabPowerShell: string;
  tabCmd: string;
  tabConfig: string;
  tabEnv: string;
  copyCommand: string;
  copied: string;
  downloadConfig: string;
  downloaded: string;
  modelAliases: string;
  aliasCol: string;
  targetCol: string;
  setupInstructions: string;
  viewDocs: string;
  quickExportTip: string;
  activeStatus: string;
  noToolsFound: string;
  endpointPrefixTip: string;
  cliToolsNav: string;
}

const STRINGS: Record<'en' | 'vi', CliToolsStrings> = {
  en: {
    title: 'CLI Tools & IDE Setup',
    subtitle: 'One-click configuration for AI coding tools: Claude Code, OpenAI Codex, Cursor, GitHub Copilot, Cline, and more.',
    selectKey: 'Active Thruline Key',
    noKeySelected: 'No key selected (commands will use placeholder)',
    createKeyPrompt: 'Need an API key to get started?',
    createKeyBtn: 'Create X Key',
    creatingKey: 'Generating key...',
    serverUrl: 'Server Gateway URL',
    localUrl: 'Localhost (Default)',
    originUrl: 'Current Domain / VPS',
    customUrl: 'Custom Endpoint',
    categoryAll: 'All Tools',
    categoryCli: 'CLI Agents',
    categoryIde: 'IDEs & Extensions',
    categoryAgent: 'Bots & Daemons',
    searchPlaceholder: 'Search tools by name, protocol, or command...',
    configure: 'Setup Guide',
    testConnection: 'Test Connection',
    testingConnection: 'Testing...',
    testOk: 'Connection verified ({latency}ms)',
    testFailed: 'Connection failed: {error}',
    tabBash: 'Bash / Zsh (Mac & Linux)',
    tabPowerShell: 'PowerShell (Windows)',
    tabCmd: 'Command Prompt (Windows)',
    tabConfig: 'Config File',
    tabEnv: '.env File',
    copyCommand: 'Copy Command',
    copied: 'Copied to Clipboard!',
    downloadConfig: 'Download Config File',
    downloaded: 'Downloaded',
    modelAliases: 'Recommended Model Aliases',
    aliasCol: 'Tool Alias / Flag',
    targetCol: 'Thruline Model ID',
    setupInstructions: 'Step-by-Step Instructions',
    viewDocs: 'Official Documentation',
    quickExportTip: 'Run this command once in your terminal session before launching the CLI tool.',
    activeStatus: 'Ready',
    noToolsFound: 'No tools match your search criteria.',
    endpointPrefixTip: 'All tools connect to the Thruline OpenAI-compatible / Anthropic-compatible wire protocol on /thruline/v1.',
    cliToolsNav: 'CLI Tools',
  },
  vi: {
    title: 'Cấu hình CLI Tools & IDE',
    subtitle: 'Cấu hình 1-chạm kết nối các công cụ AI Coding: Claude Code, OpenAI Codex, Cursor, GitHub Copilot, Cline...',
    selectKey: 'Khóa API Thruline',
    noKeySelected: 'Chưa chọn key (lệnh sẽ dùng key giữ chỗ)',
    createKeyPrompt: 'Bạn chưa có key API?',
    createKeyBtn: 'Tạo X Key mới',
    creatingKey: 'Đang tạo key...',
    serverUrl: 'Địa chỉ Gateway URL',
    localUrl: 'Localhost (Mặc định)',
    originUrl: 'Tên miền hiện tại / VPS',
    customUrl: 'Tùy chỉnh Endpoint',
    categoryAll: 'Tất cả',
    categoryCli: 'Công cụ dòng lệnh CLI',
    categoryIde: 'IDE & Tiện ích mở rộng',
    categoryAgent: 'Bot & Agent tự động',
    searchPlaceholder: 'Tìm kiếm theo tên công cụ, giao thức...',
    configure: 'Hướng dẫn cài đặt',
    testConnection: 'Kiểm tra kết nối',
    testingConnection: 'Đang kiểm tra...',
    testOk: 'Kết nối thành công ({latency}ms)',
    testFailed: 'Kết nối thất bại: {error}',
    tabBash: 'Bash / Zsh (Mac & Linux)',
    tabPowerShell: 'PowerShell (Windows)',
    tabCmd: 'Command Prompt (Windows)',
    tabConfig: 'File Cấu Hình',
    tabEnv: 'File .env',
    copyCommand: 'Sao chép lệnh',
    copied: 'Đã sao chép!',
    downloadConfig: 'Tải file cấu hình',
    downloaded: 'Đã tải xuống',
    modelAliases: 'Bí danh model khuyến nghị',
    aliasCol: 'Bí danh / Tham số',
    targetCol: 'Model đích trên Thruline',
    setupInstructions: 'Các bước cài đặt chi tiết',
    viewDocs: 'Tài liệu chính thức',
    quickExportTip: 'Chạy lệnh này một lần trong cửa sổ terminal của bạn trước khi khởi chạy công cụ CLI.',
    activeStatus: 'Sẵn sàng',
    noToolsFound: 'Không tìm thấy công cụ nào phù hợp.',
    endpointPrefixTip: 'Tất cả các công cụ đều kết nối qua giao thức chuẩn OpenAI / Anthropic tại đường dẫn /thruline/v1.',
    cliToolsNav: 'CLI Tools',
  },
};

export function useToolsStrings(): CliToolsStrings {
  const { locale } = useI18n();
  return STRINGS[locale === 'vi' ? 'vi' : 'en'];
}
