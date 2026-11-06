import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Check, Copy, ExternalLink, Terminal } from 'lucide-react'
import { useXStrings } from '../strings'

export default function Endpoint() {
  const s = useXStrings()
  const [copied, setCopied] = useState('')
  const [error, setError] = useState('')
  const base = new URL(`${import.meta.env.BASE_URL}x/v1`, window.location.origin).href
  const example = `curl '${base}/chat/completions' \\\n  -H 'Authorization: Bearer YOUR_PERSONAL_KEY' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"model":"auto","messages":[{"role":"user","content":"Hello"}]}'`
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(text); setError('') }
    catch { setError(s.copyError) }
  }
  return <>
    <div className="x-page-heading"><div><div className="x-eyebrow">{s.openaiCompatible}</div><h1>{s.endpoint}</h1><p>{s.endpointHelp}</p></div><span className="x-heading-icon"><Terminal size={28} /></span></div>
    <p className="x-notice">{s.endpointNotice}</p>
    <section className="x-panel x-endpoint-panel"><h2>{s.baseUrl}</h2><div className="x-code-line"><code>{base}</code><button className="x-icon-button" aria-label={copied === base ? s.copied : s.copy} onClick={() => void copy(base)}>{copied === base ? <Check size={18} /> : <Copy size={18} />}</button></div><Link className="x-button" to="/agents">{s.personalKey}<ExternalLink size={14} /></Link></section>
    <section className="x-panel x-endpoint-panel"><div className="x-section-heading x-inline"><h2>{s.example}</h2><button className="x-button x-small" onClick={() => void copy(example)}><Copy size={14} />{copied === example ? s.copied : s.copy}</button></div><pre className="x-code-block"><code>{example}</code></pre></section>
    {error && <p className="x-error" role="alert">{error}</p>}
  </>
}
