import { subscriptionApi } from './subscription-api'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { CheckCircle2, LoaderCircle, TriangleAlert } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { accountsApi, refreshAccounts } from './api'
import { useXStrings } from './strings'

export function AccountCallback() {
  const s = useXStrings()
  const client = useQueryClient()
  const [params] = useState(() => new URLSearchParams(window.location.search))
  const subscriptionCallback = params.get('state')?.startsWith('sub_') === true
  const [state, setState] = useState<'pending' | 'connected' | 'error'>('pending')
  const completion = useRef<Promise<unknown> | null>(null)
  useEffect(() => {
    const subscriptionId = params.get('state')?.startsWith('sub_') ? params.get('state') : null
    const attemptId = subscriptionId ?? params.get('attemptId')
    const code = params.get('code')
    window.history.replaceState(window.history.state, '', window.location.pathname)
    if (!attemptId || !code || params.has('error')) { setState('error'); return }
    let active = true
    completion.current ??= subscriptionId ? subscriptionApi.complete(attemptId, window.location.origin + window.location.pathname + '?' + params.toString()) : accountsApi.complete(attemptId, code)
    void completion.current.then(() => {
      if (!active) return
      setState('connected')
      void refreshAccounts(client)
      if (typeof BroadcastChannel !== 'undefined') {
        const channel = new BroadcastChannel('x-provider-connections')
        channel.postMessage({ attemptId, status: 'connected' })
        channel.close()
      }
    }).catch(() => { if (active) setState('error') })
    return () => { active = false }
  }, [params, client])

  return <div className="x-empty x-callback" role="status">
    {state === 'pending' ? <LoaderCircle className="x-spin" size={36} /> : state === 'connected' ? <CheckCircle2 size={36} /> : <TriangleAlert size={36} />}
    <h1>{state === 'pending' ? s.connecting : state === 'connected' ? (subscriptionCallback ? 'Credentials saved' : s.connectionDone) : s.error}</h1>
    <p>{state === 'connected' ? (subscriptionCallback ? 'Upstream inference is unverified. Run an account test with an eligible model.' : s.callbackDone) : state === 'error' ? s.callbackError : s.encrypted}</p>
    <Link className="x-button" to="/thruline/providers">{s.returnProviders}</Link>
  </div>
}
