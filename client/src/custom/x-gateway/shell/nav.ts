import type { LucideIcon } from 'lucide-react'
import { ArrowLeftRight, BarChart3, BookOpen, Film, Gauge, Headphones, Headset, Home, KeyRound, Layers, LifeBuoy, MessageSquare, Network, Scissors, ScrollText, Server, ShieldCheck, Sparkles, Terminal } from 'lucide-react'
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
import { useSupportEvidenceStrings } from '../support-evidence-strings'
import { useSupportServiceDeskStrings } from '../support-service-desk-strings'
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
  const evidence = useSupportEvidenceStrings()
  const desk = useSupportServiceDeskStrings()
  const sh = useShellStrings()
  const session = useUserSession()
  const canView = session.hasPermission('view_keys')
  const canUsage = session.hasPermission('view_x_usage')
  const groups: NavGroup[] = [
    { id: 'start', label: sh.groupStart, items: [
      { to: '/thruline/home', label: sh.overview, icon: Home },
      { to: '/thruline/endpoint', label: s.endpoint, icon: KeyRound },
      { to: '/thruline/playground', label: m.playground, icon: MessageSquare },
    ] },
    { id: 'sources', label: sh.groupSources, items: [
      ...(canView ? [{ to: '/thruline/providers', label: s.providers, icon: Server }] : []),
      ...(canView ? [{ to: '/thruline/media', label: med.mediaTitle, icon: Film }] : []),
      { to: '/thruline/proxies', label: p.proxies, icon: Network },
    ] },
    { id: 'routing', label: sh.groupRouting, items: [
      ...(canView ? [{ to: '/thruline/combos', label: m.combos, icon: Layers }] : []),
      { to: '/thruline/savers', label: s.savers, icon: Scissors },
      { to: '/thruline/translator', label: tr.translatorNav, icon: ArrowLeftRight },
    ] },
    { id: 'tools', label: sh.groupTools, items: [
      { to: '/thruline/tools', label: t.cliToolsNav, icon: Terminal },
      { to: '/thruline/skills', label: sk.skillsNav, icon: Sparkles },
    ] },
    { id: 'support', label: sh.groupSupport, items: [
      { to: '/thruline/support-integration', label: integration.nav, icon: Sparkles },
      { to: '/thruline/support-desk', label: desk.nav, icon: Headphones },
      { to: '/thruline/support', label: sup.supportNav, icon: Headset },
      { to: '/thruline/support-knowledge', label: evidence.nav, icon: BookOpen },
      { to: '/thruline/support-ops', label: ops.nav, icon: LifeBuoy },
      { to: '/thruline/support-guardrails', label: gov.nav, icon: ShieldCheck },
    ] },
    { id: 'monitor', label: sh.groupMonitor, items: [
      ...(canUsage ? [{ to: '/thruline/quota', label: 'Quota', icon: Gauge }] : []),
      ...(canView ? [{ to: '/thruline/usage', label: s.usage, icon: BarChart3 }, { to: '/thruline/logs', label: m.logs, icon: ScrollText }] : []),
    ] },
  ]
  return groups.filter(group => group.items.length > 0)
}

/** The nav entry a pathname belongs to. `/thruline/support` must not swallow `/thruline/support-ops`. */
export function matchNav(groups: NavGroup[], pathname: string) {
  for (const group of groups) {
    const item = group.items.find(entry => pathname === entry.to || pathname.startsWith(`${entry.to}/`))
    if (item) return { group, item }
  }
  return null
}
