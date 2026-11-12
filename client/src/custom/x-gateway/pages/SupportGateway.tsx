import { useState, useMemo, type FormEvent } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Headset,
  ShieldCheck,
  Plus,
  Trash2,
  RefreshCw,
  Copy,
  Check,
  Database,
  Webhook,
  Terminal,
  Code2,
  Bot,
  User,
  Users,
  Send,
  Play,
  KeyRound,
  CheckCircle2,
  Lock,
  Unlock,
  Globe,
  Sparkles,
  X,
  Sliders,
} from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { useUserSession } from '../../use-session'
import { useSessionRevision } from '../../session-state'
import { useSupportStrings } from '../support-strings'

// ---------------------------------------------------------------------------
// TypeScript Interfaces
// ---------------------------------------------------------------------------

export interface SupportRoleConfig {
  role: string;
  label: string;
  description?: string;
  permissions: string[];
}

export interface SupportTenant {
  id: number;
  name: string;
  slug: string;
  publicKey: string;
  signingSecretMasked: string;
  defaultModel: string;
  systemPrompt: string;
  allowedOrigins: string[];
  allowGuest: boolean;
  rolesConfig: SupportRoleConfig[];
  enabled: boolean;
  createdBy: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface SupportWebhookTool {
  id: number;
  tenantId: number;
  name: string;
  description: string;
  method: 'GET' | 'POST';
  endpointUrl: string;
  headers: Record<string, string>;
  parametersSchema: Record<string, unknown>;
  allowedRoles: string[];
  lockUserIdParam: string | null;
  bypassUserLockRoles: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SupportTablePolicy {
  tableName: string;
  description?: string;
  allowedRoles: string[];
  allowedColumns?: string[];
  deniedColumns?: string[];
  rowOwnerColumn?: string | null;
  bypassRowLockRoles?: string[];
}

export interface SupportDbSource {
  id: number;
  tenantId: number;
  name: string;
  driver: 'sqlite-sandbox' | 'sql-http';
  connectionUrl: string;
  authTokenMasked: string;
  schemaSql: string;
  tablePolicies: SupportTablePolicy[];
  maxRows: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SupportUserContext {
  tenantId: number;
  userId: string;
  name?: string;
  email?: string;
  role: string;
  permissions: string[];
  metadata?: Record<string, unknown>;
  verified: boolean;
  expiresAt?: number;
}

export interface SupportAvailableToolDescriptor {
  kind: 'webhook' | 'db';
  id: number;
  functionName: string;
  displayName: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface SupportToolTraceEntry {
  kind: 'webhook' | 'db';
  name: string;
  args?: Record<string, unknown>;
  rewrittenSql?: string;
  result?: unknown;
  error?: string;
  durationMs?: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  modelUsed?: string;
  toolTrace?: SupportToolTraceEntry[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

// ---------------------------------------------------------------------------
// Sample Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_SAMPLE_SQL = `
CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, price REAL NOT NULL, stock INTEGER NOT NULL);
INSERT INTO products (id, name, category, price, stock) VALUES (1, 'Wireless Mouse', 'accessories', 19.99, 120);
INSERT INTO products (id, name, category, price, stock) VALUES (2, 'Mechanical Keyboard', 'accessories', 89.5, 45);
INSERT INTO products (id, name, category, price, stock) VALUES (3, '27in 4K Monitor', 'displays', 329.0, 12);
INSERT INTO products (id, name, category, price, stock) VALUES (4, 'USB-C Hub', 'accessories', 39.0, 0);
CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, product_name TEXT NOT NULL, status TEXT NOT NULL, total_usd REAL NOT NULL, tracking_code TEXT, created_at TEXT NOT NULL);
INSERT INTO orders (id, user_id, product_name, status, total_usd, tracking_code, created_at) VALUES (1, 'cust_101', 'Wireless Mouse', 'delivered', 19.99, 'TRK-1001', '2026-10-01T09:00:00Z');
INSERT INTO orders (id, user_id, product_name, status, total_usd, tracking_code, created_at) VALUES (2, 'cust_101', 'Mechanical Keyboard', 'shipped', 89.5, 'TRK-1002', '2026-10-20T11:30:00Z');
INSERT INTO orders (id, user_id, product_name, status, total_usd, tracking_code, created_at) VALUES (3, 'cust_102', '27in 4K Monitor', 'processing', 329.0, NULL, '2026-11-02T14:15:00Z');
INSERT INTO orders (id, user_id, product_name, status, total_usd, tracking_code, created_at) VALUES (4, 'cust_102', 'USB-C Hub', 'cancelled', 39.0, NULL, '2026-11-05T08:45:00Z');
CREATE TABLE customers (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, tier TEXT NOT NULL, password_hash TEXT NOT NULL, secret_note TEXT);
INSERT INTO customers (id, name, email, tier, password_hash, secret_note) VALUES ('cust_101', 'Alice Nguyen', 'alice@example.com', 'gold', 'pbkdf2$alice-hash', 'VIP - internal only');
INSERT INTO customers (id, name, email, tier, password_hash, secret_note) VALUES ('cust_102', 'Bob Tran', 'bob@example.com', 'standard', 'pbkdf2$bob-hash', 'Chargeback risk');
`.trim()

export const DEFAULT_SAMPLE_TABLE_POLICIES: SupportTablePolicy[] = [
  {
    tableName: 'products',
    description: 'Public products catalog',
    allowedRoles: ['guest', 'customer', 'staff', 'admin'],
  },
  {
    tableName: 'orders',
    description: 'Customer purchase orders',
    allowedRoles: ['customer', 'staff', 'admin'],
    rowOwnerColumn: 'user_id',
    bypassRowLockRoles: ['admin', 'staff'],
  },
  {
    tableName: 'customers',
    description: 'Customer profile records',
    allowedRoles: ['customer', 'staff', 'admin'],
    rowOwnerColumn: 'id',
    bypassRowLockRoles: ['admin', 'staff'],
    deniedColumns: ['password_hash', 'secret_note'],
  },
]

export const DEFAULT_TENANT_ROLES: SupportRoleConfig[] = [
  { role: 'guest', label: 'Guest', permissions: ['products:read'] },
  { role: 'customer', label: 'Customer', permissions: ['products:read', 'orders:read_own'] },
  { role: 'staff', label: 'Staff', permissions: ['products:read', 'orders:read', 'customers:read'] },
  { role: 'admin', label: 'Admin', permissions: ['*'] },
]

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export default function SupportGateway() {
  const s = useSupportStrings()
  const client = useQueryClient()
  const revision = useSessionRevision()
  const session = useUserSession()
  const canEdit = session.hasPermission('edit_x_settings')

  // Selected active tenant & tabs
  const [selectedTenantId, setSelectedTenantId] = useState<number | null>(null)
  const [activeTab, setActiveTab] = useState<'overview' | 'webhook' | 'database' | 'simulator' | 'embed'>('overview')

  // Newly generated signing secret banner
  const [newSecretBanner, setNewSecretBanner] = useState<{ tenantName: string; secret: string } | null>(null)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  // Copy helper
  const handleCopy = (text: string, key: string) => {
    void navigator.clipboard.writeText(text)
    setCopiedKey(key)
    setTimeout(() => setCopiedKey(null), 2500)
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  const tenantsQuery = useQuery({
    queryKey: ['x-support-tenants', revision],
    queryFn: ({ signal }) =>
      apiFetch<{ tenants: SupportTenant[]; sampleSchemaSql?: string }>('/api/x-gateway/support/tenants', { signal }),
  })

  const tenants = tenantsQuery.data?.tenants ?? []

  // Active Tenant
  const activeTenant = useMemo(() => {
    if (!tenants.length) return null
    if (selectedTenantId !== null) {
      const found = tenants.find(t => t.id === selectedTenantId)
      if (found) return found
    }
    return tenants[0]
  }, [tenants, selectedTenantId])

  const activeId = activeTenant?.id ?? null

  const toolsQuery = useQuery({
    queryKey: ['x-support-tools', activeId, revision],
    queryFn: ({ signal }) =>
      apiFetch<{ tools: SupportWebhookTool[] }>(`/api/x-gateway/support/tenants/${activeId}/tools`, { signal }),
    enabled: activeId !== null,
  })

  const dbSourcesQuery = useQuery({
    queryKey: ['x-support-db-sources', activeId, revision],
    queryFn: ({ signal }) =>
      apiFetch<{ dbSources: SupportDbSource[] }>(`/api/x-gateway/support/tenants/${activeId}/db-sources`, { signal }),
    enabled: activeId !== null,
  })

  const tools = toolsQuery.data?.tools ?? []
  const dbSources = dbSourcesQuery.data?.dbSources ?? []

  // -------------------------------------------------------------------------
  // Tenant Mutations
  // -------------------------------------------------------------------------

  const [showCreateTenantDialog, setShowCreateTenantDialog] = useState(false)
  const [createTenantDraft, setCreateTenantDraft] = useState({
    name: '',
    slug: '',
    defaultModel: 'auto',
    allowGuest: true,
    seedSampleDb: true,
    systemPrompt: '',
    allowedOrigins: '',
  })

  const createTenantMutation = useMutation({
    mutationFn: (data: typeof createTenantDraft) =>
      apiFetch<{ tenant: SupportTenant; signingSecret: string }>('/api/x-gateway/support/tenants', {
        method: 'POST',
        body: JSON.stringify({
          name: data.name,
          slug: data.slug.trim() || undefined,
          defaultModel: data.defaultModel.trim() || 'auto',
          allowGuest: data.allowGuest,
          seedSampleDb: data.seedSampleDb,
          systemPrompt: data.systemPrompt.trim(),
          allowedOrigins: data.allowedOrigins
            .split(/[\n,]/)
            .map(s => s.trim())
            .filter(Boolean),
          rolesConfig: DEFAULT_TENANT_ROLES,
        }),
      }),
    onSuccess: (res) => {
      setShowCreateTenantDialog(false)
      setCreateTenantDraft({
        name: '',
        slug: '',
        defaultModel: 'auto',
        allowGuest: true,
        seedSampleDb: true,
        systemPrompt: '',
        allowedOrigins: '',
      })
      setNewSecretBanner({ tenantName: res.tenant.name, secret: res.signingSecret })
      setSelectedTenantId(res.tenant.id)
      void client.invalidateQueries({ queryKey: ['x-support-tenants'] })
    },
  })

  const rotateSecretMutation = useMutation({
    mutationFn: (tenantId: number) =>
      apiFetch<{ tenant: SupportTenant; signingSecret: string }>(
        `/api/x-gateway/support/tenants/${tenantId}/rotate-secret`,
        { method: 'POST', body: JSON.stringify({}) }
      ),
    onSuccess: (res) => {
      setNewSecretBanner({ tenantName: res.tenant.name, secret: res.signingSecret })
      void client.invalidateQueries({ queryKey: ['x-support-tenants'] })
    },
  })

  const deleteTenantMutation = useMutation({
    mutationFn: (tenantId: number) =>
      apiFetch<{ ok: boolean }>(`/api/x-gateway/support/tenants/${tenantId}`, { method: 'DELETE' }),
    onSuccess: () => {
      setSelectedTenantId(null)
      void client.invalidateQueries({ queryKey: ['x-support-tenants'] })
    },
  })

  const updateTenantMutation = useMutation({
    mutationFn: (payload: { id: number; data: Partial<SupportTenant> }) =>
      apiFetch<{ tenant: SupportTenant }>(`/api/x-gateway/support/tenants/${payload.id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload.data),
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['x-support-tenants'] })
    },
  })

  // -------------------------------------------------------------------------
  // Tab 1: Overview & Roles State
  // -------------------------------------------------------------------------

  const [overviewDraft, setOverviewDraft] = useState<Partial<SupportTenant> | null>(null)
  const currentTenantOverview = overviewDraft ?? activeTenant

  const [newRoleDraft, setNewRoleDraft] = useState({ role: '', label: '', permissions: '' })

  const handleAddRole = () => {
    if (!newRoleDraft.role.trim() || !newRoleDraft.label.trim()) return
    const updatedRoles = [
      ...(currentTenantOverview?.rolesConfig ?? []),
      {
        role: newRoleDraft.role.trim().toLowerCase(),
        label: newRoleDraft.label.trim(),
        permissions: newRoleDraft.permissions
          .split(/[\n,]/)
          .map(p => p.trim())
          .filter(Boolean),
      },
    ]
    setOverviewDraft({ ...(currentTenantOverview || {}), rolesConfig: updatedRoles })
    setNewRoleDraft({ role: '', label: '', permissions: '' })
  }

  const handleRemoveRole = (roleKey: string) => {
    const updatedRoles = (currentTenantOverview?.rolesConfig ?? []).filter(r => r.role !== roleKey)
    setOverviewDraft({ ...(currentTenantOverview || {}), rolesConfig: updatedRoles })
  }

  // -------------------------------------------------------------------------
  // Tab 2: Webhook Tools State & Mutations
  // -------------------------------------------------------------------------

  const [showAddToolDialog, setShowAddToolDialog] = useState(false)
  const [toolDraft, setToolDraft] = useState({
    name: '',
    description: '',
    method: 'POST' as 'GET' | 'POST',
    endpointUrl: '',
    headers: '{}',
    parametersSchema: '{\n  "type": "object",\n  "properties": {\n    "user_id": { "type": "string" },\n    "limit": { "type": "number", "default": 5 }\n  }\n}',
    allowedRoles: 'customer, staff, admin',
    lockUserIdParam: 'user_id',
    bypassUserLockRoles: 'admin, staff',
  })

  const createToolMutation = useMutation({
    mutationFn: (toolData: typeof toolDraft) => {
      let parsedHeaders = {}
      try { parsedHeaders = JSON.parse(toolData.headers) } catch { /* ignore */ }
      let parsedParams = {}
      try { parsedParams = JSON.parse(toolData.parametersSchema) } catch { /* ignore */ }

      return apiFetch<{ tool: SupportWebhookTool }>(`/api/x-gateway/support/tenants/${activeId}/tools`, {
        method: 'POST',
        body: JSON.stringify({
          name: toolData.name.trim(),
          description: toolData.description.trim(),
          method: toolData.method,
          endpointUrl: toolData.endpointUrl.trim(),
          headers: parsedHeaders,
          parametersSchema: parsedParams,
          allowedRoles: toolData.allowedRoles.split(',').map(r => r.trim()).filter(Boolean),
          lockUserIdParam: toolData.lockUserIdParam.trim() || null,
          bypassUserLockRoles: toolData.bypassUserLockRoles.split(',').map(r => r.trim()).filter(Boolean),
          enabled: true,
        }),
      })
    },
    onSuccess: () => {
      setShowAddToolDialog(false)
      setToolDraft({
        name: '',
        description: '',
        method: 'POST',
        endpointUrl: '',
        headers: '{}',
        parametersSchema: '{\n  "type": "object",\n  "properties": {\n    "user_id": { "type": "string" },\n    "limit": { "type": "number", "default": 5 }\n  }\n}',
        allowedRoles: 'customer, staff, admin',
        lockUserIdParam: 'user_id',
        bypassUserLockRoles: 'admin, staff',
      })
      void client.invalidateQueries({ queryKey: ['x-support-tools', activeId] })
    },
  })

  const deleteToolMutation = useMutation({
    mutationFn: (toolId: number) =>
      apiFetch<{ ok: boolean }>(`/api/x-gateway/support/tenants/${activeId}/tools/${toolId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['x-support-tools', activeId] })
    },
  })

  // Live Webhook Tester
  const [selectedToolId, setSelectedToolId] = useState<number | null>(null)
  const [testToolRole, setTestToolRole] = useState('customer')
  const [testToolUserId, setTestToolUserId] = useState('cust_101')
  const [testToolArgsJson, setTestToolArgsJson] = useState('{\n  "user_id": "cust_malicious_attacker",\n  "status": "delivered"\n}')
  const [toolTestResult, setToolTestResult] = useState<{
    ok: boolean;
    status: number;
    effectiveArgs: Record<string, unknown>;
    data: unknown;
    error?: string;
  } | null>(null)

  const testWebhookMutation = useMutation({
    mutationFn: (payload: { toolId: number }) => {
      let parsedArgs: Record<string, unknown> = {}
      try { parsedArgs = JSON.parse(testToolArgsJson) } catch { /* ignore */ }
      return apiFetch<{ ok: boolean; status: number; effectiveArgs: Record<string, unknown>; data: unknown }>(
        `/api/x-gateway/support/tenants/${activeId}/tools/${payload.toolId}/test`,
        {
          method: 'POST',
          body: JSON.stringify({
            userId: testToolUserId.trim(),
            role: testToolRole,
            args: parsedArgs,
          }),
        }
      )
    },
    onSuccess: (res) => {
      setToolTestResult(res)
    },
    onError: (err: Error) => {
      setToolTestResult({
        ok: false,
        status: 500,
        effectiveArgs: {},
        data: null,
        error: err.message,
      })
    },
  })

  // -------------------------------------------------------------------------
  // Tab 3: Database & Policies State & Mutations
  // -------------------------------------------------------------------------

  const [showAddDbDialog, setShowAddDbDialog] = useState(false)
  const [dbSourceDraft, setDbSourceDraft] = useState({
    name: 'E-Commerce Storefront DB',
    driver: 'sqlite-sandbox' as 'sqlite-sandbox' | 'sql-http',
    connectionUrl: '',
    authToken: '',
    schemaSql: DEFAULT_SAMPLE_SQL,
    tablePolicies: DEFAULT_SAMPLE_TABLE_POLICIES,
    maxRows: 50,
  })

  const [newTablePolicyDraft, setNewTablePolicyDraft] = useState({
    tableName: '',
    description: '',
    allowedRoles: 'customer, admin',
    rowOwnerColumn: 'user_id',
    deniedColumns: '',
    bypassRowLockRoles: 'admin, staff',
  })

  const handleAddTablePolicy = () => {
    if (!newTablePolicyDraft.tableName.trim()) return
    setDbSourceDraft({
      ...dbSourceDraft,
      tablePolicies: [
        ...dbSourceDraft.tablePolicies,
        {
          tableName: newTablePolicyDraft.tableName.trim(),
          description: newTablePolicyDraft.description.trim() || undefined,
          allowedRoles: newTablePolicyDraft.allowedRoles.split(',').map(r => r.trim()).filter(Boolean),
          rowOwnerColumn: newTablePolicyDraft.rowOwnerColumn.trim() || null,
          deniedColumns: newTablePolicyDraft.deniedColumns.split(',').map(c => c.trim()).filter(Boolean),
          bypassRowLockRoles: newTablePolicyDraft.bypassRowLockRoles.split(',').map(r => r.trim()).filter(Boolean),
        },
      ],
    })
    setNewTablePolicyDraft({
      tableName: '',
      description: '',
      allowedRoles: 'customer, admin',
      rowOwnerColumn: 'user_id',
      deniedColumns: '',
      bypassRowLockRoles: 'admin, staff',
    })
  }

  const handleRemoveTablePolicy = (tableName: string) => {
    setDbSourceDraft({
      ...dbSourceDraft,
      tablePolicies: dbSourceDraft.tablePolicies.filter(p => p.tableName !== tableName),
    })
  }

  const createDbSourceMutation = useMutation({
    mutationFn: (data: typeof dbSourceDraft) =>
      apiFetch<{ dbSource: SupportDbSource }>(`/api/x-gateway/support/tenants/${activeId}/db-sources`, {
        method: 'POST',
        body: JSON.stringify({
          name: data.name.trim(),
          driver: data.driver,
          connectionUrl: data.connectionUrl.trim() || undefined,
          authToken: data.authToken.trim() || undefined,
          schemaSql: data.schemaSql,
          tablePolicies: data.tablePolicies,
          maxRows: data.maxRows,
          enabled: true,
        }),
      }),
    onSuccess: () => {
      setShowAddDbDialog(false)
      void client.invalidateQueries({ queryKey: ['x-support-db-sources', activeId] })
    },
  })

  const deleteDbSourceMutation = useMutation({
    mutationFn: (sourceId: number) =>
      apiFetch<{ ok: boolean }>(`/api/x-gateway/support/tenants/${activeId}/db-sources/${sourceId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['x-support-db-sources', activeId] })
    },
  })

  // Live SQL Policy Tester
  const [selectedDbSourceId, setSelectedDbSourceId] = useState<number | null>(null)
  const [sqlRole, setSqlRole] = useState('customer')
  const [sqlUserId, setSqlUserId] = useState('cust_101')
  const [sqlQuery, setSqlQuery] = useState('SELECT * FROM orders')
  const [sqlTestResult, setSqlTestResult] = useState<{
    ok: boolean;
    rows?: Record<string, unknown>[];
    rowCount?: number;
    rewrittenSql?: string;
    referencedTables?: string[];
    error?: string;
  } | null>(null)

  const testSqlQueryMutation = useMutation({
    mutationFn: (payload: { sourceId: number }) =>
      apiFetch<{
        ok: boolean;
        rows: Record<string, unknown>[];
        rowCount: number;
        rewrittenSql: string;
        referencedTables: string[];
      }>(`/api/x-gateway/support/tenants/${activeId}/db-sources/${payload.sourceId}/query-test`, {
        method: 'POST',
        body: JSON.stringify({
          userId: sqlUserId.trim(),
          role: sqlRole,
          sql: sqlQuery.trim(),
        }),
      }),
    onSuccess: (res) => {
      setSqlTestResult(res)
    },
    onError: (err: Error) => {
      setSqlTestResult({ ok: false, error: err.message })
    },
  })

  // -------------------------------------------------------------------------
  // Tab 4: Live Role Simulator State & Mutation
  // -------------------------------------------------------------------------

  const [simRole, setSimRole] = useState<'guest' | 'customer' | 'staff' | 'admin'>('customer')
  const [simUserId, setSimUserId] = useState('cust_101')
  const [simUserName, setSimUserName] = useState('Alice Nguyen')
  const [simInput, setSimInput] = useState('')
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome',
      role: 'assistant',
      content: 'Hello! I am your AI storefront support assistant. How can I help you today?',
    },
  ])

  // Presets
  const applyPersonaPreset = (preset: 'guest' | 'alice' | 'bob' | 'admin') => {
    if (preset === 'guest') {
      setSimRole('guest')
      setSimUserId('guest_anon')
      setSimUserName('Guest Visitor')
    } else if (preset === 'alice') {
      setSimRole('customer')
      setSimUserId('cust_101')
      setSimUserName('Alice Nguyen')
    } else if (preset === 'bob') {
      setSimRole('customer')
      setSimUserId('cust_102')
      setSimUserName('Bob Tran')
    } else if (preset === 'admin') {
      setSimRole('admin')
      setSimUserId('admin_01')
      setSimUserName('Administrator')
    }
  }

  const simulateChatMutation = useMutation({
    mutationFn: (messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>) =>
      apiFetch<{
        reply: string;
        userContext: SupportUserContext;
        allowedTools: SupportAvailableToolDescriptor[];
        toolTrace: SupportToolTraceEntry[];
        modelUsed: string;
        usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      }>(`/api/x-gateway/support/tenants/${activeId}/simulate-chat`, {
        method: 'POST',
        body: JSON.stringify({
          userId: simUserId.trim(),
          name: simUserName.trim(),
          role: simRole,
          messages,
          model: activeTenant?.defaultModel || 'auto',
        }),
      }),
    onSuccess: (res) => {
      const assistantMsg: ChatMessage = {
        id: `msg-${Date.now()}`,
        role: 'assistant',
        content: res.reply,
        modelUsed: res.modelUsed,
        toolTrace: res.toolTrace,
        usage: res.usage,
      }
      setChatMessages(prev => [...prev, assistantMsg])
      setSimInput('')
    },
    onError: (err: Error) => {
      const errorMsg: ChatMessage = {
        id: `err-${Date.now()}`,
        role: 'assistant',
        content: `Error: ${err.message}`,
      }
      setChatMessages(prev => [...prev, errorMsg])
    },
  })

  const handleSendChat = (textToSend?: string) => {
    const text = (textToSend ?? simInput).trim()
    if (!text || simulateChatMutation.isPending || !activeId) return

    const userMsg: ChatMessage = {
      id: `usr-${Date.now()}`,
      role: 'user',
      content: text,
    }

    const updated = [...chatMessages, userMsg]
    setChatMessages(updated)
    setSimInput('')

    const payload = updated
      .filter(m => m.id !== 'welcome')
      .map(m => ({ role: m.role, content: m.content }))

    simulateChatMutation.mutate(payload)
  }

  // -------------------------------------------------------------------------
  // Tab 5: Embed Widget & Mint Token Tester
  // -------------------------------------------------------------------------

  const [mintUserId, setMintUserId] = useState('cust_101')
  const [mintRole, setMintRole] = useState('customer')
  const [mintName, setMintName] = useState('Alice Nguyen')
  const [mintTtl, setMintTtl] = useState(86400)
  const [mintedTokenResult, setMintedTokenResult] = useState<{
    token: string;
    context: SupportUserContext;
  } | null>(null)

  const mintTokenMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ token: string; context: SupportUserContext }>(
        `/api/x-gateway/support/tenants/${activeId}/mint-token`,
        {
          method: 'POST',
          body: JSON.stringify({
            userId: mintUserId.trim(),
            role: mintRole,
            name: mintName.trim() || undefined,
            ttlSeconds: mintTtl,
          }),
        }
      ),
    onSuccess: (res) => {
      setMintedTokenResult(res)
    },
  })

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="x-support-gateway">
      {/* Page Heading */}
      <div className="x-page-heading">
        <div>
          <h1>{s.supportTitle}</h1>
          <p>{s.supportSubtitle}</p>
        </div>
        <span className="x-heading-icon">
          <Headset size={28} />
        </span>
      </div>

      {/* Loading & Error States */}
      {tenantsQuery.isPending && <p role="status">{s.loading}</p>}
      {tenantsQuery.isError && (
        <div className="x-error" role="alert">
          {s.errorLoading}
          <button className="x-button" onClick={() => void tenantsQuery.refetch()}>
            {s.retry}
          </button>
        </div>
      )}

      {/* New Signing Secret Security Alert Banner */}
      {newSecretBanner && (
        <section
          className="x-panel"
          style={{
            marginBottom: '20px',
            padding: '16px 20px',
            border: '2px solid #10b981',
            background: 'var(--x-green-bg)',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
          }}
          aria-live="polite"
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#10b981', fontWeight: 600 }}>
              <CheckCircle2 size={20} />
              <span>
                {s.newSecretBannerTitle}: <strong>{newSecretBanner.tenantName}</strong>
              </span>
            </div>
            <button
              type="button"
              className="x-icon-button"
              aria-label={s.dismissSecretBanner}
              onClick={() => setNewSecretBanner(null)}
            >
              <X size={18} />
            </button>
          </div>
          <p style={{ margin: 0, fontSize: '13px', color: 'var(--x-text)' }}>{s.newSecretBannerDesc}</p>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              background: 'var(--x-panel)',
              padding: '8px 12px',
              borderRadius: '8px',
              border: '1px solid var(--x-border)',
            }}
          >
            <code style={{ fontSize: '13px', fontFamily: 'monospace', flex: 1, wordBreak: 'break-all', color: '#10b981' }}>
              {newSecretBanner.secret}
            </code>
            <button
              type="button"
              className="x-button x-small x-primary"
              onClick={() => handleCopy(newSecretBanner.secret, 'new-secret')}
            >
              {copiedKey === 'new-secret' ? <Check size={14} /> : <Copy size={14} />}
              {copiedKey === 'new-secret' ? s.copied : s.copy}
            </button>
          </div>
        </section>
      )}

      {/* Tenant Bar & Selector */}
      <section
        className="x-panel"
        style={{
          padding: '16px 20px',
          marginBottom: '24px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '14px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap', flex: 1 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600, fontSize: '13px' }}>
            <Globe size={18} color="var(--x-primary)" />
            <span>{s.tenants}:</span>
            <select
              style={{
                padding: '6px 12px',
                borderRadius: '8px',
                border: '1px solid var(--x-border)',
                background: 'var(--x-panel)',
                color: 'var(--x-text)',
                fontWeight: 500,
                fontSize: '13px',
              }}
              value={activeTenant?.id ?? ''}
              onChange={e => setSelectedTenantId(Number(e.target.value))}
            >
              {tenants.map(t => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.slug})
                </option>
              ))}
            </select>
          </label>

          {activeTenant && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <span className="x-badge" title={s.publicKey}>
                <KeyRound size={12} />
                <code>{activeTenant.publicKey}</code>
              </span>
              <span className="x-badge" title={s.defaultModel}>
                <Bot size={12} />
                <span>{activeTenant.defaultModel}</span>
              </span>
              {activeTenant.allowGuest && (
                <span className="x-badge x-green">
                  <Unlock size={12} />
                  <span>Guest OK</span>
                </span>
              )}
            </div>
          )}
        </div>

        {canEdit && (
          <button
            type="button"
            className="x-button x-primary x-small"
            onClick={() => setShowCreateTenantDialog(true)}
          >
            <Plus size={15} />
            <span>{s.newTenant}</span>
          </button>
        )}
      </section>

      {/* Empty State when no tenants exist */}
      {!tenantsQuery.isPending && tenants.length === 0 && (
        <div className="x-empty x-panel" style={{ padding: '60px 20px' }}>
          <Headset size={48} color="var(--x-primary)" />
          <h2>{s.emptyState}</h2>
          <p>{s.emptyStateDesc}</p>
          {canEdit && (
            <button
              type="button"
              className="x-button x-primary"
              style={{ marginTop: '16px' }}
              onClick={() => setShowCreateTenantDialog(true)}
            >
              <Plus size={16} />
              <span>{s.createTenantTitle}</span>
            </button>
          )}
        </div>
      )}

      {/* Main Tabbed Interface when an active tenant is selected */}
      {activeTenant && (
        <div>
          {/* Navigation Sub-Tabs */}
          <div className="x-tabs" style={{ marginBottom: '24px' }}>
            <button
              type="button"
              className={activeTab === 'overview' ? 'selected' : ''}
              onClick={() => setActiveTab('overview')}
            >
              <Sliders size={15} />
              <span>{s.tabOverview}</span>
            </button>
            <button
              type="button"
              className={activeTab === 'webhook' ? 'selected' : ''}
              onClick={() => setActiveTab('webhook')}
            >
              <Webhook size={15} />
              <span>{s.tabWebhookTools}</span>
              {tools.length > 0 && <span>{tools.length}</span>}
            </button>
            <button
              type="button"
              className={activeTab === 'database' ? 'selected' : ''}
              onClick={() => setActiveTab('database')}
            >
              <Database size={15} />
              <span>{s.tabDatabase}</span>
              {dbSources.length > 0 && <span>{dbSources.length}</span>}
            </button>
            <button
              type="button"
              className={activeTab === 'simulator' ? 'selected' : ''}
              onClick={() => setActiveTab('simulator')}
            >
              <Sparkles size={15} />
              <span>{s.tabSimulator}</span>
            </button>
            <button
              type="button"
              className={activeTab === 'embed' ? 'selected' : ''}
              onClick={() => setActiveTab('embed')}
            >
              <Code2 size={15} />
              <span>{s.tabEmbed}</span>
            </button>
          </div>

          {/* --------------------------------------------------------------- */}
          {/* TAB 1: OVERVIEW & ROLES                                         */}
          {/* --------------------------------------------------------------- */}
          {activeTab === 'overview' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
              {/* Tenant Settings Form */}
              <section className="x-panel" style={{ padding: '24px' }}>
                <h3 style={{ margin: '0 0 16px', fontSize: '16px', fontWeight: 600 }}>{s.editTenantTitle}</h3>
                <form
                  onSubmit={(e: FormEvent) => {
                    e.preventDefault()
                    if (!canEdit) return
                    updateTenantMutation.mutate({
                      id: activeTenant.id,
                      data: {
                        name: currentTenantOverview?.name,
                        defaultModel: currentTenantOverview?.defaultModel,
                        systemPrompt: currentTenantOverview?.systemPrompt,
                        allowGuest: currentTenantOverview?.allowGuest,
                        allowedOrigins: currentTenantOverview?.allowedOrigins,
                        rolesConfig: currentTenantOverview?.rolesConfig,
                      },
                    })
                  }}
                  className="x-form"
                  style={{ marginTop: 0 }}
                >
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '16px' }}>
                    <label>
                      <span>{s.tenantName}</span>
                      <input
                        type="text"
                        value={currentTenantOverview?.name ?? ''}
                        disabled={!canEdit}
                        onChange={e => setOverviewDraft({ ...(currentTenantOverview || {}), name: e.target.value })}
                        required
                      />
                    </label>

                    <label>
                      <span>{s.defaultModel}</span>
                      <input
                        type="text"
                        value={currentTenantOverview?.defaultModel ?? 'auto'}
                        disabled={!canEdit}
                        onChange={e =>
                          setOverviewDraft({ ...(currentTenantOverview || {}), defaultModel: e.target.value })
                        }
                      />
                      <small style={{ color: 'var(--x-muted)', fontSize: '11px' }}>{s.defaultModelHelp}</small>
                    </label>

                    <label style={{ gridColumn: '1 / -1' }}>
                      <span>{s.allowedOrigins}</span>
                      <input
                        type="text"
                        value={(currentTenantOverview?.allowedOrigins ?? []).join(', ')}
                        disabled={!canEdit}
                        onChange={e =>
                          setOverviewDraft({
                            ...(currentTenantOverview || {}),
                            allowedOrigins: e.target.value.split(',').map(s => s.trim()).filter(Boolean),
                          })
                        }
                        placeholder="https://shop.example.com, http://localhost:3000"
                      />
                      <small style={{ color: 'var(--x-muted)', fontSize: '11px' }}>{s.allowedOriginsHelp}</small>
                    </label>

                    <label style={{ gridColumn: '1 / -1' }}>
                      <span>{s.systemPrompt}</span>
                      <textarea
                        rows={3}
                        style={{
                          width: '100%',
                          padding: '10px 12px',
                          borderRadius: '8px',
                          border: '1px solid var(--x-border)',
                          background: 'var(--x-bg)',
                          color: 'var(--x-text)',
                          fontFamily: 'inherit',
                          fontSize: '13px',
                        }}
                        value={currentTenantOverview?.systemPrompt ?? ''}
                        disabled={!canEdit}
                        onChange={e =>
                          setOverviewDraft({ ...(currentTenantOverview || {}), systemPrompt: e.target.value })
                        }
                        placeholder={s.systemPromptPlaceholder}
                      />
                    </label>

                    <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={currentTenantOverview?.allowGuest ?? true}
                        disabled={!canEdit}
                        onChange={e =>
                          setOverviewDraft({ ...(currentTenantOverview || {}), allowGuest: e.target.checked })
                        }
                        style={{ width: 'auto' }}
                      />
                      <div>
                        <span style={{ fontWeight: 600 }}>{s.allowGuest}</span>
                        <div style={{ color: 'var(--x-muted)', fontSize: '11px' }}>{s.allowGuestHelp}</div>
                      </div>
                    </label>
                  </div>

                  {/* Roles Config Sub-Section */}
                  <div style={{ marginTop: '24px', borderTop: '1px solid var(--x-border)', paddingTop: '20px' }}>
                    <div style={{ marginBottom: '14px' }}>
                      <h4 style={{ margin: '0 0 4px', fontSize: '14px', fontWeight: 600 }}>{s.rolesConfigTitle}</h4>
                      <p style={{ margin: 0, fontSize: '12px', color: 'var(--x-muted)' }}>{s.rolesConfigDesc}</p>
                    </div>

                    <div className="x-table-wrap">
                      <table className="x-table">
                        <thead>
                          <tr>
                            <th>{s.roleColumnRole}</th>
                            <th>{s.roleColumnLabel}</th>
                            <th>{s.roleColumnPermissions}</th>
                            <th>{s.roleColumnActions}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(currentTenantOverview?.rolesConfig ?? []).map(r => (
                            <tr key={r.role}>
                              <td>
                                <span className="x-badge">
                                  <strong>{r.role}</strong>
                                </span>
                              </td>
                              <td>{r.label}</td>
                              <td>
                                <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                                  {r.permissions.map(p => (
                                    <span key={p} className="x-badge x-green" style={{ fontSize: '10px' }}>
                                      {p}
                                    </span>
                                  ))}
                                </div>
                              </td>
                              <td>
                                {canEdit && (
                                  <button
                                    type="button"
                                    className="x-icon-button x-danger"
                                    aria-label={`${s.deleteRole} ${r.role}`}
                                    onClick={() => handleRemoveRole(r.role)}
                                  >
                                    <Trash2 size={15} />
                                  </button>
                                )}
                              </td>
                            </tr>
                          ))}

                          {/* Add Role Row */}
                          {canEdit && (
                            <tr>
                              <td>
                                <input
                                  type="text"
                                  placeholder="e.g. VIP"
                                  value={newRoleDraft.role}
                                  onChange={e => setNewRoleDraft({ ...newRoleDraft, role: e.target.value })}
                                  style={{ padding: '6px 8px', fontSize: '12px' }}
                                />
                              </td>
                              <td>
                                <input
                                  type="text"
                                  placeholder="VIP Customer"
                                  value={newRoleDraft.label}
                                  onChange={e => setNewRoleDraft({ ...newRoleDraft, label: e.target.value })}
                                  style={{ padding: '6px 8px', fontSize: '12px' }}
                                />
                              </td>
                              <td>
                                <input
                                  type="text"
                                  placeholder="products:read, orders:read_own, vip:lounge"
                                  value={newRoleDraft.permissions}
                                  onChange={e => setNewRoleDraft({ ...newRoleDraft, permissions: e.target.value })}
                                  style={{ padding: '6px 8px', fontSize: '12px' }}
                                />
                              </td>
                              <td>
                                <button
                                  type="button"
                                  className="x-button x-small"
                                  onClick={handleAddRole}
                                  disabled={!newRoleDraft.role.trim() || !newRoleDraft.label.trim()}
                                >
                                  <Plus size={13} />
                                  <span>{s.addRole}</span>
                                </button>
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {canEdit && (
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '20px' }}>
                      <button
                        type="submit"
                        className="x-button x-primary"
                        disabled={updateTenantMutation.isPending}
                      >
                        {updateTenantMutation.isPending ? s.saving : s.save}
                      </button>
                    </div>
                  )}
                </form>
              </section>

              {/* Danger Zone: Rotate Secret & Delete Tenant */}
              <section
                className="x-panel"
                style={{
                  padding: '24px',
                  border: '1px solid rgba(239, 68, 68, 0.3)',
                  background: 'var(--x-red-bg)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '16px' }}>
                  <div>
                    <h4 style={{ margin: '0 0 4px', fontSize: '14px', fontWeight: 600, color: 'var(--x-red)' }}>
                      Security & Tenant Lifecycle
                    </h4>
                    <p style={{ margin: 0, fontSize: '12px', color: 'var(--x-text)' }}>
                      Signing Secret is masked for protection. You may rotate it or permanently delete this partner tenant.
                    </p>
                  </div>

                  <div style={{ display: 'flex', gap: '10px' }}>
                    {canEdit && (
                      <button
                        type="button"
                        className="x-button x-small"
                        disabled={rotateSecretMutation.isPending}
                        onClick={() => {
                          if (window.confirm(s.rotateSecretConfirm)) {
                            rotateSecretMutation.mutate(activeTenant.id)
                          }
                        }}
                      >
                        <RefreshCw size={14} />
                        <span>{s.rotateSecret}</span>
                      </button>
                    )}

                    {canEdit && (
                      <button
                        type="button"
                        className="x-button x-destructive x-small"
                        disabled={deleteTenantMutation.isPending}
                        onClick={() => {
                          if (window.confirm(s.deleteTenantConfirm)) {
                            deleteTenantMutation.mutate(activeTenant.id)
                          }
                        }}
                      >
                        <Trash2 size={14} />
                        <span>{s.deleteTenant}</span>
                      </button>
                    )}
                  </div>
                </div>
              </section>
            </div>
          )}

          {/* --------------------------------------------------------------- */}
          {/* TAB 2: WEBHOOK TOOLS (MODE A)                                   */}
          {/* --------------------------------------------------------------- */}
          {activeTab === 'webhook' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
              {/* Header & Add Button */}
              <section className="x-panel" style={{ padding: '20px 24px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '14px' }}>
                  <div>
                    <h3 style={{ margin: '0 0 4px', fontSize: '16px', fontWeight: 600 }}>{s.webhookToolsTitle}</h3>
                    <p style={{ margin: 0, fontSize: '12px', color: 'var(--x-muted)' }}>{s.webhookToolsDesc}</p>
                  </div>
                  {canEdit && (
                    <button
                      type="button"
                      className="x-button x-primary x-small"
                      onClick={() => setShowAddToolDialog(true)}
                    >
                      <Plus size={14} />
                      <span>{s.addWebhookTool}</span>
                    </button>
                  )}
                </div>

                {/* Tools Table */}
                <div className="x-table-wrap" style={{ marginTop: '16px' }}>
                  <table className="x-table">
                    <thead>
                      <tr>
                        <th>{s.toolName}</th>
                        <th>{s.toolMethod}</th>
                        <th>{s.toolEndpointUrl}</th>
                        <th>{s.allowedRoles}</th>
                        <th>{s.lockUserIdParam}</th>
                        <th>{s.bypassUserLockRoles}</th>
                        <th>{s.actions}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tools.map(tool => (
                        <tr key={tool.id}>
                          <td>
                            <strong>{tool.name}</strong>
                            {tool.description && <p style={{ margin: '2px 0 0', fontSize: '11px', color: 'var(--x-muted)' }}>{tool.description}</p>}
                          </td>
                          <td>
                            <span className={`x-badge ${tool.method === 'GET' ? 'x-green' : ''}`}>
                              {tool.method}
                            </span>
                          </td>
                          <td>
                            <code style={{ fontSize: '11px' }}>{tool.endpointUrl}</code>
                          </td>
                          <td>
                            <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                              {tool.allowedRoles.map(r => (
                                <span key={r} className="x-badge" style={{ fontSize: '10px' }}>
                                  {r}
                                </span>
                              ))}
                            </div>
                          </td>
                          <td>
                            {tool.lockUserIdParam ? (
                              <span className="x-badge x-green" style={{ fontSize: '10px' }}>
                                <Lock size={10} />
                                <code>{tool.lockUserIdParam}</code>
                              </span>
                            ) : (
                              <span style={{ color: 'var(--x-muted)', fontSize: '11px' }}>—</span>
                            )}
                          </td>
                          <td>
                            <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                              {tool.bypassUserLockRoles.map(r => (
                                <span key={r} className="x-badge" style={{ fontSize: '10px' }}>
                                  {r}
                                </span>
                              ))}
                            </div>
                          </td>
                          <td>
                            {canEdit && (
                              <button
                                type="button"
                                className="x-icon-button x-danger"
                                aria-label={`${s.delete} ${tool.name}`}
                                onClick={() => {
                                  if (window.confirm(s.deleteWebhookToolConfirm)) {
                                    deleteToolMutation.mutate(tool.id)
                                  }
                                }}
                              >
                                <Trash2 size={15} />
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                      {tools.length === 0 && (
                        <tr>
                          <td colSpan={7} style={{ textAlign: 'center', padding: '30px', color: 'var(--x-muted)' }}>
                            {s.noWebhookTools}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </section>

              {/* Live Webhook Tester */}
              {tools.length > 0 && (
                <section className="x-panel" style={{ padding: '24px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' }}>
                    <Terminal size={20} color="var(--x-primary)" />
                    <div>
                      <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 600 }}>{s.webhookTesterTitle}</h3>
                      <p style={{ margin: 0, fontSize: '12px', color: 'var(--x-muted)' }}>{s.webhookTesterDesc}</p>
                    </div>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '14px', marginBottom: '16px' }}>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', fontWeight: 500 }}>
                      <span>{s.selectToolToTest}</span>
                      <select
                        style={{
                          padding: '7px 10px',
                          borderRadius: '8px',
                          border: '1px solid var(--x-border)',
                          background: 'var(--x-panel)',
                          color: 'var(--x-text)',
                        }}
                        value={selectedToolId ?? tools[0]?.id ?? ''}
                        onChange={e => setSelectedToolId(Number(e.target.value))}
                      >
                        {tools.map(t => (
                          <option key={t.id} value={t.id}>
                            {t.name} ({t.method})
                          </option>
                        ))}
                      </select>
                    </label>

                    <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', fontWeight: 500 }}>
                      <span>{s.simulatedRole}</span>
                      <select
                        style={{
                          padding: '7px 10px',
                          borderRadius: '8px',
                          border: '1px solid var(--x-border)',
                          background: 'var(--x-panel)',
                          color: 'var(--x-text)',
                        }}
                        value={testToolRole}
                        onChange={e => setTestToolRole(e.target.value)}
                      >
                        <option value="guest">guest</option>
                        <option value="customer">customer</option>
                        <option value="staff">staff</option>
                        <option value="admin">admin</option>
                      </select>
                    </label>

                    <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', fontWeight: 500 }}>
                      <span>{s.simulatedUserId}</span>
                      <input
                        type="text"
                        style={{
                          padding: '7px 10px',
                          borderRadius: '8px',
                          border: '1px solid var(--x-border)',
                          background: 'var(--x-bg)',
                          color: 'var(--x-text)',
                        }}
                        value={testToolUserId}
                        onChange={e => setTestToolUserId(e.target.value)}
                      />
                    </label>
                  </div>

                  <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', fontWeight: 500 }}>
                    <span>{s.testArgumentsJson}</span>
                    <textarea
                      rows={3}
                      style={{
                        padding: '10px 12px',
                        borderRadius: '8px',
                        border: '1px solid var(--x-border)',
                        background: 'var(--x-bg)',
                        color: 'var(--x-text)',
                        fontFamily: 'monospace',
                        fontSize: '12px',
                      }}
                      value={testToolArgsJson}
                      onChange={e => setTestToolArgsJson(e.target.value)}
                    />
                  </label>

                  <div style={{ marginTop: '14px', display: 'flex', justifyContent: 'flex-end' }}>
                    <button
                      type="button"
                      className="x-button x-primary x-small"
                      disabled={testWebhookMutation.isPending}
                      onClick={() => {
                        const targetId = selectedToolId ?? tools[0]?.id
                        if (targetId) testWebhookMutation.mutate({ toolId: targetId })
                      }}
                    >
                      <Play size={13} />
                      <span>{testWebhookMutation.isPending ? s.testingWebhook : s.testWebhookButton}</span>
                    </button>
                  </div>

                  {/* Results Panel */}
                  {toolTestResult && (
                    <div style={{ marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span className={`x-badge ${toolTestResult.ok ? 'x-green' : 'x-red'}`}>
                          Status: {toolTestResult.status} {toolTestResult.ok ? 'OK' : 'Error'}
                        </span>
                        {toolTestResult.error && (
                          <span style={{ color: 'var(--x-red)', fontSize: '12px' }}>
                            {toolTestResult.error}
                          </span>
                        )}
                      </div>

                      {toolTestResult.effectiveArgs && (
                        <div>
                          <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '4px' }}>
                            {s.effectiveArgsTitle} <small style={{ color: 'var(--x-muted)', fontWeight: 400 }}>({s.effectiveArgsHelp})</small>
                          </div>
                          <pre
                            style={{
                              margin: 0,
                              padding: '12px',
                              borderRadius: '8px',
                              background: 'var(--x-alt)',
                              border: '1px solid var(--x-border)',
                              fontFamily: 'monospace',
                              fontSize: '12px',
                              overflow: 'auto',
                            }}
                          >
                            {JSON.stringify(toolTestResult.effectiveArgs, null, 2)}
                          </pre>
                        </div>
                      )}

                      {toolTestResult.data !== undefined && (
                        <div>
                          <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '4px' }}>
                            {s.webhookResponseTitle}
                          </div>
                          <pre
                            style={{
                              margin: 0,
                              padding: '12px',
                              borderRadius: '8px',
                              background: 'var(--x-alt)',
                              border: '1px solid var(--x-border)',
                              fontFamily: 'monospace',
                              fontSize: '12px',
                              overflow: 'auto',
                              maxHeight: '240px',
                            }}
                          >
                            {JSON.stringify(toolTestResult.data, null, 2)}
                          </pre>
                        </div>
                      )}
                    </div>
                  )}
                </section>
              )}
            </div>
          )}

          {/* --------------------------------------------------------------- */}
          {/* TAB 3: DATABASE & POLICIES (MODE B)                             */}
          {/* --------------------------------------------------------------- */}
          {activeTab === 'database' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
              {/* Header & Add Button */}
              <section className="x-panel" style={{ padding: '20px 24px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '14px' }}>
                  <div>
                    <h3 style={{ margin: '0 0 4px', fontSize: '16px', fontWeight: 600 }}>{s.dbSourcesTitle}</h3>
                    <p style={{ margin: 0, fontSize: '12px', color: 'var(--x-muted)' }}>{s.dbSourcesDesc}</p>
                  </div>
                  {canEdit && (
                    <button
                      type="button"
                      className="x-button x-primary x-small"
                      onClick={() => setShowAddDbDialog(true)}
                    >
                      <Plus size={14} />
                      <span>{s.addDbSource}</span>
                    </button>
                  )}
                </div>

                {/* Sources List */}
                <div style={{ marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
                  {dbSources.map(source => (
                    <div
                      key={source.id}
                      style={{
                        padding: '16px',
                        borderRadius: '10px',
                        border: '1px solid var(--x-border)',
                        background: 'var(--x-alt)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '12px',
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                          <Database size={18} color="var(--x-primary)" />
                          <strong>{source.name}</strong>
                          <span className="x-badge">
                            {source.driver}
                          </span>
                          <span className="x-badge">
                            Max {source.maxRows} rows
                          </span>
                        </div>
                        {canEdit && (
                          <button
                            type="button"
                            className="x-icon-button x-danger"
                            aria-label={`${s.delete} ${source.name}`}
                            onClick={() => {
                              if (window.confirm(s.deleteDbSourceConfirm)) {
                                deleteDbSourceMutation.mutate(source.id)
                              }
                            }}
                          >
                            <Trash2 size={15} />
                          </button>
                        )}
                      </div>

                      {/* Policies Overview */}
                      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                        {source.tablePolicies.map(pol => (
                          <div
                            key={pol.tableName}
                            style={{
                              padding: '6px 10px',
                              borderRadius: '6px',
                              background: 'var(--x-panel)',
                              border: '1px solid var(--x-border)',
                              fontSize: '11px',
                              display: 'flex',
                              flexDirection: 'column',
                              gap: '2px',
                            }}
                          >
                            <span style={{ fontWeight: 600 }}>Table: {pol.tableName}</span>
                            <span style={{ color: 'var(--x-muted)' }}>
                              Roles: {pol.allowedRoles.join(', ')}
                            </span>
                            {pol.rowOwnerColumn && (
                              <span style={{ color: '#10b981' }}>
                                Owner: {pol.rowOwnerColumn}
                              </span>
                            )}
                            {pol.deniedColumns && pol.deniedColumns.length > 0 && (
                              <span style={{ color: 'var(--x-red)' }}>
                                Denied: {pol.deniedColumns.join(', ')}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}

                  {dbSources.length === 0 && (
                    <div style={{ textAlign: 'center', padding: '30px', color: 'var(--x-muted)' }}>
                      {s.noDbSources}
                    </div>
                  )}
                </div>
              </section>

              {/* Live SQL Role Policy Tester */}
              {dbSources.length > 0 && (
                <section className="x-panel" style={{ padding: '24px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' }}>
                    <Code2 size={20} color="var(--x-primary)" />
                    <div>
                      <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 600 }}>{s.sqlTesterTitle}</h3>
                      <p style={{ margin: 0, fontSize: '12px', color: 'var(--x-muted)' }}>{s.sqlTesterDesc}</p>
                    </div>
                  </div>

                  {/* Controls */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '14px', marginBottom: '16px' }}>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', fontWeight: 500 }}>
                      <span>Database Source</span>
                      <select
                        style={{
                          padding: '7px 10px',
                          borderRadius: '8px',
                          border: '1px solid var(--x-border)',
                          background: 'var(--x-panel)',
                          color: 'var(--x-text)',
                        }}
                        value={selectedDbSourceId ?? dbSources[0]?.id ?? ''}
                        onChange={e => setSelectedDbSourceId(Number(e.target.value))}
                      >
                        {dbSources.map(d => (
                          <option key={d.id} value={d.id}>
                            {d.name} ({d.driver})
                          </option>
                        ))}
                      </select>
                    </label>

                    <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', fontWeight: 500 }}>
                      <span>Simulated Role</span>
                      <select
                        style={{
                          padding: '7px 10px',
                          borderRadius: '8px',
                          border: '1px solid var(--x-border)',
                          background: 'var(--x-panel)',
                          color: 'var(--x-text)',
                        }}
                        value={sqlRole}
                        onChange={e => setSqlRole(e.target.value)}
                      >
                        <option value="guest">guest</option>
                        <option value="customer">customer</option>
                        <option value="staff">staff</option>
                        <option value="admin">admin</option>
                      </select>
                    </label>

                    <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', fontWeight: 500 }}>
                      <span>Simulated User ID</span>
                      <input
                        type="text"
                        style={{
                          padding: '7px 10px',
                          borderRadius: '8px',
                          border: '1px solid var(--x-border)',
                          background: 'var(--x-bg)',
                          color: 'var(--x-text)',
                        }}
                        value={sqlUserId}
                        onChange={e => setSqlUserId(e.target.value)}
                      />
                    </label>
                  </div>

                  {/* Preset Buttons */}
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' }}>
                    <button
                      type="button"
                      className="x-button x-small"
                      onClick={() => {
                        setSqlRole('guest')
                        setSqlQuery('SELECT * FROM products')
                      }}
                    >
                      {s.presetProductsGuest}
                    </button>
                    <button
                      type="button"
                      className="x-button x-small"
                      onClick={() => {
                        setSqlRole('customer')
                        setSqlUserId('cust_101')
                        setSqlQuery('SELECT * FROM orders')
                      }}
                    >
                      {s.presetOrdersCust101}
                    </button>
                    <button
                      type="button"
                      className="x-button x-small"
                      onClick={() => {
                        setSqlRole('customer')
                        setSqlQuery('SELECT * FROM customers')
                      }}
                    >
                      {s.presetCustomersDenied}
                    </button>
                    <button
                      type="button"
                      className="x-button x-small"
                      onClick={() => {
                        setSqlQuery('DROP TABLE products;')
                      }}
                    >
                      {s.presetMaliciousDrop}
                    </button>
                  </div>

                  {/* SQL Textarea */}
                  <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', fontWeight: 500 }}>
                    <span>{s.sqlQueryLabel}</span>
                    <textarea
                      rows={3}
                      style={{
                        padding: '10px 12px',
                        borderRadius: '8px',
                        border: '1px solid var(--x-border)',
                        background: 'var(--x-bg)',
                        color: 'var(--x-text)',
                        fontFamily: 'monospace',
                        fontSize: '12px',
                      }}
                      value={sqlQuery}
                      onChange={e => setSqlQuery(e.target.value)}
                    />
                  </label>

                  <div style={{ marginTop: '14px', display: 'flex', justifyContent: 'flex-end' }}>
                    <button
                      type="button"
                      className="x-button x-primary x-small"
                      disabled={testSqlQueryMutation.isPending}
                      onClick={() => {
                        const targetId = selectedDbSourceId ?? dbSources[0]?.id
                        if (targetId) testSqlQueryMutation.mutate({ sourceId: targetId })
                      }}
                    >
                      <Play size={13} />
                      <span>{testSqlQueryMutation.isPending ? s.testingSql : s.runSqlTestButton}</span>
                    </button>
                  </div>

                  {/* SQL Test Results Panel */}
                  {sqlTestResult && (
                    <div style={{ marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
                      {sqlTestResult.error ? (
                        <div className="x-error" style={{ margin: 0 }}>
                          {sqlTestResult.error}
                        </div>
                      ) : (
                        <>
                          {sqlTestResult.rewrittenSql && (
                            <div>
                              <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '4px' }}>
                                {s.rewrittenSqlTitle} <small style={{ color: 'var(--x-muted)', fontWeight: 400 }}>({s.rewrittenSqlHelp})</small>
                              </div>
                              <pre
                                style={{
                                  margin: 0,
                                  padding: '12px',
                                  borderRadius: '8px',
                                  background: 'var(--x-alt)',
                                  border: '1px solid var(--x-border)',
                                  fontFamily: 'monospace',
                                  fontSize: '12px',
                                  overflow: 'auto',
                                  color: '#10b981',
                                }}
                              >
                                {sqlTestResult.rewrittenSql}
                              </pre>
                            </div>
                          )}

                          {sqlTestResult.rows && (
                            <div>
                              <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '6px' }}>
                                {s.queryResultsTitle} ({sqlTestResult.rowCount ?? sqlTestResult.rows.length} {s.rowsCount})
                              </div>
                              <div className="x-table-wrap">
                                <table className="x-table">
                                  <thead>
                                    <tr>
                                      {Object.keys(sqlTestResult.rows[0] ?? {}).map(col => (
                                        <th key={col}>{col}</th>
                                      ))}
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {sqlTestResult.rows.map((row, idx) => (
                                      <tr key={idx}>
                                        {Object.values(row).map((val, cIdx) => (
                                          <td key={cIdx}>{String(val ?? 'NULL')}</td>
                                        ))}
                                      </tr>
                                    ))}
                                    {sqlTestResult.rows.length === 0 && (
                                      <tr>
                                        <td colSpan={5} style={{ textAlign: 'center', color: 'var(--x-muted)' }}>
                                          0 rows returned.
                                        </td>
                                      </tr>
                                    )}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </section>
              )}
            </div>
          )}

          {/* --------------------------------------------------------------- */}
          {/* TAB 4: LIVE ROLE SIMULATOR                                      */}
          {/* --------------------------------------------------------------- */}
          {activeTab === 'simulator' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              {/* Persona Bar */}
              <section className="x-panel" style={{ padding: '18px 24px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '14px' }}>
                  <div>
                    <h3 style={{ margin: '0 0 4px', fontSize: '15px', fontWeight: 600 }}>{s.simulatorTitle}</h3>
                    <p style={{ margin: 0, fontSize: '12px', color: 'var(--x-muted)' }}>{s.simulatorDesc}</p>
                  </div>

                  {/* Preset Persona Quick Buttons */}
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className={`x-button x-small ${simRole === 'guest' ? 'x-primary' : ''}`}
                      onClick={() => applyPersonaPreset('guest')}
                    >
                      <User size={12} />
                      <span>{s.presetGuest}</span>
                    </button>
                    <button
                      type="button"
                      className={`x-button x-small ${simUserId === 'cust_101' ? 'x-primary' : ''}`}
                      onClick={() => applyPersonaPreset('alice')}
                    >
                      <Users size={12} />
                      <span>{s.presetCustomerAlice}</span>
                    </button>
                    <button
                      type="button"
                      className={`x-button x-small ${simUserId === 'cust_102' ? 'x-primary' : ''}`}
                      onClick={() => applyPersonaPreset('bob')}
                    >
                      <Users size={12} />
                      <span>{s.presetCustomerBob}</span>
                    </button>
                    <button
                      type="button"
                      className={`x-button x-small ${simRole === 'admin' ? 'x-primary' : ''}`}
                      onClick={() => applyPersonaPreset('admin')}
                    >
                      <ShieldCheck size={12} />
                      <span>{s.presetAdmin}</span>
                    </button>
                  </div>
                </div>

                {/* Identity Inputs */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px', marginTop: '16px' }}>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px', fontWeight: 600 }}>
                    <span>ROLE</span>
                    <select
                      style={{
                        padding: '6px 10px',
                        borderRadius: '6px',
                        border: '1px solid var(--x-border)',
                        background: 'var(--x-panel)',
                        color: 'var(--x-text)',
                        fontSize: '12px',
                      }}
                      value={simRole}
                      onChange={e => setSimRole(e.target.value as typeof simRole)}
                    >
                      <option value="guest">guest</option>
                      <option value="customer">customer</option>
                      <option value="staff">staff</option>
                      <option value="admin">admin</option>
                    </select>
                  </label>

                  <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px', fontWeight: 600 }}>
                    <span>USER ID</span>
                    <input
                      type="text"
                      style={{
                        padding: '6px 10px',
                        borderRadius: '6px',
                        border: '1px solid var(--x-border)',
                        background: 'var(--x-bg)',
                        color: 'var(--x-text)',
                        fontSize: '12px',
                      }}
                      value={simUserId}
                      onChange={e => setSimUserId(e.target.value)}
                    />
                  </label>

                  <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px', fontWeight: 600 }}>
                    <span>CUSTOMER NAME</span>
                    <input
                      type="text"
                      style={{
                        padding: '6px 10px',
                        borderRadius: '6px',
                        border: '1px solid var(--x-border)',
                        background: 'var(--x-bg)',
                        color: 'var(--x-text)',
                        fontSize: '12px',
                      }}
                      value={simUserName}
                      onChange={e => setSimUserName(e.target.value)}
                    />
                  </label>
                </div>

                {/* Allowed Tools live badge summary */}
                <div style={{ marginTop: '12px', display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '11px', color: 'var(--x-muted)', fontWeight: 500 }}>
                    {s.allowedToolsBadges}:
                  </span>
                  <span className="x-badge x-green" style={{ fontSize: '10px' }}>
                    products:read
                  </span>
                  {simRole !== 'guest' && (
                    <span className="x-badge x-green" style={{ fontSize: '10px' }}>
                      orders:read_own ({simUserId})
                    </span>
                  )}
                  {['admin', 'staff'].includes(simRole) && (
                    <>
                      <span className="x-badge x-green" style={{ fontSize: '10px' }}>
                        orders:read_all
                      </span>
                      <span className="x-badge x-green" style={{ fontSize: '10px' }}>
                        customers:read
                      </span>
                    </>
                  )}
                </div>
              </section>

              {/* Chat Thread Panel */}
              <section className="x-panel" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <Bot size={18} color="var(--x-primary)" />
                    <strong style={{ fontSize: '14px' }}>Storefront Support AI Simulator</strong>
                  </div>
                  <button
                    type="button"
                    className="x-button x-small"
                    onClick={() =>
                      setChatMessages([
                        {
                          id: 'welcome',
                          role: 'assistant',
                          content: 'Hello! I am your AI storefront support assistant. How can I help you today?',
                        },
                      ])
                    }
                  >
                    <RefreshCw size={12} />
                    <span>{s.clearChat}</span>
                  </button>
                </div>

                {/* Messages Container */}
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '12px',
                    minHeight: '260px',
                    maxHeight: '440px',
                    overflowY: 'auto',
                    padding: '12px',
                    borderRadius: '8px',
                    background: 'var(--x-bg)',
                    border: '1px solid var(--x-border)',
                  }}
                >
                  {chatMessages.map(msg => (
                    <div
                      key={msg.id}
                      style={{
                        alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
                        maxWidth: '85%',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '6px',
                      }}
                    >
                      <div
                        style={{
                          padding: '10px 14px',
                          borderRadius: '12px',
                          background: msg.role === 'user' ? 'var(--x-tint)' : 'var(--x-panel)',
                          border: '1px solid var(--x-border)',
                          color: msg.role === 'user' ? 'var(--x-primary)' : 'var(--x-text)',
                          fontSize: '13px',
                          lineHeight: 1.5,
                          whiteSpace: 'pre-wrap',
                        }}
                      >
                        {msg.content}
                      </div>

                      {/* Tool Execution Trace Box */}
                      {msg.toolTrace && msg.toolTrace.length > 0 && (
                        <div
                          style={{
                            padding: '10px 12px',
                            borderRadius: '8px',
                            background: 'var(--x-alt)',
                            border: '1px solid var(--x-border)',
                            fontSize: '11px',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '6px',
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600 }}>
                            <Terminal size={12} color="var(--x-primary)" />
                            <span>{s.toolTraceTitle}</span>
                          </div>
                          {msg.toolTrace.map((tr, tIdx) => (
                            <div
                              key={tIdx}
                              style={{
                                padding: '6px 8px',
                                borderRadius: '6px',
                                background: 'var(--x-panel)',
                                border: '1px solid var(--x-border)',
                              }}
                            >
                              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '2px' }}>
                                <span className={`x-badge ${tr.kind === 'db' ? 'x-green' : ''}`}>
                                  {tr.kind === 'db' ? 'SQL Query' : 'Webhook Tool'}: {tr.name}
                                </span>
                                {tr.durationMs !== undefined && (
                                  <span style={{ color: 'var(--x-muted)' }}>{tr.durationMs}ms</span>
                                )}
                              </div>
                              {tr.rewrittenSql && (
                                <pre
                                  style={{
                                    margin: '4px 0 0',
                                    padding: '4px',
                                    fontSize: '10px',
                                    fontFamily: 'monospace',
                                    overflowX: 'auto',
                                    color: '#10b981',
                                  }}
                                >
                                  {tr.rewrittenSql}
                                </pre>
                              )}
                              {tr.args && (
                                <pre
                                  style={{
                                    margin: '4px 0 0',
                                    padding: '4px',
                                    fontSize: '10px',
                                    fontFamily: 'monospace',
                                    overflowX: 'auto',
                                  }}
                                >
                                  {JSON.stringify(tr.args, null, 2)}
                                </pre>
                              )}
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Meta badges */}
                      {msg.modelUsed && (
                        <div style={{ fontSize: '10px', color: 'var(--x-muted)', display: 'flex', gap: '8px' }}>
                          <span>Model: {msg.modelUsed}</span>
                          {msg.usage && (
                            <span>
                              Tokens: {msg.usage.total_tokens} (p:{msg.usage.prompt_tokens}, c:{msg.usage.completion_tokens})
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  ))}

                  {simulateChatMutation.isPending && (
                    <div style={{ alignSelf: 'flex-start', padding: '8px 12px', color: 'var(--x-muted)', fontSize: '12px', fontStyle: 'italic' }}>
                      {s.sendingChat}
                    </div>
                  )}
                </div>

                {/* Quick Prompts Chips */}
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="x-button x-small"
                    onClick={() => handleSendChat('What products are currently in stock and what are their prices?')}
                  >
                    {s.quickPromptCatalog}
                  </button>
                  <button
                    type="button"
                    className="x-button x-small"
                    onClick={() => handleSendChat('Can you check the shipping status of my recent orders?')}
                  >
                    {s.quickPromptMyOrders}
                  </button>
                  <button
                    type="button"
                    className="x-button x-small"
                    onClick={() => handleSendChat('Show me all customer orders across the entire database.')}
                  >
                    {s.quickPromptAllOrders}
                  </button>
                  <button
                    type="button"
                    className="x-button x-small"
                    onClick={() => handleSendChat('What is the confidential note recorded for Alice Nguyen?')}
                  >
                    {s.quickPromptSecretNote}
                  </button>
                </div>

                {/* Chat Input Bar */}
                <form
                  onSubmit={(e: FormEvent) => {
                    e.preventDefault()
                    handleSendChat()
                  }}
                  style={{ display: 'flex', gap: '8px' }}
                >
                  <input
                    type="text"
                    style={{
                      flex: 1,
                      padding: '10px 14px',
                      borderRadius: '8px',
                      border: '1px solid var(--x-border)',
                      background: 'var(--x-bg)',
                      color: 'var(--x-text)',
                      fontSize: '13px',
                    }}
                    placeholder={s.chatPlaceholder}
                    value={simInput}
                    onChange={e => setSimInput(e.target.value)}
                    disabled={simulateChatMutation.isPending}
                  />
                  <button
                    type="submit"
                    className="x-button x-primary"
                    disabled={!simInput.trim() || simulateChatMutation.isPending}
                  >
                    <Send size={15} />
                    <span>{s.sendChat}</span>
                  </button>
                </form>
              </section>
            </div>
          )}

          {/* --------------------------------------------------------------- */}
          {/* TAB 5: EMBED WIDGET & INTEGRATION                               */}
          {/* --------------------------------------------------------------- */}
          {activeTab === 'embed' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
              {/* Widget HTML Snippet */}
              <section className="x-panel" style={{ padding: '24px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                  <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 600 }}>{s.widgetSnippetTitle}</h3>
                  <button
                    type="button"
                    className="x-button x-small"
                    onClick={() =>
                      handleCopy(
                        `<script\n  src="${window.location.origin}/x/v1/support/widget.js"\n  data-tenant-key="${activeTenant.publicKey}"\n  data-endpoint="${window.location.origin}"\n  data-title="${activeTenant.name} AI Assistant"\n  async\n></script>`,
                        'widget-snippet'
                      )
                    }
                  >
                    {copiedKey === 'widget-snippet' ? <Check size={14} /> : <Copy size={14} />}
                    <span>{copiedKey === 'widget-snippet' ? s.copied : s.copy}</span>
                  </button>
                </div>
                <p style={{ margin: '0 0 14px', fontSize: '12px', color: 'var(--x-muted)' }}>{s.widgetSnippetDesc}</p>
                <pre
                  style={{
                    margin: 0,
                    padding: '16px',
                    borderRadius: '8px',
                    background: 'var(--x-alt)',
                    border: '1px solid var(--x-border)',
                    fontFamily: 'monospace',
                    fontSize: '12px',
                    overflowX: 'auto',
                    lineHeight: 1.6,
                  }}
                >
{`<!-- FreeLLMAPI AI Support Widget -->
<script
  src="${typeof window !== 'undefined' ? window.location.origin : 'https://gateway.example.com'}/x/v1/support/widget.js"
  data-tenant-key="${activeTenant.publicKey}"
  data-endpoint="${typeof window !== 'undefined' ? window.location.origin : 'https://gateway.example.com'}"
  data-title="${activeTenant.name} AI Support"
  async
></script>`}
                </pre>
              </section>

              {/* Backend Session Minting Snippet */}
              <section className="x-panel" style={{ padding: '24px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                  <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 600 }}>{s.backendSnippetTitle}</h3>
                  <button
                    type="button"
                    className="x-button x-small"
                    onClick={() =>
                      handleCopy(
                        `curl -X POST ${window.location.origin}/x/v1/support/session \\\n  -H "Authorization: Bearer <YOUR_SIGNING_SECRET>" \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "tenantKey": "${activeTenant.publicKey}",\n    "userId": "cust_101",\n    "name": "Customer Name",\n    "role": "customer"\n  }'`,
                        'backend-curl'
                      )
                    }
                  >
                    {copiedKey === 'backend-curl' ? <Check size={14} /> : <Copy size={14} />}
                    <span>{copiedKey === 'backend-curl' ? s.copied : s.copy}</span>
                  </button>
                </div>
                <p style={{ margin: '0 0 14px', fontSize: '12px', color: 'var(--x-muted)' }}>{s.backendSnippetDesc}</p>
                <pre
                  style={{
                    margin: 0,
                    padding: '16px',
                    borderRadius: '8px',
                    background: 'var(--x-alt)',
                    border: '1px solid var(--x-border)',
                    fontFamily: 'monospace',
                    fontSize: '12px',
                    overflowX: 'auto',
                    lineHeight: 1.6,
                  }}
                >
{`curl -X POST ${typeof window !== 'undefined' ? window.location.origin : 'https://gateway.example.com'}/x/v1/support/session \\
  -H "Authorization: Bearer <YOUR_SIGNING_SECRET>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "tenantKey": "${activeTenant.publicKey}",
    "userId": "cust_101",
    "name": "Alice Nguyen",
    "role": "customer"
  }'`}
                </pre>
              </section>

              {/* Interactive Context Token Generator */}
              <section className="x-panel" style={{ padding: '24px' }}>
                <h3 style={{ margin: '0 0 4px', fontSize: '15px', fontWeight: 600 }}>{s.mintTokenTitle}</h3>
                <p style={{ margin: '0 0 16px', fontSize: '12px', color: 'var(--x-muted)' }}>{s.mintTokenDesc}</p>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '14px', marginBottom: '16px' }}>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', fontWeight: 500 }}>
                    <span>User ID</span>
                    <input
                      type="text"
                      style={{
                        padding: '7px 10px',
                        borderRadius: '8px',
                        border: '1px solid var(--x-border)',
                        background: 'var(--x-bg)',
                        color: 'var(--x-text)',
                      }}
                      value={mintUserId}
                      onChange={e => setMintUserId(e.target.value)}
                    />
                  </label>

                  <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', fontWeight: 500 }}>
                    <span>Role</span>
                    <select
                      style={{
                        padding: '7px 10px',
                        borderRadius: '8px',
                        border: '1px solid var(--x-border)',
                        background: 'var(--x-panel)',
                        color: 'var(--x-text)',
                      }}
                      value={mintRole}
                      onChange={e => setMintRole(e.target.value)}
                    >
                      <option value="guest">guest</option>
                      <option value="customer">customer</option>
                      <option value="staff">staff</option>
                      <option value="admin">admin</option>
                    </select>
                  </label>

                  <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', fontWeight: 500 }}>
                    <span>Name</span>
                    <input
                      type="text"
                      style={{
                        padding: '7px 10px',
                        borderRadius: '8px',
                        border: '1px solid var(--x-border)',
                        background: 'var(--x-bg)',
                        color: 'var(--x-text)',
                      }}
                      value={mintName}
                      onChange={e => setMintName(e.target.value)}
                    />
                  </label>

                  <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', fontWeight: 500 }}>
                    <span>TTL (Seconds)</span>
                    <input
                      type="number"
                      style={{
                        padding: '7px 10px',
                        borderRadius: '8px',
                        border: '1px solid var(--x-border)',
                        background: 'var(--x-bg)',
                        color: 'var(--x-text)',
                      }}
                      value={mintTtl}
                      onChange={e => setMintTtl(Number(e.target.value))}
                    />
                  </label>
                </div>

                <button
                  type="button"
                  className="x-button x-primary x-small"
                  disabled={mintTokenMutation.isPending}
                  onClick={() => mintTokenMutation.mutate()}
                >
                  <KeyRound size={13} />
                  <span>{mintTokenMutation.isPending ? s.mintingToken : s.mintTokenButton}</span>
                </button>

                {mintedTokenResult && (
                  <div style={{ marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span style={{ fontSize: '12px', fontWeight: 600 }}>{s.generatedToken}:</span>
                      <button
                        type="button"
                        className="x-button x-small"
                        onClick={() => handleCopy(mintedTokenResult.token, 'minted-token')}
                      >
                        {copiedKey === 'minted-token' ? <Check size={12} /> : <Copy size={12} />}
                        <span>{copiedKey === 'minted-token' ? s.copied : s.copy}</span>
                      </button>
                    </div>
                    <pre
                      style={{
                        margin: 0,
                        padding: '10px 12px',
                        borderRadius: '8px',
                        background: 'var(--x-alt)',
                        border: '1px solid var(--x-border)',
                        fontFamily: 'monospace',
                        fontSize: '11px',
                        wordBreak: 'break-all',
                        whiteSpace: 'pre-wrap',
                        color: '#10b981',
                      }}
                    >
                      {mintedTokenResult.token}
                    </pre>

                    <div style={{ fontSize: '12px', fontWeight: 600, marginTop: '6px' }}>
                      {s.userContextPreview}:
                    </div>
                    <pre
                      style={{
                        margin: 0,
                        padding: '10px 12px',
                        borderRadius: '8px',
                        background: 'var(--x-alt)',
                        border: '1px solid var(--x-border)',
                        fontFamily: 'monospace',
                        fontSize: '11px',
                        overflow: 'auto',
                      }}
                    >
                      {JSON.stringify(mintedTokenResult.context, null, 2)}
                    </pre>
                  </div>
                )}
              </section>
            </div>
          )}
        </div>
      )}

      {/* ------------------------------------------------------------------- */}
      {/* DIALOG: CREATE PARTNER TENANT                                       */}
      {/* ------------------------------------------------------------------- */}
      {showCreateTenantDialog && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
            padding: '20px',
          }}
        >
          <div
            className="x-panel"
            style={{
              maxWidth: '520px',
              width: '100%',
              padding: '24px',
              position: 'relative',
              borderRadius: '14px',
            }}
          >
            <button
              type="button"
              className="x-icon-button"
              style={{ position: 'absolute', top: '16px', right: '16px' }}
              aria-label={s.cancel}
              onClick={() => setShowCreateTenantDialog(false)}
            >
              <X size={18} />
            </button>

            <h3 style={{ margin: '0 0 16px', fontSize: '18px', fontWeight: 600 }}>{s.createTenantTitle}</h3>

            <form
              onSubmit={(e: FormEvent) => {
                e.preventDefault()
                createTenantMutation.mutate(createTenantDraft)
              }}
              style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}
            >
              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', fontWeight: 500 }}>
                <span>{s.tenantName} *</span>
                <input
                  type="text"
                  required
                  placeholder="e.g. MyStore Online"
                  style={{
                    padding: '8px 10px',
                    borderRadius: '8px',
                    border: '1px solid var(--x-border)',
                    background: 'var(--x-bg)',
                    color: 'var(--x-text)',
                  }}
                  value={createTenantDraft.name}
                  onChange={e => setCreateTenantDraft({ ...createTenantDraft, name: e.target.value })}
                />
              </label>

              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', fontWeight: 500 }}>
                <span>{s.tenantSlug}</span>
                <input
                  type="text"
                  placeholder="e.g. mystore (auto-generated if empty)"
                  style={{
                    padding: '8px 10px',
                    borderRadius: '8px',
                    border: '1px solid var(--x-border)',
                    background: 'var(--x-bg)',
                    color: 'var(--x-text)',
                  }}
                  value={createTenantDraft.slug}
                  onChange={e => setCreateTenantDraft({ ...createTenantDraft, slug: e.target.value })}
                />
                <small style={{ color: 'var(--x-muted)', fontSize: '11px' }}>{s.tenantSlugHelp}</small>
              </label>

              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', fontWeight: 500 }}>
                <span>{s.defaultModel}</span>
                <input
                  type="text"
                  placeholder="auto"
                  style={{
                    padding: '8px 10px',
                    borderRadius: '8px',
                    border: '1px solid var(--x-border)',
                    background: 'var(--x-bg)',
                    color: 'var(--x-text)',
                  }}
                  value={createTenantDraft.defaultModel}
                  onChange={e => setCreateTenantDraft({ ...createTenantDraft, defaultModel: e.target.value })}
                />
              </label>

              <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={createTenantDraft.allowGuest}
                  onChange={e => setCreateTenantDraft({ ...createTenantDraft, allowGuest: e.target.checked })}
                />
                <div>
                  <span style={{ fontWeight: 600, fontSize: '12px' }}>{s.allowGuest}</span>
                  <div style={{ color: 'var(--x-muted)', fontSize: '11px' }}>{s.allowGuestHelp}</div>
                </div>
              </label>

              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  cursor: 'pointer',
                  padding: '10px',
                  borderRadius: '8px',
                  background: 'var(--x-alt)',
                  border: '1px solid var(--x-border)',
                }}
              >
                <input
                  type="checkbox"
                  checked={createTenantDraft.seedSampleDb}
                  onChange={e => setCreateTenantDraft({ ...createTenantDraft, seedSampleDb: e.target.checked })}
                />
                <div>
                  <span style={{ fontWeight: 600, fontSize: '12px', color: 'var(--x-primary)' }}>
                    {s.seedSampleDb}
                  </span>
                  <div style={{ color: 'var(--x-muted)', fontSize: '11px' }}>{s.seedSampleDbHelp}</div>
                </div>
              </label>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '10px' }}>
                <button
                  type="button"
                  className="x-button"
                  onClick={() => setShowCreateTenantDialog(false)}
                >
                  {s.cancel}
                </button>
                <button
                  type="submit"
                  className="x-button x-primary"
                  disabled={!createTenantDraft.name.trim() || createTenantMutation.isPending}
                >
                  {createTenantMutation.isPending ? s.creating : s.create}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------- */}
      {/* DIALOG: CREATE WEBHOOK TOOL                                         */}
      {/* ------------------------------------------------------------------- */}
      {showAddToolDialog && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
            padding: '20px',
          }}
        >
          <div
            className="x-panel"
            style={{
              maxWidth: '560px',
              width: '100%',
              padding: '24px',
              position: 'relative',
              borderRadius: '14px',
              maxHeight: '90vh',
              overflowY: 'auto',
            }}
          >
            <button
              type="button"
              className="x-icon-button"
              style={{ position: 'absolute', top: '16px', right: '16px' }}
              aria-label={s.cancel}
              onClick={() => setShowAddToolDialog(false)}
            >
              <X size={18} />
            </button>

            <h3 style={{ margin: '0 0 16px', fontSize: '18px', fontWeight: 600 }}>{s.addWebhookTool}</h3>

            <form
              onSubmit={(e: FormEvent) => {
                e.preventDefault()
                createToolMutation.mutate(toolDraft)
              }}
              style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}
            >
              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', fontWeight: 500 }}>
                <span>{s.toolName} *</span>
                <input
                  type="text"
                  required
                  placeholder="e.g. get_customer_orders"
                  style={{
                    padding: '8px 10px',
                    borderRadius: '8px',
                    border: '1px solid var(--x-border)',
                    background: 'var(--x-bg)',
                    color: 'var(--x-text)',
                  }}
                  value={toolDraft.name}
                  onChange={e => setToolDraft({ ...toolDraft, name: e.target.value })}
                />
              </label>

              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', fontWeight: 500 }}>
                <span>{s.toolDescription} *</span>
                <textarea
                  rows={2}
                  required
                  placeholder="Describe what the tool queries or executes..."
                  style={{
                    padding: '8px 10px',
                    borderRadius: '8px',
                    border: '1px solid var(--x-border)',
                    background: 'var(--x-bg)',
                    color: 'var(--x-text)',
                  }}
                  value={toolDraft.description}
                  onChange={e => setToolDraft({ ...toolDraft, description: e.target.value })}
                />
              </label>

              <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: '10px' }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', fontWeight: 500 }}>
                  <span>{s.toolMethod}</span>
                  <select
                    style={{
                      padding: '8px 10px',
                      borderRadius: '8px',
                      border: '1px solid var(--x-border)',
                      background: 'var(--x-panel)',
                      color: 'var(--x-text)',
                    }}
                    value={toolDraft.method}
                    onChange={e => setToolDraft({ ...toolDraft, method: e.target.value as 'GET' | 'POST' })}
                  >
                    <option value="GET">GET</option>
                    <option value="POST">POST</option>
                  </select>
                </label>

                <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', fontWeight: 500 }}>
                  <span>{s.toolEndpointUrl} *</span>
                  <input
                    type="url"
                    required
                    placeholder="https://api.example.com/v1/orders"
                    style={{
                      padding: '8px 10px',
                      borderRadius: '8px',
                      border: '1px solid var(--x-border)',
                      background: 'var(--x-bg)',
                      color: 'var(--x-text)',
                    }}
                    value={toolDraft.endpointUrl}
                    onChange={e => setToolDraft({ ...toolDraft, endpointUrl: e.target.value })}
                  />
                </label>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', fontWeight: 500 }}>
                  <span>{s.allowedRoles} *</span>
                  <input
                    type="text"
                    required
                    placeholder="customer, staff, admin"
                    style={{
                      padding: '8px 10px',
                      borderRadius: '8px',
                      border: '1px solid var(--x-border)',
                      background: 'var(--x-bg)',
                      color: 'var(--x-text)',
                    }}
                    value={toolDraft.allowedRoles}
                    onChange={e => setToolDraft({ ...toolDraft, allowedRoles: e.target.value })}
                  />
                  <small style={{ color: 'var(--x-muted)', fontSize: '11px' }}>{s.allowedRolesHelp}</small>
                </label>

                <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', fontWeight: 500 }}>
                  <span>{s.lockUserIdParam}</span>
                  <input
                    type="text"
                    placeholder="user_id"
                    style={{
                      padding: '8px 10px',
                      borderRadius: '8px',
                      border: '1px solid var(--x-border)',
                      background: 'var(--x-bg)',
                      color: 'var(--x-text)',
                    }}
                    value={toolDraft.lockUserIdParam}
                    onChange={e => setToolDraft({ ...toolDraft, lockUserIdParam: e.target.value })}
                  />
                  <small style={{ color: 'var(--x-muted)', fontSize: '11px' }}>{s.lockUserIdParamHelp}</small>
                </label>
              </div>

              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', fontWeight: 500 }}>
                <span>{s.bypassUserLockRoles}</span>
                <input
                  type="text"
                  placeholder="admin, staff"
                  style={{
                    padding: '8px 10px',
                    borderRadius: '8px',
                    border: '1px solid var(--x-border)',
                    background: 'var(--x-bg)',
                    color: 'var(--x-text)',
                  }}
                  value={toolDraft.bypassUserLockRoles}
                  onChange={e => setToolDraft({ ...toolDraft, bypassUserLockRoles: e.target.value })}
                />
                <small style={{ color: 'var(--x-muted)', fontSize: '11px' }}>{s.bypassUserLockRolesHelp}</small>
              </label>

              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', fontWeight: 500 }}>
                <span>{s.toolParametersSchema}</span>
                <textarea
                  rows={4}
                  style={{
                    padding: '8px 10px',
                    borderRadius: '8px',
                    border: '1px solid var(--x-border)',
                    background: 'var(--x-bg)',
                    color: 'var(--x-text)',
                    fontFamily: 'monospace',
                    fontSize: '11px',
                  }}
                  value={toolDraft.parametersSchema}
                  onChange={e => setToolDraft({ ...toolDraft, parametersSchema: e.target.value })}
                />
              </label>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '10px' }}>
                <button
                  type="button"
                  className="x-button"
                  onClick={() => setShowAddToolDialog(false)}
                >
                  {s.cancel}
                </button>
                <button
                  type="submit"
                  className="x-button x-primary"
                  disabled={createToolMutation.isPending}
                >
                  {createToolMutation.isPending ? s.saving : s.save}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------- */}
      {/* DIALOG: CREATE DATABASE SOURCE                                      */}
      {/* ------------------------------------------------------------------- */}
      {showAddDbDialog && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
            padding: '20px',
          }}
        >
          <div
            className="x-panel"
            style={{
              maxWidth: '640px',
              width: '100%',
              padding: '24px',
              position: 'relative',
              borderRadius: '14px',
              maxHeight: '90vh',
              overflowY: 'auto',
            }}
          >
            <button
              type="button"
              className="x-icon-button"
              style={{ position: 'absolute', top: '16px', right: '16px' }}
              aria-label={s.cancel}
              onClick={() => setShowAddDbDialog(false)}
            >
              <X size={18} />
            </button>

            <h3 style={{ margin: '0 0 16px', fontSize: '18px', fontWeight: 600 }}>{s.addDbSource}</h3>

            <form
              onSubmit={(e: FormEvent) => {
                e.preventDefault()
                createDbSourceMutation.mutate(dbSourceDraft)
              }}
              style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}
            >
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px' }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', fontWeight: 500 }}>
                  <span>{s.sourceName} *</span>
                  <input
                    type="text"
                    required
                    style={{
                      padding: '8px 10px',
                      borderRadius: '8px',
                      border: '1px solid var(--x-border)',
                      background: 'var(--x-bg)',
                      color: 'var(--x-text)',
                    }}
                    value={dbSourceDraft.name}
                    onChange={e => setDbSourceDraft({ ...dbSourceDraft, name: e.target.value })}
                  />
                </label>

                <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', fontWeight: 500 }}>
                  <span>{s.driver}</span>
                  <select
                    style={{
                      padding: '8px 10px',
                      borderRadius: '8px',
                      border: '1px solid var(--x-border)',
                      background: 'var(--x-panel)',
                      color: 'var(--x-text)',
                    }}
                    value={dbSourceDraft.driver}
                    onChange={e =>
                      setDbSourceDraft({
                        ...dbSourceDraft,
                        driver: e.target.value as 'sqlite-sandbox' | 'sql-http',
                      })
                    }
                  >
                    <option value="sqlite-sandbox">sqlite-sandbox (In-Process Isolated DB)</option>
                    <option value="sql-http">sql-http (Remote SQL Gateway)</option>
                  </select>
                </label>
              </div>

              {dbSourceDraft.driver === 'sql-http' && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', fontWeight: 500 }}>
                    <span>{s.connectionUrl} *</span>
                    <input
                      type="url"
                      required
                      placeholder="https://db.example.com/query"
                      style={{
                        padding: '8px 10px',
                        borderRadius: '8px',
                        border: '1px solid var(--x-border)',
                        background: 'var(--x-bg)',
                        color: 'var(--x-text)',
                      }}
                      value={dbSourceDraft.connectionUrl}
                      onChange={e => setDbSourceDraft({ ...dbSourceDraft, connectionUrl: e.target.value })}
                    />
                  </label>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', fontWeight: 500 }}>
                    <span>{s.authToken}</span>
                    <input
                      type="password"
                      placeholder="Optional bearer token"
                      style={{
                        padding: '8px 10px',
                        borderRadius: '8px',
                        border: '1px solid var(--x-border)',
                        background: 'var(--x-bg)',
                        color: 'var(--x-text)',
                      }}
                      value={dbSourceDraft.authToken}
                      onChange={e => setDbSourceDraft({ ...dbSourceDraft, authToken: e.target.value })}
                    />
                  </label>
                </div>
              )}

              {/* Schema SQL & Load Sample Button */}
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                  <span style={{ fontSize: '12px', fontWeight: 500 }}>{s.schemaSql}</span>
                  <button
                    type="button"
                    className="x-button x-small"
                    onClick={() => {
                      setDbSourceDraft({
                        ...dbSourceDraft,
                        schemaSql: DEFAULT_SAMPLE_SQL,
                        tablePolicies: DEFAULT_SAMPLE_TABLE_POLICIES,
                      })
                    }}
                  >
                    <Database size={13} />
                    <span>{s.loadSampleSql}</span>
                  </button>
                </div>
                <textarea
                  rows={5}
                  style={{
                    width: '100%',
                    padding: '8px 10px',
                    borderRadius: '8px',
                    border: '1px solid var(--x-border)',
                    background: 'var(--x-bg)',
                    color: 'var(--x-text)',
                    fontFamily: 'monospace',
                    fontSize: '11px',
                  }}
                  value={dbSourceDraft.schemaSql}
                  onChange={e => setDbSourceDraft({ ...dbSourceDraft, schemaSql: e.target.value })}
                />
              </div>

              {/* Table Policies Editor */}
              <div style={{ borderTop: '1px solid var(--x-border)', paddingTop: '14px' }}>
                <h4 style={{ margin: '0 0 4px', fontSize: '13px', fontWeight: 600 }}>{s.tablePoliciesTitle}</h4>
                <p style={{ margin: '0 0 10px', fontSize: '11px', color: 'var(--x-muted)' }}>{s.tablePoliciesDesc}</p>

                <div className="x-table-wrap">
                  <table className="x-table">
                    <thead>
                      <tr>
                        <th>{s.tableName}</th>
                        <th>{s.allowedRoles}</th>
                        <th>{s.rowOwnerColumn}</th>
                        <th>{s.deniedColumns}</th>
                        <th>{s.actions}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dbSourceDraft.tablePolicies.map(pol => (
                        <tr key={pol.tableName}>
                          <td><strong>{pol.tableName}</strong></td>
                          <td>{pol.allowedRoles.join(', ')}</td>
                          <td>{pol.rowOwnerColumn || '—'}</td>
                          <td>{pol.deniedColumns?.join(', ') || '—'}</td>
                          <td>
                            <button
                              type="button"
                              className="x-icon-button x-danger"
                              aria-label={`${s.delete} ${pol.tableName}`}
                              onClick={() => handleRemoveTablePolicy(pol.tableName)}
                            >
                              <Trash2 size={13} />
                            </button>
                          </td>
                        </tr>
                      ))}
                      {/* Add Policy Row */}
                      <tr>
                        <td>
                          <input
                            type="text"
                            placeholder="table_name"
                            value={newTablePolicyDraft.tableName}
                            onChange={e => setNewTablePolicyDraft({ ...newTablePolicyDraft, tableName: e.target.value })}
                            style={{ padding: '4px 6px', fontSize: '11px', width: '90px' }}
                          />
                        </td>
                        <td>
                          <input
                            type="text"
                            placeholder="customer, admin"
                            value={newTablePolicyDraft.allowedRoles}
                            onChange={e => setNewTablePolicyDraft({ ...newTablePolicyDraft, allowedRoles: e.target.value })}
                            style={{ padding: '4px 6px', fontSize: '11px', width: '110px' }}
                          />
                        </td>
                        <td>
                          <input
                            type="text"
                            placeholder="user_id"
                            value={newTablePolicyDraft.rowOwnerColumn}
                            onChange={e => setNewTablePolicyDraft({ ...newTablePolicyDraft, rowOwnerColumn: e.target.value })}
                            style={{ padding: '4px 6px', fontSize: '11px', width: '80px' }}
                          />
                        </td>
                        <td>
                          <input
                            type="text"
                            placeholder="secret_col"
                            value={newTablePolicyDraft.deniedColumns}
                            onChange={e => setNewTablePolicyDraft({ ...newTablePolicyDraft, deniedColumns: e.target.value })}
                            style={{ padding: '4px 6px', fontSize: '11px', width: '100px' }}
                          />
                        </td>
                        <td>
                          <button
                            type="button"
                            className="x-button x-small"
                            onClick={handleAddTablePolicy}
                            disabled={!newTablePolicyDraft.tableName.trim()}
                          >
                            <Plus size={12} />
                          </button>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '10px' }}>
                <button
                  type="button"
                  className="x-button"
                  onClick={() => setShowAddDbDialog(false)}
                >
                  {s.cancel}
                </button>
                <button
                  type="submit"
                  className="x-button x-primary"
                  disabled={createDbSourceMutation.isPending}
                >
                  {createDbSourceMutation.isPending ? s.saving : s.save}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
