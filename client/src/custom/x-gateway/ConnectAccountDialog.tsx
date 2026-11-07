import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Copy, ExternalLink, LoaderCircle, ShieldCheck, X } from 'lucide-react'
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import type { AccountProvider, ProviderAccount, ProviderAccountAuthStartResponse } from '../../../../shared/x-accounts'
import { accountsApi, callbackAddress, refreshAccounts, trustedLoginUrl } from './api'
import { useXStrings } from './strings'
import { ProviderMark } from './pages/Providers'

const WEB_COOKIE_GUIDES: Record<string, {
  siteUrl: string
  tokenName: string
  placeholder: string
  storage: 'Cookies' | 'Local Storage'
}> = {
  'grok-web': {
    siteUrl: 'https://grok.com/',
    tokenName: 'sso',
    placeholder: 'sso=eyJ... (or paste the raw sso cookie value)',
    storage: 'Cookies',
  },
  'chatgpt-web': {
    siteUrl: 'https://chatgpt.com/',
    tokenName: '__Secure-next-auth.session-token',
    placeholder: '__Secure-next-auth.session-token=eyJ...',
    storage: 'Cookies',
  },
  'perplexity-web': {
    siteUrl: 'https://www.perplexity.ai/',
    tokenName: '__Secure-next-auth.session-token',
    placeholder: '__Secure-next-auth.session-token=eyJ...',
    storage: 'Cookies',
  },
  'gemini-web': {
    siteUrl: 'https://gemini.google.com/',
    tokenName: '__Secure-1PSID (and optional __Secure-1PSIDTS)',
    placeholder: '__Secure-1PSID=g.a000...; __Secure-1PSIDTS=sidts-...',
    storage: 'Cookies',
  },
  'deepseek-web': {
    siteUrl: 'https://chat.deepseek.com/sign_in',
    tokenName: 'userToken',
    placeholder: '{"value":"...","__version":"0"} or raw userToken string',
    storage: 'Local Storage',
  },
  'muse-web': {
    siteUrl: 'https://muse.ai/',
    tokenName: 'hatch_sess',
    placeholder: 'hatch_sess=...',
    storage: 'Cookies',
  },
  'uc-web': {
    siteUrl: 'https://uncensored.com/',
    tokenName: '__client; __client_uat',
    placeholder: '__client=...; __client_uat=...',
    storage: 'Cookies',
  },
}

const OAUTH_CLI_GUIDES: Record<string, {
  siteUrl: string
  steps: string
  placeholder: string
}> = {
  claude: {
    siteUrl: 'https://claude.ai/login',
    steps: 'Run `claude setup-token` in terminal (or open ~/.claude/.credentials.json) and paste the OAuth token / JSON.',
    placeholder: 'sk-ant-oat01-... or paste ~/.claude/.credentials.json',
  },
  codex: {
    siteUrl: 'https://chatgpt.com/auth/login',
    steps: 'Run `codex login` in terminal and paste `~/.codex/auth.json` (or your OpenAI access_token / API key).',
    placeholder: 'Paste ~/.codex/auth.json or eyJhbGci...',
  },
  antigravity: {
    siteUrl: 'https://idx.google.com/',
    steps: 'Sign in with Google in Antigravity IDE or gcloud (`gcloud auth print-access-token`) and paste the OAuth access token.',
    placeholder: 'ya29.a0... or oauth_creds.json',
  },
  'gemini-cli': {
    siteUrl: 'https://aistudio.google.com/apikey',
    steps: 'Run `gemini` CLI to sign in via browser and paste `~/.gemini/oauth_creds.json`, or paste a Gemini API key.',
    placeholder: 'Paste ~/.gemini/oauth_creds.json or AIzaSy...',
  },
  cursor: {
    siteUrl: 'https://www.cursor.com/settings',
    steps: 'Sign in on cursor.com or extract `cursorAuth/accessToken` from Cursor local state.vscdb.',
    placeholder: 'eyJhbGci... (Cursor accessToken)',
  },
  windsurf: {
    siteUrl: 'https://windsurf.com/account',
    steps: 'Sign in at windsurf.com and copy your Windsurf / Codeium auth token.',
    placeholder: 'Windsurf OAuth / API token',
  },
  qwen: {
    siteUrl: 'https://chat.qwen.ai/',
    steps: 'Run `qwen` CLI to sign in with Qwen OAuth and paste `~/.qwen/oauth_creds.json`, or DashScope API key.',
    placeholder: 'Paste ~/.qwen/oauth_creds.json or sk-...',
  },
  kiro: {
    siteUrl: 'https://kiro.dev/',
    steps: 'Sign in via Kiro IDE (AWS Builder ID / Social) and paste `~/.aws/sso/cache/kiro-auth-token.json`.',
    placeholder: 'Paste kiro-auth-token.json or accessToken',
  },
  cline: {
    siteUrl: 'https://app.cline.bot/',
    steps: 'Sign in at app.cline.bot and copy your Cline account token from settings.',
    placeholder: 'Cline OAuth / account token',
  },
  clinepass: {
    siteUrl: 'https://app.cline.bot/',
    steps: 'Sign in at app.cline.bot and copy your ClinePass token.',
    placeholder: 'ClinePass token',
  },
  kilocode: {
    siteUrl: 'https://kilocode.ai/',
    steps: 'Sign in at kilocode.ai and copy your KiloCode token from your profile.',
    placeholder: 'KiloCode OAuth / API token',
  },
  kimi: {
    siteUrl: 'https://platform.moonshot.ai/',
    steps: 'Sign in to Kimi Coding / Moonshot and copy your token or API key.',
    placeholder: 'sk-... (Kimi Coding token)',
  },
  trae: {
    siteUrl: 'https://www.trae.ai/',
    steps: 'Sign in via Trae IDE and copy your Trae session / OAuth token.',
    placeholder: 'Trae OAuth token',
  },
  zed: {
    siteUrl: 'https://zed.dev/account',
    steps: 'Sign in at zed.dev/account and copy your Zed Pro / LLM token.',
    placeholder: 'Zed auth token',
  },
  gitlab: {
    siteUrl: 'https://gitlab.com/-/user_settings/personal_access_tokens',
    steps: 'Sign in to GitLab and create a Personal Access Token or OAuth token with `ai_features` / `api` scope.',
    placeholder: 'glpat-... or OAuth access token',
  },
  'grok-cli': {
    siteUrl: 'https://console.x.ai/',
    steps: 'Sign in at console.x.ai or Grok CLI and copy your xAI / Grok token.',
    placeholder: 'xai-... or Grok CLI token',
  },
  iflow: {
    siteUrl: 'https://platform.iflow.cn/',
    steps: 'Sign in via iFlow CLI (`~/.iflow/oauth_creds.json`) or copy your iFlow API key.',
    placeholder: 'Paste ~/.iflow/oauth_creds.json or sk-...',
  },
  'codebuddy-intl': {
    siteUrl: 'https://www.codebuddy.ai/',
    steps: 'Sign in at codebuddy.ai and copy your CodeBuddy OAuth token.',
    placeholder: 'CodeBuddy OAuth token',
  },
  'codebuddy-cn': {
    siteUrl: 'https://copilot.tencent.com/',
    steps: 'Sign in to Tencent CodeBuddy and copy your OAuth token.',
    placeholder: 'CodeBuddy CN OAuth token',
  },
  qoder: {
    siteUrl: 'https://qoder.com/',
    steps: 'Sign in at qoder.com and copy your Qoder token.',
    placeholder: 'Qoder OAuth / API token',
  },
  'qoder-cn': {
    siteUrl: 'https://qoder.com/',
    steps: 'Sign in to Qoder CN and copy your Qoder token.',
    placeholder: 'Qoder CN token',
  },
  'minimax-code': {
    siteUrl: 'https://platform.minimaxi.com/',
    steps: 'Sign in to MiniMax Coding Plan and copy your Coding token / API key.',
    placeholder: 'eyJ... or MiniMax Coding key',
  },
  'minimax-code-global': {
    siteUrl: 'https://www.minimax.io/',
    steps: 'Sign in to MiniMax Global Coding Plan and copy your token / API key.',
    placeholder: 'eyJ... or MiniMax Global key',
  },
  glm: {
    siteUrl: 'https://open.bigmodel.cn/',
    steps: 'Sign in to Zhipu GLM Coding and copy your GLM Coding token / API key.',
    placeholder: 'GLM Coding token / API key',
  },
  'devin-cli': {
    siteUrl: 'https://app.devin.ai/',
    steps: 'Sign in to Devin and copy your Devin CLI / API token.',
    placeholder: 'Devin CLI token',
  },
  opencode: {
    siteUrl: 'https://opencode.ai/',
    steps: 'Run `opencode auth login` or copy your OpenCode Zen token.',
    placeholder: 'OpenCode token / API key',
  },
}

export function extractOAuthCredential(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>
      const claudeOauth = parsed.claudeAiOauth as Record<string, unknown> | undefined
      if (claudeOauth && typeof claudeOauth.accessToken === 'string' && claudeOauth.accessToken.trim()) {
        return claudeOauth.accessToken.trim()
      }
      const tokens = parsed.tokens as Record<string, unknown> | undefined
      if (tokens && typeof tokens.access_token === 'string' && tokens.access_token.trim()) {
        return tokens.access_token.trim()
      }
      for (const field of ['accessToken', 'access_token', 'token', 'api_key', 'apiKey', 'OPENAI_API_KEY', 'value']) {
        const val = parsed[field]
        if (typeof val === 'string' && val.trim()) {
          return val.trim()
        }
      }
    } catch {
      // Fall through and return raw trimmed string
    }
  }
  return trimmed
}

export function ConnectAccountDialog({ provider, account, onClose }: {
  provider: AccountProvider; account?: ProviderAccount; onClose: () => void
}) {
  const s = useXStrings()
  const client = useQueryClient()
  const loginMethod = provider.authMethods.find(method => method === 'oauth_pkce' || method === 'device_code')
  const [method, setMethod] = useState(loginMethod ?? provider.authMethods[0] ?? 'api_key')
  const [label, setLabel] = useState(account?.label ?? '')
  const [key, setKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl ?? '')
  const [proxyUrl, setProxyUrl] = useState('')
  const [attempt, setAttempt] = useState<ProviderAccountAuthStartResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [manual, setManual] = useState('')
  const [copied, setCopied] = useState(false)
  const active = useRef(true)
  const attemptId = useRef<string | null>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
      if (attemptId.current) void accountsApi.cancel(attemptId.current).catch(() => {})
    }
  }, [])

  const connected = () => {
    attemptId.current = null
    void refreshAccounts(client)
    closeRef.current()
  }

  useEffect(() => {
    if (!attempt) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const expire = setTimeout(() => {
      stopped = true
      if (timer) clearTimeout(timer)
      setError(s.expired)
    }, Math.max(0, attempt.expiresAt - Date.now()))
    const finish = () => {
      if (stopped) return
      attemptId.current = null
      void refreshAccounts(client)
      closeRef.current()
    }
    if (attempt.flow === 'device_code') {
      const poll = async () => {
        try {
          const result = await accountsApi.poll(attempt.attemptId)
          if (stopped) return
          if (result.status === 'connected') finish()
          else timer = setTimeout(poll, Math.max(1, result.interval) * 1000)
        } catch (cause) {
          if (!stopped) setError(cause instanceof Error ? cause.message : s.callbackError)
        }
      }
      timer = setTimeout(poll, Math.max(1, attempt.interval) * 1000)
    }
    const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('x-provider-connections') : null
    if (channel) channel.onmessage = event => {
      if (event.data?.attemptId === attempt.attemptId && event.data?.status === 'connected') finish()
    }
    return () => {
      stopped = true
      clearTimeout(expire)
      if (timer) clearTimeout(timer)
      channel?.close()
    }
  }, [attempt, client, s.expired, s.callbackError])

  const isDirectCredential = method === 'api_key' || method === 'cookie'
  const isCookieMethod = method === 'cookie'
  const cookieGuide = isCookieMethod ? WEB_COOKIE_GUIDES[provider.id] : undefined
  const oauthCliGuide = !isCookieMethod && isDirectCredential ? OAUTH_CLI_GUIDES[provider.id] : undefined

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    if (!label.trim() || (isDirectCredential && !key.trim()) || (provider.id === 'custom' && !baseUrl.trim())) { setError(s.required); return }
    setError('')
    setBusy(true)
    try {
      if (isDirectCredential) {
        const finalKey = oauthCliGuide ? extractOAuthCredential(key) : key.trim()
        await accountsApi.addKey(
          provider.id,
          finalKey,
          label.trim(),
          provider.id === 'custom' ? baseUrl.trim() : undefined,
          proxyUrl.trim() || undefined,
          isCookieMethod ? 'cookie' : undefined,
        )
        setKey('')
        if (active.current) connected()
      } else {
        const result = await accountsApi.start(provider.id, { label: label.trim(), callbackUrl: callbackAddress(), ...(account ? { reconnectId: account.id } : {}) })
        if (!active.current) { void accountsApi.cancel(result.attemptId).catch(() => {}); return }
        const url = result.flow === 'oauth_pkce' ? result.authorizationUrl : result.verificationUri
        if (!trustedLoginUrl(url, provider.id)) {
          void accountsApi.cancel(result.attemptId).catch(() => {})
          throw new Error(s.callbackError)
        }
        attemptId.current = result.attemptId
        setAttempt(result)
      }
    } catch (cause) {
      if (active.current) setError(cause instanceof Error ? cause.message : s.callbackError)
    } finally { if (active.current) setBusy(false) }
  }

  async function completeManual(event: FormEvent) {
    event.preventDefault()
    if (!attempt || busy) return
    setError('')
    let code: string
    try {
      const url = new URL(manual)
      const expected = new URL(callbackAddress())
      if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.searchParams.get('attemptId') !== attempt.attemptId || !url.searchParams.get('code')) throw new Error()
      code = url.searchParams.get('code')!
    } catch { setError(s.invalidCallback); return }
    setBusy(true)
    try {
      await accountsApi.complete(attempt.attemptId, code)
      setManual('')
      connected()
    } catch (cause) { setError(cause instanceof Error ? cause.message : s.callbackError) }
    finally { if (active.current) setBusy(false) }
  }

  return <Dialog open onOpenChange={open => { if (!open) onClose() }}>
    <DialogPopup className="x-console x-dialog">
      <button className="x-icon-button x-dialog-close" aria-label={s.close} onClick={onClose}><X size={18} /></button>
      <div className="x-dialog-icon"><ProviderMark id={provider.id} name={provider.name} /></div>
      <DialogTitle className="x-dialog-title">{account ? s.reconnect : s.addAccount} · {provider.name}</DialogTitle>
      <DialogDescription className="x-muted">{isCookieMethod ? s.cookieDialogHelp : oauthCliGuide ? s.oauthCliDialogHelp : s.oauthHelp}</DialogDescription>
      {provider.id === 'github-copilot' && <p className="x-notice">{s.copilotNotice}</p>}
      {cookieGuide && (
        <div className="x-notice" style={{ display: 'grid', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <span><strong>{s.cookieGuideLabel}:</strong> <code>{cookieGuide.storage} → {cookieGuide.tokenName}</code></span>
            <a className="x-button x-small" href={cookieGuide.siteUrl} target="_blank" rel="noopener noreferrer">
              {s.openProviderSite}<ExternalLink size={13} />
            </a>
          </div>
        </div>
      )}
      {oauthCliGuide && (
        <div className="x-notice" style={{ display: 'grid', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <span><strong>{s.oauthCliGuideLabel}:</strong> {oauthCliGuide.steps}</span>
            <a className="x-button x-small" href={oauthCliGuide.siteUrl} target="_blank" rel="noopener noreferrer">
              {s.openProviderSite}<ExternalLink size={13} />
            </a>
          </div>
        </div>
      )}
      {error && <div className="x-error" role="alert">{error}</div>}
      {!attempt ? <form onSubmit={submit} className="x-form">
        {!account && provider.authMethods.length > 1 && <fieldset className="x-methods"><legend>{s.method}</legend>
          {provider.authMethods.map(value => <label key={value} className={method === value ? 'selected' : ''}>
            <input type="radio" name="connection-method" value={value} checked={method === value} onChange={() => { setMethod(value); setError('') }} />
            {value === 'api_key' ? s.apiKey : value === 'cookie' ? s.cookie : value === 'device_code' ? s.device : s.oauth}
          </label>)}
        </fieldset>}
        <label>{s.name}<input id="x-account-label" name="label" autoFocus maxLength={100} value={label} placeholder={s.namePlaceholder} onChange={event => setLabel(event.target.value)} disabled={busy} required /></label>
        {provider.id === 'custom' && <label>{s.baseUrl}<input id="x-account-base-url" name="baseUrl" type="url" value={baseUrl} placeholder="https://api.example.com/v1" onChange={event => setBaseUrl(event.target.value)} disabled={busy} required /></label>}
        {isDirectCredential && (
          isCookieMethod || oauthCliGuide ? (
            <label>
              {isCookieMethod ? s.cookieCredential : s.oauthCliCredential}
              <textarea
                id="x-account-credential"
                name="credential"
                rows={3}
                value={key}
                onChange={event => setKey(event.target.value)}
                placeholder={isCookieMethod ? (cookieGuide?.placeholder ?? s.cookieCredentialPlaceholder) : (oauthCliGuide?.placeholder ?? s.oauthCliPlaceholder)}
                disabled={busy}
                required
                style={{ fontFamily: 'var(--x-mono)', fontSize: '0.84rem', resize: 'vertical' }}
              />
            </label>
          ) : (
            <label>{s.credential}<input id="x-account-credential" name="credential" type="password" autoComplete="new-password" value={key} onChange={event => setKey(event.target.value)} placeholder={s.credentialPlaceholder} disabled={busy} required /></label>
          )
        )}
        {isDirectCredential && <label>{s.accountProxy}<input id="x-account-proxy" name="proxyUrl" value={proxyUrl} onChange={event => setProxyUrl(event.target.value)} placeholder={s.accountProxyPlaceholder} disabled={busy} /></label>}
        <p className="x-security"><ShieldCheck size={16} />{s.encrypted}</p>
        <div className="x-dialog-actions"><button type="button" className="x-button" onClick={onClose}>{s.cancel}</button><button className="x-button x-primary" disabled={busy}>{busy && <LoaderCircle size={16} className="x-spin" />}{busy ? s.connecting : isDirectCredential ? s.addAccount : s.signIn}</button></div>
      </form> : <div className="x-auth-wait">
        <h3>{s.waiting}</h3><p className="x-muted">{attempt.flow === 'device_code' ? s.deviceHelp : s.browserHelp}</p>
        {attempt.flow === 'device_code' && <div className="x-device-code"><code>{attempt.userCode}</code><button className="x-icon-button" aria-label={copied ? s.copied : s.copy} onClick={async () => {
          try { await navigator.clipboard.writeText(attempt.userCode); setCopied(true) } catch { setError(s.copyError) }
        }}><Copy size={17} /></button></div>}
        <a className="x-button x-primary" target="_blank" rel="noopener noreferrer" href={trustedLoginUrl(attempt.flow === 'oauth_pkce' ? attempt.authorizationUrl : attempt.verificationUri, provider.id) ?? undefined}>{s.openLogin}<ExternalLink size={15} /></a>
        <p className="x-caption">{s.expires} {new Date(attempt.expiresAt).toLocaleTimeString()}</p>
        {attempt.flow === 'oauth_pkce' && <form className="x-form" onSubmit={completeManual}><label>{s.manualCallback}<input id="x-account-callback" name="callback" type="url" value={manual} autoComplete="off" onChange={event => setManual(event.target.value)} placeholder={s.callbackPlaceholder} /></label><button className="x-button" disabled={busy || !manual.trim()}>{busy ? s.connecting : s.complete}</button></form>}
        <button className="x-button x-full" onClick={onClose}>{s.cancel}</button>
      </div>}
    </DialogPopup>
  </Dialog>
}
