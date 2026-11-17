import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Gauge } from 'lucide-react'
import {
  CONTEXT_POLICY_LIMITS,
  CONTEXT_PRESETS,
  type ClientHistoryMode,
  type ContextPolicy,
  type ContextPolicyInput,
  type ContextPolicyResponse,
  type ContextPreset,
  type ContextPresetKey,
  type ContextStats,
} from '@freellmapi/shared/context-budget.js'
import { apiFetch } from '@/lib/api'
import { toast } from '@/lib/toast'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Switch } from '@/components/ui/switch'
import { useCustomT } from './i18n/use-custom-t'

interface Draft {
  preset: ContextPreset
  maxInputTokens: string
  outputReserveTokens: string
  safetyMarginPct: string
  summarySharePct: string
  knowledgeSharePct: string
  dropBlockTurns: string
  summarize: boolean
  clientHistoryMode: ClientHistoryMode
  knowledgeMinScore: string
}

const PRESET_OPTIONS: Array<{ value: ContextPreset; label: string }> = [
  { value: 'saver', label: 'Saver' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'max_context', label: 'Max context' },
  { value: 'custom', label: 'Custom' },
]

const CLIENT_HISTORY_OPTIONS: Array<{ value: ClientHistoryMode; label: string }> = [
  { value: 'passthrough', label: 'Keep as sent' },
  { value: 'trim_on_overflow', label: 'Trim on overflow' },
  { value: 'enforce_budget', label: 'Enforce budget' },
]

const toDraft = (p: ContextPolicy): Draft => ({
  preset: p.preset,
  maxInputTokens: p.maxInputTokens === null ? '' : String(p.maxInputTokens),
  outputReserveTokens: String(p.outputReserveTokens),
  safetyMarginPct: String(p.safetyMarginPct),
  summarySharePct: String(p.summarySharePct),
  knowledgeSharePct: String(p.knowledgeSharePct),
  dropBlockTurns: String(p.dropBlockTurns),
  summarize: p.summarize,
  clientHistoryMode: p.clientHistoryMode,
  knowledgeMinScore: p.knowledgeMinScore === null ? '' : String(p.knowledgeMinScore),
})

function parseRequiredInt(text: string, min: number, max: number): number | undefined {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  const n = Number(trimmed)
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined
}

function parseOptionalInt(text: string, min: number, max: number): number | null | undefined {
  const trimmed = text.trim()
  if (!trimmed) return null
  const n = Number(trimmed)
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined
}

function parseOptionalScore(text: string, min: number, max: number): number | null | undefined {
  const trimmed = text.trim()
  if (!trimmed) return null
  const n = Number(trimmed)
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined
}

/**
 * Per-key token-budgeted context assembly policy, legacy conversion confirmation, and 7-day
 * usage/estimate-error statistics for a client profile.
 */
export function ContextPolicyCard({ profileId, canEdit }: { profileId: number; canEdit: boolean }) {
  const tc = useCustomT()
  const queryClient = useQueryClient()
  const base = `/api/client-profiles/${profileId}`

  const { data } = useQuery<ContextPolicyResponse>({
    queryKey: ['context-policy', profileId],
    queryFn: () => apiFetch(`${base}/context-policy`),
  })

  const statsQuery = useQuery<ContextStats>({
    queryKey: ['context-stats', profileId],
    queryFn: () => apiFetch(`${base}/context-stats?days=7`),
  })

  const [edits, setEdits] = useState<Partial<Draft> | null>(null)

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['context-policy', profileId] })
    void queryClient.invalidateQueries({ queryKey: ['conversations', profileId] })
  }

  const save = useMutation({
    mutationFn: (body: ContextPolicyInput) =>
      apiFetch<ContextPolicyResponse>(`${base}/context-policy`, {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    onSuccess: (res) => {
      if (res?.policy) {
        queryClient.setQueryData(['context-policy', profileId], res)
      }
      setEdits(null)
      toast.success(tc('Context policy saved'))
      invalidate()
    },
    onError: (err: Error) => toast.error(err.message || tc('Could not save')),
  })

  const reset = useMutation({
    mutationFn: () => apiFetch<void>(`${base}/context-policy`, { method: 'DELETE' }),
    onSuccess: () => {
      setEdits(null)
      toast.success(tc('Reset to system default'))
      invalidate()
    },
    onError: (err: Error) => toast.error(err.message || tc('Could not reset')),
  })

  if (!data?.policy) return null

  const { policy, suggested } = data
  const draft: Draft = { ...toDraft(policy), ...edits }
  const presets = data.presets ?? CONTEXT_PRESETS
  const limits = data.limits ?? CONTEXT_POLICY_LIMITS

  const maxInputTokens = parseOptionalInt(draft.maxInputTokens, limits.minMaxInputTokens, limits.maxMaxInputTokens)
  const outputReserveTokens = parseRequiredInt(draft.outputReserveTokens, limits.outputReserve[0], limits.outputReserve[1])
  const safetyMarginPct = parseRequiredInt(draft.safetyMarginPct, limits.safetyMarginPct[0], limits.safetyMarginPct[1])
  const summarySharePct = parseRequiredInt(draft.summarySharePct, limits.sharePct[0], limits.sharePct[1])
  const knowledgeSharePct = parseRequiredInt(draft.knowledgeSharePct, limits.sharePct[0], limits.sharePct[1])
  const dropBlockTurns = parseRequiredInt(draft.dropBlockTurns, limits.dropBlockTurns[0], limits.dropBlockTurns[1])
  const knowledgeMinScore = parseOptionalScore(draft.knowledgeMinScore, limits.knowledgeMinScore[0], limits.knowledgeMinScore[1])

  const sharesTooLarge =
    summarySharePct !== undefined &&
    knowledgeSharePct !== undefined &&
    summarySharePct + knowledgeSharePct > limits.maxShareSum

  const valid =
    maxInputTokens !== undefined &&
    outputReserveTokens !== undefined &&
    safetyMarginPct !== undefined &&
    summarySharePct !== undefined &&
    knowledgeSharePct !== undefined &&
    dropBlockTurns !== undefined &&
    knowledgeMinScore !== undefined &&
    !sharesTooLarge

  const dirty = JSON.stringify(toDraft(policy)) !== JSON.stringify(draft)

  const set = (patch: Partial<Draft>) => setEdits(prev => ({ ...prev, ...patch }))

  const handlePresetChange = (preset: ContextPreset) => {
    if (!canEdit) return
    if (preset === 'custom') {
      set({ preset: 'custom' })
      return
    }
    const vals = presets[preset as ContextPresetKey]
    set({
      preset,
      maxInputTokens: vals.maxInputTokens === null ? '' : String(vals.maxInputTokens),
      outputReserveTokens: String(vals.outputReserveTokens),
      safetyMarginPct: String(vals.safetyMarginPct),
      summarySharePct: String(vals.summarySharePct),
      knowledgeSharePct: String(vals.knowledgeSharePct),
      dropBlockTurns: String(vals.dropBlockTurns),
    })
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!canEdit || !valid || !dirty || save.isPending) return
    const body: ContextPolicyInput =
      draft.preset === 'custom'
        ? {
            enabled: policy.enabled,
            preset: 'custom',
            maxInputTokens,
            outputReserveTokens,
            safetyMarginPct,
            summarySharePct,
            knowledgeSharePct,
            dropBlockTurns,
            summarize: draft.summarize,
            clientHistoryMode: draft.clientHistoryMode,
            knowledgeMinScore,
          }
        : {
            enabled: policy.enabled,
            preset: draft.preset,
            summarize: draft.summarize,
            clientHistoryMode: draft.clientHistoryMode,
            knowledgeMinScore,
          }
    save.mutate(body)
  }

  const stats = statsQuery.data && typeof statsQuery.data.requests === 'number' ? statsQuery.data : null

  return (
    <section className="rounded-2xl border bg-card p-4 space-y-4" aria-label="Context budget policy">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5">
            <Gauge className="size-4" />
            <h3 className="text-sm font-semibold">{tc('Context budget policy')}</h3>
          </div>
          <Badge variant={policy.inherited ? 'secondary' : 'outline'}>
            {policy.inherited ? tc('Inherited from system default') : tc('Custom override')}
          </Badge>
        </div>
        <div className="flex items-center gap-3">
          {canEdit && !policy.inherited && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={reset.isPending}
              onClick={() => reset.mutate()}
            >
              {tc('Reset to default')}
            </Button>
          )}
          <label className="inline-flex items-center gap-2 text-xs">
            <Switch
              size="sm"
              checked={policy.enabled}
              disabled={!canEdit || save.isPending}
              onCheckedChange={(enabled) => save.mutate({ enabled })}
              aria-label="Enable context policy"
            />
            {policy.enabled ? tc('On') : tc('Off')}
          </label>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        {tc('Assembles system instructions, summary, retrieved knowledge, and recent history within a single token budget per request and per model window.')}
      </p>

      {suggested && (
        <div
          className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-dashed bg-muted/40 p-3 text-xs"
          aria-label="Suggested policy values"
        >
          <div>
            <p className="font-medium">{tc('Suggested from existing conversation settings')}</p>
            <p className="text-muted-foreground">
              {tc('Max input tokens: {tokens} · Summarize older turns: {summarize}', {
                tokens: suggested.maxInputTokens.toLocaleString(),
                summarize: suggested.summarize ? tc('On') : tc('Off'),
              })}
            </p>
          </div>
          {canEdit && (
            <Button
              type="button"
              size="sm"
              className="h-7 text-xs"
              disabled={save.isPending}
              onClick={() =>
                save.mutate({
                  enabled: true,
                  preset: 'custom',
                  maxInputTokens: suggested.maxInputTokens,
                  summarize: suggested.summarize,
                })
              }
            >
              {tc('Apply suggested')}
            </Button>
          )}
        </div>
      )}

      <form className="space-y-3" onSubmit={handleSubmit}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-medium text-muted-foreground">{tc('Preset')}</span>
          {canEdit ? (
            <SegmentedControl
              ariaLabel="Context preset"
              value={draft.preset}
              onValueChange={handlePresetChange}
              options={PRESET_OPTIONS.map(o => ({ ...o, label: tc(o.label) }))}
            />
          ) : (
            <span className="text-xs font-medium">
              {tc(PRESET_OPTIONS.find(o => o.value === draft.preset)?.label ?? draft.preset)}
            </span>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1">
            <label htmlFor="ctx-maxInputTokens" className="block text-[11px] text-muted-foreground">
              {tc('Max input tokens (empty = model window)')}
            </label>
            <Input
              id="ctx-maxInputTokens"
              inputMode="numeric"
              placeholder={tc('Model window')}
              value={draft.maxInputTokens}
              disabled={!canEdit}
              onChange={(e) => set({ preset: 'custom', maxInputTokens: e.target.value })}
              className="h-8 text-xs"
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="ctx-outputReserveTokens" className="block text-[11px] text-muted-foreground">
              {tc('Output reserve (tokens)')}
            </label>
            <Input
              id="ctx-outputReserveTokens"
              inputMode="numeric"
              value={draft.outputReserveTokens}
              disabled={!canEdit}
              onChange={(e) => set({ preset: 'custom', outputReserveTokens: e.target.value })}
              className="h-8 text-xs"
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="ctx-safetyMarginPct" className="block text-[11px] text-muted-foreground">
              {tc('Safety margin (%)')}
            </label>
            <Input
              id="ctx-safetyMarginPct"
              inputMode="numeric"
              value={draft.safetyMarginPct}
              disabled={!canEdit}
              onChange={(e) => set({ preset: 'custom', safetyMarginPct: e.target.value })}
              className="h-8 text-xs"
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="ctx-dropBlockTurns" className="block text-[11px] text-muted-foreground">
              {tc('Drop block size (turns)')}
            </label>
            <Input
              id="ctx-dropBlockTurns"
              inputMode="numeric"
              value={draft.dropBlockTurns}
              disabled={!canEdit}
              onChange={(e) => set({ preset: 'custom', dropBlockTurns: e.target.value })}
              className="h-8 text-xs"
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="ctx-summarySharePct" className="block text-[11px] text-muted-foreground">
              {tc('Summary share (%)')}
            </label>
            <Input
              id="ctx-summarySharePct"
              inputMode="numeric"
              value={draft.summarySharePct}
              disabled={!canEdit}
              onChange={(e) => set({ preset: 'custom', summarySharePct: e.target.value })}
              className="h-8 text-xs"
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="ctx-knowledgeSharePct" className="block text-[11px] text-muted-foreground">
              {tc('Knowledge share (%)')}
            </label>
            <Input
              id="ctx-knowledgeSharePct"
              inputMode="numeric"
              value={draft.knowledgeSharePct}
              disabled={!canEdit}
              onChange={(e) => set({ preset: 'custom', knowledgeSharePct: e.target.value })}
              className="h-8 text-xs"
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="ctx-knowledgeMinScore" className="block text-[11px] text-muted-foreground">
              {tc('Knowledge min score (0–1, optional)')}
            </label>
            <Input
              id="ctx-knowledgeMinScore"
              inputMode="decimal"
              placeholder={tc('Off')}
              value={draft.knowledgeMinScore}
              disabled={!canEdit}
              onChange={(e) => set({ knowledgeMinScore: e.target.value })}
              className="h-8 text-xs"
            />
          </div>
        </div>

        <label className="flex items-start gap-2 text-xs">
          <Switch
            size="sm"
            checked={draft.summarize}
            disabled={!canEdit}
            onCheckedChange={(summarize) => set({ summarize })}
            aria-label="Summarize on budget pressure"
            className="mt-0.5"
          />
          <span>
            <span className="font-medium">{tc('Summarize on budget pressure')}</span>
            <span className="block text-muted-foreground">
              {tc('Folds turns dropped by the token budget into the rolling summary within the summary share cap.')}
            </span>
          </span>
        </label>

        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-medium">{tc('Client-sent history mode')}</span>
            {canEdit ? (
              <SegmentedControl
                ariaLabel="Client-sent history mode"
                value={draft.clientHistoryMode}
                onValueChange={(clientHistoryMode) => set({ clientHistoryMode })}
                options={CLIENT_HISTORY_OPTIONS.map(o => ({ ...o, label: tc(o.label) }))}
              />
            ) : (
              <span className="text-xs text-muted-foreground">
                {tc(
                  CLIENT_HISTORY_OPTIONS.find(o => o.value === draft.clientHistoryMode)?.label ??
                    draft.clientHistoryMode,
                )}
              </span>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground">
            {tc('Controls requests where the client sends full message history without X-Conversation-Id. Keep as sent is the default; trimming modes alter client-sent messages without storing summaries.')}
          </p>
        </div>

        {!valid && (
          <p role="alert" className="text-xs text-destructive">
            {maxInputTokens === undefined
              ? tc('Max input tokens must be empty or between {min} and {max}.', {
                  min: limits.minMaxInputTokens.toLocaleString(),
                  max: limits.maxMaxInputTokens.toLocaleString(),
                })
              : sharesTooLarge
                ? tc('Summary share + knowledge share must not exceed {max}%.', {
                    max: limits.maxShareSum,
                  })
                : tc('One or more fields are outside the allowed range.')}
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

      {stats && (
        <div className="space-y-2 border-t pt-3" aria-label="Context budget statistics">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium text-muted-foreground">{tc('Last 7 days')}</p>
            <p className="text-[11px] text-muted-foreground">
              {tc('{requests} requests', { requests: stats.requests.toLocaleString() })}
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl border bg-muted/20 p-2.5">
              <p className="text-[11px] text-muted-foreground">{tc('Avg input tokens')}</p>
              <p className="text-sm font-semibold tabular-nums">
                {Math.round(stats.avgInputTokens).toLocaleString()}
              </p>
              <p className="text-[11px] text-muted-foreground tabular-nums">
                {tc('Avg budget: {tokens}', { tokens: Math.round(stats.avgBudgetTokens).toLocaleString() })}
              </p>
            </div>
            <div className="rounded-xl border bg-muted/20 p-2.5">
              <p className="text-[11px] text-muted-foreground">{tc('Trimmed rate')}</p>
              <p className="text-sm font-semibold tabular-nums">{Math.round(stats.trimmedRate * 100)}%</p>
              <p className="text-[11px] text-muted-foreground tabular-nums">
                {tc('Avg dropped: {turns}', { turns: stats.avgHistoryDropped.toFixed(1) })}
              </p>
            </div>
            <div className="rounded-xl border bg-muted/20 p-2.5">
              <p className="text-[11px] text-muted-foreground">{tc('Saved tokens')}</p>
              <p className="text-sm font-semibold tabular-nums">{stats.savedTokens.toLocaleString()}</p>
              <p className="text-[11px] text-muted-foreground tabular-nums">
                {tc('Summary used: {pct}%', { pct: Math.round(stats.summaryUsedRate * 100) })}
              </p>
            </div>
            <div className="rounded-xl border bg-muted/20 p-2.5">
              <p className="text-[11px] text-muted-foreground">{tc('Estimate error')}</p>
              {stats.estimateError.samples > 0 && stats.estimateError.p50Pct !== null ? (
                <>
                  <p className="text-sm font-semibold tabular-nums">
                    p50 {stats.estimateError.p50Pct.toFixed(1)}% · p95{' '}
                    {stats.estimateError.p95Pct !== null ? `${stats.estimateError.p95Pct.toFixed(1)}%` : '—'}
                  </p>
                  <p className="text-[11px] text-muted-foreground tabular-nums">
                    {stats.estimateError.within15PctRate !== null
                      ? tc('{pct}% within 15% ({samples})', {
                          pct: Math.round(stats.estimateError.within15PctRate * 100),
                          samples: stats.estimateError.samples.toLocaleString(),
                        })
                      : tc('{samples} samples', { samples: stats.estimateError.samples.toLocaleString() })}
                  </p>
                </>
              ) : (
                <p className="text-xs text-muted-foreground">{tc('No usage samples yet')}</p>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
