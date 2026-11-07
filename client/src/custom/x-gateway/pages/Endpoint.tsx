import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, ExternalLink, Globe, KeyRound, Plus, Terminal, Trash2 } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { useUserSession } from '../../use-session'
import { useSessionRevision } from '../../session-state'
import { useXStrings } from '../strings'

type GatewayStatus = {
  enabled: boolean
  combosCount: number
}

type GatewayProxyStatus = {
  proxyUrl: string
  configured: boolean
}

type XGatewayClientKey = {
  id: number
  userId: number
  name: string
  keyPrefix: string
  rpmLimit: number
  revoked: boolean
  createdAt: string
  lastUsedAt: string | null
}

type MintedXGatewayKey = {
  id: number
  key: string
  keyPrefix: string
  name: string
  createdAt: string
}

export default function Endpoint() {
  const s = useXStrings()
  const client = useQueryClient()
  const revision = useSessionRevision()
  const session = useUserSession()
  const [copied, setCopied] = useState('')
  const [error, setError] = useState('')
  const [keyName, setKeyName] = useState('')
  const [newlyCreatedKey, setNewlyCreatedKey] = useState<string | null>(null)
  const [proxyInput, setProxyInput] = useState('')
  const canEdit = session.hasPermission('edit_x_settings')

  const status = useQuery({
    queryKey: ['x-gateway-status', revision],
    queryFn: ({ signal }) => apiFetch<GatewayStatus>('/api/x-gateway/status', { signal }),
    retry: false,
  })
  const proxyStatus = useQuery({
    queryKey: ['x-gateway-proxy', revision],
    queryFn: ({ signal }) => apiFetch<GatewayProxyStatus>('/api/x-gateway/proxy', { signal }),
    retry: false,
  })
  const xKeys = useQuery({
    queryKey: ['x-gateway-client-keys', revision],
    queryFn: ({ signal }) => apiFetch<{ keys: XGatewayClientKey[] }>('/api/x-gateway/keys', { signal }),
    retry: false,
  })

  const enabled = status.data?.enabled === true
  const activeProxy = proxyStatus.data?.proxyUrl || ''

  const toggle = useMutation({
    meta: { silenceToast: true },
    mutationFn: (next: boolean) => apiFetch<{ enabled: boolean }>('/api/x-gateway/enabled', { method: 'PUT', body: JSON.stringify({ enabled: next }) }),
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ['x-gateway-status'] }) },
  })

  const saveProxy = useMutation({
    meta: { silenceToast: true },
    mutationFn: (proxyUrl: string) => apiFetch<{ proxyUrl: string; configured: boolean }>('/api/x-gateway/proxy', { method: 'PUT', body: JSON.stringify({ proxyUrl }) }),
    onSuccess: async () => {
      setProxyInput('')
      await client.invalidateQueries({ queryKey: ['x-gateway-proxy'] })
    },
  })

  const createKey = useMutation({
    meta: { silenceToast: true },
    mutationFn: (name: string) => apiFetch<MintedXGatewayKey>('/api/x-gateway/keys', { method: 'POST', body: JSON.stringify({ ...(name.trim() ? { name: name.trim() } : {}) }) }),
    onSuccess: async (created) => {
      setNewlyCreatedKey(created.key)
      setKeyName('')
      await client.invalidateQueries({ queryKey: ['x-gateway-client-keys'] })
    },
  })

  const revokeKey = useMutation({
    meta: { silenceToast: true },
    mutationFn: (id: number) => apiFetch<{ ok: boolean }>(`/api/x-gateway/keys/${id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['x-gateway-client-keys'] })
    },
  })

  const base = new URL(`${import.meta.env.BASE_URL}x/v1`, window.location.origin).href
  const displayKey = newlyCreatedKey ?? s.placeholderKey
  const example = `curl '${base}/chat/completions' \\\n  -H 'Authorization: Bearer ${displayKey}' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"model":"auto","messages":[{"role":"user","content":"Hello"}]}'`
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(text); setError('') }
    catch { setError(s.copyError) }
  }

  function handleCreateKey(e: FormEvent) {
    e.preventDefault()
    createKey.mutate(keyName)
  }

  function handleSaveProxy(e: FormEvent) {
    e.preventDefault()
    saveProxy.mutate(proxyInput.trim())
  }

  const activeClientKeys = (xKeys.data?.keys ?? []).filter(k => !k.revoked)

  return <>
    <div className="x-page-heading"><div><div className="x-eyebrow">{s.openaiCompatible}</div><h1>{s.endpoint}</h1><p>{s.endpointHelp}</p></div><span className="x-heading-icon"><Terminal size={28} /></span></div>
    {status.isError && <div className="x-error" role="alert">{s.gatewayError}<button className="x-button" onClick={() => void status.refetch()}>{s.retry}</button></div>}
    {status.isSuccess && <section className="x-panel x-endpoint-panel"><div className="x-inline"><div><h2>{s.gatewayStatus}</h2><p className="x-muted">{enabled ? s.gatewayOnHelp : s.gatewayOffHelp}</p></div>{canEdit ? <button role="switch" className="x-switch" aria-checked={enabled} aria-label={enabled ? s.disableGateway : s.enableGateway} disabled={toggle.isPending} onClick={() => toggle.mutate(!enabled)}><span /></button> : <span className={`x-badge ${enabled ? 'x-green' : ''}`}><span className="x-dot" />{enabled ? s.gatewayOn : s.gatewayOff}</span>}</div>{toggle.isError && <p className="x-error" role="alert">{toggle.error.message}</p>}{toggle.isSuccess && <p className="x-test-ok" role="status"><Check size={16} />{s.gatewaySaved}</p>}</section>}
    <p className="x-notice">{s.endpointNotice}</p>

    <section className="x-panel x-endpoint-panel">
      <h2>{s.baseUrl}</h2>
      <div className="x-code-line">
        <code>{base}</code>
        <button className="x-icon-button" aria-label={copied === base ? s.copied : s.copy} onClick={() => void copy(base)}>
          {copied === base ? <Check size={18} /> : <Copy size={18} />}
        </button>
      </div>
      <Link className="x-button" to="/agents">{s.personalKey}<ExternalLink size={14} /></Link>
    </section>

    <section className="x-panel x-endpoint-panel">
      <div className="x-section-heading x-inline">
        <div>
          <h2><KeyRound size={18} style={{ verticalAlign: 'text-bottom', marginRight: 6 }} />{s.xGatewayKeysTitle}</h2>
          <p className="x-muted">{s.xGatewayKeysHelp}</p>
        </div>
      </div>

      <form className="x-inline" onSubmit={handleCreateKey} style={{ gap: 8, flexWrap: 'wrap' }}>
        <input
          type="text"
          value={keyName}
          maxLength={80}
          placeholder={s.keyNamePlaceholder}
          onChange={e => setKeyName(e.target.value)}
          style={{ flex: '1 1 220px', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--x-border)', background: 'var(--x-surface-subtle)', color: 'var(--x-ink)' }}
        />
        <button type="submit" className="x-button x-primary" disabled={createKey.isPending}>
          <Plus size={15} />
          {createKey.isPending ? s.creatingXKey : s.createXKey}
        </button>
      </form>

      {createKey.isError && <p className="x-error" role="alert">{createKey.error.message}</p>}

      {newlyCreatedKey && (
        <div className="x-notice" style={{ display: 'grid', gap: 8 }}>
          <strong>{s.newXKeyNotice}</strong>
          <div className="x-code-line">
            <code>{newlyCreatedKey}</code>
            <button className="x-icon-button" aria-label={copied === newlyCreatedKey ? s.copied : s.copy} onClick={() => void copy(newlyCreatedKey)}>
              {copied === newlyCreatedKey ? <Check size={18} /> : <Copy size={18} />}
            </button>
          </div>
        </div>
      )}

      {activeClientKeys.length > 0 ? (
        <div style={{ display: 'grid', gap: 8 }}>
          {activeClientKeys.map(k => (
            <div key={k.id} className="x-code-line" style={{ justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <strong>{k.name}</strong>
                <code>{k.keyPrefix}</code>
              </div>
              <button
                type="button"
                className="x-icon-button x-danger"
                aria-label={`${s.revokeKey}: ${k.name}`}
                disabled={revokeKey.isPending}
                onClick={() => revokeKey.mutate(k.id)}
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="x-muted">{s.noXKeys}</p>
      )}
    </section>

    <section className="x-panel x-endpoint-panel">
      <div className="x-section-heading x-inline">
        <div>
          <h2><Globe size={18} style={{ verticalAlign: 'text-bottom', marginRight: 6 }} />{s.outboundProxyTitle}</h2>
          <p className="x-muted">{s.outboundProxyHelp}</p>
        </div>
        <span className={`x-badge ${activeProxy ? 'x-green' : ''}`}>
          <span className="x-dot" />
          {activeProxy ? `${s.outboundProxyActive}: ${activeProxy}` : s.outboundProxyDirect}
        </span>
      </div>

      {canEdit && (
        <form className="x-inline" onSubmit={handleSaveProxy} style={{ gap: 8, flexWrap: 'wrap' }}>
          <input
            type="text"
            value={proxyInput}
            placeholder={activeProxy || s.outboundProxyPlaceholder}
            onChange={e => setProxyInput(e.target.value)}
            style={{ flex: '1 1 260px', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--x-border)', background: 'var(--x-surface-subtle)', color: 'var(--x-ink)' }}
          />
          <button type="submit" className="x-button x-primary" disabled={saveProxy.isPending || !proxyInput.trim()}>
            {saveProxy.isPending ? s.saving : s.saveProxy}
          </button>
          {activeProxy && (
            <button
              type="button"
              className="x-button"
              disabled={saveProxy.isPending}
              onClick={() => saveProxy.mutate('')}
            >
              {s.clearProxy}
            </button>
          )}
        </form>
      )}
      {saveProxy.isError && <p className="x-error" role="alert">{saveProxy.error.message}</p>}
      {saveProxy.isSuccess && <p className="x-test-ok" role="status"><Check size={16} />{s.proxySaved}</p>}
    </section>

    <section className="x-panel x-endpoint-panel"><div className="x-section-heading x-inline"><h2>{s.example}</h2><button className="x-button x-small" onClick={() => void copy(example)}><Copy size={14} />{copied === example ? s.copied : s.copy}</button></div><pre className="x-code-block"><code>{example}</code></pre></section>
    {error && <p className="x-error" role="alert">{error}</p>}
  </>
}
