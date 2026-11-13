import { useI18n } from '@/i18n'

const en = {
  nav: 'Integration Studio',
  title: 'AI Support Integration Studio',
  subtitle: 'Verify component readiness, configure runtime execution limits, monitor durable outbox events, and generate secure embed code.',
  tenant: 'Active tenant',
  noTenants: 'No tenants available. Create a tenant in AI Support Gateway first.',
  readOnly: 'You need permission to edit X-Gateway settings to change this configuration.',
  loading: 'Loading…',
  retry: 'Retry',
  refresh: 'Refresh',
  saving: 'Saving…',
  saved: 'Runtime policy saved successfully.',
  empty: 'No items found.',

  tabs: {
    readiness: 'Readiness',
    runtime: 'Runtime Policy',
    deliveries: 'Outbox Deliveries',
    embed: 'Embed & SDK'
  },

  readiness: {
    heading: 'Component Readiness Checks',
    subheading: 'Evaluates tenant configuration and component availability without calling external providers or side effects.',
    overallReady: 'Tenant is ready for live traffic.',
    overallWarning: 'Configuration has warnings. Review the recommendations below.',
    overallError: 'Configuration has errors blocking live operations.',
    colComponent: 'Component',
    colStatus: 'Status',
    colDetails: 'Details',
    statusReady: 'Ready',
    statusWarning: 'Warning',
    statusError: 'Error',
    retryAction: 'Re-run Checks',
    components: {
      tenant: 'Tenant Configuration',
      origins: 'Allowed Origins (CORS)',
      model: 'AI Model Provider',
      knowledge: 'Knowledge Base',
      masking: 'Data Masking Firewall',
      guardrails: 'Guardrails Firewall',
      quota: 'Usage Quotas',
      approvals: 'Action Approvals',
      worker: 'Outbox Worker'
    },
    codes: {
      tenant_ready: 'Tenant is enabled and active',
      tenant_disabled: 'Tenant is currently disabled',
      origins_configured: 'Allowed origins explicitly configured',
      origins_unrestricted: 'Allowed origins are unrestricted (*). In production, configure exact domains.',
      model_ready: 'Default model provider accounts configured and available',
      model_no_accounts: 'No active provider account configured for default model',
      model_check_failed: 'Unable to check provider configuration',
      knowledge_unavailable: 'Knowledge storage is unavailable',
      knowledge_ready: 'Knowledge base has active indexed documents',
      knowledge_empty: 'Knowledge base has no active documents (warning)',
      masking_ready: 'Data masking firewall is active',
      masking_disabled: 'Data masking firewall is disabled',
      guardrails_ready: 'Guardrails firewall is active',
      guardrails_disabled: 'Guardrails firewall is disabled',
      quota_ready: 'Usage quota limits configured',
      quota_unconfigured: 'Usage quota limits not set',
      quota_unavailable: 'Quota storage is unavailable',
      approvals_unavailable: 'Approval storage is unavailable',
      approvals_ready: 'Action approval pipeline configured',
      worker_ready: 'Outbox event worker is running',
      worker_missing_heartbeat: 'No recent outbox worker heartbeat detected'
    }
  },

  runtime: {
    heading: 'Runtime Execution Policy',
    subheading: 'Set token caps, tool execution modes, and context bounds. Tool execution defaults to approval required.',
    allowedModelsLabel: 'Additional Allowed Models',
    allowedModelsHelp: 'Comma-separated model names. The tenant default model is always permitted.',
    maxCompletionTokensLabel: 'Max Completion Tokens',
    maxCompletionTokensHelp: 'Integer 1..4096 (default: 512) per model call',
    maxModelCallsLabel: 'Max Model Calls',
    maxModelCallsHelp: 'Integer 1..3 (default: 3) per turn',
    maxToolCallsLabel: 'Max Tool Calls',
    maxToolCallsHelp: 'Integer 0..3 (default: 3) per turn',
    maxContextCharsLabel: 'Max Context Characters',
    maxContextCharsHelp: 'Integer 1000..32000 (default: 16000)',
    maxToolResultCharsLabel: 'Max Tool Result Characters',
    maxToolResultCharsHelp: 'Integer 256..16000 (default: 8000) per result',
    maxHistoryMessagesLabel: 'Max History Messages',
    maxHistoryMessagesHelp: 'Integer 2..100 (default: 40)',
    toolsHeading: 'Tool Security Classification',
    toolsHelp: 'POST/write tools require approval by default. To allow autonomous execution without staff review, explicitly set to Read mode.',
    toolName: 'Tool Name',
    toolType: 'Method / Target',
    toolPolicy: 'Execution Mode',
    modeRead: 'Read (Autonomous)',
    modeApproval: 'Approval Required (Default for write)',
    savePolicy: 'Save Runtime Policy',
    validationError: 'Please correct invalid limit values before saving.'
  },

  deliveries: {
    heading: 'Outbox Deliveries',
    subheading: 'Durable partner event deliveries with automatic retry and backoff.',
    colEventId: 'Event ID',
    colEvent: 'Event Type',
    colWebhook: 'Webhook Target',
    colStatus: 'Status',
    colAttempts: 'Attempts',
    colNextAttempt: 'Next Attempt',
    colError: 'Last Error',
    colActions: 'Actions',
    retryBtn: 'Retry',
    retryExpl: 'Requeues the dead event delivery to the target webhook. Does not re-run entity actions.',
    statusPending: 'Pending',
    statusDelivering: 'Delivering',
    statusDelivered: 'Delivered',
    statusDead: 'Dead (Failed)',
    noDeliveries: 'No outbox deliveries found for this tenant.',
    retrySuccess: 'Delivery requeued for retry.'
  },

  embed: {
    heading: 'Embed Code & Integration Guide',
    subheading: 'Copy the client snippet and review secure authentication practices.',
    snippetTitle: 'HTML Embed Snippet',
    copySnippet: 'Copy Snippet',
    copied: 'Copied to clipboard!',
    securityNotice: 'Security Notice: This snippet uses only the public tenant key. Never expose your tenant signing secret in browser code, HTML, or client storage.',
    backendAuthTitle: '1. Authenticated User Flow (Backend Session)',
    backendAuthDesc: 'Your backend signs a context token with your tenant secret (or calls POST /thruline/v1/support/session) with the user ID, role, and permissions, then passes the signed contextToken to the browser.',
    tokenUpdateTitle: '2. Identity Switch & Sign-out',
    tokenUpdateDesc: 'When a customer signs in or out, call FreeLLMAPISupport.updateContextToken(newToken). This securely clears prior conversation and polling state.',
    guestSessionTitle: '3. Unauthenticated Visitors (Guest Sessions)',
    guestSessionDesc: 'For visitors without an account, omit contextToken and keep allowGuestSession: true. The server mints an isolated guest session with 900-second TTL.'
  }
}

export type SupportIntegrationStrings = typeof en

export const SUPPORT_INTEGRATION_STRINGS: Record<'en' | 'vi', SupportIntegrationStrings> = {
  en,
  vi: {
    nav: 'Tích hợp & Khởi chạy',
    title: 'Trung tâm tích hợp AI Support',
    subtitle: 'Kiểm tra độ sẵn sàng các thành phần, cấu hình runtime, theo dõi sự kiện outbox và tạo mã nhúng bảo mật.',
    tenant: 'Đối tác đang chọn',
    noTenants: 'Chưa có đối tác nào. Vui lòng tạo đối tác trong Cổng AI Support trước.',
    readOnly: 'Bạn cần quyền chỉnh sửa cài đặt X-Gateway để thay đổi cấu hình này.',
    loading: 'Đang tải…',
    retry: 'Thử lại',
    refresh: 'Làm mới',
    saving: 'Đang lưu…',
    saved: 'Đã lưu cấu hình runtime thành công.',
    empty: 'Chưa có dữ liệu.',

    tabs: {
      readiness: 'Sẵn sàng',
      runtime: 'Chính sách Runtime',
      deliveries: 'Giao nhận Outbox',
      embed: 'Mã nhúng & SDK'
    },

    readiness: {
      heading: 'Kiểm tra độ sẵn sàng các thành phần',
      subheading: 'Đánh giá cấu hình đối tác và tính khả dụng của các thành phần mà không gọi provider bên ngoài hoặc gây tác động phụ.',
      overallReady: 'Đối tác đã sẵn sàng phục vụ lưu lượng thực tế.',
      overallWarning: 'Cấu hình có cảnh báo. Vui lòng xem các khuyến nghị bên dưới.',
      overallError: 'Cấu hình có lỗi ngăn cản hoạt động thực tế.',
      colComponent: 'Thành phần',
      colStatus: 'Trạng thái',
      colDetails: 'Chi tiết',
      statusReady: 'Sẵn sàng',
      statusWarning: 'Cảnh báo',
      statusError: 'Lỗi',
      retryAction: 'Kiểm tra lại',
      components: {
        tenant: 'Cấu hình Đối tác',
        origins: 'Tên miền cho phép (CORS)',
        model: 'Nhà cung cấp AI Model',
        knowledge: 'Kho tri thức',
        masking: 'Tường lửa che dữ liệu (PII)',
        guardrails: 'Tường lửa an toàn (Guardrails)',
        quota: 'Hạn ngạch sử dụng',
        approvals: 'Quy trình phê duyệt',
        worker: 'Tiến trình Outbox'
      },
      codes: {
        tenant_ready: 'Đối tác đã được bật và hoạt động',
        tenant_disabled: 'Đối tác hiện đang bị tắt',
        origins_configured: 'Tên miền cho phép đã được cấu hình cụ thể',
        origins_unrestricted: 'Tên miền cho phép đang mở (*). Trong môi trường thực tế, nên cấu hình tên miền chính xác.',
        model_ready: 'Tài khoản nhà cung cấp cho mô hình mặc định đã sẵn sàng',
        model_check_failed: 'Không thể kiểm tra cấu hình nhà cung cấp',
        knowledge_unavailable: 'Không thể truy cập kho tri thức',
        model_no_accounts: 'Chưa có tài khoản nhà cung cấp nào cho mô hình mặc định',
        knowledge_ready: 'Kho tri thức đã có tài liệu được lập chỉ mục',
        knowledge_empty: 'Kho tri thức chưa có tài liệu nào đang kích hoạt (cảnh báo)',
        masking_ready: 'Tường lửa che dữ liệu nhạy cảm đang hoạt động',
        masking_disabled: 'Tường lửa che dữ liệu nhạy cảm đang bị tắt',
        guardrails_ready: 'Tường lửa an toàn đang hoạt động',
        guardrails_disabled: 'Tường lửa an toàn đang bị tắt',
        quota_ready: 'Hạn ngạch sử dụng đã được cấu hình',
        quota_unconfigured: 'Hạn ngạch sử dụng chưa được thiết lập',
        quota_unavailable: 'Không thể truy cập bộ lưu trữ hạn ngạch',
        approvals_unavailable: 'Không thể truy cập bộ lưu trữ phê duyệt',
        approvals_ready: 'Quy trình phê duyệt hành động đã cấu hình',
        worker_ready: 'Tiến trình gửi sự kiện outbox đang chạy',
        worker_missing_heartbeat: 'Không phát hiện tín hiệu hoạt động (heartbeat) gần đây của worker'
      }
    },

    runtime: {
      heading: 'Chính sách thực thi AI Support',
      subheading: 'Thiết lập giới hạn token, chế độ an toàn công cụ và độ dài ngữ cảnh. Công cụ mặc định yêu cầu phê duyệt.',
      allowedModelsLabel: 'Các mô hình bổ sung được phép',
      allowedModelsHelp: 'Danh sách mô hình phân cách bằng dấu phẩy. Mô hình mặc định luôn được cho phép.',
      maxCompletionTokensLabel: 'Số token hoàn thành tối đa',
      maxCompletionTokensHelp: 'Số nguyên từ 1 đến 4096 (mặc định: 512) mỗi lời gọi mô hình',
      maxModelCallsLabel: 'Số lần gọi mô hình tối đa',
      maxModelCallsHelp: 'Số nguyên từ 1 đến 3 (mặc định: 3) mỗi lượt',
      maxToolCallsLabel: 'Số lần gọi công cụ tối đa',
      maxToolCallsHelp: 'Số nguyên từ 0 đến 3 (mặc định: 3) mỗi lượt',
      maxContextCharsLabel: 'Ký tự ngữ cảnh tối đa',
      maxContextCharsHelp: 'Số nguyên từ 1000 đến 32000 (mặc định: 16000)',
      maxToolResultCharsLabel: 'Ký tự kết quả công cụ tối đa',
      maxToolResultCharsHelp: 'Số nguyên từ 256 đến 16000 (mặc định: 8000) mỗi kết quả',
      maxHistoryMessagesLabel: 'Số tin nhắn lịch sử tối đa',
      maxHistoryMessagesHelp: 'Số nguyên từ 2 đến 100 (mặc định: 40)',
      toolsHeading: 'Phân loại an toàn công cụ',
      toolsHelp: 'Các công cụ ghi/POST mặc định phải chờ phê duyệt. Để cho phép chạy tự động không cần nhân viên duyệt, hãy chọn chế độ Đọc.',
      toolName: 'Tên công cụ',
      toolType: 'Phương thức / Đích',
      toolPolicy: 'Chế độ thực thi',
      modeRead: 'Đọc (Chạy tự động)',
      modeApproval: 'Yêu cầu duyệt (Mặc định cho ghi)',
      savePolicy: 'Lưu chính sách Runtime',
      validationError: 'Vui lòng sửa các giá trị vượt ngưỡng hợp lệ trước khi lưu.'
    },

    deliveries: {
      heading: 'Nhật ký giao nhận Outbox',
      subheading: 'Giao nhận sự kiện bền vững với cơ chế thử lại và backoff tự động.',
      colEventId: 'Mã sự kiện',
      colEvent: 'Loại sự kiện',
      colWebhook: 'Điểm nhận Webhook',
      colStatus: 'Trạng thái',
      colAttempts: 'Số lần thử',
      colNextAttempt: 'Lần thử tiếp',
      colError: 'Lỗi cuối',
      colActions: 'Hành động',
      retryBtn: 'Thử lại',
      retryExpl: 'Đưa lại sự kiện thất bại vào hàng đợi gửi đến webhook. Không chạy lại hành động nghiệp vụ.',
      statusPending: 'Chờ gửi',
      statusDelivering: 'Đang gửi',
      statusDelivered: 'Đã gửi',
      statusDead: 'Không gửi được (Dead)',
      noDeliveries: 'Không có sự kiện outbox nào cho đối tác này.',
      retrySuccess: 'Đã đưa bản giao vào hàng đợi thử lại.'
    },

    embed: {
      heading: 'Mã nhúng & Hướng dẫn tích hợp',
      subheading: 'Sao chép đoạn mã nhúng và xem hướng dẫn xác thực an toàn.',
      snippetTitle: 'Đoạn mã nhúng HTML',
      copySnippet: 'Sao chép mã',
      copied: 'Đã sao chép vào khay nhớ tạm!',
      securityNotice: 'Lưu ý bảo mật: Đoạn mã này chỉ chứa khóa công khai của đối tác. Tuyệt đối không để lộ mã bí mật ký (signing secret) trong mã nguồn trình duyệt, HTML hoặc bộ nhớ máy khách.',
      backendAuthTitle: '1. Luồng người dùng đã đăng nhập (Phiên qua Backend)',
      backendAuthDesc: 'Backend của bạn ký contextToken bằng tenant secret (hoặc gọi POST /thruline/v1/support/session) kèm ID, vai trò và quyền của người dùng, sau đó chuyển contextToken cho trình duyệt.',
      tokenUpdateTitle: '2. Đổi người dùng hoặc đăng xuất',
      tokenUpdateDesc: 'Khi khách hàng đăng nhập hoặc đăng xuất, gọi FreeLLMAPISupport.updateContextToken(newToken). Hàm này sẽ xóa an toàn hội thoại và phiên thăm dò cũ.',
      guestSessionTitle: '3. Khách vãng lai (Phiên khách tạm thời)',
      guestSessionDesc: 'Với khách chưa đăng nhập, không truyền contextToken và giữ allowGuestSession: true. Server sẽ tự cấp phiên khách độc lập với thời hạn 900 giây.'
    }
  }
}

export function useSupportIntegrationStrings() {
  const { locale } = useI18n()
  return SUPPORT_INTEGRATION_STRINGS[locale === 'vi' ? 'vi' : 'en']
}
