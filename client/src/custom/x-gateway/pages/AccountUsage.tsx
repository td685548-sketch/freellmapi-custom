import { Link } from 'react-router-dom'
import { BarChart3 } from 'lucide-react'
import { useAccounts } from '../api'
import { useXStrings } from '../strings'
import { AccountLoadState } from './Providers'

export default function AccountUsage() {
  const s = useXStrings()
  const query = useAccounts()
  if (query.isPending) return <AccountLoadState />
  if (query.isError) return <AccountLoadState error retry={() => void query.refetch()} />
  const accounts = query.data.providers.flatMap(provider => provider.accounts.map(account => ({ ...account, providerName: provider.name })))
  return <>
    <div className="x-page-heading"><div><h1>{s.usage}</h1><p>{s.usageHelp}</p></div><span className="x-heading-icon"><BarChart3 size={28} /></span></div>
    <div className="x-stats"><div><span>{s.totalAccounts}</span><strong>{accounts.length}</strong></div><div><span>{s.requests}</span><strong>{accounts.reduce((sum, account) => sum + account.monthlyUsage.requests, 0).toLocaleString()}</strong></div><div><span>{s.tokens}</span><strong>{accounts.reduce((sum, account) => sum + account.monthlyUsage.tokens, 0).toLocaleString()}</strong></div></div>
    <div className="x-panel x-table-wrap"><table className="x-table"><thead><tr><th>{s.accounts}</th><th>{s.providers}</th><th>{s.requests}</th><th>{s.tokens}</th></tr></thead><tbody>{accounts.map(account => <tr key={account.id}><th><Link to={`/x/providers/${encodeURIComponent(account.provider)}`}>{account.label || account.providerName}</Link></th><td>{account.providerName}</td><td>{account.monthlyUsage.requests.toLocaleString()}<small> / {account.monthlyRequestCap || '∞'}</small></td><td>{account.monthlyUsage.tokens.toLocaleString()}<small> / {account.monthlyTokenCap || '∞'}</small></td></tr>)}</tbody></table>{!accounts.length && <div className="x-empty"><p>{s.noAccounts}</p><Link className="x-button" to="/x/providers">{s.addAccount}</Link></div>}</div>
  </>
}
