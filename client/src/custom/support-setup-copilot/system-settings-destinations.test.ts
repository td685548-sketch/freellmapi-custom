import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SYSTEM_SETTING_IDS } from '../../../../shared/support-setup-copilot';
import { destinationsForSettings, SYSTEM_SETTING_DESTINATIONS } from './system-settings-destinations';

const src = (rel: string) => readFileSync(resolve(__dirname, '../../', rel), 'utf8');

describe('system setting destinations', () => {
  it('maps every system setting the Copilot can change', () => {
    for (const id of SYSTEM_SETTING_IDS) expect(SYSTEM_SETTING_DESTINATIONS[id], id).toBeDefined();
    expect(Object.keys(SYSTEM_SETTING_DESTINATIONS).sort()).toEqual([...SYSTEM_SETTING_IDS].sort());
  });

  it('never points at /settings (not a route; Settings is a dialog)', () => {
    for (const d of Object.values(SYSTEM_SETTING_DESTINATIONS)) {
      if (d.kind === 'route') expect(d.path).not.toBe('/settings');
    }
  });

  it('every route destination exists in the app (drift guard)', () => {
    const app = src('App.tsx');
    const gateway = src('custom/x-gateway/XGatewayApp.tsx');
    const platform = src('custom/ai-platform/AiPlatformApp.tsx');
    for (const d of Object.values(SYSTEM_SETTING_DESTINATIONS)) {
      if (d.kind !== 'route') continue;
      const [, top, sub] = d.path.split('/');
      if (top === 'thruline') expect(gateway, d.path).toContain(`path="${sub}"`);
      else if (top === 'ai-platform') {
        expect(app, d.path).toContain('path="/ai-platform/*"');
        expect(platform, d.path).toContain(`path="${sub}"`);
      } else if (top === 'models') expect(app, d.path).toContain(`path="${d.path}"`);
      else expect(app, d.path).toContain(`path="${d.path}"`);
    }
  });

  it('collapses to one button per distinct place, in applied order', () => {
    const ds = destinationsForSettings(['response_cache', 'prompt_compression', 'mcp_server', 'ollama_emulation', 'thruline_token_savers']);
    expect(ds.map((d) => (d.kind === 'route' ? d.path : d.kind))).toEqual(['settings-dialog', '/keys', '/thruline/savers']);
    expect(destinationsForSettings([])).toEqual([]);
  });
});
