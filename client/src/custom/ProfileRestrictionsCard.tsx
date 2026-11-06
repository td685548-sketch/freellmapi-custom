import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { MAX_ALLOWED_MODELS, MAX_TOKENS_CAP_LIMIT, type ProfileRestrictions } from '../../../shared/profile-restrictions'

const fmt = (n: number) => n.toLocaleString()

interface Draft { models: string[]; maxTokens: string }

/**
 * What one client key may do: the models it may use (empty = any) and the largest max_tokens a
 * request may ask for (empty = no cap). Viewers see the settings; editors change them.
 */
export function ProfileRestrictionsCard({ profileId, canEdit }: { profileId: number; canEdit: boolean }) {
  const queryClient = useQueryClient()
  const key = ['profile-restrictions', profileId]
  const endpoint = `/api/client-profiles/${profileId}/restrictions`
  const { data } = useQuery<{ restrictions: ProfileRestrictions }>({ queryKey: key, queryFn: () => apiFetch(endpoint) })
  const { data: catalog } = useQuery<unknown>({ queryKey: ['model-catalog-ids'], queryFn: () => apiFetch('/api/models'), enabled: canEdit })
  const [draft, setDraft] = useState<Draft | null>(null)
  const [typed, setTyped] = useState('')

  const save = useMutation({
    mutationFn: (body: ProfileRestrictions) => apiFetch<{ restrictions: ProfileRestrictions }>(endpoint, { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: (res) => { queryClient.setQueryData(key, res); setDraft(null); toast.success('Restrictions updated') },
    onError: (err: Error) => toast.error(err.message || 'Failed to update the restrictions'),
  })

  if (!data?.restrictions) return null
  const saved = data.restrictions
  const models = draft?.models ?? saved.allowedModels
  const maxText = draft?.maxTokens ?? (saved.maxTokens === null ? '' : String(saved.maxTokens))
  const trimmed = maxText.trim()
  const maxTokens = trimmed === '' ? null : Number(trimmed)
  const validMax = maxTokens === null || (Number.isInteger(maxTokens) && maxTokens >= 1 && maxTokens <= MAX_TOKENS_CAP_LIMIT)
  const dirty = draft !== null && (JSON.stringify(models) !== JSON.stringify(saved.allowedModels) || maxTokens !== saved.maxTokens)

  const suggestions = Array.isArray(catalog)
    ? [...new Set((catalog as Array<{ modelId?: unknown }>).map(m => (typeof m.modelId === 'string' ? m.modelId.toLowerCase() : '')).filter(Boolean))].sort()
    : []
  const update = (patch: Partial<Draft>) => setDraft({ models, maxTokens: maxText, ...patch })
  const add = () => {
    const id = typed.trim().toLowerCase()
    if (!id || models.includes(id) || models.length >= MAX_ALLOWED_MODELS) return
    update({ models: [...models, id] })
    setTyped('')
  }

  return (
    <form
      className="rounded-2xl border bg-card p-4 space-y-4"
      onSubmit={(e) => { e.preventDefault(); if (canEdit && validMax && dirty) save.mutate({ allowedModels: models, maxTokens }) }}
    >
      <h3 className="text-sm font-semibold">Restrictions</h3>

      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">Models this key may use</p>
        {models.length === 0 ? (
          <p className="text-xs text-muted-foreground">Any model. Add some to limit the key to them.</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5" aria-label="Allowed models">
            {models.map(m => (
              <li key={m} className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-mono">
                {m}
                {canEdit && (
                  <button type="button" aria-label={`Remove ${m}`} className="text-muted-foreground hover:text-foreground" onClick={() => update({ models: models.filter(x => x !== m) })}>
                    <X className="size-3" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {canEdit && (
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }}
              list="profile-model-suggestions"
              placeholder="Model id, e.g. llama-3.3-70b-versatile"
              aria-label="Add a model"
              className="h-8 w-72 text-xs"
            />
            <datalist id="profile-model-suggestions">{suggestions.map(s => <option key={s} value={s} />)}</datalist>
            <Button type="button" variant="outline" size="sm" className="h-8 text-xs" disabled={!typed.trim()} onClick={add}>Add</Button>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          With a list, "auto" requests are routed only to these models, and naming any other model is refused. Endpoints that do not route automatically (embeddings, images, audio, Gemini) must name one of them.
        </p>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="profile-max-tokens" className="block text-xs font-medium text-muted-foreground">Largest max_tokens per request</label>
        <Input
          id="profile-max-tokens"
          inputMode="numeric"
          value={maxText}
          onChange={(e) => update({ maxTokens: e.target.value })}
          placeholder="No cap"
          disabled={!canEdit}
          className="h-8 w-40 text-xs"
        />
        <p className="text-xs text-muted-foreground">
          {validMax ? 'A larger request is lowered to this, and one that asks for none gets it.' : `Use a whole number from 1 to ${fmt(MAX_TOKENS_CAP_LIMIT)}, or leave empty.`}
        </p>
      </div>

      {canEdit && (
        <Button type="submit" size="sm" className="h-8 text-xs" disabled={!dirty || !validMax || save.isPending}>Save restrictions</Button>
      )}
    </form>
  )
}
