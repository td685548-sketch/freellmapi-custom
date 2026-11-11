import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import type { AccountProvider, ProviderAccount } from '../../../../shared/x-accounts'
import { refreshAccounts } from './api'
import { subscriptionApi, type SubscriptionAttempt } from './subscription-api'

export function SubscriptionConnectDialog({ provider, account, onClose }: { provider: AccountProvider; account?: ProviderAccount; onClose: () => void }) {
  const client = useQueryClient()
  const [label, setLabel] = useState(account?.label ?? '')
  const [credential, setCredential] = useState('')
  const [code, setCode] = useState('')
  const [attempt, setAttempt] = useState<SubscriptionAttempt | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(true)
  const pending = useRef<string | null>(null)
  const close = useRef(onClose); close.current = onClose
  const done = () => { pending.current = null; setCredential(''); setCode(''); void refreshAccounts(client); close.current() }
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; if (pending.current) void subscriptionApi.cancel(pending.current).catch(() => {}) }
  }, [])
  useEffect(() => {
    if (!attempt) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const result = await subscriptionApi.poll(attempt.attemptId)
        if (stopped) return
        if (result.status === 'saved') done()
        else timer = setTimeout(poll, (result.interval ?? 5) * 1000)
      } catch (cause) { if (!stopped) setError(cause instanceof Error ? cause.message : 'Connection failed.') }
    }
    if (attempt.flow === 'device_code') timer = setTimeout(poll, (attempt.interval ?? 5) * 1000)
    const expiry = setTimeout(() => { stopped = true; if (timer) clearTimeout(timer); setError('Connection expired. Close and try again.') }, Math.max(0, attempt.expiresAt - Date.now()))
    const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('x-provider-connections') : null
    if (channel) channel.onmessage = event => { if (event.data?.attemptId === attempt.attemptId && event.data?.status === 'connected') done() }
    return () => { stopped = true; if (timer) clearTimeout(timer); clearTimeout(expiry); channel?.close() }
    // done reads the current close callback; the effect is scoped to one attempt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt])
  async function run(action: () => Promise<unknown>) {
    setBusy(true); setError('')
    try { await action() } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'Connection failed.') }
    finally { if (mounted.current) setBusy(false) }
  }
  const body = { provider: provider.id, label: label.trim(), ...(account ? { reconnectId: account.id } : {}) }
  async function start() {
    await run(async () => {
      const value = await subscriptionApi.start(body)
      if (!mounted.current) { void subscriptionApi.cancel(value.attemptId).catch(() => {}); return }
      pending.current = value.attemptId; setAttempt(value)
    })
  }
  function importJson(event: FormEvent) { event.preventDefault(); void run(async () => { await subscriptionApi.import({ ...body, credential }); if (mounted.current) done() }) }
  return <Dialog open onOpenChange={open => { if (!open) onClose() }}><DialogPopup className="x-console x-dialog">
    <DialogTitle>{account ? 'Reconnect' : 'Connect'} · {provider.name}</DialogTitle>
    <DialogDescription>Credentials stay encrypted on the server. Saving a credential does not verify upstream access.</DialogDescription>
    {error && <p className="x-error" role="alert">{error}</p>}
    {!attempt ? <form className="x-form" onSubmit={importJson}>
      <label>Account name<input required maxLength={200} value={label} onChange={e => setLabel(e.target.value)} disabled={busy} /></label>
      <button type="button" className="x-button x-primary" disabled={busy || !label.trim()} onClick={() => void start()}>Sign in with browser</button>
      {provider.id === 'gemini-cli' && <p className="x-caption">Browser login requires a configured Google OAuth client and public callback. Import is available for an existing CLI session.</p>}
      <label>Import credential JSON from your computer<input type="file" accept=".json,application/json" disabled={busy} onChange={e => {
        const file = e.target.files?.[0]
        if (!file) return
        if (file.size > 65536) { setError('Credential file exceeds 64 KiB.'); return }
        void file.text().then(value => { if (mounted.current) setCredential(value) }).catch(() => setError('Could not read credential file.'))
        e.target.value = ''
      }} /></label>
      <label>Credential JSON<textarea required rows={5} autoComplete="off" spellCheck={false} value={credential} onChange={e => setCredential(e.target.value)} disabled={busy} maxLength={65536} /></label>
      <p className="x-caption">Use the complete credentials export, including refresh token and expiry. No files on the hosted server are read. After saving, run an account test with an eligible model.</p>
      <button className="x-button" disabled={busy || !credential.trim() || !label.trim()}>Save encrypted credential</button>
    </form> : <div className="x-form">
      <p>{attempt.instruction ?? 'Open the verification page and enter this device code.'}</p>
      {attempt.userCode && <code>{attempt.userCode}</code>}
      <a className="x-button x-primary" href={attempt.authorizationUrl ?? attempt.verificationUri} target="_blank" rel="noopener noreferrer">Open provider login</a>
      <p className="x-caption">Expires {new Date(attempt.expiresAt).toLocaleTimeString()}</p>
      {attempt.flow === 'oauth_pkce' && <form className="x-form" onSubmit={e => { e.preventDefault(); void run(async () => { await subscriptionApi.complete(attempt.attemptId, code); if (mounted.current) done() }) }}>
        <label>Full callback URL or code#state<input value={code} onChange={e => setCode(e.target.value)} autoComplete="off" disabled={busy} required /></label>
        <button className="x-button" disabled={busy || !code.trim()}>Complete login</button>
      </form>}
    </div>}
    <button type="button" className="x-button" onClick={onClose}>Cancel</button>
  </DialogPopup></Dialog>
}
