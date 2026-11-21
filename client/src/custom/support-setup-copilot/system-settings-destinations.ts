/**
 * Where each system setting the Copilot can change actually lives in the UI.
 *
 * Settings and Updates are dialogs (no `/settings` route exists), so a destination is
 * either a dialog opened by window event or a real route. A test checks every setting
 * is mapped and every route exists in the app, so this cannot drift silently.
 */
import { SYSTEM_SETTING_IDS, type SupportSystemSettingId } from '@freellmapi/shared/support-setup-copilot.js'

export type SystemSettingDestination =
  | { kind: 'settings-dialog'; labelVi: string; labelEn: string }
  | { kind: 'updates-dialog'; labelVi: string; labelEn: string }
  | { kind: 'route'; path: string; labelVi: string; labelEn: string }

const SETTINGS_DIALOG: SystemSettingDestination = { kind: 'settings-dialog', labelVi: 'Mở Cài đặt', labelEn: 'Open Settings' }

export const SYSTEM_SETTING_DESTINATIONS: Readonly<Record<SupportSystemSettingId, SystemSettingDestination>> = {
  response_cache: SETTINGS_DIALOG,
  prompt_compression: SETTINGS_DIALOG,
  auto_update_check: { kind: 'updates-dialog', labelVi: 'Mở Cập nhật', labelEn: 'Open Updates' },
  thruline_gateway_enabled: { kind: 'route', path: '/thruline/endpoint', labelVi: 'Mở Endpoint', labelEn: 'Open Endpoint' },
  thruline_token_savers: { kind: 'route', path: '/thruline/savers', labelVi: 'Mở Token Savers', labelEn: 'Open Token Savers' },
  thruline_route_health_ttl: { kind: 'route', path: '/thruline/combos', labelVi: 'Mở Combos', labelEn: 'Open Combos' },
  ai_platform_pillars: { kind: 'route', path: '/ai-platform/overview', labelVi: 'Mở AI Platform', labelEn: 'Open AI Platform' },
  mcp_server: { kind: 'route', path: '/keys', labelVi: 'Mở Keys', labelEn: 'Open Keys' },
  ollama_emulation: { kind: 'route', path: '/keys', labelVi: 'Mở Keys', labelEn: 'Open Keys' },
  model_unification: { kind: 'route', path: '/models/chat', labelVi: 'Mở Models', labelEn: 'Open Models' },
}

const KEY = (d: SystemSettingDestination): string => (d.kind === 'route' ? `route:${d.path}` : d.kind)

/** One destination per distinct place, in the order the settings were applied. */
export function destinationsForSettings(settingIds: readonly SupportSystemSettingId[]): SystemSettingDestination[] {
  const seen = new Set<string>()
  const out: SystemSettingDestination[] = []
  for (const id of settingIds) {
    const d = SYSTEM_SETTING_DESTINATIONS[id]
    if (!d || seen.has(KEY(d))) continue
    seen.add(KEY(d))
    out.push(d)
  }
  return out
}

export const ALL_SYSTEM_SETTING_IDS = SYSTEM_SETTING_IDS
