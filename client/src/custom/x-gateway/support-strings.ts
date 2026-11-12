import { useI18n } from '@/i18n';

export interface SupportStrings {
  supportTitle: string;
  supportSubtitle: string;
  supportNav: string;

  // Tenant management
  tenants: string;
  selectTenant: string;
  newTenant: string;
  createTenantTitle: string;
  editTenantTitle: string;
  tenantName: string;
  tenantSlug: string;
  tenantSlugHelp: string;
  defaultModel: string;
  defaultModelHelp: string;
  allowedOrigins: string;
  allowedOriginsHelp: string;
  allowGuest: string;
  allowGuestHelp: string;
  seedSampleDb: string;
  seedSampleDbHelp: string;
  systemPrompt: string;
  systemPromptPlaceholder: string;
  publicKey: string;
  signingSecret: string;
  signingSecretMasked: string;
  rotateSecret: string;
  rotateSecretConfirm: string;
  deleteTenant: string;
  deleteTenantConfirm: string;
  newSecretBannerTitle: string;
  newSecretBannerDesc: string;
  dismissSecretBanner: string;

  // Tabs
  tabOverview: string;
  tabWebhookTools: string;
  tabDatabase: string;
  tabSimulator: string;
  tabEmbed: string;

  // Roles config in Overview
  rolesConfigTitle: string;
  rolesConfigDesc: string;
  roleColumnRole: string;
  roleColumnLabel: string;
  roleColumnPermissions: string;
  roleColumnActions: string;
  addRole: string;
  editRole: string;
  deleteRole: string;
  permissionsHelp: string;

  // Webhook Tools (Mode A)
  webhookToolsTitle: string;
  webhookToolsDesc: string;
  addWebhookTool: string;
  editWebhookTool: string;
  deleteWebhookToolConfirm: string;
  toolName: string;
  toolDescription: string;
  toolMethod: string;
  toolEndpointUrl: string;
  toolHeaders: string;
  toolHeadersHelp: string;
  toolParametersSchema: string;
  toolParametersSchemaHelp: string;
  allowedRoles: string;
  allowedRolesHelp: string;
  lockUserIdParam: string;
  lockUserIdParamHelp: string;
  bypassUserLockRoles: string;
  bypassUserLockRolesHelp: string;
  webhookTesterTitle: string;
  webhookTesterDesc: string;
  selectToolToTest: string;
  simulatedRole: string;
  simulatedUserId: string;
  simulatedUserName: string;
  testArgumentsJson: string;
  testWebhookButton: string;
  testingWebhook: string;
  effectiveArgsTitle: string;
  effectiveArgsHelp: string;
  webhookResponseTitle: string;
  noWebhookTools: string;

  // Database & Policies (Mode B)
  dbSourcesTitle: string;
  dbSourcesDesc: string;
  addDbSource: string;
  editDbSource: string;
  deleteDbSourceConfirm: string;
  sourceName: string;
  driver: string;
  connectionUrl: string;
  authToken: string;
  schemaSql: string;
  loadSampleSql: string;
  sampleSqlLoaded: string;
  maxRows: string;
  tablePoliciesTitle: string;
  tablePoliciesDesc: string;
  tableName: string;
  rowOwnerColumn: string;
  rowOwnerColumnHelp: string;
  deniedColumns: string;
  deniedColumnsHelp: string;
  bypassRowLockRoles: string;
  bypassRowLockRolesHelp: string;
  addTablePolicy: string;
  noDbSources: string;

  // SQL Policy Tester
  sqlTesterTitle: string;
  sqlTesterDesc: string;
  sqlQueryLabel: string;
  runSqlTestButton: string;
  testingSql: string;
  rewrittenSqlTitle: string;
  rewrittenSqlHelp: string;
  queryResultsTitle: string;
  rowsCount: string;
  presetProductsGuest: string;
  presetOrdersCust101: string;
  presetCustomersDenied: string;
  presetMaliciousDrop: string;

  // Role Simulator
  simulatorTitle: string;
  simulatorDesc: string;
  simulatedIdentity: string;
  presetGuest: string;
  presetCustomerAlice: string;
  presetCustomerBob: string;
  presetAdmin: string;
  allowedToolsBadges: string;
  chatPlaceholder: string;
  sendChat: string;
  sendingChat: string;
  clearChat: string;
  quickPromptCatalog: string;
  quickPromptMyOrders: string;
  quickPromptAllOrders: string;
  quickPromptSecretNote: string;
  toolTraceTitle: string;
  toolTraceEmpty: string;
  toolTraceKind: string;
  toolTraceDuration: string;
  modelUsed: string;
  tokenUsage: string;

  // Embed Widget & Integration
  embedTitle: string;
  embedDesc: string;
  widgetSnippetTitle: string;
  widgetSnippetDesc: string;
  backendSnippetTitle: string;
  backendSnippetDesc: string;
  mintTokenTitle: string;
  mintTokenDesc: string;
  mintTokenButton: string;
  mintingToken: string;
  generatedToken: string;
  tokenExpiresIn: string;
  userContextPreview: string;

  // Common
  save: string;
  saving: string;
  cancel: string;
  delete: string;
  create: string;
  creating: string;
  edit: string;
  copy: string;
  copied: string;
  loading: string;
  errorLoading: string;
  retry: string;
  enabled: string;
  disabled: string;
  status: string;
  actions: string;
  emptyState: string;
  emptyStateDesc: string;
  verified: string;
  readOnlyBadge: string;
}

const STRINGS: Record<'en' | 'vi', SupportStrings> = {
  en: {
    supportTitle: 'AI Support Gateway',
    supportSubtitle: 'Multi-Tenant Customer Support Gateway with Role-Aware Webhook Tools (Mode A) and Row-Isolated Database Connectors (Mode B).',
    supportNav: 'AI Support',

    // Tenant management
    tenants: 'Partner Tenants',
    selectTenant: 'Select Partner Tenant',
    newTenant: 'New Tenant',
    createTenantTitle: 'Create Partner Website Tenant',
    editTenantTitle: 'Edit Partner Tenant',
    tenantName: 'Tenant Name',
    tenantSlug: 'URL Slug',
    tenantSlugHelp: 'Unique slug identifier for URL pathing (e.g. shop-demo).',
    defaultModel: 'Default Model',
    defaultModelHelp: 'AI model to serve support inquiries (e.g. auto, combo:fast, or provider/model).',
    allowedOrigins: 'Allowed CORS Origins',
    allowedOriginsHelp: 'Comma or newline separated list of allowed website origins (e.g. https://shop.example.com).',
    allowGuest: 'Allow Unauthenticated Guests',
    allowGuestHelp: 'Permit anonymous visitors to query public catalogs without a signed context token.',
    seedSampleDb: 'Seed Sample E-Commerce DB',
    seedSampleDbHelp: 'Automatically populate a preconfigured SQLite sandbox with products, orders, and customer tables with RBAC policies.',
    systemPrompt: 'System Prompt',
    systemPromptPlaceholder: 'You are the helpful AI customer service representative for our storefront. Assist customers politely and accurately using your tools.',
    publicKey: 'Public Tenant Key',
    signingSecret: 'Signing Secret',
    signingSecretMasked: 'Masked Secret',
    rotateSecret: 'Rotate Secret',
    rotateSecretConfirm: 'Are you sure you want to rotate the signing secret? Existing integrations will need to update their secret key immediately.',
    deleteTenant: 'Delete Tenant',
    deleteTenantConfirm: 'Are you sure you want to delete this tenant and all associated webhook tools and database configurations? This action cannot be undone.',
    newSecretBannerTitle: 'New Signing Secret Generated',
    newSecretBannerDesc: 'Copy this secret now! For security reasons, it will not be displayed in full again.',
    dismissSecretBanner: 'Dismiss',

    // Tabs
    tabOverview: 'Overview & Roles',
    tabWebhookTools: 'Webhook Tools (Mode A)',
    tabDatabase: 'Database & Policies (Mode B)',
    tabSimulator: 'Live Role Simulator',
    tabEmbed: 'Embed Widget & Integration',

    // Roles config in Overview
    rolesConfigTitle: 'Tenant Roles & Permission Mapping',
    rolesConfigDesc: 'Define the user roles supported by your website and the permission tags attached to each role.',
    roleColumnRole: 'Role Identifier',
    roleColumnLabel: 'Display Label',
    roleColumnPermissions: 'Permissions',
    roleColumnActions: 'Actions',
    addRole: 'Add Role',
    editRole: 'Edit Role',
    deleteRole: 'Delete Role',
    permissionsHelp: 'Comma-separated permissions (e.g. products:read, orders:read_own).',

    // Webhook Tools (Mode A)
    webhookToolsTitle: 'Webhook Tools (Mode A: REST API Connectors)',
    webhookToolsDesc: 'Allow the AI to call partner backend APIs. Enforces identity locking so non-staff roles cannot query other customers’ data.',
    addWebhookTool: 'New Webhook Tool',
    editWebhookTool: 'Edit Webhook Tool',
    deleteWebhookToolConfirm: 'Are you sure you want to delete this webhook tool?',
    toolName: 'Tool Name',
    toolDescription: 'Tool Description',
    toolMethod: 'HTTP Method',
    toolEndpointUrl: 'Endpoint URL',
    toolHeaders: 'Custom Headers (JSON)',
    toolHeadersHelp: 'Optional headers (e.g. {"Authorization": "Bearer token"}). The gateway also sends an HMAC X-Support-Signature header.',
    toolParametersSchema: 'Parameters Schema (JSON Schema)',
    toolParametersSchemaHelp: 'JSON schema defining parameters the AI can supply when invoking this tool.',
    allowedRoles: 'Allowed Roles',
    allowedRolesHelp: 'Comma-separated roles permitted to invoke this tool (e.g. customer, staff, admin).',
    lockUserIdParam: 'Lock User-ID Parameter Name',
    lockUserIdParamHelp: 'Parameter name automatically forced to equal context.userId (e.g. user_id). Prevents IDOR vulnerabilities.',
    bypassUserLockRoles: 'Bypass Lock Roles',
    bypassUserLockRolesHelp: 'Roles permitted to query arbitrary user IDs (e.g. admin, staff).',
    webhookTesterTitle: 'Live Webhook Tester',
    webhookTesterDesc: 'Simulate an AI tool execution with signed context and inspect the effective arguments after user-locking enforcement.',
    selectToolToTest: 'Select Tool to Test',
    simulatedRole: 'Simulated Role',
    simulatedUserId: 'Simulated User ID',
    simulatedUserName: 'Simulated User Name',
    testArgumentsJson: 'Input Arguments (JSON)',
    testWebhookButton: 'Execute Webhook Test',
    testingWebhook: 'Executing Webhook...',
    effectiveArgsTitle: 'Effective Arguments (Post-Enforcement)',
    effectiveArgsHelp: 'Notice how lockUserIdParam was automatically enforced or overridden for non-staff roles.',
    webhookResponseTitle: 'Webhook Response',
    noWebhookTools: 'No webhook tools configured yet. Click "New Webhook Tool" above to connect your backend REST endpoints.',

    // Database & Policies (Mode B)
    dbSourcesTitle: 'Database Sources (Mode B: Read-Only SQL Connectors)',
    dbSourcesDesc: 'Connect SQLite Sandboxes or SQL-over-HTTP endpoints. AST-level SQL validation restricts commands to SELECT and enforces Row-Level Security.',
    addDbSource: 'New DB Source',
    editDbSource: 'Edit DB Source',
    deleteDbSourceConfirm: 'Are you sure you want to delete this database source?',
    sourceName: 'Database Source Name',
    driver: 'Connector Driver',
    connectionUrl: 'Remote Connection URL',
    authToken: 'Authentication Token',
    schemaSql: 'Schema & Bootstrap SQL',
    loadSampleSql: 'Load Sample E-Commerce SQL',
    sampleSqlLoaded: 'Sample E-Commerce SQL loaded successfully!',
    maxRows: 'Max Rows Returned',
    tablePoliciesTitle: 'Table Security & Row-Level Isolation Policies',
    tablePoliciesDesc: 'Specify role permissions, denied confidential columns, and row-owner columns for each table.',
    tableName: 'Table Name',
    rowOwnerColumn: 'Row Owner Column',
    rowOwnerColumnHelp: 'Column name matching context.userId (e.g. user_id or id). Automatically rewrites SQL to filter records by owner.',
    deniedColumns: 'Denied Confidential Columns',
    deniedColumnsHelp: 'Comma-separated sensitive columns hidden from AI and queries (e.g. password_hash, secret_note).',
    bypassRowLockRoles: 'Bypass Row-Lock Roles',
    bypassRowLockRolesHelp: 'Roles permitted to view all rows without owner filtering (e.g. admin, staff).',
    addTablePolicy: 'Add Table Policy',
    noDbSources: 'No database sources configured yet. Click "New DB Source" above to connect a database.',

    // SQL Policy Tester
    sqlTesterTitle: 'Live SQL Role Policy Tester',
    sqlTesterDesc: 'Verify how user roles, row-level filters, and column blacklists transform SQL queries before execution.',
    sqlQueryLabel: 'Input SQL Query (SELECT only)',
    runSqlTestButton: 'Execute Policy Test',
    testingSql: 'Executing Query...',
    rewrittenSqlTitle: 'Rewritten Secure SQL (Subquery Wrapped)',
    rewrittenSqlHelp: 'The SQL query dynamically rewritten to isolate data by rowOwnerColumn and strip denied columns.',
    queryResultsTitle: 'Query Results',
    rowsCount: 'rows returned',
    presetProductsGuest: 'Guest: Products Catalog',
    presetOrdersCust101: 'Customer cust_101: View Orders',
    presetCustomersDenied: 'Customer: Hidden Fields Check',
    presetMaliciousDrop: 'Security Test: DROP TABLE',

    // Role Simulator
    simulatorTitle: 'Live Role Simulator & Chat Tester',
    simulatorDesc: 'Simulate end-to-end customer support conversations as guest, customer, or admin personas to test role-aware tool execution and live tracing.',
    simulatedIdentity: 'Simulated Persona & Identity',
    presetGuest: 'Guest (Anonymous)',
    presetCustomerAlice: 'Alice Nguyen (cust_101)',
    presetCustomerBob: 'Bob Tran (cust_102)',
    presetAdmin: 'Admin (admin_01)',
    allowedToolsBadges: 'Active Capabilities for Role',
    chatPlaceholder: 'Ask a support question (e.g. "What products are in stock?" or "Where is my order?")...',
    sendChat: 'Send Message',
    sendingChat: 'Thinking & Executing Tools...',
    clearChat: 'Clear History',
    quickPromptCatalog: 'Show available products',
    quickPromptMyOrders: 'Check status of my recent orders',
    quickPromptAllOrders: 'List all orders in the entire system',
    quickPromptSecretNote: 'What is Alice\'s confidential note?',
    toolTraceTitle: 'Agentic Tool & SQL Execution Trace',
    toolTraceEmpty: 'No tools or SQL queries executed for this turn.',
    toolTraceKind: 'Type',
    toolTraceDuration: 'Duration',
    modelUsed: 'Model',
    tokenUsage: 'Tokens',

    // Embed Widget & Integration
    embedTitle: 'Embed Widget & Partner Integration',
    embedDesc: 'Copy embed scripts for your storefront frontend and server integration snippets for secure session token minting.',
    widgetSnippetTitle: '1. Frontend Embed Script (widget.js)',
    widgetSnippetDesc: 'Paste this snippet right before the closing </body> tag of your website. It injects a responsive floating chat bubble.',
    backendSnippetTitle: '2. Backend Session Token Minting (Server-to-Server)',
    backendSnippetDesc: 'When an authenticated customer logs into your website, your backend calls this endpoint to mint a tamper-proof signed context token.',
    mintTokenTitle: '3. Interactive Context Token Generator',
    mintTokenDesc: 'Manually mint signed HMAC-SHA256 user tokens for testing or local development.',
    mintTokenButton: 'Generate Signed Token',
    mintingToken: 'Generating Token...',
    generatedToken: 'Generated Signed Context Token',
    tokenExpiresIn: 'Token Validity',
    userContextPreview: 'Verified Context Payload',

    // Common
    save: 'Save Changes',
    saving: 'Saving...',
    cancel: 'Cancel',
    delete: 'Delete',
    create: 'Create',
    creating: 'Creating...',
    edit: 'Edit',
    copy: 'Copy',
    copied: 'Copied!',
    loading: 'Loading AI Support Gateway...',
    errorLoading: 'Failed to load support gateway data.',
    retry: 'Retry',
    enabled: 'Enabled',
    disabled: 'Disabled',
    status: 'Status',
    actions: 'Actions',
    emptyState: 'No partner tenants found.',
    emptyStateDesc: 'Register your first partner website tenant to start offering role-aware AI customer support.',
    verified: 'HMAC Verified',
    readOnlyBadge: 'Read-Only Mode',
  },
  vi: {
    supportTitle: 'Cổng AI Support',
    supportSubtitle: 'Cổng AI chăm sóc khách hàng đa đối tác với công cụ Webhook theo Role (Cách A) và kết nối Cơ sở dữ liệu phân quyền theo dòng (Cách B).',
    supportNav: 'AI Support',

    // Tenant management
    tenants: 'Website Đối tác (Tenants)',
    selectTenant: 'Chọn Website Đối tác',
    newTenant: 'Tạo Tenant mới',
    createTenantTitle: 'Đăng ký Website Đối tác mới',
    editTenantTitle: 'Cấu hình Website Đối tác',
    tenantName: 'Tên Website / Tenant',
    tenantSlug: 'Đường dẫn định danh (Slug)',
    tenantSlugHelp: 'Định danh duy nhất trên URL (ví dụ: shop-demo).',
    defaultModel: 'Mô hình AI mặc định',
    defaultModelHelp: 'Mô hình xử lý hội thoại (ví dụ: auto, combo:fast, hoặc provider/model).',
    allowedOrigins: 'Miền CORS cho phép',
    allowedOriginsHelp: 'Danh sách URL website được phép gọi tới, phân tách bằng dấu phẩy hoặc xuống dòng (ví dụ: https://shop.example.com).',
    allowGuest: 'Cho phép Khách vãng lai (Guest)',
    allowGuestHelp: 'Cho phép khách chưa đăng nhập tra cứu thông tin công khai mà không cần token định danh.',
    seedSampleDb: 'Khởi tạo sẵn DB E-Commerce mẫu',
    seedSampleDbHelp: 'Tự động tạo cơ sở dữ liệu SQLite mẫu với bảng sản phẩm (products), đơn hàng (orders) và khách hàng (customers) kèm chính sách phân quyền.',
    systemPrompt: 'System Prompt',
    systemPromptPlaceholder: 'Bạn là trợ lý AI chăm sóc khách hàng cho website. Hãy trả lời lịch sự, chính xác và sử dụng công cụ phù hợp theo quyền của người hỏi.',
    publicKey: 'Khóa công khai (Public Key)',
    signingSecret: 'Mã bí mật ký tên (Signing Secret)',
    signingSecretMasked: 'Khóa bí mật',
    rotateSecret: 'Đổi Signing Secret',
    rotateSecretConfirm: 'Bạn có chắc chắn muốn tạo mới mã bí mật ký tên không? Các tích hợp backend hiện tại sẽ cần cập nhật khóa mới ngay lập tức.',
    deleteTenant: 'Xóa Tenant',
    deleteTenantConfirm: 'Bạn có chắc chắn muốn xóa đối tác này cùng toàn bộ công cụ webhook và cơ sở dữ liệu liên kết không? Hành động này không thể hoàn tác.',
    newSecretBannerTitle: 'Signing Secret mới đã được tạo',
    newSecretBannerDesc: 'Hãy sao chép mã bí mật này ngay! Vì lý do an toàn, mã bí mật đầy đủ sẽ không được hiển thị lại.',
    dismissSecretBanner: 'Đóng thông báo',

    // Tabs
    tabOverview: 'Tổng quan & Roles',
    tabWebhookTools: 'Webhook Tools (Cách A)',
    tabDatabase: 'Cơ sở dữ liệu & Policies (Cách B)',
    tabSimulator: 'Trình giả lập Role',
    tabEmbed: 'Mã nhúng & Tích hợp',

    // Roles config in Overview
    rolesConfigTitle: 'Cấu hình Phân quyền (Roles & Permissions)',
    rolesConfigDesc: 'Khai báo các nhóm người dùng trên website của bạn và danh sách quyền hạn đi kèm.',
    roleColumnRole: 'Mã Role',
    roleColumnLabel: 'Tên hiển thị',
    roleColumnPermissions: 'Quyền hạn (Permissions)',
    roleColumnActions: 'Thao tác',
    addRole: 'Thêm Role',
    editRole: 'Sửa Role',
    deleteRole: 'Xóa Role',
    permissionsHelp: 'Danh sách quyền phân tách bằng dấu phẩy (ví dụ: products:read, orders:read_own).',

    // Webhook Tools (Mode A)
    webhookToolsTitle: 'Webhook Tools (Cách A: Kết nối REST API)',
    webhookToolsDesc: 'Cho phép AI gọi API của website đối tác. Cơ chế khóa User-ID ngăn chặn triệt để lỗ hổng truy cập trái phép đơn hàng của người khác.',
    addWebhookTool: 'Tạo Webhook Tool mới',
    editWebhookTool: 'Chỉnh sửa Webhook Tool',
    deleteWebhookToolConfirm: 'Bạn có chắc chắn muốn xóa webhook tool này không?',
    toolName: 'Tên Tool',
    toolDescription: 'Mô tả tính năng cho AI',
    toolMethod: 'Phương thức HTTP',
    toolEndpointUrl: 'Đường dẫn Endpoint URL',
    toolHeaders: 'Headers tùy chỉnh (JSON)',
    toolHeadersHelp: 'Header tùy chọn (ví dụ: {"Authorization": "Bearer token"}). Cổng AI cũng tự động ký chữ ký HMAC header X-Support-Signature.',
    toolParametersSchema: 'Cấu trúc tham số (JSON Schema)',
    toolParametersSchemaHelp: 'Khai báo định dạng tham số để mô hình AI biết cách truyền dữ liệu khi gọi tool.',
    allowedRoles: 'Role được phép gọi',
    allowedRolesHelp: 'Các role có quyền sử dụng công cụ này (ví dụ: customer, staff, admin).',
    lockUserIdParam: 'Tên tham số khóa User-ID',
    lockUserIdParamHelp: 'Tên tham số tự động bị ép bằng context.userId (ví dụ: user_id). Giúp chống giả mạo danh tính.',
    bypassUserLockRoles: 'Role được miễn khóa User-ID',
    bypassUserLockRolesHelp: 'Các role được quyền tra cứu bất kỳ user_id nào (ví dụ: admin, staff).',
    webhookTesterTitle: 'Thử nghiệm Webhook trực tiếp',
    webhookTesterDesc: 'Mô phỏng lượt gọi công cụ kèm ngữ cảnh người dùng và kiểm tra tính năng tự động ghi đè tham số user_id.',
    selectToolToTest: 'Chọn Tool cần kiểm tra',
    simulatedRole: 'Role mô phỏng',
    simulatedUserId: 'User ID mô phỏng',
    simulatedUserName: 'Tên người dùng mô phỏng',
    testArgumentsJson: 'Tham số đầu vào (JSON)',
    testWebhookButton: 'Chạy thử Webhook',
    testingWebhook: 'Đang thực thi Webhook...',
    effectiveArgsTitle: 'Tham số thực tế gửi đi (Effective Args)',
    effectiveArgsHelp: 'Xem cách cổng AI tự động bảo vệ tham số định danh với các role khách hàng.',
    webhookResponseTitle: 'Dữ liệu phản hồi từ Webhook',
    noWebhookTools: 'Chưa có webhook tool nào. Nhấn "Tạo Webhook Tool mới" để kết nối API backend của bạn.',

    // Database & Policies (Mode B)
    dbSourcesTitle: 'Cơ sở dữ liệu (Cách B: Truy vấn SQL Chỉ-Đọc có phân quyền)',
    dbSourcesDesc: 'Kết nối SQLite Sandbox hoặc cổng SQL-over-HTTP. Bộ phân tích cú pháp SQL bảo đảm chỉ cho phép lệnh SELECT và cách ly dữ liệu từng dòng.',
    addDbSource: 'Thêm nguồn DB mới',
    editDbSource: 'Sửa cấu hình DB',
    deleteDbSourceConfirm: 'Bạn có chắc chắn muốn xóa nguồn cơ sở dữ liệu này không?',
    sourceName: 'Tên nguồn dữ liệu',
    driver: 'Trình điều khiển (Driver)',
    connectionUrl: 'Địa chỉ kết nối từ xa (Connection URL)',
    authToken: 'Khóa xác thực (Auth Token)',
    schemaSql: 'Schema & Dữ liệu khởi tạo (SQL)',
    loadSampleSql: 'Tải SQL E-Commerce mẫu',
    sampleSqlLoaded: 'Đã nạp thành công bộ SQL E-Commerce mẫu!',
    maxRows: 'Số dòng tối đa trả về',
    tablePoliciesTitle: 'Chính sách bảo mật bảng & Phân quyền theo dòng',
    tablePoliciesDesc: 'Quy định quyền truy cập từng bảng, cột bảo mật cần giấu, và cột chủ sở hữu dòng để lọc dữ liệu.',
    tableName: 'Tên bảng',
    rowOwnerColumn: 'Cột sở hữu dòng (Row Owner Column)',
    rowOwnerColumnHelp: 'Tên cột chứa định danh khách hàng (ví dụ: user_id hoặc id). AI sẽ tự động chỉ thấy dòng của chính khách hàng đó.',
    deniedColumns: 'Các cột cấm truy cập (Ẩn khỏi AI)',
    deniedColumnsHelp: 'Danh sách cột nhạy cảm bị loại bỏ khỏi kết quả (ví dụ: password_hash, secret_note).',
    bypassRowLockRoles: 'Role được xem toàn bộ bảng',
    bypassRowLockRolesHelp: 'Các role quản trị không bị giới hạn theo dòng của riêng mình (ví dụ: admin, staff).',
    addTablePolicy: 'Thêm chính sách cho bảng',
    noDbSources: 'Chưa có nguồn dữ liệu nào. Nhấn "Thêm nguồn DB mới" để cấu hình.',

    // SQL Policy Tester
    sqlTesterTitle: 'Kiểm tra Chính sách SQL theo Role',
    sqlTesterDesc: 'Mô phỏng câu lệnh SQL để xem cách hệ thống tự động bọc subquery cách ly dòng và ẩn các cột tuyệt mật.',
    sqlQueryLabel: 'Câu lệnh SQL đầu vào (Chỉ chấp nhận SELECT)',
    runSqlTestButton: 'Chạy kiểm tra SQL',
    testingSql: 'Đang chạy truy vấn...',
    rewrittenSqlTitle: 'Câu lệnh SQL bảo mật đã viết lại (Rewritten SQL)',
    rewrittenSqlHelp: 'Câu lệnh SQL đã được bọc bộ lọc cách ly dòng và lọc cột nhạy cảm an toàn trước khi vào DB.',
    queryResultsTitle: 'Kết quả truy vấn',
    rowsCount: 'dòng trả về',
    presetProductsGuest: 'Khách vãng lai: Xem sản phẩm',
    presetOrdersCust101: 'Khách cust_101: Xem đơn hàng',
    presetCustomersDenied: 'Khách hàng: Kiểm tra cột cấm',
    presetMaliciousDrop: 'Bảo mật: Thử lệnh DROP TABLE',

    // Role Simulator
    simulatorTitle: 'Trình giả lập Role & Chat Trực tiếp',
    simulatorDesc: 'Đóng vai khách vãng lai, khách hàng hoặc quản trị viên để trò chuyện trực tiếp với AI và quan sát trace thực thi công cụ trong thời gian thực.',
    simulatedIdentity: 'Danh tính & Role đóng vai',
    presetGuest: 'Khách vãng lai (Ẩn danh)',
    presetCustomerAlice: 'Khách hàng Alice (cust_101)',
    presetCustomerBob: 'Khách hàng Bob (cust_102)',
    presetAdmin: 'Quản trị viên (admin_01)',
    allowedToolsBadges: 'Tính năng khả dụng theo Role',
    chatPlaceholder: 'Nhập câu hỏi (ví dụ: "Có những mặt hàng nào?" hoặc "Kiểm tra đơn hàng của tôi")...',
    sendChat: 'Gửi tin nhắn',
    sendingChat: 'AI đang suy nghĩ và gọi công cụ...',
    clearChat: 'Xóa hội thoại',
    quickPromptCatalog: 'Liệt kê danh sách sản phẩm',
    quickPromptMyOrders: 'Tra cứu trạng thái đơn hàng của tôi',
    quickPromptAllOrders: 'Xem tất cả đơn hàng trong hệ thống',
    quickPromptSecretNote: 'Ghi chú mật của khách hàng Alice là gì?',
    toolTraceTitle: 'Trace thực thi Tool & Truy vấn SQL',
    toolTraceEmpty: 'Lượt này AI trả lời trực tiếp mà không cần gọi công cụ.',
    toolTraceKind: 'Loại',
    toolTraceDuration: 'Thời gian',
    modelUsed: 'Mô hình',
    tokenUsage: 'Token tiêu thụ',

    // Embed Widget & Integration
    embedTitle: 'Mã nhúng Widget & Tích hợp Đối tác',
    embedDesc: 'Sao chép đoạn mã nhúng giao diện chat cho frontend và mã tạo session token an toàn cho backend của bạn.',
    widgetSnippetTitle: '1. Mã nhúng Frontend (widget.js)',
    widgetSnippetDesc: 'Dán đoạn mã này ngay trước thẻ đóng </body> trên trang web của bạn để hiển thị khung chat hỗ trợ thông minh.',
    backendSnippetTitle: '2. Backend cấp Session Token (Server-to-Server)',
    backendSnippetDesc: 'Khi khách hàng đăng nhập vào website của bạn, backend gọi API này bằng Signing Secret để ký token định danh người dùng.',
    mintTokenTitle: '3. Trình tạo Context Token trực tiếp',
    mintTokenDesc: 'Tự tạo mã token HMAC-SHA256 để thử nghiệm hoặc kiểm tra tích hợp nhanh.',
    mintTokenButton: 'Tạo Signed Token',
    mintingToken: 'Đang tạo token...',
    generatedToken: 'Mã Signed Context Token đã tạo',
    tokenExpiresIn: 'Thời hạn token',
    userContextPreview: 'Dữ liệu ngữ cảnh sau xác thực',

    // Common
    save: 'Lưu thay đổi',
    saving: 'Đang lưu...',
    cancel: 'Hủy',
    delete: 'Xóa',
    create: 'Tạo mới',
    creating: 'Đang tạo...',
    edit: 'Sửa',
    copy: 'Sao chép',
    copied: 'Đã sao chép!',
    loading: 'Đang tải Cổng AI Support...',
    errorLoading: 'Không thể tải dữ liệu cổng hỗ trợ.',
    retry: 'Thử lại',
    enabled: 'Đang bật',
    disabled: 'Đã tắt',
    status: 'Trạng thái',
    actions: 'Thao tác',
    emptyState: 'Chưa có website đối tác nào.',
    emptyStateDesc: 'Đăng ký đối tác đầu tiên để bắt đầu triển khai dịch vụ AI chăm sóc khách hàng phân quyền.',
    verified: 'Đã xác thực HMAC',
    readOnlyBadge: 'Chỉ đọc',
  },
};

export function useSupportStrings(): SupportStrings {
  const { locale } = useI18n();
  return STRINGS[locale === 'vi' ? 'vi' : 'en'];
}
