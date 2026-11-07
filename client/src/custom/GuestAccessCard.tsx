import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Globe, TriangleAlert } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import type { GuestPermission } from '../../../shared/guest-access'
import { useCustomT } from './i18n/use-custom-t'

interface Available { key: GuestPermission; title: string; description: string; warning?: boolean }
interface State { permissions: GuestPermission[]; available: Available[] }

/**
 * What a signed-out visitor may look at. Only read permissions exist for guests; changing them takes the
 * same right as assigning permissions to an account.
 */
export function GuestAccessCard({ canEdit }: { canEdit: boolean }) {
  const tc = useCustomT()
  const queryClient = useQueryClient()
  const { data } = useQuery<State>({ queryKey: ['guest-access-admin'], queryFn: () => apiFetch('/api/admin/guest-access') })
  const [draft, setDraft] = useState<GuestPermission[] | null>(null)
  useEffect(() => { setDraft(null) }, [data])
  const save = useMutation({
    mutationFn: (permissions: GuestPermission[]) => apiFetch<State>('/api/admin/guest-access', { method: 'PUT', body: JSON.stringify({ permissions }) }),
    onSuccess: (s) => { queryClient.setQueryData(['guest-access-admin'], s); void queryClient.invalidateQueries({ queryKey: ['guest-access'] }); toast.success(tc('Guest access saved')) },
    onError: (err: Error) => toast.error(err.message || tc('Could not save')),
  })
  if (!data || !Array.isArray(data.available)) return null
  const current = draft ?? data.permissions
  const dirty = draft !== null && [...draft].sort().join() !== [...data.permissions].sort().join()
  const toggle = (key: GuestPermission) => setDraft(current.includes(key) ? current.filter(k => k !== key) : [...current, key])

  return (
    <section className="rounded-2xl border bg-card p-4 space-y-3" aria-label="Guest access">
      <div className="flex items-center gap-1.5"><Globe className="size-4" /><h2 className="text-sm font-semibold">{tc('Guest access (signed-out visitors)')}</h2></div>
      <p className="text-xs text-muted-foreground">{tc('Pages anyone can look at without signing in. Guests can only view: no switch, edit, add or delete works for them, and they are asked to sign in or request access five seconds after they arrive. With nothing ticked, visitors only see the sign-in card.')}</p>
      <ul className="space-y-2">
        {data.available.map(p => (
          <li key={p.key}>
            <label className="flex items-start gap-2 text-xs">
              <input type="checkbox" className="mt-0.5 size-3.5" checked={current.includes(p.key)} disabled={!canEdit} onChange={() => toggle(p.key)} aria-label={p.title} />
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
      {canEdit && (
        <div className="flex gap-2">
          <Button size="sm" className="h-8 text-xs" disabled={!dirty || save.isPending} onClick={() => save.mutate(current)}>{tc('Save')}</Button>
          {dirty && <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => setDraft(null)}>{tc('Discard')}</Button>}
        </div>
      )}
    </section>
  )
}
