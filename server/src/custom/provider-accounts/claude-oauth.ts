import { parseOAuthCredential } from './oauth-credentials.js';

/** OAuth wire identity from 9router's Claude registry/request translator. */
export function prepareClaudeOAuthBody(credential: string, body: Record<string, unknown>): Record<string, unknown> {
  if (parseOAuthCredential(credential)?.kind !== 'claude') return body;
  const system = [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }];
  if (typeof body.system === 'string' && body.system) system.push({ type: 'text', text: body.system });
  return { ...body, system };
}
