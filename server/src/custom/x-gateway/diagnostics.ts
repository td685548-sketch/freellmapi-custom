import { createHash } from 'node:crypto';
import type { GatewayDiagnostics, ToolProbeResult } from '@freellmapi/shared/x-operations.js';
import { getDb } from '../../db/index.js';
import { isTursoDatabase } from '../../db/turso.js';
import { getConfigSnapshot } from './config.js';
import { getUsableXGatewayKeys } from '../provider-accounts/store.js';

const TTL_MS = 5 * 60_000;
const evidence = new Map<string, { at: number; result: ToolProbeResult }>();
export function sessionEvidenceId(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
export function recordToolProbe(sessionId: string, result: ToolProbeResult): void {
  for (const [key, item] of evidence) if (Date.now() - item.at >= TTL_MS) evidence.delete(key);
  if (evidence.size >= 500) evidence.delete(evidence.keys().next().value!);
  evidence.set(`${sessionId}:${result.protocol}`, { at: Date.now(), result });
}
export function gatewayDiagnostics(sessionId: string, now = Date.now()): GatewayDiagnostics {
  const snapshot = getConfigSnapshot();
  const available = getUsableXGatewayKeys().filter(account =>
    !(account.monthly_request_cap > 0 && account.requests >= account.monthly_request_cap)
    && !(account.monthly_token_cap > 0 && account.tokens >= account.monthly_token_cap)).length;
  const turso = isTursoDatabase(getDb());
  const capabilities: GatewayDiagnostics['capabilities'] = [
    { id: 'gateway', state: snapshot.enabled ? 'configured' : 'unavailable', detail: snapshot.enabled ? 'Enabled; run a connection test to verify inference.' : 'Enable Thruline first.' },
    { id: 'providers', state: available ? 'configured' : 'unavailable', detail: available ? `${available} enabled account(s) within local caps. Credentials and upstream service still require a live test.` : 'No enabled accounts within local caps.' },
    { id: 'combos', state: snapshot.combos.length ? 'configured' : 'unavailable', detail: `${snapshot.combos.length} saved combo(s). Test a combo model explicitly to verify routing.` },
    { id: 'savers', state: 'unverified', detail: 'Saver configuration is separate from execution. This diagnostic does not verify compression or savings.' },
    { id: 'media', state: 'unverified', detail: 'Text inference does not verify images, speech, embeddings or video. Use the corresponding Media Providers test.' },
  ];
  for (const protocol of ['anthropic-messages', 'openai-responses', 'openai-chat', 'gemini'] as const) {
    const probe = evidence.get(`${sessionId}:${protocol}`);
    const recent = probe && now - probe.at < TTL_MS ? probe.result : undefined;
    capabilities.push({
      id: protocol,
      state: !snapshot.enabled || !available ? 'unavailable' : recent ? (recent.ok ? 'ready' : 'unavailable') : 'unverified',
      detail: recent ? (recent.ok ? 'Recent non-streaming inference passed for this model and key. Streaming/tools and other models remain unverified.' : recent.error ?? 'Inference test failed.')
        : 'No recent inference evidence in this console session. Configured accounts do not prove availability.',
      ...(recent ? { checkedAt: recent.checkedAt, model: recent.model } : {}),
    });
  }
  return {
    checkedAt: new Date(now).toISOString(), evidenceTtlSeconds: TTL_MS / 1000, capabilities,
    deployment: {
      publicBaseConfigured: Boolean(process.env.PUBLIC_APP_URL),
      encryptionKeyConfigured: /^[a-f0-9]{64}$/i.test(process.env.ENCRYPTION_KEY ?? ''),
      database: turso ? 'turso' : 'sqlite',
      persistence: turso ? 'external' : 'operator-verification-required',
    },
  };
}
