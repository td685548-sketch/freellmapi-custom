import { useI18n } from '@/i18n'

const en = {
  proxies: 'Proxy Pool',
  proxiesHelp: 'Several outbound proxies, one sticky proxy per account. New accounts are spread across enabled entries automatically; each account keeps its IP stable.',
  newEntry: 'Add proxy', editEntry: 'Edit proxy', entryName: 'Name', entryUrl: 'Proxy URL',
  entryUrlPlaceholder: 'http://user:pass@host:8080 or socks5://user:pass@host:1080',
  entryUrlKeep: 'Leave blank to keep the current URL',
  noEntries: 'No proxies in the pool yet', boundAccounts: 'accounts bound',
  enabled: 'Enabled', disabled: 'Disabled', test: 'Test', testing: 'Testing…',
  testOk: 'Reachable', testFailed: 'Unreachable', latency: 'Latency',
  deleteConfirm: 'Delete this proxy? Bound accounts fall back to the gateway proxy.',
  save: 'Save', saving: 'Saving…', cancel: 'Cancel', edit: 'Edit', remove: 'Remove',
  loading: 'Loading…', loadError: 'Could not load data.', retry: 'Try again',
  readOnly: 'You have read-only access.',
  accountPool: 'Proxy pool', accountPoolAuto: 'Auto (spread across pool)',
  accountPoolNone: 'No pool (gateway default)', accountPoolHint: 'Ignored when an explicit proxy URL is set.',
  poolBadge: 'Pool',
} as const

const vi: Record<keyof typeof en, string> = {
  proxies: 'Proxy Pool',
  proxiesHelp: 'Nhiều proxy outbound, mỗi account gắn cố định một proxy. Account mới tự chia đều vào các entry đang bật; mỗi account giữ IP ổn định.',
  newEntry: 'Thêm proxy', editEntry: 'Sửa proxy', entryName: 'Tên', entryUrl: 'URL proxy',
  entryUrlPlaceholder: 'http://user:pass@host:8080 hoặc socks5://user:pass@host:1080',
  entryUrlKeep: 'Để trống để giữ URL hiện tại',
  noEntries: 'Chưa có proxy nào trong pool', boundAccounts: 'account đang gắn',
  enabled: 'Đang bật', disabled: 'Đã tắt', test: 'Kiểm tra', testing: 'Đang kiểm tra…',
  testOk: 'Kết nối được', testFailed: 'Không kết nối được', latency: 'Độ trễ',
  deleteConfirm: 'Xóa proxy này? Account đang gắn sẽ dùng proxy chung của gateway.',
  save: 'Lưu', saving: 'Đang lưu…', cancel: 'Hủy', edit: 'Sửa', remove: 'Xóa',
  loading: 'Đang tải…', loadError: 'Không tải được dữ liệu.', retry: 'Thử lại',
  readOnly: 'Bạn chỉ có quyền xem.',
  accountPool: 'Proxy pool', accountPoolAuto: 'Tự động (chia đều vào pool)',
  accountPoolNone: 'Không dùng pool (proxy chung)', accountPoolHint: 'Bị bỏ qua nếu đã đặt URL proxy riêng.',
  poolBadge: 'Pool',
}

export function usePoolStrings() {
  const { locale } = useI18n()
  return locale === 'vi' ? vi : en
}