import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))
const appSource = readFileSync(path.join(here, '../App.tsx'), 'utf8')
const gettingStartedSource = readFileSync(path.join(here, '../components/getting-started.tsx'), 'utf8')
const updateReminderSource = readFileSync(path.join(here, '../components/update-reminder.tsx'), 'utf8')
const playgroundSource = readFileSync(path.join(here, '../pages/PlaygroundPage.tsx'), 'utf8')
const paletteSource = readFileSync(path.join(here, '../components/command-palette.tsx'), 'utf8')
const agentsSource = readFileSync(path.join(here, '../pages/AgentsPage.tsx'), 'utf8')
const viSource = readFileSync(path.join(here, './i18n/vi.ts'), 'utf8')

describe('member UX & zero-403 permission guards', () => {
  it('keeps /keys and Settings accessible to regular members in App.tsx', () => {
    expect(appSource).not.toContain("if (i.to === '/keys' && isMember && !canManageKeys) return false")
    expect(appSource).toContain('<DropdownMenuItem onClick={onOpenSettings}>')
    expect(appSource).toContain("if (status === 401 || status === 403) return false")
  })

  it('routes custom navbar labels through tc() for Vietnamese localization', () => {
    expect(appSource).toContain("tc('Invites')")
    expect(appSource).toContain("tc('Users')")
    expect(appSource).toContain("tc('Usage')")
    expect(appSource).toContain("tc('History')")
    expect(viSource).toContain('"New Member Starter Quota":')
  })

  it('gates admin-only background queries behind permissions to prevent 403 storms', () => {
    expect(gettingStartedSource).toContain("hasPermission('view_keys')")
    expect(gettingStartedSource).toContain("hasPermission('reveal_gateway_key')")
    expect(updateReminderSource).toContain("hasPermission('view_settings') || hasPermission('manage_updates')")
    expect(playgroundSource).toContain("enabled: hasPermission('reveal_gateway_key')")
    expect(paletteSource).toContain('enabled: open && canRevealGateway')
    expect(agentsSource).toContain("enabled: hasPermission('view_analytics')")
  })
})
