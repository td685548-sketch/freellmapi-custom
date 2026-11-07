import { useI18n } from '@/i18n'

const en = {
  combos: 'Combos', playground: 'Playground', logs: 'Console Log',
  combosHelp: 'Group provider/model pairs into a named fallback chain. Call it with model "combo:<name>".',
  newCombo: 'New combo', editCombo: 'Edit combo', comboName: 'Combo name', addStep: 'Add step',
  provider: 'Provider', modelId: 'Model ID', remove: 'Remove', edit: 'Edit', save: 'Save', saving: 'Saving…',
  cancel: 'Cancel', deleteConfirm: 'Delete this combo?', noCombos: 'No combos yet', steps: 'Steps',
  callAs: 'Use as model', loading: 'Loading…', retry: 'Try again', loadError: 'Could not load data.',
  readOnly: 'You have read-only access.',
  playgroundHelp: 'Send a test chat through the gateway routing, using your connected accounts.',
  model: 'Model', modelHint: 'auto, provider/model or combo:name', prompt: 'Message', send: 'Send', sending: 'Sending…',
  reply: 'Reply', routedVia: 'Routed via', latency: 'Latency', tokens: 'Tokens', clear: 'Clear',
  logsHelp: 'Recent requests that went through X Gateway, plus an hourly breakdown.',
  last24h: 'Last 24 hours', hourly: 'Hourly usage', requests: 'Requests', errors: 'Errors',
  time: 'Time', status: 'Status', all: 'All', success: 'Success', failed: 'Failed', noLogs: 'No requests yet', refresh: 'Refresh',
} as const

const vi: Record<keyof typeof en, string> = {
  combos: 'Combos', playground: 'Playground', logs: 'Nhật ký',
  combosHelp: 'Gom các cặp nhà cung cấp/model thành chuỗi dự phòng có tên. Gọi bằng model "combo:<tên>".',
  newCombo: 'Combo mới', editCombo: 'Sửa combo', comboName: 'Tên combo', addStep: 'Thêm bước',
  provider: 'Nhà cung cấp', modelId: 'Model ID', remove: 'Xóa', edit: 'Sửa', save: 'Lưu', saving: 'Đang lưu…',
  cancel: 'Hủy', deleteConfirm: 'Xóa combo này?', noCombos: 'Chưa có combo', steps: 'Các bước',
  callAs: 'Dùng làm model', loading: 'Đang tải…', retry: 'Thử lại', loadError: 'Không tải được dữ liệu.',
  readOnly: 'Bạn chỉ có quyền xem.',
  playgroundHelp: 'Gửi một cuộc chat thử qua định tuyến của gateway, dùng các tài khoản đã kết nối.',
  model: 'Model', modelHint: 'auto, nhà-cung-cấp/model hoặc combo:tên', prompt: 'Tin nhắn', send: 'Gửi', sending: 'Đang gửi…',
  reply: 'Phản hồi', routedVia: 'Định tuyến qua', latency: 'Độ trễ', tokens: 'Token', clear: 'Xóa',
  logsHelp: 'Các request gần đây đi qua X Gateway và thống kê theo giờ.',
  last24h: '24 giờ qua', hourly: 'Sử dụng theo giờ', requests: 'Request', errors: 'Lỗi',
  time: 'Thời gian', status: 'Trạng thái', all: 'Tất cả', success: 'Thành công', failed: 'Thất bại', noLogs: 'Chưa có request', refresh: 'Làm mới',
}

export function useMgmtStrings() {
  const { locale } = useI18n()
  return locale === 'vi' ? vi : en
}

