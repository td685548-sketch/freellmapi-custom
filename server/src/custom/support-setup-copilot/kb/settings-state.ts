/**
 * Live values of the 9 system settings the Copilot can propose, read-only and
 * filtered to the settings the caller is permitted to see. This gives answers
 * like "is the response cache on?" a real value instead of a guess.
 */
import { SYSTEM_SETTING_IDS, type SupportSystemSettingId } from '@freellmapi/shared/support-setup-copilot.js';
import { getSetting } from '../../../db/index.js';
import { hasPermission } from '../../../middleware/requirePermission.js';
import { isMcpServerEnabled } from '../../../routes/mcp.js';
import { getOllamaEmulationMode } from '../../../routes/ollama.js';
import { isAutoUpdateCheckEnabled } from '../../../routes/update.js';
import type { SessionUser } from '../../../services/auth.js';
import { isCacheEnabled } from '../../../services/cache.js';
import { getCompressionConfig } from '../../../services/compression/config.js';
import { isUnifyEnabled, UNIFY_ENABLED_KEY } from '../../../services/model-groups.js';
import { getFlags } from '../../ai-platform/flags.js';
import { getConfigSnapshot } from '../../x-gateway/config.js';
import { REQUIRED_PERMISSION_BY_SETTING } from '../system-settings.js';

function readUnify(): boolean {
  try {
    const stored = getSetting(UNIFY_ENABLED_KEY);
    if (stored !== undefined && stored.trim() !== '') {
      const v = stored.trim().toLowerCase();
      return v !== '0' && v !== 'false' && v !== 'off';
    }
  } catch {
    // fall through to the service accessor
  }
  return isUnifyEnabled();
}

function readValue(id: SupportSystemSettingId): unknown {
  switch (id) {
    case 'thruline_gateway_enabled': return { enabled: getConfigSnapshot().enabled };
    case 'thruline_token_savers': return getConfigSnapshot().savers;
    case 'thruline_route_health_ttl': return { minutes: getConfigSnapshot().routeHealthTtlMinutes };
    case 'response_cache': return { enabled: isCacheEnabled() };
    case 'prompt_compression': return { mode: getCompressionConfig().mode };
    case 'model_unification': return { enabled: readUnify() };
    case 'mcp_server': return { enabled: isMcpServerEnabled() };
    case 'auto_update_check': return { enabled: isAutoUpdateCheckEnabled() };
    case 'ollama_emulation': return { mode: getOllamaEmulationMode() };
    case 'ai_platform_pillars': return getFlags();
  }
}

export interface SystemSettingsSnapshot {
  readable: Array<{ settingId: SupportSystemSettingId; value: unknown }>;
  hidden: SupportSystemSettingId[];
}

export function readSystemSettingsSnapshot(user: SessionUser | undefined): SystemSettingsSnapshot {
  const readable: SystemSettingsSnapshot['readable'] = [];
  const hidden: SupportSystemSettingId[] = [];
  for (const id of SYSTEM_SETTING_IDS) {
    if (!hasPermission(user, REQUIRED_PERMISSION_BY_SETTING[id])) {
      hidden.push(id);
      continue;
    }
    try {
      readable.push({ settingId: id, value: readValue(id) });
    } catch {
      readable.push({ settingId: id, value: 'unavailable' });
    }
  }
  return { readable, hidden };
}
