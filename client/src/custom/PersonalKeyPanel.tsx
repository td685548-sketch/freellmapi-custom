import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/copy-button'
import { toast } from '@/lib/toast'
import type { UserApiKey } from '../../../shared/user-access'

/** Personal gateway keys for accounts that cannot reveal the shared gateway key.
 *  Secrets are stored hashed, so the full key is only ever visible right after it
 *  is generated; afterwards only the prefix can be listed. */
export function PersonalKeyPanel() {
  const queryClient = useQueryClient()
  const [created, setCreated] = useState<string | null>(null)
  const { data, isLoading } = useQuery<{ keys: UserApiKey[] }>({
    queryKey: ['user-api-keys'],
    queryFn: () => apiFetch<{ keys: UserApiKey[] }>('/api/user/keys'),
  })
  const mint = useMutation({
    mutationFn: () => apiFetch<{ key: { key: string } }>('/api/user/keys', {
      method: 'POST',
      body: JSON.stringify({ name: 'Agent key' }),
    }),
    onSuccess: (res) => {
      setCreated(res.key.key)
      queryClient.invalidateQueries({ queryKey: ['user-api-keys'] })
    },
    onError: (err: unknown) => toast.error(err instanceof Error ? err.message : 'Failed to generate key'),
  })
  const active = (data?.keys ?? []).filter(key => !key.revoked)

  return (
    <div className="mt-3 space-y-2 text-xs">
      <p className="text-muted-foreground">
        Your account uses its own personal API key. Use it as <code className="font-mono">API_KEY</code> in the
        commands below. A key is shown in full only once, when it is generated.
      </p>
      {created && (
        <div className="flex items-center gap-2 rounded-xl border border-primary/30 bg-primary/5 px-3 py-2">
          <code className="min-w-0 flex-1 break-all font-mono select-all">{created}</code>
          <CopyButton text={created} label="Copy API key" className="size-7 shrink-0" />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
        {isLoading ? <span>Loading keys…</span> : active.length === 0
          ? <span>You have no active key yet.</span>
          : active.map(key => <code key={key.id} className="font-mono">{key.name}: {key.keyPrefix}••••••••</code>)}
        <Button size="sm" variant="outline" disabled={mint.isPending} onClick={() => mint.mutate()}>
          {mint.isPending ? 'Generating…' : active.length === 0 ? 'Generate my API key' : 'Generate another key'}
        </Button>
      </div>
    </div>
  )
}
