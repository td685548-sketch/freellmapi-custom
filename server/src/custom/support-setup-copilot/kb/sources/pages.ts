import type { Permission } from '@freellmapi/shared/permissions.js';
import { listPlatformRouteDescriptors } from '../../platform-guide.js';
import type { KbChunk } from '../types.js';

/**
 * Dashboard sitemap. Every `<Route path>` in client/src/App.tsx must have an
 * entry (here or in the curated platform-guide route catalog) — a test reads
 * App.tsx and fails when a page is added without being documented.
 */
interface PageDoc {
  path: string;
  titleEn: string;
  titleVi: string;
  en: string;
  vi: string;
  requiredPermission?: Permission;
  tags: string[];
}

export const DASHBOARD_PAGES: readonly PageDoc[] = [
  { path: '/models/chat', titleEn: 'Models — chat catalog & fallback order', titleVi: 'Models — danh mục chat & thứ tự dự phòng', en: 'The chat model catalog and the fallback order the router tries. Each model row links to a detail page.', vi: 'Danh mục model chat và thứ tự dự phòng mà router thử lần lượt. Mỗi model có trang chi tiết.', tags: ['models', 'chat', 'fallback', 'du phong', 'danh muc'] },
  { path: '/models/fusion', titleEn: 'Models — Fusion', titleVi: 'Models — Fusion', en: 'Fusion mode: several models answer and a judge model synthesises the result.', vi: 'Chế độ Fusion: nhiều model cùng trả lời rồi một model giám khảo tổng hợp kết quả.', tags: ['fusion', 'judge', 'panel'] },
  { path: '/models/embeddings', titleEn: 'Models — embeddings', titleVi: 'Models — embeddings', en: 'Embedding models used for semantic retrieval and knowledge indexing.', vi: 'Các model embedding dùng cho truy xuất ngữ nghĩa và lập chỉ mục tri thức.', tags: ['embeddings', 'vector', 'retrieval'] },
  { path: '/models/image', titleEn: 'Models — image', titleVi: 'Models — hình ảnh', en: 'Image generation models.', vi: 'Các model tạo ảnh.', tags: ['image', 'anh'] },
  { path: '/models/video', titleEn: 'Models — video', titleVi: 'Models — video', en: 'Video generation models.', vi: 'Các model tạo video.', tags: ['video'] },
  { path: '/models/audio', titleEn: 'Models — audio', titleVi: 'Models — âm thanh', en: 'Speech, audio and transcription models.', vi: 'Các model giọng nói, âm thanh và chuyển giọng nói thành văn bản.', tags: ['audio', 'speech', 'transcription'] },
  { path: '/models/search', titleEn: 'Models — web search', titleVi: 'Models — tìm kiếm web', en: 'Web-search providers the Playground and API can use.', vi: 'Các nhà cung cấp tìm kiếm web mà Playground và API có thể dùng.', tags: ['search', 'web', 'tim kiem'] },
  { path: '/models/decision', titleEn: 'Models — decision extraction', titleVi: 'Models — trích xuất quyết định', en: 'Decision-extraction page (see docs/decision-extraction.md).', vi: 'Trang trích xuất quyết định (xem docs/decision-extraction.md).', tags: ['decision'] },
  { path: '/models/transcription', titleEn: 'Models — transcription', titleVi: 'Models — chuyển giọng nói thành văn bản', en: 'Speech-to-text (transcription) models; each model has a detail page.', vi: 'Các model chuyển giọng nói thành văn bản; mỗi model có trang chi tiết.', tags: ['transcription', 'speech to text', 'phien am'] },
  { path: '/playground', titleEn: 'Playground', titleVi: 'Playground', en: 'Interactive chat to try any model. Chat settings (system instruction, temperature, max tokens, reasoning) sit in the settings rail.', vi: 'Khung chat để thử model. Cài đặt chat (system instruction, temperature, max tokens, reasoning) nằm ở thanh cài đặt.', tags: ['playground', 'chat', 'thu', 'system instruction'] },
  { path: '/keys', titleEn: 'Keys — provider keys, personal/unified key, client profiles', titleVi: 'Keys — khoá nhà cung cấp, khoá cá nhân/hợp nhất, client profile', en: 'Add and test upstream provider credentials, see the unified gateway key, client profiles and agent compatibility (Ollama emulation, MCP).', vi: 'Thêm và kiểm tra khoá nhà cung cấp, xem khoá gateway hợp nhất, client profile và mục tương thích agent (Ollama emulation, MCP).', requiredPermission: 'manage_keys', tags: ['keys', 'khoa', 'provider', 'api key', 'profile'] },
  { path: '/invites', titleEn: 'Invites', titleVi: 'Mã mời', en: 'Create and revoke registration invitation codes.', vi: 'Tạo và thu hồi mã mời đăng ký.', requiredPermission: 'manage_invites', tags: ['invite', 'moi', 'dang ky'] },
  { path: '/users', titleEn: 'Users & roles', titleVi: 'Người dùng & vai trò', en: 'Manage accounts, roles, permissions, quotas and sessions. Permission assignment lives here.', vi: 'Quản lý tài khoản, vai trò, quyền, hạn mức và phiên đăng nhập. Gán quyền nằm ở đây.', requiredPermission: 'manage_users', tags: ['users', 'nguoi dung', 'role', 'quyen', 'permission'] },
  { path: '/usage', titleEn: 'Usage ranking', titleVi: 'Xếp hạng sử dụng', en: 'Compare traffic and speed across accounts and client keys.', vi: 'So sánh lưu lượng và tốc độ giữa các tài khoản và client key.', requiredPermission: 'view_usage', tags: ['usage', 'su dung', 'ranking'] },
  { path: '/profiles/:id/usage', titleEn: 'Client profile usage', titleVi: 'Mức dùng của client profile', en: 'Usage of one client profile (requests, tokens, errors, latency). Opened from the usage ranking or the profile on the Keys page.', vi: 'Mức dùng của một client profile (request, token, lỗi, độ trễ). Mở từ bảng xếp hạng sử dụng hoặc từ profile ở trang Keys.', requiredPermission: 'view_usage', tags: ['profile', 'client profile', 'usage'] },
  { path: '/audit', titleEn: 'Change history (audit log)', titleVi: 'Lịch sử thay đổi (audit log)', en: 'Who changed limits, keys, permissions and settings, and when.', vi: 'Ai đã đổi hạn mức, khoá, quyền và cài đặt, vào lúc nào.', requiredPermission: 'view_audit_log', tags: ['audit', 'lich su', 'thay doi'] },
  { path: '/analytics', titleEn: 'Analytics', titleVi: 'Phân tích', en: 'Usage statistics, routing metrics and provider tiers.', vi: 'Thống kê sử dụng, số liệu định tuyến và hạng nhà cung cấp.', requiredPermission: 'view_analytics', tags: ['analytics', 'phan tich', 'thong ke'] },
  { path: '/logs', titleEn: 'Server logs', titleVi: 'Nhật ký máy chủ', en: 'Redacted server diagnostic messages.', vi: 'Thông điệp chẩn đoán của máy chủ (đã che thông tin nhạy cảm).', requiredPermission: 'view_server_logs', tags: ['logs', 'nhat ky', 'diagnostic'] },
  { path: '/status', titleEn: 'Status', titleVi: 'Trạng thái', en: 'Service status page showing whether the gateway and its upstream providers are reachable.', vi: 'Trang trạng thái dịch vụ cho biết gateway và các nhà cung cấp phía trên có truy cập được hay không.', tags: ['status', 'trang thai', 'health'] },
  { path: '/agents', titleEn: 'Agents — connect coding agents', titleVi: 'Agents — kết nối coding agent', en: 'Set up coding agents and CLIs (Claude Code, Codex, Cursor, Cline, OpenCode …) against this gateway. See docs/en/clients.', vi: 'Cấu hình coding agent và CLI (Claude Code, Codex, Cursor, Cline, OpenCode …) dùng gateway này. Xem docs/en/clients.', tags: ['agents', 'cli', 'ide', 'claude code', 'cursor'] },
  { path: '/premium', titleEn: 'Premium', titleVi: 'Premium', en: 'Premium catalog options and the live model catalog tier.', vi: 'Các tuỳ chọn catalog Premium và hạng catalog model trực tiếp.', tags: ['premium'] },
  { path: '/about', titleEn: 'About', titleVi: 'Giới thiệu', en: 'Version and project information about this installation.', vi: 'Thông tin phiên bản và dự án.', tags: ['about', 'version', 'phien ban'] },
];

export function buildPageChunks(): KbChunk[] {
  const chunks: KbChunk[] = DASHBOARD_PAGES.map((p) => ({
    id: `page:${p.path}`,
    source: 'page',
    title: `Page ${p.path}: ${p.titleEn}`,
    titleVi: `Trang ${p.path}: ${p.titleVi}`,
    text: `${p.en}${p.requiredPermission ? ` Needs the \`${p.requiredPermission}\` permission.` : ''}`,
    textVi: `${p.vi}${p.requiredPermission ? ` Cần quyền \`${p.requiredPermission}\`.` : ''}`,
    path: p.path,
    tags: ['page', 'trang', 'menu', 'o dau', 'where', ...p.tags],
    ...(p.requiredPermission ? { requiredPermission: p.requiredPermission } : {}),
  }));

  // Thruline / Tenant Portal / AI hub / AI platform screens come from the
  // curated, bilingual route catalog that already powers "where is X" answers.
  for (const r of listPlatformRouteDescriptors()) {
    if (r.routeId === 'thruline_general') continue;
    chunks.push({
      id: `route:${r.routeId}`,
      source: 'page',
      title: r.titleEn.replace(/`/g, ''),
      titleVi: r.titleVi.replace(/`/g, ''),
      text: `${r.purposeEn} ${r.howToUseEn} ${r.supportConnectionEn}`,
      textVi: `${r.purposeVi} ${r.howToUseVi} ${r.supportConnectionVi}`,
      path: r.canonicalPath,
      tags: ['page', 'trang', 'menu', 'o dau', 'where', r.routeId, r.area],
    });
  }
  return chunks;
}
