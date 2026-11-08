import { Button } from '@/components/ui/button'
import { useModelListStrings } from './strings'

export function ModelListPagination({ loaded, total, hasMore, busy, error, expired, onMore, onRetry, onReload }: {
  loaded: number; total: number; hasMore: boolean; busy: boolean; error: boolean; expired: boolean
  onMore: () => void; onRetry: () => void; onReload: () => void
}) {
  const s = useModelListStrings()
  return <div className="flex flex-col items-center gap-3 py-3">
    <p className="text-xs text-muted-foreground" aria-live="polite">{s.count(loaded, total)}</p>
    {busy && !hasMore && !error && <p role="status" className="text-xs text-muted-foreground">{s.loading}</p>}
    {error ? <div className="flex flex-col items-center gap-2" role="alert">
      <p className="text-sm text-destructive">{expired ? s.expired : s.failed}</p>
      <Button size="sm" variant="outline" disabled={busy} onClick={expired ? onReload : onRetry}>
        {expired ? s.reload : s.retry}
      </Button>
    </div> : hasMore && <Button variant="outline" disabled={busy} onClick={onMore} aria-busy={busy}>
      {busy ? s.loading : s.more}
    </Button>}
  </div>
}
