import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ThumbsDown, ThumbsUp } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { SegmentedControl } from '@/components/ui/segmented-control'
import type { FeedbackComment, FeedbackSummary } from '../../../shared/feedback'
import { useCustomT } from './i18n/use-custom-t'

const RANGES = [{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }] as const

const EXAMPLE = `// When a visitor clicks 👍 or 👎 under a reply (from your backend):
await fetch(BASE_URL + "/feedback", {
  method: "POST",
  headers: { Authorization: \`Bearer \${process.env.FREELLM_KEY}\`, "Content-Type": "application/json" },
  body: JSON.stringify({
    rating: "down",                 // "up" or "down"
    comment: "The price was wrong", // optional
    model: reply.model,             // the "model" of the reply, to compare models
    reference: reply.id,            // a second vote on the same reply replaces the first
    end_user: String(visitorId),    // optional
    conversation_id: chatId,        // optional
  }),
})`

const share = (up: number, down: number) => (up + down > 0 ? Math.round((up / (up + down)) * 100) : null)

function Satisfaction({ up, down }: { up: number; down: number }) {
  const tc = useCustomT()
  const pct = share(up, down)
  return (
    <span className="inline-flex items-center gap-2">
      <span className="inline-flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400"><ThumbsUp className="size-3.5" aria-hidden="true" />{up.toLocaleString()}</span>
      <span className="inline-flex items-center gap-0.5 text-amber-600 dark:text-amber-400"><ThumbsDown className="size-3.5" aria-hidden="true" />{down.toLocaleString()}</span>
      <span className="text-muted-foreground">{pct === null ? tc('no votes') : tc('{pct}% satisfied', { pct: pct })}</span>
    </span>
  )
}

/** What visitors think of a client key's replies: votes over a window, per model, and their comments. */
export function FeedbackCard({ profileId, canReadComments }: { profileId: number; canReadComments: boolean }) {
  const tc = useCustomT()
  const [days, setDays] = useState<'7' | '30' | '90'>('30')
  const base = `/api/client-profiles/${profileId}/feedback`
  const { data } = useQuery<{ summary: FeedbackSummary }>({ queryKey: ['feedback', profileId, days], queryFn: () => apiFetch(`${base}?days=${days}`) })
  const comments = useQuery<{ comments: FeedbackComment[] }>({ queryKey: ['feedback-comments', profileId], queryFn: () => apiFetch(`${base}/comments`), enabled: canReadComments })
  const s = data?.summary
  if (!s || !Array.isArray(s.byModel)) return null

  return (
    <section className="rounded-2xl border bg-card p-4 space-y-4" aria-label="Visitor feedback">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{tc('Visitor feedback')}</h3>
        <SegmentedControl ariaLabel="Feedback range" value={days} onValueChange={setDays} options={RANGES.map(o => ({ ...o, label: tc(o.label) }))} />
      </div>
      <p className="text-xs" data-testid="feedback-total"><Satisfaction up={s.up} down={s.down} /></p>

      {s.byModel.length > 0 && (
        <ul className="divide-y rounded-xl border text-xs" aria-label="Feedback per model">
          {s.byModel.map(m => {
            const pct = share(m.up, m.down)
            return (
              <li key={m.model ?? '—'} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <span className="font-mono">{m.model ?? tc('model not reported')}</span>
                <span className="inline-flex items-center gap-2">
                  <span className="hidden h-1.5 w-20 overflow-hidden rounded-full bg-amber-500/30 sm:inline-block" aria-hidden="true">
                    <span className="block h-full bg-emerald-500" style={{ width: `${pct ?? 0}%` }} />
                  </span>
                  <Satisfaction up={m.up} down={m.down} />
                </span>
              </li>
            )
          })}
        </ul>
      )}

      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground">{tc('How your web app sends a vote')}</summary>
        <pre className="mt-2 overflow-x-auto rounded-lg bg-muted/50 p-3 text-[11px] leading-relaxed">{EXAMPLE}</pre>
      </details>

      {canReadComments && (
        <div className="space-y-2 border-t pt-3">
          <p className="text-xs font-medium text-muted-foreground">{tc('Recent comments')}</p>
          {(comments.data?.comments ?? []).length === 0 ? <p className="text-xs text-muted-foreground">{tc('No comments yet.')}</p> : (
            <ul className="space-y-1.5" aria-label="Comments">
              {comments.data!.comments.map(c => (
                <li key={c.id} className="rounded-lg bg-muted/40 p-2 text-xs">
                  <span className="flex flex-wrap items-center gap-2 text-muted-foreground">
                    {c.rating === 'up' ? <ThumbsUp className="size-3.5 text-emerald-600" aria-label="liked" /> : <ThumbsDown className="size-3.5 text-amber-600" aria-label="disliked" />}
                    {c.endUser ?? tc('no end user')}{c.model ? ` · ${c.model}` : ''}{c.conversationId ? ` · ${c.conversationId}` : ''} · {new Date(c.createdAt).toLocaleString()}
                  </span>
                  <p className="mt-1 whitespace-pre-wrap">{c.comment}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}
