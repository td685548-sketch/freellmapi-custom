import { useQuery } from '@tanstack/react-query'
import { X } from 'lucide-react'
import type {
  ContextDropReason,
  ContextPreview,
  ContextSegmentKind,
} from '@freellmapi/shared/context-budget.js'
import { apiFetch } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogPopup,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useCustomT } from './i18n/use-custom-t'

const KIND_LABELS: Record<ContextSegmentKind, string> = {
  mandatory: 'Mandatory',
  summary: 'Summary',
  knowledge: 'Knowledge',
  history: 'History',
  client_history: 'Client history',
}

const REASON_LABELS: Record<ContextDropReason, string> = {
  budget: 'Budget',
  block_alignment: 'Block alignment',
  leading_assistant: 'Leading assistant',
  max_messages: 'Max messages',
}

interface ContextPreviewDialogProps {
  profileId: number
  conversationId: string | null
  endUser?: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Dry-run context assembly preview for the next turn of a stored conversation, showing the
 * target model budget, summary coverage, and every segment kept or dropped without calling a provider.
 */
export function ContextPreviewDialog({
  profileId,
  conversationId,
  endUser,
  open,
  onOpenChange,
}: ContextPreviewDialogProps) {
  const tc = useCustomT()
  const qs = endUser ? `?endUser=${encodeURIComponent(endUser)}` : ''
  const url = conversationId
    ? `/api/client-profiles/${profileId}/conversations/${encodeURIComponent(conversationId)}/context-preview${qs}`
    : ''

  const { data, isLoading, isError, error } = useQuery<ContextPreview>({
    queryKey: ['context-preview', profileId, conversationId, endUser ?? null],
    queryFn: () => apiFetch<ContextPreview>(url),
    enabled: open && Boolean(conversationId),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup maxWidth="max-w-3xl" className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <DialogTitle>{tc('Context preview')}</DialogTitle>
            <DialogDescription>
              {conversationId ? (
                <>
                  {tc('Conversation')}: <span className="font-mono">{conversationId}</span>
                  {endUser ? ` · ${endUser}` : ''}
                </>
              ) : (
                tc('Simulated next-turn context assembly')
              )}
            </DialogDescription>
          </div>
          <DialogClose render={<Button type="button" variant="ghost" size="icon-xs" aria-label={tc('Close')} />}>
            <X className="size-4" />
          </DialogClose>
        </div>

        {isLoading && (
          <p className="text-xs text-muted-foreground" role="status">
            {tc('Loading context preview…')}
          </p>
        )}

        {isError && (
          <p className="text-xs text-destructive" role="alert">
            {(error as Error)?.message || tc('Could not load context preview.')}
          </p>
        )}

        {data && (
          <div className="space-y-4">
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 text-xs">
              <div className="rounded-xl border bg-muted/20 p-2.5">
                <p className="text-[11px] text-muted-foreground">{tc('Model')}</p>
                <p className="font-mono font-medium truncate" title={data.model.key}>
                  {data.model.key}
                </p>
                <p className="text-[11px] text-muted-foreground tabular-nums">
                  {data.model.contextWindow !== null
                    ? tc('Window: {tokens} tokens', {
                        tokens: data.model.contextWindow.toLocaleString(),
                      })
                    : tc('Window: unknown')}
                </p>
              </div>

              <div className="rounded-xl border bg-muted/20 p-2.5">
                <p className="text-[11px] text-muted-foreground">{tc('Effective budget')}</p>
                <p className="text-sm font-semibold tabular-nums">
                  {data.budget.effective.toLocaleString()} {tc('tokens')}
                </p>
                <p className="text-[11px] text-muted-foreground tabular-nums">
                  {tc('Mandatory: {tokens}', {
                    tokens: data.budget.mandatory.toLocaleString(),
                  })}
                </p>
              </div>

              <div className="rounded-xl border bg-muted/20 p-2.5">
                <p className="text-[11px] text-muted-foreground">{tc('Section caps')}</p>
                <p className="text-[11px] tabular-nums">
                  {tc('Summary {summary} · Knowledge {knowledge} · History {history}', {
                    summary: data.budget.summaryCap.toLocaleString(),
                    knowledge: data.budget.knowledgeCap.toLocaleString(),
                    history: data.budget.historyCap.toLocaleString(),
                  })}
                </p>
                <p className="mt-0.5 text-[11px] text-muted-foreground tabular-nums" aria-label="Summary coverage">
                  {data.summary.coversThroughMessageId !== null
                    ? tc('Summarized through message #{id}', {
                        id: data.summary.coversThroughMessageId,
                      })
                    : tc('No summary yet')}
                  {' · '}
                  {tc('{count} messages pending fold', {
                    count: data.summary.pendingFoldMessages,
                  })}
                </p>
              </div>
            </div>

            {data.knowledgeNote && (
              <p className="text-xs text-muted-foreground">{data.knowledgeNote}</p>
            )}

            <div className="rounded-xl border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">{tc('Kind')}</TableHead>
                    <TableHead className="text-xs">{tc('Role')}</TableHead>
                    <TableHead className="text-xs text-right">{tc('Tokens')}</TableHead>
                    <TableHead className="text-xs">{tc('Status')}</TableHead>
                    <TableHead className="text-xs">{tc('Reason')}</TableHead>
                    <TableHead className="text-xs">{tc('Preview')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.segments.map((seg, idx) => (
                    <TableRow key={`${seg.kind}-${seg.messageId ?? idx}`}>
                      <TableCell className="text-xs font-medium">
                        {tc(KIND_LABELS[seg.kind] ?? seg.kind)}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{seg.role}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums">
                        {seg.tokens.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-xs">
                        <Badge variant={seg.sent ? 'secondary' : 'outline'}>
                          {seg.sent ? tc('Sent') : tc('Dropped')}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {seg.reason ? tc(REASON_LABELS[seg.reason] ?? seg.reason) : '—'}
                      </TableCell>
                      <TableCell className="text-xs max-w-xs whitespace-normal break-words text-muted-foreground">
                        {seg.preview || '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </DialogPopup>
    </Dialog>
  )
}
