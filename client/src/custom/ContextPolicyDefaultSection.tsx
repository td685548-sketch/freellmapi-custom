import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Gauge } from 'lucide-react'
import {
  CONTEXT_POLICY_LIMITS,
  type ContextPolicyDefault,
  type ContextPresetKey,
} from '@freellmapi/shared/context-budget.js'
import { apiFetch } from '@/lib/api'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Switch } from '@/components/ui/switch'
import { useSessionRevision } from './session-state'
import { useUserSession } from './use-session'
import { useCustomT } from './i18n/use-custom-t'

interface DefaultDraft {
  preset: ContextPresetKey
  fallbackWindowTokens: string
  imageTokens: string
}

const PRESET_OPTIONS: Array<{ value: ContextPresetKey; label: string }> = [
  { value: 'saver', label: 'Saver' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'max_context', label: 'Max context' },
]

const toDraft = (d: ContextPolicyDefault): DefaultDraft => ({
  preset: d.preset,
  fallbackWindowTokens: String(d.fallbackWindowTokens),
  imageTokens: String(d.imageTokens),
})

function parseIntInRange(text: string, min: number, max: number): number | undefined {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  const n = Number(trimmed)
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined
}

/**
 * Installation-wide default context budget policy managed via `/api/settings/context-policy`.
 * Profiles that do not configure a custom override inherit these defaults.
 */
export function ContextPolicyDefaultSection() {
  const tc = useCustomT()
  const { hasPermission } = useUserSession()
  const revision = useSessionRevision()
  const queryClient = useQueryClient()

  const canView = hasPermission('view_settings') || hasPermission('edit_settings')
  const canEdit = hasPermission('edit_settings')
  const queryKey = ['context-policy-default', revision]

  const query = useQuery<ContextPolicyDefault>({
    queryKey,
    queryFn: () => apiFetch<ContextPolicyDefault>('/api/settings/context-policy'),
    enabled: canView,
    retry: false,
  })

  const [edits, setEdits] = useState<Partial<DefaultDraft> | null>(null)

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey })
    void queryClient.invalidateQueries({ queryKey: ['context-policy'] })
    void queryClient.invalidateQueries({ queryKey: ['conversations'] })
    void queryClient.invalidateQueries({ queryKey: ['context-preview'] })
  }

  const save = useMutation({
    mutationFn: (body: Partial<ContextPolicyDefault>) =>
      apiFetch<ContextPolicyDefault>('/api/settings/context-policy', {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    onSuccess: (res) => {
      queryClient.setQueryData(queryKey, res)
      setEdits(null)
      toast.success(tc('Default context policy saved'))
      invalidate()
    },
    onError: (err: Error) => toast.error(err.message || tc('Could not save')),
  })

  if (!canView) return null

  const saved = query.data
  const draft: DefaultDraft | null = saved ? { ...toDraft(saved), ...edits } : null
  const [minFallback, maxFallback] = CONTEXT_POLICY_LIMITS.fallbackWindowTokens
  const [minImg, maxImg] = CONTEXT_POLICY_LIMITS.imageTokens

  const fallbackWindowTokens = draft
    ? parseIntInRange(draft.fallbackWindowTokens, minFallback, maxFallback)
    : undefined
  const imageTokens = draft ? parseIntInRange(draft.imageTokens, minImg, maxImg) : undefined
  const valid = fallbackWindowTokens !== undefined && imageTokens !== undefined
  const dirty = Boolean(saved && draft && JSON.stringify(toDraft(saved)) !== JSON.stringify(draft))

  const buildBody = (enabled: boolean): Partial<ContextPolicyDefault> => ({
    enabled,
    preset: draft!.preset,
    fallbackWindowTokens,
    imageTokens,
  })

  return (
    <section className="mt-6 space-y-4 border-t pt-5" aria-labelledby="default-context-policy-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Gauge className="size-4" />
          <h3 id="default-context-policy-title" className="text-sm font-semibold">
            {tc('Default context budget policy')}
          </h3>
        </div>
        {saved && (
          <label className="inline-flex items-center gap-2 text-xs">
            <Switch
              size="sm"
              checked={saved.enabled}
              disabled={!canEdit || save.isPending}
              onCheckedChange={(enabled) =>
                save.mutate(dirty && valid ? buildBody(enabled) : { enabled })
              }
              aria-label="Enable context budget by default"
            />
            {saved.enabled ? tc('On') : tc('Off')}
          </label>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        {tc('System-wide default for every client key that does not set a custom override.')}
      </p>

      {query.isPending && (
        <p role="status" className="text-xs text-muted-foreground">
          {tc('Loading default context policy…')}
        </p>
      )}
      {query.isError && (
        <div role="alert" className="text-xs text-destructive">
          {tc('Could not load default context policy.')}{' '}
          <Button type="button" size="xs" variant="outline" onClick={() => void query.refetch()}>
            {tc('Retry')}
          </Button>
        </div>
      )}

      {saved && draft && (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (!canEdit || !valid || !dirty || save.isPending) return
            save.mutate(buildBody(saved.enabled))
          }}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-medium text-muted-foreground">{tc('Default preset')}</span>
            {canEdit ? (
              <SegmentedControl
                ariaLabel="Default context preset"
                value={draft.preset}
                onValueChange={(preset) => setEdits(prev => ({ ...prev, preset }))}
                options={PRESET_OPTIONS.map(o => ({ ...o, label: tc(o.label) }))}
              />
            ) : (
              <span className="text-xs font-medium">
                {tc(PRESET_OPTIONS.find(o => o.value === draft.preset)?.label ?? draft.preset)}
              </span>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <label htmlFor="ctx-default-fallbackWindow" className="block text-[11px] text-muted-foreground">
                {tc('Fallback context window (tokens)')}
              </label>
              <Input
                id="ctx-default-fallbackWindow"
                inputMode="numeric"
                value={draft.fallbackWindowTokens}
                disabled={!canEdit}
                onChange={(e) => setEdits(prev => ({ ...prev, fallbackWindowTokens: e.target.value }))}
                className="h-8 text-xs"
              />
            </div>

            <div className="space-y-1">
              <label htmlFor="ctx-default-imageTokens" className="block text-[11px] text-muted-foreground">
                {tc('Default image estimate (tokens)')}
              </label>
              <Input
                id="ctx-default-imageTokens"
                inputMode="numeric"
                value={draft.imageTokens}
                disabled={!canEdit}
                onChange={(e) => setEdits(prev => ({ ...prev, imageTokens: e.target.value }))}
                className="h-8 text-xs"
              />
            </div>
          </div>

          <p className="text-[11px] text-muted-foreground">
            {tc('Applies when a serving model reports no context_window and the key leaves max input tokens unset. Image tokens apply per image content block.')}
          </p>

          {!valid && (
            <p role="alert" className="text-xs text-destructive">
              {tc('Fallback window must be between {min} and {max}, and image estimate between {imgMin} and {imgMax}.', {
                min: minFallback.toLocaleString(),
                max: maxFallback.toLocaleString(),
                imgMin: minImg.toLocaleString(),
                imgMax: maxImg.toLocaleString(),
              })}
            </p>
          )}

          {canEdit && dirty && (
            <div className="flex gap-2">
              <Button type="submit" size="sm" className="h-8 text-xs" disabled={!valid || save.isPending}>
                {tc('Save')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 text-xs"
                onClick={() => setEdits(null)}
              >
                {tc('Discard')}
              </Button>
            </div>
          )}
        </form>
      )}
    </section>
  )
}
