import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MessagesSquare, Trash2 } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { ConfirmButton } from '@/components/confirm-button'
import type { ConversationSettings, StoredConversation, StoredMessage } from '../../../shared/conversations'
import { CONVERSATION_LIMITS as L } from '../../../shared/conversations'
import { useCustomT } from './i18n/use-custom-t'

interface ConvState { settings: ConversationSettings; conversations: StoredConversation[] }
type NumberField = 'ttlHours' | 'maxMessages' | 'maxChars'

const FIELDS: Array<{ key: NumberField; label: string; min: number; max: number }> = [
  { key: 'ttlHours', label: 'Delete after (hours unused)', min: L.minTtlHours, max: L.maxTtlHours },
  { key: 'maxMessages', label: 'Earlier messages sent', min: L.minMaxMessages, max: L.maxMaxMessages },
  { key: 'maxChars', label: 'Characters of history sent', min: L.minMaxChars, max: L.maxMaxChars },
]

const EXAMPLE = `// Your backend sends only the new message; the server adds the earlier turns.
await fetch(BASE_URL + "/chat/completions", {
  method: "POST",
  headers: {
    Authorization: \`Bearer \${process.env.FREELLM_KEY}\`,
    "Content-Type": "application/json",
    "X-Conversation-Id": chatId,      // your id for this chat
    "X-End-User": String(visitorId),  // optional: ties the chat to this visitor
  },
  body: JSON.stringify({ model: "auto", messages: [
    { role: "system", content: "You are the assistant of my website." },
    { role: "user", content: newMessage },
  ] }),
})
// Erase a visitor's chats: DELETE BASE_URL + "/stored-conversations?end_user=" + visitorId`

const when = (iso: string) => new Date(iso).toLocaleString()

/**
 * Conversations kept on the server for a client key (X-Conversation-Id): the switch and limits, the
 * live conversations, their messages (edit permission) and erasing them per conversation or end user.
 */
export function ConversationsCard({ profileId, canEdit }: { profileId: number; canEdit: boolean }) {
  const tc = useCustomT()
  const queryClient = useQueryClient()
  const [endUser, setEndUser] = useState('')
  const [filter, setFilter] = useState('')
  const [draft, setDraft] = useState<Partial<Record<NumberField, string>>>({})
  const [open, setOpen] = useState<string | null>(null)
  const base = `/api/client-profiles/${profileId}`
  const key = ['conversations', profileId, filter]
  const { data } = useQuery<ConvState>({
    queryKey: key,
    queryFn: () => apiFetch(`${base}/conversations${filter ? `?endUser=${encodeURIComponent(filter)}` : ''}`),
  })
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['conversations', profileId] })
  const messages = useQuery<{ messages: StoredMessage[]; conversation?: { summary?: string | null } }>({
    queryKey: ['conversation', profileId, open],
    queryFn: () => apiFetch(`${base}/conversations/${encodeURIComponent(open!)}`),
    enabled: canEdit && open !== null,
  })

  const save = useMutation({
    mutationFn: (body: Partial<ConversationSettings>) => apiFetch(`${base}/conversation-settings`, { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => { setDraft({}); void refresh() },
    onError: (err: Error) => toast.error(err.message || tc('Could not save')),
  })
  const remove = useMutation({
    mutationFn: (path: string) => apiFetch<{ deleted: number }>(`${base}/conversations${path}`, { method: 'DELETE' }),
    onSuccess: (r) => { toast.success(tc('Deleted {deleted} conversation{v}', { deleted: r.deleted, v: r.deleted === 1 ? '' : 's' })); setOpen(null); void refresh() },
    onError: (err: Error) => toast.error(err.message || tc('Could not delete')),
  })

  if (!data?.settings || !Array.isArray(data.conversations)) return null
  const { settings, conversations } = data
  const parsed = Object.fromEntries(FIELDS.map(f => [f.key, Number(draft[f.key] ?? settings[f.key])])) as Record<NumberField, number>
  const valid = FIELDS.every(f => Number.isInteger(parsed[f.key]) && parsed[f.key] >= f.min && parsed[f.key] <= f.max)
  const dirty = FIELDS.some(f => draft[f.key] !== undefined && parsed[f.key] !== settings[f.key])

  return (
    <section className="rounded-2xl border bg-card p-4 space-y-4" aria-label="Stored conversations">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5"><MessagesSquare className="size-4" /><h3 className="text-sm font-semibold">{tc('Stored conversations')}</h3></div>
        <label className="inline-flex items-center gap-2 text-xs">
          <Switch size="sm" checked={settings.enabled} disabled={!canEdit} onCheckedChange={(enabled) => save.mutate({ enabled })} aria-label="Keep conversations on the server" />
          {settings.enabled ? tc('On') : tc('Off')}
        </label>
      </div>
      <p className="text-xs text-muted-foreground">{tc('Your backend sends an')}{' '}<code>{tc('X-Conversation-Id')}</code>{' '}{tc('header with only the new message; the earlier turns are added here, within the limits below. A turn is kept once the reply has finished. Works on')}{' '}<code>{tc('/v1/chat/completions')}</code>{' '}{tc('and')}{' '}<code>{tc('/v1/messages')}</code>{tc(', plain text only.')}</p>

      <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (canEdit && valid && dirty) save.mutate(parsed) }}>
        {FIELDS.map(f => (
          <div key={f.key} className="space-y-1">
            <label htmlFor={`conv-${f.key}`} className="block text-[11px] text-muted-foreground">{tc(f.label)}</label>
            <Input id={`conv-${f.key}`} inputMode="numeric" value={draft[f.key] ?? String(settings[f.key])} disabled={!canEdit}
              onChange={(e) => setDraft(d => ({ ...d, [f.key]: e.target.value }))} className="h-8 w-36 text-xs" />
          </div>
        ))}
        {canEdit && dirty && <Button type="submit" size="sm" className="h-8 text-xs" disabled={!valid || save.isPending}>{tc('Save')}</Button>}
        {!valid && <span className="text-xs text-destructive">{FIELDS.map(f => `${f.min.toLocaleString()}–${f.max.toLocaleString()}`).join(' · ')}</span>}
      </form>

      <label className="flex items-start gap-2 text-xs">
        <Switch size="sm" checked={settings.summarize} disabled={!canEdit} onCheckedChange={(summarize) => save.mutate({ summarize })} aria-label="Summarize older turns" className="mt-0.5" />
        <span>
          <span className="font-medium">{tc('Summarize older turns')}</span>
          <span className="block text-muted-foreground">{tc('Turns that no longer fit the limits are folded into a short summary sent ahead of the history, so the assistant still remembers them. Each summary is one extra request with this key and counts against its limits.')}</span>
        </span>
      </label>

      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground">{tc('Example for your backend')}</summary>
        <pre className="mt-2 overflow-x-auto rounded-lg bg-muted/50 p-3 text-[11px] leading-relaxed">{EXAMPLE}</pre>
      </details>

      <div className="space-y-2 border-t pt-3">
        <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); setFilter(endUser.trim()); setOpen(null) }}>
          <Input value={endUser} onChange={(e) => setEndUser(e.target.value)} placeholder={tc('End user id')} aria-label="Filter by end user" className="h-8 w-48 text-xs" />
          <Button type="submit" variant="outline" size="sm" className="h-8 text-xs">{tc('Filter')}</Button>
          {filter && <Button type="button" variant="ghost" size="sm" className="h-8 text-xs" onClick={() => { setEndUser(''); setFilter('') }}>{tc('Clear')}</Button>}
          {canEdit && filter && (
            <ConfirmButton onConfirm={() => remove.mutate(`?endUser=${encodeURIComponent(filter)}`)} size="xs" armedSize="xs" armedClassName="text-destructive" aria-label={`Delete every conversation of ${filter}`}>{tc('Delete all of')}{' '}{filter}
            </ConfirmButton>
          )}
        </form>

        {conversations.length === 0 ? <p className="text-xs text-muted-foreground">{tc('No stored conversations')}{filter ? tc(' for {filter}', { filter: filter }) : ''}.</p> : (
          <ul className="divide-y rounded-xl border" aria-label="Conversations">
            {conversations.map(c => (
              <li key={c.id} className="px-3 py-2 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  {canEdit
                    ? <button type="button" className="font-mono font-medium underline-offset-2 hover:underline" onClick={() => setOpen(open === c.id ? null : c.id)} aria-expanded={open === c.id}>{c.id}</button>
                    : <span className="font-mono font-medium">{c.id}</span>}
                  <span className="text-muted-foreground">
                    {c.endUser ?? tc('no end user')} · {c.messages}{' '}{tc('message')}{c.messages === 1 ? '' : 's'}{' '}{tc('· last')}{' '}{when(c.updatedAt)}{' '}{tc('· deleted')}{' '}{when(c.expiresAt)}
                  </span>
                  {canEdit && (
                    <ConfirmButton onConfirm={() => remove.mutate(`/${encodeURIComponent(c.id)}`)} size="icon-xs" armedSize="xs" aria-label={`Delete ${c.id}`} armedClassName="text-destructive"><Trash2 className="size-3.5" /></ConfirmButton>
                  )}
                </div>
                {open === c.id && messages.data?.conversation?.summary && (
                  <p className="mt-2 rounded-lg border border-dashed p-2 whitespace-pre-wrap" aria-label={`Summary of ${c.id}`}>
                    <strong>{tc('Summary of earlier turns:')}</strong> {messages.data.conversation.summary}
                  </p>
                )}
                {open === c.id && (
                  <ol className="mt-2 space-y-1" aria-label={`Messages of ${c.id}`}>
                    {(messages.data?.messages ?? []).map((m, i) => (
                      <li key={i} className={`rounded-lg p-2 ${m.role === 'user' ? 'bg-muted/40' : 'bg-primary/5'}`}>
                        <strong>{m.role === 'user' ? tc('User') : tc('Assistant')}</strong> <span className="text-muted-foreground">{when(m.createdAt)}</span>
                        <p className="mt-1 whitespace-pre-wrap break-words">{m.content}</p>
                      </li>
                    ))}
                  </ol>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
