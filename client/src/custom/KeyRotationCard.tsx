import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { toast } from '@/lib/toast'
import { ConfirmButton } from '@/components/confirm-button'
import { CopyButton } from '@/components/copy-button'
import { SegmentedControl } from '@/components/ui/segmented-control'

interface PreviousKey { keyHint: string; expiresAt: string; createdAt: string }
interface Rotated { id: number; key: string; maskedKey: string; previousKeyExpiresAt: string }

const GRACE = [
  { value: '1', label: '1 hour' },
  { value: '24', label: '24 hours' },
  { value: '72', label: '3 days' },
  { value: '168', label: '7 days' },
] as const
type Grace = typeof GRACE[number]['value']

const when = (iso: string) => new Date(iso).toLocaleString()

/**
 * Rotate a client key without breaking the web app that uses it: the new key works at once and the old
 * one keeps working for the chosen grace period, so the app's FREELLM_KEY can be changed first.
 */
export function KeyRotationCard({ profileId, canEdit }: { profileId: number; canEdit: boolean }) {
  const queryClient = useQueryClient()
  const listKey = ['profile-previous-keys', profileId]
  const { data } = useQuery<{ previousKeys: PreviousKey[] }>({
    queryKey: listKey,
    queryFn: () => apiFetch(`/api/client-profiles/${profileId}/previous-keys`),
  })
  const [grace, setGrace] = useState<Grace>('24')
  const [fresh, setFresh] = useState<Rotated | null>(null)

  const rotate = useMutation({
    mutationFn: () => apiFetch<Rotated>(`/api/client-profiles/${profileId}/rotate-with-grace`, { method: 'POST', body: JSON.stringify({ graceHours: Number(grace) }) }),
    onSuccess: (r) => {
      setFresh(r)
      void queryClient.invalidateQueries({ queryKey: listKey })
      void queryClient.invalidateQueries({ queryKey: ['client-profiles'] })
    },
    onError: (err: Error) => toast.error(err.message || 'Could not rotate the key'),
  })
  const end = useMutation({
    mutationFn: () => apiFetch<{ revoked: number }>(`/api/client-profiles/${profileId}/previous-keys`, { method: 'DELETE' }),
    onSuccess: (r) => {
      toast.success(r.revoked === 1 ? 'The old key stopped working' : `${r.revoked} old keys stopped working`)
      void queryClient.invalidateQueries({ queryKey: listKey })
    },
    onError: (err: Error) => toast.error(err.message || 'Could not end the grace period'),
  })

  const previous = Array.isArray(data?.previousKeys) ? data!.previousKeys : []

  return (
    <section className="rounded-2xl border bg-card p-4 space-y-4" aria-label="Key rotation">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">Key rotation</h3>
        <p className="text-xs text-muted-foreground">
          Rotate without breaking the web app: the new key works at once and the old one keeps working for the grace
          period, so you can update FREELLM_KEY first. The old key keeps the same limits and counts towards the same numbers.
        </p>
      </div>

      {canEdit && (
        <div className="flex flex-wrap items-center gap-3">
          <SegmentedControl ariaLabel="Grace period" value={grace} onValueChange={setGrace} options={[...GRACE]} />
          <ConfirmButton
            onConfirm={() => rotate.mutate()}
            disabled={rotate.isPending}
            variant="outline"
            size="sm"
            armedSize="sm"
            confirmLabel="Confirm rotation"
            className="h-8 text-xs"
          >
            <KeyRound className="size-3.5 mr-1" />
            Rotate key
          </ConfirmButton>
        </div>
      )}

      {fresh && (
        <div role="status" className="rounded-xl border border-primary/30 bg-primary/5 p-3 space-y-2">
          <p className="text-xs font-medium">New key: copy it now, it is not shown again.</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 break-all rounded-lg border bg-background/80 px-3 py-1.5 font-mono text-xs select-all" data-testid="new-key">{fresh.key}</code>
            <CopyButton text={fresh.key} label="Copy new key" className="h-8 w-8" />
          </div>
          <p className="text-xs text-muted-foreground">The old key keeps working until {when(fresh.previousKeyExpiresAt)}.</p>
        </div>
      )}

      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">Old keys still working</p>
        {previous.length === 0 ? (
          <p className="text-xs text-muted-foreground">None. Only the current key works.</p>
        ) : (
          <>
            <ul className="divide-y rounded-xl border" aria-label="Old keys still working">
              {previous.map(k => (
                <li key={k.expiresAt + k.keyHint} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs">
                  <code className="font-mono">{k.keyHint}</code>
                  <span className="text-muted-foreground">works until {when(k.expiresAt)}</span>
                </li>
              ))}
            </ul>
            {canEdit && (
              <ConfirmButton
                onConfirm={() => end.mutate()}
                disabled={end.isPending}
                variant="ghost"
                size="sm"
                armedSize="sm"
                confirmLabel="Confirm: stop old keys now"
                className="h-8 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
              >
                End grace period now
              </ConfirmButton>
            )}
          </>
        )}
      </div>
    </section>
  )
}
