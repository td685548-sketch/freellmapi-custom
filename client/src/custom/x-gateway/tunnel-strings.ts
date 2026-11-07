import { useI18n } from '@/i18n';

export interface TunnelStrings {
  tunnelNav: string;
  tunnelTitle: string;
  tunnelHelp: string;
  stateActive: string;
  stateStarting: string;
  stateStopped: string;
  stateError: string;
  startTunnel: string;
  stopTunnel: string;
  starting: string;
  stopping: string;
  publicUrl: string;
  copyUrl: string;
  copied: string;
  openInBrowser: string;
  localPort: string;
  uptime: string;
  reconnects: string;
  binaryStatus: string;
  binaryInstalled: string;
  binaryMissing: string;
  installInstructions: string;
  installWindows: string;
  installMac: string;
  installLinux: string;
  howToUseRemote: string;
  remoteAgentTitle: string;
  remoteAgentHelp: string;
  claudeCodeSnippet: string;
  cursorSnippet: string;
  codexSnippet: string;
  pythonSnippet: string;
  logsTitle: string;
  refreshLogs: string;
  noLogsYet: string;
  autoRefreshNote: string;
  permissionRequired: string;
}

const STRINGS: Record<'en' | 'vi', TunnelStrings> = {
  en: {
    tunnelNav: 'Quick Tunnel',
    tunnelTitle: 'Cloudflare Quick Tunnel',
    tunnelHelp:
      'Expose your local FreeLLMAPI X Gateway to remote AI agents and coding tools via an encrypted HTTPS URL on trycloudflare.com with zero port forwarding.',
    stateActive: 'Active & Connected',
    stateStarting: 'Establishing Tunnel...',
    stateStopped: 'Tunnel Stopped',
    stateError: 'Tunnel Error',
    startTunnel: 'Start Quick Tunnel',
    stopTunnel: 'Stop Tunnel',
    starting: 'Starting...',
    stopping: 'Stopping...',
    publicUrl: 'Public HTTPS Endpoint',
    copyUrl: 'Copy URL',
    copied: 'Copied!',
    openInBrowser: 'Open Health Check',
    localPort: 'Local Port',
    uptime: 'Uptime',
    reconnects: 'Reconnections',
    binaryStatus: 'cloudflared Binary',
    binaryInstalled: 'Installed & Ready',
    binaryMissing: 'Binary Not Found',
    installInstructions: 'How to install cloudflared:',
    installWindows: 'winget install --id Cloudflare.cloudflared',
    installMac: 'brew install cloudflared',
    installLinux: 'sudo apt-get install cloudflared',
    howToUseRemote: 'Remote Agent Setup',
    remoteAgentTitle: 'Connect External Tools & Remote Agents',
    remoteAgentHelp: 'Use this public HTTPS URL as the Base URL on remote dev environments, GitHub Actions, or laptops:',
    claudeCodeSnippet: 'Claude Code CLI',
    cursorSnippet: 'Cursor / VS Code',
    codexSnippet: 'OpenAI Codex CLI',
    pythonSnippet: 'Python SDK / OpenAI Client',
    logsTitle: 'Live Process Logs',
    refreshLogs: 'Refresh Logs',
    noLogsYet: 'No logs recorded yet. Start the tunnel to view live logs.',
    autoRefreshNote: 'Auto-refreshes every 3 seconds while active.',
    permissionRequired: 'You need permission to start or stop tunnels.',
  },
  vi: {
    tunnelNav: 'Quick Tunnel',
    tunnelTitle: 'Cloudflare Quick Tunnel',
    tunnelHelp:
      'Public hóa X Gateway local của bạn ra internet qua đường truyền HTTPS mã hóa của trycloudflare.com cho các AI agent và công cụ lập trình từ xa mà không cần mở port modem hay cấu hình DDNS.',
    stateActive: 'Đang hoạt động',
    stateStarting: 'Đang kết nối đường hầm...',
    stateStopped: 'Đường hầm đã dừng',
    stateError: 'Lỗi đường hầm',
    startTunnel: 'Khởi chạy Quick Tunnel',
    stopTunnel: 'Dừng đường hầm',
    starting: 'Đang khởi chạy...',
    stopping: 'Đang dừng...',
    publicUrl: 'Endpoint HTTPS Công khai',
    copyUrl: 'Sao chép URL',
    copied: 'Đã sao chép!',
    openInBrowser: 'Mở trang kiểm tra',
    localPort: 'Cổng local',
    uptime: 'Thời gian chạy',
    reconnects: 'Số lần kết nối lại',
    binaryStatus: 'Bộ thực thi cloudflared',
    binaryInstalled: 'Đã cài đặt sẵn sàng',
    binaryMissing: 'Chưa cài đặt binary',
    installInstructions: 'Hướng dẫn cài đặt cloudflared:',
    installWindows: 'winget install --id Cloudflare.cloudflared',
    installMac: 'brew install cloudflared',
    installLinux: 'sudo apt-get install cloudflared',
    howToUseRemote: 'Cấu hình Agent từ xa',
    remoteAgentTitle: 'Kết nối công cụ và Agent từ bên ngoài',
    remoteAgentHelp: 'Sử dụng URL HTTPS công khai này làm Base URL trên môi trường dev từ xa, VPS hoặc máy tính khác:',
    claudeCodeSnippet: 'Claude Code CLI',
    cursorSnippet: 'Cursor / VS Code',
    codexSnippet: 'OpenAI Codex CLI',
    pythonSnippet: 'Python SDK / OpenAI Client',
    logsTitle: 'Nhật ký tiến trình trực tiếp',
    refreshLogs: 'Làm mới nhật ký',
    noLogsYet: 'Chưa có nhật ký nào. Hãy bấm khởi chạy để xem log trực tiếp.',
    autoRefreshNote: 'Tự động làm mới mỗi 3 giây khi đường hầm đang chạy.',
    permissionRequired: 'Bạn cần quyền quản trị để khởi chạy hoặc dừng đường hầm.',
  },
};

export function useTunnelStrings(): TunnelStrings {
  const { locale } = useI18n();
  return STRINGS[locale === 'vi' ? 'vi' : 'en'];
}
