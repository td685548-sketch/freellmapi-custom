import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCustomT } from '../../i18n/use-custom-t';
import { useAdministrativeAccess } from '../../use-administrative-access';
import { useUserSession } from '../../use-session';
import { GuardEvents } from '../components/GuardEvents';
import { GuardPolicyEditor } from '../components/GuardPolicyEditor';
import { PolicyTester } from '../components/PolicyTester';
import {
  fetchCredentialScrubSettings,
  putCredentialScrubSettings,
} from '../eval-canary-api';
import {
  SCRUB_ENABLE_TOGGLE_LABEL,
  SCRUB_ERROR_MSG,
  SCRUB_SAVED_MSG,
  SCRUB_SAVING_LABEL,
  SCRUB_SECTION_HEADING,
  SCRUB_SECTION_SUBTITLE,
} from '../eval-canary-strings';
import {
  createDefaultGuardPolicy,
  fetchGuardPolicy,
  fetchGuardProfileOptions,
  fetchGuardSupportTenantOptions,
  putGuardPolicy,
  type GuardPolicyView,
  type ProfileOption,
  type Scope,
  type ScopeKind,
  type SupportTenantOption,
} from '../output-guard-api';
import {
  GUARD_AGENT_UNAVAILABLE,
  GUARD_CONFLICT_409,
  GUARD_LOADING_POLICY,
  GUARD_LOAD_POLICY_ERROR,
  GUARD_NO_PERMISSION,
  GUARD_PAGE_SUBTITLE,
  GUARD_PAGE_TITLE,
  GUARD_POLICY_SAVED,
  GUARD_SAVE_ERROR,
  GUARD_SCOPE_AGENT,
  GUARD_SCOPE_ID_PLACEHOLDER,
  GUARD_SCOPE_KIND,
  GUARD_SCOPE_PROFILE,
  GUARD_SCOPE_SUPPORT_TENANT,
  GUARD_SCOPE_TARGET,
  GUARD_TAB_EVENTS,
  GUARD_TAB_POLICY,
  GUARD_VALIDATION_422,
  GUARD_VIEW_REQUIRED_FOR_POLICY,
} from '../output-guard-strings';

type OutputGuardTab = 'policy' | 'events';

function getErrorStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  return (err as { status?: number }).status;
}

export function OutputGuard() {
  const tc = useCustomT();
  const { can, identity } = useAdministrativeAccess();
  const { isPrimary, session } = useUserSession();

  const canView = isPrimary || can('view_output_guard');
  const canEdit = isPrimary || can('edit_output_guard');
  const canViewExcerpts = isPrimary || can('view_guard_excerpts');

  // Track session/identity revision for query isolation
  const sessionRevision = useMemo(() => {
    const uid = session?.userId ?? 0;
    return uid * 1000 + identity.length;
  }, [session?.userId, identity]);

  const [tab, setTab] = useState<OutputGuardTab>(() => (!canView && !canEdit && canViewExcerpts ? 'events' : 'policy'));
  const activeTab: OutputGuardTab = !canView && !canEdit && canViewExcerpts ? 'events' : tab;
  const [scopeKind, setScopeKind] = useState<ScopeKind>('profile');
  const [scopeId, setScopeId] = useState('1');
  const [profiles, setProfiles] = useState<ProfileOption[]>([]);
  const [tenants, setTenants] = useState<SupportTenantOption[]>([]);

  const scope: Scope = useMemo(() => ({ kind: scopeKind, id: scopeId.trim() }), [scopeKind, scopeId]);

  const [policy, setPolicy] = useState<GuardPolicyView>(() => createDefaultGuardPolicy({ kind: 'profile', id: '1' }));
  const [loadingPolicy, setLoadingPolicy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  const [credentialScrubEnabled, setCredentialScrubEnabled] = useState(false);
  const [savingScrub, setSavingScrub] = useState(false);
  const [scrubFeedback, setScrubFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const saveEpochRef = useRef(0);
  const saveAbortRef = useRef<AbortController | null>(null);
  const policyEpochRef = useRef(0);
  const policyAbortRef = useRef<AbortController | null>(null);

  const resetScopeMessages = useCallback(() => {
    setSaveError(null);
    setSavedMessage(null);
    setLoadError(null);
    setScrubFeedback(null);
  }, []);

  // Load scope target options only if user has view_output_guard
  useEffect(() => {
    if (!canView) return;
    const controller = new AbortController();

    void fetchGuardProfileOptions(controller.signal)
      .then((list) => {
        if (controller.signal.aborted) return;
        setProfiles(list);
        if (scopeKind === 'profile' && list.length > 0 && !list.some((p) => String(p.id) === scopeId)) {
          setScopeId(String(list[0].id));
        }
      })
      .catch(() => {
        // Optional dropdown enrichment; manual ID input still works
      });

    void fetchGuardSupportTenantOptions(controller.signal)
      .then((list) => {
        if (controller.signal.aborted) return;
        setTenants(list);
      })
      .catch(() => {
        // Optional dropdown enrichment
      });

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canView, sessionRevision]);

  const loadPolicy = useCallback(async () => {
    // Never send unauthorized GET when user lacks view_output_guard
    if (!canView || scope.kind === 'agent' || !scope.id) return;

    const epoch = ++policyEpochRef.current;
    policyAbortRef.current?.abort();
    const controller = new AbortController();
    policyAbortRef.current = controller;

    setLoadingPolicy(true);
    setLoadError(null);
    setSaveError(null);
    setSavedMessage(null);

    try {
      const [res, scrubRes] = await Promise.all([
        fetchGuardPolicy(scope, controller.signal),
        fetchCredentialScrubSettings(scope, controller.signal).catch(() => null),
      ]);
      if (policyEpochRef.current !== epoch) return;
      if (res?.policy) {
        setPolicy(res.policy);
      }
      setCredentialScrubEnabled(Boolean(scrubRes?.credentialStreamScrubEnabled));
    } catch (err) {
      if (controller.signal.aborted || policyEpochRef.current !== epoch) return;
      setLoadError(err instanceof Error && err.message ? err.message : tc(GUARD_LOAD_POLICY_ERROR));
    } finally {
      if (policyEpochRef.current === epoch) {
        setLoadingPolicy(false);
      }
    }
  }, [canView, scope, tc]);

  useEffect(() => {
    if (scope.kind === 'agent' || !canView || !scope.id) {
      policyEpochRef.current += 1;
      policyAbortRef.current?.abort();
      return;
    }

    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        void loadPolicy();
      }
    });

    return () => {
      cancelled = true;
      policyEpochRef.current += 1;
      policyAbortRef.current?.abort();
      policyAbortRef.current = null;
    };
  }, [canView, scope, sessionRevision, loadPolicy]);

  useEffect(() => {
    const epoch = ++saveEpochRef.current;
    saveAbortRef.current?.abort();
    saveAbortRef.current = null;
    queueMicrotask(() => {
      if (saveEpochRef.current !== epoch) return;
      setSaving(false);
      resetScopeMessages();
    });
    return () => {
      saveEpochRef.current += 1;
      saveAbortRef.current?.abort();
    };
  }, [scope, identity, canEdit, resetScopeMessages]);

  async function handleSavePolicy() {
    if (!canEdit || scope.kind === 'agent' || !scope.id) return;
    const epoch = ++saveEpochRef.current;
    saveAbortRef.current?.abort();
    const controller = new AbortController();
    saveAbortRef.current = controller;
    setSaving(true);
    setSaveError(null);
    setSavedMessage(null);

    try {
      const res = await putGuardPolicy(scope, {
        mode: policy.mode,
        failMode: policy.failMode,
        detectors: policy.detectors,
        replacementText: policy.replacementText,
        bypassRoles: policy.bypassRoles,
        holdChars: policy.holdChars,
        maxDelayMs: policy.maxDelayMs,
        revision: policy.revision,
      }, controller.signal);
      if (controller.signal.aborted || saveEpochRef.current !== epoch) return;
      setPolicy(res.policy);
      setSavedMessage(tc(GUARD_POLICY_SAVED));
    } catch (err) {
      if (controller.signal.aborted || saveEpochRef.current !== epoch) return;
      const status = getErrorStatus(err);
      if (status === 409) {
        if (canView) {
          await loadPolicy();
          if (controller.signal.aborted || saveEpochRef.current !== epoch) return;
        }
        setSaveError(tc(GUARD_CONFLICT_409));
      } else if (status === 422) {
        const detail = err instanceof Error && err.message ? `: ${err.message}` : '';
        setSaveError(`${tc(GUARD_VALIDATION_422)}${detail}`);
      } else {
        setSaveError(err instanceof Error && err.message ? err.message : tc(GUARD_SAVE_ERROR));
      }
    } finally {
      if (saveEpochRef.current === epoch) setSaving(false);
    }
  }

  async function handleToggleCredentialScrub(nextEnabled: boolean) {
    if (!canEdit || scope.kind === 'agent' || !scope.id) return;
    setSavingScrub(true);
    setScrubFeedback(null);
    try {
      const updated = await putCredentialScrubSettings(scope, {
        credentialStreamScrubEnabled: nextEnabled,
      });
      setCredentialScrubEnabled(updated.credentialStreamScrubEnabled);
      setScrubFeedback({ kind: 'ok', text: tc(SCRUB_SAVED_MSG) });
    } catch (err) {
      setScrubFeedback({
        kind: 'err',
        text: err instanceof Error && err.message ? err.message : tc(SCRUB_ERROR_MSG),
      });
    } finally {
      setSavingScrub(false);
    }
  }

  if (!canView && !canEdit && !canViewExcerpts) {
    return (
      <div data-testid="guard-no-permission">
        <p className="text-sm text-muted-foreground">{tc(GUARD_NO_PERMISSION)}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="output-guard-page">
      <header className="space-y-1">
        <h2 className="text-lg font-semibold">{tc(GUARD_PAGE_TITLE)}</h2>
        <p className="text-sm text-muted-foreground">{tc(GUARD_PAGE_SUBTITLE)}</p>
      </header>

      {/* Tabs */}
      <div className="flex gap-2 border-b pb-2" role="tablist">
        {(canView || canEdit) && (
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'policy'}
            data-testid="guard-tab-policy"
            className={`px-3 py-1.5 rounded text-sm font-medium ${
              activeTab === 'policy' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted'
            }`}
            onClick={() => setTab('policy')}
          >
            {tc(GUARD_TAB_POLICY)}
          </button>
        )}
        {(canView || canViewExcerpts) && (
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'events'}
            data-testid="guard-tab-events"
            className={`px-3 py-1.5 rounded text-sm font-medium ${
              activeTab === 'events' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted'
            }`}
            onClick={() => setTab('events')}
          >
            {tc(GUARD_TAB_EVENTS)}
          </button>
        )}
      </div>

      {/* Scope selector (shown on policy tab or when user canView events) */}
      {(activeTab === 'policy' || canView) && (
        <div className="flex flex-wrap items-end gap-4 rounded-lg border p-3">
          <label className="space-y-1 text-xs">
            <span className="font-medium">{tc(GUARD_SCOPE_KIND)}</span>
            <select
              className="block rounded border px-2 py-1.5 text-sm bg-background"
              data-testid="guard-scope-kind-select"
              aria-label={tc(GUARD_SCOPE_KIND)}
              value={scopeKind}
              onChange={(e) => {
                resetScopeMessages();
                const nextKind = e.target.value as ScopeKind;
                setScopeKind(nextKind);
                let nextId = '1';
                if (nextKind === 'profile' && profiles.length > 0) {
                  nextId = String(profiles[0].id);
                } else if (nextKind === 'support_tenant' && tenants.length > 0) {
                  nextId = tenants[0].id;
                }
                setScopeId(nextId);
                if (!canView || nextKind === 'agent') {
                  setPolicy(createDefaultGuardPolicy({ kind: nextKind, id: nextId }));
                }
              }}
            >
              <option value="profile">{tc(GUARD_SCOPE_PROFILE)}</option>
              <option value="support_tenant">{tc(GUARD_SCOPE_SUPPORT_TENANT)}</option>
              <option value="agent">{tc(GUARD_SCOPE_AGENT)}</option>
            </select>
          </label>

          <label className="space-y-1 text-xs flex-1 min-w-[200px]">
            <span className="font-medium">{tc(GUARD_SCOPE_TARGET)}</span>
            {scopeKind === 'profile' && profiles.length > 0 ? (
              <select
                className="block w-full rounded border px-2 py-1.5 text-sm bg-background"
                data-testid="guard-scope-target-select"
                aria-label={tc(GUARD_SCOPE_TARGET)}
                value={scopeId}
                onChange={(e) => {
                  resetScopeMessages();
                  setScopeId(e.target.value);
                }}
              >
                {profiles.map((p) => (
                  <option key={p.id} value={String(p.id)}>
                    {p.name} (#{p.id})
                  </option>
                ))}
              </select>
            ) : scopeKind === 'support_tenant' && tenants.length > 0 ? (
              <select
                className="block w-full rounded border px-2 py-1.5 text-sm bg-background"
                data-testid="guard-scope-target-select"
                aria-label={tc(GUARD_SCOPE_TARGET)}
                value={scopeId}
                onChange={(e) => {
                  resetScopeMessages();
                  setScopeId(e.target.value);
                }}
              >
                {tenants.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.id})
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                className="block w-full rounded border px-2 py-1.5 text-sm bg-background"
                data-testid="guard-scope-id-input"
                aria-label={tc(GUARD_SCOPE_TARGET)}
                placeholder={tc(GUARD_SCOPE_ID_PLACEHOLDER)}
                value={scopeId}
                onChange={(e) => {
                  resetScopeMessages();
                  setScopeId(e.target.value);
                }}
              />
            )}
          </label>
        </div>
      )}

      {activeTab === 'policy' && (canView || canEdit) && (
        <div className="space-y-6">
          {!canView && canEdit && (
            <div className="rounded border border-amber-600/30 bg-amber-600/15 dark:bg-amber-400/15 px-3 py-2 text-xs text-amber-700 dark:text-amber-400" data-testid="guard-editor-only-notice">
              {tc(GUARD_VIEW_REQUIRED_FOR_POLICY)}
            </div>
          )}

          {scopeKind === 'agent' ? (
            <div className="rounded border p-4 text-sm text-muted-foreground" data-testid="guard-agent-unavailable">
              {tc(GUARD_AGENT_UNAVAILABLE)}
            </div>
          ) : loadingPolicy ? (
            <p className="text-sm text-muted-foreground" data-testid="guard-policy-loading">
              {tc(GUARD_LOADING_POLICY)}
            </p>
          ) : loadError ? (
            <div className="rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert" data-testid="guard-policy-load-error">
              {loadError}
            </div>
          ) : (
            <>
              <section
                className="rounded-lg border p-4 space-y-2.5"
                data-testid="guard-credential-scrub-section"
              >
                <div className="space-y-1">
                  <h3 className="text-sm font-semibold">{tc(SCRUB_SECTION_HEADING)}</h3>
                  <p className="text-xs text-muted-foreground">{tc(SCRUB_SECTION_SUBTITLE)}</p>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label className="flex items-center gap-2 text-sm font-medium">
                    <input
                      type="checkbox"
                      data-testid="guard-credential-scrub-toggle"
                      disabled={!canEdit || savingScrub}
                      checked={credentialScrubEnabled}
                      onChange={(e) => void handleToggleCredentialScrub(e.target.checked)}
                    />
                    <span>{tc(SCRUB_ENABLE_TOGGLE_LABEL)}</span>
                  </label>
                  {savingScrub && (
                    <span className="text-xs text-muted-foreground">{tc(SCRUB_SAVING_LABEL)}</span>
                  )}
                </div>
                {scrubFeedback && (
                  <div
                    role={scrubFeedback.kind === 'err' ? 'alert' : undefined}
                    data-testid="guard-credential-scrub-feedback"
                    className={`rounded border px-3 py-1.5 text-xs ${
                      scrubFeedback.kind === 'err'
                        ? 'border-destructive/30 bg-destructive/10 text-destructive'
                        : 'border-emerald-600/30 bg-emerald-600/15 text-emerald-700 dark:text-emerald-400'
                    }`}
                  >
                    {scrubFeedback.text}
                  </div>
                )}
              </section>

              <GuardPolicyEditor
                scope={scope}
                policy={policy}
                canEdit={canEdit}
                saving={saving}
                error={saveError}
                savedMessage={savedMessage}
                onChange={setPolicy}
                onSave={() => void handleSavePolicy()}
              />
              {canView && (
                <PolicyTester
                  scope={scope}
                  policy={policy}
                  sessionRevision={sessionRevision}
                  disabled={!scope.id}
                />
              )}
            </>
          )}
        </div>
      )}

      {activeTab === 'events' && (canView || canViewExcerpts) && (
        <GuardEvents
          canViewEvents={canView}
          canViewExcerpts={canViewExcerpts}
          scope={canView && scopeKind !== 'agent' && scope.id ? scope : undefined}
          sessionRevision={sessionRevision}
        />
      )}
    </div>
  );
}
