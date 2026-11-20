import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Info, Settings as SettingsIcon } from 'lucide-react'
import { useI18n } from '@/i18n'
import { useCustomT } from '@/custom/i18n/use-custom-t'
import { useUserSession } from '../../use-session'
import { useSessionRevision } from '../../session-state'
import { settingsApi, type SsoAuthMode, type XRoutingDefaults } from '../settings-api'
import { useSettingsStrings } from '../settings-strings'
import { SmartRoutingV2Panel } from '../components/SmartRoutingV2Panel'

const validLimit = (value: string) => /^\d{1,3}$/.test(value) && Number(value) >= 1 && Number(value) <= 100

function RoutingSection() {
  const s = useSettingsStrings()
  const client = useQueryClient()
  const revision = useSessionRevision()
  const canEdit = useUserSession().hasPermission('edit_x_settings')
  const query = useQuery({ queryKey: ['x-routing-defaults', revision], queryFn: ({ signal }) => settingsApi.routingDefaults(signal), retry: false })
  const [draft, setDraft] = useState<Partial<{ [K in keyof XRoutingDefaults]: XRoutingDefaults[K] extends number ? string : XRoutingDefaults[K] }>>({})
  const current = query.data
  const value = {
    accountStrategy: draft.accountStrategy ?? current?.accountStrategy ?? 'fallback',
    accountStickyLimit: draft.accountStickyLimit ?? String(current?.accountStickyLimit ?? 3),
    comboRoundRobin: draft.comboRoundRobin ?? current?.comboRoundRobin ?? false,
    comboStickyLimit: draft.comboStickyLimit ?? String(current?.comboStickyLimit ?? 1),
  }
  const accountLimitOk = validLimit(value.accountStickyLimit)
  const comboLimitOk = validLimit(value.comboStickyLimit)
  const dirty = Object.keys(draft).length > 0
  const save = useMutation({
    meta: { silenceToast: true },
    mutationFn: () => settingsApi.saveRoutingDefaults({
      accountStrategy: value.accountStrategy,
      accountStickyLimit: Number(value.accountStickyLimit),
      comboRoundRobin: value.comboRoundRobin,
      comboStickyLimit: Number(value.comboStickyLimit),
    }),
    onSuccess: async () => { setDraft({}); await client.invalidateQueries({ queryKey: ['x-routing-defaults'] }) },
  })
  const rr = value.accountStrategy === 'round-robin'

  return <section className="x-panel x-endpoint-panel" aria-labelledby="x-set-routing">
    <h2 id="x-set-routing">{s.routing}</h2>
    <p className="x-caption">{s.routingHelp}</p>
    {query.isError && <div className="x-error" role="alert">{s.loadError}<button type="button" className="x-button" onClick={() => void query.refetch()}>{s.retry}</button></div>}
    {!canEdit && !query.isError && <p className="x-caption">{s.readOnly}</p>}
    {query.data && <form className="x-mgmt-form" onSubmit={e => { e.preventDefault(); if (accountLimitOk && comboLimitOk) save.mutate() }}>
      <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <input type="checkbox" checked={rr} disabled={!canEdit} onChange={e => setDraft(d => ({ ...d, accountStrategy: e.target.checked ? 'round-robin' : 'fallback' }))} />
        <span><strong>{s.roundRobin}</strong><br /><small className="x-caption">{s.roundRobinHelp}</small></span>
      </label>
      {rr && <label>{s.stickyLimit}
        <input inputMode="numeric" value={value.accountStickyLimit} disabled={!canEdit} aria-invalid={!accountLimitOk} onChange={e => setDraft(d => ({ ...d, accountStickyLimit: e.target.value }))} />
        <small className="x-caption">{accountLimitOk ? s.stickyLimitHelp : s.limitRange}</small>
      </label>}
      <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <input type="checkbox" checked={value.comboRoundRobin} disabled={!canEdit} onChange={e => setDraft(d => ({ ...d, comboRoundRobin: e.target.checked }))} />
        <span><strong>{s.comboRoundRobin}</strong><br /><small className="x-caption">{s.comboRoundRobinHelp}</small></span>
      </label>
      <label>{s.comboStickyLimit}
        <input inputMode="numeric" value={value.comboStickyLimit} disabled={!canEdit} aria-invalid={!comboLimitOk} onChange={e => setDraft(d => ({ ...d, comboStickyLimit: e.target.value }))} />
        <small className="x-caption">{comboLimitOk ? s.comboStickyLimitHelp : s.limitRange}</small>
      </label>
      {canEdit && <div><button type="submit" className="x-button x-primary" disabled={!dirty || !accountLimitOk || !comboLimitOk || save.isPending}>{s.save}</button></div>}
      {save.isSuccess && !dirty && <p className="x-test-ok" role="status">{s.saved}</p>}
      {save.isError && <p className="x-error" role="alert">{s.saveError}</p>}
    </form>}
  </section>
}

function LanguageSection() {
  const s = useSettingsStrings()
  const { locale, setLocale } = useI18n()
  return <section className="x-panel x-endpoint-panel" aria-labelledby="x-set-language">
    <h2 id="x-set-language">{s.language}</h2>
    <p className="x-caption">{s.languageHelp}</p>
    <select aria-label={s.language} value={locale === 'vi' ? 'vi' : 'en'} onChange={e => setLocale(e.target.value as 'vi' | 'en')}>
      <option value="en">English</option>
      <option value="vi">Tiếng Việt</option>
    </select>
  </section>
}

function AccountSection() {
  const s = useSettingsStrings()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [attempted, setAttempted] = useState(false)
  const change = useMutation({
    meta: { silenceToast: true },
    mutationFn: () => settingsApi.changePassword(current, next),
    onSuccess: () => { setCurrent(''); setNext(''); setConfirm(''); setAttempted(false) },
  })
  const shortError = next.length < 8
  const mismatch = next !== confirm
  const invalid = !current || shortError || mismatch
  return <section className="x-panel x-endpoint-panel" aria-labelledby="x-set-account">
    <h2 id="x-set-account">{s.account}</h2>
    <p className="x-caption">{s.accountHelp}</p>
    <form className="x-mgmt-form" onSubmit={e => { e.preventDefault(); setAttempted(true); if (!invalid) change.mutate() }}>
      <label>{s.currentPassword}<input type="password" autoComplete="current-password" value={current} onChange={e => setCurrent(e.target.value)} /></label>
      <label>{s.newPassword}<input type="password" autoComplete="new-password" value={next} onChange={e => setNext(e.target.value)} aria-invalid={attempted && shortError} />
        {attempted && shortError && <small className="x-error" role="alert">{s.passwordShort}</small>}</label>
      <label>{s.confirmPassword}<input type="password" autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} aria-invalid={attempted && mismatch} />
        {attempted && !shortError && mismatch && <small className="x-error" role="alert">{s.passwordMismatch}</small>}</label>
      <div><button type="submit" className="x-button x-primary" disabled={change.isPending}>{s.changePassword}</button></div>
      {change.isSuccess && <p className="x-test-ok" role="status">{s.passwordChanged}</p>}
      {change.isError && <p className="x-error" role="alert">{(change.error as Error).message}</p>}
    </form>
  </section>
}

function SsoSection() {
  const s = useSettingsStrings()
  const client = useQueryClient()
  const revision = useSessionRevision()
  const session = useUserSession()
  const canEdit = Boolean(session.session?.isPrimary)
  const query = useQuery({ queryKey: ['x-sso-config', revision], queryFn: ({ signal }) => settingsApi.ssoConfig(signal), retry: false })
  const current = query.data
  const validMode = (m: unknown): SsoAuthMode => (m === 'oidc' || m === 'saml' || m === 'both' ? m : 'local')

  const [draft, setDraft] = useState<{
    authMode?: SsoAuthMode
    publicBaseUrl?: string
    autoProvisionMembers?: boolean
    oidcIssuerUrl?: string
    oidcClientId?: string
    oidcClientSecret?: string
    oidcScopes?: string
    oidcLoginLabel?: string
    samlEntryPoint?: string
    samlIssuer?: string
    samlCert?: string
    samlLoginLabel?: string
  }>({})

  const authMode = draft.authMode ?? validMode(current?.authMode)
  const showOidc = authMode === 'oidc' || authMode === 'both'
  const showSaml = authMode === 'saml' || authMode === 'both'
  const dirty = Object.keys(draft).length > 0

  const save = useMutation({
    meta: { silenceToast: true },
    mutationFn: () => settingsApi.saveSsoConfig({
      authMode,
      ...(draft.publicBaseUrl !== undefined ? { publicBaseUrl: draft.publicBaseUrl } : {}),
      ...(draft.autoProvisionMembers !== undefined ? { autoProvisionMembers: draft.autoProvisionMembers } : {}),
      ...(draft.oidcIssuerUrl !== undefined ? { oidcIssuerUrl: draft.oidcIssuerUrl } : {}),
      ...(draft.oidcClientId !== undefined ? { oidcClientId: draft.oidcClientId } : {}),
      ...(draft.oidcClientSecret?.trim() ? { oidcClientSecret: draft.oidcClientSecret } : {}),
      ...(draft.oidcScopes !== undefined ? { oidcScopes: draft.oidcScopes } : {}),
      ...(draft.oidcLoginLabel !== undefined ? { oidcLoginLabel: draft.oidcLoginLabel } : {}),
      ...(draft.samlEntryPoint !== undefined ? { samlEntryPoint: draft.samlEntryPoint } : {}),
      ...(draft.samlIssuer !== undefined ? { samlIssuer: draft.samlIssuer } : {}),
      ...(draft.samlCert !== undefined ? { samlCert: draft.samlCert } : {}),
      ...(draft.samlLoginLabel !== undefined ? { samlLoginLabel: draft.samlLoginLabel } : {}),
    }),
    onSuccess: async () => { setDraft({}); await client.invalidateQueries({ queryKey: ['x-sso-config'] }) },
  })

  return <section className="x-panel x-endpoint-panel" aria-labelledby="x-set-sso">
    <h2 id="x-set-sso">{s.sso}</h2>
    <p className="x-caption">{s.ssoHelp}</p>
    {query.data && <form className="x-mgmt-form" onSubmit={e => { e.preventDefault(); save.mutate() }}>
      <label>{s.ssoAuthMode}
        <select aria-label={s.ssoAuthMode} value={authMode} disabled={!canEdit} onChange={e => setDraft(d => ({ ...d, authMode: validMode(e.target.value) }))}>
          <option value="local">{s.ssoModeLocal}</option>
          <option value="oidc">{s.ssoModeOidc}</option>
          <option value="saml">{s.ssoModeSaml}</option>
          <option value="both">{s.ssoModeBoth}</option>
        </select>
      </label>
      {authMode !== 'local' && <>
        <label>{s.ssoPublicUrl}
          <input value={draft.publicBaseUrl ?? current?.publicBaseUrl ?? ''} disabled={!canEdit} placeholder="https://your-app.onrender.com" onChange={e => setDraft(d => ({ ...d, publicBaseUrl: e.target.value }))} />
        </label>
        <label style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <input type="checkbox" checked={draft.autoProvisionMembers ?? current?.autoProvisionMembers ?? true} disabled={!canEdit} onChange={e => setDraft(d => ({ ...d, autoProvisionMembers: e.target.checked }))} />
          <span>{s.ssoAutoProvision}</span>
        </label>
      </>}
      {showOidc && <>
        <label>{s.ssoOidcIssuer}<input value={draft.oidcIssuerUrl ?? current?.oidcIssuerUrl ?? ''} disabled={!canEdit} placeholder="https://accounts.google.com" onChange={e => setDraft(d => ({ ...d, oidcIssuerUrl: e.target.value }))} /></label>
        <label>{s.ssoOidcClientId}<input value={draft.oidcClientId ?? current?.oidcClientId ?? ''} disabled={!canEdit} onChange={e => setDraft(d => ({ ...d, oidcClientId: e.target.value }))} /></label>
        <label>{s.ssoOidcClientSecret}
          <input type="password" value={draft.oidcClientSecret ?? ''} disabled={!canEdit} placeholder={current?.oidcClientSecretConfigured ? '••••••••' : ''} onChange={e => setDraft(d => ({ ...d, oidcClientSecret: e.target.value }))} />
          {current?.oidcClientSecretConfigured && <small className="x-caption">{s.ssoSecretSet}</small>}
        </label>
        <label>{s.ssoOidcScopes}<input value={draft.oidcScopes ?? current?.oidcScopes ?? 'openid profile email'} disabled={!canEdit} onChange={e => setDraft(d => ({ ...d, oidcScopes: e.target.value }))} /></label>
        <label>{s.ssoOidcLabel}<input value={draft.oidcLoginLabel ?? current?.oidcLoginLabel ?? 'Sign in with OIDC'} disabled={!canEdit} onChange={e => setDraft(d => ({ ...d, oidcLoginLabel: e.target.value }))} /></label>
      </>}
      {showSaml && <>
        <label>{s.ssoSamlEntryPoint}<input value={draft.samlEntryPoint ?? current?.samlEntryPoint ?? ''} disabled={!canEdit} placeholder="https://idp.example.com/sso/saml" onChange={e => setDraft(d => ({ ...d, samlEntryPoint: e.target.value }))} /></label>
        <label>{s.ssoSamlIssuer}<input value={draft.samlIssuer ?? current?.samlIssuer ?? 'urn:freellmapi:sp'} disabled={!canEdit} onChange={e => setDraft(d => ({ ...d, samlIssuer: e.target.value }))} /></label>
        <label>{s.ssoSamlCert}<textarea rows={4} value={draft.samlCert ?? current?.samlCert ?? ''} disabled={!canEdit} placeholder="-----BEGIN CERTIFICATE-----" onChange={e => setDraft(d => ({ ...d, samlCert: e.target.value }))} /></label>
        <label>{s.ssoSamlLabel}<input value={draft.samlLoginLabel ?? current?.samlLoginLabel ?? 'Sign in with SAML SSO'} disabled={!canEdit} onChange={e => setDraft(d => ({ ...d, samlLoginLabel: e.target.value }))} /></label>
      </>}
      {canEdit && <div><button type="submit" className="x-button x-primary" disabled={!dirty || save.isPending}>{s.ssoSave}</button></div>}
      {save.isSuccess && !dirty && <p className="x-test-ok" role="status">{s.ssoSaved}</p>}
      {save.isError && <p className="x-error" role="alert">{s.saveError}</p>}
    </form>}
  </section>
}

function AboutSection() {
  const tc = useCustomT()
  return (
    <section className="x-panel x-endpoint-panel" aria-labelledby="x-set-about">
      <h2 id="x-set-about">{tc('About FreeLLMAPI')}</h2>
      <p className="x-caption">{tc('View deployment links, source repository, and version details.')}</p>
      <div>
        <Link to="/thruline/about" className="x-button">
          <Info size={16} />
          <span>{tc('Open About page')}</span>
        </Link>
      </div>
    </section>
  )
}

export default function Settings() {
  const s = useSettingsStrings()
  return <>
    <div className="x-page-heading"><div><h1>{s.title}</h1><p>{s.help}</p></div><span className="x-heading-icon"><SettingsIcon size={28} /></span></div>
    <RoutingSection />
    <SmartRoutingV2Panel />
    <LanguageSection />
    <AccountSection />
    <SsoSection />
    <AboutSection />
  </>
}
