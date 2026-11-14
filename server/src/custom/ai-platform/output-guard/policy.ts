import type { Request } from 'express';
import {
  type GuardEvaluateResult,
  type GuardPolicyInput,
  type GuardPolicyView,
  type GuardTestRequest,
  type GuardTestResponse,
  type GuardWire,
  type Scope,
} from '@freellmapi/shared/ai-platform-output-guard.js';
import { isPillarEnabled } from '../flags.js';
import type { OutputFilter } from '../wire/interceptor.js';
import { recordGuardEvent } from './events.js';
import {
  assertScopeExists,
  getEffectivePolicy,
  getRuntimePolicySnapshot,
  GuardStoreError,
  upsertPolicy,
  validatePolicyInput,
} from './store.js';

export interface GuardEvalContext {
  req?: Request;
  signal?: AbortSignal;
  role?: string;
  trustedRole?: string | null;
  endUser: string | null;
  wire: GuardWire;
  stream: boolean;
  systemPrompt: string | null;
  runId?: string;
  canCallGateway?: boolean;
}

export interface GuardTestContext {
  req?: Request;
  signal?: AbortSignal;
  systemPrompt: string | null;
  canCallGateway?: boolean;
}

function validatePatternSyntax(policy: GuardPolicyInput): void {
  for (const rule of policy.detectors.patterns.rules) {
    try {
      // Syntax check before transaction; deep ReDoS/5ms worker validation (D0) wires here after Agent 2 delivery.
      new RegExp(rule.pattern, rule.flags);
    } catch (err) {
      throw new GuardStoreError(
        `Invalid regex pattern '${rule.name}': ${err instanceof Error ? err.message : 'syntax error'}`,
        'unsafe_pattern',
        422,
      );
    }
  }
}

export function getPolicy(scope: Scope): GuardPolicyView {
  return getEffectivePolicy(scope);
}

export async function setPolicy(
  scope: Scope,
  input: GuardPolicyInput,
  actorId: number | null,
): Promise<GuardPolicyView> {
  const validated = validatePolicyInput(input);
  validatePatternSyntax(validated);
  return upsertPolicy(scope, validated, actorId);
}

function isTrustedBypass(policy: GuardPolicyView, ctx: GuardEvalContext): boolean {
  if (!ctx.trustedRole) return false;
  return policy.bypassRoles.includes(ctx.trustedRole);
}

/**
 * Returns an OutputFilter for the given scope and context, or `null` when
 * `outputGuard` pillar flag is disabled or the scope policy mode is `'off'`.
 *
 * NOTE: Full stream-guard filter construction (S0) and detector evaluation (D0)
 * will be wired here once Agent 2 (D0) and Agent 3 (S0) are delivered.
 */
export function outputFilterFor(scope: Scope, ctx: GuardEvalContext): OutputFilter | null {
  if (!isPillarEnabled('outputGuard')) return null;
  const policy = getRuntimePolicySnapshot(scope);
  if (policy.mode === 'off') return null;

  if (isTrustedBypass(policy, ctx)) {
    try {
      recordGuardEvent({
        scope,
        endUser: ctx.endUser,
        detector: 'keywords',
        action: 'bypassed',
        wire: ctx.wire,
        streamed: ctx.stream,
        runId: ctx.runId ?? null,
      });
    } catch {
      /* never fail inference on telemetry write */
    }
    return null;
  }

  // Pending D0 + S0 composition: return null-safe fail-closed/open placeholder is forbidden;
  // callers should check readiness until D0+S0 are wired.
  throw new Error('Output guard runtime composition pending Agent 2 (D0) and Agent 3 (S0).');
}

/**
 * Evaluates a complete assistant response against the scope's output guard policy.
 * Used for non-interceptor paths (support runtime, orchestrator runs).
 */
export async function evaluateOutput(
  scope: Scope,
  text: string,
  ctx: GuardEvalContext,
): Promise<GuardEvaluateResult> {
  if (!isPillarEnabled('outputGuard')) {
    return { action: 'pass', text };
  }

  const policy = getRuntimePolicySnapshot(scope);
  if (policy.mode === 'off') {
    return { action: 'pass', text };
  }

  if (isTrustedBypass(policy, ctx)) {
    try {
      recordGuardEvent({
        scope,
        endUser: ctx.endUser,
        detector: 'keywords',
        action: 'bypassed',
        wire: ctx.wire,
        streamed: ctx.stream,
        runId: ctx.runId ?? null,
      });
    } catch {
      /* never fail inference on telemetry write */
    }
    return { action: 'pass', text };
  }

  throw new Error('Output guard detector evaluation pending Agent 2 (D0).');
}

/**
 * Dry-run policy tester for dashboard `POST /output-guard/:scope/test`.
 * Never writes production guard events or excerpts.
 */
export async function testPolicy(
  scope: Scope,
  req: GuardTestRequest,
  _ctx: GuardTestContext,
): Promise<GuardTestResponse> {
  assertScopeExists(scope);
  if (req.includeExternal && !isPillarEnabled('outputGuard')) {
    throw new GuardStoreError(
      'Output guard pillar is disabled; external detectors cannot run.',
      'pillar_disabled',
      409,
    );
  }
  if (req.policy !== undefined) {
    const validated = validatePolicyInput(req.policy);
    validatePatternSyntax(validated);
  }
  throw new Error('Output guard tester detector evaluation pending Agent 2 (D0).');
}
