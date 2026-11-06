import { useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, CircleCheck, Ellipsis, KeyRound, Pencil, Plus, RefreshCw, ShieldCheck, Trash2, Unplug, X } from 'lucide-react'
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import type { ProviderAccount } from '../../../../../shared/x-accounts'
import { accountsApi, refreshAccounts, useAccounts } from '../api'
import { useXStrings } from '../strings'
import { ConnectAccountDialog } from '../ConnectAccountDialog'
import { AccountLoadState, ProviderMark } from './Providers'

export default function ProviderAccounts() {
  const { providerId } = useParams()
  const s = useXStrings()
  const query = useAccounts()
  const client = useQueryClient()
  const [connect, setConnect] = useState<true | ProviderAccount | null>(null)
  const [edit, setEdit] = useState<ProviderAccount | null>(null)
  const [label, setLabel] = useState('')
  const [remove, setRemove] = useState<ProviderAccount | null>(null)
  const [tab, setTab] = useState<'accounts' | 'models'>('accounts')
  const [testResult, setTestResult] = useState<{ id: number; ok: boolean } | null>(null)
  const change = useMutation({
    meta: { silenceToast: true },
    mutationFn: async (action: { type: 'edit' | 'remove' | 'toggle' | 'test'; id: number; label?: string; enabled?: boolean }) => {
      if (action.type === 'test') {
        const result = await accountsApi.test(action.id)
        setTestResult({ id: action.id, ok: result.ok })
      } else if (action.type === 'remove') await accountsApi.remove(action.id)
      else await accountsApi.edit(action.id, action.type === 'toggle' ? { enabled: action.enabled } : { label: action.label })
    },
    onSuccess: async () => { setEdit(null); setRemove(null); await refreshAccounts(client) },
  })
  if (query.isPending) return <AccountLoadState />
  if (query.isError) return <AccountLoadState error retry={() => void query.refetch()} />
  const provider = query.data.providers.find(item => item.id === providerId)
  if (!provider) return <div className="x-empty"><h1>{s.providerNotFound}</h1><Link className="x-button" to="/x/providers">{s.returnProviders}</Link></div>
  const permissions = query.data.permissions
  const canConnect = permissions.add && (provider.id !== 'github-copilot' || permissions.manageModels)
  const models = Array.from(new Map(provider.accounts.flatMap(account => account.models).map(model => [model.id, model])).values())
  const count = (value: number) => value.toLocaleString()

  function editSubmit(event: FormEvent) {
    event.preventDefault()
    if (edit && label.trim()) change.mutate({ type: 'edit', id: edit.id, label: label.trim() })
  }

  return <>
    <Link to="/x/providers" className="x-back-link"><ArrowLeft size={16} />{s.providers}</Link>
    <div className="x-page-heading"><div className="x-provider-title"><ProviderMark id={provider.id} /><div><h1>{provider.name}</h1><p>{provider.accounts.length} {s.accounts.toLowerCase()} · {provider.authMethods.map(method => method === 'api_key' ? s.apiKey : method === 'device_code' ? s.device : s.oauth).join(' / ')}</p></div></div>{canConnect && provider.id !== 'custom' && <button className="x-button x-primary" onClick={() => { change.reset(); setConnect(true) }}><Plus size={16} />{s.addAccount}</button>}</div>
    {provider.id === 'github-copilot' && <p className="x-notice">{s.copilotNotice}</p>}
    {provider.id === 'custom' && <div className="x-notice">{s.customHelp} <Link to="/keys">{s.configureCustom}</Link></div>}
    {change.isError && <div className="x-error" role="alert">{change.error.message}</div>}
    <div className="x-tabs" role="tablist" aria-label={provider.name} onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const next = event.key === 'Home' ? 'accounts' : event.key === 'End' ? 'models' : tab === 'accounts' ? 'models' : 'accounts'
      setTab(next)
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next === 'accounts' ? 0 : 1]?.focus()
    }}><button id="x-accounts-tab" role="tab" aria-selected={tab === 'accounts'} aria-controls="x-accounts-panel" tabIndex={tab === 'accounts' ? 0 : -1} className={tab === 'accounts' ? 'selected' : ''} onClick={() => setTab('accounts')}>{s.accounts}<span>{provider.accounts.length}</span></button><button id="x-models-tab" role="tab" aria-selected={tab === 'models'} aria-controls="x-models-panel" tabIndex={tab === 'models' ? 0 : -1} className={tab === 'models' ? 'selected' : ''} onClick={() => setTab('models')}>{s.models}<span>{models.length}</span></button></div>
    {tab === 'accounts' ? <section id="x-accounts-panel" role="tabpanel" aria-labelledby="x-accounts-tab">
      {!provider.accounts.length && <div className="x-empty x-panel"><Unplug size={38} /><h2>{s.noAccounts}</h2><p>{s.noAccountsHelp}</p>{canConnect && provider.id !== 'custom' && <button className="x-button x-primary" onClick={() => setConnect(true)}><Plus size={16} />{s.addAccount}</button>}</div>}
      <div className="x-account-list">{provider.accounts.map(account => <article key={account.id} className={`x-account x-panel ${account.enabled ? '' : 'x-account-paused'}`}>
        <div className="x-account-top"><span className="x-account-icon"><KeyRound size={20} /></span><div className="x-account-identity"><h3>{account.label || provider.name}</h3><p>{account.identity ?? (account.authMethod === 'api_key' ? s.apiKey : s.oauth)}</p></div><span className={`x-badge ${!account.enabled ? '' : account.status === 'healthy' ? 'x-green' : account.status === 'error' ? 'x-red' : ''}`}><span className="x-dot" />{!account.enabled ? s.paused : account.status === 'healthy' ? s.healthy : account.status === 'error' ? s.needsLogin : s.unknown}</span>{permissions.edit && <button className="x-switch" role="switch" aria-checked={account.enabled} aria-label={`${account.enabled ? s.disable : s.enable}: ${account.label}`} disabled={change.isPending} onClick={() => change.mutate({ type: 'toggle', id: account.id, enabled: !account.enabled })}><span /></button>}</div>
        <div className="x-account-metrics"><div><span>{s.requests}</span><strong>{count(account.monthlyUsage.requests)}<small> / {account.monthlyRequestCap ? count(account.monthlyRequestCap) : '∞'}</small></strong></div><div><span>{s.tokens}</span><strong>{count(account.monthlyUsage.tokens)}<small> / {account.monthlyTokenCap ? count(account.monthlyTokenCap) : '∞'}</small></strong></div></div>
        <div className="x-account-actions">{permissions.test && <button className="x-button x-small" disabled={change.isPending} onClick={() => { setTestResult(null); change.mutate({ type: 'test', id: account.id }) }}><ShieldCheck size={14} />{change.isPending && change.variables?.type === 'test' && change.variables.id === account.id ? s.testing : s.test}</button>}{permissions.edit && (provider.id !== 'github-copilot' || permissions.manageModels) && account.authMethod !== 'api_key' && <button className="x-button x-small" disabled={change.isPending} onClick={() => { change.reset(); setConnect(account) }}><RefreshCw size={14} />{s.reconnect}</button>}<span className="x-spacer" />{permissions.edit && <button className="x-icon-button" aria-label={`${s.edit}: ${account.label}`} onClick={() => { change.reset(); setEdit(account); setLabel(account.label) }}><Pencil size={16} /></button>}{permissions.delete && <button className="x-icon-button x-danger" aria-label={`${s.remove}: ${account.label}`} onClick={() => { change.reset(); setRemove(account) }}><Trash2 size={16} /></button>}{!permissions.edit && !permissions.delete && <span className="x-caption">{s.readOnly}<Ellipsis size={15} /></span>}</div>
        {testResult && testResult.id === account.id && <p className={testResult.ok ? 'x-test-ok' : 'x-error'} role="status">{testResult.ok && <CircleCheck size={16} />}{testResult.ok ? s.testOk : s.testFailed}</p>}
      </article>)}</div>
      <div className="x-info-row"><ShieldCheck size={20} /><div><h3>{s.routing}</h3><p>{s.routingHelp}</p><p>{s.sharedPool}</p></div></div>
    </section> : <section id="x-models-panel" role="tabpanel" aria-labelledby="x-models-tab" className="x-panel x-model-list">{models.length ? models.map(model => <div key={model.id}><strong>{model.name}</strong><code>{model.id}</code></div>) : <p className="x-muted">{s.noModels}</p>}</section>}
    {connect && <ConnectAccountDialog provider={provider} account={connect === true ? undefined : connect} onClose={() => setConnect(null)} />}
    {edit && <Dialog open onOpenChange={open => { if (!open && !change.isPending) setEdit(null) }}><DialogPopup className="x-console x-dialog"><DialogTitle>{s.edit}</DialogTitle><DialogDescription>{edit.label}</DialogDescription><form className="x-form" onSubmit={editSubmit}><label>{s.name}<input autoFocus required maxLength={100} value={label} onChange={event => setLabel(event.target.value)} /></label>{change.isError && <p className="x-error" role="alert">{change.error.message}</p>}<div className="x-dialog-actions"><button type="button" className="x-button" disabled={change.isPending} onClick={() => setEdit(null)}>{s.cancel}</button><button className="x-button x-primary" disabled={change.isPending || !label.trim()}>{change.isPending ? s.saving : s.save}</button></div></form></DialogPopup></Dialog>}
    {remove && <Dialog open onOpenChange={open => { if (!open && !change.isPending) setRemove(null) }}><DialogPopup className="x-console x-dialog"><DialogTitle>{s.removeTitle}</DialogTitle><DialogDescription>{remove.label} — {s.removeHelp}</DialogDescription>{change.isError && <p className="x-error" role="alert">{change.error.message}</p>}<div className="x-dialog-actions"><button className="x-button" disabled={change.isPending} onClick={() => setRemove(null)}><X size={14} />{s.cancel}</button><button className="x-button x-destructive" disabled={change.isPending} onClick={() => change.mutate({ type: 'remove', id: remove.id })}><Trash2 size={14} />{s.remove}</button></div></DialogPopup></Dialog>}
  </>
}
