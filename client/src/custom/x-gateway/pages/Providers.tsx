import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowUpRight, Check, GitBranch, KeyRound, LoaderCircle, Search, Server, Waypoints } from 'lucide-react'
import { useAccounts } from '../api'
import { useXStrings } from '../strings'
import type { AccountProvider } from '../../../../../shared/x-accounts'

export function ProviderMark({ id }: { id: string }) {
  const colors: Record<string, string> = { openrouter: 'violet', 'github-copilot': 'slate', groq: 'orange', google: 'blue', nvidia: 'green', mistral: 'orange', anthropic: 'sand', custom: 'slate' }
  return <span className={`x-provider-mark ${colors[id] ?? 'blue'}`} aria-hidden="true">{id === 'github-copilot' ? <GitBranch size={26} /> : id === 'openrouter' ? <Waypoints size={27} /> : <span>{id.slice(0, 2).toUpperCase()}</span>}</span>
}

export function AccountLoadState({ error, retry }: { error?: boolean; retry?: () => void }) {
  const s = useXStrings()
  return <div className="x-empty" role={error ? 'alert' : 'status'}>{error ? <Server size={32} /> : <LoaderCircle size={30} className="x-spin" />}<p>{error ? s.loadError : s.loading}</p>{error && <button className="x-button" onClick={retry}>{s.retry}</button>}</div>
}

function ProviderCard({ provider }: { provider: AccountProvider }) {
  const s = useXStrings()
  const enabled = provider.accounts.filter(account => account.enabled).length
  const login = provider.authMethods.some(method => method !== 'api_key')
  return <Link to={`/x/providers/${encodeURIComponent(provider.id)}`} className="x-provider-card">
    <div className="x-card-top"><ProviderMark id={provider.id} /><span className={`x-badge ${provider.accounts.length ? 'x-green' : ''}`}>{provider.accounts.length ? <><span className="x-dot" />{s.connected}</> : s.available}</span></div>
    <h3>{provider.name}<ArrowUpRight size={16} /></h3>
    <p className="x-muted">{login ? (provider.id === 'github-copilot' ? s.device : s.oauth) : s.apiKey}</p>
    <div className="x-card-bottom"><span>{provider.accounts.length} {s.accounts.toLowerCase()}</span><span>{enabled > 0 ? <><Check size={13} />{enabled} {s.active.toLowerCase()}</> : <KeyRound size={14} />}</span></div>
  </Link>
}

export default function Providers() {
  const s = useXStrings()
  const query = useAccounts()
  const [search, setSearch] = useState('')
  const [connectedOnly, setConnectedOnly] = useState(false)
  if (query.isPending) return <AccountLoadState />
  if (query.isError) return <AccountLoadState error retry={() => void query.refetch()} />
  const providers = query.data.providers
  const accounts = providers.flatMap(provider => provider.accounts)
  const filtered = providers.filter(provider => (!connectedOnly || provider.accounts.length > 0) && `${provider.name} ${provider.accounts.map(account => `${account.label} ${account.identity ?? ''}`).join(' ')}`.toLowerCase().includes(search.trim().toLowerCase()))
  const login = filtered.filter(provider => provider.authMethods.some(method => method !== 'api_key'))
  const api = filtered.filter(provider => provider.authMethods.every(method => method === 'api_key'))

  return <>
    <div className="x-page-heading"><div><div className="x-eyebrow">FreeLLMAPI / X Gateway</div><h1>{s.providers}</h1><p>{s.providerHelp}</p></div><span className="x-heading-icon"><Server size={28} /></span></div>
    <div className="x-stats"><div><span>{s.connectedProviders}</span><strong>{providers.filter(provider => provider.accounts.length).length}<small> / {providers.length}</small></strong></div><div><span>{s.totalAccounts}</span><strong>{accounts.length}</strong></div><div><span>{s.enabledAccounts}</span><strong className="x-positive">{accounts.filter(account => account.enabled).length}</strong></div></div>
    <div className="x-toolbar"><label className="x-search"><Search size={18} /><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder={s.search} aria-label={s.search} /></label><div className="x-segment"><button className={!connectedOnly ? 'selected' : ''} aria-pressed={!connectedOnly} onClick={() => setConnectedOnly(false)}>{s.all}</button><button className={connectedOnly ? 'selected' : ''} aria-pressed={connectedOnly} onClick={() => setConnectedOnly(true)}>{s.connected}</button></div></div>
    {login.length > 0 && <section className="x-provider-section"><div className="x-section-heading"><h2>{s.oauthProviders}<span>{login.length}</span></h2><p>{s.oauthHelp}</p></div><div className="x-provider-grid">{login.map(provider => <ProviderCard key={provider.id} provider={provider} />)}</div></section>}
    {api.length > 0 && <section className="x-provider-section"><div className="x-section-heading"><h2>{s.apiProviders}<span>{api.length}</span></h2><p>{s.apiHelp}</p></div><div className="x-provider-grid">{api.map(provider => <ProviderCard key={provider.id} provider={provider} />)}</div></section>}
    {filtered.length === 0 && <div className="x-empty"><Search size={32} /><h2>{s.noResults}</h2><p>{s.noResultsHelp}</p></div>}
    <p className="x-footnote">{s.sharedPool}</p>
  </>
}
