import type { Request } from 'express';
import {
  type GuardBufferingReason,
  type GuardDetectorId,
  type GuardEvalAction,
  type GuardEvaluateResult,
  type GuardPolicyInput,
  type GuardPolicyView,
  type GuardTestRequest,
  type GuardTestResponse,
  type GuardTestTriggeredHit,
  type GuardWire,
  type Scope,
} from '@freellmapi/shared/ai-platform-output-guard.js';
import { isPillarEnabled } from '../flags.js';
import { registerOutputFilterProvider } from '../pipeline.js';
import { recordCompletedSpan } from '../tracing/collector.js';
import type { OutputFilter } from '../wire/interceptor.js';
import { readStoredProfileSystemPrompt } from './context.js';
import {
  analyzeStreamingCapability,
  evaluateLocalDetectors,
  evaluateLocalDetectorsSync,
  type LocalDetectorHit,
} from './detectors.js';
import { recordGuardEvent } from './events.js';
import { evaluateExternalDetectors, type ExternalCheckResult } from './external.js';
import { validatePatternsConfig } from './pattern-validator.js';
import {
  createStreamGuard,
  type StreamGuardCheckResult,
} from './stream-guard.js';
import {
  assertScopeExists,
  buildDefaultPolicyView,
  computeBufferingReason,
  getEffectivePolicy,
  getRuntimePolicySnapshot,
  GuardStoreError,
  upsertPolicy,
  validatePolicyInput,
} from './store.js';
import { registerSupportOutputGuardEvaluator } from './support-adapter.js';

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

async function validatePatternsOrThrow(policy: GuardPolicyInput): Promise<void> {
  if (policy.detectors.patterns.rules.length === 0) return;
  const res = await validatePatternsConfig(policy.detectors.patterns);
  if (!res.ok) {
    throw new GuardStoreError(res.reason, res.code, 422);
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
  await validatePatternsOrThrow(validated);
  return upsertPolicy(scope, validated, actorId);
}

function isTrustedBypass(policy: GuardPolicyView, ctx: GuardEvalContext): boolean {
  if (!ctx.trustedRole) return false;
  return policy.bypassRoles.includes(ctx.trustedRole);
}

function safeRecordEvent(input: Parameters<typeof recordGuardEvent>[0]): void {
  try {
    recordGuardEvent(input);
  } catch {
    /* never fail or leak raw output on telemetry write error */
  }
}

/**
 * Synchronous local fast-path for incremental streaming when `canIncrementalStream` is true
 * (i.e. `patterns`, `moderation`, and `judge` are all disabled/empty).
 */
function evaluateIncrementalSync(
  scope: Scope,
  text: string,
  policy: GuardPolicyView,
  systemPrompt: string | null,
): StreamGuardCheckResult {
  const result = evaluateLocalDetectorsSync(scope, text, policy, { systemPrompt });
  return {
    action: result.action,
    text: result.action === 'masked' ? result.maskedText : text,
    detector: result.reason,
    reason: result.reason,
  };
}

async function evaluateWithPolicySnapshot(
  scope: Scope,
  policy: GuardPolicyView,
  text: string,
  ctx: GuardEvalContext,
  opts?: { recordEvents?: boolean },
): Promise<GuardEvaluateResult> {
  const recordEvents = opts?.recordEvents ?? true;

  const localResult = await evaluateLocalDetectors(scope, text, policy, {
    systemPrompt: ctx.systemPrompt,
    role: ctx.role,
    signal: ctx.signal,
  });

  const hasExternal =
    policy.detectors.moderation.enabled || policy.detectors.judge.enabled;
  let extResult: ExternalCheckResult | null = null;
  if (hasExternal && !(policy.mode === 'block' && localResult.action === 'blocked')) {
    extResult = await evaluateExternalDetectors(policy, text, {
      req: ctx.req,
      signal: ctx.signal,
      endUser: ctx.endUser,
      canCallGateway: ctx.canCallGateway,
      runId: ctx.runId,
    });
  }

  const triggeredSet = new Set<GuardDetectorId>();
  for (const hit of localResult.hits) {
    triggeredSet.add(hit.detector);
  }
  if (extResult) {
    for (const hit of extResult.triggered) {
      triggeredSet.add(hit.detector);
    }
  }

  const localFailed = Boolean(localResult.checkFailed);
  const extFailed = extResult?.action === 'check_failed';
  if (recordEvents) {
    if (localFailed) {
      safeRecordEvent({
        scope,
        endUser: ctx.endUser,
        detector: 'patterns',
        action: 'check_failed',
        wire: ctx.wire,
        streamed: ctx.stream,
        runId: ctx.runId ?? null,
      });
    }
    if (extFailed && extResult) {
      safeRecordEvent({
        scope,
        endUser: ctx.endUser,
        detector: extResult.reason ?? (policy.detectors.judge.enabled ? 'judge' : 'moderation'),
        action: 'check_failed',
        wire: ctx.wire,
        streamed: ctx.stream,
        runId: ctx.runId ?? null,
      });
    }
  }

  const failClosedTriggered = (localFailed || extFailed) && policy.failMode === 'block';
  const blockingLocalHit: LocalDetectorHit | undefined = localResult.hits.find(
    (h) => h.action === 'block',
  );
  const extBlocked = extResult?.action === 'blocked';
  const anyBlocked = Boolean(blockingLocalHit) || extBlocked || failClosedTriggered;
  const anyHit = localResult.hits.length > 0 || Boolean(extResult?.triggered.length) || failClosedTriggered;

  const primaryReason: GuardDetectorId | undefined =
    blockingLocalHit?.detector ??
    (extBlocked ? extResult?.reason : undefined) ??
    localResult.hits[0]?.detector ??
    (failClosedTriggered
      ? localFailed
        ? 'patterns'
        : extResult?.reason ?? (policy.detectors.judge.enabled ? 'judge' : 'moderation')
      : undefined);

  const primaryHit = blockingLocalHit ?? localResult.hits[0];

  if (policy.mode === 'log') {
    if (!anyHit) {
      return { action: 'pass', text };
    }
    if (recordEvents && primaryReason) {
      safeRecordEvent({
        scope,
        endUser: ctx.endUser,
        detector: primaryReason,
        action: 'logged',
        wire: ctx.wire,
        streamed: ctx.stream,
        runId: ctx.runId ?? null,
        excerptSourceText: text,
        matchOffset: primaryHit?.index,
        matchLength: primaryHit ? Math.max(1, primaryHit.endIndex - primaryHit.index) : undefined,
      });
    }
    return {
      action: 'logged',
      text,
      reason: primaryReason,
      triggered: [...triggeredSet],
    };
  }

  // mode === 'block'
  if (anyBlocked) {
    if (recordEvents && primaryReason && !(failClosedTriggered && !blockingLocalHit && !extBlocked)) {
      safeRecordEvent({
        scope,
        endUser: ctx.endUser,
        detector: primaryReason,
        action: 'blocked',
        wire: ctx.wire,
        streamed: ctx.stream,
        runId: ctx.runId ?? null,
        excerptSourceText: text,
        matchOffset: primaryHit?.index,
        matchLength: primaryHit ? Math.max(1, primaryHit.endIndex - primaryHit.index) : undefined,
      });
    }
    return {
      action: 'blocked',
      text: policy.replacementText,
      reason: primaryReason,
      triggered: [...triggeredSet],
    };
  }

  if (localResult.action === 'masked') {
    if (recordEvents) {
      safeRecordEvent({
        scope,
        endUser: ctx.endUser,
        detector: 'pii',
        action: 'masked',
        wire: ctx.wire,
        streamed: ctx.stream,
        runId: ctx.runId ?? null,
        excerptSourceText: text,
        matchOffset: primaryHit?.index,
        matchLength: primaryHit ? Math.max(1, primaryHit.endIndex - primaryHit.index) : undefined,
      });
    }
    return {
      action: 'masked',
      text: localResult.maskedText,
      reason: 'pii',
      triggered: [...triggeredSet],
    };
  }

  return { action: 'pass', text };
}

/**
 * Returns an OutputFilter for the given scope and context, or `null` when
 * `outputGuard` pillar flag is disabled or the scope policy mode is `'off'`.
 * Snapshots the policy once for the entire response.
 */
export function outputFilterFor(scope: Scope, ctx: GuardEvalContext): OutputFilter | null {
  if (!isPillarEnabled('outputGuard')) return null;
  const policy = getRuntimePolicySnapshot(scope);
  if (policy.mode === 'off') return null;

  if (isTrustedBypass(policy, ctx)) {
    safeRecordEvent({
      scope,
      endUser: ctx.endUser,
      detector: 'keywords',
      action: 'bypassed',
      wire: ctx.wire,
      streamed: ctx.stream,
      runId: ctx.runId ?? null,
    });
    return null;
  }

  const { canIncrementalStream } = analyzeStreamingCapability(policy);
  const buffering = !ctx.stream || !canIncrementalStream;

  return createStreamGuard({
    mode: policy.mode,
    holdChars: policy.holdChars,
    maxDelayMs: policy.maxDelayMs,
    replacementText: policy.replacementText,
    buffering,
    failClosed: policy.failMode === 'block',
    evaluateLocal: (scanContext) =>
      evaluateIncrementalSync(scope, scanContext, policy, ctx.systemPrompt),
    evaluateFinal: buffering
      ? async (fullText) => {
          const guardStartedAt = Date.now();
          const res = await evaluateWithPolicySnapshot(scope, policy, fullText, ctx, {
            recordEvents: true,
          });
          recordCompletedSpan({
            kind: 'output_guard',
            name: `output_guard:${scope.kind}:${scope.id}`,
            durationMs: Date.now() - guardStartedAt,
            status: res.action === 'blocked' ? 'error' : 'ok',
            ...(res.reason ? { errorSummary: res.reason } : {}),
            attributes: {
              action: res.action,
              mode: policy.mode,
              ...(res.reason ? { reason: res.reason } : {}),
            },
          });
          return {
            action: res.action,
            text: res.text,
            reason: res.reason,
            detector: res.reason,
          };
        }
      : undefined,
    onEvent: buffering
      ? undefined
      : (ev) => {
          const detector = (ev.detector ?? ev.reason ?? 'keywords') as GuardDetectorId;
          const action = ev.action === 'pass' ? 'logged' : ev.action;
          safeRecordEvent({
            scope,
            endUser: ctx.endUser,
            detector,
            action,
            wire: ctx.wire,
            streamed: ctx.stream,
            runId: ctx.runId ?? null,
            excerptSourceText: ev.excerptSource ?? undefined,
          });
        },
  });
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
    safeRecordEvent({
      scope,
      endUser: ctx.endUser,
      detector: 'keywords',
      action: 'bypassed',
      wire: ctx.wire,
      streamed: ctx.stream,
      runId: ctx.runId ?? null,
    });
    return { action: 'pass', text };
  }

  const startedAt = Date.now();
  const res = await evaluateWithPolicySnapshot(scope, policy, text, ctx, { recordEvents: true });
  recordCompletedSpan({
    kind: 'output_guard',
    name: `output_guard:${scope.kind}:${scope.id}`,
    durationMs: Date.now() - startedAt,
    status: res.action === 'blocked' ? 'error' : 'ok',
    ...(res.reason ? { errorSummary: res.reason } : {}),
    attributes: {
      action: res.action,
      mode: policy.mode,
      ...(res.reason ? { reason: res.reason } : {}),
    },
  });
  return res;
}

/**
 * Dry-run policy tester for dashboard `POST /output-guard/:scope/test`.
 * Never writes production guard events or excerpts.
 */
export async function testPolicy(
  scope: Scope,
  req: GuardTestRequest,
  ctx: GuardTestContext,
): Promise<GuardTestResponse> {
  const norm = assertScopeExists(scope);
  if (req.includeExternal && !isPillarEnabled('outputGuard')) {
    throw new GuardStoreError(
      'Output guard pillar is disabled; external detectors cannot run.',
      'pillar_disabled',
      409,
    );
  }

  let policy: GuardPolicyView;
  if (req.policy !== undefined) {
    const validated = validatePolicyInput(req.policy);
    await validatePatternsOrThrow(validated);
    const base = buildDefaultPolicyView(norm);
    policy = {
      ...base,
      ...validated,
      bufferingReason: computeBufferingReason(validated),
    };
  } else {
    policy = getEffectivePolicy(norm);
  }

  const systemPrompt =
    ctx.systemPrompt ??
    (norm.kind === 'profile' ? readStoredProfileSystemPrompt(Number(norm.id)) : null);

  const warnings: string[] = [];
  if (req.role && policy.bypassRoles.includes(req.role)) {
    warnings.push(
      `Role '${req.role}' is in bypassRoles; runtime bypass requires a verified trusted role and is not applied in dry-run.`,
    );
  }

  if (policy.mode === 'off') {
    return {
      action: 'pass',
      triggered: [],
      maskedText: req.text,
      buffering: false,
      bufferingReason: 'none',
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  const localResult = await evaluateLocalDetectors(norm, req.text, policy, {
    systemPrompt,
    role: req.role,
    signal: ctx.signal,
  });

  const triggered: GuardTestTriggeredHit[] = localResult.hits.map((h) => ({
    detector: h.detector,
    match: h.match,
  }));

  let extResult: ExternalCheckResult | null = null;
  if (
    req.includeExternal &&
    (policy.detectors.moderation.enabled || policy.detectors.judge.enabled)
  ) {
    extResult = await evaluateExternalDetectors(policy, req.text, {
      req: ctx.req,
      signal: ctx.signal,
      endUser: null,
      canCallGateway: ctx.canCallGateway,
    });
    if (extResult.action === 'blocked') {
      for (const hit of extResult.triggered) {
        triggered.push({ detector: hit.detector, match: hit.match });
      }
    } else if (extResult.action === 'check_failed') {
      warnings.push(`External check failed (${extResult.errorCode ?? 'error'}).`);
    }
  }

  if (localResult.checkFailed) {
    warnings.push('Pattern evaluation exceeded runtime budget.');
  }

  const failClosedTriggered =
    (Boolean(localResult.checkFailed) || extResult?.action === 'check_failed') &&
    policy.failMode === 'block';
  const hasBlockHit =
    localResult.hits.some((h) => h.action === 'block') ||
    extResult?.action === 'blocked' ||
    failClosedTriggered;

  let action: GuardEvalAction = 'pass';
  let maskedText = req.text;
  if (policy.mode === 'log') {
    action = triggered.length > 0 || failClosedTriggered ? 'logged' : 'pass';
    maskedText = req.text;
  } else if (hasBlockHit) {
    action = 'blocked';
    maskedText = policy.replacementText;
  } else if (localResult.action === 'masked') {
    action = 'masked';
    maskedText = localResult.maskedText;
  }

  const bufferingReason: GuardBufferingReason = computeBufferingReason(policy);
  const buffering = bufferingReason !== 'none';

  return {
    action,
    triggered,
    maskedText,
    buffering,
    bufferingReason,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

// Register default runtime providers for pipeline & support-adapter without circular imports.
registerOutputFilterProvider((ctx) =>
  outputFilterFor(ctx.scope, {
    req: ctx.req,
    signal: ctx.signal,
    role: ctx.role,
    trustedRole: null,
    endUser: ctx.endUser,
    wire: ctx.wire,
    stream: ctx.stream,
    systemPrompt: ctx.systemPrompt,
    canCallGateway: ctx.canRunExternalJudge,
  }),
);

registerSupportOutputGuardEvaluator(async (scope, text, ctx) => {
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
});
