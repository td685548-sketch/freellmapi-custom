import { useI18n } from '@/i18n'

export interface XGatewayCopy {
  editCustomNode: string
  editCustomNodeDesc: string
  nodeName: string
  nodePrefix: string
  nodeType: string
  apiType: string
  apiTypeChat: string
  apiTypeResponses: string
  baseUrl: string
  validateEndpoint: string
  validating: string
  valid: string
  invalid: string
  models: string
  addModelPlaceholder: string
  add: string
  save: string
  saving: string
  cancel: string
  edit: string
  delete: string
  deleteConfirm: string
  editNodeSuccess: string
  requiredFields: string

  routingStrategy: string
  roundRobin: string
  fallback: string
  roundRobinHelp: string
  fallbackHelp: string
  stickyLimit: string
  stickyLimitHelp: string
  requestsUnit: string
  strategySaved: string

  priorityBadge: string
  moveUp: string
  moveDown: string
  priorityUpdated: string

  selectAll: string
  deselectAll: string
  selectedAccounts: string
  bulkDelete: string
  bulkDeleteConfirm: string
  bulkDeleting: string
  bulkDeleteSuccess: string
  bulkProxy: string
  bulkProxyModalTitle: string
  bulkProxyModalDesc: string
  proxyModeUnbind: string
  proxyModeRotate: string
  proxyModePool: string
  selectPool: string
  apply: string
  applying: string
  bulkProxySuccess: string

  testOneByOne: string
  testingOneByOne: string
  stopTest: string
  testStopped: string
  testCompleted: string
  statusHealthy: string
  statusError: string
  statusTesting: string
  statusWaiting: string

  providerConfig: string
  providerConfigDesc: string
  thinkingLevel: string
  thinkingAuto: string
  thinkingLow: string
  thinkingMedium: string
  thinkingHigh: string
  thinkingMax: string
  customHeaders: string
  customHeadersHelp: string
  addHeader: string
  headerName: string
  headerValue: string
  headerBlockedWarning: string
  saveConfig: string
  configSaved: string

  enableAllModels: string
  disableAllModels: string
  fetchLiveModels: string
  fetchingLiveModels: string
  fetchLiveModelsSuccess: string
  fetchLiveModelsError: string
  copyModelId: string
  modelIdCopied: string
}

const en: XGatewayCopy = {
  editCustomNode: 'Edit Compatible Provider',
  editCustomNodeDesc: 'Update endpoint parameters, supported model list, and validation for this custom node.',
  nodeName: 'Name',
  nodePrefix: 'Prefix',
  nodeType: 'Provider Type',
  apiType: 'API Type',
  apiTypeChat: 'Chat Completions (/chat/completions)',
  apiTypeResponses: 'Responses API (/responses)',
  baseUrl: 'Base URL',
  validateEndpoint: 'Validate Endpoint',
  validating: 'Validating…',
  valid: 'Valid',
  invalid: 'Invalid',
  models: 'Models',
  addModelPlaceholder: 'Add model ID (e.g. llama-3.3-70b)',
  add: 'Add',
  save: 'Save',
  saving: 'Saving…',
  cancel: 'Cancel',
  edit: 'Edit',
  delete: 'Delete',
  deleteConfirm: 'Are you sure you want to delete this custom node?',
  editNodeSuccess: 'Compatible provider node updated.',
  requiredFields: 'Name, Prefix, and Base URL are required.',

  routingStrategy: 'Routing Strategy',
  roundRobin: 'Round Robin',
  fallback: 'Priority Fallback',
  roundRobinHelp: 'Distribute incoming requests evenly across healthy accounts.',
  fallbackHelp: 'Always use highest priority healthy account before falling back.',
  stickyLimit: 'Sticky Limit',
  stickyLimitHelp: 'Keep consecutive requests on the same account (1–100 requests).',
  requestsUnit: 'reqs',
  strategySaved: 'Routing strategy updated.',

  priorityBadge: 'Priority',
  moveUp: 'Move Up',
  moveDown: 'Move Down',
  priorityUpdated: 'Account priority updated.',

  selectAll: 'Select all',
  deselectAll: 'Deselect all',
  selectedAccounts: '{count} selected',
  bulkDelete: 'Delete Selected',
  bulkDeleteConfirm: 'Are you sure you want to delete {count} selected account(s)?',
  bulkDeleting: 'Deleting…',
  bulkDeleteSuccess: 'Deleted {count} account(s).',
  bulkProxy: 'Apply Proxy',
  bulkProxyModalTitle: 'Apply Outbound Proxy to Selected Accounts',
  bulkProxyModalDesc: 'Choose how outbound proxy routing should be configured for {count} selected account(s).',
  proxyModeUnbind: 'Unbind (Direct / Gateway Default)',
  proxyModeRotate: '1-to-1 Rotate across Active Pools',
  proxyModePool: 'Bind to Specific Pool',
  selectPool: 'Select Proxy Pool',
  apply: 'Apply',
  applying: 'Applying…',
  bulkProxySuccess: 'Proxy settings updated for {count} account(s).',

  testOneByOne: 'Test One-by-One',
  testingOneByOne: 'Testing {current}/{total}…',
  stopTest: 'Stop',
  testStopped: 'Sequential testing stopped.',
  testCompleted: 'Testing completed: {passed}/{total} healthy.',
  statusHealthy: 'Healthy',
  statusError: 'Error',
  statusTesting: 'Testing…',
  statusWaiting: 'Waiting',

  providerConfig: 'Custom Configuration',
  providerConfigDesc: 'Configure default thinking level and custom outbound headers for upstream provider requests.',
  thinkingLevel: 'Thinking Level',
  thinkingAuto: 'Auto',
  thinkingLow: 'Low',
  thinkingMedium: 'Medium',
  thinkingHigh: 'High',
  thinkingMax: 'Max',
  customHeaders: 'Custom Outbound Headers',
  customHeadersHelp: 'Add custom headers to upstream HTTP calls. Hop-by-hop and auth headers are forbidden.',
  addHeader: 'Add Header',
  headerName: 'Header Name',
  headerValue: 'Header Value',
  headerBlockedWarning: 'Header "{name}" is reserved/restricted and cannot be overridden.',
  saveConfig: 'Save Configuration',
  configSaved: 'Provider configuration saved.',

  enableAllModels: 'Enable All',
  disableAllModels: 'Disable All',
  fetchLiveModels: 'Fetch Live Models',
  fetchingLiveModels: 'Fetching live models…',
  fetchLiveModelsSuccess: 'Fetched {count} live model(s) from upstream.',
  fetchLiveModelsError: 'Failed to fetch live models from upstream.',
  copyModelId: 'Copy Model ID',
  modelIdCopied: 'Copied!',
}

const vi: XGatewayCopy = {
  editCustomNode: 'Chỉnh sửa Node Tương thích',
  editCustomNodeDesc: 'Cập nhật tham số endpoint, danh sách model và kiểm tra kết nối cho node tùy chỉnh này.',
  nodeName: 'Tên hiển thị',
  nodePrefix: 'Tiền tố (Prefix)',
  nodeType: 'Loại Provider',
  apiType: 'Loại API',
  apiTypeChat: 'Chat Completions (/chat/completions)',
  apiTypeResponses: 'Responses API (/responses)',
  baseUrl: 'Base URL',
  validateEndpoint: 'Kiểm tra Endpoint',
  validating: 'Đang kiểm tra…',
  valid: 'Hợp lệ',
  invalid: 'Không hợp lệ',
  models: 'Danh sách Models',
  addModelPlaceholder: 'Nhập mã model (ví dụ: llama-3.3-70b)',
  add: 'Thêm',
  save: 'Lưu thay đổi',
  saving: 'Đang lưu…',
  cancel: 'Hủy',
  edit: 'Sửa',
  delete: 'Xóa',
  deleteConfirm: 'Bạn có chắc chắn muốn xóa node tùy chỉnh này?',
  editNodeSuccess: 'Đã cập nhật node tương thích thành công.',
  requiredFields: 'Vui lòng điền đủ Tên, Tiền tố và Base URL.',

  routingStrategy: 'Chiến lược Định tuyến',
  roundRobin: 'Xoay vòng (Round Robin)',
  fallback: 'Ưu tiên dự phòng (Fallback)',
  roundRobinHelp: 'Phân bổ đều các request vào các tài khoản khả dụng.',
  fallbackHelp: 'Ưu tiên gọi tài khoản có thứ tự cao nhất trước khi chuyển tiếp.',
  stickyLimit: 'Giới hạn bám dính (Sticky Limit)',
  stickyLimitHelp: 'Giữ các request liên tiếp trên cùng một tài khoản (1–100 requests).',
  requestsUnit: 'yêu cầu',
  strategySaved: 'Đã cập nhật chiến lược định tuyến.',

  priorityBadge: 'Ưu tiên',
  moveUp: 'Lên trên',
  moveDown: 'Xuống dưới',
  priorityUpdated: 'Đã cập nhật độ ưu tiên tài khoản.',

  selectAll: 'Chọn tất cả',
  deselectAll: 'Bỏ chọn',
  selectedAccounts: 'Đã chọn {count}',
  bulkDelete: 'Xóa đã chọn',
  bulkDeleteConfirm: 'Bạn có chắc chắn muốn xóa {count} tài khoản đã chọn?',
  bulkDeleting: 'Đang xóa…',
  bulkDeleteSuccess: 'Đã xóa {count} tài khoản.',
  bulkProxy: 'Gán Proxy',
  bulkProxyModalTitle: 'Gán Outbound Proxy cho các tài khoản đã chọn',
  bulkProxyModalDesc: 'Chọn cách định tuyến outbound proxy cho {count} tài khoản đã chọn.',
  proxyModeUnbind: 'Hủy gán (Trực tiếp / Mặc định Gateway)',
  proxyModeRotate: 'Xoay vòng 1-1 qua các Pool đang bật',
  proxyModePool: 'Gán cố định vào Pool cụ thể',
  selectPool: 'Chọn Proxy Pool',
  apply: 'Áp dụng',
  applying: 'Đang áp dụng…',
  bulkProxySuccess: 'Đã cập nhật cấu hình proxy cho {count} tài khoản.',

  testOneByOne: 'Kiểm tra tuần tự',
  testingOneByOne: 'Đang kiểm tra {current}/{total}…',
  stopTest: 'Dừng lại',
  testStopped: 'Đã dừng kiểm tra tuần tự.',
  testCompleted: 'Kiểm tra hoàn tất: {passed}/{total} tài khoản khỏe mạnh.',
  statusHealthy: 'Khỏe mạnh',
  statusError: 'Lỗi',
  statusTesting: 'Đang kiểm tra…',
  statusWaiting: 'Chờ kiểm tra',

  providerConfig: 'Cấu hình Nâng cao',
  providerConfigDesc: 'Tùy chỉnh cấp độ tư duy (thinking level) và outbound headers gửi tới upstream.',
  thinkingLevel: 'Cấp độ Tư duy (Thinking Level)',
  thinkingAuto: 'Tự động (Auto)',
  thinkingLow: 'Thấp (Low)',
  thinkingMedium: 'Vừa (Medium)',
  thinkingHigh: 'Cao (High)',
  thinkingMax: 'Tối đa (Max)',
  customHeaders: 'Tùy biến Outbound Headers',
  customHeadersHelp: 'Thêm headers tùy chỉnh vào request gửi đến upstream. Các header hệ thống và xác thực bị cấm.',
  addHeader: 'Thêm Header',
  headerName: 'Tên Header',
  headerValue: 'Giá trị Header',
  headerBlockedWarning: 'Header "{name}" là header hệ thống/bị cấm và không thể ghi đè.',
  saveConfig: 'Lưu Cấu hình',
  configSaved: 'Đã lưu cấu hình nâng cao thành công.',

  enableAllModels: 'Bật tất cả',
  disableAllModels: 'Tắt tất cả',
  fetchLiveModels: 'Lấy Models Trực tiếp',
  fetchingLiveModels: 'Đang tải danh sách model từ upstream…',
  fetchLiveModelsSuccess: 'Đã lấy {count} model trực tiếp từ upstream.',
  fetchLiveModelsError: 'Không thể lấy danh sách model trực tiếp từ upstream.',
  copyModelId: 'Sao chép Model ID',
  modelIdCopied: 'Đã sao chép!',
}

const zhCN: XGatewayCopy = {
  editCustomNode: '编辑兼容提供商节点',
  editCustomNodeDesc: '修改此自定义节点的端点参数、支持的模型列表以及连通性验证。',
  nodeName: '名称',
  nodePrefix: '前缀 (Prefix)',
  nodeType: '提供商类型',
  apiType: 'API 类型',
  apiTypeChat: '聊天补全 (/chat/completions)',
  apiTypeResponses: 'Responses API (/responses)',
  baseUrl: '基础 URL',
  validateEndpoint: '验证端点',
  validating: '正在验证…',
  valid: '有效',
  invalid: '无效',
  models: '模型列表',
  addModelPlaceholder: '添加模型 ID (例如 llama-3.3-70b)',
  add: '添加',
  save: '保存',
  saving: '正在保存…',
  cancel: '取消',
  edit: '编辑',
  delete: '删除',
  deleteConfirm: '您确定要删除此自定义兼容节点吗？',
  editNodeSuccess: '兼容提供商节点已成功更新。',
  requiredFields: '名称、前缀和基础 URL 均为必填项。',

  routingStrategy: '路由策略',
  roundRobin: '轮询负载 (Round Robin)',
  fallback: '优先级备用 (Fallback)',
  roundRobinHelp: '在所有健康的账户之间均衡分发传入请求。',
  fallbackHelp: '优先调用优先级最高的健康账户，遇到故障时切换。',
  stickyLimit: '粘性限制 (Sticky Limit)',
  stickyLimitHelp: '在同一账户上保持连续调用的请求次数 (1–100 次请求)。',
  requestsUnit: '次请求',
  strategySaved: '路由策略已更新。',

  priorityBadge: '优先级',
  moveUp: '上移',
  moveDown: '下移',
  priorityUpdated: '账户优先级已更新。',

  selectAll: '全选',
  deselectAll: '取消全选',
  selectedAccounts: '已选择 {count} 个',
  bulkDelete: '批量删除',
  bulkDeleteConfirm: '确定要删除所选的 {count} 个账户吗？',
  bulkDeleting: '正在删除…',
  bulkDeleteSuccess: '已成功删除 {count} 个账户。',
  bulkProxy: '应用代理',
  bulkProxyModalTitle: '为所选账户配置出站代理',
  bulkProxyModalDesc: '选择如何为所选的 {count} 个账户分配出站代理。',
  proxyModeUnbind: '解除绑定 (直接连接 / 网关默认)',
  proxyModeRotate: '在启用的代理池间 1对1 循环轮询',
  proxyModePool: '绑定到指定代理池',
  selectPool: '选择代理池',
  apply: '应用',
  applying: '正在应用…',
  bulkProxySuccess: '已为 {count} 个账户更新代理设置。',

  testOneByOne: '逐个顺序测试',
  testingOneByOne: '正在顺序测试 {current}/{total}…',
  stopTest: '停止',
  testStopped: '顺序测试已停止。',
  testCompleted: '测试完成：{passed}/{total} 个账户健康。',
  statusHealthy: '健康',
  statusError: '错误',
  statusTesting: '测试中…',
  statusWaiting: '等待中',

  providerConfig: '高级自定义配置',
  providerConfigDesc: '为发送到上游的请求设置默认思考深度级别和自定义出站请求头。',
  thinkingLevel: '思考深度等级 (Thinking Level)',
  thinkingAuto: '自动 (Auto)',
  thinkingLow: '低 (Low)',
  thinkingMedium: '中 (Medium)',
  thinkingHigh: '高 (High)',
  thinkingMax: '最大 (Max)',
  customHeaders: '自定义出站请求头 (Outbound Headers)',
  customHeadersHelp: '向发往上游的 HTTP 请求添加自定义 Header。系统保留头与鉴权头不可自定义。',
  addHeader: '添加 Header',
  headerName: 'Header 名称',
  headerValue: 'Header 键值',
  headerBlockedWarning: '请求头 "{name}" 是保留/受限的系统头，无法进行自定义。',
  saveConfig: '保存配置',
  configSaved: '提供商自定义配置已保存。',

  enableAllModels: '启用全部模型',
  disableAllModels: '停用全部模型',
  fetchLiveModels: '获取实时模型',
  fetchingLiveModels: '正在从上游获取实时模型列表…',
  fetchLiveModelsSuccess: '已成功从上游获取 {count} 个模型。',
  fetchLiveModelsError: '无法从上游获取实时模型列表。',
  copyModelId: '复制模型 ID',
  modelIdCopied: '已复制！',
}

const ru: XGatewayCopy = {
  editCustomNode: 'Редактировать совместимый узел',
  editCustomNodeDesc: 'Обновите параметры конечной точки, список моделей и проверьте подключение.',
  nodeName: 'Название',
  nodePrefix: 'Префикс',
  nodeType: 'Тип провайдера',
  apiType: 'Тип API',
  apiTypeChat: 'Chat Completions (/chat/completions)',
  apiTypeResponses: 'Responses API (/responses)',
  baseUrl: 'Базовый URL',
  validateEndpoint: 'Проверить узел',
  validating: 'Проверка…',
  valid: 'Действителен',
  invalid: 'Недействителен',
  models: 'Список моделей',
  addModelPlaceholder: 'ID модели (например, llama-3.3-70b)',
  add: 'Добавить',
  save: 'Сохранить',
  saving: 'Сохранение…',
  cancel: 'Отмена',
  edit: 'Изменить',
  delete: 'Удалить',
  deleteConfirm: 'Вы уверены, что хотите удалить этот совместимый узел?',
  editNodeSuccess: 'Совместимый узел успешно обновлен.',
  requiredFields: 'Название, префикс и базовый URL обязательны.',

  routingStrategy: 'Стратегия маршрутизации',
  roundRobin: 'Round Robin (Циклическая)',
  fallback: 'Приоритет (Fallback)',
  roundRobinHelp: 'Равномерно распределять запросы между всеми исправными аккаунтами.',
  fallbackHelp: 'Использовать аккаунт с наивысшим приоритетом до сбоя.',
  stickyLimit: 'Лимит удержания (Sticky Limit)',
  stickyLimitHelp: 'Удерживать последовательные запросы на одном аккаунте (1–100 запросов).',
  requestsUnit: 'запросов',
  strategySaved: 'Стратегия маршрутизации обновлена.',

  priorityBadge: 'Приоритет',
  moveUp: 'Выше',
  moveDown: 'Ниже',
  priorityUpdated: 'Приоритет аккаунтов обновлен.',

  selectAll: 'Выбрать все',
  deselectAll: 'Снять выбор',
  selectedAccounts: 'Выбрано {count}',
  bulkDelete: 'Удалить выбранные',
  bulkDeleteConfirm: 'Удалить {count} выбранных аккаунтов?',
  bulkDeleting: 'Удаление…',
  bulkDeleteSuccess: 'Удалено {count} аккаунтов.',
  bulkProxy: 'Назначить прокси',
  bulkProxyModalTitle: 'Назначение прокси для выбранных аккаунтов',
  bulkProxyModalDesc: 'Выберите метод распределения прокси для {count} аккаунтов.',
  proxyModeUnbind: 'Отвязать (Прямое подключение)',
  proxyModeRotate: 'Ротация 1-к-1 по активным пулам',
  proxyModePool: 'Привязать к конкретному пулу',
  selectPool: 'Выберите пул прокси',
  apply: 'Применить',
  applying: 'Применение…',
  bulkProxySuccess: 'Настройки прокси обновлены для {count} аккаунтов.',

  testOneByOne: 'Тестировать по очереди',
  testingOneByOne: 'Проверка {current}/{total}…',
  stopTest: 'Остановить',
  testStopped: 'Последовательное тестирование остановлено.',
  testCompleted: 'Тестирование завершено: {passed}/{total} исправны.',
  statusHealthy: 'Исправен',
  statusError: 'Ошибка',
  statusTesting: 'Проверка…',
  statusWaiting: 'Ожидание',

  providerConfig: 'Настройки провайдера',
  providerConfigDesc: 'Настройка уровня размышлений (Thinking Level) и исходящих HTTP-заголовков.',
  thinkingLevel: 'Уровень размышления (Thinking Level)',
  thinkingAuto: 'Авто (Auto)',
  thinkingLow: 'Низкий (Low)',
  thinkingMedium: 'Средний (Medium)',
  thinkingHigh: 'Высокий (High)',
  thinkingMax: 'Максимум (Max)',
  customHeaders: 'Исходящие заголовки (Headers)',
  customHeadersHelp: 'Дополнительные HTTP-заголовки для запросов. Запрещены системные и авторизационные заголовки.',
  addHeader: 'Добавить заголовок',
  headerName: 'Имя заголовка',
  headerValue: 'Значение заголовка',
  headerBlockedWarning: 'Заголовок "{name}" зарезервирован системой и не может быть изменен.',
  saveConfig: 'Сохранить конфигурацию',
  configSaved: 'Конфигурация провайдера сохранена.',

  enableAllModels: 'Включить все',
  disableAllModels: 'Отключить все',
  fetchLiveModels: 'Загрузить живые модели',
  fetchingLiveModels: 'Загрузка списка моделей от провайдера…',
  fetchLiveModelsSuccess: 'Загружено {count} моделей от провайдера.',
  fetchLiveModelsError: 'Не удалось получить модели от провайдера.',
  copyModelId: 'Копировать ID модели',
  modelIdCopied: 'Скопировано!',
}

const tr: XGatewayCopy = {
  editCustomNode: 'Uyumlu Sağlayıcıyı Düzenle',
  editCustomNodeDesc: 'Bu özel düğüm için uç nokta parametrelerini, model listesini ve bağlantıyı güncelleyin.',
  nodeName: 'İsim',
  nodePrefix: 'Ön ek (Prefix)',
  nodeType: 'Sağlayıcı Türü',
  apiType: 'API Türü',
  apiTypeChat: 'Chat Completions (/chat/completions)',
  apiTypeResponses: 'Responses API (/responses)',
  baseUrl: 'Temel URL',
  validateEndpoint: 'Uç Noktayı Doğrula',
  validating: 'Doğrulanıyor…',
  valid: 'Geçerli',
  invalid: 'Geçersiz',
  models: 'Modeller',
  addModelPlaceholder: 'Model kimliği ekle (örn. llama-3.3-70b)',
  add: 'Ekle',
  save: 'Kaydet',
  saving: 'Kaydediliyor…',
  cancel: 'İptal',
  edit: 'Düzenle',
  delete: 'Sil',
  deleteConfirm: 'Bu uyumlu düğümü silmek istediğinizden emin misiniz?',
  editNodeSuccess: 'Uyumlu sağlayıcı düğümü güncellendi.',
  requiredFields: 'İsim, Ön ek ve Temel URL alanları zorunludur.',

  routingStrategy: 'Yönlendirme Stratejisi',
  roundRobin: 'Sıralı Dağıtım (Round Robin)',
  fallback: 'Öncelikli Yedekleme (Fallback)',
  roundRobinHelp: 'İstekleri sağlıklı hesaplar arasında eşit şekilde paylaştırın.',
  fallbackHelp: 'Her zaman en yüksek öncelikli sağlıklı hesabı kullanın.',
  stickyLimit: 'Bağlılık Limiti (Sticky Limit)',
  stickyLimitHelp: 'Arka arkaya gelen istekleri aynı hesapta tutun (1–100 istek).',
  requestsUnit: 'istek',
  strategySaved: 'Yönlendirme stratejisi güncellendi.',

  priorityBadge: 'Öncelik',
  moveUp: 'Yukarı Taşı',
  moveDown: 'Aşağı Taşı',
  priorityUpdated: 'Hesap önceliği güncellendi.',

  selectAll: 'Tümünü Seç',
  deselectAll: 'Seçimi Kaldır',
  selectedAccounts: '{count} seçildi',
  bulkDelete: 'Seçilenleri Sil',
  bulkDeleteConfirm: 'Seçilen {count} hesabı silmek istediğinizden emin misiniz?',
  bulkDeleting: 'Siliniyor…',
  bulkDeleteSuccess: '{count} hesap silindi.',
  bulkProxy: 'Proxy Uygula',
  bulkProxyModalTitle: 'Seçilen Hesaplara Proxy Ata',
  bulkProxyModalDesc: 'Seçilen {count} hesap için giden proxy yönlendirme yöntemini seçin.',
  proxyModeUnbind: 'Bağlantıyı Kaldır (Doğrudan / Varsayılan)',
  proxyModeRotate: 'Aktif Havuzlar Arasında 1-e-1 Döndür',
  proxyModePool: 'Belirli Bir Havuzla Eşle',
  selectPool: 'Proxy Havuzu Seç',
  apply: 'Uygula',
  applying: 'Uygulanıyor…',
  bulkProxySuccess: '{count} hesap için proxy ayarları güncellendi.',

  testOneByOne: 'Birebir Sıralı Test',
  testingOneByOne: 'Sırayla test ediliyor {current}/{total}…',
  stopTest: 'Durdur',
  testStopped: 'Sıralı test durduruldu.',
  testCompleted: 'Test tamamlandı: {passed}/{total} sağlıklı.',
  statusHealthy: 'Sağlıklı',
  statusError: 'Hata',
  statusTesting: 'Test ediliyor…',
  statusWaiting: 'Bekliyor',

  providerConfig: 'Özel Yapılandırma',
  providerConfigDesc: 'Üst sağlayıcı istekleri için düşünme seviyesini ve giden HTTP başlıklarını ayarlayın.',
  thinkingLevel: 'Düşünme Seviyesi (Thinking Level)',
  thinkingAuto: 'Otomatik (Auto)',
  thinkingLow: 'Düşük (Low)',
  thinkingMedium: 'Orta (Medium)',
  thinkingHigh: 'Yüksek (High)',
  thinkingMax: 'Maksimum (Max)',
  customHeaders: 'Özel Giden Başlıklar (Outbound Headers)',
  customHeadersHelp: 'Giden HTTP çağrılarına özel başlık ekleyin. Sistem ve yetkilendirme başlıkları engellenmiştir.',
  addHeader: 'Başlık Ekle',
  headerName: 'Başlık Adı',
  headerValue: 'Başlık Değeri',
  headerBlockedWarning: '"{name}" başlığı ayrılmıştır ve özelleştirilemez.',
  saveConfig: 'Yapılandırmayı Kaydet',
  configSaved: 'Sağlayıcı yapılandırması kaydedildi.',

  enableAllModels: 'Tümünü Etkinleştir',
  disableAllModels: 'Tümünü Devre Dışı Bırak',
  fetchLiveModels: 'Canlı Modelleri Çek',
  fetchingLiveModels: 'Üst sağlayıcıdan modeller çekiliyor…',
  fetchLiveModelsSuccess: 'Üst sağlayıcıdan {count} canlı model çekildi.',
  fetchLiveModelsError: 'Üst sağlayıcıdan canlı modeller çekilemedi.',
  copyModelId: 'Model Kimliğini Kopyala',
  modelIdCopied: 'Kopyalandı!',
}

const uz: XGatewayCopy = {
  editCustomNode: 'Mos provayder tugunini tahrirlash',
  editCustomNodeDesc: 'Ushbu maxsus tugun uchun endpoint parametrlarini, modellar roʻyxatini va ulanishni yangilang.',
  nodeName: 'Nomi',
  nodePrefix: 'Prefiks',
  nodeType: 'Provayder turi',
  apiType: 'API turi',
  apiTypeChat: 'Chat Completions (/chat/completions)',
  apiTypeResponses: 'Responses API (/responses)',
  baseUrl: 'Asosiy URL',
  validateEndpoint: 'Ulanishni tekshirish',
  validating: 'Tekshirilmoqda…',
  valid: 'Yaroqli',
  invalid: 'Yaroqsiz',
  models: 'Modellar',
  addModelPlaceholder: 'Model ID qoʻshish (masalan: llama-3.3-70b)',
  add: 'Qoʻshish',
  save: 'Saqlash',
  saving: 'Saqlanmoqda…',
  cancel: 'Bekor qilish',
  edit: 'Tahrirlash',
  delete: 'Oʻchirish',
  deleteConfirm: 'Haqiqatan ham ushbu maxsus tugunni oʻchirmoqchimisiz?',
  editNodeSuccess: 'Mos provayder tuguni muvaffaqiyatli yangilandi.',
  requiredFields: 'Nomi, prefiks va asosiy URL majburiy.',

  routingStrategy: 'Marshrutlash strategiyasi',
  roundRobin: 'Ketma-ket aylanish (Round Robin)',
  fallback: 'Ustuvorlik boʻyicha (Fallback)',
  roundRobinHelp: 'Soʻrovlarni sogʻlom hisoblar oʻrtasida teng taqsimlash.',
  fallbackHelp: 'Dastlab eng yuqori ustuvorlikka ega hisobdan foydalanish.',
  stickyLimit: 'Biriktirish chegarasi (Sticky Limit)',
  stickyLimitHelp: 'Ketma-ket soʻrovlarni bitta hisobda saqlab turish (1–100 soʻrov).',
  requestsUnit: 'soʻrov',
  strategySaved: 'Marshrutlash strategiyasi yangilandi.',

  priorityBadge: 'Ustuvorlik',
  moveUp: 'Yuqoriga',
  moveDown: 'Pastga',
  priorityUpdated: 'Hisob ustuvorligi yangilandi.',

  selectAll: 'Barchasini tanlash',
  deselectAll: 'Tanlovni bekor qilish',
  selectedAccounts: '{count} ta tanlandi',
  bulkDelete: 'Tanlanganlarni oʻchirish',
  bulkDeleteConfirm: 'Haqiqatan ham tanlangan {count} ta hisobni oʻchirmoqchimisiz?',
  bulkDeleting: 'Oʻchirilmoqda…',
  bulkDeleteSuccess: '{count} ta hisob oʻchirildi.',
  bulkProxy: 'Proksi belgilash',
  bulkProxyModalTitle: 'Tanlangan hisoblarga proksi belgilash',
  bulkProxyModalDesc: 'Tanlangan {count} ta hisob uchun chiquvchi proksi usulini tanlang.',
  proxyModeUnbind: 'Ajratish (Toʻgʻridan-toʻgʻri / Asosiy)',
  proxyModeRotate: 'Faol pullar boʻylab 1-ga-1 aylanish',
  proxyModePool: 'Muayyan pulga biriktirish',
  selectPool: 'Proksi pulni tanlang',
  apply: 'Qoʻllash',
  applying: 'Qoʻllanilmoqda…',
  bulkProxySuccess: '{count} ta hisob uchun proksi sozlamalari yangilandi.',

  testOneByOne: 'Bittalab tekshirish',
  testingOneByOne: 'Ketma-ket tekshirilmoqda {current}/{total}…',
  stopTest: 'Toʻxtatish',
  testStopped: 'Ketma-ket tekshirish toʻxtatildi.',
  testCompleted: 'Tekshirish yakunlandi: {passed}/{total} sogʻlom.',
  statusHealthy: 'Sogʻlom',
  statusError: 'Xato',
  statusTesting: 'Tekshirilmoqda…',
  statusWaiting: 'Kutilmoqda',

  providerConfig: 'Maxsus sozlamalar',
  providerConfigDesc: 'Fikrlash darajasi (Thinking Level) va chiquvchi sarlavhalarni (Headers) sozlang.',
  thinkingLevel: 'Fikrlash darajasi (Thinking Level)',
  thinkingAuto: 'Avtomatik (Auto)',
  thinkingLow: 'Past (Low)',
  thinkingMedium: 'Oʻrta (Medium)',
  thinkingHigh: 'Yuqori (High)',
  thinkingMax: 'Maksimal (Max)',
  customHeaders: 'Chiquvchi sarlavhalar (Outbound Headers)',
  customHeadersHelp: 'Soʻrovlarga maxsus sarlavhalar qoʻshing. Tizimli va autentifikatsiya sarlavhalari taqiqlangan.',
  addHeader: 'Sarlavha qoʻshish',
  headerName: 'Sarlavha nomi',
  headerValue: 'Sarlavha qiymati',
  headerBlockedWarning: '"{name}" sarlavhasi tizim tomonidan band qilingan va uni oʻzgartirib boʻlmaydi.',
  saveConfig: 'Sozlamalarni saqlash',
  configSaved: 'Provayder sozlamalari saqlandi.',

  enableAllModels: 'Barchasini yoqish',
  disableAllModels: 'Barchasini oʻchirish',
  fetchLiveModels: 'Jonli modellarni olish',
  fetchingLiveModels: 'Provayderdan modellar olinmoqda…',
  fetchLiveModelsSuccess: 'Provayderdan {count} ta jonli model olindi.',
  fetchLiveModelsError: 'Provayderdan jonli modellarni olib boʻlmadi.',
  copyModelId: 'Model ID nusxalash',
  modelIdCopied: 'Nusxalandi!',
}

const copyMap: Record<string, XGatewayCopy> = {
  en,
  vi,
  'zh-CN': zhCN,
  zh: zhCN,
  ru,
  tr,
  uz,
}

export function useXGatewayCopy(): XGatewayCopy {
  const { locale } = useI18n()
  return copyMap[locale] || copyMap[locale.split('-')[0] || ''] || en
}
