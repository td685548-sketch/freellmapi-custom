import { useEffect, useState, type ReactNode } from 'react'
import { Link, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { ArrowLeft, ChevronRight, Lock, Menu, Moon, PanelLeftClose, PanelLeftOpen, Search, ShieldCheck, Sun, X } from 'lucide-react'
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
import Quota from './pages/Quota'
import TokenSavers from './pages/TokenSavers'
import Combos from './pages/Combos'
import ConsoleLog from './pages/ConsoleLog'
import ProxyPool from './pages/ProxyPool'
import MediaProviders from './pages/MediaProviders'
import CLITools from './pages/CLIOperations'
import TranslatorInspector from './pages/TranslatorInspector'
import Playground from './pages/Playground'
import SkillsHub from './pages/SkillsHub'
import SupportGateway from './pages/SupportGateway'
import SupportEnterprise from './pages/SupportEnterprise'
import SupportGovernance from './pages/SupportGovernance'
import ModelAvailabilityBadge from './components/ModelAvailabilityBadge'
import { ThrulineLogo } from './ThrulineLogo'
import { useShellStrings } from './shell-strings'
import { matchNav, useNavGroups } from './shell/nav'
import { QuickJump } from './shell/QuickJump'
import Overview from './pages/Overview'
import './transition/install'
import './x-gateway.css'
import './x-theme.css'

const RAIL_KEY = 'x-gateway.sidebar-collapsed'
function readRail() {
  try { return window.localStorage.getItem(RAIL_KEY) === '1' } catch { return false }
}

function XGatewayShell() {
  const s = useXStrings()
  const sh = useShellStrings()
  const groups = useNavGroups()
  const session = useUserSession()
  const { locale, setLocale } = useI18n()
  const { resolvedDark, setTheme } = useTheme()
  const location = useLocation()
  const [menuOpen, setMenuOpen] = useState(false)
  const [rail, setRail] = useState(readRail)
  const [jumpOpen, setJumpOpen] = useState(false)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setJumpOpen(open => !open) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  if (session.isPending) return <div className="x-console"><AccountLoadState /></div>
  if (session.isError) return <div className="x-console"><AccountLoadState error retry={() => void session.refetch()} /></div>
  if (!session.hasPermission('use_x_gateway')) return <NotFoundPage />
  const canView = session.hasPermission('view_keys')
  const protectedPage = (page: ReactNode) => canView ? page : <div className="x-empty" role="alert"><ShieldCheck size={32} /><p>{s.permission}</p></div>
  const toggleRail = () => setRail(value => {
    try { window.localStorage.setItem(RAIL_KEY, value ? '0' : '1') } catch { /* preference is optional */ }
    return !value
  })
  // Provider detail pages live under /x/providers/:id and stay under that entry.
  const current = matchNav(groups, location.pathname)
  const isPlayground = location.pathname.startsWith('/x/playground')
  const shortcut = /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘K' : 'Ctrl K'
  return <div className={`x-console x-layout ${rail ? 'x-layout-rail' : ''}`}>
    {menuOpen && <button className="x-nav-scrim" aria-label={s.close} onClick={() => setMenuOpen(false)} />}
    <aside className={`x-sidebar ${menuOpen ? 'x-sidebar-open' : ''}`}>
      <div className="x-sidebar-top">
        <Link to="/x/home" className="x-brand" onClick={() => setMenuOpen(false)}><ThrulineLogo size={28} /><span className="x-brand-text">Thruline<small>FreeLLMAPI</small></span></Link>
        <button className="x-icon-button x-rail-toggle" aria-label={rail ? sh.expand : sh.collapse} title={rail ? sh.expand : sh.collapse} aria-pressed={rail} onClick={toggleRail}>{rail ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}</button>
        <button className="x-icon-button x-mobile-close" aria-label={s.close} onClick={() => setMenuOpen(false)}><X size={20} /></button>
      </div>
      <nav aria-label="Thruline">{groups.map(group => <div className="x-nav-group" key={group.id} role="group" aria-labelledby={`x-nav-${group.id}`}>
        <div className="x-nav-heading" id={`x-nav-${group.id}`}>{group.label}</div>
        {group.items.map(item => <NavLink key={item.to} to={item.to} end={item.to === '/x/support'} title={rail ? item.label : undefined} onClick={() => setMenuOpen(false)} className={({ isActive }) => `x-nav-item ${isActive ? 'active' : ''}`}><item.icon size={17} /><span>{item.label}</span></NavLink>)}
      </div>)}</nav>
      <div className="x-sidebar-bottom">
        <div className="x-sidebar-note" title={s.encrypted}><Lock size={14} /><span>{s.encrypted}</span></div>
        <Link to="/models/chat" className="x-nav-item x-back-link-nav" title={rail ? s.back : undefined}><ArrowLeft size={16} /><span>{s.back}</span></Link>
      </div>
    </aside>
    <div className={`x-main ${isPlayground ? 'x-main-playground' : ''}`}><header className="x-header"><button className="x-icon-button x-mobile-menu" aria-label={s.menu} onClick={() => setMenuOpen(true)}><Menu size={21} /></button><div className="x-breadcrumb">{current && <><span>{current.group.label}</span><ChevronRight size={14} /></>}<strong>{current?.item.label ?? 'Thruline'}</strong></div><div className="x-header-actions"><button type="button" className="x-jump-trigger" onClick={() => setJumpOpen(true)} aria-label={sh.jump}><Search size={15} /><span>{sh.jump}</span><kbd>{shortcut}</kbd></button>{canView && <ModelAvailabilityBadge />}<label className="x-language"><span className="x-sr-only">{s.language}</span><select value={locale === 'vi' ? 'vi' : 'en'} onChange={event => setLocale(event.target.value as 'vi' | 'en')}><option value="en">English</option><option value="vi">Tiếng Việt</option></select></label><button className="x-icon-button" aria-label={s.theme} onClick={() => setTheme(resolvedDark ? 'light' : 'dark')}>{resolvedDark ? <Sun size={18} /> : <Moon size={18} />}</button><span className="x-avatar" title={session.session?.email}>{session.session?.email?.slice(0, 1).toUpperCase() ?? 'X'}</span></div></header>
      <main className={`x-content ${isPlayground ? 'x-content-playground' : ''}`}><ErrorBoundary><Routes>
        <Route index element={<Navigate to="/x/home" replace />} />
        <Route path="home" element={<Overview />} />
        <Route path="providers" element={protectedPage(<Providers />)} />
        <Route path="providers/:providerId" element={protectedPage(<ProviderAccounts />)} />
        <Route path="accounts/callback" element={<AccountCallback />} />
        <Route path="endpoint" element={<Endpoint />} />
        <Route path="playground" element={<Playground />} />
        <Route path="support" element={<SupportGateway />} />
        <Route path="support-ops" element={<SupportEnterprise />} />
        <Route path="support-guardrails" element={<SupportGovernance />} />
        <Route path="tools" element={<CLITools />} />
        <Route path="skills" element={<SkillsHub />} />
        <Route path="translator" element={<TranslatorInspector />} />
        <Route path="savers" element={<TokenSavers />} />
        <Route path="media" element={protectedPage(<MediaProviders />)} />
        <Route path="proxies" element={<ProxyPool />} />
        <Route path="combos" element={protectedPage(<Combos />)} />
        <Route path="logs" element={protectedPage(<ConsoleLog />)} />
        <Route path="usage" element={protectedPage(<AccountUsage />)} />
        <Route path="quota" element={<Quota />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes></ErrorBoundary></main>
    </div><QuickJump groups={groups} open={jumpOpen} onClose={() => setJumpOpen(false)} /><Toaster />
  </div>
}

export default function XGatewayApp() {
  const revision = useSessionRevision()
  return <Routes><Route path="/x/*" element={<XGatewayShell key={revision} />} /></Routes>
}
