import { LoaderCircle } from 'lucide-react'
import './route-fallback.css'
import { useI18n } from '@/i18n'

/**
 * Shown while a route's code is downloading. It appears only after a short delay, so a page
 * that arrives from cache or a fast connection never flashes a spinner first.
 */
export function RouteFallback({ fullScreen = false }: { fullScreen?: boolean }) {
  const { t } = useI18n()
  return (
    <div
      role="status"
      aria-live="polite"
      className={`route-fallback flex items-center justify-center text-muted-foreground ${fullScreen ? 'min-h-dvh bg-background' : 'py-24'}`}
    >
      <LoaderCircle className="size-5 animate-spin" aria-hidden="true" />
      <span className="sr-only">{t('common.loading')}</span>
    </div>
  )
}
