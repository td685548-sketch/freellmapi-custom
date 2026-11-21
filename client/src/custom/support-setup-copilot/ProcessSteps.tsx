/**
 * The Copilot's working steps ("what I am doing"), shown live while a message is processed and
 * kept as a collapsed list on the answer afterwards. Plain presentational component.
 */
import { useEffect, useRef } from 'react';
import { AlertCircle, Check, ChevronRight, Loader2 } from 'lucide-react';
import type { SupportSetupTraceStep } from '../../../../shared/support-setup-copilot';

interface Props {
  steps: readonly SupportSetupTraceStep[];
  locale: 'vi' | 'en';
  /** Live: always open, no toggle. Otherwise a collapsed `<details>` on a finished answer. */
  live?: boolean;
  title: string;
  /** e.g. "(5 steps)" suffix builder for the collapsed header. */
  countLabel: (n: number) => string;
  /** Label of the live reasoning text under a running step. */
  reasoningLabel: string;
}

function StepRow({ step, locale, reasoningLabel }: { step: SupportSetupTraceStep; locale: 'vi' | 'en'; reasoningLabel: string }) {
  const title = locale === 'vi' ? step.titleVi : step.titleEn;
  const detail = locale === 'vi' ? step.detailVi : step.detailEn;
  const reasoningRef = useRef<HTMLSpanElement>(null);
  // While the model is still thinking, keep the newest reasoning in view.
  useEffect(() => {
    const el = reasoningRef.current;
    if (el && step.status === 'running') el.scrollTop = el.scrollHeight;
  }, [step.reasoning, step.status]);
  return (
    <li className={`ssc-step ssc-step--${step.status}`} data-testid="support-setup-process-step" data-status={step.status}>
      <span className="ssc-step-icon" aria-hidden="true">
        {step.status === 'running' ? (
          <Loader2 size={12} className="ssc-spin" />
        ) : step.status === 'error' ? (
          <AlertCircle size={12} />
        ) : (
          <Check size={12} />
        )}
      </span>
      <span className="ssc-step-text">
        <span className="ssc-step-title">{title}</span>
        {detail ? <span className="ssc-step-detail">{detail}</span> : null}
        {step.reasoning ? (
          <span className="ssc-step-reasoning" data-testid="support-setup-step-reasoning">
            <span className="ssc-step-reasoning-label">{reasoningLabel}</span>
            <span className="ssc-step-reasoning-text" ref={reasoningRef}>
              {step.reasoning}
            </span>
          </span>
        ) : null}
      </span>
    </li>
  );
}

export function ProcessSteps({ steps, locale, live, title, countLabel, reasoningLabel }: Props) {
  if (steps.length === 0) return null;
  const list = (
    <ol className="ssc-steps">
      {steps.map((step) => (
        <StepRow key={step.id} step={step} locale={locale} reasoningLabel={reasoningLabel} />
      ))}
    </ol>
  );
  if (live) {
    return (
      <div className="ssc-process ssc-process--live" role="status" aria-live="polite" data-testid="support-setup-process-live">
        <div className="ssc-process-head">{title}</div>
        {list}
      </div>
    );
  }
  return (
    <details className="ssc-process" data-testid="support-setup-process-done">
      <summary className="ssc-process-head">
        <ChevronRight size={12} className="ssc-process-chevron" aria-hidden="true" />
        <span>
          {title} {countLabel(steps.length)}
        </span>
      </summary>
      {list}
    </details>
  );
}
