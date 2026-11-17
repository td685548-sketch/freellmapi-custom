import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  Eye,
  Globe,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Trash2,
  UserCheck,
  X,
} from 'lucide-react'
import type { SupportDeskPublicWidgetConfig } from '@freellmapi/shared/support-service-desk.js'
import {
  SUPPORT_LIVE_TEST_PERSONA_PRESETS,
  type SupportLiveTestActionReviewResponse,
  type SupportLiveTestOriginCheckResponse,
  type SupportLiveTestPendingActionsListResponse,
  type SupportLiveTestPersonaInput,
  type SupportLiveTestPersonaMode,
  type SupportLiveTestPersonaSessionResponse,
  type SupportLiveTestSandboxCleanupResponse,
  type SupportLiveTestSandboxStats,
  type SupportLiveTestTurnDiagnostic,
  type SupportLiveTestViewMode,
} from '@freellmapi/shared/support-service-desk-live-test.js'
import { apiFetch } from '@/lib/api'
import { useI18n } from '@/i18n'
import { useSupportServiceDeskLiveTestStrings } from '../support-service-desk-live-test-strings'
import SupportWidgetPreview from './SupportWidgetPreview'

const API_BASE = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '')
const TOKEN_STORAGE_KEY = 'freellmapi_dashboard_token'

export interface LiveTestTenantInfo {
  id: number
  name: string
  slug: string
  publicKey: string
  defaultModel: string
  allowedOrigins: string[]
  enabled: boolean
  allowGuest?: boolean
  rolesConfig?: Array<{
    role: string
    label?: string
    description?: string
    permissions: string[]
  }>
}

interface WidgetRuntimeInstance {
  destroy?: () => void
  refreshProfile?: () => Promise<unknown> | void
  syncConversation?: () => void
  getConversationId?: () => string | null
  open?: () => void
}

interface FreeLLMAPISupportGlobal {
  init?: (config: {
    container: HTMLElement
    tenantKey: string
    contextToken?: string
    allowGuestSession?: boolean
    locale?: string
    loadTenantProfile?: boolean
    startOpen?: boolean
    pollInterval?: number
    storageScope?: string
    transport?: (url: string, init?: RequestInit) => Promise<Response>
  }) => WidgetRuntimeInstance
}

function getWidgetGlobal(): FreeLLMAPISupportGlobal | undefined {
  return (window as unknown as { FreeLLMAPISupport?: FreeLLMAPISupportGlobal }).FreeLLMAPISupport
}

function readDashboardToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_STORAGE_KEY)
  } catch {
    return null
  }
}

function normalizeBridgeSubpath(rawUrl: string): string {
  let pathAndQuery = rawUrl.trim()
  if (/^https?:\/\//i.test(pathAndQuery)) {
    try {
      const parsed = new URL(pathAndQuery)
      pathAndQuery = `${parsed.pathname}${parsed.search}`
    } catch {
      // keep raw pathAndQuery if URL construction fails
    }
  }
  const bridgePrefixes = ['/thruline/v1/support/service-desk', '/thruline/v1/support']
  for (const prefix of bridgePrefixes) {
    const idx = pathAndQuery.indexOf(prefix)
    if (idx !== -1) {
      const rest = pathAndQuery.slice(idx + prefix.length)
      return rest.startsWith('/') ? rest : `/${rest}`
    }
  }
  return pathAndQuery.startsWith('/') ? pathAndQuery : `/${pathAndQuery}`
}

function buildPersonaSignature(persona: SupportLiveTestPersonaInput): string {
  if (persona.mode === 'guest') return 'guest'
  const perms = [...(persona.permissions ?? [])].sort().join(',')
  return `${persona.role ?? 'customer'}:${persona.userId ?? 'anon'}:${perms}`
}

function ensureWidgetScriptLoaded(scriptSrc: string): Promise<void> {
  if (typeof getWidgetGlobal()?.init === 'function') {
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    const existing = Array.from(document.querySelectorAll('script')).find((s) =>
      s.getAttribute('src')?.includes('support/widget.js'),
    )
    if (existing) {
      if (typeof getWidgetGlobal()?.init === 'function') {
        resolve()
        return
      }
      const onLoad = () => {
        existing.removeEventListener('load', onLoad)
        existing.removeEventListener('error', onError)
        if (typeof getWidgetGlobal()?.init === 'function') resolve()
        else reject(new Error('Widget runtime init unavailable.'))
      }
      const onError = () => {
        existing.removeEventListener('load', onLoad)
        existing.removeEventListener('error', onError)
        reject(new Error('Failed to load support widget script.'))
      }
      existing.addEventListener('load', onLoad)
      existing.addEventListener('error', onError)
      return
    }

    const script = document.createElement('script')
    script.src = scriptSrc
    script.async = true
    script.onload = () => {
      if (typeof getWidgetGlobal()?.init === 'function') resolve()
      else reject(new Error('Widget runtime init unavailable.'))
    }
    script.onerror = () => reject(new Error('Failed to load support widget script.'))
    document.head.appendChild(script)
  })
}

export interface SupportWidgetLiveTestProps {
  tenant: LiveTestTenantInfo
  publicConfig: SupportDeskPublicWidgetConfig
  hasUnsavedChanges: boolean
  isSavingConfig?: boolean
  onSaveAndApply: () => void | Promise<void>
  savedEnabled: boolean
  savedConfigVersion: number
  mode: SupportLiveTestViewMode
  onModeChange: (mode: SupportLiveTestViewMode) => void
  persona: SupportLiveTestPersonaInput
  sessionEpoch: number
  personaSession: SupportLiveTestPersonaSessionResponse | null
  onApplyPersona: (
    nextPersona: SupportLiveTestPersonaInput,
    nextSession: SupportLiveTestPersonaSessionResponse,
  ) => void
  onResetConversation: () => void
  simulatedOrigin: string
  onSimulatedOriginChange: (origin: string) => void
  enforceSimulatedOrigin: boolean
  onEnforceSimulatedOriginChange: (enforce: boolean) => void
  originCheckResult: SupportLiveTestOriginCheckResponse | null
  onOriginCheckResult: (result: SupportLiveTestOriginCheckResponse | null) => void
  diagnostics: SupportLiveTestTurnDiagnostic[]
  onAppendDiagnostic: (entry: SupportLiveTestTurnDiagnostic) => void
  activeConversationId: string | null
  onConversationIdDetected: (convId: string | null) => void
  onOpenInCopilot: (convId: string) => void
  onRefreshTenantQueries?: () => void
}

export function SupportWidgetLiveTest({
  tenant,
  publicConfig,
  hasUnsavedChanges,
  isSavingConfig = false,
  onSaveAndApply,
  savedEnabled,
  savedConfigVersion,
  mode,
  onModeChange,
  persona,
  sessionEpoch,
  personaSession,
  onApplyPersona,
  onResetConversation,
  simulatedOrigin,
  onSimulatedOriginChange,
  enforceSimulatedOrigin,
  onEnforceSimulatedOriginChange,
  originCheckResult,
  onOriginCheckResult,
  diagnostics,
  onAppendDiagnostic,
  activeConversationId,
  onConversationIdDetected,
  onOpenInCopilot,
  onRefreshTenantQueries,
}: SupportWidgetLiveTestProps) {
  const { locale } = useI18n()
  const s = useSupportServiceDeskLiveTestStrings()
  const queryClient = useQueryClient()

  const [cleanupNotice, setCleanupNotice] = useState<string | null>(null)
  const [cleanupError, setCleanupError] = useState<string | null>(null)
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({})
  const [actionNotice, setActionNotice] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const resolvedConversationId = activeConversationId

  const sandboxQuery = useQuery({
    queryKey: ['x-support-live-test-sandbox', tenant.id],
    enabled: mode === 'live',
    queryFn: ({ signal }) =>
      apiFetch<SupportLiveTestSandboxStats>(
        `/api/thruline/support/tenants/${tenant.id}/service-desk/live-test/sandbox`,
        { signal },
      ),
  })

  const pendingActionsQuery = useQuery({
    queryKey: ['x-support-live-test-pending-actions', tenant.id, resolvedConversationId ?? 'all'],
    enabled: mode === 'live',
    queryFn: ({ signal }) =>
      apiFetch<SupportLiveTestPendingActionsListResponse>(
        `/api/thruline/support/tenants/${tenant.id}/service-desk/live-test/pending-actions${
          resolvedConversationId ? `?conversationId=${encodeURIComponent(resolvedConversationId)}` : ''
        }`,
        { signal },
      ),
  })

  const containerRef = useRef<HTMLDivElement | null>(null)
  const widgetInstanceRef = useRef<WidgetRuntimeInstance | null>(null)
  const prevSavedVersionRef = useRef(savedConfigVersion)
  const prevSavedEnabledRef = useRef(savedEnabled)

  const enforceOriginRef = useRef(enforceSimulatedOrigin)
  const simulatedOriginRef = useRef(simulatedOrigin)
  const onAppendDiagnosticRef = useRef(onAppendDiagnostic)
  const onConversationIdDetectedRef = useRef(onConversationIdDetected)
  const onRefreshTenantQueriesRef = useRef(onRefreshTenantQueries)
  const onRefreshSandboxRef = useRef<() => void>(() => {})

  useEffect(() => {
    enforceOriginRef.current = enforceSimulatedOrigin
    simulatedOriginRef.current = simulatedOrigin
    onAppendDiagnosticRef.current = onAppendDiagnostic
    onConversationIdDetectedRef.current = onConversationIdDetected
    onRefreshTenantQueriesRef.current = onRefreshTenantQueries
    onRefreshSandboxRef.current = () => {
      setCleanupNotice(null)
      setCleanupError(null)
      void queryClient.invalidateQueries({ queryKey: ['x-support-live-test-sandbox', tenant.id] })
      void queryClient.invalidateQueries({
        queryKey: ['x-support-live-test-pending-actions', tenant.id],
      })
    }
  }, [
    enforceSimulatedOrigin,
    simulatedOrigin,
    onAppendDiagnostic,
    onConversationIdDetected,
    onRefreshTenantQueries,
    queryClient,
    tenant.id,
  ])

  const currentPersonaSignature = buildPersonaSignature(persona)
  const [draftEdits, setDraftEdits] = useState<{
    baseSignature: string
    mode: SupportLiveTestPersonaMode
    userId: string
    role: string
    name: string
    email: string
    permissions: string
  } | null>(null)

  const draft =
    draftEdits && draftEdits.baseSignature === currentPersonaSignature
      ? draftEdits
      : {
          baseSignature: currentPersonaSignature,
          mode: persona.mode,
          userId: persona.userId ?? '',
          role: persona.role ?? (persona.mode === 'guest' ? 'guest' : 'customer'),
          name: persona.name ?? '',
          email: persona.email ?? '',
          permissions: (persona.permissions ?? []).join(', '),
        }

  const updateDraft = (
    patch: Partial<{
      mode: SupportLiveTestPersonaMode
      userId: string
      role: string
      name: string
      email: string
      permissions: string
    }>,
  ) => {
    setDraftEdits({ ...draft, ...patch, baseSignature: currentPersonaSignature })
  }

  const draftMode = draft.mode
  const draftUserId = draft.userId
  const draftRole = draft.role
  const draftName = draft.name
  const draftEmail = draft.email
  const draftPermissions = draft.permissions

  const [mintPending, setMintPending] = useState(false)
  const [mintError, setMintError] = useState<string | null>(null)
  const [widgetError, setWidgetError] = useState<string | null>(null)
  const [widgetLoading, setWidgetLoading] = useState(false)
  const [originPending, setOriginPending] = useState(false)
  const [originError, setOriginError] = useState<string | null>(null)

  const autoMintKeyRef = useRef<string | null>(null)

  const roleOptions = useMemo(() => {
    const base = ['guest', 'customer', 'staff', 'admin']
    const fromTenant = (tenant.rolesConfig ?? []).map((r) => r.role)
    return [...new Set([...base, ...fromTenant, ...(draftRole ? [draftRole] : [])])]
  }, [tenant.rolesConfig, draftRole])

  const buildPayloadFromPersona = (input: SupportLiveTestPersonaInput): SupportLiveTestPersonaInput => {
    if (input.mode === 'guest') {
      return { mode: 'guest' }
    }
    const cleanPerms = (input.permissions ?? []).map((p) => p.trim()).filter(Boolean)
    return {
      mode: 'authenticated',
      userId: input.userId?.trim() || '',
      role: input.role?.trim() || 'customer',
      ...(input.name?.trim() ? { name: input.name.trim() } : {}),
      ...(input.email?.trim() ? { email: input.email.trim() } : {}),
      ...(cleanPerms.length > 0 ? { permissions: cleanPerms } : {}),
    }
  }

  const mintAndApplyPersona = async (nextInput: SupportLiveTestPersonaInput) => {
    setMintPending(true)
    setMintError(null)
    try {
      const body = buildPayloadFromPersona(nextInput)
      const res = await apiFetch<SupportLiveTestPersonaSessionResponse>(
        `/api/thruline/support/tenants/${tenant.id}/service-desk/live-test/persona-session`,
        {
          method: 'POST',
          body: JSON.stringify(body),
        },
      )
      onApplyPersona(nextInput, res)
    } catch (err) {
      setMintError(err instanceof Error ? err.message : 'Failed to mint persona session.')
    } finally {
      setMintPending(false)
    }
  }

  const handleSelectPreset = (presetId: string) => {
    const preset = SUPPORT_LIVE_TEST_PERSONA_PRESETS.find((p) => p.id === presetId)
    if (!preset) return
    const nextInput: SupportLiveTestPersonaInput = {
      mode: preset.mode,
      userId: preset.userId,
      role: preset.role,
      name: preset.name,
      email: preset.email,
      permissions: [...preset.permissions],
    }
    setDraftEdits(null)
    void mintAndApplyPersona(nextInput)
  }

  const handleApplyDraftPersona = () => {
    const perms = draftPermissions
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
    const nextInput: SupportLiveTestPersonaInput =
      draftMode === 'guest'
        ? { mode: 'guest', role: 'guest', userId: '', name: 'Guest Visitor', permissions: [] }
        : {
            mode: 'authenticated',
            userId: draftUserId.trim(),
            role: draftRole.trim() || 'customer',
            name: draftName.trim() || undefined,
            email: draftEmail.trim() || undefined,
            permissions: perms,
          }
    void mintAndApplyPersona(nextInput)
  }

  const handleCheckOrigin = async () => {
    const trimmed = simulatedOrigin.trim()
    if (!trimmed) return
    setOriginPending(true)
    setOriginError(null)
    try {
      const res = await apiFetch<SupportLiveTestOriginCheckResponse>(
        `/api/thruline/support/tenants/${tenant.id}/service-desk/live-test/origin-check`,
        {
          method: 'POST',
          body: JSON.stringify({ origin: trimmed }),
        },
      )
      onOriginCheckResult(res)
    } catch (err) {
      setOriginError(err instanceof Error ? err.message : 'Origin check failed.')
    } finally {
      setOriginPending(false)
    }
  }

  const personaSignature = buildPersonaSignature(persona)
  const storageScope = `live-test:${tenant.id}:${personaSignature}:${sessionEpoch}`

  // Auto-mint initial persona session when entering live mode without a cached session
  useEffect(() => {
    if (mode !== 'live') return
    if (personaSession) return
    const attemptKey = `${tenant.id}:${personaSignature}:${sessionEpoch}`
    if (autoMintKeyRef.current === attemptKey) return
    autoMintKeyRef.current = attemptKey
    void mintAndApplyPersona(persona)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, tenant.id, personaSignature, sessionEpoch, personaSession])

  // Mount real interactive runtime widget in Live mode
  useEffect(() => {
    if (mode !== 'live' || !personaSession || !containerRef.current) return

    let cancelled = false
    const container = containerRef.current
    setWidgetError(null)
    setWidgetLoading(true)

    const widgetScriptUrl = `${API_BASE}/thruline/v1/support/widget.js`

    const mountWidget = async () => {
      try {
        await ensureWidgetScriptLoaded(widgetScriptUrl)
        if (cancelled) return

        const api = getWidgetGlobal()
        if (!api?.init) {
          throw new Error('FreeLLMAPISupport.init is unavailable.')
        }

        container.innerHTML = ''

        const transport = async (rawUrl: string, init?: RequestInit): Promise<Response> => {
          const subpath = normalizeBridgeSubpath(rawUrl)
          const bridgeUrl = `${API_BASE}/api/thruline/support/tenants/${tenant.id}/service-desk/live-test${subpath}`
          const headers = new Headers(init?.headers ?? {})
          const token = readDashboardToken()
          if (token) {
            headers.set('Authorization', `Bearer ${token}`)
          }
          if (enforceOriginRef.current && simulatedOriginRef.current.trim()) {
            headers.set('X-Support-Simulated-Origin', simulatedOriginRef.current.trim())
          }

          const response = await fetch(bridgeUrl, {
            ...init,
            headers,
          })

          try {
            interface BridgeToolTrace {
              id?: string
              name?: string
              toolName?: string
              kind?: string
              status?: string
              pendingApproval?: boolean
              error?: string
              rewrittenSql?: string
            }
            interface BridgePendingItem {
              toolName?: string
              name?: string
              id?: string
            }
            interface BridgePayload {
              conversationId?: string
              model?: string
              userContext?: { role?: string; userId?: string }
              allowedTools?: Array<string | { functionName?: string; name?: string }>
              toolTrace?: BridgeToolTrace[]
              conversation?: { id?: string }
              ticket?: { conversationId?: string }
              error?: { code?: string; message?: string }
              runtime?: {
                conversationId?: string
                requestId?: string
                replySource?: string
                citations?: unknown[]
                pendingActions?: BridgePendingItem[]
                pendingApprovals?: BridgePendingItem[]
                output?: { action?: string; reasons?: unknown[] }
                evidence?: { status?: string; reason?: string; citations?: unknown[] }
              }
            }

            const payload = (await response.clone().json()) as BridgePayload | null
            if (payload) {
              const convId =
                payload.runtime?.conversationId ??
                payload.conversationId ??
                payload.conversation?.id ??
                payload.ticket?.conversationId
              if (convId) {
                onConversationIdDetectedRef.current(convId)
              }

              const isChat = subpath.startsWith('/chat')
              const isIntake = subpath.startsWith('/widget/intake')
              const isEscalate = subpath.startsWith('/escalate')
              const isCsat = subpath.startsWith('/csat')
              const isErrorPoll = subpath.startsWith('/conversations/') && !response.ok

              if (isChat || isIntake || isEscalate || isCsat || isErrorPoll) {
                const runtime = payload.runtime ?? {}
                const evidence = runtime.evidence ?? {}
                const citations = Array.isArray(evidence.citations)
                  ? evidence.citations
                  : Array.isArray(runtime.citations)
                    ? runtime.citations
                    : undefined
                const pendingApprovals = Array.isArray(runtime.pendingActions)
                  ? runtime.pendingActions
                  : Array.isArray(runtime.pendingApprovals)
                    ? runtime.pendingApprovals
                    : Array.isArray(payload.toolTrace)
                      ? payload.toolTrace.filter(
                          (t) => t?.status === 'pending_approval' || t?.pendingApproval,
                        )
                      : undefined

                const mappedAllowedTools = Array.isArray(payload.allowedTools)
                  ? payload.allowedTools
                      .map((t) =>
                        typeof t === 'string' ? t : String(t?.functionName ?? t?.name ?? ''),
                      )
                      .filter(Boolean)
                  : undefined
                const mappedToolTrace = Array.isArray(payload.toolTrace)
                  ? payload.toolTrace.map((t) => ({
                      name: String(t?.name ?? t?.toolName ?? 'tool'),
                      kind: String(t?.kind ?? 'tool'),
                      ...(t?.error ? { error: String(t.error) } : {}),
                      ...(t?.rewrittenSql ? { rewrittenSql: String(t.rewrittenSql) } : {}),
                    }))
                  : undefined
                const mappedPendingActions =
                  pendingApprovals && pendingApprovals.length > 0
                    ? pendingApprovals.map((p) => String(p?.toolName ?? p?.name ?? p?.id ?? 'pending'))
                    : undefined

                const entry: SupportLiveTestTurnDiagnostic = {
                  timestamp: new Date().toISOString(),
                  endpoint: subpath.split('?')[0],
                  status: response.status,
                  ok: response.ok,
                  ...(convId ? { conversationId: convId } : {}),
                  ...(typeof payload.model === 'string' ? { modelUsed: payload.model } : {}),
                  ...(typeof runtime.replySource === 'string' ? { replySource: runtime.replySource } : {}),
                  ...(typeof payload.userContext?.role === 'string'
                    ? { effectiveRole: payload.userContext.role }
                    : {}),
                  ...(typeof payload.userContext?.userId === 'string'
                    ? { effectiveUserId: payload.userContext.userId }
                    : {}),
                  ...(mappedAllowedTools && mappedAllowedTools.length > 0
                    ? { allowedTools: mappedAllowedTools }
                    : {}),
                  ...(mappedToolTrace && mappedToolTrace.length > 0
                    ? { toolTrace: mappedToolTrace }
                    : {}),
                  ...(typeof evidence.status === 'string' ? { evidenceStatus: evidence.status } : {}),
                  ...(typeof evidence.reason === 'string' ? { evidenceReason: evidence.reason } : {}),
                  ...(citations ? { citationsCount: citations.length } : {}),
                  ...(mappedPendingActions ? { pendingActions: mappedPendingActions } : {}),
                  ...(typeof runtime.output?.action === 'string'
                    ? { outputAction: runtime.output.action }
                    : {}),
                  ...(Array.isArray(runtime.output?.reasons)
                    ? { outputReasons: runtime.output.reasons.map(String) }
                    : {}),
                  ...(typeof payload.error?.code === 'string' ? { errorCode: payload.error.code } : {}),
                  ...(typeof payload.error?.message === 'string'
                    ? { errorMessage: payload.error.message }
                    : {}),
                }
                onAppendDiagnosticRef.current(entry)
              }

              if (response.ok && (isChat || isIntake || isEscalate || isCsat)) {
                onRefreshSandboxRef.current()
                onRefreshTenantQueriesRef.current?.()
              }
            }
          } catch {
            // Non-JSON responses don't populate diagnostics
          }

          return response
        }

        const instance = api.init({
          container,
          tenantKey: tenant.publicKey,
          contextToken: personaSession.contextToken ?? undefined,
          allowGuestSession: tenant.allowGuest ?? true,
          locale,
          loadTenantProfile: true,
          startOpen: true,
          pollInterval: 3000,
          storageScope,
          transport,
        })

        if (cancelled) {
          instance?.destroy?.()
          return
        }

        widgetInstanceRef.current = instance
        const restoredConvId = instance?.getConversationId?.()
        if (restoredConvId) {
          onConversationIdDetectedRef.current(restoredConvId)
        }
        setWidgetLoading(false)
      } catch (err) {
        if (!cancelled) {
          setWidgetLoading(false)
          setWidgetError(err instanceof Error ? err.message : 'Unable to initialize live widget.')
        }
      }
    }

    void mountWidget()

    return () => {
      cancelled = true
      try {
        widgetInstanceRef.current?.destroy?.()
      } catch {
        // Ignore cleanup errors
      }
      widgetInstanceRef.current = null
    }
  }, [
    mode,
    tenant.id,
    tenant.publicKey,
    tenant.allowGuest,
    locale,
    personaSession,
    storageScope,
  ])

  // Refresh saved profile inside mounted widget when operator saves updated config
  useEffect(() => {
    const versionChanged = prevSavedVersionRef.current !== savedConfigVersion
    const enabledChanged = prevSavedEnabledRef.current !== savedEnabled
    prevSavedVersionRef.current = savedConfigVersion
    prevSavedEnabledRef.current = savedEnabled
    if (mode === 'live' && (versionChanged || enabledChanged)) {
      try {
        void widgetInstanceRef.current?.refreshProfile?.()
      } catch {
        // Ignore refresh errors during teardown
      }
    }
  }, [mode, savedConfigVersion, savedEnabled])

  const handleReset = () => {
    setActionNotice(null)
    setActionError(null)
    try {
      for (let i = window.localStorage.length - 1; i >= 0; i--) {
        const k = window.localStorage.key(i)
        if (k && k.includes(storageScope)) {
          window.localStorage.removeItem(k)
        }
      }
    } catch {
      // Ignore storage access failures
    }
    onResetConversation()
  }

  const cleanupMutation = useMutation({
    mutationFn: () =>
      apiFetch<SupportLiveTestSandboxCleanupResponse>(
        `/api/thruline/support/tenants/${tenant.id}/service-desk/live-test/sandbox`,
        { method: 'DELETE' },
      ),
    onSuccess: () => {
      setCleanupError(null)
      setCleanupNotice(s.sandboxClearedNotice)
      setActionNotice(null)
      setActionError(null)
      handleReset()
      void queryClient.invalidateQueries({ queryKey: ['x-support-live-test-sandbox', tenant.id] })
      void queryClient.invalidateQueries({
        queryKey: ['x-support-live-test-pending-actions', tenant.id],
      })
      onRefreshTenantQueriesRef.current?.()
    },
    onError: (err) => {
      setCleanupError(err instanceof Error ? err.message : 'Failed to clean up sandbox data.')
    },
  })

  const reviewActionMutation = useMutation({
    mutationFn: async (vars: {
      actionId: string
      decision: 'approved' | 'rejected'
      reviewNote?: string
    }) =>
      apiFetch<SupportLiveTestActionReviewResponse>(
        `/api/thruline/support/tenants/${tenant.id}/service-desk/live-test/pending-actions/${encodeURIComponent(vars.actionId)}/${
          vars.decision === 'approved' ? 'approve' : 'reject'
        }`,
        {
          method: 'POST',
          body: JSON.stringify(vars.reviewNote ? { reviewNote: vars.reviewNote } : {}),
        },
      ),
    onSuccess: (_data, vars) => {
      setActionError(null)
      setActionNotice(
        vars.decision === 'approved' ? s.actionApprovedNotice : s.actionRejectedNotice,
      )
      setReviewNotes((prev) => {
        const next = { ...prev }
        delete next[vars.actionId]
        return next
      })
      try {
        widgetInstanceRef.current?.syncConversation?.()
      } catch {
        // Ignore sync failures if widget is unmounting
      }
      void queryClient.invalidateQueries({
        queryKey: ['x-support-live-test-pending-actions', tenant.id],
      })
      void queryClient.invalidateQueries({ queryKey: ['x-support-live-test-sandbox', tenant.id] })
      onRefreshTenantQueriesRef.current?.()
    },
    onError: (err) => {
      setActionNotice(null)
      setActionError(err instanceof Error ? err.message : 'Action review failed.')
    },
  })

  const pendingActions = pendingActionsQuery.data?.actions ?? []
  const activeReviewActionId = reviewActionMutation.isPending
    ? reviewActionMutation.variables?.actionId
    : undefined
  const activeReviewDecision = reviewActionMutation.isPending
    ? reviewActionMutation.variables?.decision
    : undefined

  const draftMatchesPreset = (presetId: string) => {
    const preset = SUPPORT_LIVE_TEST_PERSONA_PRESETS.find((p) => p.id === presetId)
    if (!preset) return false
    return (
      persona.mode === preset.mode &&
      (persona.mode === 'guest' ||
        ((persona.userId ?? '') === preset.userId && (persona.role ?? '') === preset.role))
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Top Mode Toggle */}
      <div
        role="tablist"
        aria-label="Widget preview and live test mode"
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 6,
          padding: 4,
          borderRadius: 10,
          backgroundColor: 'var(--bg-subtle, rgba(148,163,184,0.12))',
          border: '1px solid var(--border-color, rgba(148,163,184,0.22))',
        }}
      >
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'design'}
          data-testid="widget-mode-design"
          className={`x-button ${mode === 'design' ? 'x-button-primary' : ''}`}
          style={{ justifyContent: 'center', fontSize: 12, padding: '7px 10px' }}
          onClick={() => onModeChange('design')}
        >
          <Eye size={14} />
          <span>{s.designMode}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'live'}
          data-testid="widget-mode-live"
          className={`x-button ${mode === 'live' ? 'x-button-primary' : ''}`}
          style={{ justifyContent: 'center', fontSize: 12, padding: '7px 10px' }}
          onClick={() => onModeChange('live')}
        >
          <Play size={14} />
          <span>{s.liveMode}</span>
        </button>
      </div>

      <p className="x-hint" style={{ margin: 0, fontSize: 12 }}>
        {mode === 'design' ? s.designNote : s.liveNote}
      </p>

      {mode === 'design' ? (
        <SupportWidgetPreview publicConfig={publicConfig} />
      ) : (
        <>
          {/* Unsaved Changes Warning Banner */}
          {hasUnsavedChanges && (
            <div
              data-testid="live-test-unsaved-banner"
              role="status"
              style={{
                padding: '10px 12px',
                borderRadius: 8,
                border: '1px solid rgba(245, 158, 11, 0.5)',
                backgroundColor: 'rgba(245, 158, 11, 0.1)',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                fontSize: 12,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 2, color: '#d97706' }} />
                <span>{s.unsavedBanner}</span>
              </div>
              <div>
                <button
                  type="button"
                  data-testid="live-test-save-apply-btn"
                  className="x-button x-button-primary"
                  style={{ fontSize: 12, padding: '5px 10px' }}
                  disabled={isSavingConfig}
                  onClick={() => void onSaveAndApply()}
                >
                  {isSavingConfig ? s.saving : s.saveAndApplyNow}
                </button>
              </div>
            </div>
          )}

          {/* Branded Widget Disabled Notice */}
          {!savedEnabled && (
            <div
              data-testid="live-test-disabled-notice"
              style={{
                padding: '8px 12px',
                borderRadius: 8,
                border: '1px solid var(--border-color, rgba(148,163,184,0.3))',
                backgroundColor: 'var(--bg-subtle, rgba(148,163,184,0.08))',
                fontSize: 12,
              }}
            >
              {s.savedDisabledNotice}
            </div>
          )}

          {/* Persona & RBAC Control Panel */}
          <div
            data-testid="live-test-persona-panel"
            className="x-panel"
            style={{
              padding: 12,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              borderRadius: 10,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                <UserCheck size={14} />
                {s.personaHeading}
              </span>
              <span className="x-badge" style={{ fontSize: 11 }}>
                {personaSession?.mode === 'authenticated'
                  ? `${personaSession.userContext?.role ?? persona.role}:${personaSession.userContext?.userId ?? persona.userId}`
                  : s.modeGuest}
              </span>
            </div>

            {/* Quick Persona Presets */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {SUPPORT_LIVE_TEST_PERSONA_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  data-testid={`live-test-preset-${preset.id}`}
                  className={`x-button ${draftMatchesPreset(preset.id) ? 'x-button-primary' : ''}`}
                  style={{ fontSize: 11, padding: '4px 8px' }}
                  disabled={mintPending}
                  onClick={() => handleSelectPreset(preset.id)}
                >
                  {s.presetLabels[preset.id] ?? preset.name}
                </button>
              ))}
            </div>

            {/* Guest vs Authenticated Toggle */}
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                type="button"
                data-testid="live-test-mode-guest"
                className={`x-button ${draftMode === 'guest' ? 'x-button-primary' : ''}`}
                style={{ fontSize: 11, padding: '4px 8px', flex: 1, justifyContent: 'center' }}
                onClick={() => updateDraft({ mode: 'guest', role: 'guest' })}
              >
                {s.modeGuest}
              </button>
              <button
                type="button"
                data-testid="live-test-mode-authenticated"
                className={`x-button ${draftMode === 'authenticated' ? 'x-button-primary' : ''}`}
                style={{ fontSize: 11, padding: '4px 8px', flex: 1, justifyContent: 'center' }}
                onClick={() =>
                  updateDraft({
                    mode: 'authenticated',
                    role: draftRole === 'guest' ? 'customer' : draftRole,
                    userId: draftUserId.trim() ? draftUserId : 'cust_101',
                  })
                }
              >
                {s.modeAuthenticated}
              </button>
            </div>

            {draftMode === 'guest' && tenant.allowGuest === false && (
              <div
                data-testid="live-test-guest-disabled-hint"
                style={{
                  fontSize: 11,
                  padding: '6px 8px',
                  borderRadius: 6,
                  backgroundColor: 'rgba(239, 68, 68, 0.08)',
                  color: '#b91c1c',
                }}
              >
                {s.guestDisabledHint}
              </div>
            )}

            {draftMode === 'authenticated' && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 11, fontWeight: 500, marginBottom: 2 }}>
                    {s.roleLabel}
                  </label>
                  <select
                    data-testid="live-test-role-select"
                    className="x-input"
                    style={{ fontSize: 12, padding: '4px 8px' }}
                    value={draftRole}
                    onChange={(e) => updateDraft({ role: e.target.value })}
                  >
                    {roleOptions.map((r) => (
                      <option key={r} value={r}>
                        {s.roleOptionLabels[r] ?? r}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 11, fontWeight: 500, marginBottom: 2 }}>
                    {s.userIdLabel}
                  </label>
                  <input
                    type="text"
                    data-testid="live-test-userid-input"
                    className="x-input"
                    style={{ fontSize: 12, padding: '4px 8px' }}
                    value={draftUserId}
                    onChange={(e) => updateDraft({ userId: e.target.value })}
                    placeholder="cust_101"
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 11, fontWeight: 500, marginBottom: 2 }}>
                    {s.nameLabel}
                  </label>
                  <input
                    type="text"
                    data-testid="live-test-name-input"
                    className="x-input"
                    style={{ fontSize: 12, padding: '4px 8px' }}
                    value={draftName}
                    onChange={(e) => updateDraft({ name: e.target.value })}
                    placeholder="Alice Nguyen"
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 11, fontWeight: 500, marginBottom: 2 }}>
                    {s.emailLabel}
                  </label>
                  <input
                    type="email"
                    data-testid="live-test-email-input"
                    className="x-input"
                    style={{ fontSize: 12, padding: '4px 8px' }}
                    value={draftEmail}
                    onChange={(e) => updateDraft({ email: e.target.value })}
                    placeholder="alice@example.com"
                  />
                </div>
                <div style={{ gridColumn: '1 / -1' }}>
                  <label style={{ display: 'block', fontSize: 11, fontWeight: 500, marginBottom: 2 }}>
                    {s.permissionsLabel}
                  </label>
                  <input
                    type="text"
                    data-testid="live-test-permissions-input"
                    className="x-input"
                    style={{ fontSize: 12, padding: '4px 8px' }}
                    value={draftPermissions}
                    onChange={(e) => updateDraft({ permissions: e.target.value })}
                    placeholder="refund:approve, orders:read"
                  />
                </div>
              </div>
            )}

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              <button
                type="button"
                data-testid="live-test-apply-persona-btn"
                className="x-button x-button-primary"
                style={{ fontSize: 12, padding: '5px 10px' }}
                disabled={mintPending}
                onClick={handleApplyDraftPersona}
              >
                {s.applyPersona}
              </button>
              <button
                type="button"
                data-testid="live-test-reset-btn"
                className="x-button"
                style={{ fontSize: 12, padding: '5px 10px' }}
                onClick={handleReset}
              >
                <RotateCcw size={13} />
                <span>{s.resetSession}</span>
              </button>
              <button
                type="button"
                data-testid="live-test-refresh-widget-btn"
                className="x-button"
                style={{ fontSize: 12, padding: '5px 10px' }}
                onClick={() => void widgetInstanceRef.current?.refreshProfile?.()}
              >
                <RefreshCw size={13} />
                <span>{s.refreshWidget}</span>
              </button>
            </div>

            {mintError && (
              <p role="alert" data-testid="live-test-mint-error" style={{ margin: 0, fontSize: 12, color: '#dc2626' }}>
                {mintError}
              </p>
            )}

            <p className="x-hint" style={{ margin: 0, fontSize: 11 }}>
              <ShieldCheck size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
              {s.signingSecretSafe}
            </p>
          </div>

          {/* Live Mounted Real End-User Widget Container */}
          <div style={{ position: 'relative' }}>
            {(mintPending || widgetLoading) && !widgetError && (
              <div
                data-testid="live-test-loading"
                className="x-hint"
                style={{ fontSize: 12, marginBottom: 6 }}
              >
                {s.loadingWidget}
              </div>
            )}
            {widgetError && (
              <div
                role="alert"
                data-testid="live-test-widget-error"
                style={{
                  padding: 10,
                  marginBottom: 8,
                  borderRadius: 8,
                  border: '1px solid rgba(239,68,68,0.4)',
                  color: '#dc2626',
                  fontSize: 12,
                }}
              >
                {widgetError}
              </div>
            )}
            <div
              ref={containerRef}
              data-testid="support-widget-live-container"
              style={{
                borderRadius: 16,
                border: '1px solid var(--border-color, rgba(148,163,184,0.28))',
                padding: 12,
                backgroundColor: 'var(--bg-subtle, rgba(148,163,184,0.06))',
                display: 'flex',
                justifyContent: 'center',
              }}
            />
          </div>

          {/* Inline Pending Action Approvals Panel */}
          {(pendingActions.length > 0 || Boolean(actionNotice) || Boolean(actionError)) && (
            <div
              data-testid="live-test-approvals-panel"
              className="x-panel"
              style={{
                padding: 12,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                borderRadius: 10,
                borderColor: pendingActions.length > 0 ? 'rgba(245, 158, 11, 0.45)' : undefined,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{s.pendingActionsPanelHeading}</span>
                {pendingActions.length > 0 && (
                  <span className="x-badge" style={{ fontSize: 11 }}>
                    {pendingActions.length}
                  </span>
                )}
              </div>
              <p className="x-hint" style={{ margin: 0, fontSize: 11 }}>
                {s.pendingActionsPanelHint}
              </p>

              {actionNotice && (
                <div
                  data-testid="live-test-action-review-status"
                  role="status"
                  style={{ fontSize: 11, color: '#059669' }}
                >
                  {actionNotice}
                </div>
              )}
              {actionError && (
                <div
                  data-testid="live-test-action-review-error"
                  role="alert"
                  style={{ fontSize: 11, color: '#dc2626' }}
                >
                  {actionError}
                </div>
              )}

              {pendingActions.map((act) => {
                const noteVal = reviewNotes[act.id] ?? ''
                const isThisBusy = activeReviewActionId === act.id
                return (
                  <div
                    key={act.id}
                    data-testid={`live-test-pending-action-${act.id}`}
                    style={{
                      padding: 10,
                      borderRadius: 8,
                      border: '1px solid var(--border-color, rgba(148,163,184,0.28))',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 6,
                      fontSize: 12,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
                      <strong>
                        <code>{act.toolName}</code>
                      </strong>
                      <span className="x-hint" style={{ fontSize: 11 }}>
                        {act.userRole}:{act.userId}
                      </span>
                    </div>
                    {act.actionSummary && <div style={{ fontSize: 11 }}>{act.actionSummary}</div>}
                    <pre
                      style={{
                        margin: 0,
                        padding: 6,
                        borderRadius: 6,
                        fontSize: 11,
                        overflowX: 'auto',
                        backgroundColor: 'var(--bg-subtle, rgba(148,163,184,0.1))',
                      }}
                    >
                      {JSON.stringify(act.payload)}
                    </pre>
                    <input
                      type="text"
                      data-testid={`live-test-review-note-${act.id}`}
                      className="x-input"
                      style={{ fontSize: 11, padding: '4px 8px' }}
                      placeholder={s.reviewNotePlaceholder}
                      value={noteVal}
                      disabled={reviewActionMutation.isPending}
                      onChange={(e) =>
                        setReviewNotes((prev) => ({ ...prev, [act.id]: e.target.value }))
                      }
                    />
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        type="button"
                        data-testid={`live-test-approve-btn-${act.id}`}
                        className="x-button x-button-primary"
                        style={{ fontSize: 11, padding: '4px 10px' }}
                        disabled={reviewActionMutation.isPending}
                        onClick={() =>
                          reviewActionMutation.mutate({
                            actionId: act.id,
                            decision: 'approved',
                            reviewNote: noteVal.trim() || undefined,
                          })
                        }
                      >
                        <Check size={12} />
                        <span>
                          {isThisBusy && activeReviewDecision === 'approved'
                            ? s.approvingActionLabel
                            : s.approveActionBtn}
                        </span>
                      </button>
                      <button
                        type="button"
                        data-testid={`live-test-reject-btn-${act.id}`}
                        className="x-button"
                        style={{ fontSize: 11, padding: '4px 10px' }}
                        disabled={reviewActionMutation.isPending}
                        onClick={() =>
                          reviewActionMutation.mutate({
                            actionId: act.id,
                            decision: 'rejected',
                            reviewNote: noteVal.trim() || undefined,
                          })
                        }
                      >
                        <X size={12} />
                        <span>
                          {isThisBusy && activeReviewDecision === 'rejected'
                            ? s.rejectingActionLabel
                            : s.rejectActionBtn}
                        </span>
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* Origin Allowlist Simulator */}
          <div
            data-testid="live-test-origin-panel"
            className="x-panel"
            style={{
              padding: 12,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              borderRadius: 10,
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Globe size={14} />
              {s.originHeading}
            </span>
            <p className="x-hint" style={{ margin: 0, fontSize: 11 }}>
              {s.configuredAllowlist}:{' '}
              {tenant.allowedOrigins.length > 0 ? tenant.allowedOrigins.join(', ') : s.unrestrictedLabel}
            </p>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                type="text"
                data-testid="live-test-origin-input"
                className="x-input"
                style={{ fontSize: 12, padding: '5px 8px', flex: 1 }}
                value={simulatedOrigin}
                onChange={(e) => onSimulatedOriginChange(e.target.value)}
                placeholder={s.originPlaceholder}
              />
              <button
                type="button"
                data-testid="live-test-origin-check-btn"
                className="x-button"
                style={{ fontSize: 12, padding: '5px 10px' }}
                disabled={originPending || !simulatedOrigin.trim()}
                onClick={() => void handleCheckOrigin()}
              >
                {originPending ? s.checkingOrigin : s.checkOrigin}
              </button>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
              <input
                type="checkbox"
                data-testid="live-test-origin-enforce-toggle"
                checked={enforceSimulatedOrigin}
                onChange={(e) => onEnforceSimulatedOriginChange(e.target.checked)}
              />
              <span>{s.enforceOrigin}</span>
            </label>
            {originError && (
              <p role="alert" style={{ margin: 0, fontSize: 12, color: '#dc2626' }}>
                {originError}
              </p>
            )}
            {originCheckResult && (
              <div
                data-testid="live-test-origin-result"
                style={{
                  fontSize: 12,
                  padding: '6px 8px',
                  borderRadius: 6,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  backgroundColor: originCheckResult.allowed
                    ? 'rgba(16, 185, 129, 0.1)'
                    : 'rgba(239, 68, 68, 0.1)',
                }}
              >
                {originCheckResult.allowed ? (
                  <CheckCircle2 size={14} style={{ color: '#059669' }} />
                ) : (
                  <AlertTriangle size={14} style={{ color: '#dc2626' }} />
                )}
                <strong>{originCheckResult.allowed ? s.originAllowed : s.originDenied}:</strong>
                <span>{s.originReasons[originCheckResult.reason] ?? originCheckResult.reason}</span>
              </div>
            )}
          </div>

          {/* Live Test Sandbox Data & Cleanup Panel */}
          <div
            data-testid="live-test-sandbox-panel"
            className="x-panel"
            style={{
              padding: 12,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              borderRadius: 10,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{s.sandboxHeading}</span>
              <button
                type="button"
                data-testid="live-test-cleanup-btn"
                className="x-button"
                style={{ fontSize: 11, padding: '4px 10px' }}
                disabled={!sandboxQuery.data || sandboxQuery.data.totalCount === 0 || cleanupMutation.isPending}
                onClick={() => cleanupMutation.mutate()}
              >
                <Trash2 size={13} />
                <span>{cleanupMutation.isPending ? s.cleaningSandbox : s.cleanupSandboxBtn}</span>
              </button>
            </div>
            <p className="x-hint" style={{ margin: 0, fontSize: 11 }}>
              {s.sandboxCleanNote}
            </p>
            <div data-testid="live-test-sandbox-counts" style={{ fontSize: 12 }}>
              <code>
                {sandboxQuery.data
                  ? `${sandboxQuery.data.conversationsCount} ${s.chatsLabel} · ${sandboxQuery.data.ticketsCount} ${s.ticketsLabel} · ${sandboxQuery.data.pendingActionsCount} ${s.actionsLabel} · ${sandboxQuery.data.csatRatingsCount} ${s.csatLabel}`
                  : `0 ${s.chatsLabel} · 0 ${s.ticketsLabel} · 0 ${s.actionsLabel} · 0 ${s.csatLabel}`}
              </code>
            </div>
            {cleanupNotice && (
              <div
                data-testid="live-test-cleanup-status"
                role="status"
                style={{ fontSize: 11, color: '#059669' }}
              >
                {cleanupNotice}
              </div>
            )}
            {cleanupError && (
              <div role="alert" style={{ fontSize: 11, color: '#dc2626' }}>
                {cleanupError}
              </div>
            )}
          </div>

          {/* External Operator Diagnostics Panel */}
          <div
            data-testid="live-test-diagnostics-panel"
            className="x-panel"
            style={{
              padding: 12,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              borderRadius: 10,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{s.diagnosticsHeading}</span>
              {resolvedConversationId && (
                <button
                  type="button"
                  data-testid="live-test-open-copilot-btn"
                  className="x-button x-button-primary"
                  style={{ fontSize: 11, padding: '4px 10px' }}
                  onClick={() => onOpenInCopilot(resolvedConversationId)}
                >
                  <span>{s.openInCopilot}</span>
                  <ArrowRight size={13} />
                </button>
              )}
            </div>
            <p className="x-hint" style={{ margin: 0, fontSize: 11 }}>
              {s.diagnosticsHint}
            </p>
            {resolvedConversationId && (
              <div style={{ fontSize: 12 }}>
                <strong>{s.conversationLabel}:</strong>{' '}
                <code data-testid="live-test-active-conv-id">{resolvedConversationId}</code>
              </div>
            )}
            {diagnostics.length === 0 ? (
              <p className="x-hint" style={{ margin: 0, fontSize: 12 }}>
                {s.noDiagnostics}
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 260, overflowY: 'auto' }}>
                {diagnostics.map((d, idx) => (
                  <div
                    key={`${d.timestamp}-${idx}`}
                    data-testid="live-test-diagnostic-item"
                    style={{
                      padding: 8,
                      borderRadius: 8,
                      border: '1px solid var(--border-color, rgba(148,163,184,0.25))',
                      fontSize: 11,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
                      <strong>
                        {d.endpoint} ({d.status})
                      </strong>
                      {d.modelUsed && (
                        <span>
                          {s.modelLabel}: <code>{d.modelUsed}</code>
                        </span>
                      )}
                    </div>
                    {(d.effectiveRole || d.effectiveUserId) && (
                      <div>
                        RBAC: <code>{d.effectiveRole ?? 'guest'}</code>
                        {d.effectiveUserId ? ` (${d.effectiveUserId})` : ''}
                      </div>
                    )}
                    {d.replySource && (
                      <div>
                        {s.sourceLabel}: <code>{d.replySource}</code>
                      </div>
                    )}
                    {d.allowedTools && d.allowedTools.length > 0 && (
                      <div>
                        {s.toolsLabel}: {d.allowedTools.join(', ')}
                      </div>
                    )}
                    {d.toolTrace && d.toolTrace.length > 0 && (
                      <div>
                        Trace: {d.toolTrace.map((t) => `${t.name} (${t.kind}${t.error ? `: ${t.error}` : ''})`).join(', ')}
                      </div>
                    )}
                    {(d.evidenceStatus || d.citationsCount !== undefined) && (
                      <div>
                        {s.citationsLabel}:{' '}
                        <code>{d.evidenceStatus ?? 'none'}</code>
                        {d.evidenceReason ? ` (${d.evidenceReason})` : ''}
                        {d.citationsCount !== undefined ? ` — ${d.citationsCount}` : ''}
                      </div>
                    )}
                    {d.pendingActions && d.pendingActions.length > 0 && (
                      <div>
                        {s.pendingApprovalsLabel}: {d.pendingActions.join(', ')}
                      </div>
                    )}
                    {d.outputAction && (
                      <div>
                        Output: <code>{d.outputAction}</code>
                        {d.outputReasons?.length ? ` (${d.outputReasons.join(', ')})` : ''}
                      </div>
                    )}
                    {(d.errorCode || d.errorMessage) && (
                      <div style={{ color: '#dc2626' }}>
                        {s.errorLabel}: <code>{d.errorCode ?? 'error'}</code>
                        {d.errorMessage ? ` — ${d.errorMessage}` : ''}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
