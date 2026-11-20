import type { SupportSystemSettingId } from '@freellmapi/shared/support-setup-copilot.js';
import { REQUIRED_PERMISSION_BY_SETTING } from '../../system-settings.js';
import type { KbChunk } from '../types.js';

interface SettingDoc {
  titleEn: string;
  titleVi: string;
  en: string;
  vi: string;
  /** Verified in-app route, when the setting lives on a routed page. */
  path?: string;
  /** Where to find it in the UI (only what is verified in the client code). */
  whereEn: string;
  whereVi: string;
  tags: string[];
}

/**
 * One entry per system setting the Copilot can propose. Typed as a full
 * Record so adding a setting id without documenting it fails the build.
 */
const SETTING_DOCS: Readonly<Record<SupportSystemSettingId, SettingDoc>> = {
  thruline_gateway_enabled: {
    titleEn: 'Thruline gateway on/off',
    titleVi: 'Bật/tắt cổng Thruline',
    en: 'Master switch for the Thruline gateway (the multi-provider router with combos and token savers). When off, the Thruline inference surface returns 404. Payload: { enabled: boolean }.',
    vi: 'Công tắc tổng của cổng Thruline (router đa nhà cung cấp có combo và tiết kiệm token). Khi tắt, bề mặt inference của Thruline trả về 404. Tham số: { enabled: true|false }.',
    whereEn: 'Thruline console (/thruline/home).',
    whereVi: 'Bảng điều khiển Thruline (/thruline/home).',
    tags: ['thruline', 'gateway', 'cong', 'bat', 'tat', 'enable'],
  },
  thruline_token_savers: {
    titleEn: 'Thruline default token savers',
    titleVi: 'Tiết kiệm token mặc định của Thruline',
    en: 'Default token-saver levels applied to Thruline traffic: `caveman` (boolean, terse output style), `ponytail` (off | lite | full | ultra, output compaction level) and `input` (off | lossless | standard, input compression). Lower spend and latency; higher levels trade some verbosity for tokens. Payload: any subset of { caveman, ponytail, input }.',
    vi: 'Mức tiết kiệm token mặc định cho lưu lượng Thruline: `caveman` (true/false, kiểu trả lời ngắn gọn), `ponytail` (off | lite | full | ultra, mức nén đầu ra) và `input` (off | lossless | standard, nén đầu vào). Giảm chi phí và độ trễ; mức càng cao càng ngắn gọn. Tham số: bất kỳ tập con của { caveman, ponytail, input }.',
    path: '/thruline/savers',
    whereEn: 'Thruline → Token Savers (/thruline/savers).',
    whereVi: 'Thruline → Tiết kiệm token (/thruline/savers).',
    tags: ['token', 'savers', 'tiet kiem', 'caveman', 'ponytail', 'nen', 'compress'],
  },
  thruline_route_health_ttl: {
    titleEn: 'Thruline route-health TTL',
    titleVi: 'Thời gian nhớ trạng thái route (TTL) của Thruline',
    en: 'How many minutes Thruline remembers that a route (provider account/model) failed before trying it again. Default 5, maximum 1440 (24h), whole minutes only. A short TTL retries broken routes sooner; a long TTL avoids hammering a failing provider. Payload: { minutes: integer }.',
    vi: 'Số phút Thruline nhớ một route (tài khoản/model nhà cung cấp) bị lỗi trước khi thử lại. Mặc định 5, tối đa 1440 (24 giờ), chỉ số nguyên phút. TTL ngắn thì thử lại route lỗi sớm hơn; TTL dài tránh dồn request vào nhà cung cấp đang lỗi. Tham số: { minutes: số nguyên }.',
    path: '/thruline/combos',
    whereEn: 'Thruline → Combos, "Auto route health cooldown" (/thruline/combos).',
    whereVi: 'Thruline → Combos, mục "Auto route health cooldown" (/thruline/combos).',
    tags: ['ttl', 'route', 'health', 'cooldown', 'loi', 'thu lai', 'retry'],
  },
  response_cache: {
    titleEn: 'Response cache',
    titleVi: 'Bộ nhớ đệm phản hồi (Response Cache)',
    en: 'Caches identical model responses so repeated prompts are answered instantly without calling a provider (saves quota and latency). Enable/disable here; clearing the cache needs the separate clear_cache permission. Payload: { enabled: boolean }.',
    vi: 'Lưu đệm các phản hồi giống hệt nhau để prompt lặp lại được trả lời ngay mà không gọi nhà cung cấp (tiết kiệm hạn mức và độ trễ). Bật/tắt tại đây; xoá cache cần quyền clear_cache riêng. Tham số: { enabled: true|false }.',
    whereEn: 'Dashboard Settings dialog → General (cache section).',
    whereVi: 'Hộp thoại Cài đặt của dashboard → General (mục cache).',
    tags: ['cache', 'bo nho dem', 'dem', 'response', 'phan hoi'],
  },
  prompt_compression: {
    titleEn: 'Prompt compression',
    titleVi: 'Nén prompt',
    en: 'Compresses long prompts/context before sending upstream to reduce tokens. Modes: off, lossless (safe, removes redundancy only), standard, aggressive (largest saving, may drop detail). Payload: { enabled?: boolean, mode?: off|lossless|standard|aggressive }.',
    vi: 'Nén prompt/ngữ cảnh dài trước khi gửi lên nhà cung cấp để giảm token. Chế độ: off, lossless (an toàn, chỉ bỏ phần thừa), standard, aggressive (tiết kiệm nhất, có thể mất chi tiết). Tham số: { enabled?: true|false, mode?: off|lossless|standard|aggressive }.',
    whereEn: 'Dashboard Settings dialog → Compression.',
    whereVi: 'Hộp thoại Cài đặt của dashboard → Compression.',
    tags: ['compression', 'nen', 'prompt', 'context', 'ngu canh', 'token'],
  },
  model_unification: {
    titleEn: 'Model unification',
    titleVi: 'Hợp nhất model',
    en: 'Groups the same model offered by several providers under one unified name so a request can be served by any of them (more failover, simpler model names). Payload: { enabled: boolean }.',
    vi: 'Gom cùng một model do nhiều nhà cung cấp cung cấp về một tên chung để request có thể được phục vụ bởi bất kỳ nhà cung cấp nào (dự phòng tốt hơn, tên model gọn hơn). Tham số: { enabled: true|false }.',
    path: '/models/chat',
    whereEn: 'Models pages (a model\'s detail page lets you unify/override it).',
    whereVi: 'Các trang Models (trang chi tiết model cho phép hợp nhất/ghi đè).',
    tags: ['unify', 'unification', 'hop nhat', 'model', 'group', 'failover'],
  },
  mcp_server: {
    titleEn: 'Gateway MCP server',
    titleVi: 'Máy chủ MCP của gateway',
    en: 'Turns the gateway\'s built-in MCP (Model Context Protocol) server on or off so MCP-capable agents can use the gateway as a tool server. Payload: { enabled: boolean }.',
    vi: 'Bật/tắt máy chủ MCP (Model Context Protocol) tích hợp để các agent hỗ trợ MCP dùng gateway như một tool server. Tham số: { enabled: true|false }.',
    path: '/keys',
    whereEn: 'Keys page → agent compatibility section.',
    whereVi: 'Trang Keys → mục tương thích agent.',
    tags: ['mcp', 'agent', 'tool', 'server', 'may chu'],
  },
  auto_update_check: {
    titleEn: 'Automatic update check',
    titleVi: 'Tự động kiểm tra cập nhật',
    en: 'Whether the app periodically checks for a newer version. Installing updates needs the separate manage_updates permission. Payload: { enabled: boolean }.',
    vi: 'Có tự động kiểm tra phiên bản mới định kỳ hay không. Cài đặt bản cập nhật cần quyền manage_updates riêng. Tham số: { enabled: true|false }.',
    whereEn: 'Updates dialog (update reminder).',
    whereVi: 'Hộp thoại Cập nhật (nhắc cập nhật).',
    tags: ['update', 'cap nhat', 'version', 'phien ban', 'check'],
  },
  ollama_emulation: {
    titleEn: 'Ollama emulation mode',
    titleVi: 'Chế độ giả lập Ollama',
    en: 'Lets Ollama-native clients talk to the gateway. Modes: off, open-loopback (no key needed, only from this machine) and key-required (clients must present a gateway key). Payload: { mode: off|open-loopback|key-required }.',
    vi: 'Cho phép client kiểu Ollama kết nối vào gateway. Chế độ: off, open-loopback (không cần key, chỉ từ chính máy này) và key-required (client phải gửi gateway key). Tham số: { mode: off|open-loopback|key-required }.',
    path: '/keys',
    whereEn: 'Keys page → agent compatibility section.',
    whereVi: 'Trang Keys → mục tương thích agent.',
    tags: ['ollama', 'emulation', 'gia lap', 'loopback', 'key'],
  },
};

export function buildSettingChunks(): KbChunk[] {
  return (Object.keys(SETTING_DOCS) as SupportSystemSettingId[]).map((id) => {
    const d = SETTING_DOCS[id];
    const perm = REQUIRED_PERMISSION_BY_SETTING[id];
    return {
      id: `setting:${id}`,
      source: 'setting',
      title: `System setting: ${d.titleEn} (${id})`,
      titleVi: `Cài đặt hệ thống: ${d.titleVi} (${id})`,
      text: `${d.en} Requires the \`${perm}\` permission. The Copilot only ever proposes this change — nothing applies until the admin approves the Consent Card. Where: ${d.whereEn}`,
      textVi: `${d.vi} Cần quyền \`${perm}\`. Copilot chỉ đề xuất thay đổi này — không có gì được áp dụng cho đến khi admin duyệt thẻ xác nhận. Vị trí: ${d.whereVi}`,
      path: d.path,
      tags: ['setting', 'cai dat', 'he thong', id, ...d.tags],
      requiredPermission: perm,
    };
  });
}
