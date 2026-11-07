import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { MessageSquare, Send } from 'lucide-react'
import { mgmtApi } from '../management-api'
import { useMgmtStrings } from '../management-strings'

interface Turn { role: 'user' | 'assistant'; content: string; meta?: string }

export default function Playground() {
  const s = useMgmtStrings()
  const [model, setModel] = useState('auto')
  const [prompt, setPrompt] = useState('')
  const [turns, setTurns] = useState<Turn[]>([])
  const chat = useMutation({
    meta: { silenceToast: true },
    mutationFn: (messages: Turn[]) => mgmtApi.chat({ model: model.trim() || 'auto', messages: messages.map(({ role, content }) => ({ role, content })) }),
    onSuccess: r => setTurns(t => [...t, {
      role: 'assistant', content: r.content,
      meta: `${s.routedVia} ${r.provider}/${r.model} · ${r.latencyMs} ms · ${(r.usage?.prompt_tokens ?? 0) + (r.usage?.completion_tokens ?? 0)} ${s.tokens.toLowerCase()}`,
    }]),
  })
  const send = () => {
    const text = prompt.trim()
    if (!text || chat.isPending) return
    const next: Turn[] = [...turns, { role: 'user', content: text }]
    setTurns(next); setPrompt(''); chat.mutate(next)
  }
  return <>
    <div className="x-page-heading"><div><h1>{s.playground}</h1><p>{s.playgroundHelp}</p></div><span className="x-heading-icon"><MessageSquare size={28} /></span></div>
    <div className="x-panel x-mgmt-form">
      <label>{s.model}<input value={model} placeholder={s.modelHint} onChange={e => setModel(e.target.value)} /></label>
      <div className="x-chat" aria-live="polite">{turns.map((t, i) => <div key={i} className={`x-chat-turn x-chat-${t.role}`}><pre>{t.content}</pre>{t.meta && <small>{t.meta}</small>}</div>)}</div>
      {chat.isError && <div role="alert" className="x-error">{chat.error.message}</div>}
      <label>{s.prompt}<textarea rows={3} value={prompt} onChange={e => setPrompt(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send() }} /></label>
      <div className="x-mgmt-actions">
        <button className="x-button x-primary" disabled={chat.isPending || !prompt.trim()} onClick={send}><Send size={15} />{chat.isPending ? s.sending : s.send}</button>
        <button className="x-button" disabled={!turns.length} onClick={() => { setTurns([]); chat.reset() }}>{s.clear}</button>
      </div>
    </div>
  </>
}

