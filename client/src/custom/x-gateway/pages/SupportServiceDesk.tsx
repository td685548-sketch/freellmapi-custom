import type {
  SupportDeskAvatarPreset,
  SupportDeskBorderRadius,
  SupportDeskCopilotDraft,
  SupportDeskCopilotResult,
  SupportDeskDepartment,
  SupportDeskFontFamily,
  SupportDeskHeaderStyle,
  SupportDeskIntakeField,
  SupportDeskIntakeFieldType,
  SupportDeskLauncherStyle,
  SupportDeskPublicWidgetConfig,
  SupportDeskRoutingRule,
  SupportDeskSlaClock,
  SupportDeskSlaPolicy,
  SupportDeskTicketState,
  SupportDeskWidgetAppearance,
  SupportDeskWidgetConfig,
  SupportDeskWidgetPosition,
  SupportDeskWidgetSize,
  SupportDeskWidgetTheme,
  SupportTicketPriority,
} from '@freellmapi/shared/support-service-desk.js'
import {
  DEFAULT_SUPPORT_DESK_SLA_POLICY,
  DEFAULT_SUPPORT_DESK_WIDGET_CONFIG,
  RESERVED_INTAKE_FIELD_KEYS,
  SUPPORT_DESK_AVATAR_PRESETS,
  SUPPORT_DESK_BORDER_RADII,
  SUPPORT_DESK_DEPARTMENTS,
  SUPPORT_DESK_FONT_FAMILIES,
  SUPPORT_DESK_HEADER_STYLES,
  SUPPORT_DESK_INTAKE_FIELD_TYPES,
  SUPPORT_DESK_LAUNCHER_STYLES,
  SUPPORT_DESK_LIMITS,
  SUPPORT_DESK_WIDGET_POSITIONS,
  SUPPORT_DESK_WIDGET_SIZES,
  SUPPORT_DESK_WIDGET_THEMES,
} from '@freellmapi/shared/support-service-desk.js'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Clock,
  Code2,
  Copy,
  Headphones,
  Plus,
  RotateCcw,
  Send,
  ShieldAlert,
  ShieldCheck,
  Sliders,
  Trash2,
  XCircle,
} from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { useSessionRevision } from '../../session-state'
import { useUserSession } from '../../use-session'
import { useSupportServiceDeskStrings } from '../support-service-desk-strings'
import {
  SUPPORT_LIVE_TEST_PERSONA_PRESETS,
  type SupportLiveTestOriginCheckResponse,
  type SupportLiveTestPersonaInput,
  type SupportLiveTestPersonaSessionResponse,
  type SupportLiveTestTurnDiagnostic,
  type SupportLiveTestViewMode,
} from '@freellmapi/shared/support-service-desk-live-test.js'
import { SupportWidgetLiveTest } from '../components/SupportWidgetLiveTest'
import { useSupportServiceDeskLiveTestStrings } from '../support-service-desk-live-test-strings'

export interface SupportTenant {
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

function normalizeWidgetAppearance(app: SupportDeskWidgetAppearance): SupportDeskWidgetAppearance {
  const defaults = DEFAULT_SUPPORT_DESK_WIDGET_CONFIG.appearance
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(defaults)) {
    const val = (app as unknown as Record<string, unknown>)[key]
    out[key] = val !== undefined ? val : (defaults as unknown as Record<string, unknown>)[key]
  }
  return out as unknown as SupportDeskWidgetAppearance
}

function hasUnsavedWidgetChanges(
  saved: SupportDeskWidgetConfig | undefined,
  draft: SupportDeskPublicWidgetConfig,
): boolean {
  if (!saved) return false
  if (saved.enabled !== draft.enabled) return true
  if (saved.intake.required !== draft.intake.required) return true
  if (JSON.stringify(saved.intake.fields) !== JSON.stringify(draft.intake.fields)) return true
  return (
    JSON.stringify(normalizeWidgetAppearance(saved.appearance)) !==
    JSON.stringify(normalizeWidgetAppearance(draft.appearance))
  )
}

function getLiveTestPersonaCacheKey(input: SupportLiveTestPersonaInput, epoch: number): string {
  const perms = [...(input.permissions ?? [])].sort().join(',')
  return `${epoch}:${input.mode}:${input.role ?? ''}:${input.userId ?? ''}:${input.name ?? ''}:${input.email ?? ''}:${perms}`
}

export interface SupportConversation {
  id: string
  tenantId: number
  userId: string
  userRole?: string
  status: string
  messages: Array<{
    id?: string
    role?: string
    senderType?: string
    senderName?: string
    content: string
    createdAt?: string
  }>
  createdAt: string
  updatedAt: string
}

export interface SupportQueueItem {
  ticket: {
    id: string
    conversationId?: string
    subject: string
    reason?: string
    customerRole?: string
    status: string
    priority: SupportTicketPriority
    department?: SupportDeskDepartment
    createdAt: string
    updatedAt: string
  }
  state?: SupportDeskTicketState
  firstResponseClock?: SupportDeskSlaClock
  resolutionClock?: SupportDeskSlaClock
}

type TabId = 'widget' | 'copilot' | 'queues' | 'embed'

const tabs: Array<{ id: TabId; icon: typeof Sliders }> = [
  { id: 'widget', icon: Sliders },
  { id: 'copilot', icon: Bot },
  { id: 'queues', icon: Clock },
  { id: 'embed', icon: Code2 },
]

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="x-panel x-mgmt-card" style={{ marginBottom: 20, minWidth: 0 }}>
      <div className="x-section-heading">
        <h2>{title}</h2>
      </div>
      {children}
    </section>
  )
}

function Feedback({
  error,
  success,
  conflict,
  successMsg,
}: {
  error?: Error | null
  success?: boolean
  conflict?: boolean
  successMsg?: string
}) {
  const s = useSupportServiceDeskStrings()
  if (conflict) {
    return (
      <div className="x-alert x-alert-error" role="alert" data-testid="widget-conflict-error" style={{ marginBottom: 16 }}>
        <AlertTriangle size={18} />
        <span>{s.conflictError}</span>
      </div>
    )
  }
  if (error) {
    return (
      <div className="x-alert x-alert-error" role="alert" style={{ marginBottom: 16 }}>
        <XCircle size={18} />
        <span>{error.message}</span>
      </div>
    )
  }
  if (success) {
    return (
      <div className="x-alert x-alert-success" role="status" style={{ marginBottom: 16 }}>
        <CheckCircle2 size={18} />
        <span>{successMsg || s.saved}</span>
      </div>
    )
  }
  return null
}

function useMutationAbort() {
  const controllerRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      controllerRef.current?.abort()
    }
  }, [])
  const nextSignal = () => {
    controllerRef.current?.abort()
    const ctrl = new AbortController()
    controllerRef.current = ctrl
    return ctrl.signal
  }
  const abort = () => {
    controllerRef.current?.abort()
    controllerRef.current = null
  }
  const isMountedAndActive = () => mountedRef.current && !(controllerRef.current?.signal.aborted ?? false)
  return { nextSignal, abort, isMountedAndActive }
}

// ---------------------------------------------------------
// Tab 1: Widget & Intake
// ---------------------------------------------------------
interface LiveTestStudioBridgeProps {
  tenant: SupportTenant
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
  onRefreshTenantQueries: () => void
}

function WidgetTabPanel({
  tenantBase,
  tenantKey,
  liveTestProps,
}: {
  tenantBase: string
  tenantKey: readonly unknown[]
  liveTestProps: LiveTestStudioBridgeProps
}) {
  const s = useSupportServiceDeskStrings()
  const queryClient = useQueryClient()
  const saveAbort = useMutationAbort()

  const configQuery = useQuery({
    queryKey: [...tenantKey, 'widget-config'],
    queryFn: ({ signal }) =>
      apiFetch<{
        ok: boolean
        config: SupportDeskWidgetConfig
        publicConfig: SupportDeskPublicWidgetConfig
        embedSnippet?: string
      }>(`${tenantBase}/widget-config`, { signal }),
  })

  const [draft, setDraft] = useState<{
    enabled?: boolean
    primaryColor?: string
    secondaryColor?: string
    theme?: SupportDeskWidgetTheme
    headerStyle?: SupportDeskHeaderStyle
    title?: string
    subtitle?: string
    avatarPreset?: SupportDeskAvatarPreset
    showStatusDot?: boolean
    welcomeMessage?: string
    position?: SupportDeskWidgetPosition
    edgeOffsetPx?: number
    launcherStyle?: SupportDeskLauncherStyle
    launcherLabel?: string
    borderRadius?: SupportDeskBorderRadius
    widgetSize?: SupportDeskWidgetSize
    fontFamily?: SupportDeskFontFamily
    inputPlaceholder?: string
    sendButtonLabel?: string
    showPoweredBy?: boolean
    autoOpenDelaySeconds?: number
    quickPrompts?: string[]
    intakeRequired?: boolean
    fields?: SupportDeskIntakeField[]
  }>({})
  const [newPrompt, setNewPrompt] = useState('')

  const defaults = DEFAULT_SUPPORT_DESK_WIDGET_CONFIG.appearance
  const serverCfg = configQuery.data?.config
  const enabled = draft.enabled ?? serverCfg?.enabled ?? false
  const primaryColor = draft.primaryColor ?? serverCfg?.appearance?.primaryColor ?? defaults.primaryColor
  const secondaryColor = draft.secondaryColor ?? serverCfg?.appearance?.secondaryColor ?? defaults.secondaryColor!
  const theme = draft.theme ?? serverCfg?.appearance?.theme ?? defaults.theme!
  const headerStyle = draft.headerStyle ?? serverCfg?.appearance?.headerStyle ?? defaults.headerStyle!
  const title = draft.title ?? serverCfg?.appearance?.title ?? defaults.title
  const subtitle = draft.subtitle ?? serverCfg?.appearance?.subtitle ?? defaults.subtitle!
  const avatarPreset = draft.avatarPreset ?? serverCfg?.appearance?.avatarPreset ?? defaults.avatarPreset!
  const showStatusDot = draft.showStatusDot ?? serverCfg?.appearance?.showStatusDot ?? defaults.showStatusDot!
  const welcomeMessage = draft.welcomeMessage ?? serverCfg?.appearance?.welcomeMessage ?? defaults.welcomeMessage
  const position = draft.position ?? serverCfg?.appearance?.position ?? defaults.position
  const edgeOffsetPx = draft.edgeOffsetPx ?? serverCfg?.appearance?.edgeOffsetPx ?? defaults.edgeOffsetPx!
  const launcherStyle = draft.launcherStyle ?? serverCfg?.appearance?.launcherStyle ?? defaults.launcherStyle!
  const launcherLabel = draft.launcherLabel ?? serverCfg?.appearance?.launcherLabel ?? defaults.launcherLabel!
  const borderRadius = draft.borderRadius ?? serverCfg?.appearance?.borderRadius ?? defaults.borderRadius!
  const widgetSize = draft.widgetSize ?? serverCfg?.appearance?.widgetSize ?? defaults.widgetSize!
  const fontFamily = draft.fontFamily ?? serverCfg?.appearance?.fontFamily ?? defaults.fontFamily!
  const inputPlaceholder = draft.inputPlaceholder ?? serverCfg?.appearance?.inputPlaceholder ?? defaults.inputPlaceholder!
  const sendButtonLabel = draft.sendButtonLabel ?? serverCfg?.appearance?.sendButtonLabel ?? defaults.sendButtonLabel!
  const showPoweredBy = draft.showPoweredBy ?? serverCfg?.appearance?.showPoweredBy ?? defaults.showPoweredBy!
  const autoOpenDelaySeconds = draft.autoOpenDelaySeconds ?? serverCfg?.appearance?.autoOpenDelaySeconds ?? defaults.autoOpenDelaySeconds!
  const quickPrompts = draft.quickPrompts ?? serverCfg?.appearance?.quickPrompts ?? defaults.quickPrompts
  const intakeRequired = draft.intakeRequired ?? serverCfg?.intake?.required ?? false
  const fields = draft.fields ?? serverCfg?.intake?.fields ?? []

  const setEnabled = (v: boolean) => setDraft(d => ({ ...d, enabled: v }))
  const setPrimaryColor = (v: string) => setDraft(d => ({ ...d, primaryColor: v }))
  const setSecondaryColor = (v: string) => setDraft(d => ({ ...d, secondaryColor: v }))
  const setTheme = (v: SupportDeskWidgetTheme) => setDraft(d => ({ ...d, theme: v }))
  const setHeaderStyle = (v: SupportDeskHeaderStyle) => setDraft(d => ({ ...d, headerStyle: v }))
  const setTitle = (v: string) => setDraft(d => ({ ...d, title: v }))
  const setSubtitle = (v: string) => setDraft(d => ({ ...d, subtitle: v }))
  const setAvatarPreset = (v: SupportDeskAvatarPreset) => setDraft(d => ({ ...d, avatarPreset: v }))
  const setShowStatusDot = (v: boolean) => setDraft(d => ({ ...d, showStatusDot: v }))
  const setWelcomeMessage = (v: string) => setDraft(d => ({ ...d, welcomeMessage: v }))
  const setPosition = (v: SupportDeskWidgetPosition) => setDraft(d => ({ ...d, position: v }))
  const setEdgeOffsetPx = (v: number) => setDraft(d => ({ ...d, edgeOffsetPx: v }))
  const setLauncherStyle = (v: SupportDeskLauncherStyle) => setDraft(d => ({ ...d, launcherStyle: v }))
  const setLauncherLabel = (v: string) => setDraft(d => ({ ...d, launcherLabel: v }))
  const setBorderRadius = (v: SupportDeskBorderRadius) => setDraft(d => ({ ...d, borderRadius: v }))
  const setWidgetSize = (v: SupportDeskWidgetSize) => setDraft(d => ({ ...d, widgetSize: v }))
  const setFontFamily = (v: SupportDeskFontFamily) => setDraft(d => ({ ...d, fontFamily: v }))
  const setInputPlaceholder = (v: string) => setDraft(d => ({ ...d, inputPlaceholder: v }))
  const setSendButtonLabel = (v: string) => setDraft(d => ({ ...d, sendButtonLabel: v }))
  const setShowPoweredBy = (v: boolean) => setDraft(d => ({ ...d, showPoweredBy: v }))
  const setAutoOpenDelaySeconds = (v: number) => setDraft(d => ({ ...d, autoOpenDelaySeconds: v }))
  const setQuickPrompts = (v: string[]) => setDraft(d => ({ ...d, quickPrompts: v }))
  const setIntakeRequired = (v: boolean) => setDraft(d => ({ ...d, intakeRequired: v }))
  const setFields = (v: SupportDeskIntakeField[]) => setDraft(d => ({ ...d, fields: v }))

  function resetAppearanceDefaults() {
    setDraft(d => ({
      ...d,
      primaryColor: defaults.primaryColor,
      secondaryColor: defaults.secondaryColor,
      theme: defaults.theme,
      headerStyle: defaults.headerStyle,
      title: defaults.title,
      subtitle: defaults.subtitle,
      avatarPreset: defaults.avatarPreset,
      showStatusDot: defaults.showStatusDot,
      welcomeMessage: defaults.welcomeMessage,
      position: defaults.position,
      edgeOffsetPx: defaults.edgeOffsetPx,
      launcherStyle: defaults.launcherStyle,
      launcherLabel: defaults.launcherLabel,
      borderRadius: defaults.borderRadius,
      widgetSize: defaults.widgetSize,
      fontFamily: defaults.fontFamily,
      inputPlaceholder: defaults.inputPlaceholder,
      sendButtonLabel: defaults.sendButtonLabel,
      showPoweredBy: defaults.showPoweredBy,
      autoOpenDelaySeconds: defaults.autoOpenDelaySeconds,
      quickPrompts: [...defaults.quickPrompts],
    }))
  }

  const [clientError, setClientError] = useState<string | null>(null)
  const [versionConflict, setVersionConflict] = useState(false)
  const [savedSuccess, setSavedSuccess] = useState(false)

  const saveMutation = useMutation({
    mutationFn: (body: {
      expectedVersion: number
      enabled: boolean
      appearance: SupportDeskWidgetAppearance
      intake: {
        required: boolean
        fields: SupportDeskIntakeField[]
      }
    }) =>
      apiFetch<{ ok: boolean; config: SupportDeskWidgetConfig; publicConfig: SupportDeskPublicWidgetConfig }>(
        `${tenantBase}/widget-config`,
        {
          method: 'PUT',
          body: JSON.stringify(body),
          signal: saveAbort.nextSignal(),
        }
      ),
    onSuccess: () => {
      if (!saveAbort.isMountedAndActive()) return
      setDraft({})
      setSavedSuccess(true)
      setVersionConflict(false)
      setClientError(null)
      queryClient.invalidateQueries({ queryKey: [...tenantKey, 'widget-config'] })
      setTimeout(() => setSavedSuccess(false), 3000)
    },
    onError: (err: unknown) => {
      if (!saveAbort.isMountedAndActive()) return
      const errorObj = err as { status?: number; message?: string }
      if (errorObj?.status === 409 || errorObj?.message?.includes('conflict') || errorObj?.message?.includes('version')) {
        setVersionConflict(true)
      } else {
        setClientError(errorObj?.message || s.error)
      }
    },
  })

  function handleSave() {
    setClientError(null)
    setVersionConflict(false)

    // Validations
    if (!/^#[0-9a-fA-F]{6}$/.test(primaryColor) || !/^#[0-9a-fA-F]{6}$/.test(secondaryColor)) {
      setClientError(s.widget.errors.invalidColor)
      return
    }
    if (title.length > SUPPORT_DESK_LIMITS.maxLabelChars) {
      setClientError(s.widget.errors.titleTooLong)
      return
    }
    if (welcomeMessage.length > SUPPORT_DESK_LIMITS.maxValueChars) {
      setClientError(s.widget.errors.welcomeTooLong)
      return
    }
    if (quickPrompts.length > SUPPORT_DESK_LIMITS.maxQuickPrompts) {
      setClientError(s.widget.errors.tooManyPrompts)
      return
    }
    if (fields.length > SUPPORT_DESK_LIMITS.maxFields) {
      setClientError(s.widget.errors.tooManyFields)
      return
    }
    if (intakeRequired && (!fields.length || !fields.some(f => f.required))) {
      setClientError(s.widget.errors.requiredRequiresFields)
      return
    }

    // Validate fields
    for (const f of fields) {
      if (!/^[a-z][a-z0-9_]{0,39}$/.test(f.key)) {
        setClientError(s.widget.errors.invalidFieldKey)
        return
      }
      if (RESERVED_INTAKE_FIELD_KEYS.includes(f.key as (typeof RESERVED_INTAKE_FIELD_KEYS)[number])) {
        setClientError(s.widget.errors.reservedFieldKey)
        return
      }
      if (f.label.length > SUPPORT_DESK_LIMITS.maxLabelChars) {
        setClientError(s.widget.errors.labelTooLong)
        return
      }
      if (f.type === 'select') {
        if (!f.options || f.options.length === 0) {
          setClientError(s.widget.errors.emptyOptions)
          return
        }
        if (f.options.length > SUPPORT_DESK_LIMITS.maxOptions) {
          setClientError(s.widget.errors.tooManyOptions)
          return
        }
      }
    }

    const currentVer = configQuery.data?.config?.version ?? 1
    saveMutation.mutate({
      expectedVersion: currentVer,
      enabled,
      appearance: {
        primaryColor,
        secondaryColor,
        theme,
        headerStyle,
        title,
        subtitle,
        avatarPreset,
        showStatusDot,
        welcomeMessage,
        position,
        edgeOffsetPx,
        launcherStyle,
        launcherLabel,
        borderRadius,
        widgetSize,
        fontFamily,
        inputPlaceholder,
        sendButtonLabel,
        showPoweredBy,
        autoOpenDelaySeconds,
        quickPrompts,
      },
      intake: {
        required: intakeRequired,
        fields,
      },
    })
  }

  function addQuickPrompt() {
    const trimmed = newPrompt.trim()
    if (!trimmed) return
    if (quickPrompts.length >= SUPPORT_DESK_LIMITS.maxQuickPrompts) {
      setClientError(s.widget.errors.tooManyPrompts)
      return
    }
    if (trimmed.length > SUPPORT_DESK_LIMITS.maxValueChars) {
      setClientError(s.widget.errors.promptTooLong)
      return
    }
    setQuickPrompts([...quickPrompts, trimmed])
    setNewPrompt('')
  }

  function removeQuickPrompt(idx: number) {
    setQuickPrompts(quickPrompts.filter((_, i) => i !== idx))
  }

  function addField() {
    if (fields.length >= SUPPORT_DESK_LIMITS.maxFields) {
      setClientError(s.widget.errors.tooManyFields)
      return
    }
    const newKey = `field_${fields.length + 1}`
    setFields([
      ...fields,
      {
        key: newKey,
        label: `Field ${fields.length + 1}`,
        type: 'text',
        required: false,
      },
    ])
  }

  function updateField(idx: number, patch: Partial<SupportDeskIntakeField>) {
    setFields(fields.map((f, i) => (i === idx ? { ...f, ...patch } : f)))
  }

  function removeField(idx: number) {
    setFields(fields.filter((_, i) => i !== idx))
  }

  // Build live preview config object
  const livePreviewConfig: SupportDeskPublicWidgetConfig = {
    version: configQuery.data?.config?.version ?? 1,
    enabled,
    appearance: {
      primaryColor,
      secondaryColor,
      theme,
      headerStyle,
      title,
      subtitle,
      avatarPreset,
      showStatusDot,
      welcomeMessage,
      position,
      edgeOffsetPx,
      launcherStyle,
      launcherLabel,
      borderRadius,
      widgetSize,
      fontFamily,
      inputPlaceholder,
      sendButtonLabel,
      showPoweredBy,
      autoOpenDelaySeconds,
      quickPrompts,
    },
    intake: {
      required: intakeRequired,
      fields,
      schemaHash: 'preview-hash',
    },
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(340px, 1fr) minmax(360px, 460px)', gap: 24, alignItems: 'start' }}>
      <div>
        <Feedback
          error={clientError ? new Error(clientError) : saveMutation.error ? (saveMutation.error as Error) : null}
          success={savedSuccess}
          conflict={versionConflict}
        />

        {configQuery.isPending && <div className="x-loading">{s.loading}</div>}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Status */}
          <div style={{ padding: 16, background: 'var(--x-alt)', borderRadius: 8, border: '1px solid var(--x-border)' }}>
            <h3 style={{ margin: '0 0 8px 0', fontSize: 14, fontWeight: 600 }}>{s.widget.statusHeading}</h3>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 500 }}>
              <input
                type="checkbox"
                data-testid="widget-enabled-toggle"
                checked={enabled}
                onChange={e => setEnabled(e.target.checked)}
              />
              <span>{s.widget.enabledLabel}</span>
            </label>
            <p className="x-hint" style={{ margin: '4px 0 0 24px', fontSize: 12 }}>
              {s.widget.enabledHint}
            </p>
          </div>

          {/* Appearance */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{s.widget.appearanceHeading}</h3>
              <button
                type="button"
                data-testid="widget-reset-appearance-btn"
                className="x-button x-button-sm"
                onClick={resetAppearanceDefaults}
              >
                <RotateCcw size={13} />
                <span>{s.widget.resetDefaults}</span>
              </button>
            </div>

            {/* Section 1: Colors & Theme */}
            <div style={{ padding: 14, background: 'var(--x-alt)', borderRadius: 8, border: '1px solid var(--x-border)', display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{s.widget.sectionColors}</div>

              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 500, marginBottom: 6 }}>
                  {s.widget.colorPresets}
                </label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {[
                    { name: 'Ocean', p: '#2563eb', s: '#1d4ed8' },
                    { name: 'Emerald', p: '#059669', s: '#047857' },
                    { name: 'Violet', p: '#7c3aed', s: '#5b21b6' },
                    { name: 'Coral', p: '#e11d48', s: '#be123c' },
                    { name: 'Amber', p: '#d97706', s: '#b45309' },
                    { name: 'Slate', p: '#334155', s: '#1e293b' },
                  ].map(preset => (
                    <button
                      key={preset.name}
                      type="button"
                      data-testid={`widget-color-preset-${preset.name.toLowerCase()}`}
                      onClick={() => {
                        setPrimaryColor(preset.p)
                        setSecondaryColor(preset.s)
                      }}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '4px 10px',
                        borderRadius: 999,
                        border: primaryColor.toLowerCase() === preset.p ? '2px solid var(--x-accent, #2563eb)' : '1px solid var(--x-border)',
                        background: 'var(--x-bg, transparent)',
                        color: 'inherit',
                        fontSize: 12,
                        cursor: 'pointer',
                      }}
                    >
                      <span
                        style={{
                          width: 12,
                          height: 12,
                          borderRadius: '50%',
                          background: `linear-gradient(135deg, ${preset.p}, ${preset.s})`,
                          display: 'inline-block',
                        }}
                      />
                      <span>{preset.name}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 4 }}>
                    {s.widget.primaryColor}
                  </label>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input
                      type="color"
                      value={/^#[0-9a-fA-F]{6}$/.test(primaryColor) ? primaryColor : '#2563eb'}
                      onChange={e => setPrimaryColor(e.target.value)}
                      style={{ width: 38, height: 34, padding: 0, border: '1px solid var(--x-border)', borderRadius: 6, cursor: 'pointer' }}
                    />
                    <input
                      type="text"
                      data-testid="widget-primary-color-input"
                      className="x-input"
                      value={primaryColor}
                      onChange={e => setPrimaryColor(e.target.value)}
                      style={{ flex: 1, minWidth: 0 }}
                    />
                  </div>
                  <p className="x-hint" style={{ fontSize: 11, marginTop: 2 }}>{s.widget.primaryColorHint}</p>
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 4 }}>
                    {s.widget.secondaryColor}
                  </label>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input
                      type="color"
                      value={/^#[0-9a-fA-F]{6}$/.test(secondaryColor) ? secondaryColor : '#1d4ed8'}
                      onChange={e => setSecondaryColor(e.target.value)}
                      style={{ width: 38, height: 34, padding: 0, border: '1px solid var(--x-border)', borderRadius: 6, cursor: 'pointer' }}
                    />
                    <input
                      type="text"
                      data-testid="widget-secondary-color-input"
                      className="x-input"
                      value={secondaryColor}
                      onChange={e => setSecondaryColor(e.target.value)}
                      style={{ flex: 1, minWidth: 0 }}
                    />
                  </div>
                  <p className="x-hint" style={{ fontSize: 11, marginTop: 2 }}>{s.widget.secondaryColorHint}</p>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 4 }}>
                    {s.widget.theme}
                  </label>
                  <select
                    data-testid="widget-theme-select"
                    className="x-select"
                    value={theme}
                    onChange={e => setTheme(e.target.value as SupportDeskWidgetTheme)}
                  >
                    {SUPPORT_DESK_WIDGET_THEMES.map(t => (
                      <option key={t} value={t}>
                        {s.widget.themes[t]}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 4 }}>
                    {s.widget.headerStyle}
                  </label>
                  <select
                    data-testid="widget-header-style-select"
                    className="x-select"
                    value={headerStyle}
                    onChange={e => setHeaderStyle(e.target.value as SupportDeskHeaderStyle)}
                  >
                    {SUPPORT_DESK_HEADER_STYLES.map(hs => (
                      <option key={hs} value={hs}>
                        {s.widget.headerStyles[hs]}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            {/* Section 2: Header & Identity */}
            <div style={{ padding: 14, background: 'var(--x-alt)', borderRadius: 8, border: '1px solid var(--x-border)', display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{s.widget.sectionIdentity}</div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 4 }}>
                    {s.widget.title}
                  </label>
                  <input
                    type="text"
                    data-testid="widget-title-input"
                    className="x-input"
                    value={title}
                    onChange={e => setTitle(e.target.value)}
                    placeholder={s.widget.titlePlaceholder}
                    maxLength={SUPPORT_DESK_LIMITS.maxLabelChars}
                  />
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 4 }}>
                    {s.widget.subtitle}
                  </label>
                  <input
                    type="text"
                    data-testid="widget-subtitle-input"
                    className="x-input"
                    value={subtitle}
                    onChange={e => setSubtitle(e.target.value)}
                    placeholder={s.widget.subtitlePlaceholder}
                    maxLength={SUPPORT_DESK_LIMITS.maxSubtitleChars}
                  />
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, alignItems: 'end' }}>
                <div>
                  <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 4 }}>
                    {s.widget.avatarPreset}
                  </label>
                  <select
                    data-testid="widget-avatar-select"
                    className="x-select"
                    value={avatarPreset}
                    onChange={e => setAvatarPreset(e.target.value as SupportDeskAvatarPreset)}
                  >
                    {SUPPORT_DESK_AVATAR_PRESETS.map(ap => (
                      <option key={ap} value={ap}>
                        {s.widget.avatarPresets[ap]}
                      </option>
                    ))}
                  </select>
                </div>

                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', paddingBottom: 8, fontSize: 13, fontWeight: 500 }}>
                  <input
                    type="checkbox"
                    data-testid="widget-status-dot-toggle"
                    checked={showStatusDot}
                    onChange={e => setShowStatusDot(e.target.checked)}
                  />
                  <span>{s.widget.showStatusDot}</span>
                </label>
              </div>
            </div>

            {/* Section 3: Launcher & Position */}
            <div style={{ padding: 14, background: 'var(--x-alt)', borderRadius: 8, border: '1px solid var(--x-border)', display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{s.widget.sectionLauncher}</div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 4 }}>
                    {s.widget.position}
                  </label>
                  <select
                    data-testid="widget-position-select"
                    className="x-select"
                    value={position}
                    onChange={e => setPosition(e.target.value as SupportDeskWidgetPosition)}
                  >
                    {SUPPORT_DESK_WIDGET_POSITIONS.map(pos => (
                      <option key={pos} value={pos}>
                        {s.widget.positions[pos]}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 4 }}>
                    {s.widget.edgeOffsetPx}
                  </label>
                  <input
                    type="number"
                    data-testid="widget-edge-offset-input"
                    className="x-input"
                    min={SUPPORT_DESK_LIMITS.minEdgeOffsetPx}
                    max={SUPPORT_DESK_LIMITS.maxEdgeOffsetPx}
                    value={edgeOffsetPx}
                    onChange={e => {
                      const val = Number(e.target.value)
                      if (!Number.isNaN(val)) {
                        setEdgeOffsetPx(Math.min(SUPPORT_DESK_LIMITS.maxEdgeOffsetPx, Math.max(SUPPORT_DESK_LIMITS.minEdgeOffsetPx, Math.round(val))))
                      }
                    }}
                  />
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 4 }}>
                    {s.widget.launcherStyle}
                  </label>
                  <select
                    data-testid="widget-launcher-style-select"
                    className="x-select"
                    value={launcherStyle}
                    onChange={e => setLauncherStyle(e.target.value as SupportDeskLauncherStyle)}
                  >
                    {SUPPORT_DESK_LAUNCHER_STYLES.map(ls => (
                      <option key={ls} value={ls}>
                        {s.widget.launcherStyles[ls]}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 4 }}>
                    {s.widget.launcherLabel}
                  </label>
                  <input
                    type="text"
                    data-testid="widget-launcher-label-input"
                    className="x-input"
                    value={launcherLabel}
                    onChange={e => setLauncherLabel(e.target.value)}
                    placeholder={s.widget.launcherLabelPlaceholder}
                    maxLength={SUPPORT_DESK_LIMITS.maxLauncherLabelChars}
                    disabled={launcherStyle !== 'pill'}
                  />
                </div>
              </div>
            </div>

            {/* Section 4: Layout & Typography */}
            <div style={{ padding: 14, background: 'var(--x-alt)', borderRadius: 8, border: '1px solid var(--x-border)', display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{s.widget.sectionLayout}</div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 500, marginBottom: 4 }}>
                    {s.widget.borderRadius}
                  </label>
                  <select
                    data-testid="widget-border-radius-select"
                    className="x-select"
                    value={borderRadius}
                    onChange={e => setBorderRadius(e.target.value as SupportDeskBorderRadius)}
                  >
                    {SUPPORT_DESK_BORDER_RADII.map(br => (
                      <option key={br} value={br}>
                        {s.widget.borderRadii[br]}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 500, marginBottom: 4 }}>
                    {s.widget.widgetSize}
                  </label>
                  <select
                    data-testid="widget-size-select"
                    className="x-select"
                    value={widgetSize}
                    onChange={e => setWidgetSize(e.target.value as SupportDeskWidgetSize)}
                  >
                    {SUPPORT_DESK_WIDGET_SIZES.map(ws => (
                      <option key={ws} value={ws}>
                        {s.widget.widgetSizes[ws]}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 500, marginBottom: 4 }}>
                    {s.widget.fontFamily}
                  </label>
                  <select
                    data-testid="widget-font-family-select"
                    className="x-select"
                    value={fontFamily}
                    onChange={e => setFontFamily(e.target.value as SupportDeskFontFamily)}
                  >
                    {SUPPORT_DESK_FONT_FAMILIES.map(ff => (
                      <option key={ff} value={ff}>
                        {s.widget.fontFamilies[ff]}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            {/* Section 5: Messaging & Behavior */}
            <div style={{ padding: 14, background: 'var(--x-alt)', borderRadius: 8, border: '1px solid var(--x-border)', display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{s.widget.sectionBehavior}</div>

              <div>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 4 }}>
                  {s.widget.welcomeMessage}
                </label>
                <textarea
                  data-testid="widget-welcome-input"
                  className="x-textarea"
                  rows={3}
                  value={welcomeMessage}
                  onChange={e => setWelcomeMessage(e.target.value)}
                  placeholder={s.widget.welcomeMessagePlaceholder}
                  maxLength={SUPPORT_DESK_LIMITS.maxValueChars}
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 4 }}>
                    {s.widget.inputPlaceholder}
                  </label>
                  <input
                    type="text"
                    data-testid="widget-input-placeholder-input"
                    className="x-input"
                    value={inputPlaceholder}
                    onChange={e => setInputPlaceholder(e.target.value)}
                    maxLength={SUPPORT_DESK_LIMITS.maxLabelChars}
                  />
                  <p className="x-hint" style={{ fontSize: 11, marginTop: 2 }}>{s.widget.inputPlaceholderHint}</p>
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 4 }}>
                    {s.widget.sendButtonLabel}
                  </label>
                  <input
                    type="text"
                    data-testid="widget-send-label-input"
                    className="x-input"
                    value={sendButtonLabel}
                    onChange={e => setSendButtonLabel(e.target.value)}
                    maxLength={SUPPORT_DESK_LIMITS.maxSendLabelChars}
                  />
                  <p className="x-hint" style={{ fontSize: 11, marginTop: 2 }}>{s.widget.sendButtonLabelHint}</p>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, alignItems: 'center' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, fontWeight: 500 }}>
                  <input
                    type="checkbox"
                    data-testid="widget-powered-by-toggle"
                    checked={showPoweredBy}
                    onChange={e => setShowPoweredBy(e.target.checked)}
                  />
                  <span>{s.widget.showPoweredBy}</span>
                </label>

                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 500, marginBottom: 4 }}>
                    {s.widget.autoOpenDelaySeconds}
                  </label>
                  <input
                    type="number"
                    data-testid="widget-auto-open-input"
                    className="x-input"
                    min={0}
                    max={SUPPORT_DESK_LIMITS.maxAutoOpenDelaySeconds}
                    value={autoOpenDelaySeconds}
                    onChange={e => {
                      const val = Number(e.target.value)
                      if (!Number.isNaN(val)) {
                        setAutoOpenDelaySeconds(Math.min(SUPPORT_DESK_LIMITS.maxAutoOpenDelaySeconds, Math.max(0, Math.round(val))))
                      }
                    }}
                  />
                </div>
              </div>

              {/* Quick Prompts */}
              <div>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 4 }}>
                  {s.widget.quickPrompts}
                </label>
                <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                  <input
                    type="text"
                    data-testid="widget-prompt-input"
                    className="x-input"
                    value={newPrompt}
                    onChange={e => setNewPrompt(e.target.value)}
                    placeholder={s.widget.promptPlaceholder}
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        addQuickPrompt()
                      }
                    }}
                  />
                  <button
                    type="button"
                    data-testid="widget-add-prompt-btn"
                    className="x-button"
                    onClick={addQuickPrompt}
                  >
                    <Plus size={14} />
                    <span>{s.widget.addPrompt}</span>
                  </button>
                </div>
                {quickPrompts.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {quickPrompts.map((p, idx) => (
                      <div
                        key={idx}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: '6px 10px',
                          background: 'var(--x-bg, transparent)',
                          border: '1px solid var(--x-border)',
                          borderRadius: 6,
                          fontSize: 13,
                        }}
                      >
                        <span>{p}</span>
                        <button
                          type="button"
                          data-testid={`widget-remove-prompt-${idx}`}
                          className="x-button x-button-sm"
                          onClick={() => removeQuickPrompt(idx)}
                          style={{ padding: '2px 6px' }}
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Intake Survey Configuration */}
          <div style={{ borderTop: '1px solid var(--x-border)', paddingTop: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{s.widget.intakeHeading}</h3>

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 500 }}>
              <input
                type="checkbox"
                data-testid="intake-required-toggle"
                checked={intakeRequired}
                onChange={e => setIntakeRequired(e.target.checked)}
              />
              <span>{s.widget.intakeRequired}</span>
            </label>
            <p className="x-hint" style={{ margin: '-8px 0 0 24px', fontSize: 12 }}>
              {s.widget.intakeRequiredHint}
            </p>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{s.widget.fieldsHeading}</span>
              <button
                type="button"
                data-testid="intake-add-field-btn"
                className="x-button x-button-sm"
                onClick={addField}
              >
                <Plus size={14} />
                <span>{s.widget.addField}</span>
              </button>
            </div>

            {fields.length === 0 && (
              <p className="x-hint" style={{ fontStyle: 'italic', margin: 0 }}>
                {s.widget.noFields}
              </p>
            )}

            {fields.map((field, idx) => (
              <div
                key={idx}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  padding: 12,
                  background: 'var(--x-alt)',
                  border: '1px solid var(--x-border)',
                  borderRadius: 8,
                }}
              >
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <div>
                    <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--x-muted)' }}>
                      {s.widget.fieldKey}
                    </label>
                    <input
                      type="text"
                      data-testid={`intake-field-key-${idx}`}
                      className="x-input"
                      value={field.key}
                      onChange={e => updateField(idx, { key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') })}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--x-muted)' }}>
                      {s.widget.fieldLabel}
                    </label>
                    <input
                      type="text"
                      data-testid={`intake-field-label-${idx}`}
                      className="x-input"
                      value={field.label}
                      onChange={e => updateField(idx, { label: e.target.value })}
                    />
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, alignItems: 'center' }}>
                  <div>
                    <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--x-muted)' }}>
                      {s.widget.fieldType}
                    </label>
                    <select
                      data-testid={`intake-field-type-${idx}`}
                      className="x-select"
                      value={field.type}
                      onChange={e => updateField(idx, { type: e.target.value as SupportDeskIntakeFieldType })}
                    >
                      {SUPPORT_DESK_INTAKE_FIELD_TYPES.map(t => (
                        <option key={t} value={t}>
                          {s.widget.fieldTypes[t]}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: 16 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        data-testid={`intake-field-required-${idx}`}
                        checked={field.required}
                        onChange={e => updateField(idx, { required: e.target.checked })}
                      />
                      <span>{s.widget.fieldRequired}</span>
                    </label>

                    <button
                      type="button"
                      data-testid={`intake-remove-field-${idx}`}
                      className="x-button x-button-sm"
                      onClick={() => removeField(idx)}
                      style={{ color: '#dc2626' }}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>

                {field.type === 'select' && (
                  <div>
                    <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--x-muted)' }}>
                      {s.widget.fieldOptions}
                    </label>
                    <input
                      type="text"
                      data-testid={`intake-field-options-${idx}`}
                      className="x-input"
                      placeholder="Choice 1, Choice 2, Choice 3"
                      value={(field.options || []).join(', ')}
                      onChange={e =>
                        updateField(idx, {
                          options: e.target.value
                            .split(',')
                            .map(o => o.trim())
                            .filter(Boolean),
                        })
                      }
                    />
                    <p className="x-hint" style={{ fontSize: 11, marginTop: 2 }}>{s.widget.fieldOptionsHint}</p>
                  </div>
                )}
              </div>
            ))}
          </div>

          <div style={{ paddingTop: 8 }}>
            <button
              type="button"
              data-testid="widget-save-btn"
              className="x-button x-button-primary"
              disabled={saveMutation.isPending}
              onClick={handleSave}
            >
              {saveMutation.isPending ? s.widget.saving : s.widget.saveConfigBtn}
            </button>
          </div>
        </div>
      </div>

      {/* Live Preview & End-User Test Column */}
      <div style={{ position: 'sticky', top: 20 }}>
        <h3 style={{ margin: '0 0 4px 0', fontSize: 15, fontWeight: 600 }}>{s.widget.previewHeading}</h3>
        <p className="x-hint" style={{ margin: '0 0 12px 0', fontSize: 12 }}>
          {s.widget.previewNote}
        </p>
        <SupportWidgetLiveTest
          {...liveTestProps}
          publicConfig={livePreviewConfig}
          hasUnsavedChanges={hasUnsavedWidgetChanges(configQuery.data?.config, livePreviewConfig)}
          onSaveAndApply={() => {
            void handleSave()
          }}
          savedEnabled={configQuery.data?.config?.enabled ?? false}
          savedConfigVersion={configQuery.data?.config?.version ?? 1}
        />
      </div>
    </div>
  )
}

// ---------------------------------------------------------
// Tab 2: Operator Copilot
// ---------------------------------------------------------
function CopilotTabPanel({
  tenantBase,
  tenantKey,
  tenant,
  preferredConvId,
  focusSeq,
}: {
  tenantBase: string
  tenantKey: readonly unknown[]
  tenant: SupportTenant
  preferredConvId?: string | null
  focusSeq?: number
}) {

  // 1. Fetch conversations
  const conversationsQuery = useQuery({
    queryKey: [...tenantKey, 'conversations'],
    queryFn: ({ signal }) =>
      apiFetch<{ ok: boolean; conversations: SupportConversation[] }>(
        `/api/thruline/support/tenants/${tenant.id}/conversations`,
        { signal }
      ).then(r => r.conversations || []),
  })

  const conversations = useMemo(() => conversationsQuery.data || [], [conversationsQuery.data])
  const [manualSelection, setManualSelection] = useState<{ seq: number; id: string } | null>(null)
  const targetFocusSeq = focusSeq ?? 0
  const effectiveConvId =
    manualSelection && manualSelection.seq === targetFocusSeq
      ? manualSelection.id
      : (preferredConvId ?? null)

  const activeConv = conversations.find(c => c.id === effectiveConvId) || (conversations.length > 0 ? conversations[0] : null)

  return <CopilotConversationPanel key={activeConv?.id ?? 'empty'}
    tenantBase={tenantBase} tenantKey={tenantKey} tenant={tenant}
    activeConv={activeConv} conversations={conversations}
    conversationsLoading={conversationsQuery.isPending} onSelect={id => setManualSelection({ seq: targetFocusSeq, id })} />
}

function CopilotConversationPanel({ tenantBase, tenantKey, tenant, activeConv, conversations, conversationsLoading, onSelect }: {
  tenantBase: string
  tenantKey: readonly unknown[]
  tenant: SupportTenant
  activeConv: SupportConversation | null
  conversations: SupportConversation[]
  conversationsLoading: boolean
  onSelect: (id: string) => void
}) {
  const s = useSupportServiceDeskStrings()
  const liveS = useSupportServiceDeskLiveTestStrings()
  const queryClient = useQueryClient()
  const session = useUserSession()
  const generateAbort = useMutationAbort()
  const replyAbort = useMutationAbort()
  const validationAbort = useMutationAbort()
  // Copilot draft generation state
  const [copilotResult, setCopilotResult] = useState<SupportDeskCopilotResult | null>(null)
  const [composerText, setComposerText] = useState('')
  const [replySuccess, setReplySuccess] = useState(false)
  const [resolveOnSend, setResolveOnSend] = useState(false)
  const [copilotError, setCopilotError] = useState<string | null>(null)

  const generateMutation = useMutation({
    mutationFn: (convId: string) => {
      const requestId = `req_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 9)}`
      return apiFetch<{ ok: boolean; result: SupportDeskCopilotResult }>(`${tenantBase}/copilot`, {
        method: 'POST',
        body: JSON.stringify({
          requestId,
          conversationId: convId,
        }),
        signal: generateAbort.nextSignal(),
      })
    },
    onSuccess: data => {
      if (!generateAbort.isMountedAndActive()) return
      setCopilotError(null)
      if (data?.result) {
        setCopilotResult(data.result)
      }
    },
    onError: (err: unknown) => {
      if (!generateAbort.isMountedAndActive()) return
      // Hide stale/revoked drafts on error
      setCopilotResult(null)
      setComposerText('')
      const errObj = err as { status?: number; name?: string; message?: string }
      if (errObj?.status === 401 || errObj?.status === 403) {
        setCopilotError(s.copilot.errors.authError)
      } else if (errObj?.status === 429) {
        setCopilotError(s.copilot.errors.rateLimited)
      } else if (errObj?.status === 503 || errObj?.status === 504) {
        setCopilotError(s.copilot.errors.modelUnavailable)
      } else if (errObj?.status === 409) {
        setCopilotError(s.copilot.errors.contextChanged)
      } else if (errObj?.name === 'TypeError' || errObj?.message?.toLowerCase().includes('network') || errObj?.message?.toLowerCase().includes('failed to fetch')) {
        setCopilotError(s.copilot.errors.networkError)
      } else {
        setCopilotError(errObj?.message || s.error)
      }
    },
  })

  const sendReplyMutation = useMutation({
    mutationFn: async (args: { convId: string; message: string }) => {
      if (copilotResult) await readCurrentJob(replyAbort.nextSignal())
      if (!replyAbort.isMountedAndActive()) throw new DOMException('Cancelled', 'AbortError')
      return apiFetch<{ ok: boolean }>(`/api/thruline/support/tenants/${tenant.id}/conversations/${args.convId}/reply`, {
        method: 'POST',
        body: JSON.stringify({
          content: args.message,
          agentName: session.session?.email || 'Support Agent',
          ...(resolveOnSend ? { resolveConversation: true } : {}),
        }),
        signal: replyAbort.nextSignal(),
      })
    },
    onSuccess: () => {
      if (!replyAbort.isMountedAndActive()) return
      setReplySuccess(true)
      setComposerText('')
      setCopilotResult(null)
      queryClient.invalidateQueries({ queryKey: [...tenantKey, 'conversations'] })
      queryClient.invalidateQueries({ queryKey: [...tenantKey, 'queue'] })
    },
    onError: () => {
      if (!replyAbort.isMountedAndActive()) return
      setCopilotResult(null)
      setComposerText('')
      setCopilotError(s.copilot.errors.contextChanged)
    },
  })

  async function readCurrentJob(signal: AbortSignal) {
    if (!copilotResult) throw new Error('No current Copilot job')
    const response = await apiFetch<{ ok: boolean; result: SupportDeskCopilotResult }>(
      `${tenantBase}/copilot/jobs/${encodeURIComponent(copilotResult.jobId)}`, { signal })
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError')
    return response.result
  }

  useQuery({
    queryKey: [...tenantKey, 'copilot-job', copilotResult?.jobId, activeConv?.updatedAt],
    queryFn: ({ signal }) => readCurrentJob(signal),
    enabled: !!copilotResult,
    retry: false,
    refetchInterval: 15_000,
    refetchOnWindowFocus: 'always',
  })
  useEffect(() => {
    const jobId = copilotResult?.jobId
    if (!jobId) return
    return queryClient.getQueryCache().subscribe(event => {
      if (event.type !== 'updated' || !event.query.queryKey.includes(jobId) || event.query.state.status !== 'error') return
      setCopilotResult(null)
      setComposerText('')
      setCopilotError(s.copilot.errors.contextChanged)
    })
  }, [queryClient, copilotResult?.jobId, s.copilot.errors.contextChanged])

  async function handleUseDraft(tone: SupportDeskCopilotDraft['tone']) {
    try {
      const result = await readCurrentJob(validationAbort.nextSignal())
      if (!validationAbort.isMountedAndActive()) return
      const draft = result.drafts.find(item => item.tone === tone)
      if (!draft || result.status !== 'completed') throw new Error('Stale draft')
      setComposerText(draft.text)
    } catch {
      if (!validationAbort.isMountedAndActive()) return
      setCopilotResult(null)
      setComposerText('')
      setCopilotError(s.copilot.errors.contextChanged)
    }
  }

  function handleSendReply() {
    if (!composerText.trim() || !activeConv) return
    sendReplyMutation.mutate({ convId: activeConv.id, message: composerText.trim() })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <p className="x-hint" style={{ margin: 0 }}>{s.copilot.description}</p>

      {/* Conversation Selector */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <label htmlFor="copilot-conv-select" style={{ fontSize: 13, fontWeight: 500 }}>
          {s.copilot.selectConversation}:
        </label>
        <select
          id="copilot-conv-select"
          data-testid="copilot-conversation-select"
          className="x-select"
          value={activeConv?.id ?? ''}
          onChange={e => {
            generateAbort.abort()
            onSelect(e.target.value)
            setCopilotResult(null)
            setCopilotError(null)
          }}
          style={{ minWidth: 280 }}
        >
          {conversations.map(c => (
            <option key={c.id} value={c.id}>
              {s.copilot.convLabel
                .replace('{id}', c.id.slice(0, 8))
                .replace('{role}', c.userRole || 'customer')
                .replace('{status}', c.status)}
            </option>
          ))}
        </select>
      </div>

      {conversationsLoading && <div className="x-loading">{s.loading}</div>}

      {!conversationsLoading && conversations.length === 0 && (
        <div className="x-empty" data-testid="copilot-no-conversations">
          <p>{s.copilot.noConversations}</p>
        </div>
      )}

      {activeConv && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(300px, 1fr) minmax(360px, 1.2fr)', gap: 24 }}>
          {/* Left: Transcript and Generate Button */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>{s.copilot.messagesHeading}</h3>
              <button
                type="button"
                data-testid="copilot-generate-btn"
                className="x-button x-button-primary x-button-sm"
                disabled={generateMutation.isPending}
                onClick={() => generateMutation.mutate(activeConv.id)}
              >
                <Bot size={14} />
                <span>{generateMutation.isPending ? s.copilot.generating : s.copilot.generateBtn}</span>
              </button>
            </div>

            <div
              data-testid="copilot-messages-list"
              style={{
                background: 'var(--x-alt)',
                border: '1px solid var(--x-border)',
                borderRadius: 8,
                padding: 14,
                maxHeight: 460,
                overflowY: 'auto',
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
              }}
            >
              {(!activeConv.messages || activeConv.messages.length === 0) && (
                <p className="x-hint" style={{ fontStyle: 'italic', margin: 0 }}>
                  {s.copilot.emptyMessages}
                </p>
              )}
              {activeConv.messages?.map((msg, i) => {
                const role = msg.senderType || msg.role || 'user'
                const isUser = role === 'user' || role === 'guest' || role === 'customer'
                return (
                  <div
                    key={i}
                    style={{
                      alignSelf: isUser ? 'flex-end' : 'flex-start',
                      maxWidth: '85%',
                      padding: '8px 12px',
                      background: isUser ? '#2563eb' : 'var(--x-panel)',
                      color: isUser ? '#fff' : 'var(--x-text)',
                      border: isUser ? 'none' : '1px solid var(--x-border)',
                      borderRadius: 12,
                      fontSize: 13,
                      wordBreak: 'break-word',
                    }}
                  >
                    <div style={{ fontSize: 10, opacity: 0.8, marginBottom: 2, fontWeight: 600 }}>
                      {msg.senderName || role}
                    </div>
                    <div>{msg.content}</div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Right: Copilot Drafts & Reply Composer */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {copilotError && (
              <div className="x-alert x-alert-error" role="alert" data-testid="copilot-error">
                <XCircle size={16} />
                <span>{copilotError}</span>
              </div>
            )}

            {copilotResult?.status === 'abstained' && (
              <div
                className="x-alert x-alert-warning"
                role="status"
                data-testid="copilot-abstained-notice"
              >
                <ShieldAlert size={18} />
                <div>
                  <strong>{s.copilot.abstainedHeading}: </strong>
                  <span>{s.copilot.reasons[copilotResult.reason || 'no_evidence']}</span>
                </div>
              </div>
            )}

            {copilotResult?.status === 'completed' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {/* Summary */}
                {copilotResult.summary && (
                  <div
                    data-testid="copilot-summary"
                    style={{
                      padding: 12,
                      background: '#f0fdf4',
                      border: '1px solid #bbf7d0',
                      borderRadius: 8,
                      fontSize: 13,
                    }}
                  >
                    <h4 style={{ margin: '0 0 6px 0', fontSize: 13, color: '#166534', fontWeight: 600 }}>
                      {s.copilot.summaryHeading}
                    </h4>
                    <p style={{ margin: 0, color: '#14532d' }}>{copilotResult.summary}</p>
                    {copilotResult.summaryCitations && copilotResult.summaryCitations.length > 0 && (
                      <div data-testid="copilot-summary-citations" style={{ marginTop: 8, fontSize: 11, color: '#166534' }}>
                        <strong>{s.copilot.citationsHeading}: </strong>
                        {copilotResult.summaryCitations.map((c, ci) => (
                          <span key={ci} style={{ marginRight: 6 }}>
                            [{c.ordinal || ci + 1}] {c.title}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Drafts */}
                <div data-testid="copilot-drafts" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <h4 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>{s.copilot.draftsHeading}</h4>
                  {copilotResult.drafts?.map((draft: SupportDeskCopilotDraft) => (
                    <div
                      key={draft.tone}
                      data-testid={`copilot-draft-${draft.tone}`}
                      style={{
                        padding: 12,
                        background: 'var(--x-panel)',
                        border: '1px solid var(--x-border)',
                        borderRadius: 8,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 8,
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: 12, fontWeight: 600, color: '#2563eb' }}>
                          {s.copilot.tones[draft.tone]}
                        </span>
                        <button
                          type="button"
                          data-testid={`copilot-use-draft-${draft.tone}`}
                          className="x-button x-button-sm"
                          onClick={() => void handleUseDraft(draft.tone)}
                        >
                          <Copy size={12} />
                          <span>{s.copilot.useDraftBtn}</span>
                        </button>
                      </div>
                      <div
                        data-testid={`copilot-draft-text-${draft.tone}`}
                        style={{ fontSize: 13, color: 'var(--x-text)', whiteSpace: 'pre-wrap' }}
                      >
                        {draft.text}
                      </div>
                      {draft.citations && draft.citations.length > 0 && (
                        <div
                          data-testid={`copilot-draft-citations-${draft.tone}`}
                          style={{ fontSize: 11, color: 'var(--x-muted)', borderTop: '1px solid var(--x-border)', paddingTop: 6 }}
                        >
                          <strong>{s.copilot.citationsHeading}: </strong>
                          {draft.citations.map((c, ci) => (
                            <span key={ci} style={{ marginRight: 6 }}>
                              [{c.ordinal || ci + 1}] {c.title}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {/* Accounting */}
                <div
                  data-testid="copilot-usage-info"
                  style={{
                    padding: 8,
                    background: 'var(--x-alt)',
                    borderRadius: 6,
                    fontSize: 11,
                    color: 'var(--x-muted)',
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 12,
                  }}
                >
                  <span>
                    <strong>{s.copilot.modelUsed}:</strong> {copilotResult.modelUsed || 'N/A'}
                  </span>
                  <span>
                    <strong>{s.copilot.promptTokens}:</strong> {copilotResult.usage?.promptTokens ?? 0}
                  </span>
                  <span>
                    <strong>{s.copilot.completionTokens}:</strong> {copilotResult.usage?.completionTokens ?? 0}
                  </span>
                  <span>
                    <strong>{s.copilot.totalTokens}:</strong> {copilotResult.usage?.totalTokens ?? 0}
                  </span>
                  <span>
                    <strong>{s.copilot.accountingMode}:</strong> {copilotResult.usage?.accounting ?? 'actual'}
                  </span>
                </div>
              </div>
            )}

            {/* Manual Reply Composer */}
            <div
              data-testid="copilot-composer-section"
              style={{
                borderTop: '1px solid var(--x-border)',
                paddingTop: 14,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <h4 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>{s.copilot.composerHeading}</h4>
              <p className="x-hint" style={{ margin: 0, fontSize: 12 }}>
                {s.copilot.composerHint}
              </p>
              <textarea
                data-testid="copilot-composer-input"
                className="x-textarea"
                rows={4}
                value={composerText}
                onChange={e => setComposerText(e.target.value)}
                placeholder={s.copilot.composerPlaceholder}
              />
              <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    data-testid="copilot-resolve-on-send"
                    checked={resolveOnSend}
                    onChange={e => setResolveOnSend(e.target.checked)}
                  />
                  <span>{liveS.copilotResolveOnSend}</span>
                </label>
                {replySuccess && (
                  <span
                    data-testid="copilot-reply-success"
                    style={{ color: '#059669', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}
                  >
                    <CheckCircle2 size={14} />
                    {s.copilot.replySent}
                  </span>
                )}
                <button
                  type="button"
                  data-testid="copilot-send-reply-btn"
                  className="x-button x-button-primary"
                  disabled={!composerText.trim() || sendReplyMutation.isPending}
                  onClick={handleSendReply}
                  style={{ marginLeft: 'auto' }}
                >
                  <Send size={14} />
                  <span>{sendReplyMutation.isPending ? s.copilot.sendingReply : s.copilot.sendReplyBtn}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------
// Tab 3: Queues & SLA
// ---------------------------------------------------------
function QueuesTabPanel({
  tenantBase,
  tenantKey,
}: {
  tenantBase: string
  tenantKey: readonly unknown[]
}) {
  const s = useSupportServiceDeskStrings()
  const queryClient = useQueryClient()
  const savePolicyAbort = useMutationAbort()
  const reassignAbort = useMutationAbort()

  // 1. SLA Policy query
  const policyQuery = useQuery({
    queryKey: [...tenantKey, 'sla-policy'],
    queryFn: ({ signal }) =>
      apiFetch<{ ok: boolean; policy: SupportDeskSlaPolicy }>(`${tenantBase}/sla-policy`, { signal }).then(
        r => r.policy || DEFAULT_SUPPORT_DESK_SLA_POLICY
      ),
  })

  const [policyDraft, setPolicyDraft] = useState<{
    enabled?: boolean
    targets?: typeof DEFAULT_SUPPORT_DESK_SLA_POLICY.targets
    rules?: SupportDeskRoutingRule[]
  }>({})
  const policyEnabled = policyDraft.enabled ?? policyQuery.data?.enabled ?? false
  const targets = policyDraft.targets ?? policyQuery.data?.targets ?? DEFAULT_SUPPORT_DESK_SLA_POLICY.targets
  const rules = policyDraft.rules ?? policyQuery.data?.routingRules ?? []
  const setPolicyEnabled = (v: boolean) => setPolicyDraft(d => ({ ...d, enabled: v }))
  const setTargets = (v: typeof DEFAULT_SUPPORT_DESK_SLA_POLICY.targets) => setPolicyDraft(d => ({ ...d, targets: v }))
  const setRules = (v: SupportDeskRoutingRule[]) => setPolicyDraft(d => ({ ...d, rules: v }))

  const [policyConflict, setPolicyConflict] = useState(false)
  const [policySaved, setPolicySaved] = useState(false)
  const [policyError, setPolicyError] = useState<string | null>(null)

  const savePolicyMutation = useMutation({
    mutationFn: (body: {
      expectedVersion: number
      enabled: boolean
      targets: typeof targets
      routingRules: SupportDeskRoutingRule[]
    }) =>
      apiFetch<{ ok: boolean; policy: SupportDeskSlaPolicy }>(`${tenantBase}/sla-policy`, {
        method: 'PUT',
        body: JSON.stringify(body),
        signal: savePolicyAbort.nextSignal(),
      }),
    onSuccess: () => {
      if (!savePolicyAbort.isMountedAndActive()) return
      setPolicyDraft({})
      setPolicySaved(true)
      setPolicyConflict(false)
      setPolicyError(null)
      queryClient.invalidateQueries({ queryKey: [...tenantKey, 'sla-policy'] })
      setTimeout(() => setPolicySaved(false), 3000)
    },
    onError: (err: unknown) => {
      if (!savePolicyAbort.isMountedAndActive()) return
      const errObj = err as { status?: number; message?: string }
      if (errObj?.status === 409 || errObj?.message?.includes('conflict') || errObj?.message?.includes('version')) {
        setPolicyConflict(true)
      } else {
        setPolicyError(errObj?.message || s.error)
      }
    },
  })

  function handleSavePolicy() {
    setPolicyError(null)
    setPolicyConflict(false)
    const currentVer = policyQuery.data?.version ?? 1
    savePolicyMutation.mutate({
      expectedVersion: currentVer,
      enabled: policyEnabled,
      targets,
      routingRules: rules,
    })
  }

  function addRule() {
    if (rules.length >= SUPPORT_DESK_LIMITS.maxRoutingRules) return
    const newId = `rule_${Date.now().toString(36)}`
    setRules([...rules, { id: newId, department: 'general', keywords: [] }])
  }

  function updateRule(idx: number, patch: Partial<SupportDeskRoutingRule>) {
    setRules(rules.map((r, i) => (i === idx ? { ...r, ...patch } : r)))
  }

  function removeRule(idx: number) {
    setRules(rules.filter((_, i) => i !== idx))
  }

  // 2. Queue query
  const [filterDept, setFilterDept] = useState<string>('all')
  const [filterStatus, setFilterStatus] = useState<string>('all')

  const queueQuery = useQuery({
    queryKey: [...tenantKey, 'queue', filterDept, filterStatus],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams()
      if (filterDept !== 'all') params.set('department', filterDept)
      if (filterStatus !== 'all') params.set('status', filterStatus)
      params.set('limit', '50')
      return apiFetch<{ ok: boolean; items: SupportQueueItem[]; nextCursor?: string }>(
        `${tenantBase}/queue?${params.toString()}`,
        { signal }
      ).then(r => r.items || [])
    },
  })

  const queueItems = queueQuery.data || []

  // Reassign department mutation
  const reassignMutation = useMutation({
    mutationFn: (args: { ticketId: string; expectedVersion: number; department: SupportDeskDepartment }) =>
      apiFetch<{ ok: boolean; state: SupportDeskTicketState }>(`${tenantBase}/tickets/${args.ticketId}/routing`, {
        method: 'PATCH',
        body: JSON.stringify({
          expectedVersion: args.expectedVersion,
          department: args.department,
        }),
        signal: reassignAbort.nextSignal(),
      }),
    onSuccess: () => {
      if (!reassignAbort.isMountedAndActive()) return
      queryClient.invalidateQueries({ queryKey: [...tenantKey, 'queue'] })
    },
  })

  const [selectedDepts, setSelectedDepts] = useState<Record<string, SupportDeskDepartment>>({})

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* Section 1: SLA Policy Configuration */}
      <div style={{ padding: 16, background: 'var(--x-alt)', border: '1px solid var(--x-border)', borderRadius: 8 }}>
        <h3 style={{ margin: '0 0 8px 0', fontSize: 15, fontWeight: 600 }}>{s.queues.policyHeading}</h3>
        <p className="x-hint" style={{ margin: '0 0 14px 0', fontSize: 12 }}>
          {s.queues.policyEnabledHint}
        </p>

        <Feedback
          error={policyError ? new Error(policyError) : null}
          success={policySaved}
          conflict={policyConflict}
        />

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 500, marginBottom: 16 }}>
          <input
            type="checkbox"
            data-testid="sla-enabled-toggle"
            checked={policyEnabled}
            onChange={e => setPolicyEnabled(e.target.checked)}
          />
          <span>{s.queues.policyEnabled}</span>
        </label>

        {/* Priority Targets */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
          <h4 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>{s.queues.targetsHeading}</h4>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
            {(['urgent', 'high', 'medium', 'low'] as SupportTicketPriority[]).map(p => (
              <div
                key={p}
                style={{
                  padding: 10,
                  background: 'var(--x-panel)',
                  border: '1px solid var(--x-border)',
                  borderRadius: 6,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                }}
              >
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--x-text)' }}>
                  {s.queues.priorities[p]}
                </span>
                <div>
                  <label style={{ display: 'block', fontSize: 11, color: 'var(--x-muted)' }}>
                    {s.queues.firstResponseMinutes}
                  </label>
                  <input
                    type="number"
                    data-testid={`sla-target-first-${p}`}
                    className="x-input"
                    value={targets[p]?.firstResponseMinutes ?? 60}
                    onChange={e =>
                      setTargets({
                        ...targets,
                        [p]: {
                          ...targets[p],
                          firstResponseMinutes: Number(e.target.value),
                        },
                      })
                    }
                    min={1}
                    max={10080}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 11, color: 'var(--x-muted)' }}>
                    {s.queues.resolutionMinutes}
                  </label>
                  <input
                    type="number"
                    data-testid={`sla-target-resolution-${p}`}
                    className="x-input"
                    value={targets[p]?.resolutionMinutes ?? 1440}
                    onChange={e =>
                      setTargets({
                        ...targets,
                        [p]: {
                          ...targets[p],
                          resolutionMinutes: Number(e.target.value),
                        },
                      })
                    }
                    min={1}
                    max={10080}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Routing Rules */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h4 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>{s.queues.routingHeading}</h4>
            <button
              type="button"
              data-testid="sla-add-rule-btn"
              className="x-button x-button-sm"
              onClick={addRule}
            >
              <Plus size={12} />
              <span>{s.queues.addRule}</span>
            </button>
          </div>

          {rules.length === 0 && (
            <p className="x-hint" style={{ fontStyle: 'italic', margin: 0 }}>
              {s.queues.noRules}
            </p>
          )}

          {rules.map((rule, idx) => (
            <div
              key={rule.id || idx}
              data-testid={`sla-rule-${idx}`}
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'center',
                padding: 8,
                background: 'var(--x-panel)',
                border: '1px solid var(--x-border)',
                borderRadius: 6,
              }}
            >
              <select
                data-testid={`sla-rule-dept-${idx}`}
                className="x-select"
                value={rule.department}
                onChange={e => updateRule(idx, { department: e.target.value as SupportDeskDepartment })}
                style={{ width: 140 }}
              >
                {SUPPORT_DESK_DEPARTMENTS.map(d => (
                  <option key={d} value={d}>
                    {s.queues.departments[d]}
                  </option>
                ))}
              </select>

              <input
                type="text"
                data-testid={`sla-rule-keywords-${idx}`}
                className="x-input"
                value={(rule.keywords || []).join(', ')}
                onChange={e =>
                  updateRule(idx, {
                    keywords: e.target.value
                      .split(',')
                      .map(k => k.trim())
                      .filter(Boolean),
                  })
                }
                placeholder="refund, billing, invoice"
                style={{ flex: 1 }}
              />

              <button
                type="button"
                data-testid={`sla-rule-remove-${idx}`}
                className="x-button x-button-sm"
                onClick={() => removeRule(idx)}
                style={{ color: '#dc2626' }}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>

        <button
          type="button"
          data-testid="sla-save-btn"
          className="x-button x-button-primary"
          disabled={savePolicyMutation.isPending}
          onClick={handleSavePolicy}
        >
          {savePolicyMutation.isPending ? s.queues.savingPolicy : s.queues.savePolicyBtn}
        </button>
      </div>

      {/* Section 2: Support Queue View */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{s.queues.queueHeading}</h3>

          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
              <span>{s.queues.filterDepartment}:</span>
              <select
                data-testid="queue-dept-filter"
                className="x-select"
                value={filterDept}
                onChange={e => setFilterDept(e.target.value)}
              >
                <option value="all">{s.queues.allDepartments}</option>
                {SUPPORT_DESK_DEPARTMENTS.map(d => (
                  <option key={d} value={d}>
                    {s.queues.departments[d]}
                  </option>
                ))}
              </select>
            </label>

            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
              <span>{s.queues.filterStatus}:</span>
              <select
                data-testid="queue-status-filter"
                className="x-select"
                value={filterStatus}
                onChange={e => setFilterStatus(e.target.value)}
              >
                <option value="all">{s.queues.allStatuses}</option>
                <option value="open">Open</option>
                <option value="in_progress">In Progress</option>
                <option value="escalated">Escalated</option>
                <option value="resolved">Resolved</option>
                <option value="closed">Closed</option>
              </select>
            </label>
          </div>
        </div>

        {queueQuery.isPending && <div className="x-loading">{s.loading}</div>}

        {!queueQuery.isPending && queueItems.length === 0 && (
          <div className="x-empty" data-testid="queue-no-tickets">
            <p>{s.queues.noTickets}</p>
          </div>
        )}

        {queueItems.length > 0 && (
          <div data-testid="queue-items-list" style={{ overflowX: 'auto' }}>
            <table className="x-table" style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--x-border)', textAlign: 'left', background: 'var(--x-alt)' }}>
                  <th style={{ padding: '8px 12px' }}>{s.queues.ticketColId}</th>
                  <th style={{ padding: '8px 12px' }}>{s.queues.ticketColSubject}</th>
                  <th style={{ padding: '8px 12px' }}>{s.queues.ticketColPriority}</th>
                  <th style={{ padding: '8px 12px' }}>{s.queues.ticketColDept}</th>
                  <th style={{ padding: '8px 12px' }}>{s.queues.ticketColStatus}</th>
                  <th style={{ padding: '8px 12px' }}>{s.queues.ticketColFirstSla}</th>
                  <th style={{ padding: '8px 12px' }}>{s.queues.ticketColResolutionSla}</th>
                  <th style={{ padding: '8px 12px' }}>{s.queues.ticketColActions}</th>
                </tr>
              </thead>
              <tbody>
                {queueItems.map(item => {
                  const t = item.ticket
                  const firstClock = item.firstResponseClock
                  const resClock = item.resolutionClock
                  const currentSelectedDept = selectedDepts[t.id] || t.department || 'general'

                  function renderClockBadge(clock?: SupportDeskSlaClock) {
                    if (!clock || clock.status === 'not_observed') {
                      return <span className="x-badge" style={{ background: '#f3f4f6', color: '#6b7280' }}>{s.queues.slaStatus.not_observed}</span>
                    }
                    if (clock.status === 'met') {
                      return <span className="x-badge" style={{ background: '#dcfce7', color: '#15803d' }}>{s.queues.slaStatus.met}</span>
                    }
                    if (clock.status === 'warning') {
                      return <span className="x-badge" style={{ background: '#fef3c7', color: '#b45309' }}>{s.queues.slaStatus.warning}</span>
                    }
                    if (clock.status === 'breached') {
                      return <span className="x-badge" style={{ background: '#fee2e2', color: '#b91c1c' }}>{s.queues.slaStatus.breached}</span>
                    }
                    return <span className="x-badge" style={{ background: '#e0f2fe', color: '#0369a1' }}>{s.queues.slaStatus.healthy}</span>
                  }

                  return (
                    <tr
                      key={t.id}
                      data-testid={`queue-ticket-row-${t.id}`}
                      style={{ borderBottom: '1px solid var(--x-border)' }}
                    >
                      <td style={{ padding: '8px 12px', fontFamily: 'monospace', fontWeight: 600 }}>
                        {t.id.slice(0, 8)}
                      </td>
                      <td style={{ padding: '8px 12px' }}>
                        <div>{t.subject}</div>
                        {t.reason && <div style={{ fontSize: 11, color: 'var(--x-muted)' }}>{t.reason}</div>}
                      </td>
                      <td style={{ padding: '8px 12px' }}>
                        <span className="x-badge">{t.priority}</span>
                      </td>
                      <td style={{ padding: '8px 12px' }}>
                        {s.queues.departments[t.department || 'general']}
                      </td>
                      <td style={{ padding: '8px 12px' }}>
                        <span className="x-badge">{t.status}</span>
                      </td>
                      <td style={{ padding: '8px 12px' }}>
                        <span data-testid={`queue-first-response-status-${t.id}`}>
                          {renderClockBadge(firstClock)}
                        </span>
                      </td>
                      <td style={{ padding: '8px 12px' }}>
                        <span data-testid={`queue-resolution-status-${t.id}`}>
                          {renderClockBadge(resClock)}
                        </span>
                      </td>
                      <td style={{ padding: '8px 12px' }}>
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                          <select
                            data-testid={`queue-reassign-select-${t.id}`}
                            className="x-select"
                            value={currentSelectedDept}
                            onChange={e =>
                              setSelectedDepts({
                                ...selectedDepts,
                                [t.id]: e.target.value as SupportDeskDepartment,
                              })
                            }
                            style={{ padding: '2px 4px', fontSize: 11 }}
                          >
                            {SUPPORT_DESK_DEPARTMENTS.map(d => (
                              <option key={d} value={d}>
                                {s.queues.departments[d]}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            data-testid={`queue-reassign-btn-${t.id}`}
                            className="x-button x-button-sm"
                            disabled={reassignMutation.isPending}
                            onClick={() => {
                              const expVer = item.state?.version ?? 1
                              reassignMutation.mutate({
                                ticketId: t.id,
                                expectedVersion: expVer,
                                department: currentSelectedDept,
                              })
                            }}
                            style={{ padding: '2px 8px', fontSize: 11 }}
                          >
                            {s.queues.reassignDept}
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------
// Tab 4: Embed & Snippet
// ---------------------------------------------------------
function EmbedTabPanel({
  tenantBase,
  tenantKey,
  tenant,
}: {
  tenantBase: string
  tenantKey: readonly unknown[]
  tenant: SupportTenant
}) {
  const s = useSupportServiceDeskStrings()
  const [copied, setCopied] = useState(false)

  const configQuery = useQuery({
    queryKey: [...tenantKey, 'widget-config'],
    queryFn: ({ signal }) =>
      apiFetch<{ ok: boolean; embedSnippet?: string }>(`${tenantBase}/widget-config`, { signal }),
  })

  const serverBase = typeof window !== 'undefined' ? window.location.origin : 'https://gateway.example.com'
  const computedSnippet =
    configQuery.data?.embedSnippet ||
    `<!-- FreeLLMAPI AI Support Embed Widget -->\n<script src="${serverBase}/thruline/v1/support/widget.js" async></script>\n<script>\n  window.addEventListener('load', function() {\n    FreeLLMAPISupport.init({\n      tenantKey: ${JSON.stringify(tenant.publicKey)},\n      serverBase: ${JSON.stringify(serverBase)},\n      loadTenantProfile: true\n    });\n  });\n</script>`

  function handleCopy() {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(computedSnippet)
      setCopied(true)
      setTimeout(() => setCopied(false), 2500)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div>
        <h3 style={{ margin: '0 0 6px 0', fontSize: 15, fontWeight: 600 }}>{s.embed.snippetHeading}</h3>
        <p className="x-hint" style={{ margin: '0 0 14px 0', fontSize: 13 }}>
          {s.embed.snippetHelp}
        </p>

        <div style={{ position: 'relative' }}>
          <pre
            data-testid="embed-snippet-code"
            style={{
              background: '#1e293b',
              color: '#f8fafc',
              padding: 16,
              borderRadius: 8,
              fontSize: 13,
              fontFamily: 'monospace',
              overflowX: 'auto',
              whiteSpace: 'pre',
            }}
          >
            {computedSnippet}
          </pre>

          <button
            type="button"
            data-testid="embed-copy-snippet-btn"
            className="x-button x-button-sm"
            onClick={handleCopy}
            style={{
              position: 'absolute',
              top: 10,
              right: 10,
              display: 'flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <Copy size={13} />
            <span>{copied ? s.copied : s.embed.copySnippetBtn}</span>
          </button>
        </div>
      </div>

      <div style={{ padding: 16, background: 'var(--x-alt)', border: '1px solid var(--x-border)', borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <h4 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>{s.embed.instructionsHeading}</h4>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--x-text)' }}>
          • {s.embed.instructionsGuest}
        </p>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--x-text)' }}>
          • {s.embed.instructionsCustomer}
        </p>
        <div style={{ padding: '8px 12px', background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 6, fontSize: 12, color: '#92400e' }}>
          <strong>{s.embed.securityNotice}</strong>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------
// Tenant Service Desk Container
// ---------------------------------------------------------
function TenantServiceDeskContent({
  tenant,
  revision,
}: {
  tenant: SupportTenant
  revision: number
}) {
  const s = useSupportServiceDeskStrings()
  const queryClient = useQueryClient()
  const [activeTab, setActiveTab] = useState<TabId>('widget')

  const tenantBase = `/api/thruline/support/tenants/${tenant.id}/service-desk`
  const tenantKey = useMemo(() => ['x-support-desk', revision, tenant.id] as const, [revision, tenant.id])

  const [liveMode, setLiveMode] = useState<SupportLiveTestViewMode>('design')
  const [sessionEpoch, setSessionEpoch] = useState(0)
  const [persona, setPersona] = useState<SupportLiveTestPersonaInput>(() => {
    const initialPreset = SUPPORT_LIVE_TEST_PERSONA_PRESETS[0]
    return {
      mode: initialPreset.mode,
      userId: initialPreset.userId,
      role: initialPreset.role,
      name: initialPreset.name,
      permissions: [...initialPreset.permissions],
    }
  })
  const [personaSessionCache, setPersonaSessionCache] = useState<
    Record<string, SupportLiveTestPersonaSessionResponse>
  >({})
  const [simulatedOrigin, setSimulatedOrigin] = useState('')
  const [enforceSimulatedOrigin, setEnforceSimulatedOrigin] = useState(false)
  const [originCheckResult, setOriginCheckResult] = useState<SupportLiveTestOriginCheckResponse | null>(null)
  const [diagnostics, setDiagnostics] = useState<SupportLiveTestTurnDiagnostic[]>([])
  const [activeLiveConvId, setActiveLiveConvId] = useState<string | null>(null)
  const [preferredCopilotConvId, setPreferredCopilotConvId] = useState<string | null>(null)
  const [copilotFocusSeq, setCopilotFocusSeq] = useState(0)

  const activePersonaSession =
    personaSessionCache[getLiveTestPersonaCacheKey(persona, sessionEpoch)] ?? null

  const handleApplyPersona = (
    nextPersona: SupportLiveTestPersonaInput,
    nextSession: SupportLiveTestPersonaSessionResponse,
  ) => {
    const identityChanged =
      getLiveTestPersonaCacheKey(nextPersona, 0) !== getLiveTestPersonaCacheKey(persona, 0)
    if (identityChanged) {
      setActiveLiveConvId(null)
      setDiagnostics([])
    }
    const cacheKey = getLiveTestPersonaCacheKey(nextPersona, sessionEpoch)
    setPersonaSessionCache(prev => ({ ...prev, [cacheKey]: nextSession }))
    setPersona(nextPersona)
  }

  const handleResetLiveConversation = () => {
    setSessionEpoch(prev => prev + 1)
    setDiagnostics([])
    setActiveLiveConvId(null)
  }

  const handleOpenInCopilot = (convId: string) => {
    setPreferredCopilotConvId(convId)
    setCopilotFocusSeq(n => n + 1)
    setActiveTab('copilot')
  }

  const handleRefreshTenantQueries = () => {
    void queryClient.invalidateQueries({ queryKey: tenantKey })
  }

  const liveTestProps: LiveTestStudioBridgeProps = {
    tenant,
    mode: liveMode,
    onModeChange: setLiveMode,
    persona,
    sessionEpoch,
    personaSession: activePersonaSession,
    onApplyPersona: handleApplyPersona,
    onResetConversation: handleResetLiveConversation,
    simulatedOrigin,
    onSimulatedOriginChange: setSimulatedOrigin,
    enforceSimulatedOrigin,
    onEnforceSimulatedOriginChange: setEnforceSimulatedOrigin,
    originCheckResult,
    onOriginCheckResult: setOriginCheckResult,
    diagnostics,
    onAppendDiagnostic: entry => setDiagnostics(prev => [entry, ...prev]),
    activeConversationId: activeLiveConvId,
    onConversationIdDetected: setActiveLiveConvId,
    onOpenInCopilot: handleOpenInCopilot,
    onRefreshTenantQueries: handleRefreshTenantQueries,
  }

  return (
    <div>
      <div className="x-tabs" role="tablist" style={{ marginBottom: 20 }}>
        {tabs.map(tab => {
          const Icon = tab.icon
          const isActive = activeTab === tab.id
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              data-testid={`tab-${tab.id}`}
              id={`tab-${tab.id}`}
              aria-selected={isActive}
              aria-controls={`panel-${tab.id}`}
              className={`x-tab ${isActive ? 'active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              <Icon size={16} />
              <span>{s.tabs[tab.id]}</span>
            </button>
          )
        })}
      </div>

      <div
        role="tabpanel"
        id={`panel-${activeTab}`}
        data-testid={`panel-${activeTab}`}
        aria-labelledby={`tab-${activeTab}`}
      >
        {activeTab === 'widget' && (
          <Panel title={s.widget.heading}>
            <WidgetTabPanel tenantBase={tenantBase} tenantKey={tenantKey} liveTestProps={liveTestProps} />
          </Panel>
        )}

        {activeTab === 'copilot' && (
          <Panel title={s.copilot.heading}>
            <CopilotTabPanel
              tenantBase={tenantBase}
              tenantKey={tenantKey}
              tenant={tenant}
              preferredConvId={preferredCopilotConvId}
              focusSeq={copilotFocusSeq}
            />
          </Panel>
        )}

        {activeTab === 'queues' && (
          <Panel title={s.queues.heading}>
            <QueuesTabPanel tenantBase={tenantBase} tenantKey={tenantKey} />
          </Panel>
        )}

        {activeTab === 'embed' && (
          <Panel title={s.embed.heading}>
            <EmbedTabPanel tenantBase={tenantBase} tenantKey={tenantKey} tenant={tenant} />
          </Panel>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------
// Main Support Service Desk Page
// ---------------------------------------------------------
export default function SupportServiceDesk() {
  const s = useSupportServiceDeskStrings()
  const revision = useSessionRevision()
  const session = useUserSession()

  const canEdit = session.hasPermission('use_x_gateway') && session.hasPermission('edit_x_settings')

  const tenantsQuery = useQuery({
    queryKey: ['x-support-desk-tenants', revision],
    queryFn: ({ signal }) =>
      apiFetch<{ ok: boolean; tenants: SupportTenant[] }>('/api/thruline/support/tenants', { signal }).then(
        r => r.tenants || []
      ),
    enabled: canEdit,
  })

  const [selectedTenantId, setSelectedTenantId] = useState<number | null>(null)

  const tenants = tenantsQuery.data || []
  const activeTenantId = selectedTenantId ?? (tenants.length > 0 ? tenants[0].id : null)
  const activeTenant = tenants.find(t => t.id === activeTenantId)

  return (
    <div className="x-console-page">
      <div className="x-page-header" style={{ marginBottom: 20 }}>
        <div>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Headphones size={24} style={{ color: 'var(--x-primary)' }} />
            <span>{s.title}</span>
          </h1>
          <p className="x-hint" style={{ marginTop: 4 }}>
            {s.subtitle}
          </p>
        </div>

        {canEdit && tenants.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <label htmlFor="support-desk-tenant-select" style={{ fontSize: 13, fontWeight: 500 }}>
              {s.tenant}:
            </label>
            <select
              id="support-desk-tenant-select"
              data-testid="support-desk-tenant"
              className="x-select"
              value={activeTenantId ?? ''}
              onChange={e => setSelectedTenantId(Number(e.target.value))}
              style={{ minWidth: 200 }}
            >
              {tenants.map(t => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.slug})
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {!canEdit && (
        <div className="x-alert x-alert-warning" role="alert" data-testid="support-desk-permission-denied">
          <ShieldCheck size={18} />
          <span>{s.permissionDenied}</span>
        </div>
      )}

      {canEdit && (
        <>
          {tenantsQuery.isPending && <div className="x-loading">{s.loading}</div>}

          {tenantsQuery.isError && (
            <div className="x-alert x-alert-error" role="alert">
              <XCircle size={18} />
              <span>{(tenantsQuery.error as Error).message}</span>
            </div>
          )}

          {!tenantsQuery.isPending && !tenantsQuery.isError && tenants.length === 0 && (
            <div className="x-empty" data-testid="support-desk-no-tenants">
              <AlertTriangle size={32} />
              <p>{s.noTenants}</p>
            </div>
          )}

          {activeTenant && (
            <TenantServiceDeskContent
              key={`${revision}-${activeTenant.id}`}
              tenant={activeTenant}
              revision={revision}
            />
          )}
        </>
      )}
    </div>
  )
}
