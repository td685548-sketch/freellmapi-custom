import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Globe, TriangleAlert } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { GUEST_TRIAL_LIMITS as TL, type GuestPermission, type GuestTrialSettings } from '../../../shared/guest-access'
import { useCustomT } from './i18n/use-custom-t'

interface Available { key: GuestPermission; title: string; description: string; warning?: boolean }
interface State { permissions: GuestPermission[]; available: Available[]; trial?: GuestTrialSettings }
type NumberField = 'perIpPerHour' | 'dailyCap' | 'maxTokens' | 'maxInputChars'

const TRIAL_FIELDS: Array<{ key: NumberField; label: string; range: readonly [number, number] }> = [
  { key: 'perIpPerHour', label: 'Messages per visitor (IP) per hour', range: TL.perIpPerHour },
  { key: 'dailyCap', label: 'Messages per day, all visitors', range: TL.dailyCap },
  { key: 'maxTokens', label: 'Longest answer (tokens)', range: TL.maxTokens },
  { key: 'maxInputChars', label: 'Longest visitor message (characters)', range: TL.maxInputChars },
]

interface Draft { permissions: GuestPermission[]; trial: Record<NumberField, string>; models: string }
const toDraft = (s: State): Draft => ({
  permissions: s.permissions,
  trial: Object.fromEntries(TRIAL_FIELDS.map(f => [f.key, String(s.trial?.[f.key] ?? '')])) as Record<NumberField, string>,
  models: (s.trial?.models ?? []).join('\n'),
})

/**
 * What a signed-out visitor may do: read-only views, and optionally a small trial chat with its limits.
 * Changing it takes the same right as assigning permissions to an account.
 */
export function GuestAccessCard({ canEdit }: { canEdit: boolean }) {
  const tc = useCustomT()
  const queryClient = useQueryClient()
  const { data } = useQuery<State>({ queryKey: ['guest-access-admin'], queryFn: () => apiFetch('/api/admin/guest-access') })
  const [draft, setDraft] = useState<Draft | null>(null)
  useEffect(() => { setDraft(null) }, [data])
  const save = useMutation({
    mutationFn: (body: { permissions: GuestPermission[]; trial?: Partial<GuestTrialSettings> }) => apiFetch<State>('/api/admin/guest-access', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: (s) => { queryClient.setQueryData(['guest-access-admin'], s); void queryClient.invalidateQueries({ queryKey: ['guest-access'] }); toast.success(tc('Guest access saved')) },
    onError: (err: Error) => toast.error(err.message || tc('Could not save')),
  })
  if (!data || !Array.isArray(data.available)) return null
  const current = draft ?? toDraft(data)
  const edit = (patch: Partial<Draft>) => setDraft({ ...current, ...patch })
  const toggle = (key: GuestPermission) => edit({ permissions: current.permissions.includes(key) ? current.permissions.filter(k => k !== key) : [...current.permissions, key] })
  const numbers = Object.fromEntries(TRIAL_FIELDS.map(f => [f.key, Number(current.trial[f.key])])) as Record<NumberField, number>
  const models = current.models.split('\n').map(m => m.trim()).filter(Boolean)
  const trialValid = TRIAL_FIELDS.every(f => Number.isInteger(numbers[f.key]) && numbers[f.key] >= f.range[0] && numbers[f.key] <= f.range[1]) && models.length <= TL.maxModels
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(toDraft(data))
  const trialOn = current.permissions.includes('try_playground')

  return (
    <section className="rounded-2xl border bg-card p-4 space-y-3" aria-label="Guest access">
      <div className="flex items-center gap-1.5"><Globe className="size-4" /><h2 className="text-sm font-semibold">{tc('Guest access (signed-out visitors)')}</h2></div>
      <p className="text-xs text-muted-foreground">{tc('Pages anyone can look at without signing in. Guests can only view: no switch, edit, add or delete works for them, and they are asked to sign in or request access five seconds after they arrive. With nothing ticked, visitors only see the sign-in card.')}</p>
      <ul className="space-y-2">
        {data.available.map(p => (
          <li key={p.key}>
            <label className="flex items-start gap-2 text-xs">
              <input type="checkbox" className="mt-0.5 size-3.5" checked={current.permissions.includes(p.key)} disabled={!canEdit} onChange={() => toggle(p.key)} aria-label={p.title} />
              <span>
                <span className="font-medium">{tc(p.title)}</span>
                <span className={`block ${p.warning ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}>
                  {p.warning && <TriangleAlert className="mr-1 inline size-3" aria-hidden="true" />}{tc(p.description)}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>

      {trialOn && (
        <div className="space-y-2 rounded-xl border border-dashed p-3" aria-label="Trial chat limits">
          <p className="text-xs font-medium">{tc('Trial chat limits')}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {TRIAL_FIELDS.map(f => (
              <label key={f.key} className="space-y-1 text-[11px] text-muted-foreground">
                <span className="block">{tc(f.label)} ({f.range[0].toLocaleString()}–{f.range[1].toLocaleString()})</span>
                <Input inputMode="numeric" value={current.trial[f.key]} disabled={!canEdit} aria-label={f.label}
                  onChange={(e) => edit({ trial: { ...current.trial, [f.key]: e.target.value } })} className="h-8 text-xs" />
              </label>
            ))}
          </div>
          <label className="block space-y-1 text-[11px] text-muted-foreground">
            <span className="block">{tc('Models offered, one per line (empty = automatic choice). Pick fast, free ones.')}</span>
            <Textarea rows={3} value={current.models} disabled={!canEdit} aria-label="Trial models" placeholder="llama-3.1-8b-instant" onChange={(e) => edit({ models: e.target.value })} className="text-xs" />
          </label>
          {!trialValid && <p className="text-xs text-destructive">{tc('Use whole numbers within the ranges shown, and at most {max} models.', { max: TL.maxModels })}</p>}
        </div>
      )}

      {canEdit && (
        <div className="flex gap-2">
          <Button size="sm" className="h-8 text-xs" disabled={!dirty || save.isPending || (trialOn && !trialValid)}
            onClick={() => save.mutate({ permissions: current.permissions, ...(trialOn ? { trial: { ...numbers, models } } : {}) })}>{tc('Save')}</Button>
          {dirty && <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => setDraft(null)}>{tc('Discard')}</Button>}
        </div>
      )}
    </section>
  )
}
