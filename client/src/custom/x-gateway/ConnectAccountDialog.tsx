import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Copy, ExternalLink, LoaderCircle, ShieldCheck, X } from 'lucide-react'
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import type { AccountProvider, ProviderAccount, ProviderAccountAuthStartResponse } from '../../../../shared/x-accounts'
import { accountsApi, callbackAddress, refreshAccounts, trustedLoginUrl } from './api'
import { useXStrings } from './strings'
import { ProviderMark } from './pages/Providers'

export function ConnectAccountDialog({ provider, account, onClose }: {
  provider: AccountProvider; account?: ProviderAccount; onClose: () => void
}) {
  const s = useXStrings()
  const client = useQueryClient()
  const loginMethod = provider.authMethods.find(method => method === 'oauth_pkce' || method === 'device_code')
  const [method, setMethod] = useState(loginMethod ?? provider.authMethods[0] ?? 'api_key')
  const [label, setLabel] = useState(account?.label ?? '')
  const [key, setKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl ?? '')
  const [proxyUrl, setProxyUrl] = useState('')
  const [attempt, setAttempt] = useState<ProviderAccountAuthStartResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [manual, setManual] = useState('')
  const [copied, setCopied] = useState(false)
  const active = useRef(true)
  const attemptId = useRef<string | null>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
      if (attemptId.current) void accountsApi.cancel(attemptId.current).catch(() => {})
    }
  }, [])

  const connected = () => {
    attemptId.current = null
    void refreshAccounts(client)
    closeRef.current()
  }

  useEffect(() => {
    if (!attempt) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const expire = setTimeout(() => {
      stopped = true
      if (timer) clearTimeout(timer)
      setError(s.expired)
    }, Math.max(0, attempt.expiresAt - Date.now()))
    const finish = () => {
      if (stopped) return
      attemptId.current = null
      void refreshAccounts(client)
      closeRef.current()
    }
    if (attempt.flow === 'device_code') {
      const poll = async () => {
        try {
          const result = await accountsApi.poll(attempt.attemptId)
          if (stopped) return
          if (result.status === 'connected') finish()
          else timer = setTimeout(poll, Math.max(1, result.interval) * 1000)
        } catch (cause) {
          if (!stopped) setError(cause instanceof Error ? cause.message : s.callbackError)
        }
      }
      timer = setTimeout(poll, Math.max(1, attempt.interval) * 1000)
    }
    const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('x-provider-connections') : null
    if (channel) channel.onmessage = event => {
      if (event.data?.attemptId === attempt.attemptId && event.data?.status === 'connected') finish()
    }
    return () => {
      stopped = true
      clearTimeout(expire)
      if (timer) clearTimeout(timer)
      channel?.close()
    }
  }, [attempt, client, s.expired, s.callbackError])

  const isDirectCredential = method === 'api_key' || method === 'cookie'

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    if (!label.trim() || (isDirectCredential && !key.trim()) || (provider.id === 'custom' && !baseUrl.trim())) { setError(s.required); return }
    setError('')
    setBusy(true)
    try {
      if (isDirectCredential) {
        await accountsApi.addKey(provider.id, key.trim(), label.trim(), provider.id === 'custom' ? baseUrl.trim() : undefined, proxyUrl.trim() || undefined)
        setKey('')
        if (active.current) connected()
      } else {
        const result = await accountsApi.start(provider.id, { label: label.trim(), callbackUrl: callbackAddress(), ...(account ? { reconnectId: account.id } : {}) })
        if (!active.current) { void accountsApi.cancel(result.attemptId).catch(() => {}); return }
        const url = result.flow === 'oauth_pkce' ? result.authorizationUrl : result.verificationUri
        if (!trustedLoginUrl(url, provider.id)) {
          void accountsApi.cancel(result.attemptId).catch(() => {})
          throw new Error(s.callbackError)
        }
        attemptId.current = result.attemptId
        setAttempt(result)
      }
    } catch (cause) {
      if (active.current) setError(cause instanceof Error ? cause.message : s.callbackError)
    } finally { if (active.current) setBusy(false) }
  }

  async function completeManual(event: FormEvent) {
    event.preventDefault()
    if (!attempt || busy) return
    setError('')
    let code: string
    try {
      const url = new URL(manual)
      const expected = new URL(callbackAddress())
      if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.searchParams.get('attemptId') !== attempt.attemptId || !url.searchParams.get('code')) throw new Error()
      code = url.searchParams.get('code')!
    } catch { setError(s.invalidCallback); return }
    setBusy(true)
    try {
      await accountsApi.complete(attempt.attemptId, code)
      setManual('')
      connected()
    } catch (cause) { setError(cause instanceof Error ? cause.message : s.callbackError) }
    finally { if (active.current) setBusy(false) }
  }

  return <Dialog open onOpenChange={open => { if (!open) onClose() }}>
    <DialogPopup className="x-console x-dialog">
      <button className="x-icon-button x-dialog-close" aria-label={s.close} onClick={onClose}><X size={18} /></button>
      <div className="x-dialog-icon"><ProviderMark id={provider.id} name={provider.name} /></div>
      <DialogTitle className="x-dialog-title">{account ? s.reconnect : s.addAccount} · {provider.name}</DialogTitle>
      <DialogDescription className="x-muted">{s.oauthHelp}</DialogDescription>
      {provider.id === 'github-copilot' && <p className="x-notice">{s.copilotNotice}</p>}
      {error && <div className="x-error" role="alert">{error}</div>}
      {!attempt ? <form onSubmit={submit} className="x-form">
        {!account && provider.authMethods.length > 1 && <fieldset className="x-methods"><legend>{s.method}</legend>
          {provider.authMethods.map(value => <label key={value} className={method === value ? 'selected' : ''}>
            <input type="radio" name="connection-method" value={value} checked={method === value} onChange={() => { setMethod(value); setError('') }} />
            {value === 'api_key' ? s.apiKey : value === 'cookie' ? s.cookie : value === 'device_code' ? s.device : s.oauth}
          </label>)}
        </fieldset>}
        <label>{s.name}<input id="x-account-label" name="label" autoFocus maxLength={100} value={label} placeholder={s.namePlaceholder} onChange={event => setLabel(event.target.value)} disabled={busy} required /></label>
        {provider.id === 'custom' && <label>{s.baseUrl}<input id="x-account-base-url" name="baseUrl" type="url" value={baseUrl} placeholder="https://api.example.com/v1" onChange={event => setBaseUrl(event.target.value)} disabled={busy} required /></label>}
        {isDirectCredential && <label>{s.credential}<input id="x-account-credential" name="credential" type="password" autoComplete="new-password" value={key} onChange={event => setKey(event.target.value)} placeholder={s.credentialPlaceholder} disabled={busy} required /></label>}
        {isDirectCredential && <label>{s.accountProxy}<input id="x-account-proxy" name="proxyUrl" value={proxyUrl} onChange={event => setProxyUrl(event.target.value)} placeholder={s.accountProxyPlaceholder} disabled={busy} /></label>}
        <p className="x-security"><ShieldCheck size={16} />{s.encrypted}</p>
        <div className="x-dialog-actions"><button type="button" className="x-button" onClick={onClose}>{s.cancel}</button><button className="x-button x-primary" disabled={busy}>{busy && <LoaderCircle size={16} className="x-spin" />}{busy ? s.connecting : isDirectCredential ? s.addAccount : s.signIn}</button></div>
      </form> : <div className="x-auth-wait">
        <h3>{s.waiting}</h3><p className="x-muted">{attempt.flow === 'device_code' ? s.deviceHelp : s.browserHelp}</p>
        {attempt.flow === 'device_code' && <div className="x-device-code"><code>{attempt.userCode}</code><button className="x-icon-button" aria-label={copied ? s.copied : s.copy} onClick={async () => {
          try { await navigator.clipboard.writeText(attempt.userCode); setCopied(true) } catch { setError(s.copyError) }
        }}><Copy size={17} /></button></div>}
        <a className="x-button x-primary" target="_blank" rel="noopener noreferrer" href={trustedLoginUrl(attempt.flow === 'oauth_pkce' ? attempt.authorizationUrl : attempt.verificationUri, provider.id) ?? undefined}>{s.openLogin}<ExternalLink size={15} /></a>
        <p className="x-caption">{s.expires} {new Date(attempt.expiresAt).toLocaleTimeString()}</p>
        {attempt.flow === 'oauth_pkce' && <form className="x-form" onSubmit={completeManual}><label>{s.manualCallback}<input id="x-account-callback" name="callback" type="url" value={manual} autoComplete="off" onChange={event => setManual(event.target.value)} placeholder={s.callbackPlaceholder} /></label><button className="x-button" disabled={busy || !manual.trim()}>{busy ? s.connecting : s.complete}</button></form>}
        <button className="x-button x-full" onClick={onClose}>{s.cancel}</button>
      </div>}
    </DialogPopup>
  </Dialog>
}
