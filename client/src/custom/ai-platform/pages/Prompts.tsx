import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCustomT } from '../../i18n/use-custom-t';
import { useSessionRevision } from '../../session-state';
import { useAdministrativeAccess } from '../../use-administrative-access';
import { useUserSession } from '../../use-session';
import { DiffView } from '../components/DiffView';
import { VariableEditor } from '../components/VariableEditor';
import {
  PROMPT_LIMITS,
  SYSTEM_PROMPT_VARIABLES,
  discardPromptDraft,
  fetchPromptDiff,
  fetchPromptProfileOptions,
  fetchPromptScopeState,
  fetchPromptSupportTenantOptions,
  fetchPromptVersion,
  fetchSystemPromptVariables,
  getPromptErrorInfo,
  previewPrompt,
  publishPrompt,
  restorePromptVersion,
  savePromptDraft,
  tryPrompt,
  type ProfileOption,
  type PromptDiffResponse,
  type PromptPreviewResponse,
  type PromptScopeStateResponse,
  type PromptTryResponse,
  type PromptVariable,
  type PromptVersion,
  type PromptVersionStatus,
  type Scope,
  type ScopeKind,
  type SupportTenantOption,
  type SystemPromptVariableDescriptor,
} from '../prompts-api';
import {
  PROMPTS_AUTHOR_LABEL,
  PROMPTS_AUTHOR_SYSTEM,
  PROMPTS_BODY_CHARS,
  PROMPTS_BODY_LABEL,
  PROMPTS_BODY_PLACEHOLDER,
  PROMPTS_CLOSE_BTN,
  PROMPTS_COMPARE_BTN,
  PROMPTS_CONFLICT_BANNER,
  PROMPTS_CONFLICT_RELOAD_BTN,
  PROMPTS_DIFF_ERROR,
  PROMPTS_DISCARDING_DRAFT_BTN,
  PROMPTS_DISCARD_DRAFT_BTN,
  PROMPTS_DISCARD_ERROR,
  PROMPTS_DRAFT_DISCARDED,
  PROMPTS_DRAFT_SAVED,
  PROMPTS_EDITOR_HEADING,
  PROMPTS_EDITOR_ONLY_NOTICE,
  PROMPTS_FORBIDDEN_ERROR,
  PROMPTS_HEAD_DRAFT,
  PROMPTS_HEAD_NO_DRAFT,
  PROMPTS_HEAD_NO_PUBLISHED,
  PROMPTS_HEAD_PUBLISHED,
  PROMPTS_HEAD_REVISION,
  PROMPTS_HISTORY_EMPTY,
  PROMPTS_HISTORY_HEADING,
  PROMPTS_LOADING,
  PROMPTS_LOAD_ERROR,
  PROMPTS_LOAD_INTO_EDITOR_BTN,
  PROMPTS_NOTE_LABEL,
  PROMPTS_NOTE_PLACEHOLDER,
  PROMPTS_NO_NOTE,
  PROMPTS_NO_PERMISSION,
  PROMPTS_NO_PUBLISH_NOTICE,
  PROMPTS_PAGE_SUBTITLE,
  PROMPTS_PAGE_TITLE,
  PROMPTS_PREVIEWING_BTN,
  PROMPTS_PREVIEW_BTN,
  PROMPTS_PREVIEW_ERROR,
  PROMPTS_PREVIEW_MISSING_LABEL,
  PROMPTS_PREVIEW_RENDERED_LABEL,
  PROMPTS_PREVIEW_TRY_HEADING,
  PROMPTS_PRUNED_NOTICE,
  PROMPTS_PUBLISHED_SUCCESS,
  PROMPTS_PUBLISHING_BTN,
  PROMPTS_PUBLISH_BTN,
  PROMPTS_PUBLISH_ERROR,
  PROMPTS_RELOAD_BTN,
  PROMPTS_RESTORED_FROM,
  PROMPTS_RESTORED_SUCCESS,
  PROMPTS_RESTORE_BTN,
  PROMPTS_RESTORE_CANCEL_BTN,
  PROMPTS_RESTORE_CONFIRM_BTN,
  PROMPTS_RESTORE_CONFIRM_TEXT,
  PROMPTS_RESTORE_ERROR,
  PROMPTS_RETRY,
  PROMPTS_SAMPLE_VALUES_EMPTY,
  PROMPTS_SAMPLE_VALUES_HEADING,
  PROMPTS_SAVE_DRAFT_BTN,
  PROMPTS_SAVE_ERROR,
  PROMPTS_SAVING_DRAFT_BTN,
  PROMPTS_SCOPE_ID_PLACEHOLDER,
  PROMPTS_SCOPE_KIND,
  PROMPTS_SCOPE_PROFILE,
  PROMPTS_SCOPE_SUPPORT_TENANT,
  PROMPTS_SCOPE_TARGET,
  PROMPTS_SESSION_EXPIRED,
  PROMPTS_STATUS_ARCHIVED,
  PROMPTS_STATUS_DRAFT,
  PROMPTS_STATUS_PUBLISHED,
  PROMPTS_TRYING_BTN,
  PROMPTS_TRY_BTN,
  PROMPTS_TRY_ERROR,
  PROMPTS_TRY_HEADING,
  PROMPTS_TRY_MESSAGE_LABEL,
  PROMPTS_TRY_MESSAGE_PLACEHOLDER,
  PROMPTS_TRY_MODEL_LABEL,
  PROMPTS_TRY_MODEL_PLACEHOLDER,
  PROMPTS_TRY_PILLAR_DISABLED,
  PROMPTS_TRY_QUOTA_NOTE,
  PROMPTS_TRY_REPLY_LABEL,
  PROMPTS_TRY_USAGE_LABEL,
  PROMPTS_VALIDATION_GENERIC,
  PROMPTS_VALIDATION_LOCATION,
  PROMPTS_VERSION_DETAIL_ERROR,
  PROMPTS_VERSION_DETAIL_HEADING,
  PROMPTS_VERSION_DETAIL_LOADING,
  PROMPTS_VIEW_BTN,
  PROMPTS_VIEW_ONLY_NOTICE,
} from '../prompts-strings';

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException
    ? err.name === 'AbortError'
    : typeof err === 'object' && err !== null && (err as { name?: string }).name === 'AbortError';
}

function formatApiError(
  err: unknown,
  fallback: string,
  tc: (key: string, params?: Record<string, string | number>) => string,
): string {
  const info = getPromptErrorInfo(err);
  if (info.status === 401) return tc(PROMPTS_SESSION_EXPIRED);
  if (info.status === 403) {
    return info.message && info.message !== 'Request failed'
      ? `${tc(PROMPTS_FORBIDDEN_ERROR)} (${info.message})`
      : tc(PROMPTS_FORBIDDEN_ERROR);
  }
  return info.message && info.message !== 'Request failed' ? info.message : fallback;
}

function formatStatusBadge(status: PromptVersionStatus, tc: (key: string) => string): string {
  if (status === 'published') return tc(PROMPTS_STATUS_PUBLISHED);
  if (status === 'draft') return tc(PROMPTS_STATUS_DRAFT);
  return tc(PROMPTS_STATUS_ARCHIVED);
}

function extractTemplateVariableNames(body: string, declared: readonly PromptVariable[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  const pattern = /\{\{\s*([a-z][a-z0-9_]{0,31})\s*\}\}/g;
  for (const match of body.matchAll(pattern)) {
    const name = match[1];
    if (name && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  for (const v of declared) {
    if (v.name && !seen.has(v.name)) {
      seen.add(v.name);
      names.push(v.name);
    }
  }
  return names;
}

export function Prompts() {
  const tc = useCustomT();
  const { can, identity } = useAdministrativeAccess();
  const { isPrimary, session } = useUserSession();
  const globalSessionRev = useSessionRevision();

  const canView = isPrimary || can('view_prompts');
  const canEdit = isPrimary || can('edit_prompts');
  const canPublish = isPrimary || can('publish_prompts');

  const sessionRevision = useMemo(() => {
    const uid = session?.userId ?? 0;
    let idHash = 0;
    for (let i = 0; i < identity.length; i += 1) {
      idHash = (idHash * 31 + identity.charCodeAt(i)) | 0;
    }
    return uid * 10_000 + Math.abs(idHash % 1000) + globalSessionRev * 1000;
  }, [session?.userId, identity, globalSessionRev]);

  if (!canView && !canEdit && !canPublish) {
    return (
      <div data-testid="prompts-no-permission">
        <p className="text-sm text-muted-foreground">{tc(PROMPTS_NO_PERMISSION)}</p>
      </div>
    );
  }

  return (
    <PromptsContent
      key={sessionRevision}
      sessionRevision={sessionRevision}
      canView={canView}
      canEdit={canEdit}
      canPublish={canPublish}
    />
  );
}

function PromptsContent({
  sessionRevision,
  canView,
  canEdit,
  canPublish,
}: {
  sessionRevision: number;
  canView: boolean;
  canEdit: boolean;
  canPublish: boolean;
}) {
  const tc = useCustomT();

  // Scope state
  const [scopeKind, setScopeKind] = useState<'profile' | 'support_tenant'>('profile');
  const [scopeId, setScopeId] = useState('1');
  const [profiles, setProfiles] = useState<ProfileOption[]>([]);
  const [tenants, setTenants] = useState<SupportTenantOption[]>([]);
  const scope: Scope = useMemo(
    () => ({ kind: scopeKind as ScopeKind, id: scopeId.trim() }),
    [scopeKind, scopeId],
  );

  // System variable catalog
  const [systemVariables, setSystemVariables] = useState<readonly SystemPromptVariableDescriptor[]>(
    SYSTEM_PROMPT_VARIABLES,
  );

  // Loaded scope state
  const [scopeState, setScopeState] = useState<PromptScopeStateResponse | null>(null);
  const [loadingScope, setLoadingScope] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Editor state
  const [body, setBody] = useState('');
  const [variables, setVariables] = useState<PromptVariable[]>([]);
  const [note, setNote] = useState('');
  const [revision, setRevision] = useState(1);
  const [editorHasLocalDraft, setEditorHasLocalDraft] = useState(false);

  // Mutation feedback state
  const [savingDraft, setSavingDraft] = useState(false);
  const [discardingDraft, setDiscardingDraft] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [restoringVersion, setRestoringVersion] = useState<number | null>(null);
  const [pendingRestoreVersion, setPendingRestoreVersion] = useState<number | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [conflictError, setConflictError] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  // Version detail modal/panel state
  const [viewingVersion, setViewingVersion] = useState<PromptVersion | null>(null);
  const [loadingVersionDetail, setLoadingVersionDetail] = useState(false);
  const [versionDetailError, setVersionDetailError] = useState<string | null>(null);

  // Diff state
  const [diffFromVersion, setDiffFromVersion] = useState<number | null>(null);
  const [diffToVersion, setDiffToVersion] = useState<number | null>(null);
  const [diffData, setDiffData] = useState<PromptDiffResponse | null>(null);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);

  // Preview & Try state
  const [sampleValues, setSampleValues] = useState<Record<string, string>>({});
  const [previewing, setPreviewing] = useState(false);
  const [previewResult, setPreviewResult] = useState<PromptPreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [tryMessage, setTryMessage] = useState('');
  const [tryModel, setTryModel] = useState('');
  const [trying, setTrying] = useState(false);
  const [tryResult, setTryResult] = useState<PromptTryResponse | null>(null);
  const [tryError, setTryError] = useState<string | null>(null);

  // Refs for abort + epoch safety
  const mountedRef = useRef(true);
  const scopeEpochRef = useRef(0);
  const scopeAbortRef = useRef<AbortController | null>(null);
  const diffEpochRef = useRef(0);
  const diffAbortRef = useRef<AbortController | null>(null);
  const mutAbortRef = useRef<AbortController | null>(null);
  const versionDetailAbortRef = useRef<AbortController | null>(null);
  const previewAbortRef = useRef<AbortController | null>(null);
  const tryAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      scopeAbortRef.current?.abort();
      diffAbortRef.current?.abort();
      mutAbortRef.current?.abort();
      versionDetailAbortRef.current?.abort();
      previewAbortRef.current?.abort();
      tryAbortRef.current?.abort();
    };
  }, []);

  const clearFeedback = useCallback(() => {
    setValidationError(null);
    setConflictError(false);
    setActionError(null);
    setActionSuccess(null);
  }, []);

  // Load profile / tenant dropdowns and system variable catalog ONLY when canView
  useEffect(() => {
    if (!canView) return;
    const controller = new AbortController();

    void fetchPromptProfileOptions(controller.signal)
      .then((list) => {
        if (!mountedRef.current || controller.signal.aborted) return;
        setProfiles(list);
        if (scopeKind === 'profile' && list.length > 0 && !list.some((p) => String(p.id) === scopeId)) {
          setScopeId(String(list[0].id));
        }
      })
      .catch(() => {
        // Optional enrichment; manual ID input remains available
      });

    void fetchPromptSupportTenantOptions(controller.signal)
      .then((list) => {
        if (!mountedRef.current || controller.signal.aborted) return;
        setTenants(list);
      })
      .catch(() => {
        // Optional enrichment
      });

    void fetchSystemPromptVariables(controller.signal)
      .then((res) => {
        if (!mountedRef.current || controller.signal.aborted) return;
        if (Array.isArray(res?.variables) && res.variables.length > 0) {
          setSystemVariables(res.variables);
        }
      })
      .catch(() => {
        // Fallback to shared SYSTEM_PROMPT_VARIABLES
      });

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canView, sessionRevision]);

  const applyScopeState = useCallback((res: PromptScopeStateResponse) => {
    setScopeState(res);
    setRevision(res.head.revision);
    const active = res.draft ?? res.published;
    if (active) {
      setBody(active.body);
      setVariables(active.variables ?? []);
      setNote(res.draft ? res.draft.note : '');
    } else {
      setBody('');
      setVariables([]);
      setNote('');
    }
    setEditorHasLocalDraft(res.head.draftVersion !== null);

    if (res.versions.length > 0) {
      const latest = res.versions[0].version;
      const toVer = res.head.draftVersion ?? res.head.publishedVersion ?? latest;
      const fromVer = res.versions.find((v) => v.version !== toVer)?.version ?? toVer;
      setDiffFromVersion(fromVer);
      setDiffToVersion(toVer);
    } else {
      setDiffFromVersion(null);
      setDiffToVersion(null);
      setDiffData(null);
    }
  }, []);

  const loadScopeState = useCallback(
    async (opts?: { preserveFeedback?: boolean }) => {
      if (!canView || !scope.id) return;

      const epoch = ++scopeEpochRef.current;
      scopeAbortRef.current?.abort();
      const controller = new AbortController();
      scopeAbortRef.current = controller;

      setLoadingScope(true);
      setLoadError(null);
      if (!opts?.preserveFeedback) {
        clearFeedback();
      }

      try {
        const res = await fetchPromptScopeState(scope, controller.signal);
        if (!mountedRef.current || controller.signal.aborted || scopeEpochRef.current !== epoch) {
          return;
        }
        applyScopeState(res);
      } catch (err) {
        if (
          isAbortError(err) ||
          !mountedRef.current ||
          controller.signal.aborted ||
          scopeEpochRef.current !== epoch
        ) {
          return;
        }
        setLoadError(formatApiError(err, tc(PROMPTS_LOAD_ERROR), tc));
      } finally {
        if (mountedRef.current && !controller.signal.aborted && scopeEpochRef.current === epoch) {
          setLoadingScope(false);
        }
      }
    },
    [applyScopeState, canView, clearFeedback, scope, tc],
  );

  // Fetch scope state whenever scope or session changes (when canView)
  useEffect(() => {
    if (!canView || !scope.id) {
      scopeEpochRef.current += 1;
      scopeAbortRef.current?.abort();
    }

    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setViewingVersion(null);
      setVersionDetailError(null);
      setPendingRestoreVersion(null);
      setPreviewResult(null);
      setPreviewError(null);
      setTryResult(null);
      setTryError(null);
      setDiffData(null);
      setDiffError(null);
      clearFeedback();
      if (canView && scope.id) {
        void loadScopeState();
      }
    });

    return () => {
      cancelled = true;
      scopeEpochRef.current += 1;
      scopeAbortRef.current?.abort();
    };
  }, [canView, scope, sessionRevision, loadScopeState, clearFeedback]);

  // Fetch diff whenever diffFromVersion / diffToVersion change
  useEffect(() => {
    if (!canView || !scope.id || diffFromVersion === null || diffToVersion === null) {
      diffEpochRef.current += 1;
      diffAbortRef.current?.abort();
      return;
    }

    const epoch = ++diffEpochRef.current;
    diffAbortRef.current?.abort();
    const controller = new AbortController();
    diffAbortRef.current = controller;

    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setLoadingDiff(true);
      setDiffError(null);
      void fetchPromptDiff(scope, diffFromVersion, diffToVersion, controller.signal)
        .then((res) => {
          if (!mountedRef.current || controller.signal.aborted || diffEpochRef.current !== epoch) {
            return;
          }
          setDiffData(res);
        })
        .catch((err) => {
          if (
            isAbortError(err) ||
            !mountedRef.current ||
            controller.signal.aborted ||
            diffEpochRef.current !== epoch
          ) {
            return;
          }
          setDiffData(null);
          setDiffError(formatApiError(err, tc(PROMPTS_DIFF_ERROR), tc));
        })
        .finally(() => {
          if (mountedRef.current && !controller.signal.aborted && diffEpochRef.current === epoch) {
            setLoadingDiff(false);
          }
        });
    });

    return () => {
      cancelled = true;
      diffEpochRef.current += 1;
      diffAbortRef.current?.abort();
    };
  }, [canView, scope, diffFromVersion, diffToVersion, tc]);

  function handleMutationError(err: unknown, fallbackKey: string) {
    const info = getPromptErrorInfo(err);
    if (info.status === 422) {
      if (info.line !== undefined && info.column !== undefined && info.reason) {
        setValidationError(
          tc(PROMPTS_VALIDATION_LOCATION, {
            line: info.line,
            column: info.column,
            reason: info.reason,
          }),
        );
      } else {
        setValidationError(info.reason || info.message || tc(PROMPTS_VALIDATION_GENERIC));
      }
      return;
    }
    if (info.status === 409 && (info.code === 'revision_conflict' || !info.code)) {
      setConflictError(true);
      return;
    }
    setActionError(formatApiError(err, tc(fallbackKey), tc));
  }

  async function handleSaveDraft() {
    if (!canEdit || !scope.id || savingDraft) return;
    mutAbortRef.current?.abort();
    const controller = new AbortController();
    mutAbortRef.current = controller;

    setSavingDraft(true);
    clearFeedback();
    try {
      const res = await savePromptDraft(
        scope,
        { body, variables, note, revision },
        controller.signal,
      );
      if (!mountedRef.current || controller.signal.aborted) return;
      setActionSuccess(tc(PROMPTS_DRAFT_SAVED));
      if (canView) {
        await loadScopeState({ preserveFeedback: true });
      } else {
        const nextHead = 'head' in res && res.head ? res.head : undefined;
        setRevision(nextHead?.revision ?? revision + 1);
        setEditorHasLocalDraft(true);
      }
    } catch (err) {
      if (isAbortError(err) || !mountedRef.current || controller.signal.aborted) return;
      handleMutationError(err, PROMPTS_SAVE_ERROR);
    } finally {
      if (mountedRef.current && !controller.signal.aborted) {
        setSavingDraft(false);
      }
    }
  }

  async function handleDiscardDraft() {
    if (!canEdit || !scope.id || discardingDraft) return;
    mutAbortRef.current?.abort();
    const controller = new AbortController();
    mutAbortRef.current = controller;

    setDiscardingDraft(true);
    clearFeedback();
    try {
      const res = await discardPromptDraft(scope, revision, controller.signal);
      if (!mountedRef.current || controller.signal.aborted) return;
      setActionSuccess(tc(PROMPTS_DRAFT_DISCARDED));
      if (canView) {
        await loadScopeState({ preserveFeedback: true });
      } else {
        const nextHead = 'head' in res && res.head ? res.head : undefined;
        setRevision(nextHead?.revision ?? revision + 1);
        setEditorHasLocalDraft(false);
      }
    } catch (err) {
      if (isAbortError(err) || !mountedRef.current || controller.signal.aborted) return;
      handleMutationError(err, PROMPTS_DISCARD_ERROR);
    } finally {
      if (mountedRef.current && !controller.signal.aborted) {
        setDiscardingDraft(false);
      }
    }
  }

  async function handlePublish() {
    if (!canPublish || !scope.id || publishing) return;
    mutAbortRef.current?.abort();
    const controller = new AbortController();
    mutAbortRef.current = controller;

    setPublishing(true);
    clearFeedback();
    try {
      const res = await publishPrompt(scope, { revision }, controller.signal);
      if (!mountedRef.current || controller.signal.aborted) return;
      setActionSuccess(tc(PROMPTS_PUBLISHED_SUCCESS));
      if (canView) {
        await loadScopeState({ preserveFeedback: true });
      } else {
        const nextHead = 'head' in res && res.head ? res.head : undefined;
        setRevision(nextHead?.revision ?? revision + 1);
        setEditorHasLocalDraft(false);
      }
    } catch (err) {
      if (isAbortError(err) || !mountedRef.current || controller.signal.aborted) return;
      handleMutationError(err, PROMPTS_PUBLISH_ERROR);
    } finally {
      if (mountedRef.current && !controller.signal.aborted) {
        setPublishing(false);
      }
    }
  }

  async function handleConfirmRestore(version: number) {
    if (!canPublish || !scope.id || restoringVersion !== null) return;
    mutAbortRef.current?.abort();
    const controller = new AbortController();
    mutAbortRef.current = controller;

    setRestoringVersion(version);
    clearFeedback();
    try {
      const res = await restorePromptVersion(scope, { version, revision }, controller.signal);
      if (!mountedRef.current || controller.signal.aborted) return;
      setPendingRestoreVersion(null);
      setActionSuccess(tc(PROMPTS_RESTORED_SUCCESS));
      if (canView) {
        await loadScopeState({ preserveFeedback: true });
      } else {
        const nextHead = 'head' in res && res.head ? res.head : undefined;
        setRevision(nextHead?.revision ?? revision + 1);
      }
    } catch (err) {
      if (isAbortError(err) || !mountedRef.current || controller.signal.aborted) return;
      handleMutationError(err, PROMPTS_RESTORE_ERROR);
    } finally {
      if (mountedRef.current && !controller.signal.aborted) {
        setRestoringVersion(null);
      }
    }
  }

  async function handleViewVersion(version: number) {
    if (!canView || !scope.id) return;
    versionDetailAbortRef.current?.abort();
    const controller = new AbortController();
    versionDetailAbortRef.current = controller;

    setLoadingVersionDetail(true);
    setVersionDetailError(null);
    try {
      const res = await fetchPromptVersion(scope, version, controller.signal);
      if (!mountedRef.current || controller.signal.aborted) return;
      setViewingVersion(res.version);
    } catch (err) {
      if (isAbortError(err) || !mountedRef.current || controller.signal.aborted) return;
      setVersionDetailError(formatApiError(err, tc(PROMPTS_VERSION_DETAIL_ERROR), tc));
    } finally {
      if (mountedRef.current && !controller.signal.aborted) {
        setLoadingVersionDetail(false);
      }
    }
  }

  function buildEffectiveSampleValues(): Record<string, string> {
    const defaults: Record<string, string> = {};
    for (const v of variables) {
      if (v.default !== undefined && v.default !== '') {
        defaults[v.name] = v.default;
      }
    }
    for (const [k, val] of Object.entries(sampleValues)) {
      if (val !== '') {
        defaults[k] = val;
      }
    }
    return defaults;
  }

  async function handlePreview() {
    if (!canEdit || !scope.id || previewing) return;
    previewAbortRef.current?.abort();
    const controller = new AbortController();
    previewAbortRef.current = controller;

    setPreviewing(true);
    setPreviewError(null);
    setValidationError(null);
    try {
      const res = await previewPrompt(
        scope,
        { body, variables, values: buildEffectiveSampleValues() },
        controller.signal,
      );
      if (!mountedRef.current || controller.signal.aborted) return;
      setPreviewResult(res);
    } catch (err) {
      if (isAbortError(err) || !mountedRef.current || controller.signal.aborted) return;
      const info = getPromptErrorInfo(err);
      if (info.status === 422 && info.line !== undefined && info.column !== undefined && info.reason) {
        const formatted = tc(PROMPTS_VALIDATION_LOCATION, {
          line: info.line,
          column: info.column,
          reason: info.reason,
        });
        setValidationError(formatted);
        setPreviewError(formatted);
      } else {
        setPreviewError(formatApiError(err, tc(PROMPTS_PREVIEW_ERROR), tc));
      }
    } finally {
      if (mountedRef.current && !controller.signal.aborted) {
        setPreviewing(false);
      }
    }
  }

  async function handleTryDraft() {
    if (!canEdit || !scope.id || trying || !tryMessage.trim()) return;
    tryAbortRef.current?.abort();
    const controller = new AbortController();
    tryAbortRef.current = controller;

    setTrying(true);
    setTryError(null);
    setValidationError(null);
    try {
      const res = await tryPrompt(
        scope,
        {
          body,
          variables,
          values: buildEffectiveSampleValues(),
          message: tryMessage.trim(),
          ...(tryModel.trim() ? { model: tryModel.trim() } : {}),
        },
        controller.signal,
      );
      if (!mountedRef.current || controller.signal.aborted) return;
      setTryResult(res);
    } catch (err) {
      if (isAbortError(err) || !mountedRef.current || controller.signal.aborted) return;
      const info = getPromptErrorInfo(err);
      if (info.status === 409 && (info.code === 'pillar_disabled' || !info.code)) {
        setTryError(tc(PROMPTS_TRY_PILLAR_DISABLED));
      } else if (info.status === 422 && info.line !== undefined && info.column !== undefined && info.reason) {
        const formatted = tc(PROMPTS_VALIDATION_LOCATION, {
          line: info.line,
          column: info.column,
          reason: info.reason,
        });
        setValidationError(formatted);
        setTryError(formatted);
      } else {
        setTryError(formatApiError(err, tc(PROMPTS_TRY_ERROR), tc));
      }
    } finally {
      if (mountedRef.current && !controller.signal.aborted) {
        setTrying(false);
      }
    }
  }

  const sampleVariableNames = useMemo(
    () => extractTemplateVariableNames(body, variables),
    [body, variables],
  );

  const hasDraft = canView
    ? scopeState?.head.draftVersion !== null && scopeState?.head.draftVersion !== undefined
    : editorHasLocalDraft;
  const anyMutating = savingDraft || discardingDraft || publishing || restoringVersion !== null;

  return (
    <div className="space-y-6" data-testid="prompts-page">
      <header className="space-y-1">
        <h2 className="text-lg font-semibold">{tc(PROMPTS_PAGE_TITLE)}</h2>
        <p className="text-sm text-muted-foreground">{tc(PROMPTS_PAGE_SUBTITLE)}</p>
      </header>

      {/* Permission notices */}
      {canView && !canEdit && (
        <div
          className="rounded border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
          data-testid="prompts-view-only-notice"
        >
          {tc(PROMPTS_VIEW_ONLY_NOTICE)}
        </div>
      )}
      {canEdit && !canPublish && (
        <div
          className="rounded border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
          data-testid="prompts-no-publish-notice"
        >
          {tc(PROMPTS_NO_PUBLISH_NOTICE)}
        </div>
      )}
      {!canView && (canEdit || canPublish) && (
        <div
          className="rounded border border-amber-600/30 bg-amber-600/15 dark:bg-amber-400/15 px-3 py-2 text-xs text-amber-700 dark:text-amber-400"
          data-testid="prompts-editor-only-notice"
        >
          {tc(PROMPTS_EDITOR_ONLY_NOTICE)}
        </div>
      )}

      {/* Scope selector */}
      <div className="flex flex-wrap items-end gap-4 rounded-lg border bg-card p-3">
        <label className="space-y-1 text-xs">
          <span className="font-medium">{tc(PROMPTS_SCOPE_KIND)}</span>
          <select
            className="block rounded border px-2 py-1.5 text-sm bg-background"
            data-testid="prompts-scope-kind-select"
            aria-label={tc(PROMPTS_SCOPE_KIND)}
            value={scopeKind}
            onChange={(e) => {
              const nextKind = e.target.value as 'profile' | 'support_tenant';
              setScopeKind(nextKind);
              if (nextKind === 'profile' && profiles.length > 0) {
                setScopeId(String(profiles[0].id));
              } else if (nextKind === 'support_tenant' && tenants.length > 0) {
                setScopeId(tenants[0].id);
              } else {
                setScopeId('1');
              }
            }}
          >
            <option value="profile">{tc(PROMPTS_SCOPE_PROFILE)}</option>
            <option value="support_tenant">{tc(PROMPTS_SCOPE_SUPPORT_TENANT)}</option>
          </select>
        </label>

        <label className="space-y-1 text-xs flex-1 min-w-[200px]">
          <span className="font-medium">{tc(PROMPTS_SCOPE_TARGET)}</span>
          {scopeKind === 'profile' && profiles.length > 0 ? (
            <select
              className="block w-full rounded border px-2 py-1.5 text-sm bg-background"
              data-testid="prompts-scope-target-select"
              aria-label={tc(PROMPTS_SCOPE_TARGET)}
              value={scopeId}
              onChange={(e) => setScopeId(e.target.value)}
            >
              {profiles.map((p) => (
                <option key={p.id} value={String(p.id)}>
                  {`${p.name} (#${p.id})`}
                </option>
              ))}
            </select>
          ) : scopeKind === 'support_tenant' && tenants.length > 0 ? (
            <select
              className="block w-full rounded border px-2 py-1.5 text-sm bg-background"
              data-testid="prompts-scope-target-select"
              aria-label={tc(PROMPTS_SCOPE_TARGET)}
              value={scopeId}
              onChange={(e) => setScopeId(e.target.value)}
            >
              {tenants.map((t) => (
                <option key={t.id} value={t.id}>
                  {`${t.name} (#${t.id})`}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              className="block w-full rounded border px-2 py-1.5 text-sm bg-background"
              data-testid="prompts-scope-target-input"
              aria-label={tc(PROMPTS_SCOPE_TARGET)}
              placeholder={tc(PROMPTS_SCOPE_ID_PLACEHOLDER)}
              value={scopeId}
              onChange={(e) => setScopeId(e.target.value)}
            />
          )}
        </label>

        {canView && (
          <button
            type="button"
            data-testid="prompts-reload-btn"
            disabled={loadingScope}
            onClick={() => void loadScopeState()}
            className="rounded border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
          >
            {tc(PROMPTS_RELOAD_BTN)}
          </button>
        )}
      </div>

      {/* Scope loading / load error / pruned notice / head badges */}
      {canView && loadingScope && (
        <p className="text-sm text-muted-foreground" data-testid="prompts-loading">
          {tc(PROMPTS_LOADING)}
        </p>
      )}

      {canView && loadError && (
        <div
          role="alert"
          data-testid="prompts-load-error"
          className="flex items-center justify-between gap-2 rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <span>{loadError}</span>
          <button
            type="button"
            className="underline font-medium"
            onClick={() => void loadScopeState()}
          >
            {tc(PROMPTS_RETRY)}
          </button>
        </div>
      )}

      {scopeState && (
        <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="prompts-head-summary">
          <span className="rounded bg-emerald-600/15 dark:bg-emerald-400/15 text-emerald-700 dark:text-emerald-400 px-2 py-0.5 font-medium">
            {scopeState.head.publishedVersion !== null
              ? tc(PROMPTS_HEAD_PUBLISHED, { version: scopeState.head.publishedVersion })
              : tc(PROMPTS_HEAD_NO_PUBLISHED)}
          </span>
          <span className="rounded bg-amber-600/15 dark:bg-amber-400/15 text-amber-700 dark:text-amber-400 px-2 py-0.5 font-medium">
            {scopeState.head.draftVersion !== null
              ? tc(PROMPTS_HEAD_DRAFT, { version: scopeState.head.draftVersion })
              : tc(PROMPTS_HEAD_NO_DRAFT)}
          </span>
          <span className="rounded bg-muted px-2 py-0.5 font-mono text-muted-foreground">
            {tc(PROMPTS_HEAD_REVISION, { revision })}
          </span>
        </div>
      )}

      {scopeState && scopeState.prunedCount > 0 && (
        <div
          data-testid="prompts-pruned-notice"
          className="rounded border border-blue-600/30 bg-blue-600/15 dark:bg-blue-400/15 px-3 py-2 text-xs text-blue-700 dark:text-blue-400"
        >
          {tc(PROMPTS_PRUNED_NOTICE, { count: scopeState.prunedCount })}
        </div>
      )}

      {/* 409 revision_conflict banner */}
      {conflictError && (
        <div
          role="alert"
          data-testid="prompts-conflict-banner"
          className="flex flex-wrap items-center justify-between gap-2 rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <span>{tc(PROMPTS_CONFLICT_BANNER)}</span>
          {canView && (
            <button
              type="button"
              data-testid="prompts-conflict-reload-btn"
              onClick={() => void loadScopeState()}
              className="rounded border border-destructive/40 bg-background px-2.5 py-1 text-xs font-medium text-destructive hover:bg-destructive/10"
            >
              {tc(PROMPTS_CONFLICT_RELOAD_BTN)}
            </button>
          )}
        </div>
      )}

      {/* 422 validation error (with line & column) */}
      {validationError && (
        <div
          role="alert"
          data-testid="prompts-validation-error"
          className="rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive font-mono"
        >
          {validationError}
        </div>
      )}

      {/* Generic action error / success */}
      {actionError && (
        <div
          role="alert"
          data-testid="prompts-action-error"
          className="rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {actionError}
        </div>
      )}
      {actionSuccess && (
        <div
          data-testid="prompts-action-success"
          className="rounded border border-emerald-600/30 bg-emerald-600/15 dark:bg-emerald-400/15 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400"
        >
          {actionSuccess}
        </div>
      )}

      {/* Section 1: Editor + Variable Editor */}
      <section className="rounded-lg border bg-card p-4 space-y-4" data-testid="prompts-editor-section">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-base font-semibold">{tc(PROMPTS_EDITOR_HEADING)}</h2>
          <span className="text-xs text-muted-foreground font-mono">
            {tc(PROMPTS_BODY_CHARS, {
              count: body.length,
              max: PROMPT_LIMITS.maxBodyChars,
            })}
          </span>
        </div>

        <label className="block space-y-1 text-xs">
          <span className="font-medium">{tc(PROMPTS_BODY_LABEL)}</span>
          <textarea
            data-testid="prompts-body-input"
            aria-label={tc(PROMPTS_BODY_LABEL)}
            rows={8}
            disabled={!canEdit}
            maxLength={PROMPT_LIMITS.maxBodyChars}
            placeholder={tc(PROMPTS_BODY_PLACEHOLDER)}
            className="block w-full rounded border px-3 py-2 text-sm font-mono bg-background"
            value={body}
            onChange={(e) => {
              setBody(e.target.value);
              if (validationError) setValidationError(null);
            }}
          />
        </label>

        <label className="block space-y-1 text-xs">
          <span className="font-medium">{tc(PROMPTS_NOTE_LABEL)}</span>
          <input
            type="text"
            data-testid="prompts-note-input"
            aria-label={tc(PROMPTS_NOTE_LABEL)}
            disabled={!canEdit}
            maxLength={PROMPT_LIMITS.maxNoteChars}
            placeholder={tc(PROMPTS_NOTE_PLACEHOLDER)}
            className="block w-full rounded border px-3 py-1.5 text-sm bg-background"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="prompts-save-draft-btn"
            disabled={!canEdit || anyMutating}
            onClick={() => void handleSaveDraft()}
            className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {savingDraft ? tc(PROMPTS_SAVING_DRAFT_BTN) : tc(PROMPTS_SAVE_DRAFT_BTN)}
          </button>

          <button
            type="button"
            data-testid="prompts-discard-draft-btn"
            disabled={!canEdit || anyMutating || !hasDraft}
            onClick={() => void handleDiscardDraft()}
            className="rounded border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
          >
            {discardingDraft ? tc(PROMPTS_DISCARDING_DRAFT_BTN) : tc(PROMPTS_DISCARD_DRAFT_BTN)}
          </button>

          <button
            type="button"
            data-testid="prompts-publish-btn"
            disabled={!canPublish || anyMutating || (canView && !hasDraft)}
            onClick={() => void handlePublish()}
            className="rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {publishing ? tc(PROMPTS_PUBLISHING_BTN) : tc(PROMPTS_PUBLISH_BTN)}
          </button>
        </div>

        <hr />

        <VariableEditor
          body={body}
          variables={variables}
          systemVariables={systemVariables}
          canEdit={canEdit}
          onChange={(nextVars) => setVariables(nextVars)}
        />
      </section>

      {/* Section 2: Preview & Try Draft */}
      <section className="rounded-lg border bg-card p-4 space-y-4" data-testid="prompts-preview-try-section">
        <h2 className="text-base font-semibold">{tc(PROMPTS_PREVIEW_TRY_HEADING)}</h2>

        {/* Sample Variable Values */}
        <div className="space-y-2">
          <div className="text-xs font-medium text-muted-foreground">
            {tc(PROMPTS_SAMPLE_VALUES_HEADING)}
          </div>
          {sampleVariableNames.length === 0 ? (
            <p className="text-xs text-muted-foreground">{tc(PROMPTS_SAMPLE_VALUES_EMPTY)}</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
              {sampleVariableNames.map((varName) => (
                <label key={varName} className="space-y-1 text-xs">
                  <span className="font-mono text-[11px]">{`{{${varName}}}`}</span>
                  <input
                    type="text"
                    data-testid={`prompts-sample-val-${varName}`}
                    disabled={!canEdit}
                    className="block w-full rounded border px-2 py-1 text-xs bg-background"
                    value={sampleValues[varName] ?? ''}
                    onChange={(e) =>
                      setSampleValues((prev) => ({ ...prev, [varName]: e.target.value }))
                    }
                  />
                </label>
              ))}
            </div>
          )}
        </div>

        {/* Preview Action & Result */}
        <div className="space-y-2">
          <button
            type="button"
            data-testid="prompts-preview-btn"
            disabled={!canEdit || previewing}
            onClick={() => void handlePreview()}
            className="rounded border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
          >
            {previewing ? tc(PROMPTS_PREVIEWING_BTN) : tc(PROMPTS_PREVIEW_BTN)}
          </button>

          {previewError && (
            <div
              role="alert"
              data-testid="prompts-preview-error"
              className="rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {previewError}
            </div>
          )}

          {previewResult && (
            <div className="space-y-2 rounded border bg-muted/20 p-3">
              {previewResult.missing.length > 0 && (
                <div
                  data-testid="prompts-preview-missing"
                  className="rounded border border-amber-600/30 bg-amber-600/15 dark:bg-amber-400/15 px-2.5 py-1.5 text-xs text-amber-700 dark:text-amber-400"
                >
                  <span className="font-medium">{tc(PROMPTS_PREVIEW_MISSING_LABEL)}: </span>
                  <span className="font-mono">
                    {previewResult.missing.map((m) => `{{${m}}}`).join(', ')}
                  </span>
                </div>
              )}
              <div className="text-[11px] font-medium text-muted-foreground">
                {tc(PROMPTS_PREVIEW_RENDERED_LABEL)}
              </div>
              <pre
                data-testid="prompts-preview-rendered"
                className="whitespace-pre-wrap break-words rounded border bg-background p-2.5 text-xs font-mono"
              >
                {previewResult.rendered}
              </pre>
            </div>
          )}
        </div>

        <hr />

        {/* Try Draft with Model */}
        <div className="space-y-3">
          <div>
            <h3 className="text-sm font-semibold">{tc(PROMPTS_TRY_HEADING)}</h3>
            <p className="text-xs text-muted-foreground" data-testid="prompts-try-quota-note">
              {tc(PROMPTS_TRY_QUOTA_NOTE)}
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <label className="md:col-span-3 space-y-1 text-xs">
              <span className="font-medium">{tc(PROMPTS_TRY_MESSAGE_LABEL)}</span>
              <textarea
                data-testid="prompts-try-message-input"
                aria-label={tc(PROMPTS_TRY_MESSAGE_LABEL)}
                rows={3}
                disabled={!canEdit}
                maxLength={PROMPT_LIMITS.maxTryMessageChars}
                placeholder={tc(PROMPTS_TRY_MESSAGE_PLACEHOLDER)}
                className="block w-full rounded border px-2.5 py-1.5 text-sm bg-background"
                value={tryMessage}
                onChange={(e) => setTryMessage(e.target.value)}
              />
            </label>

            <label className="space-y-1 text-xs">
              <span className="font-medium">{tc(PROMPTS_TRY_MODEL_LABEL)}</span>
              <input
                type="text"
                data-testid="prompts-try-model-input"
                aria-label={tc(PROMPTS_TRY_MODEL_LABEL)}
                disabled={!canEdit}
                placeholder={tc(PROMPTS_TRY_MODEL_PLACEHOLDER)}
                className="block w-full rounded border px-2.5 py-1.5 text-sm bg-background"
                value={tryModel}
                onChange={(e) => setTryModel(e.target.value)}
              />
            </label>
          </div>

          <button
            type="button"
            data-testid="prompts-try-btn"
            disabled={!canEdit || trying || !tryMessage.trim()}
            onClick={() => void handleTryDraft()}
            className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {trying ? tc(PROMPTS_TRYING_BTN) : tc(PROMPTS_TRY_BTN)}
          </button>

          {tryError && (
            <div
              role="alert"
              data-testid="prompts-try-error"
              className="rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {tryError}
            </div>
          )}

          {tryResult && (
            <div className="space-y-2 rounded border bg-muted/20 p-3">
              <div className="text-[11px] font-medium text-muted-foreground">
                {tc(PROMPTS_TRY_REPLY_LABEL)}
              </div>
              <pre
                data-testid="prompts-try-reply"
                className="whitespace-pre-wrap break-words rounded border bg-background p-2.5 text-xs"
              >
                {tryResult.reply}
              </pre>
              <div className="text-[11px] font-mono text-muted-foreground" data-testid="prompts-try-usage">
                {tc(PROMPTS_TRY_USAGE_LABEL, {
                  model: tryResult.model,
                  prompt: tryResult.usage.prompt_tokens,
                  completion: tryResult.usage.completion_tokens,
                  total: tryResult.usage.total_tokens,
                })}
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Section 3: Version History */}
      {canView && (
        <section className="rounded-lg border bg-card p-4 space-y-3" data-testid="prompts-history-section">
          <h2 className="text-base font-semibold">{tc(PROMPTS_HISTORY_HEADING)}</h2>

          {pendingRestoreVersion !== null && (
            <div
              data-testid="prompts-restore-confirm-panel"
              className="flex flex-wrap items-center justify-between gap-2 rounded border border-amber-600/30 bg-amber-600/15 dark:bg-amber-400/15 px-3 py-2 text-xs text-amber-700 dark:text-amber-400"
            >
              <span>{tc(PROMPTS_RESTORE_CONFIRM_TEXT, { version: pendingRestoreVersion })}</span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  data-testid="prompts-restore-confirm-btn"
                  disabled={!canPublish || restoringVersion !== null}
                  onClick={() => void handleConfirmRestore(pendingRestoreVersion)}
                  className="rounded bg-amber-700 px-2.5 py-1 text-xs font-medium text-white hover:bg-amber-800 disabled:opacity-50"
                >
                  {tc(PROMPTS_RESTORE_CONFIRM_BTN)}
                </button>
                <button
                  type="button"
                  data-testid="prompts-restore-cancel-btn"
                  onClick={() => setPendingRestoreVersion(null)}
                  className="rounded border bg-background px-2.5 py-1 text-xs font-medium hover:bg-muted"
                >
                  {tc(PROMPTS_RESTORE_CANCEL_BTN)}
                </button>
              </div>
            </div>
          )}

          {!scopeState || scopeState.versions.length === 0 ? (
            <p className="text-xs text-muted-foreground" data-testid="prompts-history-empty">
              {tc(PROMPTS_HISTORY_EMPTY)}
            </p>
          ) : (
            <div className="space-y-2" data-testid="prompts-version-list">
              {scopeState.versions.map((v) => {
                const badgeCls =
                  v.status === 'published'
                    ? 'bg-emerald-600/15 dark:bg-emerald-400/15 text-emerald-700 dark:text-emerald-400'
                    : v.status === 'draft'
                      ? 'bg-amber-600/15 dark:bg-amber-400/15 text-amber-700 dark:text-amber-400'
                      : 'bg-muted text-muted-foreground';

                return (
                  <div
                    key={v.id}
                    data-testid={`prompts-version-row-${v.version}`}
                    className="flex flex-wrap items-center justify-between gap-2 rounded border p-2.5 text-xs"
                  >
                    <div className="space-y-0.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono font-semibold">{`v${v.version}`}</span>
                        <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${badgeCls}`}>
                          {formatStatusBadge(v.status, tc)}
                        </span>
                        {v.restoredFrom !== null && (
                          <span
                            data-testid={`prompts-restored-from-${v.version}`}
                            className="rounded bg-blue-600/15 dark:bg-blue-400/15 text-blue-700 dark:text-blue-400 px-1.5 py-0.5 text-[11px]"
                          >
                            {tc(PROMPTS_RESTORED_FROM, { version: v.restoredFrom })}
                          </span>
                        )}
                      </div>
                      <div className="text-muted-foreground">
                        <span>{v.note || tc(PROMPTS_NO_NOTE)}</span>
                        <span>
                          {` · ${
                            v.authorId === null
                              ? tc(PROMPTS_AUTHOR_SYSTEM)
                              : tc(PROMPTS_AUTHOR_LABEL, { id: v.authorId })
                          } · ${v.createdAt}`}
                        </span>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        data-testid={`prompts-view-version-${v.version}`}
                        onClick={() => void handleViewVersion(v.version)}
                        className="rounded border px-2 py-1 text-xs hover:bg-muted"
                      >
                        {tc(PROMPTS_VIEW_BTN)}
                      </button>
                      <button
                        type="button"
                        data-testid={`prompts-compare-version-${v.version}`}
                        onClick={() => {
                          setDiffFromVersion(v.version);
                          setDiffToVersion(
                            scopeState.head.publishedVersion ?? scopeState.versions[0]?.version ?? v.version,
                          );
                        }}
                        className="rounded border px-2 py-1 text-xs hover:bg-muted"
                      >
                        {tc(PROMPTS_COMPARE_BTN)}
                      </button>
                      <button
                        type="button"
                        data-testid={`prompts-restore-version-${v.version}`}
                        disabled={!canPublish || anyMutating || v.status === 'published'}
                        onClick={() => setPendingRestoreVersion(v.version)}
                        className="rounded border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
                      >
                        {tc(PROMPTS_RESTORE_BTN)}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Full version viewer */}
          {loadingVersionDetail && (
            <p className="text-xs text-muted-foreground">{tc(PROMPTS_VERSION_DETAIL_LOADING)}</p>
          )}
          {versionDetailError && (
            <div
              role="alert"
              className="rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {versionDetailError}
            </div>
          )}
          {viewingVersion && (
            <div
              data-testid="prompts-version-detail"
              className="rounded border bg-muted/20 p-3 space-y-2"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs font-semibold">
                  {tc(PROMPTS_VERSION_DETAIL_HEADING, { version: viewingVersion.version })}
                </div>
                <div className="flex items-center gap-2">
                  {canEdit && (
                    <button
                      type="button"
                      data-testid="prompts-copy-version-to-editor-btn"
                      onClick={() => {
                        setBody(viewingVersion.body);
                        setVariables(viewingVersion.variables ?? []);
                      }}
                      className="rounded border bg-background px-2 py-1 text-xs hover:bg-muted"
                    >
                      {tc(PROMPTS_LOAD_INTO_EDITOR_BTN)}
                    </button>
                  )}
                  <button
                    type="button"
                    data-testid="prompts-close-version-detail-btn"
                    onClick={() => setViewingVersion(null)}
                    className="rounded border bg-background px-2 py-1 text-xs hover:bg-muted"
                  >
                    {tc(PROMPTS_CLOSE_BTN)}
                  </button>
                </div>
              </div>
              <pre className="whitespace-pre-wrap break-words rounded border bg-background p-2.5 text-xs font-mono">
                {viewingVersion.body}
              </pre>
            </div>
          )}
        </section>
      )}

      {/* Section 4: Diff View */}
      {canView && (
        <DiffView
          versions={scopeState?.versions ?? []}
          fromVersion={diffFromVersion}
          toVersion={diffToVersion}
          onChangeFrom={(ver) => setDiffFromVersion(ver)}
          onChangeTo={(ver) => setDiffToVersion(ver)}
          diff={diffData}
          loading={loadingDiff}
          error={diffError}
        />
      )}
    </div>
  );
}
