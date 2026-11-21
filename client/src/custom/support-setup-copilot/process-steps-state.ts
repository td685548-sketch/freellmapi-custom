import type { SupportSetupTraceStep } from '../../../../shared/support-setup-copilot';

/** Replaces the step with the same id (an update), or appends a new one. */
export function upsertStep(
  steps: readonly SupportSetupTraceStep[],
  next: SupportSetupTraceStep,
): SupportSetupTraceStep[] {
  const i = steps.findIndex((s) => s.id === next.id);
  if (i === -1) return [...steps, next];
  const copy = [...steps];
  copy[i] = next;
  return copy;
}
