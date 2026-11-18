import { useI18n } from '@/i18n';
import type { AgenticStrategyId } from '@freellmapi/shared/token-savers-agentic.js';

export interface AgenticPreviewPreset {
  id: 'stack_and_json' | 'verbose_bilingual' | 'long_code_file';
  role: 'tool' | 'user';
  text: string;
}

export const AGENTIC_PREVIEW_PRESETS: readonly AgenticPreviewPreset[] = [
  {
    id: 'stack_and_json',
    role: 'tool',
    text: [
      'TypeError: Cannot read properties of undefined (reading "tokens")',
      ...Array.from({ length: 24 }, (_, idx) => `    at processFrame_${idx} (D:\\repo\\server\\src\\pipeline.ts:${idx + 10}:15)`),
    ].join('\n'),
  },
  {
    id: 'verbose_bilingual',
    role: 'user',
    text: [
      'Could you please explain in order to refactor our authentication implementation in src/custom/x-gateway/router.ts?',
      'It is important to note that due to the fact that we keep `https://api.example.com/v1/chat` and `{{tenant_id}}` intact,',
      'vui lòng cho tôi hỏi nhằm mục đích tối ưu configuration trong tài liệu sau:',
      '```ts',
      'export function verifyToken(token: string): boolean {',
      '  return token.startsWith("sk-");',
      '}',
      '```',
      'Thank you so much in advance!',
    ].join('\n'),
  },
  {
    id: 'long_code_file',
    role: 'tool',
    text: [
      "import { getDb } from '../../db/index.js';",
      "import type { ChatMessage } from '@freellmapi/shared/types.js';",
      ...Array.from(
        { length: 60 },
        (_, i) => `export function helperStep${i}(msg: ChatMessage): string { return String(msg.role) + '_${i}'; }`,
      ),
    ].join('\n'),
  },
];

const en = {
  title: 'Agentic & Code-Safe Input Compactor (Zero-Sidecar)',
  subtitle:
    'Built-in <1ms local compaction for IDE coding agents: compacts bulky tool outputs (code, grep, ANSI logs, JSON, stack traces), deduplicates repeated tool schemas, freezes system prefixes for prompt caching, and trims natural prose while shielding code spans.',
  enabledLabel: 'Active',
  disabledLabel: 'Disabled',
  toolCompaction: 'Structural Tool-Result Compaction',
  dedupTools: 'Deduplicate identical tools[] schemas',
  prefixFreeze: 'Freeze recurring system prompts (Prompt Cache safe)',
  prefixFreezeThreshold: 'Freeze after hits',
  toolResultMaxChars: 'Max tool output (chars)',
  jsonMinChars: 'Min JSON size (chars)',
  proseMode: 'Code-Safe Prose Compaction',
  proseModes: {
    off: 'Off',
    lite: 'Lite (Polite framing)',
    standard: 'Standard (Connectors + EN/VI)',
    aggressive: 'Aggressive (Technical contractions)',
  },
  saveConfig: 'Save Compactor Config',
  saving: 'Saving…',
  savedOk: 'Agentic compactor configuration saved.',
  resetStats: 'Reset Stats',
  statProcessed: 'Requests Scanned',
  statCompressed: 'Requests Compacted',
  statTokensSaved: 'Tokens Saved (Est.)',
  statFrozen: 'Frozen Prefixes Protected',
  statRollbacks: 'Fidelity Rollbacks',
  strategiesHeading: 'Strategy Hits',
  strategyLabels: {
    source_code: 'Source Code',
    grep_search: 'Grep Results',
    terminal_ansi: 'Terminal / ANSI',
    json_payload: 'JSON Payload',
    stack_trace: 'Stack Trace',
    evidence_digest: 'SHA-256 Cap',
    prose_caveman: 'Code-Safe Prose',
    tools_dedup: 'Tools Dedup',
  } as Record<AgenticStrategyId, string>,
  sandboxToggleShow: 'Open Live Compression Sandbox',
  sandboxToggleHide: 'Hide Live Compression Sandbox',
  sandboxHelp: 'Dry-run test without affecting production telemetry. Load a preset or paste any prompt/tool output.',
  presetLabels: {
    stack_and_json: 'Sample: Stack Trace',
    verbose_bilingual: 'Sample: Bilingual Prose + Code',
    long_code_file: 'Sample: Long Code File',
  },
  roleTool: 'Role: tool output',
  roleUser: 'Role: user prompt',
  inputPlaceholder: 'Paste a long tool_result, stack trace, JSON array, or verbose prompt with code blocks…',
  runPreview: 'Run Compression Preview',
  runningPreview: 'Compacting…',
  beforeAfter: 'Estimated Tokens',
  savedRate: 'Saved',
  protectedSpans: 'Protected Code/URL Spans',
  prefixProtected: 'System Prefix Frozen',
  rolledBackFlag: 'Fidelity Rollback Triggered',
  yes: 'Yes',
  no: 'No',
  compressedOutputLabel: 'Compacted Output Preview',
};

const vi: typeof en = {
  title: 'Agentic & Code-Safe Input Compactor (Không cần Sidecar)',
  subtitle:
    'Bộ nén cục bộ <1ms tích hợp sẵn cho coding agents: nén thông minh tool output dài (source code, grep, log ANSI, JSON, stack trace), khử trùng lặp tools[], đóng băng system prompt để bảo toàn Prompt Cache và rút gọn văn bản giữ nguyên vẹn code/URL.',
  enabledLabel: 'Đang bật',
  disabledLabel: 'Đang tắt',
  toolCompaction: 'Nén cấu trúc Tool Result',
  dedupTools: 'Khử trùng lặp tools[] schema giống hệt nhau',
  prefixFreeze: 'Đóng băng System Prompt lặp lại (Bảo toàn Prompt Cache)',
  prefixFreezeThreshold: 'Ngưỡng đóng băng (lượt)',
  toolResultMaxChars: 'Giới hạn tool output (ký tự)',
  jsonMinChars: 'Ngưỡng nén JSON (ký tự)',
  proseMode: 'Nén câu chữ an toàn cho Code',
  proseModes: {
    off: 'Tắt',
    lite: 'Nhẹ (Bỏ câu chào/xã giao)',
    standard: 'Chuẩn (Rút gọn liên từ EN/VI)',
    aggressive: 'Mạnh (Viết tắt thuật ngữ)',
  },
  saveConfig: 'Lưu cấu hình Compactor',
  saving: 'Đang lưu…',
  savedOk: 'Đã lưu cấu hình Agentic Compactor.',
  resetStats: 'Đặt lại thống kê',
  statProcessed: 'Request đã quét',
  statCompressed: 'Request đã nén',
  statTokensSaved: 'Token tiết kiệm (Ước tính)',
  statFrozen: 'Prefix đã bảo vệ',
  statRollbacks: 'Fidelity Rollback',
  strategiesHeading: 'Số lần kích hoạt theo chiến lược',
  strategyLabels: {
    source_code: 'Source Code',
    grep_search: 'Kết quả Grep',
    terminal_ansi: 'Log Terminal / ANSI',
    json_payload: 'JSON Payload',
    stack_trace: 'Stack Trace',
    evidence_digest: 'Cắt ngưỡng SHA-256',
    prose_caveman: 'Câu chữ giữ Code',
    tools_dedup: 'Khử lặp Tools',
  },
  sandboxToggleShow: 'Mở Sandbox Thử Nén Trực Tiếp',
  sandboxToggleHide: 'Thu gọn Sandbox Thử Nén',
  sandboxHelp: 'Chạy thử nghiệm khô (dry-run), không làm thay đổi số liệu thống kê thực tế.',
  presetLabels: {
    stack_and_json: 'Mẫu: Stack Trace',
    verbose_bilingual: 'Mẫu: Văn bản song ngữ + Code',
    long_code_file: 'Mẫu: File Code dài',
  },
  roleTool: 'Vai trò: tool output',
  roleUser: 'Vai trò: user prompt',
  inputPlaceholder: 'Dán tool_result dài, stack trace, JSON lớn hoặc prompt kèm khối code…',
  runPreview: 'Chạy thử nén (Preview)',
  runningPreview: 'Đang nén…',
  beforeAfter: 'Token ước tính',
  savedRate: 'Tiết kiệm',
  protectedSpans: 'Vùng Code/URL được bảo vệ',
  prefixProtected: 'Đóng băng System Prefix',
  rolledBackFlag: 'Fidelity Gate Rollback',
  yes: 'Có',
  no: 'Không',
  compressedOutputLabel: 'Kết quả sau khi nén',
};

export function useAgenticCompactorStrings() {
  const { locale } = useI18n();
  return locale === 'vi' ? vi : en;
}
