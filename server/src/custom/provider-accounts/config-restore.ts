import { assessProviderUrl } from '../../lib/url-guard.js';
import { AccountError } from './http.js';
import { customNodeSchema, providerModelsSchema } from './router.js';
import {
  deleteCustomProviderNode,
  listCustomProviderNodes,
  saveCustomProviderNode,
  setProviderModelConfig,
  type CustomProviderNode,
  type ProviderModelConfig,
} from './store.js';

/** Config backup sections owned by the provider accounts store. A restore goes through the
 * same schemas, URL policy and store functions as the `/api/thruline-accounts` routes, so a
 * backup file cannot write what those routes would refuse. Both `prepare*` functions only
 * validate; nothing is stored until the matching `apply*` runs. */

const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function invalid(section: string, detail: string): AccountError {
  return new AccountError(400, `Invalid backup: ${section} ${detail}`);
}

export async function prepareCustomNodesRestore(input: unknown[]): Promise<CustomProviderNode[]> {
  if (input.length > 200) throw invalid('customProviderNodes', 'holds more than 200 nodes.');
  const existing = new Map(listCustomProviderNodes().map(node => [node.id, node]));
  const seen = new Set<string>();
  const nodes: CustomProviderNode[] = [];
  for (const [index, raw] of input.entries()) {
    const parsed = customNodeSchema.safeParse(raw);
    if (!parsed.success) throw invalid(`customProviderNodes[${index}]`, `is not a valid node (${parsed.error.issues[0]?.message ?? 'bad shape'}).`);
    const body = parsed.data;
    const id = body.id || `custom-${body.prefix.toLowerCase().replace(/[^a-z0-9_-]/g, '')}-${Date.now().toString(36)}-${index}`;
    if (seen.has(id)) throw invalid(`customProviderNodes[${index}]`, `repeats the node id "${id}".`);
    seen.add(id);
    const baseUrl = body.baseUrl.trim().replace(/\/+$/, '');
    // A node already stored with this address was accepted before; only new addresses are assessed.
    if (existing.get(id)?.baseUrl !== baseUrl) {
      const verdict = await assessProviderUrl(baseUrl, { blockPrivate: true });
      if (!verdict.allowed) throw invalid(`customProviderNodes[${index}]`, `base URL is refused: ${verdict.reason || 'blocked by security policy'}.`);
    }
    nodes.push({
      id,
      name: body.name,
      prefix: body.prefix.toLowerCase().trim(),
      type: body.type || 'openai-compatible',
      ...(body.apiType ? { apiType: body.apiType } : {}),
      baseUrl,
      ...(body.models ? { models: body.models } : {}),
    });
  }
  return nodes;
}

/** Replaces the stored node list with `nodes`. */
export function applyCustomNodesRestore(nodes: CustomProviderNode[]): void {
  const keep = new Set(nodes.map(node => node.id));
  for (const node of listCustomProviderNodes()) if (!keep.has(node.id)) deleteCustomProviderNode(node.id);
  for (const node of nodes) saveCustomProviderNode(node);
}

export type ProviderModelConfigPatches = Array<[providerId: string, patch: Partial<ProviderModelConfig>]>;

export function prepareProviderModelConfigsRestore(input: Record<string, unknown>): ProviderModelConfigPatches {
  const entries = Object.entries(input);
  if (entries.length > 500) throw invalid('providerModelConfigs', 'holds more than 500 providers.');
  return entries.map(([providerId, raw]) => {
    const id = providerId.trim();
    if (!id || id.length > 100 || RESERVED_KEYS.has(id)) throw invalid('providerModelConfigs', `has an unusable provider id "${providerId.slice(0, 100)}".`);
    const parsed = providerModelsSchema.safeParse(raw);
    if (!parsed.success) throw invalid(`providerModelConfigs.${id}`, `is not a valid model configuration (${parsed.error.issues[0]?.message ?? 'bad shape'}).`);
    const body = parsed.data;
    return [id, { ...body, customModels: body.customModels?.map(m => ({ id: m.id, name: m.name || m.id })) }];
  });
}

export function applyProviderModelConfigsRestore(patches: ProviderModelConfigPatches): void {
  for (const [providerId, patch] of patches) setProviderModelConfig(providerId, patch);
}
