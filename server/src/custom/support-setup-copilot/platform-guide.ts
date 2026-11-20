import type { SupportSetupTenantDiagnostic } from '@freellmapi/shared/support-setup-copilot.js';

export type PlatformQuestionKind =
  | 'platform_overview'
  | 'current_page'
  | 'thruline_overview'
  | 'tenant_portal_overview'
  | 'ai_hub_overview'
  | 'workspace_comparison'
  | 'howto_providers_keys'
  | 'howto_combos_routing'
  | 'howto_token_savers'
  | 'howto_cli_skills'
  | 'howto_translator'
  | 'howto_quota_usage';

export type PlatformArea =
  | 'thruline_support'
  | 'thruline_gateway'
  | 'tenant_portal'
  | 'ai_hub'
  | 'freellmapi_dashboard';

export interface PlatformRouteDescriptor {
  routeId: string;
  canonicalPath: string;
  normalizedPath: string;
  area: PlatformArea;
  titleVi: string;
  titleEn: string;
  purposeVi: string;
  purposeEn: string;
  howToUseVi: string;
  howToUseEn: string;
  supportConnectionVi: string;
  supportConnectionEn: string;
  quickRepliesVi: string[];
  quickRepliesEn: string[];
}

export interface PlatformQuestionMatch {
  kind: PlatformQuestionKind;
  route: PlatformRouteDescriptor | null;
}

export interface PlatformExpertReplyParams {
  match: PlatformQuestionMatch;
  locale: 'vi' | 'en';
  currentPath?: string | null;
  diagnostic?: SupportSetupTenantDiagnostic | null;
  canCreateTenant?: boolean;
  canEditAny?: boolean;
  priorAssistantMessages?: readonly string[];
}

export interface PlatformExpertReplyResult {
  reply: string;
  suggestedQuickReplies: string[];
}

/**
 * Concise, high-accuracy platform architecture reference injected into live LLM coaching
 * prompts so any connected model answers questions about FreeLLMAPI, Thruline, Tenant AI Portal,
 * Personal AI Hub, and the user's current screen like a senior product specialist.
 */
export const PLATFORM_EXPERT_KNOWLEDGE = `
PLATFORM & PRODUCT ARCHITECTURE KNOWLEDGE (FreeLLMAPI Ecosystem — 100% Ground Truth):
1. Overall Website / Platform (FreeLLMAPI + Thruline + Tenant AI Portal + Personal AI Hub):
   - Unified AI Gateway & Multi-Provider LLM Router: Aggregates multiple AI providers, API keys, keyless free tiers, and OAuth accounts behind unified OpenAI (/v1/*), Gemini (/v1beta/*), Anthropic, and Ollama-compatible endpoints — with automatic failover, weighted load balancing, rate-limit cooldown rotation, semantic/response caching, and token savers.
2. Thruline Console (/thruline/* — operator gateway & AI Support build studio):
   - /thruline/home: Overview of connected accounts, live gateway health, and recent traffic.
   - /thruline/providers: Connect AI providers, OAuth subscriptions, API keys, and free-tier accounts with automatic multi-account rotation.
   - /thruline/endpoint: Manage the unified /thruline/v1 proxy endpoint, gateway keys, and SDK connection snippets.
   - /thruline/combos: Build multi-model fallback and weighted load-balancing chains under a single virtual model name.
   - /thruline/savers (alias /thruline/token-savers): Enable Agentic Token Compactor, prompt/history compression, and semantic response caching to cut token spend and latency.
   - /thruline/quota & /thruline/usage & /thruline/logs: Real-time account rate-limit/quota windows, cooldown tracking, token analytics, and live request logs.
   - /thruline/tools (alias /thruline/cli-tools) & /thruline/skills: Connect coding agents/CLIs (Claude Code, Codex, Cursor, Cline, OpenCode, Aider) to your gateway and manage reusable Agent Skills.
   - /thruline/translator: Real-time cross-protocol inspector & translator across OpenAI, Anthropic, Gemini, and Ollama formats.
   - /thruline/proxies & /thruline/media & /thruline/playground: Outbound proxy pool per account, image/audio/video providers, and interactive model testing.
   - 7 Customer Support AI Studios (/thruline/support, /thruline/support-knowledge, /thruline/support-guardrails, /thruline/support-output, /thruline/support-desk, /thruline/support-integration, /thruline/support-ops): Build, secure, test, and embed business customer-support AI chatbots with live Service Desk tickets & SLA routing.
3. Tenant AI Portal (/tenant-portal):
   - Dedicated RBAC-scoped workspace for each business/store team to manage their own AI Support persona, FAQ/RAG knowledge base, PII masking, custom tools, prompt firewall, Service Desk live chat/tickets/SLA, team members, and website <script> embed without seeing platform-wide provider keys.
4. Personal AI Hub (/assistants) & Main FreeLLMAPI Dashboard (/models/*, /keys, /analytics, /users, /invites):
   - Personal AI assistants (Coding, Writing, Data, Productivity), personal gateway API keys with Eco/Balanced/Max routing modes, multimodal model fallback chains, invite codes, and multi-user RBAC.
`.trim();

export function normalizePlatformPath(rawPath?: string | null): string {
  if (!rawPath || typeof rawPath !== 'string') return '';
  const withoutQuery = rawPath.split(/[?#]/)[0]?.trim() ?? '';
  if (!withoutQuery) return '';
  const withLeadingSlash = withoutQuery.startsWith('/') ? withoutQuery : `/${withoutQuery}`;
  if (withLeadingSlash.length > 1 && withLeadingSlash.endsWith('/')) {
    return withLeadingSlash.replace(/\/+$/, '');
  }
  return withLeadingSlash;
}

function foldVietnameseAscii(input: string): string {
  return input
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[\u0111\u0110]/g, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

interface RouteCatalogEntry {
  match: (normalizedPath: string) => boolean;
  descriptor: Omit<PlatformRouteDescriptor, 'normalizedPath'> & { canonicalPath: string };
}

const ROUTE_CATALOG: readonly RouteCatalogEntry[] = [
  {
    match: (p) => p === '/thruline' || p === '/thruline/home',
    descriptor: {
      routeId: 'thruline_home',
      canonicalPath: '/thruline/home',
      area: 'thruline_gateway',
      titleVi: 'Tổng quan Điều hành Thruline (`/thruline/home`)',
      titleEn: 'Thruline Overview (`/thruline/home`)',
      purposeVi:
        'Đây là bảng điều khiển trung tâm của **Thruline**, giúp bạn nhìn nhanh toàn cảnh sức khỏe cổng AI: số lượng nhà cung cấp & tài khoản đang kết nối, lưu lượng request gần đây, tình trạng hạn mức và lối tắt tới các phân khu định tuyến hoặc AI Support.',
      purposeEn:
        'This is the central **Thruline Overview** dashboard, giving you an instant pulse on connected AI providers, active accounts, recent request traffic, quota health, and quick shortcuts across routing and AI Support studios.',
      howToUseVi:
        'Từ đây bạn có thể bấm sang **Providers** để nối thêm tài khoản AI, vào **Combos** để tạo chuỗi model dự phòng, hoặc mở nhóm **Support** ở thanh bên trái (hoặc nhắn ngay cho mình tại khung chat này) để dựng chatbot chăm sóc khách hàng.',
      howToUseEn:
        'Jump to **Providers** to connect upstream AI accounts, **Combos** to build fallback model chains, or open the **Support** studios in the left sidebar (or chat right here with me) to launch a customer support assistant.',
      supportConnectionVi:
        'Khi các nguồn model trên Thruline hoạt động xanh mượt, trợ lý AI Support của bạn sẽ tự động thừa hưởng khả năng xoay vòng tài khoản ổn định 24/7.',
      supportConnectionEn:
        'Healthy provider routes in Thruline automatically power your AI Support assistants with resilient 24/7 failover.',
      quickRepliesVi: [
        'Làm sao kết nối thêm tài khoản AI / Provider?',
        'Mình muốn dựng trợ lý AI Support cho web/shop',
        'Khác nhau giữa Thruline và Tenant Portal là gì?',
      ],
      quickRepliesEn: [
        'How do I connect AI provider accounts?',
        'Set up a complete AI Support assistant for me',
        'What is the difference between Thruline and Tenant Portal?',
      ],
    },
  },
  {
    match: (p) => p === '/thruline/providers' || p.startsWith('/thruline/providers/'),
    descriptor: {
      routeId: 'thruline_providers',
      canonicalPath: '/thruline/providers',
      area: 'thruline_gateway',
      titleVi: 'Kết nối Nhà cung cấp & Tài khoản AI (`Providers` — `/thruline/providers`)',
      titleEn: 'AI Providers & OAuth Accounts (`Providers` — `/thruline/providers`)',
      purposeVi:
        'Màn hình này là nơi bạn **kết nối và quản lý toàn bộ các nguồn tài khoản AI** cấp sức mạnh cho hệ thống — hỗ trợ cả đăng nhập **OAuth** (Claude, Gemini, Qwen, Codex, Kiro...), gắn **API Key**, gói **Free-tier** không cần key lẫn endpoint tùy chỉnh.',
      purposeEn:
        'This screen is where you **connect and manage all upstream AI provider accounts** powering your gateway — supporting **OAuth sign-in** (Claude, Gemini, Qwen, Codex, Kiro, etc.), **API keys**, **free-tier** routes, and custom OpenAI-compatible nodes.',
      howToUseVi:
        'Bạn chỉ cần chọn một nhà cung cấp -> bấm kết nối tài khoản OAuth hoặc dán API key -> bật kích hoạt. Bạn có thể thêm **nhiều tài khoản cùng lúc** để hệ thống tự động xoay vòng (load-balance) và né giới hạn rate-limit mượt mà.',
      howToUseEn:
        'Pick any provider card -> connect via OAuth or paste an API key -> enable the account. You can add **multiple accounts per provider** so Thruline automatically rotates credentials and avoids rate-limit bottlenecks.',
      supportConnectionVi:
        'Đây chính là "nguồn điện" nuôi con AI Support của bạn: chỉ cần có ít nhất 1 tài khoản đang bật tại đây, chatbot chăm sóc khách hàng để chế độ model `auto` sẽ trả lời khách ổn định suốt ngày đêm.',
      supportConnectionEn:
        'These accounts directly power your customer-facing AI Support bots — once at least one provider account is active here, setting a Support Tenant to `auto` gives it seamless multi-account resilience.',
      quickRepliesVi: [
        'Combo dùng để làm gì?',
        'Làm sao lấy API key để gọi từ ứng dụng?',
        'Mình muốn dựng trợ lý AI Support cho web/shop',
      ],
      quickRepliesEn: [
        'What are Combos used for?',
        'How do I get an API key for my app?',
        'Set up a complete AI Support assistant for me',
      ],
    },
  },
  {
    match: (p) => p === '/thruline/endpoint' || p.startsWith('/thruline/endpoint/'),
    descriptor: {
      routeId: 'thruline_endpoint',
      canonicalPath: '/thruline/endpoint',
      area: 'thruline_gateway',
      titleVi: 'Điểm cuối Kết nối & Khóa API (`Endpoint` — `/thruline/endpoint`)',
      titleEn: 'Unified Gateway Endpoint & API Keys (`Endpoint` — `/thruline/endpoint`)',
      purposeVi:
        'Trang này dùng để quản lý **địa chỉ cổng hợp nhất (`/thruline/v1`) và tạo khóa API (Gateway Keys)** để các ứng dụng bên ngoài, server backend hoặc công cụ code gọi vào toàn bộ dàn model bạn đã kết nối.',
      purposeEn:
        'This page manages your **unified `/thruline/v1` proxy endpoint and Gateway API Keys**, giving external apps, backend services, and SDKs a single drop-in URL to call every model connected in Thruline.',
      howToUseVi:
        'Bạn bật cổng kết nối, tạo một API Key mới, rồi copy **Base URL** kèm đoạn code mẫu (OpenAI SDK, Anthropic, cURL) dán vào ứng dụng là gọi được ngay.',
      howToUseEn:
        'Enable the gateway toggle, generate a dedicated API key, and copy the ready-made **Base URL** and SDK snippet (OpenAI, Anthropic, or cURL) into your project.',
      supportConnectionVi:
        'Lưu ý nhỏ: khóa ở trang này dành cho **backend / developer** gọi LLM trực tiếp; còn để nhúng khung chat công khai lên website cho khách hàng, hệ thống dùng khóa công khai an toàn `pk_sup_...` riêng ở `/thruline/support-integration`.',
      supportConnectionEn:
        'Note: keys on this page are secret **server/developer** keys; for public website customer chat widgets, use the scoped `pk_sup_...` public tenant key in `/thruline/support-integration` instead.',
      quickRepliesVi: [
        'Làm sao kết nối thêm tài khoản AI ở Providers?',
        'Mình muốn nhúng chatbot AI Support lên website',
        'Combo dùng để làm gì?',
      ],
      quickRepliesEn: [
        'How do I add upstream accounts in Providers?',
        'Help me set up an embeddable AI Support widget',
        'How do Combos work?',
      ],
    },
  },
  {
    match: (p) => p === '/thruline/combos' || p.startsWith('/thruline/combos/'),
    descriptor: {
      routeId: 'thruline_combos',
      canonicalPath: '/thruline/combos',
      area: 'thruline_gateway',
      titleVi: 'Chuỗi Model Dự phòng & Cân bằng tải (`Combos` — `/thruline/combos`)',
      titleEn: 'Multi-Model Combos & Smart Routing (`Combos` — `/thruline/combos`)',
      purposeVi:
        'Trang **Combos** giúp bạn gom nhiều model từ các nhà cung cấp khác nhau thành **một tên model ảo duy nhất** kèm kịch bản dự phòng (failover) hoặc chia tải tự động.',
      purposeEn:
        'The **Combos** screen lets you bundle multiple models across different providers behind **one virtual model name** with automatic failover, load balancing, or latency/cost routing strategies.',
      howToUseVi:
        'Bạn tạo một Combo mới (ví dụ `support-pro`), xếp model chính lên đầu và 1–2 model dự phòng phía dưới. Khi model đầu tiên bận hoặc chạm giới hạn quota, hệ thống tự chuyển tức thì sang model kế tiếp mà người dùng không hề gặp lỗi.',
      howToUseEn:
        'Create a named Combo (e.g. `support-pro`), stack your preferred primary model first with 1–2 backup models underneath, and pick your routing strategy — requests seamlessly fail over if an upstream provider hits rate limits.',
      supportConnectionVi:
        'Khi thiết lập AI Support, bạn có thể gán thẳng tên Combo này làm model cho trợ lý chăm sóc khách hàng để vừa có chất lượng trả lời tốt nhất vừa không bao giờ bị đứt quãng.',
      supportConnectionEn:
        'You can assign any Combo directly to your AI Support tenant so customer chats get top-tier quality with zero downtime.',
      quickRepliesVi: [
        'Token Savers giúp tiết kiệm token như thế nào?',
        'Mình muốn dựng trợ lý AI Support cho web/shop',
        'Xem hạn mức Quota của các tài khoản ở đâu?',
      ],
      quickRepliesEn: [
        'How do Token Savers reduce token usage?',
        'Set up a complete AI Support assistant for me',
        'Where do I check provider Quota & cooldowns?',
      ],
    },
  },
  {
    match: (p) =>
      p === '/thruline/savers' ||
      p.startsWith('/thruline/savers/') ||
      p === '/thruline/token-savers' ||
      p.startsWith('/thruline/token-savers/'),
    descriptor: {
      routeId: 'thruline_savers',
      canonicalPath: '/thruline/savers',
      area: 'thruline_gateway',
      titleVi: 'Tiết kiệm Token & Nén ngữ cảnh (`Token Savers` — `/thruline/savers`)',
      titleEn: 'Token Savers & Agentic Compactor (`Token Savers` — `/thruline/savers`)',
      purposeVi:
        'Màn hình **Token Savers** giúp bạn cắt giảm đáng kể chi phí/lượng token tiêu thụ và tăng tốc độ phản hồi nhờ **Agentic Token Compactor** (nén lịch sử hội thoại dài thông minh), tối ưu prompt và **Semantic/Response Cache** (lưu đệm câu trả lời tương đồng).',
      purposeEn:
        'The **Token Savers** studio cuts token consumption and speeds up responses using the **Agentic Token Compactor** (intelligent long-context & tool-output compression), prompt slimming, and **Semantic/Response Caching**.',
      howToUseVi:
        'Bạn có thể bật các chế độ nén ngữ cảnh khi cuộc trò chuyện kéo dài, bật bộ nhớ đệm cho các câu hỏi lặp lại và theo dõi trực quan số lượng token đã tiết kiệm được.',
      howToUseEn:
        'Toggle context compaction thresholds and response caching rules here, then monitor real-time token savings across your gateway traffic.',
      supportConnectionVi:
        'Tính năng này cực hợp với chatbot chăm sóc khách hàng khi có hàng trăm khách cùng hỏi các câu giống nhau về giá, phí ship hay đổi trả — vừa trả lời nhanh như chớp vừa giữ bền quota tài khoản.',
      supportConnectionEn:
        'This pairs wonderfully with AI Customer Support when visitors repeatedly ask common shipping, pricing, or FAQ questions — keeping responses fast and quota usage lean.',
      quickRepliesVi: [
        'Combo dự phòng model hoạt động thế nào?',
        'Mình muốn dựng trợ lý AI Support cho web/shop',
        'Web này còn những tính năng chính nào nữa?',
      ],
      quickRepliesEn: [
        'How do multi-model Combos work?',
        'Set up a complete AI Support assistant for me',
        'What else does this platform do?',
      ],
    },
  },
  {
    match: (p) =>
      p === '/thruline/tools' ||
      p.startsWith('/thruline/tools/') ||
      p === '/thruline/cli-tools' ||
      p.startsWith('/thruline/cli-tools/'),
    descriptor: {
      routeId: 'thruline_tools',
      canonicalPath: '/thruline/tools',
      area: 'thruline_gateway',
      titleVi: 'Kết nối Công cụ CLI & Coding Agents (`CLI Tools` — `/thruline/tools`)',
      titleEn: 'CLI Tools & Coding Agents (`CLI Tools` — `/thruline/tools`)',
      purposeVi:
        'Màn hình này giúp lập trình viên kết nối nhanh các công cụ AI coding phổ biến (như **Claude Code, Codex CLI, Cursor, Cline, Roo Code, OpenCode, Aider**...) chạy xuyên qua cổng model hợp nhất của Thruline.',
      purposeEn:
        'This screen generates ready-to-run setup configs so developer tools and coding agents (**Claude Code, Codex CLI, Cursor, Cline, Roo Code, OpenCode, Aider**, etc.) route seamlessly through your Thruline gateway.',
      howToUseVi:
        'Bạn chọn công cụ CLI mình đang dùng, chọn model hoặc Combo muốn gán, rồi sao chép lệnh cấu hình tự động (`BASE_URL` & `API_KEY`) chạy trên máy là kết nối xong.',
      howToUseEn:
        'Pick your coding tool, choose the target model or Combo, and copy the one-line environment/config snippet onto your machine.',
      supportConnectionVi:
        'Trong lúc đội kỹ thuật dùng trang này để code sản phẩm nhanh hơn, bạn có thể nhờ mình ngay ở góc màn hình này để dựng luôn trợ lý AI chăm sóc khách hàng cho sản phẩm đó!',
      supportConnectionEn:
        'While engineering uses CLI Tools to build faster, you can use me right here anytime to spin up the customer-facing AI Support bot for the product you are shipping!',
      quickRepliesVi: [
        'Skills Hub dùng để làm gì?',
        'Bộ dịch giao thức Translator hoạt động thế nào?',
        'Mình muốn dựng trợ lý AI Support cho dự án',
      ],
      quickRepliesEn: [
        'What is the Skills Hub for?',
        'How does the Protocol Translator work?',
        'Draft an AI Support setup for my project',
      ],
    },
  },
  {
    match: (p) => p === '/thruline/skills' || p.startsWith('/thruline/skills/'),
    descriptor: {
      routeId: 'thruline_skills',
      canonicalPath: '/thruline/skills',
      area: 'thruline_gateway',
      titleVi: 'Kho Kỹ năng AI Agent (`Skills Hub` — `/thruline/skills`)',
      titleEn: 'Agent Skills Hub (`Skills Hub` — `/thruline/skills`)',
      purposeVi:
        'Trang **Skills Hub** là thư viện quản lý và chia sẻ các gói kỹ năng chuẩn hóa (`SKILL.md`, hướng dẫn quy trình chuyên môn) giúp AI Agent xử lý bài bản các công việc chuyên sâu.',
      purposeEn:
        'The **Skills Hub** is a curated library for managing reusable agent skill packs (`SKILL.md` instructions and workflows) that teach coding and automation agents specialized tasks.',
      howToUseVi:
        'Bạn có thể duyệt các gói kỹ năng mẫu, cài đặt cho công cụ agent đang dùng hoặc lưu lại quy trình riêng của đội ngũ.',
      howToUseEn:
        'Browse built-in skill templates, export them to your CLI agents, or author custom team workflows.',
      supportConnectionVi:
        'Nếu bạn muốn dạy quy trình tư vấn & bảng giá cho **khách hàng ghé website**, mình sẽ nạp vào kho tri thức **Support Knowledge** (`/thruline/support-knowledge`) thay vì Skills Hub nhé!',
      supportConnectionEn:
        'Tip: Skills Hub equips developer/internal agents, whereas customer-facing FAQs and policies belong in **Support Knowledge** (`/thruline/support-knowledge`).',
      quickRepliesVi: [
        'Giải thích Bước 2 nạp FAQ cho khách hàng',
        'CLI Tools dùng để làm gì?',
        'Mình muốn dựng trợ lý AI Support cho web/shop',
      ],
      quickRepliesEn: [
        'Explain Step 2 customer FAQ & RAG knowledge',
        'What is CLI Tools used for?',
        'Set up a complete AI Support assistant for me',
      ],
    },
  },
  {
    match: (p) => p === '/thruline/translator' || p.startsWith('/thruline/translator/'),
    descriptor: {
      routeId: 'thruline_translator',
      canonicalPath: '/thruline/translator',
      area: 'thruline_gateway',
      titleVi: 'Bộ Chuyển đổi Giao thức AI (`Protocol Translator` — `/thruline/translator`)',
      titleEn: 'Protocol Translator & Inspector (`/thruline/translator`)',
      purposeVi:
        'Màn hình **Protocol Translator** giúp kiểm tra và dịch tự động hai chiều giữa các chuẩn API AI khác nhau: **OpenAI Chat/Responses, Anthropic Claude, Google Gemini (`/v1beta`) và Ollama**.',
      purposeEn:
        'The **Protocol Translator** inspects and translates requests/responses in real time across **OpenAI Chat/Responses, Anthropic Messages, Google Gemini (`/v1beta`), and Ollama** schemas.',
      howToUseVi:
        'Nhờ bộ dịch chạy ngầm này, phần mềm viết theo chuẩn OpenAI vẫn gọi mượt sang model Claude hay Gemini. Tại đây bạn có thể dán payload mẫu để soi chi tiết dữ liệu trước và sau khi dịch.',
      howToUseEn:
        'Paste any sample request payload here to inspect how tool calls, system prompts, and streaming chunks map cleanly from one provider schema to another.',
      supportConnectionVi:
        'Nhờ lớp dịch chuẩn xác này, trợ lý AI Support của bạn có thể đổi qua lại giữa mọi họ model (GPT, Claude, Gemini, Qwen...) mà không lo lỗi định dạng hội thoại.',
      supportConnectionEn:
        'Because translation happens automatically under the hood, your AI Support bot can switch or fail over across OpenAI, Claude, and Gemini models seamlessly.',
      quickRepliesVi: [
        'Combo dự phòng đa model hoạt động ra sao?',
        'Mình muốn dựng trợ lý AI Support cho web/shop',
        'Tổng quan web này làm được những gì?',
      ],
      quickRepliesEn: [
        'How do multi-model Combos work?',
        'Set up a complete AI Support assistant for me',
        'Give me an overview of this whole platform',
      ],
    },
  },
  {
    match: (p) => p === '/thruline/quota' || p.startsWith('/thruline/quota/'),
    descriptor: {
      routeId: 'thruline_quota',
      canonicalPath: '/thruline/quota',
      area: 'thruline_gateway',
      titleVi: 'Giám sát Hạn mức & Cooldown (`Quota` — `/thruline/quota`)',
      titleEn: 'Real-Time Quota & Cooldown Monitor (`Quota` — `/thruline/quota`)',
      purposeVi:
        'Trang **Quota** hiển thị trực tiếp sức khỏe hạn mức của từng tài khoản AI: lượng request/token còn lại theo khung giờ hoặc ngày, trạng thái chạm trần rate-limit và đồng hồ đếm ngược thời gian nghỉ hồi phục (**cooldown**).',
      purposeEn:
        'The **Quota** page tracks live rate-limit windows, remaining daily/monthly allowances, and automatic **cooldown** timers across every connected provider account.',
      howToUseVi:
        'Bạn mở trang này khi muốn kiểm tra xem tài khoản nào đang gánh tải tốt, tài khoản nào vừa hết hạn mức miễn phí để kịp thời nối thêm tài khoản dự phòng ở mục **Providers**.',
      howToUseEn:
        'Check this view anytime to spot accounts nearing exhaustion and add extra rotation accounts in **Providers** before traffic spikes.',
      supportConnectionVi:
        'Giúp bạn hoàn toàn chủ động giữ cho nguồn model nuôi chatbot chăm sóc khách hàng luôn thông suốt, không bao giờ hết quota bất ngờ.',
      supportConnectionEn:
        'Keeping an eye on quota health ensures your public AI Support chat widget stays responsive even during peak customer hours.',
      quickRepliesVi: [
        'Làm sao thêm tài khoản xoay vòng ở Providers?',
        'Token Savers tiết kiệm hạn mức thế nào?',
        'Mình muốn dựng trợ lý AI Support cho web/shop',
      ],
      quickRepliesEn: [
        'How do I add rotation accounts in Providers?',
        'How do Token Savers stretch my quota?',
        'Set up a complete AI Support assistant for me',
      ],
    },
  },
  {
    match: (p) => p === '/thruline/usage' || p.startsWith('/thruline/usage/'),
    descriptor: {
      routeId: 'thruline_usage',
      canonicalPath: '/thruline/usage',
      area: 'thruline_gateway',
      titleVi: 'Thống kê Lưu lượng & Token (`Account Usage` — `/thruline/usage`)',
      titleEn: 'Account Usage & Token Analytics (`/thruline/usage`)',
      purposeVi:
        'Trang **Account Usage** thống kê chi tiết số lượt gọi API, lượng token đầu vào/đầu ra, độ trễ phản hồi và tỷ lệ thành công theo từng tài khoản nhà cung cấp và từng model.',
      purposeEn:
        'The **Account Usage** screen breaks down request volume, prompt/completion tokens, latency, and success rates across your connected accounts and models.',
      howToUseVi:
        'Bạn lọc theo mốc thời gian để xem model nào được dùng nhiều nhất, phát hiện sớm các luồng tốn nhiều token và tối ưu lại bằng **Combos** hoặc **Token Savers**.',
      howToUseEn:
        'Filter by time range or provider to see which models carry the most traffic and where **Combos** or **Token Savers** can optimize cost and speed.',
      supportConnectionVi:
        'Giúp bạn theo dõi rõ ràng lượng token thực tế mà trợ lý AI chăm sóc khách hàng tiêu thụ mỗi ngày.',
      supportConnectionEn:
        'Gives you clear visibility into daily token consumption driven by your AI Support conversations and apps.',
      quickRepliesVi: [
        'Bật Token Savers giảm tốn token ở đâu?',
        'Xem hạn mức Quota còn lại ở đâu?',
        'Mình muốn dựng trợ lý AI Support cho web/shop',
      ],
      quickRepliesEn: [
        'How do I enable Token Savers?',
        'Where do I check live Quota windows?',
        'Set up a complete AI Support assistant for me',
      ],
    },
  },
  {
    match: (p) => p === '/thruline/logs' || p.startsWith('/thruline/logs/'),
    descriptor: {
      routeId: 'thruline_logs',
      canonicalPath: '/thruline/logs',
      area: 'thruline_gateway',
      titleVi: 'Nhật ký Request Trực tiếp (`Console Logs` — `/thruline/logs`)',
      titleEn: 'Live Gateway Console Logs (`/thruline/logs`)',
      purposeVi:
        'Màn hình **Console Logs** ghi lại nhật ký thời gian thực của từng lượt gọi đi qua Thruline — giúp bạn kiểm tra mã HTTP, độ trễ, model thực tế đã xử lý và lý do tự động chuyển sang tài khoản dự phòng nếu có lỗi.',
      purposeEn:
        'The **Console Logs** view streams live gateway request traces — showing HTTP status codes, latency, selected upstream accounts, and automatic failover reasons for easy debugging.',
      howToUseVi:
        'Dùng bộ lọc trạng thái lỗi hoặc tên model khi bạn cần bắt bệnh nhanh một kết nối API hay kiểm tra tốc độ phản hồi thực tế.',
      howToUseEn:
        'Filter by status or model whenever you want to diagnose an upstream error or verify failover routing in real time.',
      supportConnectionVi:
        'Rất tiện khi bạn muốn kiểm tra kỹ thuật đường truyền model phía sau các phiên chat hỗ trợ khách hàng.',
      supportConnectionEn:
        'Handy whenever you want to verify model latency or upstream health behind customer support chats.',
      quickRepliesVi: [
        'Làm sao kết nối thêm tài khoản ở Providers?',
        'Mình muốn dựng trợ lý AI Support cho web/shop',
      ],
      quickRepliesEn: [
        'How do I add accounts in Providers?',
        'Set up a complete AI Support assistant for me',
      ],
    },
  },
  {
    match: (p) => p === '/thruline/proxies' || p.startsWith('/thruline/proxies/'),
    descriptor: {
      routeId: 'thruline_proxies',
      canonicalPath: '/thruline/proxies',
      area: 'thruline_gateway',
      titleVi: 'Quản lý Hồ Proxy Kết nối (`Proxy Pool` — `/thruline/proxies`)',
      titleEn: 'Outbound Proxy Pool (`/thruline/proxies`)',
      purposeVi:
        'Trang **Proxy Pool** dùng để khai báo, kiểm tra kết nối và gán các proxy mạng đầu ra (HTTP/HTTPS/SOCKS5) riêng cho từng tài khoản nhà cung cấp AI khi cần phân tách đường truyền.',
      purposeEn:
        'The **Proxy Pool** manages outbound HTTP/HTTPS/SOCKS5 proxies, health checks, and per-account network bindings for upstream AI providers.',
      howToUseVi:
        'Thêm địa chỉ proxy, bấm kiểm tra độ trễ, sau đó gắn cho các tài khoản tương ứng trong mục **Providers**.',
      howToUseEn:
        'Add proxy endpoints, run health checks, and bind them to individual provider accounts in **Providers**.',
      supportConnectionVi:
        'Giúp duy trì kết nối ổn định tới các nhà cung cấp AI quốc tế phục vụ trợ lý AI Support của bạn.',
      supportConnectionEn:
        'Keeps upstream provider connectivity reliable for all gateway and AI Support traffic.',
      quickRepliesVi: [
        'Trang Providers dùng để làm gì?',
        'Mình muốn dựng trợ lý AI Support cho web/shop',
      ],
      quickRepliesEn: [
        'What does the Providers page do?',
        'Set up a complete AI Support assistant for me',
      ],
    },
  },
  {
    match: (p) => p === '/thruline/media' || p.startsWith('/thruline/media/'),
    descriptor: {
      routeId: 'thruline_media',
      canonicalPath: '/thruline/media',
      area: 'thruline_gateway',
      titleVi: 'Nhà cung cấp Đa phương tiện (`Media Providers` — `/thruline/media`)',
      titleEn: 'Multimodal Media Providers (`/thruline/media`)',
      purposeVi:
        'Màn hình **Media Providers** quản lý riêng các kết nối AI tạo ảnh (Image), xử lý giọng nói/âm thanh (Audio TTS/STT) và video trên Thruline.',
      purposeEn:
        'The **Media Providers** screen configures dedicated image generation, speech/audio (TTS/STT), and video AI provider accounts.',
      howToUseVi:
        'Kết nối tài khoản media tại đây để gọi thống nhất các tác vụ sinh ảnh, đọc giọng nói hoặc nhận diện âm thanh qua cổng API.',
      howToUseEn:
        'Connect multimodal credentials here to route image, audio, and video generation calls cleanly.',
      supportConnectionVi:
        'Song song với mảng Media, nếu bạn cần dựng chatbot tư vấn văn bản trên website thì mình có thể thiết lập trọn gói ngay tại hộp thoại này nhé!',
      supportConnectionEn:
        'Alongside multimodal APIs, you can chat with me right here anytime to configure your text-based website AI Support assistant!',
      quickRepliesVi: [
        'Tổng quan web này làm được những gì?',
        'Mình muốn dựng trợ lý AI Support cho web/shop',
      ],
      quickRepliesEn: [
        'What does this whole platform do?',
        'Set up a complete AI Support assistant for me',
      ],
    },
  },
  {
    match: (p) => p === '/thruline/settings' || p.startsWith('/thruline/settings/'),
    descriptor: {
      routeId: 'thruline_settings',
      canonicalPath: '/thruline/settings',
      area: 'thruline_gateway',
      titleVi: 'Cài đặt Chung Thruline (`Settings` — `/thruline/settings`)',
      titleEn: 'Thruline Console Settings (`/thruline/settings`)',
      purposeVi:
        'Trang **Settings** dùng để tinh chỉnh hành vi mặc định của cổng Thruline: chiến lược chọn tài khoản xoay vòng, thời gian chờ (timeout), tự động làm mới OAuth token và xuất/nhập bản sao lưu cấu hình.',
      purposeEn:
        'The **Settings** screen controls global Thruline routing defaults, request timeouts, automatic credential refresh behavior, and configuration backup/import.',
      howToUseVi:
        'Các thông số mặc định vốn đã được tối ưu sẵn; bạn chỉ cần vào đây khi muốn sao lưu cấu hình hoặc đổi quy tắc chọn tài khoản toàn cục.',
      howToUseEn:
        'Sensible defaults work out of the box — visit here mainly to export backups or fine-tune global routing policies.',
      supportConnectionVi:
        'Mọi cài đặt riêng của từng chatbot khách hàng (như lời chào, FAQ, màu sắc widget) nằm tách biệt an toàn trong nhóm **Support** chứ không bị lẫn ở đây.',
      supportConnectionEn:
        'Per-business chatbot settings (prompts, FAQs, widget branding) live cleanly in the **Support** studios rather than global console settings.',
      quickRepliesVi: [
        'Hướng dẫn dễ hiểu 7 bước AI Support',
        'Mình muốn dựng trợ lý AI Support cho web/shop',
      ],
      quickRepliesEn: [
        'Walk me through the 7 AI Support steps',
        'Set up a complete AI Support assistant for me',
      ],
    },
  },
  {
    match: (p) => p === '/thruline/playground' || p.startsWith('/thruline/playground/'),
    descriptor: {
      routeId: 'thruline_playground',
      canonicalPath: '/thruline/playground',
      area: 'thruline_gateway',
      titleVi: 'Phòng Thử nghiệm Chat & Model (`Playground` — `/thruline/playground`)',
      titleEn: 'Interactive Model Playground (`/thruline/playground`)',
      purposeVi:
        'Trang **Playground** là không gian chat thử nghiệm trực tiếp với bất kỳ model hay Combo nào bạn đã kết nối, giúp so sánh chất lượng câu trả lời, tốc độ stream và thử nghiệm System Prompt nhanh chóng.',
      purposeEn:
        'The **Playground** lets you chat interactively with any connected model or Combo to test prompts, compare response quality, and verify streaming behavior.',
      howToUseVi:
        'Chọn model ở thanh trên, nhập System Prompt thử nghiệm và gửi tin nhắn để đánh giá độ mượt trước khi gắn vào ứng dụng thật.',
      howToUseEn:
        'Pick a model or Combo, optionally tweak temperature or system instructions, and send test messages live.',
      supportConnectionVi:
        'Nếu muốn test riêng giao diện nút chat khách hàng (kèm kho FAQ & tường lửa của Tenant), bạn dùng khung **Live Test** trong `/thruline/support-desk` sẽ sát thực tế nhất!',
      supportConnectionEn:
        'To test your full customer-facing chatbot (including RAG knowledge and guardrails), use the **Live Test** preview inside `/thruline/support-desk`!',
      quickRepliesVi: ['Mình muốn dựng trợ lý AI Support cho web/shop'],
      quickRepliesEn: ['Set up a complete AI Support assistant for me'],
    },
  },
  {
    match: (p) => p === '/thruline/support',
    descriptor: {
      routeId: 'thruline_support_persona',
      canonicalPath: '/thruline/support',
      area: 'thruline_support',
      titleVi: 'Support AI Studio — Tenant, Nhân cách AI & Công cụ (`/thruline/support`)',
      titleEn: 'Support AI Studio — Tenant, Persona & Tools (`/thruline/support`)',
      purposeVi:
        'Đây là **Bước 1 (trái tim của AI Support)**: nơi bạn khởi tạo **Support Tenant** cho từng website/cửa hàng, viết **System Prompt** định hình giọng văn tư vấn, chọn model mặc định (`auto` để tự dự phòng), bật quyền chat cho khách vãng lai (`allowGuest`) và gắn thêm các công cụ (Tools/Webhooks) tra cứu đơn hàng.',
      purposeEn:
        'This is **Step 1 (the core of AI Support)**: where you create **Support Tenants**, craft your brand **System Prompt**, choose the default model (`auto` recommended), enable visitor sessions (`allowGuest`), and register external lookup tools.',
      howToUseVi:
        'Bạn có thể tự chỉnh trên màn hình, hoặc nhàn hơn rất nhiều là **kể nhẹ cho mình nghe bên bạn kinh doanh mảng gì** ngay trong khung chat này — mình sẽ viết sẵn System Prompt chuẩn ngành kèm trọn bộ 7 bước để bạn duyệt 1 chạm!',
      howToUseEn:
        'You can edit fields manually on screen, or simply **tell me what kind of business or website you run** right here in chat — I will draft a tailored System Prompt and full 7-step setup for your approval!',
      supportConnectionVi:
        'Màn hình này tương ứng trực tiếp với tab **AI & Prompt** và **Tools & Data** bên trong `/tenant-portal` dành cho đội ngũ vận hành của shop.',
      supportConnectionEn:
        'This corresponds directly to the **AI & Prompt** and **Tools & Data** tabs inside `/tenant-portal` for assigned business teams.',
      quickRepliesVi: [
        'Mình muốn nhờ bạn lên bản mẫu trọn gói cho shop',
        'Bước 2 nạp tài liệu FAQ làm như thế nào?',
        'Khác nhau giữa Thruline và Tenant Portal là gì?',
      ],
      quickRepliesEn: [
        'Draft a complete AI Support setup for my business',
        'How does Step 2 Knowledge Base & PII Masking work?',
        'What is the difference between Thruline and Tenant Portal?',
      ],
    },
  },
  {
    match: (p) => p === '/thruline/support-knowledge' || p.startsWith('/thruline/support-knowledge/'),
    descriptor: {
      routeId: 'thruline_support_knowledge',
      canonicalPath: '/thruline/support-knowledge',
      area: 'thruline_support',
      titleVi: 'Knowledge & Privacy Studio — Kho Tri thức FAQ & Che PII (`/thruline/support-knowledge`)',
      titleEn: 'Knowledge & Privacy Studio — RAG Docs & PII Masking (`/thruline/support-knowledge`)',
      purposeVi:
        'Đây là **Bước 2 của AI Support**: nơi bạn nạp bảng giá, quy định đổi trả, phí ship, câu hỏi thường gặp (**FAQ / RAG Knowledge & Evidence Library**) để AI trả lời đúng sự thật không bịa đặt, đồng thời bật **PII Masking** tự động che SĐT, email, số thẻ và khóa bí mật của khách.',
      purposeEn:
        'This is **Step 2 of AI Support**: where you author or import verified **FAQ/policy documents & Evidence sources** so the AI answers from ground truth, and configure **PII Masking** to redact customer emails, phone numbers, payment cards, and API keys automatically.',
      howToUseVi:
        'Mẹo quan trọng nhất trên trang này: khi tạo tài liệu cho khách ngoài web đọc, bạn nhớ tích chọn vai trò **`guest`** và **`customer`** trong mục `allowedRoles` (nếu chỉ để `admin` thì khách chat ngoài widget sẽ không truy xuất được bài đó).',
      howToUseEn:
        'Key tip on this screen: make sure **`guest`** and **`customer`** are included in `allowedRoles` on public FAQ articles so your embedded website widget can retrieve them!',
      supportConnectionVi:
        'Nếu bạn ngại tự gõ từng bài FAQ từ đầu, chỉ cần nhắn cho mình mảng kinh doanh + vài quy định cơ bản, mình sẽ soạn sẵn bộ 3 tài liệu FAQ chuẩn và bật luôn PII Masking để bạn duyệt!',
      supportConnectionEn:
        'Tell me about your shop and core policies in chat anytime and I can seed starter customer-visible FAQ articles plus PII Masking for you automatically!',
      quickRepliesVi: [
        'Soạn giúp mình bộ FAQ mẫu & cấu hình trọn gói',
        'Bước 3 tường lửa chống phá hoạt động ra sao?',
      ],
      quickRepliesEn: [
        'Draft starter FAQs and full setup for my business',
        'How does Step 3 Prompt Firewall work?',
      ],
    },
  },
  {
    match: (p) => p === '/thruline/support-guardrails' || p.startsWith('/thruline/support-guardrails/'),
    descriptor: {
      routeId: 'thruline_support_guardrails',
      canonicalPath: '/thruline/support-guardrails',
      area: 'thruline_support',
      titleVi: 'Governance & Guardrails Studio — Tường lửa Prompt & Hạn mức (`/thruline/support-guardrails`)',
      titleEn: 'Governance & Guardrails Studio — Prompt Firewall & Quotas (`/thruline/support-guardrails`)',
      purposeVi:
        'Đây là **Bước 3 của AI Support**: lớp khiên bảo vệ đầu vào giúp chatbot công khai của bạn tránh bị kẻ xấu dùng mẹo **Prompt Injection** (dụ AI quên hướng dẫn gốc hoặc lộ prompt nội bộ), chặn các **chủ đề nhạy cảm / tên đối thủ**, và giới hạn **hạn mức lượt hỏi/token mỗi giờ** theo từng vai trò (`guest`, `customer`, `staff`).',
      purposeEn:
        'This is **Step 3 of AI Support**: your inbound safety shield featuring 4 **Prompt Injection** detectors, **blocked topics & competitor keyword filters**, and hourly **per-role request/token quotas** (`guest`, `customer`, `staff`) so traffic spikes or bots cannot burn your quota.',
      howToUseVi:
        'Bạn bật công tắc Guardrails, tích đủ 4 bộ dò chống injection, điền thêm từ khóa đối thủ nếu muốn tránh nhắc tới, và đặt trần lượt hỏi hợp lý cho khách vãng lai (`guest`).',
      howToUseEn:
        'Enable the firewall toggle, keep all 4 injection detectors active, list any off-limit topics or competitor names, and set sensible hourly caps for `guest` sessions.',
      supportConnectionVi:
        'Kết hợp cùng **Output Controls** (`/thruline/support-output` — kiểm tra đầu ra), con AI của bạn được bảo vệ kín kẽ cả chiều vào lẫn chiều ra.',
      supportConnectionEn:
        'Paired with **Output Controls** (`/thruline/support-output`), this protects your assistant on both inbound user messages and outbound AI replies.',
      quickRepliesVi: [
        'Hoàn thiện giúp mình cấu hình an toàn tiêu chuẩn',
        'Bước 4 kiểm soát đầu ra khác gì Bước 3?',
      ],
      quickRepliesEn: [
        'Stage recommended safety defaults for my tenant',
        'How does Step 4 Output Controls complement Step 3?',
      ],
    },
  },
  {
    match: (p) => p === '/thruline/support-output' || p.startsWith('/thruline/support-output/'),
    descriptor: {
      routeId: 'thruline_support_output',
      canonicalPath: '/thruline/support-output',
      area: 'thruline_support',
      titleVi: 'Output Safety Studio — Kiểm soát An toàn Đầu ra (`/thruline/support-output`)',
      titleEn: 'Output Safety Controls Studio (`/thruline/support-output`)',
      purposeVi:
        'Đây là **Bước 4 của AI Support**: chốt kiểm duyệt cuối cùng quét toàn bộ câu trả lời của AI **trước khi hiển thị cho khách hàng** — giúp tự động che khóa bí mật vô tình lọt ra (`redactCredentials`), chặn các từ ngữ bị cấm trong câu trả lời và giới hạn độ dài tối đa.',
      purposeEn:
        'This is **Step 4 of AI Support**: the outbound safety gate that inspects AI responses **before they reach customers** — enforcing secret/credential redaction (`redactCredentials`), blocking restricted terms, and capping maximum reply length.',
      howToUseVi:
        'Khuyến nghị chuẩn cho môi trường chạy thật là chuyển chế độ sang **`enforce`** và bật **`redactCredentials`**. Nếu bạn dùng Setup Copilot, mình luôn cài sẵn chuẩn an toàn này trong bản nháp cho bạn!',
      howToUseEn:
        'For production bots, set mode to **`enforce`** with **`redactCredentials`** turned ON — Setup Copilot stages this automatically whenever I draft a plan for you.',
      supportConnectionVi:
        'Đảm bảo thương hiệu của bạn không bao giờ phát ngôn nhầm từ nhạy cảm hay lộ thông tin nội bộ ra ngoài khung chat.',
      supportConnectionEn:
        'Guarantees outbound replies stay brand-safe and free of accidental credential leaks.',
      quickRepliesVi: [
        'Hoàn thiện cấu hình tiêu chuẩn cho tenant hiện tại',
        'Bước 5 chỉnh màu sắc khung chat Widget ở đâu?',
      ],
      quickRepliesEn: [
        'Auto-complete current tenant with standard defaults',
        'Where do I customize the Step 5 Chat Widget?',
      ],
    },
  },
  {
    match: (p) => p === '/thruline/support-desk' || p.startsWith('/thruline/support-desk/'),
    descriptor: {
      routeId: 'thruline_support_desk',
      canonicalPath: '/thruline/support-desk',
      area: 'thruline_support',
      titleVi: 'Service Desk & Widget Studio — Bàn trực Chat/Ticket, SLA & Giao diện Widget (`/thruline/support-desk`)',
      titleEn: 'Service Desk & Chat Widget Studio (`/thruline/support-desk`)',
      purposeVi:
        'Màn hình này hội tụ **Bước 5 & Bước 6 của AI Support** cùng bàn trực vận hành thực tế: vừa là nơi **thiết kế giao diện khung Chat Widget** nhúng web (màu sắc thương hiệu, lời chào, gợi ý câu hỏi nhanh, form thu thập Tên/Email + **Live Test** chat thử ngay), vừa là **Service Desk** quản lý hộp thư khách hàng, phiếu hỗ trợ (**Tickets**), cam kết thời gian phản hồi (**SLA**) và tự động phân luồng về đúng bộ phận (*Đổi trả, Thanh toán, Kỹ thuật*).',
      purposeEn:
        'This studio combines **Steps 5 & 6 of AI Support** with live agent operations: customize your **embeddable Chat Widget** (brand colors, welcome copy, quick prompts, pre-chat intake + **Live Test** preview) and run your **Service Desk** (live conversations, prioritized **Tickets**, **SLA** timers, and keyword routing to *Returns, Billing, or Technical* teams).',
      howToUseVi:
        'Sau khi duyệt cấu hình, bạn có thể mở phần **Live Test** ngay trên trang này để đóng vai khách hàng chat thử, kiểm tra xem AI trả lời và tạo ticket chuyển nhân viên đã mượt chưa trước khi gắn lên web thật!',
      howToUseEn:
        'Use the built-in **Live Test** preview here to simulate real customer conversations, verify FAQ retrieval, and test human ticket handoffs before embedding on your live site!',
      supportConnectionVi:
        'Đội ngũ chăm sóc khách hàng hàng ngày của shop cũng có thể trực ticket và chỉnh widget tương tự ngay trong tab **Widget & Service Desk** tại `/tenant-portal`.',
      supportConnectionEn:
        'Assigned store support teams can also handle tickets and widget settings from the **Widget & Service Desk** tab inside `/tenant-portal`.',
      quickRepliesVi: [
        'Mình muốn chỉnh màu sắc & lời chào Widget cho shop',
        'Bước 7 lấy mã nhúng <script> gắn lên website ở đâu?',
      ],
      quickRepliesEn: [
        'Help me customize widget colors and welcome copy',
        'Where do I grab the Step 7 website <script> snippet?',
      ],
    },
  },
  {
    match: (p) => p === '/thruline/support-integration' || p.startsWith('/thruline/support-integration/'),
    descriptor: {
      routeId: 'thruline_support_integration',
      canonicalPath: '/thruline/support-integration',
      area: 'thruline_support',
      titleVi: 'Integration & Embed Studio — Khóa CORS, Giới hạn Runtime & Mã nhúng Web (`/thruline/support-integration`)',
      titleEn: 'Integration & Website Embed Studio (`/thruline/support-integration`)',
      purposeVi:
        'Đây là **Bước 7 (bước đưa AI lên website thật)**: nơi bạn khóa danh sách tên miền được phép nhúng widget (**Allowed Origins / CORS**), đặt giới hạn an toàn cho mỗi lượt trả lời (**Runtime Bounds** như số token tối đa, số lượt gọi công cụ), lấy **đoạn mã `<script>` 2 dòng** dán vào website và cấu hình chữ ký **`X-Support-Context-Token`** nếu muốn nhận diện khách hàng đã đăng nhập.',
      purposeEn:
        'This is **Step 7 (going live on your website)**: lock **Allowed Origins (CORS)** to your production domain, set per-turn **Runtime Bounds** (`maxCompletionTokens`, model/tool call limits), copy the **2-line `<script>` embed snippet**, and configure signed **`X-Support-Context-Token`** handshakes for logged-in users.',
      howToUseVi:
        'Khi đưa lên web thật, bạn nhớ điền đúng domain (ví dụ `https://ten-shop-cua-ban.vn`) thay cho dấu `*` để tránh trang lạ nhúng ké khóa `pk_sup_...` của bạn, rồi dán đoạn `<script>` trước thẻ `</body>` trên website là nút chat hiện lên ngay!',
      howToUseEn:
        'Before launching publicly, replace `*` in Allowed Origins with your exact production domain (e.g. `https://yourshop.com`), then paste the `<script>` snippet right before `</body>` on your site!',
      supportConnectionVi:
        'Nếu bạn chưa có tên miền riêng lúc này cũng không sao — mình có thể để chế độ thử nghiệm trước để bạn test ngay trên hệ thống, khi nào có domain khóa lại trong 1 giây!',
      supportConnectionEn:
        'No live domain yet? No problem — we can stage open testing first and lock CORS to your production URL whenever you launch!',
      quickRepliesVi: [
        'Hoàn thiện cấu hình tiêu chuẩn cho tenant hiện tại',
        'Chưa có website riêng thì có test trước được không?',
      ],
      quickRepliesEn: [
        'Auto-complete current tenant with standard defaults',
        'Can I test my AI Support bot before having a website?',
      ],
    },
  },
  {
    match: (p) => p === '/thruline/support-ops' || p.startsWith('/thruline/support-ops/'),
    descriptor: {
      routeId: 'thruline_support_ops',
      canonicalPath: '/thruline/support-ops',
      area: 'thruline_support',
      titleVi: 'Enterprise Support Operations — Kiểm toán, Đánh giá & Vận hành nâng cao (`/thruline/support-ops`)',
      titleEn: 'Enterprise Support Operations (`/thruline/support-ops`)',
      purposeVi:
        'Màn hình **Support Ops** dành cho vận hành chuyên nghiệp quy mô doanh nghiệp: theo dõi **Nhật ký kiểm toán (Audit Logs)** ai đã sửa cấu hình nào, chạy bộ kiểm thử chất lượng & triển khai thử nghiệm (**Eval & Canary**), quản lý hàng đợi **duyệt lệnh gọi Tool nhạy cảm**, cấu hình **Webhooks** sự kiện và **SSO**.',
      purposeEn:
        'The **Support Ops** studio provides enterprise governance and observability: **Audit Logs** of configuration changes, **Eval & Canary** quality suites, human **Tool Approval** queues for sensitive actions, event **Webhooks**, and **SSO** settings.',
      howToUseVi:
        'Sau khi trợ lý AI đi vào hoạt động (hoàn tất 7 bước cơ bản), bạn ghé trang này để kiểm tra chất lượng câu trả lời định kỳ, xem báo cáo tuân thủ hoặc tích hợp thông báo sang hệ thống nội bộ qua Webhook.',
      howToUseEn:
        'Once your 7-step assistant is live, use this screen to audit administrative changes, run quality regression checks, and connect operational webhooks.',
      supportConnectionVi:
        'Giúp bạn yên tâm mở rộng quy mô chăm sóc khách hàng cho nhiều thương hiệu/phòng ban với độ an toàn và minh bạch cao nhất.',
      supportConnectionEn:
        'Gives platform operators full auditability and safety controls across every business tenant.',
      quickRepliesVi: [
        'Hướng dẫn nhanh 7 bước dựng AI Support từ đầu',
        'Mình muốn dựng trợ lý AI Support cho web/shop',
      ],
      quickRepliesEn: [
        'Walk me through the 7 core AI Support setup steps',
        'Set up a complete AI Support assistant for me',
      ],
    },
  },
  {
    match: (p) => p === '/tenant-portal' || p.startsWith('/tenant-portal/'),
    descriptor: {
      routeId: 'tenant_portal',
      canonicalPath: '/tenant-portal',
      area: 'tenant_portal',
      titleVi: 'Cổng Quản trị AI Doanh nghiệp (`Tenant AI Portal` — `/tenant-portal`)',
      titleEn: 'Tenant AI Portal (`/tenant-portal`)',
      purposeVi:
        'Bạn đang ở **Tenant AI Portal** — không gian làm việc riêng biệt được thiết kế cho **từng cửa hàng, thương hiệu hoặc đội ngũ chăm sóc khách hàng** theo đúng quyền hạn (**RBAC**) được cấp.',
      purposeEn:
        'You are in the **Tenant AI Portal** — a dedicated, **RBAC-scoped workspace** built for individual businesses, storefronts, and customer-care teams to run their own AI Support assistant safely.',
      howToUseVi:
        'Tùy theo vai trò được phân quyền, bạn sẽ thấy các tab trực quan để tự chủ vận hành: **AI & Prompt** (giọng điệu & model), **Knowledge & RAG** (bài FAQ & che SĐT/email), **Tools & Data**, **Guardrails & Output** (tường lửa an toàn), **Widget & Service Desk** (trang trí khung chat & trực ticket khách hàng), **Integration & Keys** (mã `<script>` nhúng web), **Team & Permissions** và **Analytics & Audit**.',
      howToUseEn:
        'Depending on your granted permissions, you can manage **AI & Prompt**, **Knowledge & RAG** (FAQs & PII masking), **Tools & Data**, **Guardrails & Output**, **Widget & Service Desk** (branding, live chat & SLA tickets), **Integration & Keys** (`<script>` embed), **Team & Permissions**, and **Analytics & Audit** — completely isolated from platform-level provider credentials.',
      supportConnectionVi:
        'Đặc biệt nhất: ngay tại trang này, bạn không cần phải tự chỉnh tay từng tab — chỉ cần nhắn cho mình biết cửa hàng của bạn bán gì và quy định cơ bản ra sao, mình sẽ gom hết các bước bạn có quyền sửa thành 1 bản nháp gọn đẹp để bạn bấm duyệt!',
      supportConnectionEn:
        'Best of all, you do not have to configure each tab by hand — tell me about your store and policies right here in chat, and I will stage a clean preview plan scoped strictly to your permissions!',
      quickRepliesVi: [
        'Hoàn thiện cấu hình tiêu chuẩn cho tenant hiện tại',
        'Khác nhau giữa Tenant Portal và Thruline là gì?',
        'Hướng dẫn dễ hiểu 7 bước AI Support',
      ],
      quickRepliesEn: [
        'Auto-complete current tenant with standard defaults',
        'What is the difference between Tenant Portal and Thruline?',
        'Walk me through the 7 AI Support steps',
      ],
    },
  },
  {
    match: (p) => p === '/assistants' || p.startsWith('/assistants/'),
    descriptor: {
      routeId: 'personal_ai_hub',
      canonicalPath: '/assistants',
      area: 'ai_hub',
      titleVi: 'Trung tâm Trợ lý AI Cá nhân (`AI Hub` — `/assistants`)',
      titleEn: 'Personal AI Hub (`AI Hub` — `/assistants`)',
      purposeVi:
        'Bạn đang ở **AI Hub (`/assistants`)** — không gian sử dụng AI cá nhân hàng ngày để tăng năng suất làm việc (tách biệt với chatbot nhúng website cho khách ngoài). Tại đây có sẵn các trợ lý chuyên biệt về **Lập trình (Coding), Viết lách (Writing), Phân tích dữ liệu & SQL, Năng suất (Productivity)**.',
      purposeEn:
        'You are on the **Personal AI Hub (`/assistants`)** — your personal everyday AI workspace featuring specialized assistants for **Coding, Writing, Data & SQL, and Productivity**, personal custom instructions, and API key routing controls.',
      howToUseVi:
        'Bạn có thể bấm mở chat ngay với bất kỳ trợ lý chuyên môn nào, lưu **Custom Instructions** (hướng dẫn cá nhân áp dụng xuyên suốt), gán chế độ định tuyến thông minh (**Eco** siêu nhanh tiết kiệm, **Balanced** cân bằng, **Max** chất lượng tối đa) cho khóa API cá nhân và xem **Quota Coach** tư vấn hạn mức.',
      howToUseEn:
        'Open the chat drawer on any specialist assistant, save personal **Custom Instructions**, bind assistants and routing modes (**Eco**, **Balanced**, **Max Quality**) to your personal API keys, and check **Quota Coach** tips.',
      supportConnectionVi:
        'Tóm gọn dễ nhớ: **AI Hub (`/assistants`)** là trợ lý phục vụ **chính bạn và nội bộ**, còn khi bạn muốn dựng **chatbot chăm sóc khách hàng gắn lên website bán hàng/dịch vụ**, cứ nhắn ngay cho mình ở hộp thoại góc màn hình này để mình thiết lập sang khu **Tenant AI / Support** nhé!',
      supportConnectionEn:
        'In short: **AI Hub (`/assistants`)** is for **your own productivity & personal API keys**, while **AI Support (`/tenant-portal` & `/thruline/support*`)** builds **embeddable customer-service bots for your website** — and I can help you set that up right from here!',
      quickRepliesVi: [
        'Mình muốn dựng thêm chatbot AI chăm sóc khách hàng cho web/shop',
        'Tổng quan cả trang web FreeLLMAPI này làm được những gì?',
      ],
      quickRepliesEn: [
        'Help me set up a customer-facing AI Support bot for my site',
        'Give me an overview of what this whole platform does',
      ],
    },
  },
  {
    match: (p) => p === '/ai-platform' || p.startsWith('/ai-platform/'),
    descriptor: {
      routeId: 'ai_platform_admin',
      canonicalPath: '/ai-platform',
      area: 'freellmapi_dashboard',
      titleVi: 'Quản trị Nền tảng AI (`AI Platform` — `/ai-platform`)',
      titleEn: 'AI Platform Orchestration (`/ai-platform`)',
      purposeVi:
        'Trang **AI Platform** dành cho quản trị viên điều phối tầng thông minh của hệ thống: quản lý Semantic Response Cache toàn cục, ngân sách ngữ cảnh (Context Budget), đánh giá Prompt/A-B testing và cờ tính năng AI.',
      purposeEn:
        'The **AI Platform** console manages global orchestration features including Semantic Response Cache, Context Budgets, Prompt Evaluation / A-B experiments, and AI feature flags.',
      howToUseVi:
        'Bật/tắt các chính sách tối ưu hóa và theo dõi chỉ số chất lượng phản hồi trên toàn nền tảng.',
      howToUseEn:
        'Configure platform-wide caching, context budgets, and prompt evaluation benchmarks here.',
      supportConnectionVi:
        'Để thiết lập riêng từng trợ lý chăm sóc khách hàng nhúng website, bạn dùng **Tenant AI Portal** (`/tenant-portal`), **Thruline Support** (`/thruline/support`) hoặc chat trực tiếp với mình nhé!',
      supportConnectionEn:
        'For per-business website support bots, use **Tenant AI Portal** (`/tenant-portal`), **Thruline Support** (`/thruline/support`), or chat directly with me!',
      quickRepliesVi: ['Mình muốn dựng trợ lý AI Support cho web/shop'],
      quickRepliesEn: ['Set up a complete AI Support assistant for me'],
    },
  },
  {
    match: (p) => p === '/keys' || p.startsWith('/keys/'),
    descriptor: {
      routeId: 'freellmapi_keys',
      canonicalPath: '/keys',
      area: 'freellmapi_dashboard',
      titleVi: 'Quản lý Khóa API & Cổng Hợp nhất (`Keys` — `/keys`)',
      titleEn: 'Provider Keys & Unified Gateway Key (`Keys` — `/keys`)',
      purposeVi:
        'Trang **Keys** trên bảng điều khiển chính **FreeLLMAPI** là nơi quản lý các API key nhà cung cấp, nguồn miễn phí (keyless) và lấy **Unified API Key** để gọi cổng `/v1/*` (chuẩn OpenAI) hoặc `/v1beta/*` (chuẩn Gemini).',
      purposeEn:
        'The **Keys** page on the main **FreeLLMAPI** dashboard manages upstream provider keys, keyless free-tier sources, and your **Unified Gateway API Key** for `/v1/*` and `/v1beta/*` endpoints.',
      howToUseVi:
        'Thêm key nhà cung cấp hoặc bật nguồn miễn phí tại đây, sau đó dùng Unified Key để gọi tự động qua danh sách model ở tab **Models**.',
      howToUseEn:
        'Add upstream keys or enable free-tier providers here, then use your Unified Key against `/v1/chat/completions`.',
      supportConnectionVi:
        'Các nguồn model bật tại đây cũng giúp nuôi luồng hội thoại thông minh cho toàn hệ thống và trợ lý Setup Copilot!',
      supportConnectionEn:
        'Enabled routes here power `/v1/chat/completions` as well as live AI coaching across the platform.',
      quickRepliesVi: [
        'Khác nhau giữa FreeLLMAPI, Thruline và Tenant Portal?',
        'Mình muốn dựng trợ lý AI Support cho web/shop',
      ],
      quickRepliesEn: [
        'How do FreeLLMAPI, Thruline, and Tenant Portal fit together?',
        'Set up a complete AI Support assistant for me',
      ],
    },
  },
  {
    match: (p) => p === '/' || p === '/models' || p.startsWith('/models/'),
    descriptor: {
      routeId: 'freellmapi_models',
      canonicalPath: '/models/chat',
      area: 'freellmapi_dashboard',
      titleVi: 'Danh mục Model Đa phương thức & Chuỗi Dự phòng (`Models` — `/models/*`)',
      titleEn: 'Multimodal Models & Fallback Chain (`Models` — `/models/*`)',
      purposeVi:
        'Khu vực **Models** trên FreeLLMAPI quản lý danh sách model và thứ tự ưu tiên dự phòng (Fallback) cho đầy đủ các tác vụ: Chat, Fusion, Embeddings, Image, Video, Audio, Search và Decision.',
      purposeEn:
        'The **Models** workspace configures priority ordering and automatic fallback across Chat, Fusion, Embeddings, Image, Video, Audio, Search, and Decision modalities.',
      howToUseVi:
        'Kéo thả sắp xếp thứ tự ưu tiên model hoặc bật/tắt từng model để cổng `/v1/*` tự động chọn model tốt nhất đang rảnh.',
      howToUseEn:
        'Reorder or toggle models so `auto` requests hit your highest-priority healthy models first.',
      supportConnectionVi:
        'Nếu bạn muốn dựng chatbot chăm sóc khách hàng nhúng lên website riêng, hãy chuyển sang **Thruline Support** (`/thruline/support`) hoặc **Tenant AI** (`/tenant-portal`) nhé!',
      supportConnectionEn:
        'To build an embeddable customer-support chatbot for your website, head to **Thruline Support** (`/thruline/support`) or **Tenant AI** (`/tenant-portal`)!',
      quickRepliesVi: ['Tổng quan web này làm được những gì?'],
      quickRepliesEn: ['What does this whole platform do?'],
    },
  },
  {
    match: (p) =>
      p === '/users' ||
      p.startsWith('/users/') ||
      p === '/invites' ||
      p.startsWith('/invites/'),
    descriptor: {
      routeId: 'freellmapi_users_invites',
      canonicalPath: '/users',
      area: 'freellmapi_dashboard',
      titleVi: 'Quản lý Thành viên, Mã mời & Phân quyền RBAC (`/users` & `/invites`)',
      titleEn: 'Users, Invite Codes & Multi-Tenant RBAC (`/users` & `/invites`)',
      purposeVi:
        'Khu vực quản trị thành viên giúp bạn tạo mã mời đăng ký (**Invites**), cấp quyền chi tiết từng tính năng trên hệ thống và gán nhân sự vào từng **Support Tenant** với vai trò cụ thể (như *Tenant Admin, AI Configurator, Support Agent, Viewer*).',
      purposeEn:
        'Manage **Invite Codes**, multi-user platform permissions, and per-tenant **Tenant AI** role assignments (*Tenant Admin, AI Configurator, Support Agent, Viewer*).',
      howToUseVi:
        'Sau khi gán tài khoản nhân viên vào một Support Tenant tại đây, nhân viên đó đăng nhập sẽ thấy ngay mục **Tenant AI (`/tenant-portal`)** để làm việc đúng trong phạm vi được giao.',
      howToUseEn:
        'Assigning a team member to a Support Tenant here gives them instant scoped access to **Tenant AI (`/tenant-portal`)**.',
      supportConnectionVi:
        'Giúp tách bạch an toàn quyền quản trị hạ tầng AI và quyền vận hành chăm sóc khách hàng của từng shop/phòng ban.',
      supportConnectionEn:
        'Cleanly separates platform-level gateway administration from day-to-day store support operations.',
      quickRepliesVi: ['Tenant Portal dùng như thế nào?'],
      quickRepliesEn: ['How does the Tenant AI Portal work?'],
    },
  },
  {
    match: (p) =>
      p === '/analytics' ||
      p.startsWith('/analytics/') ||
      p === '/usage' ||
      p.startsWith('/usage/') ||
      p === '/logs' ||
      p.startsWith('/logs/') ||
      p === '/audit' ||
      p.startsWith('/audit/') ||
      p === '/agents' ||
      p.startsWith('/agents/') ||
      p === '/premium' ||
      p.startsWith('/premium/'),
    descriptor: {
      routeId: 'freellmapi_observability',
      canonicalPath: '/analytics',
      area: 'freellmapi_dashboard',
      titleVi: 'Bảng điều khiển Phân tích, Nhật ký & Tích hợp FreeLLMAPI',
      titleEn: 'FreeLLMAPI Analytics, Audit Logs & Integrations',
      purposeVi:
        'Các màn hình quản trị trên thanh điều hướng chính **FreeLLMAPI** giúp bạn theo dõi biểu đồ lưu lượng token (**Analytics / Usage**), tra cứu lịch sử gọi API (**Logs**), nhật ký bảo mật (**Audit / History**) và hướng dẫn tích hợp Agent.',
      purposeEn:
        'These main **FreeLLMAPI** dashboard views surface gateway traffic charts (**Analytics / Usage**), request histories (**Logs**), security trails (**Audit**), and SDK/Agent guides.',
      howToUseVi:
        'Bạn có thể chuyển nhanh sang giao diện **Thruline** ở nút góc trên bên trái hoặc mở **Tenant AI** trên thanh menu bất cứ lúc nào.',
      howToUseEn:
        'Use the top-left **Thruline** switch or the **Tenant AI** / **AI Hub** tabs in the top bar anytime to move between workspaces.',
      supportConnectionVi:
        'Mọi dữ liệu vận hành đều đồng bộ giúp bạn kiểm soát chặt chẽ cả cổng API lẫn hệ thống AI chăm sóc khách hàng.',
      supportConnectionEn:
        'Keeps both developer API traffic and customer AI workloads observable from one unified platform.',
      quickRepliesVi: ['Tổng quan web này làm được những gì?'],
      quickRepliesEn: ['What does this whole platform do?'],
    },
  },
];

/**
 * Maps a live client pathname (e.g. `/thruline/providers`, `/thruline/combos`, `/tenant-portal`,
 * `/assistants`, etc.) to an accurate, practical product-specialist guide for that exact screen.
 */
/** Read-only view of the curated route catalog (used by the Setup Copilot knowledge base). */
export function listPlatformRouteDescriptors(): Array<Omit<PlatformRouteDescriptor, 'normalizedPath'>> {
  return ROUTE_CATALOG.map((entry) => entry.descriptor);
}

export function describePlatformRoute(
  currentPath: string | undefined | null,
  _locale: 'vi' | 'en' = 'vi',
): PlatformRouteDescriptor | null {
  const normalized = normalizePlatformPath(currentPath);
  if (!normalized) return null;

  for (const entry of ROUTE_CATALOG) {
    if (entry.match(normalized)) {
      return {
        ...entry.descriptor,
        normalizedPath: normalized,
      };
    }
  }

  if (normalized.startsWith('/thruline/')) {
    return {
      routeId: 'thruline_general',
      canonicalPath: normalized,
      normalizedPath: normalized,
      area: 'thruline_gateway',
      titleVi: `Phân khu Điều hành Thruline (\`${normalized}\`)`,
      titleEn: `Thruline Console (\`${normalized}\`)`,
      purposeVi:
        'Bạn đang ở trong không gian **Thruline Console** — trung tâm quản lý đa tài khoản AI (Providers, Combos, Token Savers, CLI Tools, Translator) và bộ **7 Studio AI Support** xây dựng trợ lý chăm sóc khách hàng nhúng website.',
      purposeEn:
        'You are inside the **Thruline Console** — the operational workspace for multi-account AI routing (Providers, Combos, Token Savers, CLI Tools, Translator) and the **7 Customer Support AI Studios**.',
      howToUseVi:
        'Dùng thanh điều hướng bên trái (hoặc phím tắt `Ctrl+K` / `⌘K`) để chuyển nhanh giữa các phân khu kết nối tài khoản, tối ưu định tuyến và thiết lập AI Support.',
      howToUseEn:
        'Use the left navigation rail (or press `Ctrl+K` / `⌘K`) to jump between provider accounts, smart routing studios, and AI Support configuration.',
      supportConnectionVi:
        'Bạn có thể nhắn ngay tại hộp thoại này để nhờ mình giải thích bất kỳ mục nào hoặc lên bản nháp cấu hình AI Support trọn gói nhé!',
      supportConnectionEn:
        'Ask me right here anytime to explain any studio or draft a complete AI Support setup plan for your review!',
      quickRepliesVi: [
        'Web này dùng để làm gì?',
        'Mình muốn dựng trợ lý AI Support cho web/shop',
      ],
      quickRepliesEn: [
        'What does this website do?',
        'Set up a complete AI Support assistant for me',
      ],
    };
  }

  return null;
}

/**
 * Builds the concise platform & current-screen block injected into `buildHumanCoachSystemPrompt`
 * so live LLMs answer both holistic platform questions and current-page questions accurately.
 */
export function buildPlatformPromptSection(
  currentPath: string | undefined | null,
  locale: 'vi' | 'en',
): string {
  const routeInfo = describePlatformRoute(currentPath, locale);
  const currentScreenBlock = routeInfo
    ? locale === 'vi'
      ? [
          `MÀN HÌNH NGƯỜI DÙNG ĐANG MỞ HIỆN TẠI (currentPath = "${routeInfo.normalizedPath}"):`,
          `- Tên màn hình: ${routeInfo.titleVi}`,
          `- Chức năng chính: ${routeInfo.purposeVi}`,
          `- Cách sử dụng thực tế: ${routeInfo.howToUseVi}`,
          `- Liên hệ với AI Support: ${routeInfo.supportConnectionVi}`,
        ].join('\n')
      : [
          `USER'S CURRENT OPEN SCREEN (currentPath = "${routeInfo.normalizedPath}"):`,
          `- Screen: ${routeInfo.titleEn}`,
          `- Core purpose: ${routeInfo.purposeEn}`,
          `- Practical usage: ${routeInfo.howToUseEn}`,
          `- How it relates to AI Support: ${routeInfo.supportConnectionEn}`,
        ].join('\n')
    : `USER'S CURRENT OPEN SCREEN: ${currentPath ? `"${normalizePlatformPath(currentPath)}"` : 'not specified'}.`;

  const routingRule =
    locale === 'vi'
      ? [
          'QUY TẮC CHUYÊN GIA NỀN TẢNG & TRANG HIỆN TẠI (RẤT QUAN TRỌNG):',
          '- Nếu khách hỏi **trang web / hệ thống / nền tảng này làm gì** ("web này làm gì", "trang web này dùng để làm gì", "FreeLLMAPI / Thruline / Tenant Portal là gì") HOẶC hỏi **trang / màn hình / mục đang mở để làm gì** ("trang này làm gì", "mục này dùng sao", "làm sao lấy API key / thêm provider / tạo combo"):',
          '  + BẮT BUỘC đặt `"intent": "guide"`, `"missingQuestions": []`, KHÔNG điền bừa `extractedRequirements`! Trả lời mượt mà, ấm áp, rõ ràng như một chuyên gia sản phẩm thực thụ dựa trên kiến thức nền tảng & màn hình hiện tại ở trên.',
          '- **PHÂN BIỆT RÕ VỚI WEB RIÊNG CỦA KHÁCH**: Nếu khách nói *"tôi đang có web boardgame, và muốn setup"*, *"web của mình bán giày/mỹ phẩm"* -> đó là **website kinh doanh của khách** (KHÔNG phải hỏi FreeLLMAPI làm gì!), hãy xử lý theo luồng tư vấn ngành nghề & thiết lập AI Support cho khách.',
        ].join('\n')
      : [
          'PLATFORM & CURRENT-SCREEN SPECIALIST RULE (CRITICAL):',
          '- Whenever the user asks **what this website / platform / FreeLLMAPI / Thruline / Tenant Portal does** OR **what the current page / screen / tab is for** (or how to add providers, get API keys, build combos, use token savers, etc.):',
          '  + MUST set `"intent": "guide"` and `"missingQuestions": []` (do NOT pollute `extractedRequirements` or dump setup forms). Answer warmly, fluently, and accurately like a senior product specialist using the exact platform & current-screen knowledge above.',
          '- **DISTINGUISH USER BUSINESS WEBSITES**: When the user talks about *their own* website or store (e.g. *"I have a boardgame website and want to set up"*, *"my website sells cosmetics"*), treat that as their business context — NOT a question about what FreeLLMAPI does!',
        ].join('\n');

  return [PLATFORM_EXPERT_KNOWLEDGE, '', currentScreenBlock, '', routingRule].join('\n');
}

// ---------------------------------------------------------------------------
// Intent Detector: Platform / Current-Page / Feature Questions vs User Business
// ---------------------------------------------------------------------------

// User talking about THEIR OWN customer website, store, business, or widget embed target
const USER_OWN_BUSINESS_ASCII_RE =
  /\b(?:(?:web(?:site)?|trang\s+web|shop|cua\s+hang|tiem|quan|cong\s+ty|doanh\s+nghiep|du\s+an|ung\s+dung|app|he\s+thong|nen\s+tang|san\s+pham|dich\s+vu)\s+(?:(?:nay|hien\s+tai|moi)\s+)?(?:cua\s+|ben\s+)(?:toi|minh|em|anh|chi|chung\s+toi|chung\s+minh|nha\s+minh|shop|cong\s+ty)|(?:ben\s+(?:minh|toi|em|anh|chi)|cua\s+(?:minh|toi|em|anh|chi)|nha\s+minh|shop\s+(?:minh|toi|em)|cong\s+ty\s+(?:minh|toi|em))\s+(?:dang\s+|moi\s+|vua\s+|sap\s+|chuyen\s+|cung\s+)*(?:ban|kinh\s+doanh|buon\s+ban|cho\s+thue|cung\s+cap|san\s+xuat|gia\s+cong|day|lam|mo|xay|xay\s+dung|phat\s+trien|quan\s+ly|van\s+hanh)\b|(?:toi|minh|em|anh|chi|ben\s+minh|ben\s+toi|nha\s+minh|chung\s+toi|chung\s+minh)\s+(?:dang\s+|moi\s+|vua\s+|sap\s+|cung\s+)*(?:co|lam|mo|xay|xay\s+dung|phat\s+trien|quan\s+ly|van\s+hanh|kinh\s+doanh|ban|chuyen)\s+(?:1\s+|mot\s+)?(?:trang\s+web|website|web|shop|cua\s+hang|tiem|quan|studio|phong\s+kham|phong\s+tap|trung\s+tam|hoc\s+vien|ung\s+dung|app|dich\s+vu|thuong\s+hieu))\b/i;

const USER_OWN_BUSINESS_EN_RE =
  /\b(?:(?:my|our)\s+(?:own\s+|new\s+|current\s+|online\s+|e-?commerce\s+|customer\s+)?(?:website|web\s+app|site|shop|store|business|company|studio|clinic|cafe|bakery|app|platform)|(?:i|we)\s+(?:have|run|own|manage|operate|built|started|launched|sell|offer|are\s+building|are\s+launching)\s+(?:a|an|my|our)\b)/i;

// Pure second-person Copilot capability questions ("bạn có thể làm gì mà", "what can you do")
const PURE_COPILOT_CAPABILITY_ASCII_RE =
  /^(?:(?:da|oi|nay|ban\s+oi)\s*,?\s*)?(?:ban|may|em|ai|ad|cau)\s+(?:thuc\s+su\s+|that\s+su\s+|rot\s+cuoc\s+)?(?:co\s+the|biet|lam\s+duoc|giup\s+duoc|ho\s+tro\s+duoc|la\s+ai|giup\s+gi|lam\s+gi)|^chuc\s+nang\s+cua\s+(?:ban|em)\b|^(?:who\s+are\s+you|what\s+can\s+you\s+(?:actually\s+)?do|how\s+can\s+you\s+help|what\s+do\s+you\s+do)\b/i;

// Named platform brands/modules that explicitly indicate a platform question even in longer sentences
const EXPLICIT_PLATFORM_NAME_ASCII_RE =
  /\b(?:freellmapi|free\s*llm\s*api|thruline|tenant\s*(?:ai\s*)?portal|personal\s+ai\s+hub|token\s*savers?|agentic\s*compactor|protocol\s*translator|skills?\s*hub|cli\s*tools?)\b/i;

// Retail/F&B product-bundle context where "combo" means a shop bundle rather than Thruline Combos
const RETAIL_BUNDLE_COMBO_ASCII_RE =
  /\b(?:combo\s+(?:giam\s+gia|uu\s+dai|khuyen\s+mai|skincare|my\s+pham|an\s+sang|trua|toi|do\s+uong|tam\s+say|grooming|chup\s+anh|\d+\s*k|\d+\s*nghin)|(?:ban|mua|tang|uu\s+dai|gia)\s+combo|freeship|doi\s+tra\s+\d+\s+ngay)\b/i;

const WIDGET_EMBED_STEP_ASCII_RE =
  /\b(?:nhung\s+(?:widget|khung\s+chat|nut\s+chat|chatbot|ma\s+script)|gan\s+(?:widget|khung\s+chat|nut\s+chat|chatbot)\s+(?:len|vao)\s+(?:web|trang\s+web)|embed\s+(?:the\s+)?(?:widget|chat|snippet)|cors\s+origins?)\b/i;

// 1. Workspace comparison ("khác nhau giữa thruline và tenant portal", "difference between thruline and tenant portal")
const WORKSPACE_COMPARISON_ASCII_RE =
  /\b(?:(?:khac\s+nhau|khac\s+gi|phan\s+biet|so\s+sanh)\b.*\b(?:thruline|freellmapi|tenant\s*(?:ai\s*)?portal|ai\s*hub)\b|(?:thruline|freellmapi|tenant\s*(?:ai\s*)?portal|ai\s*hub)\b.*\b(?:khac\s+gi|khac\s+nhau|phan\s+biet\s+voi)\b|(?:difference\s+between|compare|how\s+does\s+.*\s+differ\s+from)\b.*\b(?:thruline|freellmapi|tenant\s*(?:ai\s*)?portal|ai\s*hub)\b|\b(?:thruline|tenant\s*(?:ai\s*)?portal)\s+(?:vs\.?|versus)\s+(?:thruline|freellmapi|tenant\s*(?:ai\s*)?portal|ai\s*hub)\b)/i;

// 2. Deictic current-page / current-screen / current-tab questions ("trang này làm gì", "mục này để làm gì", "chỗ này là gì", "what is this page for")
// Note: `trang\s+(?!web\b)` matches "trang này" (this page) without stealing "trang web này" (this website)!
const CURRENT_PAGE_ASCII_RE =
  /\b(?:(?:trang\s+(?!web\b)|man\s+hinh\s+|muc\s+|tab\s+|studio\s+|khu\s+vuc\s+|phan\s+|cho\s+)(?:(?:dang\s+mo|hien\s+tai)\s+)?(?:nay|hien\s+tai|dang\s+mo)\b[^,;.!?]{0,45}?(?<!\b(?:ban|may|em|ad|cau)\s+(?:co\s+the\s+)?)\b(?:lam\s+(?:duoc\s+)?(?:nhung\s+)?gi|la\s+(?:cai\s+)?(?:gi|sao)|de\s+lam\s+gi|dung\s+(?:de(?:\s+lam\s+gi)?|lam\s+gi|sao|ra\s+sao|kieu\s+gi|the\s+nao|nhu\s+the\s+nao)|xai\s+(?:sao|kieu\s+gi|the\s+nao)|co\s+(?:tac\s+dung|chuc\s+nang|tinh\s+nang|nhung\s+gi)|chinh\s+(?:nhung\s+)?gi|cai\s+(?:dat\s+)?gi|hoat\s+dong\s+(?:ra\s+sao|sao|kieu\s+gi|the\s+nao|nhu\s+the\s+nao)|huong\s+dan|cach\s+dung)\b|day\s+la\s+(?:trang\s+(?!web\b)|man\s+hinh\s+|muc\s+|tab\s+|studio\s+|cho\s+)(?:gi|nao)\b|(?:cach\s+(?:dung|su\s+dung|xai)|huong\s+dan(?:\s+dung|\s+su\s+dung)?|gioi\s+thieu(?:\s+ve)?|giai\s+thich(?:\s+ve)?)\s+(?:trang\s+(?!web\b)|man\s+hinh\s+|muc\s+|tab\s+|studio\s+|cho\s+)(?:(?:dang\s+mo|hien\s+tai)\s+)?(?:nay|hien\s+tai|dang\s+mo)\b|(?:o|tren|tai)\s+(?:trang\s+(?!web\b)|man\s+hinh\s+|muc\s+|tab\s+|cho\s+)(?:(?:dang\s+mo|hien\s+tai)\s+)?(?:nay|hien\s+tai|dang\s+mo)\b[^,;.!?]{0,35}?\b(?:lam\s+(?:duoc\s+)?gi|chinh\s+gi|dung\s+(?:sao|kieu\s+gi|the\s+nao)|co\s+gi)\b|what\s+(?:is|does)\s+this\s+(?:current\s+|open\s+|active\s+)?(?:page|screen|tab|section|studio|view)(?:\s+(?:do|for|mean|about|used\s+for))?\b|what\s+is\s+(?:on\s+)?this\s+(?:current\s+|open\s+|active\s+)?(?:page|screen|tab|section|studio|view)(?:\s+used\s+for)?\b|how\s+(?:do\s+i|to|can\s+i|does)\s+(?:use\s+)?this\s+(?:current\s+|open\s+|active\s+)?(?:page|screen|tab|section|studio|view)(?:\s+work)?\b|(?:explain|walk\s+me\s+through|guide\s+me\s+on)\s+this\s+(?:current\s+|open\s+|active\s+)?(?:page|screen|tab|section|studio|view)\b|what\s+can\s+i\s+(?:do|configure|manage)\s+(?:on|in)\s+this\s+(?:current\s+|open\s+|active\s+)?(?:page|screen|tab|studio)\b)/i;

// 3. Practical platform feature & how-to matchers
const HOWTO_PROVIDERS_KEYS_ASCII_RE =
  /\b(?:(?:lam\s+sao|cach|huong\s+dan|o\s+dau|cho\s+nao|muon|chi\s+(?:minh|toi))\b.*\b(?:lay\s+api\s*keys?|tao\s+api\s*keys?|xem\s+api\s*keys?|them\s+(?:api\s*keys?|provider\s*keys?|providers?|nha\s+cung\s+cap\s+ai|tai\s+khoan\s+(?:ai|oauth|provider|claude|gemini|openai|gpt|qwen|kiro|codex))|ket\s+noi\s+(?:providers?|nha\s+cung\s+cap|oauth|tai\s+khoan\s+(?:ai|oauth|claude|gemini|openai|qwen|kiro)))|(?:lay\s+api\s*keys?|tao\s+api\s*keys?|them\s+(?:api\s*keys?|providers?|tai\s+khoan\s+ai)|ket\s+noi\s+(?:providers?|oauth|tai\s+khoan\s+ai))\s+(?:o\s+dau|cho\s+nao|nhu\s+the\s+nao|lam\s+sao|the\s+nao|sao)\b|(?:muc\s+|trang\s+|tab\s+)?providers?\s+(?:la\s+gi|lam\s+gi|de\s+lam\s+gi|dung\s+(?:de|sao|the\s+nao))\b|(?:how\s+(?:do\s+i|to|can\s+i)|where\s+(?:do\s+i|to|can\s+i))\s+(?:get|create|generate|find|add|connect|configure)\s+(?:an?\s+|my\s+|new\s+|upstream\s+|provider\s+|gateway\s+|oauth\s+)*(?:api\s+keys?|provider\s+keys?|providers?|oauth\s+accounts?|ai\s+accounts?)\b|what\s+(?:is|are|does)\s+(?:the\s+)?providers?(?:\s+(?:page|tab|section|studio|in\s+thruline))?(?:\s+(?:do|for|used\s+for))?\b)/i;

const HOWTO_COMBOS_ASCII_RE =
  /\b(?:(?:combos?|chuoi\s+model)\s+(?:trong\s+thruline\s+)?(?:la\s+gi|lam\s+gi|de\s+lam\s+gi|dung\s+(?:de(?:\s+lam\s+gi)?|sao|the\s+nao|nhu\s+the\s+nao)|hoat\s+dong\s+(?:sao|the\s+nao|nhu\s+the\s+nao)|co\s+(?:tac\s+dung|chuc\s+nang)\s+gi)\b|(?:lam\s+sao|cach|huong\s+dan|muon)\s+(?:de\s+)?(?:tao|them|dung|cau\s+hinh|thiet\s+lap|ghep)\s+combos?(?:\s+model)?\b|(?:tao|ghep)\s+combos?\s+(?:model\s+)?(?:o\s+dau|lam\s+sao|nhu\s+the\s+nao|the\s+nao)\b|what\s+(?:is|are|does)\s+(?:a\s+|the\s+|model\s+|thruline\s+)?combos?(?:\s+(?:page|tab|do|for|used\s+for))?\b|how\s+(?:do\s+i|to|can\s+i|do)\s+(?:create|add|build|set\s+up|use|configure)?\s*(?:model\s+|thruline\s+)?combos?(?:\s+work)?\b)/i;

const HOWTO_TOKEN_SAVERS_ASCII_RE =
  /\b(?:(?:token\s*savers?|agentic\s*(?:token\s*)?compactor)\b|(?:tiet\s+kiem\s+token|nen\s+token|nen\s+lich\s+su\s+chat)\s+(?:la\s+gi|o\s+dau|lam\s+sao|hoat\s+dong\s+(?:sao|the\s+nao)))\b/i;

const HOWTO_CLI_SKILLS_ASCII_RE =
  /\b(?:cli\s*tools?|skills?\s*hub|(?:muc|trang|tab)\s+(?:tools|cli\s*tools|skills)\b|(?:skills?|cli\s*tools?)\s+(?:trong\s+thruline\s+)?(?:la\s+gi|de\s+lam\s+gi|dung\s+(?:de(?:\s+lam\s+gi)?|sao|kieu\s+gi|the\s+nao))\b|(?:lam\s+sao|cach|huong\s+dan|how\s+to|how\s+do\s+i)\b.*\b(?:ket\s+noi|cau\s+hinh|cai\s+dat|connect|configure|set\s+up)\s+(?:claude\s+code|codex|cursor|cline|roo\s+code|opencode|aider)\b|(?:ket\s+noi|cau\s+hinh|cai\s+dat|thiet\s+lap|dung|tich\s+hop)\s+(?:claude\s+code|codex|cursor|cline|roo\s+code|opencode|aider)\b.*\b(?:kieu\s+gi|the\s+nao|nhu\s+the\s+nao|ra\s+sao|lam\s+sao|sao|o\s+dau|cho\s+nao)\b)/i;

const HOWTO_TRANSLATOR_ASCII_RE =
  /\b(?:protocol\s*translator|bo\s+chuyen\s+doi\s+giao\s+thuc|(?:muc|trang|tab)\s+translator\b|translator\s+(?:trong\s+thruline\s+)?(?:la\s+gi|lam\s+gi|de\s+lam\s+gi|dung\s+(?:de|sao)|what\s+is)|what\s+(?:is|does)\s+(?:the\s+)?(?:protocol\s+)?translator\b)/i;

const HOWTO_QUOTA_USAGE_ASCII_RE =
  /\b(?:(?:muc|trang|tab)\s+(?:quota|usage|account\s+usage)\b.*\b(?:la\s+gi|lam\s+gi|de\s+lam\s+gi|dung\s+sao|what\s+is)|(?:xem|kiem\s+tra|theo\s+doi)\s+(?:quota|han\s+muc(?:\s+tai\s+khoan)?|luu\s+luong\s+token|account\s+usage)\s+(?:o\s+dau|cho\s+nao|lam\s+sao|the\s+nao)\b|where\s+(?:do\s+i|can\s+i|to)\s+(?:check|view|monitor)\s+(?:account\s+)?(?:quota|rate\s+limits?|token\s+usage)\b)/i;

// 4. Named workspace questions (Thruline, Tenant Portal, AI Hub)
const THRULINE_OVERVIEW_ASCII_RE =
  /\b(?:thruline\b.*\b(?:la\s+(?:cai\s+)?gi|lam\s+(?:duoc\s+)?gi|de\s+lam\s+gi|dung\s+(?:de(?:\s+lam\s+gi)?|sao|kieu\s+gi|the\s+nao|nhu\s+the\s+nao)|co\s+(?:tac\s+dung|chuc\s+nang|tinh\s+nang|nhung\s+gi)|hoat\s+dong\s+(?:ra\s+sao|sao|kieu\s+gi|the\s+nao|nhu\s+the\s+nao))|(?:gioi\s+thieu|giai\s+thich|tim\s+hieu)\s+(?:ve\s+)?thruline\b|what\s+(?:is|does)\s+thruline(?:\s+(?:console|gateway|do|for|used\s+for))?\b|(?:explain|tell\s+me\s+about)\s+thruline\b|how\s+does\s+thruline\s+work\b)/i;

const TENANT_PORTAL_OVERVIEW_ASCII_RE =
  /\b(?:(?:tenant\s*(?:ai\s*)?portal|cong\s+tenant(?:\s+ai)?)\b.*\b(?:la\s+(?:cai\s+)?gi|lam\s+gi|de\s+lam\s+gi|dung\s+(?:de(?:\s+lam\s+gi)?|sao|kieu\s+gi|the\s+nao)|co\s+(?:tac\s+dung|chuc\s+nang)\s+gi)|(?:gioi\s+thieu|giai\s+thich|what\s+(?:is|does)|explain|tell\s+me\s+about)\s+(?:ve\s+|the\s+)?tenant\s*(?:ai\s*)?portal\b)/i;

const AI_HUB_OVERVIEW_ASCII_RE =
  /\b(?:(?:personal\s+ai\s+hub|ai\s+hub|(?:trang|muc|tab)\s+assistants|assistants)\s+(?:la\s+(?:cai\s+)?gi|lam\s+gi|de\s+lam\s+gi|dung\s+(?:de(?:\s+lam\s+gi)?|sao|kieu\s+gi|the\s+nao))\b|(?:gioi\s+thieu|giai\s+thich|what\s+(?:is|does)|explain|tell\s+me\s+about)\s+(?:ve\s+|the\s+)?(?:personal\s+)?ai\s+hub\b|what\s+(?:is|does)\s+(?:the\s+)?assistants\s+(?:page|tab|hub)\b)/i;

// 5. Holistic website / system / platform / FreeLLMAPI overview questions
const PLATFORM_OVERVIEW_ASCII_RE =
  /\b(?:(?:trang\s+web|website|web|he\s+thong|ung\s+dung|nen\s+tang|phan\s+mem|cong\s+cu|du\s+an|project|app|portal)\s+(?:nay|dang\s+mo|hien\s+tai)\b[^,;.!?]{0,40}?(?<!\b(?:ban|may|em|ad|cau)\s+(?:co\s+the\s+)?)\b(?:lam\s+(?:duoc\s+)?(?:nhung\s+)?gi|la\s+(?:cai\s+)?(?:gi|sao)|de\s+lam\s+gi|dung\s+(?:de(?:\s+lam\s+gi)?|lam\s+gi|sao|kieu\s+gi|nhu\s+the\s+nao|the\s+nao)|phuc\s+vu\s+(?:cho\s+)?(?:viec\s+)?gi|co\s+(?:tac\s+dung|chuc\s+nang|tinh\s+nang|nhung\s+gi)|giup\s+(?:duoc\s+|ich\s+)?gi|hoat\s+dong\s+(?:ra\s+sao|sao|kieu\s+gi|the\s+nao|nhu\s+the\s+nao))\b|day\s+la\s+(?:trang\s+web|website|web|he\s+thong|ung\s+dung|nen\s+tang|app)\s+(?:gi|nao)\b|(?:gioi\s+thieu|giai\s+thich|tom\s+tat|review|cho\s+(?:toi|minh|em)\s+(?:hoi|biet))\s+(?:so\s+qua\s+|nhanh\s+|chi\s+tiet\s+|ngan\s+gon\s+)?(?:ve\s+)?(?:trang\s+web|website|web|he\s+thong|ung\s+dung|nen\s+tang|app)\s+(?:nay|hien\s+tai|dang\s+mo)\b|(?:freellmapi|free\s*llm\s*api)\b.*\b(?:la\s+(?:cai\s+)?gi|lam\s+(?:duoc\s+)?gi|de\s+lam\s+gi|dung\s+(?:de(?:\s+lam\s+gi)?|sao|kieu\s+gi|the\s+nao)|co\s+(?:tac\s+dung|chuc\s+nang|tinh\s+nang)|hoat\s+dong\s*(?:ra\s+sao|sao|the\s+nao|nhu\s+the\s+nao)?)\b|(?:gioi\s+thieu|giai\s+thich|tim\s+hieu)\s+(?:ve\s+)?(?:freellmapi|free\s*llm\s*api)\b|what\s+(?:is|does)\s+this\s+(?:website|web\s*app|site|platform|system|application|app|project)(?:\s+(?:do|for|used\s+for|all\s+about|about|mean))?\b|what\s+is\s+this\s+(?:website|web\s*app|site|platform|system|application|app)\s+used\s+for\b|(?:tell\s+me\s+about|explain(?:\s+what)?|overview\s+of|introduce)\s+this\s+(?:website|web\s*app|site|platform|system|app)\b|what\s+(?:is|does)\s+(?:freellmapi|free\s*llm\s*api)(?:\s+(?:do|for|used\s+for))?\b|how\s+does\s+(?:freellmapi|free\s*llm\s*api)\s+work\b|tell\s+me\s+about\s+(?:freellmapi|free\s*llm\s*api)\b)/i;

/**
 * Detects whether a user message is asking about this platform/website (`FreeLLMAPI` / `Thruline` /
 * `Tenant Portal` / `AI Hub`), the current screen (`currentPath`), or a core platform feature —
 * while strictly avoiding false positives when the user describes *their own* business website!
 */
export function matchPlatformKnowledgeQuestion(
  text: string,
  currentPath?: string | null,
): PlatformQuestionMatch | null {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 360) return null;

  const ascii = foldVietnameseAscii(trimmed);
  if (!ascii) return null;

  const namesPlatformExplicitly = EXPLICIT_PLATFORM_NAME_ASCII_RE.test(ascii);

  // Guard 1: User describing their own business website/shop/store (e.g. "tôi đang có web boardgame, và muốn setup", "web của tôi bán giày")
  if (
    !namesPlatformExplicitly &&
    (USER_OWN_BUSINESS_ASCII_RE.test(ascii) || USER_OWN_BUSINESS_EN_RE.test(trimmed))
  ) {
    return null;
  }

  // Guard 2: Step 7 widget embed questions ("nhúng widget lên web làm sao", "how to embed widget")
  // Let existing step_question ('runtime_policy') handle those unless asking what the current page does.
  if (
    !namesPlatformExplicitly &&
    WIDGET_EMBED_STEP_ASCII_RE.test(ascii) &&
    !CURRENT_PAGE_ASCII_RE.test(ascii)
  ) {
    return null;
  }

  // Guard 3: Second-person Copilot capability questions ("bạn có thể làm gì mà", "what can you do")
  if (
    !namesPlatformExplicitly &&
    PURE_COPILOT_CAPABILITY_ASCII_RE.test(ascii) &&
    !/\b(?:web|website|trang|man\s+hinh|muc|he\s+thong|nen\s+tang|this\s+(?:website|site|page|screen|platform))\b/i.test(
      ascii,
    )
  ) {
    return null;
  }

  const currentRoute = describePlatformRoute(currentPath);

  if (WORKSPACE_COMPARISON_ASCII_RE.test(ascii)) {
    return { kind: 'workspace_comparison', route: currentRoute };
  }

  if (CURRENT_PAGE_ASCII_RE.test(ascii)) {
    return { kind: 'current_page', route: currentRoute };
  }

  if (HOWTO_PROVIDERS_KEYS_ASCII_RE.test(ascii)) {
    return {
      kind: 'howto_providers_keys',
      route: describePlatformRoute('/thruline/providers') ?? currentRoute,
    };
  }

  if (HOWTO_COMBOS_ASCII_RE.test(ascii) && !RETAIL_BUNDLE_COMBO_ASCII_RE.test(ascii)) {
    return {
      kind: 'howto_combos_routing',
      route: describePlatformRoute('/thruline/combos') ?? currentRoute,
    };
  }

  if (HOWTO_TOKEN_SAVERS_ASCII_RE.test(ascii)) {
    return {
      kind: 'howto_token_savers',
      route: describePlatformRoute('/thruline/savers') ?? currentRoute,
    };
  }

  if (HOWTO_CLI_SKILLS_ASCII_RE.test(ascii)) {
    const isSkills = /\bskills?\b/i.test(ascii) && !/\bcli\b/i.test(ascii);
    return {
      kind: 'howto_cli_skills',
      route: describePlatformRoute(isSkills ? '/thruline/skills' : '/thruline/tools') ?? currentRoute,
    };
  }

  if (HOWTO_TRANSLATOR_ASCII_RE.test(ascii)) {
    return {
      kind: 'howto_translator',
      route: describePlatformRoute('/thruline/translator') ?? currentRoute,
    };
  }

  if (HOWTO_QUOTA_USAGE_ASCII_RE.test(ascii)) {
    const isUsage = /\busage\b|luu\s+luong/i.test(ascii) && !/\bquota\b|han\s+muc/i.test(ascii);
    return {
      kind: 'howto_quota_usage',
      route: describePlatformRoute(isUsage ? '/thruline/usage' : '/thruline/quota') ?? currentRoute,
    };
  }

  if (TENANT_PORTAL_OVERVIEW_ASCII_RE.test(ascii)) {
    return {
      kind: 'tenant_portal_overview',
      route: describePlatformRoute('/tenant-portal'),
    };
  }

  if (AI_HUB_OVERVIEW_ASCII_RE.test(ascii)) {
    return {
      kind: 'ai_hub_overview',
      route: describePlatformRoute('/assistants'),
    };
  }

  if (THRULINE_OVERVIEW_ASCII_RE.test(ascii)) {
    return {
      kind: 'thruline_overview',
      route: currentRoute,
    };
  }

  if (PLATFORM_OVERVIEW_ASCII_RE.test(ascii)) {
    return {
      kind: 'platform_overview',
      route: currentRoute,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Fluent, Non-Repetitive Human Specialist Reply Builder
// ---------------------------------------------------------------------------

function normalizeSimilarityText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[`*_~#>[\]()!?,.:;"'“”‘’—–\-+/\\|]/g, ' ')
    .replace(/\p{Extended_Pictographic}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function pickFreshVariant(
  variants: readonly string[],
  priorAssistantMessages: readonly string[],
): string {
  const normalizedPriors = priorAssistantMessages.map(normalizeSimilarityText).filter(Boolean);
  for (const candidate of variants) {
    const normCand = normalizeSimilarityText(candidate);
    if (!normCand) continue;
    const candHead = normCand.slice(0, 72);
    const collided = normalizedPriors.some(
      (p) => p === normCand || (candHead.length >= 32 && p.slice(0, 72) === candHead),
    );
    if (!collided) return candidate;
  }
  return variants[priorAssistantMessages.length % variants.length] ?? variants[0] ?? '';
}

function adaptQuickRepliesForPermissions(
  rawChips: readonly string[],
  canEditOrCreate: boolean,
  locale: 'vi' | 'en',
): string[] {
  if (canEditOrCreate) return [...rawChips].slice(0, 3);
  const filtered = rawChips.filter(
    (c) =>
      !/dựng trợ lý|lên bản mẫu|hoàn thiện cấu hình|set up a complete|draft a|auto-complete|stage recommended/i.test(
        c,
      ),
  );
  if (filtered.length >= 2) return filtered.slice(0, 3);
  const readOnlyExtras =
    locale === 'vi'
      ? [
          'Khác nhau giữa Thruline và Tenant Portal là gì?',
          'Hướng dẫn dễ hiểu 7 bước AI Support',
        ]
      : [
          'What is the difference between Thruline and Tenant Portal?',
          'Walk me through the 7 AI Support steps',
        ];
  for (const ex of readOnlyExtras) {
    if (!filtered.includes(ex)) filtered.push(ex);
    if (filtered.length >= 3) break;
  }
  return filtered.slice(0, 3);
}

/**
 * Generates a warm, fluent, product-specialist answer for platform, current-page, and
 * practical how-to questions in Vietnamese or English — with anti-repetition variation
 * and permission-aware quick-reply chips.
 */
export function buildPlatformExpertReply(
  params: PlatformExpertReplyParams,
): PlatformExpertReplyResult {
  const {
    match,
    locale,
    currentPath,
    diagnostic = null,
    canCreateTenant = true,
    canEditAny = true,
    priorAssistantMessages = [],
  } = params;

  const canEditOrCreate = Boolean(canCreateTenant || canEditAny);
  const liveRoute = describePlatformRoute(currentPath, locale) ?? match.route;

  // 1. Overall Platform Overview ("web này làm gì?", "FreeLLMAPI là gì?", "what does this website do?")
  if (match.kind === 'platform_overview') {
    const currentScreenTouchVi = liveRoute
      ? `\n\n*(Hiện bạn đang mở màn hình **${liveRoute.titleVi}** — bấm gợi ý bên dưới nếu bạn muốn mình chỉ nhanh cách dùng ngay màn hình này nhé!)*`
      : '';
    const currentScreenTouchEn = liveRoute
      ? `\n\n*(You currently have **${liveRoute.titleEn}** open — tap below if you'd like a quick walkthrough of this exact screen!)*`
      : '';

    const closingVi = canEditOrCreate
      ? 'Bạn đang muốn tìm hiểu cách kết nối tài khoản AI / lấy API key để dùng, hay muốn mình phụ dựng luôn một **chatbot chăm sóc khách hàng** cho website/shop của bạn?'
      : 'Bạn muốn mình giải thích sâu hơn về màn hình đang mở hay cách vận hành từng phân khu trong hệ thống thì cứ nhắn thoải mái nhé!';
    const closingEn = canEditOrCreate
      ? 'Would you like to explore connecting AI provider accounts & API keys, or have me draft a **customer-support AI chatbot** for your website or store?'
      : 'Feel free to ask about the screen you currently have open or how any part of the platform works!';

    const variantsVi = [
      [
        'Mình giới thiệu gọn và dễ hiểu nhất về nền tảng bạn đang mở nhé! 😊 Đây là hệ sinh thái **FreeLLMAPI & Thruline** — vừa là **Cổng AI Hợp nhất (Unified AI Gateway)**, vừa là bộ công cụ **xây dựng Trợ lý AI Chăm sóc khách hàng** trọn gói:',
        '',
        '- **Cổng Định tuyến Đa nguồn (`FreeLLMAPI` Gateway):** Gom nhiều nhà cung cấp AI, API key, gói miễn phí (free-tier) và tài khoản OAuth về một chuẩn kết nối duy nhất (`/v1/*` chuẩn OpenAI, `/v1beta/*` chuẩn Gemini, Anthropic, Ollama) — tự động xoay vòng tài khoản khi chạm giới hạn, dự phòng lỗi (failover) và cân bằng tải.',
        '- **Trung tâm Điều hành `Thruline` (`/thruline/*`):** Nơi bạn nối tài khoản **Providers**, ghép chuỗi model **Combos**, bật nén tiết kiệm **Token Savers**, kết nối **CLI Tools & Skills** cho coding agents, dịch giao thức **Translator**, theo dõi **Quota/Usage**, và vận hành **7 Studio AI Support** (`/thruline/support*`) để dựng chatbot nhúng lên website.',
        '- **Không gian Doanh nghiệp `Tenant AI Portal` (`/tenant-portal`):** Cổng làm việc riêng theo phân quyền (RBAC) cho từng cửa hàng/đội ngũ tự quản lý nhân cách AI, kho câu hỏi FAQ/RAG, che SĐT/email nhạy cảm, tường lửa prompt, trực live chat/ticket SLA và lấy mã `<script>` gắn lên web.',
        '- **Trợ lý Cá nhân `AI Hub` (`/assistants`):** Kho trợ lý chuyên biệt (Coding, Writing, Data) kèm khóa API cá nhân theo chế độ định tuyến *Eco / Balanced / Max*.',
        '',
        `${closingVi}${currentScreenTouchVi}`,
      ].join('\n'),
      [
        'Hiểu nôm na thì trang web **FreeLLMAPI (kèm phân khu Thruline)** này giải quyết trọn vẹn 2 bài toán lớn về AI ở cùng một nơi cho bạn nha:',
        '',
        '- **Thứ nhất — Trạm trung chuyển & tiết kiệm tài nguyên AI:** Thay vì mỗi ứng dụng phải tự lo đứt kết nối hay hết quota, hệ thống gom mọi tài khoản OAuth, API key và free-tier của bạn lại sau các cổng chuẩn (`/v1/*`, `/v1beta/*`), kết hợp **Combos** dự phòng đa model, **Token Savers** nén ngữ cảnh/cache và **CLI Tools / Translator** trên `/thruline/*`.',
        '- **Thứ hai — Dựng Chatbot AI trực Website & Service Desk cho doanh nghiệp:** Qua **7 Studio AI Support** (`/thruline/support*`) và cổng riêng **Tenant AI Portal** (`/tenant-portal`), từng shop hay công ty có thể nạp tài liệu FAQ, che thông tin cá nhân khách, dựng tường lửa chống phá, trực ticket theo SLA và nhúng nút chat `<script>` lên web thật — bên cạnh **Personal AI Hub** (`/assistants`) phục vụ công việc cá nhân hàng ngày.',
        '',
        `${closingVi}${currentScreenTouchVi}`,
      ].join('\n'),
    ];

    const variantsEn = [
      [
        'Happy to give you the tour! 😊 This platform brings **FreeLLMAPI & Thruline** together as both a **Unified Multi-Provider AI Gateway** and a complete **Customer Support AI Studio**:',
        '',
        '- **Unified AI Gateway & Router (`FreeLLMAPI`):** Aggregates multiple AI providers, API keys, keyless free tiers, and OAuth accounts behind drop-in OpenAI (`/v1/*`), Gemini (`/v1beta/*`), Anthropic, and Ollama endpoints — with smart failover, load balancing, rate-limit rotation, and response caching.',
        '- **Thruline Console (`/thruline/*`):** Your operational control plane for **Providers**, multi-model **Combos**, **Token Savers**, **Quota & Usage** monitoring, **CLI Tools & Agent Skills**, **Protocol Translator**, and the **7 Customer Support AI Studios** (`/thruline/support*`) for building embeddable support bots.',
        '- **Tenant AI Portal (`/tenant-portal`):** A dedicated RBAC-scoped workspace where each business or store team manages their own AI persona, FAQ/RAG knowledge base, PII masking, prompt firewall, live Service Desk tickets/SLA, and website `<script>` embed.',
        '- **Personal AI Hub (`/assistants`) & Dashboard:** Ready-to-use Coding/Writing/Data assistants, personal gateway API keys (*Eco / Balanced / Max* routing), multimodal fallback chains, and analytics.',
        '',
        `${closingEn}${currentScreenTouchEn}`,
      ].join('\n'),
      [
        'Think of **FreeLLMAPI + Thruline** as an all-in-one AI infrastructure and support workspace:',
        '',
        '- **Smart Multi-Account AI Routing:** Connect API keys, free tiers, and OAuth subscriptions in **Thruline** (`/thruline/providers`), bundle resilient fallback chains in **Combos**, trim token costs with **Token Savers**, connect coding CLIs, and expose unified `/v1/*` & `/v1beta/*` endpoints.',
        '- **Turnkey Business Support AI & Personal Hub:** Build safe, RAG-grounded website chatbots with live Service Desk ticketing across the **7 Support Studios** (`/thruline/support*`), hand each store team their own **Tenant AI Portal** (`/tenant-portal`), and use **Personal AI Hub** (`/assistants`) for everyday coding and writing.',
        '',
        `${closingEn}${currentScreenTouchEn}`,
      ].join('\n'),
    ];

    const rawChips =
      locale === 'vi'
        ? [
            ...(liveRoute ? ['Trang này dùng để làm gì?'] : []),
            'Làm sao kết nối Provider & lấy API key?',
            'Mình muốn dựng trợ lý AI Support cho web/shop',
            'Khác nhau giữa Thruline và Tenant Portal là gì?',
          ]
        : [
            ...(liveRoute ? ['What is this page for?'] : []),
            'How do I connect Providers & get an API key?',
            'Set up a complete AI Support assistant for me',
            'What is the difference between Thruline and Tenant Portal?',
          ];

    return {
      reply: pickFreshVariant(locale === 'vi' ? variantsVi : variantsEn, priorAssistantMessages),
      suggestedQuickReplies: adaptQuickRepliesForPermissions(rawChips, canEditOrCreate, locale),
    };
  }

  // 2. Thruline Overview ("Thruline là gì?", "Thruline dùng để làm gì?")
  if (match.kind === 'thruline_overview') {
    const variantsVi = [
      [
        '**Thruline (`/thruline/*`)** là trung tâm điều hành chuyên sâu nằm trong hệ sinh thái **FreeLLMAPI**, kết nối trực tiếp tầng định tuyến đa tài khoản AI với bộ công cụ dựng Chatbot doanh nghiệp:',
        '',
        '- **Kết nối & Định tuyến Đa tài khoản:** Quản lý đăng nhập OAuth, API key, free-tier tại **Providers** (`/thruline/providers`), ghép chuỗi model dự phòng & chia tải ở **Combos** (`/thruline/combos`), nén ngữ cảnh giảm tốn token với **Token Savers** (`/thruline/savers`), dịch chuẩn API tự động qua **Translator** (`/thruline/translator`) và cấp cổng `/thruline/v1` (cùng cổng `/v1/*` của FreeLLMAPI).',
        '- **Công cụ Developer & Giám sát:** Cài đặt nhanh Claude Code, Cursor, Codex tại **CLI Tools & Skills** (`/thruline/tools`, `/thruline/skills`) và theo dõi hạn mức thời gian thực ở **Quota & Usage** (`/thruline/quota`, `/thruline/usage`).',
        '- **7 Studio AI Support & Liên kết toàn nền tảng:** Dựng trọn gói chatbot chăm sóc khách hàng nhúng web tại `/thruline/support*` (nhân cách AI, FAQ/RAG, che PII, tường lửa, Service Desk SLA, mã `<script>`), đồng bộ mượt với **Tenant AI Portal** (`/tenant-portal` cho từng đội ngũ cửa hàng) và **Personal AI Hub** (`/assistants` cho trợ lý cá nhân).',
        '',
        canEditOrCreate
          ? 'Bạn đang muốn cấu hình nguồn tài khoản/Combo trên Thruline, hay nhờ mình lên bản mẫu trợ lý AI Support cho website của bạn?'
          : 'Bạn muốn mình giải thích chi tiết thêm mục nào bên trong Thruline cứ nhắn nhé!',
      ].join('\n'),
      [
        'Bạn có thể hình dung **Thruline (`/thruline/*`)** như "buồng lái điều phối thông minh" của toàn nền tảng **FreeLLMAPI** vậy! 😊',
        '',
        '- Ở mảng **hạ tầng AI Gateway**, Thruline giúp bạn gom nhiều tài khoản OAuth/API key (`Providers`), xoay vòng tránh hết hạn mức (`Quota`, `Combos`), tiết kiệm chi phí token (`Token Savers`), dịch qua lại chuẩn OpenAI/Claude/Gemini (`Translator`) và nối thẳng vào công cụ lập trình (`CLI Tools`, `Skills`).',
        '- Ở mảng **ứng dụng thực tế**, Thruline cung cấp **7 Studio AI Support** (`/thruline/support*`) kết nối chặt chẽ với **Tenant AI Portal** (`/tenant-portal`) để các doanh nghiệp vận hành chatbot trực web + bàn trực ticket SLA, song song với **AI Hub** (`/assistants`) cho nhu cầu cá nhân.',
      ].join('\n'),
    ];

    const variantsEn = [
      [
        '**Thruline (`/thruline/*`)** is the advanced multi-account gateway and AI Support studio console inside the **FreeLLMAPI** platform:',
        '',
        '- **Multi-Provider Routing & Optimization:** Connect OAuth subscriptions, API keys, and free tiers in **Providers** (`/thruline/providers`), stack failover/load-balanced model chains in **Combos** (`/thruline/combos`), trim token usage in **Token Savers** (`/thruline/savers`), translate across OpenAI/Anthropic/Gemini schemas in **Translator** (`/thruline/translator`), and monitor live limits in **Quota & Usage**.',
        '- **Developer Tooling:** Wire coding agents like Claude Code, Codex, and Cursor into your gateway via **CLI Tools & Skills** (`/thruline/tools`, `/thruline/skills`).',
        '- **7 Customer Support AI Studios & Ecosystem Sync:** Build RAG-grounded, guardrail-protected website chatbots with Service Desk SLA ticketing across `/thruline/support*` — working hand-in-hand with the main **FreeLLMAPI** `/v1/*` router, **Tenant AI Portal** (`/tenant-portal` for business teams), and **Personal AI Hub** (`/assistants`).',
      ].join('\n'),
      [
        'Think of **Thruline (`/thruline/*`)** as the operational cockpit of **FreeLLMAPI**! 😊 It brings together multi-account OAuth/key rotation (`Providers`, `Combos`, `Quota`), intelligent compression (`Token Savers`), coding agent setup (`CLI Tools`, `Skills`), protocol translation, and the **7 AI Support Studios** (`/thruline/support*`) that power scoped business workspaces in **Tenant AI Portal** (`/tenant-portal`) alongside **Personal AI Hub** (`/assistants`).',
      ].join('\n'),
    ];

    const rawChips =
      locale === 'vi'
        ? [
            'Khác nhau giữa Thruline và Tenant Portal là gì?',
            'Làm sao thêm tài khoản AI & tạo Combo?',
            'Mình muốn dựng trợ lý AI Support cho web/shop',
          ]
        : [
            'What is the difference between Thruline and Tenant Portal?',
            'How do I add Provider accounts & Combos?',
            'Set up a complete AI Support assistant for me',
          ];

    return {
      reply: pickFreshVariant(locale === 'vi' ? variantsVi : variantsEn, priorAssistantMessages),
      suggestedQuickReplies: adaptQuickRepliesForPermissions(rawChips, canEditOrCreate, locale),
    };
  }

  // 3. Current Page / Screen Guide ("trang này dùng để làm gì?", "mục này dùng sao?", "what is this page for?")
  // Also handles tenant_portal_overview & ai_hub_overview cleanly with rich route descriptors!
  if (
    match.kind === 'current_page' ||
    match.kind === 'tenant_portal_overview' ||
    match.kind === 'ai_hub_overview'
  ) {
    const route =
      match.kind === 'tenant_portal_overview'
        ? describePlatformRoute('/tenant-portal', locale)
        : match.kind === 'ai_hub_overview'
          ? describePlatformRoute('/assistants', locale)
          : liveRoute;

    if (!route) {
      // Graceful fallback if caller did not supply currentPath
      return buildPlatformExpertReply({
        ...params,
        match: { kind: 'platform_overview', route: null },
      });
    }

    const diagNoteVi =
      diagnostic && (route.area === 'thruline_support' || route.area === 'tenant_portal')
        ? `\n- **Trạng thái hiện tại của bạn:** Tenant **${diagnostic.tenant.name}** đang hoàn tất **${diagnostic.completedSteps}/${diagnostic.totalSteps} bước** chuẩn bị.`
        : '';
    const diagNoteEn =
      diagnostic && (route.area === 'thruline_support' || route.area === 'tenant_portal')
        ? `\n- **Your live status:** Active tenant **${diagnostic.tenant.name}** currently has **${diagnostic.completedSteps}/${diagnostic.totalSteps} setup steps** complete.`
        : '';

    const variantsVi = [
      [
        `Mình giải thích nhanh và sát thực tế về màn hình **${route.titleVi}** nhé! 😊`,
        '',
        `- **Trang này dùng để làm gì:** ${route.purposeVi}`,
        `- **Cách dùng hiệu quả:** ${route.howToUseVi}`,
        `- **Liên kết với AI Support:** ${route.supportConnectionVi}${diagNoteVi}`,
      ].join('\n'),
      [
        `Về **${route.titleVi}** mà bạn đang xem:`,
        '',
        `${route.purposeVi}`,
        '',
        `- **Mẹo thao tác nhanh:** ${route.howToUseVi}`,
        `- **Góc nhìn kết nối:** ${route.supportConnectionVi}${diagNoteVi}`,
      ].join('\n'),
    ];

    const variantsEn = [
      [
        `Here is a practical breakdown of **${route.titleEn}**! 😊`,
        '',
        `- **What this screen does:** ${route.purposeEn}`,
        `- **How to use it effectively:** ${route.howToUseEn}`,
        `- **How it connects to AI Support:** ${route.supportConnectionEn}${diagNoteEn}`,
      ].join('\n'),
      [
        `Let's walk through **${route.titleEn}**:`,
        '',
        `${route.purposeEn}`,
        '',
        `- **Practical workflow:** ${route.howToUseEn}`,
        `- **AI Support connection:** ${route.supportConnectionEn}${diagNoteEn}`,
      ].join('\n'),
    ];

    const rawChips = locale === 'vi' ? route.quickRepliesVi : route.quickRepliesEn;
    return {
      reply: pickFreshVariant(locale === 'vi' ? variantsVi : variantsEn, priorAssistantMessages),
      suggestedQuickReplies: adaptQuickRepliesForPermissions(rawChips, canEditOrCreate, locale),
    };
  }

  // 4. Workspace Comparison ("khác nhau giữa Thruline và Tenant Portal")
  if (match.kind === 'workspace_comparison') {
    const variantsVi = [
      [
        'Mình phân biệt cực dễ nhớ giữa các không gian làm việc trên nền tảng này cho bạn nhé! 😊',
        '',
        '- **`Thruline Console` (`/thruline/*`) — Phòng điều hành trung tâm (Operator):** Dành cho người quản trị hạ tầng AI để nối tài khoản gốc (`Providers`), ghép chuỗi dự phòng (`Combos`), bật `Token Savers`, nối `CLI Tools` và thiết lập toàn quyền **7 Studio AI Support** cho mọi dự án.',
        '- **`Tenant AI Portal` (`/tenant-portal`) — Văn phòng riêng của từng Cửa hàng / Doanh nghiệp (RBAC):** Khi bạn gán nhân sự của một shop vào Tenant, họ làm việc gọn trong `/tenant-portal` (sửa lời chào, nạp bài FAQ khuyến mãi, trực hộp thư khách hàng Service Desk, lấy mã `<script>` nhúng web) mà **hoàn toàn không thấy khóa hạ tầng hay dữ liệu của shop khác**.',
        '- **`FreeLLMAPI Dashboard` & `AI Hub` (`/assistants`) — Cổng API chính & Trợ lý cá nhân:** Quản lý danh mục model đa phương thức (`/models/*`), khóa cổng `/v1/*` (`/keys`), phân quyền thành viên (`/users`) và dùng trợ lý cá nhân hàng ngày (`/assistants`).',
      ].join('\n'),
      [
        'Điểm khác biệt cốt lõi nằm ở **vai trò người dùng và phạm vi bảo mật** bạn nhé:',
        '',
        '- **Thruline (`/thruline/*`)** quản lý cả phần "động cơ AI phía dưới" (tài khoản OAuth/API key ở `Providers`, `Combos`, `Token Savers`) lẫn toàn bộ 7 phòng cấu hình `Support` cấp hệ thống.',
        '- **Tenant AI Portal (`/tenant-portal`)** đóng gói riêng phần vận hành chatbot chăm sóc khách hàng cho từng thương hiệu/cửa hàng theo đúng quyền RBAC được cấp — giúp chủ shop hay nhân viên trực chat làm việc cực kỳ tập trung, an toàn mà không chạm tới cấu hình hạ tầng chung.',
      ].join('\n'),
    ];

    const variantsEn = [
      [
        'Here is the clearest way to picture how the workspaces fit together! 😊',
        '',
        '- **`Thruline Console` (`/thruline/*`) — Platform Operator Cockpit:** Where operators connect upstream AI accounts (`Providers`), build failover `Combos`, enable `Token Savers`, configure developer `CLI Tools`, and manage all **7 Customer Support AI Studios** platform-wide.',
        '- **`Tenant AI Portal` (`/tenant-portal`) — Dedicated Business / Storefront Workspace (RBAC):** Assigned team members for a specific brand log in here to manage *only* their tenant’s AI persona, FAQs, PII masking, guardrails, live Service Desk tickets, and website `<script>` embed — without ever seeing upstream provider secrets or other tenants.',
        '- **`FreeLLMAPI Dashboard` & `Personal AI Hub` (`/assistants`):** Manage multimodal `/v1/*` fallback chains (`/models/*`), gateway keys (`/keys`), user/tenant memberships (`/users`), and personal Coding/Writing assistants (`/assistants`).',
      ].join('\n'),
      [
        'The short version comes down to **who uses each workspace**:',
        '',
        '- **Thruline (`/thruline/*`)** is for platform operators managing upstream AI accounts, smart routing (`Combos`, `Token Savers`), and cross-tenant Support studios.',
        '- **Tenant AI Portal (`/tenant-portal`)** is a clean, permission-scoped workspace for each individual business or support team to run their own chatbot, knowledge base, and live Service Desk safely.',
      ].join('\n'),
    ];

    const rawChips =
      locale === 'vi'
        ? [
            'Trang đang mở này dùng để làm gì?',
            'Làm sao thêm tài khoản AI & lấy API key?',
            'Mình muốn dựng trợ lý AI Support cho web/shop',
          ]
        : [
            'What is this current page for?',
            'How do I add Provider keys & get an API key?',
            'Set up a complete AI Support assistant for me',
          ];

    return {
      reply: pickFreshVariant(locale === 'vi' ? variantsVi : variantsEn, priorAssistantMessages),
      suggestedQuickReplies: adaptQuickRepliesForPermissions(rawChips, canEditOrCreate, locale),
    };
  }

  // 5. Practical How-To: Providers, OAuth & API Keys
  if (match.kind === 'howto_providers_keys') {
    const variantsVi = [
      [
        'Tùy vào mục đích bạn cần **nối nguồn AI vào** hay **lấy khóa API mang đi dùng**, mình chỉ đúng chỗ nhanh nhất nhé! 🔑',
        '',
        '- **Thêm tài khoản AI / Nhà cung cấp nguồn (OAuth hoặc API Key):** Bạn mở **`/thruline/providers`** -> chọn nhà cung cấp (OpenAI, Gemini, Claude, Qwen, Kiro...) -> đăng nhập OAuth hoặc dán key và bật kích hoạt (có thể nối thêm ở mục **`/keys`** trên bảng điều khiển chính). Nối nhiều tài khoản sẽ tự động xoay vòng né rate-limit!',
        '- **Lấy API Key để gắn vào ứng dụng, code hoặc Cursor/CLI:** Bạn vào **`/thruline/endpoint`** (cổng `/thruline/v1`), trang **`/keys`** (cổng chuẩn `/v1/*` & `/v1beta/*`), hoặc **`/assistants` (AI Hub)** để tạo khóa cá nhân kèm chế độ định tuyến *Eco / Balanced / Max*.',
        '- **Lấy khóa nhúng Chatbot lên Website khách hàng:** Hệ thống dùng mã công khai an toàn **`pk_sup_...`** kèm 2 dòng `<script>` tại **`/thruline/support-integration`** (hoặc tab *Integration & Keys* trong `/tenant-portal`) để không bao giờ lộ khóa API gốc ra trình duyệt!',
      ].join('\n'),
      [
        'Để làm việc với tài khoản AI và API Key trên hệ thống, bạn đi theo 3 lối tắt cực gọn sau nha:',
        '',
        '- **Cấp nguồn model cho hệ thống:** Vào **`Providers` (`/thruline/providers`)** để kết nối OAuth 1 chạm, bật gói free-tier hoặc dán API key của các hãng AI.',
        '- **Lấy khóa gọi API cho phần mềm / công cụ lập trình:** Vào **`Endpoint` (`/thruline/endpoint`)** hoặc **`CLI Tools` (`/thruline/tools`)** để copy sẵn Base URL và Gateway Key.',
        '- **Nhúng khung chat AI lên web bán hàng:** Dùng khóa công khai `pk_sup_...` tại **`/thruline/support-integration`** — hoặc bảo mình dựng tự động trọn gói Tenant ngay trong khung chat này!',
      ].join('\n'),
    ];

    const variantsEn = [
      [
        'Depending on whether you want to **connect upstream AI accounts** or **grab a gateway API key for your apps**, here is the exact map! 🔑',
        '',
        '- **Add Upstream Provider Keys or OAuth Accounts:** Open **`/thruline/providers`** -> pick a provider (OpenAI, Claude, Gemini, Qwen, Codex, etc.) -> sign in via OAuth, enable a free tier, or paste an API key (you can also manage main gateway keys in **`/keys`**). Adding multiple accounts enables automatic rate-limit rotation!',
        '- **Get a Gateway API Key for Apps, SDKs, or Coding CLIs:** Go to **`/thruline/endpoint`** (for `/thruline/v1`), **`/keys`** (for `/v1/*` & `/v1beta/*`), or **`/assistants` (AI Hub)** for personal keys with *Eco / Balanced / Max* routing.',
        '- **Embed a Public Customer Chatbot on Your Website:** Never expose secret API keys in browser code — use the scoped **`pk_sup_...`** public key and `<script>` snippet in **`/thruline/support-integration`** (or **Tenant Portal** -> *Integration & Keys*)!',
      ].join('\n'),
      [
        'Here is the quick guide to Provider accounts and API keys on the platform:',
        '',
        '- **Connect AI Sources:** Head to **`Providers` (`/thruline/providers`)** to link OAuth accounts, free-tier models, or upstream API keys.',
        '- **Grab Your App / CLI Key:** Open **`Endpoint` (`/thruline/endpoint`)** or **`CLI Tools` (`/thruline/tools`)** for your Base URL and gateway key.',
        '- **Website Support Widget Key:** Use the safe `pk_sup_...` embed snippet in **`/thruline/support-integration`** — or ask me right here to draft your Support Tenant setup!',
      ].join('\n'),
    ];

    const rawChips =
      locale === 'vi'
        ? [
            'Combo dự phòng đa model tạo như thế nào?',
            'Mình muốn dựng trợ lý AI Support cho web/shop',
            'Xem hạn mức Quota của tài khoản ở đâu?',
          ]
        : [
            'How do I create multi-model Combos?',
            'Set up a complete AI Support assistant for me',
            'Where do I monitor account Quota & usage?',
          ];

    return {
      reply: pickFreshVariant(locale === 'vi' ? variantsVi : variantsEn, priorAssistantMessages),
      suggestedQuickReplies: adaptQuickRepliesForPermissions(rawChips, canEditOrCreate, locale),
    };
  }

  // 6. Practical How-To: Combos & Multi-Model Routing
  if (match.kind === 'howto_combos_routing') {
    const comboRoute = describePlatformRoute('/thruline/combos', locale)!;
    const variantsVi = [
      [
        `Về **${comboRoute.titleVi}**: đây là một trong những tính năng "đáng tiền" nhất trên Thruline đó bạn! 🚀`,
        '',
        `- **Công dụng chính:** ${comboRoute.purposeVi}`,
        '- **Cách tạo trong 30 giây:** Mở **`/thruline/combos`** -> bấm tạo Combo mới -> đặt một tên gọi gọn (ví dụ `auto-support`) -> chọn danh sách các model từ mục Providers theo thứ tự ưu tiên (hoặc chia phần trăm tải) rồi lưu lại.',
        `- **Ứng dụng thực tế:** ${comboRoute.supportConnectionVi}`,
      ].join('\n'),
      [
        '**Combo (`/thruline/combos`)** giúp bạn ghép nhiều model AI rời rạc thành một "đội hình bọc lót lẫn nhau": model số 1 trả lời chính, hễ gặp quá tải hay hết lượt miễn phí là hệ thống tự động nhảy sang model số 2, số 3 trong tích tắc mà khách đang chat không hề thấy báo lỗi!',
        '',
        'Bạn chỉ cần nối trước vài tài khoản ở `/thruline/providers`, sang `/thruline/combos` gom lại thành 1 tên chung, rồi dùng tên Combo đó cho ứng dụng hoặc cho trợ lý AI Support là yên tâm chạy 24/7 nha.',
      ].join('\n'),
    ];

    const variantsEn = [
      [
        `**${comboRoute.titleEn}** is one of Thruline's superpowers! 🚀`,
        '',
        `- **What it does:** ${comboRoute.purposeEn}`,
        '- **How to create one:** Open **`/thruline/combos`** -> create a new Combo -> give it a clean alias (like `auto-support`) -> add 2 or more models from your connected Providers in priority order (or weighted load-balance) and save.',
        `- **Why it shines for AI Support:** ${comboRoute.supportConnectionEn}`,
      ].join('\n'),
      [
        '**Combos (`/thruline/combos`)** let you chain multiple models behind one virtual model ID so if your primary model hits a rate limit or timeout, Thruline transparently fails over to the next healthy backup without dropping your user’s chat!',
      ].join('\n'),
    ];

    const rawChips =
      locale === 'vi'
        ? comboRoute.quickRepliesVi
        : comboRoute.quickRepliesEn;

    return {
      reply: pickFreshVariant(locale === 'vi' ? variantsVi : variantsEn, priorAssistantMessages),
      suggestedQuickReplies: adaptQuickRepliesForPermissions(rawChips, canEditOrCreate, locale),
    };
  }

  // 7. Feature-specific questions (Token Savers, CLI/Skills, Translator, Quota/Usage)
  const featureRoute = match.route ?? liveRoute;
  if (featureRoute) {
    return buildPlatformExpertReply({
      ...params,
      match: { kind: 'current_page', route: featureRoute },
      currentPath: featureRoute.normalizedPath,
    });
  }

  return buildPlatformExpertReply({
    ...params,
    match: { kind: 'platform_overview', route: null },
  });
}
