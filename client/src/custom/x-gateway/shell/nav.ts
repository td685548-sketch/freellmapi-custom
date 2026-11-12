import type { LucideIcon } from 'lucide-react'
import { ArrowLeftRight, BarChart3, Film, Gauge, Headset, Home, KeyRound, Layers, LifeBuoy, MessageSquare, Network, Scissors, ScrollText, Server, ShieldCheck, Sparkles, Terminal } from 'lucide-react'
import { useUserSession } from '../../use-session'
import { useXStrings } from '../strings'
import { useMgmtStrings } from '../management-strings'
import { usePoolStrings } from '../proxy-pool-strings'
import { useMediaStrings } from '../media-strings'
import { useToolsStrings } from '../tools-strings'
import { useTranslatorStrings } from '../translator-strings'
import { useSkillsStrings } from '../skills-strings'
import { useSupportStrings } from '../support-strings'
import { useSupportEnterpriseStrings } from '../support-enterprise-strings'
import { useSupportGovernanceStrings } from '../support-governance-strings'
import { useSupportIntegrationStrings } from '../support-integration-strings'
import { useShellStrings } from '../shell-strings'

export interface NavItem { to: string; label: string; icon: LucideIcon }
export interface NavGroup { id: string; label: string; items: NavItem[] }

/** Sidebar navigation, grouped by what the person is trying to do. */
export function useNavGroups(): NavGroup[] {
  const s = useXStrings()
  const m = useMgmtStrings()
  const p = usePoolStrings()
  const med = useMediaStrings()
  const t = useToolsStrings()
  const tr = useTranslatorStrings()
  const sk = useSkillsStrings()
  const sup = useSupportStrings()
  const ops = useSupportEnterpriseStrings()
  const gov = useSupportGovernanceStrings()
  const integration = useSupportIntegrationStrings()
  const sh = useShellStrings()
  const session = useUserSession()
  const canView = session.hasPermission('view_keys')
  const canUsage = session.hasPermission('view_x_usage')
  const groups: NavGroup[] = [
    { id: 'start', label: sh.groupStart, items: [
      { to: '/x/home', label: sh.overview, icon: Home },
      { to: '/x/endpoint', label: s.endpoint, icon: KeyRound },
      { to: '/x/playground', label: m.playground, icon: MessageSquare },
    ] },
    { id: 'sources', label: sh.groupSources, items: [
      ...(canView ? [{ to: '/x/providers', label: s.providers, icon: Server }] : []),
      ...(canView ? [{ to: '/x/media', label: med.mediaTitle, icon: Film }] : []),
      { to: '/x/proxies', label: p.proxies, icon: Network },
    ] },
    { id: 'routing', label: sh.groupRouting, items: [
      ...(canView ? [{ to: '/x/combos', label: m.combos, icon: Layers }] : []),
      { to: '/x/savers', label: s.savers, icon: Scissors },
      { to: '/x/translator', label: tr.translatorNav, icon: ArrowLeftRight },
    ] },
    { id: 'tools', label: sh.groupTools, items: [
      { to: '/x/tools', label: t.cliToolsNav, icon: Terminal },
      { to: '/x/skills', label: sk.skillsNav, icon: Sparkles },
    ] },
    { id: 'support', label: sh.groupSupport, items: [
      { to: '/x/support-integration', label: integration.nav, icon: Sparkles },
      { to: '/x/support', label: sup.supportNav, icon: Headset },
      { to: '/x/support-ops', label: ops.nav, icon: LifeBuoy },
      { to: '/x/support-guardrails', label: gov.nav, icon: ShieldCheck },
    ] },
    { id: 'monitor', label: sh.groupMonitor, items: [
      ...(canUsage ? [{ to: '/x/quota', label: 'Quota', icon: Gauge }] : []),
      ...(canView ? [{ to: '/x/usage', label: s.usage, icon: BarChart3 }, { to: '/x/logs', label: m.logs, icon: ScrollText }] : []),
    ] },
  ]
  return groups.filter(group => group.items.length > 0)
}

/** The nav entry a pathname belongs to. `/x/support` must not swallow `/x/support-ops`. */
export function matchNav(groups: NavGroup[], pathname: string) {
  for (const group of groups) {
    const item = group.items.find(entry => pathname === entry.to || pathname.startsWith(`${entry.to}/`))
    if (item) return { group, item }
  }
  return null
}
