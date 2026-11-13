import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight, BarChart3, Check, Copy, Layers, Scissors, ScrollText, Server, Terminal } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { useUserSession } from '../../use-session'
import { useSessionRevision } from '../../session-state'
import { useAccounts } from '../api'
import { useShellStrings } from '../shell-strings'

/**
 * Landing page: a setup checklist driven by the same read-only endpoints the
 * Endpoint and Providers pages already use, plus shortcuts to common tasks.
 */
export default function Overview() {
  const sh = useShellStrings()
  const session = useUserSession()
  const revision = useSessionRevision()
  const canView = session.hasPermission('view_keys')
  const [copied, setCopied] = useState(false)
  // Query keys match Endpoint.tsx so both pages share one cache entry.
  const status = useQuery({
    queryKey: ['x-gateway-status', revision],
    queryFn: ({ signal }) => apiFetch<{ enabled: boolean }>('/api/x-gateway/status', { signal }),
    retry: false,
  })
  const keys = useQuery({
    queryKey: ['x-gateway-client-keys', revision],
    queryFn: ({ signal }) => apiFetch<{ keys: unknown[] }>('/api/x-gateway/keys', { signal }),
    retry: false,
  })
  const accounts = useAccounts(canView)

  const providers = accounts.data?.providers ?? []
  const all = providers.flatMap(provider => provider.accounts)
  const enabled = all.filter(account => account.enabled)
  const attention = enabled.filter(account => account.status === 'error').length
  const connected = providers.filter(provider => provider.accounts.length > 0).length
  const keyCount = keys.data?.keys.length

  const base = new URL(`${import.meta.env.BASE_URL}thruline/v1`, window.location.origin).href
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(base)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch { /* the address stays selectable */ }
  }

  // `undefined` means the answer is not known (still loading, or no permission to read it).
  const steps: Array<{ title: string; help: string; action: string; to: string; done: boolean | undefined }> = [
    { title: sh.stepGateway, help: sh.stepGatewayHelp, action: sh.stepGatewayAction, to: '/thruline/endpoint', done: status.data?.enabled },
    ...(canView ? [{ title: sh.stepAccount, help: sh.stepAccountHelp, action: sh.stepAccountAction, to: '/thruline/providers', done: accounts.data ? enabled.length > 0 : undefined }] : []),
    { title: sh.stepKey, help: sh.stepKeyHelp, action: sh.stepKeyAction, to: '/thruline/endpoint', done: keyCount === undefined ? undefined : keyCount > 0 },
  ]
  const doneCount = steps.filter(step => step.done).length
  const ready = doneCount === steps.length
  const next = steps.findIndex(step => step.done === false)

  const tasks = [
    ...(canView ? [{ to: '/thruline/providers', icon: Server, title: sh.taskProviders, help: sh.taskProvidersHelp }] : []),
    ...(canView ? [{ to: '/thruline/combos', icon: Layers, title: sh.taskCombos, help: sh.taskCombosHelp }] : []),
    { to: '/thruline/tools', icon: Terminal, title: sh.taskTools, help: sh.taskToolsHelp },
    { to: '/thruline/savers', icon: Scissors, title: sh.taskSavers, help: sh.taskSaversHelp },
    ...(canView ? [{ to: '/thruline/usage', icon: BarChart3, title: sh.taskUsage, help: sh.taskUsageHelp }] : []),
    ...(canView ? [{ to: '/thruline/logs', icon: ScrollText, title: sh.taskLogs, help: sh.taskLogsHelp }] : []),
  ]

  return <div className="x-overview">
    <div className="x-page-heading"><div><h1>{sh.welcome}</h1><p>{sh.welcomeHelp}</p></div></div>

    <div className="x-overview-grid">
      <section className="x-panel x-setup" aria-labelledby="x-setup-title">
        <header className="x-setup-head">
          <h2 id="x-setup-title">{sh.setup}</h2>
          <span className="x-muted">{sh.setupProgress(doneCount, steps.length)}</span>
        </header>
        <div className="x-progress" role="progressbar" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={doneCount} aria-labelledby="x-setup-title">
          <span style={{ width: `${(doneCount / steps.length) * 100}%` }} />
        </div>
        <ol className="x-steps">
          {steps.map((step, index) => <li key={step.title} className={step.done ? 'done' : index === next ? 'next' : ''}>
            <span className="x-step-mark" aria-hidden="true">{step.done ? <Check size={14} /> : index + 1}</span>
            <div className="x-step-body">
              <strong>{step.title}</strong>
              <span className="x-muted">{step.help}</span>
            </div>
            {step.done
              ? <span className="x-badge x-green">{sh.done}</span>
              : <Link to={step.to} className={`x-button x-small ${index === next ? 'x-primary' : ''}`}>{step.action}<ArrowRight size={14} /></Link>}
          </li>)}
          <li className={ready ? 'next' : ''}>
            <span className="x-step-mark" aria-hidden="true">{steps.length + 1}</span>
            <div className="x-step-body"><strong>{sh.stepTry}</strong><span className="x-muted">{sh.stepTryHelp}</span></div>
            <Link to="/thruline/playground" className={`x-button x-small ${ready ? 'x-primary' : ''}`}>{sh.stepTryAction}<ArrowRight size={14} /></Link>
          </li>
        </ol>
        {ready && <p className="x-test-ok x-setup-done" role="status"><Check size={15} />{sh.setupDone}</p>}
      </section>

      <div className="x-overview-side">
        <section className="x-panel x-overview-card" aria-labelledby="x-base-title">
          <h2 id="x-base-title">{sh.baseUrl}</h2>
          <p className="x-muted">{sh.baseUrlHelp}</p>
          <div className="x-code-line"><code>{base}</code>
            <button type="button" className="x-button x-small" onClick={() => void copy()}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? sh.copied : sh.copy}</button>
          </div>
        </section>
        <section className="x-panel x-overview-card" aria-labelledby="x-glance-title">
          <h2 id="x-glance-title">{sh.atAGlance}</h2>
          <dl className="x-glance">
            {canView && <div><dt>{sh.statProviders}</dt><dd>{accounts.data ? connected : '–'}</dd></div>}
            {canView && <div><dt>{sh.statAccounts}</dt><dd>{accounts.data ? enabled.length : '–'}</dd></div>}
            {canView && <div><dt>{sh.statAttention}</dt><dd className={attention > 0 ? 'x-glance-warn' : ''}>{accounts.data ? attention : '–'}</dd></div>}
            <div><dt>{sh.statKeys}</dt><dd>{keyCount ?? '–'}</dd></div>
          </dl>
        </section>
      </div>
    </div>

    <section aria-labelledby="x-tasks-title">
      <h2 id="x-tasks-title" className="x-overview-title">{sh.shortcuts}</h2>
      <div className="x-task-grid">
        {tasks.map(task => <Link key={task.to} to={task.to} className="x-task">
          <task.icon size={18} />
          <span><strong>{task.title}</strong><small>{task.help}</small></span>
          <ArrowRight size={15} className="x-task-arrow" />
        </Link>)}
      </div>
    </section>
  </div>
}
