import type { Scope } from '../scope.js';
import { stripReferenceDataBlocks } from './context.js';

export type SupportGuardAction = 'pass' | 'logged' | 'masked' | 'blocked';

export interface SupportOutputGuardContext {
  scope: Scope;
  role: string;
  endUser: string | null;
  systemPrompt: string | null;
  /** True only when a trusted inference adapter/key was explicitly supplied for external judge calls. */
  hasInferenceCapability: boolean;
  signal?: AbortSignal;
}

export interface SupportOutputGuardResult {
  action: SupportGuardAction;
  text: string;
  reason?: string;
  checkFailed?: boolean;
}

export type SupportOutputGuardEvaluator = (
  scope: Scope,
  text: string,
  ctx: SupportOutputGuardContext,
) => Promise<SupportOutputGuardResult> | SupportOutputGuardResult;

let registeredDefaultEvaluator: SupportOutputGuardEvaluator | null = null;

/**
 * Registers the policy-backed `evaluateOutput` adapter once `output-guard/policy.ts`
 * is integrated (avoids circular/missing-dependency imports during S0).
 */
export function registerSupportOutputGuardEvaluator(evaluator: SupportOutputGuardEvaluator | null): void {
  registeredDefaultEvaluator = evaluator;
}

/**
 * Builds the trusted `SupportOutputGuardContext` for `executeSupportTurn`.
 * Never reads Express `req` or fabricates an inference key from a support session token.
 */
export function buildSupportGuardContext(options: {
  tenantId: number;
  verified: boolean;
  role: string;
  userId: string;
  systemPrompt?: string | null;
  trustedContext?: string | null;
  hasInferenceCapability?: boolean;
  signal?: AbortSignal;
}): SupportOutputGuardContext {
  const effectiveRole = options.verified ? options.role : 'guest';
  const promptParts: string[] = [];
  if (typeof options.systemPrompt === 'string') {
    const cleaned = stripReferenceDataBlocks(options.systemPrompt);
    if (cleaned) promptParts.push(cleaned);
  }
  if (typeof options.trustedContext === 'string') {
    const cleaned = stripReferenceDataBlocks(options.trustedContext);
    if (cleaned) promptParts.push(cleaned);
  }

  return {
    scope: { kind: 'support_tenant', id: String(options.tenantId) },
    role: effectiveRole,
    endUser: options.userId || null,
    systemPrompt: promptParts.length > 0 ? promptParts.join('\n\n') : null,
    hasInferenceCapability: Boolean(options.hasInferenceCapability),
    signal: options.signal,
  };
}

/**
 * Evaluates a support assistant reply through the configured output guard evaluator
 * (or registered default policy evaluator) before masking/persistence/outbox/webhook.
 */
export async function guardSupportReply(options: {
  text: string;
  context: SupportOutputGuardContext;
  evaluator?: SupportOutputGuardEvaluator;
}): Promise<SupportOutputGuardResult> {
  let fn = options.evaluator ?? registeredDefaultEvaluator;
  if (!fn) {
    const { evaluateOutput } = await import('./policy.js');
    fn = async (scope, text, ctx) => {
      const res = await evaluateOutput(scope, text, {
        role: ctx.role,
        trustedRole: ctx.role,
        endUser: ctx.endUser,
        wire: 'support',
        stream: false,
        systemPrompt: ctx.systemPrompt,
        signal: ctx.signal,
        canCallGateway: ctx.hasInferenceCapability,
      });
      return {
        action: res.action,
        text: res.text,
        reason: res.reason,
      };
    };
  }
  return await fn(options.context.scope, options.text, options.context);
}
