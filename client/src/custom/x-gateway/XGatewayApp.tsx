import { useState, type ReactNode } from 'react'
import { Link, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { ArrowLeft, BarChart3, ChevronRight, KeyRound, Menu, Moon, Scissors, Server, ShieldCheck, Sun, X } from 'lucide-react'
import { useI18n } from '@/i18n'
import { useTheme } from '@/theme-context'
import { Toaster } from '@/components/toaster'
import { ErrorBoundary } from '@/components/error-boundary'
import NotFoundPage from '@/pages/NotFoundPage'
import { useUserSession } from '../use-session'
import { useSessionRevision } from '../session-state'
import { useXStrings } from './strings'
import { AccountCallback } from './AccountCallback'
import Providers, { AccountLoadState } from './pages/Providers'
import ProviderAccounts from './pages/ProviderAccounts'
import Endpoint from './pages/Endpoint'
import AccountUsage from './pages/AccountUsage'
import TokenSavers from './pages/TokenSavers'
import './x-gateway.css'

function XGatewayShell() {
  const s = useXStrings()
  const session = useUserSession()
  const { locale, setLocale } = useI18n()
  const { resolvedDark, setTheme } = useTheme()
  const location = useLocation()
  const [menuOpen, setMenuOpen] = useState(false)
  if (session.isPending) return <div className="x-console"><AccountLoadState /></div>
  if (!session.hasPermission('use_x_gateway')) return <NotFoundPage />
  const canView = session.hasPermission('view_keys')
  const protectedPage = (page: ReactNode) => canView ? page : <div className="x-empty" role="alert"><ShieldCheck size={32} /><p>{s.permission}</p></div>
  const items = [
    { to: '/x/endpoint', label: s.endpoint, icon: KeyRound },
    ...(canView ? [{ to: '/x/providers', label: s.providers, icon: Server }] : []),
    { to: '/x/savers', label: s.savers, icon: Scissors },
    ...(canView ? [{ to: '/x/usage', label: s.usage, icon: BarChart3 }] : []),
  ]
  const current = items.find(item => location.pathname.startsWith(item.to))?.label ?? s.workspace
  return <div className="x-console x-layout">
    {menuOpen && <button className="x-nav-scrim" aria-label={s.close} onClick={() => setMenuOpen(false)} />}
    <aside className={`x-sidebar ${menuOpen ? 'x-sidebar-open' : ''}`}>
      <Link to={canView ? '/x/providers' : '/x/endpoint'} className="x-brand" onClick={() => setMenuOpen(false)}><span className="x-brand-mark">X</span><span>X Gateway<small>FreeLLMAPI</small></span></Link>
      <button className="x-icon-button x-mobile-close" aria-label={s.close} onClick={() => setMenuOpen(false)}><X size={20} /></button>
      <div className="x-nav-heading">{s.workspace}</div>
      <nav aria-label="X Gateway">{items.map(item => <NavLink key={item.to} to={item.to} onClick={() => setMenuOpen(false)} className={({ isActive }) => `x-nav-item ${isActive ? 'active' : ''}`}><item.icon size={19} />{item.label}</NavLink>)}</nav>
      <div className="x-sidebar-bottom"><div className="x-sidebar-note"><ShieldCheck size={19} /><p>{s.encrypted}</p></div><Link to="/models/chat" className="x-nav-item"><ArrowLeft size={17} />{s.back}</Link></div>
    </aside>
    <div className="x-main"><header className="x-header"><button className="x-icon-button x-mobile-menu" aria-label={s.menu} onClick={() => setMenuOpen(true)}><Menu size={21} /></button><div className="x-breadcrumb"><span>{s.workspace}</span><ChevronRight size={14} /><strong>{current}</strong></div><div className="x-header-actions"><label className="x-language"><span className="x-sr-only">{s.language}</span><select value={locale === 'vi' ? 'vi' : 'en'} onChange={event => setLocale(event.target.value as 'vi' | 'en')}><option value="en">English</option><option value="vi">Tiếng Việt</option></select></label><button className="x-icon-button" aria-label={s.theme} onClick={() => setTheme(resolvedDark ? 'light' : 'dark')}>{resolvedDark ? <Sun size={18} /> : <Moon size={18} />}</button><span className="x-avatar" title={session.session?.email}>{session.session?.email?.slice(0, 1).toUpperCase() ?? 'X'}</span></div></header>
      <main className="x-content"><ErrorBoundary><Routes>
        <Route index element={<Navigate to={canView ? '/x/providers' : '/x/endpoint'} replace />} />
        <Route path="providers" element={protectedPage(<Providers />)} />
        <Route path="providers/:providerId" element={protectedPage(<ProviderAccounts />)} />
        <Route path="accounts/callback" element={<AccountCallback />} />
        <Route path="endpoint" element={<Endpoint />} />
        <Route path="savers" element={<TokenSavers />} />
        <Route path="usage" element={protectedPage(<AccountUsage />)} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes></ErrorBoundary></main>
    </div><Toaster />
  </div>
}

export default function XGatewayApp() {
  const revision = useSessionRevision()
  return <Routes><Route path="/x/*" element={<XGatewayShell key={revision} />} /></Routes>
}
