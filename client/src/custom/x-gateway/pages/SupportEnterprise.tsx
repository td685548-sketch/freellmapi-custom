import { useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BookOpen, ShieldCheck, Inbox, CheckCircle2, BarChart3 } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { useSessionRevision } from '../../session-state'
import { useUserSession } from '../../use-session'
import { useSupportEnterpriseStrings } from '../support-enterprise-strings'

type Tab = 'knowledge' | 'masking' | 'inbox' | 'approvals' | 'analytics'
type Scope = { tenantId: number; revision: number; canEdit: boolean }
type Detector = 'email' | 'phone' | 'credit_card' | 'api_key'
interface KnowledgeDoc {
  id: string; title: string; category: string; allowedRoles: string[]; tags: string[]; content: string; enabled: boolean
}
interface KnowledgeSearch {
  matches: { docId: string; title: string; snippet: string; score: number }[]; contextPrompt: string
}
interface MaskingPolicy {
  enabled: boolean; builtinDetectors: Detector[]; unmaskedRoles: string[]
}
interface MaskResult { masked: string; redactionCount: number; appliedRules: string[]; bypassedByRole: boolean }
interface Conversation {
  id: string; subject: string; userId: string; userName?: string; userRole: string; status: string
  messages: { id: string; senderType: string; senderName?: string; content: string }[]
}
interface Ticket { id: string; subject: string; userId: string; reason: string; status: string; priority: string }
interface PendingAction {
  id: string; toolName: string; actionSummary: string; userRole: string; userId: string
  payload: Record<string, unknown>; status: string; reviewedBy?: string; reviewNote?: string; executionResult?: unknown
}
interface Analytics {
  totalConversations: number; deflectionRatePct: number; openTickets: number; awaitingApprovalActions: number
  byRole: Record<string, number>
}
const tabs = [
  { id: 'knowledge', icon: BookOpen }, { id: 'masking', icon: ShieldCheck }, { id: 'inbox', icon: Inbox },
  { id: 'approvals', icon: CheckCircle2 }, { id: 'analytics', icon: BarChart3 },
] as const
const detectors: Detector[] = ['email', 'phone', 'credit_card', 'api_key']
const split = (value: string) => [...new Set(value.split(',').map(v => v.trim()).filter(Boolean))]
const scopeKey = (scope: Scope) => ['x-support-ops', scope.revision, scope.tenantId] as const
const basePath = (scope: Scope) => `/api/thruline/support/tenants/${scope.tenantId}`

function useOpsQuery<T>(scope: Scope, path: string) {
  return useQuery({ queryKey: [...scopeKey(scope), path],
    queryFn: ({ signal }) => apiFetch<T>(`${basePath(scope)}${path}`, { signal }) })
}
function useOpsMutation<T = unknown>(scope: Scope, invalidate = true) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ path, method = 'POST', body = {} }: { path: string; method?: string; body?: unknown }) =>
      apiFetch<T>(`${basePath(scope)}${path}`, { method, body: method === 'DELETE' ? undefined : JSON.stringify(body) }),
    onSuccess: () => invalidate ? client.invalidateQueries({ queryKey: scopeKey(scope) }) : undefined,
  })
}
function Panel({ title, children }: { title: string; children: ReactNode }) {
  return <section className="x-panel x-mgmt-card" style={{ marginBottom: 20, minWidth: 0 }}><div className="x-section-heading"><h2>{title}</h2></div>{children}</section>
}
function Feedback({ error, success }: { error?: Error | null; success?: boolean }) {
  const s = useSupportEnterpriseStrings()
  return <>{error && <p role="alert">{error.message}</p>}{success && <p role="status">{s.saved}</p>}</>
}
function QueryState({ query }: { query: { isPending: boolean; error: Error | null; refetch: () => unknown } }) {
  const s = useSupportEnterpriseStrings()
  return <>{query.isPending && <p role="status">{s.loading}</p>}{query.error && <div role="alert">{query.error.message} <button className="x-button" onClick={() => void query.refetch()}>{s.retry}</button></div>}</>
}
function RoleSelect({ value, onChange }: { value: string; onChange: (role: string) => void }) {
  const s = useSupportEnterpriseStrings()
  return <label>{s.role}<select value={value} onChange={e => onChange(e.target.value)}>
    {Object.entries(s.roles).map(([role, label]) => <option key={role} value={role}>{label}</option>)}
  </select></label>
}
function Badge({ value, kind = 'statuses' }: { value: string; kind?: 'statuses' | 'priorities' | 'roles' }) {
  const s = useSupportEnterpriseStrings()
  const labels: Record<string, string> = s[kind]
  return <span className="x-badge">{labels[value] ?? value}</span>
}
function Pre({ children }: { children: ReactNode }) {
  return <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 360, overflow: 'auto' }}>{children}</pre>
}

export default function SupportEnterprise() {
  const revision = useSessionRevision()
  return <EnterprisePage key={revision} revision={revision} />
}
function EnterprisePage({ revision }: { revision: number }) {
  const s = useSupportEnterpriseStrings()
  const session = useUserSession()
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const tenants = useQuery({ queryKey: ['x-support-tenants', revision],
    queryFn: ({ signal }) => apiFetch<{ tenants: { id: number; name: string }[] }>('/api/thruline/support/tenants', { signal }) })
  const choices = tenants.data?.tenants ?? []
  const active = choices.find(t => t.id === selectedId) ?? choices[0]
  return <div data-testid="support-enterprise">
    <div className="x-page-heading"><div><h1>{s.title}</h1><p>{s.subtitle}</p></div><div className="x-heading-icon"><HeadsetIcon /></div></div>
    <QueryState query={tenants} />
    {tenants.isSuccess && choices.length === 0 && <p className="x-empty">{s.noTenants}</p>}
    {active && <>
      <div className="x-mgmt-form"><label>{s.tenant}<select data-testid="support-ops-tenant" value={active.id}
        onChange={e => setSelectedId(Number(e.target.value))}>{choices.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label></div>
      <TenantWorkspace key={active.id} tenantId={active.id} revision={revision} canEdit={session.hasPermission('edit_x_settings')} />
    </>}
  </div>
}
function HeadsetIcon() { return <Inbox size={28} aria-hidden="true" /> }
function TenantWorkspace(scope: Scope) {
  const s = useSupportEnterpriseStrings()
  const client = useQueryClient()
  const [tab, setTab] = useState<Tab>('knowledge')
  return <>
    <div className="x-media-tabs" role="tablist" aria-label={s.title}>
      {tabs.map(({ id, icon: Icon }) => <button key={id} id={`support-ops-tab-${id}`} data-testid={`tab-${id}`} role="tab"
        aria-selected={tab === id} aria-controls={`support-ops-panel-${id}`} className={`x-media-tab ${tab === id ? 'active' : ''}`}
        onClick={() => setTab(id)}><Icon size={16} aria-hidden="true" />{s[id]}</button>)}
    </div>
    <div className="x-mgmt-actions"><button className="x-button" onClick={() => void client.invalidateQueries({ queryKey: scopeKey(scope) })}>{s.refresh}</button></div>
    <div role="tabpanel" id={`support-ops-panel-${tab}`} aria-labelledby={`support-ops-tab-${tab}`} data-testid={`panel-${tab}`}>
      {tab === 'knowledge' && <KnowledgeTab {...scope} />}
      {tab === 'masking' && <MaskingTab {...scope} />}
      {tab === 'inbox' && <InboxTab {...scope} />}
      {tab === 'approvals' && <ApprovalsTab {...scope} />}
      {tab === 'analytics' && <AnalyticsTab {...scope} />}
    </div>
  </>
}

const emptyDoc = { title: '', category: 'faq', allowedRoles: '*', tags: '', content: '' }
function KnowledgeTab(scope: Scope) {
  const s = useSupportEnterpriseStrings()
  const docs = useOpsQuery<{ docs: KnowledgeDoc[] }>(scope, '/knowledge')
  const write = useOpsMutation(scope)
  const search = useOpsMutation<KnowledgeSearch>(scope, false)
  const [editingId, setEditingId] = useState<string | undefined>()
  const [draft, setDraft] = useState(emptyDoc)
  const [role, setRole] = useState('guest')
  const [query, setQuery] = useState('')
  const resetDraft = () => { setDraft(emptyDoc); setEditingId(undefined) }
  return <>
    <Panel title={s.knowledge}>
      <p>{s.knowledgeHelp}</p>
      {!scope.canEdit && <p>{s.readOnly}</p>}
      <button className="x-button" disabled={!scope.canEdit || write.isPending} onClick={() => write.mutate({ path: '/knowledge/seed' })}>{s.seed}</button>
      <Feedback error={write.error} success={write.isSuccess} />
      <QueryState query={docs} />
      {docs.data?.docs.length === 0 && <p>{s.empty}</p>}
      <div className="x-mgmt-list">{docs.data?.docs.map(doc => <article className="x-panel x-mgmt-card" key={doc.id}>
        <h3>{doc.title}</h3><p>{doc.category}</p><div className="x-mgmt-actions">{doc.allowedRoles.map(role => <Badge key={role} value={role} kind="roles" />)}</div>
        <div className="x-mgmt-actions"><button className="x-button" disabled={!scope.canEdit || write.isPending} aria-label={`${s.edit}: ${doc.title}`} onClick={() => {
          setEditingId(doc.id); setDraft({ title: doc.title, category: doc.category, allowedRoles: doc.allowedRoles.join(', '), tags: doc.tags.join(', '), content: doc.content }); write.reset()
        }}>{s.edit}</button>
          <button className="x-button" disabled={!scope.canEdit || write.isPending} aria-label={`${s.delete}: ${doc.title}`} onClick={() => write.mutate({ path: `/knowledge/${encodeURIComponent(doc.id)}`, method: 'DELETE' }, {
            onSuccess: () => { if (editingId === doc.id) resetDraft() },
          })}>{s.delete}</button></div>
      </article>)}</div>
    </Panel>
    <Panel title={editingId ? s.editDoc : s.newDoc}>
      <form className="x-mgmt-form" onSubmit={e => { e.preventDefault(); if (!scope.canEdit || write.isPending) return
        write.mutate({ path: '/knowledge', body: { id: editingId, title: draft.title.trim(), category: draft.category.trim(),
          content: draft.content, allowedRoles: split(draft.allowedRoles), tags: split(draft.tags) } }, { onSuccess: resetDraft })
      }}>
        <fieldset disabled={!scope.canEdit || write.isPending} style={{ border: 0, padding: 0, display: 'grid', gap: 12 }}>
          <label>{s.titleLabel}<input required value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })} /></label>
          <label>{s.category}<input value={draft.category} onChange={e => setDraft({ ...draft, category: e.target.value })} /></label>
          <label>{s.allowedRoles}<input aria-describedby="ops-roles-help" value={draft.allowedRoles} onChange={e => setDraft({ ...draft, allowedRoles: e.target.value })} /></label><small id="ops-roles-help">{s.rolesHelp}</small>
          <label>{s.tags}<input aria-describedby="ops-tags-help" value={draft.tags} onChange={e => setDraft({ ...draft, tags: e.target.value })} /></label><small id="ops-tags-help">{s.tagsHelp}</small>
          <label>{s.content}<textarea rows={7} required value={draft.content} onChange={e => setDraft({ ...draft, content: e.target.value })} /></label>
          <div className="x-mgmt-actions"><button className="x-button x-primary" disabled={!draft.title.trim() || !draft.content.trim()}>{write.isPending ? s.saving : s.saveDoc}</button>
            {editingId && <button type="button" className="x-button" onClick={resetDraft}>{s.cancel}</button>}</div>
        </fieldset>
      </form>
    </Panel>
    <Panel title={s.ragTester}>
      <form className="x-mgmt-form" onSubmit={e => { e.preventDefault(); if (query.trim() && !search.isPending) search.mutate({ path: '/knowledge/search', body: { query: query.trim(), role } }) }}>
        <RoleSelect value={role} onChange={v => { setRole(v); search.reset() }} />
        <label>{s.query}<input required value={query} onChange={e => { setQuery(e.target.value); search.reset() }} /></label>
        <button className="x-button x-primary" disabled={!query.trim() || search.isPending}>{search.isPending ? s.saving : s.search}</button>
      </form><Feedback error={search.error} />
      {search.data && <div aria-live="polite"><h3>{s.matches}</h3>{search.data.matches.length === 0 && <p>{s.noMatches}</p>}
        {search.data.matches.map((match, index) => <article key={`${match.docId}-${index}`}><h4>{match.title}</h4><p style={{ whiteSpace: 'pre-wrap' }}>{match.snippet}</p></article>)}
        <h3>{s.contextPrompt}</h3><Pre>{search.data.contextPrompt}</Pre></div>}
    </Panel>
  </>
}

function MaskingTab(scope: Scope) {
  const policy = useOpsQuery<{ policy: MaskingPolicy }>(scope, '/masking')
  return <><QueryState query={policy} />{policy.data && <MaskingEditor key={scope.tenantId} {...scope} policy={policy.data.policy} />}
    <MaskingTester {...scope} /></>
}
function MaskingEditor({ policy, ...scope }: Scope & { policy: MaskingPolicy }) {
  const s = useSupportEnterpriseStrings()
  const [draft, setDraft] = useState(policy)
  const [unmaskedRoles, setUnmaskedRoles] = useState(policy.unmaskedRoles.join(', '))
  const save = useOpsMutation(scope)
  return <Panel title={s.masking}><p>{s.maskingHelp}</p>{!scope.canEdit && <p>{s.readOnly}</p>}
    <form className="x-mgmt-form" onSubmit={e => { e.preventDefault(); if (!scope.canEdit || save.isPending) return
      save.mutate({ path: '/masking', method: 'PUT', body: { enabled: draft.enabled, builtinDetectors: draft.builtinDetectors, unmaskedRoles: split(unmaskedRoles) } })
    }}><fieldset disabled={!scope.canEdit || save.isPending} style={{ border: 0, padding: 0 }}>
        <label><span><input type="checkbox" checked={draft.enabled} onChange={e => setDraft({ ...draft, enabled: e.target.checked })} /> {s.policyEnabled}</span></label>
        <fieldset><legend>{s.detectors}</legend>{detectors.map(detector => <label key={detector}><span><input type="checkbox" checked={draft.builtinDetectors.includes(detector)} onChange={e => setDraft({ ...draft,
          builtinDetectors: e.target.checked ? [...draft.builtinDetectors, detector] : draft.builtinDetectors.filter(d => d !== detector),
        })} /> {s[detector]}</span></label>)}</fieldset>
        <label>{s.unmaskedRoles}<input value={unmaskedRoles} onChange={e => setUnmaskedRoles(e.target.value)} /></label>
        <button className="x-button x-primary">{save.isPending ? s.saving : s.savePolicy}</button>
      </fieldset></form><Feedback error={save.error} success={save.isSuccess} />
  </Panel>
}
function MaskingTester(scope: Scope) {
  const s = useSupportEnterpriseStrings()
  const [role, setRole] = useState('customer')
  const [text, setText] = useState('')
  const test = useOpsMutation<{ result: MaskResult }>(scope, false)
  return <Panel title={s.maskingTester}>
    <form className="x-mgmt-form" onSubmit={e => { e.preventDefault(); if (text.trim() && !test.isPending) test.mutate({ path: '/masking/test', body: { text, role } }) }}>
      <RoleSelect value={role} onChange={v => { setRole(v); test.reset() }} />
      <label>{s.sampleText}<textarea required rows={4} value={text} onChange={e => { setText(e.target.value); test.reset() }} /></label>
      <button className="x-button x-primary" disabled={!text.trim() || test.isPending}>{test.isPending ? s.saving : s.testMasking}</button>
    </form><Feedback error={test.error} />
    {test.data && <div aria-live="polite"><h3>{s.maskedOutput}</h3><Pre>{test.data.result.masked}</Pre>
      <p>{s.redactionCount}: {test.data.result.redactionCount}</p><p>{s.appliedRules}: {test.data.result.appliedRules.join(', ') || s.noRules}</p>
      {test.data.result.bypassedByRole && <p>{s.bypassed}</p>}</div>}
  </Panel>
}

function InboxTab(scope: Scope) {
  const s = useSupportEnterpriseStrings()
  const conversations = useOpsQuery<{ conversations: Conversation[] }>(scope, '/conversations')
  const tickets = useOpsQuery<{ tickets: Ticket[] }>(scope, '/tickets')
  const update = useOpsMutation(scope)
  return <>
    <Panel title={s.conversations}><QueryState query={conversations} />
      {conversations.data?.conversations.length === 0 && <p>{s.empty}</p>}
      {conversations.data?.conversations.map(conversation => <ConversationCard key={conversation.id} {...scope} conversation={conversation} />)}
    </Panel>
    <Panel title={s.tickets}><QueryState query={tickets} /><Feedback error={update.error} success={update.isSuccess} />
      {tickets.data?.tickets.length === 0 && <p>{s.empty}</p>}
      {tickets.data?.tickets.map(ticket => <article key={ticket.id} className="x-panel x-mgmt-card">
        <h3>{ticket.subject}</h3><p>{ticket.userId}</p><div className="x-mgmt-actions"><span>{s.status}: <Badge value={ticket.status} /></span><span>{s.priority}: <Badge kind="priorities" value={ticket.priority} /></span></div>
        <p>{s.reason}: {ticket.reason}</p><div className="x-mgmt-actions">
          <button className="x-button" disabled={update.isPending || ticket.status === 'in_progress' || ticket.status === 'resolved' || ticket.status === 'closed'} onClick={() => update.mutate({ path: `/tickets/${encodeURIComponent(ticket.id)}`, method: 'PATCH', body: { status: 'in_progress' } })}>{s.markInProgress}</button>
          <button className="x-button" disabled={update.isPending || ticket.status === 'resolved' || ticket.status === 'closed'} onClick={() => update.mutate({ path: `/tickets/${encodeURIComponent(ticket.id)}`, method: 'PATCH', body: { status: 'resolved' } })}>{s.markResolved}</button>
        </div></article>)}
    </Panel>
  </>
}
function ConversationCard({ conversation, ...scope }: Scope & { conversation: Conversation }) {
  const s = useSupportEnterpriseStrings()
  const session = useUserSession()
  const [content, setContent] = useState('')
  const [agentName, setAgentName] = useState(session.session?.email ?? '')
  const [resolve, setResolve] = useState(false)
  const reply = useOpsMutation(scope)
  return <article className="x-panel x-mgmt-card"><h3>{conversation.subject}</h3>
    <p>{conversation.userName ?? conversation.userId} · <Badge value={conversation.userRole} kind="roles" /> · <Badge value={conversation.status} /></p>
    <div className="x-chat">{conversation.messages.map(message => <div className="x-chat-turn" key={message.id}>
      <small>{message.senderName ?? (s.senders as Record<string, string>)[message.senderType] ?? message.senderType}</small><Pre>{message.content}</Pre>
    </div>)}</div>
    <form className="x-mgmt-form" aria-label={conversation.subject} onSubmit={e => { e.preventDefault(); if (!content.trim() || reply.isPending) return
      reply.mutate({ path: `/conversations/${encodeURIComponent(conversation.id)}/reply`, body: { agentName: agentName.trim() || undefined, content: content.trim(), resolveConversation: resolve } }, { onSuccess: () => setContent('') })
    }}>
      <label>{s.agentName}<input value={agentName} onChange={e => setAgentName(e.target.value)} /></label>
      <label>{s.reply}<textarea required rows={3} value={content} onChange={e => setContent(e.target.value)} /></label>
      <label><span><input type="checkbox" checked={resolve} onChange={e => setResolve(e.target.checked)} /> {s.resolveConversation}</span></label>
      <button className="x-button x-primary" disabled={!content.trim() || reply.isPending}>{reply.isPending ? s.saving : s.sendReply}</button>
    </form><Feedback error={reply.error} success={reply.isSuccess} />
  </article>
}

function ApprovalsTab(scope: Scope) {
  const s = useSupportEnterpriseStrings()
  const actions = useOpsQuery<{ actions: PendingAction[] }>(scope, '/actions')
  return <Panel title={s.approvals}><p>{s.approvalsHelp}</p><QueryState query={actions} />
    {actions.data?.actions.length === 0 && <p>{s.empty}</p>}
    {actions.data?.actions.map(action => <ActionCard key={action.id} {...scope} action={action} />)}
  </Panel>
}
function ActionCard({ action, ...scope }: Scope & { action: PendingAction }) {
  const s = useSupportEnterpriseStrings()
  const session = useUserSession()
  const [reviewNote, setReviewNote] = useState('')
  const review = useOpsMutation(scope)
  const decide = (decision: 'approve' | 'reject') => review.mutate({ path: `/actions/${encodeURIComponent(action.id)}/${decision}`,
    body: { reviewedBy: session.session?.email, reviewNote: reviewNote.trim() } })
  return <article className="x-panel x-mgmt-card"><h3>{action.toolName}</h3><p>{action.actionSummary}</p>
    <p>{action.userId} · {s.userRole}: <Badge value={action.userRole} kind="roles" /> · <Badge value={action.status} /></p>
    <h4>{s.payload}</h4><Pre>{JSON.stringify(action.payload, null, 2)}</Pre>
    {action.status === 'pending' ? <div className="x-mgmt-form"><label>{s.reviewNote}<textarea value={reviewNote} onChange={e => setReviewNote(e.target.value)} /></label>
      <div className="x-mgmt-actions"><button className="x-button x-primary" disabled={review.isPending} onClick={() => decide('approve')}>{s.approve}</button>
        <button className="x-button" disabled={review.isPending} onClick={() => decide('reject')}>{s.reject}</button></div></div>
      : <>{action.reviewedBy && <p>{s.reviewedBy}: {action.reviewedBy}</p>}{action.reviewNote && <p>{s.reviewNote}: {action.reviewNote}</p>}</>}
    {action.executionResult !== undefined && <><h4>{s.executionResult}</h4><Pre>{JSON.stringify(action.executionResult, null, 2)}</Pre></>}
    <Feedback error={review.error} success={review.isSuccess} />
  </article>
}
function AnalyticsTab(scope: Scope) {
  const s = useSupportEnterpriseStrings()
  const query = useOpsQuery<{ analytics: Analytics }>(scope, '/analytics')
  return <Panel title={s.analytics}><p>{s.analyticsHelp}</p><QueryState query={query} />
    {query.data && <>
      <div className="x-mgmt-list">{(['totalConversations', 'deflectionRatePct', 'openTickets', 'awaitingApprovalActions'] as const).map(key => <div className="x-panel x-mgmt-card" key={key} data-testid={`kpi-${key}`}>
        <span>{s[key]}</span><p style={{ fontSize: 30, margin: '8px 0', fontVariantNumeric: 'tabular-nums' }}>{query.data.analytics[key]}{key === 'deflectionRatePct' ? '%' : ''}</p>
      </div>)}</div>
      <h3>{s.byRole}</h3>{Object.keys(query.data.analytics.byRole).length === 0 ? <p>{s.empty}</p>
        : <table className="x-table"><thead><tr><th>{s.role}</th><th>{s.count}</th></tr></thead><tbody>{Object.entries(query.data.analytics.byRole).map(([role, count]) => <tr key={role}>
          <td><Badge value={role} kind="roles" /></td><td>{count}</td></tr>)}</tbody></table>}
    </>}
  </Panel>
}
