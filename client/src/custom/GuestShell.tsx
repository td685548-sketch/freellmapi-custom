import { useEffect, useState } from 'react'
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { LogIn, UserPlus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { GuestPermission } from '../../../shared/guest-access'
import { GuestModelsPage } from './GuestModelsPage'
import { UsageRankingPage } from './UsageRankingPage'
import { GUEST_PROMPT_DELAY_MS, GUEST_PROMPT_EVENT, GUEST_PROMPT_SEEN_KEY } from './guest-prompt'
import { useCustomT } from './i18n/use-custom-t'

// What a signed-out visitor gets when an administrator opened some read-only views to guests: those
// pages only, a header with "Sign in" / "Request access", and a popup that asks them to sign in five
// seconds after they arrive (once per tab) and whenever they try to use something.

function SignInPrompt({ onSignIn, onRequest, onClose }: { onSignIn: () => void; onRequest: () => void; onClose: () => void }) {
  const tc = useCustomT()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="guest-prompt-title" className="relative w-full max-w-sm space-y-4 rounded-2xl border bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <button type="button" onClick={onClose} aria-label="Close" className="absolute right-3 top-3 text-muted-foreground hover:text-foreground"><X className="size-4" /></button>
        <div className="space-y-1.5">
          <h2 id="guest-prompt-title" className="text-base font-semibold">{tc('Want to use these models?')}</h2>
          <p className="text-sm text-muted-foreground">{tc('You are browsing as a guest and can only look around. To chat, get an API key or change anything, sign in, or ask an administrator for access.')}</p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button className="flex-1" onClick={onSignIn}><LogIn className="size-4 mr-1.5" />{tc('Sign in')}</Button>
          <Button variant="outline" className="flex-1" onClick={onRequest}><UserPlus className="size-4 mr-1.5" />{tc('Request access')}</Button>
        </div>
        <button type="button" onClick={onClose} className="w-full text-center text-xs text-muted-foreground underline-offset-2 hover:underline">{tc('Keep browsing')}</button>
      </div>
    </div>
  )
}

/** Shown in a route a guest may not open (an admin page linked from a shared component): ask, then go back. */
function AskAndReturn({ to }: { to: string }) {
  useEffect(() => { window.dispatchEvent(new Event(GUEST_PROMPT_EVENT)) }, [])
  return <Navigate to={to} replace />
}

export function GuestShell({ permissions, onSignIn, onRequest }: { permissions: GuestPermission[]; onSignIn: () => void; onRequest: () => void }) {
  const tc = useCustomT()
  const [prompt, setPrompt] = useState(false)
  const location = useLocation()

  useEffect(() => {
    const open = () => setPrompt(true)
    window.addEventListener(GUEST_PROMPT_EVENT, open)
    let seen = false
    try { seen = sessionStorage.getItem(GUEST_PROMPT_SEEN_KEY) === '1' } catch { /* private mode: show it */ }
    const timer = seen ? undefined : window.setTimeout(() => {
      setPrompt(true)
      try { sessionStorage.setItem(GUEST_PROMPT_SEEN_KEY, '1') } catch { /* ignore */ }
    }, GUEST_PROMPT_DELAY_MS)
    return () => { window.removeEventListener(GUEST_PROMPT_EVENT, open); if (timer) window.clearTimeout(timer) }
  }, [])

  const pages = [
    ...(permissions.includes('view_models') ? [{ to: '/models/chat', label: 'Models' }] : []),
    ...(permissions.includes('view_usage_profiles') || permissions.includes('view_usage_accounts') ? [{ to: '/usage', label: 'Usage' }] : []),
  ]
  const home = pages[0]?.to ?? '/models/chat'

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4">
          <span className="font-semibold">{tc('FreeLLMAPI')}</span>
          <span className="rounded-full border px-2 py-0.5 text-[10px] text-muted-foreground">{tc('Guest')}</span>
          <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" aria-label="Guest pages">
            {pages.map(p => (
              <NavLink key={p.to} to={p.to} className={({ isActive }) => `rounded-lg px-3 py-1.5 text-sm ${isActive || location.pathname.startsWith(p.to) ? 'bg-muted font-medium' : 'text-muted-foreground hover:text-foreground'}`}>
                {tc(p.label)}
              </NavLink>
            ))}
          </nav>
          <Button variant="ghost" size="sm" className="hidden sm:inline-flex" onClick={onRequest}>{tc('Request access')}</Button>
          <Button size="sm" onClick={onSignIn}><LogIn className="size-3.5 mr-1" />{tc('Sign in')}</Button>
        </div>
      </header>
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">
        <Routes>
          {permissions.includes('view_models') && <Route path="/models/chat" element={<GuestModelsPage />} />}
          {permissions.includes('view_models') && <Route path="/models/*" element={<AskAndReturn to="/models/chat" />} />}
          {pages.some(p => p.to === '/usage') && <Route path="/usage" element={<UsageRankingPage />} />}
          <Route path="*" element={<Navigate to={home} replace />} />
        </Routes>
      </main>
      {prompt && (
        <SignInPrompt
          onClose={() => setPrompt(false)}
          onSignIn={() => { setPrompt(false); onSignIn() }}
          onRequest={() => { setPrompt(false); onRequest() }}
        />
      )}
    </div>
  )
}
