import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ShieldAlert } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { SegmentedControl } from '@/components/ui/segmented-control'
import type { ContentFilterEvent, ContentFilterMode, ContentFilterSettings } from '../../../shared/content-filter'
import { CONTENT_FILTER_LIMITS as L } from '../../../shared/content-filter'

const MODES: Array<{ value: ContentFilterMode; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'log', label: 'Record only' },
  { value: 'block', label: 'Block' },
]
const REASONS: Record<string, string> = { too_long: 'Too long', keyword: 'Keyword', prompt_injection: 'Prompt injection', repeated: 'Repeated' }

interface Draft { mode: ContentFilterMode; maxInputChars: string; blockInjection: boolean; repeatLimit: string; keywords: string }
const toDraft = (s: ContentFilterSettings): Draft => ({
  mode: s.mode, maxInputChars: s.maxInputChars === null ? '' : String(s.maxInputChars), blockInjection: s.blockInjection,
  repeatLimit: s.repeatLimit === null ? '' : String(s.repeatLimit), keywords: s.keywords.join('\n'),
})
/** Empty = no limit; otherwise a whole number within the range, or undefined when invalid. */
function limit(text: string, min: number, max: number): number | null | undefined {
  if (!text.trim()) return null
  const n = Number(text)
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined
}

/**
 * A client key's content rules: what the latest user message is checked for before it reaches a
 * provider, whether a flag blocks or is only recorded, and the recent flags (edit permission).
 */
export function ContentFilterCard({ profileId, canEdit }: { profileId: number; canEdit: boolean }) {
  const queryClient = useQueryClient()
  const base = `/api/client-profiles/${profileId}/content-filter`
  const { data } = useQuery<{ settings: ContentFilterSettings }>({ queryKey: ['content-filter', profileId], queryFn: () => apiFetch(base) })
  const events = useQuery<{ events: ContentFilterEvent[] }>({ queryKey: ['content-filter-events', profileId], queryFn: () => apiFetch(`${base}/events`), enabled: canEdit })
  const [draft, setDraft] = useState<Draft | null>(null)
  useEffect(() => { if (data?.settings) setDraft(toDraft(data.settings)) }, [data?.settings])

  const save = useMutation({
    mutationFn: (body: ContentFilterSettings) => apiFetch(base, { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => { toast.success('Content rules saved'); void queryClient.invalidateQueries({ queryKey: ['content-filter', profileId] }) },
    onError: (err: Error) => toast.error(err.message || 'Could not save'),
  })

  if (!data?.settings || !draft) return null
  const maxInputChars = limit(draft.maxInputChars, L.minInputChars, L.maxInputChars)
  const repeatLimit = limit(draft.repeatLimit, L.minRepeatLimit, L.maxRepeatLimit)
  const keywords = draft.keywords.split('\n').map(k => k.trim()).filter(Boolean)
  const keywordsValid = keywords.length <= L.maxKeywords && keywords.every(k => k.length <= L.maxKeywordLength)
  const valid = maxInputChars !== undefined && repeatLimit !== undefined && keywordsValid
  const next: ContentFilterSettings | null = valid ? { mode: draft.mode, maxInputChars, blockInjection: draft.blockInjection, repeatLimit, keywords } : null
  const dirty = JSON.stringify(toDraft(data.settings)) !== JSON.stringify(draft)
  const set = (patch: Partial<Draft>) => setDraft(d => (d ? { ...d, ...patch } : d))

  return (
    <section className="rounded-2xl border bg-card p-4 space-y-4" aria-label="Content rules">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5"><ShieldAlert className="size-4" /><h3 className="text-sm font-semibold">Content rules</h3></div>
        {canEdit
          ? <SegmentedControl ariaLabel="What a flag does" value={draft.mode} onValueChange={(mode) => set({ mode })} options={MODES} />
          : <span className="text-xs text-muted-foreground">{MODES.find(m => m.value === data.settings.mode)?.label}</span>}
      </div>
      <p className="text-xs text-muted-foreground">
        Checks the visitor&apos;s latest message before it uses a provider or this key&apos;s limits. <strong>Record only</strong> lets it through and
        notes it below; <strong>Block</strong> answers with an error (<code>content_blocked</code>) instead.
      </p>

      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (canEdit && next && dirty) save.mutate(next) }}>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <label htmlFor="cf-max" className="block text-[11px] text-muted-foreground">Longest message (characters)</label>
            <Input id="cf-max" inputMode="numeric" placeholder="No limit" value={draft.maxInputChars} disabled={!canEdit} onChange={(e) => set({ maxInputChars: e.target.value })} className="h-8 w-36 text-xs" />
          </div>
          <div className="space-y-1">
            <label htmlFor="cf-repeat" className="block text-[11px] text-muted-foreground">Same message, times in {L.repeatWindowMinutes} min</label>
            <Input id="cf-repeat" inputMode="numeric" placeholder="Off" value={draft.repeatLimit} disabled={!canEdit} onChange={(e) => set({ repeatLimit: e.target.value })} className="h-8 w-36 text-xs" />
          </div>
          <label className="inline-flex h-8 items-center gap-2 text-xs">
            <Switch size="sm" checked={draft.blockInjection} disabled={!canEdit} onCheckedChange={(blockInjection) => set({ blockInjection })} aria-label="Flag prompt injection" />
            Flag attempts to override the instructions
          </label>
        </div>
        <div className="space-y-1">
          <label htmlFor="cf-keywords" className="block text-[11px] text-muted-foreground">Keywords or phrases, one per line (whole words, any case)</label>
          <Textarea id="cf-keywords" rows={3} value={draft.keywords} disabled={!canEdit} onChange={(e) => set({ keywords: e.target.value })} className="text-xs" />
        </div>
        {!valid && (
          <p className="text-xs text-destructive">
            Longest message {L.minInputChars}–{L.maxInputChars.toLocaleString()}, repeats {L.minRepeatLimit}–{L.maxRepeatLimit}, up to {L.maxKeywords} keywords of {L.maxKeywordLength} characters.
          </p>
        )}
        {canEdit && (
          <div className="flex gap-2">
            <Button type="submit" size="sm" className="h-8 text-xs" disabled={!next || !dirty || save.isPending}>Save</Button>
            {dirty && <Button type="button" variant="ghost" size="sm" className="h-8 text-xs" onClick={() => setDraft(toDraft(data.settings))}>Discard</Button>}
          </div>
        )}
      </form>

      {canEdit && (
        <div className="space-y-2 border-t pt-3">
          <p className="text-xs font-medium text-muted-foreground">Recent flags (kept {L.eventRetentionDays} days)</p>
          {(events.data?.events ?? []).length === 0 ? <p className="text-xs text-muted-foreground">Nothing flagged.</p> : (
            <ul className="divide-y rounded-xl border" aria-label="Flagged messages">
              {events.data!.events.map(e => (
                <li key={e.id} className="space-y-0.5 px-3 py-2 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={e.action === 'blocked' ? 'font-medium text-destructive' : 'font-medium'}>{e.action === 'blocked' ? 'Blocked' : 'Recorded'}</span>
                    <span>{REASONS[e.reason] ?? e.reason}</span>
                    <span className="text-muted-foreground">{e.detail}</span>
                    <span className="text-muted-foreground">{e.endUser ?? 'no end user'} · {new Date(e.createdAt).toLocaleString()}</span>
                  </div>
                  <p className="truncate text-muted-foreground" title={e.excerpt}>{e.excerpt}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}
