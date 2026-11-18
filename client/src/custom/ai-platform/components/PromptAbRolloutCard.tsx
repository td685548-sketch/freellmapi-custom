import { useState } from 'react';
import { useCustomT } from '../../i18n/use-custom-t';
import { getPromptErrorInfo, updatePromptAbSplit, type PromptHead, type Scope } from '../prompts-api';
import {
  PROMPTS_AB_APPLYING_BTN,
  PROMPTS_AB_APPLY_BTN,
  PROMPTS_AB_DRAFT_SPLIT_LABEL,
  PROMPTS_AB_ERROR,
  PROMPTS_AB_HEADING,
  PROMPTS_AB_NEED_DRAFT,
  PROMPTS_AB_RESET_BTN,
  PROMPTS_AB_SAVED,
  PROMPTS_AB_SPLIT_SUMMARY,
  PROMPTS_AB_SUBTITLE,
} from '../prompts-strings';

const PRESET_WEIGHTS = [0, 10, 25, 50, 100] as const;

export interface PromptAbRolloutCardProps {
  scope: Scope;
  head: PromptHead;
  canPublish: boolean;
  disabled?: boolean;
  onUpdated: () => Promise<void> | void;
}

export function PromptAbRolloutCard({
  scope,
  head,
  canPublish,
  disabled = false,
  onUpdated,
}: PromptAbRolloutCardProps) {
  const tc = useCustomT();
  const [weightPct, setWeightPct] = useState<number>(head.abDraftWeightPct ?? 0);
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  const hasDraft = head.draftVersion !== null;
  const currentWeight = head.abDraftWeightPct ?? 0;
  const dirty = weightPct !== currentWeight;

  async function applyWeight(nextWeight: number) {
    if (!canPublish || saving || disabled) return;
    if (nextWeight > 0 && !hasDraft) return;
    setSaving(true);
    setErrorMsg(null);
    setSavedMsg(null);
    try {
      await updatePromptAbSplit(scope, {
        abDraftWeightPct: nextWeight,
        revision: head.revision,
      });
      setWeightPct(nextWeight);
      setSavedMsg(tc(PROMPTS_AB_SAVED));
      await onUpdated();
    } catch (err) {
      const info = getPromptErrorInfo(err);
      setErrorMsg(info.message || tc(PROMPTS_AB_ERROR));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      className="rounded-lg border bg-card p-4 space-y-3"
      data-testid="prompts-ab-rollout-section"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">{tc(PROMPTS_AB_HEADING)}</h2>
          <p className="text-xs text-muted-foreground mt-0.5">{tc(PROMPTS_AB_SUBTITLE)}</p>
        </div>
        <span
          data-testid="prompts-ab-split-badge"
          className="rounded bg-muted px-2 py-0.5 text-xs font-mono font-medium"
        >
          {tc(PROMPTS_AB_SPLIT_SUMMARY, {
            draft: weightPct,
            published: 100 - weightPct,
          })}
        </span>
      </div>

      {!hasDraft && (
        <p className="text-xs text-muted-foreground" data-testid="prompts-ab-no-draft">
          {tc(PROMPTS_AB_NEED_DRAFT)}
        </p>
      )}

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-xs font-medium" htmlFor="prompts-ab-slider">
            {tc(PROMPTS_AB_DRAFT_SPLIT_LABEL)}
          </label>
          <input
            id="prompts-ab-slider"
            data-testid="prompts-ab-slider"
            type="range"
            min={0}
            max={100}
            step={5}
            value={weightPct}
            disabled={!canPublish || !hasDraft || saving || disabled}
            onChange={(e) => {
              setSavedMsg(null);
              setWeightPct(Number(e.target.value));
            }}
            className="w-48 accent-primary"
          />
          <span className="text-xs font-mono w-10">{`${weightPct}%`}</span>
          <div className="flex flex-wrap items-center gap-1.5">
            {PRESET_WEIGHTS.map((pct) => (
              <button
                key={pct}
                type="button"
                data-testid={`prompts-ab-preset-${pct}`}
                disabled={!canPublish || (pct > 0 && !hasDraft) || saving || disabled}
                onClick={() => {
                  setSavedMsg(null);
                  setWeightPct(pct);
                }}
                className={`rounded border px-2 py-0.5 text-xs ${
                  weightPct === pct
                    ? 'border-primary bg-primary/10 text-primary font-medium'
                    : 'hover:bg-muted'
                } disabled:opacity-50`}
              >
                {`${pct}%`}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="prompts-ab-apply-btn"
            disabled={!canPublish || (!hasDraft && weightPct > 0) || !dirty || saving || disabled}
            onClick={() => void applyWeight(weightPct)}
            className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {saving ? tc(PROMPTS_AB_APPLYING_BTN) : tc(PROMPTS_AB_APPLY_BTN)}
          </button>
          {currentWeight > 0 && (
            <button
              type="button"
              data-testid="prompts-ab-reset-btn"
              disabled={!canPublish || saving || disabled}
              onClick={() => void applyWeight(0)}
              className="rounded border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
            >
              {tc(PROMPTS_AB_RESET_BTN)}
            </button>
          )}
        </div>
      </div>

      {errorMsg && (
        <div
          role="alert"
          data-testid="prompts-ab-error"
          className="rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {errorMsg}
        </div>
      )}
      {savedMsg && (
        <div
          role="status"
          data-testid="prompts-ab-saved"
          className="rounded border border-emerald-600/30 bg-emerald-600/15 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400"
        >
          {savedMsg}
        </div>
      )}
    </section>
  );
}
