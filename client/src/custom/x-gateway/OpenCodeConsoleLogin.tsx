import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Copy, ExternalLink, LoaderCircle, ShieldCheck, X } from 'lucide-react'
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import type { OpenCodeConsoleLoginStartResponse, ProviderAccount } from '../../../../shared/x-accounts'
import { accountsApi, refreshAccounts, trustedLoginUrl } from './api'
import { useXStrings } from './strings'

type Phase = 'loading' | 'logged-out' | 'waiting' | 'connected' | 'expired'

/**
 * OpenCode Console device login for one OpenCode Free account. Starts the
 * same device flow the OpenCode CLI performs, shows the verification link +
 * user code, polls until the account connects, then shows the connected
 * state with a disconnect action. When the dialog closes mid-flow the
 * pending attempt is cancelled.
 */
export function OpenCodeConsoleLogin({ account, onClose }: { account: ProviderAccount; onClose: () => void }) {
  const s = useXStrings()
  const client = useQueryClient()
  const [phase, setPhase] = useState<Phase>('loading')
  const [attempt, setAttempt] = useState<OpenCodeConsoleLoginStartResponse | null>(null)
  const [identity, setIdentity] = useState<string | null>(account.identity)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const active = useRef(true)
  const attemptId = useRef<string | null>(null)

  useEffect(() => {
    active.current = true
    let cancelled = false
    void accountsApi.opencodeOAuth.status(account.id).then(result => {
      if (cancelled || !active.current) return
      setIdentity(result.identity)
      setPhase(result.connected ? 'connected' : 'logged-out')
    }).catch(() => {
      // A failed status read must not block the dialog: treat the account as
      // not logged in and let the user start the device flow. Starting the
      // login reports its own errors if it fails too.
      if (!cancelled && active.current) {
        setPhase('logged-out')
      }
    })
    return () => {
      cancelled = true
      active.current = false
      if (attemptId.current) void accountsApi.opencodeOAuth.cancel(attemptId.current).catch(() => {})
    }
  }, [account.id, s.callbackError])

  useEffect(() => {
    if (!attempt) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const expire = setTimeout(() => {
      stopped = true
      if (timer) clearTimeout(timer)
      setPhase('expired')
    }, Math.max(0, attempt.expiresAt - Date.now()))
    const poll = async () => {
      try {
        const result = await accountsApi.opencodeOAuth.poll(attempt.attemptId)
        if (stopped) return
        if (result.status === 'connected') {
          attemptId.current = null
          setAttempt(null)
          void refreshAccounts(client)
          try {
            const status = await accountsApi.opencodeOAuth.status(account.id)
            if (!stopped) {
              setIdentity(status.identity)
              setPhase('connected')
            }
          } catch {
            if (!stopped) setPhase('connected')
          }
          return
        }
        if (result.status === 'expired') {
          setPhase('expired')
          return
        }
        timer = setTimeout(poll, Math.max(1, result.interval) * 1000)
      } catch (cause) {
        if (!stopped) setError(cause instanceof Error ? cause.message : s.callbackError)
      }
    }
    timer = setTimeout(poll, Math.max(1, attempt.interval) * 1000)
    return () => {
      stopped = true
      clearTimeout(expire)
      if (timer) clearTimeout(timer)
    }
  }, [attempt, account.id, client, s.callbackError])

  async function start() {
    if (busy) return
    setError('')
    setBusy(true)
    try {
      const result = await accountsApi.opencodeOAuth.start(account.id)
      if (!active.current) {
        void accountsApi.opencodeOAuth.cancel(result.attemptId).catch(() => {})
        return
      }
      attemptId.current = result.attemptId
      setAttempt(result)
      setPhase('waiting')
    } catch (cause) {
      if (active.current) setError(cause instanceof Error ? cause.message : s.callbackError)
    } finally {
      if (active.current) setBusy(false)
    }
  }

  async function disconnect() {
    if (busy) return
    setError('')
    setBusy(true)
    try {
      await accountsApi.opencodeOAuth.disconnect(account.id)
      setIdentity(null)
      setPhase('logged-out')
      void refreshAccounts(client)
    } catch (cause) {
      if (active.current) setError(cause instanceof Error ? cause.message : s.callbackError)
    } finally {
      if (active.current) setBusy(false)
    }
  }

  const loginUrl = attempt ? trustedLoginUrl(attempt.verificationUriComplete, 'opencode') : null

  return <Dialog open onOpenChange={open => { if (!open) onClose() }}>
    <DialogPopup className="x-console x-dialog">
      <button className="x-icon-button x-dialog-close" aria-label={s.close} onClick={onClose}><X size={18} /></button>
      <DialogTitle className="x-dialog-title">{s.consoleLogin} · {account.label || 'OpenCode Free'}</DialogTitle>
      <DialogDescription className="x-muted">{s.consoleLoginHelp}</DialogDescription>
      {error && <div className="x-error" role="alert">{error}</div>}
      {phase === 'loading' && (
        <p className="x-muted" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <LoaderCircle size={16} className="x-spin" />{s.loading}
        </p>
      )}
      {phase === 'logged-out' && (
        <div className="x-dialog-actions">
          <button type="button" className="x-button" onClick={onClose}>{s.cancel}</button>
          <button type="button" className="x-button x-primary" disabled={busy} onClick={() => void start()}>
            {busy && <LoaderCircle size={16} className="x-spin" />}{busy ? s.connecting : s.consoleLoginStart}
          </button>
        </div>
      )}
      {phase === 'waiting' && attempt && (
        <div className="x-auth-wait">
          <h3>{s.waiting}</h3>
          <p className="x-muted">{s.deviceHelp}</p>
          <div className="x-device-code">
            <code>{attempt.userCode}</code>
            <button className="x-icon-button" aria-label={copied ? s.copied : s.copy} onClick={async () => {
              try { await navigator.clipboard.writeText(attempt.userCode); setCopied(true) } catch { setError(s.copyError) }
            }}><Copy size={17} /></button>
          </div>
          <a className="x-button x-primary" target="_blank" rel="noopener noreferrer" href={loginUrl ?? undefined}>{s.openLogin}<ExternalLink size={15} /></a>
          <p className="x-caption">{s.expires} {new Date(attempt.expiresAt).toLocaleTimeString()}</p>
          <button className="x-button x-full" onClick={onClose}>{s.cancel}</button>
        </div>
      )}
      {phase === 'expired' && (
        <div className="x-auth-wait">
          <p className="x-error" role="alert">{s.expired}</p>
          <div className="x-dialog-actions">
            <button type="button" className="x-button" onClick={onClose}>{s.cancel}</button>
            <button type="button" className="x-button x-primary" disabled={busy} onClick={() => void start()}>
              {busy ? s.connecting : s.consoleLoginStart}
            </button>
          </div>
        </div>
      )}
      {phase === 'connected' && (
        <div className="x-auth-wait">
          <p style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <ShieldCheck size={18} />{s.consoleLoginConnected}
          </p>
          {identity && <p className="x-muted">{s.consoleLoginIdentity}: <code>{identity}</code></p>}
          <div className="x-dialog-actions">
            <button type="button" className="x-button" onClick={onClose}>{s.cancel}</button>
            <button type="button" className="x-button" disabled={busy} onClick={() => void disconnect()}>
              {busy ? s.connecting : s.consoleLoginDisconnect}
            </button>
          </div>
        </div>
      )}
    </DialogPopup>
  </Dialog>
}
