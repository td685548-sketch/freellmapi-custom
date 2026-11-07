import { useState, useEffect, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  CircleCheck,
  Clock,
  Ellipsis,
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  ShieldCheck,
  Trash2,
  Unplug,
  X,
} from 'lucide-react'
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { apiFetch } from '@/lib/api'
import type { ProviderAccount } from '../../../../../shared/x-accounts'
import { accountsApi, refreshAccounts, useAccounts } from '../api'
import { useSessionRevision } from '../../session-state'
import { proxyPoolApi } from '../proxy-pool-api'
import { usePoolStrings } from '../proxy-pool-strings'
import { useXStrings } from '../strings'
import { ConnectAccountDialog } from '../ConnectAccountDialog'
import { AccountLoadState, ProviderMark } from './Providers'

export interface AutoPingSchedule {
  enabled: boolean
  mode: 'off' | 'reset' | 'schedule'
  anchor: string
  windowHours: number
  slotsPerDay: number
  timezone: string
  lastPingAt?: string | null
  lastPingStatus?: 'ok' | 'error' | null
}

function CooldownTimer({ until }: { until: string }) {
  const [remaining, setRemaining] = useState('')

  useEffect(() => {
    const update = () => {
      const diff = new Date(until).getTime() - Date.now()
      if (diff <= 0) {
        setRemaining('')
        return
      }
      const secs = Math.floor(diff / 1000)
      if (secs < 60) setRemaining(`${secs}s`)
      else if (secs < 3600) setRemaining(`${Math.floor(secs / 60)}m ${secs % 60}s`)
      else setRemaining(`${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`)
    }
    update()
    const timer = setInterval(update, 1000)
    return () => clearInterval(timer)
  }, [until])

  if (!remaining) return null

  return (
    <span
      className="x-cooldown-timer"
      title="HTTP 429 Cooldown countdown active"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        color: '#f97316',
        fontWeight: 600,
        fontSize: '0.8125rem',
        fontFamily: 'monospace',
        background: 'rgba(249, 115, 22, 0.1)',
        padding: '2px 8px',
        borderRadius: '6px',
        border: '1px solid rgba(249, 115, 22, 0.25)',
      }}
    >
      ⏱ {remaining}
    </span>
  )
}

function getScheduleSlots(anchor: string, windowHours: number, slotsPerDay: number): string[] {
  const [hStr, mStr] = anchor.split(':')
  const baseMinutes = (Number(hStr) || 0) * 60 + (Number(mStr) || 0)
  const windowMinutes = Math.round(windowHours * 60)
  const slots: string[] = []

  for (let i = 0; i < Math.min(slotsPerDay, 24); i++) {
    const total = (baseMinutes + i * windowMinutes) % 1440
    const hh = String(Math.floor(total / 60)).padStart(2, '0')
    const mm = String(total % 60).padStart(2, '0')
    slots.push(`${hh}:${mm}`)
  }
  return slots
}

export default function ProviderAccounts() {
  const { providerId } = useParams()
  const s = useXStrings()
  const p = usePoolStrings()
  const revision = useSessionRevision()
  const query = useAccounts()
  const client = useQueryClient()
  const poolQuery = useQuery({ queryKey: ['x-proxy-pool', revision], queryFn: ({ signal }) => proxyPoolApi.list(signal), retry: false, staleTime: 15_000 })
  const poolEntries = poolQuery.data?.entries ?? []

  // Cooldown query
  const cooldownQuery = useQuery({
    queryKey: ['x-account-cooldowns', revision],
    queryFn: ({ signal }) => apiFetch<{ cooldowns: Record<number, string> }>('/api/x-accounts/cooldowns', { signal }),
    refetchInterval: 5_000,
    retry: false,
  })
  const cooldowns = cooldownQuery.data?.cooldowns ?? {}

  const [connect, setConnect] = useState<true | ProviderAccount | null>(null)
  const [edit, setEdit] = useState<ProviderAccount | null>(null)
  const [label, setLabel] = useState('')
  const [proxyUrl, setProxyUrl] = useState('')
  const [poolId, setPoolId] = useState('')
  const [remove, setRemove] = useState<ProviderAccount | null>(null)
  const [tab, setTab] = useState<'accounts' | 'models'>('accounts')
  const [testResult, setTestResult] = useState<{ id: number; ok: boolean } | null>(null)

  // Auto-Ping Modal state
  const [autoPingAccount, setAutoPingAccount] = useState<ProviderAccount | null>(null)
  const [pingMode, setPingMode] = useState<'off' | 'reset' | 'schedule'>('off')
  const [pingAnchor, setPingAnchor] = useState('08:00')
  const [pingWindowHours, setPingWindowHours] = useState(5)
  const [pingSlotsPerDay, setPingSlotsPerDay] = useState(3)
  const [pingTestStatus, setPingTestStatus] = useState<string | null>(null)

  // Fetch schedule when modal opens
  useQuery({
    queryKey: ['x-account-autoping', autoPingAccount?.id],
    queryFn: async ({ signal }) => {
      if (!autoPingAccount) return null
      const res = await apiFetch<{ schedule: AutoPingSchedule }>(`/api/x-accounts/${autoPingAccount.id}/auto-ping`, { signal })
      if (res?.schedule) {
        setPingMode(res.schedule.mode || 'off')
        setPingAnchor(res.schedule.anchor || '08:00')
        setPingWindowHours(res.schedule.windowHours || 5)
        setPingSlotsPerDay(res.schedule.slotsPerDay || 3)
      }
      return res
    },
    enabled: Boolean(autoPingAccount),
    retry: false,
  })

  const change = useMutation({
    meta: { silenceToast: true },
    mutationFn: async (action: { type: 'edit' | 'remove' | 'toggle' | 'test'; id: number; label?: string; proxyUrl?: string; proxyPoolId?: number | null; enabled?: boolean }) => {
      if (action.type === 'test') {
        const result = await accountsApi.test(action.id)
        setTestResult({ id: action.id, ok: result.ok })
      } else if (action.type === 'remove') await accountsApi.remove(action.id)
      else await accountsApi.edit(action.id, action.type === 'toggle' ? { enabled: action.enabled } : { label: action.label, ...(action.proxyUrl !== undefined ? { proxyUrl: action.proxyUrl } : {}), ...(action.proxyPoolId !== undefined ? { proxyPoolId: action.proxyPoolId } : {}) })
    },
    onSuccess: async () => { setEdit(null); setRemove(null); await refreshAccounts(client) },
  })

  const saveAutoPingMutation = useMutation({
    meta: { silenceToast: true },
    mutationFn: async (accountId: number) => {
      return apiFetch(`/api/x-accounts/${accountId}/auto-ping`, {
        method: 'PUT',
        body: JSON.stringify({
          mode: pingMode,
          anchor: pingAnchor,
          windowHours: Number(pingWindowHours),
          slotsPerDay: Number(pingSlotsPerDay),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        }),
      })
    },
    onSuccess: async () => {
      setAutoPingAccount(null)
      await client.invalidateQueries({ queryKey: ['x-account-cooldowns'] })
      await refreshAccounts(client)
    },
  })

  const runPingMutation = useMutation({
    meta: { silenceToast: true },
    mutationFn: async (accountId: number) => {
      setPingTestStatus('pinging')
      return apiFetch<{ ok: boolean; latencyMs: number; message?: string }>(`/api/x-accounts/${accountId}/ping`, { method: 'POST' })
    },
    onSuccess: (res) => {
      setPingTestStatus(res.ok ? `${s.pingSuccess} (${res.latencyMs}ms)` : `${s.pingFailed}: ${res.message || ''}`)
    },
    onError: (err: Error) => {
      setPingTestStatus(`${s.pingFailed}: ${err.message}`)
    },
  })

  if (query.isPending) return <AccountLoadState />
  if (query.isError) return <AccountLoadState error retry={() => void query.refetch()} />
  const provider = query.data.providers.find(item => item.id === providerId)
  if (!provider) return <div className="x-empty"><h1>{s.providerNotFound}</h1><Link className="x-button" to="/x/providers">{s.returnProviders}</Link></div>
  const permissions = query.data.permissions
  const canConnect = permissions.add && ((provider.id !== 'github-copilot' && provider.id !== 'custom') || permissions.manageModels)
  const models = Array.from(new Map(provider.accounts.flatMap(account => account.models).map(model => [model.id, model])).values())
  const count = (value: number) => value.toLocaleString()

  function editSubmit(event: FormEvent) {
    event.preventDefault()
    if (edit && label.trim()) {
      const nextProxy = proxyUrl.trim()
      const proxyPatch = nextProxy !== (edit.proxyUrl ?? '') ? { proxyUrl: nextProxy } : {}
      const nextPool = poolId === '' ? null : Number(poolId)
      const poolPatch = nextPool !== (edit.proxyPoolId ?? null) ? { proxyPoolId: nextPool } : {}
      change.mutate({ type: 'edit', id: edit.id, label: label.trim(), ...proxyPatch, ...poolPatch })
    }
  }

  const previewSlots = getScheduleSlots(pingAnchor, pingWindowHours, pingSlotsPerDay)

  return <>
    <Link to="/x/providers" className="x-back-link"><ArrowLeft size={16} />{s.providers}</Link>
    <div className="x-page-heading">
      <div className="x-provider-title">
        <ProviderMark id={provider.id} name={provider.name} />
        <div>
          <h1>{provider.name}</h1>
          <p>{provider.accounts.length} {s.accounts.toLowerCase()} · {provider.category === 'oauth' && !provider.authMethods.some(m => m === 'oauth_pkce' || m === 'device_code') ? `${s.oauth} / ${s.apiKey}` : provider.authMethods.map(method => method === 'api_key' ? s.apiKey : method === 'cookie' ? s.cookie : method === 'device_code' ? s.device : s.oauth).join(' / ')}</p>
        </div>
      </div>
      {canConnect && <button className="x-button x-primary" onClick={() => { change.reset(); setConnect(true) }}><Plus size={16} />{s.addAccount}</button>}
    </div>
    {provider.id === 'github-copilot' && <p className="x-notice">{s.copilotNotice}</p>}
    {change.isError && <div className="x-error" role="alert">{change.error.message}</div>}

    <div className="x-tabs" role="tablist" aria-label={provider.name} onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const next = event.key === 'Home' ? 'accounts' : event.key === 'End' ? 'models' : tab === 'accounts' ? 'models' : 'accounts'
      setTab(next)
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next === 'accounts' ? 0 : 1]?.focus()
    }}>
      <button id="x-accounts-tab" role="tab" aria-selected={tab === 'accounts'} aria-controls="x-accounts-panel" tabIndex={tab === 'accounts' ? 0 : -1} className={tab === 'accounts' ? 'selected' : ''} onClick={() => setTab('accounts')}>
        {s.accounts}<span>{provider.accounts.length}</span>
      </button>
      <button id="x-models-tab" role="tab" aria-selected={tab === 'models'} aria-controls="x-models-panel" tabIndex={tab === 'models' ? 0 : -1} className={tab === 'models' ? 'selected' : ''} onClick={() => setTab('models')}>
        {s.models}<span>{models.length}</span>
      </button>
    </div>

    {tab === 'accounts' ? <section id="x-accounts-panel" role="tabpanel" aria-labelledby="x-accounts-tab">
      {!provider.accounts.length && <div className="x-empty x-panel"><Unplug size={38} /><h2>{s.noAccounts}</h2><p>{s.noAccountsHelp}</p>{canConnect && <button className="x-button x-primary" onClick={() => setConnect(true)}><Plus size={16} />{s.addAccount}</button>}</div>}
      <div className="x-account-list">
        {provider.accounts.map(account => {
          const cooldownUntil = cooldowns[account.id]
          return (
            <article key={account.id} className={`x-account x-panel ${account.enabled ? '' : 'x-account-paused'}`}>
              <div className="x-account-top">
                <span className="x-account-icon"><KeyRound size={20} /></span>
                <div className="x-account-identity">
                  <h3>{account.label || provider.name}</h3>
                  <p>
                    {account.identity ?? (account.authMethod === 'api_key' ? s.apiKey : account.authMethod === 'cookie' ? s.cookie : s.oauth)}
                    {account.proxyUrl ? ` · Proxy: ${account.proxyUrl}` : ''}
                    {account.proxyPoolName ? ` · ${p.poolBadge}: ${account.proxyPoolName}` : ''}
                  </p>
                </div>
                {/* Visual Cooldown timer badge if account hit HTTP 429 */}
                {cooldownUntil && <CooldownTimer until={cooldownUntil} />}
                <span className={`x-badge ${!account.enabled ? '' : account.status === 'healthy' ? 'x-green' : account.status === 'error' ? 'x-red' : ''}`}>
                  <span className="x-dot" />
                  {!account.enabled ? s.paused : account.status === 'healthy' ? s.healthy : account.status === 'error' ? s.needsLogin : s.unknown}
                </span>
                {permissions.edit && (
                  <button className="x-switch" role="switch" aria-checked={account.enabled} aria-label={`${account.enabled ? s.disable : s.enable}: ${account.label}`} disabled={change.isPending} onClick={() => change.mutate({ type: 'toggle', id: account.id, enabled: !account.enabled })}>
                    <span />
                  </button>
                )}
              </div>

              <div className="x-account-metrics">
                <div><span>{s.requests}</span><strong>{count(account.monthlyUsage.requests)}<small> / {account.monthlyRequestCap ? count(account.monthlyRequestCap) : '∞'}</small></strong></div>
                <div><span>{s.tokens}</span><strong>{count(account.monthlyUsage.tokens)}<small> / {account.monthlyTokenCap ? count(account.monthlyTokenCap) : '∞'}</small></strong></div>
              </div>

              <div className="x-account-actions">
                {permissions.test && (
                  <button className="x-button x-small" disabled={change.isPending} onClick={() => { setTestResult(null); change.mutate({ type: 'test', id: account.id }) }}>
                    <ShieldCheck size={14} />{change.isPending && change.variables?.type === 'test' && change.variables.id === account.id ? s.testing : s.test}
                  </button>
                )}

                {/* Auto-Ping Schedule Configuration Button */}
                <button
                  type="button"
                  className="x-button x-small"
                  title={s.autoPingHelp}
                  onClick={() => {
                    setPingTestStatus(null)
                    setAutoPingAccount(account)
                  }}
                >
                  <Clock size={14} />{s.autoPing}
                </button>

                {permissions.edit && (provider.id !== 'github-copilot' || permissions.manageModels) && (account.authMethod === 'oauth_pkce' || account.authMethod === 'device_code') && (
                  <button className="x-button x-small" disabled={change.isPending} onClick={() => { change.reset(); setConnect(account) }}>
                    <RefreshCw size={14} />{s.reconnect}
                  </button>
                )}

                <span className="x-spacer" />

                {permissions.edit && (
                  <button className="x-icon-button" aria-label={`${s.edit}: ${account.label}`} onClick={() => { change.reset(); setEdit(account); setLabel(account.label); setProxyUrl(account.proxyUrl ?? ''); setPoolId(account.proxyPoolId != null ? String(account.proxyPoolId) : '') }}>
                    <Pencil size={16} />
                  </button>
                )}

                {permissions.delete && (
                  <button className="x-icon-button x-danger" aria-label={`${s.remove}: ${account.label}`} onClick={() => { change.reset(); setRemove(account) }}>
                    <Trash2 size={16} />
                  </button>
                )}

                {!permissions.edit && !permissions.delete && <span className="x-caption">{s.readOnly}<Ellipsis size={15} /></span>}
              </div>

              {testResult && testResult.id === account.id && (
                <p className={testResult.ok ? 'x-test-ok' : 'x-error'} role="status">
                  {testResult.ok && <CircleCheck size={16} />}{testResult.ok ? s.testOk : s.testFailed}
                </p>
              )}
            </article>
          )
        })}
      </div>
      <div className="x-info-row"><ShieldCheck size={20} /><div><h3>{s.routing}</h3><p>{s.routingHelp}</p><p>{s.sharedPool}</p></div></div>
    </section> : <section id="x-models-panel" role="tabpanel" aria-labelledby="x-models-tab" className="x-panel x-model-list">{models.length ? models.map(model => <div key={model.id}><strong>{model.name}</strong><code>{model.id}</code></div>) : <p className="x-muted">{s.noModels}</p>}</section>}

    {connect && <ConnectAccountDialog provider={provider} account={connect === true ? undefined : connect} onClose={() => setConnect(null)} />}

    {/* Auto-Ping Schedule Modal */}
    {autoPingAccount && (
      <Dialog open onOpenChange={open => { if (!open && !saveAutoPingMutation.isPending) setAutoPingAccount(null) }}>
        <DialogPopup className="x-console x-dialog" style={{ maxWidth: '500px' }}>
          <DialogTitle>{s.autoPing}</DialogTitle>
          <DialogDescription>{autoPingAccount.label} — {s.autoPingHelp}</DialogDescription>

          <div style={{ marginTop: '1rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {/* Mode selection buttons */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.5rem' }}>
              {(['off', 'reset', 'schedule'] as const).map(mode => (
                <button
                  key={mode}
                  type="button"
                  className={`x-button ${pingMode === mode ? 'x-primary' : ''}`}
                  onClick={() => setPingMode(mode)}
                  style={{ justifyContent: 'center' }}
                >
                  {mode === 'off' ? s.modeOff : mode === 'reset' ? s.modeReset : s.modeSchedule}
                </button>
              ))}
            </div>

            {pingMode === 'schedule' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '0.5rem' }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.75rem' }}>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.8125rem' }}>
                    {s.anchorTime}
                    <input
                      type="time"
                      value={pingAnchor}
                      onChange={e => setPingAnchor(e.target.value)}
                      style={{ padding: '0.375rem', borderRadius: '6px', border: '1px solid var(--border)' }}
                    />
                  </label>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.8125rem' }}>
                    {s.windowHours}
                    <input
                      type="number"
                      min="0.5"
                      max="24"
                      step="0.5"
                      value={pingWindowHours}
                      onChange={e => setPingWindowHours(Number(e.target.value))}
                      style={{ padding: '0.375rem', borderRadius: '6px', border: '1px solid var(--border)' }}
                    />
                  </label>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.8125rem' }}>
                    {s.slotsPerDay}
                    <input
                      type="number"
                      min="1"
                      max="24"
                      value={pingSlotsPerDay}
                      onChange={e => setPingSlotsPerDay(Number(e.target.value))}
                      style={{ padding: '0.375rem', borderRadius: '6px', border: '1px solid var(--border)' }}
                    />
                  </label>
                </div>

                {previewSlots.length > 0 && (
                  <div style={{ background: 'var(--bg-subtle, rgba(0,0,0,0.05))', padding: '0.65rem 0.75rem', borderRadius: '8px' }}>
                    <p style={{ margin: 0, fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)' }}>
                      Daily Ping Slots ({Intl.DateTimeFormat().resolvedOptions().timeZone})
                    </p>
                    <p style={{ margin: '0.25rem 0 0', fontSize: '0.875rem', fontWeight: 500 }}>
                      {previewSlots.join('  →  ')}
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* Test Ping Action */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '0.5rem', paddingTop: '0.75rem', borderTop: '1px solid var(--border)' }}>
              <button
                type="button"
                className="x-button x-small"
                disabled={runPingMutation.isPending}
                onClick={() => runPingMutation.mutate(autoPingAccount.id)}
              >
                <Send size={14} />{runPingMutation.isPending ? s.testing : s.pingNow}
              </button>
              {pingTestStatus && (
                <span style={{ fontSize: '0.8125rem', color: pingTestStatus.includes(s.pingSuccess) ? '#10b981' : 'inherit' }}>
                  {pingTestStatus}
                </span>
              )}
            </div>

            <div className="x-dialog-actions" style={{ marginTop: '1rem' }}>
              <button type="button" className="x-button" onClick={() => setAutoPingAccount(null)}>{s.cancel}</button>
              <button
                type="button"
                className="x-button x-primary"
                disabled={saveAutoPingMutation.isPending}
                onClick={() => saveAutoPingMutation.mutate(autoPingAccount.id)}
              >
                {saveAutoPingMutation.isPending ? s.saving : s.save}
              </button>
            </div>
          </div>
        </DialogPopup>
      </Dialog>
    )}

    {edit && <Dialog open onOpenChange={open => { if (!open && !change.isPending) setEdit(null) }}><DialogPopup className="x-console x-dialog"><DialogTitle>{s.edit}</DialogTitle><DialogDescription>{edit.label}</DialogDescription><form className="x-form" onSubmit={editSubmit}><label>{s.name}<input id="x-account-edit-label" name="label" autoFocus required maxLength={100} value={label} onChange={event => setLabel(event.target.value)} /></label><label>{s.accountProxy}<input id="x-account-edit-proxy" name="proxyUrl" value={proxyUrl} placeholder={s.accountProxyPlaceholder} onChange={event => setProxyUrl(event.target.value)} /></label><label>{p.accountPool}<select id="x-account-edit-pool" name="proxyPoolId" value={poolId} onChange={event => setPoolId(event.target.value)}><option value="">{p.accountPoolNone}</option>{poolEntries.map(entry => <option key={entry.id} value={entry.id}>{entry.name}{entry.enabled ? '' : ` (${p.disabled})`}</option>)}</select></label>{change.isError && <p className="x-error" role="alert">{change.error.message}</p>}<div className="x-dialog-actions"><button type="button" className="x-button" disabled={change.isPending} onClick={() => setEdit(null)}>{s.cancel}</button><button className="x-button x-primary" disabled={change.isPending || !label.trim()}>{change.isPending ? s.saving : s.save}</button></div></form></DialogPopup></Dialog>}
    {remove && <Dialog open onOpenChange={open => { if (!open && !change.isPending) setRemove(null) }}><DialogPopup className="x-console x-dialog"><DialogTitle>{s.removeTitle}</DialogTitle><DialogDescription>{remove.label} — {s.removeHelp}</DialogDescription>{change.isError && <p className="x-error" role="alert">{change.error.message}</p>}<div className="x-dialog-actions"><button className="x-button" disabled={change.isPending} onClick={() => setRemove(null)}><X size={14} />{s.cancel}</button><button className="x-button x-destructive" disabled={change.isPending} onClick={() => change.mutate({ type: 'remove', id: remove.id })}><Trash2 size={16} />{s.remove}</button></div></DialogPopup></Dialog>}
  </>
}
