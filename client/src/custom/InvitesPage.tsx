import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2, Ticket, CheckCircle2 } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PageHeader } from '@/components/page-header'
import { CopyButton } from '@/components/copy-button'
import { toast } from '@/lib/toast'

import type { InviteCode } from '../../../shared/user-access'
import { useCustomT } from './i18n/use-custom-t'
import { askConfirm } from '@/custom/x-gateway/shell/confirm'
export type { InviteCode } from '../../../shared/user-access'

export function InvitesPage({ capabilities }: { capabilities?: { view: boolean; create: boolean; revoke: boolean } } = {}) {
  const tc = useCustomT()
  const can = (action: 'view' | 'create' | 'revoke') => capabilities?.[action] !== false
  const queryClient = useQueryClient()
  const [createOpen, setCreateOpen] = useState(false)
  const [code, setCode] = useState('')
  const [maxUses, setMaxUses] = useState('1')
  const [expiresInDays, setExpiresInDays] = useState('7')
  const [note, setNote] = useState('')
  const [createdInvite, setCreatedInvite] = useState<InviteCode | null>(null)

  const { data, isLoading } = useQuery<{ invites: InviteCode[] }>({
    queryKey: ['invites'],
    queryFn: () => apiFetch<{ invites: InviteCode[] }>('/api/invites'),
    enabled: can('view'),
  })

  const invites = can('view') ? data?.invites ?? [] : []

  const createInviteMutation = useMutation({
    mutationFn: (payload: { code?: string; maxUses?: number; expiresInDays?: number | null; note?: string }) =>
      apiFetch<{ invite: InviteCode }>('/api/invites', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['invites'] })
      setCreatedInvite(res.invite)
      setCreateOpen(false)
      setCode('')
      setNote('')
      setMaxUses('1')
      toast.success(tc('Invite code created successfully'))
    },
    onError: (err: Error) => {
      toast.error(err.message || tc('Failed to create invite code'))
    },
  })

  const revokeInviteMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch<{ success: boolean }>(`/api/invites/${id}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invites'] })
      toast.success(tc('Invite code revoked'))
    },
    onError: (err: Error) => {
      toast.error(err.message || tc('Failed to revoke invite code'))
    },
  })

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault()
    const uses = parseInt(maxUses, 10)
    const days = expiresInDays === 'never' ? null : parseInt(expiresInDays, 10)

    createInviteMutation.mutate({
      code: code.trim() || undefined,
      maxUses: Number.isFinite(uses) && uses > 0 ? uses : 1,
      expiresInDays: days && Number.isFinite(days) && days > 0 ? days : null,
      note: note.trim() || undefined,
    })
  }

  const handleRevoke = async (id: number, codeName: string) => {
    if (await askConfirm(tc('Revoke invite code "{codeName}"? It will no longer allow any new registrations.', { codeName }))) {
      revokeInviteMutation.mutate(id)
    }
  }

  const getInviteLink = (c: string) => {
    const origin = typeof window !== 'undefined' ? window.location.origin : ''
    return `${origin}/?invite=${encodeURIComponent(c)}`
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title={tc('Invite Codes')}
        description={tc('Generate and manage invitation codes to grant members access to your FreeLLMAPI instance.')}
        actions={
          <Button disabled={!can('create')} onClick={() => { setCreatedInvite(null); setCreateOpen(true) }}>
            <Plus className="mr-1.5 size-4" />{tc('Create Invite Code')}</Button>
        }
      />

      {/* Newly created invite alert */}
      {createdInvite && (
        <div className="rounded-2xl border border-primary/30 bg-primary/5 p-5 shadow-sm space-y-3">
          <div className="flex items-center gap-2 text-primary font-medium text-sm">
            <CheckCircle2 className="size-4" />
            <span>{tc('Invite Code Generated!')}</span>
          </div>
          <p className="text-xs text-muted-foreground">{tc('Share this registration link with your team member. They will be able to sign up and receive their personal API key.')}</p>
          <div className="flex items-center gap-2">
            <div className="flex-1 font-mono text-xs bg-background/80 border rounded-lg px-3 py-2 text-foreground truncate select-all">
              {getInviteLink(createdInvite.code)}
            </div>
            <CopyButton text={getInviteLink(createdInvite.code)} label={tc('Copy Invite Link')} className="h-9 px-3" />
          </div>
        </div>
      )}

      {/* Invites list */}
      <div className="rounded-2xl border bg-card overflow-hidden">
        <div className="border-b px-5 py-3.5 flex items-center justify-between">
          <h2 className="text-sm font-semibold">{tc('Active & Historic Invites (')}{invites.length})</h2>
        </div>

        {isLoading ? (
          <div className="p-8 text-center text-sm text-muted-foreground">{tc('Loading invite codes…')}</div>
        ) : invites.length === 0 ? (
          <div className="p-8 text-center space-y-2">
            <Ticket className="size-8 mx-auto text-muted-foreground opacity-50" />
            <p className="text-sm font-medium">{tc('No invite codes generated yet')}</p>
            <p className="text-xs text-muted-foreground">{tc('Click "Create Invite Code" to generate your first invitation for a user.')}</p>
          </div>
        ) : (
          <div className="divide-y">
            {invites.map((inv) => {
              const isRevoked = inv.status === 'revoked'
              const isExpired = inv.status === 'expired'
              const isExhausted = inv.status === 'exhausted'
              const isActive = inv.status === 'active'

              return (
                <div key={inv.id} className="p-4 flex flex-wrap sm:flex-nowrap items-center justify-between gap-4 hover:bg-muted/30 transition-colors">
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm font-semibold text-foreground tracking-wide">{inv.code}</span>
                      <CopyButton text={inv.code} label={tc('Copy code')} className="size-6 p-0 border-none bg-transparent" />
                      
                      {isActive && (
                        <span className="text-[10px] bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-medium px-2 py-0.5 rounded-full border border-emerald-500/20">{tc('Active')}</span>
                      )}
                      {isExhausted && (
                        <span className="text-[10px] bg-amber-500/10 text-amber-600 dark:text-amber-400 font-medium px-2 py-0.5 rounded-full border border-amber-500/20">{tc('Exhausted')}</span>
                      )}
                      {isExpired && (
                        <span className="text-[10px] bg-muted text-muted-foreground font-medium px-2 py-0.5 rounded-full">{tc('Expired')}</span>
                      )}
                      {isRevoked && (
                        <span className="text-[10px] bg-destructive/10 text-destructive font-medium px-2 py-0.5 rounded-full border border-destructive/20">{tc('Revoked')}</span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
                      <span>{tc('Uses:')}{' '}<strong>{inv.usedCount}</strong> / {inv.maxUses}</span>
                      <span>{tc('Expires:')}{' '}{inv.expiresAtMs !== null ? new Date(inv.expiresAtMs).toLocaleDateString() : tc('Never')}</span>
                      {inv.note && <span>{tc('Note:')}{' '}<em>{inv.note}</em></span>}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {isActive && (
                      <CopyButton
                        text={getInviteLink(inv.code)}
                        label={tc('Copy Link')}
                        className="h-8 px-2.5 text-xs gap-1.5"
                      />
                    )}
                    {isActive && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!can('revoke')} onClick={() => handleRevoke(inv.id, inv.code)}
                        className="text-destructive hover:bg-destructive/10 hover:text-destructive text-xs h-8"
                      >
                        <Trash2 className="size-3.5 mr-1" />{tc('Revoke')}</Button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Create Invite Modal Dialog */}
      {createOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-3xl border bg-card p-6 shadow-xl space-y-4">
            <h3 className="text-base font-semibold">{tc('Generate Invite Code')}</h3>
            <p className="text-xs text-muted-foreground">{tc('Configure parameters for the new invitation code.')}</p>
            <form onSubmit={handleCreate} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="invite-code-custom" className="text-xs">{tc('Custom Code (optional)')}</Label>
                <Input
                  id="invite-code-custom"
                  type="text"
                  placeholder={tc('e.g. TEAM-BETA (leave blank to auto-generate)')}
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                  autoFocus
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="invite-max-uses" className="text-xs">{tc('Max Uses')}</Label>
                  <Input
                    id="invite-max-uses"
                    type="number"
                    min="1"
                    max="1000"
                    value={maxUses}
                    onChange={(e) => setMaxUses(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="invite-expires" className="text-xs">{tc('Expires In (Days)')}</Label>
                  <select
                    id="invite-expires"
                    value={expiresInDays}
                    onChange={(e) => setExpiresInDays(e.target.value)}
                    className="w-full h-9 rounded-md border border-input bg-transparent px-3 py-1 text-xs shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <option value="1">{tc('1 Day')}</option>
                    <option value="7">{tc('7 Days')}</option>
                    <option value="30">{tc('30 Days')}</option>
                    <option value="never">{tc('Never')}</option>
                  </select>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="invite-note" className="text-xs">{tc('Note / Memo (optional)')}</Label>
                <Input
                  id="invite-note"
                  type="text"
                  placeholder={tc('e.g. For marketing team members')}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="ghost" onClick={() => setCreateOpen(false)}>{tc('Cancel')}</Button>
                <Button type="submit" disabled={createInviteMutation.isPending}>
                  {createInviteMutation.isPending ? tc('Creating…') : tc('Create')}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

export default InvitesPage
