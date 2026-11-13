import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
// Standalone downloadable Node script: tests use temporary homes only.
import { applySetup, restoreSetup } from '../../../../client/src/custom/x-gateway/local-setup.mjs';

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true }); });
const homeFixture = () => { const home = fs.mkdtempSync(path.join(os.tmpdir(), 'x-gateway-setup-')); homes.push(home); return home; };
const options = { baseUrl: 'https://gateway.example/thruline/v1', key: 'sk-xgw-fixture', model: 'combo:coding' };

describe('local setup preservation and restore', () => {
  it.each(['claude', 'codex', 'gemini', 'opencode', 'cursor'])('sets up %s locally and restores all changed files', tool => {
    const home = homeFixture();
    const files: Record<string, string> = {
      '.claude/settings.json': '{"permissions":{"allow":["Read"]},"env":{"KEEP":"yes"}}\n',
      '.gemini/settings.json': '{"ui":{"theme":"dark"},"security":{"auth":{"selectedType":"oauth-personal"}}}\n',
      '.config/opencode/opencode.json': '{"providers":{"existing":{"name":"Keep"}},"model":"existing/model"}\n',
      '.codex/config.toml': '# preserve comment\nmodel = "existing"\n[projects."/my/project"]\ntrust_level = "trusted"\n',
      '.codex/auth.json': '{"existing":"untouched"}',
    };
    for (const [name, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(home, name)), { recursive: true });
      fs.writeFileSync(path.join(home, name), content);
    }
    const result = applySetup({ ...options, home, tool });
    expect(fs.existsSync(result.launcher)).toBe(true);
    expect(fs.readFileSync(path.join(home, '.codex/config.toml'), 'utf8')).toBe(files['.codex/config.toml']);
    expect(fs.readFileSync(path.join(home, '.codex/auth.json'), 'utf8')).toBe(files['.codex/auth.json']);
    if (tool === 'claude') {
      const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude/settings.json'), 'utf8'));
      expect(settings).toMatchObject({ permissions: { allow: ['Read'] }, env: { KEEP: 'yes', ANTHROPIC_MODEL: options.model, ANTHROPIC_BASE_URL: 'https://gateway.example/thruline' } });
    }
    if (tool === 'opencode') {
      expect(JSON.parse(fs.readFileSync(path.join(home, '.config/opencode/opencode.json'), 'utf8'))).toMatchObject({ providers: { existing: { name: 'Keep' }, x_gateway: { settings: { baseURL: options.baseUrl } } } });
    }
    restoreSetup(result.backup);
    for (const [name, content] of Object.entries(files)) expect(fs.readFileSync(path.join(home, name), 'utf8')).toBe(content);
    expect(fs.existsSync(result.launcher)).toBe(false);
  });
  it('backs up an existing generated launcher and restores it byte-for-byte', () => {
    const home = homeFixture();
    const first = applySetup({ ...options, home, tool: 'codex' });
    const content = fs.readFileSync(first.launcher, 'utf8');
    const second = applySetup({ ...options, model: 'other', home, tool: 'codex' });
    expect(fs.readFileSync(second.launcher, 'utf8')).not.toBe(content);
    restoreSetup(second.backup);
    expect(fs.readFileSync(first.launcher, 'utf8')).toBe(content);
    if (process.platform !== 'win32') expect(fs.statSync(first.launcher).mode & 0o777).toBe(0o700);
  });
  it.skipIf(process.platform === 'win32')('runs the Linux launcher with literal arguments and private permissions', () => {
    const home = homeFixture();
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o700 });
    const model = `model/$(touch ${path.join(home, 'injected')})'quoted`;
    const result = applySetup({ ...options, model, home, tool: 'codex' });
    const output = execFileSync(result.launcher, [], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    expect(output).toContain(`model=${JSON.stringify(model)}`);
    expect(output).toContain('wire_api="responses"');
    expect(fs.existsSync(path.join(home, 'injected'))).toBe(false);
    expect(fs.statSync(result.launcher).mode & 0o777).toBe(0o700);
  });
  it('preserves OpenCode v1 schema and other providers', () => {
    const home = homeFixture();
    fs.mkdirSync(path.join(home, '.config/opencode'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config/opencode/opencode.json'), '{"provider":{"keep":{"npm":"keep"}}}');
    applySetup({ ...options, home, tool: 'opencode' });
    const config = JSON.parse(fs.readFileSync(path.join(home, '.config/opencode/opencode.json'), 'utf8'));
    expect(config.provider.keep.npm).toBe('keep');
    expect(config.provider.x_gateway.npm).toBe('@ai-sdk/openai-compatible');
    expect(config.providers).toBeUndefined();
  });
  it('refuses invalid existing JSON before changing any file', () => {
    const home = homeFixture();
    fs.mkdirSync(path.join(home, '.claude'));
    fs.writeFileSync(path.join(home, '.claude/settings.json'), '{bad');
    expect(() => applySetup({ ...options, home, tool: 'claude' })).toThrow();
    expect(fs.readFileSync(path.join(home, '.claude/settings.json'), 'utf8')).toBe('{bad');
    expect(fs.existsSync(path.join(home, '.x-gateway'))).toBe(false);
  });
  it('refuses to shadow an existing OpenCode JSONC configuration', () => {
    const home = homeFixture();
    fs.mkdirSync(path.join(home, '.config/opencode'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config/opencode/opencode.jsonc'), '// existing settings');
    expect(() => applySetup({ ...options, home, tool: 'opencode' })).toThrow(/JSONC/);
    expect(fs.existsSync(path.join(home, '.config/opencode/opencode.json'))).toBe(false);
  });
  it('refuses remote HTTP, credentialed URLs and placeholders', () => {
    const home = homeFixture();
    for (const baseUrl of ['http://remote.example/thruline/v1', 'https://secret@remote.example/thruline/v1', 'https://remote.example/v1']) {
      expect(() => applySetup({ ...options, baseUrl, home, tool: 'codex' })).toThrow();
    }
    expect(() => applySetup({ ...options, key: 'prefix...[full-key]', home, tool: 'claude' })).toThrow();
  });
});
