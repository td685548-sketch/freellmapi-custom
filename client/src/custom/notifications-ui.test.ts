import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))
const appSource = readFileSync(path.join(here, '../App.tsx'), 'utf8')
const xGatewaySource = readFileSync(path.join(here, './x-gateway/XGatewayApp.tsx'), 'utf8')
const settingsSource = readFileSync(path.join(here, '../components/settings-dialog.tsx'), 'utf8')
const usageAlertsSource = readFileSync(path.join(here, './UsageAlertsCard.tsx'), 'utf8')
const viSource = readFileSync(path.join(here, './i18n/vi.ts'), 'utf8')

describe('NotificationBell & TelegramBotSettingsCard integration', () => {
  it('mounts NotificationBell in both main Navbar and Thruline header', () => {
    expect(appSource).toContain('<NotificationBell />')
    expect(xGatewaySource).toContain('<NotificationBell variant="thruline" />')
  })

  it('mounts TelegramBotSettingsCard in SettingsDialog and UsageAlertsCard with Vietnamese translations', () => {
    expect(settingsSource).toContain('<TelegramBotSettingsCard />')
    expect(usageAlertsSource).toContain('<TelegramBotSettingsCard />')
    expect(viSource).toContain('"Telegram Ops Bot & 1-Tap Approval":')
    expect(viSource).toContain('"Notifications":')
  })
})
