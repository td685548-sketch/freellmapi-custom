import { useMemo, useState } from 'react'
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
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useUserSession } from './use-session'
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

function buildPreviewUrl(
  profileId: number,
  conversationId: string | null,
  endUser: string | null | undefined,
  modelKey: string,
): string {
  if (!conversationId) return ''
  const params = new URLSearchParams()
  if (endUser) params.set('endUser', endUser)
  if (modelKey) params.set('model', modelKey)
  const qs = params.toString()
  return `/api/client-profiles/${profileId}/conversations/${encodeURIComponent(conversationId)}/context-preview${qs ? `?${qs}` : ''}`
}

function extractModelOptions(catalog: unknown): Array<{ key: string; contextWindow: number | null }> {
  if (!Array.isArray(catalog)) return []
  const seen = new Set<string>()
  const options: Array<{ key: string; contextWindow: number | null }> = []
  for (const item of catalog) {
    if (!item || typeof item !== 'object') continue
    const rec = item as { platform?: unknown; modelId?: unknown; enabled?: unknown; contextWindow?: unknown }
    if (rec.enabled === false) continue
    if (typeof rec.platform !== 'string' || typeof rec.modelId !== 'string') continue
    const key = `${rec.platform}:${rec.modelId}`
    if (seen.has(key)) continue
    seen.add(key)
    options.push({
      key,
      contextWindow: typeof rec.contextWindow === 'number' ? rec.contextWindow : null,
    })
  }
  return options.sort((a, b) => a.key.localeCompare(b.key))
}

function ContextPreviewBody({
  profileId,
  conversationId,
  endUser,
}: {
  profileId: number
  conversationId: string | null
  endUser?: string | null
}) {
  const tc = useCustomT()
  const { hasPermission } = useUserSession()
  const [modelInput, setModelInput] = useState('')
  const [selectedModel, setSelectedModel] = useState('')

  const catalogQuery = useQuery<unknown>({
    queryKey: ['model-catalog-ids'],
    queryFn: () => apiFetch('/api/models'),
    enabled: Boolean(conversationId) && hasPermission('manage_routing'),
    retry: false,
  })

  const modelOptions = useMemo(() => extractModelOptions(catalogQuery.data), [catalogQuery.data])
  const trimmedModel = selectedModel.trim()
  const url = buildPreviewUrl(profileId, conversationId, endUser, trimmedModel)

  const { data, isLoading, isError, error } = useQuery<ContextPreview>({
    queryKey: trimmedModel
      ? ['context-preview', profileId, conversationId, endUser ?? null, trimmedModel]
      : ['context-preview', profileId, conversationId, endUser ?? null],
    queryFn: () => apiFetch<ContextPreview>(url),
    enabled: Boolean(conversationId),
  })

  const breakdown = useMemo(() => {
    if (!data) return null
    let mandatory = 0
    let summary = 0
    let knowledge = 0
    let history = 0
    let droppedCount = 0
    for (const seg of data.segments) {
      if (!seg.sent) {
        droppedCount += 1
        continue
      }
      if (seg.kind === 'mandatory') mandatory += seg.tokens
      else if (seg.kind === 'summary') summary += seg.tokens
      else if (seg.kind === 'knowledge') knowledge += seg.tokens
      else history += seg.tokens
    }
    const used = mandatory + summary + knowledge + history
    const effective = Math.max(0, data.budget.effective)
    const pct = effective > 0 ? Math.min(100, Math.round((used / effective) * 100)) : 0
    const widthPct = (tokens: number) =>
      effective > 0 ? `${Math.min(100, (tokens / effective) * 100).toFixed(2)}%` : '0%'
    return { mandatory, summary, knowledge, history, used, effective, pct, droppedCount, widthPct }
  }, [data])

  const trimmedInput = modelInput.trim()

  return (
    <>
      <form
        className="flex flex-wrap items-end gap-2 rounded-xl border bg-muted/20 p-2.5 text-xs"
        onSubmit={(e) => {
          e.preventDefault()
          if (trimmedInput) setSelectedModel(trimmedInput)
        }}
      >
        <div className="min-w-52 flex-1 space-y-1">
          <label htmlFor="ctx-preview-model" className="block text-[11px] text-muted-foreground">
            {tc('Target model simulation')}
          </label>
          <Input
            id="ctx-preview-model"
            aria-label="Simulate target model"
            list="ctx-preview-models"
            value={modelInput}
            onChange={(e) => setModelInput(e.target.value)}
            placeholder={tc('Auto (top model), or platform:model_id')}
            className="h-8 font-mono text-xs"
          />
          <datalist id="ctx-preview-models">
            {modelOptions.map((m) => (
              <option key={m.key} value={m.key}>
                {m.contextWindow !== null ? `${m.key} (${m.contextWindow.toLocaleString()})` : m.key}
              </option>
            ))}
          </datalist>
        </div>
        <Button
          type="submit"
          size="sm"
          variant="outline"
          className="h-8 text-xs"
          disabled={!trimmedInput || trimmedInput === trimmedModel}
        >
          {tc('Simulate')}
        </Button>
        {trimmedModel && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-8 text-xs"
            onClick={() => {
              setModelInput('')
              setSelectedModel('')
            }}
          >
            {tc('Auto')}
          </Button>
        )}
      </form>

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

      {data && breakdown && (
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

          <div className="space-y-1.5 rounded-xl border bg-muted/20 p-2.5 text-xs" aria-label="Token budget allocation">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium text-muted-foreground">{tc('Token budget usage')}</span>
              <span className="tabular-nums text-muted-foreground">
                {tc('Used {used} / {budget} tokens ({pct}%)', {
                  used: breakdown.used.toLocaleString(),
                  budget: breakdown.effective.toLocaleString(),
                  pct: breakdown.pct,
                })}
                {breakdown.droppedCount > 0 && ` · ${tc('{count} dropped', { count: breakdown.droppedCount })}`}
              </span>
            </div>
            <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
              {breakdown.mandatory > 0 && (
                <div
                  className="bg-slate-600 dark:bg-slate-400"
                  style={{ width: breakdown.widthPct(breakdown.mandatory) }}
                  title={`${tc('Mandatory')}: ${breakdown.mandatory.toLocaleString()}`}
                />
              )}
              {breakdown.summary > 0 && (
                <div
                  className="bg-violet-500"
                  style={{ width: breakdown.widthPct(breakdown.summary) }}
                  title={`${tc('Summary')}: ${breakdown.summary.toLocaleString()}`}
                />
              )}
              {breakdown.knowledge > 0 && (
                <div
                  className="bg-amber-500"
                  style={{ width: breakdown.widthPct(breakdown.knowledge) }}
                  title={`${tc('Knowledge')}: ${breakdown.knowledge.toLocaleString()}`}
                />
              )}
              {breakdown.history > 0 && (
                <div
                  className="bg-emerald-500"
                  style={{ width: breakdown.widthPct(breakdown.history) }}
                  title={`${tc('History')}: ${breakdown.history.toLocaleString()}`}
                />
              )}
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground tabular-nums">
              <span className="inline-flex items-center gap-1">
                <span className="size-2 rounded-full bg-slate-600 dark:bg-slate-400" />
                {tc('Mandatory')}: {breakdown.mandatory.toLocaleString()}
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="size-2 rounded-full bg-violet-500" />
                {tc('Summary')}: {breakdown.summary.toLocaleString()}
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="size-2 rounded-full bg-amber-500" />
                {tc('Knowledge')}: {breakdown.knowledge.toLocaleString()}
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="size-2 rounded-full bg-emerald-500" />
                {tc('History')}: {breakdown.history.toLocaleString()}
              </span>
            </div>
          </div>

          {data.knowledgeNote && (
            <p className="text-xs text-muted-foreground">{data.knowledgeNote}</p>
          )}

          <div className="max-h-[50vh] overflow-auto rounded-xl border">
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
    </>
  )
}

/**
 * Dry-run context assembly preview for the next turn of a stored conversation, showing the
 * target model budget, visual allocation bar, summary coverage, and every segment kept or dropped.
 */
export function ContextPreviewDialog({
  profileId,
  conversationId,
  endUser,
  open,
  onOpenChange,
}: ContextPreviewDialogProps) {
  const tc = useCustomT()

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

        {open && (
          <ContextPreviewBody
            key={`${conversationId ?? 'none'}:${endUser ?? ''}`}
            profileId={profileId}
            conversationId={conversationId}
            endUser={endUser}
          />
        )}
      </DialogPopup>
    </Dialog>
  )
}
