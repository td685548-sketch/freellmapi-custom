import { useEffect, useRef, useState } from 'react';
import { useCustomT } from '../../i18n/use-custom-t';
import {
  testGuardPolicy,
  type GuardPolicyView,
  type GuardTestResponse,
  type Scope,
} from '../output-guard-api';
import {
  GUARD_TESTER_DRY_RUN_NOTICE,
  GUARD_TESTER_ERROR,
  GUARD_TESTER_EXTERNAL_WARNING,
  GUARD_TESTER_HEADING,
  GUARD_TESTER_INCLUDE_EXTERNAL,
  GUARD_TESTER_MASKED_TEXT,
  GUARD_TESTER_NO_TRIGGERS,
  GUARD_TESTER_PILLAR_DISABLED,
  GUARD_TESTER_RESULT_ACTION,
  GUARD_TESTER_ROLE_LABEL,
  GUARD_TESTER_ROLE_PLACEHOLDER,
  GUARD_TESTER_RUN,
  GUARD_TESTER_RUNNING,
  GUARD_TESTER_TEXT_LABEL,
  GUARD_TESTER_TEXT_PLACEHOLDER,
  GUARD_TESTER_TRIGGERED,
} from '../output-guard-strings';

export interface PolicyTesterProps {
  scope: Scope;
  policy: GuardPolicyView;
  sessionRevision: number;
  disabled?: boolean;
}

function getErrorStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const rec = err as { status?: number; code?: string };
  return rec.status;
}

export function PolicyTester({ scope, policy, sessionRevision, disabled }: PolicyTesterProps) {
  const tc = useCustomT();
  const [text, setText] = useState('');
  const [role, setRole] = useState('');
  const [includeExternal, setIncludeExternal] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GuardTestResponse | null>(null);

  const epochRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const scopeKey = `${scope.kind}:${scope.id}:${sessionRevision}`;
  const [prevScopeKey, setPrevScopeKey] = useState(scopeKey);
  if (prevScopeKey !== scopeKey) {
    setPrevScopeKey(scopeKey);
    setResult(null);
    setError(null);
    setRunning(false);
  }

  useEffect(() => {
    epochRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    return () => {
      epochRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [scope.kind, scope.id, sessionRevision]);

  async function handleRunTest() {
    if (!text.trim() || disabled) return;
    const epoch = ++epochRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setRunning(true);
    setError(null);
    setResult(null);

    try {
      const res = await testGuardPolicy(
        scope,
        {
          text,
          ...(role.trim() ? { role: role.trim() } : {}),
          policy: {
            mode: policy.mode,
            failMode: policy.failMode,
            detectors: policy.detectors,
            replacementText: policy.replacementText,
            bypassRoles: policy.bypassRoles,
            holdChars: policy.holdChars,
            maxDelayMs: policy.maxDelayMs,
            revision: policy.revision,
          },
          includeExternal,
        },
        controller.signal,
      );
      if (epochRef.current !== epoch) return;
      setResult(res);
    } catch (err) {
      if (controller.signal.aborted || epochRef.current !== epoch) return;
      const status = getErrorStatus(err);
      if (status === 409) {
        setError(tc(GUARD_TESTER_PILLAR_DISABLED));
      } else {
        setError(err instanceof Error && err.message ? err.message : tc(GUARD_TESTER_ERROR));
      }
    } finally {
      if (epochRef.current === epoch) {
        setRunning(false);
      }
    }
  }

  return (
    <section className="rounded-lg border p-4 space-y-3" data-testid="guard-policy-tester">
      <div className="space-y-1">
        <h3 className="text-base font-semibold">{tc(GUARD_TESTER_HEADING)}</h3>
        <p className="text-xs text-muted-foreground" data-testid="guard-tester-dry-run-notice">
          {tc(GUARD_TESTER_DRY_RUN_NOTICE)}
        </p>
      </div>

      <label className="block space-y-1 text-sm">
        <span className="font-medium">{tc(GUARD_TESTER_TEXT_LABEL)}</span>
        <textarea
          rows={4}
          className="w-full rounded border px-2 py-1.5 text-sm bg-background"
          data-testid="guard-tester-text-input"
          aria-label={tc(GUARD_TESTER_TEXT_LABEL)}
          placeholder={tc(GUARD_TESTER_TEXT_PLACEHOLDER)}
          disabled={disabled}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </label>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 items-end">
        <label className="block space-y-1 text-sm">
          <span className="font-medium">{tc(GUARD_TESTER_ROLE_LABEL)}</span>
          <input
            type="text"
            className="w-full rounded border px-2 py-1.5 text-sm bg-background"
            data-testid="guard-tester-role-input"
            aria-label={tc(GUARD_TESTER_ROLE_LABEL)}
            placeholder={tc(GUARD_TESTER_ROLE_PLACEHOLDER)}
            disabled={disabled}
            value={role}
            onChange={(e) => setRole(e.target.value)}
          />
        </label>

        <div className="space-y-1">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              data-testid="guard-tester-include-external"
              disabled={disabled}
              checked={includeExternal}
              onChange={(e) => setIncludeExternal(e.target.checked)}
            />
            <span>{tc(GUARD_TESTER_INCLUDE_EXTERNAL)}</span>
          </label>
          <p className="text-xs text-amber-600" data-testid="guard-tester-external-warning">
            {tc(GUARD_TESTER_EXTERNAL_WARNING)}
          </p>
        </div>
      </div>

      <div className="flex justify-end">
        <button
          type="button"
          className="rounded bg-secondary px-4 py-1.5 text-sm font-medium text-secondary-foreground disabled:opacity-50"
          data-testid="guard-tester-run-btn"
          disabled={disabled || running || !text.trim()}
          onClick={handleRunTest}
        >
          {running ? tc(GUARD_TESTER_RUNNING) : tc(GUARD_TESTER_RUN)}
        </button>
      </div>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700" role="alert" data-testid="guard-tester-error">
          {error}
        </div>
      )}

      {result && (
        <div className="rounded border bg-muted/30 p-3 space-y-2 text-sm" data-testid="guard-tester-result">
          <div className="flex items-center gap-2">
            <span className="font-medium">{tc(GUARD_TESTER_RESULT_ACTION)}:</span>
            <span className="rounded bg-muted px-2 py-0.5 font-mono text-xs" data-testid="guard-tester-result-action">
              {result.action}
            </span>
          </div>

          {result.buffering && result.bufferingReason !== 'none' && (
            <p className="text-xs text-amber-600" data-testid="guard-tester-buffering-reason">
              {result.bufferingReason}
            </p>
          )}

          {result.warnings?.map((w, idx) => (
            <p key={idx} className="text-xs text-amber-600">
              {w}
            </p>
          ))}

          <div>
            <p className="text-xs font-medium text-muted-foreground">{tc(GUARD_TESTER_TRIGGERED)}</p>
            {result.triggered.length === 0 ? (
              <p className="text-xs text-muted-foreground">{tc(GUARD_TESTER_NO_TRIGGERS)}</p>
            ) : (
              <ul className="list-disc pl-5 text-xs space-y-0.5" data-testid="guard-tester-triggered-list">
                {result.triggered.map((t, idx) => (
                  <li key={`${t.detector}-${idx}`}>
                    <span className="font-mono">{t.detector}</span>: {t.match}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <p className="text-xs font-medium text-muted-foreground">{tc(GUARD_TESTER_MASKED_TEXT)}</p>
            <pre className="mt-1 whitespace-pre-wrap rounded border bg-background p-2 text-xs" data-testid="guard-tester-masked-text">
              {result.maskedText}
            </pre>
          </div>
        </div>
      )}
    </section>
  );
}
