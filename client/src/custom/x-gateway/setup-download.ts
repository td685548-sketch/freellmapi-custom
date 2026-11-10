import source from './local-setup.mjs?raw';
export const LOCAL_SETUP_TOOLS = ['claude', 'codex', 'gemini', 'opencode', 'cursor'];
export function localSetupDownload(tool: string, baseUrl: string, key: string, model: string): string {
  return source.replace('const PRESET = null;', () => `const PRESET = ${JSON.stringify({ tool, baseUrl, key, model })};`);
}
export function toolBaseUrl(id: string, baseUrl: string): string {
  return ['claude', 'cline', 'gemini'].includes(id) ? baseUrl.replace(/\/v1\/?$/, '') : baseUrl;
}
