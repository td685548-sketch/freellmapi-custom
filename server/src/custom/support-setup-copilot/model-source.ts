/**
 * Which model source the Setup Copilot calls: Thruline's own provider accounts, FreeLLMAPI's main
 * gateway, or both (Thruline first, then FreeLLMAPI — the behaviour before this setting existed).
 * Stored as one system setting; changing it needs `edit_settings`.
 */
import {
  COPILOT_MODEL_SOURCES,
  type CopilotModelSource,
} from '@freellmapi/shared/support-setup-copilot.js';
import { getSetting, setSetting } from '../../db/index.js';

const SETTING_KEY = 'custom_copilot_model_source';

export function isCopilotModelSource(value: unknown): value is CopilotModelSource {
  return typeof value === 'string' && (COPILOT_MODEL_SOURCES as readonly string[]).includes(value);
}

/** Current choice; anything missing or unreadable means `both` so existing setups behave as before. */
export function getCopilotModelSource(): CopilotModelSource {
  try {
    const value = getSetting(SETTING_KEY);
    return isCopilotModelSource(value) ? value : 'both';
  } catch {
    return 'both';
  }
}

export function setCopilotModelSource(source: CopilotModelSource): void {
  setSetting(SETTING_KEY, source);
}
