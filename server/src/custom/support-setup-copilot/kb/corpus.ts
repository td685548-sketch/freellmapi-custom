import { buildPermissionChunks } from './sources/permissions.js';
import { buildSettingChunks } from './sources/settings.js';
import { buildPageChunks } from './sources/pages.js';
import { buildTenantStepChunks } from './sources/tenant-steps.js';
import { buildTroubleshootingChunks } from './sources/troubleshooting.js';
import { buildWebOptionChunks } from './sources/web-options.js';
import { DOCS_KB } from './docs.generated.js';
import type { KbChunk } from './types.js';

let cached: readonly KbChunk[] | null = null;

/** The whole knowledge base (structured sources are generated from code; docs from docs.generated.ts). */
export function getKbCorpus(): readonly KbChunk[] {
  if (cached) return cached;
  const docs: KbChunk[] = DOCS_KB.map((d) => ({
    id: d.id,
    source: 'doc',
    title: d.title,
    text: d.text,
    docFile: d.file,
    tags: ['doc', 'docs', 'tai lieu', d.file],
  }));
  const all = [
    ...buildTenantStepChunks(),
    ...buildTroubleshootingChunks(),
    ...buildWebOptionChunks(),
    ...buildSettingChunks(),
    ...buildPageChunks(),
    ...buildPermissionChunks(),
    ...docs,
  ];
  const seen = new Set<string>();
  for (const c of all) {
    if (seen.has(c.id)) throw new Error(`Duplicate Setup Copilot KB chunk id: ${c.id}`);
    seen.add(c.id);
  }
  cached = all;
  return all;
}

export function getKbChunkById(id: string): KbChunk | undefined {
  return getKbCorpus().find((c) => c.id === id);
}

export function resetKbCorpusForTests(): void {
  cached = null;
}
