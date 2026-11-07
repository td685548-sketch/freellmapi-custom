import { useEffect, useRef, useState } from 'react'
import { Send, Trash2 } from 'lucide-react'
import { apiFetch, type ApiError } from '@/lib/api'
import { Markdown } from '@/components/markdown'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { GUEST_TRIAL_LIMITS, type GuestTrialInfo } from '../../../shared/guest-access'
import { askToSignIn } from './guest-prompt'
import { useCustomT } from './i18n/use-custom-t'

// The chat a signed-out visitor may try (POST /api/guest/chat). The conversation lives only in this page:
// nothing is stored on the server, and the last few turns are sent along with each new message.

interface Turn { role: 'user' | 'assistant'; content: string }
interface Answer { reply: string | null; model: string | null; error: string | null; remaining: { hour: number; perHour: number } }

export function GuestTrialPage({ trial }: { trial: GuestTrialInfo }) {
  const tc = useCustomT()
  const [turns, setTurns] = useState<Turn[]>([])
  const [text, setText] = useState('')
  const [model, setModel] = useState(trial.models[0] ?? 'auto')
  const [busy, setBusy] = useState(false)
  const [left, setLeft] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => { end.current?.scrollIntoView?.({ block: 'end' }) }, [turns, busy])

  const tooLong = text.length > trial.maxInputChars
  const send = async () => {
    const content = text.trim()
    if (!content || busy || tooLong) return
    if (left === 0) { setError(tc('You have used the guest messages of this hour. Sign in to keep chatting.')); askToSignIn(); return }
    const next = [...turns, { role: 'user' as const, content }]
    setTurns(next); setText(''); setBusy(true); setError(null)
    try {
      const r = await apiFetch<Answer>('/api/guest/chat', { method: 'POST', body: JSON.stringify({ messages: next.slice(-GUEST_TRIAL_LIMITS.maxTurns), model }) })
      setLeft(r.remaining.hour)
      if (r.reply) setTurns([...next, { role: 'assistant', content: r.reply }])
    } catch (err) {
      const e = err as ApiError
      // Give the message back to the box so the visitor can resend it.
      setTurns(turns); setText(content)
      if (e.status === 429) {
        setLeft(0)
        setError(e.code === 'guest_trial_daily_cap' ? tc("The guest chat has reached today's limit. Sign in to keep chatting.") : tc('You have used the guest messages of this hour. Sign in to keep chatting.'))
        askToSignIn()
      } else if (e.status === 502) setError(tc('The model did not answer. Try again: this message was not counted.'))
      else setError(e.message || tc('The message could not be sent.'))
    } finally { setBusy(false) }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader title={tc('Try the chat')} description={tc('Chat with the models before signing in. Up to {perHour} messages per hour; nothing is saved, and the chat is gone when you leave the page.', { perHour: trial.perIpPerHour })} />
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        {trial.models.length > 1 ? (
          <label className="inline-flex items-center gap-2">
            {tc('Model')}
            <select value={model} onChange={(e) => setModel(e.target.value)} aria-label="Model" className="h-8 rounded-lg border bg-background px-2 text-xs">
              {trial.models.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
        ) : <span>{trial.models[0] ?? tc('Automatic model choice')}</span>}
        <span data-testid="trial-left">{left === null ? tc('{perHour} messages per hour', { perHour: trial.perIpPerHour }) : tc('{left} of {perHour} messages left this hour', { left, perHour: trial.perIpPerHour })}</span>
      </div>

      <div className="min-h-64 space-y-3 rounded-2xl border bg-card p-4" aria-label="Guest chat" aria-live="polite">
        {turns.length === 0 && <p className="text-sm text-muted-foreground">{tc('Ask anything to see how the models answer.')}</p>}
        {turns.map((t, i) => (
          <div key={i} className={t.role === 'user' ? 'ml-auto max-w-[85%] rounded-2xl bg-primary px-3 py-2 text-sm text-primary-foreground whitespace-pre-wrap' : 'max-w-[90%] rounded-2xl bg-muted/60 px-3 py-2'}>
            {t.role === 'user' ? t.content : <Markdown>{t.content}</Markdown>}
          </div>
        ))}
        {busy && <p className="text-sm text-muted-foreground" role="status">{tc('Thinking…')}</p>}
        <div ref={end} />
      </div>

      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void send() }}>
        <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} aria-label="Message" placeholder={tc('Type a message…')}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }} className="text-sm" />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm" disabled={busy || !text.trim() || tooLong || left === 0}><Send className="size-3.5 mr-1" />{tc('Send')}</Button>
          {turns.length > 0 && <Button type="button" variant="ghost" size="sm" onClick={() => { setTurns([]); setError(null) }}><Trash2 className="size-3.5 mr-1" />{tc('Clear chat')}</Button>}
          <span className={`text-xs ${tooLong ? 'text-destructive' : 'text-muted-foreground'}`}>{text.length.toLocaleString()} / {trial.maxInputChars.toLocaleString()}</span>
        </div>
      </form>
    </div>
  )
}
