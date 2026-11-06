import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, ExternalLink, Terminal } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { useUserSession } from '../../use-session'
import { useSessionRevision } from '../../session-state'
import { useXStrings } from '../strings'

type GatewayStatus = { enabled: boolean; combosCount: number }

export default function Endpoint() {
  const s = useXStrings()
  const client = useQueryClient()
  const revision = useSessionRevision()
  const session = useUserSession()
  const [copied, setCopied] = useState('')
  const [error, setError] = useState('')
  const canEdit = session.hasPermission('edit_x_settings')
  const status = useQuery({ queryKey: ['x-gateway-status', revision], queryFn: ({ signal }) => apiFetch<GatewayStatus>('/api/x-gateway/status', { signal }), retry: false })
  const enabled = status.data?.enabled === true
  const toggle = useMutation({
    meta: { silenceToast: true },
    mutationFn: (next: boolean) => apiFetch<{ enabled: boolean }>('/api/x-gateway/enabled', { method: 'PUT', body: JSON.stringify({ enabled: next }) }),
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ['x-gateway-status'] }) },
  })
  const base = new URL(`${import.meta.env.BASE_URL}x/v1`, window.location.origin).href
  const example = `curl '${base}/chat/completions' \\\n  -H 'Authorization: Bearer YOUR_PERSONAL_KEY' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"model":"auto","messages":[{"role":"user","content":"Hello"}]}'`
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(text); setError('') }
    catch { setError(s.copyError) }
  }
  return <>
    <div className="x-page-heading"><div><div className="x-eyebrow">{s.openaiCompatible}</div><h1>{s.endpoint}</h1><p>{s.endpointHelp}</p></div><span className="x-heading-icon"><Terminal size={28} /></span></div>
    {status.isError && <div className="x-error" role="alert">{s.gatewayError}<button className="x-button" onClick={() => void status.refetch()}>{s.retry}</button></div>}
    {status.isSuccess && <section className="x-panel x-endpoint-panel"><div className="x-inline"><div><h2>{s.gatewayStatus}</h2><p className="x-muted">{enabled ? s.gatewayOnHelp : s.gatewayOffHelp}</p></div>{canEdit ? <button role="switch" className="x-switch" aria-checked={enabled} aria-label={enabled ? s.disableGateway : s.enableGateway} disabled={toggle.isPending} onClick={() => toggle.mutate(!enabled)}><span /></button> : <span className={`x-badge ${enabled ? 'x-green' : ''}`}><span className="x-dot" />{enabled ? s.gatewayOn : s.gatewayOff}</span>}</div>{toggle.isError && <p className="x-error" role="alert">{toggle.error.message}</p>}{toggle.isSuccess && <p className="x-test-ok" role="status"><Check size={16} />{s.gatewaySaved}</p>}</section>}
    <p className="x-notice">{s.endpointNotice}</p>
    <section className="x-panel x-endpoint-panel"><h2>{s.baseUrl}</h2><div className="x-code-line"><code>{base}</code><button className="x-icon-button" aria-label={copied === base ? s.copied : s.copy} onClick={() => void copy(base)}>{copied === base ? <Check size={18} /> : <Copy size={18} />}</button></div><Link className="x-button" to="/agents">{s.personalKey}<ExternalLink size={14} /></Link></section>
    <section className="x-panel x-endpoint-panel"><div className="x-section-heading x-inline"><h2>{s.example}</h2><button className="x-button x-small" onClick={() => void copy(example)}><Copy size={14} />{copied === example ? s.copied : s.copy}</button></div><pre className="x-code-block"><code>{example}</code></pre></section>
    {error && <p className="x-error" role="alert">{error}</p>}
  </>
}
