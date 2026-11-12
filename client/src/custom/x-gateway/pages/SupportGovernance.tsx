import { useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ShieldCheck, Gauge, Users, Star, Webhook } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { useI18n } from '@/i18n'
import { useSessionRevision } from '../../session-state'
import { useUserSession } from '../../use-session'
import { useSupportGovernanceStrings } from '../support-governance-strings'

type Tab = 'guardrails' | 'quotas' | 'customers' | 'csat' | 'webhooks'
type Role = 'guest' | 'customer' | 'staff' | 'admin'
type Scope = { tenantId: number; revision: number; canEdit: boolean }
interface QuotaRule { maxRequestsPerWindow: number; maxTokensPerWindow: number; windowSeconds: number }
interface GuardrailPolicy {
  enabled: boolean; blockPromptInjection: boolean; blockedTopics: string[]; competitorKeywords: string[]
  maxInputLength: number; bypassRoles: string[]; roleQuotas: Record<string, QuotaRule>; updatedAt: string
}
interface Evaluation { allowed: boolean; blockedReason?: string; triggeredRules: string[]; matchedTerms: string[]; bypassedByRole: boolean }
interface QuotaStatus {
  allowed: boolean; reason?: string; userId: string; userRole: string; requestsUsed: number; maxRequests: number
  tokensUsed: number; maxTokens: number; windowSeconds: number; resetAt: string
}
interface Customer {
  userId: string; name?: string; email?: string; role: string; tier: string; tags: string[]; memoryFacts: string[]
  totalInteractions: number; averageCsat: number | null
}
interface CsatData {
  summary: { averageScore: number; totalRatings: number; positivePct: number; distribution: Record<string, number> }
  ratings: { id: string; userId: string; userName?: string; userRole: string; score: number; category?: string; comment?: string; createdAt: string }[]
}
type PartnerEvent = 'ticket.created' | 'ticket.resolved' | 'action.approved' | 'action.rejected' | 'csat.submitted' | 'guardrail.blocked' | 'webhook.test'
interface Subscription { id: string; name: string; targetUrl: string; events: PartnerEvent[]; enabled: boolean }
interface Delivery {
  id: string; webhookName: string; event: PartnerEvent; status: 'delivered' | 'failed'; statusCode?: number
  durationMs: number; error?: string; createdAt: string
}
const roles: Role[] = ['guest', 'customer', 'staff', 'admin']
const events: PartnerEvent[] = ['ticket.created', 'ticket.resolved', 'action.approved', 'action.rejected', 'csat.submitted', 'guardrail.blocked', 'webhook.test']
const tabs = [
  { id: 'guardrails', icon: ShieldCheck }, { id: 'quotas', icon: Gauge }, { id: 'customers', icon: Users },
  { id: 'csat', icon: Star }, { id: 'webhooks', icon: Webhook },
] as const
const split = (value: string) => [...new Set(value.split(/[,\n]/).map(s => s.trim()).filter(Boolean))]
const scopeKey = (scope: Scope) => ['x-support-governance', scope.revision, scope.tenantId] as const
const basePath = (scope: Scope) => `/api/x-gateway/support/tenants/${scope.tenantId}`
const validInteger = (value: number, min: number) => Number.isSafeInteger(value) && value >= min

function useGovQuery<T>(scope: Scope, path: string, enabled = true) {
  return useQuery({ queryKey: [...scopeKey(scope), path], enabled,
    queryFn: ({ signal }) => apiFetch<T>(`${basePath(scope)}${path}`, { signal }) })
}
function useGovMutation<T = unknown>(scope: Scope, invalidate = true) {
  const client = useQueryClient()
  return useMutation({ mutationFn: ({ path, method = 'POST', body = {} }: { path: string; method?: string; body?: unknown }) =>
    apiFetch<T>(`${basePath(scope)}${path}`, { method, body: method === 'DELETE' ? undefined : JSON.stringify(body) }),
  onSuccess: () => invalidate ? client.invalidateQueries({ queryKey: scopeKey(scope) }) : undefined })
}
function Panel({ title, children }: { title: string; children: ReactNode }) {
  return <section className="x-panel x-mgmt-card" style={{ marginBottom: 20, minWidth: 0 }}><div className="x-section-heading"><h2>{title}</h2></div>{children}</section>
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label><span>{label}</span>{children}</label>
}
function Feedback({ error, success, message }: { error?: Error | null; success?: boolean; message?: string }) {
  const s = useSupportGovernanceStrings()
  return <>{error && <p role="alert">{error.message}</p>}{success && <p role="status">{message ?? s.saved}</p>}</>
}
function QueryState({ query }: { query: { isPending: boolean; error: Error | null; refetch: () => unknown } }) {
  const s = useSupportGovernanceStrings()
  return <>{query.isPending && <p role="status">{s.loading}</p>}{query.error && <div role="alert">{query.error.message} <button className="x-button" onClick={() => void query.refetch()}>{s.retry}</button></div>}</>
}
function RoleSelect({ value, onChange, testId }: { value: string; onChange: (role: string) => void; testId?: string }) {
  const s = useSupportGovernanceStrings()
  return <Field label={s.role}><select data-testid={testId} value={value} onChange={e => onChange(e.target.value)}>
    {!roles.includes(value as Role) && <option value={value}>{value}</option>}
    {roles.map(role => <option key={role} value={role}>{s.roles[role]}</option>)}
  </select></Field>
}
function AllowedBadge({ allowed }: { allowed: boolean }) {
  const s = useSupportGovernanceStrings()
  return <span className={`x-badge ${allowed ? 'x-badge-success' : ''}`}>{allowed ? s.allowed : s.blocked}</span>
}
function DateValue({ value }: { value: string }) {
  const { locale } = useI18n()
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? <span>{value}</span> : <time dateTime={value}>{date.toLocaleString(locale === 'vi' ? 'vi-VN' : 'en-US')}</time>
}

export default function SupportGovernance() {
  const revision = useSessionRevision()
  return <GovernancePage key={revision} revision={revision} />
}
function GovernancePage({ revision }: { revision: number }) {
  const s = useSupportGovernanceStrings()
  const session = useUserSession()
  const [selected, setSelected] = useState<number | null>(null)
  const tenants = useQuery({ queryKey: ['x-support-tenants', revision],
    queryFn: ({ signal }) => apiFetch<{ tenants: { id: number; name: string }[] }>('/api/x-gateway/support/tenants', { signal }) })
  const choices = tenants.data?.tenants ?? []
  const active = choices.find(t => t.id === selected) ?? choices[0]
  return <div data-testid="support-governance">
    <div className="x-page-heading"><div><h1>{s.title}</h1><p>{s.subtitle}</p></div><div className="x-heading-icon"><ShieldCheck size={28} aria-hidden="true" /></div></div>
    <QueryState query={tenants} />
    {tenants.isSuccess && choices.length === 0 && <p className="x-empty">{s.noTenants}</p>}
    {active && <>
      <div className="x-mgmt-form"><Field label={s.tenant}><select data-testid="support-gov-tenant" value={active.id}
        onChange={e => setSelected(Number(e.target.value))}>{choices.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field></div>
      <Workspace key={active.id} tenantId={active.id} revision={revision} canEdit={session.hasPermission('edit_x_settings')} />
    </>}
  </div>
}
function Workspace(scope: Scope) {
  const s = useSupportGovernanceStrings()
  const client = useQueryClient()
  const [tab, setTab] = useState<Tab>('guardrails')
  return <>
    <div role="tablist" aria-label={s.title} className="x-media-tabs">
      {tabs.map(({ id, icon: Icon }, index) => <button key={id} role="tab" id={`support-gov-tab-${id}`} data-testid={`tab-${id}`}
        aria-selected={tab === id} aria-controls={`support-gov-panel-${id}`} tabIndex={tab === id ? 0 : -1}
        className={`x-media-tab ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)} onKeyDown={e => {
          if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return
          e.preventDefault()
          const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (index + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
          setTab(tabs[next].id)
          document.getElementById(`support-gov-tab-${tabs[next].id}`)?.focus()
        }}><Icon size={16} aria-hidden="true" />{s[id]}</button>)}
    </div>
    <div className="x-mgmt-actions"><button className="x-button" onClick={() => void client.invalidateQueries({ queryKey: scopeKey(scope) })}>{s.refresh}</button></div>
    {!scope.canEdit && <p>{s.readOnly}</p>}
    <div role="tabpanel" id={`support-gov-panel-${tab}`} aria-labelledby={`support-gov-tab-${tab}`} data-testid={`panel-${tab}`}>
      {tab === 'guardrails' && <GuardrailsTab {...scope} />}
      {tab === 'quotas' && <QuotasTab {...scope} />}
      {tab === 'customers' && <CustomersTab {...scope} />}
      {tab === 'csat' && <CsatTab {...scope} />}
      {tab === 'webhooks' && <WebhooksTab {...scope} />}
    </div>
  </>
}

function GuardrailsTab(scope: Scope) {
  const s = useSupportGovernanceStrings()
  const policy = useGovQuery<{ policy: GuardrailPolicy }>(scope, '/guardrails')
  const save = useGovMutation(scope)
  return <><Panel title={s.guardrails}><QueryState query={policy} />
    {policy.data && <FirewallEditor key={policy.data.policy.updatedAt} {...scope} policy={policy.data.policy} save={save} />}
    <Feedback error={save.error} success={save.isSuccess} />
  </Panel><FirewallTester {...scope} /></>
}
function FirewallEditor({ policy, save, ...scope }: Scope & { policy: GuardrailPolicy; save: ReturnType<typeof useGovMutation> }) {
  const s = useSupportGovernanceStrings()
  const [enabled, setEnabled] = useState(policy.enabled)
  const [blockInjection, setBlockInjection] = useState(policy.blockPromptInjection)
  const [topics, setTopics] = useState(policy.blockedTopics.join('\n'))
  const [competitors, setCompetitors] = useState(policy.competitorKeywords.join('\n'))
  const [bypass, setBypass] = useState(policy.bypassRoles.join(', '))
  const [maxLength, setMaxLength] = useState(String(policy.maxInputLength))
  const valid = validInteger(Number(maxLength), 1)
  return <form className="x-mgmt-form" onSubmit={e => { e.preventDefault(); if (!scope.canEdit || !valid || save.isPending) return
    save.mutate({ path: '/guardrails', method: 'PUT', body: { enabled, blockPromptInjection: blockInjection,
      blockedTopics: split(topics), competitorKeywords: split(competitors), maxInputLength: Number(maxLength), bypassRoles: split(bypass) } })
  }}><fieldset disabled={!scope.canEdit || save.isPending} style={{ border: 0, padding: 0, display: 'grid', gap: 12 }}>
      <label><span><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} /> {s.policyEnabled}</span></label>
      <label><span><input data-testid="block-injection" type="checkbox" checked={blockInjection} onChange={e => setBlockInjection(e.target.checked)} /> {s.blockPromptInjection}</span></label>
      <Field label={s.blockedTopics}><textarea rows={3} data-testid="blocked-topics" value={topics} onChange={e => setTopics(e.target.value)} /></Field>
      <Field label={s.competitorKeywords}><textarea rows={3} data-testid="competitor-keywords" value={competitors} onChange={e => setCompetitors(e.target.value)} /></Field><small>{s.listHelp}</small>
      <Field label={s.maxInputLength}><input type="number" min={1} step={1} required data-testid="max-input-length" value={maxLength} onChange={e => setMaxLength(e.target.value)} /></Field>
      <Field label={s.bypassRoles}><input data-testid="bypass-roles" value={bypass} onChange={e => setBypass(e.target.value)} /></Field>
      <button className="x-button x-primary" disabled={!valid} data-testid="save-guardrails">{save.isPending ? s.working : s.saveGuardrails}</button>
    </fieldset>
  </form>
}
function FirewallTester(scope: Scope) {
  const s = useSupportGovernanceStrings()
  const [role, setRole] = useState('customer')
  const [text, setText] = useState('')
  const test = useGovMutation<{ evaluation: Evaluation }>(scope, false)
  return <Panel title={s.firewallTester}>
    <form className="x-mgmt-form" onSubmit={e => { e.preventDefault(); if (text.trim() && !test.isPending) test.mutate({ path: '/guardrails/evaluate', body: { text, role } }) }}>
      <RoleSelect value={role} testId="firewall-role" onChange={value => { setRole(value); test.reset() }} />
      <Field label={s.prompt}><textarea data-testid="firewall-prompt" rows={4} required value={text} onChange={e => { setText(e.target.value); test.reset() }} /></Field>
      <button data-testid="evaluate-prompt" className="x-button x-primary" disabled={!text.trim() || test.isPending}>{test.isPending ? s.working : s.evaluate}</button>
    </form><Feedback error={test.error} />
    {test.data && <div aria-live="polite" data-testid="firewall-result"><AllowedBadge allowed={test.data.evaluation.allowed} />
      {test.data.evaluation.blockedReason && <p>{s.blockedReason}: {(s.reasons as Record<string, string>)[test.data.evaluation.blockedReason] ?? test.data.evaluation.blockedReason}</p>}
      <p>{s.triggeredRules}: {test.data.evaluation.triggeredRules.map(rule => (s.rules as Record<string, string>)[rule] ?? rule).join(', ') || s.none}</p>
      <p>{s.matchedTerms}: {test.data.evaluation.matchedTerms.join(', ') || s.none}</p>
      {test.data.evaluation.bypassedByRole && <p>{s.bypassed}</p>}
    </div>}
  </Panel>
}

function QuotasTab(scope: Scope) {
  const s = useSupportGovernanceStrings()
  const policy = useGovQuery<{ policy: GuardrailPolicy }>(scope, '/guardrails')
  const save = useGovMutation(scope)
  return <><Panel title={s.quotas}><p>{s.quotasHelp}</p><QueryState query={policy} />
    {policy.data && <QuotaEditor key={policy.data.policy.updatedAt} {...scope} policy={policy.data.policy} save={save} />}
    <Feedback error={save.error} success={save.isSuccess} />
  </Panel><QuotaInspector {...scope} /></>
}
function QuotaEditor({ policy, save, ...scope }: Scope & { policy: GuardrailPolicy; save: ReturnType<typeof useGovMutation> }) {
  const s = useSupportGovernanceStrings()
  const [draft, setDraft] = useState<Record<string, QuotaRule>>(() => Object.fromEntries(roles.map(role => [role,
    { ...(policy.roleQuotas[role] ?? { maxRequestsPerWindow: 0, maxTokensPerWindow: 0, windowSeconds: 3600 }) },
  ])))
  const valid = Object.values(draft).every(rule => validInteger(rule.maxRequestsPerWindow, 0) && validInteger(rule.maxTokensPerWindow, 0) && validInteger(rule.windowSeconds, 1))
  const fields = [{ key: 'maxRequestsPerWindow', label: s.maxRequests, min: 0 }, { key: 'maxTokensPerWindow', label: s.maxTokens, min: 0 }, { key: 'windowSeconds', label: s.windowSeconds, min: 1 }] as const
  return <form className="x-mgmt-form" onSubmit={e => { e.preventDefault(); if (!scope.canEdit || !valid || save.isPending) return
    save.mutate({ path: '/guardrails', method: 'PUT', body: { roleQuotas: { ...policy.roleQuotas, ...draft } } })
  }}><fieldset disabled={!scope.canEdit || save.isPending} style={{ border: 0, padding: 0 }}>
      <div className="x-mgmt-list">{roles.map(role => <fieldset key={role} className="x-panel x-mgmt-card"><legend>{s.roles[role]}</legend>
        {fields.map(field => <Field key={field.key} label={`${s.roles[role]} · ${field.label}`}><input type="number" min={field.min} step={1} required
          data-testid={`quota-${role}-${field.key}`} value={Number.isNaN(draft[role][field.key]) ? '' : draft[role][field.key]}
          onChange={e => setDraft({ ...draft, [role]: { ...draft[role], [field.key]: e.target.value === '' ? NaN : Number(e.target.value) } })} /></Field>)}
      </fieldset>)}</div>
      <button data-testid="save-quotas" className="x-button x-primary" disabled={!valid}>{save.isPending ? s.working : s.saveQuotas}</button>
    </fieldset>
  </form>
}
function QuotaInspector(scope: Scope) {
  const s = useSupportGovernanceStrings()
  const [userId, setUserId] = useState('')
  const [role, setRole] = useState('customer')
  const [inspected, setInspected] = useState<{ userId: string; role: string } | null>(null)
  const reset = useGovMutation(scope)
  const quota = useGovQuery<{ quota: QuotaStatus }>(scope, inspected ? `/quotas/${encodeURIComponent(inspected.userId)}?role=${encodeURIComponent(inspected.role)}` : '/quotas', inspected !== null)
  const result = quota.data?.quota
  return <Panel title={s.inspectQuota}>
    <form className="x-mgmt-form" onSubmit={e => { e.preventDefault(); if (userId.trim()) {
      if (inspected?.userId === userId.trim() && inspected.role === role) void quota.refetch()
      else setInspected({ userId: userId.trim(), role })
      reset.reset()
    } }}>
      <Field label={s.userId}><input data-testid="quota-user" required value={userId} onChange={e => { setUserId(e.target.value); setInspected(null); reset.reset() }} /></Field>
      <RoleSelect value={role} testId="quota-role" onChange={v => { setRole(v); setInspected(null); reset.reset() }} />
      <button data-testid="inspect-quota" className="x-button" disabled={!userId.trim() || (inspected !== null && quota.isFetching)}>{s.inspect}</button>
    </form>
    {inspected && <><QueryState query={quota} />{result && <div data-testid="quota-result"><p>{result.userId} · {(s.roles as Record<string, string>)[result.userRole] ?? result.userRole}</p>
      <AllowedBadge allowed={result.allowed} /><dl><dt>{s.requestsUsed}</dt><dd>{result.requestsUsed} / {result.maxRequests || s.unlimited}</dd>
        <dt>{s.tokensUsed}</dt><dd>{result.tokensUsed} / {result.maxTokens || s.unlimited}</dd>
        <dt>{s.resetsAt}</dt><dd><DateValue value={result.resetAt} /></dd></dl>
      {result.reason && <p>{s.quotaReason}: {(s.reasons as Record<string, string>)[result.reason] ?? result.reason}</p>}
      <button data-testid="reset-quota" className="x-button" disabled={!scope.canEdit || reset.isPending} onClick={() => {
        if (scope.canEdit && inspected.userId.trim()) reset.mutate({ path: '/quotas/reset', body: { userId: inspected.userId } })
      }}>{reset.isPending ? s.working : s.resetQuota}</button>
    </div>}</>}
    <Feedback error={reset.error} success={reset.isSuccess} message={s.resetDone} />
  </Panel>
}

const emptyCustomer = { userId: '', name: '', email: '', role: 'customer', tier: 'standard', tags: '' }
function CustomersTab(scope: Scope) {
  const s = useSupportGovernanceStrings()
  const customers = useGovQuery<{ customers: Customer[] }>(scope, '/customers')
  const [draft, setDraft] = useState(emptyCustomer)
  const [editing, setEditing] = useState(false)
  const save = useGovMutation(scope)
  const clear = () => { setDraft(emptyCustomer); setEditing(false) }
  return <>
    <Panel title={editing ? s.editCustomer : s.newCustomer}>
      <form className="x-mgmt-form" onSubmit={e => { e.preventDefault(); if (!scope.canEdit || !draft.userId.trim() || save.isPending) return
        save.mutate({ path: '/customers', body: { ...draft, userId: draft.userId.trim(), tags: split(draft.tags) } }, { onSuccess: clear })
      }}><fieldset disabled={!scope.canEdit || save.isPending} style={{ border: 0, padding: 0, display: 'grid', gap: 12 }}>
          <Field label={s.userId}><input data-testid="customer-user" required readOnly={editing} value={draft.userId} onChange={e => setDraft({ ...draft, userId: e.target.value })} /></Field>
          <Field label={s.name}><input data-testid="customer-name" value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></Field>
          <Field label={s.email}><input type="email" data-testid="customer-email" value={draft.email} onChange={e => setDraft({ ...draft, email: e.target.value })} /></Field>
          <RoleSelect value={draft.role} testId="customer-role" onChange={role => setDraft({ ...draft, role })} />
          <Field label={s.tier}><input data-testid="customer-tier" value={draft.tier} onChange={e => setDraft({ ...draft, tier: e.target.value })} /></Field>
          <Field label={s.tags}><input data-testid="customer-tags" value={draft.tags} onChange={e => setDraft({ ...draft, tags: e.target.value })} /></Field><small>{s.listHelp}</small>
          <div className="x-mgmt-actions"><button data-testid="save-customer" className="x-button x-primary" disabled={!draft.userId.trim()}>{save.isPending ? s.working : s.saveCustomer}</button>
            {editing && <button type="button" className="x-button" onClick={clear}>{s.cancel}</button>}</div>
        </fieldset><Feedback error={save.error} success={save.isSuccess} /></form>
    </Panel>
    <Panel title={s.customers}><QueryState query={customers} />{customers.data?.customers.length === 0 && <p>{s.empty}</p>}
      <div className="x-mgmt-list">{customers.data?.customers.map(customer => <CustomerCard key={customer.userId} {...scope} customer={customer} onEdit={() => {
        setDraft({ userId: customer.userId, name: customer.name ?? '', email: customer.email ?? '', role: customer.role, tier: customer.tier, tags: customer.tags.join(', ') }); setEditing(true); save.reset()
      }} />)}</div>
    </Panel>
  </>
}
function CustomerCard({ customer, onEdit, ...scope }: Scope & { customer: Customer; onEdit: () => void }) {
  const s = useSupportGovernanceStrings()
  const [fact, setFact] = useState('')
  const add = useGovMutation(scope)
  return <article className="x-panel x-mgmt-card" data-testid={`customer-${customer.userId}`}><h3>{customer.name || customer.userId}</h3>
    <p>{customer.userId} · {customer.email}</p><p><span className="x-badge">{(s.roles as Record<string, string>)[customer.role] ?? customer.role}</span> · {customer.tier}</p>
    <div className="x-mgmt-actions">{customer.tags.map(tag => <span className="x-badge" key={tag}>{tag}</span>)}</div>
    <p>{s.interactions}: {customer.totalInteractions} · {s.averageCsat}: {customer.averageCsat ?? s.none}</p>
    <button className="x-button" disabled={!scope.canEdit} aria-label={`${s.edit}: ${customer.userId}`} onClick={onEdit}>{s.edit}</button>
    <h4>{s.memoryFacts}</h4>{customer.memoryFacts.length ? <ul>{customer.memoryFacts.map((value, i) => <li key={i}>{value}</li>)}</ul> : <p>{s.empty}</p>}
    <form className="x-mgmt-form" onSubmit={e => { e.preventDefault(); if (scope.canEdit && fact.trim() && !add.isPending) add.mutate({
      path: `/customers/${encodeURIComponent(customer.userId)}/facts`, body: { fact: fact.trim() },
    }, { onSuccess: () => setFact('') }) }}>
      <Field label={s.newFact}><input required disabled={!scope.canEdit || add.isPending} data-testid={`fact-${customer.userId}`} value={fact} onChange={e => setFact(e.target.value)} /></Field>
      <button className="x-button" disabled={!scope.canEdit || !fact.trim() || add.isPending}>{add.isPending ? s.working : s.addFact}</button>
    </form><Feedback error={add.error} success={add.isSuccess} />
  </article>
}

function CsatTab(scope: Scope) {
  const s = useSupportGovernanceStrings()
  const query = useGovQuery<CsatData>(scope, '/csat')
  return <Panel title={s.csat}><QueryState query={query} />{query.data && <>
    <div className="x-mgmt-list">{(['averageScore', 'totalRatings', 'positivePct'] as const).map(key => <div className="x-panel x-mgmt-card" key={key} data-testid={`csat-${key}`}>
      <span>{s[key]}</span><p style={{ fontSize: 30, margin: '8px 0' }}>{query.data.summary[key]}{key === 'positivePct' ? '%' : ''}</p>
    </div>)}</div>
    <h3>{s.distribution}</h3><div className="x-table-wrap"><table className="x-table"><thead><tr><th>{s.score}</th><th>{s.count}</th></tr></thead>
      <tbody>{[5, 4, 3, 2, 1].map(score => <tr key={score} data-testid={`csat-stars-${score}`}><th scope="row">{score} ★</th><td>{query.data.summary.distribution[String(score)] ?? 0}</td></tr>)}</tbody></table></div>
    <h3>{s.recentFeedback}</h3>{query.data.ratings.length === 0 && <p>{s.empty}</p>}
    {query.data.ratings.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(rating => <article className="x-panel x-mgmt-card" key={rating.id}>
      <h4>{rating.userName ?? rating.userId} · {rating.score} ★</h4><span className="x-badge">{(s.roles as Record<string, string>)[rating.userRole] ?? rating.userRole}</span>
      {rating.category && <p>{s.category}: {rating.category}</p>}{rating.comment && <p style={{ whiteSpace: 'pre-wrap' }}>{rating.comment}</p>}
      <small>{s.submittedAt}: <DateValue value={rating.createdAt} /></small>
    </article>)}
  </>}</Panel>
}

function WebhooksTab(scope: Scope) {
  const s = useSupportGovernanceStrings()
  const query = useGovQuery<{ webhooks: Subscription[]; deliveries: Delivery[] }>(scope, '/webhooks')
  const [name, setName] = useState('')
  const [targetUrl, setTargetUrl] = useState('')
  const [selectedEvents, setSelectedEvents] = useState<PartnerEvent[]>(['webhook.test'])
  const [enabled, setEnabled] = useState(true)
  const [testEvent, setTestEvent] = useState<PartnerEvent>('webhook.test')
  const save = useGovMutation(scope)
  const remove = useGovMutation(scope)
  const ping = useGovMutation<{ deliveries: Delivery[] }>(scope)
  let validUrl = false
  try { validUrl = ['https:', 'http:'].includes(new URL(targetUrl).protocol) } catch { /* form remains disabled */ }
  const hasPingTargets = query.data?.webhooks.some(w => w.enabled && w.events.includes(testEvent)) ?? false
  return <>
    <Panel title={s.newWebhook}>
      <form className="x-mgmt-form" onSubmit={e => { e.preventDefault(); if (!scope.canEdit || !name.trim() || !validUrl || !selectedEvents.length || save.isPending) return
        save.mutate({ path: '/webhooks', body: { name: name.trim(), targetUrl: targetUrl.trim(), events: selectedEvents, enabled } },
          { onSuccess: () => { setName(''); setTargetUrl('') } })
      }}><fieldset disabled={!scope.canEdit || save.isPending} style={{ border: 0, padding: 0, display: 'grid', gap: 12 }}>
          <Field label={s.name}><input data-testid="webhook-name" required value={name} onChange={e => setName(e.target.value)} /></Field>
          <Field label={s.targetUrl}><input type="url" data-testid="webhook-url" required value={targetUrl} onChange={e => setTargetUrl(e.target.value)} /></Field>
          <label><span><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} /> {s.enabled}</span></label>
          <fieldset><legend>{s.eventsLabel}</legend>{events.map(event => <label key={event}><span><input type="checkbox" data-testid={`event-${event}`} checked={selectedEvents.includes(event)} onChange={e => setSelectedEvents(e.target.checked ? [...selectedEvents, event] : selectedEvents.filter(v => v !== event))} /> {s.events[event]}</span></label>)}</fieldset>
          <button data-testid="create-webhook" className="x-button x-primary" disabled={!name.trim() || !validUrl || !selectedEvents.length}>{save.isPending ? s.working : s.createWebhook}</button>
        </fieldset><Feedback error={save.error} success={save.isSuccess} /></form>
    </Panel>
    <Panel title={s.subscriptions}><QueryState query={query} /><Feedback error={remove.error} />
      {query.data?.webhooks.length === 0 && <p>{s.empty}</p>}
      {query.data?.webhooks.map(webhook => <article className="x-panel x-mgmt-card" key={webhook.id}><h3>{webhook.name}</h3><p style={{ overflowWrap: 'anywhere' }}>{webhook.targetUrl}</p>
        <div className="x-mgmt-actions">{webhook.events.map(event => <span className="x-badge" key={event}>{s.events[event] ?? event}</span>)}</div>
        <button className="x-button" disabled={!scope.canEdit || remove.isPending || ping.isPending} aria-label={`${s.delete}: ${webhook.name}`} onClick={() => {
          if (scope.canEdit) remove.mutate({ path: `/webhooks/${encodeURIComponent(webhook.id)}`, method: 'DELETE' })
        }}>{s.delete}</button></article>)}
    </Panel>
    <Panel title={s.testPing}><p>{s.pingHelp}</p><div className="x-mgmt-form"><Field label={s.testEvent}><select data-testid="webhook-test-event" value={testEvent} onChange={e => { setTestEvent(e.target.value as PartnerEvent); ping.reset() }}>
      {events.map(event => <option key={event} value={event}>{s.events[event]}</option>)}</select></Field>
      {!hasPingTargets && <p>{s.noPingTargets}</p>}
      <button data-testid="test-webhook" className="x-button" disabled={!scope.canEdit || !hasPingTargets || ping.isPending} onClick={() => {
        if (scope.canEdit && hasPingTargets) ping.mutate({ path: '/webhooks/test', body: { event: testEvent, payload: { test: true } } })
      }}>{ping.isPending ? s.working : s.testPing}</button></div><Feedback error={ping.error} success={ping.isSuccess} message={s.pingFinished} />
    </Panel>
    <Panel title={s.deliveries}>
      {query.data?.deliveries.length === 0 && <p>{s.empty}</p>}
      <div className="x-table-wrap"><table className="x-table"><thead><tr><th>{s.name}</th><th>{s.event}</th><th>{s.status}</th><th>{s.statusCode}</th><th>{s.durationMs}</th><th>{s.error}</th></tr></thead>
        <tbody>{query.data?.deliveries.map(delivery => <tr key={delivery.id}><th scope="row">{delivery.webhookName}</th><td>{s.events[delivery.event] ?? delivery.event}</td>
          <td><span className={`x-badge ${delivery.status === 'delivered' ? 'x-badge-success' : ''}`}>{s[delivery.status]}</span></td>
          <td>{delivery.statusCode ?? '—'}</td><td>{delivery.durationMs}</td><td style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{delivery.error ?? s.none}</td></tr>)}</tbody></table></div>
    </Panel>
  </>
}
