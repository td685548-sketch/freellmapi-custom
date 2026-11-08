import { useI18n } from '@/i18n'

export function useModelListStrings() {
  const { locale } = useI18n()
  return locale === 'vi' ? {
    more: 'Xem thêm 20 model', loading: 'Đang tải…', retry: 'Thử lại', reload: 'Tải lại danh sách',
    failed: 'Không tải được danh sách model.', expired: 'Danh sách đã thay đổi. Tải lại để tiếp tục.',
    count: (loaded: number, total: number) => `Đang hiển thị ${loaded} / ${total} model`,
    manual: 'Tải đủ danh sách để kéo hoặc đổi thứ tự model. Bạn vẫn có thể bật/tắt và lưu các model đang xem.',
    budgetDetails: 'Xem chi tiết ngân sách', hideBudget: 'Ẩn chi tiết ngân sách', allModels: 'Tất cả model',
  } : {
    more: 'Load 20 more models', loading: 'Loading…', retry: 'Retry', reload: 'Reload list',
    failed: 'Could not load models.', expired: 'The list changed. Reload it to continue.',
    count: (loaded: number, total: number) => `Showing ${loaded} / ${total} models`,
    manual: 'Load the complete list to drag or change model ranks. You can still toggle and save the models shown.',
    budgetDetails: 'View budget details', hideBudget: 'Hide budget details', allModels: 'All models',
  }
}
