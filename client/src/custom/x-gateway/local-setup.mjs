#!/usr/bin/env node
// Run on your own computer with Node.js 20+. Never run in the hosted server's shell.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PRESET = null;
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
export function mergeConfig(current, patch) {
  if (!plain(current) || !plain(patch)) return patch;
  const output = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Unsafe configuration key.');
    output[key] = plain(value) ? mergeConfig(plain(output[key]) ? output[key] : {}, value) : value;
  }
  return output;
}
const sh = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const ps = value => "'" + String(value).replaceAll("'", "''") + "'";

function normalizeUrl(raw) {
  const url = new URL(raw);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Use a gateway URL without credentials, query or fragment.');
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Use HTTPS for a hosted gateway.');
  if (!/\/thruline\/v1\/?$/.test(url.pathname)) throw new Error('Base URL must end with /thruline/v1.');
  return url.toString().replace(/\/$/, '');
}

export function applySetup({ tool, baseUrl, key, model = 'auto', home = os.homedir(), opencodeVersion } = {}) {
  if (!['claude', 'codex', 'gemini', 'opencode', 'cursor'].includes(tool)) throw new Error('Choose claude, codex, gemini, opencode or cursor.');
  baseUrl = normalizeUrl(baseUrl);
  if (typeof key !== 'string' || !/^[\x21-\x7e]+$/.test(key) || key.includes('[full-key]') || key.includes('your-token')) throw new Error('Provide a full API key.');
  if (typeof model !== 'string' || !model.trim() || /[\r\n\0]/.test(model)) throw new Error('Provide a model.');
  home = path.resolve(home);
  const targetRoot = path.join(home, '.x-gateway');
  const files = [];
  const json = (relative, patch) => {
    const target = path.join(home, relative);
    const existing = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, 'utf8').replace(/^\uFEFF/, '')) : {};
    if (!plain(existing)) throw new Error('Existing configuration must be a JSON object. No files were changed.');
    files.push({ target, content: JSON.stringify(mergeConfig(existing, patch), null, 2) + '\n' });
  };
  const env = {};
  let args = [];
  if (tool === 'claude') {
    Object.assign(env, { ANTHROPIC_BASE_URL: baseUrl.replace(/\/v1$/, ''), ANTHROPIC_API_KEY: key, ANTHROPIC_AUTH_TOKEN: key,
      ANTHROPIC_MODEL: model, ANTHROPIC_DEFAULT_SONNET_MODEL: model, ANTHROPIC_DEFAULT_OPUS_MODEL: model, ANTHROPIC_DEFAULT_HAIKU_MODEL: model });
    json('.claude/settings.json', { env });
  } else if (tool === 'gemini') {
    Object.assign(env, { GEMINI_API_KEY: key, GOOGLE_GEMINI_BASE_URL: baseUrl.replace(/\/v1$/, ''), GOOGLE_GENAI_API_VERSION: 'v1beta', GOOGLE_GENAI_USE_VERTEXAI: 'false', GOOGLE_GENAI_USE_GCA: 'false' });
    args = ['--model', model];
    json('.gemini/settings.json', { security: { auth: { selectedType: 'gemini-api-key' } } });
  } else if (tool === 'codex') {
    env.X_GATEWAY_API_KEY = key;
    // CLI overlays preserve every existing config.toml section, comment and auth.json.
    args = ['-c', `model=${JSON.stringify(model)}`, '-c', 'model_provider="x_gateway"',
      '-c', 'model_providers.x_gateway.name="X Gateway"',
      '-c', `model_providers.x_gateway.base_url=${JSON.stringify(baseUrl)}`,
      '-c', 'model_providers.x_gateway.env_key="X_GATEWAY_API_KEY"',
      '-c', 'model_providers.x_gateway.requires_openai_auth=false',
      '-c', 'model_providers.x_gateway.wire_api="responses"'];
  } else if (tool === 'opencode') {
    env.X_GATEWAY_API_KEY = key;
    const existingPath = path.join(home, '.config/opencode/opencode.json');
    if (fs.existsSync(path.join(home, '.config/opencode/opencode.jsonc'))) throw new Error('Merge existing OpenCode JSONC manually; refusing to shadow it.');
    const existing = fs.existsSync(existingPath) ? JSON.parse(fs.readFileSync(existingPath, 'utf8')) : {};
    const v1 = opencodeVersion === '1' || (!opencodeVersion && Object.hasOwn(existing, 'provider'));
    json('.config/opencode/opencode.json', v1 ? {
      provider: { x_gateway: { name: 'X Gateway', npm: '@ai-sdk/openai-compatible',
        options: { baseURL: baseUrl, apiKey: '{env:X_GATEWAY_API_KEY}' }, models: { [model]: { name: model } } } }, model: `x_gateway/${model}`,
    } : { providers: { x_gateway: { name: 'X Gateway', env: ['X_GATEWAY_API_KEY'],
      package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: baseUrl }, models: { [model]: { name: model } } } }, model: `x_gateway/${model}` });
  } else {
    files.push({ target: path.join(targetRoot, 'cursor-setup.txt'), content:
      `Configure Cursor manually in Cursor Settings > Models > API Keys.\nSave your previous URL and model selection before changing them.\nOpenAI API key: ${key}\nOverride OpenAI Base URL: ${baseUrl}\nModel: ${model}\nUse Verify in Cursor. Gateway inference does not prove IDE feature compatibility.\nTo undo, restore your previous values in Cursor. No Cursor files or keychain were edited.\n` });
  }
  if (tool !== 'cursor') {
    const assignments = Object.entries(env);
    files.push({ target: path.join(targetRoot, `${tool}.sh`), content: '#!/bin/sh\nset -e\n'
      + assignments.map(([k, v]) => `export ${k}=${sh(v)}\n`).join('')
      + `exec ${tool} ${args.map(sh).join(' ')} "$@"\n` });
    files.push({ target: path.join(targetRoot, `${tool}.ps1`), content:
      assignments.map(([k, v]) => `$env:${k} = ${ps(v)}\n`).join('')
      + `& ${tool} ${args.map(ps).join(' ')} @args\nexit $LASTEXITCODE\n` });
  }
  // Parse every existing JSON file before writing anything. Refuse symlinks.
  for (const file of files) {
    let cursor = file.target;
    while (cursor !== path.dirname(cursor)) {
      if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error('Refusing symlinked configuration paths.');
      cursor = path.dirname(cursor);
    }
  }
  const backup = path.join(targetRoot, 'backups', `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
  const manifest = { home, entries: files.map((file, index) => {
    const exists = fs.existsSync(file.target);
    if (exists) fs.copyFileSync(file.target, path.join(backup, String(index)));
    if (exists) fs.chmodSync(path.join(backup, String(index)), 0o600);
    return { target: path.relative(home, file.target), existed: exists, mode: exists ? fs.statSync(file.target).mode & 0o777 : 0o600, backup: String(index) };
  }) };
  fs.writeFileSync(path.join(backup, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  try {
    for (const file of files) {
      fs.mkdirSync(path.dirname(file.target), { recursive: true, mode: 0o700 });
      const tmp = `${file.target}.tmp-${crypto.randomBytes(4).toString('hex')}`;
      const mode = file.target.endsWith('.sh') ? 0o700 : 0o600;
      fs.writeFileSync(tmp, file.content, { mode, flag: 'wx' });
      fs.renameSync(tmp, file.target);
      fs.chmodSync(file.target, mode);
    }
  } catch (error) {
    restoreSetup(backup);
    throw error;
  }
  return { backup, launcher: path.join(targetRoot, tool === 'cursor' ? 'cursor-setup.txt' : `${tool}.${process.platform === 'win32' ? 'ps1' : 'sh'}`) };
}

export function restoreSetup(backup) {
  backup = path.resolve(backup);
  const manifest = JSON.parse(fs.readFileSync(path.join(backup, 'manifest.json'), 'utf8'));
  const home = path.resolve(manifest.home);
  const expectedRoot = path.join(home, '.x-gateway', 'backups') + path.sep;
  if (!backup.startsWith(expectedRoot)) throw new Error('Backup is outside the setup backup directory.');
  for (const entry of manifest.entries) {
    const target = path.resolve(home, entry.target);
    if (!target.startsWith(home + path.sep) || !/^\d+$/.test(entry.backup)) throw new Error('Invalid backup manifest.');
    let cursor = target;
    while (cursor !== path.dirname(cursor)) {
      if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error('Refusing symlinked restore paths.');
      cursor = path.dirname(cursor);
    }
  }
  for (const entry of manifest.entries) {
    const target = path.resolve(home, entry.target);
    if (entry.existed) {
      fs.copyFileSync(path.join(backup, entry.backup), target);
      fs.chmodSync(target, Number.isInteger(entry.mode) ? entry.mode & 0o777 : 0o600);
    } else fs.rmSync(target, { force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const argv = process.argv.slice(2);
    const option = name => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; };
    if (option('--restore')) { restoreSetup(option('--restore')); console.log('Setup restored.'); }
    else {
      const result = applySetup({ ...PRESET, tool: option('--tool') ?? PRESET?.tool,
        baseUrl: option('--url') ?? PRESET?.baseUrl,
        key: process.env.X_GATEWAY_API_KEY ?? PRESET?.key,
        model: option('--model') ?? PRESET?.model ?? 'auto',
        home: option('--home') ?? os.homedir(), opencodeVersion: option('--opencode-version') });
      const quote = process.platform === 'win32' ? ps : sh;
      console.log(`Setup saved locally. ${result.launcher.endsWith('.txt') ? 'Read instructions' : 'Launch'}: ${process.platform === 'win32' && !result.launcher.endsWith('.txt') ? 'pwsh -File ' : ''}${quote(result.launcher)}`);
      console.log(`Restore: node x-gateway-setup.mjs --restore ${quote(result.backup)}`);
      console.log('Downloads and backups may contain credentials. Keep them private. No client was launched.');
    }
  } catch { console.error('Setup failed. Verify tool, URL, full key and valid existing JSON settings. No credentials are logged.'); process.exitCode = 1; }
}
