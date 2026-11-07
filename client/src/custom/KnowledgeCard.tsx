import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BookOpen, Pencil, Trash2 } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { ConfirmButton } from '@/components/confirm-button'
import type { KnowledgeDoc, KnowledgeHit, KnowledgeSettings } from '../../../shared/knowledge'
import { KNOWLEDGE_LIMITS as L } from '../../../shared/knowledge'

interface KbState { settings: KnowledgeSettings; docs: KnowledgeDoc[] }

/**
 * A client key's knowledge base: documents (FAQ, policies, product facts) whose passages matching the
 * user's question are added to each chat request as reference material, when switched on.
 */
export function KnowledgeCard({ profileId, canEdit }: { profileId: number; canEdit: boolean }) {
  const queryClient = useQueryClient()
  const key = ['knowledge', profileId]
  const base = `/api/client-profiles/${profileId}/knowledge`
  const { data } = useQuery<KbState>({ queryKey: key, queryFn: () => apiFetch(base) })
  const refresh = () => queryClient.invalidateQueries({ queryKey: key })
  const [form, setForm] = useState<{ id: number | null; title: string; content: string }>({ id: null, title: '', content: '' })
  const [budget, setBudget] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<KnowledgeHit[] | null>(null)

  const saveSettings = useMutation({
    mutationFn: (body: Partial<KnowledgeSettings>) => apiFetch(`/api/client-profiles/${profileId}/knowledge-settings`, { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => { setBudget(null); void refresh() },
    onError: (err: Error) => toast.error(err.message || 'Could not save'),
  })
  const saveDoc = useMutation({
    mutationFn: () => apiFetch(form.id ? `${base}/${form.id}` : base, { method: form.id ? 'PUT' : 'POST', body: JSON.stringify({ title: form.title.trim(), content: form.content.trim() }) }),
    onSuccess: () => { toast.success(form.id ? 'Document updated' : 'Document added'); setForm({ id: null, title: '', content: '' }); void refresh() },
    onError: (err: Error) => toast.error(err.message || 'Could not save the document'),
  })
  const remove = useMutation({
    mutationFn: (id: number) => apiFetch(`${base}/${id}`, { method: 'DELETE' }),
    onSuccess: () => void refresh(),
    onError: (err: Error) => toast.error(err.message || 'Could not delete'),
  })
  const search = useMutation({
    mutationFn: () => apiFetch<{ hits: KnowledgeHit[] }>(`${base}/search?q=${encodeURIComponent(q)}`),
    onSuccess: (r) => setHits(Array.isArray(r.hits) ? r.hits : []),
  })

  if (!data?.settings || !Array.isArray(data.docs)) return null
  const { settings, docs } = data
  const budgetText = budget ?? String(settings.maxChars)
  const budgetNum = Number(budgetText)
  const budgetValid = Number.isInteger(budgetNum) && budgetNum >= L.minMaxChars && budgetNum <= L.maxMaxChars
  const formValid = form.title.trim().length > 0 && form.title.length <= L.maxTitle && form.content.trim().length > 0 && form.content.length <= L.maxDocChars

  return (
    <section className="rounded-2xl border bg-card p-4 space-y-4" aria-label="Knowledge base">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5"><BookOpen className="size-4" /><h3 className="text-sm font-semibold">Knowledge base</h3></div>
        <label className="inline-flex items-center gap-2 text-xs">
          <Switch size="sm" checked={settings.enabled} disabled={!canEdit} onCheckedChange={(enabled) => saveSettings.mutate({ enabled })} aria-label="Use the knowledge base" />
          {settings.enabled ? 'On' : 'Off'}
        </label>
      </div>
      <p className="text-xs text-muted-foreground">
        Paste your site&apos;s FAQ, policies or product facts. For each chat request with this key, the passages that best match the user&apos;s
        question are added as reference material, so answers use your own facts. Keyword matching, no extra AI call.
      </p>

      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <label htmlFor="kb-budget" className="block text-[11px] text-muted-foreground">Most characters added per request</label>
          <Input id="kb-budget" inputMode="numeric" value={budgetText} disabled={!canEdit} onChange={(e) => setBudget(e.target.value)} className="h-8 w-32 text-xs" />
        </div>
        {canEdit && budget !== null && (
          <Button size="sm" className="h-8 text-xs" disabled={!budgetValid || saveSettings.isPending} onClick={() => saveSettings.mutate({ maxChars: budgetNum })}>Save</Button>
        )}
        {!budgetValid && <span className="text-xs text-destructive">{L.minMaxChars.toLocaleString()}–{L.maxMaxChars.toLocaleString()}</span>}
      </div>

      {docs.length === 0 ? <p className="text-xs text-muted-foreground">No documents yet.</p> : (
        <ul className="divide-y rounded-xl border" aria-label="Documents">
          {docs.map(d => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs">
              <span className="font-medium">{d.title}</span>
              <span className="text-muted-foreground">{d.size.toLocaleString()} chars · {d.chunks} passage{d.chunks === 1 ? '' : 's'}</span>
              {canEdit && (
                <span className="flex items-center gap-1">
                  <Button variant="ghost" size="icon" className="size-7" aria-label={`Edit ${d.title}`} onClick={() => setForm({ id: d.id, title: d.title, content: d.content })}><Pencil className="size-3.5" /></Button>
                  <ConfirmButton onConfirm={() => remove.mutate(d.id)} size="icon-xs" armedSize="xs" aria-label={`Delete ${d.title}`} armedClassName="text-destructive"><Trash2 className="size-3.5" /></ConfirmButton>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {canEdit && (
        <form className="space-y-2 border-t pt-3" onSubmit={(e) => { e.preventDefault(); if (formValid && !saveDoc.isPending) saveDoc.mutate() }}>
          <p className="text-xs font-medium text-muted-foreground">{form.id ? 'Edit document' : `Add a document (${docs.length}/${L.maxDocs})`}</p>
          <Input value={form.title} onChange={(e) => setForm(f => ({ ...f, title: e.target.value }))} placeholder="Title, e.g. Shipping" aria-label="Document title" maxLength={L.maxTitle} className="h-8 text-xs" />
          <Textarea value={form.content} onChange={(e) => setForm(f => ({ ...f, content: e.target.value }))} placeholder="Text. Blank lines separate passages." aria-label="Document content" rows={6} className="text-xs" />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" className="h-8 text-xs" disabled={!formValid || saveDoc.isPending || (!form.id && docs.length >= L.maxDocs)}>{form.id ? 'Save changes' : 'Add'}</Button>
            {form.id && <Button type="button" variant="ghost" size="sm" className="h-8 text-xs" onClick={() => setForm({ id: null, title: '', content: '' })}>Cancel</Button>}
            <span className="text-[11px] text-muted-foreground">{form.content.length.toLocaleString()} / {L.maxDocChars.toLocaleString()}</span>
          </div>
        </form>
      )}

      <form className="space-y-2 border-t pt-3" onSubmit={(e) => { e.preventDefault(); if (q.trim()) search.mutate() }}>
        <p className="text-xs font-medium text-muted-foreground">Try a question</p>
        <div className="flex gap-2">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="What a visitor might ask…" aria-label="Test question" className="h-8 text-xs" />
          <Button type="submit" variant="outline" size="sm" className="h-8 text-xs" disabled={!q.trim() || search.isPending}>Search</Button>
        </div>
        {hits && (hits.length === 0
          ? <p className="text-xs text-muted-foreground" role="status">Nothing matches: the request would go out without reference material.</p>
          : (
            <ol className="space-y-1 text-xs" role="status" aria-label="Passages">
              {hits.map((h, i) => (
                <li key={i} className="rounded-lg bg-muted/40 p-2"><strong>{h.title}</strong> <span className="text-muted-foreground">score {h.score}</span><p className="mt-1 whitespace-pre-wrap">{h.text}</p></li>
              ))}
            </ol>
          ))}
      </form>
    </section>
  )
}
