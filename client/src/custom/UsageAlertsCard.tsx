import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BellRing } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface AlertSettings { webhookUrl: string; email: string; emailAvailable: boolean }
interface Delivery { webhook: { sent: boolean; status: number | null } | null; email: { sent: boolean } | null }

const validUrl = (v: string) => {
  if (v.trim() === '') return true
  try { const u = new URL(v.trim()); return u.protocol === 'https:' || u.protocol === 'http:' } catch { return false }
}
const validEmail = (v: string) => v.trim() === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())

function describe(d: Delivery): string {
  const parts = ['Written to the Logs page']
  if (d.webhook) parts.push(d.webhook.sent ? `webhook answered ${d.webhook.status}` : `webhook failed${d.webhook.status ? ` (${d.webhook.status})` : ' (no answer)'}`)
  if (d.email) parts.push(d.email.sent ? 'email sent' : 'email failed')
  return parts.join(' · ')
}

/**
 * Where usage alerts go: always the Logs page, plus an optional webhook (Slack / Discord incoming webhooks
 * work as they are) and an optional email through the configured Gmail sender.
 */
export function UsageAlertsCard({ canEdit }: { canEdit: boolean }) {
  const queryClient = useQueryClient()
  const key = ['usage-alert-settings']
  const { data } = useQuery<AlertSettings>({ queryKey: key, queryFn: () => apiFetch('/api/settings/usage-alerts') })
  const [draft, setDraft] = useState<{ webhookUrl?: string; email?: string }>({})
  const [result, setResult] = useState<Delivery | null>(null)

  const save = useMutation({
    mutationFn: (body: { webhookUrl: string; email: string }) => apiFetch<AlertSettings>('/api/settings/usage-alerts', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: (s) => { queryClient.setQueryData(key, s); setDraft({}); toast.success('Alert destinations saved') },
    onError: (err: Error) => toast.error(err.message || 'Could not save'),
  })
  const test = useMutation({
    mutationFn: () => apiFetch<{ delivery: Delivery }>('/api/settings/usage-alerts/test', { method: 'POST', body: '{}' }),
    onSuccess: (r) => setResult(r.delivery),
    onError: (err: Error) => toast.error(err.message || 'Could not send the test'),
  })

  if (!data || typeof data.webhookUrl !== 'string') return null
  const webhookUrl = draft.webhookUrl ?? data.webhookUrl
  const email = draft.email ?? data.email
  const valid = validUrl(webhookUrl) && validEmail(email)
  const dirty = webhookUrl.trim() !== data.webhookUrl || email.trim() !== data.email

  return (
    <section className="rounded-2xl border bg-card p-4 space-y-3" aria-label="Usage alerts">
      <div className="flex items-center gap-1.5">
        <BellRing className="size-4" />
        <h2 className="text-sm font-semibold">Alerts</h2>
      </div>
      <p className="text-xs text-muted-foreground">
        Sent when an account or client key reaches 80% and 100% of a daily or monthly allowance (once per window), and when at
        least half of its requests fail over 15 minutes (at most once an hour). Every alert is written to the Logs page.
      </p>
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => { e.preventDefault(); if (canEdit && valid && dirty) save.mutate({ webhookUrl: webhookUrl.trim(), email: email.trim() }) }}
      >
        <div className="space-y-1">
          <label htmlFor="alert-webhook" className="block text-xs font-medium text-muted-foreground">Webhook URL</label>
          <Input id="alert-webhook" value={webhookUrl} disabled={!canEdit} placeholder="https://hooks.slack.com/services/…" onChange={(e) => setDraft(d => ({ ...d, webhookUrl: e.target.value }))} className="h-8 text-xs" />
          <p className="text-[11px] text-muted-foreground">Receives a JSON POST; the message is also in <code>text</code> and <code>content</code>, so Slack and Discord show it as is.</p>
        </div>
        <div className="space-y-1">
          <label htmlFor="alert-email" className="block text-xs font-medium text-muted-foreground">Email</label>
          <Input id="alert-email" type="email" value={email} disabled={!canEdit} placeholder="ops@example.com" onChange={(e) => setDraft(d => ({ ...d, email: e.target.value }))} className="h-8 text-xs" />
          <p className="text-[11px] text-muted-foreground">
            {data.emailAvailable ? 'Sent through the configured Gmail sender.' : 'No Gmail sender is configured, so emails are not sent; the log and the webhook still work.'}
          </p>
        </div>
        {canEdit && (
          <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
            <Button type="submit" size="sm" className="h-8 text-xs" disabled={!valid || !dirty || save.isPending}>Save</Button>
            <Button type="button" variant="outline" size="sm" className="h-8 text-xs" disabled={dirty || test.isPending} onClick={() => test.mutate()} title={dirty ? 'Save first' : undefined}>
              {test.isPending ? 'Sending…' : 'Send test alert'}
            </Button>
            {!valid && <span className="text-xs text-destructive">Use an http(s) address and a valid email, or leave them empty.</span>}
            {result && <span role="status" className="text-xs text-muted-foreground">{describe(result)}</span>}
          </div>
        )}
      </form>
    </section>
  )
}
