import { useCustomT } from '../../i18n/use-custom-t';
import {
  OUTPUT_GUARD_LIMITS,
  type GuardFailMode,
  type GuardMode,
  type GuardPatternRule,
  type GuardPiiAction,
  type GuardPolicyView,
  type Scope,
} from '../output-guard-api';
import {
  GUARD_ADD_PATTERN,
  GUARD_BUFFERING_FULL_EXTERNAL,
  GUARD_BUFFERING_FULL_PATTERNS,
  GUARD_BYPASS_ROLES_LABEL,
  GUARD_BYPASS_ROLES_WARNING,
  GUARD_DETECTORS_HEADING,
  GUARD_DETECTOR_JUDGE,
  GUARD_DETECTOR_KEYWORDS,
  GUARD_DETECTOR_MAX_LENGTH,
  GUARD_DETECTOR_MODERATION,
  GUARD_DETECTOR_PATTERNS,
  GUARD_DETECTOR_PII,
  GUARD_DETECTOR_PROMPT_LEAK,
  GUARD_EDIT_REQUIRED,
  GUARD_FAIL_ALLOW,
  GUARD_FAIL_BLOCK,
  GUARD_FAIL_MODE_LABEL,
  GUARD_HOLD_CHARS_LABEL,
  GUARD_JUDGE_CRITERIA,
  GUARD_JUDGE_IDENTITY_WARNING,
  GUARD_JUDGE_MODEL,
  GUARD_KEYWORDS_TERMS_LABEL,
  GUARD_LATENCY_NOTICE,
  GUARD_MAX_DELAY_MS_LABEL,
  GUARD_MAX_LENGTH_CHARS,
  GUARD_MODE_BLOCK,
  GUARD_MODE_LABEL,
  GUARD_MODE_LOG,
  GUARD_MODE_OFF,
  GUARD_PATTERN_FLAGS,
  GUARD_PATTERN_NAME,
  GUARD_PATTERN_REGEX,
  GUARD_PII_ACTION_LABEL,
  GUARD_PII_BLOCK,
  GUARD_PII_MASK,
  GUARD_PROMPT_LEAK_SHINGLES,
  GUARD_REMOVE_PATTERN,
  GUARD_REPLACEMENT_LABEL,
  GUARD_REVISION_LABEL,
  GUARD_SAVE_POLICY,
  GUARD_SAVING_POLICY,
} from '../output-guard-strings';

export interface GuardPolicyEditorProps {
  scope: Scope;
  policy: GuardPolicyView;
  canEdit: boolean;
  saving: boolean;
  error: string | null;
  savedMessage: string | null;
  onChange: (next: GuardPolicyView) => void;
  onSave: () => void;
}

export function GuardPolicyEditor({
  scope,
  policy,
  canEdit,
  saving,
  error,
  savedMessage,
  onChange,
  onSave,
}: GuardPolicyEditorProps) {
  const tc = useCustomT();
  const { detectors } = policy;

  const hasPatternRules = detectors.patterns.enabled && detectors.patterns.rules.length > 0;
  const hasExternalChecks = detectors.moderation.enabled || detectors.judge.enabled;
  const showJudgeIdentityWarning = detectors.judge.enabled && scope.kind === 'support_tenant';

  function updateDetectors(patch: Partial<GuardPolicyView['detectors']>) {
    onChange({
      ...policy,
      detectors: {
        ...policy.detectors,
        ...patch,
      },
    });
  }

  function addPatternRule() {
    if (detectors.patterns.rules.length >= OUTPUT_GUARD_LIMITS.maxPatterns) return;
    const nextIdx = detectors.patterns.rules.length + 1;
    const nextRule: GuardPatternRule = {
      id: `rule-${Date.now()}-${nextIdx}`,
      name: `Rule ${nextIdx}`,
      pattern: '',
      flags: 'i',
    };
    updateDetectors({
      patterns: {
        ...detectors.patterns,
        rules: [...detectors.patterns.rules, nextRule],
      },
    });
  }

  function updatePatternRule(index: number, patch: Partial<GuardPatternRule>) {
    const nextRules = detectors.patterns.rules.map((rule, idx) =>
      idx === index ? { ...rule, ...patch } : rule,
    );
    updateDetectors({
      patterns: { ...detectors.patterns, rules: nextRules },
    });
  }

  function removePatternRule(index: number) {
    const nextRules = detectors.patterns.rules.filter((_, idx) => idx !== index);
    updateDetectors({
      patterns: { ...detectors.patterns, rules: nextRules },
    });
  }

  return (
    <section className="rounded-lg border p-4 space-y-4" data-testid="guard-policy-editor">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground" data-testid="guard-policy-revision">
          {tc(GUARD_REVISION_LABEL)}: {policy.revision}
        </span>
        {!canEdit && (
          <span className="text-xs text-amber-700 dark:text-amber-400" data-testid="guard-edit-readonly-notice">
            {tc(GUARD_EDIT_REQUIRED)}
          </span>
        )}
      </div>

      {/* Latency & buffering disclosures */}
      <div className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground space-y-1" data-testid="guard-latency-notice">
        <p>{tc(GUARD_LATENCY_NOTICE)}</p>
        {hasPatternRules && (
          <p className="text-amber-700 dark:text-amber-400" data-testid="guard-buffering-patterns-warning">
            {tc(GUARD_BUFFERING_FULL_PATTERNS)}
          </p>
        )}
        {hasExternalChecks && (
          <p className="text-amber-700 dark:text-amber-400" data-testid="guard-buffering-external-warning">
            {tc(GUARD_BUFFERING_FULL_EXTERNAL)}
          </p>
        )}
        {showJudgeIdentityWarning && (
          <p className="text-amber-700 dark:text-amber-400" data-testid="guard-judge-identity-warning">
            {tc(GUARD_JUDGE_IDENTITY_WARNING)}
          </p>
        )}
        {policy.bufferingReason && policy.bufferingReason !== 'none' && (
          <p className="text-amber-700 dark:text-amber-400" data-testid="guard-server-buffering-reason">
            {policy.bufferingReason}
          </p>
        )}
      </div>

      {/* Core mode & timing controls */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <label className="block space-y-1 text-sm">
          <span className="font-medium">{tc(GUARD_MODE_LABEL)}</span>
          <select
            className="w-full rounded border px-2 py-1.5 text-sm bg-background"
            data-testid="guard-mode-select"
            aria-label={tc(GUARD_MODE_LABEL)}
            disabled={!canEdit}
            value={policy.mode}
            onChange={(e) => onChange({ ...policy, mode: e.target.value as GuardMode })}
          >
            <option value="off">{tc(GUARD_MODE_OFF)}</option>
            <option value="log">{tc(GUARD_MODE_LOG)}</option>
            <option value="block">{tc(GUARD_MODE_BLOCK)}</option>
          </select>
        </label>

        <label className="block space-y-1 text-sm">
          <span className="font-medium">{tc(GUARD_FAIL_MODE_LABEL)}</span>
          <select
            className="w-full rounded border px-2 py-1.5 text-sm bg-background"
            data-testid="guard-fail-mode-select"
            aria-label={tc(GUARD_FAIL_MODE_LABEL)}
            disabled={!canEdit}
            value={policy.failMode}
            onChange={(e) => onChange({ ...policy, failMode: e.target.value as GuardFailMode })}
          >
            <option value="allow">{tc(GUARD_FAIL_ALLOW)}</option>
            <option value="block">{tc(GUARD_FAIL_BLOCK)}</option>
          </select>
        </label>

        <label className="block space-y-1 text-sm">
          <span className="font-medium">{tc(GUARD_HOLD_CHARS_LABEL)}</span>
          <input
            type="number"
            min={0}
            max={OUTPUT_GUARD_LIMITS.maxHoldChars}
            className="w-full rounded border px-2 py-1.5 text-sm bg-background"
            data-testid="guard-hold-chars-input"
            aria-label={tc(GUARD_HOLD_CHARS_LABEL)}
            disabled={!canEdit}
            value={policy.holdChars}
            onChange={(e) => onChange({ ...policy, holdChars: Number(e.target.value) || 0 })}
          />
        </label>

        <label className="block space-y-1 text-sm">
          <span className="font-medium">{tc(GUARD_MAX_DELAY_MS_LABEL)}</span>
          <input
            type="number"
            min={0}
            max={OUTPUT_GUARD_LIMITS.maxDelayMs}
            className="w-full rounded border px-2 py-1.5 text-sm bg-background"
            data-testid="guard-max-delay-input"
            aria-label={tc(GUARD_MAX_DELAY_MS_LABEL)}
            disabled={!canEdit}
            value={policy.maxDelayMs}
            onChange={(e) => onChange({ ...policy, maxDelayMs: Number(e.target.value) || 0 })}
          />
        </label>
      </div>

      {/* Replacement & Bypass roles */}
      <label className="block space-y-1 text-sm">
        <span className="font-medium">{tc(GUARD_REPLACEMENT_LABEL)}</span>
        <textarea
          rows={2}
          maxLength={OUTPUT_GUARD_LIMITS.replacementMaxChars}
          className="w-full rounded border px-2 py-1.5 text-sm bg-background"
          data-testid="guard-replacement-input"
          aria-label={tc(GUARD_REPLACEMENT_LABEL)}
          disabled={!canEdit}
          value={policy.replacementText}
          onChange={(e) => onChange({ ...policy, replacementText: e.target.value })}
        />
      </label>

      <div className="space-y-1 text-sm">
        <label className="block space-y-1">
          <span className="font-medium">{tc(GUARD_BYPASS_ROLES_LABEL)}</span>
          <input
            type="text"
            className="w-full rounded border px-2 py-1.5 text-sm bg-background"
            data-testid="guard-bypass-roles-input"
            aria-label={tc(GUARD_BYPASS_ROLES_LABEL)}
            disabled={!canEdit}
            value={policy.bypassRoles.join(', ')}
            onChange={(e) =>
              onChange({
                ...policy,
                bypassRoles: e.target.value
                  .split(',')
                  .map((r) => r.trim())
                  .filter(Boolean),
              })
            }
          />
        </label>
        <p className="text-xs text-muted-foreground" data-testid="guard-bypass-roles-warning">
          {tc(GUARD_BYPASS_ROLES_WARNING)}
        </p>
      </div>

      {/* Detectors */}
      <div className="space-y-3 border-t pt-3">
        <h3 className="text-sm font-semibold">{tc(GUARD_DETECTORS_HEADING)}</h3>

        {/* Keywords */}
        <div className="rounded border p-3 space-y-2">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              data-testid="guard-detector-keywords-toggle"
              disabled={!canEdit}
              checked={detectors.keywords.enabled}
              onChange={(e) =>
                updateDetectors({ keywords: { ...detectors.keywords, enabled: e.target.checked } })
              }
            />
            <span>{tc(GUARD_DETECTOR_KEYWORDS)}</span>
          </label>
          {detectors.keywords.enabled && (
            <label className="block space-y-1 text-xs">
              <span className="text-muted-foreground">{tc(GUARD_KEYWORDS_TERMS_LABEL)}</span>
              <textarea
                rows={3}
                className="w-full rounded border px-2 py-1 text-xs bg-background font-mono"
                data-testid="guard-keywords-terms-input"
                aria-label={tc(GUARD_KEYWORDS_TERMS_LABEL)}
                disabled={!canEdit}
                value={detectors.keywords.terms.join('\n')}
                onChange={(e) =>
                  updateDetectors({
                    keywords: {
                      ...detectors.keywords,
                      terms: e.target.value
                        .split('\n')
                        .map((t) => t.trim())
                        .filter(Boolean),
                    },
                  })
                }
              />
            </label>
          )}
        </div>

        {/* Patterns */}
        <div className="rounded border p-3 space-y-2">
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                data-testid="guard-detector-patterns-toggle"
                disabled={!canEdit}
                checked={detectors.patterns.enabled}
                onChange={(e) =>
                  updateDetectors({ patterns: { ...detectors.patterns, enabled: e.target.checked } })
                }
              />
              <span>{tc(GUARD_DETECTOR_PATTERNS)}</span>
            </label>
            {detectors.patterns.enabled && canEdit && (
              <button
                type="button"
                className="rounded border px-2 py-1 text-xs hover:bg-muted"
                data-testid="guard-add-pattern-btn"
                onClick={addPatternRule}
              >
                {tc(GUARD_ADD_PATTERN)}
              </button>
            )}
          </div>
          {detectors.patterns.enabled && detectors.patterns.rules.map((rule, idx) => (
            <div key={rule.id || idx} className="grid grid-cols-1 md:grid-cols-4 gap-2 items-center">
              <input
                type="text"
                placeholder={tc(GUARD_PATTERN_NAME)}
                aria-label={tc(GUARD_PATTERN_NAME)}
                className="rounded border px-2 py-1 text-xs bg-background"
                disabled={!canEdit}
                value={rule.name}
                onChange={(e) => updatePatternRule(idx, { name: e.target.value })}
              />
              <input
                type="text"
                placeholder={tc(GUARD_PATTERN_REGEX)}
                aria-label={tc(GUARD_PATTERN_REGEX)}
                className="rounded border px-2 py-1 text-xs bg-background font-mono md:col-span-2"
                data-testid={`guard-pattern-regex-${idx}`}
                disabled={!canEdit}
                value={rule.pattern}
                onChange={(e) => updatePatternRule(idx, { pattern: e.target.value })}
              />
              <div className="flex items-center gap-1">
                <input
                  type="text"
                  placeholder={tc(GUARD_PATTERN_FLAGS)}
                  aria-label={tc(GUARD_PATTERN_FLAGS)}
                  className="w-16 rounded border px-2 py-1 text-xs bg-background font-mono"
                  disabled={!canEdit}
                  value={rule.flags}
                  onChange={(e) => updatePatternRule(idx, { flags: e.target.value })}
                />
                {canEdit && (
                  <button
                    type="button"
                    className="rounded border px-2 py-1 text-xs text-destructive hover:bg-muted"
                    onClick={() => removePatternRule(idx)}
                  >
                    {tc(GUARD_REMOVE_PATTERN)}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Prompt Leak & PII & Max Length */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="rounded border p-3 space-y-2">
            <label className="flex items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                data-testid="guard-detector-prompt-leak-toggle"
                disabled={!canEdit}
                checked={detectors.promptLeak.enabled}
                onChange={(e) =>
                  updateDetectors({ promptLeak: { ...detectors.promptLeak, enabled: e.target.checked } })
                }
              />
              <span>{tc(GUARD_DETECTOR_PROMPT_LEAK)}</span>
            </label>
            {detectors.promptLeak.enabled && (
              <label className="block space-y-1 text-xs">
                <span>{tc(GUARD_PROMPT_LEAK_SHINGLES)}</span>
                <input
                  type="number"
                  min={1}
                  max={20}
                  className="w-full rounded border px-2 py-1 text-xs bg-background"
                  disabled={!canEdit}
                  value={detectors.promptLeak.minShingles}
                  onChange={(e) =>
                    updateDetectors({
                      promptLeak: { ...detectors.promptLeak, minShingles: Number(e.target.value) || 2 },
                    })
                  }
                />
              </label>
            )}
          </div>

          <div className="rounded border p-3 space-y-2">
            <label className="flex items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                data-testid="guard-detector-pii-toggle"
                disabled={!canEdit}
                checked={detectors.pii.enabled}
                onChange={(e) =>
                  updateDetectors({ pii: { ...detectors.pii, enabled: e.target.checked } })
                }
              />
              <span>{tc(GUARD_DETECTOR_PII)}</span>
            </label>
            {detectors.pii.enabled && (
              <label className="block space-y-1 text-xs">
                <span>{tc(GUARD_PII_ACTION_LABEL)}</span>
                <select
                  className="w-full rounded border px-2 py-1 text-xs bg-background"
                  data-testid="guard-pii-action-select"
                  disabled={!canEdit}
                  value={detectors.pii.action}
                  onChange={(e) =>
                    updateDetectors({
                      pii: { ...detectors.pii, action: e.target.value as GuardPiiAction },
                    })
                  }
                >
                  <option value="mask">{tc(GUARD_PII_MASK)}</option>
                  <option value="block">{tc(GUARD_PII_BLOCK)}</option>
                </select>
              </label>
            )}
          </div>

          <div className="rounded border p-3 space-y-2">
            <label className="flex items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                data-testid="guard-detector-max-length-toggle"
                disabled={!canEdit}
                checked={detectors.maxLength.enabled}
                onChange={(e) =>
                  updateDetectors({ maxLength: { ...detectors.maxLength, enabled: e.target.checked } })
                }
              />
              <span>{tc(GUARD_DETECTOR_MAX_LENGTH)}</span>
            </label>
            {detectors.maxLength.enabled && (
              <label className="block space-y-1 text-xs">
                <span>{tc(GUARD_MAX_LENGTH_CHARS)}</span>
                <input
                  type="number"
                  min={1}
                  className="w-full rounded border px-2 py-1 text-xs bg-background"
                  disabled={!canEdit}
                  value={detectors.maxLength.chars}
                  onChange={(e) =>
                    updateDetectors({
                      maxLength: { ...detectors.maxLength, chars: Number(e.target.value) || 1 },
                    })
                  }
                />
              </label>
            )}
          </div>
        </div>

        {/* External Moderation & Judge */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="rounded border p-3 space-y-2">
            <label className="flex items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                data-testid="guard-detector-moderation-toggle"
                disabled={!canEdit}
                checked={detectors.moderation.enabled}
                onChange={(e) =>
                  updateDetectors({ moderation: { enabled: e.target.checked } })
                }
              />
              <span>{tc(GUARD_DETECTOR_MODERATION)}</span>
            </label>
          </div>

          <div className="rounded border p-3 space-y-2">
            <label className="flex items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                data-testid="guard-detector-judge-toggle"
                disabled={!canEdit}
                checked={detectors.judge.enabled}
                onChange={(e) =>
                  updateDetectors({ judge: { ...detectors.judge, enabled: e.target.checked } })
                }
              />
              <span>{tc(GUARD_DETECTOR_JUDGE)}</span>
            </label>
            {detectors.judge.enabled && (
              <div className="space-y-2 text-xs">
                <label className="block space-y-1">
                  <span>{tc(GUARD_JUDGE_MODEL)}</span>
                  <input
                    type="text"
                    className="w-full rounded border px-2 py-1 text-xs bg-background"
                    disabled={!canEdit}
                    value={detectors.judge.model}
                    onChange={(e) =>
                      updateDetectors({ judge: { ...detectors.judge, model: e.target.value } })
                    }
                  />
                </label>
                <label className="block space-y-1">
                  <span>{tc(GUARD_JUDGE_CRITERIA)}</span>
                  <textarea
                    rows={2}
                    className="w-full rounded border px-2 py-1 text-xs bg-background"
                    disabled={!canEdit}
                    value={detectors.judge.criteria}
                    onChange={(e) =>
                      updateDetectors({ judge: { ...detectors.judge, criteria: e.target.value } })
                    }
                  />
                </label>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Feedback & Save */}
      {error && (
        <div className="rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert" data-testid="guard-policy-error">
          {error}
        </div>
      )}
      {savedMessage && (
        <div className="rounded border border-emerald-600/30 bg-emerald-600/15 dark:bg-emerald-400/15 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400" data-testid="guard-policy-saved">
          {savedMessage}
        </div>
      )}

      <div className="flex justify-end">
        <button
          type="button"
          className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          data-testid="guard-save-policy-btn"
          disabled={!canEdit || saving}
          onClick={onSave}
        >
          {saving ? tc(GUARD_SAVING_POLICY) : tc(GUARD_SAVE_POLICY)}
        </button>
      </div>
    </section>
  );
}
