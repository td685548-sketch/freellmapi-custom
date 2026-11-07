import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, Trash2, Zap } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { ConfirmButton } from '@/components/confirm-button'
import type { QuickAnswer, QuickAnswerSettings } from '../../../shared/quick-answers'
import { QUICK_ANSWER_LIMITS as L } from '../../../shared/quick-answers'

interface State { settings: QuickAnswerSettings; answers: QuickAnswer[] }
interface Form { id: number | null; questions: string; answer: string }
const EMPTY: Form = { id: null, questions: '', answer: '' }

/**
 * Ready answers of a client key: questions visitors ask again and again, answered at once without an AI
 * call when the visitor's message matches closely enough (accents and punctuation ignored).
 */
export function QuickAnswersCard({ profileId, canEdit }: { profileId: number; canEdit: boolean }) {
  const queryClient = useQueryClient()
  const key = ['quick-answers', profileId]
  const base = `/api/client-profiles/${profileId}/quick-answers`
  const { data } = useQuery<State>({ queryKey: key, queryFn: () => apiFetch(base) })
  const refresh = () => queryClient.invalidateQueries({ queryKey: key })
  const [form, setForm] = useState<Form>(EMPTY)
  const [threshold, setThreshold] = useState<string | null>(null)
  const [probe, setProbe] = useState('')
  const [match, setMatch] = useState<{ id: number; answer: string; similarity: number } | null | undefined>(undefined)

  const saveSettings = useMutation({
    mutationFn: (body: Partial<QuickAnswerSettings>) => apiFetch(`/api/client-profiles/${profileId}/quick-answer-settings`, { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => { setThreshold(null); void refresh() },
    onError: (err: Error) => toast.error(err.message || 'Could not save'),
  })
  const questions = form.questions.split('\n').map(q => q.trim()).filter(Boolean)
  const saveAnswer = useMutation({
    mutationFn: () => apiFetch(form.id ? `${base}/${form.id}` : base, { method: form.id ? 'PUT' : 'POST', body: JSON.stringify({ questions, answer: form.answer.trim() }) }),
    onSuccess: () => { toast.success(form.id ? 'Answer updated' : 'Answer added'); setForm(EMPTY); void refresh() },
    onError: (err: Error) => toast.error(err.message || 'Could not save the answer'),
  })
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) => apiFetch(`${base}/${id}`, { method: 'PUT', body: JSON.stringify({ enabled }) }),
    onSuccess: () => void refresh(),
  })
  const remove = useMutation({
    mutationFn: (id: number) => apiFetch(`${base}/${id}`, { method: 'DELETE' }),
    onSuccess: () => void refresh(),
    onError: (err: Error) => toast.error(err.message || 'Could not delete'),
  })
  const test = useMutation({
    mutationFn: () => apiFetch<{ match: { id: number; answer: string; similarity: number } | null }>(`${base}/match?message=${encodeURIComponent(probe)}`),
    onSuccess: (r) => setMatch(r.match),
  })

  if (!data?.settings || !Array.isArray(data.answers)) return null
  const { settings, answers } = data
  const thresholdText = threshold ?? String(settings.minSimilarity)
  const thresholdNum = Number(thresholdText)
  const thresholdValid = Number.isInteger(thresholdNum) && thresholdNum >= L.minMinSimilarity && thresholdNum <= L.maxMinSimilarity
  const formValid = questions.length > 0 && questions.length <= L.maxQuestions && questions.every(q => q.length <= L.maxQuestionChars)
    && form.answer.trim().length > 0 && form.answer.length <= L.maxAnswerChars

  return (
    <section className="rounded-2xl border bg-card p-4 space-y-4" aria-label="Ready answers">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5"><Zap className="size-4" /><h3 className="text-sm font-semibold">Ready answers</h3></div>
        <label className="inline-flex items-center gap-2 text-xs">
          <Switch size="sm" checked={settings.enabled} disabled={!canEdit} onCheckedChange={(enabled) => saveSettings.mutate({ enabled })} aria-label="Use ready answers" />
          {settings.enabled ? 'On' : 'Off'}
        </label>
      </div>
      <p className="text-xs text-muted-foreground">
        For questions visitors ask again and again. When the visitor&apos;s latest message matches one of the questions closely enough (accents, case and
        punctuation ignored), the answer is sent at once in the web app&apos;s format, without an AI call or provider quota. The response carries <code>X-Quick-Answer</code>.
      </p>

      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <label htmlFor="qa-threshold" className="block text-[11px] text-muted-foreground">Match at least (%)</label>
          <Input id="qa-threshold" inputMode="numeric" value={thresholdText} disabled={!canEdit} onChange={(e) => setThreshold(e.target.value)} className="h-8 w-24 text-xs" />
        </div>
        {canEdit && threshold !== null && <Button size="sm" className="h-8 text-xs" disabled={!thresholdValid || saveSettings.isPending} onClick={() => saveSettings.mutate({ minSimilarity: thresholdNum })}>Save</Button>}
        {!thresholdValid && <span className="text-xs text-destructive">{L.minMinSimilarity}–{L.maxMinSimilarity}</span>}
      </div>

      {answers.length === 0 ? <p className="text-xs text-muted-foreground">No ready answers yet.</p> : (
        <ul className="divide-y rounded-xl border" aria-label="Answers">
          {answers.map(a => (
            <li key={a.id} className={`space-y-1 px-3 py-2 text-xs ${a.enabled ? '' : 'opacity-60'}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">{a.questions.join(' · ')}</span>
                <span className="flex items-center gap-2">
                  <span className="text-muted-foreground">{a.hits.toLocaleString()} use{a.hits === 1 ? '' : 's'}</span>
                  {canEdit && (
                    <>
                      <Switch size="sm" checked={a.enabled} onCheckedChange={(enabled) => toggle.mutate({ id: a.id, enabled })} aria-label={`Use answer ${a.id}`} />
                      <Button variant="ghost" size="icon" className="size-7" aria-label={`Edit answer ${a.id}`} onClick={() => setForm({ id: a.id, questions: a.questions.join('\n'), answer: a.answer })}><Pencil className="size-3.5" /></Button>
                      <ConfirmButton onConfirm={() => remove.mutate(a.id)} size="icon-xs" armedSize="xs" aria-label={`Delete answer ${a.id}`} armedClassName="text-destructive"><Trash2 className="size-3.5" /></ConfirmButton>
                    </>
                  )}
                </span>
              </div>
              <p className="whitespace-pre-wrap text-muted-foreground">{a.answer}</p>
            </li>
          ))}
        </ul>
      )}

      {canEdit && (
        <form className="space-y-2 border-t pt-3" onSubmit={(e) => { e.preventDefault(); if (formValid && !saveAnswer.isPending) saveAnswer.mutate() }}>
          <p className="text-xs font-medium text-muted-foreground">{form.id ? 'Edit answer' : `Add an answer (${answers.length}/${L.maxAnswers})`}</p>
          <Textarea value={form.questions} onChange={(e) => setForm(f => ({ ...f, questions: e.target.value }))} rows={2} placeholder={'How visitors ask it, one per line\nPhí ship bao nhiêu?'} aria-label="Questions" className="text-xs" />
          <Textarea value={form.answer} onChange={(e) => setForm(f => ({ ...f, answer: e.target.value }))} rows={3} placeholder="The answer to send" aria-label="Answer" className="text-xs" />
          <div className="flex gap-2">
            <Button type="submit" size="sm" className="h-8 text-xs" disabled={!formValid || saveAnswer.isPending || (!form.id && answers.length >= L.maxAnswers)}>{form.id ? 'Save changes' : 'Add'}</Button>
            {form.id && <Button type="button" variant="ghost" size="sm" className="h-8 text-xs" onClick={() => setForm(EMPTY)}>Cancel</Button>}
          </div>
        </form>
      )}

      <form className="space-y-2 border-t pt-3" onSubmit={(e) => { e.preventDefault(); if (probe.trim()) test.mutate() }}>
        <p className="text-xs font-medium text-muted-foreground">Try a message</p>
        <div className="flex gap-2">
          <Input value={probe} onChange={(e) => setProbe(e.target.value)} placeholder="What a visitor might type…" aria-label="Test message" className="h-8 text-xs" />
          <Button type="submit" variant="outline" size="sm" className="h-8 text-xs" disabled={!probe.trim() || test.isPending}>Check</Button>
        </div>
        {match !== undefined && (
          <p role="status" className="text-xs">
            {match ? <>Answered at once ({match.similarity}% match): <span className="text-muted-foreground">{match.answer}</span></> : 'No ready answer matches: the AI would answer.'}
          </p>
        )}
      </form>
    </section>
  )
}
